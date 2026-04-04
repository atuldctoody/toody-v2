// scripts/generate-listening-audio.js
// Batch audio generation for listening questions in Firestore.
//
// For each question in questionBank-listening-mc and questionBank-listening-form
// that has no audioUrl, calls ElevenLabs, uploads mp3 to Firebase Storage,
// and writes the public download URL back to the Firestore document.
//
// Usage:
//   node --env-file=.env scripts/generate-listening-audio.js [flags]
//
// Flags:
//   --voice=<name>   ElevenLabs voice name (default: george). Options: george, sarah, rachel
//   --limit=N        Only generate N audio files (default: unlimited)
//   --dry-run        Show what would be generated without calling the API
//   --key-file PATH  Path to Firebase service account key JSON (default: data/toody-1ab05-firebase-adminsdk-fbsvc-12e2e5547c.json)

import { readFileSync }  from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore }  from 'firebase-admin/firestore';
import { getStorage }    from 'firebase-admin/storage';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '..');

// ── VOICE MAP ─────────────────────────────────────────────────────
// Premade ElevenLabs voices that work on the free tier
const VOICE_MAP = {
  george:  'JBFqnCBsd6RMkjVDRZzb',  // George — clear British male
  sarah:   'EXAVITQu4vr4xnSDxMaL',  // Sarah — clear neutral female (used by api/audio.js)
  rachel:  '21m00Tcm4TlvDq8ikWAM',  // Rachel — warm American female
};

const COLLECTIONS = ['questionBank-listening-mc', 'questionBank-listening-form'];
const DEFAULT_KEY = resolve(ROOT, 'data', 'toody-1ab05-firebase-adminsdk-fbsvc-12e2e5547c.json');
const BUCKET      = 'toody-1ab05.firebasestorage.app';

// ── 500ms SILENCE (WAV PCM, 44.1kHz mono) ─────────────────────────
// Prepended/appended to prevent mobile audio clipping at start/end.
// This is a minimal WAV header + 22050 samples of silence (500ms @ 44100Hz).
function buildSilenceWav(durationMs) {
  const sampleRate   = 44100;
  const numSamples   = Math.floor(sampleRate * (durationMs / 1000));
  const dataSize     = numSamples * 2;          // 16-bit PCM = 2 bytes/sample
  const headerSize   = 44;
  const buf          = Buffer.alloc(headerSize + dataSize, 0);

  // RIFF header
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);               // PCM chunk size
  buf.writeUInt16LE(1, 20);               // PCM format
  buf.writeUInt16LE(1, 22);               // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);  // byte rate
  buf.writeUInt16LE(2, 32);               // block align
  buf.writeUInt16LE(16, 34);              // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  // Remaining bytes are already zero (silence)
  return buf;
}

// ── CLI ────────────────────────────────────────────────────────────
function parseArgs() {
  const args   = process.argv.slice(2);
  const opts   = { voice: 'george', limit: Infinity, dryRun: false, keyFile: DEFAULT_KEY };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--voice='))   opts.voice   = arg.split('=')[1];
    if (arg.startsWith('--limit='))   opts.limit   = parseInt(arg.split('=')[1], 10);
    if (arg === '--dry-run')          opts.dryRun  = true;
    if (arg === '--key-file')         opts.keyFile = args[++i];
    if (arg.startsWith('--key-file=')) opts.keyFile = arg.split('=')[1];
  }
  if (!VOICE_MAP[opts.voice]) {
    console.error(`Unknown voice "${opts.voice}". Available: ${Object.keys(VOICE_MAP).join(', ')}`);
    process.exit(1);
  }
  return opts;
}

// ── FIREBASE ───────────────────────────────────────────────────────
function initFirebase(keyFile) {
  let credential;
  try {
    const key = JSON.parse(readFileSync(resolve(keyFile), 'utf8'));
    credential = cert(key);
  } catch (err) {
    console.error(`Error reading service account key at "${keyFile}":\n  ${err.message}`);
    process.exit(1);
  }
  initializeApp({ credential, storageBucket: BUCKET });
  return { db: getFirestore(), bucket: getStorage().bucket() };
}

