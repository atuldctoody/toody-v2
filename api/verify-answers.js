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


/**
 * Verifies TFNG answers independently and returns corrected questions.
 * Delegates to the /api/verify Vercel serverless function which uses Claude Sonnet.
 *
 * @param {string}   passage   - The reading passage text
 * @param {Array}    questions - Array of question objects with id, text, answer, explanation
 * @param {string}   apiUrl    - The base AI API endpoint URL (e.g. .../api/generate)
 * @returns {Promise<{questions: Array, corrections: Array}>}
 *   - questions: same array with any wrong answers corrected in-place
 *   - corrections: array of { questionId, questionText, originalAnswer, correctedAnswer, errorTag, reason }
 */
export async function verifyAnswers(passage, questions, apiUrl) {
  if (!passage || !questions?.length) return { questions, corrections: [] };

  // Route to the dedicated verify endpoint on the same Vercel project
  const verifyUrl = apiUrl.replace(/\/api\/[^/]+$/, '/api/verify');

  try {
    const res = await fetch(verifyUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ passage, questions }),
    });

    if (!res.ok) throw new Error(`verify call failed: ${res.status}`);
    const data = await res.json();
    return data; // { questions: correctedQs, corrections }
  } catch {
    // Verification failure is non-fatal — original questions returned unchanged
    return { questions, corrections: [] };
  }
}
