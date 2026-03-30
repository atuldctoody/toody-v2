// api/synthetic-test.js
// Synthetic Student + Mentor Testing System — Agent 6.
//
// Runs a complete simulated Toody session using two AI agents:
//   - Arjun: a synthetic Band 5.5 student with realistic weaknesses
//   - Mentor: an expert observer who evaluates every interaction
//
// Six steps:
//   1. Generate a TFNG reading session for Arjun
//   2. Mentor evaluates content quality (is this real IELTS standard?)
//   3. Arjun answers questions (probabilistic, profile-based, not random)
//   4. Mentor evaluates Toody's explanations (does the feedback teach?)
//   5. Arjun rates the session (honest student perspective)
//   6. Mentor final verdict (ready for real students?)
//
// Usage: npm run test:synthetic
// ESM module (api/package.json sets "type": "module").

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const API_URL          = 'https://toody-api.vercel.app/api/generate';
const FIREBASE_PROJECT = 'toody-1ab05';
const FIRESTORE_BASE   = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`;

// ── Arjun's profile (hardcoded) ───────────────────────────────────────────────

const ARJUN = {
  name:             'Arjun',
  targetBand:       7.0,
  currentBand:      5.5,
  examDate:         '6 weeks from now',
  weaknesses:       ['Not Given questions', 'reading for meaning instead of evidence', 'misses hedging language'],
  strengths:        ['True questions', 'basic comprehension'],
  behaviourProfile: 'Takes 90+ seconds on NG questions, often changes answer, scrolls back to passage frequently',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function normaliseAnswer(raw) {
  if (raw == null) return '';
  let s = String(raw).toLowerCase().trim().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, '');
  if (s === 'notgiven' || s === 'ng') s = 'notgiven';
  if (s === 'true'  || s === 't')     s = 'true';
  if (s === 'false' || s === 'f')     s = 'false';
  return s;
}

function parseJson(raw) {
  let s = (raw || '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
  return JSON.parse(s);
}

async function callAI(messages, maxTokens = 1000, temperature = 0) {
  const res = await fetch(API_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages,
      max_tokens:  maxTokens,
      temperature,
    }),
  });
  if (!res.ok) throw new Error(`API returned ${res.status}`);
  const data = await res.json();
  const raw  = data.choices?.[0]?.message?.content;
  if (!raw) throw new Error('Empty API response');
  return parseJson(raw);
}

// ── Answer simulation ─────────────────────────────────────────────────────────

// When Arjun gets a question wrong, pick the most plausible wrong answer
// based on his known weaknesses — not random.
function getPlausibleWrongAnswer(correctAnswer, errorReason) {
  const c = normaliseAnswer(correctAnswer);
  if (c === 'notgiven') return 'False';   // Arjun's core weakness: treats silence as contradiction
  if (c === 'false') {
    if (errorReason === 'negationOverlooked') return 'True';  // misses the negation entirely
    return 'NG';                                              // sees partial info, thinks nothing is stated
  }
  if (c === 'true') {
    if (errorReason === 'hedgingMissed')     return 'NG';    // hedging makes him doubt a True answer
    return 'NG';                                              // unsure, defaults to NG
  }
  return 'NG';
}

function simulateArjunAnswers(questions) {
  const accuracy = { true: 0.80, false: 0.70, notgiven: 0.40 };
  return questions.map(q => {
    const correct   = normaliseAnswer(q.answer);
    const threshold = accuracy[correct] ?? 0.65;
    const isCorrect = Math.random() < threshold;
    if (isCorrect) {
      return { questionId: q.id, questionText: q.text, correctAnswer: q.answer,
               arjunAnswer: q.answer, isCorrect: true, errorReason: q.errorReason };
    }
    const wrong = getPlausibleWrongAnswer(q.answer, q.errorReason);
    return { questionId: q.id, questionText: q.text, correctAnswer: q.answer,
             arjunAnswer: wrong, isCorrect: false, errorReason: q.errorReason };
  });
}

// ── Firestore helpers ─────────────────────────────────────────────────────────

function toFirestoreField(v) {
  if (typeof v === 'boolean')               return { booleanValue: v };
  if (typeof v === 'number')                return { doubleValue: v };
  if (v === null || v === undefined)        return { nullValue: 'NULL_VALUE' };
  if (Array.isArray(v))                     return { arrayValue: { values: v.map(toFirestoreField) } };
  if (typeof v === 'object')                return { mapValue: { fields: Object.fromEntries(
    Object.entries(v).map(([k, val]) => [k, toFirestoreField(val)])
  )}};
  return { stringValue: String(v) };
}

// ── Step 1 — Generate session for Arjun ──────────────────────────────────────

async function step1GenerateSession() {
  const system = `You are an IELTS Academic examiner. You are generating content for a specific student.

