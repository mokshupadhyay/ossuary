// Feature: ossuary-power, Property 4: The poltergeist command is a fixed template
// Validates: Requirements 1.5, 1.6, 3.1, 3.2
import path from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CLI_RELATIVE, planPoltergeistRun } from '../../src/tools/runPoltergeist.js';
import { REPO_ROOT } from '../helpers/sandbox.js';

/*
 * Mutation checks, each confirmed to fail this property before it was accepted:
 *   - accept any finite number (drop `.int()` on seed and events)
 *     → fails, counterexample {"seed":5e-324,"events":1,"target":"ossuary"}.
 *     The first version of this test passed against this break, because whole-range
 *     doubles almost never land in [0, 2^32); the near-valid generator was added for it.
 *   - accept any string as target (`z.string()` instead of the enum)
 *     → fails, counterexample {"seed":0,"events":1,"target":"twin "}.
 *   - allow unknown keys (drop `.strict()`)
 *     → fails, counterexample {"extra":""}.
 */

const KEYS = ['seed', 'events', 'target'] as const;

/** The schema, written out independently of the implementation. */
function expected(input: unknown): { seed: number; events: number; target: string } | null {
  if (input === undefined || input === null) input = {};
  if (typeof input !== 'object' || Array.isArray(input)) return null;
  const o = input as Record<string, unknown>;
  if (Object.keys(o).some((k) => !(KEYS as readonly string[]).includes(k))) return null;
  const seed = o.seed === undefined ? 7 : o.seed;
  const events = o.events === undefined ? 300 : o.events;
  const target = o.target === undefined ? 'ossuary' : o.target;
  if (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0 || seed > 4294967295) return null;
  if (typeof events !== 'number' || !Number.isInteger(events) || events < 1 || events > 2000) return null;
  if (target !== 'ossuary' && target !== 'twin') return null;
  return { seed, events, target };
}

const valueArb = fc.oneof(
  fc.integer({ min: -5, max: 2005 }),
  fc.constantFrom(0, 1, 7, 2000, 2001, 4294967295, 4294967296, -0, 0.5, 1e21, Number.NaN, Infinity),
  fc.double(),
  fc.constantFrom('ossuary', 'twin', 'Twin', '', 'ossuary --json', '7', '; rm -rf /', '$(id)'),
  fc.string({ maxLength: 8 }),
  fc.boolean(),
  fc.constant(null),
  fc.array(fc.integer(), { maxLength: 2 }),
);

const inputArb = fc.oneof(
  fc.record(
    { seed: valueArb, events: valueArb, target: valueArb },
    { requiredKeys: [] },
  ),
  fc.record({ seed: valueArb, extra: valueArb }, { requiredKeys: ['extra'] }),
  fc.record({ seed: fc.nat({ max: 4294967295 }), events: fc.integer({ min: 1, max: 2000 }), target: fc.constantFrom('ossuary', 'twin') }),
  // Near-valid: each field is in range or just off (fractional, out of range, wrong case).
  fc.record({
    seed: fc.oneof(fc.nat({ max: 4294967295 }), fc.double({ min: 0, max: 5000, noNaN: true })),
    events: fc.oneof(fc.integer({ min: 1, max: 2000 }), fc.double({ min: 0, max: 2500, noNaN: true }), fc.integer({ min: 2001, max: 3000 })),
    target: fc.constantFrom('ossuary', 'twin', 'Ossuary', 'twin '),
  }),
  valueArb,
  fc.constant(undefined),
);

describe('Property 4: the poltergeist command is a fixed template', () => {
  it('accepts exactly the schema, and every accepted input becomes the fixed argv', () => {
    const cli = path.join(REPO_ROOT, CLI_RELATIVE);
    fc.assert(
      fc.property(inputArb, (input) => {
        const want = expected(input);
        const plan = planPoltergeistRun(input, REPO_ROOT);
        if (want === null) {
          expect(plan.ok ? 'accepted' : plan.error.code).toBe('invalid_input');
          return;
        }
        if (!plan.ok) throw new Error(`refused valid input ${JSON.stringify(input)}: ${plan.error.message}`);
        expect(plan.data.file).toBe(process.execPath);
        expect(plan.data.cwd).toBe(path.join(REPO_ROOT, 'packages/core'));
        const [tsx, ...rest] = plan.data.args;
        expect(tsx).toMatch(/tsx[\\/]dist[\\/]cli\.m?js$/);
        expect(rest).toEqual([cli, '--seed', String(want.seed), '--events', String(want.events), '--target', want.target, '--json']);
        expect(rest[2]).toMatch(/^\d+$/);
        expect(rest[4]).toMatch(/^\d+$/);
      }),
      { numRuns: 300 },
    );
  });
});
