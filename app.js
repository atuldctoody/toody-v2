import { auth, db } from './firebase-config.js';
import { getVisionPrompt } from './api/vision-prompt.js';
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
let sessionQuestions = [];
let sessionPassage   = '';
let sessionAnswers   = {};   // { qnum: { val, isRight } }
let sessionCorrect   = 0;
let sessionTopic     = '';

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
const IELTS_COLORS    = ['var(--accent-light)','var(--accent-light)','var(--success-light)','var(--yellow-light)','var(--danger-light)'];

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

window.finishIELTSOverview = async function () {
  try {
    await updateStudentDoc(currentUser.uid, { hasSeenIELTSOverview: true });
    if (studentData) studentData.hasSeenIELTSOverview = true;
  } catch { /* non-critical */ }
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
  rf.textContent = warmupCorrect
    ? `✅ Correct. ${warmupQ.explanation}`
    : `❌ The answer is ${warmupQ.answer}. ${warmupQ.explanation}`;
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
  rf.innerHTML = isRight ? `\u2705 Correct. ${q.explanation}` : `\u274c Answer: <strong>${q.answer}</strong>. ${q.explanation}`;

  setTimeout(() => renderDrillQuestion(idx + 1), 1200);
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
  window.scrollTo(0, 0);
}

window.answerConfidence = function (val) {
  const qs = teachData.confidenceQuestions || [];
  const q = qs[confQIdx];
  if (!q) return;
  const isCorrect = normaliseAnswer(val) === normaliseAnswer(q.answer);
  if (isCorrect) confCorrect++;
  document.querySelectorAll('#teach-conf-btns .tfng-btn').forEach(b => {
    b.disabled = true;
    if (normaliseAnswer(b.dataset.mv) === normaliseAnswer(q.answer)) b.classList.add('correct');
    else if (b.dataset.mv === val && !isCorrect) b.classList.add('wrong');
  });
  const rf = document.getElementById('teach-conf-result');
  rf.classList.add('show', isCorrect ? 'good' : 'bad');
  rf.textContent = isCorrect
    ? `✅ Correct. ${q.explanation}`
    : `❌ The answer is ${q.answer}. ${q.explanation}`;
  setTimeout(() => {
    if (confQIdx + 1 >= qs.length) {
      const bubble = document.getElementById('teach-conf-bubble');
      if (confCorrect === 2 && bubble) bubble.textContent = "You’ve got the pattern. Now let’s see it under real conditions.";
      else if (bubble)                 bubble.textContent = "Good effort — let’s see the full session now.";
      document.getElementById('teach-celebrate').classList.remove('hidden');
      setTimeout(() => window.startRealSession(), 2000);
    } else {
      renderConfidenceQuestion(confQIdx + 1);
    }
  }, 1600);
};
window.startRealSession = function () {
  const plan = currentPlan || pickNextSkill();
  const label = plan.label || 'Reading';
  const teachingMinutes = teachStartTime ? Math.round((Date.now() - teachStartTime) / 60000) : 0;
  if (currentUser && teachingMinutes > 0) {
    updateStudentDoc(currentUser.uid, { lastTeachingMinutes: teachingMinutes }).catch(() => {});
  }
  document.getElementById('phase2-skill-name').textContent = label;
  goTo('s-phase2');
  setTimeout(() => loadReadingSession(), 1500);
};

// ── TIP SCREEN ────────────────────────────────────────────────────
async function showSessionTip({ accuracy, behaviour, missedSubTypes, skillKey }) {
  tipNotebookFn = tipNotebookFn || null;
  goTo('s-tip');
  document.getElementById('tip-loading').classList.remove('hidden');
  document.getElementById('tip-content').classList.add('hidden');
  document.getElementById('tip-done-btn').classList.add('hidden');
  document.getElementById('tip-action-pill').classList.add('hidden');

  const ctx            = buildContextSnippet();
  const ieltsSkillsForTip = getIELTSSkills();
  const topMissed = Object.entries(missedSubTypes || {})
    .sort((a,b) => b[1] - a[1]).map(e => e[0])[0] || 'N/A';

  const prompt = {
    role: 'user',
    content: `You are Toody, an IELTS Academic coach. A student just completed a ${skillKey} session.

Student context: ${ctx}
- Avg time per question: ${behaviour?.avgTimePerQuestionSec || '?'}s
- Scrolled back to passage: ${behaviour?.scrollsBackCount || 0} times
- Changed answers: ${behaviour?.answerChangesCount || 0} times
- Accuracy: ${accuracy}%
- Missed sub-types: ${JSON.stringify(missedSubTypes || {})}
- Known weak area: ${topMissed}

Generate a personalised coaching tip. Return ONLY this JSON:
{
  "observation": "one sentence about a specific behaviour pattern from this session",
  "revelation": "one sentence explaining what that pattern reveals about their current approach",
  "action": "one concrete thing they can do differently in their next session",
  "nextSessionInstruction": "max 12 words — the single most important focus for next session"
}`
  };

  try {
    const raw = await callAI(prompt);
    const tip = parseAIJson(raw);
    document.getElementById('tip-text').textContent =
      [tip.observation, tip.revelation, tip.action].filter(Boolean).join(' ');
    if (tip.nextSessionInstruction) {
      document.getElementById('tip-action-text').textContent = tip.nextSessionInstruction;
      document.getElementById('tip-action-pill').classList.remove('hidden');
    }
    document.getElementById('tip-loading').classList.add('hidden');
    document.getElementById('tip-content').classList.remove('hidden');
    document.getElementById('tip-done-btn').classList.remove('hidden');
  } catch {
    if (tipNotebookFn) { tipNotebookFn(); tipNotebookFn = null; }
  }
}

window.finishTip = function () {
  if (tipNotebookFn) { tipNotebookFn(); tipNotebookFn = null; }
};

// ── BEHAVIOUR TRACKING ───────────────────────────────────────────
let bhvSessionStart  = 0;
let bhvQStart        = {};   // { qnum: timestamp when question became active }
let bhvQDuration     = {};   // { qnum: ms taken before answering }
let bhvScrolledUp    = false;
let bhvScrollHandler = null;
let bhvAnswerChanges = 0;    // count of answer changes before submission
let bhvPrevFCValues  = {};   // { qnum: last recorded non-empty value } for FC inputs
let bhvQChangedAnswer = {};  // { qnum: true } if student changed answer at least once

function startSessionTracking() {
  bhvSessionStart  = Date.now();
  bhvQStart        = {};
  bhvQDuration     = {};
  bhvScrolledUp    = false;
  bhvAnswerChanges  = 0;
  bhvPrevFCValues   = {};
  bhvQChangedAnswer = {};
  if (bhvScrollHandler) {
    window.removeEventListener('scroll', bhvScrollHandler);
    bhvScrollHandler = null;
  }
}

function trackQStart(qnum) {
  bhvQStart[qnum] = Date.now();
}

function trackQAnswer(qnum) {
  if (bhvQStart[qnum]) {
    bhvQDuration[qnum] = Date.now() - bhvQStart[qnum];
  }
}

function trackAnswerChange() {
  bhvAnswerChanges++;
}

function setupScrollTracking() {
  let maxY = 0;
  let moved = false;
  bhvScrollHandler = () => {
    const y = window.scrollY;
    if (y > maxY) maxY = y;
    if (moved && y < maxY - 120) bhvScrolledUp = true;
    if (y > 80) moved = true;
  };
  window.addEventListener('scroll', bhvScrollHandler, { passive: true });
}

function getBehaviourPayload() {
  const sessionDurationSec    = Math.round((Date.now() - bhvSessionStart) / 1000);
  const durations              = Object.values(bhvQDuration);
  const avgTimePerQuestionSec  = durations.length
    ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length / 1000) : 0;
  const questionTimesSeconds   = {};
  Object.entries(bhvQDuration).forEach(([k, v]) => { questionTimesSeconds[k] = Math.round(v / 1000); });
  return { sessionDurationSec, avgTimePerQuestionSec, scrolledBackToPassage: bhvScrolledUp, questionTimesSeconds, answerChangesCount: bhvAnswerChanges };
}

// ── CONFIDENCE METRICS ────────────────────────────────────────────
// Computes per-session confidence signals from per-question timing data.
// questions: array of { id, answer }
// answers:   { id: { val, isRight } } (reading) or { id: 'A' } (MC/FC)
function computeConfidenceMetrics(questions, answers) {
  const answered = questions.filter(q => bhvQDuration[q.id] != null);
  if (!answered.length) return null;

  let confidentCount = 0, hesitatedCount = 0, overconf = 0, underconf = 0;

  answered.forEach(q => {
    const durSec  = bhvQDuration[q.id] / 1000;
    const changed = bhvQChangedAnswer[q.id] || false;
    const a       = answers[q.id];
    const isRight = typeof a === 'object'
      ? a.isRight === true
      : normaliseAnswer(String(a || '')) === normaliseAnswer(q.answer || '');

    // Confident = answered in ≤20s without changing
    if (durSec <= 20 && !changed) confidentCount++;
    // Hesitation = took >15s before committing
    if (durSec > 15)              hesitatedCount++;
    // Overconfidence = answered in <10s but wrong
    if (durSec < 10 && !isRight)  overconf++;
    // Underconfidence = hesitated (>15s) but got it right
    if (durSec > 15 && isRight)   underconf++;
  });

  const n = answered.length;
  return {
    confidenceScore:      Math.round((confidentCount / n) * 100),
    hesitationRate:       Math.round((hesitatedCount / n) * 100),
    overconfidenceEvents: overconf,
    underconfidenceEvents: underconf,
  };
}

