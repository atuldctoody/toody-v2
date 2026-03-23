import { auth, db } from './firebase-config.js';
import { getVisionPrompt }  from './api/vision-prompt.js';
// NOTE: verifyAnswers is loaded via dynamic import() inside loadReadingSession()
// to prevent a module-load failure from breaking the entire app.
import { onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
  doc, getDoc, setDoc, updateDoc,
  addDoc, collection, getDocs,
  orderBy, query, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ── PWA ──────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// ── CONSTANTS ────────────────────────────────────────────────────
const API_URL        = 'https://toody-api.vercel.app/api/generate';
const TRANSCRIBE_URL = 'https://toody-api.vercel.app/api/transcribe';
const AUDIO_URL      = 'https://toody-api.vercel.app/api/audio';

const SKILL_CATALOGUE = [
  { skill: 'reading.tfng',              screen: 's-reading',   section: 'Reading',   label: 'True / False / Not Given',    icon: '📖', desc: 'AI-generated passage + 5 TF/NG questions. Toody explains every answer.' },
  { skill: 'reading.summaryCompletion', screen: 's-reading',   section: 'Reading',   label: 'Summary Completion',           icon: '📖', desc: 'Complete a gapped summary using a word bank.' },
  { skill: 'listening.multipleChoice',  screen: 's-listening', section: 'Listening', label: 'Multiple Choice',              icon: '🎧', desc: 'Pick the correct answer from detailed audio scenarios.' },
  { skill: 'listening.formCompletion',  screen: 's-listening', section: 'Listening', label: 'Form Completion',              icon: '🎧', desc: 'Complete a form from information in the audio.' },
  { skill: 'writing.task1',             screen: 's-writing',   section: 'Writing',   label: 'Task 1 — Graph Description',   icon: '✍️', desc: 'Describe an academic graph or chart in 150+ words.' },
  { skill: 'writing.task2',             screen: 's-writing',   section: 'Writing',   label: 'Task 2 — Opinion Essay',       icon: '✍️', desc: 'Write a 250-word academic opinion essay.' },
  { skill: 'speaking.part1',            screen: 's-speaking',  section: 'Speaking',  label: 'Part 1 — Personal Questions',  icon: '🎤', desc: 'Answer personal questions. Transcribed and evaluated.' },
];

// Fast lookup by skill key
const SKILL_MAP = Object.fromEntries(SKILL_CATALOGUE.map(s => [s.skill, s]));

// Legacy alias kept for any remaining references
const DAY_PLAN = {
  1: SKILL_CATALOGUE[0], 2: SKILL_CATALOGUE[2], 3: SKILL_CATALOGUE[1],
  4: SKILL_CATALOGUE[3], 6: SKILL_CATALOGUE[4], 7: SKILL_CATALOGUE[5],
  8: SKILL_CATALOGUE[6], 9: SKILL_CATALOGUE[0], 10: SKILL_CATALOGUE[0],
};

// Day 1 trap question — hardcoded, no instructions, hooks on NG confusion
const TRAP = {
  passage: '"Researchers found that students who took short breaks during study sessions performed better on subsequent recall tests than those who studied continuously for the same total duration."',
  statement: 'Studying without breaks reduces a student\'s ability to recall information.',
  answer: 'NG',
  explanation: 'The passage says students with breaks performed better — but it never says the opposite group\'s recall was reduced. "Performing better" and "reduced ability" are different claims. The passage doesn\'t explicitly state that studying continuously reduces recall, so the answer is Not Given.'
};

// ── STATE ─────────────────────────────────────────────────────────
let currentUser  = null;
let studentData  = null;
let currentPlan   = null;   // The skill plan chosen for the current/next session

// Onboarding
let obStep            = 0;
let pendingBand       = 6.5;
// Briefing
let briefingCard      = 0;
// Navigation history
const screenHistory   = [];
let   _goingBack      = false;
const NO_HISTORY_SCREENS = new Set(['s-loading','s-onboarding','s-welcome','s-home','s-phase2']);
const BRIEFING_COLORS    = ['var(--accent-light)','var(--danger-light)','var(--success-light)','var(--yellow-light)','var(--accent-light)'];
let pendingDate       = null;
let pendingExperience = null;
let pendingName       = '';
let pendingPurpose    = '';
let pendingLastScore  = null;

// Reading session
let sessionQuestions   = [];
let sessionPassage     = '';
let sessionAnswers     = {};   // { qnum: { val, isRight } }
let sessionCorrect     = 0;
let sessionTopic       = '';
let sessionCorrections = [];   // Answer corrections from verifyAnswers() — logged to Firestore

// Tough Love
let tlQ           = null;
let tlKeySentence = '';
let tlExplanation = '';
let tlPassed      = false;

// Warmup
let warmupQ       = null;
let warmupCorrect = false;

// Listening session
let listenQuestions  = [];
let listenScenario   = '';
let listenAnswers    = {};
let listenType       = 'mc';   // 'mc' | 'fc'
let listenCorrect    = 0;
let listenAudioEl    = null;   // Audio element for ElevenLabs playback
let listenHasPlayed  = false;  // Whether student has pressed play at least once

// Teach-first (Day 1)
let teachData         = null;  // AI-generated lesson content
let teachStep         = 0;     // Current step in worked example
let teachSkillKey     = '';    // Skill being taught (e.g. 'reading.tfng')
let microAttempts     = 0;     // Legacy — kept for drill compat
let teachDrillIndex   = 0;     // Current drill question index
let teachDrillCorrect = 0;     // Correct answers in quick drill
let teachStartTime    = 0;     // Date.now() at start of teach phase
let workedExIdx       = 0;     // Which of the 3 guided examples we're on
let confQIdx          = 0;     // Confidence builder question index
let confCorrect       = 0;     // Confidence correct count
// IELTS Overview
let ieltsCard         = 0;
const IELTS_COLORS    = ['var(--accent-light)','var(--accent-light)','var(--success-light)','var(--yellow-light)','var(--danger-light)','var(--success-light)'];

// ── SUBJECT-AGNOSTIC SCHEMA HELPERS ──────────────────────────────
// Converts 'reading.tfng' → 'reading-tfng'
function toSkillId(key) { return (key || '').replace('.', '-'); }

// Returns the IELTS skill map from the subject-agnostic brain schema.
// Falls back to migrating from the old studentData.skills structure.
function getIELTSSkills() {
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
function setIELTSSkillLocal(skillId, data) {
  if (!studentData.brain)                              studentData.brain = {};
  if (!studentData.brain.subjects)                     studentData.brain.subjects = {};
  if (!studentData.brain.subjects['ielts-academic'])   studentData.brain.subjects['ielts-academic'] = {};
  if (!studentData.brain.subjects['ielts-academic'].skills) studentData.brain.subjects['ielts-academic'].skills = {};
  studentData.brain.subjects['ielts-academic'].skills[skillId] = {
    ...studentData.brain.subjects['ielts-academic'].skills[skillId],
    ...data,
  };
}

// ── TEACHING CONFIG (modular per-skill teaching methodology) ──────
// To add a new subject: add a top-level key (e.g. 'cambridge-igcse').
// Core loadTeachFirst() reads from this config — no core code changes needed.
const TEACHING_CONFIG = {
  'ielts-academic': {
    name: 'IELTS Academic',
    skills: {
      'reading-tfng': {
        name:          'True / False / Not Given',
        section:       'Reading',
        hasNGButton:   true,
        answerFormat:  'True|False|NG',
        conceptBubble: `Before we start, let me show you <strong>exactly</strong> how True / False / Not Given works — and the mistake most students make.`,
        conceptPrompt: `An array of 4-5 short bullet strings about True/False/Not Given. Cover: True (passage confirms), False (passage contradicts), Not Given (passage is silent — NOT False!), the #1 mistake (confusing False with Not Given). No paragraph text. Use ** around 1-2 key words per bullet.`,
        hookPromptHint: `a testable claim that looks True but is actually Not Given`,
        workedExHint:   `True/False/Not Given reasoning`,
      },
      'reading-matchingHeadings': {
        name:          'Matching Headings',
        section:       'Reading',
        hasNGButton:   false,
        answerFormat:  'True|False',
        conceptBubble: `Before we start, let me show you <strong>exactly</strong> how Matching Headings works — and the trap most students fall into.`,
        conceptPrompt: `An array of 4-5 short bullet strings about Matching Headings. Cover: what it tests (main idea of paragraph, not details), the #1 trap (picking heading from a word match not the main idea), how to avoid it. No paragraph text. Use ** around 1-2 key words per bullet.`,
        hookPromptHint: `a testable claim that looks True but is actually False`,
        workedExHint:   `Matching Headings reasoning`,
      },
      'reading-summaryCompletion': {
        name:          'Summary Completion',
        section:       'Reading',
        hasNGButton:   false,
        answerFormat:  'True|False',
        conceptBubble: `Before we start, let me show you <strong>exactly</strong> how Summary Completion works — and why students lose marks.`,
        conceptPrompt: `An array of 4-5 short bullet strings about Summary Completion. Cover: what it tests (locating specific information), the #1 mistake (using wrong word form or changing meaning), how to avoid it. No paragraph text. Use ** around 1-2 key words per bullet.`,
        hookPromptHint: `a gap-fill claim where the wrong word form is the trap`,
        workedExHint:   `Summary Completion reasoning`,
      },
      'listening-multipleChoice': {
        name:          'Multiple Choice',
        section:       'Listening',
        hasNGButton:   false,
        answerFormat:  'A|B|C',
        conceptBubble: `Before we start, let me show you how IELTS Listening Multiple Choice works — and the distractor trap.`,
        conceptPrompt: `An array of 4-5 short bullet strings about IELTS Listening Multiple Choice. Cover: how distractors work (mentioned but not the answer), the importance of predicting before listening, and how to eliminate wrong options. Use ** around key terms.`,
        hookPromptHint: `a multiple choice question where the obvious answer is a distractor`,
        workedExHint:   `Multiple Choice reasoning`,
      },
      'listening-formCompletion': {
        name:          'Form Completion',
        section:       'Listening',
        hasNGButton:   false,
        answerFormat:  'text',
        conceptBubble: `Before we start, let me show you how IELTS Listening Form Completion works — and how to avoid spelling traps.`,
        conceptPrompt: `An array of 4-5 short bullet strings about IELTS Listening Form Completion. Cover: how answers are always spelled out or obvious, the importance of word limits, and common trap categories (numbers, names, spelling). Use ** around key terms.`,
        hookPromptHint: `a form completion gap where the word limit is the trap`,
        workedExHint:   `Form Completion reasoning`,
      },
    }
  }
};
// Session tip
let tipNotebookFn     = null;

// Full Mock Test state
let fullMockSections       = [];   // e.g. ['reading','listening','writing','speaking']
let fullMockSectionIdx     = 0;    // current section index
let fullMockContent        = {};   // generated content per section
let fullMockAnswers        = {};   // { sectionKey: { qid: answer } }
let fullMockWritingResp    = {};   // { task1: '...', task2: '...' }
let fullMockSpeakingResp   = {};   // { part1: transcript, part2: ..., part3: ... }
let fullMockTimerInterval  = null;
let fullMockTimeRemaining  = 0;    // seconds remaining for current section
let fullMockSelectedOpt    = 'all';
let fullMockResults        = {};   // final evaluated results
let fullMockRecordingEl    = null; // MediaRecorder for mock speaking
const MOCK_SECTION_TIMES   = { reading: 3600, listening: 2400, writing: 3600, speaking: 840 };
const IELTS_BAND_TABLE     = [
  [40,9.0],[39,8.5],[37,8.0],[35,7.5],[32,7.0],[30,6.5],[26,6.0],[23,5.5],
  [20,5.0],[16,4.5],[13,4.0],[10,3.5],[8,3.0],[6,2.5],[4,2.0]
];

// Writing session
let writingTaskData = null;
let writingBandEst  = 0;

// Speaking session
let speakingQs          = [];
let speakingTranscript  = '';
let speakingBandEst     = 0;
let mediaRecorder       = null;
let audioChunks         = [];
let recordTimerInterval = null;
let recordSeconds       = 0;

// Mini mock
let mockMode    = false;
let mockPhase   = 0;   // 0=reading 1=listening 2=writing 3=speaking
let mockResults = {};  // { reading, listening, writing, speaking }
let miniMockTimerInterval = null;
let miniMockTimeRemaining = 0;
const MINI_MOCK_TIMES = { 0: 1200, 1: 900, 2: 1800, 3: 420 }; // reading, listening, writing, speaking (seconds)

// Summary Completion session
let isSCSession    = false;
let sessionSummary = '';   // SC summary text
let sessionWordBank = [];  // SC word bank

// ── TOAST NOTIFICATIONS ──────────────────────────────────────────
function showToast(message, duration = 3000) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const pill = document.createElement('div');
  pill.className = 'toast-pill';
  pill.textContent = message;
  container.appendChild(pill);
  setTimeout(() => {
    pill.classList.add('fade-out');
    setTimeout(() => pill.remove(), 320);
  }, duration);
}

// ── API RETRY ─────────────────────────────────────────────────────
async function withRetry(fn, maxRetries = 3) {
  let lastErr;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try { return await fn(); } catch (err) {
      lastErr = err;
      if (attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
      }
    }
  }
  throw lastErr;
}

