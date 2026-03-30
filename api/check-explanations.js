// api/check-explanations.js
// Explanation Quality Agent — Agent 3.
//
// Runs after every reading session completes, fire-and-forget.
// Scores every explanation shown to the student against Toody's five teaching
// standards and saves a quality report to the session document.
//
// Never blocks the UI. Failures are silent — the session is already complete.
// The output is mentor-facing: it surfaces weak explanations for review and
// flags systematic prompt degradation before students see it at scale.
//
// Exports two functions:
//   scoreExplanations(explanations, apiUrl) — pure API scoring, no Firestore (testable)
//   checkExplanations(uid, sessionRef, explanations, apiUrl) — scoring + Firestore save

const CHECK_SYSTEM = `You are a teaching quality auditor for an IELTS coaching product. Your job is to evaluate whether each explanation given to a student effectively teaches them to answer similar questions in future.

You will receive a list of explanations. Each was shown to a student after they answered an IELTS True/False/Not Given question. Score each explanation against all five criteria below using a 1–5 scale.

CRITERION 1 — ACCURACY (1–5)
Is the stated answer actually correct per IELTS rules?
Score 5 if the explanation correctly identifies the answer and the reasoning is consistent with official IELTS True/False/Not Given rules.
Score 3 if the answer is correct but the reasoning contains a minor inaccuracy.
Score 1 if the explanation misstates the answer or applies IELTS rules incorrectly.
Score strictly. Do not round up. A 3 is not a 4.

CRITERION 2 — EVIDENCE (1–5)
Does the explanation cite the specific passage text?
Score 5 if the explanation quotes or names the exact word, phrase, or sentence from the passage that determines the answer.
Score 3 if the explanation references passage content generally without quoting the specific word or phrase.
Score 1 if the explanation gives no reference to actual passage text.
Score strictly. Do not round up. A 3 is not a 4.

CRITERION 3 — REASONING (1–5)
Does it explain WHY, not just WHAT?
Score 5 if the explanation walks through the logical step from passage evidence to answer — showing how the evidence confirms, contradicts, or is absent from the statement.
Score 3 if the explanation states the correct answer with some justification but does not fully connect evidence to conclusion.
Score 1 if the explanation only states what the correct answer is with no reasoning.
Score strictly. Do not round up. A 3 is not a 4.

CRITERION 4 — ERROR NAMING (1–5)
Does it identify the specific trap or reasoning failure?
Score 5 if the explanation names the specific reasoning error the student is likely to make (e.g. "This is a Not Given — the passage doesn't say anything about X, even though it discusses Y").
Score 3 if the explanation implies awareness of a common trap without explicitly naming it.
Score 1 if the explanation makes no reference to what makes this question difficult or why students get it wrong.
Score strictly. Do not round up. A 3 is not a 4.

CRITERION 5 — NEXT STEP (1–5)
Does it tell the student what to look for next time?
Score 5 if the explanation gives a transferable rule or strategy the student can apply to future questions of the same type.
Score 3 if the explanation is specific to this question but implies a generalizable strategy without stating it.
Score 1 if the explanation only addresses this question with no guidance applicable to future questions.
Score strictly. Do not round up. A 3 is not a 4.

For each explanation return:
- scores for all five criteria (1–5)
- avgScore: average of the five criteria scores, rounded to 1 decimal place
- failingCriteria: array of criterion names scoring 1 or 2 (empty array if none)
- oneLineNote: a single sentence on the most important improvement needed (empty string if avgScore >= 4)

Return ONLY this JSON structure (no markdown, no preamble):
{"explanations":[{"id":1,"ACCURACY":4,"EVIDENCE":3,"REASONING":4,"ERROR_NAMING":3,"NEXT_STEP":4,"avgScore":3.6,"failingCriteria":[],"oneLineNote":"Quote the specific word from the passage that makes this Not Given rather than False."}]}`;

// ── JSON helpers (exported so other agents can reuse) ─────────────────────────

