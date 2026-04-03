// @ts-check
// tests/buttons.spec.js - Authenticated Playwright button tests
// Uses Firebase Auth REST API to sign in as the test student before each test.

const { test, expect } = require('@playwright/test');
require('dotenv').config();

const APP_URL    = 'https://toody-1ab05.web.app/app.html';
const API_KEY    = process.env.FIREBASE_API_KEY;
const TEST_EMAIL = process.env.TEST_EMAIL;
const TEST_PASS  = process.env.TEST_PASSWORD;

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

  // Firebase v10 uses IndexedDB (firebaseLocalStorageDb), not localStorage.
  // Inject auth state before the app script runs by intercepting the page.
  await page.addInitScript(
    ({ idToken, localId, apiKey }) => {
      const authKey = 'firebase:authUser:' + apiKey + ':[DEFAULT]';

      // Firebase v10 IndexedDB injection
      // The stored value must match Firebase v10's internal User format exactly.
      const fullUser = {
        uid: localId,
        email: 'test@toody.app',
        emailVerified: true,
        displayName: 'Arjun Test',
        isAnonymous: false,
        photoURL: null,
        providerData: [{
          providerId: 'password',
          uid: 'test@toody.app',
          displayName: 'Arjun Test',
          email: 'test@toody.app',
          phoneNumber: null,
          photoURL: null,
        }],
        stsTokenManager: {
          refreshToken: 'dummy-refresh',
          accessToken: idToken,
          expirationTime: Date.now() + 3600000,
        },
        createdAt: '1700000000000',
        lastLoginAt: String(Date.now()),
        apiKey: apiKey,
        appName: '[DEFAULT]',
      };

      const openReq = indexedDB.open('firebaseLocalStorageDb', 1);
      openReq.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('firebaseLocalStorage')) {
          db.createObjectStore('firebaseLocalStorage', { keyPath: 'fbase_key' });
        }
      };
      openReq.onsuccess = (e) => {
        const db = e.target.result;
        const tx = db.transaction('firebaseLocalStorage', 'readwrite');
        const store = tx.objectStore('firebaseLocalStorage');
        store.put({ fbase_key: authKey, value: fullUser });
      };
    },
    { idToken, localId, apiKey: API_KEY }
  );
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#s-home.active', { timeout: 25000 });
}

async function openDevPanel(page) {
  await page.evaluate(() => {
    const panel = document.getElementById('dev-panel-overlay');
    if (panel) panel.style.display = 'block';
  });
  await page.waitForSelector('#dev-panel-overlay', { state: 'visible', timeout: 3000 });
}

async function jumpTo(page, target) {
  await openDevPanel(page);
  await page.evaluate((t) => window.devJumpTo(t), target);
}

// ── TEST A — Home screen ─────────────────────────────────────────
test('Test A - Home screen buttons are all present and enabled', async ({ page }) => {
  await authenticatePage(page);

  // Session CTA — must exist and be enabled
  const cta = page.locator('#today-session-card button');
  await expect(cta).toBeVisible({ timeout: 5000 });
  await expect(cta).toBeEnabled();
  console.log('  cta: ' + (await cta.textContent()).trim());

  // Sign-out nav button
  const nav = page.locator('#s-home.active button.nav-btn');
  await expect(nav).toBeVisible();
  await expect(nav).toBeEnabled();
  console.log('  nav-btn: ' + (await nav.textContent()).trim());

  // View full progress button (first btn-secondary — "View full progress →")
  const prg = page.locator('#s-home.active button.btn-secondary').first();
  await expect(prg).toBeVisible();
  await expect(prg).toBeEnabled();
  console.log('  progress: ' + (await prg.textContent()).trim());

  // Skill picker — must render at least one button.
  // Some buttons are intentionally locked (disabled) due to prerequisites.
  // We verify: total count > 0, and at least one is enabled.
  const sp = page.locator('#home-skill-picker button');
  const sc = await sp.count();
  console.log('  skill-picker buttons total: ' + sc);
  expect(sc).toBeGreaterThan(0);
  let enabledCount = 0;
  for (let i = 0; i < sc; i++) {
    const b = sp.nth(i);
    if (await b.isVisible()) {
      const isEnabled = await b.isEnabled();
      const label = (await b.textContent()).trim().replace(/\s+/g, ' ').substring(0, 60);
      console.log('    skill[' + i + '] ' + (isEnabled ? 'enabled' : 'locked') + ': ' + label);
      if (isEnabled) enabledCount++;
    }
  }
  console.log('  skill-picker enabled: ' + enabledCount + ', locked: ' + (sc - enabledCount));
  expect(enabledCount).toBeGreaterThan(0);
});

