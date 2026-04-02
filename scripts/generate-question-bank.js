// scripts/generate-question-bank.js
// Multi-type IELTS question bank generator — 11 question types supported.
//
// Stages:
//   0   — Logic Matrix / Plan  (Claude Sonnet, temperature 0)
//   0.5 — Logic Pair Validation (TFNG + YNNG only, Claude Sonnet, temperature 0)
//   1   — Content Generation   (GPT-4o via Vercel proxy)
//   2   — Answer Verification  (TFNG + YNNG only, api/verify-answers.js)
//   3   — Quality Gate         (all types, api/evaluate-passage.js)
//   4   — Student Simulation   (Claude Sonnet, temperature 0.3)
//
// Usage:
//   node --env-file=.env scripts/generate-question-bank.js [options]
//
// Flags:
//   --type        TYPE    Question type (default: tfng). See VALID_TYPES below.
//   --count       N       Number of sets to generate (default: 10)
//   --band        N       Target IELTS band 5.0–9.0 (default: 6.5)
//   --topic       STRING  Fixed topic; omit for random per set
//   --concurrency N       Parallel workers (default: 3)
//   --append      false   Overwrite existing bank (default: append)

import { randomUUID }                                          from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname }                                    from 'path';
import { fileURLToPath }                                       from 'url';
import { verifyAnswers }                                       from '../api/verify-answers.js';
import { evaluatePassage }                                     from '../api/evaluate-passage.js';

const __dirname     = dirname(fileURLToPath(import.meta.url));
const ROOT          = resolve(__dirname, '..');
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const VERCEL_URL    = 'https://toody-api.vercel.app/api/generate';

// Barron's calibration — loaded once, used as context for TFNG Stage 0
const barrons = (() => {
  try {
    return JSON.parse(readFileSync(resolve(__dirname, '..', 'data', 'barrons-calibration.json'), 'utf8'));
  } catch { return []; }
})();

// ── TYPE CONFIGS ──────────────────────────────────────────────────────────────

const VALID_TYPES = [
  'tfng', 'ynng', 'summary-completion', 'sentence-completion',
  'multiple-choice', 'short-answer', 'matching-headings',
  'matching-information', 'matching-features', 'listening-mc', 'listening-form',
];

const TYPE_CONFIG = {
  'tfng': {
    label:           'True/False/Not Given',
    bankFile:        'data/question-bank-tfng.json',
    rejFile:         'data/question-bank-tfng-rejected.json',
    collectionId:    'questionBank-tfng',
    runVerification: true,
    runStage05:      true,
    useLeadPlan:     true,
    mutations:       ['SYNONYM_SUBSTITUTION', 'DIRECT_CONTRADICTION', 'NOT_GIVEN_NO_EVIDENCE', 'CONCESSIVE_TRAP', 'NOT_GIVEN_TOPIC_ADJACENT'],
    mutWeights:      [0.40, 0.20, 0.15, 0.15, 0.10],
  },
  'ynng': {
    label:           'Yes/No/Not Given',
    bankFile:        'data/question-bank-ynng.json',
    rejFile:         'data/question-bank-ynng-rejected.json',
    collectionId:    'questionBank-ynng',
    runVerification: false,  // verify-answers agent only handles T/F/NG
    runStage05:      true,
    useLeadPlan:     true,
    mutations:       ['AUTHOR_AGREES', 'AUTHOR_DISAGREES', 'NEUTRAL_AUTHOR', 'HEDGED_OPINION', 'BALANCED_REPORTING'],
    mutWeights:      [0.20, 0.20, 0.20, 0.20, 0.20],
  },
  'summary-completion': {
    label:           'Summary Completion',
    bankFile:        'data/question-bank-summary-completion.json',
    rejFile:         'data/question-bank-summary-completion-rejected.json',
    collectionId:    'questionBank-summary-completion',
    runVerification: false,
    runStage05:      false,
    useLeadPlan:     false,
    mutations:       ['SYNONYM_BRIDGE', 'DISTRACTOR_NEAR_MISS'],
  },
  'sentence-completion': {
    label:           'Sentence Completion',
    bankFile:        'data/question-bank-sentence-completion.json',
    rejFile:         'data/question-bank-sentence-completion-rejected.json',
    collectionId:    'questionBank-sentence-completion',
    runVerification: false,
    runStage05:      false,
    useLeadPlan:     false,
    mutations:       ['EXACT_WORD', 'GRAMMAR_FIT'],
  },
  'multiple-choice': {
    label:           'Multiple Choice',
    bankFile:        'data/question-bank-multiple-choice.json',
    rejFile:         'data/question-bank-multiple-choice-rejected.json',
    collectionId:    'questionBank-multiple-choice',
    runVerification: false,
    runStage05:      false,
    useLeadPlan:     false,
    mutations:       ['CORRECT_PARAPHRASE', 'DISTRACTOR_MENTIONED', 'DISTRACTOR_REVERSED', 'DISTRACTOR_OVERSTATED'],
  },
  'short-answer': {
    label:           'Short Answer',
    bankFile:        'data/question-bank-short-answer.json',
    rejFile:         'data/question-bank-short-answer-rejected.json',
    collectionId:    'questionBank-short-answer',
    runVerification: false,
    runStage05:      false,
    useLeadPlan:     false,
    mutations:       ['SPECIFIC_FACT', 'ADJECTIVE_REQUIRED'],
  },
  'matching-headings': {
    label:           'Matching Headings',
    bankFile:        'data/question-bank-matching-headings.json',
    rejFile:         'data/question-bank-matching-headings-rejected.json',
    collectionId:    'questionBank-matching-headings',
    runVerification: false,
    runStage05:      false,
    useLeadPlan:     false,
    mutations:       ['CORRECT_HEADING', 'SPECIFIC_DETAIL_TRAP', 'TOPIC_ADJACENT'],
  },
  'matching-information': {
    label:           'Matching Information',
    bankFile:        'data/question-bank-matching-information.json',
    rejFile:         'data/question-bank-matching-information-rejected.json',
    collectionId:    'questionBank-matching-information',
    runVerification: false,
    runStage05:      false,
    useLeadPlan:     false,
    mutations:       ['CORRECT_PARAGRAPH', 'TOPIC_OVERLAP_TRAP'],
  },
  'matching-features': {
    label:           'Matching Features',
    bankFile:        'data/question-bank-matching-features.json',
    rejFile:         'data/question-bank-matching-features-rejected.json',
    collectionId:    'questionBank-matching-features',
    runVerification: false,
    runStage05:      false,
    useLeadPlan:     false,
    mutations:       ['CORRECT_ATTRIBUTION', 'PROXIMITY_TRAP'],
  },
  'listening-mc': {
    label:           'Listening Multiple Choice',
    bankFile:        'data/question-bank-listening-mc.json',
    rejFile:         'data/question-bank-listening-mc-rejected.json',
    collectionId:    'questionBank-listening-mc',
    runVerification: false,
    runStage05:      false,
    useLeadPlan:     false,
    mutations:       ['CORRECT_PARAPHRASE', 'ECHO_TRAP', 'DISTRACTOR_MENTIONED', 'DISTRACTOR_REVERSED'],
  },
  'listening-form': {
    label:           'Listening Form Completion',
    bankFile:        'data/question-bank-listening-form.json',
    rejFile:         'data/question-bank-listening-form-rejected.json',
    collectionId:    'questionBank-listening-form',
    runVerification: false,
    runStage05:      false,
    useLeadPlan:     false,
    mutations:       ['FIRST_MENTION_TRAP', 'SPELLING_PRECISION', 'NUMBER_FORMAT'],
  },
};

