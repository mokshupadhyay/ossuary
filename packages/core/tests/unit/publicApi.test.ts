import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as api from '../../src/index.js';
import { entries } from '../../src/schema/index.js';
import { createTestDb, type TestDbHandle } from '../helpers/createTestDb.js';

const functionExports = [
  'balance',
  'createAccount',
  'createDb',
  'getAccount',
  'postTransaction',
  'refund',
  'runMigrations',
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
});
