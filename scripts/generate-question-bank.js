// scripts/generate-question-bank.js
// 5-stage IELTS T/F/NG question bank generator.
//
// Stages:
//   0 — Logic Matrix          (Claude Sonnet, temperature 0)   — 5 logic pair blueprints
//   1 — Passage Generation    (GPT-4o via Vercel proxy)         — weaves facts into academic prose
//   2 — Answer Verification   (api/verify-answers.js)           — corrects any wrong answers
//   3 — Passage Quality Gate  (api/evaluate-passage.js)         — IELTS standard gate (avg ≥ 3.5)
//   4 — Student Simulation    (Claude Sonnet, temperature 0.3)  — blind answer check
//
// Usage:
//   node --env-file=.env scripts/generate-question-bank.js [options]
//
// Flags:
//   --count       N       Number of sets to generate (default: 10)
//   --band        N       Target IELTS band 5.0–9.0 (default: 6.5)
//   --topic       STRING  Fixed topic; omit for random per set
//   --concurrency N       Parallel workers (default: 3)
//   --append      false   Overwrite existing bank instead of appending (default: append)

import { randomUUID }                                          from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname }                                    from 'path';
import { fileURLToPath }                                       from 'url';
import { verifyAnswers }                                       from '../api/verify-answers.js';
import { evaluatePassage }                                     from '../api/evaluate-passage.js';

const __dirname    = dirname(fileURLToPath(import.meta.url));
const ROOT         = resolve(__dirname, '..');
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const VERCEL_URL    = 'https://toody-api.vercel.app/api/generate';

// ── CONSTANTS ─────────────────────────────────────────────────────────────────

const RANDOM_TOPICS = [
  'Urban Development',
  'Climate Science',
  'Marine Biology',
  'Psychology',
  'Archaeological Discovery',
  'Renewable Energy',
  'Neuroscience',
  'Economic Policy',
  'Space Exploration',
  'Linguistic Research',
];

const LOGIC_TYPES = [
  'SYNONYM_SUBSTITUTION',
  'CAUTIOUS_LANGUAGE',
  'NEGATION_INVERSION',
  'SCOPE_QUALIFIER',
  'CAUSAL_ASSUMPTION',
];

const ERROR_REASON_MAP = {
  SYNONYM_SUBSTITUTION: 'synonymTrap',
  CAUTIOUS_LANGUAGE:    'cautiousLanguageMissed',
  NEGATION_INVERSION:   'negationOverlooked',
  SCOPE_QUALIFIER:      'scopeError',
  CAUSAL_ASSUMPTION:    'notGivenMarkedFalse',
};

// ── CLI ───────────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { count: 10, band: 6.5, topic: null, concurrency: 3, append: true };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--count':       opts.count       = parseInt(args[++i], 10)  || 10;  break;
      case '--band':        opts.band        = parseFloat(args[++i])    || 6.5; break;
      case '--topic':       opts.topic       = args[++i];                       break;
      case '--concurrency': opts.concurrency = parseInt(args[++i], 10)  || 3;   break;
      case '--append':      opts.append      = args[++i] !== 'false';           break;
    }
  }
  return opts;
}

// ── UTILITIES ─────────────────────────────────────────────────────────────────

function safeParseJson(raw) {
  const cleaned = (raw || '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
  return JSON.parse(cleaned);
}

function loadBank(relPath) {
  const full = resolve(ROOT, relPath);
  if (!existsSync(full)) return [];
  try { return JSON.parse(readFileSync(full, 'utf8')); } catch { return []; }
}

function saveBank(relPath, entries) {
  const full = resolve(ROOT, relPath);
  const dir  = dirname(full);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(full, JSON.stringify(entries, null, 2), 'utf8');
}

// ── CONCURRENCY POOL ──────────────────────────────────────────────────────────
// Runs up to `concurrency` tasks simultaneously. Preserves result order.

async function runPool(taskFns, concurrency) {
  const results = new Array(taskFns.length);
  let next = 0;
  async function worker() {
    while (next < taskFns.length) {
      const i = next++;
      results[i] = await taskFns[i]();
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, taskFns.length) }, worker)
  );
  return results;
}

// ── STAGE 0 — LOGIC MATRIX ────────────────────────────────────────────────────
// Claude Sonnet at temperature 0 generates 5 blueprint logic pairs.
// Each pair specifies the exact fact sentence, the statement the student reads,
// the answer, and the anchor text — before any passage exists.

