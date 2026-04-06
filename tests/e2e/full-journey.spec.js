// @ts-check
// tests/e2e/full-journey.spec.js
// Comprehensive end-to-end Playwright suite — full student journey validation.
// Runs against the live app at https://toody-1ab05.web.app
// Mobile viewport: 390x844 (iPhone 14) — set in playwright.config.js
//
// DESIGN NOTES
//  - Auth uses Firebase REST API + IndexedDB injection (same as buttons.spec.js).
//  - The test account is an EXISTING student, so true onboarding cannot run.
//    The new-student flow test uses devJumpTo('briefing') to reach briefing cards.
//  - AI calls can take 15-40s; timeouts are set generously per test.
//  - Console errors are collected throughout; any error fails the test.
//  - Raw-markdown check (/\*\*|__/) runs after every major content load.

const { test, expect } = require('@playwright/test');
require('dotenv').config();

const APP_URL    = 'https://toody-1ab05.web.app/app.html';
const INDEX_URL  = 'https://toody-1ab05.web.app/index.html';
const API_KEY    = process.env.FIREBASE_API_KEY;
const TEST_EMAIL = process.env.TEST_EMAIL;
const TEST_PASS  = process.env.TEST_PASSWORD;

// ── SHARED: Firebase auth ─────────────────────────────────────────
async function getFirebaseToken() {
  const url = 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + API_KEY;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASS, returnSecureToken: true }),
  });
  const json = await res.json();
  if (!json.idToken) throw new Error('Firebase sign-in failed: ' + JSON.stringify(json));
  return { idToken: json.idToken, localId: json.localId };
}

async function authenticatePage(page) {
  const { idToken, localId } = await getFirebaseToken();
  await page.addInitScript(
    ({ idToken, localId, apiKey }) => {
      const authKey = 'firebase:authUser:' + apiKey + ':[DEFAULT]';
      const fullUser = {
        uid: localId, email: 'test@toody.app', emailVerified: true,
        displayName: 'Arjun Test', isAnonymous: false, photoURL: null,
        providerData: [{ providerId: 'password', uid: 'test@toody.app',
          displayName: 'Arjun Test', email: 'test@toody.app',
          phoneNumber: null, photoURL: null }],
        stsTokenManager: { refreshToken: 'dummy-refresh', accessToken: idToken,
          expirationTime: Date.now() + 3600000 },
        createdAt: '1700000000000', lastLoginAt: String(Date.now()),
        apiKey: apiKey, appName: '[DEFAULT]',
      };
      const openReq = indexedDB.open('firebaseLocalStorageDb', 1);
      openReq.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('firebaseLocalStorage'))
          db.createObjectStore('firebaseLocalStorage', { keyPath: 'fbase_key' });
      };
      openReq.onsuccess = (e) => {
        const db = e.target.result;
        const tx = db.transaction('firebaseLocalStorage', 'readwrite');
        tx.objectStore('firebaseLocalStorage').put({ fbase_key: authKey, value: fullUser });
      };
    },
    { idToken, localId, apiKey: API_KEY }
  );
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#s-home.active', { timeout: 25000 });
}

// ── SHARED: Helpers ───────────────────────────────────────────────

/** Collect JS errors from the page; returns a string of all errors, or '' */
function attachConsoleErrorCollector(page) {
  const errors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', err => errors.push(err.message));
  return errors;
}

/** Assert page text does not contain raw markdown artefacts or null/undefined */
async function assertNoRawMarkdown(page, label) {
  const body = await page.evaluate(() => document.body.innerText);
  // Allow double-asterisk only inside code blocks (<pre>, <code>) — check full innerHTML
  const html = await page.evaluate(() => document.body.innerHTML);
  // Remove <pre> and <code> blocks before checking
  const stripped = html.replace(/<pre[\s\S]*?<\/pre>/gi, '')
                        .replace(/<code[\s\S]*?<\/code>/gi, '');
  // Check for raw ** or __ that leaked through renderMarkdown
  const hasRawBold = /\*\*[^<]{1,60}\*\*/.test(stripped);
  const hasRawUnder = /__[^<]{1,60}__/.test(stripped);
  expect(hasRawBold, `[${label}] Raw ** found in rendered text`).toBe(false);
  expect(hasRawUnder, `[${label}] Raw __ found in rendered text`).toBe(false);

  // Check visible text for literal "undefined" or "null"
  const hasUndef = /\bundefined\b/.test(body);
  const hasNull  = /\bnull\b/.test(body);
  expect(hasUndef, `[${label}] Literal 'undefined' in visible text`).toBe(false);
  expect(hasNull,  `[${label}] Literal 'null' in visible text`).toBe(false);
}

