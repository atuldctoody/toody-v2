// modules/notebook.js
import { SKILL_MANIFEST } from './constants.js';
import {
  studentData, getIELTSSkills, calcBandEstimate, callAI,
} from './state.js';
import { goTo, pickNextSkill, currentPlan } from './router.js';
import { getSkillConfig, renderMarkdown, normaliseAnswer, accToBand } from './utils.js';
import { updateStudentDoc, db } from './firebase.js';
import { showToast, safeClick, setSkillBar } from './ui.js';
import { sessionQuestions, sessionAnswers } from './session-reading.js';
import { listenQuestions, listenAnswers } from './session-listening.js';
import { writingBandEst, writingResponse } from './session-writing.js';
import { speakingBandEst, recordSeconds } from './session-speaking.js';

// ── WEEK 1 REPORT ─────────────────────────────────────────────────
export function renderWeek1Report() {
  const day = (studentData?.dayNumber || 6) - 1;

  // Hide standard skill section, show Week 1 section
  document.getElementById('nb-skill-section').classList.add('hidden');
  document.getElementById('nb-week1-section').classList.remove('hidden');

  const w1Skills = getIELTSSkills();
  const tfng = (w1Skills['reading-tfng']?.attempted              || 0) > 0 ? w1Skills['reading-tfng'].accuracy              : null;
  const mh   = (w1Skills['reading-summaryCompletion']?.attempted  || 0) > 0 ? w1Skills['reading-summaryCompletion'].accuracy  : null;
  const mc   = (w1Skills['listening-multipleChoice']?.attempted   || 0) > 0 ? w1Skills['listening-multipleChoice'].accuracy   : null;
  const fc   = (w1Skills['listening-formCompletion']?.attempted   || 0) > 0 ? w1Skills['listening-formCompletion'].accuracy    : null;

  const scores = [tfng, mh, mc, fc].filter(s => s !== null);
  const avgBand = scores.length > 0
    ? ((scores.reduce((a, b) => a + b, 0) / scores.length) / 100 * 3 + 4.5).toFixed(1)
    : (studentData?.targetBand || 6.0).toFixed(1);

  document.getElementById('w1-band').textContent      = avgBand;
  document.getElementById('w1-band-note').textContent = `Estimated from ${scores.length} skill${scores.length !== 1 ? 's' : ''} practised this week.`;

  // Top 2 weak areas
  const skillRows = [
    { name: 'T / F / Not Given',  pct: tfng, key: 'reading.tfng' },
    { name: 'Summ. Completion',   pct: mh,   key: 'reading.summaryCompletion' },
    { name: 'Multiple Choice',    pct: mc,   key: 'listening.multipleChoice' },
    { name: 'Form Completion',    pct: fc,   key: 'listening.formCompletion' },
  ].filter(r => r.pct !== null).sort((a, b) => a.pct - b.pct);

  const weak2 = skillRows.slice(0, 2);
  const weakEl = document.getElementById('w1-weak-areas');
  weakEl.innerHTML = weak2.length
    ? weak2.map(r => `
        <div class="weak-area-item">
          <div class="weak-area-name">${r.name}</div>
          <div class="skill-bar-wrap" style="max-width:140px;display:inline-block;vertical-align:middle">
            <div class="skill-bar weak" style="width:${r.pct}%"></div>
          </div>
          <span style="font-size:11px;font-weight:600;color:var(--danger);margin-left:6px">${r.pct}%</span>
        </div>`
      ).join('')
    : '<p style="font-size:13px;color:var(--muted)">Complete more sessions to identify weak areas.</p>';

  // Week 2 plan
  const planItems = [
    { icon: '✍️', day: 6, text: `<strong>Day 6</strong> — Writing Task 1 (Graph Description)` },
    { icon: '✍️', day: 7, text: `<strong>Day 7</strong> — Writing Task 2 (Opinion Essay)` },
    { icon: '🎤', day: 8, text: `<strong>Day 8</strong> — Speaking Part 1` },
    { icon: '🎯', day: 9, text: `<strong>Day 9</strong> — Focused Drill on ${weak2[0]?.name || 'your weakest skill'}` },
    { icon: '🏁', day: 10, text: `<strong>Day 10</strong> — Mini Mock across all 4 sections` },
  ];
  document.getElementById('w1-week2-plan').innerHTML = planItems.map(p =>
    `<div class="expect-item" style="padding:6px 0">
       <div class="expect-icon">${p.icon}</div>
       <div class="expect-text" style="font-size:13px">${p.text}</div>
     </div>`
  ).join('');

  // Notebook stats
  document.getElementById('nb-questions-done').textContent = '—';
  document.getElementById('nb-streak').textContent         = studentData?.streak || 0;
  document.getElementById('nb-band-est').textContent       = studentData?.targetBand || '—';
  document.getElementById('nb-assessment').textContent     =
    `Week 1 complete. Band estimate: ${avgBand}. ${weak2.length ? `Your focus areas for Week 2: ${weak2.map(r=>r.name).join(' and ')}.` : 'Keep going — more data gives a sharper picture.'}`;

  document.getElementById('nb-worked-example').classList.add('hidden');

  const next = pickNextSkill();
  document.getElementById('nb-tomorrow-day').textContent   = `Up next — ${next.section}`;
  document.getElementById('nb-tomorrow-title').textContent = next.label;
  document.getElementById('nb-tomorrow-desc').textContent  = next.desc;
}

