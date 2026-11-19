import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { createAccount } from '../../src/ledger/accounts.js';
import {
  entries,
  idempotencyRecords,
  outboxMessages,
  paymentStates,
  transactions,
  webhookEvents,
} from '../../src/schema/index.js';
import { createWebhookHandler, type WebhookConfig } from '../../src/webhooks/handler.js';
import { ledgerKeyFor, outboxKeyFor } from '../../src/webhooks/keys.js';
import { signWebhook } from '../../src/webhooks/verify.js';
import { createTestDb, type TestDbHandle } from '../helpers/createTestDb.js';

const SECRET = 'handler-test-secret-0123456789abcdef-XYZ';
const ASSET = 'USDC';
const NOW_S = 1_800_000_000;
const clock = { now: () => NOW_S * 1000 };

let handle: TestDbHandle;
let db: Db;

beforeAll(async () => {
  handle = await createTestDb();
  db = handle.db as unknown as Db;
});
afterAll(async () => {
  await handle.close();
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
  const handler = await createWebhookHandler(db, config);
  return { config, handler, clearing, revenue };
}

const event = (over: Record<string, unknown> = {}) => ({
  id: `evt_${randomUUID()}`,
  type: 'payment.pending',
  paymentId: randomUUID(),
  asset: ASSET,
  ...over,
});
const signed = (body: string, ts = NOW_S, secret = SECRET) => ({
  rawBody: body,
  headers: {
    'ossuary-timestamp': String(ts),
    'ossuary-signature': signWebhook(secret, ts, body),
  },
});
const send = (handler: Awaited<ReturnType<typeof fixture>>['handler'], e: unknown) =>
  handler(signed(JSON.stringify(e)));

const counts = async () => ({
  events: (await db.select().from(webhookEvents)).length,
  states: (await db.select().from(paymentStates)).length,
  outbox: (await db.select().from(outboxMessages)).length,
  txs: (await db.select().from(transactions)).length,
  entries: (await db.select().from(entries)).length,
});

describe('createWebhookHandler configuration', () => {
  it('rejects a secret under 32 bytes, as string or bytes', async () => {
    const f = await fixture();
    await expect(createWebhookHandler(db, { ...f.config, secret: 'short' })).rejects.toThrow(/secret/);
    await expect(
      createWebhookHandler(db, { ...f.config, secret: new Uint8Array(31) }),
    ).rejects.toThrow(/secret/);
    await expect(
      createWebhookHandler(db, { ...f.config, secret: new Uint8Array(32) }),
    ).resolves.toBeTypeOf('function');
  });

  it('rejects an empty asset', async () => {
    const f = await fixture();
    await expect(createWebhookHandler(db, { ...f.config, asset: '' })).rejects.toThrow(/asset/);
  });

  it('rejects a missing clearing account', async () => {
    const f = await fixture();
    await expect(
      createWebhookHandler(db, { ...f.config, clearingAccountId: randomUUID() }),
    ).rejects.toThrow(/clearing account does not exist/);
  });

  it('rejects a clearing account that is not an asset', async () => {
    const f = await fixture();
    const liab = randomUUID();
    await createAccount(db, { accountId: liab, name: 'L', type: 'liability', allowOverdraft: true });
    await expect(
      createWebhookHandler(db, { ...f.config, clearingAccountId: liab }),
    ).rejects.toThrow(/asset account/);
  });

  it('rejects a clearing account without overdraft', async () => {
    const f = await fixture();
    const strict = randomUUID();
    await createAccount(db, { accountId: strict, name: 'S', type: 'asset' });
    await expect(
      createWebhookHandler(db, { ...f.config, clearingAccountId: strict }),
    ).rejects.toThrow(/overdraft/);
  });

  it('rejects a missing revenue account and one of the wrong type', async () => {
    const f = await fixture();
    await expect(
      createWebhookHandler(db, { ...f.config, revenueAccountId: randomUUID() }),
    ).rejects.toThrow(/revenue account does not exist/);
    await expect(
      createWebhookHandler(db, { ...f.config, revenueAccountId: f.clearing }),
    ).rejects.toThrow(/must be a revenue account/);
  });
});

describe('verification failures', () => {
  it('returns 401 with nothing written and no reason disclosed', async () => {
    const { handler } = await fixture();
    const body = JSON.stringify(event());
    const good = signed(body);
    const cases = [
      { rawBody: body, headers: {} },
      { rawBody: body, headers: { 'ossuary-timestamp': String(NOW_S) } },
      { rawBody: body, headers: { ...good.headers, 'ossuary-signature': 'zz' } },
      { rawBody: body, headers: { ...good.headers, 'ossuary-signature': '0'.repeat(64) } },
      signed(body, NOW_S - 301),
      signed(body, NOW_S + 301),
      signed(body, NOW_S, 'another-secret-0123456789abcdef-XYZ'),
      { rawBody: body + ' ', headers: good.headers },
    ];
    const before = await counts();
    for (const req of cases) {
      const res = await handler(req);
      expect(res).toEqual({ status: 401, body: { ok: false, error: 'unauthorized' } });
    }
    expect(await counts()).toEqual(before);
  });
});

describe('parse failures', () => {
  it('returns 400 naming the field, with nothing written', async () => {
    const { handler } = await fixture();
    const before = await counts();
    const cases: Array<[unknown, string]> = [
      [event({ id: '' }), 'id'],
      [event({ paymentId: 'nope' }), 'paymentId'],
      [event({ asset: 'EUR' }), 'asset'],
      [event({ type: 'payment.captured', amount: 5 }), 'amount'],
      [event({ type: 'payment.refunded', amount: '0' }), 'amount'],
    ];
    for (const [e, field] of cases) {
      const res = await send(handler, e);
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toMatch(new RegExp(`^${field}:`));
    }
    const bad = await handler(signed('{not json'));
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/^body:/);
    const badUtf8 = new Uint8Array([0xff, 0xfe, 0x7b]);
    const ts = NOW_S;
    const res = await handler({
      rawBody: badUtf8,
      headers: {
        'ossuary-timestamp': String(ts),
        'ossuary-signature': signWebhook(SECRET, ts, badUtf8),
      },
    });
    expect(res.status).toBe(400);
    expect(await counts()).toEqual(before);
  });
});

