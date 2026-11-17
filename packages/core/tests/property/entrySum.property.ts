// Feature: ledger-core, Property 1: Global entry sum is always zero
// Validates: Requirements 2.7, 9.3a
import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NormalBalanceViolationError } from '../../src/errors/index.js';
import { balance } from '../../src/ledger/balance.js';
import { postTransaction } from '../../src/ledger/postTransaction.js';
import {
  RUNS,
  SEQUENCE_MAX,
  SEQUENCE_MIN,
  createPropertyDb,
  globalEntrySum,
  runConfig,
  seedAccounts,
  toEntries,
  validTransactionArb,
  type AccountSpec,
  type PropertyDb,
  type TxShape,
} from '../helpers/arbitraries.js';

// Mixed pool: most accounts enforce their normal balance, so many generated
// transactions are rejected; the clearing account may go either way.
const POOL: readonly AccountSpec[] = [
  { type: 'asset', allowOverdraft: false },
  { type: 'liability', allowOverdraft: false },
  { type: 'revenue', allowOverdraft: false },
  { type: 'expense', allowOverdraft: false },
  { type: 'asset', allowOverdraft: true }, // clearing
];

/**
 * Reference model of Requirement 6: returns the lowest violating account id,
 * or null when the transaction is acceptable.
 */
function modelViolation(
  shape: TxShape,
  ids: readonly string[],
  balances: readonly bigint[],
): string | null {
  const delta = new Map<number, bigint>();
  for (const l of shape) delta.set(l.account, (delta.get(l.account) ?? 0n) + l.amount);
  const violating = [...delta.entries()]
    .filter(([i, d]) => {
      const spec = POOL[i]!;
      if (spec.allowOverdraft) return false;
      const prospective = balances[i]! + d;
      const debitNormal = spec.type === 'asset' || spec.type === 'expense';
      return debitNormal ? prospective < 0n : prospective > 0n;
    })
    .map(([i]) => ids[i]!)
    .sort();
  return violating[0] ?? null;
}

let pdb: PropertyDb;
beforeAll(async () => {
  pdb = await createPropertyDb();
});
afterAll(async () => {
  await pdb.handle.close();
});

describe('Property 1: global entry sum is always zero', () => {
  it('holds after every accepted or rejected postTransaction in any sequence', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(validTransactionArb(POOL.length, 10n ** 12n), {
          minLength: SEQUENCE_MIN,
          maxLength: SEQUENCE_MAX,
          size: 'max',
        }),
        async (sequence) => {
          const { db } = pdb;
          const ids = await seedAccounts(db, POOL);
          const model = POOL.map(() => 0n);

          for (const shape of sequence) {
            const expectedViolation = modelViolation(shape, ids, model);
            const call = postTransaction(db, {
              idempotencyKey: randomUUID(),
              kind: 'transfer',
              entries: toEntries(shape, ids),
            });

            if (expectedViolation === null) {
              await call;
              for (const l of shape) model[l.account]! += l.amount;
            } else {
              const err = await call.then(
                () => null,
                (e: unknown) => e,
              );
              expect(err).toBeInstanceOf(NormalBalanceViolationError);
              expect((err as NormalBalanceViolationError).accountId).toBe(expectedViolation);
            }

            expect(await globalEntrySum(db)).toBe(0n);
          }

          // Derived balances agree with the model, so the zero sum is not vacuous.
          for (const [i, id] of ids.entries()) {
            expect(await balance(db, id)).toBe(model[i]);
          }
        },
      ),
      runConfig(RUNS.entrySum),
    );
  });
});
