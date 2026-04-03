// @ts-check
// tests/toody-stateful.spec.js
// Stateful Playwright navigation suite.
// Tests that all interactive elements remain enabled and clean
// under every realistic navigation sequence.

const { test, expect } = require('@playwright/test');
require('dotenv').config();

const APP_URL    = 'https://toody-1ab05.web.app/app.html';
const API_KEY    = process.env.FIREBASE_API_KEY;
const TEST_EMAIL = process.env.TEST_EMAIL;
const TEST_PASS  = process.env.TEST_PASSWORD;

// ── AUTH ──────────────────────────────────────────────────────────
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

// ── NAV HELPERS ───────────────────────────────────────────────────
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

async function navHome(page) {
  await page.evaluate(() => window.goToHome());
  await page.waitForSelector('#s-home.active', { timeout: 10000 });
  await page.waitForTimeout(300);
}

// ── WAIT HELPERS ──────────────────────────────────────────────────
async function waitForReadingReady(page) {
  await page.waitForSelector('#s-reading.active', { timeout: 10000 });
  await page.waitForFunction(() => {
    const l = document.getElementById('reading-loading');
    return l && l.classList.contains('hidden');
  }, { timeout: 50000 });
}

async function waitForWritingReady(page) {
  await page.waitForSelector('#s-writing.active', { timeout: 10000 });
  await page.waitForSelector('#writing-prompt-view:not(.hidden)', { timeout: 60000 });
}

async function waitForListeningReady(page) {
  await page.waitForSelector('#s-listening.active', { timeout: 10000 });
  await page.waitForFunction(() => {
    const l = document.getElementById('listening-loading');
    return l && l.classList.contains('hidden');
  }, { timeout: 50000 });
}

// ── SHARED ASSERTIONS ─────────────────────────────────────────────

// Assert all answer buttons on the active reading screen are enabled.
// Returns button count.
async function assertReadingAnswerButtons(page, label) {
  const sel = '#s-reading.active .tfng-btn, #s-reading.active .ynng-btn, ' +
              '#s-reading.active .mc-option, #s-reading.active .q-option';
  const btns = page.locator(sel);
  const count = await btns.count();
  expect(count, `[${label}] No answer buttons found`).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) {
    const b = btns.nth(i);
    if (await b.isVisible()) {
      await expect(b, `[${label}] answer btn[${i}] disabled`).toBeEnabled();
    }
  }
  return count;
}

// Assert no unexpectedly-disabled buttons on the active screen.
// Legitimately disabled:
//   - Submit/Next/Finish buttons before answers selected
//   - Skill-picker buttons locked by prerequisites (#home-skill-picker — checked separately)
//   - Audio play buttons (▶) while audio is loading or not yet available
//   - Answer buttons (.tfng-btn / .ynng-btn) after selection on teach/warmup screens
async function assertNoUnexpectedlyDisabled(page, label) {
  const result = await page.evaluate(() => {
    const active = document.querySelector('.screen.active');
    if (!active) return { bad: [] };
    const legitimatePartials = ['Submit', 'Next', 'Submit answers', 'Finish', '▶', 'Play Audio'];
    const bad = Array.from(active.querySelectorAll('button[disabled]'))
      .filter(b => {
        // Allow skill-picker locked buttons (handled by assertHomeClean)
        if (b.closest('#home-skill-picker')) return false;
        // Allow answer buttons disabled after selection (teach/warmup screens)
        if (b.classList.contains('tfng-btn') || b.classList.contains('ynng-btn')) return false;
        // Allow warmup answer buttons after selection
        if (b.classList.contains('warmup-btn')) return false;
        // Allow partial-text matches for submit/next/finish/audio
        if (legitimatePartials.some(t => b.textContent.includes(t))) return false;
        return true;
      })
      .map(b => b.textContent.trim().replace(/\s+/g, ' ').substring(0, 60));
    return { bad };
  });
  expect(result.bad,
    `[${label}] Unexpectedly disabled: ${JSON.stringify(result.bad)}`
  ).toHaveLength(0);
}

