// modules/mock.js
// Mini Mock (Day 10) and Full Mock Test system.
//
// Structural adaptations:
//   listenType = 'mc'          → setListenType('mc')
//   listenCorrect = N          → setListenCorrect(N)
//   (rebinding cross-module let vars requires exported setter functions)

import { serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { API_URL, TRANSCRIBE_URL } from './constants.js';
import {
  studentData, currentUser,
  callAI, buildContextSnippet,
  updateStudentBrain,
} from './state.js';
import { goTo } from './router.js';
import { parseAIJson, renderMarkdown, normaliseAnswer, rawScoreToBand, base64ToBlob } from './utils.js';
import { saveSessionDoc, updateStudentDoc } from './firebase.js';
import { showToast, setSkillBar } from './ui.js';
import {
  loadReadingSession,
  sessionQuestions, sessionAnswers,
  finishReadingSession, getBehaviourPayload,
} from './session-reading.js';
import {
  loadListeningSession,
  listenQuestions, listenAnswers,
  setListenType, setListenCorrect,
} from './session-listening.js';
import { loadWritingSession } from './session-writing.js';
import { loadSpeakingSession, mediaRecorder } from './session-speaking.js';

// ── MINI MOCK STATE ───────────────────────────────────────────────
export let mockMode    = false;
export let mockPhase   = 0;   // 0=reading 1=listening 2=writing 3=speaking
export let mockResults = {};  // { reading, listening, writing, speaking }
let miniMockTimerInterval = null;
let miniMockTimeRemaining = 0;
const MINI_MOCK_TIMES = { 0: 1200, 1: 900, 2: 1800, 3: 420 }; // reading, listening, writing, speaking (seconds)

// ── FULL MOCK STATE ───────────────────────────────────────────────
let fullMockSections       = [];   // e.g. ['reading','listening','writing','speaking']
let fullMockSectionIdx     = 0;    // current section index
let fullMockContent        = {};   // generated content per section
let fullMockAnswers        = {};   // { sectionKey: { qid: answer } }
let fullMockWritingResp    = {};   // { task1: '...', task2: '...' }
let fullMockSpeakingResp   = {};   // { part1: transcript, part2: ..., part3: ... }
let fullMockTimerInterval  = null;
let fullMockTimeRemaining  = 0;    // seconds remaining for current section
let fullMockSelectedOpt    = 'all';
let fullMockResults        = {};   // final evaluated results
let fullMockRecordingEl    = null; // MediaRecorder for mock speaking
const MOCK_SECTION_TIMES   = { reading: 3600, listening: 2400, writing: 3600, speaking: 840 };

// Inline recording state for toggleMockRecording
let mockRecording = false;
let mockRecorder  = null;
let mockRecordedChunks = [];
let mockRecordSeconds  = 0;
let mockRecordInterval = null;

// ── FOCUSED DRILL (Day 9) ─────────────────────────────────────────
export async function loadFocusedDrill() {
  const { getIELTSSkills } = await import('./state.js');
  const drillSkills = getIELTSSkills();
  const skillRows = [
    { name: 'T / F / Not Given',  pct: (drillSkills['reading-tfng']?.attempted              || 0) > 0 ? drillSkills['reading-tfng'].accuracy              : null, loader: loadReadingSession   },
    { name: 'Summary Completion', pct: (drillSkills['reading-summaryCompletion']?.attempted  || 0) > 0 ? drillSkills['reading-summaryCompletion'].accuracy  : null, loader: loadReadingSession   },
    { name: 'Multiple Choice',   pct: (drillSkills['listening-multipleChoice']?.attempted  || 0) > 0 ? drillSkills['listening-multipleChoice'].accuracy   : null, loader: loadListeningSession },
    { name: 'Form Completion',   pct: (drillSkills['listening-formCompletion']?.attempted  || 0) > 0 ? drillSkills['listening-formCompletion'].accuracy    : null, loader: loadListeningSession },
  ].filter(r => r.pct !== null).sort((a, b) => a.pct - b.pct);

  if (skillRows.length === 0) {
    // No data — default to reading
    loadReadingSession();
    return;
  }

  // Load the weakest skill's session
  skillRows[0].loader();
}

// ── MINI MOCK ─────────────────────────────────────────────────────
export function _startMiniMockTimer(phase) {
  if (miniMockTimerInterval) clearInterval(miniMockTimerInterval);
  miniMockTimeRemaining = MINI_MOCK_TIMES[phase] || 1200;
  const labels = ['Reading', 'Listening', 'Writing', 'Speaking'];
  const bar    = document.getElementById('mini-mock-timer-bar');
  if (bar) {
    bar.classList.remove('hidden');
    document.getElementById('mini-mock-phase-label').textContent = labels[phase] || '';
  }
  _updateMiniMockTimerDisplay();
  miniMockTimerInterval = setInterval(() => {
    miniMockTimeRemaining--;
    _updateMiniMockTimerDisplay();
    if (miniMockTimeRemaining <= 0) {
      clearInterval(miniMockTimerInterval);
      miniMockTimerInterval = null;
      _miniMockAutoSubmit(phase);
    }
  }, 1000);
}

export function _updateMiniMockTimerDisplay() {
  const m  = Math.floor(miniMockTimeRemaining / 60);
  const s  = miniMockTimeRemaining % 60;
  const el = document.getElementById('mini-mock-countdown');
  if (el) {
    el.textContent = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    el.classList.toggle('urgent', miniMockTimeRemaining <= 60);
  }
}

export function _hideMiniMockTimer() {
  if (miniMockTimerInterval) { clearInterval(miniMockTimerInterval); miniMockTimerInterval = null; }
  const bar = document.getElementById('mini-mock-timer-bar');
  if (bar) bar.classList.add('hidden');
}

export function _miniMockAutoSubmit(phase) {
  _hideMiniMockTimer();
  if (phase === 0) {
    // Complete any unanswered reading questions as wrong, then finish
    sessionQuestions.forEach(q => {
      if (!sessionAnswers[q.id]) sessionAnswers[q.id] = { val: '', isRight: false };
    });
    finishReadingSession();
  } else if (phase === 1) {
    // Score whatever was answered, finish listening
    listenQuestions.forEach(q => { if (!listenAnswers[q.id]) listenAnswers[q.id] = ''; });
    setListenCorrect(listenQuestions.filter(q => {
      const a = listenAnswers[q.id];
      return normaliseAnswer(String(a)) === normaliseAnswer(q.answer || '');
    }).length);
    window.finishListeningSession();
  } else if (phase === 2) {
    // Submit whatever is written
    const text = document.getElementById('writing-textarea')?.value?.trim() || '';
    if (text.split(/\s+/).filter(Boolean).length >= 5) {
      window.submitWriting();
    } else {
      // Nothing written — go to results with 0 band
      mockResults.writing = { band: 0 };
      runMockPhase(3);
    }
  } else if (phase === 3) {
    // Stop recording if active, evaluate whatever was captured
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      window.stopRecording();
    } else {
      // Nothing recorded
      mockResults.speaking = { band: 0 };
      showMockResults();
    }
  }
}

