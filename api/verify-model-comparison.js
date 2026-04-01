// api/verify-model-comparison.js
// Compares GPT-4o Full vs Claude Sonnet vs Claude Opus on the verify-answers task.
//
// Test design: each case provides the CORRECT answer as the stated answer.
// A model that truly understands the rules will confirm it (correctionNeeded: false).
// A naive model will wrongly dispute it — a false positive.
// The 5 trap passages are chosen to maximally challenge naive models.
//
// 5 runs × 5 test cases × 3 models = 75 total API calls.
// ESM module (api/package.json declares "type": "module").

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname }                      from 'path';
import { fileURLToPath }                         from 'url';

const __dirname   = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = resolve(__dirname, '..', 'test-results');

// ── CONFIG ────────────────────────────────────────────────────────
const RUNS          = 5;
const GPT_API_URL   = 'https://toody-api.vercel.app/api/generate';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const SONNET_MODEL  = 'claude-sonnet-4-5';
const OPUS_MODEL    = 'claude-opus-4-5';
const GPT_MODEL     = 'gpt-4o';

// ── TEST CASES ────────────────────────────────────────────────────
// correctAnswer = what IS correct. It is also sent as the statedAnswer.
// The model must CONFIRM it (correctionNeeded: false).
// A naive model will wrongly dispute it — that is a false positive.
const TEST_CASES = [
  {
    id:            1,
    trap:          'NEUTRAL AUTHOR',
    passage:       'Some researchers argue that social media improves teenage mental health by fostering connections. Others contend it leads to anxiety and isolation.',
    statement:     'Social media harms teenage mental health.',
    correctAnswer: 'Not Given',
    explanation:   'Passage reports debate — neither view is stated as fact by the author',
  },
  {
    id:            2,
    trap:          'ABSOLUTE QUALIFIER',
    passage:       'Most studies suggest that regular exercise can reduce the risk of heart disease in adults.',
    statement:     'Exercise always prevents heart disease in adults.',
    correctAnswer: 'False',
    explanation:   'Always vs most — absolute qualifier contradicted by passage scope',
  },
  {
    id:            3,
    trap:          'CAUSAL ASSUMPTION',
    passage:       'Following the introduction of the new curriculum in 2018, student test scores improved significantly across all schools.',
    statement:     'The new curriculum caused the improvement in student test scores.',
    correctAnswer: 'Not Given',
    explanation:   'Passage shows sequence not causation — other factors could explain improvement',
  },
  {
    id:            4,
    trap:          'DIRECT CLASH',
    passage:       'The ancient Romans built their roads using volcanic ash mixed with lime, creating a material far more durable than ordinary concrete.',
    statement:     'Roman roads were constructed using the same materials as modern concrete.',
    correctAnswer: 'False',
    explanation:   'Passage explicitly says volcanic ash and lime — different from ordinary concrete',
  },
  {
    id:            5,
    trap:          'INFERENCE TRAP',
    passage:       'The government announced a 40% reduction in carbon emissions over the past decade.',
    statement:     'Air quality has improved significantly as a result of government policy.',
    correctAnswer: 'Not Given',
    explanation:   'Passage confirms emissions reduced but never links this to air quality or attributes it to policy',
  },
];

