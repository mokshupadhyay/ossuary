/*
 * Seeded pseudo-random numbers for the storm generator (poltergeist-engine
 * Requirement 2.1). mulberry32: a small, published 32-bit generator. Its
 * statistical quality is irrelevant here; what matters is that the same seed
 * always gives the same sequence, in every process and in the browser.
 * Nothing in the poltergeist uses Math.random.
 */

export interface Rng {
  /** Next 32-bit output, 0 … 2^32 − 1. */
  u32(): number;
  /** Uniform integer in [min, max], inclusive. Unbiased (rejection sampling). */
  int(min: number, max: number): number;
  /** Uniform bigint in [min, max], inclusive. Unbiased; the range may span up to 2^64 values. */
  bigint(min: bigint, max: bigint): bigint;
  pick<T>(items: readonly T[]): T;
  /** Picks a value with probability proportional to its positive integer weight. */
  weighted<T>(items: readonly { weight: number; value: T }[]): T;
  /** Fisher–Yates; returns a shuffled copy and leaves `items` alone. */
  shuffle<T>(items: readonly T[]): T[];
  /** 8 lowercase hexadecimal characters from one draw. */
  hex8(): string;
}

const TWO_32 = 0x1_0000_0000;
const TWO_64 = 1n << 64n;

export function createRng(seed: number): Rng {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new RangeError('seed must be an integer from 0 to 4294967295');
  }
  let state = seed | 0;

  const u32 = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };

  const int = (min: number, max: number): number => {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max < min) {
      throw new RangeError(`int(${min}, ${max}): need safe integers with min <= max`);
    }
    const range = max - min + 1;
    if (range > TWO_32) throw new RangeError('int: range above 2^32, use bigint()');
    const limit = Math.floor(TWO_32 / range) * range;
    let u = u32();
    while (u >= limit) u = u32();
    return min + (u % range);
  };

  const bigint = (min: bigint, max: bigint): bigint => {
    if (max < min) throw new RangeError(`bigint(${min}, ${max}): need min <= max`);
    const range = max - min + 1n;
    if (range > TWO_64) throw new RangeError('bigint: range above 2^64');
    const limit = (TWO_64 / range) * range;
    const draw = (): bigint => (BigInt(u32()) << 32n) | BigInt(u32());
    let u = draw();
    while (u >= limit) u = draw();
    return min + (u % range);
  };

  return {
    u32,
    int,
    bigint,
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new RangeError('pick: empty list');
      return items[int(0, items.length - 1)]!;
    },
    weighted<T>(items: readonly { weight: number; value: T }[]): T {
      const total = items.reduce((s, i) => {
        if (!Number.isInteger(i.weight) || i.weight < 1) throw new RangeError('weighted: weights must be integers >= 1');
        return s + i.weight;
      }, 0);
      if (total === 0) throw new RangeError('weighted: empty list');
      let r = int(0, total - 1);
      for (const i of items) {
        if (r < i.weight) return i.value;
        r -= i.weight;
      }
      throw new Error('unreachable');
    },
    shuffle<T>(items: readonly T[]): T[] {
      const a = [...items];
      for (let i = a.length - 1; i > 0; i--) {
        const j = int(0, i);
        [a[i], a[j]] = [a[j]!, a[i]!];
      }
      return a;
    },
    hex8: () => u32().toString(16).padStart(8, '0'),
  };
}
