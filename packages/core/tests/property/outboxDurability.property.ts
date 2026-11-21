// Feature: webhooks-outbox, Property 3: The outbox never loses an event across crashes
// Validates: Requirements 9.9, 6.1, 6.3, 6.6, 8.1, 8.6, 9.6, 9.7, 12.5
import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { runOutboxOnce, type OutboxConfig } from '../../src/outbox/worker.js';
import { outboxMessages, webhookEvents } from '../../src/schema/index.js';
import { createWebhookHandler, type WebhookRequest, type WebhookResponse } from '../../src/webhooks/handler.js';
import { outboxKeyFor } from '../../src/webhooks/keys.js';
import { createPropertyDb, runConfig, type PropertyDb } from '../helpers/arbitraries.js';
import { fakeClock, type FakeClock } from '../helpers/clock.js';
import {
  SimulatedCrash,
  calibrate,
  createCrashingDb,
  type CrashPoint,
  type CrashingDb,
} from '../helpers/crash.js';
import { fakeSender, type SendOutcome } from '../helpers/sender.js';
import {
  WEBHOOK_RUNS,
  deliveryOrderArb,
  materialize,
  signedDelivery,
  validRailHistoryArb,
} from '../helpers/webhooks.js';

/*
 * Mutation checks (Req 12.5), each confirmed to fail this property:
 *   - write the outbox message in a separate transaction after commit;
 *   - mark `sent` before calling the sender;
 *   - skip the lease check in the claim query;
 *   - count the attempt on failure instead of at claim (D2).
 *
 * Crash points
 *   During application (one optional crash per delivery):
 *     before any statement of applyEvent (indices calibrated below), before
 *     commit, after commit. The handler turns the crash into a 500 and the
 *     test redelivers, as the rail would, until it gets a 2xx.
 *   During the worker (a few per case, each assigned to one worker run):
 *     before the claim (statement 0), after the claim commits, after a result
 *     is recorded (before the next statement), and after a send, which the
 *     fake sender's `crash-after-send` outcome injects by arming a crash
 *     before the worker's next statement (the result update).
 *
 * Driving the worker
 *   A "round" advances the clock past every lease and backoff, then runs the
 *   worker once. After a run that crashed, the restarted worker runs once
 *   more at the same instant before the clock moves (a probe). That probe is
 *   what exercises leases: a message claimed by the crashed run is still
 *   leased and must not be claimed again. Rounds are bounded by
 *   `messages × maxAttempts + 1`; probes only follow crashes and are capped
 *   separately so a broken worker fails instead of hanging.
 *
 * `sent` is checked as "the receiver got it at least once" (an `ok` or
 * `crash-after-send` call with its key), which is what `sent` means
 * (Req 9.4); a bare "was called" would pass a worker that marks a failed
 * send as sent.
 */

const SECRET = 'outbox-durability-property-secret-012345678';
const ASSET = 'USDC';
const T0_MS = 1_800_000_000_000;
const MAX_ATTEMPTS = 3;
const LEASE_MS = 60_000;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 8_000;
const ADVANCE_MS = Math.max(LEASE_MS, MAX_DELAY_MS) + 1;
const MAX_REDELIVERIES = 4;

// --- Statement calibration for applyEvent (checked in beforeAll) ---------------
const S = {
  inboxInsert: /^insert into "webhook_events"/,
  inboxUpdate: /^update "webhook_events"/,
  stateInsert: /^insert into "payment_states"/,
  stateLock: /^select .* from "payment_states" .*for update$/,
  stateUpdate: /^update "payment_states"/,
  parkedLock: /^select .* from "webhook_events" .*for update$/,
  savepoint: /^savepoint /,
  release: /^release savepoint /,
  keyClaim: /^insert into "idempotency_records"/,
  keyDone: /^update "idempotency_records"/,
  paymentLock: /^select .* from "transactions" .*for update$/,
  refundSums: /^select .* from "entries" inner join "transactions"/,
  accountLock: /^select .* from "accounts" .*for update$/,
  balances: /^select .* from "entries" where/,
  txInsert: /^insert into "transactions"/,
  entriesInsert: /^insert into "entries"/,
  outboxInsert: /^insert into "outbox_messages"/,
  claimSelect: /^select .* from "outbox_messages" .*for update skip locked$/,
  claimUpdate: /^update "outbox_messages" set "attempts" = \$1, "lease_until" = \$2, "claim_token" = \$3/,
  recordSent: /^update "outbox_messages" set "status" = \$1, "lease_until" = \$2, "sent_at" = \$3/,
} as const;
const PREFIX = [S.inboxInsert, S.stateInsert, S.stateLock];
const POST = [S.accountLock, S.balances, S.txInsert, S.entriesInsert];
const CAPTURE = [
  ...PREFIX, S.savepoint, S.keyClaim, ...POST, S.keyDone, S.release,
  S.stateUpdate, S.inboxUpdate, S.outboxInsert, S.parkedLock,
];
const REFUND_BODY = [
  S.savepoint, S.keyClaim, S.paymentLock, S.refundSums, ...POST, S.keyDone, S.release,
  S.stateUpdate, S.inboxUpdate, S.outboxInsert,
];
const CALIBRATION: Record<string, readonly RegExp[]> = {
  unknown: [S.inboxInsert, S.inboxUpdate],
  pending: [...PREFIX, S.stateUpdate],
  parked: [...PREFIX, S.inboxUpdate],
  duplicate: [S.inboxInsert],
  capture: CAPTURE,
  refund: [...PREFIX, ...REFUND_BODY],
  captureWithParked: [...CAPTURE, ...REFUND_BODY],
};
/** The longest path a generated history can take: a capture with three parked refunds. */
const MAX_APPLY_STATEMENTS = CAPTURE.length + 3 * REFUND_BODY.length;

