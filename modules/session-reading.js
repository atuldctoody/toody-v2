// modules/session-reading.js
// Warmup, behaviour tracking, reading session (TFNG + Summary Completion), Tough Love.
//
// Structural adaptation: tipNotebookFn is a module-scoped let in ui.js;
//   the direct assignment `tipNotebookFn = ...` is replaced with the exported
//   setter `setTipNotebookFn(...)` — identical logic, necessary for the module split.
//
// Forward references resolved: mockMode, mockResults, runMockPhase ← modules/mock.js
//
// Note: updateStudentBrain and updateWeakAreas were already moved to modules/state.js.

import { serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { SKILL_MANIFEST, API_URL, SKILL_MAP } from './constants.js';
import {
  studentData, setStudentData, currentUser,
  getIELTSSkills, setIELTSSkillLocal, callAI, buildContextSnippet,
  updateStudentBrain, updateWeakAreas,
} from './state.js';
import { goTo, setCurrentPlan, currentPlan, pickNextSkill, launchSkillScreen } from './router.js';
import {
  getSkillConfig, parseAIJson, renderMarkdown, normaliseAnswer,
  withRetry, accToBand, toSkillId, boldify,
} from './utils.js';
import {
  updateStudentDoc, saveSessionDoc, generateAndSaveNarrative, getStudentDoc, db,
} from './firebase.js';
import { showToast, safeClick, showSessionTip, finishTip, setTipNotebookFn } from './ui.js';
import { loadTeachFirst } from './teach-first.js';
import { renderNotebook } from './notebook.js';
import { mockMode, mockResults, runMockPhase } from './mock.js';

// ── READING SESSION STATE ─────────────────────────────────────────
export let sessionQuestions      = [];
let sessionPassage        = '';
export let sessionAnswers        = {};   // { qnum: { val, isRight } }
let sessionCorrect        = 0;
let sessionTopic          = '';
let sessionCorrections    = [];   // Answer corrections from verifyAnswers() — logged to Firestore
let sessionPassageQuality = null; // Passage quality eval from evaluate-passage.js — logged to Firestore

// Tough Love
let tlQ           = null;
let tlKeySentence = '';
let tlExplanation = '';
let tlPassed      = false;

// Warmup
let warmupQ             = null;
export let warmupCorrect = false;

// Summary Completion session
let isSCSession    = false;
let sessionSummary = '';   // SC summary text
let sessionWordBank = [];  // SC word bank

// ── BEHAVIOUR TRACKING STATE ──────────────────────────────────────
let bhvSessionStart   = 0;
let bhvQStart         = {};   // { qnum: timestamp when question became active }
let bhvQDuration      = {};   // { qnum: ms taken before answering }
let bhvScrolledUp     = false;
let bhvScrollHandler  = null;
let bhvAnswerChanges  = 0;    // count of answer changes before submission
export let bhvPrevFCValues   = {};   // { qnum: last recorded non-empty value } for FC inputs
export let bhvQChangedAnswer = {};   // { qnum: true } if student changed answer at least once

// ── WARMUP ────────────────────────────────────────────────────────
export async function loadWarmup(plan) {
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

// ── BEHAVIOUR TRACKING ───────────────────────────────────────────
export function startSessionTracking() {
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

export function trackQStart(qnum) {
  bhvQStart[qnum] = Date.now();
}

export function trackQAnswer(qnum) {
  if (bhvQStart[qnum]) {
    bhvQDuration[qnum] = Date.now() - bhvQStart[qnum];
  }
}

export function trackAnswerChange() {
  bhvAnswerChanges++;
}

export function setupScrollTracking() {
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

export function getBehaviourPayload() {
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
export function computeConfidenceMetrics(questions, answers) {
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

// ── READING SESSION ───────────────────────────────────────────────
export async function loadReadingSession() {
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

ANSWER FORMAT RULES (mandatory):
- The "answer" field must contain exactly one of: True, False, or NG. Nothing else.
- Never use pipe-separated formats like "True|False". Never use option labels like A/B/C.
- Every explanation must name the specific word, phrase, or logical feature that determines the answer. Never explain by location alone.

For each question, set "errorReason" to the reasoning trap this question is specifically designed to test. Valid values:
- "synonymTrap" — statement paraphrases passage with near-synonym; student reads meaning not exact evidence
- "cautiousLanguageMissed" — answer hinges on cautious language in passage (may, suggests, could, tends to)
- "negationOverlooked" — answer hinges on a negation in passage or statement (not, never, rarely, without)
- "scopeError" — statement claims more or less than passage actually states (all vs some, always vs usually)
- "notGivenMarkedFalse" — passage is silent on claim; designed to catch students who mark silence as contradiction
- "other" — does not fit a specific category above

SELF-VERIFICATION (do this before returning):
1. For each question, confirm the answer is exactly one word: True, False, or NG.
2. For each explanation, confirm it names a specific word or phrase — not just a paragraph number.
3. For NG answers, confirm the passage is genuinely silent on the claim (not just ambiguous).

Return ONLY this JSON:
{
  "passage": "3 paragraphs of academic prose on any interesting topic (170-220 words total)",
  "topic": "2-4 word topic label",
  "questions": [
    {"id": 1, "text": "statement", "answer": "True",  "explanation": "name the exact word/phrase that confirms this", "keySentence": "exact sentence from passage", "errorReason": "synonymTrap"},
    {"id": 2, "text": "statement", "answer": "False", "explanation": "name the exact word/phrase that contradicts this", "keySentence": "exact sentence from passage", "errorReason": "negationOverlooked"},
    {"id": 3, "text": "statement", "answer": "NG",    "explanation": "name what the passage says and what it does NOT say", "keySentence": "exact sentence from passage", "errorReason": "notGivenMarkedFalse"},
    {"id": 4, "text": "statement", "answer": "True",  "explanation": "name the exact word/phrase that confirms this", "keySentence": "exact sentence from passage", "errorReason": "cautiousLanguageMissed"},
    {"id": 5, "text": "statement", "answer": "False", "explanation": "name the exact word/phrase that contradicts this", "keySentence": "exact sentence from passage", "errorReason": "scopeError"}
  ]
}`
    };
  }

  sessionCorrections  = [];
  sessionPassageQuality = null;

  try {
    let raw    = await callAI(prompt);
    let parsed = parseAIJson(raw);

    // ── Passage Quality Gate ───────────────────────────────────────────────────
    // Runs evaluate-passage.js before any student sees the content.
    // If the passage fails, regenerate once with the specific fix instruction.
    // Non-fatal: errors here never block the session.
    try {
      const { evaluatePassage } = await import('./api/evaluate-passage.js');
      const passageEval = await evaluatePassage(
        parsed.passage,
        studentData?.currentBand || 6.0,
        API_URL
      );
      sessionPassageQuality = {
        avgScore:    passageEval.avgScore,
        scores:      passageEval.scores,
        pass:        passageEval.pass,
        regenerated: false,
      };
      if (!passageEval.pass && passageEval.regenerationInstruction) {
        console.log('Passage quality fail — regenerating. Reason:', passageEval.failReasons);
        const improvedPrompt = {
          ...prompt,
          user: prompt.user + '\n\nCRITICAL IMPROVEMENT REQUIRED: ' + passageEval.regenerationInstruction,
        };
        raw    = await callAI(improvedPrompt);
        parsed = parseAIJson(raw);
        sessionPassageQuality.regenerated = true;
      }
    } catch { /* non-fatal — continue with original passage */ }
    // ──────────────────────────────────────────────────────────────────────────

    sessionPassage = parsed.passage;
    sessionTopic   = parsed.topic || 'Reading';

    if (isSCSession) {
      sessionQuestions = parsed.questions;
      sessionSummary   = parsed.summaryText || '';
      sessionWordBank  = parsed.wordBank    || [];
      renderSCSession(parsed);
    } else {
      // Run the Answer Verification Agent before showing anything to the student.
      // Dynamic import so a load failure here never prevents app.js from booting.
      let verified = { questions: parsed.questions, corrections: [] };
      try {
        const { verifyAnswers } = await import('./api/verify-answers.js');
        verified = await verifyAnswers(parsed.passage, parsed.questions, API_URL);
      } catch { /* non-fatal — original questions used */ }
      sessionQuestions   = verified.questions;
      sessionCorrections = verified.corrections;

      // Re-build tough love with verified (possibly corrected) questions
      buildToughLove(verified.questions, parsed.passage);
      renderReadingSession({ ...parsed, questions: verified.questions });
    }

    document.getElementById('reading-loading').classList.add('hidden');
    document.getElementById('reading-content').classList.remove('hidden');

    startSessionTracking();
    setupScrollTracking();
    trackQStart(1);
  } catch (err) {
    /* session load failed — toast shown to student */
    showToast('Having trouble connecting — please check your internet and try again.');
    document.getElementById('reading-loading').innerHTML =
      `<p style="color:var(--danger);padding:20px;text-align:center">Could not load passage. Please go back and try again.<br><small style="opacity:.6">${err?.message || ''}</small></p>`;
  }
}
window.loadReadingSession = loadReadingSession;

export function renderSCSession(parsed) {
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

export function submitSCSession() {
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
          : `❌ Answer: <strong>${q.answer}</strong>. ${renderMarkdown(q.explanation)}`}
      </div>`;
  });

  document.getElementById('sc-results-container').innerHTML = resultsHtml;
  const btn = document.getElementById('btn-reading-submit');
  btn.textContent = 'Continue to notebook →';
  btn.disabled = false;
  btn.onclick = () => finishReadingSession();
  window.scrollTo(0, document.body.scrollHeight);
}

export function renderReadingSession(parsed) {
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
  console.log(`answerTFNG q${qnum}: val="${val}" answer="${q.answer}" isRight=${isRight}`);
  sessionAnswers[qnum] = { val, isRight, errorReason: isRight ? null : (q.errorReason || 'other') };
  if (isRight) sessionCorrect++;

  document.querySelectorAll(`#tfng${qnum} .tfng-btn`).forEach(b => {
    b.disabled = true;
    if      (normaliseAnswer(b.dataset.v) === normaliseAnswer(q.answer)) b.classList.add('correct');
    else if (b.dataset.v === val && !isRight)                             b.classList.add('wrong');
  });

  const rf = document.getElementById(`rf${qnum}`);
  rf.classList.remove('good', 'bad');
  rf.classList.add('show', isRight ? 'good' : 'bad');
  const expl = q.explanation ? boldify(q.explanation) : (isRight ? 'Good work.' : 'Review the passage carefully.');
  if (isRight === true) {
    rf.innerHTML = `✅ Correct. ${expl}`;
  } else {
    const ERROR_REASON_PILLS = {
      synonymTrap:         'Synonym trap — passage isn\'t as direct as it looks',
      cautiousLanguageMissed: 'Cautious language — may / suggests / could',
      negationOverlooked:  'Negation — not / never / rarely',
      scopeError:          'Scope error — all vs some, always vs usually',
      notGivenMarkedFalse: 'Not Given ≠ False — the passage is silent on this',
      other:               'Reasoning error',
    };
    const pill = ERROR_REASON_PILLS[q.errorReason];
    rf.innerHTML = `❌ The answer is <strong>${q.answer}</strong>. ${expl}`
      + (pill ? `<br><span class="error-reason-pill">⚠ ${pill}</span>` : '');
  }
  setTimeout(() => rf.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);

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
export function buildToughLove(questions, passage) {
  tlQ           = questions[Math.floor(Math.random() * questions.length)];
  tlKeySentence = tlQ.keySentence || '';
  tlExplanation = tlQ.explanation || '';
}

export function renderToughLove() {
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
export async function finishReadingSession() {
  console.log('finish session called for: reading');
  try {
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
      behaviour,
      ...(sessionCorrections.length    ? { answerCorrections: sessionCorrections }   : {}),
      ...(sessionPassageQuality        ? { passageQuality: sessionPassageQuality }   : {}),
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
        synonymTrap: 0, cautiousLanguageMissed: 0, negationOverlooked: 0,
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
    setStudentData(snap.data());
    await updateStudentBrain(behaviour, accuracy, skillKey);
    await updateWeakAreas(skillKey, missedSubTypes);
  } catch { /* Firestore save failed — still show notebook */ }

  if (_readingSessionRef) generateAndSaveNarrative(currentUser.uid, _readingSessionRef, {
    skill: skillKey, day, accuracy, questionsCorrect: sessionCorrect, total, missedSubTypes, topic: sessionTopic,
  });

  // Agent 3 — Explanation Quality Audit (fire-and-forget, never blocks UI)
  if (_readingSessionRef && sessionQuestions.length) {
    const _explData = sessionQuestions.map(q => ({
      questionText:  q.text,
      passage:       sessionPassage,
      studentAnswer: sessionAnswers[q.id]?.val        || '',
      correctAnswer: q.answer,
      explanation:   q.explanation                    || '',
      errorReason:   sessionAnswers[q.id]?.errorReason || '',
    }));
    import('./api/check-explanations.js')
      .then(({ checkExplanations }) =>
        checkExplanations(currentUser.uid, _readingSessionRef, _explData, API_URL))
      .catch(() => { /* non-critical */ });
  }

  if (mockMode) {
    mockResults.reading = { correct: sessionCorrect, total, accuracy };
    runMockPhase(1);
    return;
  }

  setTipNotebookFn(() => {
    document.getElementById('nb-day-badge').textContent = `Session ${day}`;
    goTo('s-notebook');
    renderNotebook(sessionCorrect, total, skillKey);
  });
  showSessionTip({ accuracy, behaviour, missedSubTypes, skillKey });
  } catch(err) {
    console.error('finishSession error:', err);
    showToast('Something went wrong — please try again', 'error');
    const finishBtn = document.querySelector('[onclick*="finish"], .btn-finish, #btn-finish');
    if (finishBtn) finishBtn.disabled = false;
  }
}
window.finishReadingSession = finishReadingSession;
