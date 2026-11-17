import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  captureTransactionArb,
  capturedTotal,
  refundArb,
  validTransactionArb,
} from '../helpers/arbitraries.js';

describe('shared arbitraries', () => {
  it('validTransactionArb always sums to 0n with at least 2 entries on pool accounts', () => {
    fc.assert(
      fc.property(validTransactionArb(4, 10n ** 12n), (shape) => {
        expect(shape.length).toBeGreaterThanOrEqual(2);
        expect(shape.reduce((s, l) => s + l.amount, 0n)).toBe(0n);
        for (const l of shape) {
          expect(typeof l.amount).toBe('bigint');
          expect(l.account).toBeGreaterThanOrEqual(0);
          expect(l.account).toBeLessThan(4);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('captureTransactionArb has positive legs whose debit and credit totals match', () => {
    fc.assert(
      fc.property(captureTransactionArb(5000n), (c) => {
        expect(c.debits.length).toBeGreaterThanOrEqual(1);
        expect(c.credits.length).toBeGreaterThanOrEqual(1);
        for (const a of [...c.debits, ...c.credits]) expect(a > 0n).toBe(true);
        expect(c.credits.reduce((s, a) => s + a, 0n)).toBe(capturedTotal(c));
      }),
      { numRuns: 500 },
    );
  });

  it('refundArb is always a positive bigint', () => {
    fc.assert(
      fc.property(refundArb(1000n), (a) => {
        expect(typeof a).toBe('bigint');
        expect(a > 0n).toBe(true);
      }),
      { numRuns: 500 },
    );
  });
});
