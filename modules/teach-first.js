// modules/teach-first.js
// Teach-First lesson flow: hook → concept → worked examples → reinforce → confidence → session.
//
// Forward references (resolved when their modules are created):
//   loadReadingSession — session loader still in app.js

import { TFNG_WORKED_EXAMPLES, API_URL, AUDIO_URL } from './constants.js';
import { studentData, currentUser, getIELTSSkills, callAI, saveLearningStyleSignal } from './state.js';
import { goTo, setCurrentPlan, currentPlan, pickNextSkill, launchSkillScreen } from './router.js';
import { getSkillConfig, parseAIJson, normaliseAnswer, toSkillId, boldify, base64ToBlob, renderReasoningHtml } from './utils.js';
import { updateStudentDoc } from './firebase.js';
import { showToast } from './ui.js';
import { verifyAnswers } from '../api/verify-answers.js';

// ── TEACH-FIRST STATE ─────────────────────────────────────────────
let teachData         = null;  // AI-generated lesson content
let teachStep         = 0;     // Current step in worked example
let teachSkillKey     = '';    // Skill being taught (e.g. 'reading.tfng')
let microAttempts     = 0;     // Legacy — kept for drill compat
let teachDrillIndex   = 0;     // Current drill question index
let teachDrillCorrect = 0;     // Correct answers in quick drill
let teachStartTime    = 0;     // Date.now() at start of teach phase
let workedExIdx       = 0;     // Which of the 3 guided examples we're on
let confQIdx          = 0;     // Confidence builder question index
let confCorrect       = 0;     // Confidence correct count