// --- Arbitraries -----------------------------------------------------------------
type AppCrash = 'none' | CrashPoint;
const appCrashArb: fc.Arbitrary<AppCrash> = fc.oneof(
  { weight: 3, arbitrary: fc.constant<AppCrash>('none') },
  { weight: 3, arbitrary: fc.nat({ max: CAPTURE.length - 1 }).map((index): AppCrash => ({ at: 'statement', index })) },
  {
    weight: 1,
    arbitrary: fc
      .integer({ min: CAPTURE.length, max: MAX_APPLY_STATEMENTS - 1 })
      .map((index): AppCrash => ({ at: 'statement', index })),
  },
  { weight: 1, arbitrary: fc.constant<AppCrash>({ at: 'beforeCommit' }) },
  { weight: 1, arbitrary: fc.constant<AppCrash>({ at: 'afterCommit' }) },
);

type WorkerCrash = 'beforeClaim' | 'afterClaimCommit' | 'afterRecord';
const workerCrashesArb = fc.array(
  fc.record({
    run: fc.nat({ max: 6 }),
    point: fc.constantFrom<WorkerCrash>('beforeClaim', 'afterClaimCommit', 'afterRecord'),
  }),
  { maxLength: 3 },
);

const outcomeArb = fc.oneof(
  { weight: 3, arbitrary: fc.constant<SendOutcome>('ok') },
  { weight: 2, arbitrary: fc.constant<SendOutcome>('fail') },
  { weight: 1, arbitrary: fc.constant<SendOutcome>('crash-after-send') },
);
const senderScriptArb = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      script: fc.array(outcomeArb, { maxLength: 10 }),
      whenExhausted: fc.constantFrom<'ok' | 'cycle'>('ok', 'cycle'),
    }),
  },
  // Receivers that never accept, or that crash the worker on every send (D2).
  { weight: 1, arbitrary: fc.constant({ script: ['fail'] as SendOutcome[], whenExhausted: 'cycle' as const }) },
  {
    weight: 1,
    arbitrary: fc.constant({ script: ['crash-after-send'] as SendOutcome[], whenExhausted: 'cycle' as const }),
  },
);

const caseArb = validRailHistoryArb({ minPayments: 1, maxPayments: 2 }).chain((history) =>
  deliveryOrderArb(history).chain((order) =>
    fc.record({
      history: fc.constant(history),
      order: fc.constant(order),
      appCrashes: fc.array(appCrashArb, { minLength: order.length, maxLength: order.length }),
      sender: senderScriptArb,
      workerCrashes: workerCrashesArb,
    }),
  ),
);

// --- Setup -----------------------------------------------------------------------
let pdb: PropertyDb;
let db: Db;
let crashing: CrashingDb;

async function accounts() {
  const clearing = randomUUID();
  const revenue = randomUUID();
  await createAccount(db, { accountId: clearing, name: 'Clearing', type: 'asset', allowOverdraft: true });
  await createAccount(db, { accountId: revenue, name: 'Revenue', type: 'revenue' });
  return { clearing, revenue };
}

async function handlerOn(clock: FakeClock) {
  const { clearing, revenue } = await accounts();
  return createWebhookHandler(crashing.db, {
    secret: SECRET,
    asset: ASSET,
    clearingAccountId: clearing,
    revenueAccountId: revenue,
    clock,
  });
}

