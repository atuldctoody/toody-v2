// api/verify-answers.js
// Independent Answer Verification Agent for TFNG questions.
//
// Runs after AI content generation, before display to the student.
// Makes a separate, context-free API call with temperature 0 so the
// check is deterministic — no coaching context, no student persona,
// just strict IELTS rules applied to the raw passage text.
//
// Design intent: the vision prompt + quality evaluator catch style
// issues; this agent catches logical errors where the AI assigned the
// wrong True/False/NG label despite knowing the rules.

const VERIFY_SYSTEM = `You are a strict IELTS Academic examiner verifying True/False/Not Given answer keys. Your only job is to check whether each stated answer is correct given the passage. Apply these rules with zero tolerance:

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

/**
 * Verifies TFNG answers independently and returns corrected questions.
 *
 * @param {string}   passage   - The reading passage text
 * @param {Array}    questions - Array of question objects with id, text, answer, explanation
 * @param {string}   apiUrl    - The AI API endpoint URL
 * @returns {Promise<{questions: Array, corrections: Array}>}
 *   - questions: same array with any wrong answers corrected in-place
 *   - corrections: array of correction records (empty if all correct)
 */
export async function verifyAnswers(passage, questions, apiUrl) {
  if (!passage || !questions?.length) return { questions, corrections: [] };

  const questionList = questions
    .map(q => `ID ${q.id}: Statement: "${q.text}" | Stated answer: "${q.answer}"`)
    .join('\n');

  const userMsg = `Passage:\n${passage}\n\nQuestions to verify:\n${questionList}\n\nFor each question, independently determine the correct answer from the passage, then compare it to the stated answer. If they differ, set correctionNeeded to true and explain which specific rule was violated.\n\nReturn ONLY this JSON (no markdown, no preamble):\n{"questions":[{"id":1,"originalAnswer":"True","verifiedAnswer":"True","correctionNeeded":false,"correctionReason":""},{"id":2,"originalAnswer":"True","verifiedAnswer":"NG","correctionNeeded":true,"correctionReason":"The passage uses 'may suggest' — hedging language that does not explicitly confirm the statement, making it Not Given not True"}]}`;

  try {
    const res = await fetch(apiUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model:       'gpt-4o-mini',
        messages:    [
          { role: 'system', content: VERIFY_SYSTEM },
          { role: 'user',   content: userMsg        },
        ],
        max_tokens:  700,
        temperature: 0,   // deterministic — this is a factual check, not creative generation
      }),
    });

    if (!res.ok) throw new Error(`verify call failed: ${res.status}`);
    const data = await res.json();
    let raw = (data.choices?.[0]?.message?.content || '').trim();
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
        reason:          v.correctionReason,
      });

      // Replace explanation with one that matches the corrected answer
      const correctedExplanation = v.correctionReason || q.explanation;
      return { ...q, answer: v.verifiedAnswer, explanation: correctedExplanation };
    });

    return { questions: correctedQs, corrections };
  } catch {
    // Verification failure is non-fatal — original questions returned unchanged
    return { questions, corrections: [] };
  }
}
