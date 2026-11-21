import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { formatUsdc, MAX_CONTRIBUTION, MoneyInputError, parseUsdc } from '../../src/money';

describe('parseUsdc', () => {
  it.each([
    ['50', 50_000_000n],
    ['  12.75 ', 12_750_000n],
    ['1,250.5', 1_250_500_000n],
    ['0.000001', 1n],
    ['7.', 7_000_000n],
    ['1000000', MAX_CONTRIBUTION],
  ])('parses %j', (input, expected) => {
    expect(parseUsdc(input)).toBe(expected);
  });

  it.each([
    ['', /Enter an amount/],
    ['0', /more than zero/],
    ['0.000000', /more than zero/],
    ['-5', /more than zero/],
    ['1.0000001', /6 decimal places/],
    ['abc', /digits/],
    ['1e3', /digits/],
    ['1.2.3', /digits/],
    ['.5', /digits/],
    ['1000000.000001', /1,000,000 USDC/],
  ])('rejects %j', (input, message) => {
    expect(() => parseUsdc(input)).toThrow(MoneyInputError);
    expect(() => parseUsdc(input)).toThrow(message);
  });
});

describe('formatUsdc', () => {
  it.each([
    [0n, '0.00 USDC'],
    [1n, '0.000001 USDC'],
    [50_000_000n, '50.00 USDC'],
    [1_250_500_000n, '1,250.50 USDC'],
    [-3_721_037_217n, '−3,721.037217 USDC'],
    [123_456_789_012_345_678n, '123,456,789,012.345678 USDC'],
  ])('formats %s', (amount, expected) => {
    expect(formatUsdc(amount)).toBe(expected);
  });

  it('can add a + sign and drop the code', () => {
    expect(formatUsdc(5_000_000n, { sign: true })).toBe('+5.00 USDC');
    expect(formatUsdc(0n, { sign: true, code: false })).toBe('0.00');
  });

  it('round-trips every valid contribution exactly', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: MAX_CONTRIBUTION }), (x) => {
        expect(parseUsdc(formatUsdc(x))).toBe(x);
        expect(parseUsdc(formatUsdc(x, { code: false }))).toBe(x);
      }),
      { numRuns: 500 },
    );
  });
});
