// api/test-session-flow.js
// Session Flow Agent — Agent 4.
//
// Simulates a complete Toody session end to end by calling the deployed API
// endpoints directly — no browser needed, no Playwright required.
//
// Tests exactly what a student session does:
//   Step 1 — Content generation    (reading TFNG)
//   Step 2 — Answer verification   (verify-answers agent)
//   Step 3 — Explanation quality   (check-explanations agent)
//   Step 4 — Audio generation      (TTS endpoint)
//   Step 5 — Writing evaluation    (writing Task 2 eval)
//
// Saves results to test-results/flow-{timestamp}.json
// Also tries to write to Firestore systemTests/{timestamp} via REST API.
//
// Usage:
//   npm run test:flow              — full run, exits 0 on all pass, 1 on any fail
//   node api/test-session-flow.js  — same, run directly
//
// ESM module (api/package.json sets "type": "module").

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const API_URL        = 'https://toody-api.vercel.app/api/generate';
const AUDIO_URL      = 'https://toody-api.vercel.app/api/audio';
const FIREBASE_PROJECT = 'toody-1ab05';

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseJson(raw) {
  let s = (raw || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  return JSON.parse(s);
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg);
}

const VALID_ANSWERS = new Set(['true', 'false', 'ng']);

function isValidAnswer(a) {
  return VALID_ANSWERS.has(String(a || '').toLowerCase().trim());
}

function isPipeSeparated(a) {
  return String(a || '').includes('|');
}

// Run one step: returns { pass, durationMs, error?, ...extraFields }
async function runStep(label, fn) {
  const t0 = Date.now();
  try {
    const extra = await fn();
    const ms = Date.now() - t0;
    console.log(`  ✓  ${label} — PASS (${ms}ms)`);
    return { pass: true, durationMs: ms, ...(extra || {}) };
  } catch (err) {
    const ms = Date.now() - t0;
    console.log(`  ✗  ${label} — FAIL: ${err.message} (${ms}ms)`);
    return { pass: false, durationMs: ms, error: err.message };
  }
}

// ── Step implementations ──────────────────────────────────────────────────────

async function stepGeneration() {
  const body = {
    model:    'gpt-4o-mini',
    messages: [
      {
        role:    'system',
        content: 'You are an IELTS Academic examiner. Generate reading exercises at the exact band level specified. Return valid JSON only, no markdown, no preamble.',
      },
      {
        role: 'user',
        content: `Create a True/False/Not Given IELTS Academic reading exercise for a Band 6.0 student.

ANSWER FORMAT RULES (mandatory):
- The "answer" field must contain exactly one of: True, False, or NG. Nothing else.
- Never use pipe-separated formats like "True|False". Never use option labels like A/B/C.
- Every explanation must name the specific word, phrase, or logical feature that determines the answer. Never explain by location alone.

For each question, set "errorReason" to the reasoning trap this question is specifically designed to test. Valid values:
- "synonymTrap" — statement paraphrases passage with near-synonym
- "hedgingMissed" — answer hinges on hedging language (may, suggests, could, tends to)
- "negationOverlooked" — answer hinges on a negation (not, never, rarely, without)
- "scopeError" — statement claims more or less than passage actually states
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
}`,
      },
    ],
    max_tokens:  1500,
    temperature: 0.8,
  };

  const res = await fetch(API_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert(res.ok, `API returned ${res.status}`);

  const data   = await res.json();
  const raw    = data.choices?.[0]?.message?.content;
  assert(raw, 'No content in API response');

  const parsed = parseJson(raw);

  assert(typeof parsed.passage === 'string' && parsed.passage.length > 50,
    `passage missing or too short (${parsed.passage?.length || 0} chars)`);
  assert(Array.isArray(parsed.questions),
    'questions field is not an array');
  assert(parsed.questions.length === 5,
    `expected 5 questions, got ${parsed.questions.length}`);

  const requiredFields = ['id', 'text', 'answer', 'explanation', 'keySentence', 'errorReason'];
  parsed.questions.forEach((q, i) => {
    requiredFields.forEach(f => {
      assert(q[f] !== undefined && q[f] !== '',
        `question ${i + 1} missing field: ${f}`);
    });
    assert(!isPipeSeparated(q.answer),
      `question ${i + 1} has pipe-separated answer: "${q.answer}"`);
    assert(isValidAnswer(q.answer),
      `question ${i + 1} has invalid answer: "${q.answer}" (must be True/False/NG)`);
  });

  return { passage: parsed.passage, questions: parsed.questions };
}

async function stepVerification(passage, questions) {
  const { verifyAnswers } = await import('./verify-answers.js');
  const result = await verifyAnswers(passage, questions, API_URL);

  assert(Array.isArray(result.questions),
    'verifyAnswers returned non-array questions');
  assert(result.questions.length === questions.length,
    `verifyAnswers changed question count: ${result.questions.length} vs ${questions.length}`);

  result.questions.forEach((q, i) => {
    assert(!isPipeSeparated(q.answer),
      `verified question ${i + 1} has pipe-separated answer: "${q.answer}"`);
    assert(isValidAnswer(q.answer),
      `verified question ${i + 1} has invalid answer: "${q.answer}"`);
  });

  const correctionCount = result.corrections?.length || 0;
  return { questions: result.questions, corrections: correctionCount };
}

async function stepExplanationQuality(passage, questions) {
  const { scoreExplanations } = await import('./check-explanations.js');

  const explanations = questions.map(q => ({
    questionText:  q.text,
    passage,
    studentAnswer: '',
    correctAnswer: q.answer,
    explanation:   q.explanation,
    errorReason:   q.errorReason || '',
  }));

  const report = await scoreExplanations(explanations, API_URL);

  assert(report !== null, 'scoreExplanations returned null');
  assert(Array.isArray(report.explanations),
    'explanationQuality.explanations is not an array');
  assert(report.explanations.length === questions.length,
    `explanation count mismatch: ${report.explanations.length} vs ${questions.length}`);
  assert(typeof report.sessionAvgScore === 'number',
    `sessionAvgScore is not a number: ${report.sessionAvgScore}`);
  assert(report.sessionAvgScore >= 1 && report.sessionAvgScore <= 5,
    `sessionAvgScore out of range: ${report.sessionAvgScore}`);

  return { sessionAvgScore: report.sessionAvgScore, weakCount: report.weakCount };
}

async function stepAudio() {
  const testText = 'The global average temperature has risen by approximately 1.1 degrees Celsius since the pre-industrial period, driven primarily by human activities including the burning of fossil fuels and deforestation.';

  const res = await fetch(AUDIO_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ text: testText }),
  });
  assert(res.ok, `Audio API returned ${res.status}`);

  const data = await res.json();
  assert(!data.error, `Audio API returned error: ${data.error}`);
  assert(typeof data.audio === 'string' && data.audio.length > 100,
    'Audio response missing or empty base64 audio field');

  const audioBytes = Math.round(data.audio.length * 0.75);
  return { audioBytes };
}