export function setupMiniMock() {
  _hideMiniMockTimer();
  mockMode    = false;
  mockPhase   = 0;
  mockResults = {};

  ['reading','listening','writing','speaking'].forEach(s => {
    const el = document.getElementById(`mock-step-${s}`);
    if (el) { el.className = 'mock-step'; el.textContent = ''; }
  });

  document.getElementById('mock-intro-view').classList.remove('hidden');
  document.getElementById('mock-results-view').classList.add('hidden');
}
window.setupMiniMock = setupMiniMock;

export function startMiniMock() {
  mockMode  = true;
  mockPhase = 0;
  document.getElementById('mock-intro-view').classList.add('hidden');
  runMockPhase(0);
}
window.startMiniMock = startMiniMock;

export function runMockPhase(phase) {
  mockPhase = phase;

  // Stop any running timer
  if (miniMockTimerInterval) { clearInterval(miniMockTimerInterval); miniMockTimerInterval = null; }

  // Update mock progress indicators
  const labels = ['reading','listening','writing','speaking'];
  labels.forEach((l, i) => {
    const el = document.getElementById(`mock-step-${l}`);
    if (!el) return;
    if (i < phase)       { el.className = 'mock-step done'; }
    else if (i === phase){ el.className = 'mock-step active'; }
    else                 { el.className = 'mock-step'; }
  });

  if (phase === 0) {
    try { loadReadingSession(); } catch(e) { showToast('Session failed to load — tap to retry.'); return; }
    _startMiniMockTimer(0);
  }
  else if (phase === 1) { setListenType('mc'); loadListeningSession(); _startMiniMockTimer(1); }
  else if (phase === 2) { loadWritingSession(); _startMiniMockTimer(2); }
  else if (phase === 3) { loadSpeakingSession(); _startMiniMockTimer(3); }
  else showMockResults();
}
window.runMockPhase = runMockPhase;

export function showMockResults() {
  _hideMiniMockTimer();
  mockMode = false;

  const readingPct  = mockResults.reading?.accuracy  || 0;
  const listenPct   = mockResults.listening?.accuracy || 0;
  const writingBand = mockResults.writing?.band       || 0;
  const speakBand   = mockResults.speaking?.band      || 0;

  // Convert writing/speaking band to pseudo-percentage for display
  const writingPct = writingBand > 0 ? Math.round(((writingBand - 4) / 5) * 100) : 0;
  const speakPct   = speakBand  > 0 ? Math.round(((speakBand  - 4) / 5) * 100) : 0;

  const totalReadingQ  = sessionQuestions.length || 5;
  const readingCorrect = Math.round(readingPct / 100 * totalReadingQ);
  const readingBand    = readingPct > 0 ? rawScoreToBand(readingCorrect, totalReadingQ) : 0;

  const totalListenQ  = listenQuestions.length || 5;
  const listenCorrect = Math.round(listenPct / 100 * totalListenQ);
  const listenBand    = listenPct > 0 ? rawScoreToBand(listenCorrect, totalListenQ) : 0;

  const bandSections = [];
  if (readingBand > 0) bandSections.push(readingBand);
  if (listenBand  > 0) bandSections.push(listenBand);
  if (writingBand > 0) bandSections.push(writingBand);
  if (speakBand   > 0) bandSections.push(speakBand);

  const overallBand = bandSections.length > 0
    ? (Math.round((bandSections.reduce((a, b) => a + b, 0) / bandSections.length) * 2) / 2).toFixed(1)
    : '0.0';

  document.getElementById('mock-overall-band').textContent = overallBand;

  setSkillBar('mock-reading-bar',  'mock-reading-pct',  readingPct  > 0 ? readingPct  : null);
  setSkillBar('mock-listening-bar','mock-listening-pct', listenPct  > 0 ? listenPct   : null);
  setSkillBar('mock-writing-bar',  'mock-writing-pct',  writingPct  > 0 ? writingPct  : null);
  setSkillBar('mock-speaking-bar', 'mock-speaking-pct', speakPct    > 0 ? speakPct    : null);

  // Generate recommendations from weakest areas
  const sections = [
    { name: 'Reading',  pct: readingPct  },
    { name: 'Listening',pct: listenPct   },
    { name: 'Writing',  pct: writingPct  },
    { name: 'Speaking', pct: speakPct    },
  ].sort((a,b) => a.pct - b.pct);

  const recs = [
    `1. Prioritise <strong>${sections[0].name}</strong> — your lowest section this mock.`,
    `2. Review every incorrect answer immediately after the session.`,
    `3. Sit a full timed practice exam before your real test date.`,
  ];
  document.getElementById('mock-recommendations').innerHTML = recs.join('<br/>');

  // Save mock results to Firestore
  saveSessionDoc(currentUser.uid, {
    weekNumber:     studentData.weekNumber || 2,
    dayNumber:      10,
    skillPracticed: 'minimock',
    mockResults,
    overallBandEstimate: parseFloat(overallBand),
    durationMinutes: 0
  }).catch(() => {});

  updateStudentDoc(currentUser.uid, {
    dayNumber:   11,
    lastSession: serverTimestamp(),
    streak:      (studentData.streak || 0) + 1,
  }).catch(() => {});

  goTo('s-minimock');
  document.getElementById('mock-intro-view').classList.add('hidden');
  document.getElementById('mock-results-view').classList.remove('hidden');
}

