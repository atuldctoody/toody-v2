// modules/dev-tools.js
// Dev panel and jump tools (testing only — not visible to students).
//
// Structural adaptations:
//   currentPlan = X               → setCurrentPlan(X)
//   _ieltsModalShownThisSession = false → resetIeltsModalGuard()
//   (rebinding cross-module let vars requires exported setter functions)

import { signOut } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { doc, deleteDoc } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { SKILL_MAP, SKILL_CATALOGUE } from './constants.js';
import { studentData, currentUser } from './state.js';
import { goTo, currentPlan, setCurrentPlan } from './router.js';
import { db, auth } from './firebase.js';
import { _attachLongPress } from './utils.js';
import { initOnboarding } from './auth.js';
import {
  showIELTSModal, initBriefing, resetIeltsModalGuard,
} from './ui.js';
import { loadTeachFirst } from './teach-first.js';
import { loadReadingSession } from './session-reading.js';
import { loadListeningSession } from './session-listening.js';
import { loadWritingSession } from './session-writing.js';
import { loadSpeakingSession } from './session-speaking.js';
import { renderNotebook } from './notebook.js';
import { renderHome, renderSkillPicker } from './home.js';
import { setupMiniMock } from './mock.js';

// ── DEV TOOLS (testing only — not visible to students) ───────────
export function initDevTools() {
  // Logo long-press on every screen → open the dev panel
  document.querySelectorAll('.dev-logo-trigger').forEach(el => {
    _attachLongPress(el, 3000, () => {
      const panel = document.getElementById('dev-panel-overlay');
      if (panel) panel.style.display = 'block';
    });
  });

  // Streak long-press → skip onboarding/briefing and jump straight to home
  _attachLongPress(document.getElementById('home-streak'), 3000, () => {
    if (!studentData) return;
    renderHome();
    goTo('s-home');
  });
}
window.initDevTools = initDevTools;

export function closeDevPanel() {
  const panel = document.getElementById('dev-panel-overlay');
  if (panel) panel.style.display = 'none';
}
window.closeDevPanel = closeDevPanel;

export function devJumpTo(target) {
  closeDevPanel();
  sessionStorage.setItem('devMode', 'true');

  // Ensure a default plan is set so load functions have a valid currentPlan
  if (!currentPlan) setCurrentPlan(SKILL_MAP['reading.tfng'] || SKILL_CATALOGUE[0]);

  switch (target) {
    case 'reading':
      setCurrentPlan({ ...SKILL_MAP['reading.tfng'], reason: 'Dev jump' });
      loadReadingSession();
      break;
    case 'listening':
      setCurrentPlan({ ...SKILL_MAP['listening.multipleChoice'], reason: 'Dev jump' });
      loadListeningSession();
      break;
    case 'writing':
      setCurrentPlan({ ...SKILL_MAP['writing.task2'], reason: 'Dev jump' });
      loadWritingSession();
      break;
    case 'speaking':
      setCurrentPlan({ ...SKILL_MAP['speaking.part1'], reason: 'Dev jump' });
      loadSpeakingSession();
      break;
    case 'teachfirst':
      loadTeachFirst('reading.tfng');
      break;
    case 'notebook':
      renderNotebook(3, 5, 'reading.tfng');
      goTo('s-notebook');
      break;
    case 'mock':
      setupMiniMock();
      goTo('s-minimock');
      break;
    case 'ieltsmodal': {
      // Bypass show-once guards for dev inspection
      resetIeltsModalGuard();
      localStorage.removeItem('hasSeenIELTSOverview');
      showIELTSModal();
      break;
    }
    case 'briefing':
      // Clear show-once guards so the "Show me the overview" button works correctly
      resetIeltsModalGuard();
      localStorage.removeItem('hasSeenIELTSOverview');
      initBriefing();
      break;
  }
}
window.devJumpTo = devJumpTo;

export async function devResetAccount() {
  if (!confirm('Reset account? This deletes all Firestore data and signs out.')) return;
  try {
    if (currentUser) await deleteDoc(doc(db, 'students', currentUser.uid));
  } catch { /* non-fatal */ }
  localStorage.clear();
  try { await signOut(auth); } catch { /* non-fatal */ }
  window.location.href = 'index.html';
}
window.devResetAccount = devResetAccount;
