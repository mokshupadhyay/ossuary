import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAccount } from '../../src/ledger/accounts.js';
import { postTransaction } from '../../src/ledger/postTransaction.js';
import {
  InsufficientEntriesError,
  InvalidFieldError,
  MissingIdempotencyKeyError,
  UnbalancedTransactionError,
} from '../../src/errors/index.js';
import { entries, idempotencyRecords, transactions } from '../../src/schema/index.js';
import type { Db } from '../../src/db/client.js';
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

describe('postTransaction', () => {
  it('persists transaction, entries and a completed idempotency record', async () => {
    const i = input();
    const res = await postTransaction(db, i);
    expect(res.entryIds).toHaveLength(2);

    const txs = await handle.db.select().from(transactions);
    expect(txs).toHaveLength(1);
    expect(txs[0]).toMatchObject({ id: res.transactionId, kind: 'transfer', idempotencyKey: i.idempotencyKey });

    const es = await handle.db.select().from(entries);
    expect(es.map((e) => e.id).sort()).toEqual([...res.entryIds].sort());
    expect(es.reduce((s, e) => s + e.amount, 0n)).toBe(0n);

    const recs = await handle.db.select().from(idempotencyRecords);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ key: i.idempotencyKey, status: 'completed', response: res });
  });

  it('round-trips bigint amounts beyond 2^53 exactly', async () => {
    const big = 9007199254740993123n;
    await postTransaction(db, input(big));
    const amounts = (await handle.db.select().from(entries)).map((e) => e.amount);
    expect(amounts).toContain(big);
    expect(amounts).toContain(-big);
  });

  describe('validation writes nothing', () => {
    const cases: [string, (i: ReturnType<typeof input>) => unknown, unknown][] = [
      ['missing key', (i) => ({ ...i, idempotencyKey: '' }), MissingIdempotencyKeyError],
      ['non-UUID key', (i) => ({ ...i, idempotencyKey: 'nope' }), InvalidFieldError],
      ['one entry', (i) => ({ ...i, entries: [i.entries[0]] }), InsufficientEntriesError],
      [
        'unbalanced',
        (i) => ({ ...i, entries: [i.entries[0], { accountId: b, amount: -1n }] }),
        UnbalancedTransactionError,
      ],
      [
        'number amount',
        (i) => ({ ...i, entries: [{ accountId: a, amount: 5 }, { accountId: b, amount: -5 }] }),
        InvalidFieldError,
      ],
      [
        'non-UUID account',
        (i) => ({ ...i, entries: [{ accountId: 'x', amount: 1n }, i.entries[1]] }),
        InvalidFieldError,
      ],
      ['non-UUID paymentId', (i) => ({ ...i, paymentId: 'x' }), InvalidFieldError],
    ];
    for (const [name, mutate, err] of cases) {
      it(name, async () => {
        await expect(postTransaction(db, mutate(input()) as never)).rejects.toBeInstanceOf(
          err as never,
        );
        expect(await counts()).toEqual({ keys: 0, txs: 0, entries: 0 });
      });
    }
  });

  it('rolls back everything, including the key claim, when a write fails mid-way', async () => {
    const key = randomUUID();
    const bad = {
      idempotencyKey: key,
      kind: 'transfer' as const,
      entries: [
        { accountId: a, amount: 10n },
        { accountId: randomUUID(), amount: -10n }, // unknown account trips the FK
      ],
    };
    await expect(postTransaction(db, bad)).rejects.toThrow();
    expect(await counts()).toEqual({ keys: 0, txs: 0, entries: 0 });

    const ok = await postTransaction(db, { ...input(10n), idempotencyKey: key });
    expect(ok.entryIds).toHaveLength(2);
    expect(await counts()).toEqual({ keys: 1, txs: 1, entries: 2 });
  });
});
