import { auth, db } from './firebase-config.js';
import { onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
  doc, getDoc, setDoc, updateDoc,
  addDoc, collection, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ── PWA ──────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// ── CONSTANTS ────────────────────────────────────────────────────
const API_URL = 'https://toody-api.vercel.app/api/generate';

const DAY_PLAN = {
  1:  { skill: 'reading.tfng',             screen: 's-reading',   section: 'Reading',   label: 'True / False / Not Given', icon: '📖', desc: 'AI-generated passage + 5 questions. Toody explains every answer.' },
  2:  { skill: 'listening.multipleChoice', screen: 's-listening', section: 'Listening', label: 'Multiple Choice',           icon: '🎧', desc: 'Practice picking the correct answer from detailed audio scenarios.' },
  3:  { skill: 'reading.matchingHeadings', screen: 's-reading',   section: 'Reading',   label: 'Matching Headings',         icon: '📖', desc: 'Match paragraph headings to the right sections in the passage.' },
  4:  { skill: 'listening.formCompletion', screen: 's-listening', section: 'Listening', label: 'Form Completion',           icon: '🎧', desc: 'Complete a form or notes from information in the audio.' },
  5:  { skill: 'week1report',              screen: 's-notebook',  section: 'Report',    label: 'Week 1 Report',             icon: '📊', desc: 'Your band estimate, skill bars, and personalised Week 2 plan.' },
  6:  { skill: 'writing.task1',            screen: 's-writing',   section: 'Writing',   label: 'Task 1 — Graph Description', icon: '✍️', desc: 'Describe an academic graph or chart in 150+ words.' },
  7:  { skill: 'writing.task2',            screen: 's-writing',   section: 'Writing',   label: 'Task 2 — Opinion Essay',    icon: '✍️', desc: 'Write a 250-word academic opinion essay on a given topic.' },
  8:  { skill: 'speaking.part1',           screen: 's-speaking',  section: 'Speaking',  label: 'Part 1 — Personal Questions', icon: '🎤', desc: 'Answer personal questions. Your audio is transcribed and evaluated.' },
  9:  { skill: 'drill',                    screen: null,          section: 'Drill',     label: 'Focused Drill',             icon: '🎯', desc: 'Deep drill on your single weakest area from Week 1.' },
  10: { skill: 'minimock',                 screen: null,          section: 'Mock',      label: 'Mini Mock',                 icon: '🏁', desc: 'Timed session across all 4 sections. Full report card after.' },
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
let obStep       = 0;
let pendingBand  = null;
let pendingDate  = null;

// Session
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

// ── ROUTING ──────────────────────────────────────────────────────
function goTo(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) { el.classList.add('active'); window.scrollTo(0, 0); }
}

// ── AUTH ─────────────────────────────────────────────────────────
onAuthStateChanged(auth, async user => {
  if (!user) {
    window.location.href = 'index.html';
    return;
  }
  currentUser = user;
  try {
    const snap = await getStudentDoc(user.uid);
    if (!snap.exists()) {
      initOnboarding();
      goTo('s-onboarding');
    } else {
      studentData = snap.data();
      renderHome();
      goTo('s-home');
    }
  } catch {
    // Firestore unavailable — show home with cached data or retry
    goTo('s-home');
  }
});

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
function initOnboarding() {
  const firstName = currentUser.displayName?.split(' ')[0] || 'there';
  document.getElementById('ob-first-name').textContent = firstName;

  // Band selector grid
  const bands = [5.0, 5.5, 6.0, 6.5, 7.0, 7.5, 8.0, 8.5];
  document.getElementById('band-grid').innerHTML = bands.map(b =>
    `<button class="band-btn" data-band="${b}" onclick="selectBand(${b})">${b}</button>`
  ).join('');

  // Trap question content
  document.getElementById('trap-passage').textContent = TRAP.passage;
  document.getElementById('trap-statement').textContent = TRAP.statement;

  showObStep(0);
}

function showObStep(n) {
  document.querySelectorAll('.ob-step').forEach(s => s.classList.remove('active'));
  const step = document.getElementById(`ob-${n}`);
  if (step) { step.classList.add('active'); window.scrollTo(0, 0); }
  obStep = n;
}

window.obNext     = () => showObStep(obStep + 1);
window.selectBand = function (band) {
  pendingBand = band;
  document.querySelectorAll('.band-btn').forEach(b => b.classList.remove('selected'));
  document.querySelector(`.band-btn[data-band="${band}"]`).classList.add('selected');
  document.getElementById('ob-band-btn').disabled = false;
};

window.setExamDate = function () {
  const val = document.getElementById('ob-date-input').value;
  if (val) { pendingDate = val; }
  showObStep(3);
};

window.skipExamDate = function () {
  pendingDate = null;
  showObStep(3);
};

window.answerTrap = function (val) {
  document.querySelectorAll('.trap-btn').forEach(b => { b.disabled = true; });
  const isRight = val === TRAP.answer;

  document.getElementById('trap-reveal-msg').innerHTML = isRight
    ? `You got it right — but do you know <em>exactly</em> why it's Not Given? <strong>This is what we're going to fix together.</strong>`
    : `The answer is <strong>Not Given</strong> — and most students miss it. <strong>This is exactly what we're going to fix together.</strong>`;

  document.getElementById('trap-result').innerHTML = `
    <div class="trap-answer-reveal ${isRight ? 'correct' : 'wrong'}">
      <strong>You answered: ${val}</strong> &nbsp;·&nbsp; Correct: ${TRAP.answer}
    </div>`;

  document.getElementById('trap-explain').textContent = TRAP.explanation;
  showObStep(4);
};

window.finishOnboarding = async function () {
  const btn = document.getElementById('ob-finish-btn');
  btn.textContent = 'Setting up your account…';
  btn.disabled = true;
  try {
    await createStudentDoc(currentUser.uid, {
      name:       currentUser.displayName || 'Student',
      email:      currentUser.email,
      targetBand: pendingBand || 6.5,
      examDate:   pendingDate || null,
    });
    const snap = await getStudentDoc(currentUser.uid);
    studentData = snap.data();
    renderHome();
    goTo('s-home');
  } catch {
    btn.textContent = 'Start Day 1 →';
    btn.disabled = false;
  }
};

// ── HOME ─────────────────────────────────────────────────────────
function renderHome() {
  if (!studentData) return;
  const day    = studentData.dayNumber || 1;
  const plan   = DAY_PLAN[Math.min(day, 10)] || DAY_PLAN[1];
  const name   = studentData.name?.split(' ')[0] || 'there';
  const streak = studentData.streak || 0;

  // Greeting
  const hour  = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  document.getElementById('home-greeting').innerHTML = `${greet}, <span style="color:var(--accent)">${name}</span>.`;
  document.getElementById('home-subtitle').textContent = day === 1
    ? "Let's find out where you're starting from."
    : day > 10
    ? "You've completed the 10-day programme. Incredible work."
    : `Day ${day} of 10. Keep the streak alive.`;

  // Nav badges
  document.getElementById('home-streak').textContent = `🔥 ${streak} day${streak !== 1 ? 's' : ''}`;
  document.getElementById('home-day-badge').textContent = `Day ${Math.min(day, 10)}`;

  // Today's session card
  if (day <= 10) {
    document.getElementById('today-day-label').textContent = `Day ${day} of 10`;
    document.getElementById('today-skill').textContent = `${plan.section} — ${plan.label}`;
    document.getElementById('today-desc').textContent   = plan.desc;
    document.getElementById('today-session-card').style.display = '';
  } else {
    document.getElementById('today-session-card').style.display = 'none';
  }

  // Upcoming
  const upcomingEl  = document.getElementById('upcoming-list');
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

  // Skill snapshot
  renderSkillSnapshot();
}

function renderSkillSnapshot() {
  if (!studentData?.skills) return;
  const s = studentData.skills;
  const rows = [
    { label: 'T / F / Not Given',  pct: s.reading?.tfng?.attempted             > 0 ? s.reading.tfng.accuracy             : null },
    { label: 'Matching Headings',  pct: s.reading?.matchingHeadings?.attempted  > 0 ? s.reading.matchingHeadings.accuracy  : null },
    { label: 'Multiple Choice',    pct: s.listening?.multipleChoice?.attempted  > 0 ? s.listening.multipleChoice.accuracy  : null },
    { label: 'Form Completion',    pct: s.listening?.formCompletion?.attempted  > 0 ? s.listening.formCompletion.accuracy   : null },
  ];
  const el = document.getElementById('home-skill-snapshot');
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
  const day  = studentData?.dayNumber || 1;
  const plan = DAY_PLAN[Math.min(day, 10)];
  if (!plan) return;

  // Update warmup day badge
  document.getElementById('warmup-day-badge').textContent = `Day ${day}`;
  document.getElementById('reading-day-badge').textContent = `Day ${day}`;
  document.getElementById('nb-day-badge').textContent = `Day ${day}`;

  if (day > 1 && plan.screen === 's-reading') {
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
    // If AI fails, skip warmup silently
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
  if      (plan.screen === 's-reading')   loadReadingSession();
  else if (plan.screen === 's-listening') goTo('s-listening');
  else if (plan.screen === 's-writing')   goTo('s-writing');
  else if (plan.screen === 's-speaking')  goTo('s-speaking');
  else if (plan.screen === 's-notebook')  goTo('s-notebook');
  else loadReadingSession();
}

// ── READING SESSION ───────────────────────────────────────────────
async function loadReadingSession() {
  sessionQuestions = [];
  sessionPassage   = '';
  sessionAnswers   = {};
  sessionCorrect   = 0;
  sessionTopic     = '';
  tlQ = null; tlPassed = false;

  document.getElementById('reading-loading').classList.remove('hidden');
  document.getElementById('reading-content').classList.add('hidden');
  document.getElementById('btn-reading-submit').disabled = true;

  // Reset phase dot (warmup done on Day 2+)
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
  } catch (err) {
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

  const isRight = val === q.answer;
  sessionAnswers[qnum] = { val, isRight };
  if (isRight) sessionCorrect++;

  document.querySelectorAll(`#tfng${qnum} .tfng-btn`).forEach(b => {
    b.disabled = true;
    if      (b.dataset.v === q.answer)           b.classList.add('correct');
    else if (b.dataset.v === val && !isRight)    b.classList.add('wrong');
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
  const day        = studentData?.dayNumber || 1;
  const tlAnswer   = tlQ ? sessionAnswers[tlQ.id] : null;
  const tlEligible = day > 1 && tlQ !== null && tlAnswer?.isRight === true;

  if (tlEligible) {
    renderToughLove();
    goTo('s-toughlove');
  } else {
    finishReadingSession();
  }
};

// ── TOUGH LOVE ─────────────────────────────────────────────────────
function buildToughLove(questions, passage, day) {
  if (day === 1) { tlQ = null; return; }
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

// ── SESSION FINISH + FIRESTORE SAVE ───────────────────────────────
async function finishReadingSession() {
  goTo('s-notebook');

  const total    = sessionQuestions.length || 5;
  const accuracy = Math.round((sessionCorrect / total) * 100);
  const day      = studentData.dayNumber || 1;

  // Save session document
  try {
    await saveSessionDoc(currentUser.uid, {
      weekNumber:         studentData.weekNumber || 1,
      dayNumber:          day,
      skillPracticed:     DAY_PLAN[day]?.skill || 'reading.tfng',
      questionsAttempted: total,
      questionsCorrect:   sessionCorrect,
      accuracy,
      toughLovePassed:    tlPassed,
      warmupCorrect,
      aiPassageTopic:     sessionTopic,
      durationMinutes:    0
    });

    // Update skill accuracy (rolling average)
    const prev         = studentData.skills?.reading?.tfng || { accuracy: 0, attempted: 0 };
    const prevCorrect  = Math.round((prev.accuracy / 100) * prev.attempted);
    const newAttempted = prev.attempted + total;
    const newAccuracy  = newAttempted > 0
      ? Math.round(((prevCorrect + sessionCorrect) / newAttempted) * 100)
      : 0;
    const newStreak = (studentData.streak || 0) + 1;

    await updateStudentDoc(currentUser.uid, {
      'skills.reading.tfng.accuracy':      newAccuracy,
      'skills.reading.tfng.attempted':     newAttempted,
      'skills.reading.tfng.lastPracticed': serverTimestamp(),
      'skills.reading.tfng.trend':         newAccuracy > prev.accuracy ? 'up' : newAccuracy < prev.accuracy ? 'down' : 'stable',
      dayNumber:        day + 1,
      streak:           newStreak,
      lastSession:      serverTimestamp(),
      toughLoveResults: (studentData.toughLoveResults || 0) + (tlPassed ? 1 : 0),
    });

    // Reload fresh data
    const snap = await getStudentDoc(currentUser.uid);
    studentData = snap.data();
  } catch {
    // Firestore save failed — still show notebook with local data
  }

  renderNotebook(sessionCorrect, total);
}

// ── NOTEBOOK ──────────────────────────────────────────────────────
function renderNotebook(correct, total) {
  const accuracy = Math.round((correct / total) * 100);
  const streak   = studentData?.streak    || 1;
  const day      = (studentData?.dayNumber || 2) - 1; // just completed

  // Stats
  document.getElementById('nb-questions-done').textContent = total;
  document.getElementById('nb-streak').textContent         = streak;
  document.getElementById('nb-band-est').textContent       = studentData?.currentBand || studentData?.targetBand || '—';

  // T/F/NG bar — current session accuracy
  const barClass = accuracy >= 80 ? 'strong' : accuracy >= 50 ? 'medium' : 'weak';
  document.getElementById('nb-tfng-bar').className    = `skill-bar ${barClass}`;
  document.getElementById('nb-tfng-bar').style.width  = accuracy + '%';
  document.getElementById('nb-tfng-pct').textContent  = accuracy + '%';

  // Other skill bars from Firestore cumulative data
  const skills = studentData?.skills;
  setSkillBar('nb-mh-bar', 'nb-mh-pct', skills?.reading?.matchingHeadings?.attempted  > 0 ? skills.reading.matchingHeadings.accuracy  : null);
  setSkillBar('nb-mc-bar', 'nb-mc-pct', skills?.listening?.multipleChoice?.attempted  > 0 ? skills.listening.multipleChoice.accuracy   : null);
  setSkillBar('nb-fc-bar', 'nb-fc-pct', skills?.listening?.formCompletion?.attempted  > 0 ? skills.listening.formCompletion.accuracy    : null);

  // Toody's assessment
  const assessment = accuracy >= 80
    ? `${accuracy}% on T/F/NG — strong session. You're reading with real precision. Keep this consistency and Band 7 is within reach.`
    : accuracy >= 60
    ? `${accuracy}% today. Solid effort — the questions you missed share a pattern. Toody's already noted it.`
    : `${accuracy}% — that's your starting point, not your ceiling. Toody now knows exactly where to focus next.`;
  document.getElementById('nb-assessment').textContent = assessment;

  // Worked example — first wrong answer this session
  const wrongQ = sessionQuestions.find(q => sessionAnswers[q.id]?.isRight === false);
  const weEl   = document.getElementById('nb-worked-example');
  if (wrongQ) {
    weEl.classList.remove('hidden');
    document.getElementById('we-q').textContent   = wrongQ.text;
    document.getElementById('we-exp').textContent = `Answer: ${wrongQ.answer}. ${wrongQ.explanation}`;
  } else {
    weEl.classList.add('hidden');
  }

  // Tomorrow's plan
  const nextDay = studentData?.dayNumber || day + 1;
  if (nextDay <= 10) {
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

// ── AI CALL ───────────────────────────────────────────────────────
async function callAI(prompt) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model:       'gpt-4o-mini',
      messages:    [
        { role: 'system', content: prompt.system },
        { role: 'user',   content: prompt.user   }
      ],
      max_tokens:  1500,
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