// ── SYSTEM PROMPT — verbatim copy from api/verify-answers.js ─────
// Must stay in sync. Do not edit here independently.
const VERIFY_SYSTEM = `You are a strict IELTS Academic examiner verifying True/False/Not Given answer keys. Your only job is to check whether each stated answer is correct given the passage. Apply these rules with zero tolerance:

CRITICAL: The presence of an opposing viewpoint in the passage does NOT make a statement False. False requires the passage to explicitly state the opposite as fact. If the passage only reports that some people disagree, the answer is Not Given.

TRUE: The passage explicitly and directly confirms the statement. The exact claim must be present in the passage — not implied, not suggested, explicitly stated.

FALSE: The passage EXPLICITLY CONTRADICTS the statement. This includes:
- The passage states the OPPOSITE of what the statement claims
- The passage uses words like 'low', 'slow', 'rare', 'limited', 'few' when the statement claims 'high', 'fast', 'common', 'widespread', 'many'
- The passage describes a NEGATIVE situation when the statement claims a POSITIVE one, or vice versa

NOT GIVEN: The passage does not address the specific claim AT ALL — not that it partially addresses it. This includes:
- The passage discusses the topic but not this specific aspect
- The passage uses hedging language (suggests, may, could, appears to) — hedging is NOT explicit confirmation
- The statement makes a universal claim (always, never, all, none) that the passage neither confirms nor denies
- The passage implies something without stating it directly

CRITICAL DISTINCTION — FALSE vs NOT GIVEN:
- If the passage says 'public awareness remains low' and the statement says 'public awareness is high' → this is FALSE, not NOT GIVEN. The passage directly contradicts the statement.
- Only mark NOT GIVEN when the passage is completely silent on the specific claim — when there is no evidence either confirming or contradicting it.
- Do NOT mark FALSE as NOT GIVEN simply because the passage doesn't use the exact words of the statement. If the meaning directly contradicts, it is FALSE.

NAMED TRAP CHECKS — apply every one of these before confirming any answer:

NEUTRAL AUTHOR TRAP: Does the passage use reporting verbs (argue, believe, suggest, claim, think, feel, propose, contend) to present views? If so, those views are NOT passage facts — they are reported opinions.
- If BOTH sides of a debate are reported (e.g. "Some experts argue X. Others believe Y."), the answer is almost always NOT GIVEN — the passage is reporting a debate, not confirming either side as fact.
- If only one view is reported using a reporting verb, check whether the author explicitly endorses it as fact — if not, NOT GIVEN.
- "Some experts argue X" does NOT confirm X as true.
- "Others believe Y" does NOT confirm Y as true.
- Neither view contradicts the statement — they simply represent debate. Debate = Not Given.
- Apply this check FIRST before checking True or False.

INFERENCE TRAP: Does the statement claim causation (X caused Y, X led to Y) when the passage only shows sequence (X happened, then Y happened)? If the passage shows sequence but never explicitly states causation, the answer is NOT GIVEN — not TRUE. Look for: caused, led to, resulted in, was responsible for. If these words are absent from the passage, causation is not established.

ADVERB OVERLOOK: Does the statement use an absolute qualifier (all, every, always, never, completely, entirely, only) when the passage uses a partial qualifier (most, many, some, often, usually, generally, tends to, in many cases)? A shift from partial to absolute is a direct contradiction — answer is FALSE, not NOT GIVEN. Check every quantifier and frequency word in both the statement and passage.

ABSOLUTE QUALIFIER TRAP: Does the statement use always/never/all/every/completely but the passage uses usually/often/some/generally/varies/in most cases? The absolute claim is directly contradicted by the passage's partial language — answer is FALSE. This is a sub-type of ADVERB OVERLOOK but applies specifically to binary absolutes vs qualified statements.

ASSUMPTION TRAP: Does the student's likely interpretation require a logical bridge the passage never explicitly built? Example: passage says cars were banned for safety reasons — statement says the area became quieter. Safety and silence are different concepts. If the passage does not connect them, the answer is NOT GIVEN. Ask: does the passage explicitly bridge the two concepts, or is the student filling a gap?

CAUSAL ASSUMPTION TRAP: Does the passage say two things happened at the same time or in sequence, while the statement says one caused the other? Co-occurrence is not causation. If the passage says 'profits rose after the new policy' and the statement says 'the new policy caused profits to rise', the answer is NOT GIVEN unless the passage explicitly states a causal link using words like: caused, led to, resulted in, was due to, was attributed to, was responsible for.

COMMON ERRORS TO CATCH:
- Universal statements (always/never/all) the passage doesn't explicitly confirm → NOT GIVEN, not TRUE
- Hedging language (suggests/may/could) that stops short of explicit confirmation → NOT GIVEN, not TRUE
- Partial evidence (passage supports part of the claim but not all of it) → check carefully, may be NOT GIVEN
- Direct contradiction of quantity, frequency, or quality → FALSE, not NOT GIVEN
- Pipe-separated answers (True|False or A/B/C) → INVALID, determine the single correct answer from the passage

Re-evaluate each question independently. Only use the passage text as evidence. Return valid JSON only.`;