async function stageLogicMatrix(topic, band, apiKey) {
  const res = await fetch(ANTHROPIC_URL, {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:       'claude-sonnet-4-5',
      max_tokens:  1200,
      temperature: 0,
      messages: [{
        role:    'user',
        content:
`Generate exactly 5 T/F/NG logic pairs for a Band ${band} IELTS Academic reading question set about ${topic}.
Use exactly one of each logic type:
- SYNONYM_SUBSTITUTION → answer: True (passage confirms using different words)
- CAUTIOUS_LANGUAGE → answer: Not Given (passage uses may/might/could/suggests)
- NEGATION_INVERSION → answer: False (passage says X exists/occurs, statement says it does not)
- SCOPE_QUALIFIER → answer: False (passage says some/most/usually, statement says all/always/never)
- CAUSAL_ASSUMPTION → answer: Not Given (passage shows sequence, statement claims causation)

For each pair return:
{
  "logicType": string,
  "complexityLevel": number (1-5 where 1=direct synonym, 3=scope/qualifier, 5=causal+negation combined),
  "fact": string (exact sentence that will appear verbatim in the passage),
  "anchorText": string (the specific word or phrase that makes this true/false/ng — e.g. "most", "may suggest", "after"),
  "statement": string (what the IELTS student reads),
  "answer": "True" | "False" | "Not Given",
  "whyCorrect": string (one sentence logical proof)
}

Return valid JSON array of 5 objects. Nothing else.`,
      }],
    }),
  });

  if (!res.ok) throw new Error(`Stage 0 API error: ${res.status} ${await res.text()}`);
  const data  = await res.json();
  const raw   = data.content?.[0]?.text || '';
  const pairs = safeParseJson(raw);

  if (!Array.isArray(pairs) || pairs.length !== 5) {
    throw new Error(`Stage 0: expected 5 logic pairs, got ${Array.isArray(pairs) ? pairs.length : typeof pairs}`);
  }
  return pairs;
}

// ── STAGE 1 — PASSAGE GENERATION ─────────────────────────────────────────────
// GPT-4o receives the 5 fact sentences as hard constraints and must embed them
// verbatim. Questions are constructed directly from Stage 0 pairs — GPT-4o
// is not asked to generate questions.

async function stagePassageGeneration(topic, logicPairs, band) {
  const factList = logicPairs.map((p, i) => `${i + 1}. ${p.fact}`).join('\n');

  const res = await fetch(VERCEL_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [
        {
          role:    'system',
          content: 'You are an expert IELTS Academic passage writer. Return valid JSON only, no markdown, no preamble.',
        },
        {
          role:    'user',
          content:
`Write a 300-400 word IELTS Academic passage about ${topic} that naturally contains these exact sentences verbatim (do not alter the wording of any of them):

${factList}

The passage must read as coherent academic prose with a clear argument structure. Surround each fact naturally within the academic context.

Return JSON: { "passage": string, "topic": string }`,
        },
      ],
      max_tokens:  900,
      temperature: 0.7,
    }),
  });

  if (!res.ok) throw new Error(`Stage 1 API error: ${res.status}`);
  const data   = await res.json();
  const raw    = data.choices?.[0]?.message?.content || '';
  const parsed = safeParseJson(raw);

  if (!parsed.passage) throw new Error('Stage 1: no passage field in response');

  // Build questions from Stage 0 logic pairs — deterministic, no AI call
  const questions = logicPairs.map((pair, i) => ({
    id:              i + 1,
    text:            pair.statement,
    answer:          pair.answer,
    logicType:       pair.logicType,
    passageAnchor:   pair.fact,
    anchorText:      pair.anchorText,
    complexityLevel: pair.complexityLevel,
    explanation:     pair.whyCorrect,
    errorReason:     ERROR_REASON_MAP[pair.logicType] || 'other',
  }));

  return { passage: parsed.passage, topic: parsed.topic || topic, questions };
}

// ── STAGE 2 — ANSWER VERIFICATION ────────────────────────────────────────────
// Reuses the existing verify-answers.js agent (GPT-4o, temperature 0).
// verifyAnswers is non-fatal internally; this wrapper propagates unexpected errors
// so the set is dropped rather than silently accepted with unverified answers.