// ── FULL MOCK TEST SYSTEM ─────────────────────────────────────────

export function startFullMockSetup() {
  fullMockSelectedOpt = 'all';
  document.querySelectorAll('.mock-option-btn').forEach((b, i) => {
    b.classList.toggle('active', i === 0);
  });
  goTo('s-fullmock-setup');
}
window.startFullMockSetup = startFullMockSetup;

export function selectMockOption(btn) {
  document.querySelectorAll('.mock-option-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  fullMockSelectedOpt = btn.dataset.sections;
}
window.selectMockOption = selectMockOption;

export async function startFullMockGeneration() {
  if (!currentUser) {
    showToast('Please sign in to generate your mock test.');
    goTo('s-fullmock-setup');
    return;
  }
  const opt = fullMockSelectedOpt;
  fullMockSections = opt === 'all'
    ? ['reading','listening','writing','speaking']
    : [opt];
  fullMockSectionIdx = 0;
  fullMockContent    = {};
  fullMockAnswers    = {};
  fullMockWritingResp  = {};
  fullMockSpeakingResp = {};
  fullMockResults    = {};

  goTo('s-fullmock-gen');
  _setGenStep('reading',   false);
  _setGenStep('listening', false);
  _setGenStep('writing',   false);
  _setGenStep('speaking',  false);
  document.getElementById('mock-gen-bar').style.width = '0%';

  const band = studentData?.targetBand || 6.5;
  let done = 0;
  const total = fullMockSections.length;

  const updateBar = () => {
    done++;
    document.getElementById('mock-gen-bar').style.width = `${Math.round(done/total*100)}%`;
  };

  // Generate all sections in parallel
  const tasks = [];

  if (fullMockSections.includes('reading')) {
    tasks.push((async () => {
      _setGenStep('reading', 'loading');
      try {
        const [p1, p2, p3] = await Promise.all([
          callAI({ system: 'You are an IELTS Academic examiner. Return valid JSON only.', user: `Generate an IELTS Academic Reading passage with 8 True/False/Not Given questions for Band ${band}. Return ONLY: {"topic":"...","passage":"200-word academic passage","questions":[{"id":1,"text":"claim","answer":"True|False|NG","explanation":"one sentence"},...8 questions]}`, maxTokens: 1800 }),
          callAI({ system: 'You are an IELTS Academic examiner. Return valid JSON only.', user: `Generate an IELTS Academic Reading passage with 8 Matching Headings questions for Band ${band}. Return ONLY: {"topic":"...","passage":"4 paragraphs labelled A-D, each 40-50 words","headings":["heading 1","heading 2","heading 3","heading 4","heading 5","heading 6"],"questions":[{"id":1,"paragraph":"A","answer":"3","explanation":"one sentence"},...4 questions matching A-D to headings]}`, maxTokens: 1800 }),
          callAI({ system: 'You are an IELTS Academic examiner. Return valid JSON only.', user: `Generate an IELTS Academic Reading passage with 8 Summary Completion questions for Band ${band}. Return ONLY: {"topic":"...","passage":"200-word academic passage","summaryText":"A short summary with 8 gaps marked as [1],[2]...[8]","wordBank":["word1","word2","word3","word4","word5","word6","word7","word8","decoy1","decoy2"],"questions":[{"id":1,"answer":"correct word from passage","explanation":"one sentence"},...8 questions]}`, maxTokens: 1800 }),
        ]);
        fullMockContent.reading = {
          passages: [
            { ...parseAIJson(p1), type: 'tfng' },
            { ...parseAIJson(p2), type: 'matchingHeadings' },
            { ...parseAIJson(p3), type: 'summaryCompletion' },
          ]
        };
        _setGenStep('reading', 'done');
      } catch { _setGenStep('reading', 'error'); fullMockContent.reading = null; }
      updateBar();
    })());
  }

  if (fullMockSections.includes('listening')) {
    tasks.push((async () => {
      _setGenStep('listening', 'loading');
      try {
        const [s1, s2, s3, s4] = await Promise.all([
          callAI({ system: 'You are an IELTS examiner. Return valid JSON only.', user: `Create an IELTS Listening Multiple Choice section for Band ${band}. A conversation in an everyday context (e.g. booking, enquiry). Return ONLY: {"scenario":"2-sentence description","audioText":"spoken conversation 150-180 words","questions":[{"id":1,"text":"question?","options":["A: option","B: option","C: option"],"answer":"A|B|C","explanation":"one sentence"},...7 questions]}`, maxTokens: 1600 }),
          callAI({ system: 'You are an IELTS examiner. Return valid JSON only.', user: `Create an IELTS Listening Multiple Choice section for Band ${band}. A monologue/talk in an educational context. Return ONLY: {"scenario":"2-sentence description","audioText":"spoken monologue 150-180 words","questions":[{"id":1,"text":"question?","options":["A: option","B: option","C: option"],"answer":"A|B|C","explanation":"one sentence"},...7 questions]}`, maxTokens: 1600 }),
          callAI({ system: 'You are an IELTS examiner. Return valid JSON only.', user: `Create an IELTS Listening Form Completion section for Band ${band}. Return ONLY: {"scenario":"2-sentence description","audioText":"spoken conversation 150-180 words about a form","formTitle":"Form name","questions":[{"id":1,"fieldLabel":"Field name","answer":"answer word(s)","explanation":"one sentence"},...7 questions]}`, maxTokens: 1600 }),
          callAI({ system: 'You are an IELTS examiner. Return valid JSON only.', user: `Create an IELTS Listening Multiple Choice section (academic lecture context) for Band ${band}. Return ONLY: {"scenario":"2-sentence description","audioText":"academic lecture 180-200 words","questions":[{"id":1,"text":"question?","options":["A: option","B: option","C: option"],"answer":"A|B|C","explanation":"one sentence"},...7 questions]}`, maxTokens: 1600 }),
        ]);
        const parsed = [s1, s2, s3, s4].map(r => parseAIJson(r));
        // Generate audio in parallel
        const audioBlobUrls = await Promise.all(
          parsed.map(sec => (async () => {
            try {
              const audioRes = await fetch(`${API_URL.replace('/generate', '/audio')}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: sec.audioText })
              });
              const audioData = await audioRes.json();
              if (audioData.audio) {
                const blob = base64ToBlob(audioData.audio, audioData.mimeType || 'audio/mpeg');
                return URL.createObjectURL(blob);
              }
              return null;
            } catch { return null; }
          })())
        );
        fullMockContent.listening = {
          sections: parsed.map((sec, i) => ({
            ...sec,
            audioUrl: audioBlobUrls[i],
            type: i === 2 ? 'formCompletion' : 'multipleChoice',
          }))
        };
        _setGenStep('listening', 'done');
      } catch { _setGenStep('listening', 'error'); fullMockContent.listening = null; }
      updateBar();
    })());
  }

  if (fullMockSections.includes('writing')) {
    tasks.push((async () => {
      _setGenStep('writing', 'loading');
      try {
        const raw = await callAI({
          system: 'You are an IELTS Writing examiner. Return valid JSON only.',
          user: `Generate both IELTS Writing tasks for Band ${band}. Return ONLY: {"task1":{"title":"Graph/Chart Description","prompt":"Describe the following [bar chart/line graph/table]. The graph shows [topic]. Write at least 150 words."},"task2":{"title":"Opinion Essay","prompt":"[Essay question on a relevant academic topic]. Give your opinion and support it with examples. Write at least 250 words."}}`,
          maxTokens: 600
        });
        fullMockContent.writing = parseAIJson(raw);
        _setGenStep('writing', 'done');
      } catch { _setGenStep('writing', 'error'); fullMockContent.writing = null; }
      updateBar();
    })());
  }

  if (fullMockSections.includes('speaking')) {
    tasks.push((async () => {
      _setGenStep('speaking', 'loading');
      try {
        const raw = await callAI({
          system: 'You are an IELTS Speaking examiner. Return valid JSON only.',
          user: `Generate IELTS Speaking test content for Band ${band}. Return ONLY: {"part1":{"topic":"Personal topic (e.g. hometown)","questions":["question 1?","question 2?","question 3?","question 4?","question 5?"]},"part2":{"topic":"Cue card topic","cueCard":["Describe [topic]. You should say:","- point 1","- point 2","- point 3","and explain [final point]."]},"part3":{"questions":["discussion question 1?","discussion question 2?","discussion question 3?","discussion question 4?","discussion question 5?"]}}`,
          maxTokens: 800
        });
        fullMockContent.speaking = parseAIJson(raw);
        _setGenStep('speaking', 'done');
      } catch { _setGenStep('speaking', 'error'); fullMockContent.speaking = null; }
      updateBar();
    })());
  }

  await Promise.all(tasks);

  // All done — check if any critical section failed
  const failed = fullMockSections.filter(s => fullMockContent[s] === null);
  if (failed.length === fullMockSections.length) {
    showToast('Having trouble connecting — please check your internet and try again.');
    goTo('s-fullmock-setup');
    return;
  }
  // Filter out failed sections
  fullMockSections = fullMockSections.filter(s => fullMockContent[s] !== null);
  fullMockSectionIdx = 0;
  _startMockSection();
}
window.startFullMockGeneration = startFullMockGeneration;

export function _setGenStep(section, state) {
  const el = document.getElementById(`mgs-${section}`);
  if (!el) return;
  const dot = el.querySelector('.mgs-dot');
  if (state === false)     { el.className = 'mock-gen-step'; if (dot) dot.textContent = '○'; }
  else if (state === 'loading') { el.className = 'mock-gen-step loading'; if (dot) dot.textContent = '⟳'; }
  else if (state === 'done')    { el.className = 'mock-gen-step done'; if (dot) dot.textContent = '✓'; }
  else if (state === 'error')   { el.className = 'mock-gen-step error'; if (dot) dot.textContent = '✗'; }
}

export function _startMockSection() {
  if (fullMockSectionIdx >= fullMockSections.length) {
    _evalMockTest();
    return;
  }
  const section = fullMockSections[fullMockSectionIdx];
  fullMockTimeRemaining = MOCK_SECTION_TIMES[section] || 3600;
  if (!fullMockAnswers[section]) fullMockAnswers[section] = {};
  goTo('s-fullmock-test');
  _renderMockSection(section);
  _startMockTimer();
}

export function _startMockTimer() {
  if (fullMockTimerInterval) clearInterval(fullMockTimerInterval);
  _updateTimerDisplay();
  fullMockTimerInterval = setInterval(() => {
    fullMockTimeRemaining--;
    _updateTimerDisplay();
    if (fullMockTimeRemaining <= 0) {
      clearInterval(fullMockTimerInterval);
      window.submitMockSection();
    }
  }, 1000);
}

export function _updateTimerDisplay() {
  const m = Math.floor(fullMockTimeRemaining / 60);
  const s = fullMockTimeRemaining % 60;
  const el = document.getElementById('mock-test-timer');
  if (el) {
    el.textContent = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    el.className = 'mock-test-timer' + (fullMockTimeRemaining <= 300 ? ' urgent' : '');
  }
}

export function _renderMockSection(section) {
  const labelEl = document.getElementById('mock-test-section-label');
  if (labelEl) labelEl.textContent = section.charAt(0).toUpperCase() + section.slice(1);
  const body = document.getElementById('mock-test-body');
  if (!body) return;

  if (section === 'reading') {
    body.innerHTML = _renderMockReading();
  } else if (section === 'listening') {
    body.innerHTML = _renderMockListening();
  } else if (section === 'writing') {
    body.innerHTML = _renderMockWriting();
  } else if (section === 'speaking') {
    body.innerHTML = _renderMockSpeaking();
    _initMockSpeaking();
  }
}

export function _renderMockReading() {
  const passages = fullMockContent.reading?.passages || [];
  let html = '';
  passages.forEach((passage, pIdx) => {
    html += `<div class="mock-passage-block">
      <div class="mock-passage-label">Passage ${pIdx+1} — ${passage.topic || ''}</div>
      <div class="mock-passage-text">${(passage.passage || '').split('\n').map(p => `<p>${p}</p>`).join('')}</div>`;
    if (passage.type === 'matchingHeadings' && passage.headings) {
      html += `<div class="mock-headings-list"><strong>List of Headings:</strong><ol class="mock-heading-ol">`;
      passage.headings.forEach((h, i) => { html += `<li>${h}</li>`; });
      html += `</ol></div>`;
    }
    if (passage.type === 'summaryCompletion' && passage.summaryText) {
      html += `<div class="mock-summary-wrap"><div class="mock-summary-label">Summary Completion</div><div class="mock-summary-text">${passage.summaryText}</div>`;
      if (passage.wordBank) {
        html += `<div class="mock-wordbank"><strong>Word Bank:</strong> ${passage.wordBank.join(' · ')}</div>`;
      }
      html += `</div>`;
    }
    const questions = passage.questions || [];
    html += `<div class="mock-questions-block">`;
    questions.forEach(q => {
      const qid = `r_${pIdx}_${q.id}`;
      if (passage.type === 'tfng') {
        html += `<div class="mock-q">
          <div class="mock-q-num">${q.id}.</div>
          <div class="mock-q-body">
            <div class="mock-q-text">${q.text}</div>
            <div class="mock-q-tfng">
              <label><input type="radio" name="${qid}" value="True" onchange="window.mockAnswer('reading','${qid}',this.value)"> True</label>
              <label><input type="radio" name="${qid}" value="False" onchange="window.mockAnswer('reading','${qid}',this.value)"> False</label>
              <label><input type="radio" name="${qid}" value="NG" onchange="window.mockAnswer('reading','${qid}',this.value)"> Not Given</label>
            </div>
          </div>
        </div>`;
      } else if (passage.type === 'matchingHeadings') {
        html += `<div class="mock-q">
          <div class="mock-q-num">${q.id}.</div>
          <div class="mock-q-body">
            <div class="mock-q-text">Paragraph ${q.paragraph}</div>
            <select class="mock-select" onchange="window.mockAnswer('reading','${qid}',this.value)">
              <option value="">— Choose heading —</option>
              ${(passage.headings || []).map((h,i) => `<option value="${i+1}">${i+1}. ${h}</option>`).join('')}
            </select>
          </div>
        </div>`;
      } else {
        html += `<div class="mock-q">
          <div class="mock-q-num">${q.id}.</div>
          <div class="mock-q-body">
            <input type="text" class="mock-input" placeholder="Your answer" onchange="window.mockAnswer('reading','${qid}',this.value)">
          </div>
        </div>`;
      }
    });
    html += `</div></div>`;
  });
  return html;
}

export function _renderMockListening() {
  const sections = fullMockContent.listening?.sections || [];
  let html = '';
  sections.forEach((sec, sIdx) => {
    html += `<div class="mock-listen-block">
      <div class="mock-passage-label">Section ${sIdx+1} — ${sec.scenario || ''}</div>`;
    if (sec.audioUrl) {
      html += `<div class="mock-audio-wrap">
        <audio id="mock-audio-${sIdx}" src="${sec.audioUrl}" preload="auto"></audio>
        <button class="mock-play-btn" onclick="document.getElementById('mock-audio-${sIdx}').play()">▶ Play Audio</button>
      </div>`;
    } else {
      html += `<div class="audio-fallback">Audio unavailable — read the transcript below</div>`;
      html += `<div class="transcript">${sec.audioText || ''}</div>`;
    }
    const questions = sec.questions || [];
    html += `<div class="mock-questions-block">`;
    questions.forEach(q => {
      const qid = `l_${sIdx}_${q.id}`;
      if (sec.type === 'multipleChoice') {
        html += `<div class="mock-q">
          <div class="mock-q-num">${q.id}.</div>
          <div class="mock-q-body">
            <div class="mock-q-text">${q.text}</div>
            <div class="mock-q-options">
              ${(q.options || []).map(opt => {
                const val = opt.split(':')[0].trim();
                return `<label class="mock-opt-label"><input type="radio" name="${qid}" value="${val}" onchange="window.mockAnswer('listening','${qid}',this.value)"> ${opt}</label>`;
              }).join('')}
            </div>
          </div>
        </div>`;
      } else {
        html += `<div class="mock-q">
          <div class="mock-q-num">${q.id}.</div>
          <div class="mock-q-body">
            <div class="mock-q-text">${q.fieldLabel || q.text || ''}</div>
            <input type="text" class="mock-input" placeholder="Your answer" onchange="window.mockAnswer('listening','${qid}',this.value)">
          </div>
        </div>`;
      }
    });
    html += `</div></div>`;
  });
  return html;
}

export function _renderMockWriting() {
  const w = fullMockContent.writing || {};
  return `
    <div class="mock-writing-block">
      <div class="mock-passage-label">Task 1 — ${w.task1?.title || 'Graph Description'}</div>
      <div class="mock-writing-prompt">${w.task1?.prompt || ''}</div>
      <textarea class="mock-textarea" id="mock-w-task1" placeholder="Write your Task 1 response here (minimum 150 words)..."
        oninput="window.mockWritingInput('task1',this.value)"></textarea>
      <div class="mock-wc" id="mock-wc-task1">0 words</div>
    </div>
    <div class="mock-writing-block" style="margin-top:24px">
      <div class="mock-passage-label">Task 2 — ${w.task2?.title || 'Essay'}</div>
      <div class="mock-writing-prompt">${w.task2?.prompt || ''}</div>
      <textarea class="mock-textarea" id="mock-w-task2" placeholder="Write your Task 2 response here (minimum 250 words)..."
        oninput="window.mockWritingInput('task2',this.value)"></textarea>
      <div class="mock-wc" id="mock-wc-task2">0 words</div>
    </div>`;
}

export function _renderMockSpeaking() {
  const sp = fullMockContent.speaking || {};
  return `
    <div class="mock-speaking-block">
      <div class="mock-passage-label">Part 1 — ${sp.part1?.topic || 'Personal Questions'}</div>
      <div class="mock-speaking-qs">
        ${(sp.part1?.questions || []).map((q,i) => `<div class="mock-sp-q">${i+1}. ${q}</div>`).join('')}
      </div>
      <div class="mock-passage-label mt16">Part 2 — Cue Card</div>
      <div class="mock-cue-card">
        ${(sp.part2?.cueCard || []).map(line => `<div>${line}</div>`).join('')}
      </div>
      <div class="mock-passage-label mt16">Part 3 — Discussion</div>
      <div class="mock-speaking-qs">
        ${(sp.part3?.questions || []).map((q,i) => `<div class="mock-sp-q">${i+1}. ${q}</div>`).join('')}
      </div>
      <div class="mock-speaking-record">
        <div class="mock-record-status" id="mock-record-status">Tap to record your answers</div>
        <button class="mock-record-btn" id="mock-record-btn" onclick="window.toggleMockRecording()">🎙 Start Recording</button>
        <div class="mock-record-timer" id="mock-record-timer" style="display:none">0:00</div>
      </div>
      <textarea class="mock-textarea" id="mock-sp-notes" placeholder="(Optional) Note down key points..." rows="4"
        oninput="window.mockSpeakingNotes(this.value)"></textarea>
    </div>`;
}

export function _initMockSpeaking() {
  window.mockSpeakingNotes = function (val) {
    fullMockSpeakingResp.notes = val;
  };
}

export function mockAnswer(section, qid, value) {
  if (!fullMockAnswers[section]) fullMockAnswers[section] = {};
  fullMockAnswers[section][qid] = value;
}
window.mockAnswer = mockAnswer;

export function mockWritingInput(taskKey, value) {
  fullMockWritingResp[taskKey] = value;
  const wc = value.trim().split(/\s+/).filter(Boolean).length;
  const el = document.getElementById(`mock-wc-${taskKey}`);
  if (el) el.textContent = `${wc} word${wc !== 1 ? 's' : ''}`;
}
window.mockWritingInput = mockWritingInput;

export async function toggleMockRecording() {
  const btn  = document.getElementById('mock-record-btn');
  const stat = document.getElementById('mock-record-status');
  const timer = document.getElementById('mock-record-timer');
  if (!mockRecording) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mockRecordedChunks = [];
      mockRecorder = new MediaRecorder(stream);
      mockRecorder.ondataavailable = e => { if (e.data.size > 0) mockRecordedChunks.push(e.data); };
      mockRecorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(mockRecordedChunks, { type: 'audio/webm' });
        // Transcribe via Whisper
        stat.textContent = 'Transcribing...';
        try {
          const arrayBuffer = await blob.arrayBuffer();
          const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
          const res = await fetch(TRANSCRIBE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ audio: base64, mimeType: blob.type || 'audio/webm' })
          });
          const data = await res.json();
          fullMockSpeakingResp.transcript = data.text || '';
          stat.textContent = 'Recording saved ✓';
        } catch { stat.textContent = 'Recording saved (transcription failed)'; }
      };
      mockRecorder.start();
      mockRecording = true;
      mockRecordSeconds = 0;
      timer.style.display = '';
      timer.textContent = '0:00';
      mockRecordInterval = setInterval(() => {
        mockRecordSeconds++;
        const m = Math.floor(mockRecordSeconds/60), s = mockRecordSeconds%60;
        timer.textContent = `${m}:${String(s).padStart(2,'0')}`;
      }, 1000);
      btn.textContent = '⏹ Stop Recording';
      stat.textContent = 'Recording...';
    } catch { stat.textContent = 'Microphone access denied.'; }
  } else {
    if (mockRecorder && mockRecorder.state !== 'inactive') mockRecorder.stop();
    clearInterval(mockRecordInterval);
    mockRecording = false;
    btn.textContent = '🎙 Record Again';
  }
}
window.toggleMockRecording = toggleMockRecording;

export function submitMockSection() {
  clearInterval(fullMockTimerInterval);
  if (mockRecording && mockRecorder) {
    mockRecorder.stop();
    mockRecording = false;
    clearInterval(mockRecordInterval);
  }
  fullMockSectionIdx++;
  if (fullMockSectionIdx < fullMockSections.length) {
    _startMockSection();
  } else {
    _evalMockTest();
  }
}
window.submitMockSection = submitMockSection;

export async function _evalMockTest() {
  goTo('s-fullmock-eval');
  const band = studentData?.targetBand || 6.5;

  // Evaluate reading
  if (fullMockContent.reading) {
    let correct = 0, total = 0;
    const wrongQs = [];
    fullMockContent.reading.passages.forEach((passage, pIdx) => {
      (passage.questions || []).forEach(q => {
        const qid = `r_${pIdx}_${q.id}`;
        const given = normaliseAnswer(fullMockAnswers.reading?.[qid] || '');
        const correct_ans = normaliseAnswer(q.answer || '');
        total++;
        if (given === correct_ans) { correct++; }
        else { wrongQs.push({ ...q, givenAnswer: given, section: 'Reading', type: passage.type }); }
      });
    });
    fullMockResults.reading = { correct, total, band: rawScoreToBand(correct, total), wrongQs };
  }

  // Evaluate listening
  if (fullMockContent.listening) {
    let correct = 0, total = 0;
    const wrongQs = [];
    fullMockContent.listening.sections.forEach((sec, sIdx) => {
      (sec.questions || []).forEach(q => {
        const qid = `l_${sIdx}_${q.id}`;
        const given = normaliseAnswer(fullMockAnswers.listening?.[qid] || '');
        const correct_ans = normaliseAnswer(q.answer || '');
        total++;
        if (given === correct_ans || given === correct_ans.charAt(0)) { correct++; }
        else { wrongQs.push({ ...q, givenAnswer: given, section: 'Listening', type: sec.type }); }
      });
    });
    fullMockResults.listening = { correct, total, band: rawScoreToBand(correct, total), wrongQs };
  }

  // Evaluate writing via AI
  if (fullMockContent.writing) {
    try {
      const t1 = fullMockWritingResp.task1 || '';
      const t2 = fullMockWritingResp.task2 || '';
      const evalPrompt = {
        system: 'You are an IELTS Writing examiner. Return valid JSON only.',
        user: `Evaluate these IELTS Writing responses for a Band ${band} student.
Task 1 prompt: ${fullMockContent.writing.task1?.prompt || ''}
Task 1 response: ${t1}
Task 2 prompt: ${fullMockContent.writing.task2?.prompt || ''}
Task 2 response: ${t2}
Return ONLY: {"task1Band":6.0,"task2Band":6.5,"overallBand":6.5,"task1Feedback":"one sentence","task2Feedback":"one sentence","topIssue":"most important improvement"}`,
        maxTokens: 500
      };
      const raw = await callAI(evalPrompt);
      const result = parseAIJson(raw);
      fullMockResults.writing = {
        band: result.overallBand || 6.0,
        task1Band: result.task1Band, task2Band: result.task2Band,
        task1Feedback: result.task1Feedback, task2Feedback: result.task2Feedback,
        topIssue: result.topIssue,
      };
    } catch { fullMockResults.writing = { band: 6.0 }; }
  }

  // Evaluate speaking via AI
  if (fullMockContent.speaking) {
    try {
      const transcript = fullMockSpeakingResp.transcript || fullMockSpeakingResp.notes || '(no transcript available)';
      const evalPrompt = {
        system: 'You are an IELTS Speaking examiner. Return valid JSON only.',
        user: `Evaluate this IELTS Speaking response for a Band ${band} student.
Questions covered: Part 1 (${fullMockContent.speaking.part1?.topic}), Part 2 (${fullMockContent.speaking.part2?.topic}), Part 3 discussion.
Transcript/notes: ${transcript}
Return ONLY: {"overallBand":6.5,"fluencyBand":6.5,"lexicalBand":6.5,"grammarBand":6.5,"pronunciationBand":6.5,"feedback":"2 sentences of honest assessment","topSuggestion":"one concrete improvement"}`,
        maxTokens: 400
      };
      const raw = await callAI(evalPrompt);
      const result = parseAIJson(raw);
      fullMockResults.speaking = {
        band: result.overallBand || 6.0,
        feedback: result.feedback, topSuggestion: result.topSuggestion,
      };
    } catch { fullMockResults.speaking = { band: 6.0 }; }
  }

  await _showMockReport();
}

export async function _showMockReport() {
  // Calculate overall band
  const bands = [];
  if (fullMockResults.reading)   bands.push(fullMockResults.reading.band);
  if (fullMockResults.listening) bands.push(fullMockResults.listening.band);
  if (fullMockResults.writing)   bands.push(fullMockResults.writing.band);
  if (fullMockResults.speaking)  bands.push(fullMockResults.speaking.band);
  const overall = bands.length ? (bands.reduce((a,b) => a+b, 0) / bands.length) : 0;
  // Round to nearest 0.5
  const overallRounded = Math.round(overall * 2) / 2;

  fullMockResults.overall = overallRounded;

  // Save to Firestore
  const mockDoc = {
    date:            new Date().toISOString(),
    sections:        fullMockSections,
    overall:         overallRounded,
    reading:         fullMockResults.reading?.band  || null,
    listening:       fullMockResults.listening?.band || null,
    writing:         fullMockResults.writing?.band   || null,
    speaking:        fullMockResults.speaking?.band  || null,
  };
  try {
    await saveSessionDoc(currentUser.uid, { ...mockDoc, skillPracticed: 'fullMock', durationMinutes: 0 });
    // Save compact mock history entry
    const existingMocks = studentData?.mockHistory || [];
    await updateStudentDoc(currentUser.uid, {
      mockHistory: [...existingMocks, { date: mockDoc.date, overall: overallRounded,
        reading: mockDoc.reading, listening: mockDoc.listening,
        writing: mockDoc.writing, speaking: mockDoc.speaking }]
    });
  } catch { /* non-critical */ }

  // Update brain with mock performance
  const skillUpdates = {};
  if (fullMockResults.reading) {
    const r = fullMockResults.reading;
    const acc = Math.round(r.correct / r.total * 100);
    skillUpdates['reading-tfng'] = { accuracy: acc, attempted: r.total };
    await updateStudentBrain(getBehaviourPayload(), acc, 'reading.tfng');
  }

  goTo('s-fullmock-report');

  // Render Part 1: Score Summary
  document.getElementById('mock-report-date').textContent = new Date().toLocaleDateString('en-GB', { day:'numeric', month:'long', year:'numeric' });
  document.getElementById('mr-overall-band').textContent = overallRounded.toFixed(1);

  // Compare to Day 1
  const baseline = studentData?.targetBand || 6.5;
  const diff = (overallRounded - baseline).toFixed(1);
  const compareEl = document.getElementById('mr-compare');
  if (compareEl) {
    const sign = diff >= 0 ? '+' : '';
    compareEl.textContent = `${sign}${diff} bands vs. your target of ${baseline}`;
    compareEl.style.color = diff >= 0 ? 'var(--success)' : 'var(--danger)';
  }

  const scoreHtml = [
    { label: 'Reading',   band: fullMockResults.reading?.band,   color: 'var(--accent-light)' },
    { label: 'Listening', band: fullMockResults.listening?.band, color: 'var(--surface2)' },
    { label: 'Writing',   band: fullMockResults.writing?.band,   color: 'var(--success-light)' },
    { label: 'Speaking',  band: fullMockResults.speaking?.band,  color: 'var(--yellow-light)' },
  ].filter(s => s.band != null).map(s => `
    <div class="mock-score-card" style="background:${s.color}">
      <div class="msc-label">${s.label}</div>
      <div class="msc-band">${s.band.toFixed(1)}</div>
    </div>`).join('');
  document.getElementById('mock-section-scores').innerHTML = scoreHtml;

  // Render Part 2: Skill Breakdown
  const sbRows = [];
  if (fullMockResults.reading) {
    const pct = Math.round(fullMockResults.reading.correct / fullMockResults.reading.total * 100);
    sbRows.push({ label: 'Reading (overall)', pct });
  }
  if (fullMockResults.listening) {
    const pct = Math.round(fullMockResults.listening.correct / fullMockResults.listening.total * 100);
    sbRows.push({ label: 'Listening (overall)', pct });
  }
  const sbHtml = sbRows.map(r => `
    <div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border)">
      <span style="flex:1;font-size:13px;font-weight:400">${r.label}</span>
      <div style="flex:1;height:5px;background:var(--border);border-radius:4px;overflow:hidden">
        <div style="width:${r.pct}%;height:100%;background:${r.pct>=70?'var(--success)':'var(--danger)'};border-radius:4px"></div>
      </div>
      <span style="font-size:11px;font-weight:600;color:var(--accent);width:36px;text-align:right">${r.pct}%</span>
    </div>`).join('');
  document.getElementById('mr-skill-breakdown').innerHTML = sbHtml || '<p style="font-size:13px;color:var(--muted)">—</p>';

  // Part 3: AI Debrief (async)
  _generateMockDebrief(overallRounded);

  // Part 4: Question Review
  const allWrong = [
    ...(fullMockResults.reading?.wrongQs  || []),
    ...(fullMockResults.listening?.wrongQs || []),
  ];
  const reviewHtml = allWrong.length
    ? allWrong.map(q => `
      <div class="mock-review-item">
        <div class="mock-review-section">${q.section}</div>
        <div class="mock-review-q">${q.text || q.fieldLabel || ''}</div>
        <div class="mock-review-ans">Your answer: <span class="wrong-ans">${q.givenAnswer || '—'}</span></div>
        <div class="mock-review-ans">Correct: <span class="correct-ans">${q.answer}</span></div>
        <div class="mock-review-exp">${renderMarkdown(q.explanation || '')}</div>
      </div>`).join('')
    : '<p style="font-size:13px;color:var(--muted)">All answers correct!</p>';
  document.getElementById('mr-question-review').innerHTML = reviewHtml;
}

export async function _generateMockDebrief(overall) {
  try {
    const ctx = buildContextSnippet();
    const rBand = fullMockResults.reading?.band;
    const lBand = fullMockResults.listening?.band;
    const wBand = fullMockResults.writing?.band;
    const sBand = fullMockResults.speaking?.band;
    const debriefPrompt = {
      system: 'You are Toody, an honest IELTS coach. Return valid JSON only.',
      user: `${ctx}
This student just completed a full IELTS mock test.
Results: Reading ${rBand||'—'}, Listening ${lBand||'—'}, Writing ${wBand||'—'}, Speaking ${sBand||'—'}, Overall: ${overall}
Writing feedback: ${fullMockResults.writing?.task2Feedback || ''}
Speaking feedback: ${fullMockResults.speaking?.feedback || ''}
Generate an honest 3-5 sentence assessment. Return ONLY: {"debrief":"3-5 sentence honest assessment referencing specific results and patterns from their practice history","focusArea":"the single most impactful thing to work on before the real exam"}`,
      maxTokens: 400
    };
    const raw = await callAI(debriefPrompt);
    const result = parseAIJson(raw);
    document.getElementById('mr-debrief-loading').classList.add('hidden');
    document.getElementById('mr-debrief').textContent = result.debrief || '';
    document.getElementById('mr-debrief').classList.remove('hidden');
    if (result.focusArea) {
      document.getElementById('mr-debrief').innerHTML +=
        `<div class="mock-focus-pill">Before your real exam: ${result.focusArea}</div>`;
    }
  } catch {
    document.getElementById('mr-debrief-loading').classList.add('hidden');
    document.getElementById('mr-debrief').textContent = 'Assessment unavailable — check your connection.';
    document.getElementById('mr-debrief').classList.remove('hidden');
  }
}

export async function goToMockHistory() {
  goTo('s-fullmock-history');
  document.getElementById('mock-history-loading').classList.remove('hidden');
  document.getElementById('mock-history-list').innerHTML = '';
  document.getElementById('mock-history-trend').classList.add('hidden');

  const mocks = studentData?.mockHistory || [];
  document.getElementById('mock-history-loading').classList.add('hidden');

  if (!mocks.length) {
    document.getElementById('mock-history-list').innerHTML =
      '<p style="font-size:13px;color:var(--muted);text-align:center;padding:40px 0">No mock tests taken yet.</p>';
    return;
  }

  // Simple text-based trend chart
  const trendEl = document.getElementById('mock-history-trend');
  trendEl.classList.remove('hidden');
  const maxBand = 9, minBand = 4;
  const chartHtml = mocks.slice(-8).map((m, i) => {
    const pct = Math.round(((m.overall - minBand) / (maxBand - minBand)) * 100);
    return `<div class="mht-bar-wrap" title="Mock ${i+1}: Band ${m.overall}">
      <div class="mht-bar" style="height:${pct}%"></div>
      <div class="mht-label">${m.overall.toFixed(1)}</div>
    </div>`;
  }).join('');
  trendEl.innerHTML = `<div class="mock-history-trend-label">Band Score Trend</div><div class="mht-bars">${chartHtml}</div>`;

  document.getElementById('mock-history-list').innerHTML = [...mocks].reverse().map((m, i) => {
    const d = m.date ? new Date(m.date).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' }) : '—';
    return `<div class="mock-history-item">
      <div class="mhi-date">${d}</div>
      <div class="mhi-scores">
        ${[['Reading',m.reading],['Listening',m.listening],['Writing',m.writing],['Speaking',m.speaking]].filter(([,v])=>v!=null).map(([l,v])=>`<span class="mhi-score">${l}: ${v.toFixed(1)}</span>`).join('')}
      </div>
      <div class="mhi-overall">Band ${m.overall.toFixed(1)}</div>
    </div>`;
  }).join('');
}
window.goToMockHistory = goToMockHistory;