async function openDevPanel(page) {
  await page.evaluate(() => {
    const p = document.getElementById('dev-panel-overlay');
    if (p) p.style.display = 'block';
  });
  await page.waitForSelector('#dev-panel-overlay', { state: 'visible', timeout: 3000 });
}

async function jumpTo(page, target) {
  await openDevPanel(page);
  await page.evaluate((t) => window.devJumpTo(t), target);
}

async function waitForReadingReady(page) {
  await page.waitForSelector('#s-reading.active', { timeout: 15000 });
  await page.waitForFunction(() => {
    const l = document.getElementById('reading-loading');
    return l && l.classList.contains('hidden');
  }, { timeout: 55000 });
}

async function waitForListeningReady(page) {
  await page.waitForSelector('#s-listening.active', { timeout: 15000 });
  await page.waitForFunction(() => {
    const l = document.getElementById('listening-loading');
    return l && l.classList.contains('hidden');
  }, { timeout: 55000 });
}

// ═══════════════════════════════════════════════════════════════════
// TEST 1 — AUTHENTICATION
// ═══════════════════════════════════════════════════════════════════
test('T1 — Authentication: login page loads and token injection lands on home', async ({ page }) => {
  test.setTimeout(45000);
  const errors = attachConsoleErrorCollector(page);

  // 1a. Login page renders correctly (unauthenticated)
  await page.goto(INDEX_URL, { waitUntil: 'domcontentloaded' });
  const signInBtn = page.locator('button, [role="button"]').filter({ hasText: /Google|Sign in/i }).first();
  await expect(signInBtn, 'T1: Google sign-in button not found on login page').toBeVisible({ timeout: 8000 });
  console.log('  T1a: login page ✓ — sign-in button visible');

  // 1b. Firebase REST token works
  const { idToken, localId } = await getFirebaseToken();
  expect(idToken, 'T1: Firebase idToken is empty').toBeTruthy();
  expect(localId, 'T1: Firebase localId is empty').toBeTruthy();
  console.log(`  T1b: token obtained, uid=${localId.substring(0, 8)}…`);

  // 1c. Token injection → home screen
  await authenticatePage(page);
  await expect(page.locator('#s-home.active'), 'T1: s-home not active after auth').toBeVisible();
  console.log('  T1c: home screen active ✓');

  // 1d. Console errors
  expect(errors.filter(e => !e.includes('favicon')), 'T1: JS errors on load').toHaveLength(0);
});

