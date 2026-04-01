// modules/state.js
// Shared mutable state and all functions that read/write it.
//
// Circular note: imports updateStudentDoc from firebase.js; firebase.js imports
//   currentUser + callAI from here. Safe — both sides are called at runtime, not init-time.

import { API_URL }       from './constants.js';
import { accToBand, toSkillId, withRetry } from './utils.js';
import { getVisionPrompt } from '../api/vision-prompt.js';
import { updateStudentDoc } from './firebase.js';

// ── SHARED STATE ──────────────────────────────────────────────────
let currentUser = null;
let studentData = null;

export { currentUser, studentData };

export function setCurrentUser(user) { currentUser = user; }
export function setStudentData(data) { studentData = data; }

// ── IELTS SKILL ACCESSORS ─────────────────────────────────────────
// Returns the IELTS skill map from the subject-agnostic brain schema.
// Falls back to migrating from the old studentData.skills structure.
export function getIELTSSkills() {
  const newPath = studentData?.brain?.subjects?.['ielts-academic']?.skills;
  if (newPath && Object.keys(newPath).length > 0) return newPath;
  // Graceful migration from legacy skills.* structure
  const old = studentData?.skills;
  if (!old) return {};
  return {
    'reading-tfng':              old.reading?.tfng,
    'reading-matchingHeadings':  old.reading?.matchingHeadings,
    'reading-summaryCompletion': old.reading?.summaryCompletion,
    'listening-multipleChoice':  old.listening?.multipleChoice,
    'listening-formCompletion':  old.listening?.formCompletion,
    'listening-mapDiagram':      old.listening?.mapDiagram,
    'writing-task1':             old.writing?.task1,
    'writing-task2':             old.writing?.task2,
    'speaking-part1':            old.speaking?.part1,
    'speaking-part2':            old.speaking?.part2,
    'speaking-part3':            old.speaking?.part3,
  };
}

// Updates local studentData memory with new skill data
export function setIELTSSkillLocal(skillId, data) {
  if (!studentData.brain)                              studentData.brain = {};
  if (!studentData.brain.subjects)                     studentData.brain.subjects = {};
  if (!studentData.brain.subjects['ielts-academic'])   studentData.brain.subjects['ielts-academic'] = {};
  if (!studentData.brain.subjects['ielts-academic'].skills) studentData.brain.subjects['ielts-academic'].skills = {};
  studentData.brain.subjects['ielts-academic'].skills[skillId] = {
    ...studentData.brain.subjects['ielts-academic'].skills[skillId],
    ...data,
  };
}

// ── ADAPTIVE ENGINE ───────────────────────────────────────────────
export function calcBandEstimate() {
  const skills = getIELTSSkills();
  function avgAcc(keys) {
    const q = keys.map(k => skills[k]).filter(s => s && (s.attempted || 0) >= 5);
    return q.length ? q.reduce((sum, s) => sum + (s.accuracy || 0), 0) / q.length : null;
  }
  function avgBand(keys) {
    const q = keys.map(k => skills[k]).filter(s => s && (s.attempted || 0) > 0);
    return q.length ? q.reduce((sum, s) => sum + (s.bandEstimate || 0), 0) / q.length : null;
  }
  const parts = [];
  const rAcc = avgAcc(['reading-tfng','reading-summaryCompletion']); if (rAcc !== null) parts.push(accToBand(rAcc));
  const lAcc = avgAcc(['listening-multipleChoice','listening-formCompletion']); if (lAcc !== null) parts.push(accToBand(lAcc));
  const wBand = avgBand(['writing-task1','writing-task2']); if (wBand !== null) parts.push(wBand);
  const sBand = avgBand(['speaking-part1']); if (sBand !== null) parts.push(sBand);
  if (!parts.length) return null;
  return Math.round((parts.reduce((a, b) => a + b, 0) / parts.length) * 2) / 2;
}

export function isMockUnlocked() {
  const skills = getIELTSSkills();
  return ['reading','listening','writing','speaking'].every(sec =>
    Object.keys(skills).some(k => k.startsWith(sec + '-') && (skills[k]?.attempted || 0) > 0)
  );
}

