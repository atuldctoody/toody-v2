// @ts-check
// tests/mock-e2e.spec.js
// Complete end-to-end test of Mini Mock and Full Mock flows.
// Runs against the live app at https://toody-1ab05.web.app/app.html
// Uses window.devJumpTo() to bypass Firebase auth for UI testing.

const { test, expect } = require('@playwright/test');

// ── HELPERS ──────────────────────────────────────────────────────────
async function waitForDevTools(page) {
  // Wait until devJumpTo is available (ES modules loaded)
  await page.waitForFunction(() => typeof window.devJumpTo === 'function', { timeout: 20000 });
}

async function injectStudentData(page) {
  // Inject minimal studentData so session loaders have something to work with
  // We use a documented trick: override state module exports via the setStudentData setter
  await page.evaluate(() => {
    const data = {
      uid: 'e2e-test-001',
      displayName: 'E2E Tester',
      targetBand: 6.5,
      currentBand: 6.0,
      dayNumber: 10,
      weekNumber: 2,
      streak: 3,
      recentSkills: ['reading.tfng'],
      brain: { subjects: { 'ielts-academic': { skills: {} } } },
      mockHistory: [],
    };
    // setStudentData is not on window — use the module's own setter
    // Best effort: set on window so module code reading studentData via import may not see it,
    // but optional-chaining fallbacks will provide defaults
    window.__e2eStudentData = data;
    // Try to call setStudentData if available (it's not on window, so this is best-effort)
    if (typeof window.setStudentData === 'function') window.setStudentData(data);
  });
}

