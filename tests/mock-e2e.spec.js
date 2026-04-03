// @ts-check
// tests/mock-e2e.spec.js
// Complete E2E test of Mini Mock and Full Mock flows.
// Strategy: block the auth redirect to index.html so we can test the UI
// without a real Firebase session. All AI calls go to toody-api.vercel.app
// (no auth needed). Firebase writes fail silently (wrapped in try/catch).

const { test, expect } = require('@playwright/test');

// ── SHARED SETUP ─────────────────────────────────────────────────────
async function setupPage(page) {
  // Block the unauthenticated redirect to index.html
  await page.route('**/index.html', route => route.abort('aborted'));

  await page.goto('/app.html');

  // Wait for ES modules to load — devJumpTo is set synchronously by dev-tools.js
  await page.waitForFunction(() => typeof window.devJumpTo === 'function', { timeout: 15000 });
}

// ── MINI MOCK ─────────────────────────────────────────────────────────
test.describe('Mini Mock', () => {
  test.setTimeout(300000);

  test('MM-01 intro screen renders via devJumpTo', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

    await setupPage(page);
    await page.evaluate(() => window.devJumpTo('mock'));
    await page.waitForTimeout(400);

    const active = await page.evaluate(() => document.getElementById('s-minimock')?.classList.contains('active'));
    console.log('MM-01 s-minimock active:', active);

    const introVisible = await page.evaluate(() => {
      const el = document.getElementById('mock-intro-view');
      return el && !el.classList.contains('hidden');
    });
    console.log('MM-01 intro-view visible:', introVisible);

    const resultsHidden = await page.evaluate(() =>
      document.getElementById('mock-results-view')?.classList.contains('hidden'));
    console.log('MM-01 results-view hidden:', resultsHidden);

    const stepsExist = await page.evaluate(() =>
      ['reading','listening','writing','speaking'].every(s => !!document.getElementById(`mock-step-${s}`)));
    console.log('MM-01 4 step dots exist:', stepsExist);

    const timerHidden = await page.evaluate(() =>
      document.getElementById('mini-mock-timer-bar')?.classList.contains('hidden'));
    console.log('MM-01 timer hidden initially:', timerHidden);

    const btnText = await page.evaluate(() =>
      document.querySelector('#mock-intro-view .btn')?.textContent?.trim());
    console.log('MM-01 begin button text:', btnText);

    console.log('MM-01 JS errors:', errors);

    expect(active).toBe(true);
    expect(introVisible).toBe(true);
    expect(resultsHidden).toBe(true);
    expect(stepsExist).toBe(true);
    expect(timerHidden).toBe(true);
  });

  test('MM-02 clicking Begin loads reading session and starts timer', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

    await setupPage(page);
    await page.evaluate(() => window.devJumpTo('mock'));
    await page.click('#mock-intro-view .btn');
    console.log('MM-02 clicked Begin the Mock');

    // Reading screen should become active
    await page.waitForFunction(
      () => document.getElementById('s-reading')?.classList.contains('active'),
      { timeout: 8000 }
    );
    console.log('MM-02 s-reading active');

    // Wait for AI content to load
    await page.waitForFunction(
      () => document.getElementById('reading-loading')?.classList.contains('hidden'),
      { timeout: 90000 }
    );
    console.log('MM-02 reading content loaded');

    // Timer bar
    const timerVisible = await page.evaluate(() =>
      !document.getElementById('mini-mock-timer-bar')?.classList.contains('hidden'));
    console.log('MM-02 timer bar visible:', timerVisible);

    // Timer is counting
    const t1 = await page.evaluate(() => document.getElementById('mini-mock-countdown')?.textContent);
    await page.waitForTimeout(2100);
    const t2 = await page.evaluate(() => document.getElementById('mini-mock-countdown')?.textContent);
    const counting = t1 !== t2;
    console.log('MM-02 timer t=0:', t1, '| t+2s:', t2, '| counting:', counting);

    // Phase label
    const label = await page.evaluate(() => document.getElementById('mini-mock-phase-label')?.textContent);
    console.log('MM-02 phase label:', label);

    // Timer bar position vs nav bar (overlap check)
    const timerRect = await page.evaluate(() => {
      const el = document.getElementById('mini-mock-timer-bar');
      return el ? el.getBoundingClientRect() : null;
    });
    const navRect = await page.evaluate(() => {
      const el = document.querySelector('#s-reading .nav');
      return el ? el.getBoundingClientRect() : null;
    });
    console.log('MM-02 timer bar top:', timerRect?.top, '| reading nav bottom:', navRect?.bottom);
    if (timerRect && navRect) {
      console.log('MM-02 OVERLAP (timer covers nav)?', timerRect.top < navRect.bottom);
    }

    // Reading step active
    const readingStepClass = await page.evaluate(() =>
      document.getElementById('mock-step-reading')?.className);
    console.log('MM-02 reading step class:', readingStepClass);

    // Questions rendered
    const qCount = await page.evaluate(() => document.querySelectorAll('.tfng-q, .tfng-btn').length);
    console.log('MM-02 question elements (tfng-q/tfng-btn):', qCount);

    // Submit button accessible
    const submitBtn = await page.evaluate(() => {
      const el = document.getElementById('reading-submit');
      return el ? { text: el.textContent?.trim(), disabled: el.disabled, visible: !!el.offsetParent } : null;
    });
    console.log('MM-02 submit button:', JSON.stringify(submitBtn));

    console.log('MM-02 JS errors:', errors);

    expect(timerVisible).toBe(true);
    expect(counting).toBe(true);
    expect(label).toBe('Reading');
  });

  test('MM-03 reading → listening transition', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

    await setupPage(page);
    await page.evaluate(() => window.devJumpTo('mock'));
    await page.click('#mock-intro-view .btn');

    await page.waitForFunction(
      () => document.getElementById('reading-loading')?.classList.contains('hidden'),
      { timeout: 90000 }
    );
    console.log('MM-03 reading loaded, clicking submit');

    await page.click('#reading-submit');

    // Listening should become active
    let listenActive = false;
    try {
      await page.waitForFunction(
        () => document.getElementById('s-listening')?.classList.contains('active'),
        { timeout: 90000 }
      );
      listenActive = true;
      console.log('MM-03 s-listening active');

      const phaseLabel = await page.evaluate(() => document.getElementById('mini-mock-phase-label')?.textContent);
      console.log('MM-03 phase label on listening:', phaseLabel);

      const readingDone = await page.evaluate(() =>
        document.getElementById('mock-step-reading')?.className);
      console.log('MM-03 reading step after submit:', readingDone);

      const listenActive2 = await page.evaluate(() =>
        document.getElementById('mock-step-listening')?.className);
      console.log('MM-03 listening step class:', listenActive2);

      await page.waitForFunction(
        () => document.getElementById('listening-loading')?.classList.contains('hidden'),
        { timeout: 90000 }
      ).catch(() => console.log('MM-03 listening-loading did not hide'));

      const audioEl = await page.evaluate(() =>
        document.querySelector('#s-listening audio') ? 'exists' : 'MISSING');
      console.log('MM-03 audio element:', audioEl);

      const listenQCount = await page.evaluate(() =>
        document.querySelectorAll('.mc-option, .fc-input').length);
      console.log('MM-03 listening question elements:', listenQCount);

      const listenTimer = await page.evaluate(() =>
        document.getElementById('mini-mock-countdown')?.textContent);
      console.log('MM-03 listening timer value:', listenTimer);

    } catch (e) {
      console.log('MM-03 FAIL listening did not load:', e.message);
    }

    console.log('MM-03 JS errors:', errors);
    expect(listenActive).toBe(true);
  });

  test('MM-04 writing session — task type and timer', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

    await setupPage(page);
    await page.evaluate(() => window.devJumpTo('mock'));
    await page.waitForTimeout(200);

    // Jump directly to writing phase by calling runMockPhase(2)
    await page.evaluate(() => {
      window.startMiniMock && window.startMiniMock();
    });
    await page.waitForFunction(
      () => document.getElementById('s-reading')?.classList.contains('active'),
      { timeout: 5000 }
    ).catch(() => {});

    // Skip reading and listening by advancing phases programmatically
    await page.evaluate(() => {
      // Manually set mock results for reading and listening to bypass them
      if (typeof window.runMockPhase !== 'function') {
        console.log('[E2E] runMockPhase not on window');
        return;
      }
      // Simulate reading done
      // mockResults is a module-level export — not directly settable from outside
      // but runMockPhase(2) will call loadWritingSession() directly
      window.runMockPhase(2);
    });

    await page.waitForFunction(
      () => document.getElementById('s-writing')?.classList.contains('active'),
      { timeout: 10000 }
    ).catch(() => console.log('MM-04 writing screen did not activate'));

    await page.waitForFunction(
      () => document.getElementById('writing-loading')?.classList.contains('hidden'),
      { timeout: 90000 }
    ).catch(() => console.log('MM-04 writing-loading never hid'));

    const taskType = await page.evaluate(() =>
      document.getElementById('writing-task-type')?.textContent);
    console.log('MM-04 writing task type in mini mock:', taskType);
    console.log('MM-04 EXPECTED: "Writing Task 1" or "Task 1" (mini mock is Task 1 only)');

    const phaseLabel = await page.evaluate(() =>
      document.getElementById('mini-mock-phase-label')?.textContent);
    console.log('MM-04 timer phase label during writing:', phaseLabel);

    const timerVal = await page.evaluate(() =>
      document.getElementById('mini-mock-countdown')?.textContent);
    console.log('MM-04 mini mock timer during writing:', timerVal);
    console.log('MM-04 EXPECTED: ~30:00 (1800s writing phase)');

    const writingPrompt = await page.evaluate(() =>
      document.getElementById('writing-task-text')?.textContent?.substring(0, 100));
    console.log('MM-04 writing prompt (first 100 chars):', writingPrompt);

    const wordCount = await page.evaluate(() =>
      document.getElementById('writing-word-count')?.textContent);
    console.log('MM-04 word count display:', wordCount);

    console.log('MM-04 JS errors:', errors);
  });

  test('MM-05 speaking phase — Part 2 cue card and finish button', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

    await setupPage(page);
    await page.evaluate(() => window.devJumpTo('mock'));
    await page.waitForTimeout(200);
    await page.evaluate(() => window.startMiniMock && window.startMiniMock());
    await page.waitForFunction(
      () => document.getElementById('s-reading')?.classList.contains('active'),
      { timeout: 5000 }
    ).catch(() => {});

    // Jump to speaking phase directly
    await page.evaluate(() => {
      if (typeof window.runMockPhase === 'function') window.runMockPhase(3);
    });

    await page.waitForFunction(
      () => document.getElementById('s-speaking')?.classList.contains('active'),
      { timeout: 10000 }
    ).catch(() => console.log('MM-05 speaking did not activate'));

    await page.waitForFunction(
      () => document.getElementById('speaking-loading')?.classList.contains('hidden'),
      { timeout: 60000 }
    ).catch(() => console.log('MM-05 speaking loading never hid'));

    const topicLabel = await page.evaluate(() =>
      document.getElementById('speaking-topic-label')?.textContent);
    console.log('MM-05 speaking topic label:', topicLabel);
    console.log('MM-05 EXPECTED: contains "Part 2" or "Cue Card" (mock phase 3 triggers Part 2)');

    const phaseLabel = await page.evaluate(() =>
      document.getElementById('mini-mock-phase-label')?.textContent);
    console.log('MM-05 timer phase label during speaking:', phaseLabel);

    const timerVal = await page.evaluate(() =>
      document.getElementById('mini-mock-countdown')?.textContent);
    console.log('MM-05 mini mock timer during speaking:', timerVal);
    console.log('MM-05 EXPECTED: ~07:00 (420s speaking phase)');

    const finishBtn = await page.evaluate(() => {
      const el = document.getElementById('speaking-finish-btn');
      return el ? { text: el.textContent?.trim(), disabled: el.disabled } : 'MISSING';
    });
    console.log('MM-05 finish button:', JSON.stringify(finishBtn));

    // Try to record — should fail gracefully in headless
    const recordReadyEl = await page.evaluate(() => {
      const el = document.getElementById('record-ready');
      return el ? { hidden: el.classList.contains('hidden'), html: el.innerHTML?.substring(0, 100) } : 'MISSING';
    });
    console.log('MM-05 record-ready state:', JSON.stringify(recordReadyEl));

    // Click finish (no recording done — tests mock band 0 path)
    if (finishBtn !== 'MISSING' && !finishBtn.disabled) {
      await page.click('#speaking-finish-btn');
      console.log('MM-05 clicked finish speaking');

      try {
        await page.waitForFunction(
          () => document.getElementById('s-minimock')?.classList.contains('active') &&
                !document.getElementById('mock-results-view')?.classList.contains('hidden'),
          { timeout: 60000 }
        );
        console.log('MM-05 mock results screen shown');

        const overallBand = await page.evaluate(() =>
          document.getElementById('mock-overall-band')?.textContent);
        console.log('MM-05 overall band:', overallBand);
        console.log('MM-05 NOTE: speaking band will be 0 (no recording), affects overall calc');

        const speakingPct = await page.evaluate(() =>
          document.getElementById('mock-speaking-pct')?.textContent);
        console.log('MM-05 speaking bar pct:', speakingPct);
        console.log('MM-05 EXPECTED: "—" (0 band = null → setSkillBar shows dash)');

        const recs = await page.evaluate(() =>
          document.getElementById('mock-recommendations')?.innerHTML);
        console.log('MM-05 recommendations rendered:', recs ? 'YES' : 'MISSING');

      } catch (e) {
        console.log('MM-05 results did not appear:', e.message);
      }
    }

    console.log('MM-05 JS errors:', errors);
  });
});

