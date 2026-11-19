import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as api from '../../src/index.js';
import { entries, outboxMessages } from '../../src/schema/index.js';
import { createTestDb, type TestDbHandle } from '../helpers/createTestDb.js';

const functionExports = [
  'balance',
  'createAccount',
  'createDb',
  'createWebhookHandler',
  'getAccount',
  'nextDelayMs',
  'postTransaction',
  'refund',
  'runMigrations',
  'runOutboxOnce',
  'signWebhook',
  'verifyWebhook',
];
const errorExports = [
  'AccountNotFoundError',
  'DuplicateAccountError',
  'DuplicateKeyError',
  'IdempotencyWindowExpiredError',
  'InsufficientEntriesError',
  'InvalidAccountTypeError',
  'InvalidFieldError',
  'InvalidRefundAmountError',
  'InvalidWebhookPayloadError',
  'KeyInFlightError',
  'LedgerError',
  'MissingFieldError',
  'MissingIdempotencyKeyError',
  'NormalBalanceViolationError',
  'PaymentNotFoundError',
  'RefundCapExceededError',
  'UnbalancedTransactionError',
];

describe('public API surface', () => {
  it('exports exactly the expected runtime names', () => {
    expect(Object.keys(api).sort()).toEqual([...functionExports, ...errorExports].sort());
    for (const name of functionExports) {
      expect(typeof (api as Record<string, unknown>)[name]).toBe('function');
    }
  });

  it('does not expose schema objects or internal helpers', () => {
    const hidden = [
      'accounts',
      'transactions',
      'entries',
      'idempotencyRecords',
      'accountType',
      'transactionKind',
      'idempotencyStatus',
      'allocateRefund',
      'claimOrReplay',
      'completeKey',
      'writeTransaction',
      'resolveExistingKey',
      'hashPayload',
      'webhookEvents',
      'paymentStates',
      'outboxMessages',
      'applyEvent',
      'parseEvent',
      'uuidV5',
      'ledgerKeyFor',
      'outboxKeyFor',
      'refundOnTx',
      'raisedStatus',
    ];
    for (const name of hidden) expect(name in api).toBe(false);
  });

  it('every exported error class extends LedgerError', () => {
    for (const name of errorExports) {
      const cls = (api as unknown as Record<string, new (...a: never[]) => unknown>)[name]!;
      expect(cls === api.LedgerError || cls.prototype instanceof api.LedgerError).toBe(true);
    }
  });

  it('runMigrations works on a bare pglite database', async () => {
    const client = new PGlite();
    const db = drizzle(client) as unknown as api.Db;
    await api.runMigrations(db);
    const res = await client.query<{ n: string }>(
      `select count(*)::text as n from information_schema.tables where table_name in ('accounts','transactions','entries','idempotency_records')`,
    );
    expect(res.rows[0]!.n).toBe('4');
    await client.close();
  });
});

