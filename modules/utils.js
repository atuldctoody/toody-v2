// modules/utils.js
// Pure utility functions — no side effects, no DOM, no Firestore.
// getSkillConfig needs SKILL_MANIFEST; rawScoreToBand needs IELTS_BAND_TABLE (local).
// getExamDaysRemaining reads studentData — dependency wired via state.js in next split.

import { SKILL_MANIFEST } from './constants.js';
import { studentData }    from './state.js';

// ── SKILL CONFIG ─────────────────────────────────────────────────
/**
 * Returns the SKILL_MANIFEST entry for the given skillId.
 * Falls back to reading-tfng with a console warning if the id is unknown.
 */
export function getSkillConfig(skillId) {
  if (!skillId) return SKILL_MANIFEST['reading-tfng'];
  const cfg = SKILL_MANIFEST[skillId];
  if (!cfg) {
    console.warn(`getSkillConfig: unknown skillId "${skillId}", falling back to reading-tfng`);
    return SKILL_MANIFEST['reading-tfng'];
  }
  return cfg;
}

// ── SUBJECT-AGNOSTIC SCHEMA HELPERS ──────────────────────────────
// Converts 'reading.tfng' → 'reading-tfng'
export function toSkillId(key) { return (key || '').replace('.', '-'); }

// ── API RETRY ─────────────────────────────────────────────────────
export async function withRetry(fn, maxRetries = 3) {
  let lastErr;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try { return await fn(); } catch (err) {
      lastErr = err;
      if (attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
      }
    }
  }
  throw lastErr;
}

// ── AI JSON PARSER ────────────────────────────────────────────────
// GPT-4o-mini often wraps responses in ```json … ``` despite instructions.
// This strips all markdown code fences before parsing.
export function parseAIJson(raw) {
  let s = (raw || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  return JSON.parse(s);
}

// ── MARKDOWN → HTML HELPERS ──────────────────────────────────────
// Converts **bold** and *italic* markers from AI text to HTML tags.
// Apply to every AI explanation/feedback before inserting into innerHTML.
export function renderMarkdown(s) {
  return String(s || '')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+?)\*/g,  '<em>$1</em>');
}
// Legacy alias — retained for any call sites not yet updated
export const boldify = renderMarkdown;

// ── ANSWER NORMALISER ────────────────────────────────────────────
export function normaliseAnswer(raw) {
  if (raw == null) return '';
  let s = String(raw).toLowerCase().trim();
  s = s.replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, '');
  if (s === 'notgiven' || s === 'ng' || s === 'notgiven') s = 'notgiven';
  if (s === 'true'  || s === 't') s = 'true';
  if (s === 'false' || s === 'f') s = 'false';
  return s;
}

// ── ADAPTIVE ENGINE HELPERS ───────────────────────────────────────
export function accToBand(acc) {
  if (acc >= 90) return 8.5; if (acc >= 80) return 7.5; if (acc >= 70) return 7.0;
  if (acc >= 60) return 6.5; if (acc >= 50) return 6.0; if (acc >= 40) return 5.5;
  return 5.0;
}

export function getExamDaysRemaining() {
  const d = studentData?.examDate;
  if (!d) return null;
  const today = new Date(); today.setHours(0,0,0,0);
  const exam  = new Date(d); exam.setHours(0,0,0,0);
  return Math.ceil((exam - today) / 86400000);
}

// ── IELTS BAND LOOKUP TABLE (used only by rawScoreToBand) ─────────
const IELTS_BAND_TABLE = [
  [40,9.0],[39,8.5],[37,8.0],[35,7.5],[32,7.0],[30,6.5],[26,6.0],[23,5.5],
  [20,5.0],[16,4.5],[13,4.0],[10,3.5],[8,3.0],[6,2.5],[4,2.0]
];

export function rawScoreToBand(raw, total) {
  const pct = raw / total;
  for (const [minRaw, band] of IELTS_BAND_TABLE) {
    if (raw >= (minRaw / 40) * total) return band;
  }
  return 1.0;
}

// ── AUDIO HELPERS ─────────────────────────────────────────────────
export function base64ToBlob(base64, mimeType) {
  const bytes  = atob(base64);
  const buffer = new ArrayBuffer(bytes.length);
  const view   = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++) view[i] = bytes.charCodeAt(i);
  return new Blob([buffer], { type: mimeType });
}

// ── DOM HELPERS ───────────────────────────────────────────────────
export function _attachLongPress(el, ms, cb) {
  if (!el) return;
  let t = null;
  const start = (e) => { e.preventDefault(); t = setTimeout(cb, ms); };
  const cancel = () => { clearTimeout(t); t = null; };
  el.addEventListener('pointerdown',   start);
  el.addEventListener('pointerup',     cancel);
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('contextmenu',   (e) => e.preventDefault());
}
