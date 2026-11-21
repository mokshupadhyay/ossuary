// Feature: haunted-tip-jar, Property 1: Delivery order and duplicates do not change the jar
// Validates: Requirements 4.4, 9.1, 3.6, 6.2
//
// Mutation checks are recorded in tasks.md 3.2.
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, type AppDb, type Db } from '../../src/db';
import { createRail, type RailEvent, type Reason } from '../../src/rail';
import { coffin, tips, type CoffinReport, type TipView } from '../../src/readModel';
import { bareJar, newClock, uuid } from '../helpers';

const RUNS = { numRuns: 30 };

let app: AppDb;
let db: Db;
beforeAll(async () => {
  app = await openDatabase();
  db = app.db;
});
afterAll(async () => {
  await app.close();
});

interface HistoryTip {
  amount: bigint;
  reversals: { amount: bigint; reason: Reason }[];
}

/** 1–4 tips, each with 0–3 reversals whose sum never exceeds the tip (the valid domain, as in webhooks-outbox D1). */
const tipArb: fc.Arbitrary<HistoryTip> = fc
  .record({
    amount: fc.bigInt({ min: 1n, max: 1_000_000_000n }),
    asks: fc.array(
      fc.record({ amount: fc.bigInt({ min: 1n, max: 1_000_000_000n }), reason: fc.constantFrom<Reason>('refund', 'chargeback') }),
      { maxLength: 3 },
    ),
  })
  .map(({ amount, asks }) => {
    const reversals: HistoryTip['reversals'] = [];
    let left = amount;
    for (const a of asks) {
      const take = a.amount > left ? left : a.amount;
      if (take <= 0n) break;
      reversals.push({ amount: take, reason: a.reason });
      left -= take;
    }
    return { amount, reversals };
  });

const historyArb = fc.array(tipArb, { minLength: 1, maxLength: 4 });

/** Records the history on a fresh jar without delivering anything. Returns its events in rail order. */
async function record(history: readonly HistoryTip[]) {
  const ref = await bareJar(db);
  const rail = await createRail(db, ref, { clock: newClock() });
  const events: RailEvent[] = [];
  for (const t of history) {
    const r = await rail.sendTip(uuid(), { viewer: 'V', amount: t.amount, message: '' }, { deliver: false });
    if (!r.ok) throw new Error(`tip: ${r.error}`);
    events.push(...r.events);
    for (const v of t.reversals) {
      const x = await rail.reverse(uuid(), { paymentId: r.paymentId, amount: v.amount, reason: v.reason }, { deliver: false });
      if (!x.ok) throw new Error(`reverse: ${x.error}`);
      events.push(...x.events);
    }
  }
  return { ref, rail, events };
}

/** What the property compares: per tip in send order (not by id), and the coffin without its defense counts. */
function view(t: TipView[], c: CoffinReport) {
  const { defenses: _d, checks: _c, ...numbers } = c;
  return {
    tips: [...t].reverse().map(({ captured, refunded, chargedBack, remaining, status }) => ({ captured, refunded, chargedBack, remaining, status })),
    coffin: numbers,
  };
}

function model(history: readonly HistoryTip[]) {
  const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);
  const per = history.map((t) => {
    const refunded = sum(t.reversals.filter((r) => r.reason === 'refund').map((r) => r.amount));
    const chargedBack = sum(t.reversals.filter((r) => r.reason === 'chargeback').map((r) => r.amount));
    return { captured: t.amount, refunded, chargedBack, remaining: t.amount - refunded - chargedBack };
  });
  const totalIn = sum(per.map((p) => p.captured));
  const refunds = sum(per.map((p) => p.refunded));
  const chargebacks = sum(per.map((p) => p.chargedBack));
  return { per, totalIn, refunds, chargebacks, held: totalIn - refunds - chargebacks };
}

/** Each event 1–3 times, in any order: reversals may come before their capture, pending after it. */
const scheduleArb = (n: number) =>
  fc
    .array(fc.integer({ min: 1, max: 3 }), { minLength: n, maxLength: n })
    .chain((repeats) => {
      const slots = repeats.flatMap((k, i) => Array.from({ length: k }, () => i));
      return fc.shuffledSubarray(slots, { minLength: slots.length, maxLength: slots.length });
    });

describe('Property 1: delivery order and duplicates do not change the jar', () => {
  it('any schedule with duplicates ends where one in-order delivery ends, and both match the model', async () => {
    const arb = historyArb.chain((history) => {
      const n = history.reduce((s, t) => s + 2 + t.reversals.length, 0);
      return scheduleArb(n).map((schedule) => ({ history, schedule }));
    });

    await fc.assert(
      fc.asyncProperty(arb, async ({ history, schedule }) => {
        const shuffled = await record(history);
        const reference = await record(history);
        expect(shuffled.events.length).toBe(Math.max(...schedule) + 1);

        for (const i of schedule) {
          const [d] = await shuffled.rail.deliver(shuffled.events[i]!);
          expect(d!.status, `shuffled delivery of event ${i}`).toBe(200);
        }
        for (const e of reference.events) {
          const [d] = await reference.rail.deliver(e);
          expect(d!.outcome, `reference ${e.eventId}`).toBe('applied');
        }

        const got = view(await tips(db, shuffled.ref), await coffin(db, shuffled.ref));
        const want = view(await tips(db, reference.ref), await coffin(db, reference.ref));
        expect(got).toEqual(want);

        // The reference must also be the model, so a break that hits both sides alike is caught.
        const m = model(history);
        expect(want.tips.map(({ status: _s, ...rest }) => rest)).toEqual(m.per);
        expect(want.coffin).toMatchObject({
          totalIn: m.totalIn,
          refunds: m.refunds,
          chargebacks: m.chargebacks,
          totalOut: m.refunds + m.chargebacks,
          held: m.held,
          clearing: m.held,
          residual: 0n,
          ledgerSum: 0n,
          overCapTipCount: 0,
          balanced: true,
        });
      }),
      RUNS,
    );
  });
});