STUDENT CONTEXT:
- Name: ${ARJUN.name}
- Current band: ${ARJUN.currentBand} | Target band: ${ARJUN.targetBand}
- Exam date: ${ARJUN.examDate}
- Weaknesses: ${ARJUN.weaknesses.join(', ')}
- Strengths: ${ARJUN.strengths.join(', ')}

GENERATION REQUIREMENTS:
- Difficulty must sit between Band ${ARJUN.currentBand} and Band ${ARJUN.targetBand} — challenging but not crushing
- Include at least 2 Not Given questions to target this student's primary weakness
- At least 1 question must hinge on hedging language (may, suggests, could, tends to)
- At least 1 question must use a negation that is easy to overlook
- Every explanation must name the specific word or phrase that determines the answer
- Return valid JSON only, no markdown, no preamble`;

  const user = `Create a True/False/Not Given IELTS Academic reading exercise targeted at ${ARJUN.name}'s weaknesses.

Return ONLY this JSON:
{
  "passage": "3 paragraphs of academic prose (170-220 words)",
  "topic": "2-4 word topic label",
  "questions": [
    {"id":1,"text":"statement","answer":"True","explanation":"name exact word/phrase that confirms","keySentence":"exact sentence from passage","errorReason":"synonymTrap"},
    {"id":2,"text":"statement","answer":"False","explanation":"name exact word/phrase that contradicts","keySentence":"exact sentence","errorReason":"negationOverlooked"},
    {"id":3,"text":"statement","answer":"NG","explanation":"name what passage says and does NOT say","keySentence":"most relevant sentence","errorReason":"notGivenMarkedFalse"},
    {"id":4,"text":"statement","answer":"NG","explanation":"name what passage says and does NOT say","keySentence":"most relevant sentence","errorReason":"hedgingMissed"},
    {"id":5,"text":"statement","answer":"False","explanation":"name exact word/phrase that contradicts","keySentence":"exact sentence","errorReason":"scopeError"}
  ]
}`;

  return await callAI([
    { role: 'system', content: system },
    { role: 'user',   content: user   },
  ], 1500, 0.8);
}

// ── Step 2 — Mentor evaluates content ────────────────────────────────────────

async function step2MentorContentEval(passage, questions, topic) {
  const qList = questions.map(q =>
    `Q${q.id} [${q.answer}]: "${q.text}" | Explanation: "${q.explanation}"`
  ).join('\n');

  return await callAI([
    {
      role: 'system',
      content: `You are an expert IELTS content quality evaluator with 15 years of marking experience. You evaluate whether generated IELTS content meets professional standards. Return valid JSON only.`,
    },
    {
      role: 'user',
      content: `Evaluate this IELTS Academic True/False/Not Given exercise. The target student is Band 5.5, targeting Band 7.0. The content should be challenging but not overwhelming for a Band 5.5 student.

PASSAGE (topic: ${topic}):
${passage}

QUESTIONS:
${qList}

Score each criterion 1–5:
- ieltStandard: Does the passage match real IELTS Academic register, density, and complexity?
- fairAndUnambiguous: Is each question unambiguous with one clear interpretation?
- singleDefensibleAnswer: Is there exactly one defensible correct answer per question?
- difficultyAppropriate: Is difficulty appropriate for Band 5.5–7.0? Not too easy, not crushing?

For each question that scores below 3 on any criterion, add it to flaggedIssues with a specific reason.