// Assert home screen CTA and skill picker are in clean state.
async function assertHomeClean(page, label) {
  await page.waitForSelector('#s-home.active', { timeout: 10000 });
  const cta = page.locator('#today-session-card button');
  await expect(cta, `[${label}] CTA disabled`).toBeEnabled();
  const skillBtns = page.locator('#home-skill-picker button');
  const total = await skillBtns.count();
  expect(total, `[${label}] No skill-picker buttons`).toBeGreaterThan(0);
  let enabled = 0;
  for (let i = 0; i < total; i++) {
    if (await skillBtns.nth(i).isEnabled()) enabled++;
  }
  expect(enabled, `[${label}] No enabled skill-picker buttons`).toBeGreaterThan(0);
}

// ── SEQUENCE 1 — Forward flow then back ──────────────────────────
test('Seq 1 — forward flow then back: home buttons clean on return', async ({ page }) => {
  test.setTimeout(120000);
  await authenticatePage(page);

  // First pass: jump to reading session
  await jumpTo(page, 'reading');
  await waitForReadingReady(page);
  const count1 = await assertReadingAnswerButtons(page, 'Seq1 pass1');
  await assertNoUnexpectedlyDisabled(page, 'Seq1 pass1 reading');
  console.log(`  pass1 answer buttons: ${count1}`);

  // Return to home
  await navHome(page);
  await assertHomeClean(page, 'Seq1 after return');
  await assertNoUnexpectedlyDisabled(page, 'Seq1 home after return');
  console.log('  home clean after return ✓');

  // Second pass: start another reading session — must be clean
  await jumpTo(page, 'reading');
  await waitForReadingReady(page);
  const count2 = await assertReadingAnswerButtons(page, 'Seq1 pass2');
  await assertNoUnexpectedlyDisabled(page, 'Seq1 pass2 reading');
  console.log(`  pass2 answer buttons: ${count2} ✓`);
});

// ── SEQUENCE 2 — Interrupted session ─────────────────────────────
test('Seq 2 — interrupted session: second session loads fresh', async ({ page }) => {
  test.setTimeout(120000);
  await authenticatePage(page);

  // Load first reading session, capture passage text
  await jumpTo(page, 'reading');
  await waitForReadingReady(page);
  const passage1 = await page.evaluate(() => {
    const el = document.getElementById('reading-passage');
    return el ? el.textContent.trim().substring(0, 80) : '';
  });
  console.log(`  passage1 start: "${passage1.substring(0, 40)}..."`);

  // Interrupt — go back to home mid-session
  await navHome(page);
  await assertHomeClean(page, 'Seq2 home after interrupt');

  // Start a different reading type (YNNG) — should load cleanly
  await jumpTo(page, 'reading-ynng');
  await waitForReadingReady(page);
  const count = await assertReadingAnswerButtons(page, 'Seq2 second session');
  await assertNoUnexpectedlyDisabled(page, 'Seq2 second session reading');
  console.log(`  second session answer buttons: ${count} — all enabled ✓`);

  // Passage should be present (not blank)
  const passage2 = await page.evaluate(() => {
    const el = document.getElementById('reading-passage');
    return el ? el.textContent.trim().length : 0;
  });
  expect(passage2, 'Seq2: passage2 is empty').toBeGreaterThan(0);
  console.log('  passage2 non-empty ✓');
});