const RANDOM_TOPICS = [
  'Urban Development', 'Climate Science', 'Marine Biology', 'Psychology',
  'Archaeological Discovery', 'Renewable Energy', 'Neuroscience',
  'Economic Policy', 'Space Exploration', 'Linguistic Research',
];

// TFNG error reason map — kept for backward compatibility
const ERROR_REASON_MAP = {
  SYNONYM_SUBSTITUTION:    'synonymTrap',
  DIRECT_CONTRADICTION:    'directContradiction',
  NOT_GIVEN_NO_EVIDENCE:   'notGivenNoEvidence',
  CONCESSIVE_TRAP:         'concessive',
  NOT_GIVEN_TOPIC_ADJACENT:'notGivenTopicAdjacent',
  CAUTIOUS_LANGUAGE:       'cautiousLanguageMissed',
  NEGATION_INVERSION:      'negationOverlooked',
  SCOPE_QUALIFIER:         'scopeError',
  CAUSAL_ASSUMPTION:       'notGivenMarkedFalse',
};

// ── CLI ───────────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { type: 'tfng', count: 10, band: 6.5, topic: null, concurrency: 3, append: true };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--type':        opts.type        = args[++i];                        break;
      case '--count':       opts.count       = parseInt(args[++i], 10)  || 10;  break;
      case '--band':        opts.band        = parseFloat(args[++i])    || 6.5; break;
      case '--topic':       opts.topic       = args[++i];                       break;
      case '--concurrency': opts.concurrency = parseInt(args[++i], 10)  || 3;   break;
      case '--append':      opts.append      = args[++i] !== 'false';           break;
    }
  }
  if (!VALID_TYPES.includes(opts.type)) {
    console.error(`Error: unknown --type "${opts.type}". Valid types: ${VALID_TYPES.join(', ')}`);
    process.exit(1);
  }
  return opts;
}

// ── UTILITIES ─────────────────────────────────────────────────────────────────

function safeParseJson(raw) {
  const cleaned = (raw || '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
  const sanitized = cleaned.replace(/[\x00-\x1F\x7F]/g, ' ').trim();
  return JSON.parse(sanitized);
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

// ── ANTHROPIC HELPER ──────────────────────────────────────────────────────────

async function anthropicCall(apiKey, model, temperature, maxTokens, userContent) {
  const res = await fetch(ANTHROPIC_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: maxTokens, temperature, messages: [{ role: 'user', content: userContent }] }),
  });
  if (!res.ok) throw new Error(`API error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.content?.[0]?.text || '';
}

// ── STAGE 0 — LOGIC MATRIX ────────────────────────────────────────────────────
// For TFNG and YNNG: generates 5 logic pair blueprints.
// For other types: generates a lightweight plan object for Stage 1.

async function stageLogicMatrix(type, topic, band, apiKey, leadType) {
  if (type === 'tfng') return stageLogicMatrix_tfng(topic, band, apiKey, leadType);
  if (type === 'ynng') return stageLogicMatrix_ynng(topic, band, apiKey, leadType);
  // For all other types, Stage 0 returns a minimal plan — Stage 1 does the heavy lifting
  return { topic, type, mutations: TYPE_CONFIG[type].mutations, band };
}

async function stageLogicMatrix_tfng(topic, band, apiKey, leadType) {
  const barronsSample = barrons.length
    ? barrons.slice(0, 10).map(e => `Q: ${e.explanation} → Logic: ${e.logicType}`).join('\n')
    : '';
  const barronsContext = barronsSample
    ? `\nReference these verified Barron's patterns:\n${barronsSample}\nMatch this explanation style.\n`
    : '';

  const ALL_TYPES = ['SYNONYM_SUBSTITUTION', 'DIRECT_CONTRADICTION', 'NOT_GIVEN_NO_EVIDENCE', 'CONCESSIVE_TRAP', 'NOT_GIVEN_TOPIC_ADJACENT'];
  const others   = ALL_TYPES.filter(t => t !== leadType);
  const typeList = [leadType, ...others];

  const TYPE_INSTRUCTIONS = {
    SYNONYM_SUBSTITUTION:    'answer: True (passage confirms using a precise synonym — not a semantic cousin)',
    DIRECT_CONTRADICTION:    'answer: False (passage explicitly states the opposite fact)',
    NOT_GIVEN_NO_EVIDENCE:   'answer: Not Given (topic present but specific claim never made)',
    CONCESSIVE_TRAP:         'answer: ALWAYS False — NEVER Not Given, NEVER True. Pattern: "Although X, Y" where Y directly contradicts the statement. Example: "Although the railway was a great achievement, it did not make a profit." Statement: "The railway was financially successful." Answer: False.',
    NOT_GIVEN_TOPIC_ADJACENT:'answer: Not Given (related topic mentioned but exact claim never addressed)',
  };

  const qLines = typeList.map((t, i) => `- Q${i + 1}: ${t} → ${TYPE_INSTRUCTIONS[t]}`).join('\n');

  const raw = await anthropicCall(apiKey, 'claude-sonnet-4-5', 0, 2000,
    `Generate exactly 5 T/F/NG logic pairs for a Band ${band} IELTS Academic reading set about ${topic}.
${barronsContext}
${qLines}

CRITICAL RULE — CONCESSIVE_TRAP: answer ALWAYS "False". Never "Not Given", never "True".

Return a JSON array of 5 objects. Each object:
{
  "logicType": string,
  "complexityLevel": number (1-5),
  "fact": "exact sentence that will appear verbatim in passage",
  "anchorText": "specific word/phrase that determines the answer",
  "statement": "what the student reads",
  "answer": "True" | "False" | "Not Given",
  "whyCorrect": "one sentence logical proof",
  "reasoning": {
    "step_1_locate": "verbatim fact sentence",
    "step_2_compare": "Passage says: [phrase]. Statement says: [phrase].",
    "step_3_logic": "TRAP_TYPE — plain language, Band 5 from India understands immediately",
    "step_4_eliminate": "Not [optionA] because [reason]. Not [optionB] because [reason]."
  }
}

Return valid JSON array only. Nothing else.`);

  const pairs = safeParseJson(raw);
  if (!Array.isArray(pairs) || pairs.length !== 5) {
    throw new Error(`Stage 0 TFNG: expected 5 pairs, got ${Array.isArray(pairs) ? pairs.length : typeof pairs}`);
  }
  return pairs;
}

