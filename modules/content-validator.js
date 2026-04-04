// modules/content-validator.js
// Deterministic Content Validator (DCV) — zero-latency pure JS quality gate.
// Sits between every AI response and the student's screen.
//
// Architecture: plugin-based validation pipe.
// Each validator: (payload, requestedType) → null | { code, message, autofix: bool }
// payload is a single question/item object.
//
// Integration: call parseWithValidation(raw, prompt, requestedType, opts) everywhere
// you currently call parseAIJson(raw). The function validates, autofixes, and retries
// once with the rejection reason if non-autofix errors are found.
//
// logQualityEvent is the single Firestore quality logger for the whole app.
// Import it from here — do not create a second implementation elsewhere.

import { db }                       from './firebase.js';
import { currentUser, callAI }      from './state.js';
import { parseAIJson }              from './utils.js';
import {
  addDoc, collection, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ── QUALITY LOGGER ────────────────────────────────────────────────
// Single Firestore quality logger for all quality events across the app.
// Import and reuse this — do not duplicate elsewhere.
export async function logQualityEvent(type, details) {
  if (!currentUser) return;
  try {
    await addDoc(collection(db, 'qualityLogs'), {
      type,
      uid:       currentUser.uid,
      // No Firestore session ID is reliably available at log-time; uid+skillId+timestamp is the trace key.
      traceKey:  `${currentUser.uid}:${details.skillId || ''}:${Date.now()}`,
      timestamp: serverTimestamp(),
      ...details,
    });
  } catch { /* non-fatal */ }
}

// ── LAZY EXPLANATION SIGNALS ──────────────────────────────────────
const LAZY_PHRASES = [
  'accurately summarizes',
  'main focus',
  'directly addresses',
  'is the correct answer',
  'captures the essential idea',
  'correctly identifies',
];

// ── VALIDATORS ────────────────────────────────────────────────────
// Each returns null (pass) or { code, message, autofix: bool }.
// Autofixable validators mutate payload in-place before returning.

// 1. Format mismatch — wrong question type structure returned for the requested skill
function checkFormatMismatch(payload, requestedType) {
  const stmt = payload.statement || payload.text || '';

  if (requestedType === 'tfng' || requestedType === 'ynng') {
    if (/\bheading\b/i.test(stmt)) {
      return {
        code:    'TYPE_MISMATCH',
        message: `Expected ${requestedType.toUpperCase()} question but the statement contains "Heading" — this looks like a Matching Headings question. Regenerate as a ${requestedType === 'tfng' ? 'True/False/Not Given' : 'Yes/No/Not Given'} statement about a fact in the passage.`,
        autofix: false,
      };
    }
    const opts = payload.options;
    if (Array.isArray(opts) && opts.length > 0 && opts.length !== 3) {
      return {
        code:    'TYPE_MISMATCH',
        message: `${requestedType.toUpperCase()} questions use exactly 3 fixed buttons (True/False/Not Given), but received an options array with ${opts.length} items. Remove the options array or reduce it to exactly 3 items.`,
        autofix: false,
      };
    }
  }

  if (requestedType === 'mc') {
    const opts = payload.options || [];
    if (opts.length < 4) {
      return {
        code:    'TYPE_MISMATCH',
        message: `Multiple Choice requires at least 4 options labelled A–D, received ${opts.length}. Provide exactly 4 options with distinct distractors.`,
        autofix: false,
      };
    }
  }

  return null;
}

// 2. Explanation depth — reject shallow/generic explanations shown to students
function checkExplanationDepth(payload, requestedType) {
  // Only enforce depth for skills where explanations are shown to students and passage-grounded
  const deepTypes = ['tfng', 'ynng', 'mc'];
  if (!deepTypes.includes(requestedType)) return null;

  const explanation = (payload.explanation || payload.insight || '').trim();
  if (!explanation) return null; // field absent for this item type — skip

  const words = explanation.split(/\s+/).filter(Boolean);
  if (words.length < 30) {
    return {
      code:    'SHALLOW_EXPLANATION',
      message: `Explanation is only ${words.length} words (minimum 30). Write a specific step-by-step explanation that names the exact evidence from the passage and explains why wrong answers are eliminated.`,
      autofix: false,
    };
  }

  const lower = explanation.toLowerCase();
  const lazyMatch = LAZY_PHRASES.find(p => lower.includes(p));
  if (lazyMatch) {
    return {
      code:    'SHALLOW_EXPLANATION',
      message: `Explanation uses a lazy stock phrase: "${lazyMatch}". Replace with specific reasoning: quote the exact sentence from the passage, name the logic type (e.g. synonym substitution, scope qualifier), and explain step by step.`,
      autofix: false,
    };
  }

  // Explanation must reference the passage — either via direct quotes or shared vocabulary
  const passage = (payload.passage || '').toLowerCase();
  if (passage) {
    const hasDirectQuote = /'[^']{3,}'|"[^"]{3,}"/.test(explanation);
    if (!hasDirectQuote) {
      const passageNorm       = passage.replace(/[^a-z ]/g, ' ');
      const significantWords  = words.filter(w => w.replace(/[^a-z]/gi, '').length > 5);
      const hasPassageWord    = significantWords.some(w =>
        passageNorm.includes(w.toLowerCase().replace(/[^a-z]/g, ''))
      );
      if (!hasPassageWord) {
        return {
          code:    'SHALLOW_EXPLANATION',
          message: 'Explanation must reference specific language from the passage — quote a key phrase or use words that appear verbatim in the passage to anchor the reasoning.',
          autofix: false,
        };
      }
    }
  }

  return null;
}