// ── BRAIN UPDATES ─────────────────────────────────────────────────
export function saveLearningStyleSignal(type) {
  if (!currentUser || !studentData) return;
  const prev   = studentData.brain?.learningStyleSignal || {};
  const updated = { ...prev, [type]: (prev[type] || 0) + 1 };
  updateStudentDoc(currentUser.uid, { 'brain.learningStyleSignal': updated }).catch(() => {});
  if (studentData.brain) studentData.brain.learningStyleSignal = updated;
}

export async function updateStudentBrain(behaviour, accuracy, skillKey, questionResults = null) {
  if (!currentUser) return;
  try {
    const prev  = studentData?.brain || {};
    const n     = (prev.totalSessions || 0) + 1;
    const alpha = 1 / Math.min(n, 10);   // EMA — stabilises after ~10 sessions
    const ema   = (prevVal, newVal) => Math.round(prevVal + (newVal - prevVal) * alpha);
    const changesThisSession = behaviour.answerChangesCount > 0 ? 100 : 0;

    // Per-skill breakdown stored under brain.subjects['ielts-academic'].skills[skillId]
    const skillId = skillKey ? toSkillId(skillKey) : null;
    const prevSubj = prev.subjects?.['ielts-academic'] || {};
    const prevSkillBrain = skillId ? (prevSubj.skills?.[skillId] || {}) : {};
    // Compute teaching resolution fields
    let aiResolved = prevSkillBrain.aiResolved || false;
    let needsHuman = prevSkillBrain.needsHuman || false;
    if (skillId && (prevSkillBrain.teachingAttempts || 0) >= 1 && prevSkillBrain.accuracyBeforeTeaching != null) {
      const sessionsNow = (prevSkillBrain.sessions || 0) + 1;
      if (sessionsNow >= 3 && !aiResolved) {
        if (accuracy >= prevSkillBrain.accuracyBeforeTeaching + 10) aiResolved = true;
      }
      if ((prevSkillBrain.teachingAttempts || 0) >= 3 && !aiResolved) needsHuman = true;
    }

    // Track consecutive high-accuracy sessions for "strong skill" detection
    const prevConsec = prevSkillBrain.consecutiveHighSessions || 0;
    const newConsec  = accuracy >= 80 ? prevConsec + 1 : 0;
    const isStrong   = newConsec >= 3;

    // Per-logicType error accumulation — tracks which mutation types a student misses most
    let errorsByLogicType = null;
    if (skillId && questionResults && questionResults.length > 0) {
      const prevEBLT = prevSkillBrain.errorsByLogicType || {};
      const merged   = { ...prevEBLT };
      questionResults.forEach(({ logicType, isRight }) => {
        if (!isRight && logicType) {
          merged[logicType] = (merged[logicType] || 0) + 1;
        }
      });
      errorsByLogicType = merged;
    }

    const skillBrainUpdate = skillId ? {
      avgTimePerQ:    ema(prevSkillBrain.avgTimePerQ    || 0, behaviour.avgTimePerQuestionSec),
      scrollsBackPct: ema(prevSkillBrain.scrollsBackPct || 0, behaviour.scrolledBackToPassage ? 100 : 0),
      changesAnswers: ema(prevSkillBrain.changesAnswers  || 0, changesThisSession),
      lastAccuracy:   accuracy,
      sessions:       (prevSkillBrain.sessions || 0) + 1,
      consecutiveHighSessions: newConsec,
      isStrong,
      aiResolved,
      needsHuman,
      ...(errorsByLogicType ? { errorsByLogicType } : {}),
    } : null;

    const updatedSubjSkills = {
      ...(prevSubj.skills || {}),
      ...(skillId && skillBrainUpdate ? { [skillId]: { ...(prevSubj.skills?.[skillId] || {}), ...skillBrainUpdate } } : {}),
    };
    const brain = {
      ...prev,
      totalSessions:         n,
      avgSessionDurationSec: ema(prev.avgSessionDurationSec || 0, behaviour.sessionDurationSec),
      avgTimePerQuestionSec: ema(prev.avgTimePerQuestionSec || 0, behaviour.avgTimePerQuestionSec),
      scrollsBackPct:        ema(prev.scrollsBackPct || 0, behaviour.scrolledBackToPassage ? 100 : 0),
      changesAnswersPct:      ema(prev.changesAnswersPct || 0, changesThisSession),
      recentAccuracy:        accuracy,
      subjects: {
        ...(prev.subjects || {}),
        'ielts-academic': { ...prevSubj, skills: updatedSubjSkills },
      },
    };
    await updateStudentDoc(currentUser.uid, { brain });
    if (studentData) studentData.brain = brain;
  } catch { /* non-critical */ }
}

