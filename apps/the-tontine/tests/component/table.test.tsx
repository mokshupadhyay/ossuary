// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { announcer, count, renderApp, seat } from './harness';

const captures = `SELECT count(*)::int AS n FROM transactions WHERE kind = 'capture'`;
const transfers = `SELECT count(*)::int AS n FROM transactions WHERE kind = 'transfer'`;

afterEach(() => vi.unstubAllGlobals());

describe('the candlelit table', () => {
  it('shows the seeded circle: five candles with their states in text, the recipient and the pot', async () => {
    await renderApp();
    expect(screen.getAllByRole('listitem').filter((li) => li.dataset['testid']?.startsWith('seat-'))).toHaveLength(5);
    expect(seat(0).getByText('Paid')).toBeInTheDocument();
    expect(seat(0).getByText('Received round 1')).toBeInTheDocument();
    expect(seat(1).getByText('Takes the pot')).toBeInTheDocument();
    expect(seat(3).getByText('Late')).toBeInTheDocument();
    expect(seat(4).getByText('Owes')).toBeInTheDocument();
    expect(screen.getByTestId('pot')).toHaveTextContent('150.00 USDC');
    expect(screen.getByRole('heading', { name: 'Round 2 of 5' })).toBeInTheDocument();
    expect(screen.getByTestId('ledger-sum')).toHaveTextContent('0.00 USDC');
    expect(screen.getByTestId('ledger-sum')).toHaveTextContent('balanced');
  });

  it('records a contribution: the candle lights, the pot grows, and it is announced', async () => {
    const { user } = await renderApp();
    await user.click(screen.getByRole('button', { name: 'Record 50.00 USDC from Nkechi' }));
    await waitFor(() => expect(seat(4).getByText('Paid')).toBeInTheDocument());
    expect(screen.getByTestId('pot')).toHaveTextContent('200.00 USDC');
    expect(announcer()).toHaveTextContent('Nkechi’s 50.00 USDC is in the pot');
    expect(seat(4).queryByRole('button')).not.toBeInTheDocument();
  });

  it('a double-tap records one capture, not two', async () => {
    const { spy } = await renderApp();
    const before = await count(spy, captures);
    const button = screen.getByRole('button', { name: 'Record 50.00 USDC from Nkechi' });
    // Two clicks before React can re-render and disable the button.
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    await waitFor(() => expect(seat(4).getByText('Paid')).toBeInTheDocument());
    await waitFor(async () => expect(await count(spy, captures)).toBe(before + 1));
    expect(screen.getByTestId('pot')).toHaveTextContent('200.00 USDC');
  });

  it('marks a member late: the candle gutters, and paying late shows "Paid late"', async () => {
    const { user } = await renderApp();
    await user.click(screen.getByRole('button', { name: 'Mark Nkechi late' }));
    await waitFor(() => expect(seat(4).getByText('Late')).toBeInTheDocument());
    expect(announcer()).toHaveTextContent('Nkechi is marked late');
    expect(screen.getByTestId('seat-4').querySelector('.candle--guttering')).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Record 50.00 USDC from Nkechi' }));
    await waitFor(() => expect(seat(4).getByText('Paid late')).toBeInTheDocument());
  });

  it('will not pay out while anyone owes, and says who it is waiting for', async () => {
    const { spy } = await renderApp();
    const payout = screen.getByRole('button', { name: 'Pay 250.00 USDC to Kwame' });
    expect(payout).toBeDisabled();
    expect(payout).toHaveAccessibleDescription(/Waiting for Mateo and Nkechi/);
    fireEvent.click(payout);
    expect(await count(spy, transfers)).toBe(1);
  });

  it('pays the round out: the pot goes to Kwame once, the round advances, and it is announced', async () => {
    const { user, spy } = await renderApp();
    await user.click(screen.getByRole('button', { name: 'Record 50.00 USDC from Mateo' }));
    await waitFor(() => expect(seat(3).getByText('Paid late')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Record 50.00 USDC from Nkechi' }));
    const payout = screen.getByRole('button', { name: 'Pay 250.00 USDC to Kwame' });
    await waitFor(() => expect(payout).toBeEnabled());
    await user.click(payout);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Round 3 of 5' })).toBeInTheDocument());
    expect(announcer()).toHaveTextContent('Kwame received the pot: 250.00 USDC');
    expect(seat(1).getByText('Received round 2')).toBeInTheDocument();
    expect(seat(2).getByText('Takes the pot')).toBeInTheDocument();
    expect(screen.getByTestId('pot')).toHaveTextContent('0.00 USDC');
    expect(screen.getByTestId('coin-flight')).toBeInTheDocument();
    expect(await count(spy, transfers)).toBe(2);
  });

  it('with reduced motion, the payout changes the same state but no coins fly', async () => {
    vi.stubGlobal(
      'matchMedia',
      (query: string) =>
        ({ matches: query.includes('reduce'), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }) as unknown as MediaQueryList,
    );
    const { user } = await renderApp();
    await user.click(screen.getByRole('button', { name: 'Record 50.00 USDC from Mateo' }));
    await waitFor(() => expect(seat(3).getByText('Paid late')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Record 50.00 USDC from Nkechi' }));
    const payout = screen.getByRole('button', { name: 'Pay 250.00 USDC to Kwame' });
    await waitFor(() => expect(payout).toBeEnabled());
    await user.click(payout);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Round 3 of 5' })).toBeInTheDocument());
    expect(announcer()).toHaveTextContent('Kwame received the pot');
    expect(screen.queryByTestId('coin-flight')).not.toBeInTheDocument();
  });

  it('every control is a native button, reachable by keyboard', async () => {
    const { user } = await renderApp();
    screen.getByRole('button', { name: 'Record 50.00 USDC from Nkechi' }).focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(seat(4).getByText('Paid')).toBeInTheDocument());
    await user.tab();
    expect(document.activeElement?.tagName).toMatch(/BUTTON|INPUT|SELECT|A|SUMMARY/);
  });
});
