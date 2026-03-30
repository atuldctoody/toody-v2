// api/regression-agent.js
// Regression Agent — Agent 5.
//
// Runs the full 5-step pipeline at Band 5.0, 6.0, and 7.0 in parallel.
// Checks that all three produce valid, consistent output.
// Cross-band comparison catches regressions that only appear at certain
// difficulty levels — e.g. Band 7.0 explanations suddenly scoring worse
// than Band 5.0 is a signal that the prompt has degraded.
//
// No Firestore queries. No collectionGroup. No external auth needed.
// Just 3 parallel test runs and a consistency check.
//
// Target runtime: under 60 seconds.
//
// Usage:
//   npm run test:regression
//   node api/regression-agent.js
//
// ESM module (api/package.json sets "type": "module").

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const API_URL   = 'https://toody-api.vercel.app/api/generate';
const AUDIO_URL = 'https://toody-api.vercel.app/api/audio';

// ── Shared helpers ────────────────────────────────────────────────────────────

function parseJson(raw) {
  let s = (raw || '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
  return JSON.parse(s);
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }

const hasPipe    = a => String(a || '').includes('|');
const validTFNG  = a => ['true','false','ng','notgiven'].includes(
  String(a || '').toLowerCase().trim().replace(/\s/g,'')
);

async function apiFetch(url, body) {
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert(res.ok, `API ${url} returned ${res.status}`);
  const data = await res.json();
  const raw  = data.choices?.[0]?.message?.content;
  assert(raw, 'Empty API response');
  return parseJson(raw);
}

// ── Per-band steps ────────────────────────────────────────────────────────────

async function stepGenerate(band) {
  const parsed = await apiFetch(API_URL, {
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'You are an IELTS Academic examiner. Return valid JSON only, no markdown, no preamble.' },
      { role: 'user', content: `Create a True/False/Not Given IELTS Academic reading exercise for a Band ${band} student.

ANSWER FORMAT RULES (mandatory):
- The "answer" field must contain exactly one of: True, False, or NG. Nothing else.
- Never use pipe-separated formats like "True|False". Never use option labels like A/B/C.
- Every explanation must name the specific word, phrase, or logical feature that determines the answer.

For each question, set "errorReason" to one of: synonymTrap, hedgingMissed, negationOverlooked, scopeError, notGivenMarkedFalse, other.

Return ONLY this JSON:
{"passage":"3 paragraphs of academic prose (170-220 words)","topic":"2-4 word label","questions":[{"id":1,"text":"statement","answer":"True","explanation":"specific word/phrase","keySentence":"exact sentence","errorReason":"synonymTrap"},{"id":2,"text":"statement","answer":"False","explanation":"specific word/phrase","keySentence":"exact sentence","errorReason":"negationOverlooked"},{"id":3,"text":"statement","answer":"NG","explanation":"what passage says and does NOT say","keySentence":"most relevant sentence","errorReason":"notGivenMarkedFalse"},{"id":4,"text":"statement","answer":"True","explanation":"specific word/phrase","keySentence":"exact sentence","errorReason":"hedgingMissed"},{"id":5,"text":"statement","answer":"False","explanation":"specific word/phrase","keySentence":"exact sentence","errorReason":"scopeError"}]}` },
    ],
    max_tokens: 1500, temperature: 0.8,
  });

  assert(parsed.passage?.length > 50,
    `passage too short (${parsed.passage?.length || 0} chars)`);
  assert(Array.isArray(parsed.questions) && parsed.questions.length === 5,
    `expected 5 questions, got ${parsed.questions?.length}`);

  const requiredFields = ['id','text','answer','explanation','keySentence','errorReason'];
  parsed.questions.forEach((q, i) => {
    requiredFields.forEach(f =>
      assert(q[f] != null && q[f] !== '', `q${i+1} missing field "${f}"`)
    );
    assert(!hasPipe(q.answer), `q${i+1} pipe-separated answer: "${q.answer}"`);
    assert(validTFNG(q.answer), `q${i+1} invalid answer: "${q.answer}"`);
  });

  return { passage: parsed.passage, questions: parsed.questions, topic: parsed.topic };
}

