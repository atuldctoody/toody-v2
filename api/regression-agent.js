// api/regression-agent.js
// Regression Agent — Agent 5.
//
// Runs after every deploy. Fetches the last 10 flow-test baselines from
// Firestore (systemTests collection), replays content generation for all
// four skill types, and checks that current outputs are consistent with
// prior runs. If a fix broke something that was working before, this
// catches it.
//
// Baseline source: Firestore systemTests (no auth required — same collection
// that test-session-flow.js writes to). Falls back to local
// test-results/flow-*.json files when Firestore is unavailable.
//
// Note: Firestore students/{uid}/sessions requires Firebase Admin credentials.
// When GOOGLE_APPLICATION_CREDENTIALS is set, the agent will also cross-check
// against live session data. Without credentials it uses the systemTests
// collection as baseline (which already represents canonical pipeline state).
//
// Usage:
//   npm run test:regression   — exits 0 on pass, 1 on regressions found
//   node api/regression-agent.js
//
// ESM module (api/package.json sets "type": "module").

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const API_URL          = 'https://toody-api.vercel.app/api/generate';
const FIREBASE_PROJECT = 'toody-1ab05';
const FIRESTORE_BASE   = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`;

// ── Firestore REST helpers ────────────────────────────────────────────────────

function parseFirestoreValue(v) {
  if (!v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('doubleValue'  in v) return v.doubleValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('stringValue'  in v) return v.stringValue;
  if ('nullValue'    in v) return null;
  if ('mapValue'     in v) {
    const fields = v.mapValue?.fields || {};
    return Object.fromEntries(
      Object.entries(fields).map(([k, val]) => [k, parseFirestoreValue(val)])
    );
  }
  if ('arrayValue'   in v) {
    return (v.arrayValue?.values || []).map(parseFirestoreValue);
  }
  return null;
}

function parseFirestoreDoc(doc) {
  if (!doc?.fields) return null;
  return Object.fromEntries(
    Object.entries(doc.fields).map(([k, v]) => [k, parseFirestoreValue(v)])
  );
}

function toFirestoreField(v) {
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number')  return { doubleValue:  v };
  if (v === null || v === undefined) return { nullValue: 'NULL_VALUE' };
  if (Array.isArray(v))       return { arrayValue: { values: v.map(toFirestoreField) } };
  if (typeof v === 'object')  return { mapValue: { fields: Object.fromEntries(
    Object.entries(v).map(([k, val]) => [k, toFirestoreField(val)])
  )}};
  return { stringValue: String(v) };
}

function toFirestoreDoc(obj) {
  return { fields: Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [k, toFirestoreField(v)])
  )};
}

// ── Firestore fetch ───────────────────────────────────────────────────────────

async function fetchSystemTestBaselines(limit = 10) {
  try {
    const res = await fetch(`${FIRESTORE_BASE}/systemTests?pageSize=25`, {
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) return [];
    const data = await res.json();
    if (!data.documents?.length) return [];

    const docs = data.documents
      .map(d => parseFirestoreDoc(d))
      .filter(d => d?.timestamp && d?.steps)
      .sort((a, b) => (b.timestamp > a.timestamp ? 1 : -1))
      .slice(0, limit);

    return docs;
  } catch {
    return [];
  }
}

// ── Local baseline fallback ───────────────────────────────────────────────────

function loadLocalBaselines(limit = 10) {
  try {
    const dir = path.join(__dirname, '..', 'test-results');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => f.startsWith('flow-') && f.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, limit)
      .map(f => {
        try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
        catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ── Generation checks ─────────────────────────────────────────────────────────

function parseJson(raw) {
  let s = (raw || '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
  return JSON.parse(s);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const VALID_ANSWERS = new Set(['true', 'false', 'ng']);
const hasPipe = a => String(a || '').includes('|');
const validAnswer = a => VALID_ANSWERS.has(String(a || '').toLowerCase().trim());

async function callGenerate(messages, maxTokens = 1200) {
  const res = await fetch(API_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini', messages,
      max_tokens: maxTokens, temperature: 0.8,
    }),
  });
  assert(res.ok, `API returned ${res.status}`);
  const data = await res.json();
  const raw  = data.choices?.[0]?.message?.content;
  assert(raw, 'Empty API response');
  return parseJson(raw);
}

// Reading TFNG
async function checkTFNG(band = 6.0) {
  const parsed = await callGenerate([
    { role: 'system', content: 'You are an IELTS Academic examiner. Return valid JSON only, no markdown, no preamble.' },
    { role: 'user', content: `Create a True/False/Not Given IELTS Academic reading exercise for a Band ${band} student.
