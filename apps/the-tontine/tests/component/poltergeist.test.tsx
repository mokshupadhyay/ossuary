// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp, seat } from './harness';

describe('Summon the Poltergeist', () => {
  it('runs the storm on this circle’s ledger and the twin: Ossuary at 0, Vibe Pay drifting, books untouched', async () => {
    const { user } = await renderApp();
    const panel = within(screen.getByRole('region', { name: 'Summon the Poltergeist' }));
    expect(panel.getByLabelText('Seed')).toHaveValue('7');
    expect(panel.getByLabelText('Events')).toHaveValue('200');
    await user.click(panel.getByRole('button', { name: 'Summon the Poltergeist' }));

    // While the storm runs, money controls are locked.
    expect(panel.getByRole('button', { name: 'Summoning…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Record 50.00 USDC from Nkechi' })).toBeDisabled();

    await panel.findByTestId('seance-result', {}, { timeout: 60_000 });
    expect(panel.getByTestId('drift-ossuary')).toHaveTextContent(/^0\.00 USDC$/);
    expect(panel.getByText('No drift: every cent is where it should be')).toBeInTheDocument();
    expect(panel.getByTestId('drift-vibe-pay')).not.toHaveTextContent(/^0\.00 USDC$/);
    expect(panel.getByText(/Drifting: money (lost|conjured)/)).toBeInTheDocument();

    const ossuary = within(panel.getByRole('article', { name: 'Ossuary' }));
    const twin = within(panel.getByRole('article', { name: 'Vibe Pay' }));
    const epitaphs = ossuary.getAllByRole('listitem');
    expect(epitaphs.length).toBeGreaterThan(8);
    expect(epitaphs.some((li) => /delivered twice, buried by inbox dedupe/.test(li.textContent ?? ''))).toBe(true);
    expect(epitaphs.some((li) => /double-tapped payout, buried by idempotency key/.test(li.textContent ?? ''))).toBe(true);
    expect(twin.getByText(/Ghosts that got through \(\d+\)/)).toBeInTheDocument();

    const books = panel.getByTestId('seance-books');
    expect(books).toHaveTextContent('The Midnight Circle’s books are untouched: pot 150.00 USDC before and after.');
    expect(books).toHaveTextContent('The whole ledger, storm included, sums to 0.00 USDC.');
    expect(screen.getByTestId('announcer')).toHaveTextContent('Ossuary drift 0.00 USDC');

    // Controls come back, and the circle still works.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Record 50.00 USDC from Nkechi' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Record 50.00 USDC from Nkechi' }));
    await waitFor(() => expect(seat(4).getByText('Paid')).toBeInTheDocument());
  });

  it('rejects a seed that is not a whole number from 0 to 4,294,967,295', async () => {
    const { user } = await renderApp();
    const panel = within(screen.getByRole('region', { name: 'Summon the Poltergeist' }));
    const seed = panel.getByLabelText('Seed');
    await user.clear(seed);
    await user.type(seed, '4294967296');
    await user.click(panel.getByRole('button', { name: 'Summon the Poltergeist' }));
    expect(seed).toHaveAttribute('aria-invalid', 'true');
    expect(seed).toHaveAccessibleDescription(/whole number from 0 to 4,294,967,295/);
    expect(panel.queryByTestId('seance-result')).not.toBeInTheDocument();
  });
});
