// modules/session-listening.js
// Listening session: audio player, MC/FC question flow, Tough Love, finish.
//
// Structural adaptation: tipNotebookFn = ... replaced with setTipNotebookFn(...)
//   (identical logic; necessary for module split — see modules/ui.js).
//
// Forward references resolved: mockMode, mockResults, runMockPhase ← modules/mock.js

import {
  serverTimestamp, getDocs, query, collection, where, orderBy, limit, updateDoc, increment,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { API_URL, AUDIO_URL, SKILL_MANIFEST } from './constants.js';
import {
  studentData, setStudentData, currentUser,
  getIELTSSkills, setIELTSSkillLocal, callAI, buildContextSnippet,
  updateStudentBrain, updateWeakAreas,
} from './state.js';
import { goTo, currentPlan } from './router.js';
import {
  getSkillConfig, parseAIJson, renderMarkdown, normaliseAnswer,
  base64ToBlob, toSkillId, withRetry,
} from './utils.js';
import { updateStudentDoc, saveSessionDoc, generateAndSaveNarrative, getStudentDoc, db } from './firebase.js';
import { showToast, safeClick, showSessionTip, setTipNotebookFn } from './ui.js';
import {
  startSessionTracking, trackQStart, trackQAnswer, trackAnswerChange,
  getBehaviourPayload, computeConfidenceMetrics,
  warmupCorrect, bhvPrevFCValues, bhvQChangedAnswer,
} from './session-reading.js';
import { mockMode, mockResults, runMockPhase } from './mock.js';

// ── LISTENING SESSION STATE ───────────────────────────────────────
export let listenQuestions = [];
let listenScenario  = '';
export let listenAnswers   = {};
let listenType      = 'mc';   // 'mc' | 'fc'
let listenCorrect   = 0;
let listenAudioEl   = null;   // Audio element for ElevenLabs playback
let listenHasPlayed = false;  // Whether student has pressed play at least once
let listenFromBank  = false;  // Whether session was served from questionBank
export function setListenType(val)    { listenType    = val; }
export function setListenCorrect(val) { listenCorrect = val; }

// ── BANK QUERY ─────────────────────────────────────────────────────
async function getListeningFromBank(collectionName, targetBand) {
  const band       = Math.round(targetBand * 2) / 2;
  const bandsToTry = [band, band - 0.5, band + 0.5].filter(b => b >= 5.0 && b <= 8.0);
  const recentIds  = studentData?.brain?.recentQuestionBankIds || [];

  for (const b of bandsToTry) {
    const snapshot = await getDocs(
      query(
        collection(db, collectionName),
        where('band', '==', b),
        where('status', '==', 'active'),
        orderBy('servedCount', 'asc'),
        limit(5)
      )
    );
    if (snapshot.empty) continue;
    const candidates = snapshot.docs.filter(d => !recentIds.includes(d.id));
    if (candidates.length === 0) continue;
    const picked = candidates[Math.floor(Math.random() * candidates.length)];
    updateDoc(picked.ref, { servedCount: increment(1), lastServedAt: serverTimestamp() }).catch(() => {});
    return { id: picked.id, ...picked.data() };
  }
  return null;
}

// ── LOAD LISTENING SESSION ────────────────────────────────────────
export async function loadListeningSession() {
  const day = studentData?.dayNumber || 2;
  listenType = currentPlan?.skill === 'listening.formCompletion' ? 'fc' : 'mc';
  listenQuestions  = [];
  listenScenario   = '';
  listenAnswers    = {};
  listenCorrect    = 0;
  listenHasPlayed  = false;
  listenFromBank   = false;
  if (listenAudioEl) { listenAudioEl.pause(); listenAudioEl = null; }

  document.getElementById('listening-loading').classList.remove('hidden');
  document.getElementById('listening-content').classList.add('hidden');
  document.getElementById('listening-results').classList.add('hidden');
  document.getElementById('listening-questions-gate').classList.add('hidden');

  document.getElementById('listening-p1-dot').className = 'phase-dot';
  goTo('s-listening');

  const band = studentData?.targetBand || 6.5;

  // Helper — renders question HTML into DOM (shared between bank and AI paths)
  function renderListeningQuestions(type, questions, formTitle) {
    if (type === 'mc') {
      document.getElementById('listening-q-label').textContent = 'Questions — Multiple Choice';
      document.getElementById('listening-questions').innerHTML = questions.map(q => `
        <div class="q-block" id="lqb${q.id}">
          <div class="q-num">${q.id}</div>
          <div class="q-text">${q.text}</div>
          <div class="mc-options" id="mc${q.id}">
            ${q.options.map(opt => {
              const letter = opt.charAt(0);
              return `<button class="mc-option" data-action="answer-mc" data-q="${q.id}" data-v="${letter}">${opt}</button>`;
            }).join('')}
          </div>
        </div>
      `).join('');
    } else {
      document.getElementById('listening-q-label').textContent = formTitle || 'Form Completion';
      document.getElementById('listening-questions').innerHTML = `
        <p style="font-size:12px;color:var(--muted);margin-bottom:12px">Complete the form. Write no more than <strong>three words</strong> for each answer.</p>
        ${questions.map(q => `
          <div class="fc-field" id="lqb${q.id}">
            <label class="fc-label">${q.id}. ${q.label}</label>
            <input class="fc-input" id="fc${q.id}" type="text" placeholder="${q.hint || 'your answer'}" oninput="checkFCProgress()" />
          </div>
        `).join('')}`;
    }
  }

  try {
    // ── BANK PATH — try pre-built questions first ─────────────────
    let bankSet = null;
    try {
      const collName = listenType === 'mc' ? 'questionBank-listening-mc' : 'questionBank-listening-form';
      bankSet = await getListeningFromBank(collName, studentData?.currentBand || 6.0);
    } catch { /* non-fatal — fall through to AI */ }

    if (bankSet) {
      listenScenario  = bankSet.transcript || bankSet.passage || bankSet.scenario || '';
      listenQuestions = bankSet.questions || [];
      listenFromBank  = true;

      renderListeningQuestions(listenType, listenQuestions, bankSet.formTitle);

      document.getElementById('listening-loading').classList.add('hidden');
      document.getElementById('listening-content').classList.remove('hidden');
      startSessionTracking();
      trackQStart(1);

      if (bankSet.audioUrl) {
        // Pre-generated audio from batch script — show exam-condition warning
        const hint = document.getElementById('audio-hint-text');
        if (hint) hint.textContent = 'You will hear this passage ONCE — just like the real exam.';
        setupAudioPlayer(bankSet.audioUrl);
      } else {
        // Bank question not yet voiced — show text fallback (no on-demand ElevenLabs)
        showTextFallback();
      }
      return;
    }

    // ── AI PATH — generate content ────────────────────────────────
    let prompt;
    if (listenType === 'mc') {
      prompt = {
        system: 'You are an IELTS examiner. Generate listening exercises. Return valid JSON only, no markdown.',
        user: `Create an IELTS Listening Multiple Choice exercise for a Band ${band} student.
"transcript" must be the ACTUAL spoken words a student would hear — write it as natural speech (4-6 sentences of a real conversation, monologue, or announcement). The questions must be answerable from the transcript.
Return ONLY this JSON:
{
  "transcript": "The actual spoken words — written as natural human speech, not a description. 4-6 sentences.",
  "questions": [
    {"id":1,"text":"question","options":["A. option","B. option","C. option"],"answer":"A","explanation":"why"},
    {"id":2,"text":"question","options":["A. option","B. option","C. option"],"answer":"B","explanation":"why"},
    {"id":3,"text":"question","options":["A. option","B. option","C. option"],"answer":"C","explanation":"why"},
    {"id":4,"text":"question","options":["A. option","B. option","C. option"],"answer":"A","explanation":"why"},
    {"id":5,"text":"question","options":["A. option","B. option","C. option"],"answer":"B","explanation":"why"}
  ]
}`
      };
    } else {
      prompt = {
        system: 'You are an IELTS examiner. Generate listening exercises. Return valid JSON only, no markdown.',
        user: `Create an IELTS Listening Form Completion exercise for a Band ${band} student.
"transcript" must be the ACTUAL spoken words of the phone call or interview — write it as natural speech (4-6 sentences). Include the answers embedded naturally in the spoken text.
Return ONLY this JSON:
{
  "transcript": "The actual spoken words of the interaction — written as natural human speech, not a description.",
  "formTitle": "title of the form being completed",
  "questions": [
    {"id":1,"label":"Name","answer":"exact answer spoken in transcript","hint":"first name only"},
    {"id":2,"label":"Phone number","answer":"exact answer","hint":"10 digits"},
    {"id":3,"label":"Date","answer":"exact answer","hint":"day and month"},
    {"id":4,"label":"Reason for contact","answer":"exact answer","hint":"one word or short phrase"},
    {"id":5,"label":"Preferred time","answer":"exact answer","hint":"morning or afternoon"}
  ]
}`
      };
    }

    const raw    = await callAI(prompt);
    const parsed = parseAIJson(raw);
    listenScenario  = parsed.transcript || parsed.scenario || '';
    listenQuestions = parsed.questions;

    renderListeningQuestions(listenType, listenQuestions, parsed.formTitle);

    document.getElementById('listening-loading').classList.add('hidden');
    document.getElementById('listening-content').classList.remove('hidden');
    startSessionTracking();
    trackQStart(1);

    // No on-demand ElevenLabs — show text fallback until pre-generated audio is in the bank
    showTextFallback();

  } catch {
    showToast('Having trouble connecting — please check your internet and try again.');
    document.getElementById('listening-loading').innerHTML =
      '<p style="color:var(--danger);padding:20px;text-align:center">Could not load listening scenario. Please go back and try again.</p>';
  }
}
window.loadListeningSession = loadListeningSession;

// ── LISTENING AUDIO ────────────────────────────────────────────────
// Shows the transcript as readable text and reveals questions immediately.
// Used when no pre-generated audioUrl exists on the bank question.
function showTextFallback() {
  document.getElementById('audio-hint-text').textContent = 'Read this passage carefully before answering.';
  document.getElementById('listening-audio-wrap').insertAdjacentHTML('afterend',
    `<div class="passage-wrap" style="margin-top:0">
       <div class="passage-label">Passage</div>
       <div class="passage-text">${listenScenario.split('\n').filter(p=>p.trim()).map(p=>`<p>${p}</p>`).join('')}</div>
     </div>`);
  showListeningQuestionsGate();
}

export async function fetchListeningAudio(text) {
  try {
    const data = await withRetry(async () => {
      const res = await fetch(AUDIO_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ text })
      });
      if (!res.ok) throw new Error('Audio fetch failed');
      const json = await res.json();
      if (!json.audio) throw new Error('No audio in response');
      return json;
    });
    const blob = base64ToBlob(data.audio, data.mimeType || 'audio/mpeg');
    const url  = URL.createObjectURL(blob);
    setupAudioPlayer(url);
  } catch {
    showToast('Having trouble connecting — please check your internet and try again.');
    // Graceful fallback: show passage text so student can still answer
    document.getElementById('audio-hint-text').textContent = 'Audio unavailable. Read the passage carefully and answer the questions.';
    document.getElementById('listening-audio-wrap').insertAdjacentHTML('afterend',
      `<div class="passage-wrap" style="margin-top:0">
         <div class="passage-label">Passage (Text Fallback)</div>
         <div class="passage-text">${listenScenario.split('\n').filter(p=>p.trim()).map(p=>`<p>${p}</p>`).join('')}</div>
       </div>`);
    showListeningQuestionsGate();
  }
}

