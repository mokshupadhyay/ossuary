import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, type AppDb, type Db } from '../../src/db';
import { createJar } from '../../src/jar';
import { UNIT } from '../../src/money';
import { createRail } from '../../src/rail';
import { coffin, deliveries, tips } from '../../src/readModel';
import { SEED_HELD } from '../../src/seed';
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

describe('read model on the seeded jar', () => {
  it('tips: per-tip captured, refunded, charged back, remaining and status, newest first', async () => {
    const jar = await createJar(db, { clock: newClock() });
    const t = await jar.tips();
    expect(t.map((x) => [x.viewer, x.captured, x.refunded, x.chargedBack, x.remaining, x.rejectedReversals, x.status])).toEqual([
      ['Slimer', 1_250_000n, 0n, 0n, 1_250_000n, 0, 'arrived'],
      ['Bloody Mary', 20n * UNIT, 5n * UNIT, 0n, 15n * UNIT, 1, 'partly reversed'],
      ['Headless Nick', 3n * UNIT, 0n, 3n * UNIT, 0n, 0, 'reversed'],
      ['Moaning Myrtle', 12_500_000n, 2_500_000n, 0n, 10n * UNIT, 0, 'partly reversed'],
      ['Casper', 5n * UNIT, 0n, 0n, 5n * UNIT, 0, 'arrived'],
    ]);
  });

  it('coffin: in 41.75, out 10.5 (7.5 refunds + 3 chargebacks), held 31.25, residual 0, every check passes', async () => {
    const jar = await createJar(db, { clock: newClock() });
    const c = await jar.coffin();
    expect(c).toMatchObject({
      tipCount: 5,
      totalIn: 41_750_000n,
      refunds: 7_500_000n,
      chargebacks: 3n * UNIT,
      totalOut: 10_500_000n,
      held: SEED_HELD,
      residual: 0n,
      clearing: SEED_HELD,
      ledgerSum: 0n,
      overCapTipCount: 0,
      balanced: true,
    });
    expect(c.defenses).toEqual({ duplicates: 0, staleRejected: 0, parked: 0, rejectedReversals: 1 });
    expect(c.checks.map((k) => k.ok)).toEqual([true, true, true, true]);
  });
});

describe('read model on hand-built histories', () => {
  async function fresh() {
    const ref = await bareJar(db);
    const clock = newClock();
    const rail = await createRail(db, ref, { clock });
    return { ref, rail, clock };
  }

  it('an empty jar balances at zero', async () => {
    const { ref } = await fresh();
    const c = await coffin(db, ref);
    expect(c).toMatchObject({ tipCount: 0, totalIn: 0n, totalOut: 0n, held: 0n, residual: 0n, balanced: true });
    expect(await tips(db, ref)).toEqual([]);
  });

  it('a tip whose capture has not been delivered is pending and counts nothing', async () => {
    const { ref, rail } = await fresh();
    const t = await rail.sendTip(uuid(), { viewer: 'A', amount: 9n, message: '' }, { deliver: false });
    if (!t.ok) throw new Error('tip failed');
    await rail.deliver(t.events[0]!); // pending only
    expect((await tips(db, ref))[0]).toMatchObject({ captured: 0n, remaining: 0n, status: 'pending' });
    expect(await coffin(db, ref)).toMatchObject({ totalIn: 0n, held: 0n, balanced: true });
  });

  it('a refund delivered before its capture is parked, then applied when the capture lands', async () => {
    const { ref, rail } = await fresh();
    const t = await rail.sendTip(uuid(), { viewer: 'A', amount: 10n, message: '' }, { deliver: false });
    if (!t.ok) throw new Error('tip failed');
    const r = await rail.reverse(uuid(), { paymentId: t.paymentId, amount: 4n, reason: 'chargeback' }, { deliver: false });
    if (!r.ok) throw new Error('reverse failed');
    expect((await rail.deliver(r.events[0]!))[0]!.outcome).toBe('parked');
    expect(await coffin(db, ref)).toMatchObject({ totalOut: 0n, held: 0n, balanced: true });
    await rail.deliver(t.events[1]!);
    expect((await tips(db, ref))[0]).toMatchObject({ captured: 10n, chargedBack: 4n, remaining: 6n });
    const c = await coffin(db, ref);
    expect(c).toMatchObject({ totalIn: 10n, chargebacks: 4n, held: 6n, residual: 0n, balanced: true });
    expect(c.defenses.parked).toBe(1);
  });

  it('counts the defenses: duplicates and a stale replay', async () => {
    const { ref, rail } = await fresh();
    rail.setHaunted(true);
    const t = await rail.sendTip(uuid(), { viewer: 'A', amount: 10n, message: '' });
    if (!t.ok) throw new Error('tip failed');
    await rail.replayStale(t.events[1]!.eventId);
    const c = await coffin(db, ref);
    expect(c.defenses).toMatchObject({ duplicates: 5, staleRejected: 1 });
    expect(c).toMatchObject({ totalIn: 10n, held: 10n, balanced: true });
  });

  it('deliveries: newest first, with mode and outcome', async () => {
    const { ref, rail } = await fresh();
    const t = await rail.sendTip(uuid(), { viewer: 'A', amount: 1n, message: '' });
    if (!t.ok) throw new Error('tip failed');
    await rail.replayStale(t.events[1]!.eventId);
    const log = await deliveries(db, ref);
    expect(log.map((d) => `${d.type}/${d.mode}/${d.status}/${d.outcome}`)).toEqual([
      'payment.captured/stale/401/unauthorized',
      'payment.captured/normal/200/applied',
      'payment.pending/normal/200/applied',
    ]);
  });

  it('the coffin names a failing check when the ledger and the inbox disagree', async () => {
    // Simulates a broken integration: an extra capture posted straight to the ledger, with no inbox event.
    const { ref } = await fresh();
    const { postTransaction } = await import('@ossuary/core');
    await postTransaction(db, {
      idempotencyKey: uuid(),
      kind: 'capture',
      paymentId: uuid(),
      entries: [
        { accountId: ref.clearingAccountId, amount: 5n },
        { accountId: ref.jarAccountId, amount: -5n },
      ],
    });
    const c = await coffin(db, ref);
    expect(c.balanced).toBe(false);
    expect(c.residual).toBe(-5n);
    expect(c.checks.filter((k) => !k.ok).map((k) => k.id)).toEqual(['residual', 'clearing']);
  });
});
