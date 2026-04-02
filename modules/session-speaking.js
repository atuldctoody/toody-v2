// modules/session-speaking.js
import { serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { API_URL, TRANSCRIBE_URL, SKILL_MANIFEST } from './constants.js';
import {
  studentData, currentUser, setStudentData,
  getIELTSSkills, setIELTSSkillLocal, callAI, buildContextSnippet,
  updateStudentBrain, updateWeakAreas,
} from './state.js';
import { goTo, currentPlan } from './router.js';
import { getSkillConfig, parseAIJson, renderMarkdown, normaliseAnswer, withRetry } from './utils.js';
import {
  updateStudentDoc, saveSessionDoc, generateAndSaveNarrative, getStudentDoc,
} from './firebase.js';
import { showToast, safeClick, setTipNotebookFn, showSessionTip } from './ui.js';
import { getBehaviourPayload, startSessionTracking } from './session-reading.js';
import { renderNotebookSpeaking } from './notebook.js';
import { mockMode, mockPhase, mockResults, showMockResults } from './mock.js';

// ── SPEAKING SESSION STATE ────────────────────────────────────────
let speakingQs          = [];
let speakingTranscript  = '';
export let speakingBandEst     = 0;
export let mediaRecorder       = null;
let audioChunks         = [];
let recordTimerInterval = null;
export let recordSeconds       = 0;

// ── SPEAKING SESSION ──────────────────────────────────────────────
export async function loadSpeakingSession() {
  const day = studentData?.dayNumber || 8;
  speakingQs         = [];
  speakingTranscript = '';
  speakingBandEst    = 0;
  audioChunks        = [];
  recordSeconds      = 0;

  document.getElementById('speaking-loading').classList.remove('hidden');
  document.getElementById('speaking-prompt-view').classList.add('hidden');
  document.getElementById('speaking-evaluating').classList.add('hidden');
  document.getElementById('speaking-results-view').classList.add('hidden');
  document.getElementById('speaking-p1-dot').className = 'phase-dot';
  document.getElementById('record-ready').classList.remove('hidden');
  document.getElementById('record-active').classList.add('hidden');
  document.getElementById('record-processing').classList.add('hidden');
  goTo('s-speaking');

  const band = studentData?.targetBand || 6.5;
  const isMock = mockMode && mockPhase === 3;
  const partLabel = isMock ? 'Part 2 — Cue Card' : 'Part 1 — Personal Questions';

  let promptUser;
  if (isMock) {
    promptUser = `Generate an IELTS Speaking Part 2 cue card for a Band ${band} student.
Return ONLY this JSON:
{"topicLabel":"Part 2 — Cue Card","questions":["Describe [topic]. You should say:","- [point 1]","- [point 2]","- [point 3]","and explain [final point]."]}`;
  } else {
    promptUser = `Generate 4 IELTS Speaking Part 1 personal questions for a Band ${band} student on a single topic (e.g. hometown, hobbies, daily routine).
Return ONLY this JSON:
{"topicLabel":"Part 1 — [Topic Name]","questions":["question 1?","question 2?","question 3?","question 4?"]}`;
  }

  const prompt = {
    system: 'You are an IELTS Speaking examiner. Return valid JSON only, no markdown.',
    user: promptUser
  };

  try {
    const raw    = await callAI(prompt);
    const parsed = parseAIJson(raw);
    speakingQs   = parsed.questions || [];

    document.getElementById('speaking-topic-label').textContent = parsed.topicLabel || partLabel;
    document.getElementById('speaking-questions').innerHTML = speakingQs.map((q, i) =>
      `<div class="speaking-q-item"><div class="speaking-q-num">${i + 1}</div><div>${q}</div></div>`
    ).join('');

    document.getElementById('speaking-loading').classList.add('hidden');
    document.getElementById('speaking-prompt-view').classList.remove('hidden');
    startSessionTracking();
  } catch {
    showToast('Having trouble connecting — please check your internet and try again.');
    document.getElementById('speaking-loading').innerHTML =
      '<p style="color:var(--danger);padding:20px;text-align:center">Could not load speaking questions. Please go back and try again.</p>';
  }
}

export const startRecording = async function () {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };
    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      clearInterval(recordTimerInterval);
      const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      document.getElementById('record-active').classList.add('hidden');
      document.getElementById('record-processing').classList.remove('hidden');
      await transcribeAudio(blob);
    };
    mediaRecorder.start(1000);

    recordSeconds = 0;
    document.getElementById('record-timer').textContent = '0:00';
    recordTimerInterval = setInterval(() => {
      recordSeconds++;
      const m = Math.floor(recordSeconds / 60);
      const s = String(recordSeconds % 60).padStart(2, '0');
      document.getElementById('record-timer').textContent = `${m}:${s}`;
      // Auto-stop at 3 minutes
      if (recordSeconds >= 180) window.stopRecording();
    }, 1000);

    document.getElementById('record-ready').classList.add('hidden');
    document.getElementById('record-active').classList.remove('hidden');
  } catch {
    showToast('Microphone access is required. Please allow it and try again.');
  }
};
window.startRecording = startRecording;