export function setupAudioPlayer(url) {
  if (listenAudioEl) { listenAudioEl.pause(); }

  // Use a DOM audio element so event delegation can find it via getElementById
  const existing = document.getElementById('listening-audio');
  if (existing) existing.remove();
  const audioEl = document.createElement('audio');
  audioEl.id            = 'listening-audio';
  audioEl.src           = url;
  audioEl.preload       = 'auto';
  audioEl.style.display = 'none';
  document.getElementById('listening-audio-wrap')?.appendChild(audioEl);
  listenAudioEl = audioEl;

  listenAudioEl.addEventListener('timeupdate', updateAudioProgress);
  listenAudioEl.addEventListener('ended', () => {
    const btn  = document.getElementById('audio-play-btn');
    const hint = document.getElementById('audio-hint-text');
    if (btn)  { btn.textContent = '▶'; btn.disabled = false; }
    if (hint && !listenFromBank) hint.textContent = 'Play again below if needed.';
    showListeningQuestionsGate();
  });
  listenAudioEl.addEventListener('error', () => showListeningQuestionsGate());

  const btn  = document.getElementById('audio-play-btn');
  if (btn) { btn.disabled = false; btn.textContent = '▶'; }
  // Hint text is set by the caller for bank questions; only set default for ElevenLabs path
  const hint = document.getElementById('audio-hint-text');
  if (hint && hint.textContent === 'Loading audio…') {
    hint.textContent = 'Press ▶ to listen before answering.';
  }
}

