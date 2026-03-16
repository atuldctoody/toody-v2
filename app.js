import { auth, db } from './firebase-config.js';
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

const DAY_PLAN = {
  1:  { skill: 'reading.tfng',             screen: 's-reading',   section: 'Reading',   label: 'True / False / Not Given',   icon: '📖', desc: 'AI-generated passage + 5 questions. Toody explains every answer.' },
  2:  { skill: 'listening.multipleChoice', screen: 's-listening', section: 'Listening', label: 'Multiple Choice',             icon: '🎧', desc: 'Practice picking the correct answer from detailed audio scenarios.' },
  3:  { skill: 'reading.matchingHeadings', screen: 's-reading',   section: 'Reading',   label: 'Matching Headings',           icon: '📖', desc: 'Match paragraph headings to the right sections in the passage.' },
  4:  { skill: 'listening.formCompletion', screen: 's-listening', section: 'Listening', label: 'Form Completion',             icon: '🎧', desc: 'Complete a form or notes from information in the audio.' },
  5:  { skill: 'week1report',              screen: 's-notebook',  section: 'Report',    label: 'Week 1 Report',               icon: '📊', desc: 'Your band estimate, skill bars, and personalised Week 2 plan.' },
  6:  { skill: 'writing.task1',            screen: 's-writing',   section: 'Writing',   label: 'Task 1 — Graph Description',  icon: '✍️', desc: 'Describe an academic graph or chart in 150+ words.' },
  7:  { skill: 'writing.task2',            screen: 's-writing',   section: 'Writing',   label: 'Task 2 — Opinion Essay',      icon: '✍️', desc: 'Write a 250-word academic opinion essay on a given topic.' },
  8:  { skill: 'speaking.part1',           screen: 's-speaking',  section: 'Speaking',  label: 'Part 1 — Personal Questions', icon: '🎤', desc: 'Answer personal questions. Your audio is transcribed and evaluated.' },
  9:  { skill: 'drill',                    screen: null,          section: 'Drill',     label: 'Focused Drill',               icon: '🎯', desc: 'Deep drill on your single weakest area from Week 1.' },
  10: { skill: 'minimock',                 screen: null,          section: 'Mock',      label: 'Mini Mock',                   icon: '🏁', desc: 'Timed session across all 4 sections. Full report card after.' },
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

// Onboarding
let obStep            = 0;
let pendingBand       = 6.5;
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
let microAttempts     = 0;     // How many times student tried the micro test
let teachDrillIndex   = 0;     // Current drill question index
let teachDrillCorrect = 0;     // Correct answers in quick drill

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

// ── ROUTING ──────────────────────────────────────────────────────
function goTo(id) {
  console.log('[Toody] goTo:', id);
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (!el) { console.error('[Toody] goTo: element not found:', id); return; }
  el.classList.add('active');
  const computed = window.getComputedStyle(el).display;
  console.log('[Toody] after active — computedDisplay:', computed, '| classes:', el.className);
  // If CSS override is preventing flex, force it directly
  if (computed === 'none') {
    console.warn('[Toody] CSS override detected — forcing display:flex');
    el.style.display = 'flex';
  }
  window.scrollTo(0, 0);
}

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
  } catch (err) {
    console.error('bootApp error:', err);
    showBootError();
  }
};

function showBootError() {
  const el = document.getElementById('s-loading');
  if (el) {
    el.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;gap:16px;padding:40px 24px;text-align:center">
        <div style="font-size:40px">⚠️</div>
        <p style="font-size:15px;font-weight:600;color:#1a1a2e">Could not connect to Toody.</p>
        <p style="font-size:13px;color:#666;line-height:1.6">Check your internet connection and try again.</p>
        <button onclick="bootApp()" style="background:#6557D4;color:#fff;border:none;border-radius:12px;padding:14px 28px;font-size:15px;font-weight:700;cursor:pointer">Retry</button>
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
    skills: {
      reading: {
        tfng:             { ...blank },
        matchingHeadings: { ...blank },
        summaryCompletion:{ ...blank },
      },
      listening: {
        multipleChoice: { ...blank },
        formCompletion: { ...blank },
        mapDiagram:     { ...blank },
      },
      writing: {
        task1: { bandEstimate: 0, attempted: 0, lastPracticed: null, trend: 'new' },
        task2: { bandEstimate: 0, attempted: 0, lastPracticed: null, trend: 'new' },
      },
      speaking: {
        part1: { bandEstimate: 0, attempted: 0, lastPracticed: null, trend: 'new' },
        part2: { bandEstimate: 0, attempted: 0, lastPracticed: null, trend: 'new' },
        part3: { bandEstimate: 0, attempted: 0, lastPracticed: null, trend: 'new' },
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
    skills: {
      reading:   { tfng: { ...blank }, matchingHeadings: { ...blank }, summaryCompletion: { ...blank } },
      listening: { multipleChoice: { ...blank }, formCompletion: { ...blank }, mapDiagram: { ...blank } },
      writing:   { task1: { bandEstimate: 0, attempted: 0, lastPracticed: null, trend: 'new' }, task2: { bandEstimate: 0, attempted: 0, lastPracticed: null, trend: 'new' } },
      speaking:  { part1: { bandEstimate: 0, attempted: 0, lastPracticed: null, trend: 'new' }, part2: { bandEstimate: 0, attempted: 0, lastPracticed: null, trend: 'new' }, part3: { bandEstimate: 0, attempted: 0, lastPracticed: null, trend: 'new' } },
    }
  });
}

async function updateStudentDoc(uid, updates) {
  await updateDoc(doc(db, 'students', uid), updates);
}

async function saveSessionDoc(uid, data) {
  await addDoc(collection(db, 'students', uid, 'sessions'), {
    ...data,
    date: serverTimestamp()
  });
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
    // Show welcome screen
    const welcomeName = document.getElementById('welcome-name');
    if (welcomeName) welcomeName.textContent = pendingName || 'there';
    goTo('s-welcome');
    setTimeout(() => goTo('s-home'), 2500);
  } catch (err) {
    console.error('finishOnboarding error', err);
    document.getElementById('ob-saving').classList.add('hidden');
    document.getElementById('ob-error').classList.remove('hidden');
    document.getElementById('ob-finish-btn').disabled = false;
  }
};

// ── HOME ─────────────────────────────────────────────────────────
function renderHome() {
  if (!studentData) return;
  const day    = studentData.dayNumber || 1;
  const plan   = DAY_PLAN[Math.min(day, 10)] || DAY_PLAN[1];
  const name   = studentData.preferredName || studentData.name?.split(' ')[0] || 'there';
  const streak = studentData.streak || 0;

  const hour  = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  document.getElementById('home-greeting').innerHTML = `${greet}, <span style="color:var(--accent)">${name}</span>.`;
  document.getElementById('home-subtitle').textContent = day === 1
    ? "Let's find out where you're starting from."
    : day > 10
    ? "You've completed the 10-day programme. Incredible work."
    : `Day ${day} of 10. Keep the streak alive.`;

  document.getElementById('home-streak').textContent  = `🔥 ${streak} day${streak !== 1 ? 's' : ''}`;
  document.getElementById('home-day-badge').textContent = `Day ${Math.min(day, 10)}`;

  if (day <= 10) {
    document.getElementById('today-day-label').textContent = `Day ${day} of 10`;
    document.getElementById('today-skill').textContent     = `${plan.section} — ${plan.label}`;
    document.getElementById('today-desc').textContent      = plan.desc;
    document.getElementById('today-session-card').style.display = '';
  } else {
    document.getElementById('today-session-card').style.display = 'none';
  }

  const upcomingEl   = document.getElementById('upcoming-list');
  const upcomingDays = [day + 1, day + 2, day + 3].filter(d => d >= 1 && d <= 10);
  upcomingEl.innerHTML = upcomingDays.length
    ? upcomingDays.map(d => {
        const p = DAY_PLAN[d];
        return `
          <div class="upcoming-item">
            <div class="upcoming-day">D${d}</div>
            <div class="upcoming-info">
              <div class="upcoming-skill">${p.section} — ${p.label}</div>
              <div class="upcoming-desc">${p.desc}</div>
            </div>
          </div>`;
      }).join('')
    : '<p style="font-size:13px;color:var(--muted);padding:8px 0">Programme complete.</p>';

  renderSkillSnapshot();
}