async function updateStudentBrain(behaviour, accuracy, skillKey) {
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

async function updateWeakAreas(skillKey, missedSubTypes) {
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

// ── READING SESSION ───────────────────────────────────────────────
async function loadReadingSession() {
  sessionQuestions = [];
  sessionPassage   = '';
  sessionAnswers   = {};
  sessionCorrect   = 0;
  sessionTopic     = '';
  sessionSummary   = '';
  sessionWordBank  = [];
  isSCSession      = false;
  tlQ = null; tlPassed = false;

  goTo('s-reading');
  document.getElementById('reading-loading').classList.remove('hidden');
  document.getElementById('reading-content').classList.add('hidden');

  const submitBtn = document.getElementById('btn-reading-submit');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Submit answers →';
  submitBtn.onclick = () => window.submitReading();

  const skillKey = currentPlan?.skill || 'reading.tfng';
  isSCSession    = (skillKey === 'reading.summaryCompletion');

  const _scDay = (studentData?.dayNumber || 1) - 1;
  document.getElementById('reading-p1-dot').className = _scDay > 0 ? 'phase-dot done' : 'phase-dot';

  const band = studentData?.targetBand || 6.5;

  let prompt;
  if (isSCSession) {
    prompt = {
      system: 'You are an IELTS Academic examiner. Generate reading exercises at the exact band level specified. Return valid JSON only, no markdown, no preamble.',
      user: `Create a Summary Completion IELTS Academic reading exercise for a Band ${band} student.

The wordBank must contain exactly 8 items: the 5 correct answers PLUS 3 distractor words.
- Correct answers: exact words from the passage that fill the 5 gaps
- Distractors: real English words (NOT labels or placeholders) that could grammatically fit at least one gap but are factually wrong based on the passage. For example, if the passage is about urban growth, a good distractor is "rural" — it fits grammatically but contradicts the passage.
- NEVER use placeholder labels like "decoy1", "distractor2", "word3", "correctAnswer4", or any similar pattern. Every item in wordBank must be a real English word.

Return ONLY this JSON:
{
  "passage": "3 paragraphs of academic prose on any interesting topic (170-220 words total)",
  "topic": "2-4 word topic label",
  "summaryText": "A 60-80 word summary of the passage with 5 gaps marked as [1], [2], [3], [4], [5]. Each gap must be fillable with ONE word from the passage.",
  "wordBank": ["significant","natural","limited","urban","migration","stable","complex","rural"],
  "questions": [
    {"id": 1, "text": "Gap [1]", "answer": "exact single word from passage that fills gap 1", "explanation": "why this word fills gap 1", "keySentence": "sentence from passage containing this word"},
    {"id": 2, "text": "Gap [2]", "answer": "exact single word from passage that fills gap 2", "explanation": "why this word fills gap 2", "keySentence": "sentence from passage containing this word"},
    {"id": 3, "text": "Gap [3]", "answer": "exact single word from passage that fills gap 3", "explanation": "why this word fills gap 3", "keySentence": "sentence from passage containing this word"},
    {"id": 4, "text": "Gap [4]", "answer": "exact single word from passage that fills gap 4", "explanation": "why this word fills gap 4", "keySentence": "sentence from passage containing this word"},
    {"id": 5, "text": "Gap [5]", "answer": "exact single word from passage that fills gap 5", "explanation": "why this word fills gap 5", "keySentence": "sentence from passage containing this word"}
  ]
}`
    };
  } else {
    prompt = {
      system: 'You are an IELTS Academic examiner. Generate reading exercises at the exact band level specified. Return valid JSON only, no markdown, no preamble.',
      user: `Create a True/False/Not Given IELTS Academic reading exercise for a Band ${band} student.

For each question, set "errorReason" to the reasoning trap this question is specifically designed to test. Valid values:
- "synonymTrap" — statement paraphrases passage with near-synonym; student reads meaning not exact evidence
- "hedgingMissed" — answer hinges on hedging language in passage (may, suggests, could, tends to)
- "negationOverlooked" — answer hinges on a negation in passage or statement (not, never, rarely, without)
- "scopeError" — statement claims more or less than passage actually states (all vs some, always vs usually)
- "notGivenMarkedFalse" — passage is silent on claim; designed to catch students who mark silence as contradiction
- "other" — does not fit a specific category above

Return ONLY this JSON:
{
  "passage": "3 paragraphs of academic prose on any interesting topic (170-220 words total)",
  "topic": "2-4 word topic label",
  "questions": [
    {"id": 1, "text": "statement", "answer": "True",  "explanation": "name the exact word/phrase that confirms this", "keySentence": "exact sentence from passage", "errorReason": "synonymTrap"},
    {"id": 2, "text": "statement", "answer": "False", "explanation": "name the exact word/phrase that contradicts this", "keySentence": "exact sentence from passage", "errorReason": "negationOverlooked"},
    {"id": 3, "text": "statement", "answer": "NG",    "explanation": "name what the passage says and what it does NOT say", "keySentence": "exact sentence from passage", "errorReason": "notGivenMarkedFalse"},
    {"id": 4, "text": "statement", "answer": "True",  "explanation": "name the exact word/phrase that confirms this", "keySentence": "exact sentence from passage", "errorReason": "hedgingMissed"},
    {"id": 5, "text": "statement", "answer": "False", "explanation": "name the exact word/phrase that contradicts this", "keySentence": "exact sentence from passage", "errorReason": "scopeError"}
  ]
}`
    };
  }

  try {
    const raw    = await callAI(prompt);
    const parsed = parseAIJson(raw);

    sessionPassage   = parsed.passage;
    sessionQuestions = parsed.questions;
    sessionTopic     = parsed.topic || 'Reading';

    if (isSCSession) {
      sessionSummary  = parsed.summaryText || '';
      sessionWordBank = parsed.wordBank    || [];
      renderSCSession(parsed);
    } else {
      buildToughLove(parsed.questions, parsed.passage);
      renderReadingSession(parsed);
    }

    document.getElementById('reading-loading').classList.add('hidden');
    document.getElementById('reading-content').classList.remove('hidden');

    startSessionTracking();
    setupScrollTracking();
    trackQStart(1);
  } catch (err) {
    console.error('[loadReadingSession] failed:', err);
    showToast('Having trouble connecting — please check your internet and try again.');
    document.getElementById('reading-loading').innerHTML =
      `<p style="color:var(--danger);padding:20px;text-align:center">Could not load passage. Please go back and try again.<br><small style="opacity:.6">${err?.message || ''}</small></p>`;
  }
}

function renderSCSession(parsed) {
  document.getElementById('reading-intro-msg').textContent =
    'Read the passage carefully, then complete the summary below using words from the word bank.';
  document.getElementById('reading-q-label').textContent = 'Summary Completion';
  document.getElementById('reading-q-instructions').innerHTML =
    'Fill each gap with <strong>one word</strong> from the Word Bank. Each word can be used only once.';

  document.getElementById('reading-passage').innerHTML = (parsed.passage || '')
    .split('\n').filter(p => p.trim()).map(p => `<p>${p}</p>`).join('');

  const shuffledBank = [...(parsed.wordBank || [])].sort(() => Math.random() - 0.5);

  const wordBankOpts = shuffledBank
    .map(w => `<option value="${w.toLowerCase()}">${w}</option>`).join('');

  const summaryHtml = (parsed.summaryText || '').replace(/\[(\d+)\]/g, (_, num) => {
    const qid = parseInt(num);
    return `<select class="sc-gap-select" id="sc-gap-${qid}" onchange="window.onSCSelectChange()">
      <option value="">—</option>${wordBankOpts}
    </select>`;
  });

  const wordBankHtml = shuffledBank
    .map(w => `<span class="sc-word-chip">${w}</span>`).join('');

  document.getElementById('questions-container').innerHTML = `
    <div class="sc-summary-wrap">
      <div class="sc-summary-label">Summary — fill in the gaps</div>
      <div class="sc-summary-text">${summaryHtml}</div>
    </div>
    <div class="sc-wordbank-wrap">
      <div class="sc-summary-label">Word Bank</div>
      <div class="sc-wordbank">${wordBankHtml}</div>
    </div>
    <div id="sc-results-container"></div>`;
}

window.onSCSelectChange = function () {
  const allFilled = sessionQuestions.every(q => {
    const el = document.getElementById(`sc-gap-${q.id}`);
    return el && el.value !== '';
  });
  document.getElementById('btn-reading-submit').disabled = !allFilled;
};

function submitSCSession() {
  sessionCorrect = 0;
  let resultsHtml = '';

  sessionQuestions.forEach(q => {
    const el      = document.getElementById(`sc-gap-${q.id}`);
    const val     = el ? el.value : '';
    const correct = q.answer || '';
    const isRight = normaliseAnswer(val) === normaliseAnswer(correct);
    if (isRight) sessionCorrect++;
    sessionAnswers[q.id] = { val, isRight };
    if (el) { el.disabled = true; el.classList.add(isRight ? 'sc-correct' : 'sc-wrong'); }
    resultsHtml += `
      <div class="result-flash show ${isRight ? 'good' : 'bad'}" style="margin:6px 0">
        Gap [${q.id}]: ${isRight
          ? '✅ Correct.'
          : `❌ Answer: <strong>${q.answer}</strong>. ${q.explanation}`}
      </div>`;
  });

  document.getElementById('sc-results-container').innerHTML = resultsHtml;
  const btn = document.getElementById('btn-reading-submit');
  btn.textContent = 'Continue to notebook →';
  btn.disabled = false;
  btn.onclick = () => finishReadingSession();
  window.scrollTo(0, document.body.scrollHeight);
}

function renderReadingSession(parsed) {
  document.getElementById('reading-passage').innerHTML = parsed.passage
    .split('\n')
    .filter(p => p.trim())
    .map(p => `<p>${p}</p>`)
    .join('');

  document.getElementById('questions-container').innerHTML = parsed.questions.map(q => `
    <div class="q-block" id="qb${q.id}">
      <div class="q-num">${q.id}</div>
      <div class="q-text">${q.text}</div>
      <div class="q-sub">True, False, or Not Given in the passage?</div>
      <div class="tfng" id="tfng${q.id}">
        <button class="tfng-btn" onclick="answerTFNG(${q.id},'True')"  data-v="True">✓ True</button>
        <button class="tfng-btn" onclick="answerTFNG(${q.id},'False')" data-v="False">✗ False</button>
        <button class="tfng-btn" onclick="answerTFNG(${q.id},'NG')"    data-v="NG">? Not Given</button>
      </div>
      <div class="result-flash" id="rf${q.id}"></div>
    </div>
  `).join('');
}

window.answerTFNG = function (qnum, val) {
  if (sessionAnswers[qnum]) return;
  const q = sessionQuestions.find(x => x.id === qnum);
  if (!q) return;

  trackQAnswer(qnum);
  trackQStart(qnum + 1);

  const isRight = normaliseAnswer(val) === normaliseAnswer(q.answer);
  sessionAnswers[qnum] = { val, isRight, errorReason: isRight ? null : (q.errorReason || 'other') };
  if (isRight) sessionCorrect++;

  document.querySelectorAll(`#tfng${qnum} .tfng-btn`).forEach(b => {
    b.disabled = true;
    if      (normaliseAnswer(b.dataset.v) === normaliseAnswer(q.answer)) b.classList.add('correct');
    else if (b.dataset.v === val && !isRight)                             b.classList.add('wrong');
  });

  const rf = document.getElementById(`rf${qnum}`);
  rf.classList.add('show', isRight ? 'good' : 'bad');
  rf.innerHTML = isRight
    ? `✅ Correct. ${q.explanation}`
    : `❌ The answer is <strong>${q.answer}</strong>. ${q.explanation}`;

  if (Object.keys(sessionAnswers).length >= sessionQuestions.length) {
    document.getElementById('btn-reading-submit').disabled = false;
  }
};

window.submitReading = function () {
  if (isSCSession) { submitSCSession(); return; }

  const tlAnswer   = tlQ ? sessionAnswers[tlQ.id] : null;
  const tlEligible = tlQ !== null && tlAnswer?.isRight === true;

  if (tlEligible) {
    renderToughLove();
    goTo('s-toughlove');
  } else {
    finishReadingSession();
  }
};

// ── TOUGH LOVE ─────────────────────────────────────────────────────
function buildToughLove(questions, passage) {
  tlQ           = questions[Math.floor(Math.random() * questions.length)];
  tlKeySentence = tlQ.keySentence || '';
  tlExplanation = tlQ.explanation || '';
}

function renderToughLove() {
  if (!tlQ) return;

  document.getElementById('tl-question').textContent =
    `For Question ${tlQ.id} — "${tlQ.text}" — which sentence in the passage gave you the answer?`;

  const sentences = sessionPassage
    .replace(/\n/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 25 && s !== tlKeySentence);

  const distractors = sentences.sort(() => Math.random() - 0.5).slice(0, 3);
  const options     = [
    ...distractors.map(s => ({ text: s, correct: false })),
    { text: tlKeySentence, correct: true }
  ].sort(() => Math.random() - 0.5);

  document.getElementById('tl-hint-options').innerHTML = options.map(o => {
    const label = o.text.length > 120 ? o.text.substring(0, 120) + '…' : o.text;
    return `<button class="hint-btn" onclick="pickHint(this,${o.correct})">"${label}"</button>`;
  }).join('');

  document.getElementById('tl-result').className = 'result-flash mt16';
  document.getElementById('btn-tl-continue').disabled = true;
}

window.pickHint = function (el, isCorrect) {
  document.querySelectorAll('.hint-btn').forEach(b => { b.disabled = true; });
  el.classList.add(isCorrect ? 'correct-hint' : 'wrong-hint');
  tlPassed = isCorrect;

  const rf = document.getElementById('tl-result');
  rf.classList.add('show', isCorrect ? 'good' : 'bad');
  rf.innerHTML = isCorrect
    ? `✅ Exactly right. That's the sentence that gives you the answer. ${tlExplanation} You're reading like a Band 7+ student.`
    : `❌ That wasn't the one. The answer lives in: <em>"${tlKeySentence}"</em> — ${tlExplanation}`;

  document.getElementById('btn-tl-continue').disabled = false;
};

window.continueTLToNotebook = function () { finishReadingSession(); };

// ── READING FINISH ─────────────────────────────────────────────────
async function finishReadingSession() {
  const total     = sessionQuestions.length || 5;
  const accuracy  = Math.round((sessionCorrect / total) * 100);
  const day       = studentData.dayNumber || 1;
  const skillKey  = currentPlan?.skill || 'reading.tfng';
  const behaviour = getBehaviourPayload();

  // Remove scroll listener now that session is done
  if (bhvScrollHandler) { window.removeEventListener('scroll', bhvScrollHandler); bhvScrollHandler = null; }

  // Tally missed answer sub-types (e.g. how many True / False / NG were wrong)
  const missedSubTypes = {};
  sessionQuestions.forEach(q => {
    const a = sessionAnswers[q.id];
    if (a && !a.isRight) {
      missedSubTypes[q.answer] = (missedSubTypes[q.answer] || 0) + 1;
    }
  });

  const skillId  = toSkillId(skillKey);
  const prevSkill = getIELTSSkills()[skillId] || { accuracy: 0, attempted: 0 };

  let _readingSessionRef = null;
  try {
    _readingSessionRef = await saveSessionDoc(currentUser.uid, {
      weekNumber:         studentData.weekNumber || 1,
      dayNumber:          day,
      skillPracticed:     skillKey,
      questionsAttempted: total,
      questionsCorrect:   sessionCorrect,
      accuracy,
      toughLovePassed:    tlPassed,
      warmupCorrect,
      aiPassageTopic:     sessionTopic,
      missedSubTypes,
      durationMinutes:    Math.round(behaviour.sessionDurationSec / 60),
      behaviour
    });

    const prevCorrect  = Math.round(((prevSkill.accuracy || 0) / 100) * (prevSkill.attempted || 0));
    const newAttempted = (prevSkill.attempted || 0) + total;
    const newAccuracy  = newAttempted > 0
      ? Math.round(((prevCorrect + sessionCorrect) / newAttempted) * 100) : 0;
    const newStreak = (studentData.streak || 0) + 1;
    const subjPath  = `brain.subjects.ielts-academic.skills.${skillId}`;

    // Error reason tagging — TFNG only (SC has a different error model)
    let errorReasonsUpdate = null;
    if (!isSCSession) {
      const prevER = prevSkill.errorReasons || {};
      const mergedER = {
        synonymTrap: 0, hedgingMissed: 0, negationOverlooked: 0,
        scopeError: 0, notGivenMarkedFalse: 0, other: 0,
        ...prevER,
      };
      sessionQuestions.forEach(q => {
        const a = sessionAnswers[q.id];
        if (a && !a.isRight) {
          const key = a.errorReason;
          if (key && Object.prototype.hasOwnProperty.call(mergedER, key)) mergedER[key]++;
          else mergedER.other++;
        }
      });
      errorReasonsUpdate = mergedER;
    }

    // Confidence profile
    const confMetrics = computeConfidenceMetrics(sessionQuestions, sessionAnswers);
    let confProfileUpdate = null;
    if (confMetrics) {
      const prevCP  = prevSkill.confidenceProfile || {};
      const cpN     = (prevCP.sessions || 0) + 1;
      const cpAlpha = 1 / Math.min(cpN, 10);
      const cpEma   = (p, n) => Math.round(p + (n - p) * cpAlpha);
      confProfileUpdate = {
        avgConfidenceScore:    cpEma(prevCP.avgConfidenceScore    || 0, confMetrics.confidenceScore),
        avgHesitationRate:     cpEma(prevCP.avgHesitationRate     || 0, confMetrics.hesitationRate),
        overconfidenceEvents:  (prevCP.overconfidenceEvents  || 0) + confMetrics.overconfidenceEvents,
        underconfidenceEvents: (prevCP.underconfidenceEvents || 0) + confMetrics.underconfidenceEvents,
        sessions: cpN,
      };
    }

    await updateStudentDoc(currentUser.uid, {
      [`${subjPath}.accuracy`]:      newAccuracy,
      [`${subjPath}.attempted`]:     newAttempted,
      [`${subjPath}.lastPracticed`]: serverTimestamp(),
      [`${subjPath}.trend`]:         newAccuracy > (prevSkill.accuracy || 0) ? 'up' : newAccuracy < (prevSkill.accuracy || 0) ? 'down' : 'stable',
      ...(errorReasonsUpdate    ? { [`${subjPath}.errorReasons`]:     errorReasonsUpdate    } : {}),
      ...(confProfileUpdate     ? { [`${subjPath}.confidenceProfile`]: confProfileUpdate    } : {}),
      dayNumber:        (studentData.dayNumber || 1) + 1,
      recentSkills:     [skillKey, ...(studentData.recentSkills || [])].slice(0, 5),
      streak:           newStreak,
      lastSession:      serverTimestamp(),
      toughLoveResults: (studentData.toughLoveResults || 0) + (tlPassed ? 1 : 0),
    });

    const snap = await getStudentDoc(currentUser.uid);
    studentData = snap.data();
    await updateStudentBrain(behaviour, accuracy, skillKey);
    await updateWeakAreas(skillKey, missedSubTypes);
  } catch { /* Firestore save failed — still show notebook */ }

  if (_readingSessionRef) generateAndSaveNarrative(currentUser.uid, _readingSessionRef, {
    skill: skillKey, day, accuracy, questionsCorrect: sessionCorrect, total, missedSubTypes, topic: sessionTopic,
  });

  if (mockMode) {
    mockResults.reading = { correct: sessionCorrect, total, accuracy };
    runMockPhase(1);
    return;
  }

  tipNotebookFn = () => {
    document.getElementById('nb-day-badge').textContent = `Day ${day}`;
    goTo('s-notebook');
    renderNotebook(sessionCorrect, total, 'reading.tfng');
  };
  showSessionTip({ accuracy, behaviour, missedSubTypes, skillKey });
}

// ── LISTENING SESSION ─────────────────────────────────────────────
async function loadListeningSession() {
  const day = studentData?.dayNumber || 2;
  listenType = currentPlan?.skill === 'listening.formCompletion' ? 'fc' : 'mc';
  listenQuestions  = [];
  listenScenario   = '';
  listenAnswers    = {};
  listenCorrect    = 0;
  listenHasPlayed  = false;
  if (listenAudioEl) { listenAudioEl.pause(); listenAudioEl = null; }

  document.getElementById('listening-loading').classList.remove('hidden');
  document.getElementById('listening-content').classList.add('hidden');
  document.getElementById('listening-results').classList.add('hidden');
  document.getElementById('listening-questions-gate').classList.add('hidden');

  document.getElementById('listening-p1-dot').className = 'phase-dot';
  goTo('s-listening');

  const band = studentData?.targetBand || 6.5;

  let prompt;
  if (listenType === 'mc') {
    prompt = {
      system: 'You are an IELTS examiner. Generate listening exercises. Return valid JSON only, no markdown.',
      user: `Create an IELTS Listening Multiple Choice exercise for a Band ${band} student.
"transcript" must be the ACTUAL spoken words a student would hear — write it as natural speech (4-6 sentences of a real conversation, monologue, or announcement). The questions must be answerable from the transcript.
Return ONLY this JSON:
{
  "transcript": "The actual spoken words — written as natural human speech, not a description. 4-6 sentences.",
  "questions": [
    {"id":1,"text":"question","options":["A. option","B. option","C. option"],"answer":"A","explanation":"why"},
    {"id":2,"text":"question","options":["A. option","B. option","C. option"],"answer":"B","explanation":"why"},
    {"id":3,"text":"question","options":["A. option","B. option","C. option"],"answer":"C","explanation":"why"},
    {"id":4,"text":"question","options":["A. option","B. option","C. option"],"answer":"A","explanation":"why"},
    {"id":5,"text":"question","options":["A. option","B. option","C. option"],"answer":"B","explanation":"why"}
  ]
}`
    };
  } else {
    prompt = {
      system: 'You are an IELTS examiner. Generate listening exercises. Return valid JSON only, no markdown.',
      user: `Create an IELTS Listening Form Completion exercise for a Band ${band} student.
"transcript" must be the ACTUAL spoken words of the phone call or interview — write it as natural speech (4-6 sentences). Include the answers embedded naturally in the spoken text.
Return ONLY this JSON:
{
  "transcript": "The actual spoken words of the interaction — written as natural human speech, not a description.",
  "formTitle": "title of the form being completed",
  "questions": [
    {"id":1,"label":"Name","answer":"exact answer spoken in transcript","hint":"first name only"},
    {"id":2,"label":"Phone number","answer":"exact answer","hint":"10 digits"},
    {"id":3,"label":"Date","answer":"exact answer","hint":"day and month"},
    {"id":4,"label":"Reason for contact","answer":"exact answer","hint":"one word or short phrase"},
    {"id":5,"label":"Preferred time","answer":"exact answer","hint":"morning or afternoon"}
  ]
}`
    };
  }

  try {
    const raw    = await callAI(prompt);
    const parsed = parseAIJson(raw);
    listenScenario  = parsed.transcript || parsed.scenario || '';
    listenQuestions = parsed.questions;

    // Render questions (gated — hidden until user presses play)
    if (listenType === 'mc') {
      document.getElementById('listening-q-label').textContent = 'Questions — Multiple Choice';
      document.getElementById('listening-questions').innerHTML = listenQuestions.map(q => `
        <div class="q-block" id="lqb${q.id}">
          <div class="q-num">${q.id}</div>
          <div class="q-text">${q.text}</div>
          <div class="mc-options" id="mc${q.id}">
            ${q.options.map(opt => {
              const letter = opt.charAt(0);
              return `<button class="mc-option" data-v="${letter}" onclick="answerMC(${q.id},'${letter}')">${opt}</button>`;
            }).join('')}
          </div>
        </div>
      `).join('');
    } else {
      document.getElementById('listening-q-label').textContent = parsed.formTitle || 'Form Completion';
      document.getElementById('listening-questions').innerHTML = `
        <p style="font-size:12px;color:var(--muted);margin-bottom:12px">Complete the form. Write no more than <strong>three words</strong> for each answer.</p>
        ${listenQuestions.map(q => `
          <div class="fc-field" id="lqb${q.id}">
            <label class="fc-label">${q.id}. ${q.label}</label>
            <input class="fc-input" id="fc${q.id}" type="text" placeholder="${q.hint || 'your answer'}" oninput="checkFCProgress()" />
          </div>
        `).join('')}`;
    }

    document.getElementById('listening-loading').classList.add('hidden');
    document.getElementById('listening-content').classList.remove('hidden');

    startSessionTracking();
    trackQStart(1);

    // Fetch audio from ElevenLabs (async — player shows loading state)
    fetchListeningAudio(listenScenario);

  } catch {
    showToast('Having trouble connecting — please check your internet and try again.');
    document.getElementById('listening-loading').innerHTML =
      '<p style="color:var(--danger);padding:20px;text-align:center">Could not load listening scenario. Please go back and try again.</p>';
  }
}

// ── LISTENING AUDIO ────────────────────────────────────────────────
async function fetchListeningAudio(text) {
  try {
    const data = await withRetry(async () => {
      const res = await fetch(AUDIO_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ text })
      });
      if (!res.ok) throw new Error('Audio fetch failed');
      const json = await res.json();
      if (!json.audio) throw new Error('No audio in response');
      return json;
    });
    const blob = base64ToBlob(data.audio, data.mimeType || 'audio/mpeg');
    const url  = URL.createObjectURL(blob);
    setupAudioPlayer(url);
  } catch {
    showToast('Having trouble connecting — please check your internet and try again.');
    // Graceful fallback: show questions and an inline scenario text
    document.getElementById('audio-hint-text').textContent = 'Audio unavailable. Read the scenario below and answer the questions.';
    document.getElementById('listening-audio-wrap').insertAdjacentHTML('afterend',
      `<div class="passage-wrap" style="margin-top:0">
         <div class="passage-label">Scenario (Text Fallback)</div>
         <div class="passage-text">${listenScenario.split('\n').filter(p=>p.trim()).map(p=>`<p>${p}</p>`).join('')}</div>
       </div>`);
    showListeningQuestionsGate();
  }
}