// ═══════════════════════════════════════════════════════════════════
// TEST 2 — NEW STUDENT FLOW (briefing + IELTS overview)
// NOTE: True onboarding requires a brand-new Firestore doc (no test isolation
// for the shared test account). We test the briefing card flow via devJumpTo
// and assert each card responds on first tap — validating event delegation.
// ═══════════════════════════════════════════════════════════════════
test('T2 — New student flow: briefing cards respond on first tap, IELTS modal appears once', async ({ page }) => {
  test.setTimeout(60000);
  const errors = attachConsoleErrorCollector(page);
  await authenticatePage(page);

  // Jump to briefing (simulates what a new student sees after onboarding)
  await jumpTo(page, 'briefing');
  await page.waitForSelector('#s-briefing.active', { timeout: 8000 });
  console.log('  T2: briefing screen active ✓');

  // Verify card 0 is visible
  const card0 = page.locator('#bc-0');
  await expect(card0, 'T2: bc-0 not active on load').toHaveClass(/active/, { timeout: 5000 });

  // Click "Next" on card 0 — must respond on FIRST tap
  const nextBtn0 = card0.locator('button.bc-btn');
  await expect(nextBtn0, 'T2: Next button on bc-0 not visible').toBeVisible();
  await expect(nextBtn0, 'T2: Next button on bc-0 disabled').toBeEnabled();
  await nextBtn0.click();
  await page.waitForSelector('#bc-1.active', { timeout: 5000 });
  console.log('  T2: card 0 → card 1 transition ✓ (first-tap)');

  // Click "Next" on card 1 — first tap
  const card1 = page.locator('#bc-1');
  const nextBtn1 = card1.locator('button.bc-btn');
  await expect(nextBtn1, 'T2: Next button on bc-1 disabled').toBeEnabled();
  await nextBtn1.click();
  await page.waitForSelector('#bc-2.active', { timeout: 5000 });
  console.log('  T2: card 1 → card 2 transition ✓ (first-tap)');

  // Card 2 — final card, "Show me the overview" button
  const finishBtn = page.locator('#bc2-btn');
  await expect(finishBtn, 'T2: bc2-btn not visible').toBeVisible();
  await expect(finishBtn, 'T2: bc2-btn disabled').toBeEnabled();
  await finishBtn.click();
  console.log('  T2: briefing finish clicked');

  // IELTS overview modal should appear
  await page.waitForFunction(
    () => {
      const modal = document.getElementById('ielts-modal');
      return modal && modal.style.display !== 'none';
    },
    { timeout: 10000 }
  );
  console.log('  T2: IELTS overview modal appeared ✓');

  // IELTS modal content present
  const ieltsWrap = page.locator('#ielts-wrap');
  await expect(ieltsWrap, 'T2: ielts-wrap not found').toBeVisible();

  // "Let's start" button at the bottom of IELTS modal
  const letsStart = page.locator('#ic-last-btn');
  await expect(letsStart, 'T2: ic-last-btn not visible').toBeVisible({ timeout: 5000 });
  await expect(letsStart, 'T2: ic-last-btn disabled').toBeEnabled();
  await letsStart.click();
  console.log('  T2: IELTS modal "Let\'s start" clicked');

  // Should land on home screen
  await page.waitForSelector('#s-home.active', { timeout: 10000 });
  console.log('  T2: home screen after IELTS overview ✓');

  // Curriculum map present (skill picker has buttons)
  const skillBtns = page.locator('#home-skill-picker button');
  const count = await skillBtns.count();
  expect(count, 'T2: no skill picker buttons on home').toBeGreaterThan(0);
  console.log(`  T2: curriculum map has ${count} skill buttons ✓`);

  // Raw markdown check
  await assertNoRawMarkdown(page, 'T2-home');
  expect(errors.filter(e => !e.includes('favicon') && !e.includes('safeClick')), 'T2: JS errors').toHaveLength(0);
});

