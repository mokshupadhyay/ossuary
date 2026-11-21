import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  blockedSizeArb,
  determinismSizeArb,
  ossuarySizeArb,
  POLTERGEIST_RUNS,
  seedArb,
  twinSizeArb,
} from '../helpers/poltergeist.js';

describe('poltergeist property helpers', () => {
  it('every property runs at least 25 cases (Requirement 13.6)', () => {
    for (const [name, runs] of Object.entries(POLTERGEIST_RUNS)) expect(runs, name).toBeGreaterThanOrEqual(25);
    expect(Object.keys(POLTERGEIST_RUNS)).toHaveLength(4);
  });

  it('arbitraries stay inside the ranges the properties promise', () => {
    fc.assert(
      fc.property(seedArb, determinismSizeArb, ossuarySizeArb, twinSizeArb, blockedSizeArb, (seed, d, o, t, b) => {
        expect(seed >= 0 && seed <= 2 ** 32 - 1).toBe(true);
        expect(d >= 1 && d <= 100).toBe(true);
        expect(o >= 1 && o <= 2000).toBe(true);
        expect(t >= 18 && t <= 200).toBe(true);
        expect(b >= 1 && b <= 150).toBe(true);
      }),
    );
  });
});