async function stageLogicMatrix_ynng(topic, band, apiKey, leadType) {
  const ALL_TYPES = ['AUTHOR_AGREES', 'AUTHOR_DISAGREES', 'NEUTRAL_AUTHOR', 'HEDGED_OPINION', 'BALANCED_REPORTING'];
  const others   = ALL_TYPES.filter(t => t !== leadType);
  const typeList = [leadType, ...others];

  const TYPE_INSTRUCTIONS = {
    AUTHOR_AGREES:       'answer: Yes — passage contains an explicit opinion marker (I believe, clearly, it is vital, argues that, contends that) where the author directly agrees with the statement',
    AUTHOR_DISAGREES:    'answer: No — passage contains an explicit opinion marker where the author directly contradicts the statement',
    NEUTRAL_AUTHOR:      'answer: Not Given — passage reports the views of others (researchers found, some argue) but the author never states a personal position on this claim',
    HEDGED_OPINION:      'answer: Not Given — author uses arguably / may suggest / could be argued / it appears / possibly without committing to a definite view',
    BALANCED_REPORTING:  'answer: Not Given — author presents both sides of the argument equally and never picks one',
  };

  const qLines = typeList.map((t, i) => `- Q${i + 1}: ${t} → ${TYPE_INSTRUCTIONS[t]}`).join('\n');

  const raw = await anthropicCall(apiKey, 'claude-sonnet-4-5', 0, 2000,
    `Generate exactly 5 Y/N/NG logic pairs for a Band ${band} IELTS Academic reading set about ${topic}.
This tests the student's ability to identify the WRITER'S VIEWS AND CLAIMS — not factual truth.

${qLines}

For each pair return:
{
  "logicType": string,
  "complexityLevel": number (1-5),
  "fact": "exact sentence that will appear verbatim in passage — must contain the opinion/stance signal",
  "anchorText": "the specific opinion marker word/phrase (e.g. 'I believe', 'arguably', 'clearly')",
  "statement": "claim about the writer's view that the student must evaluate",
  "answer": "Yes" | "No" | "Not Given",
  "whyCorrect": "one sentence citing the specific opinion marker",
  "reasoning": {
    "step_1_locate": "verbatim fact sentence containing the opinion marker",
    "step_2_compare": "Author says: [opinion phrase]. Statement claims: [phrase].",
    "step_3_logic": "MUTATION_TYPE — plain language sentence",
    "step_4_eliminate": "Not [optionA] because [reason]. Not [optionB] because [reason]."
  }
}

Return valid JSON array of 5 objects only.`);

  const pairs = safeParseJson(raw);
  if (!Array.isArray(pairs) || pairs.length !== 5) {
    throw new Error(`Stage 0 YNNG: expected 5 pairs, got ${Array.isArray(pairs) ? pairs.length : typeof pairs}`);
  }
  return pairs;
}

// ── STAGE 0.5 — LOGIC PAIR VALIDATION ────────────────────────────────────────
// Runs for TFNG and YNNG only. Reviews all 5 pairs for ambiguity.
// Regenerates invalid pairs (up to 2 attempts). Falls back to DIRECT_CONTRADICTION.

async function stageLogicValidation(type, logicPairs, topic, band, apiKey, log) {
  const isYnng = type === 'ynng';

  const pairSummaries = logicPairs.map((p, i) =>
    JSON.stringify({ id: i + 1, logicType: p.logicType, fact: p.fact, statement: p.statement, answer: p.answer })
  ).join('\n');

  const rules = isYnng
    ? `- YES: passage must have explicit author opinion marker (I believe, clearly, it is vital, argues) confirming statement — not just a reported view
- NO: passage must have explicit author opinion marker contradicting statement
- NOT GIVEN (NEUTRAL_AUTHOR): passage reports others' views only — author is silent
- NOT GIVEN (HEDGED_OPINION): author hedges with arguably/may suggest without committing
- NOT GIVEN (BALANCED_REPORTING): author presents both sides — never picks one
Flag invalid if: Yes/No pair has no explicit opinion marker, or Not Given pair could be read as Yes/No`
    : `- TRUE: fact must explicitly confirm via synonyms — no inference allowed
- FALSE: fact must explicitly contradict — not just fail to confirm
- NOT GIVEN: fact must be genuinely silent — not hinting or implying
- CONCESSIVE_TRAP: answer must always be False — main clause after although/despite contradicts statement
Flag invalid if: NOT GIVEN could be mistaken for False, TRUE requires inference, FALSE could be Not Given, CONCESSIVE_TRAP is not False`;

  const valRaw = await anthropicCall(apiKey, 'claude-sonnet-4-5', 0, 600,
    `You are a strict IELTS examiner. Review each logic pair and flag any that are ambiguous.

Rules:
${rules}

Logic pairs to review:
${pairSummaries}

Return JSON array: [{ "id": 1, "valid": boolean, "issue": string }]`);

  const reviews = safeParseJson(valRaw);
  if (!Array.isArray(reviews)) throw new Error('Stage 0.5: invalid review response');

  const flagged = reviews.filter(r => !r.valid);
  if (flagged.length === 0) { log(`⟳ Stage 0.5: 5/5 pairs valid`); return logicPairs; }

  const validated = [...logicPairs];
  const outcomes  = [];

  for (const flag of flagged) {
    const pairIdx      = flag.id - 1;
    const originalPair = logicPairs[pairIdx];
    let   fixed        = false;

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const regenRaw = await anthropicCall(apiKey, 'claude-sonnet-4-5', 0, 600,
          `Generate exactly 1 ${isYnng ? 'Y/N/NG' : 'T/F/NG'} logic pair for a Band ${band} IELTS passage about ${topic}.

PREVIOUS ATTEMPT REJECTED: ${flag.issue}. Generate a cleaner unambiguous version.

Type required: ${originalPair.logicType}
Answer must be: ${originalPair.answer}

Return a single JSON object (not an array) with fields: logicType, complexityLevel, fact, anchorText, statement, answer, whyCorrect, reasoning (step_1_locate, step_2_compare, step_3_logic, step_4_eliminate).`);

        const newPair = safeParseJson(regenRaw);
        if (newPair && newPair.fact && newPair.statement && newPair.answer) {
          validated[pairIdx] = newPair;
          fixed = true;
          break;
        }
      } catch { /* try next attempt */ }
    }

    if (!fixed) {
      // Fallback — DIRECT_CONTRADICTION is always unambiguous
      try {
        const fbRaw = await anthropicCall(apiKey, 'claude-sonnet-4-5', 0, 600,
          `Generate exactly 1 T/F/NG logic pair for a Band ${band} IELTS passage about ${topic}.
Type: DIRECT_CONTRADICTION. Answer: False. The passage sentence must EXPLICITLY state the opposite of the statement. Zero ambiguity.
Return a single JSON object with: logicType, complexityLevel, fact, anchorText, statement, answer, whyCorrect, reasoning.`);
        const fbPair = safeParseJson(fbRaw);
        if (fbPair && fbPair.fact) { validated[pairIdx] = fbPair; outcomes.push('fallback→DC'); }
      } catch { outcomes.push('fallback_failed'); }
    } else {
      outcomes.push('valid');
    }
  }

  const issueDesc  = flagged.map(f => `${logicPairs[f.id - 1]?.logicType} ambiguous`).join(', ');
  const outcomeStr = outcomes.length === 1 ? outcomes[0] : outcomes.join(', ');
  log(`⟳ Stage 0.5: ${flagged.length} flagged (${issueDesc}) → regenerating... ${outcomeStr}`);
  return validated;
}

// ── STAGE 1 — CONTENT GENERATION ──────────────────────────────────────────────
// TFNG/YNNG: embeds logic pair fact sentences verbatim into an academic passage.
// All other types: generates passage/script + complete question set in one call.

async function stageContentGeneration(type, topic, plan, band) {
  if (type === 'tfng') return stagePassageGeneration_tfng(topic, plan, band);
  if (type === 'ynng') return stagePassageGeneration_ynng(topic, plan, band);
  return stageGenerateAllInOne(type, topic, plan, band);
}