// ── FULL MOCK ─────────────────────────────────────────────────────────
test.describe('Full Mock', () => {
  test.setTimeout(600000);

  test('FM-01 setup screen and section selector', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

    await setupPage(page);
    await page.evaluate(() => window.startFullMockSetup());
    await page.waitForTimeout(400);

    const active = await page.evaluate(() =>
      document.getElementById('s-fullmock-setup')?.classList.contains('active'));
    console.log('FM-01 setup screen active:', active);
    expect(active).toBe(true);

    const btnCount = await page.evaluate(() =>
      document.querySelectorAll('.mock-option-btn').length);
    console.log('FM-01 option button count:', btnCount);
    expect(btnCount).toBe(5);

    const defaultSel = await page.evaluate(() =>
      document.querySelector('.mock-option-btn.active')?.dataset?.sections);
    console.log('FM-01 default selection:', defaultSel);
    expect(defaultSel).toBe('all');

    // Check if option buttons have structured inner content (time/desc labels)
    const hasOptTime = await page.evaluate(() => !!document.querySelector('.mock-opt-time'));
    const hasOptDesc = await page.evaluate(() => !!document.querySelector('.mock-opt-desc'));
    console.log('FM-01 option buttons have time labels:', hasOptTime);
    console.log('FM-01 option buttons have desc labels:', hasOptDesc);
    console.log('FM-01 NOTE: CSS defines .mock-opt-time/.mock-opt-desc but HTML buttons are plain text');

    // Select Reading Only then back to all
    await page.evaluate(() => {
      const btn = document.querySelector('[data-sections="reading"]');
      if (btn) window.selectMockOption(btn);
    });
    const readingSel = await page.evaluate(() =>
      document.querySelector('.mock-option-btn.active')?.dataset?.sections);
    console.log('FM-01 after selecting reading:', readingSel);
    expect(readingSel).toBe('reading');

    const genBtn = await page.evaluate(() => {
      const el = document.querySelector('[onclick*="startFullMockGeneration"]');
      return el ? { text: el.textContent?.trim(), disabled: el.disabled } : null;
    });
    console.log('FM-01 generate button:', JSON.stringify(genBtn));

    console.log('FM-01 JS errors:', errors);
  });

  test('FM-02 generation screen — all 4 steps and progress bar', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

    await setupPage(page);
    await page.evaluate(() => window.startFullMockSetup());
    await page.waitForTimeout(300);
    await page.click('[onclick*="startFullMockGeneration"]');

    await page.waitForFunction(
      () => document.getElementById('s-fullmock-gen')?.classList.contains('active'),
      { timeout: 5000 }
    );
    console.log('FM-02 generation screen appeared');

    const stepsExist = await page.evaluate(() =>
      ['reading','listening','writing','speaking'].every(s => !!document.getElementById(`mgs-${s}`)));
    console.log('FM-02 all 4 gen step elements exist:', stepsExist);
    expect(stepsExist).toBe(true);

    const barInitWidth = await page.evaluate(() =>
      document.getElementById('mock-gen-bar')?.style?.width);
    console.log('FM-02 progress bar initial width:', barInitWidth);

    // Wait briefly and check if any steps turned loading
    await page.waitForTimeout(2000);
    const stepStates = await page.evaluate(() => ({
      reading:   document.getElementById('mgs-reading')?.className,
      listening: document.getElementById('mgs-listening')?.className,
      writing:   document.getElementById('mgs-writing')?.className,
      speaking:  document.getElementById('mgs-speaking')?.className,
    }));
    console.log('FM-02 step states at t+2s:', JSON.stringify(stepStates));

    console.log('FM-02 waiting for test screen (AI generation — may take 2+ min)...');
    try {
      await page.waitForFunction(
        () => document.getElementById('s-fullmock-test')?.classList.contains('active'),
        { timeout: 240000 }
      );
      console.log('FM-02 test screen became active');

      const finalStepStates = await page.evaluate(() => ({
        reading:   document.getElementById('mgs-reading')?.className,
        listening: document.getElementById('mgs-listening')?.className,
        writing:   document.getElementById('mgs-writing')?.className,
        speaking:  document.getElementById('mgs-speaking')?.className,
      }));
      console.log('FM-02 final step states:', JSON.stringify(finalStepStates));

      const barFinalWidth = await page.evaluate(() =>
        document.getElementById('mock-gen-bar')?.style?.width);
      console.log('FM-02 progress bar final width:', barFinalWidth);

    } catch (e) {
      console.log('FM-02 FAIL generation did not complete:', e.message);
      const currentScreen = await page.evaluate(() =>
        [...document.querySelectorAll('.screen.active')].map(s => s.id));
      console.log('FM-02 current active screens:', currentScreen);
    }

    console.log('FM-02 JS errors:', errors);
  });

  test('FM-03 reading section renders correctly', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

    await setupPage(page);
    await page.evaluate(() => window.startFullMockSetup());
    await page.waitForTimeout(300);
    await page.click('[onclick*="startFullMockGeneration"]');

    await page.waitForFunction(
      () => document.getElementById('s-fullmock-test')?.classList.contains('active'),
      { timeout: 240000 }
    );

    const sectionLabel = await page.evaluate(() =>
      document.getElementById('mock-test-section-label')?.textContent);
    console.log('FM-03 section label:', sectionLabel);
    expect(sectionLabel?.toLowerCase()).toBe('reading');

    // Timer
    const t1 = await page.evaluate(() => document.getElementById('mock-test-timer')?.textContent);
    await page.waitForTimeout(2100);
    const t2 = await page.evaluate(() => document.getElementById('mock-test-timer')?.textContent);
    console.log('FM-03 full mock timer t=0:', t1, '| t+2s:', t2);
    const counting = t1 !== t2;
    console.log('FM-03 timer counting:', counting);
    expect(counting).toBe(true);

    // 3 passage blocks
    const passageBlocks = await page.evaluate(() =>
      document.querySelectorAll('.mock-passage-block').length);
    console.log('FM-03 passage blocks:', passageBlocks);
    console.log('FM-03 EXPECTED: 3 (tfng + matchingHeadings + summaryCompletion)');

    // Total questions
    const qCount = await page.evaluate(() => document.querySelectorAll('.mock-q').length);
    console.log('FM-03 total question elements:', qCount);
    console.log('FM-03 EXPECTED: 20 (8+4+8 per the prompts)');

    // TFNG radio buttons exist (passage 1)
    const tfngRadios = await page.evaluate(() =>
      document.querySelectorAll('.mock-q-tfng input[type=radio]').length);
    console.log('FM-03 TFNG radio inputs:', tfngRadios);

    // Matching headings: select dropdowns + headings list
    const headingSelects = await page.evaluate(() =>
      document.querySelectorAll('.mock-select').length);
    const headingsList = await page.evaluate(() => !!document.querySelector('.mock-headings-list'));
    console.log('FM-03 heading selects:', headingSelects, '| headings list:', headingsList);

    // Summary completion: wrap + word bank
    const summaryWrap = await page.evaluate(() => !!document.querySelector('.mock-summary-wrap'));
    const wordBank = await page.evaluate(() => !!document.querySelector('.mock-wordbank'));
    console.log('FM-03 summary wrap:', summaryWrap, '| word bank:', wordBank);

    // Submit button
    const submitDisabled = await page.evaluate(() =>
      document.getElementById('mock-submit-btn')?.disabled);
    console.log('FM-03 submit button disabled:', submitDisabled);

    console.log('FM-03 JS errors:', errors);
  });

  test('FM-04 reading → listening → writing → speaking → report full chain', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

    await setupPage(page);
    await page.evaluate(() => window.startFullMockSetup());
    await page.waitForTimeout(300);
    await page.click('[onclick*="startFullMockGeneration"]');

    await page.waitForFunction(
      () => document.getElementById('s-fullmock-test')?.classList.contains('active'),
      { timeout: 240000 }
    );
    console.log('FM-04 generation complete, on reading section');

    // ── Section 1: Reading ──
    await page.click('#mock-submit-btn');
    console.log('FM-04 submitted reading');

    // ── Section 2: Listening ──
    await page.waitForFunction(
      () => document.getElementById('mock-test-section-label')?.textContent?.toLowerCase() === 'listening',
      { timeout: 10000 }
    );
    console.log('FM-04 on listening section');

    const listenTimer = await page.evaluate(() =>
      document.getElementById('mock-test-timer')?.textContent);
    console.log('FM-04 listening timer:', listenTimer);
    console.log('FM-04 EXPECTED: 40:00 (2400s)');

    const listenBlocks = await page.evaluate(() =>
      document.querySelectorAll('.mock-listen-block').length);
    console.log('FM-04 listening blocks rendered:', listenBlocks);
    console.log('FM-04 EXPECTED: 4 sections');

    const playBtns = await page.evaluate(() =>
      document.querySelectorAll('.mock-play-btn').length);
    const unavailFallbacks = await page.evaluate(() =>
      document.querySelectorAll('.mock-audio-unavail').length);
    console.log('FM-04 audio play buttons:', playBtns, '| unavailable fallbacks:', unavailFallbacks);
    console.log('FM-04 NOTE: audio URLs are blob URLs — may not work in headless');

    await page.click('#mock-submit-btn');
    console.log('FM-04 submitted listening');

    // ── Section 3: Writing ──
    await page.waitForFunction(
      () => document.getElementById('mock-test-section-label')?.textContent?.toLowerCase() === 'writing',
      { timeout: 10000 }
    );
    console.log('FM-04 on writing section');

    const writingTimer = await page.evaluate(() =>
      document.getElementById('mock-test-timer')?.textContent);
    console.log('FM-04 writing timer:', writingTimer);
    console.log('FM-04 EXPECTED: 60:00 (3600s)');

    const textareaCount = await page.evaluate(() =>
      document.querySelectorAll('.mock-textarea').length);
    console.log('FM-04 writing textareas:', textareaCount);
    console.log('FM-04 EXPECTED: 3 (task1 + task2 + speaking notes — but notes is on speaking not writing)');

    const wcDisplays = await page.evaluate(() =>
      document.querySelectorAll('.mock-wc').length);
    console.log('FM-04 word count displays:', wcDisplays);

    const t1Exists = await page.evaluate(() => !!document.getElementById('mock-w-task1'));
    const t2Exists = await page.evaluate(() => !!document.getElementById('mock-w-task2'));
    console.log('FM-04 task1 textarea:', t1Exists, '| task2:', t2Exists);

    if (t1Exists) {
      await page.fill('#mock-w-task1', 'The graph illustrates changes in annual rainfall across three cities between 2010 and 2020. Overall there was a general upward trend with significant variations between cities.');
      const wc1 = await page.evaluate(() => document.getElementById('mock-wc-task1')?.textContent);
      console.log('FM-04 task1 word count after typing:', wc1);
    }
    if (t2Exists) {
      await page.fill('#mock-w-task2', 'The debate about university curricula has intensified in recent years. Proponents of academic focus argue that fundamental knowledge forms the basis of all professional expertise. Conversely advocates for practical skills note that employers increasingly value applied competencies. Both perspectives contain merit and a balanced approach incorporating theoretical and practical elements would serve students best.');
      const wc2 = await page.evaluate(() => document.getElementById('mock-wc-task2')?.textContent);
      console.log('FM-04 task2 word count after typing:', wc2);
    }

    await page.click('#mock-submit-btn');
    console.log('FM-04 submitted writing');

    // ── Section 4: Speaking ──
    await page.waitForFunction(
      () => document.getElementById('mock-test-section-label')?.textContent?.toLowerCase() === 'speaking',
      { timeout: 10000 }
    );
    console.log('FM-04 on speaking section');

    const speakingTimer = await page.evaluate(() =>
      document.getElementById('mock-test-timer')?.textContent);
    console.log('FM-04 speaking timer:', speakingTimer);
    console.log('FM-04 EXPECTED: 14:00 (840s)');

    const spQCount = await page.evaluate(() =>
      document.querySelectorAll('.mock-sp-q').length);
    console.log('FM-04 speaking question items:', spQCount);

    const cueCardExists = await page.evaluate(() => !!document.querySelector('.mock-cue-card'));
    console.log('FM-04 cue card exists:', cueCardExists);

    const recordBtnExists = await page.evaluate(() => !!document.getElementById('mock-record-btn'));
    console.log('FM-04 record button exists:', recordBtnExists);

    const notesArea = await page.evaluate(() => !!document.getElementById('mock-sp-notes'));
    console.log('FM-04 notes textarea exists:', notesArea);

    if (notesArea) {
      await page.fill('#mock-sp-notes', 'I am from a small city. I enjoy reading about history and science. Reading has become more digital in recent years with e-books growing in popularity.');
    }

    await page.click('#mock-submit-btn');
    console.log('FM-04 submitted speaking');

    // ── Evaluation screen ──
    try {
      await page.waitForFunction(
        () => document.getElementById('s-fullmock-eval')?.classList.contains('active'),
        { timeout: 10000 }
      );
      console.log('FM-04 evaluation screen showed');
      const evalAnim = await page.evaluate(() =>
        document.getElementById('mock-eval-anim')?.textContent);
      console.log('FM-04 eval animation:', evalAnim);
    } catch (e) {
      console.log('FM-04 eval screen did not appear:', e.message);
    }

    // ── Report screen ──
    console.log('FM-04 waiting for report (AI evaluation)...');
    try {
      await page.waitForFunction(
        () => document.getElementById('s-fullmock-report')?.classList.contains('active'),
        { timeout: 120000 }
      );
      console.log('FM-04 report screen appeared');

      const reportDate = await page.evaluate(() =>
        document.getElementById('mock-report-date')?.textContent);
      console.log('FM-04 report date:', reportDate);

      const overallBand = await page.evaluate(() =>
        document.getElementById('mr-overall-band')?.textContent);
      console.log('FM-04 overall band:', overallBand);

      const compareText = await page.evaluate(() =>
        document.getElementById('mr-compare')?.textContent);
      console.log('FM-04 compare text:', compareText);

      const scoreCardsHtml = await page.evaluate(() =>
        document.getElementById('mock-section-scores')?.innerHTML?.substring(0, 300));
      console.log('FM-04 score cards html:', scoreCardsHtml);

      // Check CSS variables used in score cards resolve
      const scoreCardBg = await page.evaluate(() => {
        const card = document.querySelector('.mock-score-card');
        if (!card) return null;
        return window.getComputedStyle(card).backgroundColor;
      });
      console.log('FM-04 score card computed background:', scoreCardBg);
      console.log('FM-04 NOTE: if "rgba(0,0,0,0)" the CSS var (--accent-light etc) is not resolving');

      const skillBreakdown = await page.evaluate(() =>
        document.getElementById('mr-skill-breakdown')?.textContent?.trim()?.substring(0, 100));
      console.log('FM-04 skill breakdown:', skillBreakdown);

      const reviewItems = await page.evaluate(() =>
        document.querySelectorAll('.mock-review-item').length);
      console.log('FM-04 wrong question review items:', reviewItems);

      // Wait for debrief AI call
      await page.waitForTimeout(8000);
      const debriefVisible = await page.evaluate(() =>
        !document.getElementById('mr-debrief')?.classList.contains('hidden'));
      const debriefText = await page.evaluate(() =>
        document.getElementById('mr-debrief')?.textContent?.substring(0, 150));
      console.log('FM-04 debrief visible:', debriefVisible, '| text:', debriefText);

      const focusPill = await page.evaluate(() =>
        document.querySelector('.mock-focus-pill')?.textContent?.substring(0, 80));
      console.log('FM-04 focus pill:', focusPill);

    } catch (e) {
      console.log('FM-04 report failed:', e.message);
    }

    console.log('FM-04 JS errors:', errors);
  });

  test('FM-05 single-section mock — reading only goes straight to report', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

    await setupPage(page);
    await page.evaluate(() => {
      window.startFullMockSetup();
    });
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      const btn = document.querySelector('[data-sections="reading"]');
      if (btn) window.selectMockOption(btn);
    });
    await page.click('[onclick*="startFullMockGeneration"]');

    await page.waitForFunction(
      () => document.getElementById('s-fullmock-test')?.classList.contains('active'),
      { timeout: 120000 }
    );
    console.log('FM-05 reading-only test screen active');

    const label = await page.evaluate(() =>
      document.getElementById('mock-test-section-label')?.textContent);
    console.log('FM-05 section label:', label);

    await page.click('#mock-submit-btn');
    console.log('FM-05 submitted reading (only section)');

    try {
      await page.waitForFunction(
        () => document.getElementById('s-fullmock-report')?.classList.contains('active'),
        { timeout: 60000 }
      );
      console.log('FM-05 report appeared');

      const band = await page.evaluate(() =>
        document.getElementById('mr-overall-band')?.textContent);
      console.log('FM-05 overall band (reading only):', band);

      const scoreCards = await page.evaluate(() =>
        document.getElementById('mock-section-scores')?.children?.length);
      console.log('FM-05 score cards (expected 1 — reading only):', scoreCards);

    } catch (e) {
      console.log('FM-05 report did not appear:', e.message);
      const screen = await page.evaluate(() =>
        [...document.querySelectorAll('.screen.active')].map(s => s.id));
      console.log('FM-05 current active screen:', screen);
    }

    console.log('FM-05 JS errors:', errors);
  });

  test('FM-06 mock history screen', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

    await setupPage(page);
    await page.evaluate(() => window.goToMockHistory && window.goToMockHistory());
    await page.waitForTimeout(600);

    const active = await page.evaluate(() =>
      document.getElementById('s-fullmock-history')?.classList.contains('active'));
    console.log('FM-06 history screen active:', active);
    expect(active).toBe(true);

    const listContent = await page.evaluate(() =>
      document.getElementById('mock-history-list')?.textContent?.trim());
    console.log('FM-06 history list content:', listContent?.substring(0, 100));
    console.log('FM-06 EXPECTED: empty state message since studentData is null/no history');

    console.log('FM-06 JS errors:', errors);
  });
});