// ── TEST B — Dev panel ───────────────────────────────────────────
test('Test B - Dev panel opens and all jump-to buttons are enabled', async ({ page }) => {
  await authenticatePage(page);
  await openDevPanel(page);

  const jb = page.locator('.dev-jump-btn');
  const jc = await jb.count();
  console.log('  Found ' + jc + ' dev jump buttons');
  expect(jc).toBeGreaterThan(0);

  for (let i = 0; i < jc; i++) {
    const b = jb.nth(i);
    if (await b.isVisible()) {
      await expect(b).toBeEnabled();
      console.log('  jump[' + i + ']: ' + (await b.textContent()).trim());
    }
  }
});

// ── TEST C — Session intro ────────────────────────────────────────
test('Test C - Session intro ready button is visible and enabled', async ({ page }) => {
  await authenticatePage(page);

  const cta = page.locator('#today-session-card button');
  await expect(cta).toBeVisible({ timeout: 5000 });
  await cta.click();
  await page.waitForSelector('#s-session-intro.active', { timeout: 10000 });

  const rb = page.locator('#btn-ready');
  await expect(rb).toBeVisible({ timeout: 5000 });
  await expect(rb).toBeEnabled();
  console.log('  ready-btn: ' + (await rb.textContent()).trim());

  const hb = page.locator('#s-session-intro.active .nav-btn');
  await expect(hb).toBeVisible();
  await expect(hb).toBeEnabled();
  console.log('  nav-back: ' + (await hb.textContent()).trim());
});

// ── TEST D — Teach-first ─────────────────────────────────────────
test('Test D - Teach-first hook answer buttons are all enabled', async ({ page }) => {
  await authenticatePage(page);
  await jumpTo(page, 'teachfirst:reading-tfng');
  await page.waitForSelector('#s-teach.active', { timeout: 10000 });

  await page.waitForFunction(() => {
    const h = document.getElementById('teach-hook');
    return h && !h.classList.contains('hidden');
  }, { timeout: 40000 });

  const hb = page.locator('#teach-hook-btns .tfng-btn');
  const hc = await hb.count();
  console.log('  hook buttons: ' + hc);
  expect(hc).toBeGreaterThan(0);
  for (let i = 0; i < hc; i++) {
    const b = hb.nth(i);
    if (await b.isVisible()) {
      await expect(b).toBeEnabled();
      console.log('  hook[' + i + ']: ' + (await b.textContent()).trim());
    }
  }

  // Click first hook answer — reveal button should appear
  await hb.first().click();
  const eb = page.locator('#teach-hook-reveal button');
  await expect(eb).toBeVisible({ timeout: 5000 });
  await expect(eb).toBeEnabled();
  console.log('  reveal-btn: ' + (await eb.textContent()).trim());

  // Advance to concept phase
  await eb.click();
  const cb = page.locator('#teach-concept button.btn');
  await expect(cb).toBeVisible({ timeout: 5000 });
  await expect(cb).toBeEnabled();
  console.log('  concept-btn: ' + (await cb.textContent()).trim());
});

