import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, type AppDb, type Db } from '../../src/db';
import { createRail, MAX_ATTEMPTS, reversalEvent, tipEvents } from '../../src/rail';
import { bareJar, entrySum, newClock, uuid } from '../helpers';

let app: AppDb;
let db: Db;
beforeAll(async () => {
  app = await openDatabase();
  db = app.db;
});
afterAll(async () => {
  await app.close();
});

const USDC = (n: bigint) => n * 1_000_000n;

async function setup(opts: { haunted?: boolean } = {}) {
  const jar = await bareJar(db);
  const clock = newClock();
  const rail = await createRail(db, jar, { clock, haunted: opts.haunted ?? false });
  const held = async () => -(await entrySum(db, jar.jarAccountId));
  return { jar, clock, rail, held };
}

describe('rail: tips', () => {
  it('a tip delivers pending then captured, and the jar holds it', async () => {
    const { rail, held } = await setup();
    const r = await rail.sendTip(uuid(), { viewer: 'Casper', amount: USDC(5n), message: 'boo' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.replayed).toBe(false);
    expect(r.outcomes.map((o) => [o.type, o.outcome])).toEqual([
      ['payment.pending', 'applied'],
      ['payment.captured', 'applied'],
    ]);
    expect(await held()).toBe(USDC(5n));
  });

  it('a double-tap (same key, same request) redelivers the same bytes and creates nothing', async () => {
    const { rail, held, jar } = await setup();
    const key = uuid();
    const req = { viewer: 'Casper', amount: USDC(5n), message: 'boo' };
    const [a, b] = await Promise.all([rail.sendTip(key, req), rail.sendTip(key, req)]);
    const c = await rail.sendTip(key, req);
    for (const r of [a, b, c]) expect(r.ok).toBe(true);
    if (!a.ok || !b.ok || !c.ok) return;
    expect(new Set([a.paymentId, b.paymentId, c.paymentId]).size).toBe(1);
    expect(c.replayed).toBe(true);
    expect(c.events).toEqual(a.ok ? a.events : []);
    expect(c.outcomes.every((o) => o.outcome === 'duplicate')).toBe(true);
    const tips = await db.execute(sql`SELECT count(*)::int AS n FROM tipjar_tips WHERE jar_id = ${jar.id}`);
    expect(tips.rows[0]!['n']).toBe(1);
    expect(await held()).toBe(USDC(5n));
  });

  it('the same key with a different request is 409 and changes nothing', async () => {
    const { rail, held } = await setup();
    const key = uuid();
    await rail.sendTip(key, { viewer: 'Casper', amount: USDC(5n), message: 'boo' });
    const r = await rail.sendTip(key, { viewer: 'Casper', amount: USDC(500n), message: 'boo' });
    expect(r).toEqual({ ok: false, status: 409, error: 'key reused with a different request' });
    expect(await held()).toBe(USDC(5n));
  });

  it('a key used in one jar is 409 in another', async () => {
    const one = await setup();
    const two = await setup();
    const key = uuid();
    await one.rail.sendTip(key, { viewer: 'A', amount: 1n, message: '' });
    const r = await two.rail.sendTip(key, { viewer: 'A', amount: 1n, message: '' });
    expect(r.ok).toBe(false);
    expect(await two.held()).toBe(0n);
  });

  it('validates at the trust boundary', async () => {
    const { rail } = await setup();
    const bad = async (key: string, req: Parameters<typeof rail.sendTip>[1]) => {
      const r = await rail.sendTip(key, req);
      expect(r.ok).toBe(false);
      return r.ok ? '' : r.error;
    };
    expect(await bad('not-a-uuid', { viewer: 'A', amount: 1n, message: '' })).toMatch(/UUID/);
    expect(await bad(uuid(), { viewer: '', amount: 1n, message: '' })).toMatch(/viewer/);
    expect(await bad(uuid(), { viewer: 'x'.repeat(41), amount: 1n, message: '' })).toMatch(/viewer/);
    expect(await bad(uuid(), { viewer: 'A', amount: 1n, message: 'x'.repeat(141) })).toMatch(/message/);
    expect(await bad(uuid(), { viewer: 'A', amount: 0n, message: '' })).toMatch(/amount/);
    expect(await bad(uuid(), { viewer: 'A', amount: 10n ** 13n, message: '' })).toMatch(/amount/);
    expect(await bad(uuid(), { viewer: 'A', amount: 5 as unknown as bigint, message: '' })).toMatch(/bigint/);
  });
});

describe('rail: reversals', () => {
  it('refund then chargeback: the second exceeds the cap and is rejected', async () => {
    const { rail, held } = await setup();
    const t = await rail.sendTip(uuid(), { viewer: 'Casper', amount: USDC(10n), message: '' });
    if (!t.ok) throw new Error('tip failed');
    const r1 = await rail.reverse(uuid(), { paymentId: t.paymentId, amount: USDC(4n), reason: 'refund' });
    const r2 = await rail.reverse(uuid(), { paymentId: t.paymentId, amount: USDC(10n), reason: 'chargeback' });
    expect(r1.ok && r1.outcomes[0]!.outcome).toBe('applied');
    expect(r2.ok && r2.outcomes[0]!.outcome).toBe('rejected');
    expect(await held()).toBe(USDC(6n));
  });

  it('a reversal of an unknown tip is 400; reusing a tip key for a refund is 409', async () => {
    const { rail } = await setup();
    const key = uuid();
    const t = await rail.sendTip(key, { viewer: 'A', amount: 5n, message: '' });
    if (!t.ok) throw new Error('tip failed');
    expect(await rail.reverse(uuid(), { paymentId: uuid(), amount: 1n, reason: 'refund' })).toMatchObject({ status: 400 });
    expect(await rail.reverse(key, { paymentId: t.paymentId, amount: 1n, reason: 'refund' })).toMatchObject({ status: 409 });
    expect(await rail.reverse(key, { paymentId: uuid(), amount: 1n, reason: 'refund' })).toMatchObject({ status: 409 });
  });

  it('event bodies are byte-stable and carry the reason', () => {
    const p = uuid();
    const k = uuid();
    expect(tipEvents(k, p, 7n)).toEqual(tipEvents(k, p, 7n));
    expect(JSON.parse(reversalEvent(k, p, 3n, 'chargeback').body)).toEqual({
      id: `chargeback_${k}`,
      type: 'payment.refunded',
      paymentId: p,
      asset: 'USDC',
      amount: '3',
      reason: 'chargeback',
    });
  });
});

describe('rail: haunting, retries and replays', () => {
  it('haunted delivery: duplicates, a late pending and an exact replay all change nothing', async () => {
    const { rail, held } = await setup({ haunted: true });
    const t = await rail.sendTip(uuid(), { viewer: 'Casper', amount: USDC(3n), message: '' });
    if (!t.ok) throw new Error('tip failed');
    expect(t.outcomes.map((o) => `${o.mode}:${o.outcome}`)).toEqual([
      'normal:applied', // pending
      'duplicate:duplicate',
      'replay:duplicate',
      'normal:applied', // captured
      'duplicate:duplicate',
      'late:duplicate', // the late pending is the same event id
      'replay:duplicate',
    ]);
    expect(await held()).toBe(USDC(3n));
  });

  it('retries a 5xx up to MAX_ATTEMPTS, re-signing each attempt', async () => {
    const jar = await bareJar(db);
    const clock = newClock();
    let failures = 2;
    const seen: string[] = [];
    const rail = await createRail(db, jar, {
      clock,
      wrapHandler: (h) => async (req) => {
        seen.push(req.headers['ossuary-timestamp']!);
        clock.advance(1000);
        if (failures-- > 0) return { status: 500, body: { ok: false, error: 'internal' } };
        return h(req);
      },
    });
    const t = await rail.sendTip(uuid(), { viewer: 'A', amount: 9n, message: '' }, { deliver: false });
    if (!t.ok) throw new Error('tip failed');
    const out = await rail.deliver(t.events[1]!);
    expect(out.map((o) => `${o.mode}#${o.attempt}:${o.outcome}`)).toEqual(['normal#1:error', 'retry#2:error', 'retry#3:applied']);
    expect(new Set(seen).size).toBe(3);
    expect(MAX_ATTEMPTS).toBe(3);
    expect(-(await entrySum(db, jar.jarAccountId))).toBe(9n);
  });

  it('a stale replay is refused by core with 401 and changes nothing', async () => {
    const { rail, held } = await setup();
    const t = await rail.sendTip(uuid(), { viewer: 'A', amount: 2n, message: '' });
    if (!t.ok) throw new Error('tip failed');
    const r = await rail.replayStale(t.events[1]!.eventId);
    expect(r).toMatchObject({ mode: 'stale', status: 401, outcome: 'unauthorized' });
    expect(await held()).toBe(2n);
  });

  it('every attempt is written to the delivery log', async () => {
    const { rail, jar } = await setup({ haunted: true });
    await rail.sendTip(uuid(), { viewer: 'A', amount: 2n, message: '' });
    const r = await db.execute(sql`SELECT count(*)::int AS n FROM tipjar_deliveries WHERE jar_id = ${jar.id}`);
    expect(r.rows[0]!['n']).toBe(7);
  });
});