// ── NOTEBOOK HELPERS ──────────────────────────────────────────────
export function renderNotebook(correct, total, skillKey) {
  // Show standard section, hide week1
  document.getElementById('nb-skill-section').classList.remove('hidden');
  document.getElementById('nb-week1-section').classList.add('hidden');

  const accuracy = Math.round((correct / total) * 100);
  const streak   = studentData?.streak    || 1;
  const day      = (studentData?.dayNumber || 2) - 1;

  document.getElementById('nb-questions-done').textContent = total;
  document.getElementById('nb-streak').textContent         = streak;
  document.getElementById('nb-band-est').textContent       = studentData?.currentBand || studentData?.targetBand || '—';

  const nbSkills = getIELTSSkills();
  const isTfng  = skillKey === 'reading.tfng';
  const isSC    = skillKey === 'reading.summaryCompletion';
  const isMC    = skillKey === 'listening.multipleChoice';
  const isFC    = skillKey === 'listening.formCompletion';

  // Current session bar
  const barClass = accuracy >= 80 ? 'strong' : accuracy >= 50 ? 'medium' : 'weak';
  if (isTfng) {
    document.getElementById('nb-tfng-bar').className   = `skill-bar ${barClass}`;
    document.getElementById('nb-tfng-bar').style.width = accuracy + '%';
    document.getElementById('nb-tfng-pct').textContent = accuracy + '%';
  }
  if (isSC) {
    document.getElementById('nb-mh-bar').className   = `skill-bar ${barClass}`;
    document.getElementById('nb-mh-bar').style.width = accuracy + '%';
    document.getElementById('nb-mh-pct').textContent = accuracy + '%';
  }
  if (isMC) {
    document.getElementById('nb-mc-bar').className   = `skill-bar ${barClass}`;
    document.getElementById('nb-mc-bar').style.width = accuracy + '%';
    document.getElementById('nb-mc-pct').textContent = accuracy + '%';
  }
  if (isFC) {
    document.getElementById('nb-fc-bar').className   = `skill-bar ${barClass}`;
    document.getElementById('nb-fc-bar').style.width = accuracy + '%';
    document.getElementById('nb-fc-pct').textContent = accuracy + '%';
  }

  // Other bars from Firestore
  if (!isTfng) setSkillBar('nb-tfng-bar', 'nb-tfng-pct', (nbSkills['reading-tfng']?.attempted             || 0) > 0 ? nbSkills['reading-tfng'].accuracy              : null);
  if (!isSC)   setSkillBar('nb-mh-bar',   'nb-mh-pct',   (nbSkills['reading-summaryCompletion']?.attempted || 0) > 0 ? nbSkills['reading-summaryCompletion'].accuracy  : null);
  if (!isMC)   setSkillBar('nb-mc-bar',   'nb-mc-pct',   (nbSkills['listening-multipleChoice']?.attempted  || 0) > 0 ? nbSkills['listening-multipleChoice'].accuracy    : null);
  if (!isFC)   setSkillBar('nb-fc-bar',   'nb-fc-pct',   (nbSkills['listening-formCompletion']?.attempted  || 0) > 0 ? nbSkills['listening-formCompletion'].accuracy     : null);

  const assessment = correct === 0
    ? `${correct}/${total} — Keep going — this is how you learn.`
    : correct === total
    ? `${correct}/${total} — Excellent. You've got this skill.`
    : accuracy >= 80
    ? `${correct}/${total} — Strong session.`
    : accuracy >= 50
    ? `${correct}/${total} — Solid. Room to improve.`
    : `${correct}/${total} — This is where Toody helps most. Let's keep going.`;
  document.getElementById('nb-assessment').textContent = assessment;

  // Worked example
  const questions = isTfng || isSC ? sessionQuestions : listenQuestions;
  const answers   = isTfng || isSC ? sessionAnswers   : listenAnswers;
  const wrongQ    = questions.find(q => {
    const a = answers[q.id];
    return typeof a === 'object' ? a.isRight === false : (normaliseAnswer(a) !== normaliseAnswer(q.answer));
  });
  const weEl = document.getElementById('nb-worked-example');
  if (wrongQ) {
    weEl.classList.remove('hidden');
    document.getElementById('we-q').textContent = wrongQ.text || wrongQ.label || '';
    document.getElementById('we-exp').innerHTML  = `Answer: ${wrongQ.answer}. ${renderMarkdown(wrongQ.explanation || '')}`;
  } else {
    weEl.classList.add('hidden');
  }

}