async function stepVerify(passage, questions) {
  const { verifyAnswers } = await import('./verify-answers.js');
  const result = await verifyAnswers(passage, questions, API_URL);

  assert(Array.isArray(result.questions), 'verifyAnswers: non-array questions');
  assert(result.questions.length === questions.length,
    `verifyAnswers: count changed ${result.questions.length} vs ${questions.length}`);
  result.questions.forEach((q, i) => {
    assert(!hasPipe(q.answer), `verified q${i+1} pipe-separated: "${q.answer}"`);
    assert(validTFNG(q.answer), `verified q${i+1} invalid answer: "${q.answer}"`);
  });

  return { questions: result.questions, corrections: result.corrections?.length ?? 0 };
}

async function stepExplain(passage, questions) {
  const { scoreExplanations } = await import('./check-explanations.js');
  const explanations = questions.map(q => ({
    questionText: q.text, passage,
    studentAnswer: '', correctAnswer: q.answer,
    explanation: q.explanation, errorReason: q.errorReason || '',
  }));
  const report = await scoreExplanations(explanations, API_URL);

  assert(report !== null, 'scoreExplanations returned null');
  assert(typeof report.sessionAvgScore === 'number' &&
    report.sessionAvgScore >= 1 && report.sessionAvgScore <= 5,
    `avgScore out of range: ${report.sessionAvgScore}`);

  return { avgScore: report.sessionAvgScore, weakCount: report.weakCount };
}

async function stepAudio() {
  const res = await fetch(AUDIO_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Urban migration patterns have shifted dramatically over the past three decades, driven by economic pressures and improved transportation infrastructure.' }),
  });
  assert(res.ok, `Audio API returned ${res.status}`);
  const data = await res.json();
  assert(!data.error, `Audio error: ${data.error}`);
  assert(typeof data.audio === 'string' && data.audio.length > 100, 'Audio: empty or missing base64');
  return { audioBytes: Math.round(data.audio.length * 0.75) };
}

async function stepWriting(band) {
  const parsed = await apiFetch(API_URL, {
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: `You are an experienced IELTS examiner. You are evaluating a writing sample from a Band ${band} student. Your overall band score must reflect realistic performance for this level. A Band 5.0 student should return 4.5–5.5. A Band 6.0 student should return 5.5–6.5. A Band 7.0 student should return 6.5–7.5. Do not return the same band score for all student levels. Return valid JSON only.` },
      { role: 'user', content: `Evaluate this IELTS Writing Task 2 response for a Band ${band} target student.

TASK: Some people think governments should spend money on public transport rather than building new roads. To what extent do you agree?

RESPONSE: Governments face difficult choices when allocating infrastructure budgets. While some argue that expanding road networks stimulates economic growth, I believe investment in public transport offers greater long-term benefits. Public transport reduces traffic congestion, lowers carbon emissions, and provides mobility for those without cars. Research from European cities shows that metro systems cut urban commute times by up to 40%. However, roads remain essential in rural areas where public transport is impractical. Therefore, a balanced approach is needed, prioritising public transport in cities while maintaining road networks in less populated regions.

Return ONLY: {"overallBand":6.0,"taskAchievement":{"band":6.0,"feedback":"one sentence"},"coherenceCohesion":{"band":6.0,"feedback":"one sentence"},"lexicalResource":{"band":6.0,"feedback":"one sentence"},"grammaticalRange":{"band":6.0,"feedback":"one sentence"}}` },
    ],
    max_tokens: 400, temperature: 0.8,
  });

  ['overallBand','taskAchievement','coherenceCohesion','lexicalResource','grammaticalRange'].forEach(f =>
    assert(parsed[f] != null, `Writing eval missing field: ${f}`)
  );
  assert(typeof parsed.overallBand === 'number' &&
    parsed.overallBand >= 1 && parsed.overallBand <= 9,
    `overallBand out of range: ${parsed.overallBand}`);

  return { overallBand: parsed.overallBand };
}

// ── Full band test (all 5 steps sequentially) ─────────────────────────────────