export async function updateWeakAreas(skillKey, missedSubTypes) {
  if (!currentUser || !studentData) return;
  try {
    const ieltsSkills = getIELTSSkills();
    const candidates = [
      { key: 'reading-tfng',              name: 'T/F/Not Given',      s: ieltsSkills['reading-tfng'] },
      { key: 'reading-summaryCompletion', name: 'Summary Completion', s: ieltsSkills['reading-summaryCompletion'] },
      { key: 'listening-multipleChoice',  name: 'Multiple Choice',    s: ieltsSkills['listening-multipleChoice'] },
      { key: 'listening-formCompletion',  name: 'Form Completion',    s: ieltsSkills['listening-formCompletion'] },
    ].filter(c => c.s?.attempted > 0 && c.s.accuracy < 70)
     .sort((a, b) => a.s.accuracy - b.s.accuracy);

    const weakAreas = candidates.slice(0, 2).map(c => c.key);

    // Accumulate consistently missed sub-types
    const updates = { weakAreas };
    if (skillKey && missedSubTypes && Object.keys(missedSubTypes).length > 0) {
      const safeKey = toSkillId(skillKey);
      const prevBrain = studentData.brain || {};
      const prevMissed = prevBrain.consistentlyWeak?.[safeKey] || {};
      const merged = { ...prevMissed };
      Object.entries(missedSubTypes).forEach(([type, count]) => {
        merged[type] = (merged[type] || 0) + count;
      });
      // Find the sub-type missed 2+ times
      const topMissed = Object.entries(merged)
        .filter(([, c]) => c >= 2)
        .sort((a, b) => b[1] - a[1])[0];
      updates['brain.consistentlyWeak'] = {
        ...(studentData.brain?.consistentlyWeak || {}),
        [safeKey]: merged,
      };
      if (topMissed) {
        updates['brain.topMissedSubType'] = {
          ...(studentData.brain?.topMissedSubType || {}),
          [safeKey]: topMissed[0],
        };
      }
    }

    await updateStudentDoc(currentUser.uid, updates);
    if (studentData) {
      studentData.weakAreas = weakAreas;
      if (updates['brain.consistentlyWeak']) {
        if (!studentData.brain) studentData.brain = {};
        studentData.brain.consistentlyWeak = updates['brain.consistentlyWeak'];
      }
      if (updates['brain.topMissedSubType']) {
        studentData.brain.topMissedSubType = updates['brain.topMissedSubType'];
      }
    }
  } catch { /* non-critical */ }
}