export const stopRecording = function () {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
  }
};
window.stopRecording = stopRecording;

export async function transcribeAudio(blob) {
  try {
    const arrayBuffer = await blob.arrayBuffer();
    const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));

    const data = await withRetry(async () => {
      const res = await fetch(TRANSCRIBE_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ audio: base64, mimeType: blob.type || 'audio/webm' })
      });
      if (!res.ok) throw new Error('Transcription failed');
      return res.json();
    });
    speakingTranscript = data.text || '';

    document.getElementById('record-processing').classList.add('hidden');
    await evaluateSpeaking(speakingTranscript);
  } catch {
    showToast('Having trouble connecting — please check your internet and try again.');
    document.getElementById('record-processing').innerHTML =
      '<p style="color:var(--danger);padding:20px;text-align:center">Transcription failed. Please try again.</p>';
  }
}

export async function evaluateSpeaking(transcript) {
  document.getElementById('speaking-prompt-view').classList.add('hidden');
  document.getElementById('speaking-evaluating').classList.remove('hidden');

  const band     = studentData?.targetBand || 6.5;
  const questions = speakingQs.join('\n');

  const prompt = {
    model: 'gpt-4o',
    system: `You are a Cambridge IELTS examiner. Score this Speaking response using ONLY the official Cambridge band descriptors below.

FLUENCY AND COHERENCE (25%):
- Band 5: Usually maintains flow but uses repetition and self-correction. Over-relies on slow speech
- Band 5.5: Maintains flow but uses repetition and self-correction more than Band 6
- Band 6: Willing to speak at length. Repetition and self-correction reduce coherence
- Band 6.5: Speaks at length without noticeable effort. Some hesitation but maintains coherence
- Band 7: Speaks at length without noticeable effort. Logical sequencing. Some hesitation acceptable
- Band 8+: Speaks fluently with only rare repetition. Develops topics coherently and appropriately

LEXICAL RESOURCE (25%):
- Band 5: Manages to talk about familiar topics. Uses basic vocabulary with some inappropriate choices
- Band 5.5: Adequate for familiar topics. Attempts paraphrasing but not always successfully
- Band 6: Adequate vocabulary for familiar topics. Some attempts at less common items
- Band 6.5: Uses vocabulary with flexibility. Uses less common items with some awareness of style
- Band 7: Uses vocabulary with flexibility. Uses less common items with some awareness of collocation
- Band 8+: Uses a wide vocabulary resource. Uses idiomatic language naturally and accurately

GRAMMATICAL RANGE AND ACCURACY (25%):
- Band 5: Basic sentence forms with reasonable accuracy. Limited range of complex structures
- Band 5.5: Basic sentence forms with reasonable accuracy. Some complex structures attempted
- Band 6: Mix of simple and complex structures. Errors occur but rarely impede communication
- Band 6.5: Mix of simple and complex structures. Generally error-free sentences
- Band 7: Uses a variety of complex structures. Frequent error-free sentences
- Band 8+: Wide range of structures. Majority of sentences are error free. Only minor mistakes

PRONUNCIATION (25%):
- Band 5: Generally intelligible. Mispronunciation of individual sounds causes occasional difficulty
- Band 5.5: Generally intelligible. Mispronunciation does not cause major problems
- Band 6: Generally intelligible throughout. Some features of L1 accent evident
- Band 6.5: Easy to understand throughout. L1 accent has minimal effect
- Band 7: Easy to understand throughout. Uses a range of phonological features
- Band 8+: Easy to understand throughout. Uses a full range of phonological features

INDIAN STUDENT SPECIFIC PATTERNS TO WATCH FOR:
- Retroflex consonants (t/d sounds) — note if causing intelligibility issues
- Rising intonation at sentence ends — note if affecting communication
- Filler overuse (basically, actually, only) — note if reducing fluency score
- Direct translation structures from Hindi — note if affecting grammatical range

Return JSON only:
{
  "overallBand": number (nearest 0.5),
  "fluencyCoherence": number (nearest 0.5),
  "lexicalResource": number (nearest 0.5),
  "grammaticalRange": number (nearest 0.5),
  "pronunciation": number (nearest 0.5),
  "feedback": {
    "strengths": ["strength 1", "strength 2"],
    "improvements": ["improvement 1", "improvement 2", "improvement 3"],
    "keyFocus": "the single most important thing to fix",
    "indianStudentNote": "specific pattern noticed if any, empty string if none"
  },
  "wordCount": number,
  "speakingTime": number
}`,
    user: `Evaluate this IELTS Speaking response for a Band ${band} target student.

QUESTIONS ASKED:
${questions}

STUDENT TRANSCRIPT:
${transcript || '[No speech detected]'}`
  };

  try {
    const raw    = await callAI({ ...prompt, maxTokens: 800 });
    const result = parseAIJson(raw);
    speakingBandEst = result.overallBand || 6.0;

    document.getElementById('speaking-transcript-text').textContent = transcript || '[No transcript available]';
    document.getElementById('speaking-overall-band').textContent    = speakingBandEst.toFixed(1);
    document.getElementById('sc-fc-band').textContent = result.fluencyCoherence?.toFixed(1) || '—';
    document.getElementById('sc-fc-fb').innerHTML     = renderMarkdown(result.feedback?.improvements?.[0] || '');
    document.getElementById('sc-lr-band').textContent = result.lexicalResource?.toFixed(1)  || '—';
    document.getElementById('sc-lr-fb').innerHTML     = renderMarkdown(result.feedback?.improvements?.[1]  || '');
    document.getElementById('sc-gr-band').textContent = result.grammaticalRange?.toFixed(1) || '—';
    document.getElementById('sc-gr-fb').innerHTML     = renderMarkdown(result.feedback?.improvements?.[2] || '');
    document.getElementById('sc-pr-band').textContent = result.pronunciation?.toFixed(1)    || '—';
    document.getElementById('sc-pr-fb').innerHTML     = renderMarkdown(result.feedback?.indianStudentNote || result.feedback?.strengths?.[0] || '');
    document.getElementById('speaking-suggestion').innerHTML = renderMarkdown(result.feedback?.keyFocus || '');

    document.getElementById('speaking-evaluating').classList.add('hidden');
    document.getElementById('speaking-results-view').classList.remove('hidden');
  } catch {
    showToast('Having trouble connecting — please check your internet and try again.');
    document.getElementById('speaking-evaluating').innerHTML =
      '<p style="color:var(--danger);padding:20px;text-align:center">Evaluation failed. Please go back and try again.</p>';
  }
}

