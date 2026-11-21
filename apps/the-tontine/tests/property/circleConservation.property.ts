import { PGlite } from '@electric-sql/pglite';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { CircleModel, circleSpec, commands, harness, ledgerFacts, Mismatch, NUM_RUNS, step, type Harness } from './helpers/circleModel';

/*
 * Property 1: circle conservation (Requirement 7.1).
 * Over any sequence of contributions (any member, current or wrong round),
 * missed payments, payouts (current or wrong round) and duplicate,
 * concurrent or replayed operations, after every operation:
 *   - the pot is never negative;
 *   - each member received at most one payout, the full pot, and only if
 *     their own round was paid out (so each round has at most one payout);
 *   - money in = money out + pot;
 *   - pot, money in and the current round equal the independent model's.
 */

let client: PGlite;
let h: Harness;
beforeAll(async () => {
  client = new PGlite();
  h = await harness(client);
});
afterAll(() => client.close());

async function checkConservation(circleId: string, m: CircleModel, after: string): Promise<void> {
  const f = await ledgerFacts(h, circleId);
  const fail = (msg: string): never => {
    throw new Mismatch(`after ${after}: ${msg}`);
  };
  if (f.pot < 0n) fail(`pot is negative: ${f.pot}`);
  const potPerRound = BigInt(m.n) * m.contribution;
  for (const [p, w] of f.wallets.entries()) {
    if (f.walletCredits[p]! > 1) fail(`member ${p} was paid ${f.walletCredits[p]} times`);
    const expected = m.paidOut.has(p + 1) ? potPerRound : 0n;
    if (w !== expected) fail(`member ${p} holds ${w}, expected ${expected} (paid-out rounds: ${[...m.paidOut].join(',') || 'none'})`);
  }
  if (f.transfers > m.paidOut.size) fail(`${f.transfers} payouts for ${m.paidOut.size} paid-out rounds`);
  const out = f.wallets.reduce((a, b) => a + b, 0n);
  if (f.clearing !== out + f.pot) fail(`money in ${f.clearing} ≠ money out ${out} + pot ${f.pot}`);
  if (f.pot !== m.pot) fail(`pot ${f.pot}, model ${m.pot}`);
  if (f.clearing !== m.moneyIn) fail(`money in ${f.clearing}, model ${m.moneyIn}`);
  const v = await h.svc.view(circleId);
  if (v.currentRound !== m.current) fail(`current round ${v.currentRound}, model ${m.current}`);
}

describe('Property 1: circle conservation', () => {
  it('pot ≥ 0, one payout per member and round, money in = out + pot, and the model agrees', async () => {
    await fc.assert(
      fc.asyncProperty(circleSpec, commands(40), async (spec, cmds) => {
        const circleId = await h.svc.createCircle({ name: 'Property 1', members: spec.names, contribution: spec.contribution });
        const m = new CircleModel(spec.names.length, spec.contribution);
        for (const [i, cmd] of cmds.entries()) {
          await step(h, circleId, m, cmd);
          await checkConservation(circleId, m, `command ${i} ${JSON.stringify(cmd)}`);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
