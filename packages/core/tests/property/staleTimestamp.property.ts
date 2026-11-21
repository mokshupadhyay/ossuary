// Feature: webhooks-outbox, Property 1: A replayed old timestamp is always rejected
// Validates: Requirements 2.2, 2.6, 1.1, 12.5
import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { createWebhookHandler, type WebhookResponse } from '../../src/webhooks/handler.js';
import { createPropertyDb, runConfig, type PropertyDb } from '../helpers/arbitraries.js';
import { fakeClock } from '../helpers/clock.js';
import {
  WEBHOOK_RUNS,
  materialize,
  signedDelivery,
  signedDeliveryAt,
  validRailHistoryArb,
  type RailHistory,
} from '../helpers/webhooks.js';

/*
 * Mutation checks (Req 12.5), each confirmed to fail this property:
 *   - skip the timestamp check in verifyWebhook;
 *   - widen the tolerance to 300,000 s.
 */

const SECRET = 'stale-timestamp-property-secret-0123456789';
const ASSET = 'USDC';
const T0_MS = 1_800_000_000_000;
const TEN_YEARS_S = 315_360_000;

type BodySpec =
  | { kind: 'event'; history: RailHistory; index: number }
  | { kind: 'string'; body: string }
  | { kind: 'bytes'; body: Uint8Array };

/** A valid event (one event of a rail history), or any string, or any bytes. */
const bodyArb: fc.Arbitrary<BodySpec> = fc.oneof(
  {
    weight: 2,
    arbitrary: validRailHistoryArb({ maxPayments: 2 })
      .filter((h) => h.events.length > 0)
      .chain((history) =>
        fc.nat({ max: history.events.length - 1 }).map((index): BodySpec => ({ kind: 'event', history, index })),
      ),
  },
  { weight: 1, arbitrary: fc.string({ unit: 'binary', maxLength: 300 }).map((body): BodySpec => ({ kind: 'string', body })) },
  { weight: 1, arbitrary: fc.uint8Array({ maxLength: 300 }).map((body): BodySpec => ({ kind: 'bytes', body })) },
);

// Events are materialized inside the property, so every run (and every shrink re-run) gets fresh ids.
const toBody = (s: BodySpec): string | Uint8Array =>
  s.kind === 'event' ? materialize(s.history, ASSET).events[s.index]!.body : s.body;

/** More than 300 s old, weighted toward the boundary, up to about 10 years. */
const ageArb = fc.oneof(
  { weight: 3, arbitrary: fc.integer({ min: 301, max: 400 }) },
  { weight: 1, arbitrary: fc.integer({ min: 401, max: TEN_YEARS_S }) },
);

let pdb: PropertyDb;
let db: Db;
let clearing: string;
let revenue: string;

beforeAll(async () => {
  pdb = await createPropertyDb();
  db = pdb.db;
  clearing = randomUUID();
  revenue = randomUUID();
  await createAccount(db, { accountId: clearing, name: 'Clearing', type: 'asset', allowOverdraft: true });
  await createAccount(db, { accountId: revenue, name: 'Revenue', type: 'revenue' });
});
afterAll(async () => {
  await pdb.handle.close();
});

async function counts(): Promise<Record<string, string>> {
  const r = await db.execute(sql`
    select (select count(*) from webhook_events)::text as webhook_events,
           (select count(*) from payment_states)::text as payment_states,
           (select count(*) from outbox_messages)::text as outbox_messages,
           (select count(*) from transactions)::text as transactions,
           (select count(*) from entries)::text as entries`);
  return r.rows[0] as Record<string, string>;
}

describe('Property 1: a replayed old timestamp is always rejected', () => {
  it('a correctly signed stale delivery is 401 and writes nothing; the same body signed now is not 401', async () => {
    await fc.assert(
      fc.asyncProperty(bodyArb, ageArb, fc.integer({ min: 0, max: 999 }), async (spec, age, msInSecond) => {
        const clock = fakeClock(T0_MS + msInSecond);
        const handler = await createWebhookHandler(db, {
          secret: SECRET,
          asset: ASSET,
          clearingAccountId: clearing,
          revenueAccountId: revenue,
          clock,
        });
        const { kind } = spec;
        const body = toBody(spec);
        const nowS = Math.floor(clock.now() / 1000);

        const before = await counts();
        const stale: WebhookResponse = await handler(signedDeliveryAt(SECRET, nowS - age, body));
        expect(stale).toEqual({ status: 401, body: { ok: false, error: 'unauthorized' } });
        expect(await counts()).toEqual(before);

        // Same body, same secret, fresh timestamp: the rejection above was about age.
        const fresh = await handler(signedDelivery(SECRET, clock, body));
        expect(fresh.status).not.toBe(401);
        if (kind === 'event') expect(fresh.status).toBe(200);
      }),
      runConfig(WEBHOOK_RUNS.staleTimestamp),
    );
  });
});