async function runBandTest(band) {
  const t0    = Date.now();
  const steps = {};

  // Step 1 — generation
  try {
    const r = await stepGenerate(band);
    steps.generation = { pass: true, topic: r.topic, passage: r.passage, questions: r.questions };
  } catch (e) {
    steps.generation = { pass: false, error: e.message };
  }

  // Steps 2 + 3 depend on generation
  if (steps.generation.pass) {
    const { passage, questions } = steps.generation;

    try {
      const r = await stepVerify(passage, questions);
      steps.verification = { pass: true, corrections: r.corrections, questions: r.questions };
    } catch (e) {
      steps.verification = { pass: false, error: e.message };
    }

    const verifiedQs = steps.verification?.questions || questions;
    try {
      const r = await stepExplain(passage, verifiedQs);
      steps.explanationQuality = { pass: true, avgScore: r.avgScore, weakCount: r.weakCount };
    } catch (e) {
      steps.explanationQuality = { pass: false, error: e.message };
    }
  } else {
    steps.verification      = { pass: false, error: 'generation failed — skipped' };
    steps.explanationQuality = { pass: false, error: 'generation failed — skipped' };
  }

  // Steps 4 + 5 are independent
  try {
    const r = await stepAudio();
    steps.audio = { pass: true, audioBytes: r.audioBytes };
  } catch (e) {
    steps.audio = { pass: false, error: e.message };
  }

  try {
    const r = await stepWriting(band);
    steps.writingEval = { pass: true, overallBand: r.overallBand };
  } catch (e) {
    steps.writingEval = { pass: false, error: e.message };
  }

  const allPass = Object.values(steps).every(s => s.pass);
  return { band, steps, pass: allPass, durationMs: Date.now() - t0 };
}

// ── Consistency checks across band levels ─────────────────────────────────────

function checkConsistency(results) {
  const issues = [];

  // All generation steps must pass
  const genFails = results.filter(r => !r.steps.generation.pass);
  if (genFails.length) {
    genFails.forEach(r =>
      issues.push({ type: 'generation_fail', band: r.band, detail: r.steps.generation.error })
    );
  }

  // Explanation scores: no band should be more than 1.0 below any other
  const scores = results
    .map(r => ({ band: r.band, score: r.steps.explanationQuality?.avgScore }))
    .filter(s => typeof s.score === 'number');

  if (scores.length >= 2) {
    const max = Math.max(...scores.map(s => s.score));
    const min = Math.min(...scores.map(s => s.score));
    if (max - min > 1.0) {
      const maxR = scores.find(s => s.score === max);
      const minR = scores.find(s => s.score === min);
      issues.push({
        type: 'explain_drift',
        detail: `Explanation score gap ${(max - min).toFixed(1)} > 1.0 — Band ${maxR.band} scored ${maxR.score.toFixed(1)} but Band ${minR.band} scored ${minR.score.toFixed(1)}`,
      });
    }
  }

  // Writing band estimates should be within ±1.5 of each other (AI is variable; wider tolerance)
  const bands = results
    .map(r => ({ band: r.band, overallBand: r.steps.writingEval?.overallBand }))
    .filter(b => typeof b.overallBand === 'number');

  if (bands.length >= 2) {
    const max = Math.max(...bands.map(b => b.overallBand));
    const min = Math.min(...bands.map(b => b.overallBand));
    if (max - min > 1.5) {
      issues.push({
        type: 'writing_drift',
        detail: `Writing band estimates spread ${(max-min).toFixed(1)} > 1.5 — values: ${bands.map(b => `${b.band}→${b.overallBand}`).join(', ')}`,
      });
    }
  }

  // Pipe-separated answer check (regression from a previous bug)
  results.forEach(r => {
    const qs = r.steps.generation?.questions || [];
    qs.forEach(q => {
      if (hasPipe(q.answer)) {
        issues.push({
          type: 'pipe_answer',
          band: r.band,
          detail: `Band ${r.band} q${q.id}: pipe-separated answer "${q.answer}"`,
        });
      }
    });
  });

  return issues;
}

// ── Save results (local only — no Firestore) ──────────────────────────────────

function saveLocal(result) {
  try {
    const dir = path.join(__dirname, '..', 'test-results');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const filename = `regression-${result.timestamp.replace(/[:.]/g, '-')}.json`;
    fs.writeFileSync(path.join(dir, filename), JSON.stringify(result, null, 2));
    console.log(`  Saved: test-results/${filename}`);
  } catch (e) {
    console.log(`  Warning: could not save file — ${e.message}`);
  }
}

// ── Console output helpers ────────────────────────────────────────────────────

function stepIcon(step, label) {
  if (!step) return `  ?${label}`;
  if (!step.pass) return `✗${label}`;
  return `✓${label}`;
}

