// Feature: poltergeist-engine, Property 3: The twin visibly loses money, and the report names the fault
// Validates: Requirements 13.4, 6.3, 6.4, 6.5, 8.4, 13.7
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FAULT_IDS } from '../../src/poltergeist/faults.js';
import type { DriftJson } from '../../src/poltergeist/report.js';
import { generateStorm, isolateUnit, prefixStorm } from '../../src/poltergeist/storm.js';
import { summon } from '../../src/poltergeist/summon.js';
import { runConfig } from '../helpers/arbitraries.js';
import {
  createPoltergeistDbs,
  POLTERGEIST_RUNS,
  seedArb,
  twinSizeArb,
  type PoltergeistDbs,
} from '../helpers/poltergeist.js';

/*
 * Mutation checks (Requirement 13.7), each confirmed to fail this property:
 *   - compute "expected" from the snapshot in measureDrift, so drift is always zero (drift.ts);
 *   - measure each unit's delta against the run's start instead of the previous unit (summon.ts);
 *   - record the main run's final drift in an isolated counterexample instead of the
 *     isolated run's (summon.ts).
 */

let dbs: PoltergeistDbs;
beforeAll(async () => {
  dbs = await createPoltergeistDbs();
});
afterAll(async () => {
  await dbs.close();
});

const byAccount = (...ds: DriftJson[]) => {
  const out = new Map<string, bigint>();
  for (const d of ds) for (const a of d.accounts) out.set(a.account, (out.get(a.account) ?? 0n) + BigInt(a.drift));
  return out;
};

describe('Property 3: the twin visibly loses money, and the report names the fault', () => {
  it('drifts, attributes every cent to a catalog fault, and its counterexample replays', async () => {
    await fc.assert(
      fc.asyncProperty(seedArb, twinSizeArb, async (seed, size) => {
        const storm = generateStorm({ seed, size, ensureEveryFault: true });
        const r = await summon({ storm, factory: dbs.factory('twin'), target: 'twin' });

        expect(r.drift.accounts.some((a) => a.drift !== '0')).toBe(true);
        expect(r.drifted.length).toBeGreaterThan(0);

        const units = new Map(storm.units.map((u) => [u.unitId, u]));
        for (const d of r.drifted) {
          expect(FAULT_IDS).toContain(d.faultId);
          const u = units.get(d.ghostId)!;
          expect(u.kind === 'ghost' && u.faultId).toBe(d.faultId);
        }

        // Every cent of the final drift is attributed (Requirement 6.4).
        const attributed = byAccount(...r.drifted.map((d) => d.drift), r.honest.drift, r.settleDrift);
        for (const a of r.drift.accounts) expect(attributed.get(a.account) ?? 0n, a.account).toBe(BigInt(a.drift));

        const cx = r.counterexample;
        expect(cx).not.toBeNull();
        if (cx!.faultId !== null) expect(FAULT_IDS).toContain(cx!.faultId);
        const replayStorm = cx!.kind === 'isolated' ? isolateUnit(storm, cx!.unitId) : prefixStorm(storm, cx!.unitId);
        const replay = await summon({ storm: replayStorm, factory: dbs.factory('twin'), target: 'twin' });
        expect(replay.drift.total).toBe(cx!.drift.total);
        expect(replay.drift.accounts).toEqual(cx!.drift.accounts);
      }),
      runConfig(POLTERGEIST_RUNS.twinDrifts),
    );
  });
});