function base64ToBlob(base64, mimeType) {
  const bytes  = atob(base64);
  const buffer = new ArrayBuffer(bytes.length);
  const view   = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++) view[i] = bytes.charCodeAt(i);
  return new Blob([buffer], { type: mimeType });
}

function setupAudioPlayer(url) {
  if (listenAudioEl) { listenAudioEl.pause(); }
  listenAudioEl = new Audio(url);

  listenAudioEl.addEventListener('timeupdate', updateAudioProgress);
  listenAudioEl.addEventListener('ended', () => {
    const btn = document.getElementById('audio-play-btn');
    if (btn) btn.textContent = '▶';
    showListeningQuestionsGate();
  });
  listenAudioEl.addEventListener('error', () => {
    showListeningQuestionsGate();
  });

  const btn  = document.getElementById('audio-play-btn');
  const hint = document.getElementById('audio-hint-text');
  if (btn)  { btn.disabled = false; btn.textContent = '▶'; }
  if (hint) hint.textContent = 'Press ▶ to listen before answering.';
}

function updateAudioProgress() {
  if (!listenAudioEl || !listenAudioEl.duration) return;
  const pct  = (listenAudioEl.currentTime / listenAudioEl.duration) * 100;
  const fill = document.getElementById('audio-progress-fill');
  const time = document.getElementById('audio-time');
  if (fill) fill.style.width = pct + '%';
  if (time) {
    const secs = Math.floor(listenAudioEl.currentTime);
    time.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  }
}

window.toggleAudio = function () {
  if (!listenAudioEl) return;
  const btn = document.getElementById('audio-play-btn');
  if (listenAudioEl.paused) {
    listenAudioEl.play();
    if (btn) btn.textContent = '⏸';
    if (!listenHasPlayed) {
      listenHasPlayed = true;
      // Reveal questions 1 second after first play
      setTimeout(showListeningQuestionsGate, 1000);
    }
  } else {
    listenAudioEl.pause();
    if (btn) btn.textContent = '▶';
  }
};

window.replayAudio = function () {
  if (!listenAudioEl) return;
  listenAudioEl.currentTime = 0;
  listenAudioEl.play();
  const btn = document.getElementById('audio-play-btn');
  if (btn) btn.textContent = '⏸';
};

window.seekAudio = function (e) {
  if (!listenAudioEl || !listenAudioEl.duration) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const pct  = (e.clientX - rect.left) / rect.width;
  listenAudioEl.currentTime = pct * listenAudioEl.duration;
};

function showListeningQuestionsGate() {
  const gate = document.getElementById('listening-questions-gate');
  const hint = document.getElementById('audio-hint-text');
  if (gate) gate.classList.remove('hidden');
  if (hint && listenHasPlayed) hint.textContent = 'You can replay the audio at any time.';
}

window.answerMC = function (qnum, val) {
  if (listenAnswers[qnum]) return;
  trackQAnswer(qnum);
  trackQStart(qnum + 1);
  listenAnswers[qnum] = val;

  document.querySelectorAll(`#mc${qnum} .mc-option`).forEach(b => {
    b.disabled = true;
    b.classList.toggle('selected', b.dataset.v === val);
  });

  if (Object.keys(listenAnswers).length >= listenQuestions.length) {
    document.getElementById('btn-listening-submit').disabled = false;
  }
};

window.checkFCProgress = function () {
  const allFilled = listenQuestions.every(q => {
    const el = document.getElementById(`fc${q.id}`);
    if (!el) return false;
    const val = el.value.trim();
    // Track if student changed a previously entered answer
    if (val.length > 0 && bhvPrevFCValues[q.id] && bhvPrevFCValues[q.id] !== val) {
      trackAnswerChange();
      bhvQChangedAnswer[q.id] = true;
    }
    if (val.length > 0) bhvPrevFCValues[q.id] = val;
    return val.length > 0;
  });
  document.getElementById('btn-listening-submit').disabled = !allFilled;
};

