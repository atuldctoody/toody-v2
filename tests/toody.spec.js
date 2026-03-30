// @ts-check
const { test, expect } = require('@playwright/test');

const BASE_URL = 'https://toody-1ab05.web.app';

// ─────────────────────────────────────────────────────────────────
// MOCK STUDENT PROFILES
// ─────────────────────────────────────────────────────────────────

// A student who has completed onboarding (hasExperience is the gate)
// but has never done a session — will trigger briefing flow
const newStudent = {
  uid: 'test-uid-new',
  name: 'Test Student',
  preferredName: 'Test',
  email: 'test@playwright.dev',
  targetBand: 7.0,
  hasExperience: false,   // CRITICAL: onboarding gate check is (hasExperience === true || === false)
  dayNumber: 1,
  weekNumber: 1,
  sessionCount: 0,
  briefingSeen: false,
  hasSeenIELTSOverview: false,
  brain: { subjects: { 'ielts-academic': { skills: {} } } },
  weakAreas: [],
  recentSkills: [],
  examDate: null,
  streak: 0,
};

// First-time skill student (past onboarding + briefing + IELTS overview → triggers teach-first)
const teachFirstStudent = {
  ...newStudent,
  hasExperience: true,
  briefingSeen: true,
  hasSeenIELTSOverview: true,
  brain: { subjects: { 'ielts-academic': { skills: {} } } },
};

// Experienced student — skips all gates, loads reading session directly
const experiencedStudent = {
  uid: 'test-uid-exp',
  name: 'Test Student',
  preferredName: 'Test',
  email: 'test@playwright.dev',
  targetBand: 7.0,
  hasExperience: true,
  dayNumber: 1,
  weekNumber: 1,
  sessionCount: 0,  // 0 skips warmup gate
  briefingSeen: true,
  hasSeenIELTSOverview: true,
  brain: {
    subjects: {
      'ielts-academic': {
        skills: {
          'reading-tfng':              { accuracy: 60, attempted: 3, sessions: 3 },
          'reading-summaryCompletion': { accuracy: 70, attempted: 2, sessions: 2 },
          'listening-multipleChoice':  { accuracy: 72, attempted: 2, sessions: 2 },
          'listening-formCompletion':  { accuracy: 75, attempted: 2, sessions: 2 },
          'writing-task1':             { bandEstimate: 6.5, attempted: 1, sessions: 1 },
          'writing-task2':             { bandEstimate: 6.0, attempted: 1, sessions: 1 },
          'speaking-part1':            { bandEstimate: 6.5, attempted: 1, sessions: 1 },
        },
      },
    },
  },
  weakAreas: ['reading-tfng'],
  recentSkills: ['reading.summaryCompletion'],
  examDate: null,
  streak: 3,
  currentBand: 6.5,
};

// ─────────────────────────────────────────────────────────────────
// MOCK AI RESPONSES
// ─────────────────────────────────────────────────────────────────