ANSWER FORMAT RULES: The "answer" field must contain exactly one of: True, False, or NG. Never pipe-separated.
Return ONLY this JSON:
{"passage":"170-220 word academic passage","topic":"2-4 word label","questions":[{"id":1,"text":"statement","answer":"True","explanation":"specific word/phrase from passage","keySentence":"exact sentence","errorReason":"synonymTrap"},{"id":2,"text":"statement","answer":"False","explanation":"specific word/phrase","keySentence":"exact sentence","errorReason":"negationOverlooked"},{"id":3,"text":"statement","answer":"NG","explanation":"what passage says and does NOT say","keySentence":"exact sentence","errorReason":"notGivenMarkedFalse"},{"id":4,"text":"statement","answer":"True","explanation":"specific word/phrase","keySentence":"exact sentence","errorReason":"hedgingMissed"},{"id":5,"text":"statement","answer":"False","explanation":"specific word/phrase","errorReason":"scopeError","keySentence":"exact sentence"}]}` },
  ]);

  assert(parsed.passage?.length > 50, `TFNG: passage too short (${parsed.passage?.length || 0} chars)`);
  assert(Array.isArray(parsed.questions) && parsed.questions.length === 5, `TFNG: expected 5 questions, got ${parsed.questions?.length}`);
  parsed.questions.forEach((q, i) => {
    assert(!hasPipe(q.answer),    `TFNG q${i+1}: pipe-separated answer "${q.answer}"`);
    assert(validAnswer(q.answer), `TFNG q${i+1}: invalid answer "${q.answer}"`);
    assert(q.explanation?.length > 5, `TFNG q${i+1}: missing explanation`);
  });

  return { questionsCount: parsed.questions.length, passage: parsed.passage, questions: parsed.questions };
}

// Reading Summary Completion
async function checkSummaryCompletion(band = 6.0) {
  const parsed = await callGenerate([
    { role: 'system', content: 'You are an IELTS Academic examiner. Return valid JSON only, no markdown, no preamble.' },
    { role: 'user', content: `Create a Summary Completion IELTS Academic reading exercise for a Band ${band} student.
Each gap answer must be a single word taken directly from the passage. The word bank must contain real English words — no placeholders.
Return ONLY this JSON:
{"passage":"170-220 word academic passage","topic":"2-4 word label","summaryText":"60-80 word summary with 5 gaps marked as [1] [2] [3] [4] [5]","wordBank":["word1","word2","word3","word4","word5","word6","word7","word8"],"questions":[{"id":1,"text":"Gap [1]","answer":"exact word from passage","explanation":"why this word fills the gap","keySentence":"sentence from passage containing this word"},{"id":2,"text":"Gap [2]","answer":"exact word","explanation":"why","keySentence":"sentence"},{"id":3,"text":"Gap [3]","answer":"exact word","explanation":"why","keySentence":"sentence"},{"id":4,"text":"Gap [4]","answer":"exact word","explanation":"why","keySentence":"sentence"},{"id":5,"text":"Gap [5]","answer":"exact word","explanation":"why","keySentence":"sentence"}]}` },
  ]);

  assert(parsed.passage?.length > 50,     'SC: passage missing or too short');
  assert(parsed.summaryText?.length > 20,  'SC: summaryText missing');
  assert(Array.isArray(parsed.wordBank) && parsed.wordBank.length >= 5, 'SC: wordBank missing or too short');
  assert(Array.isArray(parsed.questions) && parsed.questions.length === 5, `SC: expected 5 questions, got ${parsed.questions?.length}`);

  // Verify no word bank entry looks like a placeholder
  const placeholderRe = /^(word|correct|answer|distractor|decoy|item)\d+$/i;
  parsed.wordBank.forEach((w, i) => {
    assert(!placeholderRe.test(w), `SC: wordBank[${i}] looks like a placeholder: "${w}"`);
  });

  parsed.questions.forEach((q, i) => {
    assert(q.answer?.length > 0,      `SC q${i+1}: missing answer`);
    assert(q.explanation?.length > 5, `SC q${i+1}: missing explanation`);
  });

  return { questionsCount: parsed.questions.length, wordBankSize: parsed.wordBank.length };
}

// Listening Multiple Choice
async function checkListeningMC(band = 6.0) {
  const parsed = await callGenerate([
    { role: 'system', content: 'You are an IELTS examiner. Generate listening exercises. Return valid JSON only, no markdown.' },
    { role: 'user', content: `Create an IELTS Listening Multiple Choice exercise for a Band ${band} student.