window.submitListening = function () {
  listenCorrect = 0;
  let resultsHtml = '';

  listenQuestions.forEach(q => {
    let userAns, isRight;

    if (listenType === 'mc') {
      userAns = listenAnswers[q.id] || '—';
      isRight = normaliseAnswer(userAns) === normaliseAnswer(q.answer);
    } else {
      const el = document.getElementById(`fc${q.id}`);
      userAns  = el ? el.value.trim() : '';
      isRight  = normaliseAnswer(userAns) === normaliseAnswer(q.answer);
      // Lock the input
      if (el) { el.disabled = true; el.classList.add(isRight ? 'fc-correct' : 'fc-wrong'); }
    }

    if (isRight) listenCorrect++;
    listenAnswers[q.id] = userAns;

    resultsHtml += `
      <div style="padding:10px 0;border-bottom:1px solid var(--border);">
        <div style="font-size:13px;font-weight:400;margin-bottom:4px">${q.id}. ${q.text || q.label}</div>
        <div style="font-size:12px;color:${isRight ? 'var(--success)' : 'var(--danger)'}">
          ${isRight ? '✅' : '❌'} Your answer: <strong>${userAns}</strong>
          ${!isRight ? ` — Correct: <strong>${q.answer}</strong>` : ''}
        </div>
        <div style="font-size:12px;color:var(--muted);margin-top:3px">${q.explanation || ''}</div>
      </div>`;
  });

  document.getElementById('btn-listening-submit').classList.add('hidden');
  const resultsEl = document.getElementById('listening-results');
  document.getElementById('listening-results-body').innerHTML = resultsHtml;
  resultsEl.classList.remove('hidden');

  // Scroll to results
  resultsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

window.finishListeningSession = async function () {
  if (listenAudioEl) { listenAudioEl.pause(); listenAudioEl = null; }
  const total     = listenQuestions.length || 5;
  const accuracy  = Math.round((listenCorrect / total) * 100);
  const day       = studentData.dayNumber || 2;
  const listenSkillSuffix = listenType === 'mc' ? 'multipleChoice' : 'formCompletion';
  const firestoreKey      = `listening.${listenSkillSuffix}`;
  const listenSkillId     = toSkillId(firestoreKey);
  const behaviour = getBehaviourPayload();

  let _listenSessionRef = null;
  try {
    _listenSessionRef = await saveSessionDoc(currentUser.uid, {
      weekNumber:         studentData.weekNumber || 1,
      dayNumber:          day,
      skillPracticed:     firestoreKey,
      questionsAttempted: total,
      questionsCorrect:   listenCorrect,
      accuracy,
      warmupCorrect,
      durationMinutes:    Math.round(behaviour.sessionDurationSec / 60),
      behaviour
    });

    const prevL        = getIELTSSkills()[listenSkillId] || { accuracy: 0, attempted: 0 };
    const prevCorrect  = Math.round(((prevL.accuracy || 0) / 100) * (prevL.attempted || 0));
    const newAttempted = (prevL.attempted || 0) + total;
    const newAccuracy  = newAttempted > 0
      ? Math.round(((prevCorrect + listenCorrect) / newAttempted) * 100) : 0;
    const subjPath = `brain.subjects.ielts-academic.skills.${listenSkillId}`;

    // Confidence profile
    const lConfMetrics = computeConfidenceMetrics(listenQuestions, listenAnswers);
    let lConfProfileUpdate = null;
    if (lConfMetrics) {
      const prevCP  = prevL.confidenceProfile || {};
      const cpN     = (prevCP.sessions || 0) + 1;
      const cpAlpha = 1 / Math.min(cpN, 10);
      const cpEma   = (p, n) => Math.round(p + (n - p) * cpAlpha);
      lConfProfileUpdate = {
        avgConfidenceScore:    cpEma(prevCP.avgConfidenceScore    || 0, lConfMetrics.confidenceScore),
        avgHesitationRate:     cpEma(prevCP.avgHesitationRate     || 0, lConfMetrics.hesitationRate),
        overconfidenceEvents:  (prevCP.overconfidenceEvents  || 0) + lConfMetrics.overconfidenceEvents,
        underconfidenceEvents: (prevCP.underconfidenceEvents || 0) + lConfMetrics.underconfidenceEvents,
        sessions: cpN,
      };
    }

    await updateStudentDoc(currentUser.uid, {
      [`${subjPath}.accuracy`]:      newAccuracy,
      [`${subjPath}.attempted`]:     newAttempted,
      [`${subjPath}.lastPracticed`]: serverTimestamp(),
      [`${subjPath}.trend`]:         newAccuracy > (prevL.accuracy || 0) ? 'up' : newAccuracy < (prevL.accuracy || 0) ? 'down' : 'stable',
      ...(lConfProfileUpdate ? { [`${subjPath}.confidenceProfile`]: lConfProfileUpdate } : {}),
      dayNumber:    (studentData.dayNumber || 1) + 1,
      recentSkills: [firestoreKey, ...(studentData.recentSkills || [])].slice(0, 5),
      streak:       (studentData.streak || 0) + 1,
      lastSession:  serverTimestamp(),
    });

    const snap = await getStudentDoc(currentUser.uid);
    studentData = snap.data();
    await updateStudentBrain(behaviour, accuracy, firestoreKey);
    await updateWeakAreas(firestoreKey, null);
  } catch { /* still show notebook */ }

  if (_listenSessionRef) generateAndSaveNarrative(currentUser.uid, _listenSessionRef, {
    skill: firestoreKey, day, accuracy, questionsCorrect: listenCorrect, total,
  });

  if (mockMode) {
    mockResults.listening = { correct: listenCorrect, total, accuracy };
    runMockPhase(2);
    return;
  }

  const listenMissed = {};
  listenQuestions.forEach(q => {
    const a = listenAnswers?.[q.id];
    if (a !== undefined && normaliseAnswer(String(a)) !== normaliseAnswer(q.answer || '')) {
      listenMissed[q.type || 'mc'] = (listenMissed[q.type || 'mc'] || 0) + 1;
    }
  });
  tipNotebookFn = () => {
    document.getElementById('nb-day-badge').textContent = `Day ${day}`;
    goTo('s-notebook');
    renderNotebook(listenCorrect, total, firestoreKey);
  };
  showSessionTip({ accuracy, behaviour: getBehaviourPayload(), missedSubTypes: listenMissed, skillKey: firestoreKey });
};

// ── WRITING SESSION ───────────────────────────────────────────────
async function loadWritingSession() {
  const day = studentData?.dayNumber || 6;
  writingTaskData = null;
  writingBandEst  = 0;

  document.getElementById('writing-loading').classList.remove('hidden');
  document.getElementById('writing-prompt-view').classList.add('hidden');
  document.getElementById('writing-evaluating').classList.add('hidden');
  document.getElementById('writing-results-view').classList.add('hidden');
  document.getElementById('writing-p1-dot').className = 'phase-dot';
  goTo('s-writing');

  const isTask1 = currentPlan?.skill !== 'writing.task2';
  const band    = studentData?.targetBand || 6.5;
  const taskNum = isTask1 ? 1 : 2;
  const minWords = isTask1 ? 150 : 250;

  const prompt = {
    system: 'You are an IELTS Writing examiner. Return valid JSON only, no markdown.',
    user: isTask1
      ? `Generate an IELTS Academic Writing Task 1 prompt for a Band ${band} student.
Return ONLY this JSON:
{"taskType":"Task 1","title":"Graph/Chart Description","prompt":"Describe the following [bar chart / line graph / table / pie chart]. The [chart] below shows [what it shows]. Summarise the information by selecting and reporting the main features, and make comparisons where relevant. Write at least 150 words.","dataDescription":"[describe the imaginary chart data in 2-3 sentences so the student knows what to write about]"}`
      : `Generate an IELTS Academic Writing Task 2 prompt for a Band ${band} student.
Return ONLY this JSON:
{"taskType":"Task 2","title":"Opinion Essay","prompt":"[Essay question on a current topic]. Write at least 250 words. Give reasons for your answer and include any relevant examples from your own knowledge or experience."}`
  };

  try {
    const raw    = await callAI(prompt);
    writingTaskData = parseAIJson(raw);

    document.getElementById('writing-task-type').textContent = writingTaskData.taskType || `Writing Task ${taskNum}`;
    document.getElementById('writing-task-text').innerHTML   = writingTaskData.prompt
      + (writingTaskData.dataDescription ? `<br/><br/><em style="color:var(--muted);font-size:12px">${writingTaskData.dataDescription}</em>` : '');
    document.getElementById('writing-target-hint').textContent = `Target: at least ${minWords} words.`;
    document.getElementById('writing-textarea').value = '';
    document.getElementById('writing-word-count').textContent = '0 words';
    document.getElementById('writing-word-count').className   = 'word-count-badge';
    document.getElementById('btn-writing-submit').disabled    = false;

    document.getElementById('writing-loading').classList.add('hidden');
    document.getElementById('writing-prompt-view').classList.remove('hidden');
    startSessionTracking();
  } catch {
    showToast('Having trouble connecting — please check your internet and try again.');
    document.getElementById('writing-loading').innerHTML =
      '<p style="color:var(--danger);padding:20px;text-align:center">Could not load writing task. Please go back and try again.</p>';
  }
}

window.updateWordCount = function () {
  const text  = document.getElementById('writing-textarea').value.trim();
  const words = text ? text.split(/\s+/).length : 0;
  const min   = currentPlan?.skill !== 'writing.task2' ? 150 : 250;
  const badge = document.getElementById('writing-word-count');
  badge.textContent = `${words} word${words !== 1 ? 's' : ''}`;
  badge.className   = `word-count-badge ${words >= min ? 'ok' : words >= min * 0.7 ? 'warn' : ''}`;
};

window.submitWriting = async function () {
  const text = document.getElementById('writing-textarea').value.trim();
  if (!text || text.split(/\s+/).length < 30) {
    showToast('Please write at least a few sentences before submitting.');
    return;
  }
  writingResponse = text;

  document.getElementById('writing-prompt-view').classList.add('hidden');
  document.getElementById('writing-evaluating').classList.remove('hidden');

  const isTask1 = currentPlan?.skill !== 'writing.task2';
  const band   = studentData?.targetBand || 6.5;
  const taskLabel = isTask1 ? 'Task 1 (Graph Description)' : 'Task 2 (Opinion Essay)';

  const prompt = {
    system: 'You are an experienced IELTS examiner. Evaluate writing responses strictly but fairly using official band descriptors. Return valid JSON only.',
    user: `Evaluate this IELTS Writing ${taskLabel} response for a Band ${band} target student.

TASK PROMPT: ${writingTaskData?.prompt || ''}

STUDENT RESPONSE:
${text}

Return ONLY this JSON:
{
  "overallBand": 6.0,
  "taskAchievement": {"band": 6.0, "feedback": "one sentence"},
  "coherenceCohesion": {"band": 6.0, "feedback": "one sentence"},
  "lexicalResource": {"band": 6.0, "feedback": "one sentence"},
  "grammaticalRange": {"band": 6.0, "feedback": "one sentence"},
  "topSuggestion": "one specific, actionable improvement",
  "encouragement": "one motivating sentence about their performance"
}`
  };

  try {
    const raw    = await callAI({ ...prompt, maxTokens: 600 });
    const result = parseAIJson(raw);
    writingBandEst = result.overallBand || 6.0;

    document.getElementById('writing-overall-band').textContent  = writingBandEst.toFixed(1);
    document.getElementById('writing-encouragement').textContent = result.encouragement || '';
    document.getElementById('wc-ta-band').textContent  = result.taskAchievement?.band?.toFixed(1)    || '—';
    document.getElementById('wc-ta-fb').textContent    = result.taskAchievement?.feedback            || '';
    document.getElementById('wc-cc-band').textContent  = result.coherenceCohesion?.band?.toFixed(1)  || '—';
    document.getElementById('wc-cc-fb').textContent    = result.coherenceCohesion?.feedback          || '';
    document.getElementById('wc-lr-band').textContent  = result.lexicalResource?.band?.toFixed(1)    || '—';
    document.getElementById('wc-lr-fb').textContent    = result.lexicalResource?.feedback            || '';
    document.getElementById('wc-gr-band').textContent  = result.grammaticalRange?.band?.toFixed(1)   || '—';
    document.getElementById('wc-gr-fb').textContent    = result.grammaticalRange?.feedback           || '';
    document.getElementById('writing-suggestion').textContent = result.topSuggestion || '';

    document.getElementById('writing-evaluating').classList.add('hidden');
    document.getElementById('writing-results-view').classList.remove('hidden');
  } catch {
    showToast('Having trouble connecting — please check your internet and try again.');
    document.getElementById('writing-evaluating').innerHTML =
      '<p style="color:var(--danger);padding:20px;text-align:center">Evaluation failed. Please go back and try again.</p>';
  }
};

window.finishWritingSession = async function () {
  const day     = studentData?.dayNumber || 6;
  const isTask1 = currentPlan?.skill !== 'writing.task2';
  const taskKey = isTask1 ? 'task1' : 'task2';
  const behaviour = getBehaviourPayload();

  let _writingSessionRef = null;
  try {
    _writingSessionRef = await saveSessionDoc(currentUser.uid, {
      weekNumber:     studentData.weekNumber || 2,
      dayNumber:      day,
      skillPracticed: `writing.${taskKey}`,
      bandEstimate:   writingBandEst,
      wordCount:      writingResponse.split(/\s+/).length,
      durationMinutes: Math.round(behaviour.sessionDurationSec / 60),
      behaviour
    });

    const writingSkillId = toSkillId(`writing.${taskKey}`);
    const prevW = getIELTSSkills()[writingSkillId] || { bandEstimate: 0, attempted: 0 };
    const wSubjPath = `brain.subjects.ielts-academic.skills.${writingSkillId}`;
    await updateStudentDoc(currentUser.uid, {
      [`${wSubjPath}.bandEstimate`]:  writingBandEst,
      [`${wSubjPath}.attempted`]:     (prevW.attempted || 0) + 1,
      [`${wSubjPath}.lastPracticed`]: serverTimestamp(),
      [`${wSubjPath}.trend`]:         writingBandEst > (prevW.bandEstimate || 0) ? 'up' : writingBandEst < (prevW.bandEstimate || 0) ? 'down' : 'stable',
      dayNumber:    (studentData.dayNumber || 1) + 1,
      recentSkills: [`writing.${taskKey}`, ...(studentData.recentSkills || [])].slice(0, 5),
      streak:       (studentData.streak || 0) + 1,
      lastSession:  serverTimestamp(),
    });

    const snap = await getStudentDoc(currentUser.uid);
    studentData = snap.data();
    await updateWeakAreas(`writing.${taskKey}`, null);
  } catch { /* still show notebook */ }

  if (_writingSessionRef) generateAndSaveNarrative(currentUser.uid, _writingSessionRef, {
    skill: `writing.${taskKey}`, day, bandEstimate: writingBandEst,
    wordCount: writingResponse.split(/\s+/).length,
  });

  if (mockMode) {
    mockResults.writing = { band: writingBandEst };
    runMockPhase(3);
    return;
  }

  tipNotebookFn = () => {
    document.getElementById('nb-day-badge').textContent = `Day ${day}`;
    goTo('s-notebook');
    renderNotebookWriting();
  };
  showSessionTip({ accuracy: Math.round(writingBandEst * 10), behaviour: getBehaviourPayload(), missedSubTypes: {}, skillKey: 'writing' });
};

// ── SPEAKING SESSION ──────────────────────────────────────────────
async function loadSpeakingSession() {
  const day = studentData?.dayNumber || 8;
  speakingQs         = [];
  speakingTranscript = '';
  speakingBandEst    = 0;
  audioChunks        = [];
  recordSeconds      = 0;

  document.getElementById('speaking-loading').classList.remove('hidden');
  document.getElementById('speaking-prompt-view').classList.add('hidden');
  document.getElementById('speaking-evaluating').classList.add('hidden');
  document.getElementById('speaking-results-view').classList.add('hidden');
  document.getElementById('speaking-p1-dot').className = 'phase-dot';
  document.getElementById('record-ready').classList.remove('hidden');
  document.getElementById('record-active').classList.add('hidden');
  document.getElementById('record-processing').classList.add('hidden');
  goTo('s-speaking');

  const band = studentData?.targetBand || 6.5;
  const isMock = mockMode && mockPhase === 3;
  const partLabel = isMock ? 'Part 2 — Cue Card' : 'Part 1 — Personal Questions';

  let promptUser;
  if (isMock) {
    promptUser = `Generate an IELTS Speaking Part 2 cue card for a Band ${band} student.
Return ONLY this JSON:
{"topicLabel":"Part 2 — Cue Card","questions":["Describe [topic]. You should say:","- [point 1]","- [point 2]","- [point 3]","and explain [final point]."]}`;
  } else {
    promptUser = `Generate 4 IELTS Speaking Part 1 personal questions for a Band ${band} student on a single topic (e.g. hometown, hobbies, daily routine).
Return ONLY this JSON:
{"topicLabel":"Part 1 — [Topic Name]","questions":["question 1?","question 2?","question 3?","question 4?"]}`;
  }

  const prompt = {
    system: 'You are an IELTS Speaking examiner. Return valid JSON only, no markdown.',
    user: promptUser
  };

  try {
    const raw    = await callAI(prompt);
    const parsed = parseAIJson(raw);
    speakingQs   = parsed.questions || [];

    document.getElementById('speaking-topic-label').textContent = parsed.topicLabel || partLabel;
    document.getElementById('speaking-questions').innerHTML = speakingQs.map((q, i) =>
      `<div class="speaking-q-item"><div class="speaking-q-num">${i + 1}</div><div>${q}</div></div>`
    ).join('');

    document.getElementById('speaking-loading').classList.add('hidden');
    document.getElementById('speaking-prompt-view').classList.remove('hidden');
    startSessionTracking();
  } catch {
    showToast('Having trouble connecting — please check your internet and try again.');
    document.getElementById('speaking-loading').innerHTML =
      '<p style="color:var(--danger);padding:20px;text-align:center">Could not load speaking questions. Please go back and try again.</p>';
  }
}

window.startRecording = async function () {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };
    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      clearInterval(recordTimerInterval);
      const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      document.getElementById('record-active').classList.add('hidden');
      document.getElementById('record-processing').classList.remove('hidden');
      await transcribeAudio(blob);
    };
    mediaRecorder.start(1000);

    recordSeconds = 0;
    document.getElementById('record-timer').textContent = '0:00';
    recordTimerInterval = setInterval(() => {
      recordSeconds++;
      const m = Math.floor(recordSeconds / 60);
      const s = String(recordSeconds % 60).padStart(2, '0');
      document.getElementById('record-timer').textContent = `${m}:${s}`;
      // Auto-stop at 3 minutes
      if (recordSeconds >= 180) window.stopRecording();
    }, 1000);

    document.getElementById('record-ready').classList.add('hidden');
    document.getElementById('record-active').classList.remove('hidden');
  } catch {
    showToast('Microphone access is required. Please allow it and try again.');
  }
};

window.stopRecording = function () {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
  }
};

async function transcribeAudio(blob) {
  try {
    const arrayBuffer = await blob.arrayBuffer();
    const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));

    const data = await withRetry(async () => {
      const res = await fetch(TRANSCRIBE_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ audio: base64, mimeType: blob.type || 'audio/webm' })
      });
      if (!res.ok) throw new Error('Transcription failed');
      return res.json();
    });
    speakingTranscript = data.text || '';

    document.getElementById('record-processing').classList.add('hidden');
    await evaluateSpeaking(speakingTranscript);
  } catch {
    showToast('Having trouble connecting — please check your internet and try again.');
    document.getElementById('record-processing').innerHTML =
      '<p style="color:var(--danger);padding:20px;text-align:center">Transcription failed. Please try again.</p>';
  }
}

async function evaluateSpeaking(transcript) {
  document.getElementById('speaking-prompt-view').classList.add('hidden');
  document.getElementById('speaking-evaluating').classList.remove('hidden');

  const band     = studentData?.targetBand || 6.5;
  const questions = speakingQs.join('\n');

  const prompt = {
    system: 'You are an experienced IELTS Speaking examiner. Evaluate transcribed responses strictly using official band descriptors. Return valid JSON only.',
    user: `Evaluate this IELTS Speaking response for a Band ${band} target student.

QUESTIONS ASKED:
${questions}

STUDENT TRANSCRIPT:
${transcript || '[No speech detected]'}

Note: Pronunciation cannot be assessed from text alone — give a neutral score with a caveat.

Return ONLY this JSON:
{
  "overallBand": 6.0,
  "fluencyCoherence": {"band": 6.0, "feedback": "one sentence"},
  "lexicalResource": {"band": 6.0, "feedback": "one sentence"},
  "grammaticalRange": {"band": 6.0, "feedback": "one sentence"},
  "pronunciation": {"band": 6.0, "feedback": "Cannot assess from text. Score based on grammar/lexical proxies only."},
  "topSuggestion": "one specific, actionable improvement"
}`
  };

  try {
    const raw    = await callAI({ ...prompt, maxTokens: 600 });
    const result = parseAIJson(raw);
    speakingBandEst = result.overallBand || 6.0;

    document.getElementById('speaking-transcript-text').textContent = transcript || '[No transcript available]';
    document.getElementById('speaking-overall-band').textContent    = speakingBandEst.toFixed(1);
    document.getElementById('sc-fc-band').textContent  = result.fluencyCoherence?.band?.toFixed(1) || '—';
    document.getElementById('sc-fc-fb').textContent    = result.fluencyCoherence?.feedback         || '';
    document.getElementById('sc-lr-band').textContent  = result.lexicalResource?.band?.toFixed(1)  || '—';
    document.getElementById('sc-lr-fb').textContent    = result.lexicalResource?.feedback          || '';
    document.getElementById('sc-gr-band').textContent  = result.grammaticalRange?.band?.toFixed(1) || '—';
    document.getElementById('sc-gr-fb').textContent    = result.grammaticalRange?.feedback         || '';
    document.getElementById('sc-pr-band').textContent  = result.pronunciation?.band?.toFixed(1)    || '—';
    document.getElementById('sc-pr-fb').textContent    = result.pronunciation?.feedback            || '';
    document.getElementById('speaking-suggestion').textContent = result.topSuggestion || '';

    document.getElementById('speaking-evaluating').classList.add('hidden');
    document.getElementById('speaking-results-view').classList.remove('hidden');
  } catch {
    showToast('Having trouble connecting — please check your internet and try again.');
    document.getElementById('speaking-evaluating').innerHTML =
      '<p style="color:var(--danger);padding:20px;text-align:center">Evaluation failed. Please go back and try again.</p>';
  }
}

window.finishSpeakingSession = async function () {
  const day       = studentData?.dayNumber || 8;
  const behaviour = getBehaviourPayload();
  // For speaking, override durationSec with actual recording time
  behaviour.sessionDurationSec = Math.max(behaviour.sessionDurationSec, recordSeconds);

  let _speakSessionRef = null;
  try {
    _speakSessionRef = await saveSessionDoc(currentUser.uid, {
      weekNumber:     studentData.weekNumber || 2,
      dayNumber:      day,
      skillPracticed: 'speaking.part1',
      bandEstimate:   speakingBandEst,
      transcript:     speakingTranscript,
      durationMinutes: Math.round(behaviour.sessionDurationSec / 60),
      behaviour
    });

    const speakSkillId = 'speaking-part1';
    const prevSp = getIELTSSkills()[speakSkillId] || { bandEstimate: 0, attempted: 0 };
    const spSubjPath = `brain.subjects.ielts-academic.skills.${speakSkillId}`;
    await updateStudentDoc(currentUser.uid, {
      [`${spSubjPath}.bandEstimate`]:  speakingBandEst,
      [`${spSubjPath}.attempted`]:     (prevSp.attempted || 0) + 1,
      [`${spSubjPath}.lastPracticed`]: serverTimestamp(),
      [`${spSubjPath}.trend`]:         speakingBandEst > (prevSp.bandEstimate || 0) ? 'up' : speakingBandEst < (prevSp.bandEstimate || 0) ? 'down' : 'stable',
      dayNumber:    (studentData.dayNumber || 1) + 1,
      recentSkills: ['speaking.part1', ...(studentData.recentSkills || [])].slice(0, 5),
      streak:       (studentData.streak || 0) + 1,
      lastSession:  serverTimestamp(),
    });

    const snap = await getStudentDoc(currentUser.uid);
    studentData = snap.data();
    await updateWeakAreas('speaking.part1', null);
  } catch { /* still show notebook */ }

  if (_speakSessionRef) generateAndSaveNarrative(currentUser.uid, _speakSessionRef, {
    skill: 'speaking.part1', day, bandEstimate: speakingBandEst,
    transcriptLength: speakingTranscript?.length || 0,
  });

  if (mockMode) {
    mockResults.speaking = { band: speakingBandEst };
    showMockResults();
    return;
  }

  tipNotebookFn = () => {
    document.getElementById('nb-day-badge').textContent = `Day ${day}`;
    goTo('s-notebook');
    renderNotebookSpeaking();
  };
  showSessionTip({ accuracy: Math.round(speakingBandEst * 10), behaviour: getBehaviourPayload(), missedSubTypes: {}, skillKey: 'speaking' });
};

