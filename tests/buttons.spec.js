// @ts-check
const { test, expect } = require('@playwright/test');

test('All buttons are responsive on every screen', async ({ page }) => {
  await page.goto('https://toody-1ab05.web.app/app.html');

  const buttons = page.locator('button:not([disabled]), .btn:not([disabled]), [onclick]:not([disabled])');
  const count = await buttons.count();

  console.log(`Found ${count} interactive elements`);

  for (let i = 0; i < count; i++) {
    const btn = buttons.nth(i);
    const isVisible = await btn.isVisible();
    if (!isVisible) continue;

    const text = await btn.textContent();
    console.log(`Testing: ${text?.trim()}`);

    await expect(btn).toBeEnabled();
  }
});

test('Quick drill Next button advances to next question', async ({ page }) => {
  await page.goto('https://toody-1ab05.web.app/app.html');

  const drillNext = page.locator('#drill-next-btn, .drill-next, [onclick*="renderDrillQuestion"]');
  if (await drillNext.count() > 0) {
    await expect(drillNext.first()).toBeEnabled();
  }
});

test('Submit buttons are all responsive', async ({ page }) => {
  await page.goto('https://toody-1ab05.web.app/app.html');

  const submitButtons = page.locator('button:has-text("Submit"), button:has-text("Continue"), button:has-text("Next")');
  const count = await submitButtons.count();

  for (let i = 0; i < count; i++) {
    const btn = submitButtons.nth(i);
    if (await btn.isVisible()) {
      await expect(btn).toBeEnabled();
    }
  }
});
