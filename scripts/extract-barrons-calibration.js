// scripts/extract-barrons-calibration.js
// Extracts all T/F/NG and Y/N/NG answer explanations from Barron's IELTS Superpack.
//
// The PDF is a real binary PDF — we extract text via the system pdftotext CLI
// (not a library) so the rest of the script works on plain UTF-8 text lines.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '..');
const PDF_PATH  = resolve(ROOT, 'data', 'Barrons.pdf');
const TXT_PATH  = resolve(ROOT, 'data', 'barrons-raw.txt');
const OUT_PATH  = resolve(ROOT, 'data', 'barrons-calibration.json');

// ── 1. GET TEXT ──────────────────────────────────────────────────────────────
let rawText;
if (existsSync(TXT_PATH)) {
  rawText = readFileSync(TXT_PATH, 'utf8');
  console.log(`Using cached ${TXT_PATH}`);
} else {
  console.log('Extracting text from PDF via pdftotext…');
  execSync(`pdftotext -layout "${PDF_PATH}" "${TXT_PATH}"`);
  rawText = readFileSync(TXT_PATH, 'utf8');
  console.log(`Extracted ${rawText.length.toLocaleString()} characters`);
}

const lines = rawText.split('\n');
console.log(`Lines: ${lines.length.toLocaleString()}`);

// ── 2. HELPERS ───────────────────────────────────────────────────────────────

// Normalise PDF line-break artefacts in "Not Given"
function normaliseAnswer(raw) {
  const s = raw.replace(/N\s+ot\s+Given/gi, 'Not Given').trim();
  if (/^true$/i.test(s))      return 'True';
  if (/^false$/i.test(s))     return 'False';
  if (/^not\s+given$/i.test(s)) return 'Not Given';
  if (/^yes$/i.test(s))       return 'Yes';
  if (/^no$/i.test(s))        return 'No';
  return null;
}

// Extract paragraph reference from explanation text
function parseParagraphRef(text) {
  // e.g. "Paragraph 6:", "Paragraphs 2 and 5", "Opening sentence:", "Section A:"
  // "According to paragraph 1," / "According to Paragraphs 2 and 5,"
  const patterns = [
    /\b(Opening sentence)/i,
    /\b(Section [A-Z](?:\s+and\s+[A-Z])?)/i,
    /\b(Paragraphs?\s+\d+(?:\s+and\s+\d+)?)/i,
    /According to\s+(Paragraphs?\s+\d+(?:\s+and\s+\d+)?)/i,
    /According to\s+(paragraph\s+\d+)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return (m[1] || m[0]).replace(/\s+/g, ' ').trim();
  }
  return '';
}