async function stagePassageGeneration_tfng(topic, logicPairs, band) {
  const factList = logicPairs.map((p, i) => `${i + 1}. ${p.fact}`).join('\n');

  const res = await fetch(VERCEL_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'You are an expert IELTS Academic passage writer. Return valid JSON only, no markdown, no preamble.' },
        { role: 'user',   content:
`Write a 300-400 word IELTS Academic passage about ${topic} that contains these exact sentences verbatim:

${factList}

Return JSON: { "passage": string, "topic": string }` },
      ],
      max_tokens: 900, temperature: 0.7,
    }),
  });

  if (!res.ok) throw new Error(`Stage 1 API error: ${res.status}`);
  const data   = await res.json();
  const raw    = data.choices?.[0]?.message?.content || '';
  const parsed = safeParseJson(raw);
  if (!parsed.passage) throw new Error('Stage 1 TFNG: no passage in response');

  const questions = logicPairs.map((pair, i) => ({
    id:              i + 1,
    text:            pair.statement,
    answer:          pair.answer,
    logicType:       pair.logicType,
    passageAnchor:   pair.fact,
    anchorText:      pair.anchorText,
    complexityLevel: pair.complexityLevel,
    explanation:     pair.reasoning?.step_3_logic || pair.whyCorrect,
    reasoning:       pair.reasoning || null,
    errorReason:     ERROR_REASON_MAP[pair.logicType] || 'other',
  }));

  return { passage: parsed.passage, topic: parsed.topic || topic, questions, extraData: null };
}

async function stagePassageGeneration_ynng(topic, logicPairs, band) {
  const factList = logicPairs.map((p, i) => `${i + 1}. ${p.fact}`).join('\n');

  const res = await fetch(VERCEL_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'You are an expert IELTS Academic passage writer. Return valid JSON only, no markdown, no preamble.' },
        { role: 'user',   content:
`Write a 300-400 word IELTS Academic passage about ${topic} where the author expresses clear opinions and views.
The passage must contain these exact sentences verbatim — they contain the author's opinion markers:

${factList}

The author should use phrases like "I believe", "it is clear that", "arguably", "in my view", "it is vital" where relevant.
Return JSON: { "passage": string, "topic": string }` },
      ],
      max_tokens: 900, temperature: 0.7,
    }),
  });

  if (!res.ok) throw new Error(`Stage 1 YNNG API error: ${res.status}`);
  const data   = await res.json();
  const raw    = data.choices?.[0]?.message?.content || '';
  const parsed = safeParseJson(raw);
  if (!parsed.passage) throw new Error('Stage 1 YNNG: no passage in response');

  const questions = logicPairs.map((pair, i) => ({
    id:              i + 1,
    text:            pair.statement,
    answer:          pair.answer,
    logicType:       pair.logicType,
    passageAnchor:   pair.fact,
    anchorText:      pair.anchorText,
    complexityLevel: pair.complexityLevel,
    explanation:     pair.reasoning?.step_3_logic || pair.whyCorrect,
    reasoning:       pair.reasoning || null,
  }));

  return { passage: parsed.passage, topic: parsed.topic || topic, questions, extraData: null };
}

