#!/usr/bin/env node
// scripts/review-question-bank.js
// Claude-powered review of every T/F/NG question set in the bank.
// Reads:  data/question-bank-tfng.json
// Writes: data/question-bank-tfng-reviewed.json
//
// Usage: node --env-file=.env scripts/review-question-bank.js
// Resumable — skips sets already marked verified or needs_correction.
// Rate-limited — batches of 3 with 15s pause + exponential backoff on 429.

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL         = 'claude-sonnet-4-5';
const BATCH_SIZE    = 3;
const BATCH_DELAY   = 15_000; // ms between batches
const MAX_RETRIES   = 3;
const RETRY_DELAY   = 30_000; // ms base delay on 429
const INPUT_FILE    = path.join(__dirname, '../data/question-bank-tfng.json');
const OUTPUT_FILE   = path.join(__dirname, '../data/question-bank-tfng-reviewed.json');

// ── HELPERS ───────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

function safeParseJson(raw) {
  try { return JSON.parse(raw.trim()); } catch { /* fall through */ }
  const m = raw.match(/\[[\s\S]*\]/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
  return null;
}

function estimateCost(inputTokens, outputTokens) {
  // claude-sonnet-4-5: $3/M input, $15/M output
  return (inputTokens / 1_000_000) * 3 + (outputTokens / 1_000_000) * 15;
}

// ── API CALL WITH BACKOFF ─────────────────────────────────────────────────────

async function callClaude(apiKey, systemPrompt, userPrompt) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(ANTHROPIC_URL, {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:       MODEL,
        max_tokens:  1000,
        temperature: 0,
        system:      systemPrompt,
        messages:    [{ role: 'user', content: userPrompt }],
      }),
    });

    if (res.ok) {
      const data = await res.json();
      return data.content?.[0]?.text || '';
    }

    const text = await res.text();

    if (res.status === 429) {
      const waitMs = RETRY_DELAY * attempt; // 30s, 60s, 90s
      lastErr = new Error(`Rate limit (429)`);
      if (attempt < MAX_RETRIES) {
        console.log(`    [Backoff] 429 rate limit — waiting ${waitMs / 1000}s (attempt ${attempt}/${MAX_RETRIES})...`);
        await sleep(waitMs);
        continue;
      }
    } else {
      throw new Error(`API ${res.status}: ${text.slice(0, 120)}`);
    }
  }
  throw lastErr;
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
    throw new Error(`Bad response format (got ${Array.isArray(reviews) ? reviews.length : typeof reviews} items)`);
  }

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

  const hasWrong   = flagged.some(f => !f.correct);
  const hasLowConf = flagged.some(f => f.correct && f.confidence !== 'high');
  const reviewStatus = hasWrong ? 'needs_correction'
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

  return { reviewStatus, flaggedQuestions: flagged, correctedQuestions };
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { console.error('ANTHROPIC_API_KEY not set'); process.exit(1); }
  if (!fs.existsSync(INPUT_FILE)) { console.error(`Input not found: ${INPUT_FILE}`); process.exit(1); }

  const bank  = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));
  const total = bank.length;
  const tsRun = new Date().toISOString();

  // ── Load checkpoint (existing reviewed output) ──────────────────────────────
  let checkpoint = {};
  if (fs.existsSync(OUTPUT_FILE)) {
    const existing = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
    for (const s of existing) {
      if (s.id && (s.reviewStatus === 'verified' || s.reviewStatus === 'needs_correction')) {
        checkpoint[s.id] = s;
      }
    }
    console.log(`\nCheckpoint loaded — ${Object.keys(checkpoint).length} sets already reviewed, skipping.`);
  }

  // ── Identify sets to process ────────────────────────────────────────────────
  const toProcess = bank.filter(s => !checkpoint[s.id]);
  const skipped   = total - toProcess.length;

  console.log(`\nClaude Bank Review — T/F/NG`);
  console.log(`Total: ${total} sets | To review: ${toProcess.length} | Skipped: ${skipped} | Batch: ${BATCH_SIZE} | Pause: ${BATCH_DELAY / 1000}s\n`);

  // Build output array seeded with checkpointed results
  const output = bank.map(s => checkpoint[s.id] || { ...s, reviewStatus: 'pending' });

  let doneThisRun     = 0;
  let verifiedCount   = 0;
  let correctionCount = 0;
  let reviewCount     = 0;
  let errorCount      = 0;
  let totalInputTok   = 0;
  let totalOutputTok  = 0;

  // ── Process in batches ──────────────────────────────────────────────────────
  for (let i = 0; i < toProcess.length; i += BATCH_SIZE) {
    const batch   = toProcess.slice(i, i + BATCH_SIZE);
    const batchNo = Math.floor(i / BATCH_SIZE) + 1;
    const batches = Math.ceil(toProcess.length / BATCH_SIZE);

    const results = await Promise.all(batch.map(async set => {
      const originalIdx = bank.findIndex(s => s.id === set.id);
      const displayIdx  = originalIdx + 1;
      const topicLabel  = (set.topic || set.id || `set-${originalIdx}`).toString().slice(0, 35);

      try {
        const { reviews, inputTokens, outputTokens } = await reviewSet(set, apiKey);
        const { reviewStatus, flaggedQuestions, correctedQuestions } = classifySet(set, reviews);

        totalInputTok  += inputTokens;
        totalOutputTok += outputTokens;
        doneThisRun++;

        const prefix = `[${String(displayIdx).padStart(3)}/${total}]`;

        if (reviewStatus === 'verified') {
          verifiedCount++;
          console.log(`${prefix} ✓ ${topicLabel} — 5/5 verified`);
        } else if (reviewStatus === 'needs_correction') {
          const wrongs = flaggedQuestions.filter(f => !f.correct);
          correctionCount += wrongs.length;
          for (const w of wrongs) {
            console.log(`${prefix} ✗ ${topicLabel} — Q${w.id}: ${w.bankAnswer} → ${w.verifiedAnswer} — ${(w.reasoning || '').slice(0, 80)}`);
          }
        } else {
          reviewCount++;
          for (const lc of flaggedQuestions.filter(f => f.correct && f.confidence !== 'high')) {
            console.log(`${prefix} ⚠ ${topicLabel} — Q${lc.id} ${lc.confidence} confidence flagged`);
          }
        }

        return { originalIdx, reviewed: { ...set, questions: correctedQuestions, reviewStatus, reviewedAt: tsRun, flaggedQuestions } };

      } catch (err) {
        doneThisRun++;
        errorCount++;
        console.log(`[${String(displayIdx).padStart(3)}/${total}] ✗ ERROR ${topicLabel}: ${err.message.slice(0, 80)}`);
        return { originalIdx, reviewed: { ...set, reviewStatus: 'error', reviewedAt: tsRun, flaggedQuestions: [], reviewError: err.message } };
      }
    }));

    // Write results back to output array and flush checkpoint to disk
    for (const { originalIdx, reviewed } of results) {
      output[originalIdx] = reviewed;
    }
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf8');

    // Batch pause (skip after last batch)
    const remaining = toProcess.length - i - BATCH_SIZE;
    if (remaining > 0) {
      console.log(`  [Batch ${batchNo}/${batches}] Waiting ${BATCH_DELAY / 1000}s before next batch... (${remaining} sets remaining)`);
      await sleep(BATCH_DELAY);
    }
  }

  // ── Final tally includes previously checkpointed sets ───────────────────────
  const allVerified    = output.filter(s => s.reviewStatus === 'verified').length;
  const allCorrections = output.reduce((n, s) => n + (s.flaggedQuestions?.filter(f => !f.correct).length || 0), 0);
  const allReview      = output.filter(s => s.reviewStatus === 'needs_review').length;
  const allErrors      = output.filter(s => s.reviewStatus === 'error').length;
  const estCost        = estimateCost(totalInputTok, totalOutputTok);

  console.log(`
═══════════════════════════════════════
CLAUDE BANK REVIEW — T/F/NG COMPLETE
═══════════════════════════════════════
Reviewed this run: ${doneThisRun} sets (${skipped} skipped from checkpoint)
Total bank status:
  ✓ Verified clean: ${allVerified} sets
  ✗ Wrong answers:  ${allCorrections} questions auto-corrected
  ⚠ Needs review:   ${allReview} sets
  ✗ Errors:         ${allErrors} sets
Estimated cost:   $${estCost.toFixed(4)}
Output: data/question-bank-tfng-reviewed.json
═══════════════════════════════════════`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