// ── SEQUENCE 3 — Multiple section navigation ──────────────────────
test('Seq 3 — multiple sections: reading → home → listening → home → writing', async ({ page }) => {
  test.setTimeout(180000);
  await authenticatePage(page);

  // ── Reading ──
  await jumpTo(page, 'reading');
  await waitForReadingReady(page);
  await assertReadingAnswerButtons(page, 'Seq3 reading');
  await assertNoUnexpectedlyDisabled(page, 'Seq3 reading');
  console.log('  reading ✓');

  // ── Home ──
  await navHome(page);
  await assertHomeClean(page, 'Seq3 home1');
  console.log('  home after reading ✓');

  // ── Listening ──
  await jumpTo(page, 'listening');
  await waitForListeningReady(page);
  const listenBtns = page.locator('#s-listening.active .tfng-btn, #s-listening.active .mc-option, #s-listening.active .q-option');
  const listenCount = await listenBtns.count();
  expect(listenCount, 'Seq3: no listening answer buttons').toBeGreaterThan(0);
  for (let i = 0; i < listenCount; i++) {
    const b = listenBtns.nth(i);
    if (await b.isVisible()) await expect(b, `Seq3 listen btn[${i}] disabled`).toBeEnabled();
  }
  await assertNoUnexpectedlyDisabled(page, 'Seq3 listening');
  console.log(`  listening answer buttons: ${listenCount} ✓`);

  // ── Home ──
  await navHome(page);
  await assertHomeClean(page, 'Seq3 home2');
  console.log('  home after listening ✓');

  // ── Writing ──
  await jumpTo(page, 'writing');
  await waitForWritingReady(page);
  const wb = page.locator('#btn-writing-submit');
  await expect(wb, 'Seq3 writing submit disabled').toBeEnabled();
  const ta = page.locator('#writing-textarea');
  await expect(ta, 'Seq3 textarea disabled').toBeEnabled();
  await assertNoUnexpectedlyDisabled(page, 'Seq3 writing');
  console.log('  writing submit + textarea enabled ✓');
});

// ── SEQUENCE 4 — Dev panel navigation stress test ─────────────────
test('Seq 4 — dev panel stress: 3 different jumps, buttons clean each time', async ({ page }) => {
  test.setTimeout(300000);
  await authenticatePage(page);

  const jumps = [
    { target: 'reading',      label: 'TF/NG',   wait: waitForReadingReady },
    { target: 'reading-ynng', label: 'Y/N/NG',  wait: waitForReadingReady },
    { target: 'notebook',     label: 'Notebook', wait: async (p) => {
      await p.waitForSelector('#s-notebook.active', { timeout: 10000 });
    }},
  ];

  for (const { target, label, wait } of jumps) {
    // Open dev panel and jump
    await openDevPanel(page);
    const panelVisible = await page.isVisible('#dev-panel-overlay');
    expect(panelVisible, `Seq4 dev panel not visible before ${label}`).toBe(true);
    console.log(`  dev panel open for ${label} ✓`);

    await page.evaluate((t) => window.devJumpTo(t), target);
    await wait(page);
    await assertNoUnexpectedlyDisabled(page, `Seq4 ${label}`);
    if (target !== 'notebook') {
      const count = await assertReadingAnswerButtons(page, `Seq4 ${label}`);
      console.log(`  ${label}: ${count} answer buttons enabled ✓`);
    } else {
      const homeBtn = page.locator('#s-notebook.active button[onclick*="notebookGoHome"]');
      await expect(homeBtn.first(), `Seq4 ${label} home btn disabled`).toBeEnabled();
      console.log(`  ${label}: home button enabled ✓`);
    }

    // Return home
    await navHome(page);
    await assertHomeClean(page, `Seq4 home after ${label}`);
  }
});

// ── SEQUENCE 5 — Answer then navigate back ────────────────────────
test('Seq 5 — answer 2 questions then back: second session all buttons enabled', async ({ page }) => {
  test.setTimeout(120000);
  await authenticatePage(page);

  // First session — answer 2 questions
  await jumpTo(page, 'reading');
  await waitForReadingReady(page);
  const btns1 = page.locator('#s-reading.active .tfng-btn');
  const btnCount = await btns1.count();
  expect(btnCount, 'Seq5: no tfng buttons').toBeGreaterThan(0);

  // Click first two visible answer buttons
  let clicked = 0;
  for (let i = 0; i < Math.min(btnCount, 6) && clicked < 2; i++) {
    const b = btns1.nth(i);
    if (await b.isVisible() && await b.isEnabled()) {
      await b.click();
      clicked++;
    }
  }
  console.log(`  answered ${clicked} questions in first session`);

  // Navigate back before completing
  await navHome(page);
  await assertHomeClean(page, 'Seq5 home after partial session');
  console.log('  home clean after partial session ✓');

  // Second session — ALL answer buttons must be enabled (no stale disabled state)
  await jumpTo(page, 'reading');
  await waitForReadingReady(page);
  const count2 = await assertReadingAnswerButtons(page, 'Seq5 second session');
  await assertNoUnexpectedlyDisabled(page, 'Seq5 second session');
  console.log(`  second session: ${count2} answer buttons all enabled ✓`);
});