// ── LOAD TEACH FIRST ─────────────────────────────────────────────
export async function loadTeachFirst(skillKey) {
  teachData         = null;
  teachStep         = 0;
  teachStartTime    = Date.now();
  workedExIdx       = 0;
  confQIdx          = 0;
  confCorrect       = 0;
  teachDrillIndex   = 0;
  teachDrillCorrect = 0;
  teachSkillKey     = skillKey || 'reading.tfng';

  ['teach-hook','teach-concept','teach-worked','teach-reinforce','teach-confidence'].forEach(id => {
    document.getElementById(id)?.classList.add('hidden');
  });
  document.getElementById('teach-loading').classList.remove('hidden');
  goTo('s-teach');

  const band = studentData?.targetBand || 6.5;
  // Look up per-skill config from SKILL_MANIFEST
  const skillId    = toSkillId(skillKey);
  const cfg        = getSkillConfig(skillId);
  const skillLabel = cfg.displayName;
  const isMH       = cfg.hookStyle === 'matching';
  const isYNNG     = cfg.hookStyle === 'ynng';
  const isTFNG     = cfg.answerButtons.includes('Not Given') && !isYNNG;

  // ── TEACHING ATTEMPTS TRACKING ────────────────────────────────────
  // Record that Teach-First fired for this skill, and snapshot accuracy before teaching.
  if (currentUser) {
    try {
      const prevSkillBrainTeach = studentData?.brain?.subjects?.['ielts-academic']?.skills?.[skillId] || {};
      const newTeachAttempts    = (prevSkillBrainTeach.teachingAttempts || 0) + 1;
      const currentAccForSkill  = getIELTSSkills()[skillId]?.accuracy ?? null;
      const subjPathTeach       = `brain.subjects.ielts-academic.skills.${skillId}`;
      await updateStudentDoc(currentUser.uid, {
        [`${subjPathTeach}.teachingAttempts`]:      newTeachAttempts,
        [`${subjPathTeach}.accuracyBeforeTeaching`]: currentAccForSkill,
        [`${subjPathTeach}.aiResolved`]:            prevSkillBrainTeach.aiResolved || false,
        [`${subjPathTeach}.needsHuman`]:            prevSkillBrainTeach.needsHuman || false,
      });
    } catch { /* non-critical */ }
  }

  // Update the concept section header text from config
  const conceptBubble = document.querySelector('#teach-concept .toody-bubble');
  if (conceptBubble) conceptBubble.innerHTML = cfg.conceptBubble;
  const strategyLabel = document.querySelector('#teach-concept .card-label');
  if (strategyLabel) strategyLabel.textContent = 'The Strategy';

  const conceptPromptDetail = cfg.conceptPromptHint;

  const ansVals = isMH ? ['A','B','A'] : isYNNG ? ['Yes','No','Not Given'] : isTFNG ? ['True','False','NG'] : ['True','False','True'];

  // Skill-specific passage and statement descriptions for the hook question
  const hookPassageDesc = isMH
    ? '2 academic sentences — choose a topic where one heading fits the main idea but another could mislead'
    : isYNNG
    ? "2 academic sentences written in first person, clearly expressing the author's opinions"
    : isTFNG
    ? '2 academic sentences — choose a tricky topic where the Not Given trap applies'
    : '2 academic sentences from which a one-sentence summary can be drawn with one key term left blank';

  // Skill-specific statement/example descriptions
  const statementDesc = isMH
    ? 'a testable claim that looks True but is actually False — a detail matches but not the main idea'
    : (isYNNG || isTFNG)
    ? cfg.hookPromptHint
    : 'a summary sentence with one blank gap where the instinctive fill word uses the wrong form (e.g. noun instead of adjective)';

  const exStatementHint = isMH
    ? 'a heading choice where a distractor matches a detail but not the main idea'
    : isTFNG
    ? 'testable claim'
    : 'a summary sentence with one blank gap and a wrong-form distractor visible';

  const sysAnswerRule = isYNNG
    ? 'CRITICAL: Every "answer" field must be exactly ONE value (Yes, No, or Not Given) — never True/False/NG.'
    : isTFNG
    ? 'CRITICAL: Every "answer" field must be exactly ONE value (True, False, or NG) — never pipe-separated.'
    : 'CRITICAL: Every "answer" field must be exactly one of: True or False — never pipe-separated or NG.';

  const exSchema = (label, ansIdx) =>
    `{"label":"${label}","passage":"2 academic sentences","statement":"${exStatementHint}","answer":"${ansVals[ansIdx]}","steps":["Step 1 reasoning","Step 2 reasoning","Step 3 reasoning"],"conclusion":"Therefore the answer is ${ansVals[ansIdx]} — one sentence.","insight":"One sentence for the student: what to notice about this specific example or trap."}`;

  const prompt = {
    system: `You are an expert IELTS Academic teacher. Return valid JSON only, no markdown, no preamble. ${sysAnswerRule}`,
    user: `Generate a 10-minute interactive lesson on ${skillLabel} for a Band ${band} IELTS student.

Return ONLY this JSON:
{
  "concept": ${conceptPromptDetail},${isTFNG ? `
  "conceptExamples": [
    INSTRUCTION — these three examples must be completely unambiguous. A trained IELTS examiner would agree on every answer 100% of the time with zero debate. DO NOT use: cautious language (may, might, could, suggests), reported opinions (experts argue, some believe), or partial scope (some, most) in these examples — those belong in advanced trap examples, not foundational concept teaching.
    {"passage": "2 academic sentences that explicitly and directly state a single clear fact — plain declarative language, no cautious words, no reporting verbs, stated as established knowledge", "statement": "a claim that uses the same or directly synonymous language to match the fact stated in the passage", "answer": "True", "explanation": "one sentence: passage explicitly states this — same meaning confirmed with no cautious language"},
    {"passage": "2 academic sentences that explicitly state the direct opposite of the statement as an established fact — a plain factual assertion, not a reported opinion, no cautious language — the passage and statement directly contradict each other", "statement": "a claim that directly contradicts the fact stated in the passage", "answer": "False", "explanation": "one sentence: passage explicitly states the opposite as fact — direct unambiguous contradiction"},
    {"passage": "2 academic sentences on a topic — the passage discusses the topic but never mentions the specific aspect in the statement at all — completely absent, no cautious language, not reported opinion, simply not there", "statement": "a claim about a specific aspect that the passage never addresses at all", "answer": "NG", "explanation": "one sentence: the passage is completely silent on this specific claim — it never mentions it"}
  ],` : ''}
  "hookQuestion": {
    "passage": "${hookPassageDesc}",
    "statement": "${statementDesc}",
    "answer": "${isMH ? 'False' : isYNNG ? 'Not Given' : isTFNG ? 'NG' : 'False'}",
    "insight": "Here is what most students miss: one sentence explaining exactly why this question trips people up."
  },
  "workedExamples": [
    ${exSchema('Easy', 0)},
    ${exSchema('Medium — introduce the most common trap for this question type', 1)},
    ${exSchema('Hard — the exact sub-type where most Band 6 students fail', 2)}
  ],
  "confidenceQuestions": [
    {"passage": "2 academic sentences — set at Band ${Math.max(5, band - 0.5)} difficulty", "statement": "a clear achievable claim", "answer": "${ansVals[0]}", "explanation": "one sentence"},
    {"passage": "2 academic sentences on a different topic — set at Band ${Math.max(5, band - 0.5)} difficulty", "statement": "another achievable claim", "answer": "${ansVals[1]}", "explanation": "one sentence"}
  ],
  "drillQuestions": [
    {"passage": "2 academic sentences", "statement": "a testable claim", "answer": "${ansVals[2]}", "explanation": "one sentence"},
    {"passage": "2 academic sentences on a different topic", "statement": "another testable claim", "answer": "${ansVals[0]}", "explanation": "one sentence"}
  ]
}`,
    maxTokens: 3500
  };

  try {
    const raw  = await callAI(prompt);
    teachData  = parseAIJson(raw);

    // For reading-tfng, replace AI-generated worked examples with the hardcoded
    // expert-verified set. Hook, concept, confidence, and drill remain AI-generated.
    if (cfg.workedExamples === 'hardcoded') {
      teachData.workedExamples = TFNG_WORKED_EXAMPLES;
    }

    // Verify drill + confidence + conceptExamples + worked examples for T/F/NG and Y/N/NG skills.
    // Each question has its own embedded passage, so we verify each one independently in parallel.
    // Non-fatal: if verification fails the original AI-generated question is used.
    if (cfg.answerButtons.includes('Not Given')) {
      try {
        // Adapter for questions that carry an explanation field (drill, confidence, conceptExamples).
        const verifyTeachQ = async (q, idx) => {
          const result = await verifyAnswers(
            q.passage,
            [{ id: idx + 1, text: q.statement, answer: q.answer, explanation: q.explanation }],
            API_URL
          );
          const vq = result.questions?.[0];
          return vq ? { ...q, answer: vq.answer, explanation: vq.explanation } : q;
        };

        // GAP 2 — adapter for AI-generated worked examples (steps/conclusion format).
        // Only the answer field is updated — explanation is intentionally NOT spread back,
        // because adding it would trigger the rich-format renderer branch in renderWorkedExampleAt().
        const verifyWorkedQ = async (q, i) => {
          const result = await verifyAnswers(
            q.passage,
            [{ id: i + 1, text: q.statement, answer: q.answer, explanation: '' }],
            API_URL
          );
          const vq = result.questions?.[0];
          return vq ? { ...q, answer: vq.answer } : q;
        };

        const drillQs     = teachData.drillQuestions      || [];
        const confQs      = teachData.confidenceQuestions || [];
        const conceptExQs = teachData.conceptExamples     || [];
        // Skip hardcoded worked examples (reading-tfng) — already expert-verified.
        const workedQs    = cfg.workedExamples !== 'hardcoded' ? (teachData.workedExamples || []) : [];

        const [verifiedDrill, verifiedConf, verifiedConceptEx, verifiedWorked] = await Promise.all([
          Promise.all(drillQs.map(    (q, i) => verifyTeachQ(q, i).catch(() => q))),
          Promise.all(confQs.map(     (q, i) => verifyTeachQ(q, i).catch(() => q))),
          Promise.all(conceptExQs.map((q, i) => verifyTeachQ(q, i).catch(() => q))),
          Promise.all(workedQs.map(   (q, i) => verifyWorkedQ(q, i).catch(() => q))),
        ]);

        if (verifiedDrill.length)     teachData.drillQuestions      = verifiedDrill;
        if (verifiedConf.length)      teachData.confidenceQuestions = verifiedConf;
        if (verifiedConceptEx.length) teachData.conceptExamples     = verifiedConceptEx;
        if (verifiedWorked.length)    teachData.workedExamples      = verifiedWorked;
      } catch { /* non-fatal — original questions used */ }
    }

    // GAP 1 — verify hookQuestion for T/F/NG and Y/N/NG skills before it is rendered.
    // The hook is intentionally verified separately so it runs regardless of whether
    // the bulk verification block above was entered.
    // Non-fatal: if verification fails the original AI-generated hook is used.
    if (teachData.hookQuestion &&
        (cfg.answerButtons.includes('Not Given') || cfg.answerButtons.includes('False'))) {
      try {
        const hookResult = await verifyAnswers(
          teachData.hookQuestion.passage,
          [{ id: 1, text: teachData.hookQuestion.statement, answer: teachData.hookQuestion.answer, explanation: teachData.hookQuestion.insight || '' }],
          API_URL
        );
        const hq = hookResult.questions?.[0];
        if (hq) {
          teachData.hookQuestion.answer = hq.answer;
          if (hq.explanation) teachData.hookQuestion.insight = hq.explanation;
        }
      } catch (err) { console.warn('Hook verification failed, using original:', err?.message || err); }
    }

    // Render concept bullets + verified illustrative examples
    const bullets = Array.isArray(teachData.concept)
      ? teachData.concept
      : String(teachData.concept).split('\n').filter(p => p.trim());
    const boldify = s => s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    let conceptHtml = '<ul class="teach-bullets">' +
      bullets.map(b => `<li>${boldify(b.replace(/^[-•]\s*/, ''))}</li>`).join('') +
      '</ul>';

    // Append verified concept examples (structured, verified — not raw AI text)
    const conceptExamples = teachData.conceptExamples || [];
    if (conceptExamples.length) {
      conceptHtml += conceptExamples.map(ex => {
        const normAns  = normaliseAnswer(ex.answer);
        const ansLabel = normAns === 'notgiven' ? 'Not Given' : ex.answer;
        const ansColor = (normAns === 'true'  || normAns === 'yes') ? 'var(--success)'
                       : (normAns === 'false' || normAns === 'no')  ? 'var(--danger)'
                       : 'var(--accent)';
        return `<div class="card" style="margin-top:10px;padding:12px 14px;">
          <div class="card-label" style="color:${ansColor}">Example — answer: ${ansLabel}</div>
          <div style="font-size:13px;font-style:italic;color:var(--muted);margin:6px 0 4px">${ex.passage}</div>
          <div style="font-size:13px;margin-bottom:4px">Statement: "${ex.statement}"</div>
          <div style="font-size:13px;font-weight:600;color:${ansColor}">→ ${ansLabel}. ${ex.explanation}</div>
        </div>`;
      }).join('');
    }

    document.getElementById('teach-concept-body').innerHTML = conceptHtml;

    document.getElementById('teach-loading').classList.add('hidden');
    renderHookQuestion();
  } catch {
    showToast('Having trouble connecting — please check your internet and try again.');
    loadReadingSession();
  }
}
window.loadTeachFirst = loadTeachFirst;