// ── WEEK 1 REPORT ─────────────────────────────────────────────────
function renderWeek1Report() {
  const day = (studentData?.dayNumber || 6) - 1;

  // Hide standard skill section, show Week 1 section
  document.getElementById('nb-skill-section').classList.add('hidden');
  document.getElementById('nb-week1-section').classList.remove('hidden');

  const w1Skills = getIELTSSkills();
  const tfng = (w1Skills['reading-tfng']?.attempted              || 0) > 0 ? w1Skills['reading-tfng'].accuracy              : null;
  const mh   = (w1Skills['reading-summaryCompletion']?.attempted  || 0) > 0 ? w1Skills['reading-summaryCompletion'].accuracy  : null;
  const mc   = (w1Skills['listening-multipleChoice']?.attempted   || 0) > 0 ? w1Skills['listening-multipleChoice'].accuracy   : null;
  const fc   = (w1Skills['listening-formCompletion']?.attempted   || 0) > 0 ? w1Skills['listening-formCompletion'].accuracy    : null;

  const scores = [tfng, mh, mc, fc].filter(s => s !== null);
  const avgBand = scores.length > 0
    ? ((scores.reduce((a, b) => a + b, 0) / scores.length) / 100 * 3 + 4.5).toFixed(1)
    : (studentData?.targetBand || 6.0).toFixed(1);

  document.getElementById('w1-band').textContent      = avgBand;
  document.getElementById('w1-band-note').textContent = `Estimated from ${scores.length} skill${scores.length !== 1 ? 's' : ''} practised this week.`;

  // Top 2 weak areas
  const skillRows = [
    { name: 'T / F / Not Given',  pct: tfng, key: 'reading.tfng' },
    { name: 'Summ. Completion',   pct: mh,   key: 'reading.summaryCompletion' },
    { name: 'Multiple Choice',    pct: mc,   key: 'listening.multipleChoice' },
    { name: 'Form Completion',    pct: fc,   key: 'listening.formCompletion' },
  ].filter(r => r.pct !== null).sort((a, b) => a.pct - b.pct);

  const weak2 = skillRows.slice(0, 2);
  const weakEl = document.getElementById('w1-weak-areas');
  weakEl.innerHTML = weak2.length
    ? weak2.map(r => `
        <div class="weak-area-item">
          <div class="weak-area-name">${r.name}</div>
          <div class="skill-bar-wrap" style="max-width:140px;display:inline-block;vertical-align:middle">
            <div class="skill-bar weak" style="width:${r.pct}%"></div>
          </div>
          <span style="font-size:11px;font-weight:600;color:var(--danger);margin-left:6px">${r.pct}%</span>
        </div>`
      ).join('')
    : '<p style="font-size:13px;color:var(--muted)">Complete more sessions to identify weak areas.</p>';

  // Week 2 plan
  const planItems = [
    { icon: '✍️', day: 6, text: `<strong>Day 6</strong> — Writing Task 1 (Graph Description)` },
    { icon: '✍️', day: 7, text: `<strong>Day 7</strong> — Writing Task 2 (Opinion Essay)` },
    { icon: '🎤', day: 8, text: `<strong>Day 8</strong> — Speaking Part 1` },
    { icon: '🎯', day: 9, text: `<strong>Day 9</strong> — Focused Drill on ${weak2[0]?.name || 'your weakest skill'}` },
    { icon: '🏁', day: 10, text: `<strong>Day 10</strong> — Mini Mock across all 4 sections` },
  ];
  document.getElementById('w1-week2-plan').innerHTML = planItems.map(p =>
    `<div class="expect-item" style="padding:6px 0">
       <div class="expect-icon">${p.icon}</div>
       <div class="expect-text" style="font-size:13px">${p.text}</div>
     </div>`
  ).join('');

  // Notebook stats
  document.getElementById('nb-questions-done').textContent = '—';
  document.getElementById('nb-streak').textContent         = studentData?.streak || 0;
  document.getElementById('nb-band-est').textContent       = studentData?.targetBand || '—';
  document.getElementById('nb-assessment').textContent     =
    `Week 1 complete. Band estimate: ${avgBand}. ${weak2.length ? `Your focus areas for Week 2: ${weak2.map(r=>r.name).join(' and ')}.` : 'Keep going — more data gives a sharper picture.'}`;

  document.getElementById('nb-worked-example').classList.add('hidden');

  const next = pickNextSkill();
  document.getElementById('nb-tomorrow-day').textContent   = `Up next — ${next.section}`;
  document.getElementById('nb-tomorrow-title').textContent = next.label;
  document.getElementById('nb-tomorrow-desc').textContent  = next.desc;
}

// ── NOTEBOOK HELPERS ──────────────────────────────────────────────
function renderNotebook(correct, total, skillKey) {
  // Show standard section, hide week1
  document.getElementById('nb-skill-section').classList.remove('hidden');
  document.getElementById('nb-week1-section').classList.add('hidden');

  const accuracy = Math.round((correct / total) * 100);
  const streak   = studentData?.streak    || 1;
  const day      = (studentData?.dayNumber || 2) - 1;

  document.getElementById('nb-questions-done').textContent = total;
  document.getElementById('nb-streak').textContent         = streak;
  document.getElementById('nb-band-est').textContent       = studentData?.currentBand || studentData?.targetBand || '—';

  const nbSkills = getIELTSSkills();
  const isTfng  = skillKey === 'reading.tfng';
  const isSC    = skillKey === 'reading.summaryCompletion';
  const isMC    = skillKey === 'listening.multipleChoice';
  const isFC    = skillKey === 'listening.formCompletion';

  // Current session bar
  const barClass = accuracy >= 80 ? 'strong' : accuracy >= 50 ? 'medium' : 'weak';
  if (isTfng) {
    document.getElementById('nb-tfng-bar').className   = `skill-bar ${barClass}`;
    document.getElementById('nb-tfng-bar').style.width = accuracy + '%';
    document.getElementById('nb-tfng-pct').textContent = accuracy + '%';
  }
  if (isSC) {
    document.getElementById('nb-mh-bar').className   = `skill-bar ${barClass}`;
    document.getElementById('nb-mh-bar').style.width = accuracy + '%';
    document.getElementById('nb-mh-pct').textContent = accuracy + '%';
  }
  if (isMC) {
    document.getElementById('nb-mc-bar').className   = `skill-bar ${barClass}`;
    document.getElementById('nb-mc-bar').style.width = accuracy + '%';
    document.getElementById('nb-mc-pct').textContent = accuracy + '%';
  }
  if (isFC) {
    document.getElementById('nb-fc-bar').className   = `skill-bar ${barClass}`;
    document.getElementById('nb-fc-bar').style.width = accuracy + '%';
    document.getElementById('nb-fc-pct').textContent = accuracy + '%';
  }

  // Other bars from Firestore
  if (!isTfng) setSkillBar('nb-tfng-bar', 'nb-tfng-pct', (nbSkills['reading-tfng']?.attempted             || 0) > 0 ? nbSkills['reading-tfng'].accuracy              : null);
  if (!isSC)   setSkillBar('nb-mh-bar',   'nb-mh-pct',   (nbSkills['reading-summaryCompletion']?.attempted || 0) > 0 ? nbSkills['reading-summaryCompletion'].accuracy  : null);
  if (!isMC)   setSkillBar('nb-mc-bar',   'nb-mc-pct',   (nbSkills['listening-multipleChoice']?.attempted  || 0) > 0 ? nbSkills['listening-multipleChoice'].accuracy    : null);
  if (!isFC)   setSkillBar('nb-fc-bar',   'nb-fc-pct',   (nbSkills['listening-formCompletion']?.attempted  || 0) > 0 ? nbSkills['listening-formCompletion'].accuracy     : null);

  const assessment = accuracy >= 80
    ? `${accuracy}% — strong session. You're building real exam instincts.`
    : accuracy >= 60
    ? `${accuracy}% today. Solid effort — Toody's tracking the pattern in your misses.`
    : `${accuracy}% — that's the baseline. Toody now knows exactly where to focus.`;
  document.getElementById('nb-assessment').textContent = assessment;

  // Worked example
  const questions = isTfng || isSC ? sessionQuestions : listenQuestions;
  const answers   = isTfng || isSC ? sessionAnswers   : listenAnswers;
  const wrongQ    = questions.find(q => {
    const a = answers[q.id];
    return typeof a === 'object' ? a.isRight === false : (normaliseAnswer(a) !== normaliseAnswer(q.answer));
  });
  const weEl = document.getElementById('nb-worked-example');
  if (wrongQ) {
    weEl.classList.remove('hidden');
    document.getElementById('we-q').textContent   = wrongQ.text || wrongQ.label || '';
    document.getElementById('we-exp').textContent = `Answer: ${wrongQ.answer}. ${wrongQ.explanation || ''}`;
  } else {
    weEl.classList.add('hidden');
  }

  renderTomorrowCard();
}

function renderNotebookWriting() {
  document.getElementById('nb-skill-section').classList.remove('hidden');
  document.getElementById('nb-week1-section').classList.add('hidden');

  const day    = (studentData?.dayNumber || 7) - 1;
  const streak = studentData?.streak || 1;

  document.getElementById('nb-questions-done').textContent = `${writingResponse.split(/\s+/).length} words`;
  document.getElementById('nb-streak').textContent         = streak;
  document.getElementById('nb-band-est').textContent       = writingBandEst.toFixed(1);

  const wSkills = getIELTSSkills();
  setSkillBar('nb-tfng-bar', 'nb-tfng-pct', (wSkills['reading-tfng']?.attempted             || 0) > 0 ? wSkills['reading-tfng'].accuracy              : null);
  setSkillBar('nb-mh-bar',   'nb-mh-pct',   (wSkills['reading-summaryCompletion']?.attempted || 0) > 0 ? wSkills['reading-summaryCompletion'].accuracy  : null);
  setSkillBar('nb-mc-bar',   'nb-mc-pct',   (wSkills['listening-multipleChoice']?.attempted  || 0) > 0 ? wSkills['listening-multipleChoice'].accuracy    : null);
  setSkillBar('nb-fc-bar',   'nb-fc-pct',   (wSkills['listening-formCompletion']?.attempted  || 0) > 0 ? wSkills['listening-formCompletion'].accuracy     : null);

  document.getElementById('nb-assessment').textContent =
    `Writing Band Estimate: ${writingBandEst.toFixed(1)}. ${writingBandEst >= 7 ? 'Excellent — this is exam-ready writing.' : writingBandEst >= 6 ? 'Solid foundation. One targeted improvement can push you to 7.' : 'Keep practising. Toody has noted your specific gap areas.'}`;

  document.getElementById('nb-worked-example').classList.add('hidden');
  renderTomorrowCard();
}

function renderNotebookSpeaking() {
  document.getElementById('nb-skill-section').classList.remove('hidden');
  document.getElementById('nb-week1-section').classList.add('hidden');

  const streak = studentData?.streak || 1;
  document.getElementById('nb-questions-done').textContent = `${recordSeconds}s recorded`;
  document.getElementById('nb-streak').textContent         = streak;
  document.getElementById('nb-band-est').textContent       = speakingBandEst.toFixed(1);

  const spSkills = getIELTSSkills();
  setSkillBar('nb-tfng-bar', 'nb-tfng-pct', (spSkills['reading-tfng']?.attempted             || 0) > 0 ? spSkills['reading-tfng'].accuracy              : null);
  setSkillBar('nb-mh-bar',   'nb-mh-pct',   (spSkills['reading-summaryCompletion']?.attempted || 0) > 0 ? spSkills['reading-summaryCompletion'].accuracy  : null);
  setSkillBar('nb-mc-bar',   'nb-mc-pct',   (spSkills['listening-multipleChoice']?.attempted  || 0) > 0 ? spSkills['listening-multipleChoice'].accuracy    : null);
  setSkillBar('nb-fc-bar',   'nb-fc-pct',   (spSkills['listening-formCompletion']?.attempted  || 0) > 0 ? spSkills['listening-formCompletion'].accuracy     : null);

  document.getElementById('nb-assessment').textContent =
    `Speaking Band Estimate: ${speakingBandEst.toFixed(1)}. ${speakingBandEst >= 7 ? 'Impressive — you sound like a Band 7+ speaker.' : speakingBandEst >= 6 ? 'Good fluency. Focus on the suggestion above for your next session.' : 'Early days — every session builds your spoken fluency.'}`;

  document.getElementById('nb-worked-example').classList.add('hidden');
  renderTomorrowCard();
}

function renderTomorrowCard() {
  const next = pickNextSkill();
  document.getElementById('nb-tomorrow-day').textContent   = `Up next — ${next.section}`;
  document.getElementById('nb-tomorrow-title').textContent = next.label;
  document.getElementById('nb-tomorrow-desc').textContent  = next.desc;
}

function setSkillBar(barId, pctId, pct) {
  const bar   = document.getElementById(barId);
  const pctEl = document.getElementById(pctId);
  if (!bar || !pctEl) return;
  if (pct === null) {
    bar.className   = 'skill-bar';
    bar.style.width = '0%';
    pctEl.textContent = '—';
  } else {
    bar.className   = `skill-bar ${pct >= 80 ? 'strong' : pct >= 50 ? 'medium' : 'weak'}`;
    bar.style.width = pct + '%';
    pctEl.textContent = pct + '%';
  }
}

// ── FOCUSED DRILL (Day 9) ─────────────────────────────────────────
async function loadFocusedDrill() {
  const drillSkills = getIELTSSkills();
  const skillRows = [
    { name: 'T / F / Not Given',  pct: (drillSkills['reading-tfng']?.attempted              || 0) > 0 ? drillSkills['reading-tfng'].accuracy              : null, loader: loadReadingSession   },
    { name: 'Summary Completion', pct: (drillSkills['reading-summaryCompletion']?.attempted  || 0) > 0 ? drillSkills['reading-summaryCompletion'].accuracy  : null, loader: loadReadingSession   },
    { name: 'Multiple Choice',   pct: (drillSkills['listening-multipleChoice']?.attempted  || 0) > 0 ? drillSkills['listening-multipleChoice'].accuracy   : null, loader: loadListeningSession },
    { name: 'Form Completion',   pct: (drillSkills['listening-formCompletion']?.attempted  || 0) > 0 ? drillSkills['listening-formCompletion'].accuracy    : null, loader: loadListeningSession },
  ].filter(r => r.pct !== null).sort((a, b) => a.pct - b.pct);

  if (skillRows.length === 0) {
    // No data — default to reading
    loadReadingSession();
    return;
  }

  // Load the weakest skill's session
  skillRows[0].loader();
}

// ── MINI MOCK ─────────────────────────────────────────────────────
function _startMiniMockTimer(phase) {
  if (miniMockTimerInterval) clearInterval(miniMockTimerInterval);
  miniMockTimeRemaining = MINI_MOCK_TIMES[phase] || 1200;
  const labels = ['Reading', 'Listening', 'Writing', 'Speaking'];
  const bar    = document.getElementById('mini-mock-timer-bar');
  if (bar) {
    bar.classList.remove('hidden');
    document.getElementById('mini-mock-phase-label').textContent = labels[phase] || '';
  }
  _updateMiniMockTimerDisplay();
  miniMockTimerInterval = setInterval(() => {
    miniMockTimeRemaining--;
    _updateMiniMockTimerDisplay();
    if (miniMockTimeRemaining <= 0) {
      clearInterval(miniMockTimerInterval);
      miniMockTimerInterval = null;
      _miniMockAutoSubmit(phase);
    }
  }, 1000);
}

function _updateMiniMockTimerDisplay() {
  const m  = Math.floor(miniMockTimeRemaining / 60);
  const s  = miniMockTimeRemaining % 60;
  const el = document.getElementById('mini-mock-countdown');
  if (el) {
    el.textContent = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    el.classList.toggle('urgent', miniMockTimeRemaining <= 60);
  }
}

function _hideMiniMockTimer() {
  if (miniMockTimerInterval) { clearInterval(miniMockTimerInterval); miniMockTimerInterval = null; }
  const bar = document.getElementById('mini-mock-timer-bar');
  if (bar) bar.classList.add('hidden');
}

