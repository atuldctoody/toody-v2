// modules/ui.js
// Shared UI helpers, briefing flow, IELTS overview modal, tip screen.

import { doc, updateDoc } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { auth, db, updateStudentDoc } from './firebase.js';
import { studentData, currentUser, getIELTSSkills, buildContextSnippet, callAI } from './state.js';
import { goTo, _updateBackBtn } from './router.js';
import { parseAIJson, renderMarkdown } from './utils.js';
import { loadTeachFirst } from './teach-first.js';

// ── BRIEFING STATE ────────────────────────────────────────────────
export let briefingCard = 0;
const BRIEFING_COLORS = ['var(--danger-light)','var(--success-light)','var(--yellow-light)','var(--accent-light)'];

// ── IELTS OVERVIEW STATE ──────────────────────────────────────────
export let ieltsCard = 0;
let _ieltsModalShownThisSession = false; // set once, never reset — process-lifetime guarantee
const IELTS_COLORS = ['#F4F4F9'];

// ── TIP STATE ─────────────────────────────────────────────────────
let tipNotebookFn = null;
export function setTipNotebookFn(fn) { tipNotebookFn = fn; }
export function resetIeltsModalGuard() { _ieltsModalShownThisSession = false; }

// ── TOAST ─────────────────────────────────────────────────────────
export function showToast(message, duration = 3000) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const pill = document.createElement('div');
  pill.className = 'toast-pill';
  pill.textContent = message;
  container.appendChild(pill);
  setTimeout(() => {
    pill.classList.add('fade-out');
    setTimeout(() => pill.remove(), 320);
  }, duration);
}

// ── SAFE CLICK — async button wrapper ────────────────────────────
// Disables the button, runs an async fn, re-enables on completion or error.
// Prevents stuck-disabled buttons when async calls throw silently.
export function safeClick(btn, asyncFn) {
  if (btn.disabled) return;
  btn.disabled = true;
  btn.style.opacity = '0.7';

  Promise.resolve()
    .then(() => asyncFn())
    .catch(err => {
      console.error('safeClick error:', err);
      showToast('Something went wrong — please try again', 'error');
    })
    .finally(() => {
      btn.disabled = false;
      btn.style.opacity = '1';
    });
}
window.safeClick = safeClick;

// Expandable briefing/IELTS overview pill — only one open at a time per card
export function togglePill(el) {
  const isOpen = el.classList.contains('open');
  el.closest('.bc-pills').querySelectorAll('.bc-pill-exp.open').forEach(p => p.classList.remove('open'));
  if (!isOpen) el.classList.add('open');
}
window.togglePill = togglePill;

// IELTS modal expandable cards — independent toggle, any number open at once
export function toggleCard(el) {
  el.classList.toggle('expanded');
}
window.toggleCard = toggleCard;

// ── SKILL BAR ────────────────────────────────────────────────────
export function setSkillBar(barId, pctId, pct) {
  const bar   = document.getElementById(barId);
  const pctEl = document.getElementById(pctId);
  if (!bar || !pctEl) return;
  if (pct === null) {
    bar.className   = 'skill-bar';
    bar.style.width = '0%';
    pctEl.textContent = '—';
  } else {
    bar.className   = `skill-bar ${pct >= 80 ? 'strong' : pct >= 50 ? 'medium' : 'weak'}`;
    bar.style.width = pct + '%';
    pctEl.textContent = pct + '%';
  }
}

// ── BEHAVIOUR ANALYTICS ───────────────────────────────────────────
export function renderBehaviourAnalytics() {
  const el = document.getElementById('progress-behaviour-section');
  if (!el) return;
  const brain = studentData?.brain || {};
  const sessions = brain.totalSessions || 0;

  if (sessions < 2) {
    el.innerHTML = '<p style="font-size:13px;color:var(--muted)">Complete a few sessions to see your study patterns.</p>';
    return;
  }

  const avgTime   = brain.avgTimePerQuestionSec || 0;
  const scrollPct = brain.scrollsBackPct        || 0;
  const changePct = brain.changesAnswersPct      || 0;

  const timeBar  = Math.min(Math.round((avgTime / 120) * 100), 100);
  const timeNote = avgTime < 30 ? 'Fast pace — good instinct'
                 : avgTime < 60 ? 'Considered pace'
                 : 'Slow and thorough — may need to speed up';
  const scrollNote = scrollPct > 70 ? 'Re-reads passage a lot'
                   : scrollPct > 30 ? 'Re-reads when unsure'
                   : 'Trusts first read';
  const changeNote = changePct > 60 ? 'Often second-guesses yourself'
                   : changePct > 20 ? 'Occasionally reconsiders'
                   : 'Confident in first answer';

  el.innerHTML = `
    <div class="behaviour-metric">
      <div class="bm-label">⏱ Time per question</div>
      <div class="bm-bar-track"><div class="bm-bar" style="width:${timeBar}%"></div></div>
      <div class="bm-meta">
        <span class="bm-value">${avgTime}s avg</span>
        <span class="bm-note">${timeNote}</span>
      </div>
    </div>
    <div class="behaviour-metric">
      <div class="bm-label">🔁 Re-reads passage</div>
      <div class="bm-bar-track"><div class="bm-bar" style="width:${scrollPct}%"></div></div>
      <div class="bm-meta">
        <span class="bm-value">${scrollPct}% of sessions</span>
        <span class="bm-note">${scrollNote}</span>
      </div>
    </div>
    <div class="behaviour-metric">
      <div class="bm-label">✏️ Changes answers</div>
      <div class="bm-bar-track"><div class="bm-bar" style="width:${changePct}%"></div></div>
      <div class="bm-meta">
        <span class="bm-value">${changePct}% of sessions</span>
        <span class="bm-note">${changeNote}</span>
      </div>
    </div>`;
}

