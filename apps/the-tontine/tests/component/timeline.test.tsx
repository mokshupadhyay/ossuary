// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp } from './harness';

const history = () => within(screen.getByRole('region', { name: 'History' }));
const items = () => history().getAllByRole('listitem').filter((li) => li.classList.contains('event'));

describe('history timeline', () => {
  it('lists the seeded history newest first: missed mark, contributions, payout', async () => {
    await renderApp();
    const titles = items().map((li) => li.querySelector('.event__title')!.textContent!.replace(/^\W+/, ''));
    expect(titles[0]).toBe('Round 2 · Mateo marked late');
    expect(titles).toContain('Round 1 · Asha received the pot, 250.00 USDC');
    expect(titles.filter((t) => / paid 50\.00 USDC/.test(t))).toHaveLength(8);
    expect(titles.at(-1)).toMatch(/^Round 1 · Asha paid 50\.00 USDC/);
    expect(items()[0]).toHaveTextContent('No money moved');
  });

  it('shows both keys and the entries for a contribution, and the receipt', async () => {
    const { user, spy } = await renderApp();
    await user.click(screen.getByRole('button', { name: 'Record 50.00 USDC from Nkechi' }));
    await waitFor(() => expect(items()[0]).toHaveTextContent('Round 2 · Nkechi paid 50.00 USDC'));
    const first = within(items()[0]!);
    const circleId = (await spy.current().service.listCircles())[0]!.circleId;
    const v = await spy.current().service.view(circleId);
    const entry = v.timeline[0]!;
    if (entry.kind !== 'contribution') throw new Error('expected a contribution');
    expect(first.getByText('Idempotency-Key')).toBeInTheDocument();
    expect(first.getByText(entry.clientKey)).toBeInTheDocument();
    expect(first.getByText('Ledger key')).toBeInTheDocument();
    expect(first.getByText(entry.ledgerKey)).toBeInTheDocument();
    expect(first.getByText('receipt sent')).toBeInTheDocument();
    expect(items()[0]).toHaveTextContent('Clearing +50.00 USDC');
    expect(items()[0]).toHaveTextContent('Pot −50.00 USDC');
  });

  it('shows a payout under its single key, with the wallet credited', async () => {
    await renderApp();
    const payout = items().find((li) => li.classList.contains('event--payout'))!;
    expect(within(payout).getByText('Idempotency-Key')).toBeInTheDocument();
    expect(within(payout).queryByText('Ledger key')).not.toBeInTheDocument();
    expect(payout).toHaveTextContent('Pot +250.00 USDC');
    expect(payout).toHaveTextContent('Wallet · Asha −250.00 USDC');
    expect(within(payout).getByText(/^[0-9a-f]{8}-[0-9a-f]{4}-/)).toBeInTheDocument();
  });
});