// Universal mock: contains fields for all session types so one mock works everywhere
const MOCK_AI = {
  // Reading TF/NG + SC
  passage: 'Academic researchers have consistently found that spaced repetition significantly improves long-term memory retention compared to massed practice. Studies at major universities show that students who review material at increasing intervals retain up to 80% more information after one month. The technique exploits the psychological spacing effect, documented in the 1880s. Sleep plays a crucial role in consolidating memories. Optimal spacing intervals vary considerably between individuals.',
  topic: 'Learning Science',
  summaryText: 'Researchers found that spaced [1] significantly improves memory [2] compared to massed practice. The spacing [3] was documented in the 1880s. Sleep plays a crucial [4]. Spacing intervals [5] between individuals.',
  wordBank: ['repetition', 'retention', 'effect', 'role', 'vary', 'massed', 'practice', 'research'],
  questions: [
    { id: 1, text: 'Spaced repetition improves memory retention compared to massed practice.', answer: 'True',  explanation: 'Directly stated.', keySentence: 'spaced repetition significantly improves long-term memory retention compared to massed practice.' },
    { id: 2, text: 'Students retain 90% more information with spaced repetition.',              answer: 'False', explanation: 'Passage says 80%.', keySentence: 'students who review material at increasing intervals retain up to 80% more information.' },
    { id: 3, text: 'The spacing effect was invented in the 1960s.',                            answer: 'NG',    explanation: 'Not mentioned.',     keySentence: 'the psychological spacing effect, documented in the 1880s.' },
    { id: 4, text: 'Sleep helps consolidate memories from study sessions.',                    answer: 'True',  explanation: 'Explicitly stated.', keySentence: 'Sleep plays a crucial role in consolidating memories.' },
    { id: 5, text: 'All individuals benefit equally from spaced repetition.',                  answer: 'False', explanation: 'Intervals vary.',    keySentence: 'Optimal spacing intervals vary considerably between individuals.' },
  ],
  // Teach-first schema
  hookQuestion: {
    passage: 'A study found that students who reviewed notes within 24 hours retained 60% more information after one week.',
    statement: 'The study claims students who review within 24 hours always pass their exams.',
    answer: 'NG',
    insight: "The passage mentions retention — not exam passing. 'Always' is a strong claim the passage never makes.",
  },
  conceptBullets: [
    'TRUE — the passage directly confirms the statement.',
    'FALSE — the passage directly contradicts the statement.',
    'NOT GIVEN — the passage is silent on this point.',
  ],
  workedExample: [
    { type: 'statement', passage: 'Water boils at 100°C at sea level.', statement: 'Water boils at 100°C.', answer: 'True', reasoning: 'The passage says exactly this.' },
    { type: 'statement', passage: 'Water boils at 100°C at sea level.', statement: 'Water boils at 90°C.', answer: 'False', reasoning: 'The passage says 100°C, not 90°C.' },
    { type: 'statement', passage: 'Water boils at 100°C at sea level.', statement: 'Boiling water is used in cooking.', answer: 'NG', reasoning: 'The passage never mentions cooking.' },
  ],
  reinforcementOptions: [
    { type: 'hear', text: 'Hear it explained like a story' },
    { type: 'see',  text: 'See the decision framework'     },
    { type: 'drill', text: 'Quick-fire practice questions'  },
  ],
  drillQuestions: [
    { passage: 'Solar panels convert sunlight into electricity.', statement: 'Solar panels produce electricity from sunlight.', answer: 'True',  explanation: 'Directly stated.' },
    { passage: 'Solar panels convert sunlight into electricity.', statement: 'Solar panels are cheaper than wind turbines.', answer: 'NG',    explanation: 'Cost not mentioned.' },
    { passage: 'Exercise reduces heart disease risk by 30%.',     statement: 'Exercise increases heart disease risk.',        answer: 'False', explanation: 'Passage says reduces.' },
    { passage: 'Exercise reduces heart disease risk by 30%.',     statement: 'Exercise reduces risk by exactly 30%.',         answer: 'True',  explanation: '30% stated explicitly.' },
    { passage: 'Meditation has been practised for over 3,000 years.', statement: 'Meditation is a modern technique.',        answer: 'False', explanation: '3,000 years is not modern.' },
  ],
  confidenceQuestions: [
    { passage: 'The Amazon produces 20% of world oxygen.', statement: 'The Amazon generates a fifth of global oxygen.', answer: 'True',  explanation: '20% = a fifth.' },
    { passage: 'The Amazon produces 20% of world oxygen.', statement: 'The Amazon is the largest forest on Earth.',    answer: 'NG',    explanation: 'Size not mentioned.' },
  ],
  // Session tip schema
  observation: 'You completed the reading session with solid focus.',
  revelation: 'The evidence is always in the passage — your job is to find it, not infer it.',
  action: 'On your next session, underline the key sentence before answering each question.',
  // Writing/Speaking eval schema
  overallBand: 7.0,
  criteria: [
    { name: 'Task Achievement', band: 7.0, feedback: 'Good.' },
    { name: 'Coherence',        band: 7.0, feedback: 'Clear structure.' },
    { name: 'Lexical Resource', band: 6.5, feedback: 'Adequate range.' },
    { name: 'Grammar',          band: 7.0, feedback: 'Minor errors only.' },
  ],
};