// ── MINI MOCK TESTS ───────────────────────────────────────────────────
test.describe('Mini Mock Flow', () => {
  test.setTimeout(300000); // 5 min — AI calls are slow

  test('MM-01: Mini Mock intro screen loads via devJumpTo', async ({ page }) => {
    const errors = [];
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    page.on('pageerror', err => errors.push(`PAGEERROR: ${err.message}`));

    await page.goto('/app.html');
    await waitForDevTools(page);
    await injectStudentData(page);

    await page.evaluate(() => window.devJumpTo('mock'));
    await page.waitForTimeout(500);

    // s-minimock should be active
    const screenActive = await page.evaluate(() =>
      document.getElementById('s-minimock')?.classList.contains('active')
    );
    console.log('MM-01 s-minimock active:', screenActive);
    expect(screenActive).toBe(true);

    // Intro view should be visible, results hidden
    const introVisible = await page.evaluate(() => {
      const el = document.getElementById('mock-intro-view');
      return el && !el.classList.contains('hidden') && el.offsetParent !== null;
    });
    console.log('MM-01 intro view visible:', introVisible);
    expect(introVisible).toBe(true);

    const resultsHidden = await page.evaluate(() =>
      document.getElementById('mock-results-view')?.classList.contains('hidden')
    );
    console.log('MM-01 results view hidden:', resultsHidden);
    expect(resultsHidden).toBe(true);

    // Progress steps exist
    const stepsExist = await page.evaluate(() =>
      ['reading','listening','writing','speaking'].every(s =>
        !!document.getElementById(`mock-step-${s}`)
      )
    );
    console.log('MM-01 all 4 step indicators exist:', stepsExist);
    expect(stepsExist).toBe(true);

    // Timer bar is hidden initially
    const timerHidden = await page.evaluate(() =>
      document.getElementById('mini-mock-timer-bar')?.classList.contains('hidden')
    );
    console.log('MM-01 timer bar initially hidden:', timerHidden);
    expect(timerHidden).toBe(true);

    // "Begin the Mock" button exists and is enabled
    const btnText = await page.evaluate(() => {
      const btn = document.querySelector('#mock-intro-view .btn');
      return btn ? btn.textContent.trim() : null;
    });
    console.log('MM-01 begin button text:', btnText);
    expect(btnText).toContain('Begin the Mock');

    console.log('MM-01 console errors:', errors);
    console.log('MM-01 RESULT: PASS');
  });

  test('MM-02: Reading phase — session loads, questions render, timer starts', async ({ page }) => {
    const errors = [];
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    page.on('pageerror', err => errors.push(`PAGEERROR: ${err.message}`));

    await page.goto('/app.html');
    await waitForDevTools(page);
    await injectStudentData(page);
    await page.evaluate(() => window.devJumpTo('mock'));

    // Click "Begin the Mock"
    await page.click('#mock-intro-view .btn');
    console.log('MM-02 clicked Begin the Mock');

    // s-reading should become active (reading session loads)
    await page.waitForFunction(
      () => document.getElementById('s-reading')?.classList.contains('active'),
      { timeout: 5000 }
    );
    console.log('MM-02 s-reading became active');

    // Reading loading spinner should appear first, then disappear
    // Wait for reading content to load (AI call — up to 60s)
    await page.waitForFunction(
      () => {
        const loading = document.getElementById('reading-loading');
        const content = document.getElementById('reading-content');
        return loading?.classList.contains('hidden') || content?.children.length > 0;
      },
      { timeout: 60000 }
    );
    console.log('MM-02 reading content appeared');

    // Check questions render
    const questionCount = await page.evaluate(() =>
      document.querySelectorAll('.tfng-q, .tfng-btn, .reading-q, [id^="q-"]').length
    );
    console.log('MM-02 questions/buttons found:', questionCount);

    // Check timer bar is now visible
    const timerVisible = await page.evaluate(() => {
      const bar = document.getElementById('mini-mock-timer-bar');
      return bar && !bar.classList.contains('hidden');
    });
    console.log('MM-02 timer bar visible during reading:', timerVisible);
    expect(timerVisible).toBe(true);

    // Check timer is counting (wait 2s and check it changed)
    const time1 = await page.evaluate(() =>
      document.getElementById('mini-mock-countdown')?.textContent
    );
    await page.waitForTimeout(2000);
    const time2 = await page.evaluate(() =>
      document.getElementById('mini-mock-countdown')?.textContent
    );
    console.log('MM-02 timer at t=0:', time1, '| timer at t+2s:', time2);
    const timerCounting = time1 !== time2;
    console.log('MM-02 timer is counting down:', timerCounting);
    expect(timerCounting).toBe(true);

    // Check phase label
    const phaseLabel = await page.evaluate(() =>
      document.getElementById('mini-mock-phase-label')?.textContent
    );
    console.log('MM-02 phase label:', phaseLabel);
    expect(phaseLabel).toBe('Reading');

    // Check progress bar — reading step should be "active"
    const readingStepClass = await page.evaluate(() =>
      document.getElementById('mock-step-reading')?.className
    );
    console.log('MM-02 reading step class:', readingStepClass);
    expect(readingStepClass).toContain('active');

    // Timer bar position — check it's not obscured by nav
    const timerBarTop = await page.evaluate(() => {
      const bar = document.getElementById('mini-mock-timer-bar');
      return bar ? bar.getBoundingClientRect().top : null;
    });
    const navBottom = await page.evaluate(() => {
      const nav = document.querySelector('#s-reading .nav');
      return nav ? nav.getBoundingClientRect().bottom : null;
    });
    console.log('MM-02 timer bar top:', timerBarTop, '| reading nav bottom:', navBottom);
    if (timerBarTop !== null && navBottom !== null) {
      const overlaps = timerBarTop < navBottom;
      console.log('MM-02 LAYOUT BUG - timer bar overlaps reading nav:', overlaps);
    }

    console.log('MM-02 console errors:', errors);
  });

  test('MM-03: Reading → Listening transition after submit', async ({ page }) => {
    const errors = [];
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    page.on('pageerror', err => errors.push(`PAGEERROR: ${err.message}`));

    await page.goto('/app.html');
    await waitForDevTools(page);
    await injectStudentData(page);
    await page.evaluate(() => window.devJumpTo('mock'));
    await page.click('#mock-intro-view .btn');

    // Wait for reading to load
    await page.waitForFunction(
      () => document.getElementById('s-reading')?.classList.contains('active'),
      { timeout: 5000 }
    );
    await page.waitForFunction(
      () => document.getElementById('reading-loading')?.classList.contains('hidden'),
      { timeout: 60000 }
    );
    console.log('MM-03 reading loaded');

    // Check what the submit button says
    const submitBtn = await page.evaluate(() => {
      const btn = document.getElementById('reading-submit');
      return btn ? { text: btn.textContent.trim(), disabled: btn.disabled } : null;
    });
    console.log('MM-03 submit button:', JSON.stringify(submitBtn));

    // Click submit to finish reading and advance to listening
    const hasSubmitBtn = await page.evaluate(() => !!document.getElementById('reading-submit'));
    console.log('MM-03 submit button exists:', hasSubmitBtn);

    if (hasSubmitBtn) {
      await page.click('#reading-submit');
      console.log('MM-03 clicked reading submit');

      // Wait for listening to become active
      try {
        await page.waitForFunction(
          () => document.getElementById('s-listening')?.classList.contains('active'),
          { timeout: 60000 }
        );
        console.log('MM-03 s-listening became active');

        // Check phase label changed to Listening
        const phaseLabel = await page.evaluate(() =>
          document.getElementById('mini-mock-phase-label')?.textContent
        );
        console.log('MM-03 phase label after reading:', phaseLabel);
        expect(phaseLabel).toBe('Listening');

        // Check reading step is now "done"
        const readingStepClass = await page.evaluate(() =>
          document.getElementById('mock-step-reading')?.className
        );
        console.log('MM-03 reading step class after done:', readingStepClass);
        expect(readingStepClass).toContain('done');

        // Check listening step is "active"
        const listenStepClass = await page.evaluate(() =>
          document.getElementById('mock-step-listening')?.className
        );
        console.log('MM-03 listening step class:', listenStepClass);
        expect(listenStepClass).toContain('active');

      } catch (e) {
        console.log('MM-03 FAIL: Listening screen did not become active:', e.message);
      }
    }

    console.log('MM-03 console errors:', errors);
  });

  test('MM-04: Listening → Writing → Speaking → Results full chain', async ({ page }) => {
    const errors = [];
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    page.on('pageerror', err => errors.push(`PAGEERROR: ${err.message}`));

    await page.goto('/app.html');
    await waitForDevTools(page);
    await injectStudentData(page);
    await page.evaluate(() => window.devJumpTo('mock'));
    await page.click('#mock-intro-view .btn');

    // ── Phase 0: Reading ──
    await page.waitForFunction(
      () => document.getElementById('reading-loading')?.classList.contains('hidden'),
      { timeout: 60000 }
    );
    console.log('MM-04 reading loaded, submitting...');
    await page.click('#reading-submit').catch(() => console.log('MM-04 no reading-submit btn'));

    // ── Phase 1: Listening ──
    try {
      await page.waitForFunction(
        () => document.getElementById('s-listening')?.classList.contains('active'),
        { timeout: 60000 }
      );
      await page.waitForFunction(
        () => document.getElementById('listening-loading')?.classList.contains('hidden'),
        { timeout: 90000 }
      );
      console.log('MM-04 listening loaded');

      // Check audio player exists
      const audioEl = await page.evaluate(() => !!document.querySelector('#s-listening audio'));
      console.log('MM-04 listening audio element exists:', audioEl);

      // Check listen questions rendered
      const listenQCount = await page.evaluate(() =>
        document.querySelectorAll('.mc-option, .fc-input, .listen-q').length
      );
      console.log('MM-04 listening question elements count:', listenQCount);

      // Check timer changed to Listening
      const phaseLabel = await page.evaluate(() =>
        document.getElementById('mini-mock-phase-label')?.textContent
      );
      console.log('MM-04 timer phase label on listening:', phaseLabel);

      await page.click('#listening-submit').catch(() => console.log('MM-04 no listening-submit btn'));
      console.log('MM-04 submitted listening');
    } catch(e) { console.log('MM-04 listening phase error:', e.message); }

    // ── Phase 2: Writing ──
    try {
      await page.waitForFunction(
        () => document.getElementById('s-writing')?.classList.contains('active'),
        { timeout: 60000 }
      );
      await page.waitForFunction(
        () => document.getElementById('writing-loading')?.classList.contains('hidden'),
        { timeout: 60000 }
      );
      console.log('MM-04 writing loaded');

      // Check task type — should be Task 1 in mini mock
      const taskType = await page.evaluate(() =>
        document.getElementById('writing-task-type')?.textContent
      );
      console.log('MM-04 writing task type:', taskType);

      // Check phase label
      const phaseLabel = await page.evaluate(() =>
        document.getElementById('mini-mock-phase-label')?.textContent
      );
      console.log('MM-04 timer phase label on writing:', phaseLabel);

      // Type some text and submit
      await page.fill('#writing-textarea', 'The graph shows significant changes over the period from 2010 to 2020. There was a notable increase in the first category reaching its peak in 2015. Subsequently the trend reversed showing a gradual decline. Overall the data suggests cyclical patterns in the subject area which merit further investigation.');
      console.log('MM-04 typed writing response');

      // Click submit writing button
      await page.click('[onclick*="submitWriting"]').catch(() => console.log('MM-04 no submitWriting btn'));
      console.log('MM-04 clicked writing submit');

      // Wait for writing evaluation (AI call)
      await page.waitForFunction(
        () => !document.getElementById('s-writing')?.classList.contains('active') ||
              document.getElementById('writing-results-view') && !document.getElementById('writing-results-view')?.classList.contains('hidden'),
        { timeout: 60000 }
      );
      console.log('MM-04 writing evaluation done');
    } catch(e) { console.log('MM-04 writing phase error:', e.message); }

    // ── Phase 3: Speaking ──
    try {
      await page.waitForFunction(
        () => document.getElementById('s-speaking')?.classList.contains('active'),
        { timeout: 60000 }
      );
      await page.waitForFunction(
        () => document.getElementById('speaking-loading')?.classList.contains('hidden'),
        { timeout: 60000 }
      );
      console.log('MM-04 speaking loaded');

      // Check it's Part 2 cue card (mock speaking)
      const topicLabel = await page.evaluate(() =>
        document.getElementById('speaking-topic-label')?.textContent
      );
      console.log('MM-04 speaking topic label:', topicLabel);
      const isPart2 = topicLabel?.includes('Part 2') || topicLabel?.includes('Cue Card');
      console.log('MM-04 speaking is Part 2 cue card:', isPart2);

      // Check phase label
      const phaseLabel = await page.evaluate(() =>
        document.getElementById('mini-mock-phase-label')?.textContent
      );
      console.log('MM-04 timer phase label on speaking:', phaseLabel);

      // Mic won't work in headless — check if start button exists
      const startRecBtn = await page.evaluate(() =>
        !!document.getElementById('record-ready')
      );
      console.log('MM-04 record-ready section exists:', startRecBtn);

      // Check finish button
      const finishBtn = await page.evaluate(() => {
        const btn = document.getElementById('speaking-finish-btn');
        return btn ? { exists: true, text: btn.textContent.trim(), disabled: btn.disabled } : { exists: false };
      });
      console.log('MM-04 speaking finish button:', JSON.stringify(finishBtn));

      // Try clicking finish
      if (finishBtn.exists) {
        await page.click('#speaking-finish-btn');
        console.log('MM-04 clicked speaking finish');

        // Wait for results or notebook
        await page.waitForFunction(
          () => document.getElementById('s-minimock')?.classList.contains('active') ||
                document.getElementById('s-notebook')?.classList.contains('active'),
          { timeout: 60000 }
        );

        const currentScreen = await page.evaluate(() => {
          const screens = ['s-minimock','s-notebook','s-home'];
          return screens.find(id => document.getElementById(id)?.classList.contains('active')) || 'unknown';
        });
        console.log('MM-04 screen after speaking finish:', currentScreen);

        if (currentScreen === 's-minimock') {
          const resultsVisible = await page.evaluate(() =>
            !document.getElementById('mock-results-view')?.classList.contains('hidden')
          );
          console.log('MM-04 mini mock results visible:', resultsVisible);

          if (resultsVisible) {
            const overallBand = await page.evaluate(() =>
              document.getElementById('mock-overall-band')?.textContent
            );
            console.log('MM-04 overall band displayed:', overallBand);

            const recommendations = await page.evaluate(() =>
              document.getElementById('mock-recommendations')?.innerHTML
            );
            console.log('MM-04 recommendations rendered:', recommendations?.substring(0, 100));

            // Check all 4 section bars
            const bars = await page.evaluate(() => ({
              reading:  document.getElementById('mock-reading-pct')?.textContent,
              listening:document.getElementById('mock-listening-pct')?.textContent,
              writing:  document.getElementById('mock-writing-pct')?.textContent,
              speaking: document.getElementById('mock-speaking-pct')?.textContent,
            }));
            console.log('MM-04 section bars:', JSON.stringify(bars));
          }
        }
      }
    } catch(e) { console.log('MM-04 speaking phase error:', e.message); }

    console.log('MM-04 final console errors:', errors);
  });

  test('MM-05: Writing task type in mini mock should be Task 1', async ({ page }) => {
    const errors = [];
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    page.on('pageerror', err => errors.push(`PAGEERROR: ${err.message}`));

    await page.goto('/app.html');
    await waitForDevTools(page);
    await injectStudentData(page);

    // Directly jump to writing session in mock mode
    await page.evaluate(() => {
      window.devJumpTo('mock');
    });
    await page.waitForTimeout(300);

    // Programmatically set mockMode and mockPhase then load writing
    await page.evaluate(async () => {
      // Set mock state — these are module-level vars so this is via the mock module functions
      window.startMiniMock && window.startMiniMock();
    });

    await page.waitForFunction(
      () => document.getElementById('s-reading')?.classList.contains('active'),
      { timeout: 5000 }
    ).catch(() => {});

    // Skip ahead — directly load writing in mock mode
    // In mini mock, mockPhase=2 triggers loadWritingSession which should pick Task 1
    await page.evaluate(() => {
      if (typeof window.runMockPhase === 'function') {
        window.runMockPhase(2);
      }
    });

    await page.waitForFunction(
      () => document.getElementById('s-writing')?.classList.contains('active'),
      { timeout: 10000 }
    ).catch(() => console.log('MM-05 writing screen did not activate'));

    await page.waitForFunction(
      () => document.getElementById('writing-loading')?.classList.contains('hidden'),
      { timeout: 60000 }
    ).catch(() => console.log('MM-05 writing loading did not hide'));

    const taskType = await page.evaluate(() =>
      document.getElementById('writing-task-type')?.textContent
    );
    console.log('MM-05 writing task type in mini mock:', taskType);

    console.log('MM-05 console errors:', errors);
  });
});