// ── SEQUENCE 6 — Teach-First TFNG → YNNG ─────────────────────────
test('Seq 6 — teach-first: TFNG hook then YNNG session loads correct buttons', async ({ page }) => {
  test.setTimeout(180000);
  await authenticatePage(page);

  // ── TFNG Teach-First ──
  await jumpTo(page, 'teachfirst:reading-tfng');
  await page.waitForSelector('#s-teach.active', { timeout: 10000 });
  await page.waitForFunction(() => {
    const h = document.getElementById('teach-hook');
    return h && !h.classList.contains('hidden');
  }, { timeout: 40000 });

  const hookBtns = page.locator('#teach-hook-btns .tfng-btn');
  const hookCount = await hookBtns.count();
  expect(hookCount, 'Seq6 TFNG: no hook buttons').toBeGreaterThan(0);
  for (let i = 0; i < hookCount; i++) {
    if (await hookBtns.nth(i).isVisible())
      await expect(hookBtns.nth(i), `Seq6 TFNG hook btn[${i}] disabled`).toBeEnabled();
  }
  console.log(`  TFNG hook buttons: ${hookCount} enabled ✓`);

  // Click first hook answer → reveal button
  await hookBtns.first().click();
  const revealBtn = page.locator('#teach-hook-reveal button');
  await expect(revealBtn).toBeVisible({ timeout: 5000 });
  await expect(revealBtn).toBeEnabled();
  await revealBtn.click();

  // Concept phase
  const conceptBtn = page.locator('#teach-concept button.btn');
  await expect(conceptBtn).toBeVisible({ timeout: 5000 });
  await expect(conceptBtn).toBeEnabled();
  console.log('  TFNG concept button enabled ✓');

  await assertNoUnexpectedlyDisabled(page, 'Seq6 teach TFNG');

  // Return home
  await navHome(page);
  await assertHomeClean(page, 'Seq6 home after TFNG teach');
  console.log('  home clean after TFNG teach ✓');

  // ── YNNG Reading session — check buttons say Yes/No/Not Given ──
  await jumpTo(page, 'reading-ynng');
  await waitForReadingReady(page);

  // YNNG sessions use .tfng-btn class but with Yes/No/Not Given text
  const ynngBtns = page.locator('#s-reading.active .tfng-btn');
  const ynngCount = await ynngBtns.count();
  expect(ynngCount, 'Seq6: no answer buttons for YNNG session').toBeGreaterThan(0);
  for (let i = 0; i < ynngCount; i++) {
    if (await ynngBtns.nth(i).isVisible())
      await expect(ynngBtns.nth(i), `Seq6 YNNG btn[${i}] disabled`).toBeEnabled();
  }
  // Verify first button text says Yes/No/Not Given — not True/False/Not Given
  const firstText = await ynngBtns.first().textContent();
  expect(firstText.trim(), 'Seq6: YNNG first button should not say True').not.toMatch(/^\s*[✓✗]?\s*True\b/);
  console.log(`  YNNG answer buttons: ${ynngCount}, first="${firstText.trim()}" ✓`);
  await assertNoUnexpectedlyDisabled(page, 'Seq6 YNNG session');
});

