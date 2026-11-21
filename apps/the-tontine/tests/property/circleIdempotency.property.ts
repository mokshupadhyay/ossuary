import { PGlite } from '@electric-sql/pglite';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { CircleModel, circleSpec, commands, harness, ledgerFacts, Mismatch, NUM_RUNS, replay, step, type Harness, type LedgerFacts } from './helpers/circleModel';

/*
 * Property 2: idempotent replays (Requirement 7.2).
 * For any circle and any prefix of operations, replaying any contribution or
 * payout that already succeeded, with the same idempotency key (once, or 2-3
 * times concurrently), changes nothing: the same number of transactions and
 * entries in the whole ledger, and the same balance on every account of the
 * circle.
 */

let client: PGlite;
let h: Harness;
beforeAll(async () => {
  client = new PGlite();
  h = await harness(client);
});
afterAll(() => client.close());

const snapshot = (f: LedgerFacts) =>
  JSON.stringify({ tx: f.txCount, entries: f.entryCount, clearing: f.clearing, pot: f.pot, wallets: f.wallets }, (_, v) => (typeof v === 'bigint' ? v.toString() : v));

describe('Property 2: idempotent replays', () => {
  it('replaying any successful contribution or payout with its key changes nothing', async () => {
    await fc.assert(
      fc.asyncProperty(
        circleSpec,
        commands(30),
        fc.nat(),
        fc.integer({ min: 1, max: 3 }),
        async (spec, cmds, pick, times) => {
          const circleId = await h.svc.createCircle({ name: 'Property 2', members: spec.names, contribution: spec.contribution });
          const m = new CircleModel(spec.names.length, spec.contribution);
          // Always start with one money operation that succeeds, so there is something to replay.
          await step(h, circleId, m, { t: 'contribute', pos: 0, delta: 0 });
          for (const cmd of cmds) await step(h, circleId, m, cmd);

          const ops = m.done;
          const op = ops[pick % ops.length]!;
          const before = snapshot(await ledgerFacts(h, circleId));
          await replay(h, circleId, op, times);
          const after = snapshot(await ledgerFacts(h, circleId));
          if (before !== after) throw new Mismatch(`replaying ${JSON.stringify(op)} ×${times} changed the ledger:\n${before}\n${after}`);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