function _miniMockAutoSubmit(phase) {
  _hideMiniMockTimer();
  if (phase === 0) {
    // Complete any unanswered reading questions as wrong, then finish
    sessionQuestions.forEach(q => {
      if (!sessionAnswers[q.id]) sessionAnswers[q.id] = { val: '', isRight: false };
    });
    finishReadingSession();
  } else if (phase === 1) {
    // Score whatever was answered, finish listening
    listenQuestions.forEach(q => { if (!listenAnswers[q.id]) listenAnswers[q.id] = ''; });
    listenCorrect = listenQuestions.filter(q => {
      const a = listenAnswers[q.id];
      return normaliseAnswer(String(a)) === normaliseAnswer(q.answer || '');
    }).length;
    window.finishListeningSession();
  } else if (phase === 2) {
    // Submit whatever is written
    const text = document.getElementById('writing-textarea')?.value?.trim() || '';
    if (text.split(/\s+/).filter(Boolean).length >= 5) {
      window.submitWriting();
    } else {
      // Nothing written — go to results with 0 band
      mockResults.writing = { band: 0 };
      runMockPhase(3);
    }
  } else if (phase === 3) {
    // Stop recording if active, evaluate whatever was captured
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      window.stopRecording();
    } else {
      // Nothing recorded
      mockResults.speaking = { band: 0 };
      showMockResults();
    }
  }
}

function setupMiniMock() {
  _hideMiniMockTimer();
  mockMode    = false;
  mockPhase   = 0;
  mockResults = {};

  ['reading','listening','writing','speaking'].forEach(s => {
    const el = document.getElementById(`mock-step-${s}`);
    if (el) { el.className = 'mock-step'; el.textContent = ''; }
  });

  document.getElementById('mock-intro-view').classList.remove('hidden');
  document.getElementById('mock-results-view').classList.add('hidden');
}

window.startMiniMock = function () {
  mockMode  = true;
  mockPhase = 0;
  document.getElementById('mock-intro-view').classList.add('hidden');
  runMockPhase(0);
};

function runMockPhase(phase) {
  mockPhase = phase;

  // Stop any running timer
  if (miniMockTimerInterval) { clearInterval(miniMockTimerInterval); miniMockTimerInterval = null; }

  // Update mock progress indicators
  const labels = ['reading','listening','writing','speaking'];
  labels.forEach((l, i) => {
    const el = document.getElementById(`mock-step-${l}`);
    if (!el) return;
    if (i < phase)       { el.className = 'mock-step done'; }
    else if (i === phase){ el.className = 'mock-step active'; }
    else                 { el.className = 'mock-step'; }
  });

  if (phase === 0) { loadReadingSession(); _startMiniMockTimer(0); }
  else if (phase === 1) { listenType = 'mc'; loadListeningSession(); _startMiniMockTimer(1); }
  else if (phase === 2) { loadWritingSession(); _startMiniMockTimer(2); }
  else if (phase === 3) { loadSpeakingSession(); _startMiniMockTimer(3); }
  else showMockResults();
}

function showMockResults() {
  _hideMiniMockTimer();
  mockMode = false;

  const readingPct  = mockResults.reading?.accuracy  || 0;
  const listenPct   = mockResults.listening?.accuracy || 0;
  const writingBand = mockResults.writing?.band       || 0;
  const speakBand   = mockResults.speaking?.band      || 0;

  // Convert writing/speaking band to pseudo-percentage for display
  const writingPct = writingBand > 0 ? Math.round(((writingBand - 4) / 5) * 100) : 0;
  const speakPct   = speakBand  > 0 ? Math.round(((speakBand  - 4) / 5) * 100) : 0;

  const overallBand = (
    (readingPct / 100 * 3 + 4.5) * 0.25 +
    (listenPct  / 100 * 3 + 4.5) * 0.25 +
    writingBand                          * 0.25 +
    speakBand                            * 0.25
  ).toFixed(1);

  document.getElementById('mock-overall-band').textContent = overallBand;

  setSkillBar('mock-reading-bar',  'mock-reading-pct',  readingPct  > 0 ? readingPct  : null);
  setSkillBar('mock-listening-bar','mock-listening-pct', listenPct  > 0 ? listenPct   : null);
  setSkillBar('mock-writing-bar',  'mock-writing-pct',  writingPct  > 0 ? writingPct  : null);
  setSkillBar('mock-speaking-bar', 'mock-speaking-pct', speakPct    > 0 ? speakPct    : null);

  // Generate recommendations from weakest areas
  const sections = [
    { name: 'Reading',  pct: readingPct  },
    { name: 'Listening',pct: listenPct   },
    { name: 'Writing',  pct: writingPct  },
    { name: 'Speaking', pct: speakPct    },
  ].sort((a,b) => a.pct - b.pct);

  const recs = [
    `1. Prioritise <strong>${sections[0].name}</strong> — your lowest section this mock.`,
    `2. Review every incorrect answer immediately after the session.`,
    `3. Sit a full timed practice exam before your real test date.`,
  ];
  document.getElementById('mock-recommendations').innerHTML = recs.join('<br/>');

  // Save mock results to Firestore
  saveSessionDoc(currentUser.uid, {
    weekNumber:     studentData.weekNumber || 2,
    dayNumber:      10,
    skillPracticed: 'minimock',
    mockResults,
    overallBandEstimate: parseFloat(overallBand),
    durationMinutes: 0
  }).catch(() => {});

  updateStudentDoc(currentUser.uid, {
    dayNumber:   11,
    lastSession: serverTimestamp(),
    streak:      (studentData.streak || 0) + 1,
  }).catch(() => {});

  goTo('s-minimock');
  document.getElementById('mock-intro-view').classList.add('hidden');
  document.getElementById('mock-results-view').classList.remove('hidden');
}

// ── BEHAVIOUR ANALYTICS UI ────────────────────────────────────────
function renderBehaviourAnalytics() {
  const el = document.getElementById('progress-behaviour-section');
  if (!el) return;
  const brain = studentData?.brain || {};
  const sessions = brain.totalSessions || 0;

  if (sessions < 2) {
    el.innerHTML = '<p style="font-size:13px;color:var(--muted)">Complete a few sessions to see your study patterns.</p>';
    return;
  }

  const avgTime   = brain.avgTimePerQuestionSec || 0;
  const scrollPct = brain.scrollsBackPct        || 0;
  const changePct = brain.changesAnswersPct      || 0;

  const timeBar  = Math.min(Math.round((avgTime / 120) * 100), 100);
  const timeNote = avgTime < 30 ? 'Fast pace — good instinct'
                 : avgTime < 60 ? 'Considered pace'
                 : 'Slow and thorough — may need to speed up';
  const scrollNote = scrollPct > 70 ? 'Re-reads passage a lot'
                   : scrollPct > 30 ? 'Re-reads when unsure'
                   : 'Trusts first read';
  const changeNote = changePct > 60 ? 'Often second-guesses yourself'
                   : changePct > 20 ? 'Occasionally reconsiders'
                   : 'Confident in first answer';

  el.innerHTML = `
    <div class="behaviour-metric">
      <div class="bm-label">⏱ Time per question</div>
      <div class="bm-bar-track"><div class="bm-bar" style="width:${timeBar}%"></div></div>
      <div class="bm-meta">
        <span class="bm-value">${avgTime}s avg</span>
        <span class="bm-note">${timeNote}</span>
      </div>
    </div>
    <div class="behaviour-metric">
      <div class="bm-label">🔁 Re-reads passage</div>
      <div class="bm-bar-track"><div class="bm-bar" style="width:${scrollPct}%"></div></div>
      <div class="bm-meta">
        <span class="bm-value">${scrollPct}% of sessions</span>
        <span class="bm-note">${scrollNote}</span>
      </div>
    </div>
    <div class="behaviour-metric">
      <div class="bm-label">✏️ Changes answers</div>
      <div class="bm-bar-track"><div class="bm-bar" style="width:${changePct}%"></div></div>
      <div class="bm-meta">
        <span class="bm-value">${changePct}% of sessions</span>
        <span class="bm-note">${changeNote}</span>
      </div>
    </div>`;
}

// ── PROGRESS SCREEN ───────────────────────────────────────────────
window.goToProgress = async function () {
  if (!studentData) return;

  document.getElementById('prog-sessions').textContent = '…';
  document.getElementById('prog-band').textContent     = studentData.targetBand || '—';
  document.getElementById('prog-streak').textContent   = studentData.streak     || 0;

  const progSkills = getIELTSSkills();
  setSkillBar('prog-tfng-bar', 'prog-tfng-pct', (progSkills['reading-tfng']?.attempted              || 0) > 0 ? progSkills['reading-tfng'].accuracy              : null);
  setSkillBar('prog-mh-bar',   'prog-mh-pct',   (progSkills['reading-summaryCompletion']?.attempted  || 0) > 0 ? progSkills['reading-summaryCompletion'].accuracy  : null);
  setSkillBar('prog-mc-bar',   'prog-mc-pct',   (progSkills['listening-multipleChoice']?.attempted   || 0) > 0 ? progSkills['listening-multipleChoice'].accuracy    : null);
  setSkillBar('prog-fc-bar',   'prog-fc-pct',   (progSkills['listening-formCompletion']?.attempted   || 0) > 0 ? progSkills['listening-formCompletion'].accuracy     : null);

  renderBehaviourAnalytics();

  document.getElementById('progress-loading').classList.remove('hidden');
  document.getElementById('progress-session-list').innerHTML = '';
  goTo('s-progress');

  try {
    const snap = await getDocs(
      query(collection(db, 'students', currentUser.uid, 'sessions'), orderBy('date', 'desc'))
    );

    document.getElementById('prog-sessions').textContent = snap.size;
    document.getElementById('progress-loading').classList.add('hidden');

    if (snap.empty) {
      document.getElementById('progress-session-list').innerHTML =
        '<p style="font-size:13px;color:var(--muted)">No sessions yet.</p>';
      return;
    }

    document.getElementById('progress-session-list').innerHTML = snap.docs.map(d => {
      const s   = d.data();
      const day = s.dayNumber    ? `Day ${s.dayNumber}` : '—';
      const skill = (s.skillPracticed && SKILL_MAP[s.skillPracticed]?.label) || s.skillPracticed || '—';
      const score = s.accuracy != null
        ? `${s.accuracy}%`
        : s.bandEstimate != null
        ? `Band ${s.bandEstimate}`
        : '—';
      const dateStr = s.date?.toDate
        ? s.date.toDate().toLocaleDateString('en-GB', { day:'numeric', month:'short' })
        : '—';
      return `
        <div class="progress-session-item" style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border);">
          <div>
            <div style="font-size:13px;font-weight:600">${day} — ${skill}</div>
            <div style="font-size:11px;color:var(--muted)">${dateStr}</div>
          </div>
          <div style="font-size:14px;font-weight:600;color:var(--accent)">${score}</div>
        </div>`;
    }).join('');
  } catch {
    document.getElementById('progress-loading').classList.add('hidden');
    document.getElementById('progress-session-list').innerHTML =
      '<p style="font-size:13px;color:var(--danger)">Could not load session history. Check your connection.</p>';
  }
};

// ── CONTEXT SNIPPET ───────────────────────────────────────────────
function buildContextSnippet() {
  if (!studentData) return '';

  const name    = studentData.preferredName || studentData.name?.split(' ')[0] || 'Student';
  const target  = studentData.targetBand  || 6.5;
  const current = studentData.currentBand || target;
  const week    = studentData.weekNumber  || 1;
  const day     = studentData.dayNumber   || 1;
  const ctxSkills = getIELTSSkills();
  const brain   = studentData.brain       || {};
  const weak    = studentData.weakAreas   || [];
  const purpose = studentData.purpose     || '';

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
    hedgingMissed:       'misses hedging language — may/suggests/could',
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
  const focusSkill = weak[0] ? weak[0].replace('-', ' ') : 'the student\'s weakest area';
  const focusMissed = weak[0] ? (brain.topMissedSubType?.[toSkillId(weak[0])] || brain.topMissedSubType?.[weak[0]] || null) : null;

  const purposeNote = purpose === 'university'  ? 'Use academic/scientific passage topics (research, environment, technology, history).'
                    : purpose === 'migration'   ? 'Use general-interest topics relevant to daily life, society, health, culture.'
                    : purpose === 'work'        ? 'Use professional/workplace topics where relevant.'
                    : '';

  const lines = [
    `STUDENT: ${name} | Target: Band ${target} | Current estimate: Band ${current} | Week ${week} Day ${day}`,
    `STRONG: ${strong.length ? strong.join(', ') : 'No data yet — first session'}`,
    `WEAK: ${weakSkills.length ? weakSkills.join(', ') : 'No weak areas identified yet'}`,
    ...(topTfngErrors.length ? [`READING ERROR PATTERNS: ${topTfngErrors.join('; ')} — target these specific failures in T/F/NG questions`] : []),
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
    `- Focus on ${focusSkill}${focusMissed ? ` — student consistently misses "${focusMissed}" answer type` : ''}`,
    `- Set difficulty at Band ${targetPush} — push slightly beyond current level`,
    ...(purposeNote ? [`- TOPIC PREFERENCE: ${purposeNote}`] : []),
  ];

  return lines.join('\n');
}

