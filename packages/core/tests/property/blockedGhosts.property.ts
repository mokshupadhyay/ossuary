// Feature: poltergeist-engine, Property 4: Every blocked ghost maps to a fault in the catalog
// Validates: Requirements 13.5, 1.3, 1.4, 6.3, 8.4, 13.7
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFENSE_LABELS, FAULT_IDS, faultById, shortSubject } from '../../src/poltergeist/faults.js';
import { generateStorm } from '../../src/poltergeist/storm.js';
import { summon } from '../../src/poltergeist/summon.js';
import { runConfig } from '../helpers/arbitraries.js';
import {
  blockedSizeArb,
  createPoltergeistDbs,
  POLTERGEIST_RUNS,
  seedArb,
  targetArb,
  type PoltergeistDbs,
} from '../helpers/poltergeist.js';

/*
 * Mutation checks (Requirement 13.7), each confirmed to fail this property:
 *   - list honest units in `blocked` with faultId 'honest' (report.ts);
 *   - fill blocked[].faultId from the fault's name instead of its id (report.ts);
 *   - put every ghost in `blocked`, dropping the zero-delta check (report.ts).
 */

let dbs: PoltergeistDbs;
beforeAll(async () => {
  dbs = await createPoltergeistDbs();
});
afterAll(async () => {
  await dbs.close();
});

const LABELS = Object.values(DEFENSE_LABELS);
const FATE = new RegExp(`^(passed without drift|buried by (${LABELS.join('|')})( and (${LABELS.join('|')}))*)$`);

describe('Property 4: every blocked ghost maps to a fault in the catalog', () => {
  it('blocked ghosts carry their storm ghost\'s fault id and epitaph, and blocked/drifted partition the ghosts', async () => {
    await fc.assert(
      fc.asyncProperty(seedArb, blockedSizeArb, targetArb, async (seed, size, target) => {
        const storm = generateStorm({ seed, size });
        const r = await summon({ storm, factory: dbs.factory(target), target });
        const units = new Map(storm.units.map((u) => [u.unitId, u]));
        const ghostIds = storm.units.filter((u) => u.kind === 'ghost').map((u) => u.unitId);

        for (const b of r.blocked) {
          expect(FAULT_IDS).toContain(b.faultId);
          const u = units.get(b.ghostId);
          expect(u?.kind, `${b.ghostId} is not a ghost`).toBe('ghost');
          if (u?.kind !== 'ghost') continue;
          expect(b.faultId).toBe(u.faultId);
          expect(b.subject).toBe(u.subject);
          const [head] = faultById(u.faultId).epitaph.replace('{subject}', shortSubject(u.subject)).split('{fate}');
          expect(b.epitaph.startsWith(head!), b.epitaph).toBe(true);
          const fate = b.epitaph.slice(head!.length);
          expect(fate, b.epitaph).toMatch(FATE);
          if (target === 'twin') expect(fate).toBe('passed without drift');
        }

        const blocked = r.blocked.map((b) => b.ghostId);
        const drifted = r.drifted.map((d) => d.ghostId);
        expect(blocked.filter((id) => drifted.includes(id))).toEqual([]);
        expect([...blocked, ...drifted].sort()).toEqual([...ghostIds].sort());

        for (const f of r.faults) {
          const mine = storm.units.filter((u) => u.kind === 'ghost' && u.faultId === f.id);
          expect(f.ghosts).toBe(mine.length);
          expect(f.blocked + f.drifted).toBe(f.ghosts);
          expect(r.blocked.filter((b) => b.faultId === f.id)).toHaveLength(f.blocked);
          expect(r.drifted.filter((d) => d.faultId === f.id)).toHaveLength(f.drifted);
        }
      }),
      runConfig(POLTERGEIST_RUNS.blockedGhosts),
    );
  });
});