export const finishSpeakingSession = async function () {
  console.log('finish session called for: speaking');
  if (window._finishSpeakingRunning) return;
  window._finishSpeakingRunning = true;
  const speakFinishBtn = document.getElementById('speaking-finish-btn');
  if (speakFinishBtn) speakFinishBtn.disabled = true;
  try {
  const day       = studentData?.dayNumber || 8;
  const behaviour = getBehaviourPayload();
  // For speaking, override durationSec with actual recording time
  behaviour.sessionDurationSec = Math.max(behaviour.sessionDurationSec, recordSeconds);

  let _speakSessionRef = null;
  try {
    _speakSessionRef = await saveSessionDoc(currentUser.uid, {
      weekNumber:     studentData.weekNumber || 2,
      dayNumber:      day,
      skillPracticed: 'speaking.part1',
      bandEstimate:   speakingBandEst,
      transcript:     speakingTranscript,
      durationMinutes: Math.round(behaviour.sessionDurationSec / 60),
      behaviour
    });

    const speakSkillId = 'speaking-part1';
    const prevSp = getIELTSSkills()[speakSkillId] || { bandEstimate: 0, attempted: 0 };
    const spSubjPath = `brain.subjects.ielts-academic.skills.${speakSkillId}`;
    await updateStudentDoc(currentUser.uid, {
      [`${spSubjPath}.bandEstimate`]:  speakingBandEst,
      [`${spSubjPath}.attempted`]:     (prevSp.attempted || 0) + 1,
      [`${spSubjPath}.lastPracticed`]: serverTimestamp(),
      [`${spSubjPath}.trend`]:         speakingBandEst > (prevSp.bandEstimate || 0) ? 'up' : speakingBandEst < (prevSp.bandEstimate || 0) ? 'down' : 'stable',
      dayNumber:    (studentData.dayNumber || 1) + 1,
      recentSkills: ['speaking.part1', ...(studentData.recentSkills || [])].slice(0, 5),
      streak:       (studentData.streak || 0) + 1,
      lastSession:  serverTimestamp(),
    });

    const snap = await getStudentDoc(currentUser.uid);
    setStudentData(snap.data());
    await updateWeakAreas('speaking.part1', null);
  } catch { /* still show notebook */ }

  if (_speakSessionRef) generateAndSaveNarrative(currentUser.uid, _speakSessionRef, {
    skill: 'speaking.part1', day, bandEstimate: speakingBandEst,
    transcriptLength: speakingTranscript?.length || 0,
  });

  if (mockMode) {
    mockResults.speaking = { band: speakingBandEst };
    showMockResults();
    return;
  }

  setTipNotebookFn(() => {
    document.getElementById('nb-day-badge').textContent = `Session ${day}`;
    goTo('s-notebook');
    renderNotebookSpeaking();
  });
  showSessionTip({ accuracy: Math.round(speakingBandEst * 10), behaviour: getBehaviourPayload(), missedSubTypes: {}, skillKey: 'speaking' });
  } catch(err) {
    console.error('finishSession error:', err);
    showToast('Something went wrong — please try again', 'error');
    window._finishSpeakingRunning = false;
    if (speakFinishBtn) speakFinishBtn.disabled = false;
  }
};
window.finishSpeakingSession = finishSpeakingSession;
