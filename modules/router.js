// modules/router.js
// Navigation routing and skill-selection logic.
//
// Forward references (resolved when their modules are created):
//   showToast, setupMiniMock, loadTeachFirst, loadWarmup, renderHome,
//   renderSkillPicker, loadReadingSession, loadListeningSession,
//   loadWritingSession, loadSpeakingSession — session/home loaders still in app.js

import { SKILL_CATALOGUE, SKILL_MAP, SKILL_MANIFEST } from './constants.js';
import { getSkillConfig, getExamDaysRemaining, toSkillId } from './utils.js';
import { studentData, getIELTSSkills } from './state.js';
import { briefingCard, ieltsCard, _showBriefingCard, _showIELTSCard } from './ui.js';

// ── NAVIGATION STATE ──────────────────────────────────────────────
export const screenHistory = [];
export let   currentScreen = null;
let   _goingBack    = false;
const NO_HISTORY_SCREENS = new Set(['s-loading','s-onboarding','s-welcome','s-home','s-phase2','s-briefing']);

// ── CURRENT PLAN ──────────────────────────────────────────────────
export let currentPlan = null;
export function setCurrentPlan(plan) { currentPlan = plan; }

// ── ADAPTIVE SKILL PICKER ─────────────────────────────────────────
export function pickNextSkill(forceSkillKey) {
  if (forceSkillKey) {
    const found = SKILL_MAP[forceSkillKey];
    if (found) return { ...found, reason: 'You selected this skill.' };
  }
  const daysToExam = getExamDaysRemaining();
  if (daysToExam !== null && daysToExam >= 0 && daysToExam <= 7) {
    return { skill: 'minimock', screen: null, section: 'Mock', label: 'Mini Mock', icon: '🏁',
      desc: 'Full timed session across all 4 sections.',
      reason: `Only ${daysToExam} day${daysToExam === 1 ? '' : 's'} until your exam — full mock practice now.` };
  }

  const skills = getIELTSSkills();
  const recentSkills = studentData?.recentSkills || [];
  const lastSkill = recentSkills[0] || null;

  // Section recency: how many sessions ago was each section last practiced
  const sectionLastIdx = {};
  SKILL_CATALOGUE.forEach(s => {
    const idx = recentSkills.indexOf(s.skill);
    const prev = sectionLastIdx[s.section];
    sectionLastIdx[s.section] = prev === undefined ? (idx === -1 ? 99 : idx) : Math.min(prev, idx === -1 ? 99 : idx);
  });

  const scored = SKILL_CATALOGUE.map(s => {
    const id = toSkillId(s.skill);
    const data = skills[id] || {};
    return { ...s, id, data,
      accuracy:  data.accuracy  ?? null,
      attempted: data.attempted || 0,
      isStrong:  data.isStrong  || false,
      isLast:    s.skill === lastSkill,
    };
  });

  let candidates = scored.filter(s => !s.isLast && !s.isStrong);
  if (!candidates.length) candidates = scored.filter(s => !s.isLast);
  if (!candidates.length) candidates = scored;

  // 1) Never-attempted first — section-aware, deterministic
  const never = candidates.filter(s => s.attempted === 0);
  if (never.length) {
    // Determine the last-played section so we can prefer staying in it
    const lastSection = lastSkill
      ? (SKILL_CATALOGUE.find(s => s.skill === lastSkill)?.section || null)
      : null;

    // Stay in the same section unless:
    //   (a) every skill in that section has been attempted at least once, OR
    //   (b) the section's average accuracy is already 75%+
    let staySameSection = false;
    if (lastSection) {
      const sectionSkills = scored.filter(s => s.section === lastSection);
      const allAttempted  = sectionSkills.every(s => s.attempted > 0);
      const attemptedInSection = sectionSkills.filter(s => s.attempted > 0);
      const sectionAcc = attemptedInSection.length
        ? Math.round(attemptedInSection.reduce((sum, s) => sum + (s.accuracy || 0), 0) / attemptedInSection.length)
        : 0;
      staySameSection = !allAttempted && sectionAcc < 75;
    }

    // Stable sort: same-section group first, then SKILL_CATALOGUE order as tiebreaker
    const catalogueIndex = Object.fromEntries(SKILL_CATALOGUE.map((s, i) => [s.skill, i]));
    const pick = never.sort((a, b) => {
      const aGroup = (staySameSection && a.section === lastSection) ? 0 : 1;
      const bGroup = (staySameSection && b.section === lastSection) ? 0 : 1;
      if (aGroup !== bGroup) return aGroup - bGroup;
      return (catalogueIndex[a.skill] ?? 99) - (catalogueIndex[b.skill] ?? 99);
    })[0];
    return { ...pick, reason: `You haven't tried ${pick.label} yet — let's see where you start.` };
  }

  // 2) Section rotation: if any section not practiced in 3+ sessions, prioritise it
  const starved = Object.entries(sectionLastIdx).filter(([, i]) => i >= 3).sort((a, b) => b[1] - a[1]);
  if (starved.length) {
    const sc = candidates.filter(s => s.section === starved[0][0]);
    if (sc.length) {
      const pick = sc.sort((a, b) => (a.accuracy ?? -1) - (b.accuracy ?? -1))[0];
      return { ...pick, reason: `It's been a while since ${pick.section} — let's keep all sections sharp.` };
    }
  }

  // 3) Lowest accuracy
  candidates.sort((a, b) => (a.accuracy ?? -1) - (b.accuracy ?? -1));
  const pick = candidates[0];
  let reason;
  if (pick.accuracy === null)      reason = `You haven't tried ${pick.label} yet.`;
  else if (pick.accuracy < 50)     reason = `Your ${pick.label} accuracy is ${pick.accuracy}% — biggest opportunity right now.`;
  else if (pick.accuracy < 70)     reason = `Your ${pick.label} accuracy is ${pick.accuracy}% — still below target. Let's close that gap.`;
  else                             reason = `Keeping ${pick.label} sharp — ${pick.accuracy}% is good but there's still room.`;
  return { ...pick, reason };
}

