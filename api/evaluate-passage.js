// api/evaluate-passage.js
// Passage Quality Agent — runs after content generation, before verify-answers.
//
// Evaluates whether a generated passage meets genuine IELTS Academic standard
// before any student sees it. If it fails, the caller regenerates once with
// the specific regenerationInstruction returned here.
//
// Scores 6 dimensions at temperature 0 (deterministic — same principle as
// verify-answers.js). Returns pass/fail + exact failure reasons so the
// regeneration prompt can fix the specific problem.
//
// Non-fatal by design: if this agent errors, the original passage is used.
//
// ESM module (api/package.json sets "type": "module").

const EVAL_SYSTEM = (targetBand) => `You are a senior IELTS Academic examiner with 30 years of experience.
Your job is to evaluate whether a passage meets genuine IELTS Academic standard.

Score the passage on these 6 dimensions. Each dimension scored 1-5. Be strict — a 3 is not a 4.

DIMENSION 1 — ARGUMENT STRUCTURE (1-5)
5: Clear Hypothesis → Evidence → Counter-argument → Conclusion structure
4: Clear argument with most structural elements present
3: Some argument present but mostly factual reporting
2: Mostly facts listed sequentially with no clear argument
1: No discernible argument structure

DIMENSION 2 — ACADEMIC VOCABULARY (1-5)
5: Consistent Tier 2/3 academic vocabulary used correctly throughout (consequently, attributed to, demonstrates, indicates, suggests)
4: Good academic vocabulary with minor lapses into conversational language
3: Mix of academic and conversational — feels like a newspaper not a journal
2: Mostly conversational vocabulary
1: No academic vocabulary

DIMENSION 3 — WRITER'S STANCE (1-5)
5: Author has a clear discernible position — uses opinion markers (argues, contends, it is evident that) and hedging (may suggest, appears to, is widely considered)
4: Some stance present but inconsistent
3: Neutral reporting only — no stance detectable
2: Confusing or contradictory stance
1: No stance

DIMENSION 4 — TRAP POTENTIAL (1-5)
5: Contains hedging language (may, suggests, could, appears to), scope qualifiers (some, most, certain), and causal language (consequently, as a result) that can generate genuine T/F/NG traps
4: Contains most trap elements
3: Some hedging or scope language but limited trap potential
2: Very little trap potential — mostly absolute statements
1: No trap potential — all statements are absolute and unambiguous

DIMENSION 5 — LOGICAL INTEGRITY (1-5)
5: Every claim is supported, no logical gaps, no assertions without basis
4: Mostly logical with one minor unsupported claim
3: Some logical gaps present
2: Multiple unsupported assertions
1: Logically inconsistent

DIMENSION 6 — BAND APPROPRIATENESS (1-5)
5: Complexity, vocabulary density and sentence structure precisely match Band ${targetBand} reading level
4: Broadly appropriate with minor mismatches
3: Noticeably too easy or too hard for target band
2: Significantly mismatched to target band
1: Completely wrong difficulty level

Return ONLY valid JSON in this exact format:
{
  "scores": {
    "argumentStructure": <1-5>,
    "academicVocabulary": <1-5>,
    "writersStance": <1-5>,
    "trapPotential": <1-5>,
    "logicalIntegrity": <1-5>,
    "bandAppropriateness": <1-5>
  },
  "avgScore": <calculated average to 1 decimal place>,
  "pass": <true if avgScore >= 3.5 AND no individual dimension below 3, false otherwise>,
  "failReasons": [<array of specific failure reasons, empty if pass>],
  "regenerationInstruction": "<if fail: one specific instruction telling the AI exactly what to fix in the regenerated passage, empty string if pass>"
}`;

/**
 * Evaluates a passage against IELTS Academic standard.
 *
 * @param {string} passage    - The passage text to evaluate
 * @param {number} targetBand - The student's target band (used for dimension 6)
 * @param {string} apiUrl     - The AI API endpoint URL (full URL, e.g. .../api/generate)
 * @returns {Promise<{
 *   scores: object,
 *   avgScore: number|null,
 *   pass: boolean,
 *   failReasons: string[],
 *   regenerationInstruction: string,
 *   error?: string
 * }>}
 */
export async function evaluatePassage(passage, targetBand, apiUrl) {
  const userPrompt = `Evaluate this passage for IELTS Academic standard at Band ${targetBand}:

"${passage}"`;

  try {
    const res = await fetch(apiUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model:       'gpt-4o',
        messages:    [
          { role: 'system', content: EVAL_SYSTEM(targetBand) },
          { role: 'user',   content: userPrompt              },
        ],
        max_tokens:  600,
        temperature: 0,   // deterministic — this is a quality gate, not creative generation
      }),
    });

    if (!res.ok) throw new Error(`evaluate-passage API returned ${res.status}`);
    const data = await res.json();
    let raw = (data.choices?.[0]?.message?.content || '').trim();
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    const result = JSON.parse(raw);

    // Enforce pass logic server-side in case the model miscalculates
    const s = result.scores || {};
    const vals = Object.values(s).filter(v => typeof v === 'number');
    const avg  = vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null;
    const anyBelow3 = vals.some(v => v < 3);
    result.avgScore = avg;
    result.pass     = avg !== null && avg >= 3.5 && !anyBelow3;

    return result;

  } catch (err) {
    // Non-fatal — if this agent fails, caller uses original passage unchanged
    return {
      pass:                    true,
      avgScore:                null,
      scores:                  null,
      failReasons:             [],
      regenerationInstruction: '',
      error:                   err.message,
    };
  }
}
