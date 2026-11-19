import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { runOutboxOnce, type OutboxConfig, type OutboxMessageToSend } from '../../src/outbox/worker.js';
import { outboxMessages, webhookEvents } from '../../src/schema/index.js';
import * as schema from '../../src/schema/index.js';
import { createTestDb, type TestDbHandle } from '../helpers/createTestDb.js';

const T0 = 1_800_000_000_000;

let handle: TestDbHandle;
let db: Db;

beforeAll(async () => {
  handle = await createTestDb();
  db = handle.db as unknown as Db;
});
afterAll(async () => {
  await handle.close();
});
// Test-only cleanup so each test sees only its own messages. Production code never deletes.
beforeEach(async () => {
  await handle.client.exec('DELETE FROM outbox_messages');
});

function fakeClock(start = T0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms), set: (v: number) => void (t = v) };
}

/** Records every call. `script` gives per-call outcomes; missing entries succeed. */
function fakeSender(script: Array<'ok' | 'fail'> = []) {
  const calls: OutboxMessageToSend[] = [];
  const sender = async (m: OutboxMessageToSend) => {
    const outcome = script[calls.length] ?? 'ok';
    calls.push(m);
    if (outcome === 'fail') throw new Error(`boom ${calls.length}`);
  };
  return { sender, calls };
}

async function seed(over: Partial<typeof outboxMessages.$inferInsert> = {}) {
  const eventId = `evt_${randomUUID()}`;
  await db.insert(webhookEvents).values({
    eventId,
    type: 'payment.captured',
    paymentId: randomUUID(),
    amount: 1n,
    asset: 'USDC',
    rawBody: '{}',
    status: 'applied',
  });
  const id = randomUUID();
  await db.insert(outboxMessages).values({
    id,
    idempotencyKey: randomUUID(),
    eventId,
    topic: 'payment.captured',
    payload: { eventId, paymentId: randomUUID(), ledgerTransactionId: randomUUID(), asset: 'USDC', amount: '1' },
    nextAttemptAt: new Date(T0),
    ...over,
  });
  return id;
}
const row = async (id: string) =>
  (await db.select().from(outboxMessages).where(eq(outboxMessages.id, id)))[0]!;

const cfg = (over: Partial<OutboxConfig> & Pick<OutboxConfig, 'sender' | 'clock'>): OutboxConfig => ({
  batchSize: 50,
  leaseMs: 60_000,
  baseDelayMs: 1_000,
  maxDelayMs: 100_000,
  maxAttempts: 5,
  ...over,
});

