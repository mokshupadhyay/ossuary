import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, type AppDb, type Db } from '../../src/db';
import { createJar } from '../../src/jar';
import {
  CHANNEL_NAME,
  createGhostStore,
  createOverlayBus,
  drainOutbox,
  isOverlayMessage,
  type OverlayMessage,
} from '../../src/overlayBus';
import { createRail } from '../../src/rail';
import { bareJar, newClock, uuid } from '../helpers';

let app: AppDb;
let db: Db;
beforeAll(async () => {
  app = await openDatabase();
  db = app.db;
});
afterAll(async () => {
  await app.close();
});

function collector() {
  const got: OverlayMessage[] = [];
  return { got, bus: { publish: (m: OverlayMessage) => got.push(m) } };
}

async function fresh() {
  const ref = await bareJar(db);
  const clock = newClock();
  const rail = await createRail(db, ref, { clock });
  return { ref, clock, rail };
}

describe('drainOutbox', () => {
  it('publishes one captured message per tip, with viewer, message, amount and remaining', async () => {
    const { ref, clock, rail } = await fresh();
    const t = await rail.sendTip(uuid(), { viewer: 'Casper', amount: 5_000_000n, message: 'boo' });
    if (!t.ok) throw new Error('tip failed');
    const { got, bus } = collector();
    expect(await drainOutbox(db, ref, { clock, bus })).toBe(1);
    expect(got).toEqual([
      {
        v: 1,
        key: expect.any(String),
        topic: 'payment.captured',
        jarId: ref.id,
        paymentId: t.paymentId,
        viewer: 'Casper',
        message: 'boo',
        amount: '5000000',
        remaining: '5000000',
        reason: null,
      },
    ]);
    expect(isOverlayMessage(got[0])).toBe(true);
    // Drained already: nothing new.
    expect(await drainOutbox(db, ref, { clock, bus })).toBe(0);
  });

  it('a haunted rail still yields exactly one message per applied event', async () => {
    const { ref, clock, rail } = await fresh();
    rail.setHaunted(true);
    const t = await rail.sendTip(uuid(), { viewer: 'A', amount: 10n, message: '' });
    if (!t.ok) throw new Error('tip failed');
    await rail.reverse(uuid(), { paymentId: t.paymentId, amount: 4n, reason: 'chargeback' });
    const { got, bus } = collector();
    await drainOutbox(db, ref, { clock, bus });
    // Core's outbox orders by next_attempt_at, then by a random id: messages enqueued in the same millisecond
    // may be sent in either order, so the overlay must not depend on it (see the store test below).
    expect(got.map((m) => `${m.topic}:${m.amount}:${m.reason}`).sort()).toEqual(['payment.captured:10:null', 'payment.refunded:4:chargeback']);
  });

  it('a failed send is retried by core with the same key (at-least-once), and the store shows one ghost', async () => {
    const { ref, clock, rail } = await fresh();
    const t = await rail.sendTip(uuid(), { viewer: 'A', amount: 10n, message: '' });
    if (!t.ok) throw new Error('tip failed');
    const { got, bus } = collector();
    let fail = true;
    const beforePublish = () => {
      if (fail) {
        fail = false;
        throw new Error('overlay offline');
      }
    };
    expect(await drainOutbox(db, ref, { clock, bus, beforePublish })).toBe(0);
    clock.advance(2_000); // past core's first backoff (1 s)
    expect(await drainOutbox(db, ref, { clock, bus, beforePublish })).toBe(1);

    const store = createGhostStore();
    expect(store.receive(got[0]!)).toBe(true);
    // Simulate a resend of the same message after a lost acknowledgement.
    expect(store.receive({ ...got[0]! })).toBe(false);
    expect(store.ghosts()).toHaveLength(1);
  });

  it('messages for another jar are acknowledged but not published', async () => {
    const one = await fresh();
    const two = await fresh();
    await one.rail.sendTip(uuid(), { viewer: 'A', amount: 10n, message: '' });
    const { got, bus } = collector();
    expect(await drainOutbox(db, two.ref, { clock: two.clock, bus })).toBe(0);
    expect(got).toEqual([]);
  });

  it('TipJar.drainOutbox publishes the seed to its bus', async () => {
    const { got, bus } = collector();
    // Earlier tests in this file left messages for other jars; they are acknowledged, not published.
    const jar = await createJar(db, { clock: newClock(), bus });
    await jar.drainOutbox();
    const mine = got.filter((m) => m.jarId === jar.jarId);
    expect(mine.filter((m) => m.topic === 'payment.captured')).toHaveLength(5);
    expect(mine.filter((m) => m.topic === 'payment.refunded')).toHaveLength(3); // the rejected one sends nothing
  });
});

