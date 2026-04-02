// modules/session-writing.js
import { serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { API_URL, SKILL_MANIFEST } from './constants.js';
import {
  studentData, currentUser, setStudentData,
  getIELTSSkills, setIELTSSkillLocal, callAI, buildContextSnippet,
  updateStudentBrain, updateWeakAreas,
} from './state.js';
import { goTo, currentPlan } from './router.js';
import { getSkillConfig, toSkillId, parseAIJson, renderMarkdown, normaliseAnswer } from './utils.js';
import {
  updateStudentDoc, saveSessionDoc, generateAndSaveNarrative, getStudentDoc,
} from './firebase.js';
import { showToast, safeClick, setTipNotebookFn, showSessionTip } from './ui.js';
import { getBehaviourPayload, startSessionTracking } from './session-reading.js';
import { renderNotebookWriting } from './notebook.js';
import { mockMode, mockResults, runMockPhase } from './mock.js';

// ── WRITING SESSION STATE ─────────────────────────────────────────
let writingTaskData = null;
export let writingBandEst  = 0;
export let writingResponse = '';
let _writingChart = null;

// ── WRITING SESSION ───────────────────────────────────────────────
export async function loadWritingSession() {
  const day = studentData?.dayNumber || 6;
  window._submitWritingRunning = false;
  writingTaskData = null;
  writingBandEst  = 0;

  document.getElementById('writing-loading').classList.remove('hidden');
  document.getElementById('writing-prompt-view').classList.add('hidden');
  document.getElementById('writing-evaluating').classList.add('hidden');
  document.getElementById('writing-results-view').classList.add('hidden');
  document.getElementById('writing-p1-dot').className = 'phase-dot';
  goTo('s-writing');

  const isTask1 = currentPlan?.skill !== 'writing.task2';
  const band    = studentData?.targetBand || 6.5;
  const taskNum = isTask1 ? 1 : 2;
  const minWords = isTask1 ? 150 : 250;

  const prompt = {
    system: 'You are an IELTS Writing examiner. Return valid JSON only, no markdown.',
    user: isTask1
      ? `Generate an IELTS Academic Writing Task 1 prompt for a Band ${band} student.
Return ONLY this JSON (no extra fields, no markdown):
{"taskType":"Task 1","title":"[short title]","prompt":"The [chart type] below shows [topic]. Summarise the information by selecting and reporting the main features, and make comparisons where relevant. Write at least 150 words.","dataDescription":"[2-3 sentence plain description of the data for accessibility]","chartData":{"type":"bar","labels":["Label1","Label2","Label3","Label4","Label5"],"datasets":[{"label":"[series name]","data":[10,20,30,40,50]}],"yAxisLabel":"[unit label e.g. Percentage (%)"],"unit":"[unit e.g. %]"}}`
      : `Generate an IELTS Academic Writing Task 2 prompt for a Band ${band} student.
Return ONLY this JSON:
{"taskType":"Task 2","title":"Opinion Essay","prompt":"[Essay question on a current topic]. Write at least 250 words. Give reasons for your answer and include any relevant examples from your own knowledge or experience."}`
  };

  try {
    const raw    = await callAI(prompt);
    writingTaskData = parseAIJson(raw);

    document.getElementById('writing-task-type').textContent = writingTaskData.taskType || `Writing Task ${taskNum}`;
    document.getElementById('writing-task-text').innerHTML   = writingTaskData.prompt || '';
    document.getElementById('writing-target-hint').textContent = `Target: at least ${minWords} words.`;
    if (isTask1) renderWritingChart(writingTaskData);
    document.getElementById('writing-textarea').value = '';
    document.getElementById('writing-word-count').textContent = '0 words';
    document.getElementById('writing-word-count').className   = 'word-count-badge';
    document.getElementById('btn-writing-submit').disabled    = false;

    document.getElementById('writing-loading').classList.add('hidden');
    document.getElementById('writing-prompt-view').classList.remove('hidden');
    startSessionTracking();
  } catch {
    showToast('Having trouble connecting — please check your internet and try again.');
    document.getElementById('writing-loading').innerHTML =
      '<p style="color:var(--danger);padding:20px;text-align:center">Could not load writing task. Please go back and try again.</p>';
  }
}

export function renderWritingChart(taskData) {
  const container = document.getElementById('writing-chart-container');
  container.classList.add('hidden');
  container.innerHTML = '';

  // Destroy any previous Chart.js instance
  if (_writingChart) { _writingChart.destroy(); _writingChart = null; }

  const cd = taskData?.chartData;

  // ── Fallback: styled table ────────────────────────────────────────────────
  if (!cd || !Array.isArray(cd.labels) || !cd.labels.length ||
      !Array.isArray(cd.datasets) || !cd.datasets[0]?.data?.length) {
    const desc = taskData.dataDescription || '';
    if (!desc) return;
    container.innerHTML =
      `<div class="writing-chart-fallback"><p>${desc}</p></div>`;
    container.classList.remove('hidden');
    return;
  }

  // ── Chart.js render ───────────────────────────────────────────────────────
  const type    = ['bar','line','pie'].includes(cd.type) ? cd.type : 'bar';
  const isPie   = type === 'pie';
  const colors  = ['#6557D4','#34A0A4','#F4A261','#E76F51','#2A9D8F',
                   '#E9C46A','#264653','#A8DADC','#457B9D','#1D3557'];
  const ds      = cd.datasets[0];
  const bgColors = isPie
    ? ds.data.map((_, i) => colors[i % colors.length])
    : colors[0];
  const borderColors = isPie
    ? ds.data.map((_, i) => colors[i % colors.length])
    : colors[0];

  const wrap = document.createElement('div');
  wrap.className = 'writing-chart-wrap';
  if (taskData.title) {
    const ttl = document.createElement('div');
    ttl.className = 'writing-chart-title';
    ttl.textContent = taskData.title;
    wrap.appendChild(ttl);
  }
  const canvas = document.createElement('canvas');
  canvas.id = 'writing-chart-canvas';
  wrap.appendChild(canvas);
  container.appendChild(wrap);
  container.classList.remove('hidden');

  _writingChart = new Chart(canvas, {
    type,
    data: {
      labels: cd.labels,
      datasets: [{
        label:           ds.label || '',
        data:            ds.data,
        backgroundColor: bgColors,
        borderColor:     borderColors,
        borderWidth:     isPie ? 1 : 2,
        fill:            false,
        tension:         0.3,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: { display: isPie, position: 'bottom',
          labels: { color: '#333', font: { size: 12 } } },
        tooltip: { callbacks: {
          label: ctx => ` ${ctx.parsed.y ?? ctx.parsed} ${cd.unit || ''}`.trim(),
        }},
      },
      scales: isPie ? {} : {
        x: { ticks: { color: '#555', font: { size: 11 } },
             grid:  { display: false } },
        y: { ticks: { color: '#555', font: { size: 11 } },
             title: { display: !!cd.yAxisLabel, text: cd.yAxisLabel || '',
                      color: '#555', font: { size: 11 } },
             beginAtZero: true },
      },
    },
  });
}

export const updateWordCount = function () {
  const text  = document.getElementById('writing-textarea').value.trim();
  const words = text ? text.split(/\s+/).length : 0;
  const min   = currentPlan?.skill !== 'writing.task2' ? 150 : 250;
  const badge = document.getElementById('writing-word-count');
  badge.textContent = `${words} word${words !== 1 ? 's' : ''}`;
  badge.className   = `word-count-badge ${words >= min ? 'ok' : words >= min * 0.7 ? 'warn' : ''}`;
};
window.updateWordCount = updateWordCount;

export const submitWriting = async function () {
  const btn = document.getElementById('btn-writing-submit');
  btn.disabled = true;
  if (window._submitWritingRunning) return;
  window._submitWritingRunning = true;
  const text = document.getElementById('writing-textarea').value.trim();
  if (!text || text.split(/\s+/).length < 30) {
    window._submitWritingRunning = false;
    document.getElementById('btn-writing-submit').disabled = false;
    showToast('Please write at least a few sentences before submitting.');
    return;
  }
  writingResponse = text;

  document.getElementById('writing-prompt-view').classList.add('hidden');
  document.getElementById('writing-evaluating').classList.remove('hidden');

  const isTask1 = currentPlan?.skill !== 'writing.task2';
  const band   = studentData?.targetBand || 6.5;
  const taskLabel = isTask1 ? 'Task 1 (Graph Description)' : 'Task 2 (Opinion Essay)';

  const prompt = {
    model: 'gpt-4o',
    system: `You are a Cambridge IELTS examiner with 20 years experience. Score this response using ONLY the official Cambridge band descriptors below. Do not invent criteria.

TASK ACHIEVEMENT (25%):
- Band 5: Addresses task only partially. Format may be inappropriate.
- Band 5.5: Addresses task but coverage is not always sufficient
- Band 6: Addresses all parts of the task. Presents relevant main ideas but some may be inadequately developed
- Band 6.5: Addresses all parts of task though some parts more fully than others
- Band 7: Covers all requirements. Presents clear position throughout. Main ideas extended and supported
- Band 8+: Covers all requirements fully. Position is clear throughout. Ideas well developed with relevant examples

COHERENCE AND COHESION (25%):
- Band 5: Some organisation but may lack overall progression. Limited range of cohesive devices
- Band 5.5: Presents information with some organisation but cohesion may be faulty
- Band 6: Arranges information coherently. Uses cohesive devices effectively but may be mechanical
- Band 6.5: Organises information logically. Manages paragraphing well
- Band 7: Logically organises information. Uses a range of cohesive devices appropriately
- Band 8+: Sequences information and ideas logically. Manages all aspects of cohesion skilfully

LEXICAL RESOURCE (25%):
- Band 5: Minimal range. Noticeable errors in spelling/word formation that cause difficulty for reader
- Band 5.5: Uses limited range of vocabulary. Makes noticeable errors in spelling/word formation
- Band 6: Adequate range. Attempts less common vocabulary with some inaccuracy. Some spelling errors
- Band 6.5: Uses sufficient range. Generally paraphrases successfully
- Band 7: Uses sufficient range with flexibility. Uses less common items with awareness of style
- Band 8+: Uses wide range with fluency and flexibility. Skilfully uses uncommon lexical items

GRAMMATICAL RANGE AND ACCURACY (25%):
- Band 5: Limited range of structures. Frequent grammatical errors that may impede communication
- Band 5.5: Uses only a limited range of structures with only rare use of subordinate clauses
- Band 6: Mix of simple and complex structures. Some errors in grammar but meaning is clear
- Band 6.5: Mix of simple and complex structures. Generally error free sentences
- Band 7: Uses a variety of complex structures. Frequent error-free sentences
- Band 8+: Wide range of structures. Majority of sentences are error free

TASK 1 SPECIFIC RULES:
- Missing overview = Band 5.5 ceiling — always check for overview paragraph
- Must report main trends not every detail
- Minimum 150 words — under = penalised one band
- Data accuracy matters — misreporting numbers is penalised

TASK 2 SPECIFIC RULES:
- Must address ALL parts of the question — missing one part = significant penalty
- Minimum 250 words — under = penalised one band
- Position must be clear from introduction — sitting on the fence reduces score
- Mechanical linking (First of all / However / On the other hand at every paragraph) reduces Coherence score
- Examples must support arguments — abstract claims without examples score lower

Return JSON only:
{
  "overallBand": number (nearest 0.5),
  "taskAchievement": number (nearest 0.5),
  "coherenceCohesion": number (nearest 0.5),
  "lexicalResource": number (nearest 0.5),
  "grammaticalRange": number (nearest 0.5),
  "feedback": {
    "strengths": ["strength 1", "strength 2"],
    "improvements": ["improvement 1", "improvement 2", "improvement 3"],
    "keyFocus": "one sentence — the single most important thing to fix"
  },
  "wordCount": number,
  "hasOverview": boolean,
  "addressesAllParts": boolean
}`,
    user: `Evaluate this IELTS Writing ${taskLabel} response for a Band ${band} target student.

TASK PROMPT: ${writingTaskData?.prompt || ''}

STUDENT RESPONSE:
${text}`
  };

  try {
    const raw    = await callAI({ ...prompt, maxTokens: 800 });
    const result = parseAIJson(raw);
    writingBandEst = result.overallBand || 6.0;

    document.getElementById('writing-overall-band').textContent = writingBandEst.toFixed(1);
    document.getElementById('writing-encouragement').innerHTML  = renderMarkdown(result.feedback?.strengths?.[0] || '');
    document.getElementById('wc-ta-band').textContent  = result.taskAchievement?.toFixed(1)   || '—';
    document.getElementById('wc-ta-fb').innerHTML      = renderMarkdown(result.feedback?.improvements?.[0]   || '');
    document.getElementById('wc-cc-band').textContent  = result.coherenceCohesion?.toFixed(1) || '—';
    document.getElementById('wc-cc-fb').innerHTML      = renderMarkdown(result.feedback?.improvements?.[1] || '');
    document.getElementById('wc-lr-band').textContent  = result.lexicalResource?.toFixed(1)   || '—';
    document.getElementById('wc-lr-fb').innerHTML      = renderMarkdown(result.feedback?.improvements?.[2]   || '');
    document.getElementById('wc-gr-band').textContent  = result.grammaticalRange?.toFixed(1)  || '—';
    document.getElementById('wc-gr-fb').innerHTML      = renderMarkdown(result.feedback?.strengths?.[1]  || '');
    document.getElementById('writing-suggestion').innerHTML = renderMarkdown(result.feedback?.keyFocus || '');

    document.getElementById('writing-evaluating').classList.add('hidden');
    document.getElementById('writing-results-view').classList.remove('hidden');
  } catch {
    window._submitWritingRunning = false;
    document.getElementById('btn-writing-submit').disabled = false;
    document.getElementById('writing-evaluating').classList.add('hidden');
    document.getElementById('writing-prompt-view').classList.remove('hidden');
    showToast('Evaluation failed — please try submitting again.');
  }
};
window.submitWriting = submitWriting;

export const finishWritingSession = async function () {
  console.log('finish session called for: writing');
  try {
  const day     = studentData?.dayNumber || 6;
  const isTask1 = currentPlan?.skill !== 'writing.task2';
  const taskKey = isTask1 ? 'task1' : 'task2';
  const behaviour = getBehaviourPayload();

  let _writingSessionRef = null;
  try {
    _writingSessionRef = await saveSessionDoc(currentUser.uid, {
      weekNumber:     studentData.weekNumber || 2,
      dayNumber:      day,
      skillPracticed: `writing.${taskKey}`,
      bandEstimate:   writingBandEst,
      wordCount:      writingResponse.split(/\s+/).length,
      durationMinutes: Math.round(behaviour.sessionDurationSec / 60),
      behaviour
    });

    const writingSkillId = toSkillId(`writing.${taskKey}`);
    const prevW = getIELTSSkills()[writingSkillId] || { bandEstimate: 0, attempted: 0 };
    const wSubjPath = `brain.subjects.ielts-academic.skills.${writingSkillId}`;
    await updateStudentDoc(currentUser.uid, {
      [`${wSubjPath}.bandEstimate`]:  writingBandEst,
      [`${wSubjPath}.attempted`]:     (prevW.attempted || 0) + 1,
      [`${wSubjPath}.lastPracticed`]: serverTimestamp(),
      [`${wSubjPath}.trend`]:         writingBandEst > (prevW.bandEstimate || 0) ? 'up' : writingBandEst < (prevW.bandEstimate || 0) ? 'down' : 'stable',
      dayNumber:    (studentData.dayNumber || 1) + 1,
      recentSkills: [`writing.${taskKey}`, ...(studentData.recentSkills || [])].slice(0, 5),
      streak:       (studentData.streak || 0) + 1,
      lastSession:  serverTimestamp(),
    });

    const snap = await getStudentDoc(currentUser.uid);
    setStudentData(snap.data());
    await updateWeakAreas(`writing.${taskKey}`, null);
  } catch { /* still show notebook */ }

  if (_writingSessionRef) generateAndSaveNarrative(currentUser.uid, _writingSessionRef, {
    skill: `writing.${taskKey}`, day, bandEstimate: writingBandEst,
    wordCount: writingResponse.split(/\s+/).length,
  });

  if (mockMode) {
    mockResults.writing = { band: writingBandEst };
    runMockPhase(3);
    return;
  }

  setTipNotebookFn(() => {
    document.getElementById('nb-day-badge').textContent = `Session ${day}`;
    goTo('s-notebook');
    renderNotebookWriting();
  });
  showSessionTip({ accuracy: Math.round(writingBandEst * 10), behaviour: getBehaviourPayload(), missedSubTypes: {}, skillKey: 'writing' });
  } catch(err) {
    console.error('finishSession error:', err);
    showToast('Something went wrong — please try again', 'error');
    const finishBtn = document.querySelector('[onclick*="finish"], .btn-finish, #btn-finish');
    if (finishBtn) finishBtn.disabled = false;
  }
};
window.finishWritingSession = finishWritingSession;
