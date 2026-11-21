// Feature: haunted-tip-jar, Property 2: Reversals never exceed a tip, and the coffin balances
// Validates: Requirements 2.5, 3.3, 3.4, 6.1-6.4, 9.2
//
// Mutation checks are recorded in tasks.md 3.3.
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, type AppDb, type Db } from '../../src/db';
import { createRail, type RailEvent, type Reason } from '../../src/rail';
import { coffin, tips } from '../../src/readModel';
import { bareJar, newClock, uuid } from '../helpers';

const RUNS = { numRuns: 25 };

let app: AppDb;
let db: Db;
beforeAll(async () => {
  app = await openDatabase();
  db = app.db;
});
afterAll(async () => {
  await app.close();
});

type Op =
  | { kind: 'tip'; amount: bigint }
  | { kind: 'double-tap' }
  | { kind: 'reuse-key'; extra: bigint }
  /** `perMille` of the tip's capture, 1–2000: up to twice what the tip received. */
  | { kind: 'reverse'; tip: number; perMille: bigint; reason: Reason }
  | { kind: 'redeliver'; event: number }
  | { kind: 'stale'; event: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('tip' as const), amount: fc.bigInt({ min: 1n, max: 1_000_000_000n }) }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'double-tap' as const }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('reuse-key' as const), extra: fc.bigInt({ min: 1n, max: 1_000_000n }) }) },
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant('reverse' as const),
      tip: fc.nat(),
      perMille: fc.bigInt({ min: 1n, max: 2000n }),
      reason: fc.constantFrom<Reason>('refund', 'chargeback'),
    }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('redeliver' as const), event: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('stale' as const), event: fc.nat() }) },
);

interface ModelTip {
  paymentId: string;
  key: string;
  amount: bigint;
  reversed: bigint;
}

describe('Property 2: reversals never exceed a tip, and the coffin always balances', () => {
  it('after every operation: per-tip cap, residual 0, ledger 0, clearing = in − out, held = model', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 40 }), async (ops) => {
        const ref = await bareJar(db);
        const rail = await createRail(db, ref, { clock: newClock() });
        const model: ModelTip[] = [];
        const sent: RailEvent[] = [];

        for (const [step, op] of ops.entries()) {
          const at = `step ${step} (${op.kind})`;
          switch (op.kind) {
            case 'tip': {
              const key = uuid();
              const r = await rail.sendTip(key, { viewer: 'V', amount: op.amount, message: '' });
              expect(r.ok, at).toBe(true);
              if (!r.ok) return;
              model.push({ paymentId: r.paymentId, key, amount: op.amount, reversed: 0n });
              sent.push(...r.events);
              break;
            }
            case 'double-tap': {
              const last = model.at(-1);
              if (!last) break;
              const r = await rail.sendTip(last.key, { viewer: 'V', amount: last.amount, message: '' });
              expect(r.ok && r.replayed && r.paymentId === last.paymentId, at).toBe(true);
              break;
            }
            case 'reuse-key': {
              const last = model.at(-1);
              if (!last) break;
              const r = await rail.sendTip(last.key, { viewer: 'V', amount: last.amount + op.extra, message: '' });
              expect(r, at).toEqual({ ok: false, status: 409, error: 'key reused with a different request' });
              break;
            }
            case 'reverse': {
              if (model.length === 0) break;
              const tip = model[op.tip % model.length]!;
              const want = (tip.amount * op.perMille) / 1000n;
              const amount = want < 1n ? 1n : want;
              const r = await rail.reverse(uuid(), { paymentId: tip.paymentId, amount, reason: op.reason });
              expect(r.ok, at).toBe(true);
              if (!r.ok) return;
              sent.push(...r.events);
              const fits = tip.reversed + amount <= tip.amount;
              expect(r.outcomes[0]!.outcome, at).toBe(fits ? 'applied' : 'rejected');
              if (fits) tip.reversed += amount;
              break;
            }
            case 'redeliver': {
              if (sent.length === 0) break;
              const [d] = await rail.deliver(sent[op.event % sent.length]!);
              expect(d!.outcome, at).toBe('duplicate');
              break;
            }
            case 'stale': {
              if (sent.length === 0) break;
              const d = await rail.replayStale(sent[op.event % sent.length]!.eventId);
              expect(d?.outcome, at).toBe('unauthorized');
              break;
            }
          }

          // The invariants, after every operation.
          const views = await tips(db, ref);
          for (const v of views) {
            expect(v.refunded + v.chargedBack, `${at}: tip reversed beyond its capture`).toBeLessThanOrEqual(v.captured);
          }
          const c = await coffin(db, ref);
          const accepted = model.reduce((s, t) => s + t.amount, 0n);
          const reversed = model.reduce((s, t) => s + t.reversed, 0n);
          expect(c.residual, `${at}: residual`).toBe(0n);
          expect(c.ledgerSum, `${at}: ledger sum`).toBe(0n);
          expect(c.clearing, `${at}: clearing`).toBe(c.totalIn - c.totalOut);
          expect(c.held, `${at}: held vs model`).toBe(accepted - reversed);
          expect(c.totalOut, `${at}: out vs model`).toBe(reversed);
          expect(c.overCapTipCount, at).toBe(0);
          expect(c.tipCount, `${at}: tip count`).toBe(model.length);
          expect(c.balanced, at).toBe(true);
        }
      }),
      RUNS,
    );
  });
});