// ─────────────────────────────────────────────────────────────────
// SETUP HELPERS
// ─────────────────────────────────────────────────────────────────

async function setupMocks(page, student) {
  const aiBody = JSON.stringify({
    choices: [{ message: { content: JSON.stringify(MOCK_AI) } }],
  });

  // 1. firebase-config.js (local file)
  await page.route('**/firebase-config.js', route =>
    route.fulfill({
      contentType: 'application/javascript; charset=utf-8',
      body: `export const auth = {}; export const db = {}; export const googleProvider = {};`,
    })
  );

  // 2. Firebase Auth SDK (CDN)
  const userJson = JSON.stringify({
    uid: student.uid,
    email: student.email,
    displayName: student.name,
    photoURL: null,
  });
  await page.route('https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js', route =>
    route.fulfill({
      contentType: 'application/javascript; charset=utf-8',
      body: `
        export function onAuthStateChanged(auth, cb) {
          setTimeout(() => cb(${userJson}), 80);
          return () => {};
        }
        export function signOut() { return Promise.resolve(); }
        export function signInWithPopup() { return Promise.resolve({ user: ${userJson} }); }
      `,
    })
  );

  // 3. Firestore SDK (CDN)
  const studentJson = JSON.stringify(student);
  await page.route('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js', route =>
    route.fulfill({
      contentType: 'application/javascript; charset=utf-8',
      body: `
        const _d = ${studentJson};
        export function doc() { return {}; }
        export async function getDoc() { return { exists: () => true, data: () => ({ ..._d }) }; }
        export async function setDoc() {}
        export async function updateDoc() {}
        export async function addDoc() { return { id: 'test-' + Date.now() }; }
        export function collection() { return {}; }
        export async function getDocs() { return { docs: [] }; }
        export function orderBy() { return {}; }
        export function query(c) { return c; }
        export function serverTimestamp() { return new Date().toISOString(); }
        export async function deleteDoc() {}
      `,
    })
  );

  // 4. AI API (Vercel proxy)
  await page.route('https://toody-api.vercel.app/api/generate', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: aiBody })
  );

  // 5. Audio API
  await page.route('https://toody-api.vercel.app/api/audio', route =>
    route.fulfill({ status: 200, contentType: 'audio/mpeg', body: Buffer.from([]) })
  );
}

// Navigate to app and wait for home screen
async function loadApp(page, student) {
  await setupMocks(page, student);
  await page.goto(BASE_URL);
  await page.waitForURL('**/app.html', { timeout: 15000 });
  await page.waitForSelector('#s-home.active', { timeout: 15000 });
}

// Navigate all the way into a reading TF/NG session
async function goToReadingSession(page) {
  await loadApp(page, experiencedStudent);
  await page.evaluate(() => window.goToSession('reading.tfng'));
  await page.waitForSelector('#s-reading.active', { timeout: 8000 });
  await page.waitForSelector('#reading-passage p', { timeout: 20000 });
}

// Answer all 5 questions with the correct mock answers and submit
async function answerAndSubmit(page) {
  const answers = ['True', 'False', 'NG', 'True', 'False'];
  for (let i = 1; i <= 5; i++) {
    await page.locator(`#tfng${i} .tfng-btn[data-v="${answers[i - 1]}"]`).click();
    await page.waitForTimeout(150);
  }
  await expect(page.locator('#btn-reading-submit')).not.toBeDisabled({ timeout: 3000 });
  await page.click('#btn-reading-submit');
}