// ── HOOK PHASE ────────────────────────────────────────────────────
function renderHookQuestion() {
  const hq = teachData.hookQuestion;
  if (!hq) { window.startConceptPhase(); return; }
  document.getElementById('teach-hook-passage').textContent = hq.passage;
  document.getElementById('teach-hook-statement').textContent = hq.statement;

  const hookCfg       = getSkillConfig(toSkillId(teachSkillKey));
  const btnsContainer = document.getElementById('teach-hook-btns');

  // Clean up any previous text input wrap from a typed-answer skill
  const prevTextWrap = document.getElementById('teach-hook-text-wrap');
  if (prevTextWrap) prevTextWrap.remove();

  if (hookCfg.hookStyle === 'matching') {
    // Render letter option buttons (A, B, C, D, E) from skill config
    btnsContainer.innerHTML = hookCfg.answerButtons.map(v =>
      `<button class="tfng-btn" onclick="window.answerHook('${v}')" data-mv="${v}">${v}</button>`
    ).join('');
    btnsContainer.classList.remove('hidden');
  } else if (hookCfg.hookStyle === 'gapfill' || hookCfg.hookStyle === 'shortanswer') {
    btnsContainer.classList.add('hidden');
    // Inject text input for typed-answer hook questions
    let inputWrap = document.createElement('div');
    inputWrap.id = 'teach-hook-text-wrap';
    btnsContainer.insertAdjacentElement('beforebegin', inputWrap);
    inputWrap.innerHTML = `
      <input type="text" id="hook-text-input" placeholder="Type your answer here..."
        style="width:100%;padding:16px;border-radius:12px;border:1.5px solid #E0DFF0;font-size:15px;color:#1A1A2E;background:#fff;box-sizing:border-box;font-family:inherit">
      <button class="btn mt8" onclick="window.answerHook(document.getElementById('hook-text-input').value)">Submit answer →</button>
    `;
  } else if (hookCfg.hookStyle === 'ynng') {
    // ynng: Yes / No / Not Given buttons
    btnsContainer.innerHTML =
      `<button class="tfng-btn" onclick="window.answerHook('Yes')"       data-mv="Yes">✓ Yes</button>` +
      `<button class="tfng-btn" onclick="window.answerHook('No')"        data-mv="No">✗ No</button>` +
      `<button class="tfng-btn" onclick="window.answerHook('Not Given')" data-mv="Not Given">? Not Given</button>`;
    btnsContainer.classList.remove('hidden');
  } else {
    // tfng: ensure True / False / NG buttons are present with correct NG visibility
    btnsContainer.innerHTML =
      `<button class="tfng-btn" onclick="window.answerHook('True')"  data-mv="True">✓ True</button>` +
      `<button class="tfng-btn" onclick="window.answerHook('False')" data-mv="False">✗ False</button>` +
      `<button class="tfng-btn" onclick="window.answerHook('NG')"    data-mv="NG">? Not Given</button>`;
    btnsContainer.classList.remove('hidden');
    const ngBtn = btnsContainer.querySelector('[data-mv="NG"]');
    if (ngBtn) ngBtn.classList.toggle('hidden', !hookCfg.answerButtons.includes('Not Given'));
  }

  // Reset all buttons to neutral unselected state
  document.querySelectorAll('#teach-hook-btns .tfng-btn').forEach(b => {
    b.classList.remove('correct', 'wrong', 'selected');
    b.disabled = false;
  });
  if (document.activeElement && document.activeElement !== document.body) {
    document.activeElement.blur();
  }
  document.getElementById('teach-hook-reveal').classList.add('hidden');
  document.getElementById('teach-hook').classList.remove('hidden');
}