async function stageVerification(passage, questions) {
  const result = await verifyAnswers(passage, questions, VERCEL_URL);
  return { questions: result.questions, corrections: result.corrections };
}

// ── STAGE 3 — PASSAGE QUALITY GATE ───────────────────────────────────────────
// Reuses the existing evaluate-passage.js agent (GPT-4o, temperature 0).
// Pass threshold: avgScore >= 3.5 AND no individual dimension below 3.

async function stageQualityGate(passage, band) {
  return evaluatePassage(passage, band, VERCEL_URL);
}

// ── STAGE 4 — BLIND STUDENT SIMULATION ───────────────────────────────────────
// Claude Sonnet at temperature 0.3 plays a Band 6 student with NO access to
// answer keys, logic types, or metadata. Answers are compared to the bank.
// 0–1 mismatch → approved (1 mismatch logged as warning)
// 2+ mismatches → rejected with full mismatch detail

async function stageStudentSimulation(passage, questions, apiKey) {
  const qList = questions.map((q, i) => `${i + 1}. ${q.text}`).join('\n');

  const res = await fetch(ANTHROPIC_URL, {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:       'claude-sonnet-4-5',
      max_tokens:  512,
      temperature: 0.3,
      messages: [{
        role:    'user',
        content:
`You are an IELTS Academic student at Band 6.0. Read this passage and answer these True/False/Not Given questions based only on what the passage says. Apply strict IELTS rules: True = passage explicitly confirms, False = passage explicitly contradicts, Not Given = passage does not address.

Passage: ${passage}

Questions:
${qList}

Return JSON array: [{ "questionId": 1, "answer": "True"|"False"|"Not Given", "confidence": "high"|"medium"|"low" }]
Nothing else.`,
      }],
    }),
  });

  if (!res.ok) throw new Error(`Stage 4 API error: ${res.status}`);
  const data       = await res.json();
  const raw        = data.content?.[0]?.text || '';
  const simAnswers = safeParseJson(raw);

  if (!Array.isArray(simAnswers)) throw new Error('Stage 4: response is not an array');

  return simAnswers.map(s => {
    const bankQ   = questions.find(q => q.id === s.questionId);
    const matched = bankQ ? s.answer === bankQ.answer : false;
    return {
      questionId:    s.questionId,
      studentAnswer: s.answer,
      bankAnswer:    bankQ?.answer ?? '?',
      confidence:    s.confidence,
      matched,
    };
  });
}

// ── ENTRY BUILDER ─────────────────────────────────────────────────────────────

function buildEntry({ topic, band, passage, questions, corrections, quality, simulation, rejectedReason }) {
  const simMap     = Object.fromEntries((simulation || []).map(s => [s.questionId, s]));
  const corrSet    = new Set((corrections || []).map(c => c.questionId));
  const mismatches = (simulation || []).filter(s => !s.matched);
  const flagged    = (simulation || [])
    .filter(s => s.confidence === 'low')
    .map(s => s.questionId);

  const complexities = (questions || []).map(q => q.complexityLevel).filter(Number.isFinite);
  const avgC = complexities.length
    ? Math.round(complexities.reduce((a, b) => a + b, 0) / complexities.length * 10) / 10
    : null;

  const enrichedQs = (questions || []).map(q => ({
    ...q,
    keySentence:       q.passageAnchor,
    verified:          !corrSet.has(q.id),
    studentSimulation: simMap[q.id]
      ? { answer: simMap[q.id].studentAnswer, confidence: simMap[q.id].confidence, matched: simMap[q.id].matched }
      : null,
  }));

  let simResult = 'not_run';
  if (simulation) simResult = mismatches.length >= 2 ? 'rejected' : 'approved';

  const entry = {
    id:       randomUUID(),
    band,
    topic,
    passage:  passage || '',
    questions: enrichedQs,
    meta: {
      generatedAt:             new Date().toISOString(),
      band,
      passageQuality:          quality
        ? { avgScore: quality.avgScore, scores: quality.scores }
        : null,
      verificationCorrections: (corrections || []).length,
      studentSimulationResult: simResult,
      logicDistribution:       Object.fromEntries(
        LOGIC_TYPES.map(lt => [lt, (questions || []).filter(q => q.logicType === lt).length])
      ),
      complexityProfile: {
        avg: avgC,
        min: complexities.length ? Math.min(...complexities) : null,
        max: complexities.length ? Math.max(...complexities) : null,
      },
      flaggedForReview: flagged,
    },
  };

  if (rejectedReason) entry.rejectedReason = rejectedReason;
  return entry;
}