function renderSkillSnapshot() {
  if (!studentData?.skills) return;
  const s = studentData.skills;
  const rows = [
    { label: 'T / F / Not Given', pct: s.reading?.tfng?.attempted             > 0 ? s.reading.tfng.accuracy             : null },
    { label: 'Matching Headings', pct: s.reading?.matchingHeadings?.attempted  > 0 ? s.reading.matchingHeadings.accuracy  : null },
    { label: 'Multiple Choice',   pct: s.listening?.multipleChoice?.attempted  > 0 ? s.listening.multipleChoice.accuracy  : null },
    { label: 'Form Completion',   pct: s.listening?.formCompletion?.attempted  > 0 ? s.listening.formCompletion.accuracy   : null },
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
        <span style="font-size:13px;font-weight:500;flex:1">${r.label}</span>
        ${pct === null
          ? '<span style="font-size:11px;color:var(--muted2)">Not tested</span>'
          : `<div style="flex:1;height:5px;background:var(--border);border-radius:4px;overflow:hidden;">
               <div style="width:${pct}%;height:100%;border-radius:4px;background:${pct>=80?'var(--success)':pct>=50?'var(--yellow)':'var(--danger)'};transition:width 0.6s ease;"></div>
             </div>
             <span style="font-size:11px;font-weight:700;color:var(--muted);width:32px;text-align:right">${pct}%</span>`}
      </div>`;
  }).join('');
}

// ── SESSION INTRO ─────────────────────────────────────────────────
window.startSession = function () {
  const day  = studentData?.dayNumber || 1;
  const plan = DAY_PLAN[Math.min(day, 10)] || DAY_PLAN[1];

  document.getElementById('si-icon').textContent    = plan.icon;
  document.getElementById('si-section').textContent = plan.section;
  document.getElementById('si-skill').textContent   = plan.label;

  const expects = buildExpectations(day, plan.skill);
  document.getElementById('si-expect-list').innerHTML = expects
    .map(e => `<div class="expect-item"><div class="expect-icon">${e.icon}</div><div class="expect-text">${e.text}</div></div>`)
    .join('');

  goTo('s-session-intro');
};

function buildExpectations(day, skill) {
  const list = [];
  if (day > 1) list.push({ icon: '🧠', text: 'Quick memory check first — one question from last session rephrased.' });
  list.push({ icon: '📝', text: 'AI-generated material specific to your current band level — different every session.' });
  list.push({ icon: '💬', text: 'Instant feedback after every answer with the exact reasoning.' });
  if (day > 1) list.push({ icon: '🔍', text: 'Get one right and Toody will ask you to prove your reasoning — the Tough Love Check.' });
  return list;
}

window.goToSession = function () {
  console.log('[Toody] button clicked');
  const day  = studentData?.dayNumber || 1;
  const plan = DAY_PLAN[Math.min(day, 10)];
  console.log('[Toody] day:', day, '| plan:', plan, '| studentData:', studentData);

  if (!plan) {
    console.error('[Toody] goToSession: no plan found for day', day);
    return;
  }

  document.getElementById('warmup-day-badge').textContent    = `Day ${day}`;
  document.getElementById('reading-day-badge').textContent   = `Day ${day}`;
  document.getElementById('listening-day-badge').textContent = `Day ${day}`;
  document.getElementById('writing-day-badge').textContent   = `Day ${day}`;
  document.getElementById('speaking-day-badge').textContent  = `Day ${day}`;
  document.getElementById('nb-day-badge').textContent        = `Day ${day}`;

  // Teach-first fires the FIRST TIME a student encounters any reading or listening skill
  const isFirstTimeSkill = (() => {
    const [section, subSkill] = (plan.skill || '').split('.');
    if (!section || !subSkill) return false;
    const attempted = studentData?.skills?.[section]?.[subSkill]?.attempted || 0;
    return attempted === 0;
  })();

  if (plan.screen === 's-reading' && isFirstTimeSkill) {
    loadTeachFirst(plan.skill);
  // Warmup fires on Day 2+ reading sessions that are NOT first-time
  } else if (day > 1 && plan.screen === 's-reading') {
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

  const prevDay  = studentData.dayNumber - 1;
  const prevPlan = DAY_PLAN[prevDay];
  const band     = studentData.targetBand || 6.5;

  const prompt = {
    system: 'You are an IELTS Academic examiner creating retrieval-practice questions. Return valid JSON only, no markdown, no extra text.',
    user: `Create one True/False/Not Given memory-check question for a Band ${band} IELTS student to revisit ${prevPlan?.label || 'reading'} skills.
Return ONLY this JSON:
{"passage": "2 sentences of academic text", "statement": "one claim about the passage", "answer": "True|False|NG", "explanation": "one sentence explaining the answer"}`
  };

  try {
    const raw  = await callAI(prompt);
    warmupQ = JSON.parse(raw);
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
  warmupCorrect = val === warmupQ.answer;
  const rf = document.getElementById('warmup-result');
  rf.classList.add('show', warmupCorrect ? 'good' : 'bad');
  rf.textContent = warmupCorrect
    ? `✅ Correct. ${warmupQ.explanation}`
    : `❌ The answer is ${warmupQ.answer}. ${warmupQ.explanation}`;
  document.getElementById('warmup-continue-btn').classList.remove('hidden');
};

window.continueFromWarmup = function () {
  const plan = DAY_PLAN[Math.min(studentData.dayNumber, 10)];
  launchSkillScreen(plan);
};

function launchSkillScreen(plan) {
  const day = studentData?.dayNumber || 1;
  if      (plan.screen === 's-reading')   loadReadingSession();
  else if (plan.screen === 's-listening') loadListeningSession();
  else if (plan.screen === 's-writing')   loadWritingSession();
  else if (plan.screen === 's-speaking')  loadSpeakingSession();
  else if (plan.screen === 's-notebook')  { renderWeek1Report(); goTo('s-notebook'); }
  else if (day === 9)                     loadFocusedDrill();
  else if (day === 10)                    { setupMiniMock(); goTo('s-minimock'); }
  else loadReadingSession();
}

// ── TEACH FIRST (first encounter of a skill) ─────────────────────
async function loadTeachFirst(skillKey) {
  teachData         = null;
  teachStep         = 0;
  microAttempts     = 0;
  teachDrillIndex   = 0;
  teachDrillCorrect = 0;
  teachSkillKey     = skillKey || 'reading.tfng';

  document.getElementById('teach-loading').classList.remove('hidden');
  document.getElementById('teach-concept').classList.add('hidden');
  document.getElementById('teach-worked').classList.add('hidden');
  document.getElementById('teach-micro').classList.add('hidden');
  goTo('s-teach');

  const band = studentData?.targetBand || 6.5;
  const isMH = skillKey === 'reading.matchingHeadings';
  const skillLabel = isMH ? 'Matching Headings' : 'True/False/Not Given';

  // Update the concept section header text
  const conceptBubble = document.querySelector('#teach-concept .toody-bubble');
  if (conceptBubble) {
    conceptBubble.innerHTML = isMH
      ? `Before we start, let me show you <strong>exactly</strong> how Matching Headings works — and the trap most students fall into.`
      : `Before we start, let me show you <strong>exactly</strong> how True / False / Not Given works — and the mistake most students make.`;
  }
  const strategyLabel = document.querySelector('#teach-concept .card-label');
  if (strategyLabel) strategyLabel.textContent = 'The Strategy';

  const conceptPromptDetail = isMH
    ? `Paragraph 1: explain what Matching Headings tests (identifying the main idea of a paragraph, not details). Paragraph 2: the #1 mistake students make (choosing a heading based on a word that appears in the paragraph rather than the main idea) and how to avoid it.`
    : `Paragraph 1: define True, False, Not Given in plain language. Paragraph 2: the #1 mistake students make (confusing 'False' with 'Not Given') and how to avoid it.`;

  const microTestPrompt = isMH
    ? `"passage": "one paragraph of 3-4 academic sentences", "statement": "Does the heading '[a heading]' describe the main idea of this paragraph? Answer True if it matches, False if it contradicts or is clearly wrong.", "answer": "True|False", "explanation": "one sentence saying why"`
    : `"passage": "2 academic sentences on a completely different topic", "statement": "a testable claim", "answer": "True|False|NG", "explanation": "one sentence explaining the answer"`;

  const prompt = {
    system: 'You are an expert IELTS Academic teacher. Return valid JSON only, no markdown, no preamble.',
    user: `Generate a teach-first lesson on ${skillLabel} reading for a Band ${band} IELTS student.

Return ONLY this JSON:
{
  "concept": "2 short paragraphs. ${conceptPromptDetail}",
  "workedExample": {
    "passage": "2 academic sentences on any interesting topic",
    "statement": "${isMH ? 'a heading that either does or does not capture the main idea of the passage' : 'a clear testable claim about the passage'}",
    "answer": "${isMH ? 'True|False' : 'True|False|NG'}",
    "relevantPhrase": "exact phrase from the passage that is key to answering",
    "statementClaim": "one sentence: what exactly the statement is claiming",
    "steps": [
      "Step 1: explanation of which part of the passage is relevant and why",
      "Step 2: explanation of what the statement is claiming",
      "Step 3: explanation of whether the passage confirms, contradicts, or stays silent"
    ],
    "conclusion": "Therefore the answer is [answer] — one sentence saying why."
  },
  "microTest": {
    ${microTestPrompt}
  },
  "microTest2": {
    ${microTestPrompt.replace(/completely different topic/g, 'third completely different topic')}
  },
  "drillQuestions": [
    {"passage": "2 academic sentences", "statement": "a testable claim", "answer": "${isMH ? 'True|False' : 'True|False|NG'}", "explanation": "one sentence"},
    {"passage": "2 academic sentences on a different topic", "statement": "another testable claim", "answer": "${isMH ? 'True|False' : 'True|False|NG'}", "explanation": "one sentence"}
  ]
}`,
    maxTokens: 2000
  };

  try {
    const raw  = await callAI(prompt);
    teachData  = JSON.parse(raw);

    document.getElementById('teach-concept-body').innerHTML = teachData.concept
      .split('\n')
      .filter(p => p.trim())
      .map(p => `<p style="margin-bottom:12px">${p}</p>`)
      .join('');

    document.getElementById('teach-loading').classList.add('hidden');
    document.getElementById('teach-concept').classList.remove('hidden');
  } catch {
    // If teaching fails, skip straight to the reading session
    loadReadingSession();
  }
}

window.teachShowWorked = function () {
  document.getElementById('teach-concept').classList.add('hidden');

  const we = teachData.workedExample;
  document.getElementById('teach-we-passage').innerHTML = we.passage
    .split('\n').filter(p => p.trim()).map(p => `<p>${p}</p>`).join('');
  document.getElementById('teach-we-statement').textContent = we.statement;

  teachStep = 0;

  // Step 3 answer → which choice button to highlight
  const answerToChoice = { true: 'confirms', false: 'contradicts', ng: 'silent' };
  const correctChoice  = answerToChoice[(we.answer || 'ng').toLowerCase()] || 'silent';

  const html = `
    <div class="predict-block" id="predict-0">
      <div class="predict-prompt">What part of the passage is relevant here?</div>
      <button class="btn-secondary mt8" onclick="window.teachRevealStep(0)">Show me the thinking <span class="arrow">→</span></button>
      <div class="predict-reveal hidden" id="predict-reveal-0">
        <div class="card" style="margin-top:12px">
          <div class="card-label" style="color:var(--accent)">Step 1</div>
          <p style="font-size:14px;line-height:1.7;color:var(--text)">${we.steps[0]}</p>
        </div>
      </div>
    </div>

    <div class="predict-block hidden" id="predict-1">
      <div class="predict-prompt">What is this statement actually claiming?</div>
      <button class="btn-secondary mt8" onclick="window.teachRevealStep(1)">Reveal <span class="arrow">→</span></button>
      <div class="predict-reveal hidden" id="predict-reveal-1">
        <div class="card" style="margin-top:12px">
          <div class="card-label" style="color:var(--accent)">Step 2</div>
          <p style="font-size:14px;line-height:1.7;color:var(--text)">${we.steps[1]}</p>
        </div>
      </div>
    </div>

    <div class="predict-block hidden" id="predict-2">
      <div class="predict-prompt">Does the passage confirm, contradict, or stay silent on this?</div>
      <div class="step3-choices mt8">
        <button class="step3-btn" data-choice="confirms" onclick="window.teachPickStep3('confirms','${correctChoice}')">✓ Confirms it</button>
        <button class="step3-btn" data-choice="contradicts" onclick="window.teachPickStep3('contradicts','${correctChoice}')">✗ Contradicts it</button>
        <button class="step3-btn" data-choice="silent" onclick="window.teachPickStep3('silent','${correctChoice}')">? Stays silent</button>
      </div>
      <div class="predict-reveal hidden" id="predict-reveal-2">
        <div class="card" style="margin-top:12px">
          <div class="card-label" style="color:var(--accent)">Step 3</div>
          <p style="font-size:14px;line-height:1.7;color:var(--text)">${we.steps[2]}</p>
        </div>
        <div class="card" style="margin-top:8px;border:2px solid var(--success)">
          <div class="card-label" style="color:var(--success)">✅ Answer</div>
          <p style="font-size:14px;line-height:1.6;font-weight:600;color:var(--text)">${we.conclusion}</p>
        </div>
      </div>
    </div>`;

  document.getElementById('teach-steps-container').innerHTML = html;
  document.getElementById('teach-try-btn').classList.add('hidden');
  document.getElementById('teach-worked').classList.remove('hidden');
};

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
  // Lock all buttons, highlight correct/wrong
  document.querySelectorAll('.step3-btn').forEach(b => {
    b.disabled = true;
    if (b.dataset.choice === correct)  b.classList.add('step3-correct');
    if (b.dataset.choice === choice && choice !== correct) b.classList.add('step3-wrong');
  });
  // Reveal explanation + conclusion
  document.getElementById('predict-reveal-2').classList.remove('hidden');
  // Show "Lock it in" button
  document.getElementById('teach-try-btn').classList.remove('hidden');
  window.scrollTo(0, document.body.scrollHeight);
};