describe('inbox', () => {
  it('a duplicate event id returns 200 duplicate and writes nothing, even with a changed payload', async () => {
    const { handler } = await fixture();
    const e = event();
    const first = await send(handler, e);
    expect(first).toEqual({ status: 200, body: { ok: true, outcome: 'applied' } });
    const [stored] = await db.select().from(webhookEvents).where(eq(webhookEvents.eventId, e.id));
    const before = await counts();

    const again = await send(handler, e);
    expect(again).toEqual({ status: 200, body: { ok: true, outcome: 'duplicate' } });
    const changed = await send(handler, { ...e, type: 'payment.whatever', paymentId: randomUUID() });
    expect(changed).toEqual({ status: 200, body: { ok: true, outcome: 'duplicate' } });

    expect(await counts()).toEqual(before);
    const [after] = await db.select().from(webhookEvents).where(eq(webhookEvents.eventId, e.id));
    expect(after).toEqual(stored);
  });

  it('records an unknown type as ignored, with no state, ledger or outbox change', async () => {
    const { handler } = await fixture();
    const before = await counts();
    const e = event({ type: 'payment.disputed' });
    const res = await send(handler, e);
    expect(res).toEqual({ status: 200, body: { ok: true, outcome: 'ignored' } });
    const [row] = await db.select().from(webhookEvents).where(eq(webhookEvents.eventId, e.id));
    expect(row).toMatchObject({ status: 'ignored', type: 'payment.disputed', amount: null });
    expect(row!.rawBody).toBe(JSON.stringify(e));
    expect(await counts()).toEqual({ ...before, events: before.events + 1 });
  });
});