// ── DAY 1 BRIEFING ───────────────────────────────────────────────
export function initBriefing() {
  briefingCard = 0;
  document.querySelectorAll('#s-briefing .bc').forEach((c, i) => {
    c.classList.toggle('active', i === 0);
    c.classList.toggle('hidden', i !== 0);
    c.style.animation = '';
  });
  _setBriefingBg(0);
  _updateBriefingDots(0);
  goTo('s-briefing');
}

export function _setBriefingBg(idx) {
  const wrap = document.getElementById('s-briefing');
  if (wrap) wrap.style.background = BRIEFING_COLORS[idx] || 'var(--accent-light)';
}

export function _updateBriefingDots(idx) {
  document.querySelectorAll('#briefing-dots .bc-dot').forEach((d, i) => {
    d.classList.toggle('active', i === idx);
    d.classList.toggle('done', i < idx);
  });
  _updateBackBtn('s-briefing');
}

export function _showBriefingCard(nextIdx, direction) {
  const currEl = document.getElementById(`bc-${briefingCard}`);
  const nextEl = document.getElementById(`bc-${nextIdx}`);
  if (!currEl || !nextEl) return;

  // Hide current
  currEl.classList.remove('active');
  currEl.classList.add('hidden');
  currEl.style.animation = '';

  // Animate next in
  nextEl.classList.remove('hidden');
  nextEl.style.animation = 'none';
  nextEl.offsetHeight; // force reflow
  nextEl.style.animation = direction === 'back' ? 'bc-enter-back 0.3s ease' : 'bc-enter-fwd 0.3s ease';
  nextEl.classList.add('active');

  briefingCard = nextIdx;
  _setBriefingBg(nextIdx);
  _updateBriefingDots(nextIdx);
  const nextBriefingBtn = document.querySelector('#bc-' + nextIdx + ' button');
  if (nextBriefingBtn) nextBriefingBtn.disabled = false;
}

export function nextBriefingCard() { _showBriefingCard(briefingCard + 1, 'forward'); }
window.nextBriefingCard = nextBriefingCard;

export async function finishBriefing() {
  console.log('finishBriefing called');
  if (window._finishBriefingRunning) return;
  window._finishBriefingRunning = true;
  const btn = document.getElementById('bc2-btn');
  if (btn) btn.disabled = true;
  try {
    await updateStudentDoc(currentUser.uid, { briefingSeen: true });
    if (studentData) studentData.briefingSeen = true;
  } catch (e) {
    /* Firestore write failed — briefingSeen still set in memory */
    if (studentData) studentData.briefingSeen = true;
  }
  window._finishBriefingRunning = false;
  showIELTSModal();
}
window.finishBriefing = finishBriefing;

// ── IELTS OVERVIEW MODAL (one-time, after briefing) ───────────────
// Modal overlay — outside the navigation stack entirely. Cannot be
// triggered by goTo(), auth state changes, or back-button history.
export function showIELTSModal() {
  if (document.getElementById('ielts-modal').style.display === 'block') return;
  if (_ieltsModalShownThisSession) return;                               // process-lifetime guard — immune to DOM/localStorage state
  _ieltsModalShownThisSession = true;
  if (localStorage.getItem('hasSeenIELTSOverview') === 'true') return;  // returning user on same device
  localStorage.setItem('hasSeenIELTSOverview', 'true');

  // Fire-and-forget Firestore write — intentionally not awaited
  if (auth.currentUser) {
    updateDoc(doc(db, 'students', auth.currentUser.uid), { hasSeenIELTSOverview: true })
      .catch(() => { /* non-critical — localStorage guard still active */ });
  }
  if (studentData) studentData.hasSeenIELTSOverview = true;

  // Reset card state
  ieltsCard = 0;
  const modal = document.getElementById('ielts-modal');
  document.querySelectorAll('#ielts-modal .bc').forEach((c, i) => {
    c.classList.toggle('active', i === 0);
    c.classList.toggle('hidden', i !== 0);
    c.style.animation = '';
  });
  modal.style.background = IELTS_COLORS[0];
  document.querySelectorAll('#ielts-modal .bc-dot').forEach((d, i) => {
    d.classList.toggle('active', i === 0);
    d.classList.remove('done');
  });
  const backBtn = document.getElementById('ielts-modal-back');
  if (backBtn) backBtn.classList.add('hidden');

  modal.style.display = 'block';
  window.scrollTo(0, 0);
}