window.teachShowReinforce = function () {
  document.getElementById('teach-worked').classList.add('hidden');
  document.getElementById('teach-reinforce-content').classList.add('hidden');
  document.getElementById('teach-continue-micro-btn').classList.add('hidden');
  document.getElementById('teach-reinforce').classList.remove('hidden');
};

window.teachReinforceHear = function () {
  saveLearningStyleSignal('hear');
  const we = teachData.workedExample;
  const text = `Here is the reasoning for the worked example. ${we.steps.join(' ')} ${we.conclusion}`;
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
  const qs = teachData.drillQuestions || [];
  if (idx >= qs.length) {
    // Drill complete
    const contentEl = document.getElementById('teach-reinforce-content');
    contentEl.innerHTML = `<div class="card mt8" style="background:var(--success-light);border:1.5px solid var(--success-mid)"><p style="font-size:14px;font-weight:600;color:#1a6048;text-align:center">${teachDrillCorrect} / ${qs.length} correct. Nice work.</p></div>`;
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
  const q = teachData.drillQuestions[idx];
  const isRight = val.toLowerCase() === (q.answer || '').toLowerCase();
  if (isRight) teachDrillCorrect++;

  document.querySelectorAll(`#drill-card-${idx} .tfng-btn`).forEach(b => {
    b.disabled = true;
    if      (b.dataset.dv.toLowerCase() === (q.answer || '').toLowerCase()) b.classList.add('correct');
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

window.teachShowMicro = function () {
  document.getElementById('teach-reinforce').classList.add('hidden');

  const micro = teachData.microTest;
  loadMicroQuestion(micro);
  document.getElementById('teach-micro').classList.remove('hidden');
};

function loadMicroQuestion(micro) {
  document.getElementById('teach-micro-passage').innerHTML = micro.passage
    .split('\n').filter(p => p.trim()).map(p => `<p>${p}</p>`).join('');
  document.getElementById('teach-micro-statement').textContent = micro.statement;
  document.getElementById('teach-micro-result').className = 'result-flash';
  document.getElementById('teach-micro-result').innerHTML = '';
  document.getElementById('teach-celebrate').classList.add('hidden');
  const btnsEl = document.getElementById('teach-micro-btns');
  btnsEl.innerHTML = `
    <button class="tfng-btn" onclick="window.answerMicro('True')"  data-mv="True">\u2713 True</button>
    <button class="tfng-btn" onclick="window.answerMicro('False')" data-mv="False">\u2717 False</button>
    <button class="tfng-btn" onclick="window.answerMicro('NG')"    data-mv="NG">? Not Given</button>`;
}

window.answerMicro = function (val) {
  const micro = microAttempts === 0 ? teachData?.microTest : teachData?.microTest2;
  if (!micro) return;

  document.querySelectorAll('#teach-micro-btns .tfng-btn').forEach(b => {
    b.disabled = true;
    const bv = b.getAttribute('data-mv');
    if      (bv.toLowerCase() === (micro.answer || '').toLowerCase()) b.classList.add('correct');
    else if (bv === val && bv.toLowerCase() !== (micro.answer || '').toLowerCase()) b.classList.add('wrong');
  });

  const isRight = val.toLowerCase() === (micro.answer || '').toLowerCase();
  const rf = document.getElementById('teach-micro-result');
  microAttempts++;

  if (isRight) {
    rf.classList.add('show', 'good');
    rf.innerHTML = `\u2705 Correct! ${micro.explanation}`;
    // Brief celebration then auto-advance
    setTimeout(() => {
      rf.classList.remove('show');
      document.getElementById('teach-celebrate').classList.remove('hidden');
      setTimeout(() => window.startRealSession(), 2000);
    }, 600);
    return;
  }

  // Wrong answer handling
  rf.classList.add('show', 'bad');

  if (microAttempts === 1 && teachData?.microTest2) {
    // First failure — give them a second different question
    rf.innerHTML = `\u274c The answer is <strong>${micro.answer}</strong>. ${micro.explanation} Let\u2019s try one more.`;
    const bubble = document.getElementById('teach-micro-bubble');
    if (bubble) bubble.textContent = 'One more — slightly different. Same strategy.';
    setTimeout(() => {
      rf.className = 'result-flash';
      loadMicroQuestion(teachData.microTest2);
    }, 2200);
  } else {
    // Second failure — move forward anyway
    rf.innerHTML = `\u274c The answer is <strong>${micro.answer}</strong>. ${micro.explanation}`;
    const bubble = document.getElementById('teach-micro-bubble');
    if (bubble) bubble.textContent = "Let\u2019s learn through doing \u2014 I\u2019ll explain as we go.";
    setTimeout(() => window.startRealSession(), 2500);
  }
};

window.startRealSession = function () {
  const day = studentData?.dayNumber || 1;
  const plan = DAY_PLAN[Math.min(day, 10)] || DAY_PLAN[1];
  const label = plan.label || 'Reading';
  document.getElementById('phase2-skill-name').textContent = label;
  goTo('s-phase2');
  setTimeout(() => loadReadingSession(), 1500);
};

// ── BEHAVIOUR TRACKING ───────────────────────────────────────────
let bhvSessionStart  = 0;
let bhvQStart        = {};   // { qnum: timestamp when question became active }
let bhvQDuration     = {};   // { qnum: ms taken before answering }
let bhvScrolledUp    = false;
let bhvScrollHandler = null;
let bhvAnswerChanges = 0;    // count of answer changes before submission
let bhvPrevFCValues  = {};   // { qnum: last recorded non-empty value } for FC inputs

function startSessionTracking() {
  bhvSessionStart  = Date.now();
  bhvQStart        = {};
  bhvQDuration     = {};
  bhvScrolledUp    = false;
  bhvAnswerChanges = 0;
  bhvPrevFCValues  = {};
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

async function updateStudentBrain(behaviour, accuracy, skillKey) {
  if (!currentUser) return;
  try {
    const prev  = studentData?.brain || {};
    const n     = (prev.totalSessions || 0) + 1;
    const alpha = 1 / Math.min(n, 10);   // EMA — stabilises after ~10 sessions
    const ema   = (prevVal, newVal) => Math.round(prevVal + (newVal - prevVal) * alpha);
    const changesThisSession = behaviour.answerChangesCount > 0 ? 100 : 0;

    // Per-skill breakdown stored under brain.skills[safeKey]
    const safeKey = skillKey ? skillKey.replace('.', '_') : null;
    const prevSkillBrain = safeKey ? (prev.skills?.[safeKey] || {}) : {};
    const skillBrainUpdate = safeKey ? {
      avgTimePerQ:    ema(prevSkillBrain.avgTimePerQ    || 0, behaviour.avgTimePerQuestionSec),
      scrollsBackPct: ema(prevSkillBrain.scrollsBackPct || 0, behaviour.scrolledBackToPassage ? 100 : 0),
      changesAnswers: ema(prevSkillBrain.changesAnswers  || 0, changesThisSession),
      lastAccuracy:   accuracy,
      sessions:       (prevSkillBrain.sessions || 0) + 1,
    } : null;

    const brain = {
      totalSessions:         n,
      avgSessionDurationSec: ema(prev.avgSessionDurationSec || 0, behaviour.sessionDurationSec),
      avgTimePerQuestionSec: ema(prev.avgTimePerQuestionSec || 0, behaviour.avgTimePerQuestionSec),
      scrollsBackPct:        ema(prev.scrollsBackPct || 0, behaviour.scrolledBackToPassage ? 100 : 0),
      changesAnswersPct:      ema(prev.changesAnswersPct || 0, changesThisSession),
      recentAccuracy:        accuracy,
      skills:                { ...(prev.skills || {}), ...(safeKey && skillBrainUpdate ? { [safeKey]: skillBrainUpdate } : {}) },
    };
    await updateStudentDoc(currentUser.uid, { brain });
    if (studentData) studentData.brain = brain;
  } catch { /* non-critical */ }
}

async function updateWeakAreas(skillKey, missedSubTypes) {
  if (!currentUser || !studentData) return;
  try {
    const skills = studentData.skills || {};
    const candidates = [
      { key: 'reading.tfng',             name: 'T/F/Not Given',          s: skills?.reading?.tfng },
      { key: 'reading.matchingHeadings', name: 'Matching Headings',      s: skills?.reading?.matchingHeadings },
      { key: 'listening.multipleChoice', name: 'Multiple Choice',        s: skills?.listening?.multipleChoice },
      { key: 'listening.formCompletion', name: 'Form Completion',        s: skills?.listening?.formCompletion },
    ].filter(c => c.s?.attempted > 0 && c.s.accuracy < 70)
     .sort((a, b) => a.s.accuracy - b.s.accuracy);

    const weakAreas = candidates.slice(0, 2).map(c => c.key);

    // Accumulate consistently missed sub-types (e.g. 'Not Given' within TF/NG)
    const updates = { weakAreas };
    if (skillKey && missedSubTypes && Object.keys(missedSubTypes).length > 0) {
      const safeKey = skillKey.replace('.', '_');
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
  console.log('[Toody] loadReadingSession() called');
  sessionQuestions = [];
  sessionPassage   = '';
  sessionAnswers   = {};
  sessionCorrect   = 0;
  sessionTopic     = '';
  tlQ = null; tlPassed = false;

  goTo('s-reading');
  document.getElementById('reading-loading').classList.remove('hidden');
  document.getElementById('reading-content').classList.add('hidden');
  document.getElementById('btn-reading-submit').disabled = true;

  const day = studentData?.dayNumber || 1;
  document.getElementById('reading-p1-dot').className = day > 1 ? 'phase-dot done' : 'phase-dot';

  const band = studentData?.targetBand || 6.5;

  const prompt = {
    system: 'You are an IELTS Academic examiner. Generate reading exercises at the exact band level specified. Return valid JSON only, no markdown, no preamble.',
    user: `Create a True/False/Not Given IELTS Academic reading exercise for a Band ${band} student.

Return ONLY this JSON:
{
  "passage": "3 paragraphs of academic prose on any interesting topic (170-220 words total)",
  "topic": "2-4 word topic label",
  "questions": [
    {"id": 1, "text": "statement", "answer": "True",  "explanation": "why", "keySentence": "exact sentence from passage"},
    {"id": 2, "text": "statement", "answer": "False", "explanation": "why", "keySentence": "exact sentence from passage"},
    {"id": 3, "text": "statement", "answer": "NG",    "explanation": "why", "keySentence": "exact sentence from passage"},
    {"id": 4, "text": "statement", "answer": "True",  "explanation": "why", "keySentence": "exact sentence from passage"},
    {"id": 5, "text": "statement", "answer": "False", "explanation": "why", "keySentence": "exact sentence from passage"}
  ]
}`
  };

  try {
    const raw    = await callAI(prompt);
    const parsed = JSON.parse(raw);

    sessionPassage   = parsed.passage;
    sessionQuestions = parsed.questions;
    sessionTopic     = parsed.topic || 'Reading';

    buildToughLove(parsed.questions, parsed.passage, day);
    renderReadingSession(parsed);

    document.getElementById('reading-loading').classList.add('hidden');
    document.getElementById('reading-content').classList.remove('hidden');

    startSessionTracking();
    setupScrollTracking();
    trackQStart(1);
  } catch {
    document.getElementById('reading-loading').innerHTML =
      '<p style="color:var(--danger);padding:20px;text-align:center">Could not load passage. Please go back and try again.</p>';
  }
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

  const isRight = val.toLowerCase() === (q.answer || '').toLowerCase();
  sessionAnswers[qnum] = { val, isRight };
  if (isRight) sessionCorrect++;

  document.querySelectorAll(`#tfng${qnum} .tfng-btn`).forEach(b => {
    b.disabled = true;
    if      (b.dataset.v.toLowerCase() === (q.answer || '').toLowerCase()) b.classList.add('correct');
    else if (b.dataset.v === val && !isRight)                               b.classList.add('wrong');
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
function buildToughLove(questions, passage, day) {
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
  const skillKey  = DAY_PLAN[day]?.skill || 'reading.tfng';
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

  const isTfng   = skillKey === 'reading.tfng';
  const skillPath = isTfng ? 'reading.tfng' : 'reading.matchingHeadings';
  const [section, subSkill] = skillPath.split('.');

  try {
    await saveSessionDoc(currentUser.uid, {
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

    const prev         = studentData.skills?.[section]?.[subSkill] || { accuracy: 0, attempted: 0 };
    const prevCorrect  = Math.round((prev.accuracy / 100) * prev.attempted);
    const newAttempted = prev.attempted + total;
    const newAccuracy  = newAttempted > 0
      ? Math.round(((prevCorrect + sessionCorrect) / newAttempted) * 100) : 0;
    const newStreak = (studentData.streak || 0) + 1;

    await updateStudentDoc(currentUser.uid, {
      [`skills.${section}.${subSkill}.accuracy`]:      newAccuracy,
      [`skills.${section}.${subSkill}.attempted`]:     newAttempted,
      [`skills.${section}.${subSkill}.lastPracticed`]: serverTimestamp(),
      [`skills.${section}.${subSkill}.trend`]:         newAccuracy > prev.accuracy ? 'up' : newAccuracy < prev.accuracy ? 'down' : 'stable',
      dayNumber:        day + 1,
      streak:           newStreak,
      lastSession:      serverTimestamp(),
      toughLoveResults: (studentData.toughLoveResults || 0) + (tlPassed ? 1 : 0),
    });

    const snap = await getStudentDoc(currentUser.uid);
    studentData = snap.data();
    await updateStudentBrain(behaviour, accuracy, skillKey);
    await updateWeakAreas(skillKey, missedSubTypes);
  } catch { /* Firestore save failed — still show notebook */ }

  if (mockMode) {
    mockResults.reading = { correct: sessionCorrect, total, accuracy };
    runMockPhase(1);
    return;
  }

  document.getElementById('nb-day-badge').textContent = `Day ${day}`;
  goTo('s-notebook');
  renderNotebook(sessionCorrect, total, 'reading.tfng');
}

// ── LISTENING SESSION ─────────────────────────────────────────────
async function loadListeningSession() {
  const day = studentData?.dayNumber || 2;
  listenType       = day === 4 ? 'fc' : 'mc';
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
    const parsed = JSON.parse(raw);
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
    document.getElementById('listening-loading').innerHTML =
      '<p style="color:var(--danger);padding:20px;text-align:center">Could not load listening scenario. Please go back and try again.</p>';
  }
}

// ── LISTENING AUDIO ────────────────────────────────────────────────
async function fetchListeningAudio(text) {
  try {
    const res = await fetch(AUDIO_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ text })
    });
    if (!res.ok) throw new Error('Audio fetch failed');
    const data = await res.json();
    if (!data.audio) throw new Error('No audio in response');

    const blob = base64ToBlob(data.audio, data.mimeType || 'audio/mpeg');
    const url  = URL.createObjectURL(blob);
    setupAudioPlayer(url);
  } catch {
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
      isRight = (userAns || '').toUpperCase() === (q.answer || '').toUpperCase();
    } else {
      const el = document.getElementById(`fc${q.id}`);
      userAns  = el ? el.value.trim() : '';
      isRight  = userAns.toLowerCase() === q.answer.toLowerCase();
      // Lock the input
      if (el) { el.disabled = true; el.classList.add(isRight ? 'fc-correct' : 'fc-wrong'); }
    }

    if (isRight) listenCorrect++;
    listenAnswers[q.id] = userAns;

    resultsHtml += `
      <div style="padding:10px 0;border-bottom:1px solid var(--border);">
        <div style="font-size:13px;font-weight:500;margin-bottom:4px">${q.id}. ${q.text || q.label}</div>
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
  const skillKey  = listenType === 'mc' ? 'multipleChoice' : 'formCompletion';
  const firestoreKey = `listening.${skillKey}`;
  const behaviour = getBehaviourPayload();

  try {
    await saveSessionDoc(currentUser.uid, {
      weekNumber:         studentData.weekNumber || 1,
      dayNumber:          day,
      skillPracticed:     DAY_PLAN[day]?.skill || firestoreKey,
      questionsAttempted: total,
      questionsCorrect:   listenCorrect,
      accuracy,
      warmupCorrect,
      durationMinutes:    Math.round(behaviour.sessionDurationSec / 60),
      behaviour
    });

    const prev         = studentData.skills?.listening?.[skillKey] || { accuracy: 0, attempted: 0 };
    const prevCorrect  = Math.round((prev.accuracy / 100) * prev.attempted);
    const newAttempted = prev.attempted + total;
    const newAccuracy  = newAttempted > 0
      ? Math.round(((prevCorrect + listenCorrect) / newAttempted) * 100) : 0;

    await updateStudentDoc(currentUser.uid, {
      [`skills.listening.${skillKey}.accuracy`]:      newAccuracy,
      [`skills.listening.${skillKey}.attempted`]:     newAttempted,
      [`skills.listening.${skillKey}.lastPracticed`]: serverTimestamp(),
      [`skills.listening.${skillKey}.trend`]:         newAccuracy > prev.accuracy ? 'up' : newAccuracy < prev.accuracy ? 'down' : 'stable',
      dayNumber:   day + 1,
      streak:      (studentData.streak || 0) + 1,
      lastSession: serverTimestamp(),
    });

    const snap = await getStudentDoc(currentUser.uid);
    studentData = snap.data();
    await updateStudentBrain(behaviour, accuracy, `listening.${skillKey}`);
    await updateWeakAreas(`listening.${skillKey}`, null);
  } catch { /* still show notebook */ }

  if (mockMode) {
    mockResults.listening = { correct: listenCorrect, total, accuracy };
    runMockPhase(2);
    return;
  }

  document.getElementById('nb-day-badge').textContent = `Day ${day}`;
  goTo('s-notebook');
  renderNotebook(listenCorrect, total, firestoreKey);
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

  const isTask1 = day === 6 || day === 10;
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
    writingTaskData = JSON.parse(raw);

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
    document.getElementById('writing-loading').innerHTML =
      '<p style="color:var(--danger);padding:20px;text-align:center">Could not load writing task. Please go back and try again.</p>';
  }
}

window.updateWordCount = function () {
  const text  = document.getElementById('writing-textarea').value.trim();
  const words = text ? text.split(/\s+/).length : 0;
  const day   = studentData?.dayNumber || 6;
  const min   = (day === 6 || day === 10) ? 150 : 250;
  const badge = document.getElementById('writing-word-count');
  badge.textContent = `${words} word${words !== 1 ? 's' : ''}`;
  badge.className   = `word-count-badge ${words >= min ? 'ok' : words >= min * 0.7 ? 'warn' : ''}`;
};

window.submitWriting = async function () {
  const text = document.getElementById('writing-textarea').value.trim();
  if (!text || text.split(/\s+/).length < 30) {
    alert('Please write at least a few sentences before submitting.');
    return;
  }
  writingResponse = text;

  document.getElementById('writing-prompt-view').classList.add('hidden');
  document.getElementById('writing-evaluating').classList.remove('hidden');

  const day    = studentData?.dayNumber || 6;
  const isTask1 = day === 6 || day === 10;
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
    const result = JSON.parse(raw);
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
    document.getElementById('writing-evaluating').innerHTML =
      '<p style="color:var(--danger);padding:20px;text-align:center">Evaluation failed. Please go back and try again.</p>';
  }
};

window.finishWritingSession = async function () {
  const day     = studentData?.dayNumber || 6;
  const isTask1 = day === 6 || day === 10;
  const taskKey = isTask1 ? 'task1' : 'task2';
  const behaviour = getBehaviourPayload();

  try {
    await saveSessionDoc(currentUser.uid, {
      weekNumber:     studentData.weekNumber || 2,
      dayNumber:      day,
      skillPracticed: DAY_PLAN[day]?.skill || `writing.${taskKey}`,
      bandEstimate:   writingBandEst,
      wordCount:      writingResponse.split(/\s+/).length,
      durationMinutes: Math.round(behaviour.sessionDurationSec / 60),
      behaviour
    });

    const prev = studentData.skills?.writing?.[taskKey] || { bandEstimate: 0, attempted: 0 };
    await updateStudentDoc(currentUser.uid, {
      [`skills.writing.${taskKey}.bandEstimate`]:   writingBandEst,
      [`skills.writing.${taskKey}.attempted`]:      (prev.attempted || 0) + 1,
      [`skills.writing.${taskKey}.lastPracticed`]:  serverTimestamp(),
      [`skills.writing.${taskKey}.trend`]:          writingBandEst > prev.bandEstimate ? 'up' : writingBandEst < prev.bandEstimate ? 'down' : 'stable',
      dayNumber:   day + 1,
      streak:      (studentData.streak || 0) + 1,
      lastSession: serverTimestamp(),
    });

    const snap = await getStudentDoc(currentUser.uid);
    studentData = snap.data();
    await updateWeakAreas(`writing.${taskKey}`, null);
  } catch { /* still show notebook */ }

  if (mockMode) {
    mockResults.writing = { band: writingBandEst };
    runMockPhase(3);
    return;
  }

  document.getElementById('nb-day-badge').textContent = `Day ${day}`;
  goTo('s-notebook');
  renderNotebookWriting();
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
    const parsed = JSON.parse(raw);
    speakingQs   = parsed.questions || [];

    document.getElementById('speaking-topic-label').textContent = parsed.topicLabel || partLabel;
    document.getElementById('speaking-questions').innerHTML = speakingQs.map((q, i) =>
      `<div class="speaking-q-item"><div class="speaking-q-num">${i + 1}</div><div>${q}</div></div>`
    ).join('');

    document.getElementById('speaking-loading').classList.add('hidden');
    document.getElementById('speaking-prompt-view').classList.remove('hidden');
    startSessionTracking();
  } catch {
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
    alert('Microphone access is required for the speaking section. Please allow microphone access and try again.');
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

    const res = await fetch(TRANSCRIBE_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ audio: base64, mimeType: blob.type || 'audio/webm' })
    });
    if (!res.ok) throw new Error('Transcription failed');
    const data = await res.json();
    speakingTranscript = data.text || '';

    document.getElementById('record-processing').classList.add('hidden');
    await evaluateSpeaking(speakingTranscript);
  } catch {
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
    const result = JSON.parse(raw);
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
    document.getElementById('speaking-evaluating').innerHTML =
      '<p style="color:var(--danger);padding:20px;text-align:center">Evaluation failed. Please go back and try again.</p>';
  }
}

window.finishSpeakingSession = async function () {
  const day       = studentData?.dayNumber || 8;
  const behaviour = getBehaviourPayload();
  // For speaking, override durationSec with actual recording time
  behaviour.sessionDurationSec = Math.max(behaviour.sessionDurationSec, recordSeconds);

  try {
    await saveSessionDoc(currentUser.uid, {
      weekNumber:     studentData.weekNumber || 2,
      dayNumber:      day,
      skillPracticed: DAY_PLAN[day]?.skill || 'speaking.part1',
      bandEstimate:   speakingBandEst,
      transcript:     speakingTranscript,
      durationMinutes: Math.round(behaviour.sessionDurationSec / 60),
      behaviour
    });

    const prev = studentData.skills?.speaking?.part1 || { bandEstimate: 0, attempted: 0 };
    await updateStudentDoc(currentUser.uid, {
      'skills.speaking.part1.bandEstimate':   speakingBandEst,
      'skills.speaking.part1.attempted':      (prev.attempted || 0) + 1,
      'skills.speaking.part1.lastPracticed':  serverTimestamp(),
      'skills.speaking.part1.trend':          speakingBandEst > prev.bandEstimate ? 'up' : speakingBandEst < prev.bandEstimate ? 'down' : 'stable',
      dayNumber:   day + 1,
      streak:      (studentData.streak || 0) + 1,
      lastSession: serverTimestamp(),
    });

    const snap = await getStudentDoc(currentUser.uid);
    studentData = snap.data();
    await updateWeakAreas('speaking.part1', null);
  } catch { /* still show notebook */ }

  if (mockMode) {
    mockResults.speaking = { band: speakingBandEst };
    showMockResults();
    return;
  }

  document.getElementById('nb-day-badge').textContent = `Day ${day}`;
  goTo('s-notebook');
  renderNotebookSpeaking();
};

// ── WEEK 1 REPORT ─────────────────────────────────────────────────
function renderWeek1Report() {
  const day = (studentData?.dayNumber || 6) - 1;

  // Hide standard skill section, show Week 1 section
  document.getElementById('nb-skill-section').classList.add('hidden');
  document.getElementById('nb-week1-section').classList.remove('hidden');

  const skills  = studentData?.skills;
  const tfng    = skills?.reading?.tfng?.attempted    > 0 ? skills.reading.tfng.accuracy            : null;
  const mh      = skills?.reading?.matchingHeadings?.attempted > 0 ? skills.reading.matchingHeadings.accuracy : null;
  const mc      = skills?.listening?.multipleChoice?.attempted > 0 ? skills.listening.multipleChoice.accuracy : null;
  const fc      = skills?.listening?.formCompletion?.attempted > 0 ? skills.listening.formCompletion.accuracy : null;

  const scores = [tfng, mh, mc, fc].filter(s => s !== null);
  const avgBand = scores.length > 0
    ? ((scores.reduce((a, b) => a + b, 0) / scores.length) / 100 * 3 + 4.5).toFixed(1)
    : (studentData?.targetBand || 6.0).toFixed(1);

  document.getElementById('w1-band').textContent      = avgBand;
  document.getElementById('w1-band-note').textContent = `Estimated from ${scores.length} skill${scores.length !== 1 ? 's' : ''} practised this week.`;

  // Top 2 weak areas
  const skillRows = [
    { name: 'T / F / Not Given',  pct: tfng, key: 'reading.tfng' },
    { name: 'Matching Headings',  pct: mh,   key: 'reading.matchingHeadings' },
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
          <span style="font-size:11px;font-weight:700;color:var(--danger);margin-left:6px">${r.pct}%</span>
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

  const nextDay = studentData?.dayNumber || 6;
  if (nextDay <= 10) {
    const next = DAY_PLAN[nextDay];
    document.getElementById('nb-tomorrow-day').textContent   = `Next — Day ${nextDay}`;
    document.getElementById('nb-tomorrow-title').textContent = `${next.section} — ${next.label}`;
    document.getElementById('nb-tomorrow-desc').textContent  = next.desc;
  }
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

  const skills  = studentData?.skills;
  const isTfng  = skillKey === 'reading.tfng';
  const isMH    = skillKey === 'reading.matchingHeadings';
  const isMC    = skillKey === 'listening.multipleChoice';
  const isFC    = skillKey === 'listening.formCompletion';

  // Current session bar
  const barClass = accuracy >= 80 ? 'strong' : accuracy >= 50 ? 'medium' : 'weak';
  if (isTfng) {
    document.getElementById('nb-tfng-bar').className   = `skill-bar ${barClass}`;
    document.getElementById('nb-tfng-bar').style.width = accuracy + '%';
    document.getElementById('nb-tfng-pct').textContent = accuracy + '%';
  }
  if (isMH) {
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
  if (!isTfng) setSkillBar('nb-tfng-bar', 'nb-tfng-pct', skills?.reading?.tfng?.attempted            > 0 ? skills.reading.tfng.accuracy             : null);
  if (!isMH)   setSkillBar('nb-mh-bar',   'nb-mh-pct',   skills?.reading?.matchingHeadings?.attempted > 0 ? skills.reading.matchingHeadings.accuracy  : null);
  if (!isMC)   setSkillBar('nb-mc-bar',   'nb-mc-pct',   skills?.listening?.multipleChoice?.attempted > 0 ? skills.listening.multipleChoice.accuracy   : null);
  if (!isFC)   setSkillBar('nb-fc-bar',   'nb-fc-pct',   skills?.listening?.formCompletion?.attempted > 0 ? skills.listening.formCompletion.accuracy    : null);

  const assessment = accuracy >= 80
    ? `${accuracy}% — strong session. You're building real exam instincts.`
    : accuracy >= 60
    ? `${accuracy}% today. Solid effort — Toody's tracking the pattern in your misses.`
    : `${accuracy}% — that's the baseline. Toody now knows exactly where to focus.`;
  document.getElementById('nb-assessment').textContent = assessment;

  // Worked example
  const questions = isTfng || isMH ? sessionQuestions : listenQuestions;
  const answers   = isTfng || isMH ? sessionAnswers   : listenAnswers;
  const wrongQ    = questions.find(q => {
    const a = answers[q.id];
    return typeof a === 'object' ? a.isRight === false : (a?.toLowerCase() !== q.answer?.toLowerCase());
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

  setSkillBar('nb-tfng-bar', 'nb-tfng-pct', studentData?.skills?.reading?.tfng?.attempted            > 0 ? studentData.skills.reading.tfng.accuracy            : null);
  setSkillBar('nb-mh-bar',   'nb-mh-pct',   studentData?.skills?.reading?.matchingHeadings?.attempted > 0 ? studentData.skills.reading.matchingHeadings.accuracy : null);
  setSkillBar('nb-mc-bar',   'nb-mc-pct',   studentData?.skills?.listening?.multipleChoice?.attempted > 0 ? studentData.skills.listening.multipleChoice.accuracy  : null);
  setSkillBar('nb-fc-bar',   'nb-fc-pct',   studentData?.skills?.listening?.formCompletion?.attempted > 0 ? studentData.skills.listening.formCompletion.accuracy   : null);

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

  setSkillBar('nb-tfng-bar', 'nb-tfng-pct', studentData?.skills?.reading?.tfng?.attempted            > 0 ? studentData.skills.reading.tfng.accuracy            : null);
  setSkillBar('nb-mh-bar',   'nb-mh-pct',   studentData?.skills?.reading?.matchingHeadings?.attempted > 0 ? studentData.skills.reading.matchingHeadings.accuracy : null);
  setSkillBar('nb-mc-bar',   'nb-mc-pct',   studentData?.skills?.listening?.multipleChoice?.attempted > 0 ? studentData.skills.listening.multipleChoice.accuracy  : null);
  setSkillBar('nb-fc-bar',   'nb-fc-pct',   studentData?.skills?.listening?.formCompletion?.attempted > 0 ? studentData.skills.listening.formCompletion.accuracy   : null);

  document.getElementById('nb-assessment').textContent =
    `Speaking Band Estimate: ${speakingBandEst.toFixed(1)}. ${speakingBandEst >= 7 ? 'Impressive — you sound like a Band 7+ speaker.' : speakingBandEst >= 6 ? 'Good fluency. Focus on the suggestion above for your next session.' : 'Early days — every session builds your spoken fluency.'}`;

  document.getElementById('nb-worked-example').classList.add('hidden');
  renderTomorrowCard();
}

function renderTomorrowCard() {
  const nextDay = studentData?.dayNumber;
  if (nextDay && nextDay <= 10) {
    const next = DAY_PLAN[nextDay];
    document.getElementById('nb-tomorrow-day').textContent   = `Tomorrow — Day ${nextDay}`;
    document.getElementById('nb-tomorrow-title').textContent = `${next.section} — ${next.label}`;
    document.getElementById('nb-tomorrow-desc').textContent  = next.desc;
  } else {
    document.getElementById('nb-tomorrow-day').textContent   = 'Programme complete 🎉';
    document.getElementById('nb-tomorrow-title').textContent = 'You\'ve finished all 10 sessions.';
    document.getElementById('nb-tomorrow-desc').textContent  = 'Check your progress to see your full band estimate and improvement.';
  }
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
  const skills  = studentData?.skills;
  const skillRows = [
    { name: 'T / F / Not Given',  pct: skills?.reading?.tfng?.attempted            > 0 ? skills.reading.tfng.accuracy            : null, loader: loadReadingSession   },
    { name: 'Matching Headings',  pct: skills?.reading?.matchingHeadings?.attempted > 0 ? skills.reading.matchingHeadings.accuracy : null, loader: loadReadingSession   },
    { name: 'Multiple Choice',    pct: skills?.listening?.multipleChoice?.attempted > 0 ? skills.listening.multipleChoice.accuracy : null, loader: loadListeningSession },
    { name: 'Form Completion',    pct: skills?.listening?.formCompletion?.attempted > 0 ? skills.listening.formCompletion.accuracy  : null, loader: loadListeningSession },
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
function setupMiniMock() {
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

  // Update mock progress indicators
  const labels = ['reading','listening','writing','speaking'];
  labels.forEach((l, i) => {
    const el = document.getElementById(`mock-step-${l}`);
    if (!el) return;
    if (i < phase)       { el.className = 'mock-step done'; }
    else if (i === phase){ el.className = 'mock-step active'; }
    else                 { el.className = 'mock-step'; }
  });

  if (phase === 0) loadReadingSession();
  else if (phase === 1) { listenType = 'mc'; loadListeningSession(); }
  else if (phase === 2) loadWritingSession();
  else if (phase === 3) loadSpeakingSession();
  else showMockResults();
}

function showMockResults() {
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

// ── PROGRESS SCREEN ───────────────────────────────────────────────
window.goToProgress = async function () {
  if (!studentData) return;

  document.getElementById('prog-sessions').textContent = '…';
  document.getElementById('prog-band').textContent     = studentData.targetBand || '—';
  document.getElementById('prog-streak').textContent   = studentData.streak     || 0;

  const skills = studentData.skills;
  setSkillBar('prog-tfng-bar', 'prog-tfng-pct', skills?.reading?.tfng?.attempted            > 0 ? skills.reading.tfng.accuracy            : null);
  setSkillBar('prog-mh-bar',   'prog-mh-pct',   skills?.reading?.matchingHeadings?.attempted > 0 ? skills.reading.matchingHeadings.accuracy : null);
  setSkillBar('prog-mc-bar',   'prog-mc-pct',   skills?.listening?.multipleChoice?.attempted > 0 ? skills.listening.multipleChoice.accuracy  : null);
  setSkillBar('prog-fc-bar',   'prog-fc-pct',   skills?.listening?.formCompletion?.attempted > 0 ? skills.listening.formCompletion.accuracy   : null);

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
      const skill = DAY_PLAN[s.dayNumber]?.label || s.skillPracticed || '—';
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
          <div style="font-size:14px;font-weight:700;color:var(--accent)">${score}</div>
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
  const skills  = studentData.skills      || {};
  const brain   = studentData.brain       || {};
  const weak    = studentData.weakAreas   || [];
  const purpose = studentData.purpose     || '';

  const allSkills = [
    { key: 'reading.tfng',             name: 'T/F/Not Given',     s: skills?.reading?.tfng              },
    { key: 'reading.matchingHeadings', name: 'Matching Headings', s: skills?.reading?.matchingHeadings  },
    { key: 'listening.multipleChoice', name: 'Multiple Choice',   s: skills?.listening?.multipleChoice  },
    { key: 'listening.formCompletion', name: 'Form Completion',   s: skills?.listening?.formCompletion  },
  ].filter(x => x.s?.attempted > 0);

  const strong = allSkills
    .filter(x => x.s.accuracy >= 75)
    .map(x => `${x.name} (${x.s.accuracy}%)`);

  const weakSkills = allSkills
    .filter(x => x.s.accuracy < 70)
    .map(x => {
      let str = `${x.name} (${x.s.accuracy}%)`;
      const topMissed = brain.topMissedSubType?.[x.key.replace('.', '_')];
      if (topMissed) str += ` — especially "${topMissed}" answer type`;
      return str;
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
  const focusSkill = weak[0] ? weak[0].replace('.', ' ') : 'the student\'s weakest area';
  const focusMissed = weak[0] ? (brain.topMissedSubType?.[weak[0].replace('.', '_')] || null) : null;

  const purposeNote = purpose === 'university'  ? 'Use academic/scientific passage topics (research, environment, technology, history).'
                    : purpose === 'migration'   ? 'Use general-interest topics relevant to daily life, society, health, culture.'
                    : purpose === 'work'        ? 'Use professional/workplace topics where relevant.'
                    : '';

  const lines = [
    `STUDENT: ${name} | Target: Band ${target} | Current estimate: Band ${current} | Week ${week} Day ${day}`,
    `STRONG: ${strong.length ? strong.join(', ') : 'No data yet — first session'}`,
    `WEAK: ${weakSkills.length ? weakSkills.join(', ') : 'No weak areas identified yet'}`,
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
  const snippet = buildContextSnippet();
  const systemContent = snippet
    ? `${snippet}\n\n---\n\n${prompt.system}`
    : prompt.system;

  const res = await fetch(API_URL, {
    method: 'POST',
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
}

// ── NAV ACTIONS ───────────────────────────────────────────────────
window.goToHome = function () { renderHome(); goTo('s-home'); };

window.signOutUser = async function () {
  try {
    await signOut(auth);
    window.location.href = 'index.html';
  } catch {
    window.location.href = 'index.html';
  }
};