window.answerHook = function (val) {
  const hq = teachData.hookQuestion;
  if (!hq) return;
  const hookCfg    = getSkillConfig(toSkillId(teachSkillKey));
  const isTextInput = hookCfg.hookStyle === 'gapfill' || hookCfg.hookStyle === 'shortanswer';
  if (isTextInput) {
    const inputEl   = document.getElementById('hook-text-input');
    const inputWrap = document.getElementById('teach-hook-text-wrap');
    if (inputEl) inputEl.disabled = true;
    const submitBtn = inputWrap?.querySelector('.btn');
    if (submitBtn) submitBtn.disabled = true;
    const isRight = normaliseAnswer(val) === normaliseAnswer(hq.answer);
    if (inputEl) inputEl.style.borderColor = isRight ? 'var(--success)' : 'var(--danger)';
    if (!isRight && inputWrap) {
      const fb = document.createElement('div');
      fb.style.cssText = 'font-size:13px;color:var(--danger);margin-top:6px;font-weight:600';
      fb.textContent = `Answer: ${hq.answer}`;
      inputWrap.appendChild(fb);
    }
  } else {
    document.querySelectorAll('#teach-hook-btns .tfng-btn').forEach(b => {
      b.disabled = true;
      if (normaliseAnswer(b.dataset.mv) === normaliseAnswer(hq.answer)) b.classList.add('correct');
      else if (b.dataset.mv === val) b.classList.add('wrong');
    });
  }
  document.getElementById('teach-hook-insight').textContent = hq.insight || '';
  document.getElementById('teach-hook-reveal').classList.remove('hidden');
  window.scrollTo(0, document.body.scrollHeight);
};

window.startConceptPhase = function () {
  document.getElementById('teach-hook').classList.add('hidden');
  document.getElementById('teach-concept').classList.remove('hidden');
};