const outboxCount = async (): Promise<number> =>
  Number((await db.execute(sql`select count(*)::int as n from outbox_messages`)).rows[0]!['n']);

beforeAll(async () => {
  pdb = await createPropertyDb();
  db = pdb.db;
  crashing = createCrashingDb(pdb.handle.client);

  // Calibrate every applyEvent path against the expected statements, so the
  // statement-index crash points cover each statement of each path.
  const clock = fakeClock(T0_MS);
  const handler = await handlerOn(clock);
  const p1 = randomUUID();
  const p2 = randomUUID();
  const body = (o: Record<string, unknown>) => JSON.stringify({ id: randomUUID(), asset: ASSET, ...o });
  const send = (b: string) => async () => {
    const res = await handler(signedDelivery(SECRET, clock, b));
    expect(res.status).toBe(200);
  };
  const parked = body({ type: 'payment.refunded', paymentId: p2, amount: '3' });
  await calibrate(crashing, send(body({ type: 'x.unknown', paymentId: p1 })), CALIBRATION['unknown']!);
  await calibrate(crashing, send(body({ type: 'payment.pending', paymentId: p1 })), CALIBRATION['pending']!);
  await calibrate(crashing, send(parked), CALIBRATION['parked']!);
  await calibrate(crashing, send(parked), CALIBRATION['duplicate']!);
  await calibrate(crashing, send(body({ type: 'payment.captured', paymentId: p1, amount: '10' })), CALIBRATION['capture']!);
  await calibrate(crashing, send(body({ type: 'payment.refunded', paymentId: p1, amount: '4' })), CALIBRATION['refund']!);
  await calibrate(
    crashing,
    send(body({ type: 'payment.captured', paymentId: p2, amount: '10' })),
    CALIBRATION['captureWithParked']!,
  );

  // Worker: one claim SELECT, one claim UPDATE per message, then one result
  // UPDATE per message outside the claim transaction. This also drains the
  // calibration messages so the property starts with nothing pending.
  const pending = Number(
    (await db.execute(sql`select count(*)::int as n from outbox_messages where status = 'pending'`)).rows[0]!['n'],
  );
  expect(pending).toBe(4);
  await calibrate(
    crashing,
    () => runOutboxOnce(crashing.db, { sender: async () => {}, clock }),
    [S.claimSelect, ...Array(pending).fill(S.claimUpdate), ...Array(pending).fill(S.recordSent)],
  );
});
afterAll(async () => {
  await pdb.handle.close();
});