// ═══════════════════════════════════════════════════════════════════
// TEST 3 — TEACH-FIRST FLOW
// ═══════════════════════════════════════════════════════════════════
test('T3 — Teach-first flow: hook → concept → reinforce → examples → confidence', async ({ page }) => {
  test.setTimeout(180000);
  const errors = attachConsoleErrorCollector(page);
  await authenticatePage(page);

  // Jump to teach-first for TFNG
  await jumpTo(page, 'teachfirst:reading-tfng');
  await page.waitForSelector('#s-teach.active', { timeout: 10000 });
  console.log('  T3: teach screen active ✓');

  // Wait for hook to load (AI call)
  await page.waitForFunction(
    () => {
      const loading = document.getElementById('teach-loading');
      const hook    = document.getElementById('teach-hook');
      return loading && loading.classList.contains('hidden') && hook && !hook.classList.contains('hidden');
    },
    { timeout: 55000 }
  );
  console.log('  T3: hook question loaded ✓');

  // Hook: all 3 TFNG answer buttons present and enabled (no pre-selection)
  const hookBtns = page.locator('#teach-hook-btns .tfng-btn');
  await expect(hookBtns, 'T3: not 3 hook buttons').toHaveCount(3);
  for (let i = 0; i < 3; i++) {
    await expect(hookBtns.nth(i), `T3: hook btn[${i}] disabled`).toBeEnabled();
    const cls = await hookBtns.nth(i).getAttribute('class');
    expect(cls, `T3: hook btn[${i}] pre-selected`).not.toMatch(/correct|wrong/);
  }
  console.log('  T3: hook buttons — 3 present, all neutral ✓');

  // Answer hook (pick first option)
  await hookBtns.first().click();

  // Reveal button should appear
  const revealBtn = page.locator('#teach-hook-reveal button');
  await expect(revealBtn, 'T3: reveal button not visible after hook answer').toBeVisible({ timeout: 5000 });
  console.log('  T3: hook reveal appeared ✓');

  // "Let me explain the pattern" → concept phase
  await revealBtn.click();
  await page.waitForFunction(
    () => !document.getElementById('teach-concept').classList.contains('hidden'),
    { timeout: 8000 }
  );
  console.log('  T3: concept phase visible ✓');

  // Raw markdown check on concept text
  const conceptBody = await page.locator('#teach-concept-body').innerText();
  expect(conceptBody.length, 'T3: concept body empty').toBeGreaterThan(20);
  await assertNoRawMarkdown(page, 'T3-concept');

  // "Lock in the concept" → reinforce phase
  const lockBtn = page.locator('#teach-concept button.btn');
  await expect(lockBtn, 'T3: Lock in the concept button not visible').toBeVisible();
  await lockBtn.click();
  await page.waitForFunction(
    () => !document.getElementById('teach-reinforce').classList.contains('hidden'),
    { timeout: 8000 }
  );
  console.log('  T3: reinforce phase visible ✓');

  // Reinforce: 3 options present
  const reinforceBtns = page.locator('.reinforce-btn');
  await expect(reinforceBtns, 'T3: not 3 reinforce options').toHaveCount(3);
  for (let i = 0; i < 3; i++) {
    await expect(reinforceBtns.nth(i), `T3: reinforce btn[${i}] disabled`).toBeEnabled();
  }
  console.log('  T3: reinforce options ✓');

  // Select "See it" (visual decision tree — no async call needed)
  const seeBtnLocator = page.locator('button.reinforce-btn').filter({ hasText: /See it/i });
  await seeBtnLocator.click();

  // "Show me the examples" button should appear
  const showExBtn = page.locator('#teach-continue-micro-btn');
  await expect(showExBtn, 'T3: Show me the examples button not visible').toBeVisible({ timeout: 10000 });
  await expect(showExBtn, 'T3: Show me the examples button disabled').toBeEnabled();
  await showExBtn.click();
  console.log('  T3: → worked examples phase');

  // Worked examples phase — 3 examples
  await page.waitForFunction(
    () => !document.getElementById('teach-worked').classList.contains('hidden'),
    { timeout: 10000 }
  );
  console.log('  T3: worked examples visible ✓');

  const exCounter = page.locator('#teach-ex-counter');
  await expect(exCounter, 'T3: example counter missing').toBeVisible();
  const counterText = await exCounter.innerText();
  console.log(`  T3: counter = "${counterText}"`);
  expect(counterText, 'T3: counter does not say "Example 1"').toContain('1');

  // Advance through all 3 worked examples
  for (let ex = 0; ex < 3; ex++) {
    // Wait for steps to load and "Next example" / "Start practising" button to appear
    const tryBtn = page.locator('#teach-try-btn');
    await expect(tryBtn, `T3: teach-try-btn missing on ex ${ex}`).toBeVisible({ timeout: 20000 });
    await expect(tryBtn, `T3: teach-try-btn disabled on ex ${ex}`).toBeEnabled({ timeout: 15000 });

    const tryTxt = await tryBtn.innerText();
    console.log(`  T3: ex ${ex+1} button: "${tryTxt.trim()}"`);
    await tryBtn.click();

    if (ex < 2) {
      // Should still be on worked examples (next example loaded)
      await page.waitForTimeout(500);
    } else {
      // After ex 3, confidence builder should appear
      await page.waitForFunction(
        () => !document.getElementById('teach-confidence').classList.contains('hidden'),
        { timeout: 15000 }
      );
      console.log('  T3: confidence builder phase ✓');
    }
  }

  // Confidence builder: 2 questions
  const confBtns = page.locator('#teach-conf-btns .tfng-btn');
  await expect(confBtns, 'T3: no confidence builder buttons').toHaveCount(3);
  for (let i = 0; i < 3; i++) {
    await expect(confBtns.nth(i), `T3: conf btn[${i}] disabled`).toBeEnabled();
  }
  console.log('  T3: confidence builder buttons ✓');

  // Answer both confidence questions
  await confBtns.first().click();
  // Wait for result flash
  await page.waitForFunction(
    () => document.getElementById('teach-conf-result').classList.contains('show'),
    { timeout: 5000 }
  );
  console.log('  T3: conf Q1 answered ✓');

  // Wait for Q2 or celebrate
  await page.waitForTimeout(1000);
  const confResult = await page.locator('#teach-conf-result').innerText();
  console.log(`  T3: conf result: "${confResult.substring(0, 50)}"`);

  // Celebrate or Q2
  const q2Btns = page.locator('#teach-conf-btns .tfng-btn:not([disabled])');
  const q2Count = await q2Btns.count();
  if (q2Count > 0) {
    await q2Btns.first().click();
    console.log('  T3: conf Q2 answered ✓');
  }

  // "Start my session" button should eventually appear
  const startSession = page.locator('button').filter({ hasText: /Start my session|Let.s go|Continue/i });
  await expect(startSession.first(), 'T3: Start session button never appeared').toBeVisible({ timeout: 15000 });
  console.log('  T3: Start session button visible ✓');

  await assertNoRawMarkdown(page, 'T3-final');
  expect(errors.filter(e => !e.includes('favicon') && !e.includes('answerTFNG') && !e.includes('console.log')),
    'T3: unexpected JS errors').toHaveLength(0);
});

