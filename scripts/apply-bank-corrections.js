#!/usr/bin/env node
// scripts/apply-bank-corrections.js
// Reads question-bank-{type}-reviewed.json and applies auto-corrected answers to Firestore.
//
// Usage:
//   node --env-file=.env scripts/apply-bank-corrections.js \
//     [--type tfng] --key-file data/toody-1ab05-firebase-adminsdk-fbsvc-12e2e5547c.json

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── TYPE → FIRESTORE COLLECTION MAP ──────────────────────────────────────────
// TFNG uses 'questionBank' (no suffix); all other types use 'questionBank-{type}'

const COLLECTION_MAP = {
  'tfng':                 'questionBank',
  'ynng':                 'questionBank-ynng',
  'multiple-choice':      'questionBank-multiple-choice',
  'sentence-completion':  'questionBank-sentence-completion',
  'summary-completion':   'questionBank-summary-completion',
  'matching-headings':    'questionBank-matching-headings',
  'matching-information': 'questionBank-matching-information',
  'matching-features':    'questionBank-matching-features',
  'listening-mc':         'questionBank-listening-mc',
  'listening-form':       'questionBank-listening-form',
};

// ── ARG PARSING ───────────────────────────────────────────────────────────────

const args    = process.argv.slice(2);
const typeIdx = args.indexOf('--type');
const TYPE    = typeIdx !== -1 ? args[typeIdx + 1] : 'tfng';
const kfIdx   = args.indexOf('--key-file');
const keyFile = kfIdx !== -1 ? args[kfIdx + 1] : 'data/toody-1ab05-firebase-adminsdk-fbsvc-12e2e5547c.json';

if (!COLLECTION_MAP[TYPE]) {
  console.error(`Unsupported type: ${TYPE}. Supported: ${Object.keys(COLLECTION_MAP).join(', ')}`);
  process.exit(1);
}

const REVIEWED_FILE = path.join(__dirname, `../data/question-bank-${TYPE}-reviewed.json`);
const COLLECTION    = COLLECTION_MAP[TYPE];

// ── FIREBASE INIT ─────────────────────────────────────────────────────────────

async function initFirebase(keyFilePath) {
  const { default: admin } = await import('firebase-admin');
  const keyAbs = path.resolve(keyFilePath);
  const key    = JSON.parse(fs.readFileSync(keyAbs, 'utf8'));
  admin.initializeApp({ credential: admin.credential.cert(key) });
  return admin.firestore();
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(REVIEWED_FILE)) {
    console.error(`Reviewed file not found: ${REVIEWED_FILE}`);
    process.exit(1);
  }

  const reviewed = JSON.parse(fs.readFileSync(REVIEWED_FILE, 'utf8'));
  const toFix    = reviewed.filter(s => s.reviewStatus === 'needs_correction');

  console.log(`\nApply Bank Corrections — ${TYPE.toUpperCase()}`);
  console.log(`Sets needing correction: ${toFix.length}\n`);

  if (toFix.length === 0) {
    console.log('Nothing to apply — bank is clean.');
    return;
  }

  const db   = await initFirebase(path.resolve(keyFile));
  const coll = db.collection(COLLECTION);

  let appliedCount = 0;
  let errorCount   = 0;

  for (const set of toFix) {
    const wrongQs = set.flaggedQuestions.filter(f => !f.correct && f.confidence === 'high');
    if (wrongQs.length === 0) continue;

    const docRef = coll.doc(set.id);
    const snap   = await docRef.get();

    if (!snap.exists) {
      console.log(`  ✗ Set ${set.id.slice(0, 8)}... not found in Firestore — skipping`);
      errorCount++;
      continue;
    }

    const docData  = snap.data();
    const questions = [...(docData.questions || [])];

    for (const fq of wrongQs) {
      const qIdx = fq.id - 1; // flaggedQuestions.id is 1-based
      if (!questions[qIdx]) {
        console.log(`  ✗ Set ${set.id.slice(0, 8)}... Q${fq.id} not found in doc — skipping`);
        errorCount++;
        continue;
      }

      const before = questions[qIdx].answer;
      questions[qIdx] = {
        ...questions[qIdx],
        answer:            fq.verifiedAnswer,
        autoCorrectReason: fq.reasoning,
      };

      console.log(`  ✓ Updated set ${set.id.slice(0, 8)}... (${set.topic}) Q${fq.id}: ${before} → ${fq.verifiedAnswer}`);
      appliedCount++;
    }

    await docRef.update({ questions });
  }

  console.log(`
═══════════════════════════════════════
CORRECTIONS APPLIED
═══════════════════════════════════════
Sets processed:  ${toFix.length}
Corrections:     ${appliedCount} applied
Errors:          ${errorCount}
Collection:      ${COLLECTION}
═══════════════════════════════════════`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