Return ONLY this JSON:
{"ieltStandard":4,"fairAndUnambiguous":4,"singleDefensibleAnswer":5,"difficultyAppropriate":4,"avgScore":4.25,"flaggedIssues":[],"passageNote":"brief note on passage quality","overallNote":"one-sentence summary"}`,
    },
  ], 700, 0);
}

// ── Step 3 — Arjun's wrong-answer reasoning ───────────────────────────────────

async function step3ArjunReasoning(passage, questions, answers) {
  const wrongAnswers = answers.filter(a => !a.isCorrect);
  if (!wrongAnswers.length) return { wrongAnswers: [] };

  const wrongList = wrongAnswers.map(a => {
    const q = questions.find(q => q.id === a.questionId);
    return `Q${a.questionId}: "${q?.text}"
  Correct answer: ${a.correctAnswer} | Arjun answered: ${a.arjunAnswer}
  Question trap type: ${a.errorReason}`;
  }).join('\n\n');

  return await callAI([
    {
      role: 'system',
      content: `You are ${ARJUN.name}, a Band ${ARJUN.currentBand} IELTS student taking a practice test.

YOUR PROFILE:
- Weaknesses: ${ARJUN.weaknesses.join(', ')}
- Behaviour: ${ARJUN.behaviourProfile}

You just answered some questions incorrectly. For each wrong answer, explain your genuine thought process in first person — what you were thinking when you chose your answer, why it seemed right to you, and what you missed. Write as a real student would: uncertain, making plausible mistakes, not technical. Maximum 2 sentences per answer. Return valid JSON only.`,
    },
    {
      role: 'user',
      content: `PASSAGE:
${passage}

WRONG ANSWERS TO EXPLAIN:
${wrongList}

Return ONLY this JSON:
{"wrongAnswers":[{"questionId":1,"arjunThought":"what I was thinking when I chose the wrong answer"}]}`,
    },
  ], 600, 0.7);
}

// ── Step 4 — Mentor evaluates Toody's explanations ───────────────────────────

async function step4MentorExplanationEval(questions, answers, wrongReasonMap) {
  const evalList = questions.map(q => {
    const a = answers.find(a => a.questionId === q.id);
    const arjunWrong = a && !a.isCorrect;
    const arjunThought = wrongReasonMap[q.id] || null;
    return `Q${q.id} [correct: ${q.answer} | Arjun: ${a?.arjunAnswer || q.answer} | ${arjunWrong ? 'WRONG' : 'correct'}]
  Statement: "${q.text}"
  Toody's explanation: "${q.explanation}"${arjunThought ? `\n  Arjun was thinking: "${arjunThought}"` : ''}`;
  }).join('\n\n');

  return await callAI([
    {
      role: 'system',
      content: `You are an expert IELTS teaching quality evaluator. You assess whether coaching explanations are effective for a Band 5.5 student named ${ARJUN.name}.

${ARJUN.name}'s weaknesses: ${ARJUN.weaknesses.join(', ')}

For each explanation, score 1–5:
- bandAppropriate: Would a Band 5.5 student understand every word on first read?
- addressesMistake: Does it directly address the specific error ${ARJUN.name} made (or would make)?
- teachesNextStep: Does it give a rule ${ARJUN.name} can apply to the next similar question?
- tone: Coaching (5) vs condescending or vague (1)?

Flag any explanation where ANY criterion scores 1 or 2. Return valid JSON only.`,
    },
    {
      role: 'user',
      content: `Evaluate these 5 explanations for ${ARJUN.name}:

${evalList}

Return ONLY this JSON:
{"explanations":[{"questionId":1,"bandAppropriate":4,"addressesMistake":5,"teachesNextStep":4,"tone":5,"avgScore":4.5,"flagged":false,"note":""}],"avgScoreAll":4.3}`,
    },
  ], 900, 0);
}

// ── Step 5 — Arjun rates the session ─────────────────────────────────────────