async function stageGenerateAllInOne(type, topic, plan, band) {
  const PROMPTS = {
    'summary-completion': `Generate a Band ${band} IELTS Academic Summary Completion exercise about ${topic}.

The word bank must contain exactly 8 items: 5 correct gap answers PLUS 3 near-miss distractors.
Distractors must be real English words that are semantically related but factually wrong.

Mutation plan:
- Gaps 1, 2, 3: SYNONYM_BRIDGE — summary paraphrases passage, answer is the exact passage word bridged via synonym
- Gaps 4, 5: use words that require careful reading to distinguish from near-miss distractors

Return JSON:
{
  "topic": string,
  "passage": "3 paragraphs, 170-220 words",
  "summaryText": "60-80 word summary with 5 gaps marked [1][2][3][4][5]",
  "wordBank": ["word1",...,"word8"],
  "questions": [
    { "id": 1, "text": "Gap [1]", "answer": "exact word from passage", "explanation": "why this word", "keySentence": "passage sentence containing it", "mutationType": "SYNONYM_BRIDGE" },
    ...5 items
  ]
}`,

    'sentence-completion': `Generate a Band ${band} IELTS Academic Sentence Completion exercise about ${topic}.

Mutation plan:
- Questions 1, 2, 3: EXACT_WORD — one exact word from the passage completes the sentence
- Questions 4, 5: GRAMMAR_FIT — answer must match the grammatical form required (noun/adjective/verb)

Return JSON:
{
  "topic": string,
  "passage": "3 paragraphs, 200-250 words",
  "questions": [
    { "id": 1, "text": "Complete the sentence: [sentence stem with _____ gap]", "answer": "exact word from passage", "explanation": "why this word", "keySentence": "passage sentence", "mutationType": "EXACT_WORD" },
    ...5 items
  ]
}`,

    'multiple-choice': `Generate a Band ${band} IELTS Academic Multiple Choice reading exercise about ${topic}.

Each question must have exactly 4 options (A/B/C/D). Apply these traps:
- CORRECT_PARAPHRASE: correct answer paraphrases the passage — never uses exact words
- DISTRACTOR_MENTIONED: appears in passage but doesn't answer the specific question
- DISTRACTOR_REVERSED: uses passage words but reverses the meaning
- DISTRACTOR_OVERSTATED: goes beyond what the passage claims

Return JSON:
{
  "topic": string,
  "passage": "3 paragraphs, 250-300 words",
  "questions": [
    {
      "id": 1,
      "text": "question stem",
      "options": [
        { "label": "A", "text": "option text", "isCorrect": true, "trapType": "CORRECT_PARAPHRASE" },
        { "label": "B", "text": "option text", "isCorrect": false, "trapType": "DISTRACTOR_MENTIONED" },
        { "label": "C", "text": "option text", "isCorrect": false, "trapType": "DISTRACTOR_REVERSED" },
        { "label": "D", "text": "option text", "isCorrect": false, "trapType": "DISTRACTOR_OVERSTATED" }
      ],
      "answer": "A",
      "explanation": "why A is correct and why each distractor fails"
    },
    ...5 questions
  ]
}`,

    'short-answer': `Generate a Band ${band} IELTS Academic Short Answer reading exercise about ${topic}.
Answers must be 1-2 words only. No complete sentences.

Mutation plan:
- Questions 1, 2, 3: SPECIFIC_FACT — exact data point (name, number, place) from passage
- Questions 4, 5: ADJECTIVE_REQUIRED — answer needs a qualifier (e.g. "blue whales" not just "whales")

Return JSON:
{
  "topic": string,
  "passage": "3 paragraphs, 200-250 words",
  "questions": [
    { "id": 1, "text": "question", "answer": "1-2 word answer", "explanation": "why this answer", "keySentence": "passage sentence", "mutationType": "SPECIFIC_FACT" },
    ...5 items
  ]
}`,

    'matching-headings': `Generate a Band ${band} IELTS Academic Matching Headings exercise about ${topic}.

Structure:
- 5 paragraphs (A-E), each with a distinct main idea
- 5 correct headings matching the paragraphs
- 2 distractor headings: one SPECIFIC_DETAIL_TRAP (true detail from paragraph but too narrow) and one TOPIC_ADJACENT (related topic not in passage)

Return JSON:
{
  "topic": string,
  "paragraphs": [
    { "label": "A", "text": "paragraph text (60-80 words)" },
    ...5 items
  ],
  "headings": [
    { "id": 1, "text": "heading text", "correctParagraph": "A", "isDistractor": false },
    { "id": 2, "text": "heading text", "correctParagraph": "B", "isDistractor": false },
    { "id": 3, "text": "heading text", "correctParagraph": "C", "isDistractor": false },
    { "id": 4, "text": "heading text", "correctParagraph": "D", "isDistractor": false },
    { "id": 5, "text": "heading text", "correctParagraph": "E", "isDistractor": false },
    { "id": 6, "text": "distractor heading", "correctParagraph": null, "isDistractor": true, "trapType": "SPECIFIC_DETAIL_TRAP" },
    { "id": 7, "text": "distractor heading", "correctParagraph": null, "isDistractor": true, "trapType": "TOPIC_ADJACENT" }
  ],
  "questions": [
    { "id": 1, "text": "Paragraph A", "answer": "3", "explanation": "why heading 3 matches paragraph A" },
    ...5 items (one per paragraph)
  ]
}`,

    'matching-information': `Generate a Band ${band} IELTS Academic Matching Information exercise about ${topic}.

The passage has 5 paragraphs (A-E). Students match each statement to the paragraph containing that information.
Include at least one TOPIC_OVERLAP_TRAP: a statement that could plausibly match the wrong paragraph.

Return JSON:
{
  "topic": string,
  "paragraphs": [
    { "label": "A", "text": "paragraph text (60-80 words)" },
    ...5 items
  ],
  "questions": [
    { "id": 1, "text": "statement about specific information", "answer": "A", "explanation": "why paragraph A", "mutationType": "CORRECT_PARAGRAPH" },
    { "id": 2, "text": "statement", "answer": "C", "explanation": "...", "mutationType": "CORRECT_PARAGRAPH" },
    { "id": 3, "text": "statement with topic overlap trap", "answer": "B", "explanation": "why B not D despite topic overlap", "mutationType": "TOPIC_OVERLAP_TRAP" },
    { "id": 4, "text": "statement", "answer": "D", "explanation": "...", "mutationType": "CORRECT_PARAGRAPH" },
    { "id": 5, "text": "statement", "answer": "E", "explanation": "...", "mutationType": "CORRECT_PARAGRAPH" }
  ]
}`,

    'matching-features': `Generate a Band ${band} IELTS Academic Matching Features exercise about ${topic}.

Use 3 researchers/people/categories. Students match 5 statements to the correct person/category.
Include at least one PROXIMITY_TRAP: a statement attributed to a person whose name appears nearby but is wrong.

Return JSON:
{
  "topic": string,
  "passage": "300-350 word passage discussing the views/findings of 3 named people/categories",
  "features": ["Dr Smith", "Professor Jones", "Dr Patel"],
  "questions": [
    { "id": 1, "text": "statement about a view or finding", "answer": "Dr Smith", "explanation": "...", "mutationType": "CORRECT_ATTRIBUTION" },
    { "id": 2, "text": "statement", "answer": "Professor Jones", "explanation": "...", "mutationType": "CORRECT_ATTRIBUTION" },
    { "id": 3, "text": "proximity trap statement", "answer": "Dr Patel", "explanation": "why Dr Patel not the nearby name", "mutationType": "PROXIMITY_TRAP" },
    { "id": 4, "text": "statement", "answer": "Dr Smith", "explanation": "...", "mutationType": "CORRECT_ATTRIBUTION" },
    { "id": 5, "text": "statement", "answer": "Professor Jones", "explanation": "...", "mutationType": "CORRECT_ATTRIBUTION" }
  ]
}`,

    'listening-mc': `Generate a Band ${band} IELTS Listening Multiple Choice exercise about ${topic}.

Write an audio DIALOGUE SCRIPT (not a reading passage) — two speakers discussing ${topic}.
Apply these traps: ECHO_TRAP (wrong options use exact audio words; correct answer is paraphrased), DISTRACTOR_MENTIONED, DISTRACTOR_REVERSED.

Return JSON:
{
  "topic": string,
  "script": "dialogue script 300-350 words, two speakers labelled A: and B:",
  "questions": [
    {
      "id": 1,
      "text": "question stem",
      "options": [
        { "label": "A", "text": "option — paraphrase of correct audio content", "isCorrect": true, "trapType": "CORRECT_PARAPHRASE" },
        { "label": "B", "text": "option — uses exact audio words but wrong", "isCorrect": false, "trapType": "ECHO_TRAP" },
        { "label": "C", "text": "option — mentioned but doesn't answer", "isCorrect": false, "trapType": "DISTRACTOR_MENTIONED" },
        { "label": "D", "text": "option — reverses the meaning", "isCorrect": false, "trapType": "DISTRACTOR_REVERSED" }
      ],
      "answer": "A",
      "explanation": "why A is correct, why others fail"
    },
    ...5 questions
  ]
}`,

    'listening-form': `Generate a Band ${band} IELTS Listening Form Completion exercise about ${topic}.

Write an audio DIALOGUE SCRIPT with a form template. Include:
- 2 × FIRST_MENTION_TRAP: speaker says something then corrects it — answer is the correction, not first mention
- 2 × SPELLING_PRECISION: proper noun answers where exact spelling matters
- 1 × NUMBER_FORMAT: numeric answer (accept both "12" and "twelve")

Return JSON:
{
  "topic": string,
  "script": "dialogue 300-350 words, two speakers. Include self-corrections using: 'actually', 'no wait', 'sorry, I mean'",
  "formTitle": "form name (e.g. 'Booking Confirmation Form')",
  "questions": [
    { "id": 1, "label": "form field label", "answer": "exact answer from script", "explanation": "where in script", "mutationType": "FIRST_MENTION_TRAP", "trapDetail": "what was said first vs corrected to" },
    { "id": 2, "label": "field label", "answer": "ProperNoun", "explanation": "...", "mutationType": "SPELLING_PRECISION" },
    { "id": 3, "label": "field label", "answer": "corrected answer", "explanation": "...", "mutationType": "FIRST_MENTION_TRAP", "trapDetail": "..." },
    { "id": 4, "label": "field label", "answer": "ProperNoun2", "explanation": "...", "mutationType": "SPELLING_PRECISION" },
    { "id": 5, "label": "field label", "answer": "42", "alternateAnswer": "forty-two", "explanation": "...", "mutationType": "NUMBER_FORMAT" }
  ]
}`,
  };

  const prompt = PROMPTS[type];
  if (!prompt) throw new Error(`No Stage 1 prompt for type: ${type}`);

  const res = await fetch(VERCEL_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'You are an expert IELTS examiner and passage writer. Return valid JSON only, no markdown, no preamble.' },
        { role: 'user',   content: prompt },
      ],
      max_tokens: 2000, temperature: 0.7,
    }),
  });

  if (!res.ok) throw new Error(`Stage 1 ${type} API error: ${res.status}`);
  const data   = await res.json();
  const raw    = data.choices?.[0]?.message?.content || '';
  const parsed = safeParseJson(raw);

  // Normalise to a standard shape: { passage, topic, questions, extraData }
  const resolvedTopic = parsed.topic || topic;

  if (type === 'matching-headings') {
    if (!parsed.paragraphs || !parsed.headings) throw new Error('Stage 1 matching-headings: missing paragraphs or headings');
    const passage = parsed.paragraphs.map(p => `${p.label}. ${p.text}`).join('\n\n');
    return { passage, topic: resolvedTopic, questions: parsed.questions || [], extraData: { paragraphs: parsed.paragraphs, headings: parsed.headings } };
  }
  if (type === 'matching-information') {
    if (!parsed.paragraphs) throw new Error('Stage 1 matching-information: missing paragraphs');
    const passage = parsed.paragraphs.map(p => `${p.label}. ${p.text}`).join('\n\n');
    return { passage, topic: resolvedTopic, questions: parsed.questions || [], extraData: { paragraphs: parsed.paragraphs } };
  }
  if (type === 'matching-features') {
    if (!parsed.features) throw new Error('Stage 1 matching-features: missing features');
    return { passage: parsed.passage || '', topic: resolvedTopic, questions: parsed.questions || [], extraData: { features: parsed.features } };
  }
  if (type === 'listening-mc' || type === 'listening-form') {
    if (!parsed.script) throw new Error(`Stage 1 ${type}: missing script`);
    const extraData = type === 'listening-form'
      ? { formTitle: parsed.formTitle }
      : {};
    return { passage: parsed.script, topic: resolvedTopic, questions: parsed.questions || [], extraData };
  }
  if (type === 'summary-completion') {
    if (!parsed.summaryText || !parsed.wordBank) throw new Error('Stage 1 summary-completion: missing summaryText or wordBank');
    return { passage: parsed.passage || '', topic: resolvedTopic, questions: parsed.questions || [], extraData: { summaryText: parsed.summaryText, wordBank: parsed.wordBank } };
  }

  // multiple-choice / listening-mc — shuffle options so correct isn't always A
  if (type === 'multiple-choice' || type === 'listening-mc') {
    if (!parsed.passage && !parsed.script) throw new Error(`Stage 1 ${type}: missing passage/script`);
    const shuffledQs = (parsed.questions || []).map(q => {
      if (!Array.isArray(q.options)) return q;
      const opts = [...q.options].sort(() => Math.random() - 0.5);
      const labels = ['A', 'B', 'C', 'D'];
      opts.forEach((o, i) => { o.label = labels[i]; });
      const correct = opts.find(o => o.isCorrect);
      return { ...q, options: opts, answer: correct?.label || q.answer };
    });
    return { passage: parsed.passage || parsed.script || '', topic: resolvedTopic, questions: shuffledQs, extraData: null };
  }

  // sentence-completion, short-answer
  if (!parsed.passage) throw new Error(`Stage 1 ${type}: missing passage`);
  return { passage: parsed.passage, topic: resolvedTopic, questions: parsed.questions || [], extraData: null };
}