// ── AI CONTEXT + CALL ─────────────────────────────────────────────
export function buildContextSnippet() {
  if (!studentData) return '';

  const name      = studentData.preferredName || studentData.name?.split(' ')[0] || 'Student';
  const target    = studentData.targetBand  || 6.5;
  const current   = studentData.currentBand || target;
  const ctxSkills = getIELTSSkills();
  const brain     = studentData.brain       || {};
  const weak      = studentData.weakAreas   || [];
  const purpose   = studentData.purpose     || '';

  const allSkills = [
    { key: 'reading-tfng',              name: 'T/F/Not Given',      s: ctxSkills['reading-tfng']              },
    { key: 'reading-summaryCompletion', name: 'Summary Completion', s: ctxSkills['reading-summaryCompletion'] },
    { key: 'listening-multipleChoice',  name: 'Multiple Choice',    s: ctxSkills['listening-multipleChoice']  },
    { key: 'listening-formCompletion',  name: 'Form Completion',    s: ctxSkills['listening-formCompletion']  },
  ].filter(x => x.s?.attempted > 0);

  const strong = allSkills
    .filter(x => x.s.accuracy >= 75)
    .map(x => `${x.name} (${x.s.accuracy}%)`);

  const weakSkills = allSkills
    .filter(x => x.s.accuracy < 70)
    .map(x => {
      let str = `${x.name} (${x.s.accuracy}%)`;
      const topMissed = brain.topMissedSubType?.[x.key]; // key is already 'reading-tfng' format
      if (topMissed) str += ` — especially "${topMissed}" answer type`;
      return str;
    });

  // Error reason analysis for reading-tfng
  const ERROR_REASON_LABELS = {
    synonymTrap:         'reads meaning not exact words (synonym trap)',
    cautiousLanguageMissed: 'misses cautious language — may/suggests/could',
    negationOverlooked:  'overlooks negation — not/never/rarely',
    scopeError:          'misreads scope — statement claims more/less than passage states',
    notGivenMarkedFalse: 'marks Not Given as False (most common T/F/NG error)',
    other:               'unclassified reasoning failure',
  };
  const tfngErrors = ctxSkills['reading-tfng']?.errorReasons || {};
  const topTfngErrors = Object.entries(tfngErrors)
    .filter(([, c]) => c > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([k, c]) => `${ERROR_REASON_LABELS[k] || k} (×${c})`);

  // Teaching history per skill
  const teachingHistory = [];
  const skillsToCheck = ['reading-tfng', 'reading-summaryCompletion', 'listening-multipleChoice', 'listening-formCompletion'];
  skillsToCheck.forEach(skillId => {
    const skill = ctxSkills[skillId];
    if (!skill) return;
    const attempts        = skill.teachingAttempts       || 0;
    const resolved        = skill.aiResolved             || false;
    const accuracyBefore  = skill.accuracyBeforeTeaching || null;
    const accuracyAfter   = skill.accuracy               || null;
    const skillName       = allSkills.find(s => s.key === skillId)?.name || skillId;
    if (attempts >= 1 && !resolved) {
      const improvement = accuracyBefore && accuracyAfter ? Math.round(accuracyAfter - accuracyBefore) : null;
      teachingHistory.push(
        `${skillName}: taught ${attempts}x — ${improvement !== null ? (improvement > 0 ? `improved ${improvement}% but not resolved` : `no improvement after ${attempts} attempts — try different approach`) : 'unresolved'}`
      );
    }
    if (skill.needsHuman) {
      teachingHistory.push(`${skillName}: AI teaching ceiling reached — flag for human mentor`);
    }
  });

  // Behaviour pattern line
  const patterns = [];
  if (brain.avgTimePerQuestionSec) patterns.push(`${brain.avgTimePerQuestionSec}s avg per question`);
  if (brain.scrollsBackPct > 30)   patterns.push('re-reads passage frequently');
  if (brain.changesAnswersPct > 20) patterns.push('changes answers often');

  // Learning style — from learningStyleSignal after 3+ sessions
  let learningStyle = '';
  if ((brain.totalSessions || 0) >= 3) {
    const signal = brain.learningStyleSignal || {};
    const topSignal = Object.entries(signal).sort((a, b) => b[1] - a[1])[0]?.[0];
    if      (topSignal === 'hear')  learningStyle = 'Auditory learner — prefers hearing explanations. Use clear verbal reasoning in feedback.';
    else if (topSignal === 'see')   learningStyle = 'Visual learner — responds to structured frameworks and decision trees.';
    else if (topSignal === 'drill') learningStyle = 'Practice-first learner — learns best through repetition. Provide more examples.';
    else if (brain.avgTimePerQuestionSec > 60)  learningStyle = 'Deliberate reader — may benefit from timed pressure practice.';
    else if (brain.scrollsBackPct > 50)         learningStyle = 'Detail-oriented — responds well to explicit passage structure cues.';
    else                                        learningStyle = 'Efficient test-taker — push with higher-complexity material.';
  }

  const targetPush = Math.min(9, parseFloat((current + 0.5).toFixed(1)));
  const focusSkill  = weak[0] ? weak[0].replace('-', ' ') : 'the student\'s weakest area';
  const focusMissed = weak[0] ? (brain.topMissedSubType?.[toSkillId(weak[0])] || brain.topMissedSubType?.[weak[0]] || null) : null;

  const purposeNote = purpose === 'university'  ? 'Use academic/scientific passage topics (research, environment, technology, history).'
                    : purpose === 'migration'   ? 'Use general-interest topics relevant to daily life, society, health, culture.'
                    : purpose === 'work'        ? 'Use professional/workplace topics where relevant.'
                    : '';

  // Specific trap instruction derived from top error pattern
  const errorReasonToInstruction = {
    synonymTrap:         'Use passages where the correct answer requires reading exact words, not paraphrasing. Warn: do not match meaning — match the exact claim.',
    cautiousLanguageMissed: 'Use passages containing cautious language: may, suggests, could, appears to, is thought to. Explain: cautious language = Not Given signal.',
    negationOverlooked:  'Use passages with negation: not, never, rarely, fails to. Highlight negation words explicitly in explanations.',
    scopeError:          'Use passages where statements overreach passage scope: all vs some, always vs usually. Target absolute qualifiers.',
    notGivenMarkedFalse: 'Apply the Alternative Reality Test in every explanation. Ask: does the passage actively contradict this, or is it simply silent?',
  };
  const topErrorKey        = Object.entries(tfngErrors).sort((a, b) => b[1] - a[1])[0]?.[0];
  const specificInstruction = topErrorKey ? errorReasonToInstruction[topErrorKey] : null;

  const lines = [
    `STUDENT: ${name} | Target: Band ${target} | Current estimate: Band ${current} | Session ${brain.totalSessions || 1}`,
    `STRONG: ${strong.length ? strong.join(', ') : 'No data yet — first session'}`,
    `WEAK: ${weakSkills.length ? weakSkills.join(', ') : 'No weak areas identified yet'}`,
    ...(topTfngErrors.length ? [`READING ERROR PATTERNS: ${topTfngErrors.join('; ')} — target these specific failures in T/F/NG questions`] : []),
    ...(teachingHistory.length ? [`TEACHING HISTORY: ${teachingHistory.join('. ')}`] : []),
    ...(() => {
      // Confidence signals — emit for any skill with ≥2 sessions of data
      const CP_SKILL_LABELS = {
        'reading-tfng':              'T/F/Not Given',
        'reading-summaryCompletion': 'Summary Completion',
        'listening-multipleChoice':  'Multiple Choice',
        'listening-formCompletion':  'Form Completion',
      };
      const signals = [];
      Object.entries(CP_SKILL_LABELS).forEach(([skillId, label]) => {
        const cp = ctxSkills[skillId]?.confidenceProfile;
        if (!cp || (cp.sessions || 0) < 2) return;
        if (cp.overconfidenceEvents  >= 2) signals.push(`rushes and gets ${label} wrong (overconfidence ×${cp.overconfidenceEvents})`);
        if (cp.underconfidenceEvents >= 2) signals.push(`hesitates on ${label} even when correct (underconfidence ×${cp.underconfidenceEvents})`);
        else if (cp.avgHesitationRate > 60) signals.push(`consistently slow to commit on ${label} (${cp.avgHesitationRate}% hesitation rate)`);
      });
      return signals.length
        ? [`CONFIDENCE PROFILE: ${signals.slice(0, 2).join('. ')}. Adjust difficulty and pacing accordingly.`]
        : [];
    })(),
    `PATTERN: ${patterns.length ? patterns.join('. ') + '.' : 'No pattern data yet.'}${learningStyle ? ' ' + learningStyle : ''}`,
    '',
    'INSTRUCTION FOR THIS SESSION:',
    '- Do NOT re-teach basics for strong skills',
    `- Primary target: ${focusSkill}${focusMissed ? ` — student consistently misses "${focusMissed}" answer type` : ''}`,
    `- Set difficulty at Band ${targetPush} — push slightly beyond current level`,
    ...(specificInstruction ? [`- SPECIFIC TRAP TO TARGET: ${specificInstruction}`] : []),
    ...(teachingHistory.some(t => t.includes('no improvement')) ? ['- Previous explanation approach failed — change the analogy, use a different example, do not repeat the same explanation'] : []),
    ...(purposeNote ? [`- TOPIC PREFERENCE: ${purposeNote}`] : []),
  ];

  return lines.join('\n');
}

// ── AI CALL ───────────────────────────────────────────────────────
export async function callAI(prompt) {
  if (studentData) studentData._contextSnippet = buildContextSnippet();
  const visionPrompt  = getVisionPrompt(studentData);
  const systemContent = [
    visionPrompt,
    `\n---\n\n${prompt.system}`,
  ].join('');

  return withRetry(async () => {
    const res = await fetch(API_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model:       'gpt-4o-mini',
        messages:    [
          { role: 'system', content: systemContent },
          { role: 'user',   content: prompt.user   }
        ],
        max_tokens:  prompt.maxTokens || 1500,
        temperature: 0.8
      })
    });
    if (!res.ok) throw new Error(`AI call failed: ${res.status}`);
    const data = await res.json();
    return data.choices[0].message.content;
  });
}
