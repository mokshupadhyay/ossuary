// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp } from './harness';

const accounts = `SELECT count(*)::int AS n FROM accounts`;

describe('creating a circle', () => {
  it('marks every invalid field, links the message, focuses the first, and creates nothing', async () => {
    const { user, spy } = await renderApp();
    const before = (await spy.current().service.ledger.client.query<{ n: number }>(accounts)).rows[0]!.n;
    await user.click(screen.getByRole('button', { name: 'New circle' }));
    const form = within(screen.getByRole('region', { name: 'Start a new circle' }));
    await user.type(form.getByLabelText('Member 1'), 'Ama');
    await user.type(form.getByLabelText('Member 2'), 'ama');
    await user.type(form.getByLabelText('Contribution per round'), '1.0000001');
    await user.click(form.getByRole('button', { name: 'Light the candles' }));

    const name = form.getByLabelText('Circle name');
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(name).toHaveAccessibleDescription('Give the circle a name.');
    expect(form.getByLabelText('Member 2')).toHaveAccessibleDescription(/ama is already in the circle/);
    expect(form.getByLabelText('Member 3')).toHaveAccessibleDescription(/Member 3 needs a name/);
    expect(form.getByLabelText('Contribution per round')).toHaveAccessibleDescription(/6 decimal places/);
    await waitFor(() => expect(name).toHaveFocus());
    expect((await spy.current().service.ledger.client.query<{ n: number }>(accounts)).rows[0]!.n).toBe(before);
  });

  it('shows rounds = members, creates the circle, selects it, and lets you switch back', async () => {
    const { user } = await renderApp();
    await user.click(screen.getByRole('button', { name: 'New circle' }));
    const form = within(screen.getByRole('region', { name: 'Start a new circle' }));
    expect(form.getByTestId('rounds')).toHaveTextContent('3');
    await user.click(form.getByRole('button', { name: 'Add a member' }));
    expect(form.getByTestId('rounds')).toHaveTextContent('4');
    await user.click(form.getByRole('button', { name: 'Remove member 4' }));
    expect(form.getByTestId('rounds')).toHaveTextContent('3');

    await user.type(form.getByLabelText('Circle name'), 'Tanda de los Viernes');
    await user.type(form.getByLabelText('Member 1'), 'Rosa');
    await user.type(form.getByLabelText('Member 2'), 'Diego');
    await user.type(form.getByLabelText('Member 3'), 'Inés');
    await user.type(form.getByLabelText('Contribution per round'), '12.5');
    await user.click(form.getByRole('button', { name: 'Light the candles' }));

    await screen.findByRole('heading', { name: 'Tanda de los Viernes', level: 2 });
    expect(screen.getByText('3 members · 12.50 USDC each round · 3 rounds')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pay 37.50 USDC to Rosa' })).toBeDisabled();
    expect(screen.getByTestId('announcer')).toHaveTextContent('Tanda de los Viernes is set');

    const select = screen.getByLabelText('Circle');
    await user.selectOptions(select, 'The Midnight Circle');
    await screen.findByRole('heading', { name: 'The Midnight Circle', level: 2 });
  });

  it('cancel goes back to the table', async () => {
    const { user } = await renderApp();
    await user.click(screen.getByRole('button', { name: 'New circle' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('heading', { name: 'The Midnight Circle', level: 2 })).toBeInTheDocument();
  });
});