describe('end-to-end through the public entry point', () => {
  let handle: TestDbHandle;
  let db: api.Db;

  beforeEach(async () => {
    handle = await createTestDb();
    db = handle.db as unknown as api.Db;
  });
  afterEach(async () => {
    await handle.close();
  });

  it('capture, balance, partial refund, replay, cap', async () => {
    const cash = randomUUID();
    const revenue = randomUUID();
    const paymentId = randomUUID();
    await api.createAccount(db, { accountId: cash, name: 'Clearing', type: 'asset' });
    await api.createAccount(db, { accountId: revenue, name: 'Revenue', type: 'revenue' });
    expect((await api.getAccount(db, cash)).type).toBe('asset');

    await api.postTransaction(db, {
      idempotencyKey: randomUUID(),
      kind: 'capture',
      paymentId,
      entries: [
        { accountId: cash, amount: 1000n },
        { accountId: revenue, amount: -1000n },
      ],
    });
    expect(await api.balance(db, cash)).toBe(1000n);
    expect(await api.balance(db, revenue)).toBe(-1000n);

    const key = randomUUID();
    const first = await api.refund(db, { idempotencyKey: key, paymentId, amount: 300n });
    expect(await api.balance(db, cash)).toBe(700n);
    expect(await api.balance(db, revenue)).toBe(-700n);

    const replay = await api.refund(db, { idempotencyKey: key, paymentId, amount: 300n });
    expect(replay).toEqual(first);
    expect(await api.balance(db, cash)).toBe(700n);
    expect(await api.balance(db, revenue)).toBe(-700n);

    const err = await api
      .refund(db, { idempotencyKey: randomUUID(), paymentId, amount: 701n })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(api.RefundCapExceededError);
    expect((err as api.RefundCapExceededError).remaining).toBe(700n);

    const all = await handle.db.select({ amount: entries.amount }).from(entries);
    expect(all.reduce((s, e) => s + e.amount, 0n)).toBe(0n);
  });

  it('webhook intake and outbox delivery, using only the public API', async () => {
    const SECRET = 'public-api-secret-0123456789-abcdefghij';
    const nowS = 1_800_000_000;
    const clock: api.Clock = { now: () => nowS * 1000 };
    const clearing = randomUUID();
    const revenue = randomUUID();
    await api.createAccount(db, { accountId: clearing, name: 'Clearing', type: 'asset', allowOverdraft: true });
    await api.createAccount(db, { accountId: revenue, name: 'Revenue', type: 'revenue' });
    const handler = await api.createWebhookHandler(db, {
      secret: SECRET,
      asset: 'USDC',
      clearingAccountId: clearing,
      revenueAccountId: revenue,
      clock,
    });
    const deliver = (e: Record<string, unknown>) => {
      const rawBody = JSON.stringify({ asset: 'USDC', ...e });
      return handler({
        rawBody,
        headers: {
          'ossuary-timestamp': String(nowS),
          'ossuary-signature': api.signWebhook(SECRET, nowS, rawBody),
        },
      });
    };
    const pA = randomUUID();
    const pB = randomUUID();

    // 1. A signed capture moves the balances.
    const capA = { id: 'evt-capA', type: 'payment.captured', paymentId: pA, amount: '1000' };
    expect((await deliver(capA)).body).toEqual({ ok: true, outcome: 'applied' });
    expect(await api.balance(db, clearing)).toBe(1000n);
    expect(await api.balance(db, revenue)).toBe(-1000n);

    // 2. A refund that arrives before its capture is parked.
    const refB = { id: 'evt-refB', type: 'payment.refunded', paymentId: pB, amount: '250' };
    expect((await deliver(refB)).body).toEqual({ ok: true, outcome: 'parked' });
    expect(await api.balance(db, clearing)).toBe(1000n);

    // 3. Its capture arrives and the parked refund is applied.
    const capB = { id: 'evt-capB', type: 'payment.captured', paymentId: pB, amount: '600' };
    expect((await deliver(capB)).body).toEqual({ ok: true, outcome: 'applied' });
    expect(await api.balance(db, clearing)).toBe(1000n + 600n - 250n);
    expect(await api.balance(db, revenue)).toBe(-(1000n + 600n - 250n));

    // 4. The worker sends every message once, each with its idempotency key.
    const calls: api.OutboxMessageToSend[] = [];
    const sender: api.Sender = async (m) => void calls.push(m);
    const run = await api.runOutboxOnce(db, { sender, clock });
    expect(run).toEqual({ claimed: 3, sent: 3, failed: 0, dead: 0 });
    expect(calls.map((c) => c.topic).sort()).toEqual(['payment.captured', 'payment.captured', 'payment.refunded']);
    expect(new Set(calls.map((c) => c.idempotencyKey)).size).toBe(3);
    const stored = await handle.db.select().from(outboxMessages);
    expect(stored).toHaveLength(3);
    expect(stored.every((m) => m.status === 'sent')).toBe(true);
    expect(new Set(stored.map((m) => m.idempotencyKey))).toEqual(new Set(calls.map((c) => c.idempotencyKey)));
    expect((await api.runOutboxOnce(db, { sender, clock })).claimed).toBe(0);

    // 5. A duplicate delivery changes nothing.
    const entriesBefore = (await handle.db.select().from(entries)).length;
    expect((await deliver(capA)).body).toEqual({ ok: true, outcome: 'duplicate' });
    expect((await deliver(refB)).body).toEqual({ ok: true, outcome: 'duplicate' });
    expect(await api.balance(db, clearing)).toBe(1350n);
    expect((await handle.db.select().from(entries)).length).toBe(entriesBefore);
    expect(await handle.db.select().from(outboxMessages)).toHaveLength(3);
    expect(calls).toHaveLength(3);
  });
});
