import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRng } from '../../src/poltergeist/rng.js';

/** The published mulberry32, written independently of src/, to cross-check the pinned values. */
function reference(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

describe('createRng (mulberry32)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('pins the first outputs for seeds 0 and 7', () => {
    const pinned: Record<number, number[]> = {
      0: [1144304738, 1416247, 958946056, 627933444, 2007157716],
      7: [50271532, 266108690, 4195786334, 3002305430, 2239590375],
    };
    for (const [seed, want] of Object.entries(pinned)) {
      const r = createRng(Number(seed));
      const ref = reference(Number(seed));
      const got = want.map(() => r.u32());
      expect(got).toEqual(want);
      expect(want.map(() => ref())).toEqual(want);
    }
  });

  it('rejects seeds outside 0 … 2^32 − 1', () => {
    for (const bad of [-1, 2 ** 32, 1.5, Number.NaN]) expect(() => createRng(bad)).toThrow(RangeError);
    expect(() => createRng(2 ** 32 - 1)).not.toThrow();
  });

  it('int and bigint stay within their inclusive bounds and reach both ends', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 32 - 1 }), fc.integer({ min: -50, max: 50 }), fc.nat({ max: 5 }), (seed, min, width) => {
        const r = createRng(seed);
        const seenInt = new Set<number>();
        const seenBig = new Set<bigint>();
        for (let i = 0; i < 200; i++) {
          const v = r.int(min, min + width);
          expect(v).toBeGreaterThanOrEqual(min);
          expect(v).toBeLessThanOrEqual(min + width);
          seenInt.add(v);
          const b = r.bigint(BigInt(min), BigInt(min + width));
          expect(b >= BigInt(min) && b <= BigInt(min + width)).toBe(true);
          seenBig.add(b);
        }
        expect(seenInt.has(min) && seenInt.has(min + width)).toBe(true);
        expect(seenBig.has(BigInt(min)) && seenBig.has(BigInt(min + width))).toBe(true);
      }),
      { numRuns: 50 },
    );
  });

  it('bigint handles ranges wider than 2^53', () => {
    const r = createRng(7);
    for (let i = 0; i < 100; i++) {
      const v = r.bigint(1n, 2n ** 62n);
      expect(v >= 1n && v <= 2n ** 62n).toBe(true);
    }
    expect(() => r.bigint(0n, 2n ** 64n)).toThrow(RangeError);
    expect(() => r.bigint(2n, 1n)).toThrow(RangeError);
  });

  it('shuffle returns a permutation and leaves its input alone', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 32 - 1 }), fc.array(fc.integer(), { maxLength: 20 }), (seed, items) => {
        const copy = [...items];
        const out = createRng(seed).shuffle(items);
        expect(items).toEqual(copy);
        expect([...out].sort((a, b) => a - b)).toEqual([...items].sort((a, b) => a - b));
      }),
    );
  });

  it('weighted and pick only return listed values; hex8 is 8 lowercase hex chars', () => {
    const r = createRng(1);
    for (let i = 0; i < 100; i++) {
      expect(['a', 'b']).toContain(r.weighted([{ weight: 1, value: 'a' }, { weight: 3, value: 'b' }]));
      expect([1, 2, 3]).toContain(r.pick([1, 2, 3]));
      expect(r.hex8()).toMatch(/^[0-9a-f]{8}$/);
    }
    expect(() => r.pick([])).toThrow(RangeError);
    expect(() => r.weighted([{ weight: 0, value: 'x' }])).toThrow(RangeError);
  });

  it('never calls Math.random', () => {
    const spy = vi.spyOn(Math, 'random');
    const r = createRng(42);
    r.int(0, 10);
    r.bigint(0n, 10n ** 9n);
    r.shuffle([1, 2, 3, 4]);
    r.hex8();
    r.weighted([{ weight: 2, value: 1 }]);
    expect(spy).not.toHaveBeenCalled();
  });
});
