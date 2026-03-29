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
