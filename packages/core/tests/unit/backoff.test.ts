import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { nextDelayMs } from '../../src/outbox/backoff.js';

describe('nextDelayMs', () => {
  it('doubles from the base: exact values for attempts 1-5', () => {
    expect([1, 2, 3, 4, 5].map((n) => nextDelayMs(n, 1_000, 3_600_000))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000,
    ]);
  });

  it('caps at the maximum', () => {
    expect(nextDelayMs(3, 1_000, 3_000)).toBe(3_000);
    expect(nextDelayMs(12, 1_000, 3_600_000)).toBe(2_048_000);
    expect(nextDelayMs(13, 1_000, 3_600_000)).toBe(3_600_000);
    expect(nextDelayMs(11, 1_000, 3_600_000)).toBe(1_024_000);
  });

  it('stays at the cap for a very large attempt count', () => {
    expect(nextDelayMs(1_000_000, 1_000, 3_600_000)).toBe(3_600_000);
    expect(nextDelayMs(Number.MAX_SAFE_INTEGER, 1, 60_000)).toBe(60_000);
  });

  it('is finite, capped and non-decreasing for any attempt count', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100_000 }), (n) => {
        const d = nextDelayMs(n, 1_000, 3_600_000);
        expect(Number.isFinite(d)).toBe(true);
        expect(d).toBeLessThanOrEqual(3_600_000);
        expect(d).toBeGreaterThanOrEqual(nextDelayMs(Math.max(1, n - 1), 1_000, 3_600_000));
      }),
      { numRuns: 100 },
    );
  });

  it('rejects an attempt count below 1', () => {
    expect(() => nextDelayMs(0, 1_000, 5_000)).toThrow(RangeError);
  });
});
