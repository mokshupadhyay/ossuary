// Feature: haunted-tip-jar, Property 3: Amounts round-trip exactly
// Validates: Requirements 2.2, 9.3
//
// Mutation check (recorded in tasks.md 1.3): parseUsdc rewritten as
// BigInt(Math.round(Number(text) * 1e6)) fails this property.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { formatUsdc, formatUsdcShort, MAX_AMOUNT, parseUsdc } from '../../src/money';

const RUNS = { numRuns: 200 };

const units = fc.oneof(
  fc.bigInt({ min: 1n, max: MAX_AMOUNT }),
  // Bias toward amounts with all 6 decimals used and near the top of the range.
  fc.bigInt({ min: MAX_AMOUNT - 1_000_000n, max: MAX_AMOUNT }),
  fc.bigInt({ min: 1n, max: 999_999n }),
);

describe('Property 3: amounts round-trip exactly', () => {
  it('parse(format(x)) === x for both formats', () => {
    fc.assert(
      fc.property(units, (x) => {
        const a = parseUsdc(formatUsdc(x));
        const b = parseUsdc(formatUsdcShort(x));
        expect(a).toEqual({ ok: true, units: x });
        expect(b).toEqual({ ok: true, units: x });
      }),
      RUNS,
    );
  });

  it('rejects more than 6 decimals', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 999_999n }),
        fc.stringMatching(/^[0-9]{7,12}$/),
        (whole, frac) => {
          expect(parseUsdc(`${whole}.${frac}`).ok).toBe(false);
        },
      ),
      RUNS,
    );
  });
});