// Extract the first quoted string from explanation text (curly or straight quotes)
function parseQuote(text) {
  // Handle curly quotes and straight quotes; may contain ellipsis ". . ."
  const m = text.match(/["\u201C]([^"\u201D]{5,300})["\u201D]/);
  if (m) return m[1].replace(/\s+/g, ' ').trim();
  return '';
}

// Infer logic type from answer + explanation text
function inferLogicType(answer, explanation) {
  const ex = explanation.toLowerCase();

  if (answer === 'Not Given' || answer === 'No' || answer === 'Yes') {
    // Not Given sub-types
    if (answer === 'Not Given') {
      if (/there is no mention|not mentioned|does not mention|no mention/.test(ex))
        return 'NOT_GIVEN_NO_EVIDENCE';
      if (/is mentioned.*but|mentioned.*not|but.*not/.test(ex))
        return 'NOT_GIVEN_TOPIC_ADJACENT';
      return 'NOT_GIVEN_NO_EVIDENCE';
    }
  }

  // Concessive / contrast trap (but / although / while / however / though + reversal)
  if (/\b(although|however|though|while|but)\b/.test(ex) &&
      (answer === 'False' || answer === 'No'))
    return 'CONCESSIVE_TRAP';

  // Direct negation / reversal in False answers
  if (answer === 'False' || answer === 'No') {
    if (/not increase|not decrease|not definitively|far less likely|does not/.test(ex))
      return 'NEGATIVE_REFRAME';
    if (/according to paragraph|is (native|opposite|incorrect|not related)/.test(ex))
      return 'DIRECT_CONTRADICTION';
    if (/causal|led to|caused by|result of/.test(ex))
      return 'CAUSAL_ASSUMPTION';
    return 'DIRECT_CONTRADICTION';
  }

  // True / Yes sub-types
  if (answer === 'True' || answer === 'Yes') {
    if (/means the same as|same as|synonym/.test(ex))
      return 'SYNONYM_SWAP';
    if (/habit-forming|same as|equivalent|means/.test(ex))
      return 'SYNONYM_SWAP';
    if (/not definitively|approximately|only|most|far less/.test(ex))
      return 'QUALIFIER_SHIFT';
    if (/implies|based on|infers|can be inferred/.test(ex))
      return 'CAUSAL_ASSUMPTION';
    return 'SYNONYM_SWAP'; // default True — passage synonym confirmed
  }

  return 'DIRECT_CONTRADICTION';
}

// ── 3. PARSE ─────────────────────────────────────────────────────────────────

// Matches: "  33. True. ..." or deep-indented "                   33. True. ..." etc.
// Also handles "N ot Given" split across the answer token
const ENTRY_RE = /^\s*(\d{1,2})\.\s+(True|False|Not\s+Given|N\s+ot\s+Given|Yes|No)\.\s+(.*)/i;

// Track module and test number as persistent state.
// "General Training Module" may appear on a separate line from "Practice Test N",
// so we track isGT independently and apply it whenever we see a test number.
// GT tests are stored with testNumber 7-12 (GT1=7, GT2=8, … GT6=12).

const results = [];
let testNumber = 1;
let module     = 'academic';
let isGT       = false;   // persistent: true once inside the GT section
let i = 0;

while (i < lines.length) {
  const line = lines[i];

  // Update module state (persists across lines)
  if (/General\s+Training\s+M[o0]dule/i.test(line)) isGT = true;
  if (/Academic\s+M[o0]dule/i.test(line) && !/General/i.test(line)) isGT = false;

  // Update test number
  const tnMatch = line.match(/Practice\s+Test\s+(\d)/i) || line.match(/Test\s+(\d)-Answer/i);
  if (tnMatch) {
    const n = parseInt(tnMatch[1], 10);
    testNumber = isGT ? n + 6 : n;
    module     = isGT ? 'general-training' : 'academic';
  }

  const m = line.match(ENTRY_RE);
  if (m) {
    // Skip answer-key table rows: the explanation section begins after PASSAGE/PASSAGE N header;
    // answer key tables have no full-stop after the answer (e.g. "33. True\n" with no trailing text)
    // and the body text (m[3]) would be empty or look like another answer column.
    // Guard: if no body text AND it looks like an answer-key row, skip.
    const bodyRaw = (m[3] || '').trim();
    // Answer-key rows either have no body or have another answer column fragment right after
    if (!bodyRaw || /^\d{1,2}\.\s|^[A-Z]\s+\d/.test(bodyRaw)) { i++; continue; }

    const qNum     = parseInt(m[1], 10);
    const rawAns   = m[2];
    let   bodyText = m[3] || '';

    // Collect continuation lines (handles both short-indent and 60-col two-column layout)
    let j = i + 1;
    while (j < lines.length) {
      const next = lines[j];
      // Blank or whitespace-only line ends the entry
      if (/^\s*$/.test(next.replace(/\s/g, ''))) { j++; break; }
      // Next numbered TFNG entry
      if (ENTRY_RE.test(next)) break;
      // New section or test markers
      if (/^\s*(PASSAGE|READING PASSAGE|Writing|WRITING|Listening|Speaking|ACADEMIC MODULE|GENERAL TRAINING)/i.test(next)) break;
      if (/^\s*(Practice Test|Answer Key|Test \d-Answer)/i.test(next)) break;
      // PDF page header fragments (e.g. "Academic Module-- Practice Test 1 39")
      if (/A\s*c\s*a\s*d\s*e\s*m\s*i\s*c\s+M\s*o\s*d\s*u\s*l\s*e/.test(next)) break;
      // Non-TFNG numbered answer like "27. (B)" — stop
      if (/^\s*\d{1,2}\.\s+[\(\[]?[A-Z][\)\]]/.test(next)) break;
      const trimmed = next.trim();
      // Accept any non-empty continuation
      if (trimmed.length > 0 && trimmed.length < 200) {
        // Skip lone stray chars that are PDF artifacts (single letter on a line)
        if (trimmed.length === 1 && /[a-z]/.test(trimmed)) { j++; continue; }
        bodyText += ' ' + trimmed;
        j++;
      } else {
        break;
      }
    }
    i = j;

    const answer = normaliseAnswer(rawAns.replace(/\s+/g, ' '));
    if (!answer) continue;

    // Normalise bodyText
    bodyText = bodyText.replace(/\s+/g, ' ').trim();

    const paragraphRef  = parseParagraphRef(bodyText);
    const passageQuote  = parseQuote(bodyText);
    // Explanation = full body minus the leading paragraph reference + colon
    const explanation   = bodyText.replace(/^\s*/, '');
    const logicType     = inferLogicType(answer, explanation);

    results.push({
      testNumber,
      module,
      questionNumber: qNum,
      answer,
      paragraphRef,
      passageQuote,
      explanation,
      logicType,
    });
    continue;
  }

  i++;
}

// ── 4. DEDUP & SORT ──────────────────────────────────────────────────────────
// Remove duplicates (same test+module+question can appear from layout fragments)
const seen = new Set();
const deduped = results.filter(r => {
  const key = `${r.module}-${r.testNumber}-${r.questionNumber}-${r.answer}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});
deduped.sort((a, b) => a.testNumber - b.testNumber || a.questionNumber - b.questionNumber);

// ── 5. WRITE OUTPUT ──────────────────────────────────────────────────────────
writeFileSync(OUT_PATH, JSON.stringify(deduped, null, 2), 'utf8');

// ── 6. REPORT ────────────────────────────────────────────────────────────────
console.log(`\n✓ Extracted ${deduped.length} entries → data/barrons-calibration.json\n`);

// Answer type distribution
const byAnswer = {};
const byLogic  = {};
for (const r of deduped) {
  byAnswer[r.answer]    = (byAnswer[r.answer]    || 0) + 1;
  byLogic[r.logicType]  = (byLogic[r.logicType]  || 0) + 1;
}

console.log('── Answer type distribution ──────────────────');
for (const [k, v] of Object.entries(byAnswer).sort((a,b) => b[1]-a[1]))
  console.log(`  ${k.padEnd(12)} ${v}`);

console.log('\n── Logic type distribution ───────────────────');
for (const [k, v] of Object.entries(byLogic).sort((a,b) => b[1]-a[1]))
  console.log(`  ${k.padEnd(30)} ${v}`);

// Per-test breakdown
const byTest = {};
for (const r of deduped) {
  const key = `${r.module === 'academic' ? 'Acad' : 'GT  '} Test ${r.testNumber <= 6 ? r.testNumber : r.testNumber - 6}`;
  byTest[key] = (byTest[key] || 0) + 1;
}
console.log('\n── Per-test breakdown ────────────────────────');
for (const [t, v] of Object.entries(byTest).sort()) console.log(`  ${t}: ${v}`);

// 3 sample entries
console.log('\n── 3 sample entries ──────────────────────────');
const samples = [
  deduped.find(r => r.answer === 'True'),
  deduped.find(r => r.answer === 'False'),
  deduped.find(r => r.answer === 'Not Given'),
].filter(Boolean);
for (const s of samples) console.log(JSON.stringify(s, null, 2));