// ── CORE NAVIGATION ───────────────────────────────────────────────
export function goTo(id) {
  // Push current screen to history (unless going back, or it's a non-navigable screen)
  if (!_goingBack) {
    const current = document.querySelector('.screen.active')?.id;
    if (current && !NO_HISTORY_SCREENS.has(current) && current !== id) {
      screenHistory.push(current);
    }
  }
  _goingBack = false;

  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add('active');
  const computed = window.getComputedStyle(el).display;
  if (computed === 'none') el.style.display = 'flex';
  // Reset history when returning to home
  if (id === 's-home') screenHistory.length = 0;

  currentScreen = id;

  // Reset primary CTA buttons on screen entry — no screen inherits disabled state from a previous visit
  {
    const _rb = (btnId) => {
      const b = document.getElementById(btnId);
      if (!b) return;
      b.disabled = false;
      b.style.opacity = '';
      b.style.pointerEvents = '';
      b.classList.remove('disabled', 'loading', 'btn-loading');
    };
    if (id === 's-session-intro') _rb('btn-ready');
    if (id === 's-reading')       _rb('btn-reading-submit');
    if (id === 's-listening')     _rb('listening-finish-btn');
    if (id === 's-writing')       _rb('btn-writing-submit');
    if (id === 's-speaking')      _rb('speaking-finish-btn');
    if (id === 's-teach')         _rb('teach-start-session-btn');
    if (id === 's-toughlove') {
      _rb('btn-tl-continue');
      document.querySelectorAll('.hint-btn').forEach(b => {
        b.disabled = false; b.style.opacity = ''; b.style.pointerEvents = '';
        b.classList.remove('disabled', 'loading', 'btn-loading');
      });
    }
  }

  _updateBackBtn(id);
  window.scrollTo(0, 0);
}

export function _updateBackBtn(screenId) {
  const btn = document.getElementById('global-back-btn');
  if (!btn) return;
  const show = screenHistory.length > 0
    || (screenId === 's-briefing' && briefingCard > 0);
  btn.classList.toggle('hidden', !show);
}