// ── AI JSON PARSER ────────────────────────────────────────────────
// GPT-4o-mini often wraps responses in ```json … ``` despite instructions.
// This strips all markdown code fences before parsing.
function parseAIJson(raw) {
  let s = (raw || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  return JSON.parse(s);
}

// ── MARKDOWN → HTML HELPERS ──────────────────────────────────────
// Converts **bold** and *italic* markers from AI text to HTML tags.
// Apply to every AI explanation/feedback before inserting into innerHTML.
function renderMarkdown(s) {
  return String(s || '')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+?)\*/g,  '<em>$1</em>');
}
// Legacy alias — retained for any call sites not yet updated
const boldify = renderMarkdown;

// ── ANSWER NORMALISER ────────────────────────────────────────────
function normaliseAnswer(raw) {
  if (raw == null) return '';
  let s = String(raw).toLowerCase().trim();
  s = s.replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, '');
  if (s === 'notgiven' || s === 'ng' || s === 'notgiven') s = 'notgiven';
  if (s === 'true'  || s === 't') s = 'true';
  if (s === 'false' || s === 'f') s = 'false';
  return s;
}

// ── ADAPTIVE ENGINE HELPERS ───────────────────────────────────────
function accToBand(acc) {
  if (acc >= 90) return 8.5; if (acc >= 80) return 7.5; if (acc >= 70) return 7.0;
  if (acc >= 60) return 6.5; if (acc >= 50) return 6.0; if (acc >= 40) return 5.5;
  return 5.0;
}