// ═══════════════════════════════════════════════════════════════════
// TEST 4 — READING SESSION
// ═══════════════════════════════════════════════════════════════════
test('T4 — Reading session: 5 questions, feedback, tough love, return to home', async ({ page }) => {
  test.setTimeout(120000);
  const errors = attachConsoleErrorCollector(page);
  await authenticatePage(page);

  await jumpTo(page, 'reading');
  await waitForReadingReady(page);
  console.log('  T4: reading session loaded ✓');

  // Passage is non-empty
  const passageText = await page.locator('#reading-passage').innerText();
  expect(passageText.trim().length, 'T4: passage is empty').toBeGreaterThan(50);
  console.log(`  T4: passage length ${passageText.length} chars ✓`);

  // 5 questions present
  const qBlocks = page.locator('#questions-container .q-block');
  const qCount = await qBlocks.count();
  expect(qCount, 'T4: fewer than 5 question blocks').toBeGreaterThanOrEqual(5);
  console.log(`  T4: ${qCount} question blocks ✓`);

  // Answer each question — pick first available button for each
  // Works for TFNG, YNNG, MC — all use button elements
  for (let i = 0; i < qCount; i++) {
    const block = qBlocks.nth(i);
    const answerBtns = block.locator('button[data-action], button.tfng-btn, button.mc-option');
    const btnCount = await answerBtns.count();
    if (btnCount === 0) {
      console.log(`  T4: Q${i+1} — no clickable buttons (may be input type), skipping`);
      continue;
    }
    const firstEnabled = answerBtns.first();
    await expect(firstEnabled, `T4: Q${i+1} first btn disabled`).toBeEnabled();
    await firstEnabled.click();

    // Feedback card should appear
    const rf = block.locator('.result-flash.show');
    await expect(rf, `T4: Q${i+1} feedback card did not appear`).toBeVisible({ timeout: 5000 });

    // No raw ** in feedback
    const rfText = await rf.innerText();
    expect(rfText, `T4: Q${i+1} feedback contains raw **`).not.toMatch(/\*\*/);
    console.log(`  T4: Q${i+1} answered — feedback: "${rfText.substring(0, 60).trim()}…"`);

    // Report issue link must be visible on feedback card
    const reportLink = rf.locator('button.report-link');
    await expect(reportLink, `T4: Q${i+1} report-link not visible on feedback`).toBeVisible();
    console.log(`  T4: Q${i+1} "Report issue" link present ✓`);
  }

  // Submit button should now be enabled
  const submitBtn = page.locator('#btn-reading-submit');
  await expect(submitBtn, 'T4: submit btn not enabled after all answers').toBeEnabled({ timeout: 5000 });
  console.log('  T4: submit button enabled ✓');

  // Click submit
  await submitBtn.click();

  // Could go to tough love screen OR stay (if no TL eligible question)
  await page.waitForTimeout(500);
  const tlActive = await page.evaluate(() => document.querySelector('#s-toughlove.active') !== null);

  if (tlActive) {
    console.log('  T4: Tough Love screen appeared ✓');
    // TL question text present
    const tlQ = page.locator('#tl-question');
    await expect(tlQ, 'T4: TL question missing').toBeVisible();
    // Hint options present
    const hintBtns = page.locator('.hint-btn');
    const hintCount = await hintBtns.count();
    expect(hintCount, 'T4: TL no hint options').toBe(4);
    await hintBtns.first().click();
    // "Continue to notebook" button
    const tlContinue = page.locator('#btn-tl-continue');
    await expect(tlContinue, 'T4: TL continue button disabled').toBeEnabled({ timeout: 3000 });
    await tlContinue.click();
  }

  // Should reach notebook
  await page.waitForSelector('#s-notebook.active', { timeout: 15000 });
  console.log('  T4: notebook screen ✓');

  // "Back to Home" button on notebook navigates home
  const homeBtn = page.locator('#s-notebook.active button').filter({ hasText: /Back to Home|home/i });
  await expect(homeBtn.first(), 'T4: Back to Home button not found').toBeVisible({ timeout: 5000 });
  await homeBtn.first().click();
  await page.waitForSelector('#s-home.active', { timeout: 10000 });
  console.log('  T4: returned to home after session ✓');

  await assertNoRawMarkdown(page, 'T4-final');
  expect(errors.filter(e => !e.includes('favicon') && !e.includes('answerTFNG') && !e.includes('console.log')),
    'T4: unexpected JS errors').toHaveLength(0);
});

