// scripts/load-question-bank.js
// Uploads approved question-bank sets from data/question-bank.json to Firestore.
//
// Authentication: set GOOGLE_APPLICATION_CREDENTIALS to your service account key JSON path,
// or pass --key-file <path> as a CLI flag.
//
// Usage:
//   node scripts/load-question-bank.js [options]
//
// Flags:
//   --dry-run          Show what would be uploaded without writing to Firestore
//   --band   N         Only upload sets for a specific band (e.g. 6.0)
//   --key-file PATH    Path to Firebase service account key JSON (overrides GOOGLE_APPLICATION_CREDENTIALS)

import { readFileSync }               from 'fs';
import { resolve, dirname }           from 'path';
import { fileURLToPath }              from 'url';
import { initializeApp, cert }        from 'firebase-admin/app';
import { getFirestore, FieldValue }   from 'firebase-admin/firestore';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '..');

// ── CLI ───────────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { dryRun: false, band: null, keyFile: null };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--dry-run':  opts.dryRun  = true;                     break;
      case '--band':     opts.band    = parseFloat(args[++i]);    break;
      case '--key-file': opts.keyFile = args[++i];                break;
    }
  }
  return opts;
}

// ── FIREBASE INIT ─────────────────────────────────────────────────────────────

function initFirebase(keyFile) {
  const keyPath = keyFile || process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!keyPath) {
    console.error(
      'Error: Firebase credentials not found.\n' +
      'Set GOOGLE_APPLICATION_CREDENTIALS to your service account key JSON path, or pass --key-file <path>.\n' +
      '\nTo generate a service account key:\n' +
      '  Firebase Console → Project Settings → Service Accounts → Generate new private key'
    );
    process.exit(1);
  }

  let credential;
  try {
    const key = JSON.parse(readFileSync(resolve(keyPath), 'utf8'));
    credential = cert(key);
  } catch (err) {
    console.error(`Error reading service account key at "${keyPath}":\n  ${err.message}`);
    process.exit(1);
  }

  initializeApp({ credential });
  return getFirestore();
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();

  // Load bank
  const bankPath = resolve(ROOT, 'data', 'question-bank.json');
  let bank;
  try {
    bank = JSON.parse(readFileSync(bankPath, 'utf8'));
  } catch (err) {
    console.error(`Error reading question bank at "${bankPath}":\n  ${err.message}`);
    process.exit(1);
  }

  if (!Array.isArray(bank)) {
    console.error('Error: question-bank.json is not a JSON array.');
    process.exit(1);
  }

  // Filter: approved only (no rejectedReason), then optional band filter
  let sets = bank.filter(e => !e.rejectedReason);
  if (opts.band !== null) {
    sets = sets.filter(e => e.band === opts.band);
  }

  const totalSets      = sets.length;
  const totalQuestions = sets.reduce((n, s) => n + (s.questions?.length || 0), 0);

  console.log('\nToody Question Bank Loader');
  console.log(`Mode:  ${opts.dryRun ? 'DRY RUN (no writes)' : 'LIVE'}`);
  if (opts.band !== null) console.log(`Band filter: ${opts.band}`);
  console.log(`Bank: ${totalSets} approved sets / ${totalQuestions} questions\n`);

  if (opts.dryRun) {
    // Show preview without touching Firestore
    console.log('Sets that would be uploaded:');
    sets.forEach((s, i) => {
      const qCount = s.questions?.length || 0;
      console.log(
        `  [${String(i + 1).padStart(String(totalSets).length)}/${totalSets}]` +
        ` ${s.topic} (Band ${s.band}, ${qCount} questions, id: ${s.id?.slice(0, 8)}...)`
      );
    });
    console.log(`\nDry run complete — ${totalSets} sets would be uploaded.`);
    console.log('Run without --dry-run to write to Firestore.');
    return;
  }

  // Init Firebase
  const db         = initFirebase(opts.keyFile);
  const collection = db.collection('questionBank');

  // Fetch existing IDs in one query — avoid duplicates
  process.stdout.write('Fetching existing Firestore IDs... ');
  const existing    = await collection.select().get();
  const existingIds = new Set(existing.docs.map(d => d.id));
  console.log(`${existingIds.size} sets already in Firestore.\n`);

  let uploaded = 0;
  let skipped  = 0;
  const pad    = String(totalSets).length;

  for (let i = 0; i < sets.length; i++) {
    const s      = sets[i];
    const label  = `[${String(i + 1).padStart(pad)}/${totalSets}]`;
    const qCount = s.questions?.length || 0;

    if (existingIds.has(s.id)) {
      process.stdout.write(`${label} ⟳ Skipped — already in Firestore: ${s.topic} (Band ${s.band})\n`);
      skipped++;
      continue;
    }

    process.stdout.write(`${label} ↑ Uploading ${s.topic} (Band ${s.band}, ${qCount} questions)...\n`);

    const doc = {
      ...s,
      status:       'active',
      servedCount:  0,
      lastServedAt: null,
      createdAt:    FieldValue.serverTimestamp(),
    };

    await collection.doc(s.id).set(doc);
    uploaded++;
  }

  // Final summary — fetch fresh count for accuracy
  const finalSnap      = await collection.where('status', '==', 'active').get();
  const totalActive    = finalSnap.size;
  const activeQs       = finalSnap.docs.reduce(
    (n, d) => n + (d.data().questions?.length || 0), 0
  );

  const SEP = '─'.repeat(40);
  console.log(`\n${SEP}`);
  console.log(`Uploaded: ${uploaded} new set${uploaded !== 1 ? 's' : ''}`);
  console.log(`Skipped:  ${skipped} already in Firestore`);
  console.log(`Total active in bank: ${totalActive} sets / ${activeQs} questions`);
  console.log(`Collection: questionBank`);
  console.log(`${SEP}\n`);
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
