import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RefundCapExceededError } from '../../src/errors/index.js';
import { postTransaction } from '../../src/ledger/postTransaction.js';
import { refund } from '../../src/ledger/refund.js';
import {
  RUNS,
  captureEntries,
  captureTransactionArb,
  capturedTotal,
  createPropertyDb,
  positiveSumForPayment,
  refundArb,
  runConfig,
  seedAccounts,
  tableCounts,
  type AccountSpec,
  type CaptureShape,
  type PropertyDb,
} from '../helpers/arbitraries.js';

// Normal-balance rules stay on: the refund must reverse within what each account still holds.
const DEBIT_SIDE: readonly AccountSpec[] = [
  { type: 'asset', allowOverdraft: false },
  { type: 'asset', allowOverdraft: false },
];
const CREDIT_SIDE: readonly AccountSpec[] = [
  { type: 'revenue', allowOverdraft: false },
  { type: 'revenue', allowOverdraft: false },
];

let pdb: PropertyDb;
beforeAll(async () => {
  pdb = await createPropertyDb();
});
afterAll(async () => {
  await pdb.handle.close();
});

/** Seeds fresh accounts and posts the captures under one new payment id. */
async function setupPayment(captures: readonly CaptureShape[]): Promise<string> {
  const debitIds = await seedAccounts(pdb.db, DEBIT_SIDE);
  const creditIds = await seedAccounts(pdb.db, CREDIT_SIDE);
  const paymentId = randomUUID();
  for (const c of captures) {
    await postTransaction(pdb.db, {
      idempotencyKey: randomUUID(),
      kind: 'capture',
      paymentId,
      entries: captureEntries(c, debitIds, creditIds),
    });
  }
  return paymentId;
}

const settle = <T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> =>
  p.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

/** Asserts a rejected refund was a cap rejection with these fields and wrote nothing. */
async function expectCapRejection(
  paymentId: string,
  amount: bigint,
  remaining: bigint,
): Promise<void> {
  const before = await tableCounts(pdb.db);
  const result = await settle(refund(pdb.db, { idempotencyKey: randomUUID(), paymentId, amount }));
  expect(result.ok).toBe(false);
  const error = (result as { error: unknown }).error;
  expect(error).toBeInstanceOf(RefundCapExceededError);
  expect((error as RefundCapExceededError).requested).toBe(amount);
  expect((error as RefundCapExceededError).remaining).toBe(remaining);
  // No transaction, no entries, and no idempotency record (the key stays unclaimed).
  expect(await tableCounts(pdb.db)).toEqual(before);
}

// Feature: ledger-core, Property 4: Total refunded per payment never exceeds total captured
// Validates: Requirements 5.7, 9.3d
describe('Property 4: total refunded per payment never exceeds total captured', () => {
  it('holds after every refund attempt, accepted or rejected', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(captureTransactionArb(5000n), { minLength: 1, maxLength: 2 }),
        fc.array(refundArb(3000n), { maxLength: 20, size: 'max' }),
        async (captures, attempts) => {
          const paymentId = await setupPayment(captures);
          const captured = captures.reduce((s, c) => s + capturedTotal(c), 0n);
          let refunded = 0n; // reference model

          for (const amount of attempts) {
            const remaining = captured - refunded;
            if (amount <= remaining) {
              await refund(pdb.db, { idempotencyKey: randomUUID(), paymentId, amount });
              refunded += amount;
            } else {
              await expectCapRejection(paymentId, amount, remaining);
            }

            // The invariant, read from the ledger itself.
            const dbCaptured = await positiveSumForPayment(pdb.db, paymentId, 'capture');
            const dbRefunded = await positiveSumForPayment(pdb.db, paymentId, 'refund');
            expect(dbRefunded <= dbCaptured).toBe(true);
            // And the ledger agrees with the model, so acceptance is neither too strict nor too loose.
            expect(dbCaptured).toBe(captured);
            expect(dbRefunded).toBe(refunded);
          }
        },
      ),
      runConfig(RUNS.refundCap),
    );
  });
});

// Feature: ledger-core, Property 5: Boundary - exact remaining amount accepted, one unit over rejected
// Validates: Requirements 5.8, 5.3
describe('Property 5: exact remaining amount accepted, one unit over rejected', () => {
  it('at the same ledger state, refund(R + 1) is rejected and refund(R) is accepted', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Totals beyond 2^53 so the R + 1 boundary is checked where Number would round.
        fc.array(captureTransactionArb(2n ** 55n), { minLength: 1, maxLength: 2 }),
        // Prior refunds as percentages of what is left at that moment, so they always fit.
        fc.array(fc.integer({ min: 1, max: 100 }), { maxLength: 5 }),
        fc.boolean(), // also refund whatever is left first, to force R = 0
        async (captures, priorPercents, exhaust) => {
          const paymentId = await setupPayment(captures);
          const captured = captures.reduce((s, c) => s + capturedTotal(c), 0n);
          let refunded = 0n;

          const prior = async (amount: bigint) => {
            await refund(pdb.db, { idempotencyKey: randomUUID(), paymentId, amount });
            refunded += amount;
          };
          for (const pct of priorPercents) {
            const left = captured - refunded;
            if (left === 0n) break;
            const amount = (left * BigInt(pct)) / 100n;
            await prior(amount > 0n ? amount : 1n);
          }
          if (exhaust && captured - refunded > 0n) await prior(captured - refunded);

          const R = captured - refunded;
          const dbR =
            (await positiveSumForPayment(pdb.db, paymentId, 'capture')) -
            (await positiveSumForPayment(pdb.db, paymentId, 'refund'));
          expect(dbR).toBe(R);

          if (R > 0n) {
            // Same state for both calls: the rejection writes nothing, so R is still remaining.
            await expectCapRejection(paymentId, R + 1n, R);
            const before = await tableCounts(pdb.db);
            await refund(pdb.db, { idempotencyKey: randomUUID(), paymentId, amount: R });
            const after = await tableCounts(pdb.db);
            expect(after.transactions - before.transactions).toBe(1n);
            expect(after.idempotencyRecords - before.idempotencyRecords).toBe(1n);
            expect(await positiveSumForPayment(pdb.db, paymentId, 'refund')).toBe(captured);
          }

          // Fully refunded: even the smallest unit is rejected.
          await expectCapRejection(paymentId, 1n, 0n);
        },
      ),
      runConfig(RUNS.refundBoundary),
    );
  });
});