describe('payment.pending', () => {
  it('sets the state when none exists, with no ledger change and no outbox message', async () => {
    const { handler } = await fixture();
    const before = await counts();
    const e = event();
    const res = await send(handler, e);
    expect(res.body.outcome).toBe('applied');
    const [state] = await db.select().from(paymentStates).where(eq(paymentStates.paymentId, e.paymentId));
    expect(state).toMatchObject({ status: 'pending', capturedEventId: null });
    expect(await counts()).toEqual({ ...before, events: before.events + 1, states: before.states + 1 });
  });

  it('leaves a captured state unchanged', async () => {
    const { handler } = await fixture();
    const paymentId = randomUUID();
    await db.insert(paymentStates).values({ paymentId, status: 'captured' });
    const res = await send(handler, event({ paymentId }));
    expect(res.body.outcome).toBe('applied');
    const [state] = await db.select().from(paymentStates).where(eq(paymentStates.paymentId, paymentId));
    expect(state!.status).toBe('captured');
  });

  it('is idempotent across distinct pending events', async () => {
    const { handler } = await fixture();
    const paymentId = randomUUID();
    await send(handler, event({ paymentId }));
    await send(handler, event({ paymentId }));
    const rows = await db.select().from(paymentStates).where(eq(paymentStates.paymentId, paymentId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('pending');
  });
});

describe('payment.captured', () => {
  const captured = (paymentId: string, amount: string, over: Record<string, unknown> = {}) =>
    event({ type: 'payment.captured', paymentId, amount, ...over });
  const balanceOf = async (id: string) => {
    const { balance } = await import('../../src/ledger/balance.js');
    return balance(db, id);
  };

  it('moves clearing by +amount and revenue by -amount, and writes one outbox message', async () => {
    const f = await fixture();
    const paymentId = randomUUID();
    const e = captured(paymentId, '2500');
    const res = await send(f.handler, e);
    expect(res).toEqual({ status: 200, body: { ok: true, outcome: 'applied' } });
    expect(await balanceOf(f.clearing)).toBe(2500n);
    expect(await balanceOf(f.revenue)).toBe(-2500n);

    const [state] = await db.select().from(paymentStates).where(eq(paymentStates.paymentId, paymentId));
    expect(state).toMatchObject({ status: 'captured', capturedEventId: e.id });
    const [ev] = await db.select().from(webhookEvents).where(eq(webhookEvents.eventId, e.id));
    expect(ev!.status).toBe('applied');
    expect(ev!.ledgerTransactionId).not.toBeNull();
    expect(ev!.appliedAt).not.toBeNull();

    const msgs = await db.select().from(outboxMessages).where(eq(outboxMessages.eventId, e.id));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ topic: 'payment.captured', status: 'pending', attempts: 0 });
    expect(msgs[0]!.nextAttemptAt.getTime()).toBe(clock.now());
    expect(msgs[0]!.idempotencyKey).toBe(outboxKeyFor(e.id, 'payment.captured'));
    expect(msgs[0]!.payload).toEqual({
      eventId: e.id,
      paymentId,
      ledgerTransactionId: ev!.ledgerTransactionId,
      asset: ASSET,
      amount: '2500',
    });
    // No JSON numbers anywhere in the payload.
    expect(Object.values(msgs[0]!.payload as object).every((v) => typeof v === 'string')).toBe(true);
  });

  it('stores the derived ledger key on the transaction', async () => {
    const f = await fixture();
    const e = captured(randomUUID(), '10');
    await send(f.handler, e);
    const [ev] = await db.select().from(webhookEvents).where(eq(webhookEvents.eventId, e.id));
    const [t] = await db.select().from(transactions).where(eq(transactions.id, ev!.ledgerTransactionId!));
    expect(t!.idempotencyKey).toBe(ledgerKeyFor(e.id));
    expect(t!.kind).toBe('capture');
    expect(t!.paymentId).toBe(e.paymentId);
  });

  it('rejects a second distinct capture and changes nothing else', async () => {
    const f = await fixture();
    const paymentId = randomUUID();
    const first = captured(paymentId, '700');
    await send(f.handler, first);
    const before = await counts();
    const second = captured(paymentId, '900');
    const res = await send(f.handler, second);
    expect(res).toEqual({ status: 200, body: { ok: true, outcome: 'rejected' } });
    const [row] = await db.select().from(webhookEvents).where(eq(webhookEvents.eventId, second.id));
    expect(row).toMatchObject({ status: 'rejected', rejectionReason: 'duplicate capture' });
    expect(row!.ledgerTransactionId).toBeNull();
    expect(await counts()).toEqual({ ...before, events: before.events + 1 });
    expect(await balanceOf(f.clearing)).toBe(700n);
    const [state] = await db.select().from(paymentStates).where(eq(paymentStates.paymentId, paymentId));
    expect(state!.capturedEventId).toBe(first.id);
  });

  it('round-trips an amount above 2^53 exactly', async () => {
    const f = await fixture();
    const big = 9007199254740993n;
    const e = captured(randomUUID(), big.toString());
    await send(f.handler, e);
    expect(await balanceOf(f.clearing)).toBe(big);
    expect(await balanceOf(f.revenue)).toBe(-big);
    const [ev] = await db.select().from(webhookEvents).where(eq(webhookEvents.eventId, e.id));
    expect(ev!.amount).toBe(big);
    const [m] = await db.select().from(outboxMessages).where(eq(outboxMessages.eventId, e.id));
    expect((m!.payload as { amount: string }).amount).toBe('9007199254740993');
  });

  it('raises a pending payment to captured', async () => {
    const f = await fixture();
    const paymentId = randomUUID();
    await send(f.handler, event({ paymentId }));
    await send(f.handler, captured(paymentId, '5'));
    const [state] = await db.select().from(paymentStates).where(eq(paymentStates.paymentId, paymentId));
    expect(state!.status).toBe('captured');
  });
});

