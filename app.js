import { getVisionPrompt }  from './api/vision-prompt.js';
// NOTE: verifyAnswers and checkExplanations are loaded via dynamic import() inside
// their call sites to prevent a module-load failure from breaking the entire app.
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';


// ── CONSTANTS ────────────────────────────────────────────────────
import {
  API_URL, TRANSCRIBE_URL, AUDIO_URL,
  SKILL_CATALOGUE, SKILL_MAP,
  HOOK_TRAP, TFNG_WORKED_EXAMPLES, SKILL_MANIFEST,
} from './modules/constants.js';

// ── UTILITIES ────────────────────────────────────────────────────
import {
  getSkillConfig, toSkillId, withRetry, parseAIJson,
  renderMarkdown, boldify, normaliseAnswer, accToBand,
  getExamDaysRemaining, rawScoreToBand, base64ToBlob, _attachLongPress,
} from './modules/utils.js';

// ── STATE ─────────────────────────────────────────────────────────
import {
  currentUser, studentData, setCurrentUser, setStudentData,
  getIELTSSkills, setIELTSSkillLocal, calcBandEstimate, isMockUnlocked,
  saveLearningStyleSignal, updateStudentBrain, updateWeakAreas,
  buildContextSnippet, callAI,
} from './modules/state.js';

// ── ROUTER ───────────────────────────────────────────────────────
import {
  screenHistory, currentScreen, currentPlan, setCurrentPlan,
  pickNextSkill, goTo, _updateBackBtn, goBack,
  pickSkill, goToSession, launchSkillScreen, goToHome,
} from './modules/router.js';

// ── FIREBASE ──────────────────────────────────────────────────────
import {
  auth, db,
  getStudentDoc, createStudentDoc, createSkeletonDoc,
  updateStudentDoc, saveSessionDoc, generateAndSaveNarrative,
} from './modules/firebase.js';

// ── AUTH ──────────────────────────────────────────────────────────
import {
  bootApp, showBootError, initOnboarding,
  showObStep, obSetName, obSetPurpose, updateBandSlider,
  setExamDate, skipExamDate, obPickExperience,
  finishOnboarding, signOutUser,
} from './modules/auth.js';

// ── UI ────────────────────────────────────────────────────────────
import {
  showToast, safeClick, togglePill, toggleCard,
  setSkillBar, renderBehaviourAnalytics,
  initBriefing, _setBriefingBg, _updateBriefingDots, _showBriefingCard,
  nextBriefingCard, finishBriefing,
  showIELTSModal, hideIELTSModal, nextIELTSCard, _showIELTSCard,
  finishIELTSOverview, showSessionTip, finishTip,
} from './modules/ui.js';

// ── HOME ──────────────────────────────────────────────────────────
import {
  renderHome, renderSkillPicker, renderSkillSnapshot,
  startSession, buildExpectations, goToProgress,
} from './modules/home.js';

// ── TEACH FIRST ───────────────────────────────────────────────────
import { loadTeachFirst } from './modules/teach-first.js';

// ── SESSION READING ───────────────────────────────────────────────
import {
  loadWarmup, loadReadingSession,
  startSessionTracking, trackQStart, trackQAnswer, trackAnswerChange,
  setupScrollTracking, getBehaviourPayload, computeConfidenceMetrics,
  renderSCSession, submitSCSession, renderReadingSession,
  buildToughLove, renderToughLove, finishReadingSession,
} from './modules/session-reading.js';

// ── SESSION LISTENING ─────────────────────────────────────────────
import {
  loadListeningSession, fetchListeningAudio, setupAudioPlayer,
  updateAudioProgress, showListeningQuestionsGate,
  submitListening, finishListeningSession,
} from './modules/session-listening.js';

// ── SESSION WRITING ───────────────────────────────────────────────
import {
  loadWritingSession, renderWritingChart, updateWordCount,
  submitWriting, finishWritingSession,
  writingBandEst, writingResponse,
} from './modules/session-writing.js';

// ── SESSION SPEAKING ──────────────────────────────────────────────
import {
  loadSpeakingSession, startRecording, stopRecording,
  transcribeAudio, evaluateSpeaking, finishSpeakingSession,
  speakingBandEst, recordSeconds,
} from './modules/session-speaking.js';

// ── NOTEBOOK ──────────────────────────────────────────────────────
import {
  renderWeek1Report, renderNotebook,
  renderNotebookWriting, renderNotebookSpeaking, renderTomorrowCard,
} from './modules/notebook.js';

// ── MOCK ──────────────────────────────────────────────────────────
import {
  loadFocusedDrill, setupMiniMock, startMiniMock, runMockPhase, showMockResults,
  startFullMockSetup, selectMockOption, startFullMockGeneration,
  mockAnswer, mockWritingInput, toggleMockRecording, submitMockSection,
  goToMockHistory,
  mockMode, mockPhase, mockResults,
} from './modules/mock.js';

// ── DEV TOOLS ─────────────────────────────────────────────────────
import { initDevTools } from './modules/dev-tools.js';

// ── AUTH ─────────────────────────────────────────────────────────
onAuthStateChanged(auth, async user => {
  if (!user) {
    window.location.href = 'index.html';
    return;
  }
  setCurrentUser(user);
  window._finishBriefingRunning = false;
  window._finishIELTSOverviewRunning = false;
  window._finishListeningRunning = false;
  window._finishSpeakingRunning = false;
  initDevTools();
  await bootApp();
});