describe('ghost store', () => {
  const msg = (over: Partial<OverlayMessage>): OverlayMessage => ({
    v: 1,
    key: uuid(),
    topic: 'payment.captured',
    jarId: '00000000-0000-4000-8000-000000000001',
    paymentId: '00000000-0000-4000-8000-0000000000aa',
    viewer: 'Casper',
    message: 'boo',
    amount: '10',
    remaining: '10',
    reason: null,
    ...over,
  });

  it('a partial refund keeps the ghost; a full reversal fades it', () => {
    const store = createGhostStore();
    store.receive(msg({}));
    store.receive(msg({ topic: 'payment.refunded', amount: '4', remaining: '6', reason: 'refund' }));
    expect(store.ghosts()[0]).toMatchObject({ remaining: 6n, faded: false, lastReason: 'refund' });
    store.receive(msg({ topic: 'payment.refunded', amount: '6', remaining: '0', reason: 'chargeback' }));
    expect(store.ghosts()[0]).toMatchObject({ remaining: 0n, faded: true, lastReason: 'chargeback' });
  });

  it('an out-of-order stale remaining never un-fades a ghost', () => {
    const store = createGhostStore();
    store.receive(msg({}));
    store.receive(msg({ topic: 'payment.refunded', remaining: '0' }));
    store.receive(msg({ topic: 'payment.refunded', remaining: '6' }));
    expect(store.ghosts()[0]!.faded).toBe(true);
  });

  it('a refund sent before its capture still ends in the right state, because remaining is read at send time', () => {
    const store = createGhostStore();
    // Both messages drained after the full reversal: each carries remaining 0.
    expect(store.receive(msg({ topic: 'payment.refunded', remaining: '0', reason: 'refund' }))).toBe(true);
    expect(store.ghosts()).toEqual([]);
    store.receive(msg({ remaining: '0' }));
    expect(store.ghosts()[0]).toMatchObject({ remaining: 0n, faded: true });
  });

  it('rejects malformed messages from the channel', () => {
    const store = createGhostStore();
    expect(store.receive({ ...msg({}), amount: '1.5' })).toBe(false);
    expect(store.receive({ ...msg({}), amount: '-1' })).toBe(false);
    expect(store.receive({ ...msg({}), viewer: 'x'.repeat(41) })).toBe(false);
    expect(store.receive({ ...msg({}), v: 2 } as unknown as OverlayMessage)).toBe(false);
    expect(store.receive(null as unknown as OverlayMessage)).toBe(false);
    expect(store.ghosts()).toEqual([]);
  });

  it('a new jar id starts a new feed', () => {
    const store = createGhostStore();
    store.receive(msg({}));
    store.receive(msg({ jarId: '00000000-0000-4000-8000-000000000002', paymentId: '00000000-0000-4000-8000-0000000000bb' }));
    expect(store.ghosts().map((g) => g.paymentId)).toEqual(['00000000-0000-4000-8000-0000000000bb']);
  });
});

describe('BroadcastChannel bus', () => {
  it('reaches another channel instance and in-page listeners, and drops junk', async () => {
    const bus = createOverlayBus();
    const local: OverlayMessage[] = [];
    bus.subscribe((m) => local.push(m));
    const other = new BroadcastChannel(CHANNEL_NAME);
    const remote = new Promise<unknown>((resolve) => {
      other.onmessage = (e) => resolve(e.data);
    });
    const m: OverlayMessage = {
      v: 1,
      key: uuid(),
      topic: 'payment.captured',
      jarId: uuid(),
      paymentId: uuid(),
      viewer: 'A',
      message: '',
      amount: '1',
      remaining: '1',
      reason: null,
    };
    bus.publish(m);
    expect(await remote).toEqual(m);
    expect(local).toEqual([m]);

    // Junk posted by another tab never reaches listeners.
    other.postMessage({ hello: 'world' });
    await new Promise((r) => setTimeout(r, 20));
    expect(local).toHaveLength(1);
    other.close();
    bus.close();
  });
});