export function updateAudioProgress() {
  if (!listenAudioEl || !listenAudioEl.duration) return;
  const pct  = (listenAudioEl.currentTime / listenAudioEl.duration) * 100;
  const fill = document.getElementById('audio-progress-fill');
  const time = document.getElementById('audio-time');
  if (fill) fill.style.width = pct + '%';
  if (time) {
    const secs = Math.floor(listenAudioEl.currentTime);
    time.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  }
}

window.toggleAudio = function () {
  if (!listenAudioEl) return;
  const btn = document.getElementById('audio-play-btn');
  if (listenAudioEl.paused) {
    listenAudioEl.play();
    if (btn) btn.textContent = '⏸';
    if (!listenHasPlayed) {
      listenHasPlayed = true;
      // Reveal questions 1 second after first play
      setTimeout(showListeningQuestionsGate, 1000);
    }
  } else {
    listenAudioEl.pause();
    if (btn) btn.textContent = '▶';
  }
};

window.replayAudio = function () {
  if (!listenAudioEl) return;
  listenAudioEl.currentTime = 0;
  listenAudioEl.play();
  const btn = document.getElementById('audio-play-btn');
  if (btn) btn.textContent = '⏸';
};

window.seekAudio = function (e) {
  if (!listenAudioEl || !listenAudioEl.duration) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const pct  = (e.clientX - rect.left) / rect.width;
  listenAudioEl.currentTime = pct * listenAudioEl.duration;
};