// ── TEST E — Reading session ──────────────────────────────────────
test('Test E - Reading session answer buttons are all enabled', async ({ page }) => {
  await authenticatePage(page);
  await jumpTo(page, 'reading');
  await page.waitForSelector('#s-reading.active', { timeout: 10000 });

  await page.waitForFunction(() => {
    const l = document.getElementById('reading-loading');
    return l && l.classList.contains('hidden');
  }, { timeout: 40000 });

  const ab = page.locator('.tfng-btn, .q-option, .mc-option, .ynng-btn');
  const ac = await ab.count();
  console.log('  answer buttons: ' + ac);
  expect(ac).toBeGreaterThan(0);
  for (let i = 0; i < ac; i++) {
    const b = ab.nth(i);
    if (await b.isVisible()) {
      await expect(b).toBeEnabled();
      console.log('  ans[' + i + ']: ' + (await b.textContent()).trim());
    }
  }

  const sb = page.locator('#reading-submit');
  if (await sb.count() > 0) {
    await expect(sb.first()).toBeVisible();
    console.log('  submit: ' + (await sb.first().textContent()).trim());
  }
});

// ── TEST F — Writing screen ───────────────────────────────────────
test('Test F - Writing screen submit button is visible and enabled', async ({ page }) => {
  await authenticatePage(page);
  await jumpTo(page, 'writing');
  await page.waitForSelector('#s-writing.active', { timeout: 10000 });

  // Wait for writing-prompt-view to become visible (spinner hides once AI responds)
  await page.waitForSelector('#writing-prompt-view:not(.hidden)', { timeout: 60000 });

  const wb = page.locator('#btn-writing-submit');
  await expect(wb).toBeVisible({ timeout: 5000 });
  await expect(wb).toBeEnabled();
  console.log('  writing-submit: ' + (await wb.textContent()).trim());

  const ta = page.locator('#writing-textarea');
  await expect(ta).toBeVisible();
  await expect(ta).toBeEnabled();
  console.log('  textarea: enabled');
});

// ── TEST G — Notebook back to home ───────────────────────────────
test('Test G - Notebook Back-to-Home button navigates to home', async ({ page }) => {
  await authenticatePage(page);
  await jumpTo(page, 'notebook');
  await page.waitForSelector('#s-notebook.active', { timeout: 10000 });

  const nhb = page.locator('#s-notebook.active button[onclick*="notebookGoHome"]');
  const nc = await nhb.count();
  console.log('  notebook home buttons: ' + nc);
  expect(nc).toBeGreaterThan(0);

  const nb = nhb.first();
  await expect(nb).toBeVisible({ timeout: 5000 });
  await expect(nb).toBeEnabled();
  console.log('  home-btn: ' + (await nb.textContent()).trim());

  // Invoke the onclick directly via evaluate, capturing any internal errors
  const result = await page.evaluate(() => {
    const btn = document.querySelector('#s-notebook.active button[onclick*="notebookGoHome"]');
    if (!btn) return { found: false };

    // Patch console.error to capture the inner catch message
    let capturedError = null;
    const origError = console.error;
    console.error = (...args) => { capturedError = args.join(' '); origError(...args); };

    try {
      window.notebookGoHome(btn);
    } catch (e) {
      capturedError = 'OUTER: ' + e.message;
    } finally {
      console.error = origError;
    }
    return { found: true, disabled: btn.disabled, capturedError,
             homeActive: document.getElementById('s-home')?.classList.contains('active') };
  });

  console.log('  notebookGoHome result: ' + JSON.stringify(result));
  expect(result.found).toBe(true);
  expect(result.capturedError).toBeNull();

  // After calling goToHome, s-home should become active
  await page.waitForFunction(() => {
    const home = document.getElementById('s-home');
    return home && home.classList.contains('active');
  }, { timeout: 20000 });
  console.log('  navigation confirmed: s-home is active');
});

// ── TEST H — IELTS modal ──────────────────────────────────────────
test('Test H - IELTS modal navigation buttons all enabled', async ({ page }) => {
  await authenticatePage(page);
  await openDevPanel(page);
  await page.evaluate(() => window.devJumpTo('ieltsmodal'));
  await page.waitForSelector('#ielts-modal', { state: 'visible', timeout: 10000 });

  const mb = page.locator('#ielts-modal button');
  const mc = await mb.count();
  console.log('  ielts modal buttons: ' + mc);
  expect(mc).toBeGreaterThan(0);
  for (let i = 0; i < mc; i++) {
    const b = mb.nth(i);
    if (await b.isVisible()) {
      await expect(b).toBeEnabled();
      console.log('  modal[' + i + ']: ' + (await b.textContent()).trim());
    }
  }
});