// Navigate from submit through optional TL and tip screens to notebook
async function navigateToNotebook(page) {
  await answerAndSubmit(page);

  // Handle Tough Love if it appears
  const afterSubmit = await Promise.race([
    page.waitForSelector('#s-toughlove.active', { timeout: 8000 }).then(() => 'tl'),
    page.waitForSelector('#s-tip.active',       { timeout: 8000 }).then(() => 'tip'),
    page.waitForSelector('#s-notebook.active',  { timeout: 8000 }).then(() => 'nb'),
  ]);

  if (afterSubmit === 'tl') {
    await page.locator('.hint-btn').first().click();
    await page.waitForSelector('#btn-tl-continue:not([disabled])', { timeout: 3000 });
    await page.click('#btn-tl-continue');
  }

  // Handle tip
  const afterTl = await Promise.race([
    page.waitForSelector('#s-tip.active',      { timeout: 8000 }).then(() => 'tip'),
    page.waitForSelector('#s-notebook.active', { timeout: 8000 }).then(() => 'nb'),
  ]);

  if (afterTl === 'tip') {
    await page.waitForSelector('#tip-done-btn:not(.hidden)', { timeout: 8000 });
    await page.click('#tip-done-btn');
    await page.waitForSelector('#s-notebook.active', { timeout: 8000 });
  }
}

// ─────────────────────────────────────────────────────────────────
// TEST 1 — Login page
// ─────────────────────────────────────────────────────────────────
test.describe('Test 1 — Login page', () => {
  test('shows all login elements with correct tagline', async ({ page }) => {
    await page.goto(BASE_URL);

    await expect(page.locator('.login-name')).toBeVisible();
    await expect(page.getByRole('button', { name: /Continue with Google/i })).toBeVisible();
    await expect(page.locator('.login-tagline')).toBeVisible();
    await expect(page.locator('.login-tagline')).toContainText('Toody gets you to your target band');
    await expect(page.locator('.login-logo')).toBeVisible();
  });

  test('logo is an <img> (no SVG grey-box)', async ({ page }) => {
    await page.goto(BASE_URL);
    const logoTag = await page.locator('.login-logo').evaluate(el => el.tagName.toLowerCase());
    expect(logoTag).toBe('img');
  });
});

// ─────────────────────────────────────────────────────────────────
// TEST 2 — Briefing cards
// ─────────────────────────────────────────────────────────────────
test.describe('Test 2 — Briefing cards', () => {
  test('3 cards appear in correct order', async ({ page }) => {
    await loadApp(page, newStudent);

    // startSession → session intro → I'm ready → briefing gate
    await page.evaluate(() => window.startSession && window.startSession());
    await page.waitForSelector('#s-session-intro.active', { timeout: 8000 });
    await page.click('#btn-ready');
    await page.waitForSelector('#s-briefing.active', { timeout: 8000 });

    // Card 1 — THE INSIGHT
    await expect(page.locator('#bc-0')).not.toHaveClass(/hidden/);
    await expect(page.locator('#bc-0 .bc-eyebrow')).toHaveText('THE INSIGHT');
    await expect(page.locator('#bc-0 .bc-title')).toContainText("What the examiner knows");

    // 3 progress dots
    await expect(page.locator('#briefing-dots .bc-dot')).toHaveCount(3);

    // Advance → Card 2 — YOUR PROGRAMME
    await page.click('#bc-0 .bc-btn');
    await expect(page.locator('#bc-1')).not.toHaveClass(/hidden/);
    await expect(page.locator('#bc-1 .bc-eyebrow')).toHaveText('YOUR PROGRAMME');
    await expect(page.locator('#bc-1 .bc-title')).toContainText('How Toody works');

    // Advance → Card 3 — NEXT UP
    await page.click('#bc-1 .bc-btn');
    await expect(page.locator('#bc-2')).not.toHaveClass(/hidden/);
    await expect(page.locator('#bc-2 .bc-eyebrow')).toHaveText('NEXT UP');
    await expect(page.locator('#bc-2 .bc-title')).toContainText('A quick IELTS overview');
  });
});