export function goBack() {
  // Modal back navigation — modal is outside the screen stack
  const modal = document.getElementById('ielts-modal');
  if (modal && modal.style.display !== 'none') {
    if (ieltsCard > 0) _showIELTSCard(ieltsCard - 1, 'back');
    return;
  }
  const cur = document.querySelector('.screen.active')?.id;
  if (cur === 's-briefing' && briefingCard > 0) { _showBriefingCard(briefingCard - 1, 'back'); return; }
  if (screenHistory.length === 0) return;
  _goingBack = true;
  let prev;
  do {
    if (screenHistory.length === 0) { _goingBack = false; return; }
    prev = screenHistory.pop();
  } while (prev === 's-briefing' && studentData?.briefingSeen);
  goTo(prev);
}
window.goBack = goBack;

// ── SKILL SESSION ROUTING ─────────────────────────────────────────
export function pickSkill(skillKey) {
  currentPlan = pickNextSkill(skillKey);
  // Update session card
  document.getElementById('today-day-label').textContent = `${currentPlan.section} · Your choice`;
  document.getElementById('today-skill').textContent     = currentPlan.label;
  document.getElementById('today-desc').textContent      = currentPlan.desc;
  document.getElementById('today-reason').textContent    = '';
  // Refresh picker to show new active
  renderSkillPicker();
}
window.pickSkill = pickSkill;

export function goToSession(forceSkillKey) {
  const plan = currentPlan || pickNextSkill(forceSkillKey);
  currentPlan = plan;
  const sessionCount = studentData?.sessions?.length || 0;

  // Update all screen session badges to show session count
  const badge = `Session ${sessionCount + 1}`;
  ['warmup','reading','listening','writing','speaking','nb'].forEach(id => {
    const el = document.getElementById(`${id}-day-badge`);
    if (el) el.textContent = badge;
  });

  // Special plan types
  if (plan.skill === 'minimock') { setupMiniMock(); goTo('s-minimock'); return; }

  // Prerequisite gate — blocks first-time access to locked skills
  const _skillId = toSkillId(plan.skill || '');
  const _mEntry  = SKILL_MANIFEST[_skillId];
  if (_mEntry?.prerequisite && _mEntry?.accuracyGate) {
    const _thisData  = getIELTSSkills()[_skillId] || {};
    const _prereqData = getIELTSSkills()[_mEntry.prerequisite] || {};
    if ((_thisData.attempted || 0) === 0 && (_prereqData.accuracy ?? 0) < _mEntry.accuracyGate) {
      showToast(`Reach ${_mEntry.accuracyGate}% on ${getSkillConfig(_mEntry.prerequisite).displayName} to unlock this skill.`);
      return;
    }
  }

  const isFirstTimeSkill = (getIELTSSkills()[toSkillId(plan.skill)]?.attempted || 0) === 0;
  const teachFirstDone = studentData[`teachFirstDone_${toSkillId(plan.skill)}`] === true;
  const shouldTeachFirst = isFirstTimeSkill && !teachFirstDone;

  // Onboarding gates (in order): briefing → teach-first
  /* debug removed */
  if (plan.screen === 's-reading' && isFirstTimeSkill && !studentData.briefingSeen) {
    renderHome(); initBriefing();
  } else if (shouldTeachFirst && plan.screen === 's-reading') {
    loadTeachFirst(plan.skill);
  } else if (sessionCount > 0 && plan.screen === 's-reading') {
    loadWarmup(plan);
  } else {
    launchSkillScreen(plan);
  }
}
window.goToSession = goToSession;

export function launchSkillScreen(plan) {
  if      (plan.screen === 's-reading')   loadReadingSession();
  else if (plan.screen === 's-listening') loadListeningSession();
  else if (plan.screen === 's-writing')   loadWritingSession();
  else if (plan.screen === 's-speaking')  loadSpeakingSession();
  else if (plan.skill  === 'minimock')    { setupMiniMock(); goTo('s-minimock'); }
  else                                    loadReadingSession();
}

export function goToHome() { renderHome(); goTo('s-home'); }
window.goToHome = goToHome;