async function step5ArjunRatesSession(passage, questions, answers, explanations) {
  const sessionSummary = questions.map(q => {
    const a = answers.find(a => a.questionId === q.id);
    const evalResult = explanations?.find(e => e.questionId === q.id);
    return `Q${q.id}: ${a?.isCorrect ? 'got right' : `got wrong (chose ${a?.arjunAnswer}, correct: ${q.answer})`}
  Explanation I received: "${q.explanation}"`;
  }).join('\n');

  const score = answers.filter(a => a.isCorrect).length;

  return await callAI([
    {
      role: 'system',
      content: `You are ${ARJUN.name}, a Band ${ARJUN.currentBand} IELTS student targeting Band ${ARJUN.targetBand}. You just completed a practice session.

YOUR PROFILE:
- Exam in ${ARJUN.examDate}
- Weaknesses: ${ARJUN.weaknesses.join(', ')}
- You are honest and direct. You don't give fake positive feedback. If something didn't help, you say so.

Give your genuine reaction to the session. Return valid JSON only.`,
    },
    {
      role: 'user',
      content: `You just completed a True/False/Not Given practice session. You scored ${score}/5.

SESSION SUMMARY:
${sessionSummary}

Answer these questions honestly:

Return ONLY this JSON:
{
  "learnedSomethingNew": true,
  "learnedWhat": "what specifically you learned (or empty string if nothing new)",
  "difficultyAppropriate": true,
  "difficultyComment": "one sentence on the difficulty",
  "feedbackHelped": true,
  "feedbackComment": "one sentence on whether the feedback helped you understand your mistake",
  "wouldComeBackTomorrow": true,
  "comingBackReason": "honest one-sentence reason why yes or no",
  "sessionRating": 4,
  "honestComment": "one thing you wish was different about the session (or empty string if nothing)"
}`,
    },
  ], 500, 0.6);
}

// ── Step 6 — Mentor final verdict ─────────────────────────────────────────────

async function step6MentorVerdict(contentEval, explanationEval, arjunRating, answers, questionCount) {
  const score    = answers.filter(a => a.isCorrect).length;
  const accuracy = Math.round((score / answers.length) * 100);

  return await callAI([
    {
      role: 'system',
      content: `You are a senior IELTS product quality evaluator. You make final pass/fail decisions on whether AI-generated coaching sessions are ready for real students. You are direct, specific, and honest. Return valid JSON only.`,
    },
    {
      role: 'user',
      content: `Review this complete synthetic session report and give your final verdict.

STUDENT: ${ARJUN.name} (Band ${ARJUN.currentBand} → ${ARJUN.targetBand})
SESSION ACCURACY: ${score}/${questionCount} (${accuracy}%) — simulated based on ${ARJUN.name}'s weakness profile

The session contains exactly ${questionCount} questions, numbered Q1 through Q${questionCount}. You may only reference question numbers that exist in this session. Do not invent or reference question numbers outside this range.

CONTENT QUALITY (Mentor):
${JSON.stringify(contentEval, null, 2)}

EXPLANATION QUALITY (Mentor):
avg score: ${explanationEval?.avgScoreAll ?? 'N/A'}
flagged: ${explanationEval?.explanations?.filter(e => e.flagged).length ?? 0} explanation(s)

STUDENT RATING (${ARJUN.name}):
session rating: ${arjunRating?.sessionRating ?? 'N/A'}/5
learned something: ${arjunRating?.learnedSomethingNew ? 'Yes' : 'No'}
would come back tomorrow: ${arjunRating?.wouldComeBackTomorrow ? 'Yes' : 'No'}
student comment: "${arjunRating?.honestComment || ''}"

Give your verdict. Top 3 improvements must be SPECIFIC — name the exact question number (Q1–Q${questionCount} only) and exact word or phrase that needs to change. Not general advice.

Return ONLY this JSON:
{
  "contentQualityScore": 4.2,
  "teachingEffectivenessScore": 3.9,
  "top3Improvements": [
    "Specific improvement 1 — name Q number and exact issue",
    "Specific improvement 2",
    "Specific improvement 3"
  ],
  "readyForRealStudent": true,
  "readyReason": "one sentence explaining why yes or no"
}`,
    },
  ], 700, 0);
}

// ── Save results ──────────────────────────────────────────────────────────────