export function hideIELTSModal() {
  const modal = document.getElementById('ielts-modal');
  if (modal) modal.style.display = 'none';
}

export function nextIELTSCard() { _showIELTSCard(ieltsCard + 1, 'forward'); }
window.nextIELTSCard = nextIELTSCard;

export function _showIELTSCard(nextIdx, direction) {
  const currEl = document.getElementById(`ic-${ieltsCard}`);
  const nextEl = document.getElementById(`ic-${nextIdx}`);
  if (!currEl || !nextEl) return;
  currEl.classList.remove('active'); currEl.classList.add('hidden'); currEl.style.animation = '';
  nextEl.classList.remove('hidden');
  nextEl.style.animation = 'none';
  nextEl.offsetHeight;
  nextEl.style.animation = direction === 'back' ? 'bc-enter-back 0.3s ease' : 'bc-enter-fwd 0.3s ease';
  nextEl.classList.add('active');
  ieltsCard = nextIdx;
  document.getElementById('ielts-modal').style.background = IELTS_COLORS[nextIdx] || IELTS_COLORS[0];
  document.querySelectorAll('#ielts-modal .bc-dot').forEach((d, i) => {
    d.classList.toggle('active', i === nextIdx);
    d.classList.toggle('done', i < nextIdx);
  });
  const backBtn = document.getElementById('ielts-modal-back');
  if (backBtn) backBtn.classList.toggle('hidden', nextIdx === 0);
  const nextIELTSBtn = document.querySelector('#ic-' + nextIdx + ' button');
  if (nextIELTSBtn) nextIELTSBtn.disabled = false;
}

export function finishIELTSOverview() {
  console.log('finishIELTSOverview called');
  if (window._finishIELTSOverviewRunning) return;
  window._finishIELTSOverviewRunning = true;
  const btn = document.getElementById('ic-last-btn');
  if (btn) btn.disabled = true;
  hideIELTSModal();
  loadTeachFirst('reading-tfng');
}
window.finishIELTSOverview = finishIELTSOverview;

// ── TIP SCREEN ────────────────────────────────────────────────────
export async function showSessionTip({ accuracy, behaviour, missedSubTypes, skillKey }) {
  tipNotebookFn = tipNotebookFn || null;
  goTo('s-tip');
  document.getElementById('tip-loading').classList.remove('hidden');
  document.getElementById('tip-content').classList.add('hidden');
  document.getElementById('tip-done-btn').classList.add('hidden');
  document.getElementById('tip-action-pill').classList.add('hidden');

  const ctx            = buildContextSnippet();
  const ieltsSkillsForTip = getIELTSSkills();
  const topMissed = Object.entries(missedSubTypes || {})
    .sort((a,b) => b[1] - a[1]).map(e => e[0])[0] || 'N/A';

  const prompt = {
    role: 'user',
    content: `You are Toody, an IELTS Academic coach. A student just completed a ${skillKey} session.

Student context: ${ctx}
- Avg time per question: ${behaviour?.avgTimePerQuestionSec || '?'}s
- Scrolled back to passage: ${behaviour?.scrollsBackCount || 0} times
- Changed answers: ${behaviour?.answerChangesCount || 0} times
- Accuracy: ${accuracy}%
- Missed sub-types: ${JSON.stringify(missedSubTypes || {})}
- Known weak area: ${topMissed}

Generate a personalised coaching tip. Return ONLY this JSON:
{
  "observation": "one sentence about a specific behaviour pattern from this session",
  "revelation": "one sentence explaining what that pattern reveals about their current approach",
  "action": "one concrete thing they can do differently in their next session",
  "nextSessionInstruction": "max 12 words — the single most important focus for next session"
}`
  };

  try {
    const raw = await callAI(prompt);
    const tip = parseAIJson(raw);
    document.getElementById('tip-text').innerHTML =
      renderMarkdown([tip.observation, tip.revelation, tip.action].filter(Boolean).join(' '));
    if (tip.nextSessionInstruction) {
      document.getElementById('tip-action-text').textContent = tip.nextSessionInstruction;
      document.getElementById('tip-action-pill').classList.remove('hidden');
    }
    document.getElementById('tip-loading').classList.add('hidden');
    document.getElementById('tip-content').classList.remove('hidden');
    document.getElementById('tip-done-btn').classList.remove('hidden');
  } catch {
    if (tipNotebookFn) { tipNotebookFn(); tipNotebookFn = null; }
  }
}

export function finishTip() {
  if (tipNotebookFn) { tipNotebookFn(); tipNotebookFn = null; }
}
window.finishTip = finishTip;
