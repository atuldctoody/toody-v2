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

import {
  serverTimestamp, getDocs, query, collection, where, orderBy, limit,
  updateDoc, increment,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { SKILL_MANIFEST, API_URL, SKILL_MAP } from './constants.js';
import {
  studentData, setStudentData, currentUser,
  getIELTSSkills, setIELTSSkillLocal, callAI, buildContextSnippet,
  updateStudentBrain, updateWeakAreas,
} from './state.js';
import { goTo, setCurrentPlan, currentPlan, pickNextSkill, launchSkillScreen } from './router.js';
import {
  getSkillConfig, parseAIJson, renderMarkdown, normaliseAnswer,
  withRetry, accToBand, toSkillId, boldify, renderReasoningHtml,
} from './utils.js';
import {
  updateStudentDoc, saveSessionDoc, generateAndSaveNarrative, getStudentDoc, db,
} from './firebase.js';
import { showToast, safeClick, showSessionTip, finishTip, setTipNotebookFn } from './ui.js';
import { loadTeachFirst } from './teach-first.js';
import { renderNotebook } from './notebook.js';
import { mockMode, mockResults, runMockPhase } from './mock.js';
import { verifyAnswers } from '../api/verify-answers.js';

// ── READING SESSION STATE ─────────────────────────────────────────
export let sessionQuestions      = [];
let sessionPassage        = '';
export let sessionAnswers        = {};   // { qnum: { val, isRight } }
let sessionCorrect        = 0;
let sessionTopic          = '';
let sessionCorrections    = [];   // Answer corrections from verifyAnswers() — logged to Firestore
let sessionPassageQuality = null; // Passage quality eval from evaluate-passage.js — logged to Firestore
let sessionLogicValidationPassed = false; // Logic Tags validation result — logged to Firestore
let sessionIsVerified            = false; // Whether verifyAnswers() succeeded this session
let sessionFromBank              = false; // Whether this session was served from questionBank
let sessionBankSetId             = null;  // Firestore document ID of the bank set used

// Tough Love
let tlQ           = null;
let tlKeySentence = '';
let tlExplanation = '';
let tlPassed      = false;

// Warmup
let warmupQ             = null;
export let warmupCorrect = false;

// Summary Completion session
let isSCSession          = false;
let sessionSummary       = '';   // SC summary text
let sessionWordBank      = [];   // SC word bank

// Additional session type flags
let isYNNGSession             = false;  // Yes / No / Not Given
let isMCSession               = false;  // Reading Multiple Choice
let isSentenceCompSession     = false;  // Sentence Completion
let isMatchingInfoSession     = false;  // Matching Information
let isMatchingFeaturesSession = false;  // Matching Features
let isMatchingHeadingsSession = false;  // Matching Headings
let isShortAnswerSession      = false;  // Short Answer

// Extra state for matching/short-answer sessions
let sessionMatchingFeatures   = [];  // feature names for Matching Features
let sessionMatchingHeadings   = [];  // heading options for Matching Headings

// ── BEHAVIOUR TRACKING STATE ──────────────────────────────────────
let bhvSessionStart   = 0;
let bhvQStart         = {};   // { qnum: timestamp when question became active }
let bhvQDuration      = {};   // { qnum: ms taken before answering }
let bhvScrolledUp     = false;
let bhvScrollHandler  = null;
let bhvAnswerChanges  = 0;    // count of answer changes before submission
export let bhvPrevFCValues   = {};   // { qnum: last recorded non-empty value } for FC inputs
export let bhvQChangedAnswer = {};   // { qnum: true } if student changed answer at least once

// ── LOGIC TAGS ────────────────────────────────────────────────────
// Five constrained mutation types for T/F/NG question generation.
// Each generated question must declare which type it implements and which
// exact passage sentence it anchors to — enabling per-type error tracking.
const VALID_LOGIC_TYPES = [
  'SYNONYM_SUBSTITUTION',
  'CAUTIOUS_LANGUAGE',
  'NEGATION_INVERSION',
  'SCOPE_QUALIFIER',
  'CAUSAL_ASSUMPTION',
];

function validateLogicTags(passage, questions) {
  if (!Array.isArray(questions) || questions.length === 0) return false;
  for (const q of questions) {
    if (!VALID_LOGIC_TYPES.includes(q.logicType)) return false;
    if (!q.passageAnchor || !passage.includes(q.passageAnchor)) return false;
  }
  return true;
}

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

// ── QUESTION BANK LOOKUP ──────────────────────────────────────────
async function getQuestionFromBank(targetBand, excludeIds = []) {
  const band       = Math.round(targetBand * 2) / 2;
  const bandsToTry = [band, band - 0.5, band + 0.5].filter(b => b >= 5.0 && b <= 7.0);

  for (const b of bandsToTry) {
    const snapshot = await getDocs(
      query(
        collection(db, 'questionBank'),
        where('band', '==', b),
        where('status', '==', 'active'),
        orderBy('servedCount', 'asc'),
        limit(10)
      )
    );

    if (snapshot.empty) continue;

    const candidates = snapshot.docs.filter(d => !excludeIds.includes(d.id));
    if (candidates.length === 0) continue;

    const picked = candidates[Math.floor(Math.random() * candidates.length)];

    updateDoc(picked.ref, {
      servedCount:  increment(1),
      lastServedAt: serverTimestamp(),
    }).catch(() => {});

    return { id: picked.id, ...picked.data() };
  }

  return null;
}

// Generic bank loader — same query pattern as getQuestionFromBank but for any collection.
async function getFromBankCollection(collectionName, targetBand, excludeIds = []) {
  const band       = Math.round(targetBand * 2) / 2;
  const bandsToTry = [band, band - 0.5, band + 0.5].filter(b => b >= 5.0 && b <= 7.0);

  // Pre-compute weak logic type error rates from all IELTS skills
  const brainSkills = studentData?.brain?.subjects?.['ielts-academic']?.skills || {};
  const errorTotals   = {};
  const attemptTotals = {};
  Object.values(brainSkills).forEach(sk => {
    Object.entries(sk.errorsByLogicType   || {}).forEach(([lt, n]) => { errorTotals[lt]   = (errorTotals[lt]   || 0) + n; });
    Object.entries(sk.attemptsByLogicType || {}).forEach(([lt, n]) => { attemptTotals[lt] = (attemptTotals[lt] || 0) + n; });
  });
  const errRate = (lt) => (attemptTotals[lt] || 0) > 0 ? (errorTotals[lt] || 0) / attemptTotals[lt] : 0;

  for (const b of bandsToTry) {
    const snapshot = await getDocs(
      query(
        collection(db, collectionName),
        where('band', '==', b),
        where('status', '==', 'active'),
        orderBy('servedCount', 'asc'),
        limit(10)
      )
    );

    if (snapshot.empty) continue;

    const candidates = snapshot.docs.filter(d => !excludeIds.includes(d.id));
    if (candidates.length === 0) continue;

    // Score each candidate by weak logic type coverage, then pick from top 3
    const scored = candidates
      .map(doc => ({
        doc,
        score: (doc.data().questions || []).reduce((s, q) => s + (q.logicType ? errRate(q.logicType) : 0), 0),
      }))
      .sort((a, b) => b.score - a.score);
    const top3   = scored.slice(0, Math.min(3, scored.length));
    const picked = top3[Math.floor(Math.random() * top3.length)].doc;

    updateDoc(picked.ref, {
      servedCount:  increment(1),
      lastServedAt: serverTimestamp(),
    }).catch(() => {});

    return { id: picked.id, ...picked.data() };
  }

  return null;
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
  isSCSession                  = false;
  isYNNGSession                = false;
  isMCSession                  = false;
  isSentenceCompSession        = false;
  isMatchingInfoSession        = false;
  isMatchingFeaturesSession    = false;
  isMatchingHeadingsSession    = false;
  isShortAnswerSession         = false;
  sessionMatchingFeatures      = [];
  sessionMatchingHeadings      = [];
  sessionLogicValidationPassed = false;
  sessionIsVerified            = false;
  sessionFromBank              = false;
  sessionBankSetId             = null;
  tlQ = null; tlPassed = false;

  goTo('s-reading');
  document.getElementById('reading-loading').classList.remove('hidden');
  document.getElementById('reading-content').classList.add('hidden');

  const submitBtn = document.getElementById('btn-reading-submit');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Submit answers →';
  submitBtn.onclick = () => window.submitReading();

  const skillKey            = currentPlan?.skill || 'reading.tfng';
  isSCSession               = (skillKey === 'reading.summaryCompletion');
  isYNNGSession             = (skillKey === 'reading.yesNoNotGiven');
  isMCSession               = (skillKey === 'reading.multipleChoice');
  isSentenceCompSession     = (skillKey === 'reading.sentenceCompletion');
  isMatchingInfoSession     = (skillKey === 'reading.matchingInformation');
  isMatchingFeaturesSession = (skillKey === 'reading.matchingFeatures');
  isMatchingHeadingsSession = (skillKey === 'reading.matchingHeadings');
  isShortAnswerSession      = (skillKey === 'reading.shortAnswer');

  const _scDay = (studentData?.dayNumber || 1) - 1;
  document.getElementById('reading-p1-dot').className = _scDay > 0 ? 'phase-dot done' : 'phase-dot';

  const band = studentData?.targetBand || 6.5;

  // ── Question Bank fast-path (T/F/NG only) ─────────────────────────────────
  const cfg = getSkillConfig(currentPlan?.skillId || 'reading-tfng');
  if (cfg.id === 'reading-tfng') {
    try {
      const recentIds = studentData?.brain?.recentQuestionBankIds || [];
      const bankSet   = await getQuestionFromBank(
        studentData?.currentBand || 6.0,
        recentIds
      );

      if (bankSet) {
        const updatedRecentIds = [bankSet.id, ...recentIds].slice(0, 20);
        updateStudentDoc(currentUser.uid, { 'brain.recentQuestionBankIds': updatedRecentIds }).catch(() => {});

        sessionPassage   = bankSet.passage;
        sessionTopic     = bankSet.topic;
        sessionFromBank  = true;
        sessionBankSetId = bankSet.id;
        sessionQuestions = bankSet.questions.map(q => ({
          id:           q.id,
          text:         q.text,
          answer:       q.answer,
          explanation:  q.explanation,
          keySentence:  q.passageAnchor || q.keySentence,
          errorReason:  q.errorReason,
          logicType:    q.logicType,
          reasoning:    q.reasoning || null,
          verified:     true,
          fromBank:     true,
        }));

        buildToughLove(sessionQuestions, sessionPassage);
        renderReadingSession({ passage: sessionPassage, questions: sessionQuestions });
        document.getElementById('reading-loading').classList.add('hidden');
        document.getElementById('reading-content').classList.remove('hidden');
        startSessionTracking();
        setupScrollTracking();
        trackQStart(1);
        return;
      }

      console.log('Question bank exhausted for this band — falling back to AI generation');
    } catch (err) {
      console.warn('Question bank lookup failed — falling back to AI generation:', err.message);
    }
  }

  // ── Bank fast-path: Y/N/NG ────────────────────────────────────────────────
  if (isYNNGSession) {
    try {
      const recentIds = studentData?.brain?.recentQuestionBankIds || [];
      const bankSet   = await getFromBankCollection(
        'questionBank-ynng',
        studentData?.currentBand || 6.0,
        recentIds
      );

      if (bankSet) {
        const updatedRecentIds = [bankSet.id, ...recentIds].slice(0, 20);
        updateStudentDoc(currentUser.uid, { 'brain.recentQuestionBankIds': updatedRecentIds }).catch(() => {});

        sessionPassage   = bankSet.passage;
        sessionTopic     = bankSet.topic;
        sessionFromBank  = true;
        sessionBankSetId = bankSet.id;
        sessionQuestions = bankSet.questions.map(q => ({
          id:          q.id,
          text:        q.text,
          answer:      q.answer,
          explanation: q.explanation,
          keySentence: q.passageAnchor || q.keySentence,
          errorReason: q.errorReason || null,
          logicType:   q.logicType   || null,
          verified:    true,
          fromBank:    true,
        }));

        buildToughLove(sessionQuestions, sessionPassage);
        renderYNNGSession({ passage: sessionPassage, questions: sessionQuestions });
        document.getElementById('reading-loading').classList.add('hidden');
        document.getElementById('reading-content').classList.remove('hidden');
        startSessionTracking();
        setupScrollTracking();
        trackQStart(1);
        return;
      }
    } catch (err) {
      console.warn('YNNG bank lookup failed — falling back to AI:', err.message);
    }
  }

  // ── Bank fast-path: Reading Multiple Choice ───────────────────────────────
  if (isMCSession) {
    try {
      const recentIds = studentData?.brain?.recentQuestionBankIds || [];
      const bankSet   = await getFromBankCollection(
        'questionBank-multiple-choice',
        studentData?.currentBand || 6.0,
        recentIds
      );

      if (bankSet) {
        const updatedRecentIds = [bankSet.id, ...recentIds].slice(0, 20);
        updateStudentDoc(currentUser.uid, { 'brain.recentQuestionBankIds': updatedRecentIds }).catch(() => {});

        sessionPassage   = bankSet.passage;
        sessionTopic     = bankSet.topic;
        sessionFromBank  = true;
        sessionBankSetId = bankSet.id;
        sessionQuestions = bankSet.questions.map(q => ({
          id:          q.id,
          text:        q.text,
          options:     q.options || [],
          answer:      q.answer,
          explanation: q.explanation,
          keySentence: q.keySentence || null,
          verified:    true,
          fromBank:    true,
        }));

        renderMCSession({ passage: sessionPassage, questions: sessionQuestions });
        document.getElementById('reading-loading').classList.add('hidden');
        document.getElementById('reading-content').classList.remove('hidden');
        startSessionTracking();
        setupScrollTracking();
        trackQStart(1);
        return;
      }
    } catch (err) {
      console.warn('MC bank lookup failed — falling back to AI:', err.message);
    }
  }

  // ── Bank fast-path: Summary Completion ────────────────────────────────────
  if (isSCSession) {
    try {
      const recentIds = studentData?.brain?.recentQuestionBankIds || [];
      const bankSet   = await getFromBankCollection(
        'questionBank-summary-completion',
        studentData?.currentBand || 6.0,
        recentIds
      );

      if (bankSet) {
        const updatedRecentIds = [bankSet.id, ...recentIds].slice(0, 20);
        updateStudentDoc(currentUser.uid, { 'brain.recentQuestionBankIds': updatedRecentIds }).catch(() => {});

        sessionPassage   = bankSet.passage;
        sessionTopic     = bankSet.topic;
        sessionFromBank  = true;
        sessionBankSetId = bankSet.id;
        sessionSummary   = bankSet.extraData?.summaryText || '';
        sessionWordBank  = bankSet.extraData?.wordBank    || [];
        sessionQuestions = bankSet.questions.map(q => ({
          id:          q.id,
          text:        q.text,
          answer:      q.answer,
          explanation: q.explanation,
          keySentence: q.keySentence || null,
          verified:    true,
          fromBank:    true,
        }));

        renderSCSession({
          passage:     sessionPassage,
          summaryText: sessionSummary,
          wordBank:    sessionWordBank,
          questions:   sessionQuestions,
        });
        document.getElementById('reading-loading').classList.add('hidden');
        document.getElementById('reading-content').classList.remove('hidden');
        startSessionTracking();
        setupScrollTracking();
        trackQStart(1);
        return;
      }
    } catch (err) {
      console.warn('SC bank lookup failed — falling back to AI:', err.message);
    }
  }
  // ── Bank fast-path: Matching Information ─────────────────────────────────
  if (isMatchingInfoSession) {
    try {
      const recentIds = studentData?.brain?.recentQuestionBankIds || [];
      const bankSet   = await getFromBankCollection(
        'questionBank-matching-information',
        studentData?.currentBand || 6.0,
        recentIds
      );
      if (bankSet) {
        const updatedRecentIds = [bankSet.id, ...recentIds].slice(0, 20);
        updateStudentDoc(currentUser.uid, { 'brain.recentQuestionBankIds': updatedRecentIds }).catch(() => {});
        sessionPassage   = bankSet.passage;
        sessionTopic     = bankSet.topic;
        sessionFromBank  = true;
        sessionBankSetId = bankSet.id;
        sessionQuestions = bankSet.questions.map(q => ({
          id: q.id, text: q.text, answer: q.answer, explanation: q.explanation, fromBank: true,
        }));
        renderMatchingInfoSession({ passage: sessionPassage, questions: sessionQuestions });
        document.getElementById('reading-loading').classList.add('hidden');
        document.getElementById('reading-content').classList.remove('hidden');
        startSessionTracking(); setupScrollTracking(); trackQStart(1);
        return;
      }
    } catch (err) { console.warn('Matching Info bank lookup failed — falling back to AI:', err.message); }
  }

  // ── Bank fast-path: Matching Features ────────────────────────────────────
  if (isMatchingFeaturesSession) {
    try {
      const recentIds = studentData?.brain?.recentQuestionBankIds || [];
      const bankSet   = await getFromBankCollection(
        'questionBank-matching-features',
        studentData?.currentBand || 6.0,
        recentIds
      );
      if (bankSet) {
        const updatedRecentIds = [bankSet.id, ...recentIds].slice(0, 20);
        updateStudentDoc(currentUser.uid, { 'brain.recentQuestionBankIds': updatedRecentIds }).catch(() => {});
        sessionPassage          = bankSet.passage;
        sessionTopic            = bankSet.topic;
        sessionFromBank         = true;
        sessionBankSetId        = bankSet.id;
        sessionMatchingFeatures = bankSet.extraData?.features || [];
        sessionQuestions        = bankSet.questions.map(q => ({
          id: q.id, text: q.text, answer: q.answer, explanation: q.explanation, fromBank: true,
        }));
        renderMatchingFeaturesSession({
          passage: sessionPassage, questions: sessionQuestions, features: sessionMatchingFeatures,
        });
        document.getElementById('reading-loading').classList.add('hidden');
        document.getElementById('reading-content').classList.remove('hidden');
        startSessionTracking(); setupScrollTracking(); trackQStart(1);
        return;
      }
    } catch (err) { console.warn('Matching Features bank lookup failed — falling back to AI:', err.message); }
  }

  // ── Bank fast-path: Matching Headings (AI fallback — only 2 bank sets) ──
  if (isMatchingHeadingsSession) {
    try {
      const recentIds = studentData?.brain?.recentQuestionBankIds || [];
      const bankSet   = await getFromBankCollection(
        'questionBank-matching-headings',
        studentData?.currentBand || 6.0,
        recentIds
      );
      if (bankSet) {
        const updatedRecentIds = [bankSet.id, ...recentIds].slice(0, 20);
        updateStudentDoc(currentUser.uid, { 'brain.recentQuestionBankIds': updatedRecentIds }).catch(() => {});
        sessionPassage          = bankSet.passage;
        sessionTopic            = bankSet.topic;
        sessionFromBank         = true;
        sessionBankSetId        = bankSet.id;
        sessionMatchingHeadings = bankSet.extraData?.headings || [];
        const paragraphs        = bankSet.extraData?.paragraphs || [];
        sessionQuestions        = bankSet.questions.map(q => ({
          id: q.id, text: q.text, answer: q.answer, explanation: q.explanation, fromBank: true,
        }));
        renderMatchingHeadingsSession({
          passage: sessionPassage, questions: sessionQuestions,
          headings: sessionMatchingHeadings, paragraphs,
        });
        document.getElementById('reading-loading').classList.add('hidden');
        document.getElementById('reading-content').classList.remove('hidden');
        startSessionTracking(); setupScrollTracking(); trackQStart(1);
        return;
      }
    } catch (err) { console.warn('Matching Headings bank lookup failed — falling back to AI:', err.message); }
  }
  // ─────────────────────────────────────────────────────────────────────────

  let prompt;
  if (isYNNGSession) {
    prompt = {
      model: 'gpt-4o',
      system: 'You are an IELTS Academic examiner. Generate reading exercises at the exact band level specified. Return valid JSON only, no markdown, no preamble.',
      user: `Create a Yes/No/Not Given IELTS Academic reading exercise for a Band ${band} student.

The passage must be written in the FIRST PERSON or clearly express the AUTHOR'S OWN OPINION. Use "I believe", "In my view", "It is clear that", "Proponents of X overlook" — the passage must be an academic argument, not neutral reporting.

ANSWER FORMAT RULES (mandatory):
- The "answer" field must contain exactly one of: Yes, No, or Not Given.
- Yes = the statement matches the writer's view as expressed in the passage.
- No = the statement contradicts the writer's view.
- Not Given = the writer does not address this specific claim.
- NEVER use True/False/NG — this is Yes/No/Not Given.

Return ONLY this JSON:
{
  "passage": "3 paragraphs of opinionated academic prose where the author clearly expresses views (170-220 words total)",
  "topic": "2-4 word topic label",
  "questions": [
    {"id": 1, "text": "statement about the writer's view", "answer": "Yes",       "explanation": "which phrase shows the writer agrees", "keySentence": "exact sentence from passage"},
    {"id": 2, "text": "statement about the writer's view", "answer": "No",        "explanation": "which phrase shows the writer disagrees", "keySentence": "exact sentence from passage"},
    {"id": 3, "text": "statement about the writer's view", "answer": "Not Given", "explanation": "why this topic is not addressed by the writer", "keySentence": "closest sentence in passage"},
    {"id": 4, "text": "statement about the writer's view", "answer": "Yes",       "explanation": "which phrase shows the writer agrees", "keySentence": "exact sentence from passage"},
    {"id": 5, "text": "statement about the writer's view", "answer": "No",        "explanation": "which phrase shows the writer disagrees", "keySentence": "exact sentence from passage"}
  ]
}`,
    };
  } else if (isMCSession) {
    prompt = {
      model: 'gpt-4o',
      system: 'You are an IELTS Academic examiner. Generate reading exercises at the exact band level specified. Return valid JSON only, no markdown, no preamble.',
      user: `Create a Multiple Choice IELTS Academic reading exercise for a Band ${band} student.

DISTRACTOR RULES (mandatory):
- Each question must have exactly 4 options labelled A, B, C, D.
- The correct option must be supported by the passage. The other three are distractors — mentioned in the passage but wrong, or based on common assumptions.
- Never make the correct answer obvious from wording alone; require reading the passage carefully.

Return ONLY this JSON:
{
  "passage": "3 paragraphs of academic prose on any interesting topic (170-220 words total)",
  "topic": "2-4 word topic label",
  "questions": [
    {
      "id": 1,
      "text": "question stem",
      "options": [
        {"label": "A", "text": "option text", "isCorrect": false},
        {"label": "B", "text": "option text", "isCorrect": false},
        {"label": "C", "text": "option text", "isCorrect": false},
        {"label": "D", "text": "option text", "isCorrect": true}
      ],
      "answer": "D",
      "explanation": "why D is correct and why the distractors are wrong"
    },
    {"id": 2, "text": "...", "options": [...], "answer": "A", "explanation": "..."},
    {"id": 3, "text": "...", "options": [...], "answer": "B", "explanation": "..."},
    {"id": 4, "text": "...", "options": [...], "answer": "C", "explanation": "..."},
    {"id": 5, "text": "...", "options": [...], "answer": "D", "explanation": "..."}
  ]
}`,
    };
  } else if (isMatchingInfoSession) {
    prompt = {
      model: 'gpt-4o',
      system: 'You are an IELTS Academic examiner. Generate reading exercises at the exact band level specified. Return valid JSON only, no markdown, no preamble.',
      user: `Create a Matching Information IELTS Academic reading exercise for a Band ${band} student.

RULES:
- The passage must have exactly 5 labeled sections: A, B, C, D, E — each a distinct paragraph.
- Each question identifies a specific piece of information and asks which section (A–E) contains it.
- Answers must be exactly "A", "B", "C", "D", or "E".
- Distribute answers across sections — do not put all answers in one section.

Return ONLY this JSON:
{
  "passage": "A. First paragraph (50–70 words)\\n\\nB. Second paragraph (50–70 words)\\n\\nC. Third paragraph (50–70 words)\\n\\nD. Fourth paragraph (50–70 words)\\n\\nE. Fifth paragraph (50–70 words)",
  "topic": "2-4 word topic label",
  "questions": [
    {"id": 1, "text": "specific information to locate", "answer": "A", "explanation": "Section A states that..."},
    {"id": 2, "text": "specific information to locate", "answer": "C", "explanation": "Section C mentions..."},
    {"id": 3, "text": "specific information to locate", "answer": "B", "explanation": "Section B describes..."},
    {"id": 4, "text": "specific information to locate", "answer": "E", "explanation": "Section E notes..."},
    {"id": 5, "text": "specific information to locate", "answer": "D", "explanation": "Section D states..."}
  ]
}`,
    };
  } else if (isMatchingFeaturesSession) {
    prompt = {
      model: 'gpt-4o',
      system: 'You are an IELTS Academic examiner. Generate reading exercises at the exact band level specified. Return valid JSON only, no markdown, no preamble.',
      user: `Create a Matching Features IELTS Academic reading exercise for a Band ${band} student.

RULES:
- The passage discusses exactly 3 distinct people, researchers, or organisations (the "features").
- Each of the 5 questions is a statement attributed to one of the 3 features.
- Answers must be one of the exact feature names (e.g. "Dr Smith").
- Each feature must be used at least once but does NOT need to be used equally.

Return ONLY this JSON:
{
  "passage": "3 paragraphs of academic prose (170–220 words total) discussing 3 named people/researchers",
  "topic": "2-4 word topic label",
  "features": ["Feature One", "Feature Two", "Feature Three"],
  "questions": [
    {"id": 1, "text": "statement attributed to one feature", "answer": "Feature One", "explanation": "The passage states that Feature One..."},
    {"id": 2, "text": "statement attributed to one feature", "answer": "Feature Two", "explanation": "Feature Two is described as..."},
    {"id": 3, "text": "statement attributed to one feature", "answer": "Feature Three", "explanation": "Feature Three..."},
    {"id": 4, "text": "statement attributed to one feature", "answer": "Feature One", "explanation": "Feature One also..."},
    {"id": 5, "text": "statement attributed to one feature", "answer": "Feature Two", "explanation": "Feature Two further..."}
  ]
}`,
    };
  } else if (isMatchingHeadingsSession) {
    prompt = {
      model: 'gpt-4o',
      system: 'You are an IELTS Academic examiner. Generate reading exercises at the exact band level specified. Return valid JSON only, no markdown, no preamble.',
      user: `Create a Matching Headings IELTS Academic reading exercise for a Band ${band} student.

RULES:
- The passage must have exactly 5 labeled paragraphs: A, B, C, D, E.
- Provide exactly 7 headings numbered 1–7: 5 correct (one per paragraph) + 2 distractors.
- Distractors must seem plausible but focus on a detail, not the paragraph's main idea.
- Each question asks which heading (1–7) best matches the paragraph's main idea.
- "answer" must be the heading number as a string ("1", "2", etc.).

Return ONLY this JSON:
{
  "passage": "A. First paragraph (60–80 words)\\n\\nB. Second paragraph (60–80 words)\\n\\nC. Third paragraph (60–80 words)\\n\\nD. Fourth paragraph (60–80 words)\\n\\nE. Fifth paragraph (60–80 words)",
  "topic": "2-4 word topic label",
  "headings": [
    {"id": 1, "text": "Heading matching paragraph A"},
    {"id": 2, "text": "Heading matching paragraph B"},
    {"id": 3, "text": "Heading matching paragraph C"},
    {"id": 4, "text": "Heading matching paragraph D"},
    {"id": 5, "text": "Heading matching paragraph E"},
    {"id": 6, "text": "Distractor heading — detail from passage, not main idea"},
    {"id": 7, "text": "Distractor heading — related topic not covered"}
  ],
  "questions": [
    {"id": 1, "text": "Paragraph A", "answer": "1", "explanation": "Heading 1 matches paragraph A because..."},
    {"id": 2, "text": "Paragraph B", "answer": "2", "explanation": "Heading 2 matches paragraph B because..."},
    {"id": 3, "text": "Paragraph C", "answer": "3", "explanation": "Heading 3 matches paragraph C because..."},
    {"id": 4, "text": "Paragraph D", "answer": "4", "explanation": "Heading 4 matches paragraph D because..."},
    {"id": 5, "text": "Paragraph E", "answer": "5", "explanation": "Heading 5 matches paragraph E because..."}
  ]
}`,
    };
  } else if (isShortAnswerSession) {
    prompt = {
      model: 'gpt-4o',
      system: 'You are an IELTS Academic examiner. Generate reading exercises at the exact band level specified. Return valid JSON only, no markdown, no preamble.',
      user: `Create a Short Answer IELTS Academic reading exercise for a Band ${band} student.

RULES:
- Each question requires an answer of NO MORE THAN THREE WORDS taken directly from the passage.
- The answer must be the exact words from the passage — no paraphrasing.
- Questions should require scanning the passage carefully, not just skimming.
- Display the word limit reminder in the question text.

Return ONLY this JSON:
{
  "passage": "3 paragraphs of academic prose on any interesting topic (170-220 words total)",
  "topic": "2-4 word topic label",
  "questions": [
    {"id": 1, "text": "Question? (NO MORE THAN THREE WORDS)", "answer": "exact words from passage", "explanation": "which passage sentence contains the answer", "keySentence": "exact sentence from passage"},
    {"id": 2, "text": "Question? (NO MORE THAN THREE WORDS)", "answer": "exact words from passage", "explanation": "...", "keySentence": "..."},
    {"id": 3, "text": "Question? (NO MORE THAN THREE WORDS)", "answer": "exact words from passage", "explanation": "...", "keySentence": "..."},
    {"id": 4, "text": "Question? (NO MORE THAN THREE WORDS)", "answer": "exact words from passage", "explanation": "...", "keySentence": "..."},
    {"id": 5, "text": "Question? (NO MORE THAN THREE WORDS)", "answer": "exact words from passage", "explanation": "...", "keySentence": "..."}
  ]
}`,
    };
  } else if (isSentenceCompSession) {
    prompt = {
      model: 'gpt-4o',
      system: 'You are an IELTS Academic examiner. Generate reading exercises at the exact band level specified. Return valid JSON only, no markdown, no preamble.',
      user: `Create a Sentence Completion IELTS Academic reading exercise for a Band ${band} student.

RULES:
- Each question is an incomplete sentence. The gap must be filled with NO MORE THAN THREE WORDS taken directly from the passage.
- The answer must be the exact words from the passage — no paraphrasing.
- The sentence stem should paraphrase the passage so the student must scan for the answer.

Return ONLY this JSON:
{
  "passage": "3 paragraphs of academic prose on any interesting topic (170-220 words total)",
  "topic": "2-4 word topic label",
  "questions": [
    {"id": 1, "text": "Incomplete sentence with _____ gap.", "answer": "exact words from passage", "explanation": "which passage sentence contains the answer", "keySentence": "exact sentence from passage"},
    {"id": 2, "text": "...", "answer": "...", "explanation": "...", "keySentence": "..."},
    {"id": 3, "text": "...", "answer": "...", "explanation": "...", "keySentence": "..."},
    {"id": 4, "text": "...", "answer": "...", "explanation": "...", "keySentence": "..."},
    {"id": 5, "text": "...", "answer": "...", "explanation": "...", "keySentence": "..."}
  ]
}`,
    };
  } else if (isSCSession) {
    prompt = {
      model: 'gpt-4o',
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
      model: 'gpt-4o',
      system: 'You are an IELTS Academic examiner. Generate reading exercises at the exact band level specified. Return valid JSON only, no markdown, no preamble.',
      user: `Create a True/False/Not Given IELTS Academic reading exercise for a Band ${band} student using CONSTRAINED MUTATION generation.

ANSWER FORMAT RULES (mandatory):
- The "answer" field must contain exactly one of: True, False, or NG. Nothing else.
- Never use pipe-separated formats like "True|False". Never use option labels like A/B/C.
- Every explanation must name the specific word, phrase, or logical feature that determines the answer. Never explain by location alone.

LOGIC TAG RULES (mandatory for every question):
Each question must be generated by applying exactly one of these five mutation types to a specific sentence in the passage:
- SYNONYM_SUBSTITUTION — replace a key word in a passage sentence with a near-synonym; the statement looks equivalent but the substitution is not exact. Answer: True (if synonym is accurate) or False (if synonym shifts meaning). DIRECT_CONFIRMATION synonym rule: The synonym in the statement must be a precise linguistic equivalent — not a semantic cousin or related concept. Acceptable: protect = defend, decrease = reduce, begin = commence. Not acceptable: pathogen = disease, cause = result, treatment = cure. If no precise synonym exists, use direct paraphrase of the exact passage sentence.
- CAUTIOUS_LANGUAGE — the passage uses hedging words (may, suggests, could, tends to, appears to). The statement either drops the hedge (overclaims) → False, or the hedge is preserved → True.
- NEGATION_INVERSION — passage contains a negation (not, never, rarely, without, fails to). Statement either flips the negation → False, or preserves it → True.
- SCOPE_QUALIFIER — passage uses a scope limiter (some, most, certain, several, under specific conditions). Statement makes an absolute or broader claim → False or NG.
- CAUSAL_ASSUMPTION — passage describes a sequence or correlation. Statement infers causation that is not stated → NG.

For each question, set:
- "logicType": exactly one of the five types above (UPPER_SNAKE_CASE)
- "passageAnchor": the EXACT sentence from the passage (copy it verbatim) that the question is derived from
- "errorReason": the corresponding student reasoning trap (synonymTrap | cautiousLanguageMissed | negationOverlooked | scopeError | notGivenMarkedFalse)

QUESTION DISTRIBUTION: Use each logic type exactly once across the 5 questions. Cover at least 2 different answer types (True, False, NG).

SELF-VERIFICATION (do this before returning):
1. For each question, confirm the answer is exactly one word: True, False, or NG.
2. For each explanation, confirm it names a specific word or phrase — not just a paragraph number.
3. For NG answers, confirm the passage is genuinely silent on the claim (not just ambiguous).
4. Confirm passageAnchor is copied verbatim from the passage — do not paraphrase it.

Return ONLY this JSON:
{
  "passage": "3 paragraphs of academic prose on any interesting topic (170-220 words total)",
  "topic": "2-4 word topic label",
  "questions": [
    {"id": 1, "text": "statement", "answer": "True",  "explanation": "name the exact word/phrase", "keySentence": "exact sentence from passage", "errorReason": "synonymTrap",            "logicType": "SYNONYM_SUBSTITUTION", "passageAnchor": "exact verbatim sentence from passage"},
    {"id": 2, "text": "statement", "answer": "False", "explanation": "name the exact word/phrase", "keySentence": "exact sentence from passage", "errorReason": "cautiousLanguageMissed", "logicType": "CAUTIOUS_LANGUAGE",    "passageAnchor": "exact verbatim sentence from passage"},
    {"id": 3, "text": "statement", "answer": "NG",    "explanation": "name what passage says/omits", "keySentence": "exact sentence from passage", "errorReason": "notGivenMarkedFalse", "logicType": "CAUSAL_ASSUMPTION",    "passageAnchor": "exact verbatim sentence from passage"},
    {"id": 4, "text": "statement", "answer": "False", "explanation": "name the exact word/phrase", "keySentence": "exact sentence from passage", "errorReason": "negationOverlooked",    "logicType": "NEGATION_INVERSION",   "passageAnchor": "exact verbatim sentence from passage"},
    {"id": 5, "text": "statement", "answer": "False", "explanation": "name the exact word/phrase", "keySentence": "exact sentence from passage", "errorReason": "scopeError",            "logicType": "SCOPE_QUALIFIER",      "passageAnchor": "exact verbatim sentence from passage"}
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

    // ── Logic Tag Validation ───────────────────────────────────────────────────
    // For TFNG sessions only: verify every question has a valid logicType and
    // a passageAnchor that is a verbatim substring of the passage.
    // On failure, regenerate once with an explicit correction instruction.
    if (!isSCSession && !isYNNGSession && !isMCSession && !isSentenceCompSession &&
        !isMatchingInfoSession && !isMatchingFeaturesSession && !isMatchingHeadingsSession && !isShortAnswerSession) {
      try {
        const tagsOk = validateLogicTags(parsed.passage, parsed.questions);
        if (!tagsOk) {
          console.log('Logic Tag validation failed — regenerating once.');
          const retryPrompt = {
            ...prompt,
            user: prompt.user + '\n\nCRITICAL FIX REQUIRED: Previous response failed Logic Tag validation. Every question MUST include "logicType" (one of: SYNONYM_SUBSTITUTION, CAUTIOUS_LANGUAGE, NEGATION_INVERSION, SCOPE_QUALIFIER, CAUSAL_ASSUMPTION) and "passageAnchor" copied verbatim from the passage. Each logicType must be used exactly once.',
          };
          const retryRaw    = await callAI(retryPrompt);
          const retryParsed = parseAIJson(retryRaw);
          if (validateLogicTags(retryParsed.passage, retryParsed.questions)) {
            parsed = retryParsed;
            sessionLogicValidationPassed = true;
          }
          // if retry also fails, keep original parsed — validation flag stays false
        } else {
          sessionLogicValidationPassed = true;
        }
      } catch { /* non-fatal — continue with original parsed */ }
    }
    // ──────────────────────────────────────────────────────────────────────────

    sessionPassage = parsed.passage;
    sessionTopic   = parsed.topic || 'Reading';

    if (isSCSession) {
      sessionQuestions = parsed.questions;
      sessionSummary   = parsed.summaryText || '';
      sessionWordBank  = parsed.wordBank    || [];
      renderSCSession(parsed);
    } else if (isYNNGSession) {
      // Verify answers before display (non-fatal)
      let verified = { questions: parsed.questions, corrections: [] };
      try {
        verified = await verifyAnswers(parsed.passage, parsed.questions, API_URL);
        sessionIsVerified = true;
      } catch { /* non-fatal */ }
      sessionQuestions   = verified.questions;
      sessionCorrections = verified.corrections;
      buildToughLove(verified.questions, parsed.passage);
      renderYNNGSession({ ...parsed, questions: verified.questions });
    } else if (isMCSession) {
      sessionQuestions = parsed.questions;
      renderMCSession(parsed);
    } else if (isSentenceCompSession) {
      sessionQuestions = parsed.questions;
      renderSentenceCompletionSession(parsed);
    } else if (isMatchingInfoSession) {
      sessionQuestions = parsed.questions;
      renderMatchingInfoSession(parsed);
    } else if (isMatchingFeaturesSession) {
      sessionMatchingFeatures = parsed.features || [];
      sessionQuestions = parsed.questions;
      renderMatchingFeaturesSession(parsed);
    } else if (isMatchingHeadingsSession) {
      sessionMatchingHeadings = parsed.headings || [];
      sessionQuestions = parsed.questions;
      renderMatchingHeadingsSession(parsed);
    } else if (isShortAnswerSession) {
      sessionQuestions = parsed.questions;
      renderShortAnswerSession(parsed);
    } else {
      // Run the Answer Verification Agent before showing anything to the student.
      let verified = { questions: parsed.questions, corrections: [] };
      try {
        verified = await verifyAnswers(parsed.passage, parsed.questions, API_URL);
        sessionIsVerified = true;
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
  if (isRight === true) {
    rf.innerHTML = `✅ Correct. ${renderReasoningHtml(q, true)}`;
  } else {
    const ERROR_REASON_PILLS = {
      synonymTrap:             'Synonym trap — passage isn\'t as direct as it looks',
      directContradiction:     'Direct contradiction — passage says the opposite',
      notGivenNoEvidence:      'Not Given — topic present but this claim is never made',
      concessive:              'Concessive trap — the "although" clause is the trap',
      notGivenTopicAdjacent:   'Not Given — related topic, but this exact claim is absent',
      cautiousLanguageMissed:  'Cautious language — may / suggests / could',
      negationOverlooked:      'Negation — not / never / rarely',
      scopeError:              'Scope error — all vs some, always vs usually',
      notGivenMarkedFalse:     'Not Given ≠ False — the passage is silent on this',
      other:                   'Reasoning error',
    };
    const pill = ERROR_REASON_PILLS[q.errorReason];
    rf.innerHTML = `❌ The answer is <strong>${q.answer}</strong>. ${renderReasoningHtml(q, false)}`
      + (pill ? `<br><span class="error-reason-pill">⚠ ${pill}</span>` : '');
  }
  setTimeout(() => rf.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);

  if (Object.keys(sessionAnswers).length >= sessionQuestions.length) {
    document.getElementById('btn-reading-submit').disabled = false;
  }
};

// ── Y/N/NG RENDERER ───────────────────────────────────────────────
export function renderYNNGSession(parsed) {
  document.getElementById('reading-intro-msg').textContent =
    "Read the passage carefully. The author expresses opinions — decide if each statement matches the writer's view.";
  document.getElementById('reading-q-label').textContent = 'Yes / No / Not Given';
  document.getElementById('reading-q-instructions').innerHTML =
    '<strong>Yes</strong> = writer agrees · <strong>No</strong> = writer disagrees · <strong>Not Given</strong> = writer doesn\'t address this';

  document.getElementById('reading-passage').innerHTML = (parsed.passage || '')
    .split('\n').filter(p => p.trim()).map(p => `<p>${p}</p>`).join('');

  document.getElementById('questions-container').innerHTML = (parsed.questions || []).map(q => `
    <div class="q-block" id="qb${q.id}">
      <div class="q-num">${q.id}</div>
      <div class="q-text">${q.text}</div>
      <div class="q-sub">Does this match the writer's view?</div>
      <div class="tfng" id="tfng${q.id}">
        <button class="tfng-btn" onclick="answerYNNG(${q.id},'Yes')"       data-v="Yes">✓ Yes</button>
        <button class="tfng-btn" onclick="answerYNNG(${q.id},'No')"        data-v="No">✗ No</button>
        <button class="tfng-btn" onclick="answerYNNG(${q.id},'Not Given')" data-v="Not Given">? Not Given</button>
      </div>
      <div class="result-flash" id="rf${q.id}"></div>
    </div>
  `).join('');
}

window.answerYNNG = function (qnum, val) {
  if (sessionAnswers[qnum]) return;
  const q = sessionQuestions.find(x => x.id === qnum);
  if (!q) return;

  trackQAnswer(qnum);
  trackQStart(qnum + 1);

  const isRight = normaliseAnswer(val) === normaliseAnswer(q.answer);
  sessionAnswers[qnum] = { val, isRight };
  if (isRight) sessionCorrect++;

  document.querySelectorAll(`#tfng${qnum} .tfng-btn`).forEach(b => {
    b.disabled = true;
    if      (normaliseAnswer(b.dataset.v) === normaliseAnswer(q.answer)) b.classList.add('correct');
    else if (normaliseAnswer(b.dataset.v) === normaliseAnswer(val) && !isRight) b.classList.add('wrong');
  });

  const rf = document.getElementById(`rf${qnum}`);
  rf.classList.add('show', isRight ? 'good' : 'bad');
  rf.innerHTML = isRight
    ? `✅ Correct. ${renderMarkdown(q.explanation || '')}`
    : `❌ The answer is <strong>${q.answer}</strong>. ${renderMarkdown(q.explanation || '')}`;
  setTimeout(() => rf.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);

  if (Object.keys(sessionAnswers).length >= sessionQuestions.length) {
    document.getElementById('btn-reading-submit').disabled = false;
  }
};

// ── READING MULTIPLE CHOICE RENDERER ─────────────────────────────
export function renderMCSession(parsed) {
  document.getElementById('reading-intro-msg').textContent =
    'Read the passage carefully, then choose the best answer for each question.';
  document.getElementById('reading-q-label').textContent = 'Multiple Choice';
  document.getElementById('reading-q-instructions').innerHTML =
    'Choose the <strong>best answer</strong> — only one option is correct.';

  document.getElementById('reading-passage').innerHTML = (parsed.passage || '')
    .split('\n').filter(p => p.trim()).map(p => `<p>${p}</p>`).join('');

  document.getElementById('questions-container').innerHTML = (parsed.questions || []).map(q => {
    const optionsHtml = (q.options || []).map(opt =>
      `<button class="mc-option" data-v="${opt.label}" onclick="answerMC(${q.id},'${opt.label}')">
        <span class="mc-label">${opt.label}</span>
        <span>${opt.text}</span>
      </button>`
    ).join('');
    return `
      <div class="q-block" id="qb${q.id}">
        <div class="q-num">${q.id}</div>
        <div class="q-text">${q.text}</div>
        <div id="mc${q.id}" style="margin-top:10px">${optionsHtml}</div>
        <div class="result-flash" id="rf${q.id}"></div>
      </div>`;
  }).join('');
}

window.answerMC = function (qnum, val) {
  if (sessionAnswers[qnum]) return;
  const q = sessionQuestions.find(x => x.id === qnum);
  if (!q) return;

  trackQAnswer(qnum);
  trackQStart(qnum + 1);

  const isRight = normaliseAnswer(val) === normaliseAnswer(q.answer);
  sessionAnswers[qnum] = { val, isRight };
  if (isRight) sessionCorrect++;

  document.querySelectorAll(`#mc${qnum} .mc-option`).forEach(b => {
    b.disabled = true;
    if      (normaliseAnswer(b.dataset.v) === normaliseAnswer(q.answer)) b.classList.add('correct');
    else if (normaliseAnswer(b.dataset.v) === normaliseAnswer(val) && !isRight) b.classList.add('wrong');
  });

  const rf = document.getElementById(`rf${qnum}`);
  rf.classList.add('show', isRight ? 'good' : 'bad');
  rf.innerHTML = isRight
    ? `✅ Correct.`
    : `❌ The answer is <strong>${q.answer}</strong>. ${renderMarkdown(q.explanation || '')}`;
  setTimeout(() => rf.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);

  if (Object.keys(sessionAnswers).length >= sessionQuestions.length) {
    document.getElementById('btn-reading-submit').disabled = false;
  }
};

// ── SENTENCE COMPLETION RENDERER ──────────────────────────────────
export function renderSentenceCompletionSession(parsed) {
  document.getElementById('reading-intro-msg').textContent =
    'Read the passage carefully, then complete each sentence using words directly from the passage.';
  document.getElementById('reading-q-label').textContent = 'Sentence Completion';
  document.getElementById('reading-q-instructions').innerHTML =
    'Use words <strong>directly from the passage</strong>. No more than <strong>THREE WORDS</strong> per gap.';

  document.getElementById('reading-passage').innerHTML = (parsed.passage || '')
    .split('\n').filter(p => p.trim()).map(p => `<p>${p}</p>`).join('');

  document.getElementById('questions-container').innerHTML = (parsed.questions || []).map(q => `
    <div class="q-block" id="qb${q.id}">
      <div class="q-num">${q.id}</div>
      <div class="q-text">${q.text.replace('_____', '<span style="background:#E8E5FF;padding:2px 8px;border-radius:4px;font-style:italic;color:var(--accent)">_____</span>')}</div>
      <div style="margin-top:10px">
        <input type="text" id="sentcomp-input-${q.id}" placeholder="Type your answer…"
          style="width:100%;padding:12px 14px;border-radius:10px;border:1.5px solid var(--border);font-size:14px;color:var(--text);background:#fff;box-sizing:border-box;font-family:inherit"
          oninput="onSentenceCompInput()" />
      </div>
      <div class="result-flash" id="rf${q.id}"></div>
    </div>
  `).join('');
}

window.onSentenceCompInput = function () {
  const allFilled = sessionQuestions.every(q => {
    const el = document.getElementById(`sentcomp-input-${q.id}`);
    return el && el.value.trim() !== '';
  });
  document.getElementById('btn-reading-submit').disabled = !allFilled;
};

function submitSentenceComp() {
  sessionCorrect = 0;
  sessionQuestions.forEach(q => {
    const el      = document.getElementById(`sentcomp-input-${q.id}`);
    const val     = el ? el.value.trim() : '';
    const correct = q.answer || '';
    const isRight = normaliseAnswer(val) === normaliseAnswer(correct);
    if (isRight) sessionCorrect++;
    sessionAnswers[q.id] = { val, isRight };
    if (el) {
      el.disabled = true;
      el.style.borderColor = isRight ? 'var(--success)' : 'var(--danger)';
    }
    const rf = document.getElementById(`rf${q.id}`);
    if (rf) {
      rf.classList.add('show', isRight ? 'good' : 'bad');
      rf.innerHTML = isRight
        ? `✅ Correct.`
        : `❌ Answer: <strong>${q.answer}</strong>. ${renderMarkdown(q.explanation || '')}`;
    }
  });

  const btn = document.getElementById('btn-reading-submit');
  btn.textContent = 'Continue to notebook →';
  btn.disabled = false;
  btn.onclick = () => finishReadingSession();
  window.scrollTo(0, document.body.scrollHeight);
}

// ── MATCHING INFORMATION RENDERER ────────────────────────────────
export function renderMatchingInfoSession(parsed) {
  document.getElementById('reading-intro-msg').textContent =
    'Read the passage carefully. The passage is divided into sections A–E. Match each piece of information to the correct section.';
  document.getElementById('reading-q-label').textContent = 'Matching Information';
  document.getElementById('reading-q-instructions').innerHTML =
    'For each statement, tap the <strong>section letter</strong> (A–E) that contains that information.';

  document.getElementById('reading-passage').innerHTML = (parsed.passage || '')
    .split('\n').filter(p => p.trim()).map(p => `<p>${p}</p>`).join('');

  const sectionLabels = ['A', 'B', 'C', 'D', 'E'];
  document.getElementById('questions-container').innerHTML = (parsed.questions || []).map(q => {
    const btns = sectionLabels.map(l =>
      `<button class="tfng-btn" data-v="${l}" onclick="answerMatchingInfo(${q.id},'${l}')">${l}</button>`
    ).join('');
    return `
      <div class="q-block" id="qb${q.id}">
        <div class="q-num">${q.id}</div>
        <div class="q-text">${q.text}</div>
        <div class="q-sub">Which section contains this information?</div>
        <div class="tfng" id="mi${q.id}">${btns}</div>
        <div class="result-flash" id="rf${q.id}"></div>
      </div>`;
  }).join('');
}

window.answerMatchingInfo = function (qnum, val) {
  if (sessionAnswers[qnum]) return;
  const q = sessionQuestions.find(x => x.id === qnum);
  if (!q) return;
  trackQAnswer(qnum); trackQStart(qnum + 1);
  const isRight = val === q.answer;
  sessionAnswers[qnum] = { val, isRight };
  if (isRight) sessionCorrect++;
  document.querySelectorAll(`#mi${qnum} .tfng-btn`).forEach(b => {
    b.disabled = true;
    if (b.dataset.v === q.answer)         b.classList.add('correct');
    else if (b.dataset.v === val && !isRight) b.classList.add('wrong');
  });
  const rf = document.getElementById(`rf${qnum}`);
  rf.classList.add('show', isRight ? 'good' : 'bad');
  rf.innerHTML = isRight
    ? `✅ Correct. ${renderMarkdown(q.explanation || '')}`
    : `❌ The answer is <strong>${q.answer}</strong>. ${renderMarkdown(q.explanation || '')}`;
  setTimeout(() => rf.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);
  if (Object.keys(sessionAnswers).length >= sessionQuestions.length) {
    document.getElementById('btn-reading-submit').disabled = false;
  }
};

// ── MATCHING FEATURES RENDERER ────────────────────────────────────
export function renderMatchingFeaturesSession({ passage, questions, features }) {
  document.getElementById('reading-intro-msg').textContent =
    'Read the passage carefully. Match each statement to the correct person or category.';
  document.getElementById('reading-q-label').textContent = 'Matching Features';
  document.getElementById('reading-q-instructions').innerHTML =
    'Tap the <strong>name or category</strong> that each statement refers to.';

  document.getElementById('reading-passage').innerHTML = (passage || '')
    .split('\n').filter(p => p.trim()).map(p => `<p>${p}</p>`).join('');

  const featureList = features || sessionMatchingFeatures;
  document.getElementById('questions-container').innerHTML = (questions || []).map(q => {
    const btns = featureList.map(f =>
      `<button class="mc-option" data-v="${f}" onclick="answerMatchingFeatures(${q.id},this)">
        <span>${f}</span>
      </button>`
    ).join('');
    return `
      <div class="q-block" id="qb${q.id}">
        <div class="q-num">${q.id}</div>
        <div class="q-text">${q.text}</div>
        <div id="mf${q.id}" style="margin-top:10px">${btns}</div>
        <div class="result-flash" id="rf${q.id}"></div>
      </div>`;
  }).join('');
}

window.answerMatchingFeatures = function (qnum, btn) {
  if (sessionAnswers[qnum]) return;
  const q = sessionQuestions.find(x => x.id === qnum);
  if (!q) return;
  const val = btn.dataset.v;
  trackQAnswer(qnum); trackQStart(qnum + 1);
  const isRight = val === q.answer;
  sessionAnswers[qnum] = { val, isRight };
  if (isRight) sessionCorrect++;
  document.querySelectorAll(`#mf${qnum} .mc-option`).forEach(b => {
    b.disabled = true;
    if (b.dataset.v === q.answer)             b.classList.add('correct');
    else if (b.dataset.v === val && !isRight) b.classList.add('wrong');
  });
  const rf = document.getElementById(`rf${qnum}`);
  rf.classList.add('show', isRight ? 'good' : 'bad');
  rf.innerHTML = isRight
    ? `✅ Correct. ${renderMarkdown(q.explanation || '')}`
    : `❌ The answer is <strong>${q.answer}</strong>. ${renderMarkdown(q.explanation || '')}`;
  setTimeout(() => rf.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);
  if (Object.keys(sessionAnswers).length >= sessionQuestions.length) {
    document.getElementById('btn-reading-submit').disabled = false;
  }
};

// ── MATCHING HEADINGS RENDERER ────────────────────────────────────
const ROMAN = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x'];

export function renderMatchingHeadingsSession({ passage, questions, headings, paragraphs }) {
  document.getElementById('reading-intro-msg').textContent =
    'Read the passage. Choose the best heading for each paragraph from the list below.';
  document.getElementById('reading-q-label').textContent = 'Matching Headings';
  document.getElementById('reading-q-instructions').innerHTML =
    'Select one heading per paragraph. Each heading can only be used <strong>once</strong>.';

  const headingList = headings || sessionMatchingHeadings;
  const headingHtml = headingList.map(h =>
    `<div style="margin:4px 0;font-size:13px"><span style="font-weight:700;color:var(--accent);min-width:20px;display:inline-block">${ROMAN[h.id - 1]}</span> ${h.text}</div>`
  ).join('');

  const selectOpts = headingList.map(h =>
    `<option value="${h.id}">${ROMAN[h.id - 1]}: ${h.text.length > 55 ? h.text.slice(0, 55) + '…' : h.text}</option>`
  ).join('');

  // If paragraphs extraData available, show them individually; otherwise use passage text
  const passageHtml = (paragraphs && paragraphs.length)
    ? paragraphs.map(p => `<p><strong>${p.label}.</strong> ${p.text}</p>`).join('')
    : (passage || '').split('\n').filter(p => p.trim()).map(p => `<p>${p}</p>`).join('');

  document.getElementById('reading-passage').innerHTML = passageHtml;

  document.getElementById('questions-container').innerHTML = `
    <div style="background:#F4F4F9;border-radius:10px;padding:12px 14px;margin-bottom:16px">
      <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">List of Headings</div>
      ${headingHtml}
    </div>
    ${(questions || []).map(q => `
      <div class="q-block" id="qb${q.id}">
        <div class="q-num">${q.id}</div>
        <div class="q-text">${q.text}</div>
        <select id="mh-sel-${q.id}" class="sc-gap-select" onchange="onMatchingHeadingsChange()"
          style="margin-top:10px;width:100%;padding:10px 12px;border-radius:8px;border:1.5px solid var(--border);font-size:13px;background:#fff;color:var(--text);font-family:inherit">
          <option value="">— Select a heading —</option>
          ${selectOpts}
        </select>
        <div class="result-flash" id="rf${q.id}"></div>
      </div>`).join('')}`;
}

window.onMatchingHeadingsChange = function () {
  const allFilled = sessionQuestions.every(q => {
    const el = document.getElementById(`mh-sel-${q.id}`);
    return el && el.value !== '';
  });
  document.getElementById('btn-reading-submit').disabled = !allFilled;
};

function submitMatchingHeadings() {
  sessionCorrect = 0;
  sessionQuestions.forEach(q => {
    const el      = document.getElementById(`mh-sel-${q.id}`);
    const val     = el ? el.value : '';
    const isRight = val === q.answer;
    if (isRight) sessionCorrect++;
    sessionAnswers[q.id] = { val, isRight };
    if (el) { el.disabled = true; el.style.borderColor = isRight ? 'var(--success)' : 'var(--danger)'; }
    const rf = document.getElementById(`rf${q.id}`);
    if (rf) {
      const chosenHeading = sessionMatchingHeadings.find(h => String(h.id) === val);
      const correctHeading = sessionMatchingHeadings.find(h => String(h.id) === q.answer);
      rf.classList.add('show', isRight ? 'good' : 'bad');
      rf.innerHTML = isRight
        ? `✅ Correct. ${renderMarkdown(q.explanation || '')}`
        : `❌ The correct heading is <strong>${correctHeading ? ROMAN[correctHeading.id - 1] + ': ' + correctHeading.text : q.answer}</strong>. ${renderMarkdown(q.explanation || '')}`;
    }
  });
  const btn = document.getElementById('btn-reading-submit');
  btn.textContent = 'Continue to notebook →';
  btn.disabled = false;
  btn.onclick = () => finishReadingSession();
  window.scrollTo(0, document.body.scrollHeight);
}

// ── SHORT ANSWER RENDERER ─────────────────────────────────────────
export function renderShortAnswerSession(parsed) {
  document.getElementById('reading-intro-msg').textContent =
    'Read the passage carefully, then answer each question using words directly from the passage.';
  document.getElementById('reading-q-label').textContent = 'Short Answer';
  document.getElementById('reading-q-instructions').innerHTML =
    'Use words <strong>directly from the passage</strong>. <strong>NO MORE THAN THREE WORDS</strong> per answer.';

  document.getElementById('reading-passage').innerHTML = (parsed.passage || '')
    .split('\n').filter(p => p.trim()).map(p => `<p>${p}</p>`).join('');

  document.getElementById('questions-container').innerHTML = (parsed.questions || []).map(q => `
    <div class="q-block" id="qb${q.id}">
      <div class="q-num">${q.id}</div>
      <div class="q-text">${q.text}</div>
      <div style="margin-top:10px">
        <input type="text" id="sa-input-${q.id}" placeholder="Type your answer (max 3 words)…"
          style="width:100%;padding:12px 14px;border-radius:10px;border:1.5px solid var(--border);font-size:14px;color:var(--text);background:#fff;box-sizing:border-box;font-family:inherit"
          oninput="onShortAnswerInput()" />
      </div>
      <div class="result-flash" id="rf${q.id}"></div>
    </div>
  `).join('');
}

window.onShortAnswerInput = function () {
  const allFilled = sessionQuestions.every(q => {
    const el = document.getElementById(`sa-input-${q.id}`);
    return el && el.value.trim() !== '';
  });
  document.getElementById('btn-reading-submit').disabled = !allFilled;
};

function submitShortAnswer() {
  sessionCorrect = 0;
  sessionQuestions.forEach(q => {
    const el      = document.getElementById(`sa-input-${q.id}`);
    const val     = el ? el.value.trim() : '';
    const correct = q.answer || '';
    const isRight = normaliseAnswer(val) === normaliseAnswer(correct);
    if (isRight) sessionCorrect++;
    sessionAnswers[q.id] = { val, isRight };
    if (el) {
      el.disabled = true;
      el.style.borderColor = isRight ? 'var(--success)' : 'var(--danger)';
    }
    const rf = document.getElementById(`rf${q.id}`);
    if (rf) {
      rf.classList.add('show', isRight ? 'good' : 'bad');
      rf.innerHTML = isRight
        ? `✅ Correct.`
        : `❌ Answer: <strong>${q.answer}</strong>. ${renderMarkdown(q.explanation || '')}`;
    }
  });
  const btn = document.getElementById('btn-reading-submit');
  btn.textContent = 'Continue to notebook →';
  btn.disabled = false;
  btn.onclick = () => finishReadingSession();
  window.scrollTo(0, document.body.scrollHeight);
}

window.submitReading = function () {
  if (isSCSession || isSentenceCompSession || isShortAnswerSession || isMatchingHeadingsSession) {
    if (isSentenceCompSession)      { submitSentenceComp();       return; }
    if (isShortAnswerSession)       { submitShortAnswer();        return; }
    if (isMatchingHeadingsSession)  { submitMatchingHeadings();   return; }
    submitSCSession();
    return;
  }

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
      servedFromBank:     sessionFromBank,
      bankSetId:          sessionBankSetId,
      ...(sessionCorrections.length    ? { answerCorrections: sessionCorrections }   : {}),
      ...(sessionPassageQuality        ? { passageQuality: sessionPassageQuality }   : {}),
      // Only log logic-type metadata for T/F/NG sessions (where it is generated)
      ...(!isSCSession && !isYNNGSession && !isMCSession && !isSentenceCompSession &&
          !isMatchingInfoSession && !isMatchingFeaturesSession && !isMatchingHeadingsSession && !isShortAnswerSession && sessionQuestions.length ? {
        logicTypes:           sessionQuestions.map(q => ({ id: q.id, logicType: q.logicType || null })),
        passageAnchors:       sessionQuestions.map(q => ({ id: q.id, passageAnchor: q.passageAnchor || null })),
        logicValidationPassed: sessionLogicValidationPassed,
        isVerified:            sessionIsVerified,
      } : {}),
      // For YNNG/MC/SC log isVerified without logic types
      ...(isYNNGSession ? { isVerified: sessionIsVerified } : {}),
    });

    const prevCorrect  = Math.round(((prevSkill.accuracy || 0) / 100) * (prevSkill.attempted || 0));
    const newAttempted = (prevSkill.attempted || 0) + total;
    const newAccuracy  = newAttempted > 0
      ? Math.round(((prevCorrect + sessionCorrect) / newAttempted) * 100) : 0;
    const newStreak = (studentData.streak || 0) + 1;
    const subjPath  = `brain.subjects.ielts-academic.skills.${skillId}`;

    // Error reason tagging — TFNG only (all other session types have different error models)
    let errorReasonsUpdate = null;
    if (!isSCSession && !isYNNGSession && !isMCSession && !isSentenceCompSession &&
        !isMatchingInfoSession && !isMatchingFeaturesSession && !isMatchingHeadingsSession && !isShortAnswerSession) {
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
    const questionResults = (!isSCSession && !isMCSession && !isSentenceCompSession &&
      !isMatchingInfoSession && !isMatchingFeaturesSession && !isMatchingHeadingsSession && !isShortAnswerSession)
      ? sessionQuestions.map(q => ({ logicType: q.logicType || null, isRight: sessionAnswers[q.id]?.isRight || false }))
      : null;
    await updateStudentBrain(behaviour, accuracy, skillKey, questionResults);
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