function calcBandEstimate() {
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

function isMockUnlocked() {
  const skills = getIELTSSkills();
  return ['reading','listening','writing','speaking'].every(sec =>
    Object.keys(skills).some(k => k.startsWith(sec + '-') && (skills[k]?.attempted || 0) > 0)
  );
}

function getExamDaysRemaining() {
  const d = studentData?.examDate;
  if (!d) return null;
  const today = new Date(); today.setHours(0,0,0,0);
  const exam  = new Date(d); exam.setHours(0,0,0,0);
  return Math.ceil((exam - today) / 86400000);
}

function pickNextSkill(forceSkillKey) {
  if (forceSkillKey) {
    const found = SKILL_MAP[forceSkillKey];
    if (found) return { ...found, reason: 'You selected this skill.' };
  }
  const daysToExam = getExamDaysRemaining();
  if (daysToExam !== null && daysToExam >= 0 && daysToExam <= 7) {
    return { skill: 'minimock', screen: null, section: 'Mock', label: 'Mini Mock', icon: '🏁',
      desc: 'Full timed session across all 4 sections.',
      reason: `Only ${daysToExam} day${daysToExam === 1 ? '' : 's'} until your exam — full mock practice now.` };
  }

  const skills = getIELTSSkills();
  const recentSkills = studentData?.recentSkills || [];
  const lastSkill = recentSkills[0] || null;

  // Section recency: how many sessions ago was each section last practiced
  const sectionLastIdx = {};
  SKILL_CATALOGUE.forEach(s => {
    const idx = recentSkills.indexOf(s.skill);
    const prev = sectionLastIdx[s.section];
    sectionLastIdx[s.section] = prev === undefined ? (idx === -1 ? 99 : idx) : Math.min(prev, idx === -1 ? 99 : idx);
  });

  const scored = SKILL_CATALOGUE.map(s => {
    const id = toSkillId(s.skill);
    const data = skills[id] || {};
    return { ...s, id, data,
      accuracy:  data.accuracy  ?? null,
      attempted: data.attempted || 0,
      isStrong:  data.isStrong  || false,
      isLast:    s.skill === lastSkill,
    };
  });

  let candidates = scored.filter(s => !s.isLast && !s.isStrong);
  if (!candidates.length) candidates = scored.filter(s => !s.isLast);
  if (!candidates.length) candidates = scored;

  // 1) Never-attempted first, prefer section least recently covered
  const never = candidates.filter(s => s.attempted === 0);
  if (never.length) {
    const pick = never.sort((a, b) => (sectionLastIdx[b.section] ?? 0) - (sectionLastIdx[a.section] ?? 0))[0];
    return { ...pick, reason: `You haven't tried ${pick.label} yet — let's see where you start.` };
  }

  // 2) Section rotation: if any section not practiced in 3+ sessions, prioritise it
  const starved = Object.entries(sectionLastIdx).filter(([, i]) => i >= 3).sort((a, b) => b[1] - a[1]);
  if (starved.length) {
    const sc = candidates.filter(s => s.section === starved[0][0]);
    if (sc.length) {
      const pick = sc.sort((a, b) => (a.accuracy ?? -1) - (b.accuracy ?? -1))[0];
      return { ...pick, reason: `It's been a while since ${pick.section} — let's keep all sections sharp.` };
    }
  }

  // 3) Lowest accuracy
  candidates.sort((a, b) => (a.accuracy ?? -1) - (b.accuracy ?? -1));
  const pick = candidates[0];
  let reason;
  if (pick.accuracy === null)      reason = `You haven't tried ${pick.label} yet.`;
  else if (pick.accuracy < 50)     reason = `Your ${pick.label} accuracy is ${pick.accuracy}% — biggest opportunity right now.`;
  else if (pick.accuracy < 70)     reason = `Your ${pick.label} accuracy is ${pick.accuracy}% — still below target. Let's close that gap.`;
  else                             reason = `Keeping ${pick.label} sharp — ${pick.accuracy}% is good but there's still room.`;
  return { ...pick, reason };
}

// ── ROUTING ──────────────────────────────────────────────────────
function goTo(id) {
  // Push current screen to history (unless going back, or it's a non-navigable screen)
  if (!_goingBack) {
    const current = document.querySelector('.screen.active')?.id;
    if (current && !NO_HISTORY_SCREENS.has(current) && current !== id) {
      screenHistory.push(current);
    }
  }
  _goingBack = false;

  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add('active');
  const computed = window.getComputedStyle(el).display;
  if (computed === 'none') el.style.display = 'flex';
  // Reset history when returning to home
  if (id === 's-home') screenHistory.length = 0;

  _updateBackBtn(id);
  window.scrollTo(0, 0);
}

function _updateBackBtn(screenId) {
  const btn = document.getElementById('global-back-btn');
  if (!btn) return;
  const show = screenHistory.length > 0
    || (screenId === 's-briefing' && briefingCard > 0)
    || (screenId === 's-ielts'    && ieltsCard    > 0);
  btn.classList.toggle('hidden', !show);
}

window.goBack = function () {
  const cur = document.querySelector('.screen.active')?.id;
  if (cur === 's-briefing' && briefingCard > 0) { _showBriefingCard(briefingCard - 1, 'back'); return; }
  if (cur === 's-ielts'    && ieltsCard    > 0) { _showIELTSCard(ieltsCard    - 1, 'back'); return; }
  if (screenHistory.length === 0) return;
  _goingBack = true;
  const prev = screenHistory.pop();
  goTo(prev);
};

// ── AUTH ─────────────────────────────────────────────────────────
onAuthStateChanged(auth, async user => {
  if (!user) {
    window.location.href = 'index.html';
    return;
  }
  currentUser = user;
  await bootApp();
});

window.bootApp = async function () {
  try {
    const snap = await getStudentDoc(currentUser.uid);
    const data = snap.exists() ? snap.data() : null;

    // Gate: hasExperience is the ONLY field written exclusively by the new
    // 3-question onboarding (setExperience). It is:
    //   undefined  — old account that pre-dates new onboarding
    //   null       — skeleton doc created but onboarding not completed
    //   true/false — onboarding completed ✓
    // Any value other than true or false means onboarding is incomplete.
    const onboardingDone = data !== null
      && (data.hasExperience === true || data.hasExperience === false);

    if (!onboardingDone) {
      // Create skeleton doc only if no doc exists yet
      if (!snap.exists()) {
        await createSkeletonDoc(currentUser.uid);
      }
      initOnboarding();
      goTo('s-onboarding');
    } else {
      studentData = data;
      renderHome();
      goTo('s-home');
    }
  } catch {
    showBootError();
  }
};

function showBootError() {
  const el = document.getElementById('s-loading');
  if (el) {
    el.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;gap:16px;padding:40px 24px;text-align:center">
        <div style="font-size:40px">⚠️</div>
        <p style="font-size:15px;font-weight:600;color:var(--text)">Could not connect to Toody.</p>
        <p style="font-size:13px;color:var(--muted);line-height:1.6">Check your internet connection and try again.</p>
        <button onclick="bootApp()" style="background:var(--accent);color:#fff;border:none;border-radius:var(--radius-full);padding:14px 28px;font-size:15px;font-weight:600;cursor:pointer">Retry</button>
      </div>`;
    goTo('s-loading');
  }
}

// ── FIREBASE HELPERS ─────────────────────────────────────────────
function getStudentDoc(uid) {
  return getDoc(doc(db, 'students', uid));
}

async function createStudentDoc(uid, data) {
  const blank = { accuracy: 0, attempted: 0, lastPracticed: null, trend: 'new' };
  await setDoc(doc(db, 'students', uid), {
    name:             data.name,
    email:            data.email,
    targetBand:       data.targetBand,
    examDate:         data.examDate || null,
    currentBand:      data.targetBand,
    weekNumber:       1,
    dayNumber:        1,
    streak:           0,
    isNewStudent:     false,
    createdAt:        serverTimestamp(),
    lastSession:      null,
    toughLoveResults: 0,
    weakAreas:        [],
    brain: {
      subjects: {
        'ielts-academic': {
          skills: {
            'reading-tfng':              { ...blank },
            'reading-matchingHeadings':  { ...blank },
            'reading-summaryCompletion': { ...blank },
            'listening-multipleChoice':  { ...blank },
            'listening-formCompletion':  { ...blank },
            'listening-mapDiagram':      { ...blank },
            'writing-task1':   { bandEstimate: 0, attempted: 0, lastPracticed: null, trend: 'new' },
            'writing-task2':   { bandEstimate: 0, attempted: 0, lastPracticed: null, trend: 'new' },
            'speaking-part1':  { bandEstimate: 0, attempted: 0, lastPracticed: null, trend: 'new' },
            'speaking-part2':  { bandEstimate: 0, attempted: 0, lastPracticed: null, trend: 'new' },
            'speaking-part3':  { bandEstimate: 0, attempted: 0, lastPracticed: null, trend: 'new' },
          }
        }
      }
    }
  });
}

async function createSkeletonDoc(uid) {
  const blank = { accuracy: 0, attempted: 0, lastPracticed: null, trend: 'new' };
  await setDoc(doc(db, 'students', uid), {
    name:             currentUser.displayName || 'Student',
    email:            currentUser.email       || '',
    targetBand:       6.5,
    examDate:         null,
    hasExperience:    null,
    currentBand:      6.5,
    weekNumber:       1,
    dayNumber:        1,
    streak:           0,
    isNewStudent:     true,
    createdAt:        serverTimestamp(),
    lastSession:      null,
    toughLoveResults: 0,
    weakAreas:        [],
    brain: {
      subjects: {
        'ielts-academic': {
          skills: {
            'reading-tfng':              { ...blank },
            'reading-matchingHeadings':  { ...blank },
            'reading-summaryCompletion': { ...blank },
            'listening-multipleChoice':  { ...blank },
            'listening-formCompletion':  { ...blank },
            'listening-mapDiagram':      { ...blank },
            'writing-task1':  { bandEstimate: 0, attempted: 0, lastPracticed: null, trend: 'new' },
            'writing-task2':  { bandEstimate: 0, attempted: 0, lastPracticed: null, trend: 'new' },
            'speaking-part1': { bandEstimate: 0, attempted: 0, lastPracticed: null, trend: 'new' },
            'speaking-part2': { bandEstimate: 0, attempted: 0, lastPracticed: null, trend: 'new' },
            'speaking-part3': { bandEstimate: 0, attempted: 0, lastPracticed: null, trend: 'new' },
          }
        }
      }
    }
  });
}

async function updateStudentDoc(uid, updates) {
  await updateDoc(doc(db, 'students', uid), updates);
}

async function saveSessionDoc(uid, data) {
  const ref = await addDoc(collection(db, 'students', uid, 'sessions'), {
    ...data,
    date: serverTimestamp()
  });
  return ref;
}

// Generates a 3-sentence mentor-facing session narrative and saves it to the session doc.
// Fire-and-forget — never awaited, never blocks UI.
async function generateAndSaveNarrative(uid, sessionRef, ctx) {
  try {
    const prompt = {
      system: 'You are a clinical IELTS tutor writing session notes for a human mentor. Be specific, factual, and concise.',
      user: `Session data: ${JSON.stringify(ctx)}

In exactly 3 sentences, summarise this student's session. Sentence 1: what they practised and their overall score. Sentence 2: the specific pattern you observed — what they got right and what they got wrong at a sub-type level. Sentence 3: one honest observation about where the learning is and is not happening. Be specific and clinical — this will be read by a human mentor, not the student.`
    };
    const narrative = await callAI(prompt);
    await updateDoc(sessionRef, { sessionNarrative: narrative.trim() });
  } catch { /* non-critical — narrative is additive only */ }
}

