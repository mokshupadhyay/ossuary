import { PGlite } from '@electric-sql/pglite';
import fc from 'fast-check';
import type { Target } from '../../src/poltergeist/report.js';
import { ossuaryFactory, type SutFactory } from '../../src/poltergeist/sut.js';
import { twinFactory } from '../../src/poltergeist/twinSut.js';
import { createPropertyDb, type PropertyDb } from './arbitraries.js';

/*
 * Shared arbitraries and SUT factories for the poltergeist-engine properties.
 * Each property file uses one migrated database for Ossuary and one PGlite
 * for the twin; every summon picks a fresh run tag, so runs (and fast-check's
 * shrink re-runs) never see each other's rows.
 */

/** Run counts for the four properties. Each must be at least 25 (Requirement 13.6). */
export const POLTERGEIST_RUNS = {
  determinism: 25,
  ossuaryZeroDrift: 25,
  twinDrifts: 25,
  blockedGhosts: 25,
} as const;

export const seedArb: fc.Arbitrary<number> = fc.integer({ min: 0, max: 2 ** 32 - 1 });
export const targetArb: fc.Arbitrary<Target> = fc.constantFrom('ossuary', 'twin');

/** Property 1: sizes 1–100. */
export const determinismSizeArb = fc.integer({ min: 1, max: 100 });
/** Property 2: sizes 1–2,000, weighted 60% 1–60, 30% 61–300, 10% 301–2,000 (design time budget). */
export const ossuarySizeArb = fc.oneof(
  { weight: 6, arbitrary: fc.integer({ min: 1, max: 60 }) },
  { weight: 3, arbitrary: fc.integer({ min: 61, max: 300 }) },
  { weight: 1, arbitrary: fc.integer({ min: 301, max: 2000 }) },
);
/** Property 3: sizes 18–200 with ensureEveryFault. */
export const twinSizeArb = fc.integer({ min: 18, max: 200 });
/** Property 4: sizes 1–150. */
export const blockedSizeArb = fc.integer({ min: 1, max: 150 });

export interface PoltergeistDbs {
  ossuary: PropertyDb;
  twin: PGlite;
  factory(target: Target): SutFactory;
  close(): Promise<void>;
}

/** One migrated database for Ossuary and one PGlite for the twin, shared by every run in a file. */
export async function createPoltergeistDbs(): Promise<PoltergeistDbs> {
  const ossuary = await createPropertyDb();
  const twin = new PGlite();
  return {
    ossuary,
    twin,
    factory: (target) =>
      target === 'ossuary' ? ossuaryFactory({ client: ossuary.handle.client }) : twinFactory({ client: twin }),
    close: async () => {
      await ossuary.handle.close();
      await twin.close();
    },
  };
}
