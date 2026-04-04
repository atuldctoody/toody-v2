// api/verify.js
// Vercel serverless function — Answer Verification Agent (Claude Sonnet backend).
//
// Called by the browser-side api/verify-answers.js module.
// Uses the Anthropic SDK server-side so the API key is never exposed to the browser.
//
// POST { passage: string, questions: Array<{id, text, answer}> }
// → { questions: Array<corrected>, corrections: Array<correction> }

import Anthropic from '@anthropic-ai/sdk';

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

ERROR TAGS — assign exactly one to each correction:
- neutralAuthor: reporting verb / debate context misread as fact
- inferenceTrap: sequence misread as causation
- adverbOverlook: partial qualifier in passage vs absolute in statement
- absoluteQualifier: always/never/all/every vs hedged passage language
- assumptionTrap: logical bridge missing from passage
- causalAssumption: co-occurrence misread as causation
- hedgingLanguage: may/could/suggests misread as explicit confirmation
- scopeError: claim broadened or narrowed beyond what passage states
- pipeSeparated: answer contained pipe-separated values

Re-evaluate each question independently. Only use the passage text as evidence. Return valid JSON only.`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { passage, questions } = req.body || {};
  if (!passage || !Array.isArray(questions) || questions.length === 0) {
    res.status(400).json({ error: 'passage and questions array required' });
    return;
  }

  const questionList = questions
    .map(q => `ID ${q.id}: Statement: "${q.text}" | Stated answer: "${q.answer}"`)
    .join('\n');

  const userMsg = `Passage:\n${passage}\n\nQuestions to verify:\n${questionList}\n\nFor each question, independently determine the correct answer from the passage, then compare it to the stated answer. If they differ, set correctionNeeded to true, identify the errorTag, and explain which specific rule was violated.\n\nReturn ONLY this JSON (no markdown, no preamble):\n{"questions":[{"id":1,"originalAnswer":"True","verifiedAnswer":"True","correctionNeeded":false,"correctionReason":"","errorTag":""},{"id":2,"originalAnswer":"True","verifiedAnswer":"NG","correctionNeeded":true,"correctionReason":"The passage uses 'may suggest' — cautious language that does not explicitly confirm the statement, making it Not Given not True","errorTag":"hedgingLanguage"}]}`;

  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const message = await anthropic.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 2000,
      temperature: 0,
      system:     VERIFY_SYSTEM,
      messages:   [{ role: 'user', content: userMsg }],
    });

    let raw = (message.content?.[0]?.text || '').trim();
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    const result = JSON.parse(raw);

    const corrections = [];
    const correctedQs = questions.map(q => {
      const v = result.questions?.find(vq => Number(vq.id) === Number(q.id));
      if (!v || !v.correctionNeeded) return q;

      corrections.push({
        questionId:      q.id,
        questionText:    q.text,
        originalAnswer:  v.originalAnswer,
        correctedAnswer: v.verifiedAnswer,
        errorTag:        v.errorTag || '',
        reason:          v.correctionReason || '',
      });

      return { ...q, answer: v.verifiedAnswer, explanation: v.correctionReason || q.explanation };
    });

    res.status(200).json({ questions: correctedQs, corrections });
  } catch (err) {
    // Verification failure is non-fatal — return originals so the session continues
    console.error('verify.js error:', err?.message);
    res.status(200).json({ questions, corrections: [] });
  }
}