// ── AI CALL ───────────────────────────────────────────────────────
async function callAI(prompt) {
  const vision  = getVisionPrompt(studentData);
  const snippet = buildContextSnippet();
  const systemContent = [
    vision,
    snippet ? `\n---\n\n${snippet}` : '',
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

// ── NAV ACTIONS ───────────────────────────────────────────────────

// ══════════════════════════════════════════════════════════════════
// FULL MOCK TEST SYSTEM
// ══════════════════════════════════════════════════════════════════

function rawScoreToBand(raw, total) {
  const pct = raw / total;
  for (const [minRaw, band] of IELTS_BAND_TABLE) {
    if (raw >= (minRaw / 40) * total) return band;
  }
  return 1.0;
}

window.startFullMockSetup = function () {
  fullMockSelectedOpt = 'all';
  document.querySelectorAll('.mock-option-btn').forEach((b, i) => {
    b.classList.toggle('active', i === 0);
  });
  goTo('s-fullmock-setup');
};

window.selectMockOption = function (btn) {
  document.querySelectorAll('.mock-option-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  fullMockSelectedOpt = btn.dataset.sections;
};

window.startFullMockGeneration = async function () {
  const opt = fullMockSelectedOpt;
  fullMockSections = opt === 'all'
    ? ['reading','listening','writing','speaking']
    : [opt];
  fullMockSectionIdx = 0;
  fullMockContent    = {};
  fullMockAnswers    = {};
  fullMockWritingResp  = {};
  fullMockSpeakingResp = {};
  fullMockResults    = {};

  goTo('s-fullmock-gen');
  _setGenStep('reading',   false);
  _setGenStep('listening', false);
  _setGenStep('writing',   false);
  _setGenStep('speaking',  false);
  document.getElementById('mock-gen-bar').style.width = '0%';

  const band = studentData?.targetBand || 6.5;
  let done = 0;
  const total = fullMockSections.length;

  const updateBar = () => {
    done++;
    document.getElementById('mock-gen-bar').style.width = `${Math.round(done/total*100)}%`;
  };

  // Generate all sections in parallel
  const tasks = [];

  if (fullMockSections.includes('reading')) {
    tasks.push((async () => {
      _setGenStep('reading', 'loading');
      try {
        const [p1, p2, p3] = await Promise.all([
          callAI({ system: 'You are an IELTS Academic examiner. Return valid JSON only.', user: `Generate an IELTS Academic Reading passage with 8 True/False/Not Given questions for Band ${band}. Return ONLY: {"topic":"...","passage":"200-word academic passage","questions":[{"id":1,"text":"claim","answer":"True|False|NG","explanation":"one sentence"},...8 questions]}`, maxTokens: 1800 }),
          callAI({ system: 'You are an IELTS Academic examiner. Return valid JSON only.', user: `Generate an IELTS Academic Reading passage with 8 Matching Headings questions for Band ${band}. Return ONLY: {"topic":"...","passage":"4 paragraphs labelled A-D, each 40-50 words","headings":["heading 1","heading 2","heading 3","heading 4","heading 5","heading 6"],"questions":[{"id":1,"paragraph":"A","answer":"3","explanation":"one sentence"},...4 questions matching A-D to headings]}`, maxTokens: 1800 }),
          callAI({ system: 'You are an IELTS Academic examiner. Return valid JSON only.', user: `Generate an IELTS Academic Reading passage with 8 Summary Completion questions for Band ${band}. Return ONLY: {"topic":"...","passage":"200-word academic passage","summaryText":"A short summary with 8 gaps marked as [1],[2]...[8]","wordBank":["word1","word2","word3","word4","word5","word6","word7","word8","decoy1","decoy2"],"questions":[{"id":1,"answer":"correct word from passage","explanation":"one sentence"},...8 questions]}`, maxTokens: 1800 }),
        ]);
        fullMockContent.reading = {
          passages: [
            { ...parseAIJson(p1), type: 'tfng' },
            { ...parseAIJson(p2), type: 'matchingHeadings' },
            { ...parseAIJson(p3), type: 'summaryCompletion' },
          ]
        };
        _setGenStep('reading', 'done');
      } catch { _setGenStep('reading', 'error'); fullMockContent.reading = null; }
      updateBar();
    })());
  }

  if (fullMockSections.includes('listening')) {
    tasks.push((async () => {
      _setGenStep('listening', 'loading');
      try {
        const [s1, s2, s3, s4] = await Promise.all([
          callAI({ system: 'You are an IELTS examiner. Return valid JSON only.', user: `Create an IELTS Listening Multiple Choice section for Band ${band}. A conversation in an everyday context (e.g. booking, enquiry). Return ONLY: {"scenario":"2-sentence description","audioText":"spoken conversation 150-180 words","questions":[{"id":1,"text":"question?","options":["A: option","B: option","C: option"],"answer":"A|B|C","explanation":"one sentence"},...7 questions]}`, maxTokens: 1600 }),
          callAI({ system: 'You are an IELTS examiner. Return valid JSON only.', user: `Create an IELTS Listening Multiple Choice section for Band ${band}. A monologue/talk in an educational context. Return ONLY: {"scenario":"2-sentence description","audioText":"spoken monologue 150-180 words","questions":[{"id":1,"text":"question?","options":["A: option","B: option","C: option"],"answer":"A|B|C","explanation":"one sentence"},...7 questions]}`, maxTokens: 1600 }),
          callAI({ system: 'You are an IELTS examiner. Return valid JSON only.', user: `Create an IELTS Listening Form Completion section for Band ${band}. Return ONLY: {"scenario":"2-sentence description","audioText":"spoken conversation 150-180 words about a form","formTitle":"Form name","questions":[{"id":1,"fieldLabel":"Field name","answer":"answer word(s)","explanation":"one sentence"},...7 questions]}`, maxTokens: 1600 }),
          callAI({ system: 'You are an IELTS examiner. Return valid JSON only.', user: `Create an IELTS Listening Multiple Choice section (academic lecture context) for Band ${band}. Return ONLY: {"scenario":"2-sentence description","audioText":"academic lecture 180-200 words","questions":[{"id":1,"text":"question?","options":["A: option","B: option","C: option"],"answer":"A|B|C","explanation":"one sentence"},...7 questions]}`, maxTokens: 1600 }),
        ]);
        const parsed = [s1, s2, s3, s4].map(r => parseAIJson(r));
        // Generate audio in sequence (rate limit friendly)
        const audioUrls = [];
        for (const sec of parsed) {
          try {
            const audioRes = await fetch(`${API_URL.replace('/generate', '/audio')}`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: sec.audioText })
            });
            const audioData = await audioRes.json();
            audioUrls.push(audioData.audioUrl || null);
          } catch { audioUrls.push(null); }
        }
        fullMockContent.listening = {
          sections: parsed.map((sec, i) => ({
            ...sec,
            audioUrl: audioUrls[i],
            type: i === 2 ? 'formCompletion' : 'multipleChoice',
          }))
        };
        _setGenStep('listening', 'done');
      } catch { _setGenStep('listening', 'error'); fullMockContent.listening = null; }
      updateBar();
    })());
  }

  if (fullMockSections.includes('writing')) {
    tasks.push((async () => {
      _setGenStep('writing', 'loading');
      try {
        const raw = await callAI({
          system: 'You are an IELTS Writing examiner. Return valid JSON only.',
          user: `Generate both IELTS Writing tasks for Band ${band}. Return ONLY: {"task1":{"title":"Graph/Chart Description","prompt":"Describe the following [bar chart/line graph/table]. The graph shows [topic]. Write at least 150 words."},"task2":{"title":"Opinion Essay","prompt":"[Essay question on a relevant academic topic]. Give your opinion and support it with examples. Write at least 250 words."}}`,
          maxTokens: 600
        });
        fullMockContent.writing = parseAIJson(raw);
        _setGenStep('writing', 'done');
      } catch { _setGenStep('writing', 'error'); fullMockContent.writing = null; }
      updateBar();
    })());
  }

  if (fullMockSections.includes('speaking')) {
    tasks.push((async () => {
      _setGenStep('speaking', 'loading');
      try {
        const raw = await callAI({
          system: 'You are an IELTS Speaking examiner. Return valid JSON only.',
          user: `Generate IELTS Speaking test content for Band ${band}. Return ONLY: {"part1":{"topic":"Personal topic (e.g. hometown)","questions":["question 1?","question 2?","question 3?","question 4?","question 5?"]},"part2":{"topic":"Cue card topic","cueCard":["Describe [topic]. You should say:","- point 1","- point 2","- point 3","and explain [final point]."]},"part3":{"questions":["discussion question 1?","discussion question 2?","discussion question 3?","discussion question 4?","discussion question 5?"]}}`,
          maxTokens: 800
        });
        fullMockContent.speaking = parseAIJson(raw);
        _setGenStep('speaking', 'done');
      } catch { _setGenStep('speaking', 'error'); fullMockContent.speaking = null; }
      updateBar();
    })());
  }

  await Promise.all(tasks);

  // All done — check if any critical section failed
  const failed = fullMockSections.filter(s => fullMockContent[s] === null);
  if (failed.length === fullMockSections.length) {
    showToast('Having trouble connecting — please check your internet and try again.');
    goTo('s-fullmock-setup');
    return;
  }
  // Filter out failed sections
  fullMockSections = fullMockSections.filter(s => fullMockContent[s] !== null);
  fullMockSectionIdx = 0;
  _startMockSection();
};

function _setGenStep(section, state) {
  const el = document.getElementById(`mgs-${section}`);
  if (!el) return;
  const dot = el.querySelector('.mgs-dot');
  if (state === false)     { el.className = 'mock-gen-step'; if (dot) dot.textContent = '○'; }
  else if (state === 'loading') { el.className = 'mock-gen-step loading'; if (dot) dot.textContent = '⟳'; }
  else if (state === 'done')    { el.className = 'mock-gen-step done'; if (dot) dot.textContent = '✓'; }
  else if (state === 'error')   { el.className = 'mock-gen-step error'; if (dot) dot.textContent = '✗'; }
}

function _startMockSection() {
  if (fullMockSectionIdx >= fullMockSections.length) {
    _evalMockTest();
    return;
  }
  const section = fullMockSections[fullMockSectionIdx];
  fullMockTimeRemaining = MOCK_SECTION_TIMES[section] || 3600;
  if (!fullMockAnswers[section]) fullMockAnswers[section] = {};
  goTo('s-fullmock-test');
  _renderMockSection(section);
  _startMockTimer();
}

function _startMockTimer() {
  if (fullMockTimerInterval) clearInterval(fullMockTimerInterval);
  _updateTimerDisplay();
  fullMockTimerInterval = setInterval(() => {
    fullMockTimeRemaining--;
    _updateTimerDisplay();
    if (fullMockTimeRemaining <= 0) {
      clearInterval(fullMockTimerInterval);
      window.submitMockSection();
    }
  }, 1000);
}

function _updateTimerDisplay() {
  const m = Math.floor(fullMockTimeRemaining / 60);
  const s = fullMockTimeRemaining % 60;
  const el = document.getElementById('mock-test-timer');
  if (el) {
    el.textContent = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    el.className = 'mock-test-timer' + (fullMockTimeRemaining <= 300 ? ' urgent' : '');
  }
}

function _renderMockSection(section) {
  const labelEl = document.getElementById('mock-test-section-label');
  if (labelEl) labelEl.textContent = section.charAt(0).toUpperCase() + section.slice(1);
  const body = document.getElementById('mock-test-body');
  if (!body) return;

  if (section === 'reading') {
    body.innerHTML = _renderMockReading();
  } else if (section === 'listening') {
    body.innerHTML = _renderMockListening();
  } else if (section === 'writing') {
    body.innerHTML = _renderMockWriting();
  } else if (section === 'speaking') {
    body.innerHTML = _renderMockSpeaking();
    _initMockSpeaking();
  }
}

function _renderMockReading() {
  const passages = fullMockContent.reading?.passages || [];
  let html = '';
  passages.forEach((passage, pIdx) => {
    html += `<div class="mock-passage-block">
      <div class="mock-passage-label">Passage ${pIdx+1} — ${passage.topic || ''}</div>
      <div class="mock-passage-text">${(passage.passage || '').split('\n').map(p => `<p>${p}</p>`).join('')}</div>`;
    if (passage.type === 'matchingHeadings' && passage.headings) {
      html += `<div class="mock-headings-list"><strong>List of Headings:</strong><ol class="mock-heading-ol">`;
      passage.headings.forEach((h, i) => { html += `<li>${h}</li>`; });
      html += `</ol></div>`;
    }
    if (passage.type === 'summaryCompletion' && passage.summaryText) {
      html += `<div class="mock-summary-wrap"><div class="mock-summary-label">Summary Completion</div><div class="mock-summary-text">${passage.summaryText}</div>`;
      if (passage.wordBank) {
        html += `<div class="mock-wordbank"><strong>Word Bank:</strong> ${passage.wordBank.join(' · ')}</div>`;
      }
      html += `</div>`;
    }
    const questions = passage.questions || [];
    html += `<div class="mock-questions-block">`;
    questions.forEach(q => {
      const qid = `r_${pIdx}_${q.id}`;
      if (passage.type === 'tfng') {
        html += `<div class="mock-q">
          <div class="mock-q-num">${q.id}.</div>
          <div class="mock-q-body">
            <div class="mock-q-text">${q.text}</div>
            <div class="mock-q-tfng">
              <label><input type="radio" name="${qid}" value="True" onchange="window.mockAnswer('reading','${qid}',this.value)"> True</label>
              <label><input type="radio" name="${qid}" value="False" onchange="window.mockAnswer('reading','${qid}',this.value)"> False</label>
              <label><input type="radio" name="${qid}" value="NG" onchange="window.mockAnswer('reading','${qid}',this.value)"> Not Given</label>
            </div>
          </div>
        </div>`;
      } else if (passage.type === 'matchingHeadings') {
        html += `<div class="mock-q">
          <div class="mock-q-num">${q.id}.</div>
          <div class="mock-q-body">
            <div class="mock-q-text">Paragraph ${q.paragraph}</div>
            <select class="mock-select" onchange="window.mockAnswer('reading','${qid}',this.value)">
              <option value="">— Choose heading —</option>
              ${(passage.headings || []).map((h,i) => `<option value="${i+1}">${i+1}. ${h}</option>`).join('')}
            </select>
          </div>
        </div>`;
      } else {
        html += `<div class="mock-q">
          <div class="mock-q-num">${q.id}.</div>
          <div class="mock-q-body">
            <input type="text" class="mock-input" placeholder="Your answer" onchange="window.mockAnswer('reading','${qid}',this.value)">
          </div>
        </div>`;
      }
    });
    html += `</div></div>`;
  });
  return html;
}

function _renderMockListening() {
  const sections = fullMockContent.listening?.sections || [];
  let html = '';
  sections.forEach((sec, sIdx) => {
    html += `<div class="mock-listen-block">
      <div class="mock-passage-label">Section ${sIdx+1} — ${sec.scenario || ''}</div>`;
    if (sec.audioUrl) {
      html += `<div class="mock-audio-wrap">
        <audio id="mock-audio-${sIdx}" src="${sec.audioUrl}" preload="auto"></audio>
        <button class="mock-play-btn" onclick="document.getElementById('mock-audio-${sIdx}').play()">▶ Play Audio</button>
      </div>`;
    } else {
      html += `<div class="mock-audio-unavail">Audio unavailable — read the scenario text for this section.</div>`;
      html += `<div class="mock-passage-text" style="font-style:italic;font-size:13px">${sec.audioText || ''}</div>`;
    }
    const questions = sec.questions || [];
    html += `<div class="mock-questions-block">`;
    questions.forEach(q => {
      const qid = `l_${sIdx}_${q.id}`;
      if (sec.type === 'multipleChoice') {
        html += `<div class="mock-q">
          <div class="mock-q-num">${q.id}.</div>
          <div class="mock-q-body">
            <div class="mock-q-text">${q.text}</div>
            <div class="mock-q-options">
              ${(q.options || []).map(opt => {
                const val = opt.split(':')[0].trim();
                return `<label class="mock-opt-label"><input type="radio" name="${qid}" value="${val}" onchange="window.mockAnswer('listening','${qid}',this.value)"> ${opt}</label>`;
              }).join('')}
            </div>
          </div>
        </div>`;
      } else {
        html += `<div class="mock-q">
          <div class="mock-q-num">${q.id}.</div>
          <div class="mock-q-body">
            <div class="mock-q-text">${q.fieldLabel || q.text || ''}</div>
            <input type="text" class="mock-input" placeholder="Your answer" onchange="window.mockAnswer('listening','${qid}',this.value)">
          </div>
        </div>`;
      }
    });
    html += `</div></div>`;
  });
  return html;
}

function _renderMockWriting() {
  const w = fullMockContent.writing || {};
  return `
    <div class="mock-writing-block">
      <div class="mock-passage-label">Task 1 — ${w.task1?.title || 'Graph Description'}</div>
      <div class="mock-writing-prompt">${w.task1?.prompt || ''}</div>
      <textarea class="mock-textarea" id="mock-w-task1" placeholder="Write your Task 1 response here (minimum 150 words)..."
        oninput="window.mockWritingInput('task1',this.value)"></textarea>
      <div class="mock-wc" id="mock-wc-task1">0 words</div>
    </div>
    <div class="mock-writing-block" style="margin-top:24px">
      <div class="mock-passage-label">Task 2 — ${w.task2?.title || 'Essay'}</div>
      <div class="mock-writing-prompt">${w.task2?.prompt || ''}</div>
      <textarea class="mock-textarea" id="mock-w-task2" placeholder="Write your Task 2 response here (minimum 250 words)..."
        oninput="window.mockWritingInput('task2',this.value)"></textarea>
      <div class="mock-wc" id="mock-wc-task2">0 words</div>
    </div>`;
}

function _renderMockSpeaking() {
  const sp = fullMockContent.speaking || {};
  return `
    <div class="mock-speaking-block">
      <div class="mock-passage-label">Part 1 — ${sp.part1?.topic || 'Personal Questions'}</div>
      <div class="mock-speaking-qs">
        ${(sp.part1?.questions || []).map((q,i) => `<div class="mock-sp-q">${i+1}. ${q}</div>`).join('')}
      </div>
      <div class="mock-passage-label mt16">Part 2 — Cue Card</div>
      <div class="mock-cue-card">
        ${(sp.part2?.cueCard || []).map(line => `<div>${line}</div>`).join('')}
      </div>
      <div class="mock-passage-label mt16">Part 3 — Discussion</div>
      <div class="mock-speaking-qs">
        ${(sp.part3?.questions || []).map((q,i) => `<div class="mock-sp-q">${i+1}. ${q}</div>`).join('')}
      </div>
      <div class="mock-speaking-record">
        <div class="mock-record-status" id="mock-record-status">Tap to record your answers</div>
        <button class="mock-record-btn" id="mock-record-btn" onclick="window.toggleMockRecording()">🎙 Start Recording</button>
        <div class="mock-record-timer" id="mock-record-timer" style="display:none">0:00</div>
      </div>
      <textarea class="mock-textarea" id="mock-sp-notes" placeholder="(Optional) Note down key points..." rows="4"
        oninput="window.mockSpeakingNotes(this.value)"></textarea>
    </div>`;
}

function _initMockSpeaking() {
  window.mockSpeakingNotes = function (val) {
    fullMockSpeakingResp.notes = val;
  };
}

window.mockAnswer = function (section, qid, value) {
  if (!fullMockAnswers[section]) fullMockAnswers[section] = {};
  fullMockAnswers[section][qid] = value;
};

