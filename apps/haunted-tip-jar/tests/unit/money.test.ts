import { describe, expect, it } from 'vitest';
import { formatUsdc, formatUsdcShort, goalPerMille, MAX_AMOUNT, parseUsdc } from '../../src/money';

const ok = (text: string) => {
  const r = parseUsdc(text);
  if (!r.ok) throw new Error(`expected ${text} to parse: ${r.error}`);
  return r.units;
};
const err = (text: string) => {
  const r = parseUsdc(text);
  if (r.ok) throw new Error(`expected ${text} to be rejected`);
  return r.error;
};

describe('parseUsdc', () => {
  it('parses whole, fractional and smallest amounts', () => {
    expect(ok('5')).toBe(5_000_000n);
    expect(ok('2.5')).toBe(2_500_000n);
    expect(ok('2.50')).toBe(2_500_000n);
    expect(ok('0.000001')).toBe(1n);
    expect(ok(' 12.345678 ')).toBe(12_345_678n);
    expect(ok('7.')).toBe(7_000_000n);
    expect(ok('1000000')).toBe(MAX_AMOUNT);
  });

  it('keeps precision a float would lose', () => {
    // 0.1 + 0.2 style trouble, and a value past 2^53 units.
    expect(ok('0.3')).toBe(300_000n);
    expect(ok('999999.999999')).toBe(999_999_999_999n);
  });

  it('rejects bad input with a message naming the problem', () => {
    expect(err('')).toMatch(/Enter an amount/);
    expect(err('0')).toMatch(/more than zero/);
    expect(err('0.000000')).toMatch(/more than zero/);
    expect(err('-1')).toMatch(/positive/);
    expect(err('1.0000001')).toMatch(/6 decimal/);
    expect(err('abc')).toMatch(/digits/);
    expect(err('1e3')).toMatch(/digits/);
    expect(err('1,000')).toMatch(/digits/);
    expect(err('.5')).toMatch(/digits/);
    expect(err('1000000.000001')).toMatch(/1,000,000/);
    expect(err('99999999999999999999')).toMatch(/1,000,000/);
  });
});

describe('formatUsdc', () => {
  it('prints all 6 decimals', () => {
    expect(formatUsdc(0n)).toBe('0.000000');
    expect(formatUsdc(1n)).toBe('0.000001');
    expect(formatUsdc(12_500_000n)).toBe('12.500000');
    expect(formatUsdc(-5_000_000n)).toBe('-5.000000');
  });
  it('short form trims trailing zeros', () => {
    expect(formatUsdcShort(12_500_000n)).toBe('12.5');
    expect(formatUsdcShort(3_000_000n)).toBe('3');
    expect(formatUsdcShort(1n)).toBe('0.000001');
    expect(formatUsdcShort(0n)).toBe('0');
  });
});

describe('goalPerMille', () => {
  it('is clamped and integer', () => {
    expect(goalPerMille(0n, 100n)).toBe(0);
    expect(goalPerMille(50n, 100n)).toBe(500);
    expect(goalPerMille(1n, 3n)).toBe(333);
    expect(goalPerMille(500n, 100n)).toBe(1000);
    expect(goalPerMille(-5n, 100n)).toBe(0);
    expect(goalPerMille(5n, 0n)).toBe(0);
  });
});