// ── GUIDED PRACTICE — 3 WORKED EXAMPLES ──────────────────────────
function renderWorkedExampleAt(idx) {
  const examples = teachData.workedExamples || [];
  if (idx >= examples.length) { renderConfidenceQuestion(0); return; }
  const we = examples[idx];

  // Use the label from the example itself if present (hardcoded format),
  // otherwise fall back to Easy/Medium/Hard (AI format).
  const fallbackLabels = ['Easy', 'Medium', 'Hard'];
  const counterLabel = we.label || `${fallbackLabels[idx] || ''}`;
  document.getElementById('teach-ex-counter').textContent = `Example ${idx + 1} of 3 — ${counterLabel}`;
  document.getElementById('teach-ex-fill').style.width = `${((idx + 1) / 3) * 100}%`;
  document.getElementById('teach-we-passage').innerHTML = (we.passage || '')
    .split('\n').filter(p => p.trim()).map(p => `<p>${p}</p>`).join('');
  document.getElementById('teach-we-statement').textContent = we.statement || '';

  const insightEl = document.getElementById('teach-ex-insight');
  insightEl.classList.add('hidden');
  document.getElementById('teach-ex-insight-text').textContent = '';

  const tryBtn = document.getElementById('teach-try-btn');
  tryBtn.classList.add('hidden');
  tryBtn.textContent = idx < 2 ? 'Next example →' : 'Try on your own →';

  // Normalise answer to the three keys used by answerToChoice
  const normAns = normaliseAnswer(we.answer || 'ng');
  const answerToChoice = { true: 'confirms', false: 'contradicts', notgiven: 'silent', ng: 'silent', yes: 'confirms', no: 'contradicts' };
  const correctChoice  = answerToChoice[normAns] || 'silent';

  // ── RICH FORMAT (hardcoded examples — explanation/bandFiveAnswer/teachingNote) ──
  if (we.explanation) {
    const answerLabel  = normAns === 'true' || normAns === 'yes' ? (normAns === 'yes' ? 'Yes' : 'True') : normAns === 'false' || normAns === 'no' ? (normAns === 'no' ? 'No' : 'False') : 'Not Given';
    const wrongBadge   = we.bandFiveAnswer
      ? `<div class="card" style="margin-top:12px;border:2px solid var(--danger)">
           <div class="card-label" style="color:var(--danger)">⚠ What most students answer</div>
           <div class="teach-step-text"><strong>${we.bandFiveAnswer}</strong> — ${we.bandFiveReason || ''}</div>
         </div>`
      : '';
    const trapBadge    = we.trap && we.trap !== 'none — this is the clearest case. If a student gets this wrong they have a fundamental False vs Not Given confusion.'
      ? `<div class="card" style="margin-top:8px;background:var(--surface-2,#f8f4ff)">
           <div class="card-label" style="color:var(--accent)">Trap</div>
           <div class="teach-step-text">${we.trap}</div>
         </div>`
      : '';
    const teachNote    = we.teachingNote
      ? `<div class="card" style="margin-top:8px;border:2px solid var(--success)">
           <div class="card-label" style="color:var(--success)">✅ Key rule</div>
           <div class="teach-step-text" style="font-weight:600">${we.teachingNote}</div>
         </div>`
      : '';

    document.getElementById('teach-steps-container').innerHTML = `
      <div class="predict-block" id="predict-0">
        <div class="predict-prompt">What do most Band 5 students answer here — and why?</div>
        <button class="btn-secondary mt8" onclick="window.teachRevealStep(0)">Show me <span class="arrow">→</span></button>
        <div class="predict-reveal hidden" id="predict-reveal-0">
          ${wrongBadge}
        </div>
      </div>
      <div class="predict-block hidden" id="predict-1">
        <div class="predict-prompt">Here is the correct reasoning — step by step.</div>
        <button class="btn-secondary mt8" onclick="window.teachRevealStep(1)">Show reasoning <span class="arrow">→</span></button>
        <div class="predict-reveal hidden" id="predict-reveal-1">
          <div class="card" style="margin-top:12px">
            <div class="card-label" style="color:var(--accent)">The reasoning</div>
            <div class="teach-step-text">${we.explanation}</div>
          </div>
          ${trapBadge}
        </div>
      </div>
      <div class="predict-block hidden" id="predict-2">
        <div class="predict-prompt">Does the passage confirm, contradict, or stay silent on this?</div>
        <div class="step3-choices mt8">
          <button class="step3-btn" data-choice="confirms"    onclick="window.teachPickStep3('confirms','${correctChoice}')">✓ Confirms it</button>
          <button class="step3-btn" data-choice="contradicts" onclick="window.teachPickStep3('contradicts','${correctChoice}')">✗ Contradicts it</button>
          <button class="step3-btn" data-choice="silent"      onclick="window.teachPickStep3('silent','${correctChoice}')">? Stays silent</button>
        </div>
        <div class="predict-reveal hidden" id="predict-reveal-2">
          <div class="card" style="margin-top:12px;border:2px solid var(--success)">
            <div class="card-label" style="color:var(--success)">✅ Answer: ${answerLabel}</div>
            <div class="teach-step-text" style="font-weight:600">${we.teachingNote || ''}</div>
          </div>
          ${teachNote !== '' ? '' /* already shown above */ : ''}
        </div>
      </div>`;

  // ── STANDARD FORMAT (AI-generated examples — steps[]/conclusion/insight) ──
  } else {
    document.getElementById('teach-steps-container').innerHTML = `
      <div class="predict-block" id="predict-0">
        <div class="predict-prompt">What part of the passage is relevant here?</div>
        <button class="btn-secondary mt8" onclick="window.teachRevealStep(0)">Show me the thinking <span class="arrow">→</span></button>
        <div class="predict-reveal hidden" id="predict-reveal-0">
          <div class="card" style="margin-top:12px">
            <div class="card-label" style="color:var(--accent)">Step 1</div>
            <div class="teach-step-text">${(we.steps || [])[0] || ''}</div>
          </div>
        </div>
      </div>
      <div class="predict-block hidden" id="predict-1">
        <div class="predict-prompt">What is this statement actually claiming?</div>
        <button class="btn-secondary mt8" onclick="window.teachRevealStep(1)">Reveal <span class="arrow">→</span></button>
        <div class="predict-reveal hidden" id="predict-reveal-1">
          <div class="card" style="margin-top:12px">
            <div class="card-label" style="color:var(--accent)">Step 2</div>
            <div class="teach-step-text">${(we.steps || [])[1] || ''}</div>
          </div>
        </div>
      </div>
      <div class="predict-block hidden" id="predict-2">
        <div class="predict-prompt">Does the passage confirm, contradict, or stay silent on this?</div>
        <div class="step3-choices mt8">
          <button class="step3-btn" data-choice="confirms"    onclick="window.teachPickStep3('confirms','${correctChoice}')">✓ Confirms it</button>
          <button class="step3-btn" data-choice="contradicts" onclick="window.teachPickStep3('contradicts','${correctChoice}')">✗ Contradicts it</button>
          <button class="step3-btn" data-choice="silent"      onclick="window.teachPickStep3('silent','${correctChoice}')">? Stays silent</button>
        </div>
        <div class="predict-reveal hidden" id="predict-reveal-2">
          <div class="card" style="margin-top:12px">
            <div class="card-label" style="color:var(--accent)">Step 3</div>
            <div class="teach-step-text">${(we.steps || [])[2] || ''}</div>
          </div>
          <div class="card" style="margin-top:8px;border:2px solid var(--success)">
            <div class="card-label" style="color:var(--success)">✅ Answer</div>
            <div class="teach-step-text" style="font-weight:600">${we.conclusion || ''}</div>
          </div>
        </div>
      </div>`;
  }

  document.getElementById('teach-reinforce').classList.add('hidden');
  document.getElementById('teach-confidence').classList.add('hidden');
  document.getElementById('teach-worked').classList.remove('hidden');
  window.scrollTo(0, 0);
}