// ── ONBOARDING ───────────────────────────────────────────────────
const BAND_MEANINGS = {
  '5.0': 'Modest user',
  '5.5': 'Modest user',
  '6.0': 'Competent user',
  '6.5': 'Competent user',
  '7.0': 'Good user',
  '7.5': 'Good user',
  '8.0': 'Very good user',
  '8.5': 'Very good user',
  '9.0': 'Expert user',
};

function initOnboarding() {
  pendingBand       = 6.5;
  pendingDate       = null;
  pendingExperience = null;
  pendingName       = currentUser.displayName?.split(' ')[0] || '';
  pendingPurpose    = '';
  pendingLastScore  = null;
  // Pre-fill name input
  const nameInput = document.getElementById('ob-name-input');
  if (nameInput) nameInput.value = pendingName;
  // Reset slider
  const slider = document.getElementById('ob-band-slider');
  if (slider) slider.value = '6.5';
  const display = document.getElementById('ob-band-display');
  if (display) display.textContent = '6.5';
  const meaning = document.getElementById('ob-band-meaning');
  if (meaning) meaning.textContent = 'Competent user';
  showObStep(0);
}

window.showObStep = function showObStep(n) {
  document.querySelectorAll('.ob-step').forEach(s => {
    s.classList.remove('active');
    s.classList.add('hidden');
  });
  const step = document.getElementById(`ob-${n}`);
  if (step) {
    step.classList.remove('hidden');
    step.classList.add('active');
    window.scrollTo(0, 0);
  }
  // Update dots
  document.querySelectorAll('.ob-dot').forEach((dot, i) => {
    dot.classList.toggle('active', i === n);
    dot.classList.toggle('done', i < n);
  });
  obStep = n;
};

window.obSetName = function () {
  const val = document.getElementById('ob-name-input').value.trim();
  pendingName = val || currentUser.displayName?.split(' ')[0] || 'there';
  showObStep(1);
};

