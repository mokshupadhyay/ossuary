import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAccount } from '../../src/ledger/accounts.js';
import { postTransaction } from '../../src/ledger/postTransaction.js';
import {
  NormalBalanceViolationError,
  UnbalancedTransactionError,
} from '../../src/errors/index.js';
import { entries, idempotencyRecords, transactions } from '../../src/schema/index.js';
import type { Db, Tx } from '../../src/db/client.js';
import { createTestDb, type TestDbHandle } from '../helpers/createTestDb.js';

let handle: TestDbHandle;
let db: Db;
let a: string;
let b: string;

beforeEach(async () => {
  handle = await createTestDb();
  db = handle.db as unknown as Db;
  a = randomUUID();
  b = randomUUID();
  await createAccount(db, { accountId: a, name: 'A', type: 'asset', allowOverdraft: true });
  await createAccount(db, { accountId: b, name: 'B', type: 'liability', allowOverdraft: true });
});
afterEach(async () => {
  await handle.close();
});

const counts = async () => ({
  keys: (await handle.db.select().from(idempotencyRecords)).length,
  txs: (await handle.db.select().from(transactions)).length,
  entries: (await handle.db.select().from(entries)).length,
});

const input = (amount = 100n) => ({
  idempotencyKey: randomUUID(),
  kind: 'transfer' as const,
  entries: [
    { accountId: a, amount },
    { accountId: b, amount: -amount },
  ],
});

const claim = (tx: Tx, key: string) =>
  tx.insert(idempotencyRecords).values({ key, requestHash: 'caller-hash', status: 'in_progress' });

class Boom extends Error {}

describe('postTransaction with caller tx', () => {
  it('commits atomically with the caller work', async () => {
    const inp = input();
    await db.transaction(async (tx) => {
      await claim(tx, inp.idempotencyKey);
      const res = await postTransaction(db, inp, tx);
      await tx
        .update(idempotencyRecords)
        .set({ status: 'completed', response: res })
        .where(eq(idempotencyRecords.key, inp.idempotencyKey));
    });

    const [rec] = await handle.db.select().from(idempotencyRecords);
    expect(rec!.status).toBe('completed');
    expect(rec!.requestHash).toBe('caller-hash');
    expect(await counts()).toEqual({ keys: 1, txs: 1, entries: 2 });
    const [t] = await handle.db.select().from(transactions);
    expect(t!.idempotencyKey).toBe(inp.idempotencyKey);
    expect((rec!.response as { transactionId: string }).transactionId).toBe(t!.id);
  });

  it('does not mark the record completed itself', async () => {
    const inp = input();
    await db.transaction(async (tx) => {
      await claim(tx, inp.idempotencyKey);
      await postTransaction(db, inp, tx);
      const [rec] = await tx
        .select()
        .from(idempotencyRecords)
        .where(eq(idempotencyRecords.key, inp.idempotencyKey));
      expect(rec!.status).toBe('in_progress');
      expect(rec!.response).toBeNull();
    });
  });

  it('rolling back the outer transaction removes everything', async () => {
    const inp = input();
    await expect(
      db.transaction(async (tx) => {
        await claim(tx, inp.idempotencyKey);
        await postTransaction(db, inp, tx);
        throw new Boom();
      }),
    ).rejects.toBeInstanceOf(Boom);
    expect(await counts()).toEqual({ keys: 0, txs: 0, entries: 0 });
  });

  it('propagates a normal-balance violation and persists nothing', async () => {
    const strict = randomUUID();
    await createAccount(db, { accountId: strict, name: 'S', type: 'asset' });
    const inp = {
      idempotencyKey: randomUUID(),
      kind: 'transfer' as const,
      entries: [
        { accountId: strict, amount: -5n },
        { accountId: b, amount: 5n },
      ],
    };
    await expect(
      db.transaction(async (tx) => {
        await claim(tx, inp.idempotencyKey);
        await postTransaction(db, inp, tx);
      }),
    ).rejects.toBeInstanceOf(NormalBalanceViolationError);
    expect(await counts()).toEqual({ keys: 0, txs: 0, entries: 0 });
  });

  it('fails on the idempotency FK when the key was not claimed', async () => {
    const inp = input();
    await expect(
      db.transaction(async (tx) => {
        await postTransaction(db, inp, tx);
      }),
    ).rejects.toThrow();
    expect(await counts()).toEqual({ keys: 0, txs: 0, entries: 0 });
  });

  it('runs validation before any statement on tx', async () => {
    const bad = { ...input(), entries: [{ accountId: a, amount: 1n }, { accountId: b, amount: -2n }] };
    await db.transaction(async (tx) => {
      await claim(tx, bad.idempotencyKey);
      await expect(postTransaction(db, bad, tx)).rejects.toBeInstanceOf(UnbalancedTransactionError);
      // tx is still usable (no aborted-statement state) and nothing was written.
      const rows = await tx.select().from(entries);
      expect(rows).toHaveLength(0);
    });
  });
});