window.teachRevealStep = function (stepIdx) {
  document.getElementById(`predict-reveal-${stepIdx}`).classList.remove('hidden');
  // Hide the reveal button after click
  const block = document.getElementById(`predict-${stepIdx}`);
  const btn = block.querySelector('.btn-secondary');
  if (btn) btn.classList.add('hidden');
  // Show next step
  const nextBlock = document.getElementById(`predict-${stepIdx + 1}`);
  if (nextBlock) nextBlock.classList.remove('hidden');
};

window.teachPickStep3 = function (choice, correct) {
  document.querySelectorAll('.step3-btn').forEach(b => {
    b.disabled = true;
    if (b.dataset.choice === correct)  b.classList.add('step3-correct');
    if (b.dataset.choice === choice && choice !== correct) b.classList.add('step3-wrong');
  });
  document.getElementById('predict-reveal-2').classList.remove('hidden');
  // Show per-example insight (AI format uses .insight; hardcoded format uses .teachingNote)
  const examples = teachData.workedExamples || [];
  const we2   = examples[workedExIdx] || {};
  const insight = we2.insight || (we2.explanation ? '' : ''); // rich format inlines note in reveal-2
  if (insight) {
    document.getElementById('teach-ex-insight-text').textContent = insight;
    document.getElementById('teach-ex-insight').classList.remove('hidden');
  }
  document.getElementById('teach-try-btn').classList.remove('hidden');
  window.scrollTo(0, document.body.scrollHeight);
};

window.advanceWorkedExample = function () {
  workedExIdx++;
  renderWorkedExampleAt(workedExIdx);
};

window.startWorkedExamples = function () {
  workedExIdx = 0;
  document.getElementById('teach-reinforce').classList.add('hidden');
  renderWorkedExampleAt(0);
};

// ── REINFORCE PHASE ───────────────────────────────────────────────
window.teachShowReinforce = function () {
  ['teach-hook','teach-concept','teach-worked'].forEach(id =>
    document.getElementById(id)?.classList.add('hidden')
  );
  document.getElementById('teach-reinforce-content').classList.add('hidden');
  document.getElementById('teach-continue-micro-btn').classList.add('hidden');
  document.getElementById('teach-reinforce').classList.remove('hidden');
};

window.teachReinforceHear = function () {
  saveLearningStyleSignal('hear');
  const bullets = Array.isArray(teachData.concept) ? teachData.concept : [];
  const skillLabel2 = getSkillConfig(toSkillId(teachSkillKey)).displayName;
  const text = `Here is how ${skillLabel2} reading works. ${bullets.map(b => b.replace(/\*\*/g, '')).join(' ')}`;
  const contentEl = document.getElementById('teach-reinforce-content');
  contentEl.innerHTML = '<div class="screen-loading" style="min-height:60px"><div class="spinner"></div><p>Generating audio…</p></div>';
  contentEl.classList.remove('hidden');

  fetch(AUDIO_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text })
  }).then(r => r.json()).then(data => {
    if (!data.audio) throw new Error('no audio');
    const blob = base64ToBlob(data.audio, data.mimeType || 'audio/mpeg');
    const url  = URL.createObjectURL(blob);
    const audio = new Audio(url);
    contentEl.innerHTML = `
      <div class="card mt8" style="text-align:center">
        <p style="font-size:13px;color:var(--muted);margin-bottom:12px">Toody is reading the reasoning aloud.</p>
        <button class="btn" id="hear-play-btn" onclick="window.toggleHearAudio()">\u25b6 Play</button>
      </div>`;
    window._hearAudio = audio;
    audio.addEventListener('ended', () => {
      document.getElementById('hear-play-btn').textContent = '\u25b6 Replay';
    });
    document.getElementById('teach-continue-micro-btn').classList.remove('hidden');
  }).catch(() => {
    contentEl.innerHTML = `<div class="card mt8"><p style="font-size:13px;color:var(--muted)">Audio unavailable. Read the steps above to review the reasoning.</p></div>`;
    document.getElementById('teach-continue-micro-btn').classList.remove('hidden');
  });
};

window.toggleHearAudio = function () {
  const audio = window._hearAudio;
  if (!audio) return;
  const btn = document.getElementById('hear-play-btn');
  if (audio.paused) { audio.play(); btn.textContent = '\u23f8 Pause'; }
  else              { audio.pause(); btn.textContent = '\u25b6 Play'; }
};

