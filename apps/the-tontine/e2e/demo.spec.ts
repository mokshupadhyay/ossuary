import { expect, test } from '@playwright/test';

/*
 * The demo path a judge takes (Requirement 13.2), on the built app served
 * from dist/: the seeded circle, paying round 2, summoning the poltergeist,
 * and a reload that keeps the ledger.
 */

test('seeded circle → pay a round → summon the poltergeist → reload keeps the books', async ({ page, baseURL }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => {
    // PGlite's IndexedDB file system reports ENOENT once on every open (design Facts); anything else fails the test.
    if (!(e.name === 'ErrnoError' || e.message === 'ErrnoError')) errors.push(`${e.name}: ${e.message}`);
  });
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'The Midnight Circle', level: 2 })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('heading', { name: 'Round 2 of 5' })).toBeVisible();
  await expect(page.getByTestId('seat-3')).toContainText('Late');
  await expect(page.getByTestId('seat-4')).toContainText('Owes');
  const payout = page.getByRole('button', { name: 'Pay 250.00 USDC to Kwame' });
  await expect(payout).toBeDisabled();

  await page.getByRole('button', { name: 'Record 50.00 USDC from Mateo' }).click();
  await expect(page.getByTestId('seat-3')).toContainText('Paid late');
  await page.getByRole('button', { name: 'Record 50.00 USDC from Nkechi' }).click();
  await expect(page.getByTestId('seat-4')).toContainText('Paid');
  await expect(page.getByTestId('pot')).toHaveText('250.00 USDC');

  await expect(payout).toBeEnabled();
  await payout.click();
  await expect(page.getByRole('heading', { name: 'Round 3 of 5' })).toBeVisible();
  await expect(page.getByTestId('announcer')).toContainText('Kwame received the pot: 250.00 USDC');
  await expect(page.getByTestId('seat-1')).toContainText('Received round 2');
  const history = page.getByRole('region', { name: 'History' });
  const payoutEntry = history.locator('.event--payout').first();
  await expect(payoutEntry).toContainText('Round 2 · Kwame received the pot, 250.00 USDC');
  await expect(payoutEntry.getByText('Idempotency-Key')).toBeVisible();
  await expect(payoutEntry.locator('code')).toHaveText(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

  const seance = page.getByRole('region', { name: 'Summon the Poltergeist' });
  await seance.getByRole('button', { name: 'Summon the Poltergeist' }).click();
  // While the storm runs, ghosts drift across both lanes; then the storm is replayed and the twin's meter climbs.
  const stage = seance.getByTestId('storm-stage');
  await expect(stage).toHaveAttribute('data-state', 'storm');
  await expect(seance.getByTestId('lane-ossuary').locator('.sprite--brewing')).toHaveCount(4);
  await expect(seance.getByTestId('lane-twin').locator('.sprite--brewing')).toHaveCount(4);
  await expect(stage).toHaveAttribute('data-state', 'replay', { timeout: 150_000 });
  await expect(seance.getByTestId('lane-twin').locator('[data-fate="escaped"]').first()).toBeAttached();
  await expect(seance.getByTestId('lane-ossuary').locator('[data-fate="escaped"]')).toHaveCount(0);
  await expect(seance.getByTestId('storm-status')).toBeEmpty();
  await expect(seance.getByTestId('seance-result')).toBeVisible({ timeout: 10_000 });
  await expect(stage).toHaveAttribute('data-state', 'done');
  await expect(seance.getByTestId('gauge-ossuary')).toHaveAttribute('data-percent', '0');
  await expect(seance.getByTestId('gauge-twin')).toHaveAttribute('data-percent', '100');
  const status = seance.getByTestId('storm-status');
  await expect(status).toHaveAttribute('aria-live', 'polite');
  await expect(status).toHaveText(/^Storm finished: drift 0\.00 USDC on Ossuary, .+ on Vibe Pay\.$/);

  // Ghosts by fault: the twin's double-tap row drifted, and shows the money it lost and conjured even where the total nets out.
  const twinFaults = seance.getByRole('table', { name: 'Vibe Pay: ghosts per fault' });
  await expect(twinFaults.getByRole('columnheader')).toHaveText(['Fault', 'Ghosts', 'Blocked', 'Drifted', 'Lost (USDC)', 'Conjured (USDC)']);
  const doubleTap = twinFaults.getByRole('row', { name: /Concurrent double-tap/ });
  await expect(doubleTap).toHaveClass(/faults__row--drifted/);
  await expect(doubleTap.getByRole('cell').nth(3)).not.toHaveText('0.00');
  await expect(doubleTap.getByRole('cell').nth(4)).not.toHaveText('0.00');
  const ossuaryFaults = seance.getByRole('table', { name: 'Ossuary: ghosts per fault' });
  for (const cell of await ossuaryFaults.locator('tbody td:nth-child(5), tbody td:nth-child(6)').all()) await expect(cell).toHaveText('0.00');
  await expect(seance.getByTestId('drift-ossuary')).toHaveText('0.00 USDC');
  await expect(seance.getByTestId('drift-vibe-pay')).not.toHaveText('0.00 USDC');
  await expect(seance.getByText('No drift: every cent is where it should be')).toBeVisible();
  await expect(seance.getByTestId('seance-books')).toContainText('The Midnight Circle’s books are untouched: pot 0.00 USDC before and after.');
  await expect(seance.getByTestId('seance-books')).toContainText('sums to 0.00 USDC');

  // Readable at the current width with no horizontal scroll (Requirement 8.8).
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Round 3 of 5' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('seat-1')).toContainText('Received round 2');

  // Static: every request stays on this origin (Requirement 1.3).
  expect(requests.filter((u) => !u.startsWith(`${baseURL}/`))).toEqual([]);
  expect(errors).toEqual([]);
});


test('with reduced motion the storm is a still picture, and the result still arrives and is announced', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'The Midnight Circle', level: 2 })).toBeVisible({ timeout: 60_000 });
  // Candles stand still.
  const flame = page.getByTestId('seat-1').locator('.candle__flame');
  expect(await flame.evaluate((e) => getComputedStyle(e).animationName)).toBe('none');

  const seance = page.getByRole('region', { name: 'Summon the Poltergeist' });
  await seance.getByRole('button', { name: 'Summon the Poltergeist' }).click();
  await expect(seance.getByTestId('lane-twin')).toContainText('👻 → 💸');
  await expect(page.locator('.sprite')).toHaveCount(0);
  await expect(seance.getByTestId('seance-result')).toBeVisible({ timeout: 150_000 });
  await expect(page.locator('.sprite')).toHaveCount(0);
  await expect(seance.getByTestId('storm-status')).toHaveText(/^Storm finished: drift 0\.00 USDC on Ossuary/);
});

test('candles flicker, each out of step with its neighbour', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'The Midnight Circle', level: 2 })).toBeVisible({ timeout: 60_000 });
  const lit = page.locator('.candle--lit');
  expect(await lit.count()).toBeGreaterThan(1);
  const anim = (i: number) =>
    lit.nth(i).evaluate((c) => {
      const f = getComputedStyle(c.querySelector('.candle__flame')!);
      const g = getComputedStyle(c.querySelector('.candle__glow')!);
      return { flame: f.animationName, glow: g.animationName, delay: g.animationDelay };
    });
  const [a, b] = [await anim(0), await anim(1)];
  expect(a).toMatchObject({ flame: 'flicker', glow: 'glow' });
  expect(a.delay).not.toBe(b.delay);
});