function formatBandRow(r) {
  const g  = r.steps.generation;
  const v  = r.steps.verification;
  const eq = r.steps.explanationQuality;
  const a  = r.steps.audio;
  const w  = r.steps.writingEval;

  const cols = [
    `Band ${r.band.toFixed(1)}:`,
    (g?.pass  ? '✓ gen'       : `✗ gen(${g?.error?.slice(0,20) || ''})`).padEnd(10),
    (v?.pass  ? '✓ verify'    : `✗ verify`).padEnd(10),
    (eq?.pass ? `✓ explain(${eq.avgScore?.toFixed(1)})` : '✗ explain').padEnd(16),
    (a?.pass  ? '✓ audio'     : '✗ audio').padEnd(9),
    (w?.pass  ? `✓ writing(${w.overallBand?.toFixed(1)})` : '✗ writing').padEnd(14),
    r.pass ? 'PASS' : 'FAIL',
  ];
  return '  ' + cols.join('  ');
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function runRegressionTests() {
  const t0        = Date.now();
  const timestamp = new Date().toISOString();

  console.log('\n── Toody Regression Agent ───────────────────────────────────');
  console.log(`   ${timestamp}`);
  console.log('   Running Band 5.0 / 6.0 / 7.0 in parallel...\n');

  // Run all 3 band tests simultaneously
  const [r5, r6, r7] = await Promise.all([
    runBandTest(5.0),
    runBandTest(6.0),
    runBandTest(7.0),
  ]);
  const results = [r5, r6, r7];

  // Per-band summary rows
  results.forEach(r => console.log(formatBandRow(r)));

  // Consistency checks
  const issues = checkConsistency(results);
  console.log('\nConsistency:');
  if (issues.length === 0) {
    console.log('  ✓  All cross-band checks passed');
  } else {
    issues.forEach(iss => console.log(`  ✗  ${iss.detail || iss.type}`));
  }

  // Final result
  const passed      = results.filter(r => r.pass).length;
  const overallPass = passed === results.length && issues.length === 0;
  const durationMs  = Date.now() - t0;

  const regressions = [
    ...results.filter(r => !r.pass).map(r => ({
      band:   r.band,
      issue:  'one or more steps failed',
      detail: Object.entries(r.steps)
        .filter(([, s]) => !s.pass)
        .map(([k, s]) => `${k}: ${s.error}`)
        .join('; '),
    })),
    ...issues.map(i => ({ band: i.band ?? 'cross-band', issue: i.type, detail: i.detail })),
  ];

  console.log(`\n── Result: ${passed}/${results.length} band levels passed${issues.length ? `, ${issues.length} consistency issue(s)` : ''} — ${overallPass ? 'PASS ✓' : 'FAIL ✗'}`);
  console.log(`   Total: ${(durationMs / 1000).toFixed(1)}s\n`);

  const output = {
    timestamp,
    sessionsChecked: results.length,
    passed,
    failed: results.length - passed,
    regressions,
    overallPass,
    durationMs,
    bandResults: results.map(r => ({
      band: r.band,
      pass: r.pass,
      durationMs: r.durationMs,
      steps: {
        generation:         { pass: r.steps.generation?.pass,         topic: r.steps.generation?.topic,             error: r.steps.generation?.error         ?? null },
        verification:       { pass: r.steps.verification?.pass,       corrections: r.steps.verification?.corrections ?? null, error: r.steps.verification?.error       ?? null },
        explanationQuality: { pass: r.steps.explanationQuality?.pass, avgScore: r.steps.explanationQuality?.avgScore ?? null, error: r.steps.explanationQuality?.error ?? null },
        audio:              { pass: r.steps.audio?.pass,              error: r.steps.audio?.error                   ?? null },
        writingEval:        { pass: r.steps.writingEval?.pass,        overallBand: r.steps.writingEval?.overallBand  ?? null, error: r.steps.writingEval?.error        ?? null },
      },
    })),
  };

  saveLocal(output);
  return output;
}

// Direct execution: node api/regression-agent.js
if (process.argv[1] === __filename) {
  runRegressionTests()
    .then(r => process.exit(r.overallPass ? 0 : 1))
    .catch(err => { console.error('Fatal:', err); process.exit(1); });
}