window.teachReinforceSee = function () {
  saveLearningStyleSignal('see');
  const contentEl = document.getElementById('teach-reinforce-content');
  contentEl.innerHTML = `
    <div class="card mt8">
      <div class="card-label">Decision Tree</div>
      <div class="dtree">
        <div class="dtree-node root">Read the statement</div>
        <div class="dtree-arrow">\u2193</div>
        <div class="dtree-node">Find the relevant part of the passage</div>
        <div class="dtree-arrow">\u2193</div>
        <div class="dtree-row">
          <div class="dtree-branch">
            <div class="dtree-node branch-q">Passage <strong>confirms</strong> it?</div>
            <div class="dtree-arrow">\u2193</div>
            <div class="dtree-node answer true-node"><strong>TRUE</strong></div>
          </div>
          <div class="dtree-branch">
            <div class="dtree-node branch-q">Passage <strong>contradicts</strong> it?</div>
            <div class="dtree-arrow">\u2193</div>
            <div class="dtree-node answer false-node"><strong>FALSE</strong></div>
          </div>
          <div class="dtree-branch">
            <div class="dtree-node branch-q">Passage is <strong>silent</strong>?</div>
            <div class="dtree-arrow">\u2193</div>
            <div class="dtree-node answer ng-node"><strong>NOT GIVEN</strong></div>
          </div>
        </div>
      </div>
    </div>`;
  contentEl.classList.remove('hidden');
  document.getElementById('teach-continue-micro-btn').classList.remove('hidden');
};

window.teachReinforceDrill = function () {
  saveLearningStyleSignal('drill');
  teachDrillIndex   = 0;
  teachDrillCorrect = 0;
  renderDrillQuestion(0);
};

// ── DRILL PHASE ───────────────────────────────────────────────────
window.renderDrillQuestion = function renderDrillQuestion(idx) {
  const qs = teachData.drillQuestions || teachData.confidenceQuestions || [];
  if (idx >= qs.length) {
    // Drill complete — show score then go to confidence builder
    const contentEl = document.getElementById('teach-reinforce-content');
    const _drillAcc = qs.length > 0 ? Math.round((teachDrillCorrect / qs.length) * 100) : 0;
    const _drillMsg = teachDrillCorrect === 0
      ? 'Keep going — this is how you learn.'
      : teachDrillCorrect === qs.length
      ? 'Excellent. You\'ve got this skill.'
      : (teachDrillCorrect === 1 && qs.length === 2)
      ? 'Getting there. One more to go.'
      : (teachDrillCorrect === 2 && qs.length === 2)
      ? 'Nice work. Both correct.'
      : _drillAcc >= 80
      ? 'Strong session.'
      : _drillAcc >= 50
      ? 'Solid. Room to improve.'
      : 'This is where Toody helps most. Let\'s keep going.';
    contentEl.innerHTML = `<div class="card mt8" style="background:var(--success-light);border:1.5px solid var(--success-mid)"><p style="font-size:14px;font-weight:600;color:var(--success-text);text-align:center">${teachDrillCorrect} / ${qs.length} correct. ${_drillMsg}</p><button class="btn-secondary" style="margin-top:10px;display:block;margin-left:auto;margin-right:auto" onclick="renderConfidenceQuestion(0)">Continue →</button></div>`;
    return;
  }
  const q = qs[idx];
  const contentEl = document.getElementById('teach-reinforce-content');
  contentEl.innerHTML = `
    <div class="card mt8" id="drill-card-${idx}">
      <div class="card-label">Quick drill ${idx + 1} of ${qs.length}</div>
      <div class="passage-snippet" style="font-size:13px;font-style:italic;color:var(--muted);margin-bottom:8px">${q.passage}</div>
      <div class="q-text" style="margin-bottom:12px">${q.statement}</div>
      <div class="tfng">
        <button class="tfng-btn" data-dv="True"  onclick="window.answerDrill(${idx},'True')">✓ True</button>
        <button class="tfng-btn" data-dv="False" onclick="window.answerDrill(${idx},'False')">✗ False</button>
        <button class="tfng-btn" data-dv="NG"    onclick="window.answerDrill(${idx},'NG')">? Not Given</button>
      </div>
      <div class="result-flash" id="drill-result-${idx}"></div>
    </div>`;
  contentEl.classList.remove('hidden');
  // Hide NG button for skills that do not use Not Given answers
  const drillCfg  = getSkillConfig(toSkillId(teachSkillKey));
  const drillNgBtn = document.querySelector(`#drill-card-${idx} [data-dv="NG"]`);
  if (drillNgBtn) drillNgBtn.classList.toggle('hidden', !drillCfg.answerButtons.includes('Not Given'));
};

window.answerDrill = function (idx, val) {
  const qs2 = teachData.drillQuestions || teachData.confidenceQuestions || [];
  const q = qs2[idx];
  const isRight = normaliseAnswer(val) === normaliseAnswer(q.answer);
  if (isRight) teachDrillCorrect++;

  document.querySelectorAll(`#drill-card-${idx} .tfng-btn`).forEach(b => {
    b.disabled = true;
    if      (normaliseAnswer(b.dataset.dv) === normaliseAnswer(q.answer)) b.classList.add('correct');
    else if (b.dataset.dv === val && !isRight) b.classList.add('wrong');
  });
  const rf = document.getElementById(`drill-result-${idx}`);
  rf.classList.add('show', isRight ? 'good' : 'bad');
  const qs2b = teachData.drillQuestions || teachData.confidenceQuestions || [];
  const hasNext = idx + 1 < qs2b.length;
  const drillExpl = renderReasoningHtml(q, isRight);
  rf.innerHTML = (isRight ? `✅ Correct. ${drillExpl}` : `❌ Answer: <strong>${q.answer}</strong>. ${drillExpl}`)
    + `<br><button class="btn-secondary" style="margin-top:10px" onclick="renderDrillQuestion(${idx + 1})">${hasNext ? 'Next question →' : 'Continue →'}</button>`;
};