window.obSetPurpose = function (btn) {
  pendingPurpose = btn.dataset.val;
  // Visual selection
  document.querySelectorAll('#ob-purpose-group .ob-choice-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  // Auto-advance after brief highlight
  setTimeout(() => showObStep(2), 300);
};

window.updateBandSlider = function () {
  const val = document.getElementById('ob-band-slider').value;
  pendingBand = parseFloat(val);
  document.getElementById('ob-band-display').textContent = val;
  const meaning = document.getElementById('ob-band-meaning');
  if (meaning) meaning.textContent = BAND_MEANINGS[val] || '';
};

window.setExamDate = function () {
  const val = document.getElementById('ob-date-input').value;
  pendingDate = val || null;
  showObStep(4);
};

window.skipExamDate = function () {
  pendingDate = null;
  showObStep(4);
};

window.obPickExperience = function (hasExperience) {
  pendingExperience = hasExperience;
  document.getElementById('ob-exp-yes').classList.toggle('selected', hasExperience === true);
  document.getElementById('ob-exp-no').classList.toggle('selected', hasExperience === false);
  if (hasExperience) {
    document.getElementById('ob-last-score-wrap').classList.remove('hidden');
  } else {
    document.getElementById('ob-last-score-wrap').classList.add('hidden');
    pendingLastScore = null;
  }
  document.getElementById('ob-finish-btn').classList.remove('hidden');
};

window.finishOnboarding = async function () {
  if (pendingExperience === true) {
    const scoreEl = document.getElementById('ob-last-score');
    pendingLastScore = scoreEl?.value ? parseFloat(scoreEl.value) : null;
  }
  document.getElementById('ob-finish-btn').disabled = true;
  document.getElementById('ob-saving').classList.remove('hidden');
  document.getElementById('ob-error').classList.add('hidden');

  try {
    await updateStudentDoc(currentUser.uid, {
      preferredName:  pendingName,
      purpose:        pendingPurpose    || 'other',
      targetBand:     pendingBand       || 6.5,
      examDate:       pendingDate       || null,
      hasExperience:  pendingExperience,
      lastScore:      pendingLastScore  || null,
      isNewStudent:   false,
      currentBand:    pendingBand       || 6.5,
    });
    const snap = await getStudentDoc(currentUser.uid);
    studentData = snap.data();
    renderHome();
    // Show welcome screen, then go into briefing
    const welcomeName = document.getElementById('welcome-name');
    if (welcomeName) welcomeName.textContent = pendingName || 'there';
    goTo('s-welcome');
    setTimeout(() => initBriefing(), 2500);
  } catch {
    document.getElementById('ob-saving').classList.add('hidden');
    document.getElementById('ob-error').classList.remove('hidden');
    document.getElementById('ob-finish-btn').disabled = false;
  }
};

// ── DAY 1 BRIEFING ───────────────────────────────────────────────
function initBriefing() {
  briefingCard = 0;
  document.querySelectorAll('.bc').forEach((c, i) => {
    c.classList.toggle('active', i === 0);
    c.classList.toggle('hidden', i !== 0);
    c.style.animation = '';
  });
  _setBriefingBg(0);
  _updateBriefingDots(0);
  goTo('s-briefing');
}

function _setBriefingBg(idx) {
  const wrap = document.getElementById('s-briefing');
  if (wrap) wrap.style.background = BRIEFING_COLORS[idx] || 'var(--accent-light)';
}

function _updateBriefingDots(idx) {
  document.querySelectorAll('.bc-dot').forEach((d, i) => {
    d.classList.toggle('active', i === idx);
    d.classList.toggle('done', i < idx);
  });
  _updateBackBtn('s-briefing');
}

function _showBriefingCard(nextIdx, direction) {
  const currEl = document.getElementById(`bc-${briefingCard}`);
  const nextEl = document.getElementById(`bc-${nextIdx}`);
  if (!currEl || !nextEl) return;

  // Hide current
  currEl.classList.remove('active');
  currEl.classList.add('hidden');
  currEl.style.animation = '';

  // Animate next in
  nextEl.classList.remove('hidden');
  nextEl.style.animation = 'none';
  nextEl.offsetHeight; // force reflow
  nextEl.style.animation = direction === 'back' ? 'bc-enter-back 0.3s ease' : 'bc-enter-fwd 0.3s ease';
  nextEl.classList.add('active');

  briefingCard = nextIdx;
  _setBriefingBg(nextIdx);
  _updateBriefingDots(nextIdx);
}

window.nextBriefingCard = function () { _showBriefingCard(briefingCard + 1, 'forward'); };

window.finishBriefing = async function () {
  try {
    await updateStudentDoc(currentUser.uid, { briefingSeen: true });
    if (studentData) studentData.briefingSeen = true;
  } catch { /* non-critical */ }
  initIELTSOverview();
};

// ── IELTS OVERVIEW (one-time, after briefing) ─────────────────────
function initIELTSOverview() {
  // Mark as seen immediately so navigating back doesn't re-trigger it
  if (currentUser && studentData && !studentData.hasSeenIELTSOverview) {
    updateStudentDoc(currentUser.uid, { hasSeenIELTSOverview: true }).catch(() => {});
    if (studentData) studentData.hasSeenIELTSOverview = true;
  }
  ieltsCard = 0;
  document.querySelectorAll('#s-ielts .bc').forEach((c, i) => {
    c.classList.toggle('active', i === 0);
    c.classList.toggle('hidden', i !== 0);
    c.style.animation = '';
  });
  document.getElementById('s-ielts').style.background = IELTS_COLORS[0];
  document.querySelectorAll('#s-ielts .bc-dot').forEach((d, i) => {
    d.classList.toggle('active', i === 0);
    d.classList.remove('done');
  });
  goTo('s-ielts');
}

window.nextIELTSCard = function () { _showIELTSCard(ieltsCard + 1, 'forward'); };

function _showIELTSCard(nextIdx, direction) {
  const currEl = document.getElementById(`ic-${ieltsCard}`);
  const nextEl = document.getElementById(`ic-${nextIdx}`);
  if (!currEl || !nextEl) return;
  currEl.classList.remove('active'); currEl.classList.add('hidden'); currEl.style.animation = '';
  nextEl.classList.remove('hidden');
  nextEl.style.animation = 'none';
  nextEl.offsetHeight;
  nextEl.style.animation = direction === 'back' ? 'bc-enter-back 0.3s ease' : 'bc-enter-fwd 0.3s ease';
  nextEl.classList.add('active');
  ieltsCard = nextIdx;
  document.getElementById('s-ielts').style.background = IELTS_COLORS[nextIdx] || IELTS_COLORS[0];
  document.querySelectorAll('#s-ielts .bc-dot').forEach((d, i) => {
    d.classList.toggle('active', i === nextIdx);
    d.classList.toggle('done', i < nextIdx);
  });
  _updateBackBtn('s-ielts');
}

window.finishIELTSOverview = function () {
  loadTeachFirst('reading.tfng');
};

// ── HOME ─────────────────────────────────────────────────────────
function renderHome() {
  if (!studentData) return;
  const sessionCount = (studentData.dayNumber || 1) - 1;
  const name   = studentData.preferredName || studentData.name?.split(' ')[0] || 'there';
  const streak = studentData.streak || 0;
  const target = studentData.targetBand || 6.5;
  const daysToExam = getExamDaysRemaining();
  const bandEst = calcBandEstimate();
  const mockUnlocked = isMockUnlocked();

  const hour  = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  document.getElementById('home-greeting').innerHTML = `${greet}, <span style="color:var(--accent)">${name}</span>.`;

  // Subtitle: exam countdown or generic
  let subtitle = sessionCount === 0
    ? "Let's find out where you're starting from."
    : daysToExam !== null && daysToExam >= 0
    ? `<strong style="color:var(--accent)">${daysToExam} day${daysToExam === 1 ? '' : 's'}</strong> until your exam. Every session counts.`
    : `${sessionCount} session${sessionCount !== 1 ? 's' : ''} done. Keep the streak alive.`;
  document.getElementById('home-subtitle').innerHTML = subtitle;

  document.getElementById('home-streak').textContent  = `🔥 ${streak} day${streak !== 1 ? 's' : ''}`;

  // Replace day badge with band estimate or session count
  const badgeEl = document.getElementById('home-day-badge');
  if (badgeEl) badgeEl.textContent = bandEst !== null ? `Band ~${bandEst}` : `${sessionCount} done`;

  // Band progress bar
  const progressCard = document.getElementById('home-band-progress');
  if (progressCard) {
    if (bandEst !== null) {
      const min = 5.0, span = target - min;
      const pct = span > 0 ? Math.min(100, Math.max(0, Math.round(((bandEst - min) / span) * 100))) : 100;
      document.getElementById('band-progress-fill').style.width  = `${pct}%`;
      document.getElementById('band-progress-label').textContent = `${pct}% of the way to Band ${target}`;
      document.getElementById('band-est-text').textContent       = `Current: ~${bandEst}`;
      document.getElementById('band-target-text').textContent    = `Target: ${target}`;
      progressCard.classList.remove('hidden');
    } else {
      progressCard.classList.add('hidden');
    }
  }

  // Adaptive recommendation
  currentPlan = pickNextSkill();
  const sessionCard = document.getElementById('today-session-card');
  if (currentPlan.skill === 'minimock') {
    document.getElementById('today-day-label').textContent = '🏁 Exam mode';
    document.getElementById('today-skill').textContent     = 'Mini Mock Test';
    document.getElementById('today-desc').textContent      = currentPlan.desc;
    document.getElementById('today-reason').textContent    = currentPlan.reason;
    sessionCard.style.display = '';
  } else {
    document.getElementById('today-day-label').textContent = `${currentPlan.section} · Toody recommends`;
    document.getElementById('today-skill').textContent     = currentPlan.label;
    document.getElementById('today-desc').textContent      = currentPlan.desc;
    document.getElementById('today-reason').textContent    = `Why: ${currentPlan.reason}`;
    sessionCard.style.display = '';
  }

  // Final 3 days message
  const readinessCard = document.getElementById('home-readiness-card');
  if (readinessCard) {
    if (daysToExam !== null && daysToExam >= 0 && daysToExam <= 3) {
      readinessCard.classList.remove('hidden');
    } else {
      readinessCard.classList.add('hidden');
    }
  }

  // Exam countdown banner (if 4–30 days out)
  const countdownBanner = document.getElementById('home-countdown-banner');
  if (countdownBanner) {
    if (daysToExam !== null && daysToExam > 3 && daysToExam <= 30) {
      document.getElementById('countdown-days').textContent = daysToExam;
      countdownBanner.classList.remove('hidden');
    } else {
      countdownBanner.classList.add('hidden');
    }
  }

  // Skill picker grid
  renderSkillPicker();

  // Mock card
  const mockCard = document.getElementById('home-mock-card');
  if (mockCard) mockCard.style.display = mockUnlocked ? '' : 'none';

  renderSkillSnapshot();
}

function renderSkillPicker() {
  const el = document.getElementById('home-skill-picker');
  if (!el) return;
  const skills = getIELTSSkills();
  el.innerHTML = SKILL_CATALOGUE.map(s => {
    const data = skills[toSkillId(s.skill)] || {};
    const pct  = data.attempted > 0 ? (data.accuracy ?? data.bandEstimate !== undefined ? Math.round((data.bandEstimate||0)*10) : null) : null;
    const acc  = data.attempted > 0 ? (data.accuracy !== undefined ? `${data.accuracy}%` : data.bandEstimate !== undefined ? `Band ${data.bandEstimate}` : '—') : 'Not tried';
    const isActive = currentPlan?.skill === s.skill;
    return `<button class="skill-pick-btn${isActive ? ' active' : ''}" onclick="window.pickSkill('${s.skill}')">
      <span class="spb-icon">${s.icon}</span>
      <span class="spb-body">
        <span class="spb-label">${s.label}</span>
        <span class="spb-acc">${acc}</span>
      </span>
    </button>`;
  }).join('');
}

window.pickSkill = function (skillKey) {
  currentPlan = pickNextSkill(skillKey);
  // Update session card
  document.getElementById('today-day-label').textContent = `${currentPlan.section} · Your choice`;
  document.getElementById('today-skill').textContent     = currentPlan.label;
  document.getElementById('today-desc').textContent      = currentPlan.desc;
  document.getElementById('today-reason').textContent    = '';
  // Refresh picker to show new active
  renderSkillPicker();
};

function renderSkillSnapshot() {
  const sk = getIELTSSkills();
  const rows = [
    { label: 'T / F / Not Given',  pct: (sk['reading-tfng']?.attempted              || 0) > 0 ? sk['reading-tfng'].accuracy              : null },
    { label: 'Summ. Completion',   pct: (sk['reading-summaryCompletion']?.attempted  || 0) > 0 ? sk['reading-summaryCompletion'].accuracy  : null },
    { label: 'Multiple Choice',    pct: (sk['listening-multipleChoice']?.attempted   || 0) > 0 ? sk['listening-multipleChoice'].accuracy   : null },
    { label: 'Form Completion',    pct: (sk['listening-formCompletion']?.attempted   || 0) > 0 ? sk['listening-formCompletion'].accuracy    : null },
  ];
  const el      = document.getElementById('home-skill-snapshot');
  const anyData = rows.some(r => r.pct !== null);
  if (!anyData) {
    el.innerHTML = '<div style="font-size:13px;color:var(--muted);text-align:center;padding:10px 0">Complete your first session to see your skill data.</div>';
    return;
  }
  el.innerHTML = rows.map(r => {
    const pct = r.pct;
    return `
      <div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border);">
        <span style="font-size:13px;font-weight:400;flex:1">${r.label}</span>
        ${pct === null
          ? '<span style="font-size:11px;color:var(--muted2)">Not tested</span>'
          : `<div style="flex:1;height:5px;background:var(--border);border-radius:4px;overflow:hidden;">
               <div style="width:${pct}%;height:100%;border-radius:4px;background:${pct>=80?'var(--success)':pct>=50?'var(--yellow)':'var(--danger)'};transition:width 0.6s ease;"></div>
             </div>
             <span style="font-size:11px;font-weight:600;color:var(--muted);width:32px;text-align:right">${pct}%</span>`}
      </div>`;
  }).join('');
}

// ── SESSION INTRO ─────────────────────────────────────────────────
window.startSession = function () {
  const plan = currentPlan || pickNextSkill();
  currentPlan = plan;

  document.getElementById('si-icon').textContent    = plan.icon || '📖';
  document.getElementById('si-section').textContent = plan.section || 'Session';
  document.getElementById('si-skill').textContent   = plan.label;

  const sessionCount = (studentData?.dayNumber || 1) - 1;
  const expects = buildExpectations(sessionCount, plan.skill);
  document.getElementById('si-expect-list').innerHTML = expects
    .map(e => `<div class="expect-item"><div class="expect-icon">${e.icon}</div><div class="expect-text">${e.text}</div></div>`)
    .join('');

  goTo('s-session-intro');
};

function buildExpectations(sessionCount, skill) {
  const list = [];
  if (sessionCount > 0) list.push({ icon: '🧠', text: 'Quick memory check first — one question from a previous session.' });
  list.push({ icon: '📝', text: 'AI-generated material specific to your current band level — different every session.' });
  list.push({ icon: '💬', text: 'Instant feedback after every answer with the exact reasoning.' });
  if (sessionCount > 0) list.push({ icon: '🔍', text: 'Get one right and Toody will ask you to prove your reasoning — the Tough Love Check.' });
  return list;
}

window.goToSession = function (forceSkillKey) {
  const plan = currentPlan || pickNextSkill(forceSkillKey);
  currentPlan = plan;
  const sessionCount = (studentData?.dayNumber || 1) - 1;

  // Update all screen session badges to show session count
  const badge = `Session ${sessionCount + 1}`;
  ['warmup','reading','listening','writing','speaking','nb'].forEach(id => {
    const el = document.getElementById(`${id}-day-badge`);
    if (el) el.textContent = badge;
  });

  // Special plan types
  if (plan.skill === 'minimock') { setupMiniMock(); goTo('s-minimock'); return; }

  const isFirstTimeSkill = (getIELTSSkills()[toSkillId(plan.skill)]?.attempted || 0) === 0;

  // Onboarding gates (in order): briefing → IELTS overview → teach-first
  if (plan.screen === 's-reading' && isFirstTimeSkill && !studentData.briefingSeen) {
    renderHome(); initBriefing();
  } else if (plan.screen === 's-reading' && isFirstTimeSkill && !studentData.hasSeenIELTSOverview) {
    renderHome(); initIELTSOverview();
  } else if (isFirstTimeSkill && (plan.screen === 's-reading' || plan.screen === 's-listening')) {
    loadTeachFirst(plan.skill);
  } else if (sessionCount > 0 && plan.screen === 's-reading') {
    loadWarmup(plan);
  } else {
    launchSkillScreen(plan);
  }
};

// ── WARMUP ────────────────────────────────────────────────────────
async function loadWarmup(plan) {
  warmupQ       = null;
  warmupCorrect = false;
  document.getElementById('warmup-loading').classList.remove('hidden');
  document.getElementById('warmup-content').classList.add('hidden');
  document.getElementById('warmup-result').className = 'result-flash';
  document.getElementById('warmup-continue-btn').classList.add('hidden');
  document.querySelectorAll('.warmup-btn').forEach(b => { b.disabled = false; b.classList.remove('correct','wrong'); });
  goTo('s-warmup');

  const lastSkill = (studentData.recentSkills || [])[0] || '';
  const prevLabel = SKILL_MAP[lastSkill]?.label || 'reading';
  const band      = studentData.targetBand || 6.5;

  const prompt = {
    system: 'You are an IELTS Academic examiner creating retrieval-practice questions. Return valid JSON only, no markdown, no extra text.',
    user: `Create one True/False/Not Given memory-check question for a Band ${band} IELTS student to revisit ${prevLabel} skills.
Return ONLY this JSON:
{"passage": "2 sentences of academic text", "statement": "one claim about the passage", "answer": "True|False|NG", "explanation": "one sentence explaining the answer"}`
  };

  try {
    const raw  = await callAI(prompt);
    warmupQ = parseAIJson(raw);
    document.getElementById('warmup-passage').textContent   = warmupQ.passage;
    document.getElementById('warmup-statement').textContent = warmupQ.statement;
    document.getElementById('warmup-loading').classList.add('hidden');
    document.getElementById('warmup-content').classList.remove('hidden');
  } catch {
    launchSkillScreen(plan);
  }
}

window.answerWarmup = function (val) {
  if (!warmupQ) return;
  document.querySelectorAll('.warmup-btn').forEach(b => { b.disabled = true; });
  warmupCorrect = normaliseAnswer(val) === normaliseAnswer(warmupQ.answer);
  const rf = document.getElementById('warmup-result');
  rf.classList.add('show', warmupCorrect ? 'good' : 'bad');
  rf.innerHTML = warmupCorrect
    ? `✅ Correct. ${boldify(warmupQ.explanation)}`
    : `❌ The answer is ${warmupQ.answer}. ${boldify(warmupQ.explanation)}`;
  document.getElementById('warmup-continue-btn').classList.remove('hidden');
};

window.continueFromWarmup = function () {
  launchSkillScreen(currentPlan || pickNextSkill());
};

function launchSkillScreen(plan) {
  if      (plan.screen === 's-reading')   loadReadingSession();
  else if (plan.screen === 's-listening') loadListeningSession();
  else if (plan.screen === 's-writing')   loadWritingSession();
  else if (plan.screen === 's-speaking')  loadSpeakingSession();
  else if (plan.skill  === 'minimock')    { setupMiniMock(); goTo('s-minimock'); }
  else                                    loadReadingSession();
}

// ── TEACH FIRST — 10-minute interactive learning phase ─────────
async function loadTeachFirst(skillKey) {
  teachData         = null;
  teachStep         = 0;
  teachStartTime    = Date.now();
  workedExIdx       = 0;
  confQIdx          = 0;
  confCorrect       = 0;
  teachDrillIndex   = 0;
  teachDrillCorrect = 0;
  teachSkillKey     = skillKey || 'reading.tfng';

  ['teach-hook','teach-concept','teach-worked','teach-reinforce','teach-confidence'].forEach(id => {
    document.getElementById(id)?.classList.add('hidden');
  });
  document.getElementById('teach-loading').classList.remove('hidden');
  goTo('s-teach');

  const band = studentData?.targetBand || 6.5;
  // Look up per-skill config from TEACHING_CONFIG (subject-agnostic)
  const skillId     = toSkillId(skillKey);
  const skillCfg    = TEACHING_CONFIG['ielts-academic']?.skills[skillId] || TEACHING_CONFIG['ielts-academic']?.skills['reading-tfng'];
  const skillLabel  = skillCfg.name;
  const isMH        = skillId === 'reading-matchingHeadings';

  // ── TEACHING ATTEMPTS TRACKING ────────────────────────────────────
  // Record that Teach-First fired for this skill, and snapshot accuracy before teaching.
  if (currentUser) {
    try {
      const prevSkillBrainTeach = studentData?.brain?.subjects?.['ielts-academic']?.skills?.[skillId] || {};
      const newTeachAttempts    = (prevSkillBrainTeach.teachingAttempts || 0) + 1;
      const currentAccForSkill  = getIELTSSkills()[skillId]?.accuracy ?? null;
      const subjPathTeach       = `brain.subjects.ielts-academic.skills.${skillId}`;
      await updateStudentDoc(currentUser.uid, {
        [`${subjPathTeach}.teachingAttempts`]:      newTeachAttempts,
        [`${subjPathTeach}.accuracyBeforeTeaching`]: currentAccForSkill,
        [`${subjPathTeach}.aiResolved`]:            prevSkillBrainTeach.aiResolved || false,
        [`${subjPathTeach}.needsHuman`]:            prevSkillBrainTeach.needsHuman || false,
      });
    } catch { /* non-critical */ }
  }

  // Update the concept section header text from config
  const conceptBubble = document.querySelector('#teach-concept .toody-bubble');
  if (conceptBubble) conceptBubble.innerHTML = skillCfg.conceptBubble;
  const strategyLabel = document.querySelector('#teach-concept .card-label');
  if (strategyLabel) strategyLabel.textContent = 'The Strategy';

  const ans = skillCfg.answerFormat;
  const conceptPromptDetail = skillCfg.conceptPrompt;

  const exSchema = `{"label":"Easy|Medium|Hard","passage":"2 academic sentences","statement":"testable claim","answer":"${ans}","steps":["Step 1 reasoning","Step 2 reasoning","Step 3 reasoning"],"conclusion":"Therefore the answer is X — one sentence.","insight":"One sentence for the student: what to notice about this specific example or trap."}`;

  const prompt = {
    system: 'You are an expert IELTS Academic teacher. Return valid JSON only, no markdown, no preamble.',
    user: `Generate a 10-minute interactive lesson on ${skillLabel} for a Band ${band} IELTS student.

Return ONLY this JSON:
{
  "concept": ${conceptPromptDetail},
  "hookQuestion": {
    "passage": "2 academic sentences — choose a tricky topic where the Not Given trap applies",
    "statement": "a testable claim that looks True but is actually ${isMH ? 'False' : 'Not Given'}",
    "answer": "${isMH ? 'True|False' : 'True|False|NG'}",
    "insight": "Here is what most students miss: one sentence explaining exactly why this question trips people up."
  },
  "workedExamples": [
    ${exSchema.replace('Easy|Medium|Hard', 'Easy')},
    ${exSchema.replace('Easy|Medium|Hard', 'Medium — introduce the most common trap for this question type')},
    ${exSchema.replace('Easy|Medium|Hard', 'Hard — the exact sub-type where most Band 6 students fail')}
  ],
  "confidenceQuestions": [
    {"passage": "2 academic sentences — set at Band ${Math.max(5, band - 0.5)} difficulty", "statement": "a clear achievable claim", "answer": "${ans}", "explanation": "one sentence"},
    {"passage": "2 academic sentences on a different topic — set at Band ${Math.max(5, band - 0.5)} difficulty", "statement": "another achievable claim", "answer": "${ans}", "explanation": "one sentence"}
  ],
  "drillQuestions": [
    {"passage": "2 academic sentences", "statement": "a testable claim", "answer": "${ans}", "explanation": "one sentence"},
    {"passage": "2 academic sentences on a different topic", "statement": "another testable claim", "answer": "${ans}", "explanation": "one sentence"}
  ]
}`,
    maxTokens: 3500
  };

  try {
    const raw  = await callAI(prompt);
    teachData  = parseAIJson(raw);

    // Render concept bullets
    const bullets = Array.isArray(teachData.concept)
      ? teachData.concept
      : String(teachData.concept).split('\n').filter(p => p.trim());
    const boldify = s => s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    document.getElementById('teach-concept-body').innerHTML =
      '<ul class="teach-bullets">' +
      bullets.map(b => `<li>${boldify(b.replace(/^[-•]\s*/, ''))}</li>`).join('') +
      '</ul>';

    document.getElementById('teach-loading').classList.add('hidden');
    renderHookQuestion();
  } catch {
    showToast('Having trouble connecting — please check your internet and try again.');
    loadReadingSession();
  }
}

// Hook phase functions (min 0-2)
function renderHookQuestion() {
  const hq = teachData.hookQuestion;
  if (!hq) { window.startConceptPhase(); return; }
  document.getElementById('teach-hook-passage').textContent = hq.passage;
  document.getElementById('teach-hook-statement').textContent = hq.statement;
  const isMH = teachSkillKey === 'reading.matchingHeadings';
  const ngBtn = document.querySelector('#teach-hook-btns [data-mv="NG"]');
  if (ngBtn) ngBtn.classList.toggle('hidden', isMH);
  // Reset all buttons to neutral unselected state
  document.querySelectorAll('#teach-hook-btns .tfng-btn').forEach(b => {
    b.disabled = false;
    b.classList.remove('correct', 'wrong');
    b.blur();
  });
  document.getElementById('teach-hook-reveal').classList.add('hidden');
  document.getElementById('teach-hook').classList.remove('hidden');
}

window.answerHook = function (val) {
  const hq = teachData.hookQuestion;
  if (!hq) return;
  document.querySelectorAll('#teach-hook-btns .tfng-btn').forEach(b => {
    b.disabled = true;
    if (normaliseAnswer(b.dataset.mv) === normaliseAnswer(hq.answer)) b.classList.add('correct');
    else if (b.dataset.mv === val) b.classList.add('wrong');
  });
  document.getElementById('teach-hook-insight').textContent = hq.insight || '';
  document.getElementById('teach-hook-reveal').classList.remove('hidden');
  window.scrollTo(0, document.body.scrollHeight);
};

window.startConceptPhase = function () {
  document.getElementById('teach-hook').classList.add('hidden');
  document.getElementById('teach-concept').classList.remove('hidden');
};

// Guided practice — 3 worked examples (min 5-8)
function renderWorkedExampleAt(idx) {
  const examples = teachData.workedExamples || [];
  if (idx >= examples.length) { renderConfidenceQuestion(0); return; }
  const we = examples[idx];
  const labels = ['Easy', 'Medium', 'Hard'];

  document.getElementById('teach-ex-counter').textContent = `Example ${idx + 1} of 3 — ${labels[idx] || ''}`;
  document.getElementById('teach-ex-fill').style.width = `${((idx + 1) / 3) * 100}%`;
  document.getElementById('teach-we-passage').innerHTML = (we.passage || '')
    .split('\n').filter(p => p.trim()).map(p => `<p>${p}</p>`).join('');
  document.getElementById('teach-we-statement').textContent = we.statement || '';

  const insightEl = document.getElementById('teach-ex-insight');
  insightEl.classList.add('hidden');
  document.getElementById('teach-ex-insight-text').textContent = '';

  const tryBtn = document.getElementById('teach-try-btn');
  tryBtn.classList.add('hidden');
  tryBtn.textContent = idx < 2 ? 'Next example →' : 'Try on your own →';

  const answerToChoice = { true: 'confirms', false: 'contradicts', ng: 'silent' };
  const correctChoice  = answerToChoice[(we.answer || 'ng').toLowerCase()] || 'silent';

  document.getElementById('teach-steps-container').innerHTML = `
    <div class="predict-block" id="predict-0">
      <div class="predict-prompt">What part of the passage is relevant here?</div>
      <button class="btn-secondary mt8" onclick="window.teachRevealStep(0)">Show me the thinking <span class="arrow">→</span></button>
      <div class="predict-reveal hidden" id="predict-reveal-0">
        <div class="card" style="margin-top:12px">
          <div class="card-label" style="color:var(--accent)">Step 1</div>
          <div class="teach-step-text">${(we.steps || [])[0] || ''}</div>
        </div>
      </div>
    </div>
    <div class="predict-block hidden" id="predict-1">
      <div class="predict-prompt">What is this statement actually claiming?</div>
      <button class="btn-secondary mt8" onclick="window.teachRevealStep(1)">Reveal <span class="arrow">→</span></button>
      <div class="predict-reveal hidden" id="predict-reveal-1">
        <div class="card" style="margin-top:12px">
          <div class="card-label" style="color:var(--accent)">Step 2</div>
          <div class="teach-step-text">${(we.steps || [])[1] || ''}</div>
        </div>
      </div>
    </div>
    <div class="predict-block hidden" id="predict-2">
      <div class="predict-prompt">Does the passage confirm, contradict, or stay silent on this?</div>
      <div class="step3-choices mt8">
        <button class="step3-btn" data-choice="confirms"    onclick="window.teachPickStep3('confirms','${correctChoice}')">✓ Confirms it</button>
        <button class="step3-btn" data-choice="contradicts" onclick="window.teachPickStep3('contradicts','${correctChoice}')">✗ Contradicts it</button>
        <button class="step3-btn" data-choice="silent"      onclick="window.teachPickStep3('silent','${correctChoice}')">? Stays silent</button>
      </div>
      <div class="predict-reveal hidden" id="predict-reveal-2">
        <div class="card" style="margin-top:12px">
          <div class="card-label" style="color:var(--accent)">Step 3</div>
          <div class="teach-step-text">${(we.steps || [])[2] || ''}</div>
        </div>
        <div class="card" style="margin-top:8px;border:2px solid var(--success)">
          <div class="card-label" style="color:var(--success)">✅ Answer</div>
          <div class="teach-step-text" style="font-weight:600">${we.conclusion || ''}</div>
        </div>
      </div>
    </div>`;

  document.getElementById('teach-reinforce').classList.add('hidden');
  document.getElementById('teach-confidence').classList.add('hidden');
  document.getElementById('teach-worked').classList.remove('hidden');
  window.scrollTo(0, 0);
}

window.teachRevealStep = function (stepIdx) {
  document.getElementById(`predict-reveal-${stepIdx}`).classList.remove('hidden');
  // Hide the reveal button after click
  const block = document.getElementById(`predict-${stepIdx}`);
  const btn = block.querySelector('.btn-secondary');
  if (btn) btn.classList.add('hidden');
  // Show next step
  const nextBlock = document.getElementById(`predict-${stepIdx + 1}`);
  if (nextBlock) nextBlock.classList.remove('hidden');
};

window.teachPickStep3 = function (choice, correct) {
  document.querySelectorAll('.step3-btn').forEach(b => {
    b.disabled = true;
    if (b.dataset.choice === correct)  b.classList.add('step3-correct');
    if (b.dataset.choice === choice && choice !== correct) b.classList.add('step3-wrong');
  });
  document.getElementById('predict-reveal-2').classList.remove('hidden');
  // Show per-example insight
  const examples = teachData.workedExamples || [];
  const insight = examples[workedExIdx]?.insight || '';
  if (insight) {
    document.getElementById('teach-ex-insight-text').textContent = insight;
    document.getElementById('teach-ex-insight').classList.remove('hidden');
  }
  document.getElementById('teach-try-btn').classList.remove('hidden');
  window.scrollTo(0, document.body.scrollHeight);
};

window.advanceWorkedExample = function () {
  workedExIdx++;
  renderWorkedExampleAt(workedExIdx);
};

window.startWorkedExamples = function () {
  workedExIdx = 0;
  document.getElementById('teach-reinforce').classList.add('hidden');
  renderWorkedExampleAt(0);
};

window.teachShowReinforce = function () {
  ['teach-hook','teach-concept','teach-worked'].forEach(id =>
    document.getElementById(id)?.classList.add('hidden')
  );
  document.getElementById('teach-reinforce-content').classList.add('hidden');
  document.getElementById('teach-continue-micro-btn').classList.add('hidden');
  document.getElementById('teach-reinforce').classList.remove('hidden');
};

window.teachReinforceHear = function () {
  saveLearningStyleSignal('hear');
  const bullets = Array.isArray(teachData.concept) ? teachData.concept : [];
  const skillLabel2 = teachSkillKey === 'reading.matchingHeadings' ? 'Matching Headings' : 'True, False, Not Given';
  const text = `Here is how ${skillLabel2} reading works. ${bullets.map(b => b.replace(/\*\*/g, '')).join(' ')}`;
  const contentEl = document.getElementById('teach-reinforce-content');
  contentEl.innerHTML = '<div class="screen-loading" style="min-height:60px"><div class="spinner"></div><p>Generating audio…</p></div>';
  contentEl.classList.remove('hidden');

  fetch(AUDIO_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text })
  }).then(r => r.json()).then(data => {
    if (!data.audio) throw new Error('no audio');
    const blob = base64ToBlob(data.audio, data.mimeType || 'audio/mpeg');
    const url  = URL.createObjectURL(blob);
    const audio = new Audio(url);
    contentEl.innerHTML = `
      <div class="card mt8" style="text-align:center">
        <p style="font-size:13px;color:var(--muted);margin-bottom:12px">Toody is reading the reasoning aloud.</p>
        <button class="btn" id="hear-play-btn" onclick="window.toggleHearAudio()">\u25b6 Play</button>
      </div>`;
    window._hearAudio = audio;
    audio.addEventListener('ended', () => {
      document.getElementById('hear-play-btn').textContent = '\u25b6 Replay';
    });
    document.getElementById('teach-continue-micro-btn').classList.remove('hidden');
  }).catch(() => {
    contentEl.innerHTML = `<div class="card mt8"><p style="font-size:13px;color:var(--muted)">Audio unavailable. Read the steps above to review the reasoning.</p></div>`;
    document.getElementById('teach-continue-micro-btn').classList.remove('hidden');
  });
};

