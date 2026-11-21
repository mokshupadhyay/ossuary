import { expect, test } from '@playwright/test';

/*
 * The full demo path against the built app: seeded jar → send a tip → refund it
 * → its ghost fades → count the coffin → summon the poltergeist.
 */
test('demo path', async ({ page, context }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // An overlay tab next to the jar, as OBS would have it.
  const overlay = await context.newPage();
  await overlay.goto('/#/overlay');
  await expect(overlay.getByRole('main', { name: 'Tip overlay' })).toBeVisible();

  // 1. Seeded jar.
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Spooky Streams' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('tip-row')).toHaveCount(5);
  await expect(page.getByTestId('goal-text')).toHaveText('31.25 of 100 USDC');

  // 2. Send a tip, double-clicking Send.
  await page.getByLabel('Your name').fill('Playwright Phantom');
  await page.getByLabel('Amount (USDC)').fill('6.66');
  await page.getByLabel('Message').fill('end to end, beyond the grave');
  await page.getByRole('button', { name: /send tip/i }).dblclick();
  const row = page.getByTestId('tip-row').filter({ hasText: 'Playwright Phantom' });
  await expect(row).toHaveCount(1);
  await expect(row.getByText('Arrived')).toBeVisible();
  await expect(page.getByTestId('goal-text')).toHaveText('37.91 of 100 USDC');

  // The ghost floats in, once, on the overlay tab and in the preview.
  const ghost = overlay.getByTestId('ghost').filter({ hasText: 'Playwright Phantom' });
  await expect(ghost).toHaveCount(1);
  await expect(ghost).toHaveAttribute('data-faded', 'false');
  await expect(page.getByTestId('ghost').filter({ hasText: 'Playwright Phantom' })).toHaveCount(1);

  // 3. Refund it in full (empty amount = what is left); a chargeback after that is rejected.
  await row.getByRole('button', { name: 'Refund Playwright Phantom' }).click();
  await expect(row.getByText('Reversed')).toBeVisible();
  await row.getByRole('button', { name: "Chargeback Playwright Phantom's tip" }).click();
  await expect(row.getByTestId('tip-note')).toHaveText(/Rejected: more than this tip received/);
  await expect(page.getByTestId('goal-text')).toHaveText('31.25 of 100 USDC');

  // 4. The ghost fades on the overlay.
  await expect(ghost).toHaveAttribute('data-faded', 'true');
  await expect(ghost).toContainText('refunded');

  // 5. Count the coffin.
  await page.getByRole('link', { name: 'Count the coffin' }).click();
  await expect(page.getByTestId('coffin-verdict')).toHaveText(/The coffin balances/);
  await expect(page.getByTestId('coffin-residual')).toHaveText('0.000000');
  await expect(page.getByRole('row', { name: /In: 6 tips captured/ })).toContainText('48.410000');
  await expect(page.getByRole('row', { name: /Out: refunds/ })).toContainText('14.160000');
  await expect(page.getByRole('row', { name: /Held in the jar/ })).toContainText('31.250000');

  // 6. Summon the poltergeist.
  await page.getByRole('link', { name: 'Summon the Poltergeist' }).click();
  await page.getByRole('button', { name: /summon the poltergeist/i }).click();
  await expect(page.getByTestId('drift-ossuary')).toHaveText('0.000000', { timeout: 90_000 });
  await expect(page.getByTestId('drift-twin')).not.toHaveText('0.000000');
  await expect(page.getByTestId('cx-twin')).toContainText('fault');
  await expect(page.getByTestId('epitaphs').getByRole('listitem').first()).toContainText('buried by');

  // The jar is untouched by the storm.
  await page.getByRole('link', { name: 'Count the coffin' }).click();
  await expect(page.getByTestId('coffin-residual')).toHaveText('0.000000');
  await expect(page.getByRole('row', { name: /Held in the jar/ })).toContainText('31.250000');

  expect(errors).toEqual([]);
});