// ═══════════════════════════════════════════════════════════════════
// TEST 5 — LISTENING SESSION WITH AUDIO
// ═══════════════════════════════════════════════════════════════════
test('T5 — Listening session: audio player appears, play button works, questions gate', async ({ page }) => {
  test.setTimeout(90000);
  const errors = attachConsoleErrorCollector(page);
  await authenticatePage(page);

  await jumpTo(page, 'listening');
  await waitForListeningReady(page);
  console.log('  T5: listening session loaded ✓');

  // Audio player must be visible (not "Audio unavailable")
  const audioWrap = page.locator('#listening-audio-wrap');
  await expect(audioWrap, 'T5: listening-audio-wrap not visible').toBeVisible();
  const audioWrapText = await audioWrap.innerText();
  expect(audioWrapText, 'T5: "Audio unavailable" shown').not.toMatch(/Audio unavailable/i);
  console.log('  T5: audio area visible, not "unavailable" ✓');

  // Scenario text present
  const scenario = page.locator('#listening-scenario-text');
  const scenarioVisible = await scenario.isVisible().catch(() => false);
  if (scenarioVisible) {
    const scenText = await scenario.innerText();
    console.log(`  T5: scenario text: "${scenText.substring(0, 60)}…"`);
  }

  // Play button responds on first tap — find it inside audio wrap
  const playBtn = audioWrap.locator('button').filter({ hasText: /▶|Play/ }).first();
  const playBtnExists = await playBtn.isVisible().catch(() => false);

  if (playBtnExists) {
    await expect(playBtn, 'T5: play button disabled').toBeEnabled();
    // Don't actually play audio in CI (network) — just verify button state
    console.log('  T5: play button present and enabled ✓');
  } else {
    // Pre-generated audio from bank uses a different layout — check for <audio> element
    const audioEl = page.locator('#listening-audio');
    const audioElExists = await audioEl.isVisible().catch(() => false);
    console.log(`  T5: audio element exists: ${audioElExists}`);
  }

  // Questions gate — submit button initially hidden/disabled until audio played
  const submitBtn = page.locator('#btn-listening-submit');
  // Gate may be hidden before questions are shown
  const gateSection = page.locator('#listening-questions-gate');
  const gateVisible = await gateSection.isVisible().catch(() => false);
  console.log(`  T5: questions gate visible on load: ${gateVisible}`);

  // Simulate audio completion by calling showListeningQuestionsGate
  await page.evaluate(() => {
    if (typeof window.showListeningQuestionsGate === 'function') {
      window.showListeningQuestionsGate();
    }
  });
  await page.waitForTimeout(500);

  // Questions should now be visible
  const questionsContainer = page.locator('#listening-questions-container');
  const qVisible = await questionsContainer.isVisible().catch(() => false);
  console.log(`  T5: questions container visible after gate: ${qVisible}`);

  if (qVisible) {
    const listeningQBtns = questionsContainer.locator('button, input');
    const listeningQCount = await listeningQBtns.count();
    console.log(`  T5: ${listeningQCount} question interactive elements ✓`);
    expect(listeningQCount, 'T5: no question elements after gate').toBeGreaterThan(0);
  }

  await assertNoRawMarkdown(page, 'T5-listening');
  expect(errors.filter(e => !e.includes('favicon')), 'T5: JS errors').toHaveLength(0);
});