// ── ELEVENLABS CALL ───────────────────────────────────────────────
async function generateAudio(text, voiceId) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY not set in environment');

  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method:  'POST',
    headers: {
      'xi-api-key':   apiKey,
      'Content-Type': 'application/json',
      'Accept':       'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id:      'eleven_multilingual_v2',
      voice_settings: { stability: 0.75, similarity_boost: 0.75 },
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`ElevenLabs error ${res.status}: ${detail.slice(0, 200)}`);
  }

  return Buffer.from(await res.arrayBuffer());
}

// ── STORAGE UPLOAD ─────────────────────────────────────────────────
async function uploadAndGetUrl(bucket, questionId, audioBuffer) {
  // Wrap mp3 with 500ms silence bookends to prevent mobile clipping
  const silence  = buildSilenceWav(500);
  const combined = Buffer.concat([silence, audioBuffer, silence]);

  const file    = bucket.file(`audio/listening/${questionId}.mp3`);
  await file.save(combined, {
    metadata:    { contentType: 'audio/mpeg' },
    resumable:   false,
    public:      true,
  });

  // Make publicly accessible and return the download URL
  const [url] = await file.getSignedUrl({
    action:  'read',
    expires: '2099-12-31',
  });
  return url;
}

// ── MAIN ───────────────────────────────────────────────────────────
async function main() {
  const opts    = parseArgs();
  const voiceId = VOICE_MAP[opts.voice];

  console.log(`\n[AUDIO] Listening Audio Generator`);
  console.log(`[AUDIO] Voice:    ${opts.voice} (${voiceId})`);
  console.log(`[AUDIO] Limit:    ${opts.limit === Infinity ? 'unlimited' : opts.limit}`);
  console.log(`[AUDIO] Dry run:  ${opts.dryRun}`);
  console.log(`[AUDIO] Key:      ${opts.keyFile}\n`);

  const { db, bucket } = initFirebase(opts.keyFile);

  let processed = 0;
  let skipped   = 0;
  let errors    = 0;

  for (const collId of COLLECTIONS) {
    console.log(`[AUDIO] Reading collection: ${collId}`);
    const snap = await db.collection(collId).get();
    console.log(`[AUDIO] Found ${snap.size} documents\n`);

    for (const doc of snap.docs) {
      if (processed >= opts.limit) break;

      const data = doc.data();

      // Skip documents that already have audio
      if (data.audioUrl) {
        skipped++;
        continue;
      }

      const passageText = data.transcript || data.passage || data.scenario || '';
      if (!passageText) {
        console.warn(`[AUDIO] SKIP ${doc.id} — no transcript/passage field found`);
        skipped++;
        continue;
      }

      const charCount = passageText.length;
      console.log(`[AUDIO] ${opts.dryRun ? 'DRY-RUN' : 'Processing'}: ${doc.id} — ${charCount} chars`);

      if (opts.dryRun) {
        processed++;
        continue;
      }

      try {
        const audioBuffer = await generateAudio(passageText, voiceId);
        const audioUrl    = await uploadAndGetUrl(bucket, doc.id, audioBuffer);

        await db.collection(collId).doc(doc.id).update({ audioUrl });

        console.log(`[AUDIO] Generated: ${doc.id} — ${charCount} chars → ${audioUrl.slice(0, 80)}…`);
        processed++;
      } catch (err) {
        console.error(`[AUDIO] ERROR ${doc.id}: ${err.message}`);
        errors++;
      }
    }

    if (processed >= opts.limit) break;
  }

  console.log(`\n[AUDIO] Done. Generated: ${processed} | Skipped (already voiced): ${skipped} | Errors: ${errors}`);
}

main().catch(err => {
  console.error('[AUDIO] Fatal error:', err.message);
  process.exit(1);
});
