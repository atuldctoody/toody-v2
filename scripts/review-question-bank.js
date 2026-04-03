#!/usr/bin/env node
// scripts/review-question-bank.js
// Claude-powered review of every T/F/NG question set in the bank.
// Reads:  data/question-bank-tfng.json
// Writes: data/question-bank-tfng-reviewed.json
//
// Usage: node --env-file=.env scripts/review-question-bank.js

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL         = 'claude-sonnet-4-5';
const CONCURRENCY   = 5;
const INPUT_FILE    = path.join(__dirname, '../data/question-bank-tfng.json');
const OUTPUT_FILE   = path.join(__dirname, '../data/question-bank-tfng-reviewed.json');

// ── API HELPER ────────────────────────────────────────────────────────────────

async function callClaude(apiKey, systemPrompt, userPrompt) {
  const res = await fetch(ANTHROPIC_URL, {
    method:  'POST',
    headers: {
      'Content-Type':    'application/json',
      'x-api-key':       apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      MODEL,
      max_tokens: 1000,
      temperature: 0,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userPrompt }],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text}`);
  }
  const data = await res.json();
  return data.content?.[0]?.text || '';
}

// ── JSON PARSER ───────────────────────────────────────────────────────────────

function safeParseJson(raw) {
  try {
    return JSON.parse(raw.trim());
  } catch {
    const m = raw.match(/\[[\s\S]*\]/);
    if (m) {
      try { return JSON.parse(m[0]); } catch { /* fall through */ }
    }
    return null;
  }
}

// ── TOKEN COST ESTIMATE ───────────────────────────────────────────────────────
// claude-sonnet-4-5: $3/M input, $15/M output (approximate)

function estimateCost(inputTokens, outputTokens) {
  return (inputTokens / 1_000_000) * 3 + (outputTokens / 1_000_000) * 15;
}

// ── REVIEW ONE SET ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  'You are a strict IELTS examiner with 30 years experience. ' +
  'Apply the Lawyer Rule to each question: can you underline the exact passage text that proves the answer? ' +
  'Zero tolerance for ambiguity.';

async function reviewSet(set, apiKey) {
  const userPrompt =
`Passage: ${set.passage}

Verify if each stated answer is correct:
- TRUE: passage explicitly confirms using synonyms or paraphrase — no inference allowed
- FALSE: passage explicitly contradicts — provable by underlining exact passage text
- NOT GIVEN: passage is genuinely silent — not hinting, not implying

Critical patterns to catch:
- 'a/an [noun]' in passage + 'only/solely/the only' in statement = FALSE not NOT GIVEN
- Reporting verbs (argue, suggest, believe) + statement as fact = NOT GIVEN
- Cautious language (may/might/could) + definite statement = NOT GIVEN
- 'Although X, Y' — Y is truth, X is distractor
- Sequence ≠ causation — temporal order does not imply cause

Questions:
${set.questions.map((q, i) => `Q${i + 1}: ${q.text} | Answer: ${q.answer}`).join('\n')}

Return JSON array only — no other text:
[{ "id": number, "bankAnswer": string, "verifiedAnswer": string, "correct": boolean, "confidence": "high"|"medium"|"low", "reasoning": string }]`;

  const raw     = await callClaude(apiKey, SYSTEM_PROMPT, userPrompt);
  const reviews = safeParseJson(raw);

  if (!Array.isArray(reviews) || reviews.length !== set.questions.length) {
    throw new Error(`Unexpected response format (got ${Array.isArray(reviews) ? reviews.length : typeof reviews} items)`);
  }

  // Rough token estimate for cost tracking
  const inputTokens  = Math.ceil((SYSTEM_PROMPT.length + userPrompt.length) / 4);
  const outputTokens = Math.ceil(raw.length / 4);

  return { reviews, inputTokens, outputTokens };
}

// ── CLASSIFY SET ──────────────────────────────────────────────────────────────

function classifySet(set, reviews) {
  const flagged = [];

  for (const r of reviews) {
    if (!r.correct || r.confidence !== 'high') {
      flagged.push({
        id:             r.id,
        bankAnswer:     r.bankAnswer,
        verifiedAnswer: r.verifiedAnswer,
        correct:        r.correct,
        confidence:     r.confidence,
        reasoning:      r.reasoning,
      });
    }
  }

  const hasWrong      = flagged.some(f => !f.correct);
  const hasLowConf    = flagged.some(f => f.correct && f.confidence !== 'high');
  const reviewStatus  = hasWrong ? 'needs_correction'
                      : hasLowConf ? 'needs_review'
                      : 'verified';

  // Auto-correct high-confidence wrong answers
  const correctedQuestions = set.questions.map((q, i) => {
    const r = reviews.find(rv => rv.id === i + 1) || reviews[i];
    if (!r) return q;
    if (!r.correct && r.confidence === 'high') {
      return { ...q, answer: r.verifiedAnswer, autoCorrectReason: r.reasoning };
    }
    return q;
  });

  return {
    reviewStatus,
    flaggedQuestions: flagged,
    correctedQuestions,
  };
}

// ── CONCURRENCY POOL ──────────────────────────────────────────────────────────

async function runPool(taskFns, concurrency) {
  const results = new Array(taskFns.length);
  let next = 0;
  async function worker() {
    while (next < taskFns.length) {
      const i = next++;
      results[i] = await taskFns[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, taskFns.length) }, worker));
  return results;
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { console.error('ANTHROPIC_API_KEY not set'); process.exit(1); }

  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`Input not found: ${INPUT_FILE}`);
    process.exit(1);
  }

  const bank   = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8')); // eslint-disable-line
  const total  = bank.length;
  const tsRun  = new Date().toISOString();

  console.log(`\nClaude Bank Review — T/F/NG`);
  console.log(`Sets: ${total} | Concurrency: ${CONCURRENCY} | Model: ${MODEL}\n`);

  let done            = 0;
  let verifiedCount   = 0;
  let correctionCount = 0;
  let reviewCount     = 0;
  let totalInputTok   = 0;
  let totalOutputTok  = 0;
  const output        = [];

  const tasks = bank.map((set, idx) => async () => {
    let reviewed;
    try {
      const { reviews, inputTokens, outputTokens } = await reviewSet(set, apiKey);
      const { reviewStatus, flaggedQuestions, correctedQuestions } = classifySet(set, reviews);

      totalInputTok  += inputTokens;
      totalOutputTok += outputTokens;
      done++;

      const prefix = `[${String(done).padStart(3)}/${total}]`;
      const topicLabel = (set.topic || set.id || `set-${idx}`).toString().slice(0, 35);

      if (reviewStatus === 'verified') {
        verifiedCount++;
        console.log(`${prefix} ✓ ${topicLabel} — 5/5 verified`);
      } else if (reviewStatus === 'needs_correction') {
        const wrongs = flaggedQuestions.filter(f => !f.correct);
        correctionCount += wrongs.length;
        for (const w of wrongs) {
          const snippet = w.reasoning?.slice(0, 80) || '';
          console.log(`${prefix} ✗ ${topicLabel} — Q${w.id}: ${w.bankAnswer} → ${w.verifiedAnswer} — ${snippet}`);
        }
      } else {
        reviewCount++;
        const lowConf = flaggedQuestions.filter(f => f.correct && f.confidence !== 'high');
        for (const lc of lowConf) {
          console.log(`${prefix} ⚠ ${topicLabel} — Q${lc.id} ${lc.confidence} confidence flagged`);
        }
      }

      reviewed = {
        ...set,
        questions:       correctedQuestions,
        reviewStatus,
        reviewedAt:      tsRun,
        flaggedQuestions,
      };
    } catch (err) {
      done++;
      console.log(`[${String(done).padStart(3)}/${total}] ✗ ERROR set ${idx}: ${err.message}`);
      reviewed = {
        ...set,
        reviewStatus:    'error',
        reviewedAt:      tsRun,
        flaggedQuestions: [],
        reviewError:     err.message,
      };
    }

    output[idx] = reviewed;
  });

  await runPool(tasks, CONCURRENCY);

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf8');

  const estCost = estimateCost(totalInputTok, totalOutputTok);

  console.log(`
═══════════════════════════════════════
CLAUDE BANK REVIEW — T/F/NG COMPLETE
═══════════════════════════════════════
Reviewed:         ${total} sets / ${total * 5} questions
✓ Verified clean: ${verifiedCount} sets
✗ Wrong answers:  ${correctionCount} questions flagged
⚠ Needs review:   ${reviewCount} sets
Estimated cost:   $${estCost.toFixed(4)}
Output: data/question-bank-tfng-reviewed.json
═══════════════════════════════════════`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