window.mockWritingInput = function (taskKey, value) {
  fullMockWritingResp[taskKey] = value;
  const wc = value.trim().split(/\s+/).filter(Boolean).length;
  const el = document.getElementById(`mock-wc-${taskKey}`);
  if (el) el.textContent = `${wc} word${wc !== 1 ? 's' : ''}`;
};

let mockRecording = false;
let mockRecorder  = null;
let mockRecordedChunks = [];
let mockRecordSeconds  = 0;
let mockRecordInterval = null;

window.toggleMockRecording = async function () {
  const btn  = document.getElementById('mock-record-btn');
  const stat = document.getElementById('mock-record-status');
  const timer = document.getElementById('mock-record-timer');
  if (!mockRecording) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mockRecordedChunks = [];
      mockRecorder = new MediaRecorder(stream);
      mockRecorder.ondataavailable = e => { if (e.data.size > 0) mockRecordedChunks.push(e.data); };
      mockRecorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(mockRecordedChunks, { type: 'audio/webm' });
        // Transcribe via Whisper
        stat.textContent = 'Transcribing...';
        try {
          const formData = new FormData();
          formData.append('audio', blob, 'speaking.webm');
          const res = await fetch(API_URL.replace('/generate', '/transcribe'), { method: 'POST', body: formData });
          const data = await res.json();
          fullMockSpeakingResp.transcript = data.transcript || '';
          stat.textContent = 'Recording saved ✓';
        } catch { stat.textContent = 'Recording saved (transcription failed)'; }
      };
      mockRecorder.start();
      mockRecording = true;
      mockRecordSeconds = 0;
      timer.style.display = '';
      timer.textContent = '0:00';
      mockRecordInterval = setInterval(() => {
        mockRecordSeconds++;
        const m = Math.floor(mockRecordSeconds/60), s = mockRecordSeconds%60;
        timer.textContent = `${m}:${String(s).padStart(2,'0')}`;
      }, 1000);
      btn.textContent = '⏹ Stop Recording';
      stat.textContent = 'Recording...';
    } catch { stat.textContent = 'Microphone access denied.'; }
  } else {
    if (mockRecorder && mockRecorder.state !== 'inactive') mockRecorder.stop();
    clearInterval(mockRecordInterval);
    mockRecording = false;
    btn.textContent = '🎙 Record Again';
  }
};

window.submitMockSection = function () {
  clearInterval(fullMockTimerInterval);
  if (mockRecording && mockRecorder) {
    mockRecorder.stop();
    mockRecording = false;
    clearInterval(mockRecordInterval);
  }
  fullMockSectionIdx++;
  if (fullMockSectionIdx < fullMockSections.length) {
    _startMockSection();
  } else {
    _evalMockTest();
  }
};

async function _evalMockTest() {
  goTo('s-fullmock-eval');
  const band = studentData?.targetBand || 6.5;

  // Evaluate reading
  if (fullMockContent.reading) {
    let correct = 0, total = 0;
    const wrongQs = [];
    fullMockContent.reading.passages.forEach((passage, pIdx) => {
      (passage.questions || []).forEach(q => {
        const qid = `r_${pIdx}_${q.id}`;
        const given = normaliseAnswer(fullMockAnswers.reading?.[qid] || '');
        const correct_ans = normaliseAnswer(q.answer || '');
        total++;
        if (given === correct_ans) { correct++; }
        else { wrongQs.push({ ...q, givenAnswer: given, section: 'Reading', type: passage.type }); }
      });
    });
    fullMockResults.reading = { correct, total, band: rawScoreToBand(correct, total), wrongQs };
  }

  // Evaluate listening
  if (fullMockContent.listening) {
    let correct = 0, total = 0;
    const wrongQs = [];
    fullMockContent.listening.sections.forEach((sec, sIdx) => {
      (sec.questions || []).forEach(q => {
        const qid = `l_${sIdx}_${q.id}`;
        const given = normaliseAnswer(fullMockAnswers.listening?.[qid] || '');
        const correct_ans = normaliseAnswer(q.answer || '');
        total++;
        if (given === correct_ans || given === correct_ans.charAt(0)) { correct++; }
        else { wrongQs.push({ ...q, givenAnswer: given, section: 'Listening', type: sec.type }); }
      });
    });
    fullMockResults.listening = { correct, total, band: rawScoreToBand(correct, total), wrongQs };
  }

  // Evaluate writing via AI
  if (fullMockContent.writing) {
    try {
      const t1 = fullMockWritingResp.task1 || '';
      const t2 = fullMockWritingResp.task2 || '';
      const evalPrompt = {
        system: 'You are an IELTS Writing examiner. Return valid JSON only.',
        user: `Evaluate these IELTS Writing responses for a Band ${band} student.
Task 1 prompt: ${fullMockContent.writing.task1?.prompt || ''}
Task 1 response: ${t1}
Task 2 prompt: ${fullMockContent.writing.task2?.prompt || ''}
Task 2 response: ${t2}
Return ONLY: {"task1Band":6.0,"task2Band":6.5,"overallBand":6.5,"task1Feedback":"one sentence","task2Feedback":"one sentence","topIssue":"most important improvement"}`,
        maxTokens: 500
      };
      const raw = await callAI(evalPrompt);
      const result = parseAIJson(raw);
      fullMockResults.writing = {
        band: result.overallBand || 6.0,
        task1Band: result.task1Band, task2Band: result.task2Band,
        task1Feedback: result.task1Feedback, task2Feedback: result.task2Feedback,
        topIssue: result.topIssue,
      };
    } catch { fullMockResults.writing = { band: 6.0 }; }
  }

  // Evaluate speaking via AI
  if (fullMockContent.speaking) {
    try {
      const transcript = fullMockSpeakingResp.transcript || fullMockSpeakingResp.notes || '(no transcript available)';
      const evalPrompt = {
        system: 'You are an IELTS Speaking examiner. Return valid JSON only.',
        user: `Evaluate this IELTS Speaking response for a Band ${band} student.
Questions covered: Part 1 (${fullMockContent.speaking.part1?.topic}), Part 2 (${fullMockContent.speaking.part2?.topic}), Part 3 discussion.
Transcript/notes: ${transcript}
Return ONLY: {"overallBand":6.5,"fluencyBand":6.5,"lexicalBand":6.5,"grammarBand":6.5,"pronunciationBand":6.5,"feedback":"2 sentences of honest assessment","topSuggestion":"one concrete improvement"}`,
        maxTokens: 400
      };
      const raw = await callAI(evalPrompt);
      const result = parseAIJson(raw);
      fullMockResults.speaking = {
        band: result.overallBand || 6.0,
        feedback: result.feedback, topSuggestion: result.topSuggestion,
      };
    } catch { fullMockResults.speaking = { band: 6.0 }; }
  }

  await _showMockReport();
}

async function _showMockReport() {
  // Calculate overall band
  const bands = [];
  if (fullMockResults.reading)   bands.push(fullMockResults.reading.band);
  if (fullMockResults.listening) bands.push(fullMockResults.listening.band);
  if (fullMockResults.writing)   bands.push(fullMockResults.writing.band);
  if (fullMockResults.speaking)  bands.push(fullMockResults.speaking.band);
  const overall = bands.length ? (bands.reduce((a,b) => a+b, 0) / bands.length) : 0;
  // Round to nearest 0.5
  const overallRounded = Math.round(overall * 2) / 2;

  fullMockResults.overall = overallRounded;

  // Save to Firestore
  const mockDoc = {
    date:            new Date().toISOString(),
    sections:        fullMockSections,
    overall:         overallRounded,
    reading:         fullMockResults.reading?.band  || null,
    listening:       fullMockResults.listening?.band || null,
    writing:         fullMockResults.writing?.band   || null,
    speaking:        fullMockResults.speaking?.band  || null,
  };
  try {
    await saveSessionDoc(currentUser.uid, { ...mockDoc, skillPracticed: 'fullMock', durationMinutes: 0 });
    // Save compact mock history entry
    const existingMocks = studentData?.mockHistory || [];
    await updateStudentDoc(currentUser.uid, {
      mockHistory: [...existingMocks, { date: mockDoc.date, overall: overallRounded,
        reading: mockDoc.reading, listening: mockDoc.listening,
        writing: mockDoc.writing, speaking: mockDoc.speaking }]
    });
  } catch { /* non-critical */ }

  // Update brain with mock performance
  const skillUpdates = {};
  if (fullMockResults.reading) {
    const r = fullMockResults.reading;
    const acc = Math.round(r.correct / r.total * 100);
    skillUpdates['reading-tfng'] = { accuracy: acc, attempted: r.total };
    await updateStudentBrain(getBehaviourPayload(), acc, 'reading.tfng');
  }

  goTo('s-fullmock-report');

  // Render Part 1: Score Summary
  document.getElementById('mock-report-date').textContent = new Date().toLocaleDateString('en-GB', { day:'numeric', month:'long', year:'numeric' });
  document.getElementById('mr-overall-band').textContent = overallRounded.toFixed(1);

  // Compare to Day 1
  const baseline = studentData?.targetBand || 6.5;
  const diff = (overallRounded - baseline).toFixed(1);
  const compareEl = document.getElementById('mr-compare');
  if (compareEl) {
    const sign = diff >= 0 ? '+' : '';
    compareEl.textContent = `${sign}${diff} bands vs. your target of ${baseline}`;
    compareEl.style.color = diff >= 0 ? 'var(--success)' : 'var(--danger)';
  }

  const scoreHtml = [
    { label: 'Reading',   band: fullMockResults.reading?.band,   color: 'var(--accent-light)' },
    { label: 'Listening', band: fullMockResults.listening?.band, color: 'var(--surface2)' },
    { label: 'Writing',   band: fullMockResults.writing?.band,   color: 'var(--success-light)' },
    { label: 'Speaking',  band: fullMockResults.speaking?.band,  color: 'var(--yellow-light)' },
  ].filter(s => s.band != null).map(s => `
    <div class="mock-score-card" style="background:${s.color}">
      <div class="msc-label">${s.label}</div>
      <div class="msc-band">${s.band.toFixed(1)}</div>
    </div>`).join('');
  document.getElementById('mock-section-scores').innerHTML = scoreHtml;

  // Render Part 2: Skill Breakdown
  const sbRows = [];
  if (fullMockResults.reading) {
    const pct = Math.round(fullMockResults.reading.correct / fullMockResults.reading.total * 100);
    sbRows.push({ label: 'Reading (overall)', pct });
  }
  if (fullMockResults.listening) {
    const pct = Math.round(fullMockResults.listening.correct / fullMockResults.listening.total * 100);
    sbRows.push({ label: 'Listening (overall)', pct });
  }
  const sbHtml = sbRows.map(r => `
    <div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border)">
      <span style="flex:1;font-size:13px;font-weight:400">${r.label}</span>
      <div style="flex:1;height:5px;background:var(--border);border-radius:4px;overflow:hidden">
        <div style="width:${r.pct}%;height:100%;background:${r.pct>=70?'var(--success)':'var(--danger)'};border-radius:4px"></div>
      </div>
      <span style="font-size:11px;font-weight:600;color:var(--accent);width:36px;text-align:right">${r.pct}%</span>
    </div>`).join('');
  document.getElementById('mr-skill-breakdown').innerHTML = sbHtml || '<p style="font-size:13px;color:var(--muted)">—</p>';

  // Part 3: AI Debrief (async)
  _generateMockDebrief(overallRounded);

  // Part 4: Question Review
  const allWrong = [
    ...(fullMockResults.reading?.wrongQs  || []),
    ...(fullMockResults.listening?.wrongQs || []),
  ];
  const reviewHtml = allWrong.length
    ? allWrong.map(q => `
      <div class="mock-review-item">
        <div class="mock-review-section">${q.section}</div>
        <div class="mock-review-q">${q.text || q.fieldLabel || ''}</div>
        <div class="mock-review-ans">Your answer: <span class="wrong-ans">${q.givenAnswer || '—'}</span></div>
        <div class="mock-review-ans">Correct: <span class="correct-ans">${q.answer}</span></div>
        <div class="mock-review-exp">${q.explanation || ''}</div>
      </div>`).join('')
    : '<p style="font-size:13px;color:var(--muted)">All answers correct!</p>';
  document.getElementById('mr-question-review').innerHTML = reviewHtml;
}

async function _generateMockDebrief(overall) {
  try {
    const ctx = buildContextSnippet();
    const rBand = fullMockResults.reading?.band;
    const lBand = fullMockResults.listening?.band;
    const wBand = fullMockResults.writing?.band;
    const sBand = fullMockResults.speaking?.band;
    const debriefPrompt = {
      system: 'You are Toody, an honest IELTS coach. Return valid JSON only.',
      user: `${ctx}
This student just completed a full IELTS mock test.
Results: Reading ${rBand||'—'}, Listening ${lBand||'—'}, Writing ${wBand||'—'}, Speaking ${sBand||'—'}, Overall: ${overall}
Writing feedback: ${fullMockResults.writing?.task2Feedback || ''}
Speaking feedback: ${fullMockResults.speaking?.feedback || ''}
Generate an honest 3-5 sentence assessment. Return ONLY: {"debrief":"3-5 sentence honest assessment referencing specific results and patterns from their practice history","focusArea":"the single most impactful thing to work on before the real exam"}`,
      maxTokens: 400
    };
    const raw = await callAI(debriefPrompt);
    const result = parseAIJson(raw);
    document.getElementById('mr-debrief-loading').classList.add('hidden');
    document.getElementById('mr-debrief').textContent = result.debrief || '';
    document.getElementById('mr-debrief').classList.remove('hidden');
    if (result.focusArea) {
      document.getElementById('mr-debrief').innerHTML +=
        `<div class="mock-focus-pill">Before your real exam: ${result.focusArea}</div>`;
    }
  } catch {
    document.getElementById('mr-debrief-loading').classList.add('hidden');
    document.getElementById('mr-debrief').textContent = 'Assessment unavailable — check your connection.';
    document.getElementById('mr-debrief').classList.remove('hidden');
  }
}

window.goToMockHistory = async function () {
  goTo('s-fullmock-history');
  document.getElementById('mock-history-loading').classList.remove('hidden');
  document.getElementById('mock-history-list').innerHTML = '';
  document.getElementById('mock-history-trend').classList.add('hidden');

  const mocks = studentData?.mockHistory || [];
  document.getElementById('mock-history-loading').classList.add('hidden');

  if (!mocks.length) {
    document.getElementById('mock-history-list').innerHTML =
      '<p style="font-size:13px;color:var(--muted);text-align:center;padding:40px 0">No mock tests taken yet.</p>';
    return;
  }

  // Simple text-based trend chart
  const trendEl = document.getElementById('mock-history-trend');
  trendEl.classList.remove('hidden');
  const maxBand = 9, minBand = 4;
  const chartHtml = mocks.slice(-8).map((m, i) => {
    const pct = Math.round(((m.overall - minBand) / (maxBand - minBand)) * 100);
    return `<div class="mht-bar-wrap" title="Mock ${i+1}: Band ${m.overall}">
      <div class="mht-bar" style="height:${pct}%"></div>
      <div class="mht-label">${m.overall.toFixed(1)}</div>
    </div>`;
  }).join('');
  trendEl.innerHTML = `<div class="mock-history-trend-label">Band Score Trend</div><div class="mht-bars">${chartHtml}</div>`;

  document.getElementById('mock-history-list').innerHTML = [...mocks].reverse().map((m, i) => {
    const d = m.date ? new Date(m.date).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' }) : '—';
    return `<div class="mock-history-item">
      <div class="mhi-date">${d}</div>
      <div class="mhi-scores">
        ${[['Reading',m.reading],['Listening',m.listening],['Writing',m.writing],['Speaking',m.speaking]].filter(([,v])=>v!=null).map(([l,v])=>`<span class="mhi-score">${l}: ${v.toFixed(1)}</span>`).join('')}
      </div>
      <div class="mhi-overall">Band ${m.overall.toFixed(1)}</div>
    </div>`;
  }).join('');
};


window.goToHome = function () { renderHome(); goTo('s-home'); };

window.signOutUser = async function () {
  try {
    await signOut(auth);
    window.location.href = 'index.html';
  } catch {
    window.location.href = 'index.html';
  }
};