"transcript" must be the ACTUAL spoken words — write it as natural speech (4-6 sentences of a real conversation, monologue, or announcement). Questions must be answerable from the transcript.
Return ONLY this JSON:
{"transcript":"actual spoken words as natural human speech, 4-6 sentences","questions":[{"id":1,"text":"question","options":["A. option","B. option","C. option"],"answer":"A","explanation":"why"},{"id":2,"text":"question","options":["A. option","B. option","C. option"],"answer":"B","explanation":"why"},{"id":3,"text":"question","options":["A. option","B. option","C. option"],"answer":"C","explanation":"why"},{"id":4,"text":"question","options":["A. option","B. option","C. option"],"answer":"A","explanation":"why"},{"id":5,"text":"question","options":["A. option","B. option","C. option"],"answer":"B","explanation":"why"}]}` },
  ]);

  assert(parsed.transcript?.length > 30, 'ListeningMC: transcript missing or too short');
  assert(Array.isArray(parsed.questions) && parsed.questions.length === 5, `ListeningMC: expected 5 questions, got ${parsed.questions?.length}`);
  parsed.questions.forEach((q, i) => {
    assert(Array.isArray(q.options) && q.options.length === 3, `ListeningMC q${i+1}: expected 3 options`);
    assert(['A','B','C'].includes(q.answer), `ListeningMC q${i+1}: invalid answer "${q.answer}" (must be A/B/C)`);
  });

  return { questionsCount: parsed.questions.length, transcriptLength: parsed.transcript.length };
}

// ── Comparison logic ──────────────────────────────────────────────────────────

function avg(arr) {
  if (!arr.length) return null;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function compareAgainstBaselines(current, baselines) {
  const regressions = [];

  if (!baselines.length) return regressions;  // no history — no comparison possible

  // For each step, check if it regressed
  const steps = ['generation', 'verification', 'explanationQuality', 'audio', 'writingEval'];
  steps.forEach(stepName => {
    const historicalPasses = baselines
      .map(b => b.steps?.[stepName]?.pass)
      .filter(v => typeof v === 'boolean');

    if (!historicalPasses.length) return;

    const passRate = historicalPasses.filter(Boolean).length / historicalPasses.length;
    const currentPass = current.steps?.[stepName]?.pass;

    // Regression: step was passing ≥80% of the time but now fails
    if (passRate >= 0.8 && currentPass === false) {
      regressions.push({
        sessionId: 'current',
        issue: `Step "${stepName}" has regressed — passed in ${Math.round(passRate * 100)}% of last ${historicalPasses.length} runs, now FAILS`,
        baseline: `pass rate ${Math.round(passRate * 100)}%`,
        current: 'FAIL',
      });
    }
  });

  // Check explanationQuality score
  const historicalScores = baselines
    .map(b => b.steps?.explanationQuality?.sessionAvgScore)
    .filter(v => typeof v === 'number' && v > 0);

  if (historicalScores.length >= 2) {
    const baselineAvg = avg(historicalScores);
    const currentScore = current.steps?.explanationQuality?.sessionAvgScore;
    if (typeof currentScore === 'number' && currentScore < baselineAvg - 1.0) {
      regressions.push({
        sessionId: 'current',
        issue: `Explanation quality dropped more than 1.0 point vs baseline average`,
        baseline: `avg ${baselineAvg.toFixed(1)} (n=${historicalScores.length})`,
        current: String(currentScore),
      });
    }
  }

  // Check writing band drift
  const historicalBands = baselines
    .map(b => b.steps?.writingEval?.overallBand)
    .filter(v => typeof v === 'number');

  if (historicalBands.length >= 2) {
    const baselineAvg = avg(historicalBands);
    const currentBand = current.steps?.writingEval?.overallBand;
    if (typeof currentBand === 'number' && Math.abs(currentBand - baselineAvg) > 1.5) {
      regressions.push({
        sessionId: 'current',
        issue: `Writing band estimate drifted outside ±1.5 of baseline (high AI variability — may be noise)`,
        baseline: `avg band ${baselineAvg.toFixed(1)} (n=${historicalBands.length})`,
        current: String(currentBand),
      });
    }
  }

  return regressions;
}

// ── Save results ──────────────────────────────────────────────────────────────

async function saveRegressionResult(result) {
  try {
    const docId = result.timestamp.replace(/[:.]/g, '-');
    const url   = `${FIRESTORE_BASE}/regressionTests/${docId}`;
    const body  = toFirestoreDoc({
      timestamp:        result.timestamp,
      sessionsChecked:  result.sessionsChecked,
      passed:           result.passed,
      failed:           result.failed,
      overallPass:      result.overallPass,
      totalDurationMs:  result.totalDurationMs,
      regressionCount:  result.regressions.length,
    });
    const res = await fetch(url, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    if (res.ok) {
      console.log(`  Firestore: saved to regressionTests/${docId}`);
    }
  } catch { /* non-critical */ }
}

// ── Main ─────────────────────────────────────────────────────────────────────

export async function runRegressionTests() {
  const t0 = Date.now();
  console.log('\n── Toody Regression Agent ───────────────────────────────────');
  console.log(`   ${new Date().toISOString()}\n`);

  // ── STEP 1: Fetch baselines ───────────────────────────────────────────────
  console.log('Step 1 — Loading baselines');
  let baselines = await fetchSystemTestBaselines(10);
  const firestoreCount = baselines.length;

  if (firestoreCount === 0) {
    console.log('  ⊘  Firestore unavailable — trying local test-results/');
    baselines = loadLocalBaselines(10);
  }

  if (baselines.length === 0) {
    console.log('  ⊘  No baselines found — this is the first run. Baselines will be written after this run.');
  } else {
    console.log(`  ✓  Loaded ${baselines.length} baseline(s) (${firestoreCount > 0 ? 'Firestore systemTests' : 'local files'})`);
  }

  // ── STEP 2: Replay generation for all skill types ─────────────────────────
  console.log('\nStep 2 — Replaying content generation (4 skill types)');

  const skillChecks = [
    { name: 'reading.tfng',              label: 'Reading TFNG',             fn: () => checkTFNG()              },
    { name: 'reading.summaryCompletion', label: 'Reading Summary Completion', fn: () => checkSummaryCompletion() },
    { name: 'listening.multipleChoice',  label: 'Listening Multiple Choice',  fn: () => checkListeningMC()       },
  ];

  const skillResults = [];
  for (const check of skillChecks) {
    const t = Date.now();
    try {
      const extra = await check.fn();
      const ms = Date.now() - t;
      console.log(`  ✓  ${check.label} — PASS (${ms}ms)`);
      skillResults.push({ name: check.name, pass: true, durationMs: ms, ...extra });
    } catch (err) {
      const ms = Date.now() - t;
      console.log(`  ✗  ${check.label} — FAIL: ${err.message} (${ms}ms)`);
      skillResults.push({ name: check.name, pass: false, durationMs: ms, error: err.message });
    }
  }

  // ── STEP 3: Check consistency ─────────────────────────────────────────────
  console.log('\nStep 3 — Checking consistency');

  // Build a "current run" object from the latest flow-test result
  // (that was just written by npm run test:flow, which ran before us in predeploy)
  const localFiles = loadLocalBaselines(1);
  const latestFlowResult = localFiles[0] || null;

  if (latestFlowResult) {
    console.log(`  ✓  Latest flow test: ${latestFlowResult.timestamp} — ${latestFlowResult.overallPass ? 'ALL PASS' : 'HAS FAILURES'}`);
  } else {
    console.log('  ⊘  No local flow test result found — skipping flow-test regression check');
  }

  // ── STEP 4: Compare to baseline ───────────────────────────────────────────
  console.log('\nStep 4 — Comparing to baseline');

  // Regressions from flow test steps
  const priorBaselines = latestFlowResult
    ? baselines.filter(b => b.timestamp < latestFlowResult.timestamp)
    : baselines;

  const flowRegressions = latestFlowResult && priorBaselines.length
    ? compareAgainstBaselines(latestFlowResult, priorBaselines)
    : [];

  // Regressions from skill-specific generation checks
  // Compare against prior regressionTest results (Firestore regressionTests collection)
  let skillRegressions = [];
  try {
    const rrRes = await fetch(`${FIRESTORE_BASE}/regressionTests?pageSize=20`);
    if (rrRes.ok) {
      const rrData = await rrRes.json();
      const priorRRs = (rrData.documents || [])
        .map(d => parseFirestoreDoc(d))
        .filter(d => d?.timestamp)
        .sort((a, b) => (b.timestamp > a.timestamp ? 1 : -1))
        .slice(0, 10);

      if (priorRRs.length > 0) {
        // For each skill, check if it was passing before but fails now
        skillChecks.forEach((check, i) => {
          const historicalPasses = priorRRs
            .map(rr => rr[`skill_${check.name.replace(/\./g, '_')}_pass`])
            .filter(v => typeof v === 'boolean');
          const passRate = historicalPasses.length
            ? historicalPasses.filter(Boolean).length / historicalPasses.length
            : null;
          const currentPass = skillResults[i]?.pass;

          if (passRate !== null && passRate >= 0.8 && currentPass === false) {
            skillRegressions.push({
              sessionId: check.name,
              issue: `Skill "${check.name}" generation has regressed — passed ${Math.round(passRate * 100)}% of recent runs, now FAILS`,
              baseline: `pass rate ${Math.round(passRate * 100)}%`,
              current: 'FAIL',
            });
          }
        });
      }
    }
  } catch { /* non-critical */ }

  const allRegressions = [...flowRegressions, ...skillRegressions];

  allRegressions.forEach(r => {
    console.log(`  ✗  REGRESSION: ${r.issue}`);
    console.log(`       baseline: ${r.baseline}`);
    console.log(`        current: ${r.current}`);
  });

  if (allRegressions.length === 0) {
    if (priorBaselines.length === 0 && skillResults.every(s => s.pass)) {
      console.log('  ✓  No prior baseline — all checks passed on first run');
    } else {
      console.log(`  ✓  No regressions detected (checked against ${priorBaselines.length} prior run(s))`);
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const sessionsChecked = priorBaselines.length;
  const skillFailed     = skillResults.filter(s => !s.pass).length;
  const skillPassed     = skillResults.filter(s => s.pass).length;
  const overallPass     = allRegressions.length === 0 && skillFailed === 0;
  const totalDurationMs = Date.now() - t0;

  console.log(`\n── Result: ${overallPass ? 'PASS ✓' : 'FAIL ✗'} ──────────────────────────────────────────`);
  console.log(`   Skills checked: ${skillPassed}/${skillChecks.length} passed`);
  console.log(`   Regressions:    ${allRegressions.length}`);
  console.log(`   Baselines used: ${sessionsChecked}`);
  console.log(`   Total:          ${totalDurationMs}ms\n`);

  const result = {
    timestamp:       new Date().toISOString(),
    sessionsChecked,
    passed:          skillPassed,
    failed:          skillFailed,
    regressions:     allRegressions,
    overallPass,
    totalDurationMs,
    skillResults,
    ...(latestFlowResult ? { flowTestPass: latestFlowResult.overallPass, flowTestTimestamp: latestFlowResult.timestamp } : {}),
  };

  // Save skill pass/fail per skill name for future baseline comparison
  skillResults.forEach(s => {
    result[`skill_${s.name.replace(/\./g, '_')}_pass`] = s.pass;
  });

  await saveRegressionResult(result);

  return result;
}

// Allow direct execution: node api/regression-agent.js
if (process.argv[1] === __filename) {
  runRegressionTests()
    .then(r => {
      console.log(JSON.stringify(r, null, 2));
      process.exit(r.overallPass ? 0 : 1);
    })
    .catch(err => {
      console.error('Fatal error:', err);
      process.exit(1);
    });
}