// ── GENERATE ONE SET ──────────────────────────────────────────────────────────

async function generateOneSet(idx, total, topic, band, apiKey) {
  const prefix = `[${String(idx).padStart(String(total).length)}/${total}]`;
  const log    = msg => process.stdout.write(`${prefix} ${msg}\n`);

  try {
    // Stage 0
    log('⟳ Stage 0: Logic matrix...');
    const logicPairs = await stageLogicMatrix(topic, band, apiKey);

    // Stage 1
    log('⟳ Stage 1: Passage generation...');
    const { passage, topic: resolvedTopic, questions } = await stagePassageGeneration(topic, logicPairs, band);

    // Stage 2
    log('⟳ Stage 2: Verification...');
    const { questions: verifiedQs, corrections } = await stageVerification(passage, questions);

    // Stage 3
    log('⟳ Stage 3: Quality gate...');
    const quality = await stageQualityGate(passage, band);
    if (!quality.pass) {
      const entry = buildEntry({
        topic: resolvedTopic, band, passage, questions: verifiedQs,
        corrections, quality, simulation: null, rejectedReason: 'quality_gate',
      });
      const reasons = (quality.failReasons || []).join('; ') || `avg ${quality.avgScore ?? 'n/a'}`;
      log(`✗ Rejected — quality_gate (${reasons})`);
      return { status: 'rejected', reason: 'quality_gate', entry };
    }

    // Stage 4
    log('⟳ Stage 4: Student simulation...');
    const simulation = await stageStudentSimulation(passage, verifiedQs, apiKey);
    const mismatches = simulation.filter(s => !s.matched);

    const status         = mismatches.length >= 2 ? 'rejected' : 'approved';
    const rejectedReason = status === 'rejected' ? 'student_simulation_fail' : null;

    const entry = buildEntry({
      topic: resolvedTopic, band, passage, questions: verifiedQs,
      corrections, quality, simulation, rejectedReason,
    });

    if (status === 'approved') {
      const warnSuffix    = mismatches.length === 1
        ? ` (1 ambiguous Q — warning logged)`
        : '';
      const avgComplexity = entry.meta.complexityProfile.avg ?? '?';
      const simScore      = `${5 - mismatches.length}/5`;
      log(`✓ ${resolvedTopic} | quality ${quality.avgScore} | corrections ${corrections.length} | simulation ${simScore} | complexity avg ${avgComplexity}${warnSuffix}`);
    } else {
      const mismatchDesc = mismatches
        .map(m => `Q${m.questionId} student=${m.studentAnswer} bank=${m.bankAnswer}`)
        .join(', ');
      log(`✗ Rejected — student_simulation_fail (${mismatches.length} mismatches: ${mismatchDesc})`);
    }

    return { status, reason: rejectedReason, entry };

  } catch (err) {
    log(`✗ Rejected — pipeline_error: ${err.message}`);
    return {
      status: 'rejected',
      reason: 'pipeline_error',
      entry:  {
        id:            randomUUID(),
        topic,
        band,
        rejectedReason: 'pipeline_error',
        error:          err.message,
        meta:           { generatedAt: new Date().toISOString() },
      },
    };
  }
}

// ── SUMMARY ───────────────────────────────────────────────────────────────────