// ── STAGE 2 — ANSWER VERIFICATION ────────────────────────────────────────────
// Runs for TFNG and YNNG only.

async function stageVerification(passage, questions) {
  const result = await verifyAnswers(passage, questions, VERCEL_URL);
  return { questions: result.questions, corrections: result.corrections };
}

// ── STAGE 3 — PASSAGE QUALITY GATE ───────────────────────────────────────────

async function stageQualityGate(passage, band) {
  return evaluatePassage(passage, band, VERCEL_URL);
}

// ── STAGE 4 — STUDENT SIMULATION ──────────────────────────────────────────────

async function stageStudentSimulation(type, passage, questions, apiKey, extraData) {
  if (type === 'tfng') return stageStudentSimulation_tfng(passage, questions, apiKey);
  if (type === 'ynng') return stageStudentSimulation_ynng(passage, questions, apiKey);
  return stageStudentSimulation_generic(type, passage, questions, apiKey, extraData);
}

async function stageStudentSimulation_tfng(passage, questions, apiKey) {
  const qList = questions.map((q, i) => `${i + 1}. ${q.text}`).join('\n');
  const raw   = await anthropicCall(apiKey, 'claude-sonnet-4-5', 0.3, 512,
    `You are an IELTS Academic student at Band 6.0. Read this passage and answer these True/False/Not Given questions. Apply strict rules: True = explicitly confirmed, False = explicitly contradicted, Not Given = not addressed.

Passage: ${passage}

Questions:
${qList}

Return JSON array: [{ "questionId": 1, "answer": "True"|"False"|"Not Given", "confidence": "high"|"medium"|"low" }]`);

  const simAnswers = safeParseJson(raw);
  if (!Array.isArray(simAnswers)) throw new Error('Stage 4 TFNG: response not array');
  return simAnswers.map(s => {
    const bankQ   = questions.find(q => q.id === s.questionId);
    const matched = bankQ ? s.answer === bankQ.answer : false;
    return { questionId: s.questionId, studentAnswer: s.answer, bankAnswer: bankQ?.answer ?? '?', confidence: s.confidence, matched };
  });
}

async function stageStudentSimulation_ynng(passage, questions, apiKey) {
  const qList = questions.map((q, i) => `${i + 1}. ${q.text}`).join('\n');
  const raw   = await anthropicCall(apiKey, 'claude-sonnet-4-5', 0, 512,
    `You are an IELTS student answering Yes/No/Not Given questions about the writer's views. Yes = writer explicitly agrees, No = writer explicitly disagrees, Not Given = writer never states a personal view.

Passage:
${passage}

Questions:
${qList}

IMPORTANT: Return ONLY a valid JSON array. No explanation, no preamble, just JSON.
[{ "questionId": 1, "answer": "Yes", "confidence": "high" }, ...]`);

  const simAnswers = safeParseJson(raw);
  if (!Array.isArray(simAnswers)) throw new Error('Stage 4 YNNG: response not array');
  return simAnswers.map(s => {
    const bankQ   = questions.find(q => q.id === s.questionId);
    const matched = bankQ ? s.answer === bankQ.answer : false;
    return { questionId: s.questionId, studentAnswer: s.answer, bankAnswer: bankQ?.answer ?? '?', confidence: s.confidence, matched };
  });
}

async function stageStudentSimulation_generic(type, passage, questions, apiKey, extraData) {
  const SIM_INSTRUCTIONS = {
    'summary-completion':  `Fill each gap using only words from the word bank. Word bank: [${(extraData?.wordBank || []).join(', ')}]. Summary: ${extraData?.summaryText || ''}. Return JSON: [{ "questionId": 1, "answer": "word" }]`,
    'sentence-completion': `Complete each sentence using one word from the passage. Return JSON: [{ "questionId": 1, "answer": "word" }]`,
    'multiple-choice':     `Choose the best answer (A/B/C/D) for each question. Return JSON: [{ "questionId": 1, "answer": "A" }]`,
    'short-answer':        `Answer each question in 1-2 words only. Return JSON: [{ "questionId": 1, "answer": "short answer" }]`,
    'matching-headings':   `Match each paragraph to a heading number. Return JSON: [{ "questionId": 1, "answer": "3" }] — use heading id numbers.`,
    'matching-information':`Match each statement to a paragraph letter (A/B/C/D/E). Return JSON: [{ "questionId": 1, "answer": "B" }]`,
    'matching-features':   `Match each statement to the correct person/category: [${(extraData?.features || []).join(' / ')}]. Return JSON: [{ "questionId": 1, "answer": "Dr Smith" }]`,
    'listening-mc':        `Choose the best answer (A/B/C/D) for each question based on the audio script. Return JSON: [{ "questionId": 1, "answer": "A" }]`,
    'listening-form':      `Fill in the form gaps based on what you hear in the script. Return JSON: [{ "questionId": 1, "answer": "word or phrase" }]`,
  };

  const instruction = SIM_INSTRUCTIONS[type] || 'Answer each question. Return JSON: [{ "questionId": 1, "answer": "..." }]';
  const qList       = questions.map(q => {
    const opts = q.options?.map(o => `  ${o.label}) ${o.text}`).join('\n') || '';
    return `${q.id}. ${q.text || q.label}${opts ? '\n' + opts : ''}`;
  }).join('\n\n');
  const contentLabel = (type === 'listening-mc' || type === 'listening-form') ? 'Audio script' : 'Passage';

  const raw = await anthropicCall(apiKey, 'claude-sonnet-4-5', 0, 512,
    `You are an IELTS student. ${contentLabel}:
${passage}

Questions:
${qList}

${instruction}
IMPORTANT: Return ONLY valid JSON. No explanation, no preamble, no markdown. Just the JSON array.`);

  const simAnswers = safeParseJson(raw);
  if (!Array.isArray(simAnswers)) throw new Error(`Stage 4 ${type}: response not array`);
  return simAnswers.map(s => {
    const bankQ = questions.find(q => q.id === s.questionId);
    if (!bankQ) return { questionId: s.questionId, studentAnswer: s.answer, bankAnswer: '?', confidence: 'medium', matched: false };
    const correct = bankQ.answer || (bankQ.options?.find(o => o.isCorrect)?.label);
    const matched  = String(s.answer).trim().toLowerCase() === String(correct || '').trim().toLowerCase();
    return { questionId: s.questionId, studentAnswer: s.answer, bankAnswer: correct ?? '?', confidence: 'medium', matched };
  });
}