export function parseAIJson(raw) {
  return (raw || '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
}

// Repairs two known malformation patterns in AI-generated JSON arrays:
//   1. Stray quote before element opening brace: },"{ → },{
//      (model inserts a spurious " before { when separating array elements)
//   2. Truncation: closes the array + outer object after the last complete element
// Only call this when JSON.parse has already failed.
export function repairJSON(raw) {
  // Fix 1: stray quote before opening brace of an array element
  let s = raw.replace(/\},\s*"\{/g, '},{');
  // Fix 2: truncation — close array + outer object after last complete element
  const lastBrace = s.lastIndexOf('}');
  if (lastBrace === -1) throw new Error('repairJSON: no closing brace found in response');
  return s.slice(0, lastBrace + 1) + ']}';
}

// Tries to parse in three escalating steps, then throws if all fail.
function tryParse(raw) {
  const cleaned = parseAIJson(raw);
  // Step 1: parse as-is
  try { return JSON.parse(cleaned); } catch { /* continue */ }
  // Step 2: fix stray-quote pattern only (all elements may be present but malformed separators)
  try { return JSON.parse(cleaned.replace(/\},\s*"\{/g, '},{')); } catch { /* continue */ }
  // Step 3: full repair — stray-quote fix + truncation close
  return JSON.parse(repairJSON(cleaned));
}

/**
 * Calls the scoring API and returns the quality report.
 * Pure function — no side effects, no Firestore. Safe to call from tests or CLI.
 *
 * @param {Array}  explanations - Array of { questionText, passage, studentAnswer, correctAnswer, explanation, errorReason }
 * @param {string} apiUrl       - The AI API endpoint URL
 * @returns {Promise<{ sessionAvgScore, explanationCount, weakCount, flagged, explanations } | null>}
 */
export async function scoreExplanations(explanations, apiUrl) {
  if (!explanations?.length || !apiUrl) return null;

  const scoreable = explanations.filter(e => e.explanation?.trim());
  if (!scoreable.length) return null;

  const explanationList = scoreable
    .map((e, i) => [
      `ID ${i + 1}:`,
      `  Question: "${e.questionText}"`,
      `  Correct answer: ${e.correctAnswer}`,
      `  Student answer: ${e.studentAnswer}`,
      `  Explanation shown: "${e.explanation}"`,
    ].join('\n'))
    .join('\n\n');

  const userMsg = `Evaluate the following explanations. Each was shown to a Band 5–6 IELTS student after answering a question.\n\n${explanationList}\n\nScore each explanation against all five criteria and return the JSON structure specified in your instructions.`;

  const requestBody = {
    model:       'gpt-4o-mini',
    messages:    [
      { role: 'system', content: CHECK_SYSTEM },
      { role: 'user',   content: userMsg      },
    ],
    max_tokens:  1000,
    temperature: 0,
  };

  async function callAPI() {
    const res = await fetch(apiUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(requestBody),
    });
    if (!res.ok) throw new Error(`check-explanations API call failed: ${res.status}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  }

  // Step 1: first attempt — parse as-is (with markdown fence strip)
  // Step 2: if parse fails — attempt structural repair
  // Step 3: if repair fails — log and retry the full API call once
  // Step 4: if retry also fails — throw and let the step fail
  let result;
  const raw = await callAPI();
  try {
    result = tryParse(raw);
  } catch {
    console.warn(`check-explanations: malformed JSON, attempting repair then retry.\nRaw (first 300 chars): ${raw.slice(0, 300)}`);
    const raw2 = await callAPI();
    result = tryParse(raw2); // throws if still malformed — step fails as before
  }

  if (!result?.explanations?.length) throw new Error('check-explanations returned empty explanations array');

  const report = result.explanations.map((r, i) => {
    const criteriaScores = [r.ACCURACY, r.EVIDENCE, r.REASONING, r.ERROR_NAMING, r.NEXT_STEP]
      .filter(s => typeof s === 'number');
    const avgScore = criteriaScores.length
      ? Math.round((criteriaScores.reduce((a, b) => a + b, 0) / criteriaScores.length) * 10) / 10
      : (r.avgScore ?? 0);
    return {
      questionText:    scoreable[i]?.questionText || '',
      avgScore,
      failingCriteria: r.failingCriteria || [],
      oneLineNote:     r.oneLineNote     || '',
      scores: {
        ACCURACY:     r.ACCURACY,
        EVIDENCE:     r.EVIDENCE,
        REASONING:    r.REASONING,
        ERROR_NAMING: r.ERROR_NAMING,
        NEXT_STEP:    r.NEXT_STEP,
      },
    };
  });

  const sessionAvg = Math.round(
    (report.reduce((s, r) => s + (r.avgScore || 0), 0) / report.length) * 10
  ) / 10;

  return {
    sessionAvgScore:  sessionAvg,
    explanationCount: report.length,
    weakCount:        report.filter(r => r.avgScore < 3).length,
    flagged:          report.some(r => r.avgScore < 3),
    explanations:     report,
    checkedAt:        new Date().toISOString(),
  };
}

/**
 * Scores every explanation shown during a session against Toody's teaching
 * standards and saves a quality report to the session Firestore document.
 *
 * Fire-and-forget — never awaited, never blocks the UI.
 *
 * @param {string}   uid          - Firebase Auth UID (for logging context)
 * @param {object}   sessionRef   - Firestore DocumentReference for the session
 * @param {Array}    explanations - Array of { questionText, passage, studentAnswer, correctAnswer, explanation, errorReason }
 * @param {string}   apiUrl       - The AI API endpoint URL
 */
export async function checkExplanations(uid, sessionRef, explanations, apiUrl) {
  try {
    const quality = await scoreExplanations(explanations, apiUrl);
    if (!quality) return;

    // Save to the session document — mentor-facing, not shown to the student
    const { updateDoc } = await import('https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js');
    await updateDoc(sessionRef, { explanationQuality: quality });
  } catch { /* non-critical — explanation audit is additive only */ }
}
