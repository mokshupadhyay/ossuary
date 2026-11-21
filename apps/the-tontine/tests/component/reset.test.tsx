// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp, seat } from './harness';

describe('reset', () => {
  it('opens a dialog with focus inside; Cancel and Escape change nothing and return focus to Reset', async () => {
    const { user, spy } = await renderApp();
    await user.click(screen.getByRole('button', { name: 'Record 50.00 USDC from Nkechi' }));
    await waitFor(() => expect(seat(4).getByText('Paid')).toBeInTheDocument());
    const reset = screen.getByRole('button', { name: 'Reset demo' });

    await user.click(reset);
    const dialog = screen.getByRole('dialog', { name: 'Reset the demo?' });
    expect(screen.getByRole('button', { name: 'Keep my circles' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Delete and reset' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Keep my circles' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Keep my circles' }));
    expect(dialog).not.toBeInTheDocument();
    await waitFor(() => expect(reset).toHaveFocus());

    await user.click(reset);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(reset).toHaveFocus());

    expect(seat(4).getByText('Paid')).toBeInTheDocument();
    expect(spy.sessions).toHaveLength(1);
  });

  it('confirm deletes everything and lays the demo circle again', async () => {
    const { user, spy } = await renderApp();
    await user.click(screen.getByRole('button', { name: 'Record 50.00 USDC from Nkechi' }));
    await waitFor(() => expect(seat(4).getByText('Paid')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Reset demo' }));
    await user.click(screen.getByRole('button', { name: 'Delete and reset' }));
    await waitFor(() => expect(screen.getByTestId('announcer')).toHaveTextContent('The table is laid again'));
    expect(seat(4).getByText('Owes')).toBeInTheDocument();
    expect(spy.sessions).toHaveLength(2);
    expect(spy.sessions[0]!.service.ledger.client.closed).toBe(true);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reset demo' })).toHaveFocus());
  });
});