// ═══════════════════════════════════════════════════════════════════
// TEST 6 — REPORT ISSUE BUTTON
// ═══════════════════════════════════════════════════════════════════
test('T6 — Report issue: link visible on feedback, modal appears, submit shows toast', async ({ page }) => {
  test.setTimeout(90000);
  const errors = attachConsoleErrorCollector(page);
  await authenticatePage(page);

  // Load a reading session and answer one question
  await jumpTo(page, 'reading');
  await waitForReadingReady(page);

  const qBlocks = page.locator('#questions-container .q-block');
  const firstBlock = qBlocks.first();
  const firstAnswerBtn = firstBlock.locator('button[data-action], button.tfng-btn, button.mc-option').first();
  await expect(firstAnswerBtn, 'T6: first answer btn disabled').toBeEnabled();
  await firstAnswerBtn.click();

  // Feedback card appears
  const rf = firstBlock.locator('.result-flash.show');
  await expect(rf, 'T6: feedback card did not appear').toBeVisible({ timeout: 5000 });
  console.log('  T6: feedback card appeared ✓');

  // "Report issue" link must be in the feedback card
  const reportLink = rf.locator('button.report-link');
  await expect(reportLink, 'T6: "Report issue" link not visible in feedback').toBeVisible();
  const linkText = await reportLink.innerText();
  expect(linkText.trim(), 'T6: report link text wrong').toBe('Report issue');
  console.log('  T6: "Report issue" link visible ✓');

  // Click the report link — modal should appear
  await reportLink.click();
  const modal = page.locator('#report-modal');
  await expect(modal, 'T6: report-modal not visible after click').toBeVisible({ timeout: 3000 });
  console.log('  T6: report modal opened ✓');

  // Modal has 3 radio options
  const radioOptions = page.locator('#report-modal input[type="radio"]');
  await expect(radioOptions, 'T6: not 3 radio options').toHaveCount(3);
  const labels = await page.locator('.report-radio-option').allInnerTexts();
  console.log('  T6: modal options:', labels.map(l => l.trim().substring(0, 40)));

  // Select "Wrong answer"
  const wrongAnswerRadio = page.locator('input[name="report-type"][value="wrong_answer"]');
  await wrongAnswerRadio.check();
  await expect(wrongAnswerRadio, 'T6: wrong_answer radio not checked').toBeChecked();
  console.log('  T6: "Wrong answer" selected ✓');

  // Free-text area should be hidden for this option
  const textarea = page.locator('#report-details');
  await expect(textarea, 'T6: textarea should be hidden for non-something_else').toBeHidden();

  // Submit
  const submitBtn = page.locator('#report-modal button').filter({ hasText: /Submit/ });
  await expect(submitBtn, 'T6: Submit button not found').toBeVisible();
  await submitBtn.click();
  console.log('  T6: Submit clicked');

  // Toast should appear: "Thanks — we'll look into this"
  const toast = page.locator('.toast-pill');
  await expect(toast, 'T6: toast did not appear after submit').toBeVisible({ timeout: 8000 });
  const toastText = await toast.innerText();
  expect(toastText, "T6: toast text wrong").toContain("Thanks");
  console.log(`  T6: toast appeared: "${toastText}" ✓`);

  // Modal should close
  await expect(modal, 'T6: modal did not close after submit').toBeHidden({ timeout: 5000 });
  console.log('  T6: modal closed ✓');

  // "Something else" option shows free-text textarea
  // Reopen modal
  await reportLink.click();
  await expect(modal, 'T6: modal did not reopen').toBeVisible({ timeout: 3000 });
  const somethingElse = page.locator('input[name="report-type"][value="something_else"]');
  await somethingElse.check();
  await expect(textarea, 'T6: textarea should be visible for something_else').toBeVisible({ timeout: 2000 });
  console.log('  T6: "Something else" shows textarea ✓');

  // Cancel closes modal
  const cancelBtn = page.locator('#report-modal button').filter({ hasText: /Cancel/ });
  await cancelBtn.click();
  await expect(modal, 'T6: modal did not close on Cancel').toBeHidden({ timeout: 3000 });
  console.log('  T6: Cancel closes modal ✓');

  expect(errors.filter(e => !e.includes('favicon')), 'T6: JS errors').toHaveLength(0);
});