// ─────────────────────────────────────────────────────────────────
// TEST 3 — Teach-First flow
// ─────────────────────────────────────────────────────────────────
test.describe('Test 3 — Teach-First flow', () => {
  test('hook question loads with 3 neutral buttons', async ({ page }) => {
    await loadApp(page, teachFirstStudent);
    await page.evaluate(() => window.goToSession('reading.tfng'));
    await page.waitForSelector('#s-teach.active', { timeout: 8000 });
    await page.waitForSelector('#teach-hook:not(.hidden)', { timeout: 20000 });

    const btns = page.locator('#teach-hook-btns .tfng-btn');
    await expect(btns).toHaveCount(3);

    // No button should be pre-selected
    for (let i = 0; i < 3; i++) {
      await expect(btns.nth(i)).not.toHaveClass(/correct/);
      await expect(btns.nth(i)).not.toHaveClass(/wrong/);
    }
  });

  test('clicking hook answer reveals explanation', async ({ page }) => {
    await loadApp(page, teachFirstStudent);
    await page.evaluate(() => window.goToSession('reading.tfng'));
    await page.waitForSelector('#teach-hook:not(.hidden)', { timeout: 20000 });

    await page.locator('#teach-hook-btns .tfng-btn').first().click();
    await expect(page.locator('#teach-hook-reveal')).not.toHaveClass(/hidden/);
  });

  test('concept phase appears after hook', async ({ page }) => {
    await loadApp(page, teachFirstStudent);
    await page.evaluate(() => window.goToSession('reading.tfng'));
    await page.waitForSelector('#teach-hook:not(.hidden)', { timeout: 20000 });

    await page.locator('#teach-hook-btns .tfng-btn').first().click();
    await page.waitForSelector('#teach-hook-reveal:not(.hidden)', { timeout: 3000 });
    await page.click('text=Let me explain');
    await expect(page.locator('#teach-concept:not(.hidden)')).toBeVisible({ timeout: 5000 });
  });
});

// ─────────────────────────────────────────────────────────────────
// TEST 4 — Reading session (CRITICAL)
// ─────────────────────────────────────────────────────────────────
test.describe('Test 4 — Reading session (CRITICAL)', () => {
  test('passage and 5 questions load within 15 seconds', async ({ page }) => {
    const start = Date.now();
    await goToReadingSession(page);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(15000);
    await expect(page.locator('#reading-passage')).not.toBeEmpty();
    await expect(page.locator('.q-block')).toHaveCount(5);
  });

  test('TF/NG buttons are present and neutral on load', async ({ page }) => {
    await goToReadingSession(page);

    for (let i = 1; i <= 5; i++) {
      const btns = page.locator(`#tfng${i} .tfng-btn`);
      await expect(btns).toHaveCount(3);
      for (let j = 0; j < 3; j++) {
        await expect(btns.nth(j)).not.toHaveClass(/correct/);
        await expect(btns.nth(j)).not.toHaveClass(/wrong/);
      }
    }
  });

  test('submit button disabled until all questions answered', async ({ page }) => {
    await goToReadingSession(page);
    await expect(page.locator('#btn-reading-submit')).toBeDisabled();

    // Answer Q1 only — still disabled
    await page.locator('#tfng1 .tfng-btn[data-v="True"]').click();
    await expect(page.locator('#btn-reading-submit')).toBeDisabled();
  });
});

