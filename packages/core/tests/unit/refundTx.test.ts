import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAccount } from '../../src/ledger/accounts.js';
import { balance } from '../../src/ledger/balance.js';
import { postTransaction } from '../../src/ledger/postTransaction.js';
import { refund } from '../../src/ledger/refund.js';
import { RefundCapExceededError } from '../../src/errors/index.js';
import { entries, idempotencyRecords, transactions } from '../../src/schema/index.js';
import type { Db, Tx } from '../../src/db/client.js';
import { createTestDb, type TestDbHandle } from '../helpers/createTestDb.js';

let handle: TestDbHandle;
let db: Db;
let cash: string;
let revenue: string;
let paymentId: string;

beforeEach(async () => {
  handle = await createTestDb();
  db = handle.db as unknown as Db;
  cash = randomUUID();
  revenue = randomUUID();
  paymentId = randomUUID();
  await createAccount(db, { accountId: cash, name: 'Cash', type: 'asset' });
  await createAccount(db, { accountId: revenue, name: 'Revenue', type: 'revenue' });
  await postTransaction(db, {
    idempotencyKey: randomUUID(),
    kind: 'capture',
    paymentId,
    entries: [
      { accountId: cash, amount: 1000n },
      { accountId: revenue, amount: -1000n },
    ],
  });
});
afterEach(async () => {
  await handle.close();
});

const claim = (tx: Tx, key: string) =>
  tx.insert(idempotencyRecords).values({ key, requestHash: 'caller-hash', status: 'in_progress' });
const txCount = async () => (await handle.db.select().from(transactions)).length;
const entryCount = async () => (await handle.db.select().from(entries)).length;

class Boom extends Error {}

describe('refund with caller tx', () => {
  it('commits atomically with the caller work', async () => {
    const key = randomUUID();
    await db.transaction(async (tx) => {
      await claim(tx, key);
      const res = await refund(db, { idempotencyKey: key, paymentId, amount: 400n }, tx);
      await tx
        .update(idempotencyRecords)
        .set({ status: 'completed', response: res })
        .where(eq(idempotencyRecords.key, key));
    });
    const [rec] = await handle.db
      .select()
      .from(idempotencyRecords)
      .where(eq(idempotencyRecords.key, key));
    expect(rec!.status).toBe('completed');
    expect(rec!.requestHash).toBe('caller-hash');
    expect(await txCount()).toBe(2);
    expect(await entryCount()).toBe(4);
    expect(await balance(db, cash)).toBe(600n);
    expect(await balance(db, revenue)).toBe(-600n);
  });

  it('does not mark the key completed itself', async () => {
    const key = randomUUID();
    await db.transaction(async (tx) => {
      await claim(tx, key);
      await refund(db, { idempotencyKey: key, paymentId, amount: 100n }, tx);
      const [rec] = await tx
        .select()
        .from(idempotencyRecords)
        .where(eq(idempotencyRecords.key, key));
      expect(rec!.status).toBe('in_progress');
    });
  });

  it('is removed when the outer transaction rolls back', async () => {
    const key = randomUUID();
    await expect(
      db.transaction(async (tx) => {
        await claim(tx, key);
        await refund(db, { idempotencyKey: key, paymentId, amount: 400n }, tx);
        throw new Boom();
      }),
    ).rejects.toBeInstanceOf(Boom);
    expect(await txCount()).toBe(1);
    expect(await entryCount()).toBe(2);
    expect(await handle.db.select().from(idempotencyRecords).where(eq(idempotencyRecords.key, key))).toHaveLength(0);
    expect(await balance(db, cash)).toBe(1000n);
  });

  it('leaves the outer transaction usable after a cap error in a savepoint', async () => {
    const okKey = randomUUID();
    const badKey = randomUUID();
    await db.transaction(async (tx) => {
      await claim(tx, okKey);
      await refund(db, { idempotencyKey: okKey, paymentId, amount: 300n }, tx);
      await expect(
        tx.transaction(async (sp) => {
          await claim(sp, badKey);
          await refund(db, { idempotencyKey: badKey, paymentId, amount: 701n }, sp);
        }),
      ).rejects.toBeInstanceOf(RefundCapExceededError);
      // Outer transaction still works, and can refund the exact remainder.
      const lastKey = randomUUID();
      await claim(tx, lastKey);
      await refund(db, { idempotencyKey: lastKey, paymentId, amount: 700n }, tx);
    });
    expect(await txCount()).toBe(3);
    expect(await handle.db.select().from(idempotencyRecords).where(eq(idempotencyRecords.key, badKey))).toHaveLength(0);
    expect(await balance(db, cash)).toBe(0n);
    expect(await balance(db, revenue)).toBe(0n);
  });
});
