import { expect, test, type Page } from '@playwright/test';

/*
 * The app at a 390 px phone width: no horizontal scroll on any page, visible
 * focus rings, and with reduced motion the storm shows a static fallback.
 */
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test('390 px: no horizontal scroll, focus rings visible', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Spooky Streams' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('tip-row')).toHaveCount(5);
  expect(await overflow(page)).toBe(0);

  // Keyboard focus shows a 3 px ring on the first few stops.
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab');
    const ring = await page.evaluate(() => {
      const cs = getComputedStyle(document.activeElement!);
      return cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2;
    });
    expect(ring).toBe(true);
  }

  await page.getByRole('link', { name: 'Count the coffin' }).click();
  await expect(page.getByTestId('coffin-verdict')).toHaveText(/The coffin balances/);
  expect(await overflow(page)).toBe(0);

  await page.getByRole('link', { name: 'Summon the Poltergeist' }).click();
  await page.getByRole('button', { name: /summon the poltergeist/i }).click();
  await expect(page.getByTestId('storm')).toBeVisible();
  expect(await overflow(page)).toBe(0);
  await expect(page.getByTestId('drift-ossuary')).toHaveText('0.000000', { timeout: 90_000 });
  expect(await overflow(page)).toBe(0);

  await page.goto('/#/overlay');
  await expect(page.getByRole('main', { name: 'Tip overlay' })).toBeVisible();
  expect(await overflow(page)).toBe(0);
  expect(errors).toEqual([]);
});

test('390 px with reduced motion: a still storm and no replay', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/#/poltergeist');
  await page.getByRole('button', { name: /summon the poltergeist/i }).click();
  await expect(page.getByTestId('sky-twin')).toHaveClass(/still/);
  await expect(page.getByTestId('sky-twin').locator('.sprite')).toHaveCount(0);
  await expect(page.getByTestId('drift-ossuary')).toHaveText('0.000000', { timeout: 90_000 });
  await expect(page.getByTestId('storm')).toHaveCount(0);
  await expect(page.getByTestId('storm-status')).toHaveText(/^Storm finished: drift 0\.000000 USDC on Ossuary/);
  expect(await overflow(page)).toBe(0);
});
