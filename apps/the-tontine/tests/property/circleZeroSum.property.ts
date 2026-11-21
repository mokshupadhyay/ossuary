import { PGlite } from '@electric-sql/pglite';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { CircleModel, circleSpec, commands, harness, ledgerFacts, Mismatch, NUM_RUNS, step, type Harness } from './helpers/circleModel';

/*
 * Property 3: zero sum (Requirement 7.3).
 * For any circle and any sequence of operations, after every operation the
 * entries on the circle's accounts sum to exactly zero, and so does every
 * entry in the database (all circles share one ledger here).
 */

let client: PGlite;
let h: Harness;
beforeAll(async () => {
  client = new PGlite();
  h = await harness(client);
});
afterAll(() => client.close());

describe('Property 3: zero sum', () => {
  it("a circle's entries, and the whole ledger's, always sum to zero", async () => {
    await fc.assert(
      fc.asyncProperty(circleSpec, commands(40), async (spec, cmds) => {
        const circleId = await h.svc.createCircle({ name: 'Property 3', members: spec.names, contribution: spec.contribution });
        const m = new CircleModel(spec.names.length, spec.contribution);
        for (const [i, cmd] of cmds.entries()) {
          // Results are checked by Property 1; this property only needs the ledger after each command.
          await step(h, circleId, m, cmd).catch((e) => {
            if (!(e instanceof Mismatch)) throw e;
          });
          const f = await ledgerFacts(h, circleId);
          if (f.circleSum !== 0n) throw new Mismatch(`after command ${i} ${JSON.stringify(cmd)}: circle entries sum to ${f.circleSum}`);
          if (f.ledgerSum !== 0n) throw new Mismatch(`after command ${i} ${JSON.stringify(cmd)}: ledger entries sum to ${f.ledgerSum}`);
          const v = await h.svc.view(circleId);
          if (v.ledgerSum !== 0n) throw new Mismatch(`after command ${i}: the circle view reports a ledger sum of ${v.ledgerSum}`);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