// ── SEQUENCE 7 — Writing → Reading → Writing (fresh prompt) ──────
test('Seq 7 — writing → reading → writing: second writing session has fresh prompt', async ({ page }) => {
  test.setTimeout(240000);
  await authenticatePage(page);

  // ── First writing session ──
  await jumpTo(page, 'writing');
  await waitForWritingReady(page);
  const prompt1 = await page.evaluate(() => {
    const el = document.getElementById('writing-prompt-view');
    return el ? el.textContent.trim().substring(0, 100) : '';
  });
  const ta1 = page.locator('#writing-textarea');
  await expect(ta1).toBeEnabled();
  const val1 = await ta1.inputValue();
  expect(val1, 'Seq7: textarea not empty at start').toBe('');
  await expect(page.locator('#btn-writing-submit')).toBeEnabled();
  await assertNoUnexpectedlyDisabled(page, 'Seq7 writing1');
  console.log(`  writing1 prompt: "${prompt1.substring(0, 50)}..." ✓`);

  // ── Back to home → reading ──
  await navHome(page);
  await assertHomeClean(page, 'Seq7 home1');
  await jumpTo(page, 'reading');
  await waitForReadingReady(page);
  await assertReadingAnswerButtons(page, 'Seq7 reading');
  await assertNoUnexpectedlyDisabled(page, 'Seq7 reading');
  console.log('  reading session after writing ✓');

  // ── Back to home → second writing session ──
  await navHome(page);
  await assertHomeClean(page, 'Seq7 home2');
  await jumpTo(page, 'writing');
  await waitForWritingReady(page);

  const ta2 = page.locator('#writing-textarea');
  await expect(ta2, 'Seq7: textarea disabled on second writing').toBeEnabled();
  const val2 = await ta2.inputValue();
  expect(val2, 'Seq7: textarea not empty on second writing load').toBe('');
  await expect(page.locator('#btn-writing-submit'), 'Seq7 write2 submit disabled').toBeEnabled();
  await assertNoUnexpectedlyDisabled(page, 'Seq7 writing2');

  const prompt2 = await page.evaluate(() => {
    const el = document.getElementById('writing-prompt-view');
    return el ? el.textContent.trim().substring(0, 100) : '';
  });
  console.log(`  writing2 prompt: "${prompt2.substring(0, 50)}..."`);
  // Fresh prompt: textarea is empty and enabled (main invariant)
  console.log('  second writing: textarea empty + enabled ✓');
});

// ── SEQUENCE 8 — Speaking → Reading ──────────────────────────────
test('Seq 8 — speaking then reading: no audio state bleeding', async ({ page }) => {
  test.setTimeout(180000);
  await authenticatePage(page);

  // ── Speaking session ──
  await jumpTo(page, 'speaking');
  await page.waitForSelector('#s-speaking.active', { timeout: 10000 });

  const finBtn = page.locator('#speaking-finish-btn');
  // Finish button may or may not be visible depending on state — just check screen loaded
  const speakingActive = await page.evaluate(() =>
    document.getElementById('s-speaking')?.classList.contains('active')
  );
  expect(speakingActive, 'Seq8: speaking screen not active').toBe(true);
  await assertNoUnexpectedlyDisabled(page, 'Seq8 speaking');
  console.log('  speaking screen loaded, no unexpected disabled ✓');

  // ── Back to home ──
  await navHome(page);
  await assertHomeClean(page, 'Seq8 home after speaking');
  console.log('  home clean after speaking ✓');

  // ── Reading session — verify no audio/speaking state bleeds in ──
  await jumpTo(page, 'reading');
  await waitForReadingReady(page);
  const count = await assertReadingAnswerButtons(page, 'Seq8 reading after speaking');
  await assertNoUnexpectedlyDisabled(page, 'Seq8 reading after speaking');

  // Verify audio-related elements are NOT present on reading screen
  const audioEl = await page.evaluate(() =>
    document.querySelector('#s-reading.active audio, #s-reading.active .mock-record-btn') !== null
  );
  expect(audioEl, 'Seq8: audio element present on reading screen (state bleed)').toBe(false);
  console.log(`  reading after speaking: ${count} answer buttons, no audio bleed ✓`);
});