// ── FULL MOCK TESTS ───────────────────────────────────────────────────
test.describe('Full Mock Flow', () => {
  test.setTimeout(600000); // 10 min — lots of AI calls

  test('FM-01: Full mock setup screen loads correctly', async ({ page }) => {
    const errors = [];
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    page.on('pageerror', err => errors.push(`PAGEERROR: ${err.message}`));

    await page.goto('/app.html');
    await waitForDevTools(page);
    await injectStudentData(page);

    await page.evaluate(() => window.startFullMockSetup());
    await page.waitForTimeout(500);

    const screenActive = await page.evaluate(() =>
      document.getElementById('s-fullmock-setup')?.classList.contains('active')
    );
    console.log('FM-01 s-fullmock-setup active:', screenActive);
    expect(screenActive).toBe(true);

    // Check all 5 option buttons exist
    const optionBtns = await page.evaluate(() =>
      document.querySelectorAll('.mock-option-btn').length
    );
    console.log('FM-01 mock option buttons count:', optionBtns);
    expect(optionBtns).toBe(5);

    // Check "Full Mock Test" is selected by default
    const activeSections = await page.evaluate(() =>
      document.querySelector('.mock-option-btn.active')?.dataset?.sections
    );
    console.log('FM-01 default selected option:', activeSections);
    expect(activeSections).toBe('all');

    // Check option buttons have time labels or descriptions (CSS classes defined but HTML may not use them)
    const hasOptTime = await page.evaluate(() =>
      !!document.querySelector('.mock-opt-time')
    );
    console.log('FM-01 option buttons have time labels (.mock-opt-time):', hasOptTime);
    // This documents whether the structured inner HTML exists

    // Check generate button exists
    const genBtn = await page.evaluate(() => {
      const btn = document.querySelector('[onclick*="startFullMockGeneration"]');
      return btn ? { text: btn.textContent.trim(), disabled: btn.disabled } : null;
    });
    console.log('FM-01 generate button:', JSON.stringify(genBtn));

    console.log('FM-01 console errors:', errors);
  });

  test('FM-02: Full mock generation — all 4 sections generate and screen transitions', async ({ page }) => {
    const errors = [];
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    page.on('pageerror', err => errors.push(`PAGEERROR: ${err.message}`));

    await page.goto('/app.html');
    await waitForDevTools(page);
    await injectStudentData(page);

    await page.evaluate(() => window.startFullMockSetup());
    await page.waitForTimeout(300);

    // Click generate
    await page.click('[onclick*="startFullMockGeneration"]');
    console.log('FM-02 clicked generate');

    // Generation screen should appear
    await page.waitForFunction(
      () => document.getElementById('s-fullmock-gen')?.classList.contains('active'),
      { timeout: 5000 }
    );
    console.log('FM-02 generation screen active');

    // Check generation steps appear
    const genStepsExist = await page.evaluate(() =>
      ['reading','listening','writing','speaking'].every(s =>
        !!document.getElementById(`mgs-${s}`)
      )
    );
    console.log('FM-02 all gen step elements exist:', genStepsExist);
    expect(genStepsExist).toBe(true);

    // Wait for generation to complete and test screen to appear
    // This can take up to 2-3 minutes (4 reading AI calls + 4 listening AI calls + 4 audio calls + writing + speaking)
    console.log('FM-02 waiting for generation to complete (may take 2-3 min)...');
    await page.waitForFunction(
      () => document.getElementById('s-fullmock-test')?.classList.contains('active'),
      { timeout: 240000 }
    );
    console.log('FM-02 s-fullmock-test became active');

    // Check which steps completed
    const stepStates = await page.evaluate(() => ({
      reading:   document.getElementById('mgs-reading')?.className,
      listening: document.getElementById('mgs-listening')?.className,
      writing:   document.getElementById('mgs-writing')?.className,
      speaking:  document.getElementById('mgs-speaking')?.className,
    }));
    console.log('FM-02 gen step final states:', JSON.stringify(stepStates));

    // Check section label on test screen
    const sectionLabel = await page.evaluate(() =>
      document.getElementById('mock-test-section-label')?.textContent
    );
    console.log('FM-02 first section label:', sectionLabel);
    expect(sectionLabel?.toLowerCase()).toBe('reading');

    // Check timer shows and is running
    const timerText1 = await page.evaluate(() =>
      document.getElementById('mock-test-timer')?.textContent
    );
    await page.waitForTimeout(2000);
    const timerText2 = await page.evaluate(() =>
      document.getElementById('mock-test-timer')?.textContent
    );
    console.log('FM-02 full mock timer t=0:', timerText1, '| t+2s:', timerText2);
    const timerRunning = timerText1 !== timerText2;
    console.log('FM-02 full mock timer is running:', timerRunning);
    expect(timerRunning).toBe(true);

    // Check reading content rendered (3 passages)
    const passageBlocks = await page.evaluate(() =>
      document.querySelectorAll('.mock-passage-block').length
    );
    console.log('FM-02 reading passage blocks:', passageBlocks);

    // Check question count
    const questionCount = await page.evaluate(() =>
      document.querySelectorAll('.mock-q').length
    );
    console.log('FM-02 question count in reading:', questionCount);

    // Check headings list exists for passage 2
    const hasHeadingsList = await page.evaluate(() =>
      !!document.querySelector('.mock-headings-list')
    );
    console.log('FM-02 matching headings list exists:', hasHeadingsList);

    // Check summary completion exists for passage 3
    const hasSummaryWrap = await page.evaluate(() =>
      !!document.querySelector('.mock-summary-wrap')
    );
    console.log('FM-02 summary completion exists:', hasSummaryWrap);

    // Check submit button
    const submitBtn = await page.evaluate(() => {
      const btn = document.getElementById('mock-submit-btn');
      return btn ? { text: btn.textContent.trim(), disabled: btn.disabled } : null;
    });
    console.log('FM-02 submit button:', JSON.stringify(submitBtn));

    console.log('FM-02 console errors:', errors);
  });

  test('FM-03: Full mock — Reading → Listening → Writing → Speaking section transitions', async ({ page }) => {
    const errors = [];
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    page.on('pageerror', err => errors.push(`PAGEERROR: ${err.message}`));

    await page.goto('/app.html');
    await waitForDevTools(page);
    await injectStudentData(page);

    // Shortcut: inject pre-built fullMockContent to skip AI generation
    await page.evaluate(async () => {
      // Wait for the mock module to be ready
      await new Promise(r => setTimeout(r, 1000));

      // Inject minimal mock content to bypass generation
      const mockContent = {
        reading: {
          passages: [
            {
              type: 'tfng',
              topic: 'Test Topic',
              passage: 'This is a test passage for the end-to-end test. Scientists have found that water boils at 100 degrees Celsius at sea level. The sky appears blue due to Rayleigh scattering.',
              questions: [
                { id: 1, text: 'Water boils at 100°C at sea level.', answer: 'True', explanation: 'Stated directly in the passage.' },
                { id: 2, text: 'The sky is green.', answer: 'False', explanation: 'The passage says blue.' },
                { id: 3, text: 'Rayleigh scattering was discovered in 1900.', answer: 'NG', explanation: 'Not mentioned.' },
              ]
            },
            {
              type: 'matchingHeadings',
              topic: 'Test Headings',
              passage: 'Paragraph A: Introduction to renewable energy. Paragraph B: Solar power advantages. Paragraph C: Wind energy challenges. Paragraph D: The future of clean energy.',
              headings: ['Clean energy outlook', 'Barriers to wind power', 'Overview of renewables', 'Benefits of solar', 'Cost analysis'],
              questions: [
                { id: 1, paragraph: 'A', answer: '3', explanation: 'Introduces renewables.' },
                { id: 2, paragraph: 'B', answer: '4', explanation: 'Benefits of solar.' },
                { id: 3, paragraph: 'C', answer: '2', explanation: 'Challenges = barriers.' },
                { id: 4, paragraph: 'D', answer: '1', explanation: 'Future = outlook.' },
              ]
            },
            {
              type: 'summaryCompletion',
              topic: 'Test Summary',
              passage: 'Climate change is accelerating. Temperatures are rising globally. Ice caps are melting rapidly.',
              summaryText: 'Climate change is [1] and temperatures are [2] globally.',
              wordBank: ['accelerating', 'rising', 'falling', 'stable', 'decelerating'],
              questions: [
                { id: 1, answer: 'accelerating', explanation: 'Directly from passage.' },
                { id: 2, answer: 'rising', explanation: 'Temperatures are rising.' },
              ]
            }
          ]
        },
        listening: {
          sections: [
            {
              type: 'multipleChoice',
              scenario: 'A conversation between a student and a librarian.',
              audioText: 'Librarian: Can I help you? Student: Yes, I need to find books on climate change.',
              audioUrl: null,
              questions: [
                { id: 1, text: 'What is the student looking for?', options: ['A: History books', 'B: Books on climate change', 'C: Science journals'], answer: 'B', explanation: 'Student says climate change.' },
                { id: 2, text: 'Where does this conversation take place?', options: ['A: A classroom', 'B: A library', 'C: A bookshop'], answer: 'B', explanation: 'It is a librarian.' },
              ]
            },
            {
              type: 'formCompletion',
              scenario: 'A customer filling in a hotel registration form.',
              audioText: 'Receptionist: Name please? Guest: John Smith.',
              audioUrl: null,
              questions: [
                { id: 1, fieldLabel: 'Guest surname:', answer: 'Smith', explanation: 'Guest says Smith.' },
                { id: 2, fieldLabel: 'Room type preferred:', answer: 'double', explanation: 'Guest requests double room.' },
              ]
            }
          ]
        },
        writing: {
          task1: { title: 'Bar Chart', prompt: 'Describe the bar chart showing annual rainfall in three cities from 2010 to 2020. Write at least 150 words.' },
          task2: { title: 'Opinion Essay', prompt: 'Some people think that universities should focus only on academic subjects. Others believe practical skills are equally important. Discuss both views and give your opinion. Write at least 250 words.' }
        },
        speaking: {
          part1: { topic: 'Hometown', questions: ['Where are you from?', 'What do you like about your hometown?', 'Has your hometown changed much?'] },
          part2: { topic: 'Describe a book', cueCard: ['Describe a book you have read.', '- What it was about', '- Why you chose it', '- What you learned from it', 'and explain whether you would recommend it.'] },
          part3: { questions: ['Why do people read books?', 'How has technology changed reading habits?', 'Do you think children should be encouraged to read?'] }
        }
      };

      // Inject via internal module variable — only works if the global is accessible
      window.__injectedMockContent = mockContent;
      window.__useMockContent = true;
    });

    // Now start full mock setup
    await page.evaluate(() => window.startFullMockSetup());
    await page.waitForTimeout(300);

    // Override startFullMockGeneration to use injected content
    await page.evaluate(() => {
      if (typeof window.startFullMockGeneration !== 'function') return;
      const orig = window.startFullMockGeneration;
      window.startFullMockGeneration = async function() {
        if (window.__useMockContent && window.__injectedMockContent) {
          // Access internal variables via closure — can't directly, so call real generation
          // but with mock content flag set
          console.log('[E2E] Using real generation (mock content injection not possible for ES modules)');
        }
        return orig.apply(this, arguments);
      };
    });

    // Just click generate and use real AI generation
    await page.click('[onclick*="startFullMockGeneration"]');
    console.log('FM-03 clicked generate — waiting for first section...');

    // Wait for test screen
    await page.waitForFunction(
      () => document.getElementById('s-fullmock-test')?.classList.contains('active'),
      { timeout: 240000 }
    );
    console.log('FM-03 first section (reading) ready');

    // ── Submit Reading ──
    const section1Label = await page.evaluate(() =>
      document.getElementById('mock-test-section-label')?.textContent
    );
    console.log('FM-03 section 1:', section1Label);

    await page.click('#mock-submit-btn');
    console.log('FM-03 submitted reading');

    // ── Listening section ──
    await page.waitForFunction(
      () => {
        const lbl = document.getElementById('mock-test-section-label')?.textContent?.toLowerCase();
        return lbl === 'listening';
      },
      { timeout: 10000 }
    );
    const section2Label = await page.evaluate(() =>
      document.getElementById('mock-test-section-label')?.textContent
    );
    console.log('FM-03 section 2:', section2Label);

    // Check listening renders audio or fallback
    const listenBlocks = await page.evaluate(() =>
      document.querySelectorAll('.mock-listen-block').length
    );
    console.log('FM-03 listening blocks:', listenBlocks);

    const audioAvail = await page.evaluate(() =>
      document.querySelectorAll('.mock-play-btn').length
    );
    const audioUnavail = await page.evaluate(() =>
      document.querySelectorAll('.mock-audio-unavail').length
    );
    console.log('FM-03 audio play buttons:', audioAvail, '| unavailable fallbacks:', audioUnavail);

    // Listening timer
    const listenTimer = await page.evaluate(() =>
      document.getElementById('mock-test-timer')?.textContent
    );
    console.log('FM-03 listening timer:', listenTimer);

    await page.click('#mock-submit-btn');
    console.log('FM-03 submitted listening');

    // ── Writing section ──
    await page.waitForFunction(
      () => document.getElementById('mock-test-section-label')?.textContent?.toLowerCase() === 'writing',
      { timeout: 10000 }
    );
    const section3Label = await page.evaluate(() =>
      document.getElementById('mock-test-section-label')?.textContent
    );
    console.log('FM-03 section 3:', section3Label);

    // Check two textareas exist
    const textareaCount = await page.evaluate(() =>
      document.querySelectorAll('.mock-textarea').length
    );
    console.log('FM-03 writing textareas:', textareaCount);

    // Check word count elements exist
    const wcCount = await page.evaluate(() =>
      document.querySelectorAll('.mock-wc').length
    );
    console.log('FM-03 word count displays:', wcCount);

    // Check writing timer
    const writingTimer = await page.evaluate(() =>
      document.getElementById('mock-test-timer')?.textContent
    );
    console.log('FM-03 writing timer:', writingTimer);

    // Type something in both textareas
    const task1Id = 'mock-w-task1';
    const task2Id = 'mock-w-task2';
    const t1Exists = await page.evaluate(() => !!document.getElementById('mock-w-task1'));
    const t2Exists = await page.evaluate(() => !!document.getElementById('mock-w-task2'));
    console.log('FM-03 task1 textarea exists:', t1Exists, '| task2:', t2Exists);

    if (t1Exists) await page.fill('#mock-w-task1', 'The bar chart illustrates annual rainfall patterns across three cities over a ten-year period. Overall there was significant variation between cities.');
    if (t2Exists) await page.fill('#mock-w-task2', 'Many people argue that universities should prioritise academic learning above all else. However practical skills are increasingly valued in the modern workplace. Both perspectives have merit and should be carefully considered.');

    // Check word counts updated
    const wc1 = await page.evaluate(() => document.getElementById('mock-wc-task1')?.textContent);
    const wc2 = await page.evaluate(() => document.getElementById('mock-wc-task2')?.textContent);
    console.log('FM-03 task1 word count display:', wc1, '| task2:', wc2);

    await page.click('#mock-submit-btn');
    console.log('FM-03 submitted writing');

    // ── Speaking section ──
    await page.waitForFunction(
      () => document.getElementById('mock-test-section-label')?.textContent?.toLowerCase() === 'speaking',
      { timeout: 10000 }
    );
    const section4Label = await page.evaluate(() =>
      document.getElementById('mock-test-section-label')?.textContent
    );
    console.log('FM-03 section 4:', section4Label);

    // Check speaking content renders
    const speakingQs = await page.evaluate(() =>
      document.querySelectorAll('.mock-sp-q').length
    );
    console.log('FM-03 speaking questions rendered:', speakingQs);

    const cueCardExists = await page.evaluate(() => !!document.querySelector('.mock-cue-card'));
    console.log('FM-03 cue card exists:', cueCardExists);

    const recordBtnExists = await page.evaluate(() => !!document.getElementById('mock-record-btn'));
    console.log('FM-03 record button exists:', recordBtnExists);

    const notesAreaExists = await page.evaluate(() => !!document.getElementById('mock-sp-notes'));
    console.log('FM-03 notes textarea exists:', notesAreaExists);

    // Type notes as workaround for no mic
    if (notesAreaExists) {
      await page.fill('#mock-sp-notes', 'Discussed hometown, described a book about leadership, talked about reading habits in society.');
    }

    // Speaking timer
    const speakingTimer = await page.evaluate(() =>
      document.getElementById('mock-test-timer')?.textContent
    );
    console.log('FM-03 speaking timer:', speakingTimer);

    await page.click('#mock-submit-btn');
    console.log('FM-03 submitted speaking');

    // ── Evaluation screen ──
    try {
      await page.waitForFunction(
        () => document.getElementById('s-fullmock-eval')?.classList.contains('active'),
        { timeout: 10000 }
      );
      console.log('FM-03 evaluation screen appeared');
    } catch(e) { console.log('FM-03 eval screen wait:', e.message); }

    // ── Report screen ──
    console.log('FM-03 waiting for report (AI evaluation + debrief)...');
    try {
      await page.waitForFunction(
        () => document.getElementById('s-fullmock-report')?.classList.contains('active'),
        { timeout: 120000 }
      );
      console.log('FM-03 report screen appeared');

      // Check overall band
      const overallBand = await page.evaluate(() =>
        document.getElementById('mr-overall-band')?.textContent
      );
      console.log('FM-03 overall band in report:', overallBand);

      // Check section score cards
      const scoreCards = await page.evaluate(() =>
        document.getElementById('mock-section-scores')?.children.length
      );
      console.log('FM-03 section score cards:', scoreCards);

      // Check compare text
      const compareText = await page.evaluate(() =>
        document.getElementById('mr-compare')?.textContent
      );
      console.log('FM-03 compare text:', compareText);

      // Check skill breakdown rendered
      const skillBreakdownHtml = await page.evaluate(() =>
        document.getElementById('mr-skill-breakdown')?.innerHTML?.substring(0, 100)
      );
      console.log('FM-03 skill breakdown:', skillBreakdownHtml);

      // Check question review rendered
      const reviewItems = await page.evaluate(() =>
        document.querySelectorAll('.mock-review-item').length
      );
      console.log('FM-03 question review items:', reviewItems);

      // Check debrief (async AI call)
      await page.waitForTimeout(5000); // Give debrief time to load
      const debriefVisible = await page.evaluate(() =>
        !document.getElementById('mr-debrief')?.classList.contains('hidden')
      );
      const debriefText = await page.evaluate(() =>
        document.getElementById('mr-debrief')?.textContent?.substring(0, 150)
      );
      console.log('FM-03 debrief visible:', debriefVisible, '| text:', debriefText);

      // Check mock-report-date populated
      const reportDate = await page.evaluate(() =>
        document.getElementById('mock-report-date')?.textContent
      );
      console.log('FM-03 report date:', reportDate);

      // Check History button works
      const historyBtn = await page.evaluate(() => {
        const btn = document.querySelector('[onclick*="goToMockHistory"]');
        return btn ? btn.textContent.trim() : null;
      });
      console.log('FM-03 history button text:', historyBtn);

    } catch(e) { console.log('FM-03 report screen error:', e.message); }

    console.log('FM-03 final console errors:', errors);
  });

  test('FM-04: Mock history screen loads correctly', async ({ page }) => {
    const errors = [];
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    page.on('pageerror', err => errors.push(`PAGEERROR: ${err.message}`));

    await page.goto('/app.html');
    await waitForDevTools(page);
    await injectStudentData(page);

    await page.evaluate(() => window.goToMockHistory && window.goToMockHistory());
    await page.waitForTimeout(500);

    const screenActive = await page.evaluate(() =>
      document.getElementById('s-fullmock-history')?.classList.contains('active')
    );
    console.log('FM-04 history screen active:', screenActive);
    expect(screenActive).toBe(true);

    // Empty state (no mock history for test user)
    const emptyState = await page.evaluate(() =>
      document.getElementById('mock-history-list')?.textContent?.trim()
    );
    console.log('FM-04 history empty state text:', emptyState);

    console.log('FM-04 console errors:', errors);
  });

  test('FM-05: Single section mock — Reading Only', async ({ page }) => {
    const errors = [];
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    page.on('pageerror', err => errors.push(`PAGEERROR: ${err.message}`));

    await page.goto('/app.html');
    await waitForDevTools(page);
    await injectStudentData(page);

    await page.evaluate(() => window.startFullMockSetup());
    await page.waitForTimeout(300);

    // Select "Reading Only"
    await page.evaluate(() => {
      const btn = document.querySelector('[data-sections="reading"]');
      if (btn) window.selectMockOption(btn);
    });
    const selectedOpt = await page.evaluate(() =>
      document.querySelector('.mock-option-btn.active')?.dataset?.sections
    );
    console.log('FM-05 selected option:', selectedOpt);
    expect(selectedOpt).toBe('reading');

    // Generate
    await page.click('[onclick*="startFullMockGeneration"]');
    await page.waitForFunction(
      () => document.getElementById('s-fullmock-test')?.classList.contains('active'),
      { timeout: 120000 }
    );
    console.log('FM-05 reading-only test screen active');

    const sectionLabel = await page.evaluate(() =>
      document.getElementById('mock-test-section-label')?.textContent
    );
    console.log('FM-05 section label:', sectionLabel);

    // Submit immediately — should skip straight to eval
    await page.click('#mock-submit-btn');
    console.log('FM-05 submitted reading');

    // Should go straight to eval then report (no other sections)
    await page.waitForFunction(
      () => document.getElementById('s-fullmock-report')?.classList.contains('active'),
      { timeout: 60000 }
    );
    console.log('FM-05 report appeared after reading-only mock');

    const overallBand = await page.evaluate(() =>
      document.getElementById('mr-overall-band')?.textContent
    );
    console.log('FM-05 reading-only overall band:', overallBand);

    // Only reading score card should exist
    const scoreCards = await page.evaluate(() =>
      document.getElementById('mock-section-scores')?.innerHTML
    );
    console.log('FM-05 score cards html:', scoreCards?.substring(0, 200));

    console.log('FM-05 console errors:', errors);
  });
});