window.toggleHearAudio = function () {
  const audio = window._hearAudio;
  if (!audio) return;
  const btn = document.getElementById('hear-play-btn');
  if (audio.paused) { audio.play(); btn.textContent = '\u23f8 Pause'; }
  else              { audio.pause(); btn.textContent = '\u25b6 Play'; }
};

window.teachReinforceSee = function () {
  saveLearningStyleSignal('see');
  const contentEl = document.getElementById('teach-reinforce-content');
  contentEl.innerHTML = `
    <div class="card mt8">
      <div class="card-label">Decision Tree</div>
      <div class="dtree">
        <div class="dtree-node root">Read the statement</div>
        <div class="dtree-arrow">\u2193</div>
        <div class="dtree-node">Find the relevant part of the passage</div>
        <div class="dtree-arrow">\u2193</div>
        <div class="dtree-row">
          <div class="dtree-branch">
            <div class="dtree-node branch-q">Passage <strong>confirms</strong> it?</div>
            <div class="dtree-arrow">\u2193</div>
            <div class="dtree-node answer true-node"><strong>TRUE</strong></div>
          </div>
          <div class="dtree-branch">
            <div class="dtree-node branch-q">Passage <strong>contradicts</strong> it?</div>
            <div class="dtree-arrow">\u2193</div>
            <div class="dtree-node answer false-node"><strong>FALSE</strong></div>
          </div>
          <div class="dtree-branch">
            <div class="dtree-node branch-q">Passage is <strong>silent</strong>?</div>
            <div class="dtree-arrow">\u2193</div>
            <div class="dtree-node answer ng-node"><strong>NOT GIVEN</strong></div>
          </div>
        </div>
      </div>
    </div>`;
  contentEl.classList.remove('hidden');
  document.getElementById('teach-continue-micro-btn').classList.remove('hidden');
};