// 3. Markdown health — fix broken bold/italic markers (AUTOFIX: mutates payload)
function checkMarkdownHealth(payload) {
  const fields = ['explanation', 'insight', 'statement', 'passage', 'text'];
  let fixed = false;

  for (const field of fields) {
    const original = payload[field];
    if (typeof original !== 'string') continue;

    let text = original;

    // Odd number of ** means unclosed bold — strip all to prevent render corruption
    const boldCount = (text.match(/\*\*/g) || []).length;
    if (boldCount % 2 !== 0) {
      text  = text.replace(/\*\*/g, '');
      fixed = true;
    }

    // Strip lone * (italic) — not rendered by our simple boldify(), leaks as literal *
    const stripped = text.replace(/(?<!\*)\*(?!\*)/g, '');
    if (stripped !== text) { text = stripped; fixed = true; }

    payload[field] = text;
  }

  return fixed
    ? { code: 'BROKEN_MARKDOWN', message: 'Broken markdown stripped from question fields.', autofix: true }
    : null;
}

// 4. Answer format — pipe-separated values or missing answer fields
function checkAnswerFormat(payload, requestedType) {
  const answer = payload.answer;

  if (answer === undefined || answer === null || answer === '') {
    return {
      code:    'BAD_ANSWER_FORMAT',
      message: 'Answer field is missing or empty. Every question must have a single definitive answer.',
      autofix: false,
    };
  }

  const ansStr = String(answer);

  if (requestedType === 'tfng' || requestedType === 'ynng') {
    if (ansStr.includes('|')) {
      return {
        code:    'BAD_ANSWER_FORMAT',
        message: `Answer "${ansStr}" contains pipe-separated values. For ${requestedType.toUpperCase()}, the answer must be exactly one of: ${requestedType === 'tfng' ? 'True, False, or Not Given' : 'Yes, No, or Not Given'}.`,
        autofix: false,
      };
    }
    if (ansStr.length > 10) {
      return {
        code:    'BAD_ANSWER_FORMAT',
        message: `Answer "${ansStr.slice(0, 40)}…" is too long. For ${requestedType.toUpperCase()}, answer must be True, False, Not Given, or NG.`,
        autofix: false,
      };
    }
  }

  return null;
}

// 5. Word count — flags student writing that falls short of the IELTS minimum
// NOTE: This validator fires on student responses, not AI content.
// Call validateAIResponse({ studentResponse: text }, 'writing-task1') to check writing.
function checkWordCount(payload, requestedType) {
  const text = payload.studentResponse || '';
  if (!text || !requestedType?.startsWith('writing-')) return null;

  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  const limit     = requestedType === 'writing-task1' ? 150 : requestedType === 'writing-task2' ? 250 : 0;

  if (limit && wordCount < limit) {
    return {
      code:    'UNDER_WORD_COUNT',
      message: `${requestedType === 'writing-task1' ? 'Task 1' : 'Task 2'} requires at least ${limit} words. You have written ${wordCount} words.`,
      autofix: false,
    };
  }

  return null;
}

