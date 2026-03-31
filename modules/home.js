// modules/home.js
// Home screen rendering, skill picker, session intro, and progress screen.

import { SKILL_MANIFEST, SKILL_MAP } from './constants.js';
import { studentData, currentUser, getIELTSSkills, calcBandEstimate, isMockUnlocked } from './state.js';
import { goTo, pickNextSkill, setCurrentPlan, currentPlan } from './router.js';
import { getSkillConfig, getExamDaysRemaining } from './utils.js';
import { setSkillBar, renderBehaviourAnalytics } from './ui.js';
import { db } from './firebase.js';
import {
  getDocs, collection, orderBy, query,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ── HOME ─────────────────────────────────────────────────────────
export function renderHome() {
  if (!studentData) return;
  const sessionCount = (studentData.dayNumber || 1) - 1;
  const name   = studentData.preferredName || studentData.name?.split(' ')[0] || 'there';
  const streak = studentData.streak || 0;
  const target = studentData.targetBand || 6.5;
  const daysToExam = getExamDaysRemaining();
  const bandEst = calcBandEstimate();
  const mockUnlocked = isMockUnlocked();

  const hour  = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  document.getElementById('home-greeting').innerHTML = `${greet}, <span style="color:var(--accent)">${name}</span>.`;

  // Subtitle: exam countdown or generic
  let subtitle = sessionCount === 0
    ? "Let's find out where you're starting from."
    : daysToExam !== null && daysToExam >= 0
    ? `<strong style="color:var(--accent)">${daysToExam} day${daysToExam === 1 ? '' : 's'}</strong> until your exam. Every session counts.`
    : `${sessionCount} session${sessionCount !== 1 ? 's' : ''} done. Keep the streak alive.`;
  document.getElementById('home-subtitle').innerHTML = subtitle;

  document.getElementById('home-streak').textContent  = `🔥 ${streak} day${streak !== 1 ? 's' : ''}`;

  // Replace day badge with band estimate or session count
  const badgeEl = document.getElementById('home-day-badge');
  if (badgeEl) badgeEl.textContent = bandEst !== null ? `Band ~${bandEst}` : `${sessionCount} done`;

  // Band progress bar
  const progressCard = document.getElementById('home-band-progress');
  if (progressCard) {
    if (bandEst !== null) {
      const min = 5.0, span = target - min;
      const pct = span > 0 ? Math.min(100, Math.max(0, Math.round(((bandEst - min) / span) * 100))) : 100;
      document.getElementById('band-progress-fill').style.width  = `${pct}%`;
      document.getElementById('band-progress-label').textContent = `${pct}% of the way to Band ${target}`;
      document.getElementById('band-est-text').textContent       = `Current: ~${bandEst}`;
      document.getElementById('band-target-text').textContent    = `Target: ${target}`;
      progressCard.classList.remove('hidden');
    } else {
      progressCard.classList.add('hidden');
    }
  }

  // Adaptive recommendation
  setCurrentPlan(pickNextSkill());
  const sessionCard = document.getElementById('today-session-card');
  if (currentPlan.skill === 'minimock') {
    document.getElementById('today-day-label').textContent = '🏁 Exam mode';
    document.getElementById('today-skill').textContent     = 'Mini Mock Test';
    document.getElementById('today-desc').textContent      = currentPlan.desc;
    document.getElementById('today-reason').textContent    = currentPlan.reason;
    sessionCard.style.display = '';
  } else {
    document.getElementById('today-day-label').textContent = `${currentPlan.section} · Toody recommends`;
    document.getElementById('today-skill').textContent     = currentPlan.label;
    document.getElementById('today-desc').textContent      = currentPlan.desc;
    document.getElementById('today-reason').textContent    = `Why: ${currentPlan.reason}`;
    sessionCard.style.display = '';
  }

  // Final 3 days message
  const readinessCard = document.getElementById('home-readiness-card');
  if (readinessCard) {
    if (daysToExam !== null && daysToExam >= 0 && daysToExam <= 3) {
      readinessCard.classList.remove('hidden');
    } else {
      readinessCard.classList.add('hidden');
    }
  }

  // Exam countdown banner (if 4–30 days out)
  const countdownBanner = document.getElementById('home-countdown-banner');
  if (countdownBanner) {
    if (daysToExam !== null && daysToExam > 3 && daysToExam <= 30) {
      document.getElementById('countdown-days').textContent = daysToExam;
      countdownBanner.classList.remove('hidden');
    } else {
      countdownBanner.classList.add('hidden');
    }
  }

  // Skill picker grid
  renderSkillPicker();

  // Mock card
  const mockCard = document.getElementById('home-mock-card');
  if (mockCard) mockCard.style.display = mockUnlocked ? '' : 'none';

  renderSkillSnapshot();
}

export function renderSkillPicker() {
  const el = document.getElementById('home-skill-picker');
  if (!el) return;
  const skills = getIELTSSkills();
  el.innerHTML = Object.values(SKILL_MANIFEST).map(cfg => {
    const data      = skills[cfg.id] || {};
    const acc       = data.attempted > 0
      ? (data.accuracy !== undefined ? `${data.accuracy}%` : data.bandEstimate !== undefined ? `Band ${data.bandEstimate}` : '—')
      : 'Not tried';
    const isActive  = currentPlan?.skill === (cfg.catalogueKey || cfg.id);
    const isDeployed = cfg.catalogueKey !== null;

    // Lock if not deployed yet, or if first-time and prerequisite not met
    let isLocked = !isDeployed;
    if (isDeployed && cfg.prerequisite && cfg.accuracyGate) {
      const prereqData = skills[cfg.prerequisite] || {};
      if ((data.attempted || 0) === 0 && (prereqData.accuracy ?? 0) < cfg.accuracyGate) {
        isLocked = true;
      }
    }

    const lockLabel = !isDeployed
      ? 'Coming soon'
      : (cfg.prerequisite ? `Complete ${getSkillConfig(cfg.prerequisite).displayName} first` : 'Locked');

    return `<button class="skill-pick-btn${isActive ? ' active' : ''}${isLocked ? ' locked' : ''}"
      ${isLocked ? 'disabled' : `onclick="window.pickSkill('${cfg.catalogueKey}')"`}>
      <span class="spb-icon">${cfg.icon}</span>
      <span class="spb-body">
        <span class="spb-label">${cfg.displayName}</span>
        <span class="spb-acc">${isLocked ? lockLabel : acc}</span>
      </span>
    </button>`;
  }).join('');
}
window.renderSkillPicker = renderSkillPicker;

export function renderSkillSnapshot() {
  const sk = getIELTSSkills();
  const rows = [
    { label: 'T / F / Not Given',  pct: (sk['reading-tfng']?.attempted              || 0) > 0 ? sk['reading-tfng'].accuracy              : null },
    { label: 'Summ. Completion',   pct: (sk['reading-summaryCompletion']?.attempted  || 0) > 0 ? sk['reading-summaryCompletion'].accuracy  : null },
    { label: 'Multiple Choice',    pct: (sk['listening-multipleChoice']?.attempted   || 0) > 0 ? sk['listening-multipleChoice'].accuracy   : null },
    { label: 'Form Completion',    pct: (sk['listening-formCompletion']?.attempted   || 0) > 0 ? sk['listening-formCompletion'].accuracy    : null },
  ];
  const el      = document.getElementById('home-skill-snapshot');
  const anyData = rows.some(r => r.pct !== null);
  if (!anyData) {
    el.innerHTML = '<div style="font-size:13px;color:var(--muted);text-align:center;padding:10px 0">Complete your first session to see your skill data.</div>';
    return;
  }
  el.innerHTML = rows.map(r => {
    const pct = r.pct;
    return `
      <div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border);">
        <span style="font-size:13px;font-weight:400;flex:1">${r.label}</span>
        ${pct === null
          ? '<span style="font-size:11px;color:var(--muted2)">Not tested</span>'
          : `<div style="flex:1;height:5px;background:var(--border);border-radius:4px;overflow:hidden;">
               <div style="width:${pct}%;height:100%;border-radius:4px;background:${pct>=80?'var(--success)':pct>=50?'var(--yellow)':'var(--danger)'};transition:width 0.6s ease;"></div>
             </div>
             <span style="font-size:11px;font-weight:600;color:var(--muted);width:32px;text-align:right">${pct}%</span>`}
      </div>`;
  }).join('');
}

// ── SESSION INTRO ─────────────────────────────────────────────────
export function startSession() {
  if (window._startSessionRunning) return;
  window._startSessionRunning = true;
  setTimeout(() => { window._startSessionRunning = false; }, 3000);
  const plan = currentPlan || pickNextSkill();
  setCurrentPlan(plan);

  document.getElementById('si-icon').textContent    = plan.icon || '📖';
  document.getElementById('si-section').textContent = plan.section || 'Session';
  document.getElementById('si-skill').textContent   = plan.label;

  const sessionCount = (studentData?.dayNumber || 1) - 1;
  const expects = buildExpectations(sessionCount, plan.skill);
  document.getElementById('si-expect-list').innerHTML = expects
    .map(e => `<div class="expect-item"><div class="expect-icon">${e.icon}</div><div class="expect-text">${e.text}</div></div>`)
    .join('');

  goTo('s-session-intro');
}
window.startSession = startSession;

export function buildExpectations(sessionCount, skill) {
  const list = [];
  if (sessionCount > 0) list.push({ icon: '🧠', text: 'Quick memory check first — one question from a previous session.' });
  list.push({ icon: '📝', text: 'AI-generated material specific to your current band level — different every session.' });
  list.push({ icon: '💬', text: 'Instant feedback after every answer with the exact reasoning.' });
  if (sessionCount > 0) list.push({ icon: '🔍', text: 'Get one right and Toody will ask you to prove your reasoning — the Tough Love Check.' });
  return list;
}

// ── PROGRESS SCREEN ───────────────────────────────────────────────
export async function goToProgress() {
  if (!studentData) return;

  document.getElementById('prog-sessions').textContent = '…';
  document.getElementById('prog-band').textContent     = studentData.targetBand || '—';
  document.getElementById('prog-streak').textContent   = studentData.streak     || 0;

  const progSkills = getIELTSSkills();
  setSkillBar('prog-tfng-bar', 'prog-tfng-pct', (progSkills['reading-tfng']?.attempted              || 0) > 0 ? progSkills['reading-tfng'].accuracy              : null);
  setSkillBar('prog-mh-bar',   'prog-mh-pct',   (progSkills['reading-summaryCompletion']?.attempted  || 0) > 0 ? progSkills['reading-summaryCompletion'].accuracy  : null);
  setSkillBar('prog-mc-bar',   'prog-mc-pct',   (progSkills['listening-multipleChoice']?.attempted   || 0) > 0 ? progSkills['listening-multipleChoice'].accuracy    : null);
  setSkillBar('prog-fc-bar',   'prog-fc-pct',   (progSkills['listening-formCompletion']?.attempted   || 0) > 0 ? progSkills['listening-formCompletion'].accuracy     : null);

  renderBehaviourAnalytics();

  document.getElementById('progress-loading').classList.remove('hidden');
  document.getElementById('progress-session-list').innerHTML = '';
  goTo('s-progress');

  try {
    const snap = await getDocs(
      query(collection(db, 'students', currentUser.uid, 'sessions'), orderBy('date', 'desc'))
    );

    document.getElementById('prog-sessions').textContent = snap.size;
    document.getElementById('progress-loading').classList.add('hidden');

    if (snap.empty) {
      document.getElementById('progress-session-list').innerHTML =
        '<p style="font-size:13px;color:var(--muted)">No sessions yet.</p>';
      return;
    }

    document.getElementById('progress-session-list').innerHTML = snap.docs.map(d => {
      const s   = d.data();
      const day = s.dayNumber    ? `Day ${s.dayNumber}` : '—';
      const skill = (s.skillPracticed && SKILL_MAP[s.skillPracticed]?.label) || s.skillPracticed || '—';
      const score = s.accuracy != null
        ? `${s.accuracy}%`
        : s.bandEstimate != null
        ? `Band ${s.bandEstimate}`
        : '—';
      const dateStr = s.date?.toDate
        ? s.date.toDate().toLocaleDateString('en-GB', { day:'numeric', month:'short' })
        : '—';
      return `
        <div class="progress-session-item" style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border);">
          <div>
            <div style="font-size:13px;font-weight:600">${day} — ${skill}</div>
            <div style="font-size:11px;color:var(--muted)">${dateStr}</div>
          </div>
          <div style="font-size:14px;font-weight:600;color:var(--accent)">${score}</div>
        </div>`;
    }).join('');
  } catch {
    document.getElementById('progress-loading').classList.add('hidden');
    document.getElementById('progress-session-list').innerHTML =
      '<p style="font-size:13px;color:var(--danger)">Could not load session history. Check your connection.</p>';
  }
}
window.goToProgress = goToProgress;