window.teachReinforceDrill = function () {
  saveLearningStyleSignal('drill');
  teachDrillIndex   = 0;
  teachDrillCorrect = 0;
  renderDrillQuestion(0);
};

function renderDrillQuestion(idx) {
  const qs = teachData.drillQuestions || teachData.confidenceQuestions || [];
  if (idx >= qs.length) {
    // Drill complete
    const contentEl = document.getElementById('teach-reinforce-content');
    contentEl.innerHTML = `<div class="card mt8" style="background:var(--success-light);border:1.5px solid var(--success-mid)"><p style="font-size:14px;font-weight:600;color:var(--success-text);text-align:center">${teachDrillCorrect} / ${qs.length} correct. Nice work.</p></div>`;
    document.getElementById('teach-continue-micro-btn').classList.remove('hidden');
    return;
  }
  const q = qs[idx];
  const contentEl = document.getElementById('teach-reinforce-content');
  contentEl.innerHTML = `
    <div class="card mt8" id="drill-card-${idx}">
      <div class="card-label">Quick drill ${idx + 1} of ${qs.length}</div>
      <div class="passage-snippet" style="font-size:13px;font-style:italic;color:var(--muted);margin-bottom:8px">${q.passage}</div>
      <div class="q-text" style="margin-bottom:12px">${q.statement}</div>
      <div class="tfng">
        <button class="tfng-btn" data-dv="True"  onclick="window.answerDrill(${idx},'True')">✓ True</button>
        <button class="tfng-btn" data-dv="False" onclick="window.answerDrill(${idx},'False')">✗ False</button>
        <button class="tfng-btn" data-dv="NG"    onclick="window.answerDrill(${idx},'NG')">? Not Given</button>
      </div>
      <div class="result-flash" id="drill-result-${idx}"></div>
    </div>`;
  contentEl.classList.remove('hidden');
}

