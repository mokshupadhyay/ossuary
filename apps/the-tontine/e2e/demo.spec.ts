import { expect, test } from '@playwright/test';

/*
 * The demo path a judge takes (Requirement 13.2), on the built app served
 * from dist/: the seeded circle, paying round 2, summoning the poltergeist,
 * and a reload that keeps the ledger.
 */

test('seeded circle → pay a round → summon the poltergeist → reload keeps the books', async ({ page }) => {
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
  await expect(seance.getByTestId('seance-result')).toBeVisible({ timeout: 150_000 });
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
  expect(requests.filter((u) => !u.startsWith('http://localhost:4173/'))).toEqual([]);
  expect(errors).toEqual([]);
});