// --- The property ------------------------------------------------------------------
describe('Property 3: the outbox never loses an event across crashes', () => {
  it('every committed ledger change ends with exactly one message, sent or visibly dead', async () => {
    await fc.assert(
      fc.asyncProperty(caseArb, async ({ history, order, appCrashes, sender: script, workerCrashes }) => {
        const clock = fakeClock(T0_MS);
        const handler = await handlerOn(clock);
        const m = materialize(history, ASSET);
        const eventIds = m.events.map((e) => e.eventId);
        let lastCount = await outboxCount();
        const neverDecreases = async (where: string) => {
          const n = await outboxCount();
          expect(n, `outbox row count decreased ${where}`).toBeGreaterThanOrEqual(lastCount);
          lastCount = n;
        };

        // 1. Deliver, with a crash at the chosen point, redelivering every non-2xx.
        for (const [k, i] of order.entries()) {
          const req: WebhookRequest = signedDelivery(SECRET, clock, m.events[i]!.body);
          const crash = appCrashes[k]!;
          if (crash !== 'none') crashing.arm(crash);
          let res: WebhookResponse = await handler(req);
          crashing.disarm(); // a statement index past this path's end never fires
          for (let tries = 0; res.status !== 200 && tries < MAX_REDELIVERIES; tries++) res = await handler(req);
          expect(res.status, `delivery ${k} (event ${i}) after redelivery`).toBe(200);
          await neverDecreases(`after delivery ${k}`);
        }

        // Every capture and refund of a valid history commits a ledger change exactly once.
        const inbox = await db.select().from(webhookEvents).where(inArray(webhookEvents.eventId, eventIds));
        const changed = new Set(inbox.filter((r) => r.ledgerTransactionId !== null).map((r) => r.eventId));
        expect([...changed].sort()).toEqual(
          m.events
            .filter((e) => e.type === 'payment.captured' || e.type === 'payment.refunded')
            .map((e) => e.eventId)
            .sort(),
        );

        // 2. Drive the worker until none of this case's messages is pending.
        const ours = () => db.select().from(outboxMessages).where(inArray(outboxMessages.eventId, eventIds));
        const messages = (await ours()).length;
        const roundLimit = messages * MAX_ATTEMPTS + 1;
        const fake = fakeSender(script.script, { whenExhausted: script.whenExhausted, crash: () => crashing.armNext() });
        const cfg: OutboxConfig = {
          sender: fake.sender,
          clock,
          batchSize: 50,
          leaseMs: LEASE_MS,
          baseDelayMs: BASE_DELAY_MS,
          maxDelayMs: MAX_DELAY_MS,
          maxAttempts: MAX_ATTEMPTS,
        };
        const interrupted = new Set<string>();
        let rounds = 0;
        let probes = 0;
        let crashedLastRun = false;

        for (let run = 0; ; run++) {
          const before = await ours();
          if (!before.some((r) => r.status === 'pending')) break;
          if (crashedLastRun) {
            probes++;
            expect(probes, 'worker probes after crashes').toBeLessThanOrEqual(roundLimit + workerCrashes.length + 1);
          } else {
            clock.advance(ADVANCE_MS);
            rounds++;
            expect(rounds, `worker did not drain within ${roundLimit} rounds`).toBeLessThanOrEqual(roundLimit);
          }

          const planned = workerCrashes.find((c) => c.run === run)?.point;
          if (planned === 'beforeClaim') crashing.arm({ at: 'statement', index: 0 });
          if (planned === 'afterClaimCommit') crashing.arm({ at: 'afterCommit' });
          if (planned === 'afterRecord') {
            // Before the first statement after the first result update (results are recorded outside a transaction).
            let recorded = false;
            crashing.arm({
              at: 'when',
              test: (_q, _i, inTx) => {
                if (recorded) return true;
                if (!inTx) recorded = true;
                return false;
              },
            });
          }

          const now = clock.now();
          crashedLastRun = await runOutboxOnce(crashing.db, cfg).then(
            () => false,
            (e: unknown) => {
              if (e instanceof SimulatedCrash) return true;
              throw e;
            },
          );
          crashing.disarm();

          const after = await ours();
          const prev = new Map(before.map((r) => [r.id, r]));
          for (const r of after) {
            const p = prev.get(r.id)!;
            if (r.attempts > p.attempts) {
              // Claimed in this run: it must have been due, pending and not leased (Req 9.1, 9.2).
              expect(p.status, `claimed a ${p.status} message`).toBe('pending');
              expect(p.nextAttemptAt.getTime(), 'claimed before its next attempt time').toBeLessThanOrEqual(now);
              expect(
                p.leaseUntil === null || p.leaseUntil.getTime() <= now,
                `claimed message ${r.idempotencyKey} while its lease ran until ${p.leaseUntil?.toISOString()}`,
              ).toBe(true);
            }
            // Claimed but no result recorded: an attempt interrupted by a crash.
            if (r.status === 'pending' && r.leaseUntil !== null) interrupted.add(r.idempotencyKey);
          }
          await neverDecreases(`after worker run ${run}`);
        }

        // 3. Final state.
        const final = await ours();
        expect(final.length, 'messages appeared or vanished after delivery').toBe(messages);
        const byEvent = new Map<string, typeof final>();
        for (const r of final) byEvent.set(r.eventId, [...(byEvent.get(r.eventId) ?? []), r]);
        for (const e of m.events) {
          const rows = byEvent.get(e.eventId) ?? [];
          if (!changed.has(e.eventId)) {
            expect(rows, `outbox message for ${e.type} without a ledger change`).toHaveLength(0);
            continue;
          }
          expect(rows, `outbox messages for committed ${e.type}`).toHaveLength(1);
          const msg = rows[0]!;
          expect(msg.topic).toBe(e.type);
          expect(msg.idempotencyKey).toBe(outboxKeyFor(e.eventId, e.type));

          const calls = fake.callsFor(msg.idempotencyKey);
          expect(calls.length, 'sender calls exceed attempts counted at claim').toBeLessThanOrEqual(msg.attempts);
          if (msg.status === 'sent') {
            expect(calls.some((c) => c.delivered), `sent message ${msg.idempotencyKey} was never delivered`).toBe(true);
          } else {
            expect(msg.status).toBe('dead');
            expect(msg.attempts).toBe(MAX_ATTEMPTS);
            expect(calls.length).toBeLessThanOrEqual(MAX_ATTEMPTS);
            if (!interrupted.has(msg.idempotencyKey)) expect(calls.length).toBe(MAX_ATTEMPTS);
          }
        }
      }),
      runConfig(WEBHOOK_RUNS.outboxDurability),
    );
  });
});
