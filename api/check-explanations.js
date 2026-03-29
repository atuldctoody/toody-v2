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

const CHECK_SYSTEM = `You are a teaching quality auditor for an IELTS coaching product. Your job is to evaluate whether each explanation given to a student meets five specific teaching standards.

You will receive a list of explanations. Each explanation was shown to a student after they answered an IELTS True/False/Not Given or Summary Completion question. For each explanation, score it against every criterion below using a 1–5 scale.

CRITERION 1 — BAND_APPROPRIATE (1–5)
Score 5 if a 16-year-old who scored Band 5 on their last test would understand this on first read, without needing a dictionary or re-reading.
Score 3 if the language is mostly accessible but has one sentence or phrase that a Band 5 student might not understand.
Score 1 if the explanation uses academic or meta-linguistic language that a Band 5 student would likely not understand (e.g. "hedging language", "discourse marker", "syntactic structure" without explanation).
Rule: short sentences (max 20 words), plain vocabulary, no unexplained jargon.

CRITERION 2 — LINGUISTIC_SPECIFICITY (1–5)
Score 5 if the explanation names the exact word or phrase in the passage or statement that determines the answer (e.g. "The word 'suggests' means the writer is not 100% sure").
Score 3 if the explanation references a general feature (e.g. "the passage uses uncertain language") without quoting the specific word.
Score 1 if the explanation gives the correct answer but names no specific word, phrase, or logical feature from the passage or statement.
Rule: a good explanation quotes or names the specific linguistic evidence. "The passage does not support this" with no quoted evidence is a score-1 explanation.

CRITERION 3 — NON_LOCATIONAL (1–5)
Score 5 if the explanation gives a reasoning step with no reference to paragraph or sentence location as the main justification.
Score 3 if location is mentioned alongside a reasoning step (acceptable as context, not as the reason).
Score 1 if location is the primary or only justification (e.g. "The answer is in Paragraph 2" or "See the third sentence").
Rule: location tells students where to look. It does not teach them how to think.

CRITERION 4 — TEACHES_THE_RULE (1–5)
Score 5 if the explanation gives a transferable rule the student can apply to future questions (e.g. "When a statement says 'always' and the passage only gives one example, the answer is Not Given — not True").
Score 3 if the explanation is specific to this question but implies a rule without stating it.
Score 1 if the explanation only states the correct answer for this question with no generalizable insight.
Rule: the best explanation teaches what to do next time, not just what the answer was this time.

CRITERION 5 — CONCRETE_EXAMPLE (1–5)
Score 5 if the explanation uses a direct quote or paraphrase from the actual passage text to demonstrate the reasoning.
Score 3 if the explanation references the passage content without quoting it.
Score 1 if the explanation makes no reference to the actual passage text — just states abstract rules or the correct answer label.
Rule: abstract rules without passage-grounded examples do not build reading skill.

For each explanation, return:
- scores for all five criteria (1–5)
- an avgScore (average of the five, rounded to 1 decimal place)
- a failingCriteria array listing the names of any criterion scoring 1 or 2
- a oneLineNote: a single sentence identifying the most important improvement needed (leave empty string if avgScore >= 4)

Return ONLY this JSON structure (no markdown, no preamble):
{"explanations":[{"id":1,"BAND_APPROPRIATE":4,"LINGUISTIC_SPECIFICITY":2,"NON_LOCATIONAL":5,"TEACHES_THE_RULE":3,"CONCRETE_EXAMPLE":2,"avgScore":3.2,"failingCriteria":["LINGUISTIC_SPECIFICITY","CONCRETE_EXAMPLE"],"oneLineNote":"Name the specific word in the passage that shows uncertainty — do not just say the passage is unclear."}]}`;

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
  if (!explanations?.length || !apiUrl) return;

  // Only evaluate explanations that were actually shown (questions the student answered)
  const scoreable = explanations.filter(e => e.explanation?.trim());
  if (!scoreable.length) return;

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

  try {
    const res = await fetch(apiUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model:       'gpt-4o-mini',
        messages:    [
          { role: 'system', content: CHECK_SYSTEM },
          { role: 'user',   content: userMsg      },
        ],
        max_tokens:  1000,
        temperature: 0,  // deterministic — this is a quality audit, not creative generation
      }),
    });

    if (!res.ok) return;  // non-critical, fail silently
    const data = await res.json();
    let raw = (data.choices?.[0]?.message?.content || '').trim();
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    const result = JSON.parse(raw);

    if (!result?.explanations?.length) return;

    // Map scores back to the original question text for the saved report
    const report = result.explanations.map((r, i) => ({
      questionText:    scoreable[i]?.questionText || '',
      avgScore:        r.avgScore,
      failingCriteria: r.failingCriteria || [],
      oneLineNote:     r.oneLineNote     || '',
      scores: {
        BAND_APPROPRIATE:      r.BAND_APPROPRIATE,
        LINGUISTIC_SPECIFICITY: r.LINGUISTIC_SPECIFICITY,
        NON_LOCATIONAL:        r.NON_LOCATIONAL,
        TEACHES_THE_RULE:      r.TEACHES_THE_RULE,
        CONCRETE_EXAMPLE:      r.CONCRETE_EXAMPLE,
      },
    }));

    const sessionAvg = report.length
      ? Math.round((report.reduce((s, r) => s + r.avgScore, 0) / report.length) * 10) / 10
      : null;

    const weakExplanations = report.filter(r => r.avgScore < 3);

    // Save to the session document — mentor-facing, not shown to the student
    const { updateDoc } = await import('https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js');
    await updateDoc(sessionRef, {
      explanationQuality: {
        sessionAvgScore:  sessionAvg,
        explanationCount: report.length,
        weakCount:        weakExplanations.length,
        flagged:          weakExplanations.length > 0,
        explanations:     report,
        checkedAt:        new Date().toISOString(),
      },
    });
  } catch { /* non-critical — explanation audit is additive only */ }
}