// ── CONFIDENCE BUILDER ────────────────────────────────────────────
window.renderConfidenceQuestion = function renderConfidenceQuestion(idx) {
  confQIdx = idx;
  const qs = teachData.confidenceQuestions || [];
  if (idx >= qs.length) {
    const celebrate = document.getElementById('teach-celebrate');
    celebrate.classList.remove('hidden');
    let startBtn = document.getElementById('teach-start-session-btn');
    if (!startBtn) {
      startBtn = document.createElement('button');
      startBtn.id = 'teach-start-session-btn';
      startBtn.className = 'bc-btn';
      startBtn.style.marginTop = '16px';
      startBtn.innerHTML = 'Start my session <span class="arrow">→</span>';
      celebrate.appendChild(startBtn);
    }
    startBtn.style.display = '';
    startBtn.onclick = () => { startBtn.disabled = true; window.startRealSession(); };
    return;
  }
  const q = qs[idx];
  document.getElementById('teach-conf-counter').textContent = `Question ${idx + 1} of 2`;
  document.getElementById('teach-conf-passage').textContent = q.passage;
  document.getElementById('teach-conf-statement').textContent = q.statement;
  const confCfg = getSkillConfig(toSkillId(teachSkillKey));
  const ngBtn = document.querySelector('#teach-conf-btns [data-mv="NG"]');
  if (ngBtn) ngBtn.classList.toggle('hidden', !confCfg.answerButtons.includes('Not Given'));
  document.querySelectorAll('#teach-conf-btns .tfng-btn').forEach(b => {
    b.disabled = false; b.classList.remove('correct', 'wrong');
  });
  const rf = document.getElementById('teach-conf-result');
  rf.className = 'result-flash'; rf.textContent = '';
  document.getElementById('teach-celebrate').classList.add('hidden');
  document.getElementById('teach-worked').classList.add('hidden');
  document.getElementById('teach-confidence').classList.remove('hidden');
  window.scrollTo(0, 0);
};

window.answerConfidence = function (val) {
  const qs = teachData.confidenceQuestions || [];
  const q = qs[confQIdx];
  if (!q) return;
  const isCorrect = normaliseAnswer(val) === normaliseAnswer(q.answer);
  if (isCorrect) confCorrect++;
  document.querySelectorAll('#teach-conf-btns .tfng-btn').forEach(b => {
    b.disabled = true;
    if (normaliseAnswer(b.dataset.mv) === normaliseAnswer(q.answer)) b.classList.add('correct');
    else if (b.dataset.mv === val && !isCorrect) b.classList.add('wrong');
  });
  const rf = document.getElementById('teach-conf-result');
  rf.classList.add('show', isCorrect ? 'good' : 'bad');
  const isLastConfQ = confQIdx + 1 >= qs.length;
  const confExpl = renderReasoningHtml(q, isCorrect);
  rf.innerHTML = (isCorrect ? `✅ Correct. ${confExpl}` : `❌ The answer is ${q.answer}. ${confExpl}`)
    + (isLastConfQ
        ? ''
        : `<br><button class="btn-secondary" style="margin-top:10px" onclick="renderConfidenceQuestion(${confQIdx + 1})">Next question →</button>`);
  if (isLastConfQ) {
    const bubble = document.getElementById('teach-conf-bubble');
    if (confCorrect === 2 && bubble) bubble.textContent = "You've got the pattern. Now let's see it under real conditions.";
    else if (bubble)                 bubble.textContent = "Good effort — let's see the full session now.";
    const celebrate = document.getElementById('teach-celebrate');
    celebrate.classList.remove('hidden');
    let startBtn = document.getElementById('teach-start-session-btn');
    if (!startBtn) {
      startBtn = document.createElement('button');
      startBtn.id = 'teach-start-session-btn';
      startBtn.className = 'bc-btn';
      startBtn.style.marginTop = '16px';
      startBtn.innerHTML = 'Start my session <span class="arrow">→</span>';
      celebrate.appendChild(startBtn);
    }
    startBtn.style.display = '';
    startBtn.onclick = () => { startBtn.disabled = true; window.startRealSession(); };
  }
};

// ── START REAL SESSION ────────────────────────────────────────────
window.startRealSession = function () {
  const plan = currentPlan || pickNextSkill();
  const label = plan.label || 'Reading';
  const teachingMinutes = teachStartTime ? Math.round((Date.now() - teachStartTime) / 60000) : 0;
  const skillDoneKey = `teachFirstDone_${toSkillId(plan.skill)}`;
  if (studentData) studentData[skillDoneKey] = true;
  if (currentUser) updateStudentDoc(currentUser.uid, { [skillDoneKey]: true }).catch(() => {});
  if (currentUser && teachingMinutes > 0) {
    updateStudentDoc(currentUser.uid, { lastTeachingMinutes: teachingMinutes }).catch(() => {});
  }
  document.getElementById('phase2-skill-name').textContent = label;
  goTo('s-phase2');
  setTimeout(() => launchSkillScreen(plan), 1500);
};