describe('runOutboxOnce', () => {
  it('marks a success sent, passing the idempotency key, topic and payload', async () => {
    const clock = fakeClock();
    const s = fakeSender();
    const id = await seed();
    const before = await row(id);
    const res = await runOutboxOnce(db, cfg({ sender: s.sender, clock }));
    expect(res).toEqual({ claimed: 1, sent: 1, failed: 0, dead: 0 });
    expect(s.calls).toEqual([
      { idempotencyKey: before.idempotencyKey, topic: before.topic, payload: before.payload },
    ]);
    const after = await row(id);
    expect(after).toMatchObject({ status: 'sent', attempts: 1, leaseUntil: null, lastError: null });
    expect(after.sentAt!.getTime()).toBe(T0);

    // Sent messages are never claimed again.
    await runOutboxOnce(db, cfg({ sender: s.sender, clock }));
    expect(s.calls).toHaveLength(1);
  });

  it('does not claim a message before its next-attempt time', async () => {
    const clock = fakeClock();
    const s = fakeSender();
    const id = await seed({ nextAttemptAt: new Date(T0 + 5_000) });
    expect((await runOutboxOnce(db, cfg({ sender: s.sender, clock }))).claimed).toBe(0);
    clock.advance(5_000);
    expect((await runOutboxOnce(db, cfg({ sender: s.sender, clock }))).sent).toBe(1);
    expect((await row(id)).status).toBe('sent');
  });

  it('retries on the exact backoff schedule', async () => {
    const clock = fakeClock();
    const s = fakeSender(['fail', 'fail', 'fail', 'fail', 'ok']);
    const id = await seed();
    const c = cfg({ sender: s.sender, clock, baseDelayMs: 1_000, maxDelayMs: 100_000, maxAttempts: 10 });
    let t = T0;
    for (const delay of [1_000, 2_000, 4_000, 8_000]) {
      const res = await runOutboxOnce(db, c);
      expect(res.failed).toBe(1);
      const r = await row(id);
      expect(r.nextAttemptAt.getTime()).toBe(t + delay);
      expect(r.leaseUntil).toBeNull();
      // One millisecond early: not due.
      clock.set(t + delay - 1);
      expect((await runOutboxOnce(db, c)).claimed).toBe(0);
      t += delay;
      clock.set(t);
    }
    expect((await runOutboxOnce(db, c)).sent).toBe(1);
    const done = await row(id);
    expect(done).toMatchObject({ status: 'sent', attempts: 5, lastError: 'boom 4' });
    expect(new Set(s.calls.map((m) => m.idempotencyKey)).size).toBe(1);
  });

  it('caps the retry delay', async () => {
    const clock = fakeClock();
    const s = fakeSender(Array(6).fill('fail'));
    const id = await seed();
    const c = cfg({ sender: s.sender, clock, baseDelayMs: 1_000, maxDelayMs: 3_000, maxAttempts: 10 });
    const delays: number[] = [];
    for (let i = 0; i < 4; i++) {
      const start = clock.now();
      await runOutboxOnce(db, c);
      const next = (await row(id)).nextAttemptAt.getTime();
      delays.push(next - start);
      clock.set(next);
    }
    expect(delays).toEqual([1_000, 2_000, 3_000, 3_000]);
  });

  it('truncates last_error to 1000 characters', async () => {
    const clock = fakeClock();
    const id = await seed();
    await runOutboxOnce(
      db,
      cfg({
        clock,
        sender: async () => {
          throw new Error('x'.repeat(5_000));
        },
      }),
    );
    expect((await row(id)).lastError).toHaveLength(1_000);
  });

  it('is dead after maxAttempts failures, with the sender called exactly maxAttempts times', async () => {
    const clock = fakeClock();
    const s = fakeSender(Array(10).fill('fail'));
    const id = await seed();
    const c = cfg({ sender: s.sender, clock, maxAttempts: 3, maxDelayMs: 1_000 });
    const results = [];
    for (let i = 0; i < 6; i++) {
      results.push(await runOutboxOnce(db, c));
      clock.advance(10_000);
    }
    expect(s.calls).toHaveLength(3);
    expect(results.map((r) => r.dead)).toEqual([0, 0, 1, 0, 0, 0]);
    expect(await row(id)).toMatchObject({ status: 'dead', attempts: 3, lastError: 'boom 3', leaseUntil: null });
  });

  it('a message claimed with attempts == maxAttempts (crash loop) becomes dead without a send', async () => {
    const clock = fakeClock();
    const s = fakeSender();
    const id = await seed({ attempts: 3 });
    const res = await runOutboxOnce(db, cfg({ sender: s.sender, clock, maxAttempts: 3 }));
    expect(res).toEqual({ claimed: 0, sent: 0, failed: 0, dead: 1 });
    expect(s.calls).toHaveLength(0);
    const r = await row(id);
    expect(r.status).toBe('dead');
    expect(r.attempts).toBe(3);
    expect(r.lastError).toMatch(/attempt limit/);
  });

  it('does not reclaim an unexpired lease, and reclaims an expired one with the same key', async () => {
    const clock = fakeClock();
    const s = fakeSender();
    // Simulates a worker that claimed (attempt 1) and then died before recording.
    const leaseUntil = new Date(T0 + 60_000);
    const id = await seed({ attempts: 1, leaseUntil, claimToken: randomUUID() });
    const original = (await row(id)).idempotencyKey;
    const c = cfg({ sender: s.sender, clock });

    expect((await runOutboxOnce(db, c)).claimed).toBe(0);
    clock.set(T0 + 59_999);
    expect((await runOutboxOnce(db, c)).claimed).toBe(0);
    clock.set(T0 + 60_000);
    expect((await runOutboxOnce(db, c)).sent).toBe(1);
    expect(s.calls.map((m) => m.idempotencyKey)).toEqual([original]);
    expect(await row(id)).toMatchObject({ status: 'sent', attempts: 2 });
  });

  it('drops a stale result after another worker took the message over', async () => {
    const clock = fakeClock();
    const id = await seed();
    const inner = fakeSender();
    let innerResult;
    const outerSender = async () => {
      // While this send is in flight, the lease expires and a second worker takes over and succeeds.
      clock.advance(60_001);
      innerResult = await runOutboxOnce(db, cfg({ sender: inner.sender, clock }));
      throw new Error('stale failure');
    };
    const outer = await runOutboxOnce(db, cfg({ sender: outerSender, clock }));

    expect(innerResult).toEqual({ claimed: 1, sent: 1, failed: 0, dead: 0 });
    expect(outer).toEqual({ claimed: 1, sent: 0, failed: 0, dead: 0 });
    expect(await row(id)).toMatchObject({ status: 'sent', attempts: 2, lastError: null });
    expect(inner.calls).toHaveLength(1);
  });

  it('drops a stale success the same way', async () => {
    const clock = fakeClock();
    const id = await seed();
    const inner = fakeSender(['fail']);
    const outerSender = async () => {
      clock.advance(60_001);
      await runOutboxOnce(db, cfg({ sender: inner.sender, clock }));
    };
    const outer = await runOutboxOnce(db, cfg({ sender: outerSender, clock }));
    expect(outer.sent).toBe(0);
    const r = await row(id);
    expect(r.status).toBe('pending');
    expect(r).toMatchObject({ attempts: 2, lastError: 'boom 1' });
  });

  it('respects batchSize and takes the earliest due messages first', async () => {
    const clock = fakeClock();
    const s = fakeSender();
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(await seed({ nextAttemptAt: new Date(T0 - (5 - i) * 1000) }));
    const res = await runOutboxOnce(db, cfg({ sender: s.sender, clock, batchSize: 2 }));
    expect(res.claimed).toBe(2);
    expect(s.calls).toHaveLength(2);
    expect((await row(ids[0]!)).status).toBe('sent');
    expect((await row(ids[1]!)).status).toBe('sent');
    expect((await row(ids[2]!)).status).toBe('pending');
  });

  it('rejects invalid configuration', async () => {
    const s = fakeSender();
    await expect(runOutboxOnce(db, cfg({ sender: s.sender, clock: fakeClock(), batchSize: 0 }))).rejects.toThrow(
      /batchSize/,
    );
    await expect(runOutboxOnce(db, cfg({ sender: s.sender, clock: fakeClock(), maxAttempts: 1.5 }))).rejects.toThrow(
      /maxAttempts/,
    );
  });

  it('claims with FOR UPDATE SKIP LOCKED and never deletes', async () => {
    // Concurrent workers cannot run on one pglite connection, so inspect the SQL.
    const statements: string[] = [];
    const logged = drizzle(handle.client, {
      schema,
      logger: { logQuery: (q: string) => void statements.push(q) },
    }) as unknown as Db;
    const clock = fakeClock();
    const s = fakeSender(['fail', 'ok']);
    await seed();
    const countBefore = (await db.select().from(outboxMessages)).length;
    await runOutboxOnce(logged, cfg({ sender: s.sender, clock }));
    clock.advance(10_000);
    await runOutboxOnce(logged, cfg({ sender: s.sender, clock }));

    const claim = statements.find((q) => /select/i.test(q) && /outbox_messages/.test(q));
    expect(claim).toBeDefined();
    expect(claim!).toMatch(/for update skip locked/i);
    expect(claim!).toMatch(/order by/i);
    expect(statements.some((q) => /delete\s+from/i.test(q))).toBe(false);
    expect((await db.select().from(outboxMessages)).length).toBe(countBefore);
  });
});
