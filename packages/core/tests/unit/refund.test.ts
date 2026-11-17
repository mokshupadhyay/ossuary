import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAccount } from '../../src/ledger/accounts.js';
import { balance } from '../../src/ledger/balance.js';
import { postTransaction } from '../../src/ledger/postTransaction.js';
import { allocateRefund, refund } from '../../src/ledger/refund.js';
import {
  DuplicateKeyError,
  InvalidFieldError,
  InvalidRefundAmountError,
  MissingFieldError,
  MissingIdempotencyKeyError,
  PaymentNotFoundError,
  RefundCapExceededError,
} from '../../src/errors/index.js';
import { entries, idempotencyRecords, transactions } from '../../src/schema/index.js';
import type { Db } from '../../src/db/client.js';
import { createTestDb, type TestDbHandle } from '../helpers/createTestDb.js';

let handle: TestDbHandle;
let db: Db;
let cash: string; // asset (debit-normal)
let revenue: string; // revenue (credit-normal)

beforeEach(async () => {
  handle = await createTestDb();
  db = handle.db as unknown as Db;
  cash = randomUUID();
  revenue = randomUUID();
  // No allow_overdraft needed: cash goes 0 -> +N -> 0, revenue 0 -> -N -> 0.
  await createAccount(db, { accountId: cash, name: 'Cash', type: 'asset' });
  await createAccount(db, { accountId: revenue, name: 'Revenue', type: 'revenue' });
});

afterEach(async () => {
  await handle.close();
});

const counts = async () => ({
  keys: (await handle.db.select().from(idempotencyRecords)).length,
  txs: (await handle.db.select().from(transactions)).length,
  entries: (await handle.db.select().from(entries)).length,
});

const capture = (paymentId: string, amount: bigint, cashId = cash) =>
  postTransaction(db, {
    idempotencyKey: randomUUID(),
    kind: 'capture',
    paymentId,
    entries: [
      { accountId: cashId, amount },
      { accountId: revenue, amount: -amount },
    ],
  });

const doRefund = (paymentId: string, amount: bigint, idempotencyKey = randomUUID()) =>
  refund(db, { idempotencyKey, paymentId, amount });

describe('allocateRefund', () => {
  const m = (o: Record<string, bigint>) => new Map(Object.entries(o));

  it('reverses a simple two-leg capture', () => {
    expect(allocateRefund(m({ a: 100n, b: -100n }), 40n)).toEqual([
      { accountId: 'a', amount: -40n },
      { accountId: 'b', amount: 40n },
    ]);
  });

  it('allocates greedily in ascending account order across multiple legs', () => {
    const legs = allocateRefund(m({ c1: 60n, c2: 40n, r1: -30n, r2: -70n }), 80n);
    expect(legs).toEqual([
      { accountId: 'c1', amount: -60n },
      { accountId: 'c2', amount: -20n },
      { accountId: 'r1', amount: 30n },
      { accountId: 'r2', amount: 50n },
    ]);
    expect(legs.reduce((s, l) => s + l.amount, 0n)).toBe(0n);
  });

  it('omits accounts with nothing outstanding', () => {
    const legs = allocateRefund(m({ a: 0n, b: 10n, c: -10n }), 10n);
    expect(legs.map((l) => l.accountId)).toEqual(['b', 'c']);
  });

  it('throws instead of returning a partial reversal', () => {
    expect(() => allocateRefund(m({ a: 10n, b: -10n }), 11n)).toThrow(/Cannot allocate/);
  });
});