function printSummary(results, allApproved) {
  const approved    = results.filter(r => r.status === 'approved');
  const rejected    = results.filter(r => r.status !== 'approved');
  const qualGateRej = rejected.filter(r => r.reason === 'quality_gate').length;
  const simRej      = rejected.filter(r => r.reason === 'student_simulation_fail').length;
  const otherRej    = rejected.length - qualGateRej - simRej;

  const approvedQs  = allApproved.flatMap(e => e.questions || []);
  const flagged     = allApproved.reduce((s, e) => s + (e.meta?.flaggedForReview?.length || 0), 0);

  const logicDist   = Object.fromEntries(
    LOGIC_TYPES.map(lt => [lt, approvedQs.filter(q => q.logicType === lt).length])
  );
  const complexities = approvedQs.map(q => q.complexityLevel).filter(Number.isFinite);
  const easy   = complexities.filter(c => c <= 2).length;
  const medium = complexities.filter(c => c === 3).length;
  const hard   = complexities.filter(c => c >= 4).length;
  const total  = approvedQs.length || 1;

  const rejParts = [];
  if (qualGateRej) rejParts.push(`quality_gate: ${qualGateRej}`);
  if (simRej)      rejParts.push(`student_sim: ${simRej}`);
  if (otherRej)    rejParts.push(`other: ${otherRej}`);

  const SEP = '═'.repeat(39);
  console.log(`\n${SEP}`);
  console.log('TOODY QUESTION BANK — GENERATION COMPLETE');
  console.log(SEP);
  console.log(`Sets attempted:     ${results.length}`);
  console.log(`✓ Approved:        ${approved.length}`);
  console.log(`✗ Rejected:         ${rejected.length}${rejected.length ? ` (${rejParts.join(', ')})` : ''}`);
  console.log(`Questions approved: ${approvedQs.length}`);
  console.log(`Flagged for review: ${flagged} questions`);
  console.log('');
  console.log('Logic distribution across approved sets:');
  LOGIC_TYPES.forEach(lt => {
    const n = logicDist[lt] || 0;
    console.log(`  ${lt.padEnd(24)}: ${String(n).padStart(3)} (${Math.round(n / total * 100)}%)`);
  });
  console.log('');
  console.log('Complexity profile:');
  console.log(`  Level 1-2 (easy):   ${String(easy).padStart(3)} questions (${Math.round(easy   / total * 100)}%)`);
  console.log(`  Level 3 (medium):   ${String(medium).padStart(3)} questions (${Math.round(medium / total * 100)}%)`);
  console.log(`  Level 4-5 (hard):   ${String(hard).padStart(3)} questions (${Math.round(hard   / total * 100)}%)`);
  console.log('');
  console.log(`Bank total: ${approvedQs.length} questions across ${allApproved.length} sets`);
  console.log(`Output: data/question-bank.json`);
  console.log(`Rejected: data/question-bank-rejected.json`);
  console.log(`${SEP}\n`);
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

async function main() {
  const opts   = parseArgs();
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    console.error(
      'Error: ANTHROPIC_API_KEY environment variable is required.\n' +
      'Set it with:  export ANTHROPIC_API_KEY=sk-ant-...\n' +
      'Or run with:  node --env-file=.env scripts/generate-question-bank.js'
    );
    process.exit(1);
  }

  const OUT_PATH = 'data/question-bank.json';
  const REJ_PATH = 'data/question-bank-rejected.json';

  console.log('\nToody Question Bank Generator');
  console.log(`Count: ${opts.count}  |  Band: ${opts.band}  |  Concurrency: ${opts.concurrency}`);
  console.log(`Topic: ${opts.topic || 'random per set'}`);
  console.log(`Mode:  ${opts.append ? 'append to existing bank' : 'overwrite existing bank'}\n`);

  const existingApproved = opts.append ? loadBank(OUT_PATH) : [];
  const existingRejected = opts.append ? loadBank(REJ_PATH) : [];

  // Build topic list up front so each task has its topic bound at creation time
  const topicPool = opts.topic ? null : [...RANDOM_TOPICS];
  function pickTopic() {
    if (opts.topic) return opts.topic;
    if (!topicPool.length) topicPool.push(...RANDOM_TOPICS);
    const i = Math.floor(Math.random() * topicPool.length);
    return topicPool.splice(i, 1)[0];
  }

  const taskFns = Array.from({ length: opts.count }, (_, i) => {
    const topic = pickTopic();
    return () => generateOneSet(i + 1, opts.count, topic, opts.band, apiKey);
  });

  const results = await runPool(taskFns, opts.concurrency);

  const newApproved = results.filter(r => r.status === 'approved').map(r => r.entry);
  const newRejected = results.filter(r => r.status !== 'approved').map(r => r.entry);

  const allApproved = [...existingApproved, ...newApproved];
  const allRejected = [...existingRejected, ...newRejected];

  saveBank(OUT_PATH, allApproved);
  saveBank(REJ_PATH, allRejected);

  printSummary(results, allApproved);
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
