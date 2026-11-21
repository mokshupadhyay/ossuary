// Feature: webhooks-outbox, Property 2: Delivery order and duplicates don't change the outcome
// Validates: Requirements 5.10, 4.3, 5.6, 5.7, 5.9, 8.1, 12.5
import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { balance } from '../../src/ledger/balance.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { outboxMessages, paymentStates, webhookEvents } from '../../src/schema/index.js';
import { createWebhookHandler } from '../../src/webhooks/handler.js';
import { createPropertyDb, globalEntrySum, runConfig, type PropertyDb } from '../helpers/arbitraries.js';
import { fakeClock } from '../helpers/clock.js';
import {
  KNOWN_TYPES,
  WEBHOOK_RUNS,
  deliveryOrderArb,
  materialize,
  signedDelivery,
  validRailHistoryArb,
  type MaterializedHistory,
  type RailHistory,
} from '../helpers/webhooks.js';

/*
 * Mutation checks (Req 12.5), each confirmed to fail this property:
 *   - drop the inbox dedupe (ON CONFLICT DO NOTHING removed, and separately
 *     turned into an upsert that always "claims");
 *   - record a refund on an uncaptured payment as `rejected` instead of `parked`;
 *   - let `pending` overwrite `captured`.
 *
 * Domain (D1): valid rail histories only. Two captures for one payment, or
 * refunds that together exceed the capture, are order-dependent by design and
 * covered by example tests in handler.test.ts.
 */

const SECRET = 'delivery-order-property-secret-0123456789';
const ASSET = 'USDC';
const T0_MS = 1_800_000_000_000;
const KNOWN: ReadonlySet<string> = new Set(KNOWN_TYPES);

let pdb: PropertyDb;
let db: Db;

beforeAll(async () => {
  pdb = await createPropertyDb();
  db = pdb.db;
});
afterAll(async () => {
  await pdb.handle.close();
});

interface Side {
  m: MaterializedHistory;
  clearing: string;
  revenue: string;
  deliver: (index: number) => Promise<number>;
}

async function side(history: RailHistory): Promise<Side> {
  const clearing = randomUUID();
  const revenue = randomUUID();
  await createAccount(db, { accountId: clearing, name: 'Clearing', type: 'asset', allowOverdraft: true });
  await createAccount(db, { accountId: revenue, name: 'Revenue', type: 'revenue' });
  const clock = fakeClock(T0_MS);
  const handler = await createWebhookHandler(db, {
    secret: SECRET,
    asset: ASSET,
    clearingAccountId: clearing,
    revenueAccountId: revenue,
    clock,
  });
  const m = materialize(history, ASSET);
  return {
    m,
    clearing,
    revenue,
    deliver: async (index) => (await handler(signedDelivery(SECRET, clock, m.events[index]!.body))).status,
  };
}

/** Everything the property compares, keyed by event or payment index, not by id. */
async function outcome(s: Side) {
  const ids = s.m.events.map((e) => e.eventId);
  const inbox = ids.length === 0 ? [] : await db.select().from(webhookEvents).where(inArray(webhookEvents.eventId, ids));
  const outbox =
    ids.length === 0 ? [] : await db.select().from(outboxMessages).where(inArray(outboxMessages.eventId, ids));
  const states = await db.select().from(paymentStates).where(inArray(paymentStates.paymentId, s.m.paymentIds));
  const byId = new Map(inbox.map((r) => [r.eventId, r]));
  return {
    clearing: await balance(db, s.clearing),
    revenue: await balance(db, s.revenue),
    paymentStates: s.m.paymentIds.map((p) => states.find((r) => r.paymentId === p)?.status ?? 'none'),
    inbox: s.m.events.map((e) => byId.get(e.eventId)?.status ?? 'missing'),
    ledgerChanged: s.m.events.map((e) => byId.get(e.eventId)?.ledgerTransactionId != null),
    outboxPerEvent: s.m.events.map((e) => outbox.filter((o) => o.eventId === e.eventId).length),
  };
}

describe('Property 2: delivery order and duplicates do not change the outcome', () => {
  it('any permutation with duplicates ends where one in-order delivery of each event ends', async () => {
    const arb = validRailHistoryArb().chain((history) =>
      deliveryOrderArb(history).map((order) => ({ history, order })),
    );
    await fc.assert(
      fc.asyncProperty(arb, async ({ history, order }) => {
        const shuffled = await side(history);
        const reference = await side(history);

        for (const i of order) expect(await shuffled.deliver(i), `shuffled delivery of event ${i}`).toBe(200);
        for (const e of history.events) expect(await reference.deliver(e.index), `reference event ${e.index}`).toBe(200);

        const got = await outcome(shuffled);
        const want = await outcome(reference);
        expect(got).toEqual(want);

        // The reference itself must be the D1 outcome, so a break that hits both sides alike is caught too.
        const captured = history.events
          .filter((e) => e.type === 'payment.captured')
          .reduce((s, e) => s + e.amount!, 0n);
        const refunded = history.events
          .filter((e) => e.type === 'payment.refunded')
          .reduce((s, e) => s + e.amount!, 0n);
        expect(want.clearing).toBe(captured - refunded);
        expect(want.revenue).toBe(refunded - captured);
        expect(want.inbox).toEqual(
          history.events.map((e) => (KNOWN.has(e.type) ? 'applied' : 'ignored')),
        );
        // Exactly one outbox message per ledger-changing event, none for the rest, on each side.
        for (const o of [got, want]) {
          expect(o.outboxPerEvent).toEqual(o.ledgerChanged.map((c) => (c ? 1 : 0)));
          expect(o.ledgerChanged).toEqual(
            history.events.map((e) => e.type === 'payment.captured' || e.type === 'payment.refunded'),
          );
        }
        expect(await globalEntrySum(db)).toBe(0n);
      }),
      runConfig(WEBHOOK_RUNS.deliveryOrder),
    );
  });
});