async function stepWritingEval(band = 6.0) {
  const sampleTask  = 'Some people think that the best way to reduce crime is to give longer prison sentences. Others, however, believe there are better alternative ways of reducing crime. Discuss both views and give your own opinion.';
  const sampleEssay = `Crime is a major problem in many societies today. Some argue that harsher prison sentences deter criminals, while others believe rehabilitation and social investment are more effective. In this essay, I will discuss both perspectives before giving my own view.

Those who support longer sentences argue that they act as a powerful deterrent. When potential criminals know that the punishment is severe, they may think twice before committing an offence. Furthermore, keeping offenders in prison for longer periods prevents them from reoffending during that time, which provides a degree of protection to society.

On the other hand, many experts believe that rehabilitation programmes, education, and addressing the root causes of crime — such as poverty and lack of opportunity — are more effective in the long term. Research suggests that countries with lower incarceration rates but stronger social welfare systems often have lower crime rates overall.

In my opinion, a balanced approach is necessary. While serious crimes may require custodial sentences, investment in education, mental health support, and community programmes offers a more sustainable solution to reducing criminal behaviour.`;

  const body = {
    model:    'gpt-4o-mini',
    messages: [
      {
        role:    'system',
        content: `You are an experienced IELTS examiner. Evaluate writing responses strictly but fairly using official band descriptors. You are evaluating a writing sample from a Band ${band} student. Your overall band score must reflect realistic performance for this level. A Band 5.0 student should return 4.5–5.5. A Band 6.0 student should return 5.5–6.5. A Band 7.0 student should return 6.5–7.5. Do not return the same band score for all student levels. Return valid JSON only.`,
      },
      {
        role: 'user',
        content: `Evaluate this IELTS Writing Task 2 (Opinion Essay) response for a Band ${band} target student.

TASK PROMPT: ${sampleTask}

STUDENT RESPONSE:
${sampleEssay}

Return ONLY this JSON:
{
  "overallBand": 6.0,
  "taskAchievement": {"band": 6.0, "feedback": "one sentence"},
  "coherenceCohesion": {"band": 6.0, "feedback": "one sentence"},
  "lexicalResource": {"band": 6.0, "feedback": "one sentence"},
  "grammaticalRange": {"band": 6.0, "feedback": "one sentence"},
  "topSuggestion": "one specific, actionable improvement",
  "encouragement": "one motivating sentence about their performance"
}`,
      },
    ],
    max_tokens:  600,
    temperature: 0.8,
  };

  const res = await fetch(API_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert(res.ok, `Writing eval API returned ${res.status}`);

  const data   = await res.json();
  const raw    = data.choices?.[0]?.message?.content;
  assert(raw, 'No content in writing eval response');

  const result = parseJson(raw);

  const requiredFields = ['overallBand', 'taskAchievement', 'coherenceCohesion', 'lexicalResource', 'grammaticalRange'];
  requiredFields.forEach(f => {
    assert(result[f] !== undefined, `Writing eval missing field: ${f}`);
  });
  assert(typeof result.overallBand === 'number',
    `overallBand is not a number: ${result.overallBand}`);
  assert(result.overallBand >= 1 && result.overallBand <= 9,
    `overallBand out of range: ${result.overallBand}`);

  return { overallBand: result.overallBand };
}

// ── Save results ──────────────────────────────────────────────────────────────

function saveLocal(results) {
  try {
    const dir      = path.join(__dirname, '..', 'test-results');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const filename = `flow-${results.timestamp.replace(/[:.]/g, '-')}.json`;
    fs.writeFileSync(path.join(dir, filename), JSON.stringify(results, null, 2));
    console.log(`\n  Saved: test-results/${filename}`);
  } catch (e) {
    console.log(`\n  Warning: could not save local results — ${e.message}`);
  }
}

async function saveFirestore(results) {
  try {
    const docId = results.timestamp.replace(/[:.]/g, '-');
    const url   = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/systemTests/${docId}`;

    const toField = v => {
      if (typeof v === 'boolean') return { booleanValue: v };
      if (typeof v === 'number')  return { doubleValue:  v };
      if (v === null)             return { nullValue: 'NULL_VALUE' };
      return { stringValue: String(v) };
    };
    const fields = {};
    Object.entries(results).forEach(([k, v]) => {
      if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
        fields[k] = { mapValue: { fields: Object.fromEntries(
          Object.entries(v).map(([k2, v2]) => [k2, toField(v2)])
        )}};
      } else {
        fields[k] = toField(v);
      }
    });

    const res = await fetch(url, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ fields }),
    });
    if (res.ok) console.log(`  Firestore: saved to systemTests/${docId}`);
  } catch { /* non-critical */ }
}

// ── Main ─────────────────────────────────────────────────────────────────────

export async function testSessionFlow() {
  const t0 = Date.now();
  console.log('\n── Toody Session Flow Test ──────────────────────────────────');
  console.log(`   ${new Date().toISOString()}\n`);

  // Step 1 — Content generation
  console.log('Step 1 — Content generation');
  const gen = await runStep('Reading TFNG generation', stepGeneration);

  // Step 2 — Answer verification (depends on Step 1 output)
  console.log('\nStep 2 — Answer verification');
  let verify = { pass: false, durationMs: 0, error: 'Step 1 failed — skipped', questions: null };
  if (gen.pass && gen.passage && gen.questions) {
    verify = await runStep('Verify-answers agent', () => stepVerification(gen.passage, gen.questions));
  } else {
    console.log('  ⊘  Verify-answers — SKIPPED (Step 1 failed)');
  }

  // Step 3 — Explanation quality (depends on Step 1/2 output)
  console.log('\nStep 3 — Explanation quality');
  const questionsForCheck = verify.pass && verify.questions ? verify.questions : gen.questions;
  let quality = { pass: false, durationMs: 0, error: 'Steps 1+2 failed — skipped' };
  if (gen.pass && gen.passage && questionsForCheck) {
    quality = await runStep('Check-explanations agent', () =>
      stepExplanationQuality(gen.passage, questionsForCheck));
  } else {
    console.log('  ⊘  Check-explanations — SKIPPED (no questions available)');
  }

  // Step 4 — Audio generation (independent)
  console.log('\nStep 4 — Audio generation');
  const audio = await runStep('TTS audio endpoint', stepAudio);

  // Step 5 — Writing evaluation (independent)
  console.log('\nStep 5 — Writing evaluation');
  const writing = await runStep('Writing Task 2 evaluation', () => stepWritingEval(6.0));

  const steps = {
    generation:         { pass: gen.pass,     durationMs: gen.durationMs,     error: gen.error     || null },
    verification:       { pass: verify.pass,  durationMs: verify.durationMs,  error: verify.error  || null, corrections: verify.corrections ?? null },
    explanationQuality: { pass: quality.pass, durationMs: quality.durationMs, error: quality.error || null, sessionAvgScore: quality.sessionAvgScore ?? null },
    audio:              { pass: audio.pass,   durationMs: audio.durationMs,   error: audio.error   || null },
    writingEval:        { pass: writing.pass, durationMs: writing.durationMs, error: writing.error || null, overallBand: writing.overallBand ?? null },
  };

  const overallPass     = Object.values(steps).every(s => s.pass);
  const totalDurationMs = Date.now() - t0;
  const passCount       = Object.values(steps).filter(s => s.pass).length;
  const total           = Object.keys(steps).length;

  console.log(`\n── Result: ${passCount}/${total} steps passed ─────────────────────────────`);
  console.log(`   Total: ${totalDurationMs}ms | ${overallPass ? 'ALL PASS ✓' : 'FAILURES DETECTED ✗'}\n`);

  const results = { timestamp: new Date().toISOString(), steps, overallPass, totalDurationMs };

  saveLocal(results);
  await saveFirestore(results);

  return results;
}

// Allow direct execution: node api/test-session-flow.js
if (process.argv[1] === __filename) {
  testSessionFlow()
    .then(r => { console.log(JSON.stringify(r, null, 2)); process.exit(r.overallPass ? 0 : 1); })
    .catch(err => { console.error('Fatal error:', err); process.exit(1); });
}
