import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, type AppDb, type Db } from '../../src/db';
import { createJar, openJar, resetJar } from '../../src/jar';
import { SEED_HELD } from '../../src/seed';
import { entrySum, newClock, uuid } from '../helpers';

let app: AppDb;
let db: Db;
beforeAll(async () => {
  app = await openDatabase();
  db = app.db;
});
afterAll(async () => {
  await app.close();
});

describe('jar', () => {
  it('openJar on an empty database creates one seeded jar; opening again returns the same jar', async () => {
    const clock = newClock();
    const a = await openJar(db, { clock });
    const b = await openJar(db, { clock });
    expect(b.jarId).toBe(a.jarId);
    expect(b.ref).toEqual(a.ref);
    expect(b.info).toEqual({ creator: 'Spooky Streams', goal: 100_000_000n, asset: 'USDC' });
  });

  it('the seed goes through the rail: held, clearing and the rejected over-cap chargeback', async () => {
    const jar = await createJar(db, { clock: newClock() });
    expect(-(await entrySum(db, jar.ref.jarAccountId))).toBe(SEED_HELD);
    expect(SEED_HELD).toBe(31_250_000n);
    expect(await entrySum(db, jar.ref.clearingAccountId)).toBe(SEED_HELD);
    const rejected = await db.execute(sql`
      SELECT count(*)::int AS n FROM webhook_events w JOIN tipjar_tips t ON t.payment_id = w.payment_id
      WHERE t.jar_id = ${jar.jarId} AND w.status = 'rejected'`);
    expect(rejected.rows[0]!['n']).toBe(1);
    const reasons = await db.execute(sql`
      SELECT w.raw_body::jsonb ->> 'reason' AS reason, w.status FROM webhook_events w
      JOIN tipjar_tips t ON t.payment_id = w.payment_id
      WHERE t.jar_id = ${jar.jarId} AND w.type = 'payment.refunded' ORDER BY w.received_seq`);
    expect(reasons.rows.map((r) => `${r['reason']}:${r['status']}`)).toEqual([
      'refund:applied',
      'chargeback:applied',
      'refund:applied',
      'chargeback:rejected',
    ]);
  });

  it('reset archives the old jar, keeps its entries, and opens a fresh seeded one', async () => {
    const clock = newClock();
    const old = await openJar(db, { clock });
    const before = await entrySum(db, old.ref.jarAccountId);
    const fresh = await resetJar(db, { clock });
    expect(fresh.jarId).not.toBe(old.jarId);
    expect((await openJar(db, { clock })).jarId).toBe(fresh.jarId);
    expect(await entrySum(db, old.ref.jarAccountId)).toBe(before);
    const active = await db.execute(sql`SELECT count(*)::int AS n FROM tipjar_jars WHERE archived_at IS NULL`);
    expect(active.rows[0]!['n']).toBe(1);
  });

  it('an unseeded jar starts empty and a tip lands', async () => {
    const jar = await createJar(db, { clock: newClock(), seed: false, creator: 'Test', goal: 1n });
    expect(await entrySum(db, jar.ref.jarAccountId)).toBe(0n);
    const r = await jar.sendTip(uuid(), { viewer: 'A', amount: 7n, message: '' });
    expect(r.ok).toBe(true);
    expect(-(await entrySum(db, jar.ref.jarAccountId))).toBe(7n);
  });

  it('two jars on one database never see each other', async () => {
    const one = await createJar(db, { clock: newClock(), seed: false });
    const two = await createJar(db, { clock: newClock(), seed: false });
    const t = await one.sendTip(uuid(), { viewer: 'A', amount: 7n, message: '' });
    if (!t.ok) throw new Error('tip failed');
    expect(await two.reverse(uuid(), { paymentId: t.paymentId, amount: 1n, reason: 'refund' })).toMatchObject({ status: 400 });
    expect(await entrySum(db, two.ref.jarAccountId)).toBe(0n);
  });
});