// ── HELPERS ───────────────────────────────────────────────────────
function normalise(a) {
  const s = (a || '').trim().toLowerCase().replace(/[\s\-_]+/g, '');
  if (s === 'ng' || s === 'notgiven') return 'notgiven';
  if (s === 'true')  return 'true';
  if (s === 'false') return 'false';
  return s;
}

function buildUserMsg(tc) {
  // Stated answer = correctAnswer (we are testing whether the model wrongly disputes it)
  return [
    `Passage:\n${tc.passage}`,
    `\nQuestions to verify:\nID ${tc.id}: Statement: "${tc.statement}" | Stated answer: "${tc.correctAnswer}"`,
    `\nFor each question, independently determine the correct answer from the passage, then compare it to the stated answer. If they differ, set correctionNeeded to true and explain which specific rule was violated.`,
    `\nReturn ONLY this JSON (no markdown, no preamble):\n{"questions":[{"id":${tc.id},"originalAnswer":"${tc.correctAnswer}","verifiedAnswer":"${tc.correctAnswer}","correctionNeeded":false,"correctionReason":""}]}`,
  ].join('');
}

function parseRaw(raw, tcId) {
  const clean = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  const result = JSON.parse(clean);
  const q = (result.questions || []).find(x => Number(x.id) === tcId);
  if (!q) throw new Error(`id ${tcId} not found in response`);
  return {
    verifiedAnswer:   String(q.verifiedAnswer  || '').trim(),
    correctionNeeded: !!q.correctionNeeded,
    correctionReason: String(q.correctionReason || '').trim(),
  };
}