describe('refund', () => {
  it('full refund succeeds and returns balances to pre-capture values', async () => {
    const p = randomUUID();
    await capture(p, 100n);
    expect(await balance(db, cash)).toBe(100n);

    const res = await doRefund(p, 100n);
    expect(res.entryIds).toHaveLength(2);
    expect(await balance(db, cash)).toBe(0n);
    expect(await balance(db, revenue)).toBe(0n);

    const refundTxs = (await handle.db.select().from(transactions)).filter((t) => t.kind === 'refund');
    expect(refundTxs).toHaveLength(1);
    expect(refundTxs[0]).toMatchObject({ id: res.transactionId, paymentId: p });
  });

  it('partial refund then the remainder succeeds; one more unit is rejected with remaining 0', async () => {
    const p = randomUUID();
    await capture(p, 100n);
    await doRefund(p, 30n);
    expect(await balance(db, cash)).toBe(70n);
    await doRefund(p, 70n);
    expect(await balance(db, cash)).toBe(0n);

    const err = await doRefund(p, 1n).catch((e) => e);
    expect(err).toBeInstanceOf(RefundCapExceededError);
    expect(err).toMatchObject({ requested: 1n, remaining: 0n });
  });

  it('accepts two refunds up to the cap; the second that exceeds it is rejected and writes nothing', async () => {
    const p = randomUUID();
    await capture(p, 100n);
    await doRefund(p, 60n);

    const before = await counts();
    const key = randomUUID();
    const err = await doRefund(p, 50n, key).catch((e) => e);
    expect(err).toBeInstanceOf(RefundCapExceededError);
    expect(err).toMatchObject({ requested: 50n, remaining: 40n });
    expect(await counts()).toEqual(before);

    const keys = await handle.db.select().from(idempotencyRecords);
    expect(keys.find((k) => k.key === key)).toBeUndefined();

    // The same key is reusable with an amount that fits.
    await expect(doRefund(p, 40n, key)).resolves.toBeDefined();
    expect(await balance(db, cash)).toBe(0n);
  });

  it('boundary: exactly remaining is accepted, remaining + 1 is rejected', async () => {
    const p = randomUUID();
    await capture(p, 100n);
    await doRefund(p, 25n);
    await expect(doRefund(p, 76n)).rejects.toMatchObject({ remaining: 75n });
    await expect(doRefund(p, 75n)).resolves.toBeDefined();
  });

  it('over-cap refund writes nothing', async () => {
    const p = randomUUID();
    await capture(p, 100n);
    const before = await counts();
    await expect(doRefund(p, 101n)).rejects.toBeInstanceOf(RefundCapExceededError);
    expect(await counts()).toEqual(before);
  });

  it('unknown payment throws PaymentNotFoundError, writes nothing, leaves key unclaimed', async () => {
    const before = await counts();
    await expect(doRefund(randomUUID(), 10n)).rejects.toBeInstanceOf(PaymentNotFoundError);
    expect(await counts()).toEqual(before);
  });

  it('zero and negative amounts throw InvalidRefundAmountError and write nothing', async () => {
    const p = randomUUID();
    await capture(p, 100n);
    const before = await counts();
    await expect(doRefund(p, 0n)).rejects.toBeInstanceOf(InvalidRefundAmountError);
    await expect(doRefund(p, -5n)).rejects.toBeInstanceOf(InvalidRefundAmountError);
    expect(await counts()).toEqual(before);
  });

  it('validates inputs before opening a transaction', async () => {
    const p = randomUUID();
    const k = randomUUID();
    const bad = (o: object) => refund(db, { idempotencyKey: k, paymentId: p, amount: 1n, ...o } as never);
    await expect(bad({ idempotencyKey: undefined })).rejects.toBeInstanceOf(MissingIdempotencyKeyError);
    await expect(bad({ idempotencyKey: 'nope' })).rejects.toBeInstanceOf(InvalidFieldError);
    await expect(bad({ paymentId: undefined })).rejects.toBeInstanceOf(MissingFieldError);
    await expect(bad({ paymentId: 'nope' })).rejects.toBeInstanceOf(InvalidFieldError);
    await expect(bad({ amount: 5 })).rejects.toBeInstanceOf(InvalidFieldError);
    expect(await counts()).toEqual({ keys: 0, txs: 0, entries: 0 });
  });

  it('replay with the same key returns the identical stored response, even after full refund', async () => {
    const p = randomUUID();
    await capture(p, 100n);
    const key = randomUUID();
    const first = await doRefund(p, 100n, key);
    const before = await counts();

    const again = await doRefund(p, 100n, key);
    expect(again).toEqual(first);
    expect(await counts()).toEqual(before);
    expect(await balance(db, cash)).toBe(0n);
  });

  it('replay with paymentId in different letter case is a replay', async () => {
    const p = randomUUID();
    await capture(p, 100n);
    const key = randomUUID();
    const first = await doRefund(p, 40n, key);
    const before = await counts();
    expect(await doRefund(p.toUpperCase(), 40n, key)).toEqual(first);
    expect(await counts()).toEqual(before);
  });

  it('same key with a different amount throws DuplicateKeyError', async () => {
    const p = randomUUID();
    await capture(p, 100n);
    const key = randomUUID();
    await doRefund(p, 10n, key);
    const before = await counts();
    await expect(doRefund(p, 20n, key)).rejects.toBeInstanceOf(DuplicateKeyError);
    expect(await counts()).toEqual(before);
  });

  it('a key previously used for postTransaction throws DuplicateKeyError', async () => {
    const p = randomUUID();
    await capture(p, 100n);
    const key = randomUUID();
    await postTransaction(db, {
      idempotencyKey: key,
      kind: 'transfer',
      entries: [
        { accountId: cash, amount: 1n },
        { accountId: revenue, amount: -1n },
      ],
    });
    await expect(doRefund(p, 1n, key)).rejects.toBeInstanceOf(DuplicateKeyError);
  });

  it('multi-leg capture: refund allocates greedily and entries match allocateRefund', async () => {
    const cash2 = randomUUID();
    await createAccount(db, { accountId: cash2, name: 'Cash2', type: 'asset' });
    const p = randomUUID();
    await postTransaction(db, {
      idempotencyKey: randomUUID(),
      kind: 'capture',
      paymentId: p,
      entries: [
        { accountId: cash, amount: 60n },
        { accountId: cash2, amount: 40n },
        { accountId: revenue, amount: -100n },
      ],
    });

    const res = await doRefund(p, 80n);
    const expected = allocateRefund(
      new Map([
        [cash, 60n],
        [cash2, 40n],
        [revenue, -100n],
      ]),
      80n,
    );
    const rows = (await handle.db.select().from(entries)).filter((e) => res.entryIds.includes(e.id));
    const got = rows.map((e) => ({ accountId: e.accountId, amount: e.amount }));
    const byId = (x: { accountId: string }, y: { accountId: string }) => x.accountId.localeCompare(y.accountId);
    expect(got.sort(byId)).toEqual([...expected].sort(byId));
    expect(rows.reduce((s, e) => s + e.amount, 0n)).toBe(0n);

    // Second refund continues from what is left on each account.
    await doRefund(p, 20n);
    expect(await balance(db, cash)).toBe(0n);
    expect(await balance(db, cash2)).toBe(0n);
    expect(await balance(db, revenue)).toBe(0n);
  });

  it('two captures on one payment share one cap', async () => {
    const cash2 = randomUUID();
    await createAccount(db, { accountId: cash2, name: 'Cash2', type: 'asset' });
    const p = randomUUID();
    await capture(p, 70n);
    await capture(p, 30n, cash2);

    await expect(doRefund(p, 101n)).rejects.toMatchObject({ remaining: 100n });
    await doRefund(p, 100n);
    expect(await balance(db, cash)).toBe(0n);
    expect(await balance(db, cash2)).toBe(0n);
    expect(await balance(db, revenue)).toBe(0n);
  });

  it("refunds of other payments don't affect the cap", async () => {
    const p1 = randomUUID();
    const p2 = randomUUID();
    await capture(p1, 100n);
    await capture(p2, 100n);
    await doRefund(p1, 100n);
    await expect(doRefund(p2, 100n)).resolves.toBeDefined();
  });

  it('a capture with no payment_id is ignored by the cap', async () => {
    const p = randomUUID();
    await capture(p, 50n);
    await postTransaction(db, {
      idempotencyKey: randomUUID(),
      kind: 'capture',
      entries: [
        { accountId: cash, amount: 500n },
        { accountId: revenue, amount: -500n },
      ],
    });
    await expect(doRefund(p, 51n)).rejects.toMatchObject({ remaining: 50n });
    await expect(doRefund(p, 50n)).resolves.toBeDefined();
  });
});