export function showListeningQuestionsGate() {
  const gate = document.getElementById('listening-questions-gate');
  const hint = document.getElementById('audio-hint-text');
  if (gate) gate.classList.remove('hidden');
  if (hint && listenHasPlayed) hint.textContent = 'You can replay the audio at any time.';
}

function answerListeningMC(qnum, val) {
  if (listenAnswers[qnum]) return;
  trackQAnswer(qnum);
  trackQStart(qnum + 1);
  listenAnswers[qnum] = val;

  document.querySelectorAll(`#mc${qnum} .mc-option`).forEach(b => {
    b.disabled = true;
    b.classList.toggle('selected', b.dataset.v === val);
  });

  if (Object.keys(listenAnswers).length >= listenQuestions.length) {
    document.getElementById('btn-listening-submit').disabled = false;
  }
}
window.answerMC = answerListeningMC;  // keep global alias for any legacy callers

window.checkFCProgress = function () {
  const allFilled = listenQuestions.every(q => {
    const el = document.getElementById(`fc${q.id}`);
    if (!el) return false;
    const val = el.value.trim();
    // Track if student changed a previously entered answer
    if (val.length > 0 && bhvPrevFCValues[q.id] && bhvPrevFCValues[q.id] !== val) {
      trackAnswerChange();
      bhvQChangedAnswer[q.id] = true;
    }
    if (val.length > 0) bhvPrevFCValues[q.id] = val;
    return val.length > 0;
  });
  document.getElementById('btn-listening-submit').disabled = !allFilled;
};