// ── MODEL CALLERS ────────────────────────────────────────────────
async function callGPT(userMsg) {
  const t0  = Date.now();
  const res = await fetch(GPT_API_URL, {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model:       GPT_MODEL,
      messages:    [
        { role: 'system', content: VERIFY_SYSTEM },
        { role: 'user',   content: userMsg        },
      ],
      max_tokens:  500,
      temperature: 0,
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`GPT ${res.status}: ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  const raw  = String(data.choices?.[0]?.message?.content || '').trim();
  return { raw, latencyMs: Date.now() - t0 };
}

// Call B — Claude Sonnet
async function callClaude(userMsg) {
  const t0  = Date.now();
  const res = await fetch(ANTHROPIC_URL, {
    method:  'POST',
    headers: {
      'content-type':      'application/json',
      'x-api-key':         ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:       SONNET_MODEL,
      system:      VERIFY_SYSTEM,
      messages:    [{ role: 'user', content: userMsg }],
      max_tokens:  500,
      temperature: 0,
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Claude Sonnet ${res.status}: ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  const raw  = String(data.content?.[0]?.text || '').trim();
  return { raw, latencyMs: Date.now() - t0 };
}

// Call C — Claude Opus
async function callClaudeOpus(userMsg) {
  const t0  = Date.now();
  const res = await fetch(ANTHROPIC_URL, {
    method:  'POST',
    headers: {
      'content-type':      'application/json',
      'x-api-key':         ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:       OPUS_MODEL,
      system:      VERIFY_SYSTEM,
      messages:    [{ role: 'user', content: userMsg }],
      max_tokens:  500,
      temperature: 0,
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Claude Opus ${res.status}: ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  const raw  = String(data.content?.[0]?.text || '').trim();
  return { raw, latencyMs: Date.now() - t0 };
}

// ── SINGLE CASE RUNNER ────────────────────────────────────────────
async function runCase(tc, callFn, modelName, run) {
  const userMsg = buildUserMsg(tc);
  try {
    const { raw, latencyMs } = await callFn(userMsg);
    const { verifiedAnswer, correctionNeeded, correctionReason } = parseRaw(raw, tc.id);
    const correct        = normalise(verifiedAnswer) === normalise(tc.correctAnswer);
    const correctionMade = correctionNeeded;
    // falsePositive: model wrongly disputed the correct answer AND its proposed answer is wrong
    const falsePositive  = correctionMade && !correct;
    return {
      run, model: modelName, id: tc.id, trap: tc.trap,
      correctAnswer:  tc.correctAnswer,
      modelAnswer:    verifiedAnswer,
      correct, correctionMade, falsePositive,
      correctionReason,
      latencyMs,
      error: null,
    };
  } catch (err) {
    return {
      run, model: modelName, id: tc.id, trap: tc.trap,
      correctAnswer:  tc.correctAnswer,
      modelAnswer:    '',
      correct: false, correctionMade: false, falsePositive: false,
      correctionReason: '',
      latencyMs: 0,
      error: err.message,
    };
  }
}

// ── STATS CALCULATOR ──────────────────────────────────────────────
function calcStats(records) {
  const total = records.length;
  if (!total) return null;

  const correct       = records.filter(r => r.correct).length;
  const falsePositive = records.filter(r => r.falsePositive).length;
  const latencies     = records.filter(r => r.latencyMs > 0).map(r => r.latencyMs);
  const avgLatencyMs  = latencies.length
    ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
    : 0;

  // Consistency: for each test case, all 5 runs must return the same normalised answer
  const consistentCases = TEST_CASES.filter(tc => {
    const answers = records
      .filter(r => r.id === tc.id)
      .map(r => normalise(r.modelAnswer));
    return answers.length > 0 && answers.every(a => a === answers[0]);
  }).length;

  // Trap breakdown: correct count per trap (out of RUNS attempts)
  const trapBreakdown = {};
  for (const tc of TEST_CASES) {
    const tcRecords = records.filter(r => r.id === tc.id);
    trapBreakdown[tc.trap] = {
      correct: tcRecords.filter(r => r.correct).length,
      total:   tcRecords.length,
    };
  }

  return {
    accuracyPct:       Math.round((correct        / total)             * 100),
    consistencyPct:    Math.round((consistentCases / TEST_CASES.length) * 100),
    falsePositiveRate: Math.round((falsePositive   / total)             * 100),
    avgLatencyMs,
    trapBreakdown,
    correct, total, falsePositive, consistentCases,
  };
}

// ── TABLE PRINTER ─────────────────────────────────────────────────
function pad(s, n, right = false) {
  const str = String(s ?? '');
  return right ? str.padStart(n) : str.padEnd(n);
}

function printComparisonTable(gptStats, sonnetStats, opusStats) {
  const sonnetAvail = !!sonnetStats;
  const opusAvail   = !!opusStats;
  const G = gptStats;
  const S = sonnetStats || {};
  const O = opusStats   || {};

  const rows = [
    ['Accuracy',
      `${G.accuracyPct}%`,
      sonnetAvail ? `${S.accuracyPct}%`       : '—',
      opusAvail   ? `${O.accuracyPct}%`       : '—'],
    ['Consistency',
      `${G.consistencyPct}%`,
      sonnetAvail ? `${S.consistencyPct}%`    : '—',
      opusAvail   ? `${O.consistencyPct}%`    : '—'],
    ['False Positive Rate',
      `${G.falsePositiveRate}%`,
      sonnetAvail ? `${S.falsePositiveRate}%` : '—',
      opusAvail   ? `${O.falsePositiveRate}%` : '—'],
    ['Avg Latency',
      `${G.avgLatencyMs}ms`,
      sonnetAvail ? `${S.avgLatencyMs}ms`     : '—',
      opusAvail   ? `${O.avgLatencyMs}ms`     : '—'],
  ];

  const c1 = 21, c2 = 14, c3 = 15, c4 = 13;
  const divider = `├${'─'.repeat(c1)}┼${'─'.repeat(c2)}┼${'─'.repeat(c3)}┼${'─'.repeat(c4)}┤`;
  const top     = `┌${'─'.repeat(c1)}┬${'─'.repeat(c2)}┬${'─'.repeat(c3)}┬${'─'.repeat(c4)}┐`;
  const bot     = `└${'─'.repeat(c1)}┴${'─'.repeat(c2)}┴${'─'.repeat(c3)}┴${'─'.repeat(c4)}┘`;

  console.log('\n' + top);
  console.log(`│ ${pad('Metric', c1-2)} │ ${pad('GPT-4o Full', c2-2)} │ ${pad('Claude Sonnet', c3-2)} │ ${pad('Claude Opus', c4-2)} │`);
  console.log(divider);
  for (const [metric, gv, sv, ov] of rows) {
    console.log(`│ ${pad(metric, c1-2)} │ ${pad(gv, c2-2)} │ ${pad(sv, c3-2)} │ ${pad(ov, c4-2)} │`);
  }
  console.log(bot);

  // Per trap breakdown
  console.log('\nPer trap type:');
  const t1 = 22, t2 = 14, t3 = 15, t4 = 13;
  const tdiv = `├${'─'.repeat(t1)}┼${'─'.repeat(t2)}┼${'─'.repeat(t3)}┼${'─'.repeat(t4)}┤`;
  const ttop = `┌${'─'.repeat(t1)}┬${'─'.repeat(t2)}┬${'─'.repeat(t3)}┬${'─'.repeat(t4)}┐`;
  const tbot = `└${'─'.repeat(t1)}┴${'─'.repeat(t2)}┴${'─'.repeat(t3)}┴${'─'.repeat(t4)}┘`;

  console.log(ttop);
  console.log(`│ ${pad('Trap', t1-2)} │ ${pad('GPT-4o Full', t2-2)} │ ${pad('Claude Sonnet', t3-2)} │ ${pad('Claude Opus', t4-2)} │`);
  console.log(tdiv);
  for (const tc of TEST_CASES) {
    const gVal = `${G.trapBreakdown[tc.trap]?.correct ?? '—'}/${G.trapBreakdown[tc.trap]?.total ?? RUNS}`;
    const sVal = sonnetAvail
      ? `${S.trapBreakdown[tc.trap]?.correct ?? '—'}/${S.trapBreakdown[tc.trap]?.total ?? RUNS}`
      : '—';
    const oVal = opusAvail
      ? `${O.trapBreakdown[tc.trap]?.correct ?? '—'}/${O.trapBreakdown[tc.trap]?.total ?? RUNS}`
      : '—';
    console.log(`│ ${pad(tc.trap, t1-2)} │ ${pad(gVal, t2-2)} │ ${pad(sVal, t3-2)} │ ${pad(oVal, t4-2)} │`);
  }
  console.log(tbot);
}

// ── MAIN ──────────────────────────────────────────────────────────
async function runComparison() {
  const ts = new Date().toISOString();
  console.log(`\n${'═'.repeat(62)}`);
  console.log('  Verify-answers Model Comparison');
  console.log(`  ${ts}`);
  console.log(`  GPT-4o Full vs Claude Sonnet (${SONNET_MODEL}) vs Claude Opus (${OPUS_MODEL})`);
  console.log(`  ${TEST_CASES.length} test cases × ${RUNS} runs × 3 models = ${TEST_CASES.length * RUNS * 3} total calls`);

  const claudeAvail = !!ANTHROPIC_KEY;
  if (!claudeAvail) {
    console.log('\n  ⚠  ANTHROPIC_API_KEY not set — Claude Sonnet and Opus tests skipped.');
    console.log('     Set ANTHROPIC_API_KEY in your .env and re-run to include Claude models.\n');
  }
  console.log(`${'═'.repeat(62)}\n`);

  const allResults = [];

  for (let run = 1; run <= RUNS; run++) {
    console.log(`Run ${run}/${RUNS} — running ${TEST_CASES.length} cases × 3 models in parallel...`);

    const runPromises = TEST_CASES.flatMap(tc => {
      const promises = [runCase(tc, callGPT, 'gpt-4o', run)];
      if (claudeAvail) {
        promises.push(runCase(tc, callClaude,      'claude-sonnet', run));
        promises.push(runCase(tc, callClaudeOpus,  'claude-opus',   run));
      }
      return promises;
    });

    const runResults = await Promise.all(runPromises);
    allResults.push(...runResults);

    const gptRun    = runResults.filter(r => r.model === 'gpt-4o');
    const sonnetRun = runResults.filter(r => r.model === 'claude-sonnet');
    const opusRun   = runResults.filter(r => r.model === 'claude-opus');

    const fmt = (arr) =>
      `${arr.filter(r => r.correct).length}/${arr.length} correct, ${arr.filter(r => r.falsePositive).length} FP`;

    console.log(`  GPT-4o:        ${fmt(gptRun)}`);
    if (claudeAvail) {
      console.log(`  Claude Sonnet: ${fmt(sonnetRun)}`);
      console.log(`  Claude Opus:   ${fmt(opusRun)}`);
    }

    // Per-case breakdown
    for (const tc of TEST_CASES) {
      const g = gptRun.find(r => r.id === tc.id);
      const s = sonnetRun.find(r => r.id === tc.id);
      const o = opusRun.find(r => r.id === tc.id);

      const icon = (r) => !r ? ' ' : r.error ? 'E' : r.correct ? '✓' : '✗';
      const ans  = (r) => !r ? '—' : r.error ? 'ERR' : (r.modelAnswer || '?');

      const trapPad = tc.trap.padEnd(20);
      let line = `    [${trapPad}] GPT:${icon(g)}(${ans(g).padEnd(9)})`;
      if (claudeAvail) {
        line += ` Sonnet:${icon(s)}(${ans(s).padEnd(9)}) Opus:${icon(o)}(${ans(o)})`;
      }
      console.log(line);
    }
    console.log();
  }

  // ── Aggregate stats ───────────────────────────────────────────
  const gptAll    = allResults.filter(r => r.model === 'gpt-4o');
  const sonnetAll = allResults.filter(r => r.model === 'claude-sonnet');
  const opusAll   = allResults.filter(r => r.model === 'claude-opus');

  const gptStats    = calcStats(gptAll);
  const sonnetStats = claudeAvail ? calcStats(sonnetAll) : null;
  const opusStats   = claudeAvail ? calcStats(opusAll)   : null;

  console.log(`${'─'.repeat(62)}`);
  console.log('  RESULTS SUMMARY');
  console.log(`${'─'.repeat(62)}`);
  printComparisonTable(gptStats, sonnetStats, opusStats);

  const errors = allResults.filter(r => r.error);
  if (errors.length) {
    console.log(`\n  ⚠  ${errors.length} call(s) failed:`);
    errors.forEach(e =>
      console.log(`     Run ${e.run} | ${e.model} | Case ${e.id} (${e.trap}): ${e.error}`)
    );
  }

  // ── Save results ──────────────────────────────────────────────
  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
  const slug    = ts.replace(/[:.]/g, '-').slice(0, 23);
  const outPath = resolve(RESULTS_DIR, `model-comparison-${slug}Z.json`);

  const output = {
    timestamp: ts,
    config: {
      runs: RUNS,
      gptModel:    GPT_MODEL,
      sonnetModel: SONNET_MODEL,
      opusModel:   OPUS_MODEL,
      claudeAvail,
    },
    testCases: TEST_CASES.map(tc => ({
      id: tc.id, trap: tc.trap, correctAnswer: tc.correctAnswer, explanation: tc.explanation,
    })),
    summary: {
      'gpt-4o':         gptStats,
      'claude-sonnet':  sonnetStats,
      'claude-opus':    opusStats,
    },
    allResults,
  };

  writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\n  Saved: ${outPath}`);
  console.log(`${'═'.repeat(62)}\n`);

  return output;
}

runComparison().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