// ── ENTRY BUILDER ─────────────────────────────────────────────────────────────

function buildEntry({ type, topic, band, passage, questions, corrections, quality, simulation, rejectedReason, extraData }) {
  const mismatches = (simulation || []).filter(s => !s.matched);
  const flagged    = (simulation || []).filter(s => s.confidence === 'low').map(s => s.questionId);
  const simMap     = Object.fromEntries((simulation || []).map(s => [s.questionId, s]));
  const corrSet    = new Set((corrections || []).map(c => c.questionId));

  const complexities = (questions || []).map(q => q.complexityLevel).filter(Number.isFinite);
  const avgC = complexities.length
    ? Math.round(complexities.reduce((a, b) => a + b, 0) / complexities.length * 10) / 10
    : null;

  const enrichedQs = (questions || []).map(q => ({
    ...q,
    keySentence:       q.keySentence || q.passageAnchor,
    verified:          !corrSet.has(q.id),
    studentSimulation: simMap[q.id]
      ? { answer: simMap[q.id].studentAnswer, confidence: simMap[q.id].confidence, matched: simMap[q.id].matched }
      : null,
  }));

  let simResult = 'not_run';
  if (simulation) simResult = mismatches.length >= 2 ? 'rejected' : 'approved';

  const cfg = TYPE_CONFIG[type] || TYPE_CONFIG['tfng'];
  const logicDist = Object.fromEntries(
    cfg.mutations.map(m => [m, (questions || []).filter(q => q.logicType === m || q.mutationType === m).length])
  );

  const entry = {
    id:        randomUUID(),
    type:      type || 'tfng',
    band,
    topic,
    passage:   passage || '',
    questions: enrichedQs,
    ...(extraData ? { extraData } : {}),
    meta: {
      generatedAt:             new Date().toISOString(),
      band,
      passageQuality:          quality ? { avgScore: quality.avgScore, scores: quality.scores } : null,
      verificationCorrections: (corrections || []).length,
      studentSimulationResult: simResult,
      mutationDistribution:    logicDist,
      complexityProfile:       { avg: avgC, min: complexities.length ? Math.min(...complexities) : null, max: complexities.length ? Math.max(...complexities) : null },
      flaggedForReview:        flagged,
    },
  };

  if (rejectedReason) entry.rejectedReason = rejectedReason;
  return entry;
}

// ── GENERATE ONE SET ──────────────────────────────────────────────────────────

function isNetworkError(err) {
  const msg = (err.message || '').toLowerCase();
  return /fetch failed|econnreset|etimedout|connection reset|api error: 500/.test(msg);
}

async function generateOneSet(idx, total, type, topic, band, apiKey, leadType) {
  const MAX_RETRIES = 2;
  const RETRY_DELAY = 5000;
  const cfg    = TYPE_CONFIG[type];
  const prefix = `[${String(idx).padStart(String(total).length)}/${total}]`;
  const log    = msg => process.stdout.write(`${prefix} ${msg}\n`);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, RETRY_DELAY));
      log(`⟳ Retry ${attempt}/${MAX_RETRIES} after network error...`);
    }

    try {
      // Stage 0
      const stage0Label = leadType ? `lead: ${leadType}` : type;
      log(`⟳ Stage 0: Logic matrix (${stage0Label})...`);
      const plan = await stageLogicMatrix(type, topic, band, apiKey, leadType);

      // Stage 0.5 — TFNG and YNNG only
      const logicPairs = (cfg.runStage05 && Array.isArray(plan))
        ? await stageLogicValidation(type, plan, topic, band, apiKey, log)
        : plan;

      // Stage 1
      log('⟳ Stage 1: Content generation...');
      const { passage, topic: resolvedTopic, questions, extraData } = await stageContentGeneration(type, topic, logicPairs, band);

      // Stage 2 — TFNG and YNNG only
      let verifiedQs   = questions;
      let corrections  = [];
      if (cfg.runVerification) {
        log('⟳ Stage 2: Verification...');
        const verified = await stageVerification(passage, questions);
        verifiedQs     = verified.questions;
        corrections    = verified.corrections;
      }

      // Stage 3
      log('⟳ Stage 3: Quality gate...');
      const quality = await stageQualityGate(passage, band);
      if (!quality.pass) {
        const reasons = (quality.failReasons || []).join('; ') || `avg ${quality.avgScore ?? 'n/a'}`;
        log(`✗ Rejected — quality_gate (${reasons})`);
        return {
          status: 'rejected', reason: 'quality_gate',
          entry: buildEntry({ type, topic: resolvedTopic, band, passage, questions: verifiedQs, corrections, quality, simulation: null, rejectedReason: 'quality_gate', extraData }),
        };
      }

      // Stage 4
      log('⟳ Stage 4: Student simulation...');
      const simulation = await stageStudentSimulation(type, passage, verifiedQs, apiKey, extraData);
      const mismatches = simulation.filter(s => !s.matched);

      const status         = mismatches.length >= 2 ? 'rejected' : 'approved';
      const rejectedReason = status === 'rejected' ? 'student_simulation_fail' : null;

      const entry = buildEntry({ type, topic: resolvedTopic, band, passage, questions: verifiedQs, corrections, quality, simulation, rejectedReason, extraData });

      if (status === 'approved') {
        const warnSuffix    = mismatches.length === 1 ? ` (1 ambiguous Q — warning logged)` : '';
        const avgComplexity = entry.meta.complexityProfile.avg ?? '?';
        const simScore      = `${verifiedQs.length - mismatches.length}/${verifiedQs.length}`;
        log(`✓ ${resolvedTopic} | quality ${quality.avgScore} | corrections ${corrections.length} | simulation ${simScore} | complexity avg ${avgComplexity}${warnSuffix}`);
      } else {
        const mismatchDesc = mismatches.map(m => `Q${m.questionId} student=${m.studentAnswer} bank=${m.bankAnswer}`).join(', ');
        log(`✗ Rejected — student_simulation_fail (${mismatches.length} mismatches: ${mismatchDesc})`);
      }

      return { status, reason: rejectedReason, entry };

    } catch (err) {
      if (attempt < MAX_RETRIES && isNetworkError(err)) {
        log(`⚠ Network error (attempt ${attempt + 1}): ${err.message}`);
        continue;
      }
      log(`✗ Rejected — pipeline_error: ${err.message}`);
      return {
        status: 'rejected', reason: 'pipeline_error',
        entry: { id: randomUUID(), type, topic, band, rejectedReason: 'pipeline_error', error: err.message, meta: { generatedAt: new Date().toISOString() } },
      };
    }
  }
}