export function renderNotebookWriting() {
  document.getElementById('nb-skill-section').classList.remove('hidden');
  document.getElementById('nb-week1-section').classList.add('hidden');

  const day    = (studentData?.dayNumber || 7) - 1;
  const streak = studentData?.streak || 1;

  document.getElementById('nb-questions-done').textContent = `${writingResponse.split(/\s+/).length} words`;
  document.getElementById('nb-streak').textContent         = streak;
  document.getElementById('nb-band-est').textContent       = writingBandEst.toFixed(1);

  const wSkills = getIELTSSkills();
  setSkillBar('nb-tfng-bar', 'nb-tfng-pct', (wSkills['reading-tfng']?.attempted             || 0) > 0 ? wSkills['reading-tfng'].accuracy              : null);
  setSkillBar('nb-mh-bar',   'nb-mh-pct',   (wSkills['reading-summaryCompletion']?.attempted || 0) > 0 ? wSkills['reading-summaryCompletion'].accuracy  : null);
  setSkillBar('nb-mc-bar',   'nb-mc-pct',   (wSkills['listening-multipleChoice']?.attempted  || 0) > 0 ? wSkills['listening-multipleChoice'].accuracy    : null);
  setSkillBar('nb-fc-bar',   'nb-fc-pct',   (wSkills['listening-formCompletion']?.attempted  || 0) > 0 ? wSkills['listening-formCompletion'].accuracy     : null);

  document.getElementById('nb-assessment').textContent =
    `Writing Band Estimate: ${writingBandEst.toFixed(1)}. ${writingBandEst >= 7 ? 'Excellent — this is exam-ready writing.' : writingBandEst >= 6 ? 'Solid foundation. One targeted improvement can push you to 7.' : 'Keep practising. Toody has noted your specific gap areas.'}`;

  document.getElementById('nb-worked-example').classList.add('hidden');
}

export function renderNotebookSpeaking() {
  document.getElementById('nb-skill-section').classList.remove('hidden');
  document.getElementById('nb-week1-section').classList.add('hidden');

  const streak = studentData?.streak || 1;
  document.getElementById('nb-questions-done').textContent = `${recordSeconds}s recorded`;
  document.getElementById('nb-streak').textContent         = streak;
  document.getElementById('nb-band-est').textContent       = speakingBandEst.toFixed(1);

  const spSkills = getIELTSSkills();
  setSkillBar('nb-tfng-bar', 'nb-tfng-pct', (spSkills['reading-tfng']?.attempted             || 0) > 0 ? spSkills['reading-tfng'].accuracy              : null);
  setSkillBar('nb-mh-bar',   'nb-mh-pct',   (spSkills['reading-summaryCompletion']?.attempted || 0) > 0 ? spSkills['reading-summaryCompletion'].accuracy  : null);
  setSkillBar('nb-mc-bar',   'nb-mc-pct',   (spSkills['listening-multipleChoice']?.attempted  || 0) > 0 ? spSkills['listening-multipleChoice'].accuracy    : null);
  setSkillBar('nb-fc-bar',   'nb-fc-pct',   (spSkills['listening-formCompletion']?.attempted  || 0) > 0 ? spSkills['listening-formCompletion'].accuracy     : null);

  document.getElementById('nb-assessment').textContent =
    `Speaking Band Estimate: ${speakingBandEst.toFixed(1)}. ${speakingBandEst >= 7 ? 'Impressive — you sound like a Band 7+ speaker.' : speakingBandEst >= 6 ? 'Good fluency. Focus on the suggestion above for your next session.' : 'Early days — every session builds your spoken fluency.'}`;

  document.getElementById('nb-worked-example').classList.add('hidden');
}

export function renderTomorrowCard() {
  const next = pickNextSkill();
  document.getElementById('nb-tomorrow-day').textContent   = `Up next — ${next.section}`;
  document.getElementById('nb-tomorrow-title').textContent = next.label;
  document.getElementById('nb-tomorrow-desc').textContent  = next.desc;
}
