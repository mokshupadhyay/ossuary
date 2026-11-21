// Feature: poltergeist-engine, Property 1: The same seed gives the same storm and the same report
// Validates: Requirements 2.1, 2.2, 3.8, 8.7, 13.2, 13.7
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serializeReport } from '../../src/poltergeist/report.js';
import { generateStorm, stormToJson } from '../../src/poltergeist/storm.js';
import { summon } from '../../src/poltergeist/summon.js';
import { runConfig } from '../helpers/arbitraries.js';
import {
  createPoltergeistDbs,
  determinismSizeArb,
  POLTERGEIST_RUNS,
  seedArb,
  targetArb,
  type PoltergeistDbs,
} from '../helpers/poltergeist.js';

/*
 * Mutation checks (Requirement 13.7), each confirmed to fail this property:
 *   - draw the replay age from Math.random instead of the seeded PRNG (storm.ts);
 *   - add `generatedAt: new Date().toISOString()` to the report (report.ts);
 *   - match member accounts by sorted concrete member id instead of Member_Ref
 *     (summon.ts), which depends on the run tag.
 *
 * Each summon uses a fresh random run tag and a fresh random signing secret,
 * so the report must not depend on either.
 */

let dbs: PoltergeistDbs;
beforeAll(async () => {
  dbs = await createPoltergeistDbs();
});
afterAll(async () => {
  await dbs.close();
});

describe('Property 1: the same seed gives the same storm and the same report', () => {
  it('generates identical storms and byte-identical reports on fresh SUT instances', async () => {
    await fc.assert(
      fc.asyncProperty(seedArb, determinismSizeArb, targetArb, async (seed, size, target) => {
        const a = generateStorm({ seed, size });
        const b = generateStorm({ seed, size });
        expect(b).toEqual(a);
        expect(stormToJson(b)).toBe(stormToJson(a));

        const first = await summon({ storm: a, factory: dbs.factory(target), target });
        const second = await summon({ storm: b, factory: dbs.factory(target), target });
        expect(serializeReport(second)).toBe(serializeReport(first));
      }),
      runConfig(POLTERGEIST_RUNS.determinism),
    );
  });
});