window.answerDrill = function (idx, val) {
  const qs2 = teachData.drillQuestions || teachData.confidenceQuestions || [];
  const q = qs2[idx];
  const isRight = normaliseAnswer(val) === normaliseAnswer(q.answer);
  if (isRight) teachDrillCorrect++;

  document.querySelectorAll(`#drill-card-${idx} .tfng-btn`).forEach(b => {
    b.disabled = true;
    if      (normaliseAnswer(b.dataset.dv) === normaliseAnswer(q.answer)) b.classList.add('correct');
    else if (b.dataset.dv === val && !isRight) b.classList.add('wrong');
  });
  const rf = document.getElementById(`drill-result-${idx}`);
  rf.classList.add('show', isRight ? 'good' : 'bad');
  const qs2b = teachData.drillQuestions || teachData.confidenceQuestions || [];
  const hasNext = idx + 1 < qs2b.length;
  rf.innerHTML = (isRight ? `✅ Correct. ${boldify(q.explanation)}` : `❌ Answer: <strong>${q.answer}</strong>. ${boldify(q.explanation)}`)
    + (hasNext ? `<br><button class="btn-secondary" style="margin-top:10px" onclick="renderDrillQuestion(${idx + 1})">Next question →</button>` : '');
  if (!hasNext) setTimeout(() => renderDrillQuestion(idx + 1), 1000);
};

function saveLearningStyleSignal(type) {
  if (!currentUser || !studentData) return;
  const prev   = studentData.brain?.learningStyleSignal || {};
  const updated = { ...prev, [type]: (prev[type] || 0) + 1 };
  updateStudentDoc(currentUser.uid, { 'brain.learningStyleSignal': updated }).catch(() => {});
  if (studentData.brain) studentData.brain.learningStyleSignal = updated;
}

// Confidence builder (min 8-10)
function renderConfidenceQuestion(idx) {
  confQIdx = idx;
  const qs = teachData.confidenceQuestions || [];
  if (idx >= qs.length) {
    document.getElementById('teach-celebrate').classList.remove('hidden');
    setTimeout(() => window.startRealSession(), 2000);
    return;
  }
  const q = qs[idx];
  document.getElementById('teach-conf-counter').textContent = `Question ${idx + 1} of 2`;
  document.getElementById('teach-conf-passage').textContent = q.passage;
  document.getElementById('teach-conf-statement').textContent = q.statement;
  const isMH = teachSkillKey === 'reading.matchingHeadings';
  const ngBtn = document.querySelector('#teach-conf-btns [data-mv="NG"]');
  if (ngBtn) ngBtn.classList.toggle('hidden', isMH);
  document.querySelectorAll('#teach-conf-btns .tfng-btn').forEach(b => {
    b.disabled = false; b.classList.remove('correct', 'wrong');
  });
  const rf = document.getElementById('teach-conf-result');
  rf.className = 'result-flash'; rf.textContent = '';
  document.getElementById('teach-celebrate').classList.add('hidden');
  document.getElementById('teach-worked').classList.add('hidden');
  document.getElementById('teach-confidence').classList.remove('hidden');