describe('payment.refunded', () => {
  const cap = (paymentId: string, amount: string) =>
    event({ type: 'payment.captured', paymentId, amount });
  const ref = (paymentId: string, amount: string) =>
    event({ type: 'payment.refunded', paymentId, amount });
  const bal = async (id: string) => (await import('../../src/ledger/balance.js')).balance(db, id);
  const inbox = async (id: string) =>
    (await db.select().from(webhookEvents).where(eq(webhookEvents.eventId, id)))[0]!;
  const outboxFor = (id: string) =>
    db.select().from(outboxMessages).where(eq(outboxMessages.eventId, id));
  const stateOf = async (paymentId: string) =>
    (await db.select().from(paymentStates).where(eq(paymentStates.paymentId, paymentId)))[0]!;

  it('a partial refund leaves the state refunded and the balances correct', async () => {
    const f = await fixture();
    const p = randomUUID();
    await send(f.handler, cap(p, '1000'));
    const r = ref(p, '400');
    expect((await send(f.handler, r)).body.outcome).toBe('applied');
    expect((await stateOf(p)).status).toBe('refunded');
    expect(await bal(f.clearing)).toBe(600n);
    expect(await bal(f.revenue)).toBe(-600n);
    const row = await inbox(r.id);
    expect(row.status).toBe('applied');
    expect(row.ledgerTransactionId).not.toBeNull();
    const [t] = await db.select().from(transactions).where(eq(transactions.id, row.ledgerTransactionId!));
    expect(t).toMatchObject({ kind: 'refund', idempotencyKey: ledgerKeyFor(r.id) });
    const msgs = await outboxFor(r.id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      topic: 'payment.refunded',
      idempotencyKey: outboxKeyFor(r.id, 'payment.refunded'),
    });
    expect(msgs[0]!.payload).toMatchObject({ amount: '400', ledgerTransactionId: row.ledgerTransactionId });
  });

  it('parks a refund that arrives before its capture, with no ledger change or outbox message', async () => {
    const f = await fixture();
    const p = randomUUID();
    const r = ref(p, '300');
    const before = await counts();
    expect((await send(f.handler, r)).body.outcome).toBe('parked');
    expect((await inbox(r.id)).status).toBe('parked');
    expect(await outboxFor(r.id)).toHaveLength(0);
    expect(await counts()).toEqual({ ...before, events: before.events + 1, states: before.states + 1 });
    expect((await stateOf(p)).status).toBeNull();
  });

  it('applies a parked refund when the capture arrives', async () => {
    const f = await fixture();
    const p = randomUUID();
    const r = ref(p, '300');
    const c = cap(p, '1000');
    await send(f.handler, r);
    expect((await send(f.handler, c)).body.outcome).toBe('applied');
    expect((await inbox(r.id)).status).toBe('applied');
    expect((await inbox(r.id)).ledgerTransactionId).not.toBeNull();
    expect((await stateOf(p)).status).toBe('refunded');
    expect(await bal(f.clearing)).toBe(700n);
    expect(await outboxFor(r.id)).toHaveLength(1);
    expect(await outboxFor(c.id)).toHaveLength(1);
  });

  it('applies several parked refunds in arrival order', async () => {
    const f = await fixture();
    const p = randomUUID();
    // Arrival order 600, 300, 200 against a 1000 capture: the first two fit and
    // the third does not. Any other order would reject a different refund.
    const r1 = ref(p, '600');
    const r2 = ref(p, '300');
    const r3 = ref(p, '200');
    for (const r of [r1, r2, r3]) await send(f.handler, r);
    await send(f.handler, cap(p, '1000'));
    expect((await inbox(r1.id)).status).toBe('applied');
    expect((await inbox(r2.id)).status).toBe('applied');
    const last = await inbox(r3.id);
    expect(last).toMatchObject({ status: 'rejected', rejectionReason: 'refund exceeds remaining 100' });
    expect(await outboxFor(r3.id)).toHaveLength(0);
    expect(await bal(f.clearing)).toBe(100n);
  });

  it('rejects a refund that no longer fits, and its savepoint leaves no key behind', async () => {
    const f = await fixture();
    const p = randomUUID();
    await send(f.handler, cap(p, '1000'));
    await send(f.handler, ref(p, '700'));
    const r = ref(p, '400');
    const before = await counts();
    const res = await send(f.handler, r);
    expect(res).toEqual({ status: 200, body: { ok: true, outcome: 'rejected' } });
    const row = await inbox(r.id);
    expect(row).toMatchObject({ status: 'rejected', rejectionReason: 'refund exceeds remaining 300' });
    expect(row.ledgerTransactionId).toBeNull();
    expect(await outboxFor(r.id)).toHaveLength(0);
    expect(await counts()).toEqual({ ...before, events: before.events + 1 });
    const keyRows = await db
      .select()
      .from(idempotencyRecords)
      .where(eq(idempotencyRecords.key, ledgerKeyFor(r.id)));
    expect(keyRows).toHaveLength(0);
    expect(await bal(f.clearing)).toBe(300n);
    expect((await send(f.handler, ref(p, '300'))).body.outcome).toBe('applied');
    expect(await bal(f.clearing)).toBe(0n);
  });

  it('with two captures of different amounts, the first to arrive is applied', async () => {
    const f = await fixture();
    const p = randomUUID();
    const first = cap(p, '500');
    const second = cap(p, '900');
    await send(f.handler, first);
    await send(f.handler, second);
    expect((await inbox(second.id)).status).toBe('rejected');
    expect(await bal(f.clearing)).toBe(500n);
    expect((await send(f.handler, ref(p, '501'))).body.outcome).toBe('rejected');
    expect((await send(f.handler, ref(p, '500'))).body.outcome).toBe('applied');
  });

  it('rejects a parked refund that exceeds the capture when applied', async () => {
    const f = await fixture();
    const p = randomUUID();
    const r = ref(p, '2000');
    await send(f.handler, r);
    const c = cap(p, '1000');
    expect((await send(f.handler, c)).body.outcome).toBe('applied');
    const row = await inbox(r.id);
    expect(row).toMatchObject({ status: 'rejected', rejectionReason: 'refund exceeds remaining 1000' });
    expect(await outboxFor(r.id)).toHaveLength(0);
    expect((await stateOf(p)).status).toBe('captured');
    expect(await bal(f.clearing)).toBe(1000n);
  });

  it('a duplicate refund delivery is a no-op', async () => {
    const f = await fixture();
    const p = randomUUID();
    await send(f.handler, cap(p, '1000'));
    const r = ref(p, '100');
    await send(f.handler, r);
    const before = await counts();
    expect((await send(f.handler, r)).body.outcome).toBe('duplicate');
    expect(await counts()).toEqual(before);
    expect(await bal(f.clearing)).toBe(900n);
  });
});