// ── SUMMARY ───────────────────────────────────────────────────────────────────

function printSummary(type, results, allApproved) {
  const cfg         = TYPE_CONFIG[type];
  const approved    = results.filter(r => r.status === 'approved');
  const rejected    = results.filter(r => r.status !== 'approved');
  const qualGateRej = rejected.filter(r => r.reason === 'quality_gate').length;
  const simRej      = rejected.filter(r => r.reason === 'student_simulation_fail').length;
  const otherRej    = rejected.length - qualGateRej - simRej;

  const approvedQs   = allApproved.flatMap(e => e.questions || []);
  const flagged      = allApproved.reduce((s, e) => s + (e.meta?.flaggedForReview?.length || 0), 0);
  const complexities = approvedQs.map(q => q.complexityLevel).filter(Number.isFinite);
  const easy         = complexities.filter(c => c <= 2).length;
  const medium       = complexities.filter(c => c === 3).length;
  const hard         = complexities.filter(c => c >= 4).length;
  const total        = approvedQs.length || 1;

  const mutDist = Object.fromEntries(
    cfg.mutations.map(m => [m, approvedQs.filter(q => q.logicType === m || q.mutationType === m).length])
  );

  const rejParts = [];
  if (qualGateRej) rejParts.push(`quality_gate: ${qualGateRej}`);
  if (simRej)      rejParts.push(`student_sim: ${simRej}`);
  if (otherRej)    rejParts.push(`other: ${otherRej}`);

  const SEP = '═'.repeat(39);
  console.log(`\n${SEP}`);
  console.log('TOODY QUESTION BANK — GENERATION COMPLETE');
  console.log(SEP);
  console.log(`Type:               ${cfg.label}`);
  console.log(`Sets attempted:     ${results.length}`);
  console.log(`✓ Approved:        ${approved.length}`);
  console.log(`✗ Rejected:         ${rejected.length}${rejected.length ? ` (${rejParts.join(', ')})` : ''}`);
  console.log(`Questions approved: ${approvedQs.length}`);
  console.log(`Flagged for review: ${flagged} questions`);
  if (complexities.length) {
    console.log('');
    console.log('Complexity profile:');
    console.log(`  Level 1-2 (easy):   ${String(easy).padStart(3)} questions (${Math.round(easy   / total * 100)}%)`);
    console.log(`  Level 3 (medium):   ${String(medium).padStart(3)} questions (${Math.round(medium / total * 100)}%)`);
    console.log(`  Level 4-5 (hard):   ${String(hard).padStart(3)} questions (${Math.round(hard   / total * 100)}%)`);
  }
  if (Object.values(mutDist).some(n => n > 0)) {
    console.log('');
    console.log('Mutation distribution:');
    Object.entries(mutDist).forEach(([m, n]) => {
      console.log(`  ${m.padEnd(26)}: ${String(n).padStart(3)} (${Math.round(n / total * 100)}%)`);
    });
  }
  console.log('');
  console.log(`Bank total: ${approvedQs.length} questions across ${allApproved.length} sets`);
  console.log(`Output: ${cfg.bankFile}`);
  console.log(`Rejected: ${cfg.rejFile}`);
  console.log(`${SEP}\n`);
}

// ── LEAD-TYPE PLANNER (TFNG + YNNG) ──────────────────────────────────────────

function buildLeadTypePlan(type, count) {
  const cfg     = TYPE_CONFIG[type];
  const weights = cfg.mutations.map((m, i) => ({ type: m, weight: cfg.mutWeights?.[i] || (1 / cfg.mutations.length) }));
  const slots   = weights.map(w => ({ type: w.type, n: Math.floor(count * w.weight) }));
  let assigned  = slots.reduce((s, x) => s + x.n, 0);
  const remainders = weights.map((w, i) => ({ i, frac: (count * w.weight) - slots[i].n }))
    .sort((a, b) => b.frac - a.frac);
  for (let r = 0; assigned < count; r++, assigned++) slots[remainders[r % remainders.length].i].n++;
  const plan = slots.flatMap(s => Array(s.n).fill(s.type));
  for (let i = plan.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [plan[i], plan[j]] = [plan[j], plan[i]];
  }
  return plan;
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

async function main() {
  const opts   = parseArgs();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const cfg    = TYPE_CONFIG[opts.type];

  if (!apiKey) {
    console.error('Error: ANTHROPIC_API_KEY required. Run with: node --env-file=.env scripts/generate-question-bank.js');
    process.exit(1);
  }

  // Migrate legacy question-bank.json → question-bank-tfng.json on first run
  if (opts.type === 'tfng' && !existsSync(resolve(ROOT, cfg.bankFile)) && existsSync(resolve(ROOT, 'data/question-bank.json'))) {
    const legacy = loadBank('data/question-bank.json');
    if (legacy.length) { saveBank(cfg.bankFile, legacy); console.log(`Migrated ${legacy.length} sets from question-bank.json → ${cfg.bankFile}\n`); }
  }

  console.log('\nToody Question Bank Generator');
  console.log(`Type:  ${cfg.label}`);
  console.log(`Count: ${opts.count}  |  Band: ${opts.band}  |  Concurrency: ${opts.concurrency}`);
  console.log(`Topic: ${opts.topic || 'random per set'}`);
  console.log(`Mode:  ${opts.append ? 'append' : 'overwrite'}\n`);

  const existingApproved = opts.append ? loadBank(cfg.bankFile)  : [];
  const existingRejected = opts.append ? loadBank(cfg.rejFile) : [];

  // Lead-type plan (only for types that use it)
  const leadTypePlan = cfg.useLeadPlan ? buildLeadTypePlan(opts.type, opts.count) : null;

  if (leadTypePlan) {
    console.log('Lead-type batch plan:');
    const planCount = {};
    leadTypePlan.forEach(t => { planCount[t] = (planCount[t] || 0) + 1; });
    Object.entries(planCount).sort((a, b) => b[1] - a[1]).forEach(([t, n]) =>
      console.log(`  ${t.padEnd(26)} × ${n}`)
    );
    console.log('');
  }

  const topicPool = opts.topic ? null : [...RANDOM_TOPICS];
  function pickTopic() {
    if (opts.topic) return opts.topic;
    if (!topicPool.length) topicPool.push(...RANDOM_TOPICS);
    const i = Math.floor(Math.random() * topicPool.length);
    return topicPool.splice(i, 1)[0];
  }

  const taskFns = Array.from({ length: opts.count }, (_, i) => {
    const topic    = pickTopic();
    const leadType = leadTypePlan?.[i] ?? null;
    return () => generateOneSet(i + 1, opts.count, opts.type, topic, opts.band, apiKey, leadType);
  });

  const results    = await runPool(taskFns, opts.concurrency);
  const newApproved = results.filter(r => r.status === 'approved').map(r => r.entry);
  const newRejected = results.filter(r => r.status !== 'approved').map(r => r.entry);

  const allApproved = [...existingApproved, ...newApproved];
  const allRejected = [...existingRejected, ...newRejected];

  saveBank(cfg.bankFile, allApproved);
  saveBank(cfg.rejFile,  allRejected);

  printSummary(opts.type, results, allApproved);
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
