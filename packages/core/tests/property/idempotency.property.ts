import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { balance } from '../../src/ledger/balance.js';
import { postTransaction } from '../../src/ledger/postTransaction.js';
import type { EntryInput } from '../../src/types/index.js';
import {
  RUNS,
  createPropertyDb,
  runConfig,
  seedAccounts,
  tableCounts,
  toEntries,
  validTransactionArb,
  type AccountSpec,
  type PropertyDb,
  type TxShape,
} from '../helpers/arbitraries.js';

// Every account may go either way, so acceptance never depends on order.
const POOL: readonly AccountSpec[] = [
  { type: 'asset', allowOverdraft: true },
  { type: 'liability', allowOverdraft: true },
  { type: 'revenue', allowOverdraft: true },
  { type: 'expense', allowOverdraft: true },
];

const balances = (pdb: PropertyDb, ids: readonly string[]) =>
  Promise.all(ids.map((id) => balance(pdb.db, id)));

/** Same logical payload; account ids optionally re-cased, which must still be a replay. */
const recase = (entries: readonly EntryInput[], upper: boolean): EntryInput[] =>
  entries.map((e) => ({ ...e, accountId: upper ? e.accountId.toUpperCase() : e.accountId }));

let pdb: PropertyDb;
beforeAll(async () => {
  pdb = await createPropertyDb();
});
afterAll(async () => {
  await pdb.handle.close();
});

// Feature: ledger-core, Property 2: Idempotency replay leaves the ledger unchanged
// Validates: Requirements 3.8, 9.3b
describe('Property 2: idempotency replay leaves the ledger unchanged', () => {
  it('replaying a completed postTransaction N times changes nothing and returns the same response', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Amounts beyond 2^53 make any Number round-trip visible.
        validTransactionArb(POOL.length, 2n ** 60n),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 50 }), // one entry per replay: re-case ids?
        async (shape, replays) => {
          const ids = await seedAccounts(pdb.db, POOL);
          const input = {
            idempotencyKey: randomUUID(),
            kind: 'transfer' as const,
            entries: toEntries(shape, ids),
          };

          const first = await postTransaction(pdb.db, input);
          const countsAfterFirst = await tableCounts(pdb.db);
          const balancesAfterFirst = await balances(pdb, ids);

          for (const upper of replays) {
            const again = await postTransaction(pdb.db, {
              ...input,
              entries: recase(input.entries, upper),
            });
            expect(again).toEqual(first);
          }

          expect(await tableCounts(pdb.db)).toEqual(countsAfterFirst);
          expect(await balances(pdb, ids)).toEqual(balancesAfterFirst);
          // The first call really applied the transaction (the check is not vacuous).
          const expected = POOL.map((_, i) =>
            shape.filter((l) => l.account === i).reduce((s, l) => s + l.amount, 0n),
          );
          expect(balancesAfterFirst).toEqual(expected);
        },
      ),
      runConfig(RUNS.replay),
    );
  });
});

/** 1 to 20 distinct transactions plus a delivery order that is a permutation with duplicates. */
const deliveryArb = fc
  .array(validTransactionArb(POOL.length, 2n ** 55n), { minLength: 1, maxLength: 20, size: 'max' })
  .chain((txs) =>
    fc
      .array(fc.nat({ max: txs.length - 1 }), { maxLength: 2 * txs.length, size: 'max' })
      .chain((dups) => {
        const all = [...txs.keys(), ...dups];
        return fc.shuffledSubarray(all, { minLength: all.length, maxLength: all.length });
      })
      .map((order) => ({ txs, order })),
  );

const modelBalances = (txs: readonly TxShape[]): bigint[] =>
  POOL.map((_, i) =>
    txs.flat().reduce((s, l) => (l.account === i ? s + l.amount : s), 0n),
  );

// Feature: ledger-core, Property 3: Replay in any order with duplicates yields the same balances
// Validates: Requirements 9.3, 9.3c, 3.8
describe('Property 3: replay in any order with duplicates yields the same balances', () => {
  it('matches a reference ledger that applies each distinct key exactly once, in order', async () => {
    await fc.assert(
      fc.asyncProperty(deliveryArb, async ({ txs, order }) => {
        const shuffledIds = await seedAccounts(pdb.db, POOL);
        const referenceIds = await seedAccounts(pdb.db, POOL);
        const keys = txs.map(() => randomUUID());
        const before = await tableCounts(pdb.db);

        // Reference ledger: each distinct key once, in natural order, on its own accounts.
        for (const shape of txs) {
          await postTransaction(pdb.db, {
            idempotencyKey: randomUUID(),
            kind: 'transfer',
            entries: toEntries(shape, referenceIds),
          });
        }

        // Shuffled delivery with duplicates; every delivery of a key returns the first response.
        const firstResponse = new Map<number, unknown>();
        for (const i of order) {
          const r = await postTransaction(pdb.db, {
            idempotencyKey: keys[i]!,
            kind: 'transfer',
            entries: toEntries(txs[i]!, shuffledIds),
          });
          if (!firstResponse.has(i)) firstResponse.set(i, r);
          else expect(r).toEqual(firstResponse.get(i));
        }

        const expected = modelBalances(txs);
        expect(await balances(pdb, shuffledIds)).toEqual(expected);
        expect(await balances(pdb, referenceIds)).toEqual(expected);

        // Exactly one transaction per distinct key on each side.
        const after = await tableCounts(pdb.db);
        expect(after.transactions - before.transactions).toBe(BigInt(2 * txs.length));
        expect(after.idempotencyRecords - before.idempotencyRecords).toBe(BigInt(2 * txs.length));
      }),
      runConfig(RUNS.anyOrder),
    );
  });
});