window.submitListening = function () {
  if (window._submitListeningRunning) return;
  window._submitListeningRunning = true;
  listenCorrect = 0;
  let resultsHtml = '';

  listenQuestions.forEach(q => {
    let userAns, isRight;

    if (listenType === 'mc') {
      userAns = listenAnswers[q.id] || '—';
      isRight = normaliseAnswer(userAns) === normaliseAnswer(q.answer);
    } else {
      const el = document.getElementById(`fc${q.id}`);
      userAns  = el ? el.value.trim() : '';
      isRight  = normaliseAnswer(userAns) === normaliseAnswer(q.answer);
      // Lock the input
      if (el) { el.disabled = true; el.classList.add(isRight ? 'fc-correct' : 'fc-wrong'); }
    }

    if (isRight) listenCorrect++;
    listenAnswers[q.id] = userAns;

    resultsHtml += `
      <div style="padding:10px 0;border-bottom:1px solid var(--border);">
        <div style="font-size:13px;font-weight:400;margin-bottom:4px">${q.id}. ${q.text || q.label}</div>
        <div style="font-size:12px;color:${isRight ? 'var(--success)' : 'var(--danger)'}">
          ${isRight ? '✅' : '❌'} Your answer: <strong>${userAns}</strong>
          ${!isRight ? ` — Correct: <strong>${q.answer}</strong>` : ''}
        </div>
        <div style="font-size:12px;color:var(--muted);margin-top:3px">${renderMarkdown(q.explanation || '')}</div>
      </div>`;
  });

  document.getElementById('btn-listening-submit').classList.add('hidden');
  const resultsEl = document.getElementById('listening-results');
  document.getElementById('listening-results-body').innerHTML = resultsHtml;
  resultsEl.classList.remove('hidden');

  // Scroll to results
  resultsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

export async function finishListeningSession() {
  console.log('finish session called for: listening');
  if (window._finishListeningRunning) return;
  window._finishListeningRunning = true;
  const listenFinishBtn = document.getElementById('listening-finish-btn');
  if (listenFinishBtn) listenFinishBtn.disabled = true;
  try {
  if (listenAudioEl) { listenAudioEl.pause(); listenAudioEl = null; }
  const total     = listenQuestions.length || 5;
  const accuracy  = Math.round((listenCorrect / total) * 100);
  const day       = studentData.dayNumber || 2;
  const listenSkillSuffix = listenType === 'mc' ? 'multipleChoice' : 'formCompletion';
  const firestoreKey      = `listening.${listenSkillSuffix}`;
  const listenSkillId     = toSkillId(firestoreKey);
  const behaviour = getBehaviourPayload();

  let _listenSessionRef = null;
  try {
    _listenSessionRef = await saveSessionDoc(currentUser.uid, {
      weekNumber:         studentData.weekNumber || 1,
      dayNumber:          day,
      skillPracticed:     firestoreKey,
      questionsAttempted: total,
      questionsCorrect:   listenCorrect,
      accuracy,
      warmupCorrect,
      durationMinutes:    Math.round(behaviour.sessionDurationSec / 60),
      behaviour,
      servedFromBank:     listenFromBank,
    });

    const prevL        = getIELTSSkills()[listenSkillId] || { accuracy: 0, attempted: 0 };
    const prevCorrect  = Math.round(((prevL.accuracy || 0) / 100) * (prevL.attempted || 0));
    const newAttempted = (prevL.attempted || 0) + total;
    const newAccuracy  = newAttempted > 0
      ? Math.round(((prevCorrect + listenCorrect) / newAttempted) * 100) : 0;
    const subjPath = `brain.subjects.ielts-academic.skills.${listenSkillId}`;

    // Confidence profile
    const lConfMetrics = computeConfidenceMetrics(listenQuestions, listenAnswers);
    let lConfProfileUpdate = null;
    if (lConfMetrics) {
      const prevCP  = prevL.confidenceProfile || {};
      const cpN     = (prevCP.sessions || 0) + 1;
      const cpAlpha = 1 / Math.min(cpN, 10);
      const cpEma   = (p, n) => Math.round(p + (n - p) * cpAlpha);
      lConfProfileUpdate = {
        avgConfidenceScore:    cpEma(prevCP.avgConfidenceScore    || 0, lConfMetrics.confidenceScore),
        avgHesitationRate:     cpEma(prevCP.avgHesitationRate     || 0, lConfMetrics.hesitationRate),
        overconfidenceEvents:  (prevCP.overconfidenceEvents  || 0) + lConfMetrics.overconfidenceEvents,
        underconfidenceEvents: (prevCP.underconfidenceEvents || 0) + lConfMetrics.underconfidenceEvents,
        sessions: cpN,
      };
    }

    await updateStudentDoc(currentUser.uid, {
      [`${subjPath}.accuracy`]:      newAccuracy,
      [`${subjPath}.attempted`]:     newAttempted,
      [`${subjPath}.lastPracticed`]: serverTimestamp(),
      [`${subjPath}.trend`]:         newAccuracy > (prevL.accuracy || 0) ? 'up' : newAccuracy < (prevL.accuracy || 0) ? 'down' : 'stable',
      ...(lConfProfileUpdate ? { [`${subjPath}.confidenceProfile`]: lConfProfileUpdate } : {}),
      dayNumber:    (studentData.dayNumber || 1) + 1,
      recentSkills: [firestoreKey, ...(studentData.recentSkills || [])].slice(0, 5),
      streak:       (studentData.streak || 0) + 1,
      lastSession:  serverTimestamp(),
    });

    const snap = await getStudentDoc(currentUser.uid);
    setStudentData(snap.data());
    await updateStudentBrain(behaviour, accuracy, firestoreKey);
    await updateWeakAreas(firestoreKey, null);
  } catch { /* still show notebook */ }

  if (_listenSessionRef) generateAndSaveNarrative(currentUser.uid, _listenSessionRef, {
    skill: firestoreKey, day, accuracy, questionsCorrect: listenCorrect, total,
  });

  if (mockMode) {
    mockResults.listening = { correct: listenCorrect, total, accuracy };
    runMockPhase(2);
    return;
  }

  const listenMissed = {};
  listenQuestions.forEach(q => {
    const a = listenAnswers?.[q.id];
    if (a !== undefined && normaliseAnswer(String(a)) !== normaliseAnswer(q.answer || '')) {
      listenMissed[q.type || 'mc'] = (listenMissed[q.type || 'mc'] || 0) + 1;
    }
  });
  setTipNotebookFn(() => {
    document.getElementById('nb-day-badge').textContent = `Session ${day}`;
    goTo('s-notebook');
    renderNotebook(listenCorrect, total, firestoreKey);
  });
  showSessionTip({ accuracy, behaviour: getBehaviourPayload(), missedSubTypes: listenMissed, skillKey: firestoreKey });
  } catch(err) {
    console.error('finishSession error:', err);
    showToast('Something went wrong — please try again', 'error');
    window._finishListeningRunning = false;
    if (listenFinishBtn) listenFinishBtn.disabled = false;
  }
}
window.finishListeningSession = finishListeningSession;

// ── EVENT DELEGATION — s-listening screen ────────────────────────
(function () {
  const el = document.getElementById('s-listening');
  if (!el) return;
  el.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn || btn.disabled) return;
    const { action } = btn.dataset;
    if (action === 'answer-mc') {
      answerListeningMC(parseInt(btn.dataset.q, 10), btn.dataset.v);
    }
    if (action === 'play-listening') {
      const audio = document.getElementById('listening-audio');
      if (audio) {
        audio.play();
        btn.textContent = '⏸';
        btn.disabled = true;
        if (!listenHasPlayed) {
          listenHasPlayed = true;
          setTimeout(showListeningQuestionsGate, 1000);
        }
      }
    }
  });
})();
