// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, type AppDb, type Db } from '../../src/db';
import { createJar, type TipJar } from '../../src/jar';
import { createOverlayBus, type OverlayBus } from '../../src/overlayBus';
import { Announcer } from '../../src/ui/Announcer';
import { JarView } from '../../src/ui/JarView';
import { REJECTED_TEXT } from '../../src/ui/TipRow';
import { newClock } from '../helpers';

const WAIT = { timeout: 8000 };

let app: AppDb;
let db: Db;
let bus: OverlayBus;
beforeAll(async () => {
  app = await openDatabase();
  db = app.db;
});
afterEach(() => {
  cleanup();
  bus?.close();
});
afterAll(async () => {
  await app.close();
});

async function mount(options: { seed?: boolean; before?: (jar: TipJar) => Promise<void> } = {}) {
  bus = createOverlayBus({ channel: false });
  const jar = await createJar(db, { clock: newClock(), seed: options.seed ?? false, bus });
  await options.before?.(jar);
  render(
    <Announcer>
      <JarView jar={jar} bus={bus} intervalMs={0} />
    </Announcer>,
  );
  await screen.findByTestId('goal-text', {}, WAIT);
  return jar;
}

describe('JarView: sending tips', () => {
  it('a double-tap on Send creates one tip, moves the goal bar and announces it', async () => {
    const jar = await mount();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Your name'), 'Casper');
    await user.type(screen.getByLabelText('Amount (USDC)'), '2.5');
    await user.type(screen.getByLabelText('Message'), 'boo');
    const form = screen.getByRole('button', { name: /send tip/i }).closest('form')!;
    // Two submits before either resolves: both must carry the same Idempotency_Key.
    fireEvent.submit(form);
    fireEvent.submit(form);

    const row = await screen.findByTestId('tip-row', {}, WAIT);
    expect(within(row).getByText('Casper')).toBeInTheDocument();
    expect(within(row).getByText('Arrived')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('goal-text')).toHaveTextContent('2.5 of 100 USDC'), WAIT);
    await waitFor(() => expect(screen.getByTestId('announcer')).toHaveTextContent('Tip from Casper: 2.5 USDC'), WAIT);

    expect(await jar.tips()).toHaveLength(1);
    expect((await jar.coffin()).totalIn).toBe(2_500_000n);
    // The preview shows exactly one ghost, from the outbox.
    await waitFor(() => expect(screen.getAllByTestId('ghost')).toHaveLength(1), WAIT);
  });

  it('rejects a bad amount before anything reaches the rail', async () => {
    const jar = await mount();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Your name'), 'Casper');
    await user.type(screen.getByLabelText('Amount (USDC)'), '1.0000001');
    await user.click(screen.getByRole('button', { name: /send tip/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('At most 6 decimal places');
    expect(await jar.tips()).toEqual([]);
  });
});

describe('JarView: refunds and chargebacks', () => {
  it('partial refund, then an over-cap chargeback is rejected with text, then the rest fades the ghost', async () => {
    const jar = await mount({
      before: async (j) => {
        const t = await j.sendTip(globalThis.crypto.randomUUID(), { viewer: 'Myrtle', amount: 10_000_000n, message: 'mic' });
        if (!t.ok) throw new Error('tip failed');
      },
    });
    const user = userEvent.setup();
    const row = await screen.findByTestId('tip-row', {}, WAIT);

    await user.type(within(row).getByLabelText(/Refund amount for Myrtle/), '4');
    await user.click(within(row).getByRole('button', { name: 'Refund Myrtle' }));
    await waitFor(() => expect(within(row).getByTestId('tip-note')).toHaveTextContent('Refunded 4 USDC'), WAIT);
    await waitFor(() => expect(within(row).getByText('Partly reversed')).toBeInTheDocument(), WAIT);

    await user.click(within(row).getByRole('button', { name: "Chargeback Myrtle's tip" }));
    await waitFor(() => expect(within(row).getByTestId('tip-note')).toHaveTextContent(REJECTED_TEXT), WAIT);
    await waitFor(() => expect(within(row).getByText(/1 reversal rejected by the refund cap/)).toBeInTheDocument(), WAIT);
    expect((await jar.coffin()).held).toBe(6_000_000n);

    // Empty amount refunds what is left.
    await user.click(within(row).getByRole('button', { name: 'Refund Myrtle' }));
    await waitFor(() => expect(within(row).getByText('Reversed')).toBeInTheDocument(), WAIT);
    const coffin = await jar.coffin();
    expect(coffin).toMatchObject({ held: 0n, refunds: 10_000_000n, chargebacks: 0n, residual: 0n, balanced: true });
    await waitFor(() => expect(screen.getByTestId('ghost')).toHaveAttribute('data-faded', 'true'), WAIT);
    expect(screen.getByTestId('ghost')).toHaveTextContent('refunded');
  });

  it('the haunted rail switch delivers duplicates that the log shows and the ledger ignores', async () => {
    const jar = await mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole('switch'));
    expect(screen.getByRole('switch')).toBeChecked();
    expect(screen.getByText('Haunted rail (on)')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Your name'), 'Slimer');
    await user.type(screen.getByLabelText('Amount (USDC)'), '1');
    await user.click(screen.getByRole('button', { name: /send tip/i }));
    await waitFor(() => expect(screen.getAllByTestId('delivery-row').length).toBe(7), WAIT);
    expect(screen.getAllByText('duplicate, ignored').length).toBe(5);
    expect((await jar.coffin()).held).toBe(1_000_000n);

    await user.click(screen.getByRole('button', { name: /replay a stale webhook/i }));
    await waitFor(() => expect(screen.getByTestId('stale-result')).toHaveTextContent('401 refused: bad or stale signature'), WAIT);
    expect((await jar.coffin()).held).toBe(1_000_000n);
  });
});
