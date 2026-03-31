// modules/auth.js
// Authentication, boot sequence, and onboarding flow.

import { signOut } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { auth, getStudentDoc, createSkeletonDoc, updateStudentDoc } from './firebase.js';
import { currentUser, setStudentData, studentData } from './state.js';
import { goTo } from './router.js';
import { initBriefing } from './ui.js';
import { renderHome } from './home.js';

// ── ONBOARDING STATE ──────────────────────────────────────────────
let obStep          = 0;
let pendingBand     = 6.5;
let pendingDate     = null;
let pendingExperience = null;
let pendingName     = '';
let pendingPurpose  = '';
let pendingLastScore = null;

const BAND_MEANINGS = {
  '5.0': 'Modest user',
  '5.5': 'Modest user',
  '6.0': 'Competent user',
  '6.5': 'Competent user',
  '7.0': 'Good user',
  '7.5': 'Good user',
  '8.0': 'Very good user',
  '8.5': 'Very good user',
  '9.0': 'Expert user',
};

// ── BOOT ─────────────────────────────────────────────────────────
export async function bootApp() {
  try {
    const snap = await getStudentDoc(currentUser.uid);
    const data = snap.exists() ? snap.data() : null;

    // Gate: hasExperience is the ONLY field written exclusively by the new
    // 3-question onboarding (setExperience). It is:
    //   undefined  — old account that pre-dates new onboarding
    //   null       — skeleton doc created but onboarding not completed
    //   true/false — onboarding completed ✓
    // Any value other than true or false means onboarding is incomplete.
    const onboardingDone = data !== null
      && (data.hasExperience === true || data.hasExperience === false);

    if (!onboardingDone) {
      // Create skeleton doc only if no doc exists yet
      if (!snap.exists()) {
        await createSkeletonDoc(currentUser.uid);
      }
      initOnboarding();
      goTo('s-onboarding');
    } else {
      setStudentData(data);
      if (studentData.hasSeenIELTSOverview) {
        localStorage.setItem('hasSeenIELTSOverview', 'true');
      }
      renderHome();
      goTo('s-home');
    }
  } catch {
    showBootError();
  }
}
window.bootApp = bootApp;