// ─────────────────────────────────────────────────────────────────
// TEST 5 — Answer feedback
// ─────────────────────────────────────────────────────────────────
test.describe('Test 5 — Answer feedback', () => {
  test('correct answer shows green feedback', async ({ page }) => {
    await goToReadingSession(page);

    // Q1 correct answer is "True"
    await page.locator('#tfng1 .tfng-btn[data-v="True"]').click();
    await expect(page.locator('#tfng1 .tfng-btn[data-v="True"]')).toHaveClass(/correct/);
    await expect(page.locator('#rf1')).toContainText('✅');
  });

  test('wrong answer shows red feedback and reveals correct button', async ({ page }) => {
    await goToReadingSession(page);

    // Q1 correct is "True" — click False (wrong)
    await page.locator('#tfng1 .tfng-btn[data-v="False"]').click();
    await expect(page.locator('#tfng1 .tfng-btn[data-v="False"]')).toHaveClass(/wrong/);
    await expect(page.locator('#tfng1 .tfng-btn[data-v="True"]')).toHaveClass(/correct/);
    await expect(page.locator('#rf1')).toContainText('❌');
  });

  test('no double emoji in feedback', async ({ page }) => {
    await goToReadingSession(page);
    await page.locator('#tfng1 .tfng-btn[data-v="True"]').click();

    const rfText = await page.locator('#rf1').textContent();
    const count = (rfText.match(/✅/g) || []).length;
    expect(count).toBe(1);
  });

  test('answer normalisation — Not Given matches regardless of format', async ({ page }) => {
    await goToReadingSession(page);

    // Q3 answer is "NG" — clicking the NG button should be marked correct
    await page.locator('#tfng3 .tfng-btn[data-v="NG"]').click();
    await expect(page.locator('#tfng3 .tfng-btn[data-v="NG"]')).toHaveClass(/correct/);
  });
});

// ─────────────────────────────────────────────────────────────────
// TEST 6 — Tough Love Check
// ─────────────────────────────────────────────────────────────────
test.describe('Test 6 — Tough Love Check', () => {
  test('TL or notebook appears after submitting all answers', async ({ page }) => {
    await goToReadingSession(page);
    await answerAndSubmit(page);

    const screen = await Promise.race([
      page.waitForSelector('#s-toughlove.active', { timeout: 10000 }).then(() => 'tl'),
      page.waitForSelector('#s-tip.active',       { timeout: 10000 }).then(() => 'tip'),
      page.waitForSelector('#s-notebook.active',  { timeout: 10000 }).then(() => 'nb'),
    ]);
    expect(['tl', 'tip', 'nb']).toContain(screen);
  });

  test('TL screen shows 4 sentence options when it appears', async ({ page }) => {
    await goToReadingSession(page);
    await answerAndSubmit(page);

    const screen = await Promise.race([
      page.waitForSelector('#s-toughlove.active', { timeout: 10000 }).then(() => 'tl'),
      page.waitForSelector('#s-tip.active',       { timeout: 10000 }).then(() => 'skip'),
      page.waitForSelector('#s-notebook.active',  { timeout: 10000 }).then(() => 'skip'),
    ]);

    if (screen === 'tl') {
      await expect(page.locator('.hint-btn')).toHaveCount(4);
    }
    // If TL wasn't shown, test passes — TL only shows if at least one answer is correct
  });
});