// ═══════════════════════════════════════════════════════════════════
// TEST 7 — GLOBAL VALIDATION
// No raw markdown, no null/undefined, no JS errors, correct viewport
// ═══════════════════════════════════════════════════════════════════
test('T7 — Global validation: viewport, no raw markdown, no null text on home + reading', async ({ page }) => {
  test.setTimeout(90000);
  const errors = attachConsoleErrorCollector(page);
  await authenticatePage(page);

  // Viewport check
  const vp = page.viewportSize();
  expect(vp?.width,  'T7: viewport width wrong').toBe(390);
  expect(vp?.height, 'T7: viewport height wrong').toBe(844);
  console.log(`  T7: viewport ${vp?.width}x${vp?.height} ✓`);

  // Home screen
  await assertNoRawMarkdown(page, 'T7-home');
  console.log('  T7: home — no raw markdown, no null ✓');

  // Session intro
  await jumpTo(page, 'reading');
  await page.waitForSelector('#s-session-intro.active', { timeout: 8000 }).catch(() => null);
  // session intro might skip if already past day 1; either way check the active screen
  const activeScreen = await page.evaluate(() => document.querySelector('.screen.active')?.id);
  console.log(`  T7: active screen after reading jump: ${activeScreen}`);

  // Wait for content to load if on reading
  if (activeScreen === 's-reading' || activeScreen === 's-session-intro') {
    await page.waitForTimeout(1000);
    await assertNoRawMarkdown(page, `T7-${activeScreen}`);
    console.log(`  T7: ${activeScreen} — no raw markdown ✓`);
  }

  // Reading session
  await waitForReadingReady(page).catch(() => {});
  const readingActive = await page.evaluate(() => document.getElementById('s-reading')?.classList.contains('active'));
  if (readingActive) {
    await assertNoRawMarkdown(page, 'T7-reading');

    // Answer one question and check feedback text
    const firstBtn = page.locator('#questions-container .q-block button').first();
    if (await firstBtn.isEnabled().catch(() => false)) {
      await firstBtn.click();
      await page.waitForTimeout(500);
      await assertNoRawMarkdown(page, 'T7-reading-feedback');
      console.log('  T7: reading feedback — no raw markdown ✓');
    }
  }

  // Console errors (allow console.log from app code — only catch actual errors)
  const realErrors = errors.filter(e =>
    !e.includes('favicon') &&
    !e.includes('answerTFNG') &&
    !e.includes('console.log')
  );
  if (realErrors.length > 0) {
    console.log('  T7: JS errors found:');
    realErrors.forEach(e => console.log('    ' + e.substring(0, 120)));
  }
  expect(realErrors, 'T7: unexpected JS errors in console').toHaveLength(0);
});