export function showBootError() {
  const el = document.getElementById('s-loading');
  if (el) {
    el.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;gap:16px;padding:40px 24px;text-align:center">
        <div style="font-size:40px">⚠️</div>
        <p style="font-size:15px;font-weight:600;color:var(--text)">Could not connect to Toody.</p>
        <p style="font-size:13px;color:var(--muted);line-height:1.6">Check your internet connection and try again.</p>
        <button onclick="bootApp()" style="background:var(--accent);color:#fff;border:none;border-radius:var(--radius-full);padding:14px 28px;font-size:15px;font-weight:600;cursor:pointer">Retry</button>
      </div>`;
    goTo('s-loading');
  }
}

// ── ONBOARDING ───────────────────────────────────────────────────
export function initOnboarding() {
  pendingBand       = 6.5;
  pendingDate       = null;
  pendingExperience = null;
  pendingName       = currentUser.displayName?.split(' ')[0] || '';
  pendingPurpose    = '';
  pendingLastScore  = null;
  // Pre-fill name input
  const nameInput = document.getElementById('ob-name-input');
  if (nameInput) nameInput.value = pendingName;
  // Reset slider
  const slider = document.getElementById('ob-band-slider');
  if (slider) slider.value = '6.5';
  const display = document.getElementById('ob-band-display');
  if (display) display.textContent = '6.5';
  const meaning = document.getElementById('ob-band-meaning');
  if (meaning) meaning.textContent = 'Competent user';
  showObStep(0);
}

export function showObStep(n) {
  document.querySelectorAll('.ob-step').forEach(s => {
    s.classList.remove('active');
    s.classList.add('hidden');
  });
  const step = document.getElementById(`ob-${n}`);
  if (step) {
    step.classList.remove('hidden');
    step.classList.add('active');
    window.scrollTo(0, 0);
  }
  // Update dots
  document.querySelectorAll('.ob-dot').forEach((dot, i) => {
    dot.classList.toggle('active', i === n);
    dot.classList.toggle('done', i < n);
  });
  obStep = n;
}
window.showObStep = showObStep;

export function obSetName() {
  const val = document.getElementById('ob-name-input').value.trim();
  pendingName = val || currentUser.displayName?.split(' ')[0] || 'there';
  showObStep(1);
}
window.obSetName = obSetName;

export function obSetPurpose(btn) {
  pendingPurpose = btn.dataset.val;
  // Visual selection
  document.querySelectorAll('#ob-purpose-group .ob-choice-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  // Auto-advance after brief highlight
  setTimeout(() => showObStep(2), 300);
}
window.obSetPurpose = obSetPurpose;

export function updateBandSlider() {
  const val = document.getElementById('ob-band-slider').value;
  pendingBand = parseFloat(val);
  document.getElementById('ob-band-display').textContent = val;
  const meaning = document.getElementById('ob-band-meaning');
  if (meaning) meaning.textContent = BAND_MEANINGS[val] || '';
}
window.updateBandSlider = updateBandSlider;

export function setExamDate() {
  const val = document.getElementById('ob-date-input').value;
  pendingDate = val || null;
  showObStep(4);
}
window.setExamDate = setExamDate;

export function skipExamDate() {
  pendingDate = null;
  showObStep(4);
}
window.skipExamDate = skipExamDate;

export function obPickExperience(hasExperience) {
  pendingExperience = hasExperience;
  document.getElementById('ob-exp-yes').classList.toggle('selected', hasExperience === true);
  document.getElementById('ob-exp-no').classList.toggle('selected', hasExperience === false);
  if (hasExperience) {
    document.getElementById('ob-last-score-wrap').classList.remove('hidden');
  } else {
    document.getElementById('ob-last-score-wrap').classList.add('hidden');
    pendingLastScore = null;
  }
  document.getElementById('ob-finish-btn').classList.remove('hidden');
}
window.obPickExperience = obPickExperience;

export async function finishOnboarding() {
  if (pendingExperience === true) {
    const scoreEl = document.getElementById('ob-last-score');
    pendingLastScore = scoreEl?.value ? parseFloat(scoreEl.value) : null;
  }
  document.getElementById('ob-finish-btn').disabled = true;
  document.getElementById('ob-saving').classList.remove('hidden');
  document.getElementById('ob-error').classList.add('hidden');

  try {
    await updateStudentDoc(currentUser.uid, {
      preferredName:  pendingName,
      purpose:        pendingPurpose    || 'other',
      targetBand:     pendingBand       || 6.5,
      examDate:       pendingDate       || null,
      hasExperience:  pendingExperience,
      lastScore:      pendingLastScore  || null,
      isNewStudent:   false,
      currentBand:    pendingBand       || 6.5,
    });
    const snap = await getStudentDoc(currentUser.uid);
    setStudentData(snap.data());
    renderHome();
    // Show welcome screen, then go into briefing
    const welcomeName = document.getElementById('welcome-name');
    if (welcomeName) welcomeName.textContent = pendingName || 'there';
    goTo('s-welcome');
    setTimeout(() => initBriefing(), 2500);
  } catch {
    document.getElementById('ob-saving').classList.add('hidden');
    document.getElementById('ob-error').classList.remove('hidden');
    document.getElementById('ob-finish-btn').disabled = false;
  }
}
window.finishOnboarding = finishOnboarding;

// ── SIGN OUT ──────────────────────────────────────────────────────
export async function signOutUser() {
  try {
    await signOut(auth);
    window.location.href = 'index.html';
  } catch {
    window.location.href = 'index.html';
  }
}
window.signOutUser = signOutUser;