// ── VALIDATION PIPE ───────────────────────────────────────────────
const validationPipe = [
  checkFormatMismatch,
  checkExplanationDepth,
  checkMarkdownHealth,
  checkAnswerFormat,
  checkWordCount,
];

// Run all validators on a single payload item.
// Autofixable validators mutate payload in-place as a side effect.
// Returns all errors found (both autofix and reject).
export function validateAIResponse(payload, requestedType) {
  const errors = [];
  for (const validator of validationPipe) {
    const error = validator(payload, requestedType);
    if (error) errors.push(error);
  }
  return errors; // empty array = pass
}

// ── PARSE WITH VALIDATION ─────────────────────────────────────────
// Drop-in replacement for parseAIJson(raw) at AI call sites.
//
// Parameters:
//   raw           — raw AI response string (output of callAI)
//   prompt        — the original prompt object {system, user, model?, maxTokens?}
//   requestedType — DCV type string: 'tfng' | 'ynng' | 'mc' | 'sc' | 'gapfill' |
//                   'matching' | 'matching-headings' | 'shortanswer' |
//                   'writing-task1' | 'writing-task2'
//   opts.skillId      — for quality log trace key
//   opts.extractItems — fn(parsed) → item[] — items to validate from the parsed object.
//                       Default: (p) => p.questions || []
//                       If items lack a passage field and parsed.passage exists,
//                       it is temporarily attached for checkExplanationDepth.
//
// Flow:
//   1. Parse raw JSON
//   2. Validate each item; autofixes mutate in-place
//   3. If non-autofix errors: log TYPE_MISMATCH, retry once with error message appended
//   4. If retry also fails: log VALIDATION_BYPASS, return attempt with fewer errors
export async function parseWithValidation(raw, prompt, requestedType, {
  skillId      = '',
  extractItems = (p) => p.questions || [],
} = {}) {

  function runValidation(parsed) {
    const rejectErrors = [];
    const sharedPassage = parsed.passage || '';

    for (const item of extractItems(parsed)) {
      if (!item || typeof item !== 'object') continue;

      // Temporarily attach passage for checkExplanationDepth cross-reference
      const addedPassage = !item.passage && sharedPassage;
      if (addedPassage) item.passage = sharedPassage;

      const errs = validateAIResponse(item, requestedType);
      // checkMarkdownHealth applied autofixes in-place above

      if (addedPassage) delete item.passage; // clean up — don't pollute question objects

      errs.filter(e => !e.autofix).forEach(e => rejectErrors.push(e));
    }
    return rejectErrors;
  }

  let parsed1;
  try { parsed1 = parseAIJson(raw); }
  catch { throw new Error('DCV: Failed to parse AI response as JSON'); }

  const rejectErrors1 = runValidation(parsed1);
  if (rejectErrors1.length === 0) return parsed1; // all validators passed

  // First attempt failed — log and retry once
  const errSummary = rejectErrors1.map(e => e.message).join('; ');
  logQualityEvent('TYPE_MISMATCH', {
    skillId,
    requestedType,
    errors: rejectErrors1.slice(0, 5).map(e => `${e.code}: ${e.message}`).join(' | '),
  }).catch(() => {});

  const retryPrompt = {
    ...prompt,
    user: `${prompt.user}\n\nYour previous response was rejected: ${errSummary}. Fix this specific issue in your regeneration.`,
  };

  let parsed2;
  try {
    const raw2 = await callAI(retryPrompt);
    parsed2    = parseAIJson(raw2);
  } catch {
    return parsed1; // retry call itself failed — return first attempt (autofixes already applied)
  }

  const rejectErrors2 = runValidation(parsed2);
  if (rejectErrors2.length === 0) return parsed2; // retry passed

  // Both attempts failed — return the one with fewer errors and log as bypass
  const winner = rejectErrors2.length <= rejectErrors1.length ? parsed2 : parsed1;
  logQualityEvent('VALIDATION_BYPASS', {
    skillId,
    requestedType,
    attempt1Errors: rejectErrors1.length,
    attempt2Errors: rejectErrors2.length,
    errorCodes:     rejectErrors2.slice(0, 3).map(e => e.code).join(','),
  }).catch(() => {});

  return winner;
}