// ─────────────────────────────────────────────────────────────────
// TEST 7 — Notebook
// ─────────────────────────────────────────────────────────────────
test.describe('Test 7 — Notebook', () => {
  test('notebook loads after completing a session', async ({ page }) => {
    await goToReadingSession(page);
    await navigateToNotebook(page);

    await expect(page.locator('#s-notebook')).toBeVisible();
    await expect(page.locator('#nb-questions-done')).toBeVisible();
    await expect(page.locator('#nb-band-est')).toBeVisible();
    await expect(page.locator('#nb-day-badge')).toBeVisible();
  });

  test('skill bars are visible in notebook', async ({ page }) => {
    await goToReadingSession(page);
    await navigateToNotebook(page);

    // Skill bar elements exist in the notebook
    await expect(page.locator('#nb-tfng-bar, #nb-mh-bar, #nb-mc-bar').first()).toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────
// TEST 8 — Navigation
// ─────────────────────────────────────────────────────────────────
test.describe('Test 8 — Navigation', () => {
  test('home screen has sign-out button (no back nav)', async ({ page }) => {
    await loadApp(page, experiencedStudent);
    // Home only has the sign-out (↩) button — no back button
    await expect(page.locator('#s-home .nav-btn')).toHaveCount(1);
  });

  test('session intro shows back-to-home button', async ({ page }) => {
    await loadApp(page, experiencedStudent);
    await page.evaluate(() => window.startSession && window.startSession());
    await page.waitForSelector('#s-session-intro.active', { timeout: 8000 });
    await expect(page.locator('#s-session-intro .nav-btn')).toBeVisible();
  });

  test('back button from session intro returns to home', async ({ page }) => {
    await loadApp(page, experiencedStudent);
    await page.evaluate(() => window.startSession && window.startSession());
    await page.waitForSelector('#s-session-intro.active', { timeout: 8000 });

    await page.locator('#s-session-intro .nav-btn').click();
    await page.waitForSelector('#s-home.active', { timeout: 5000 });
    await expect(page.locator('#s-home')).toHaveClass(/active/);
  });
});

// ─────────────────────────────────────────────────────────────────
// TEST 9 — Button state reset
// ─────────────────────────────────────────────────────────────────
test.describe('Test 9 — Button state reset', () => {
  test('buttons reset correctly after navigating away and back', async ({ page }) => {
    await loadApp(page, experiencedStudent);

    // --- Round 1: first entry — btn-ready must be enabled ---
    await page.evaluate(() => window.startSession && window.startSession());
    await page.waitForSelector('#s-session-intro.active', { timeout: 8000 });
    await expect(page.locator('#btn-ready')).not.toBeDisabled();

    // Tap btn-ready — inline onclick sets this.disabled=true, then calls goToSession()
    await page.click('#btn-ready');
    // Wait for session navigation to complete (any skill screen)
    await Promise.race([
      page.waitForSelector('#s-reading.active',   { timeout: 15000 }),
      page.waitForSelector('#s-listening.active',  { timeout: 15000 }),
      page.waitForSelector('#s-writing.active',    { timeout: 15000 }),
      page.waitForSelector('#s-speaking.active',   { timeout: 15000 }),
      page.waitForSelector('#s-teach.active',      { timeout: 15000 }),
      page.waitForSelector('#s-warmup.active',     { timeout: 15000 }),
    ]);
    // Navigate back to home
    await page.evaluate(() => window.goToHome && window.goToHome());
    await page.waitForSelector('#s-home.active', { timeout: 5000 });

    // --- Round 2: re-entry — btn-ready must be reset, not stuck disabled ---
    // Reset the startSession guard (3s cooldown) before re-entry
    await page.evaluate(() => { window._startSessionRunning = false; window.startSession && window.startSession(); });
    await page.waitForSelector('#s-session-intro.active', { timeout: 8000 });
    await expect(page.locator('#btn-ready')).not.toBeDisabled();

    // --- Round 3: repeat once more for consistency ---
    await page.click('#btn-ready');
    await Promise.race([
      page.waitForSelector('#s-reading.active',   { timeout: 15000 }),
      page.waitForSelector('#s-listening.active',  { timeout: 15000 }),
      page.waitForSelector('#s-writing.active',    { timeout: 15000 }),
      page.waitForSelector('#s-speaking.active',   { timeout: 15000 }),
      page.waitForSelector('#s-teach.active',      { timeout: 15000 }),
      page.waitForSelector('#s-warmup.active',     { timeout: 15000 }),
    ]);
    await page.evaluate(() => window.goToHome && window.goToHome());
    await page.waitForSelector('#s-home.active', { timeout: 5000 });
    await page.evaluate(() => { window._startSessionRunning = false; window.startSession && window.startSession(); });
    await page.waitForSelector('#s-session-intro.active', { timeout: 8000 });
    await expect(page.locator('#btn-ready')).not.toBeDisabled();
  });
});
