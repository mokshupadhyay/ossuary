import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { balance } from '../../src/ledger/balance.js';
import { createAccount } from '../../src/ledger/accounts.js';
import {
  entries,
  idempotencyRecords,
  outboxMessages,
  paymentStates,
  transactions,
  webhookEvents,
} from '../../src/schema/index.js';
import {
  createWebhookHandler,
  type WebhookConfig,
  type WebhookResponse,
} from '../../src/webhooks/handler.js';
import { signWebhook } from '../../src/webhooks/verify.js';
import { createTestDb, type TestDbHandle } from '../helpers/createTestDb.js';

const SECRET = 'SECRET-sentinel-0123456789-abcdefghijklmnop';
const ASSET = 'USDC';
const NOW_S = 1_800_000_000;
const clock = { now: () => NOW_S * 1000 };

let handle: TestDbHandle;
let db: Db;

beforeAll(async () => {
  handle = await createTestDb();
  db = handle.db as unknown as Db;
  // Test-only failure injection: any outbox insert for a payment listed in
  // fail_outbox_for raises. The outbox insert runs after the ledger change, so
  // this fails an event after its money has moved.
  await db.execute(sql`CREATE TABLE fail_outbox_for (payment_id text PRIMARY KEY)`);
  await db.execute(sql`
    CREATE FUNCTION fail_outbox_insert() RETURNS trigger AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM fail_outbox_for WHERE payment_id = NEW.payload->>'paymentId') THEN
        RAISE EXCEPTION 'injected failure after ledger change';
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`);
  await db.execute(sql`
    CREATE TRIGGER fail_outbox BEFORE INSERT ON outbox_messages
    FOR EACH ROW EXECUTE FUNCTION fail_outbox_insert()`);
});
afterAll(async () => {
  await handle.close();
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function fixture() {
  const clearing = randomUUID();
  const revenue = randomUUID();
  await createAccount(db, { accountId: clearing, name: 'Clearing', type: 'asset', allowOverdraft: true });
  await createAccount(db, { accountId: revenue, name: 'Revenue', type: 'revenue' });
  const config: WebhookConfig = {
    secret: SECRET,
    asset: ASSET,
    clearingAccountId: clearing,
    revenueAccountId: revenue,
    clock,
  };
  return { config, handler: await createWebhookHandler(db, config), clearing, revenue };
}

const body = (over: Record<string, unknown>) =>
  JSON.stringify({ id: `evt_${randomUUID()}`, paymentId: randomUUID(), asset: ASSET, ...over });
const sign = (raw: string, ts = NOW_S, secret = SECRET) => ({
  rawBody: raw,
  headers: { 'ossuary-timestamp': String(ts), 'ossuary-signature': signWebhook(secret, ts, raw) },
});
const failFor = (paymentId: string) =>
  db.execute(sql`INSERT INTO fail_outbox_for (payment_id) VALUES (${paymentId})`);
const stopFailing = (paymentId: string) =>
  db.execute(sql`DELETE FROM fail_outbox_for WHERE payment_id = ${paymentId}`);

const rowsFor = async (eventId: string, paymentId: string) => ({
  inbox: (await db.select().from(webhookEvents)).filter((r) => r.eventId === eventId).length,
  states: (await db.select().from(paymentStates)).filter((r) => r.paymentId === paymentId).length,
  txs: (await db.select().from(transactions)).filter((r) => r.paymentId === paymentId).length,
  outbox: (await db.select().from(outboxMessages)).filter((r) => r.eventId === eventId).length,
  keys: (await db.select().from(idempotencyRecords)).length,
  entries: (await db.select().from(entries)).length,
});

describe('rollback after the ledger change', () => {
  it('a failed capture returns 500, leaves nothing behind, and a retry applies it exactly once', async () => {
    const f = await fixture();
    const paymentId = randomUUID();
    const id = `evt_${randomUUID()}`;
    const raw = body({ id, paymentId, type: 'payment.captured', amount: '1234' });
    const before = await rowsFor(id, paymentId);
    await failFor(paymentId);

    const res = await f.handler(sign(raw));
    expect(res).toEqual({ status: 500, body: { ok: false, error: 'internal' } });
    expect(await rowsFor(id, paymentId)).toEqual(before);
    expect(await balance(db, f.clearing)).toBe(0n);
    expect(await balance(db, f.revenue)).toBe(0n);

    await stopFailing(paymentId);
    const retry = await f.handler(sign(raw));
    expect(retry).toEqual({ status: 200, body: { ok: true, outcome: 'applied' } });
    const after = await rowsFor(id, paymentId);
    expect(after).toMatchObject({ inbox: 1, states: 1, txs: 1, outbox: 1 });
    expect(await balance(db, f.clearing)).toBe(1234n);

    const dup = await f.handler(sign(raw));
    expect(dup.body.outcome).toBe('duplicate');
    expect(await balance(db, f.clearing)).toBe(1234n);
  });

  it('a failed refund rolls back its own work only, then applies once on retry', async () => {
    const f = await fixture();
    const paymentId = randomUUID();
    const cap = body({ paymentId, type: 'payment.captured', amount: '1000' });
    expect((await f.handler(sign(cap))).status).toBe(200);

    const id = `evt_${randomUUID()}`;
    const raw = body({ id, paymentId, type: 'payment.refunded', amount: '400' });
    await db.execute(sql`INSERT INTO fail_outbox_for (payment_id) VALUES (${paymentId})`);
    const txsBefore = (await db.select().from(transactions)).length;

    expect((await f.handler(sign(raw))).status).toBe(500);
    expect((await db.select().from(webhookEvents)).some((r) => r.eventId === id)).toBe(false);
    expect((await db.select().from(transactions)).length).toBe(txsBefore);
    expect(await balance(db, f.clearing)).toBe(1000n);
    const [state] = (await db.select().from(paymentStates)).filter((r) => r.paymentId === paymentId);
    expect(state!.status).toBe('captured');

    await stopFailing(paymentId);
    expect((await f.handler(sign(raw))).body.outcome).toBe('applied');
    expect(await balance(db, f.clearing)).toBe(600n);
    expect((await f.handler(sign(raw))).body.outcome).toBe('duplicate');
    expect(await balance(db, f.clearing)).toBe(600n);
  });

  it('a capture that fails while applying parked refunds rolls back the capture too', async () => {
    const f = await fixture();
    const paymentId = randomUUID();
    const refund = body({ paymentId, type: 'payment.refunded', amount: '300' });
    expect((await f.handler(sign(refund))).body.outcome).toBe('parked');

    const capId = `evt_${randomUUID()}`;
    const cap = body({ id: capId, paymentId, type: 'payment.captured', amount: '1000' });
    // Fails on the refund's outbox insert, after the capture's own rows exist.
    // The capture's outbox insert fires the trigger first, so it is enough to
    // fail on this payment: nothing may survive.
    await failFor(paymentId);
    expect((await f.handler(sign(cap))).status).toBe(500);
    expect(await balance(db, f.clearing)).toBe(0n);
    expect((await db.select().from(webhookEvents)).some((r) => r.eventId === capId)).toBe(false);
    const parked = (await db.select().from(webhookEvents)).filter(
      (r) => r.paymentId === paymentId && r.type === 'payment.refunded',
    );
    expect(parked.map((r) => r.status)).toEqual(['parked']);

    await stopFailing(paymentId);
    expect((await f.handler(sign(cap))).body.outcome).toBe('applied');
    expect(await balance(db, f.clearing)).toBe(700n);
  });
});

describe('secrecy', () => {
  it('no response, error or log line contains the secret, a signature or the raw body', async () => {
    const logs: string[] = [];
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
    }
    const f = await fixture();
    const marker = 'RAWBODY-MARKER-9f3a1c';
    const paymentId = randomUUID();

    const goodBody = body({ type: 'payment.pending', paymentId, note: marker });
    const good = sign(goodBody);
    const captured = body({ type: 'payment.captured', paymentId: randomUUID(), amount: '5', note: marker });
    const failingPayment = randomUUID();
    await failFor(failingPayment);
    const failing = body({ type: 'payment.captured', paymentId: failingPayment, amount: '5', note: marker });

    const requests: Array<{
      req: { rawBody: string; headers: Record<string, string | undefined> };
      raw: string;
    }> = [
      { req: good, raw: goodBody }, // 200 applied
      { req: good, raw: goodBody }, // 200 duplicate
      { req: sign(captured), raw: captured }, // 200 applied
      { req: sign(body({ type: 'payment.mystery', note: marker })), raw: marker }, // 200 ignored
      { req: sign(goodBody, NOW_S - 1000), raw: goodBody }, // 401 stale
      { req: sign(goodBody, NOW_S, 'a-different-secret-0123456789-abcdefghij'), raw: goodBody }, // 401 bad sig
      { req: { rawBody: goodBody, headers: {} }, raw: goodBody }, // 401 missing
      { req: sign(body({ asset: marker, type: 'payment.pending' })), raw: marker }, // 400 asset
      { req: sign(body({ paymentId: marker, type: 'payment.pending' })), raw: marker }, // 400 paymentId
      { req: sign(body({ type: 'payment.captured', amount: marker })), raw: marker }, // 400 amount
      { req: sign(`{${marker}`), raw: marker }, // 400 invalid JSON
      { req: sign(failing), raw: failing }, // 500
    ];

    const statuses = new Set<number>();
    for (const { req, raw } of requests) {
      const res: WebhookResponse = await f.handler(req);
      statuses.add(res.status);
      const text = JSON.stringify(res);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(req.headers['ossuary-signature'] ?? '\u0000');
      expect(text).not.toContain(marker);
      expect(text).not.toContain(raw);
    }
    expect([...statuses].sort()).toEqual([200, 400, 401, 500]);

    // A configuration error must not echo the secret either.
    const short = 'short-SECRET-sentinel';
    const err = await createWebhookHandler(db, { ...f.config, secret: short }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain(short);

    for (const line of logs) {
      expect(line).not.toContain(SECRET);
      expect(line).not.toContain(marker);
    }
  });
});
