// Feature: poltergeist-engine, Property 2: Ossuary never drifts
// Validates: Requirements 13.3, 5.2-5.9, 6.2, 7.2, 7.7, 13.7
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateStorm } from '../../src/poltergeist/storm.js';
import { summon } from '../../src/poltergeist/summon.js';
import { globalEntrySum, runConfig } from '../helpers/arbitraries.js';
import {
  createPoltergeistDbs,
  ossuarySizeArb,
  POLTERGEIST_RUNS,
  seedArb,
  type PoltergeistDbs,
} from '../helpers/poltergeist.js';

/*
 * Mutation checks (Requirement 13.7), each confirmed to fail this property:
 *   - record refunds of uncaptured payments as `rejected` instead of `parked` (apply.ts);
 *   - skip applying parked refunds when their capture arrives (apply.ts);
 *   - mint a fresh idempotency key per payout request in the Ossuary adapter (sut.ts);
 *   - catch every error, not only RefundCapExceededError, in applyRefund's savepoint
 *     (apply.ts), so a crash there commits the refund as `rejected`.
 *
 * Not detected, by design: dropping only the inbox dedupe (an upsert that always
 * claims). Duplicates are still stopped by the event-derived ledger key, the
 * payment's captured_event_id and the outbox key's unique constraint, so no
 * money drifts. This is defense in depth, not a gap in the property.
 */

let dbs: PoltergeistDbs;
beforeAll(async () => {
  dbs = await createPoltergeistDbs();
});
afterAll(async () => {
  await dbs.close();
});

describe('Property 2: Ossuary never drifts', () => {
  it('has zero drift on every account, for any seed and any storm size up to 2,000', async () => {
    await fc.assert(
      fc.asyncProperty(seedArb, ossuarySizeArb, async (seed, size) => {
        const r = await summon({ storm: generateStorm({ seed, size }), factory: dbs.factory('ossuary'), target: 'ossuary' });
        expect(r.drift.total).toBe('0');
        expect(r.drift.accounts.filter((a) => a.drift !== '0')).toEqual([]);
        expect([r.drift.conjured, r.drift.lost, r.honest.drift.total, r.settleDrift.total]).toEqual(['0', '0', '0', '0']);
        expect(r.drift.doubleCreditedMembers).toBe(0);
        expect(r.drifted).toEqual([]);
        expect(r.counterexample).toBeNull();
        expect(r.blocked).toHaveLength(r.faults.reduce((n, f) => n + f.ghosts, 0));
        expect(await globalEntrySum(dbs.ossuary.db)).toBe(0n);
      }),
      {
        ...runConfig(POLTERGEIST_RUNS.ossuaryZeroDrift),
        // ~12 s alone, but ~4x slower while the rest of the suite shares the CPU. The
        // shared 45 s bound interrupted it (as a failure) at 20 cases, so this property
        // gets 100 s: still bounded, and below Vitest's 120 s test timeout.
        interruptAfterTimeLimit: 100_000,
        examples: [[7, 2000]],
      },
    );
  });
});