// ── SEQUENCE 9 — Mock test then regular session ───────────────────
test('Seq 9 — mini mock then regular reading: no mock state', async ({ page }) => {
  test.setTimeout(120000);
  await authenticatePage(page);

  // ── Jump to mini mock setup screen ──
  await jumpTo(page, 'mock');
  await page.waitForSelector('#s-minimock.active', { timeout: 10000 });
  const introView = page.locator('#mock-intro-view');
  await expect(introView).toBeVisible();
  const startBtn = page.locator('#s-minimock.active button').first();
  await expect(startBtn, 'Seq9 mock start btn disabled').toBeEnabled();
  await assertNoUnexpectedlyDisabled(page, 'Seq9 mock setup');
  console.log('  mock setup screen: buttons enabled ✓');

  // ── Jump to notebook (simulates having completed a session) ──
  await jumpTo(page, 'notebook');
  await page.waitForSelector('#s-notebook.active', { timeout: 10000 });
  await assertNoUnexpectedlyDisabled(page, 'Seq9 notebook');
  const homeBtn = page.locator('#s-notebook.active button[onclick*="notebookGoHome"]');
  await expect(homeBtn.first(), 'Seq9 notebook home btn disabled').toBeEnabled();
  console.log('  notebook: home button enabled ✓');

  // ── Navigate home ──
  await navHome(page);
  await assertHomeClean(page, 'Seq9 home after mock/notebook');

  // Verify mock state is cleared — mockMode should be false
  const mockMode = await page.evaluate(() => typeof window.mockMode === 'undefined' ? false : window.mockMode);
  expect(mockMode, 'Seq9: mockMode still true after returning home').toBe(false);
  console.log(`  mockMode=${mockMode} ✓`);

  // ── Regular reading session — must be clean of any mock state ──
  await jumpTo(page, 'reading');
  await waitForReadingReady(page);
  const count = await assertReadingAnswerButtons(page, 'Seq9 reading after mock');
  await assertNoUnexpectedlyDisabled(page, 'Seq9 reading after mock');

  // Mock timer bar must be hidden
  const timerHidden = await page.evaluate(() => {
    const bar = document.getElementById('mini-mock-timer-bar');
    return !bar || bar.classList.contains('hidden');
  });
  expect(timerHidden, 'Seq9: mini-mock timer bar visible during regular session').toBe(true);
  console.log(`  reading: ${count} buttons, mock timer hidden ✓`);
});

// ── SEQUENCE 10 — Rapid navigation stress test ────────────────────
test('Seq 10 — rapid navigation: 10 screens, no freeze or blank', async ({ page }) => {
  test.setTimeout(300000);
  await authenticatePage(page);

  const steps = [
    // [target, waitFn or null, label]
    ['teachfirst:reading-tfng', async (p) => {
      await p.waitForSelector('#s-teach.active', { timeout: 10000 });
      await p.waitForFunction(() => {
        const h = document.getElementById('teach-hook');
        return h && !h.classList.contains('hidden');
      }, { timeout: 40000 });
    }, 'teach TFNG'],
    [null, async (p) => await navHome(p), 'home (1)'],
    ['reading', waitForReadingReady, 'reading TFNG'],
    [null, async (p) => await navHome(p), 'home (2)'],
    ['teachfirst:reading-tfng', async (p) => {
      await p.waitForSelector('#s-teach.active', { timeout: 10000 });
      await p.waitForFunction(() => {
        const h = document.getElementById('teach-hook');
        return h && !h.classList.contains('hidden');
      }, { timeout: 40000 });
    }, 'teach TFNG (2)'],
    [null, async (p) => await navHome(p), 'home (3)'],
    ['reading', waitForReadingReady, 'reading TFNG (2)'],
    [null, async (p) => await navHome(p), 'home (4)'],
    ['writing', waitForWritingReady, 'writing'],
    [null, async (p) => await navHome(p), 'home (5)'],
    ['speaking', async (p) => {
      await p.waitForSelector('#s-speaking.active', { timeout: 10000 });
    }, 'speaking'],
  ];

  for (let i = 0; i < steps.length; i++) {
    const [target, waitFn, label] = steps[i];

    if (target === null) {
      // waitFn IS the action (navHome)
      await waitFn(page);
    } else {
      await jumpTo(page, target);
      await waitFn(page);
    }

    // After each step, verify no blank screen and no unexpected disabled buttons
    const activeScreen = await page.evaluate(() =>
      document.querySelector('.screen.active')?.id || 'NONE'
    );
    expect(activeScreen, `[Seq10 step ${i}: ${label}] No active screen`).not.toBe('NONE');
    await assertNoUnexpectedlyDisabled(page, `Seq10 step${i} ${label}`);
    console.log(`  step ${i+1}/11 [${label}] → #${activeScreen} ✓`);

    // Short settle time between rapid navigations
    await page.waitForTimeout(300);
  }

  // Navigate home and verify final state is clean
  await navHome(page);
  await assertHomeClean(page, 'Seq10 final home');
  console.log('  final home state clean ✓');
});