async function saveResults(result) {
  // Local file
  try {
    const dir      = path.join(__dirname, '..', 'test-results');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const filename = `synthetic-${result.timestamp.replace(/[:.]/g, '-')}.json`;
    fs.writeFileSync(path.join(dir, filename), JSON.stringify(result, null, 2));
    console.log(`\n  Saved: test-results/${filename}`);
  } catch (e) {
    console.log(`\n  Warning: could not save local file — ${e.message}`);
  }

  // Firestore
  try {
    const docId = result.timestamp.replace(/[:.]/g, '-');
    const flat  = {
      timestamp:                result.timestamp,
      overallPass:              result.overallPass,
      totalDurationMs:          result.totalDurationMs,
      arjunScore:               result.arjunScore,
      arjunAccuracy:            result.arjunAccuracy,
      contentQualityScore:      result.verdict?.contentQualityScore      ?? null,
      teachingEffectivenessScore: result.verdict?.teachingEffectivenessScore ?? null,
      arjunSessionRating:       result.arjunRating?.sessionRating        ?? null,
      wouldComeBackTomorrow:    result.arjunRating?.wouldComeBackTomorrow ?? null,
      readyForRealStudent:      result.verdict?.readyForRealStudent       ?? null,
    };
    const fields = {};
    function toField(v) {
      if (typeof v === 'boolean')        return { booleanValue: v };
      if (typeof v === 'number')         return { doubleValue: v };
      if (v === null || v === undefined) return { nullValue: 'NULL_VALUE' };
      return { stringValue: String(v) };
    }
    Object.entries(flat).forEach(([k, v]) => { fields[k] = toField(v); });

    const res = await fetch(`${FIRESTORE_BASE}/syntheticTests/${docId}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ fields }),
    });
    if (res.ok) console.log(`  Firestore: saved to syntheticTests/${docId}`);
  } catch { /* non-critical */ }
}

// ── Console formatting ────────────────────────────────────────────────────────

const DIVIDER   = '──────────────────────────────────────────────────────────';
const DIVIDER_H = '══════════════════════════════════════════════════════════';

function scoreBar(score, max = 5) {
  const filled = Math.round((score / max) * 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled) + ` ${score.toFixed(1)}/${max}`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function runSyntheticTest() {
  const t0 = Date.now();
  const timestamp = new Date().toISOString();

  console.log(`\n${DIVIDER_H}`);
  console.log('  Synthetic Student + Mentor Test');
  console.log(`  ${timestamp}`);
  console.log(`  Student: ${ARJUN.name} | Band ${ARJUN.currentBand} → ${ARJUN.targetBand} | Exam: ${ARJUN.examDate}`);
  console.log(`${DIVIDER_H}\n`);

  // ── Step 1 ────────────────────────────────────────────────────────────────
  console.log('Step 1 — Generating reading session for Arjun');
  let session;
  try {
    session = await step1GenerateSession();
    console.log(`  ✓  Topic: "${session.topic}" | Passage: ${session.passage?.length || 0} chars`);
    console.log(`  ✓  ${session.questions?.length || 0} questions generated`);
  } catch (err) {
    console.log(`  ✗  Generation FAILED: ${err.message}`);
    return { timestamp, overallPass: false, totalDurationMs: Date.now() - t0, error: err.message };
  }

  // ── Step 2 ────────────────────────────────────────────────────────────────
  console.log('\nStep 2 — Mentor evaluates content quality');
  let contentEval;
  try {
    contentEval = await step2MentorContentEval(session.passage, session.questions, session.topic);
    const avg = contentEval.avgScore ?? ((contentEval.ieltStandard + contentEval.fairAndUnambiguous +
      contentEval.singleDefensibleAnswer + contentEval.difficultyAppropriate) / 4);
    console.log(`  ✓  Content score: ${scoreBar(avg)}`);
    console.log(`       IELTS standard:          ${contentEval.ieltStandard}/5`);
    console.log(`       Fair & unambiguous:       ${contentEval.fairAndUnambiguous}/5`);
    console.log(`       Single correct answer:    ${contentEval.singleDefensibleAnswer}/5`);
    console.log(`       Difficulty appropriate:   ${contentEval.difficultyAppropriate}/5`);
    if (contentEval.flaggedIssues?.length) {
      contentEval.flaggedIssues.forEach(f => console.log(`  ⚑   Flag: ${f}`));
    } else {
      console.log(`  ✓  No content flags`);
    }
    if (contentEval.overallNote) console.log(`       Note: ${contentEval.overallNote}`);
  } catch (err) {
    console.log(`  ✗  Content eval FAILED: ${err.message}`);
    contentEval = null;
  }

  // ── Step 3 ────────────────────────────────────────────────────────────────
  console.log('\nStep 3 — Arjun answers questions');
  const answers = simulateArjunAnswers(session.questions);
  const score   = answers.filter(a => a.isCorrect).length;
  const accuracy = Math.round((score / answers.length) * 100);

  answers.forEach(a => {
    const q    = session.questions.find(q => q.id === a.questionId);
    const icon = a.isCorrect ? '✓' : '✗';
    const note = a.isCorrect ? '' : ` ← expected ${a.correctAnswer}`;
    console.log(`  ${icon}  Q${a.questionId} [${a.correctAnswer.padEnd(5)}] → Arjun: ${a.arjunAnswer}${note}`);
  });
  console.log(`\n  Score: ${score}/${answers.length} (${accuracy}%)`);

  let arjunReasoning;
  const wrongAnswers = answers.filter(a => !a.isCorrect);
  if (wrongAnswers.length) {
    try {
      arjunReasoning = await step3ArjunReasoning(session.passage, session.questions, answers);
      arjunReasoning.wrongAnswers?.forEach(w => {
        console.log(`\n  Q${w.questionId} — Arjun's thinking:`);
        console.log(`    "${w.arjunThought}"`);
      });
    } catch (err) {
      console.log(`  ⚑   Reasoning generation failed: ${err.message}`);
      arjunReasoning = { wrongAnswers: [] };
    }
  } else {
    console.log('\n  ✓  Arjun got all questions right — no wrong-answer reasoning needed');
    arjunReasoning = { wrongAnswers: [] };
  }

  const wrongReasonMap = {};
  arjunReasoning.wrongAnswers?.forEach(w => { wrongReasonMap[w.questionId] = w.arjunThought; });

  // ── Step 4 ────────────────────────────────────────────────────────────────
  console.log('\nStep 4 — Mentor evaluates Toody\'s explanations');
  let explanationEval;
  try {
    explanationEval = await step4MentorExplanationEval(session.questions, answers, wrongReasonMap);
    const avgAll = explanationEval.avgScoreAll ?? 0;
    console.log(`  ✓  Teaching score: ${scoreBar(avgAll)}`);
    explanationEval.explanations?.forEach(e => {
      const flag = e.flagged ? ' ⚑' : '';
      console.log(`       Q${e.questionId}: ${e.avgScore?.toFixed(1) ?? '?'}/5${flag}${e.note ? ' — ' + e.note : ''}`);
    });
    const flagCount = explanationEval.explanations?.filter(e => e.flagged).length ?? 0;
    if (flagCount) console.log(`\n  ⚑   ${flagCount} explanation(s) flagged below threshold`);
  } catch (err) {
    console.log(`  ✗  Explanation eval FAILED: ${err.message}`);
    explanationEval = null;
  }

  // ── Step 5 ────────────────────────────────────────────────────────────────
  console.log('\nStep 5 — Arjun rates the session');
  let arjunRating;
  try {
    arjunRating = await step5ArjunRatesSession(session.passage, session.questions, answers, explanationEval?.explanations);
    console.log(`  ✓  Session rating:       ${arjunRating.sessionRating}/5`);
    console.log(`     Learned something:    ${arjunRating.learnedSomethingNew ? 'Yes' : 'No'}${arjunRating.learnedWhat ? ' — "' + arjunRating.learnedWhat + '"' : ''}`);
    console.log(`     Difficulty OK:        ${arjunRating.difficultyAppropriate ? 'Yes' : 'No'}${arjunRating.difficultyComment ? ' — ' + arjunRating.difficultyComment : ''}`);
    console.log(`     Feedback helped:      ${arjunRating.feedbackHelped ? 'Yes' : 'No'}${arjunRating.feedbackComment ? ' — ' + arjunRating.feedbackComment : ''}`);
    if (arjunRating.honestComment) console.log(`     Honest comment:       "${arjunRating.honestComment}"`);
  } catch (err) {
    console.log(`  ✗  Arjun rating FAILED: ${err.message}`);
    arjunRating = null;
  }

  // ── Would Arjun come back? (most important signal) ────────────────────────
  console.log(`\n${DIVIDER_H}`);
  if (arjunRating) {
    const yesNo = arjunRating.wouldComeBackTomorrow ? '  YES  ' : '  NO   ';
    console.log(`  Would ${ARJUN.name} come back tomorrow?   ${yesNo}`);
    console.log(`  "${arjunRating.comingBackReason}"`);
  } else {
    console.log(`  Would ${ARJUN.name} come back tomorrow?   UNKNOWN (rating step failed)`);
  }
  console.log(`${DIVIDER_H}\n`);

  // ── Step 6 ────────────────────────────────────────────────────────────────
  console.log('Step 6 — Mentor final verdict');
  let verdict;
  try {
    verdict = await step6MentorVerdict(contentEval, explanationEval, arjunRating, answers, session.questions.length);
    console.log(`  ✓  Content quality:     ${scoreBar(verdict.contentQualityScore)}`);
    console.log(`     Teaching quality:    ${scoreBar(verdict.teachingEffectivenessScore)}`);
    console.log(`\n  Top 3 improvements:`);
    verdict.top3Improvements?.forEach((imp, i) => console.log(`    ${i + 1}. ${imp}`));
    const readyIcon = verdict.readyForRealStudent ? '✓' : '✗';
    console.log(`\n  ${readyIcon}  Ready for real students: ${verdict.readyForRealStudent ? 'YES' : 'NO'}`);
    console.log(`     "${verdict.readyReason}"`);
  } catch (err) {
    console.log(`  ✗  Verdict FAILED: ${err.message}`);
    verdict = null;
  }

  // ── Overall pass/fail ─────────────────────────────────────────────────────
  const contentAvg   = contentEval?.avgScore
    ?? ((contentEval?.ieltStandard + contentEval?.fairAndUnambiguous +
         contentEval?.singleDefensibleAnswer + contentEval?.difficultyAppropriate) / 4)
    ?? null;
  const teachingAvg  = explanationEval?.avgScoreAll ?? null;
  const arjunScore   = arjunRating?.sessionRating   ?? null;
  const readyForReal = verdict?.readyForRealStudent  ?? null;

  const passReasons  = [];
  const failReasons  = [];

  if (contentAvg === null)      failReasons.push('content evaluation failed');
  else if (contentAvg < 3.5)   failReasons.push(`content quality ${contentAvg.toFixed(1)}/5 < 3.5 threshold`);
  else                          passReasons.push(`content ${contentAvg.toFixed(1)}/5`);

  if (teachingAvg === null)     failReasons.push('explanation evaluation failed');
  else if (teachingAvg < 3.5)  failReasons.push(`teaching quality ${teachingAvg.toFixed(1)}/5 < 3.5 threshold`);
  else                          passReasons.push(`teaching ${teachingAvg.toFixed(1)}/5`);

  if (arjunScore === null)      failReasons.push('student rating failed');
  else if (arjunScore < 3)     failReasons.push(`Arjun rated session ${arjunScore}/5 < 3 threshold`);
  else                          passReasons.push(`Arjun rated ${arjunScore}/5`);

  if (readyForReal === false)   failReasons.push('Mentor: NOT ready for real students');
  else if (readyForReal)        passReasons.push('Mentor: ready for real students');

  const overallPass = failReasons.length === 0;
  const totalDurationMs = Date.now() - t0;

  console.log(`\n${DIVIDER}`);
  console.log(`  RESULT: ${overallPass ? 'PASS ✓' : 'FAIL ✗'}`);
  if (passReasons.length)  console.log(`  Pass:   ${passReasons.join(' | ')}`);
  if (failReasons.length)  console.log(`  Fail:   ${failReasons.join('\n          ')}`);
  console.log(`  Time:   ${(totalDurationMs / 1000).toFixed(1)}s`);
  console.log(DIVIDER);

  const result = {
    timestamp,
    overallPass,
    totalDurationMs,
    arjunScore:     score,
    arjunAccuracy:  accuracy,
    session:        { topic: session.topic, questionCount: session.questions.length },
    answers,
    contentEval,
    arjunReasoning: arjunReasoning?.wrongAnswers ?? [],
    explanationEval,
    arjunRating,
    verdict,
  };

  await saveResults(result);
  return result;
}

// Allow direct execution: node api/synthetic-test.js
if (process.argv[1] === __filename) {
  runSyntheticTest()
    .then(r => process.exit(r.overallPass ? 0 : 1))
    .catch(err => { console.error('Fatal error:', err); process.exit(1); });
}
