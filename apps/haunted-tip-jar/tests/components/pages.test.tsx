// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { postTransaction } from '@ossuary/core';
import type { Boot } from '../../src/boot';
import { openDatabase, type AppDb, type Db } from '../../src/db';
import { createJar } from '../../src/jar';
import { createOverlayBus, type OverlayBus, type OverlayMessage } from '../../src/overlayBus';
import { Announcer } from '../../src/ui/Announcer';
import { App } from '../../src/ui/App';
import { Coffin } from '../../src/ui/Coffin';
import { OverlayPage } from '../../src/ui/Ghosts';
import { newClock, uuid } from '../helpers';

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
  window.location.hash = '';
});
afterAll(async () => {
  await app.close();
});

const message = (over: Partial<OverlayMessage>): OverlayMessage => ({
  v: 1,
  key: uuid(),
  topic: 'payment.captured',
  jarId: '00000000-0000-4000-8000-000000000001',
  paymentId: '00000000-0000-4000-8000-0000000000aa',
  viewer: 'Casper',
  message: 'boo',
  amount: '5000000',
  remaining: '5000000',
  reason: null,
  ...over,
});

describe('Overlay page', () => {
  it('is transparent, has no controls, shows one ghost per key and fades a full reversal', async () => {
    bus = createOverlayBus({ channel: false });
    render(<OverlayPage bus={bus} />);
    expect(document.documentElement).toHaveClass('overlay-mode');
    expect(screen.queryAllByRole('button')).toEqual([]);

    const tip = message({});
    act(() => {
      bus.publish(tip);
      bus.publish(tip); // at-least-once resend
      bus.publish({ ...tip });
    });
    expect(screen.getAllByTestId('ghost')).toHaveLength(1);
    expect(screen.getByTestId('ghost')).toHaveTextContent('Casper5 USDC“boo”');
    expect(screen.getByTestId('ghost')).toHaveAttribute('data-faded', 'false');

    act(() => bus.publish(message({ topic: 'payment.refunded', amount: '5000000', remaining: '0', reason: 'chargeback' })));
    expect(screen.getByTestId('ghost')).toHaveAttribute('data-faded', 'true');
    expect(screen.getByTestId('ghost')).toHaveTextContent('charged back');
  });
});

describe('Coffin', () => {
  it('the seeded jar balances, with the equation, checks and buried ghosts in text', async () => {
    bus = createOverlayBus({ channel: false });
    const jar = await createJar(db, { clock: newClock(), bus });
    render(
      <Announcer>
        <Coffin jar={jar} intervalMs={0} />
      </Announcer>,
    );
    expect(await screen.findByTestId('coffin-verdict', {}, WAIT)).toHaveTextContent('The coffin balances');
    expect(screen.getByTestId('coffin-residual')).toHaveTextContent('0.000000');
    expect(screen.getByRole('row', { name: /In: 5 tips captured/ })).toHaveTextContent('41.750000');
    expect(screen.getByRole('row', { name: /Out: refunds/ })).toHaveTextContent('7.500000');
    expect(screen.getByRole('row', { name: /Out: chargebacks/ })).toHaveTextContent('3.000000');
    expect(screen.getByRole('row', { name: /Held in the jar/ })).toHaveTextContent('31.250000');
    for (const id of ['residual', 'ledger-sum', 'clearing', 'over-cap']) {
      expect(screen.getByTestId(`check-${id}`)).toHaveTextContent('pass');
    }
    expect(screen.getByText(/reversals rejected for asking more than a tip received/)).toHaveTextContent('1 reversals');
    await waitFor(() => expect(screen.getByTestId('announcer')).toHaveTextContent('The coffin balances. Residual 0.000000 USDC.'), WAIT);
  });

  it('names the failing check when money bypasses the webhook inbox', async () => {
    bus = createOverlayBus({ channel: false });
    const jar = await createJar(db, { clock: newClock(), seed: false, bus });
    await postTransaction(db, {
      idempotencyKey: uuid(),
      kind: 'capture',
      paymentId: uuid(),
      entries: [
        { accountId: jar.ref.clearingAccountId, amount: 1_000_000n },
        { accountId: jar.ref.jarAccountId, amount: -1_000_000n },
      ],
    });
    render(
      <Announcer>
        <Coffin jar={jar} intervalMs={0} />
      </Announcer>,
    );
    const verdict = await screen.findByTestId('coffin-verdict', {}, WAIT);
    expect(verdict).toHaveTextContent('The coffin does not balance: In − out − held = 0; Rail clearing = in − out');
    expect(screen.getByTestId('coffin-residual')).toHaveTextContent('-1.000000');
    expect(screen.getByTestId('check-residual')).toHaveTextContent('fail (-1000000)');
    expect(screen.getByTestId('check-ledger-sum')).toHaveTextContent('pass');
  });
});

describe('App shell', () => {
  it('another tab holding the database shows a message; the overlay never boots the jar', async () => {
    bus = createOverlayBus({ channel: false });
    const boot = vi.fn(async (): Promise<Boot> => ({ kind: 'locked' }));
    window.location.hash = '#/overlay';
    const { unmount } = render(<App boot={boot} bus={bus} />);
    expect(screen.getByRole('main', { name: 'Tip overlay' })).toBeInTheDocument();
    expect(boot).not.toHaveBeenCalled();
    unmount();

    window.location.hash = '#/';
    render(<App boot={boot} bus={bus} />);
    expect(await screen.findByRole('heading', { name: 'The jar is open in another tab' })).toBeInTheDocument();
    expect(boot).toHaveBeenCalledTimes(1);
  });

  it('routes between jar and coffin with one boot, and marks the current page', async () => {
    bus = createOverlayBus({ channel: false });
    const jar = await createJar(db, { clock: newClock(), bus });
    const boot = vi.fn(async (): Promise<Boot> => ({ kind: 'ready', app, jar, reset: async () => jar }));
    window.location.hash = '#/';
    render(<App boot={boot} bus={bus} intervalMs={0} />);
    expect(await screen.findByRole('heading', { name: 'Spooky Streams' }, WAIT)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Jar' })).toHaveAttribute('aria-current', 'page');

    act(() => {
      window.location.hash = '#/coffin';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(await screen.findByTestId('coffin-verdict', {}, WAIT)).toHaveTextContent('The coffin balances');
    expect(screen.getByRole('link', { name: 'Count the coffin' })).toHaveAttribute('aria-current', 'page');
    expect(boot).toHaveBeenCalledTimes(1);
  });
});
