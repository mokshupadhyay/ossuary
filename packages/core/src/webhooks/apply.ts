import { randomUUID } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Db, Tx } from '../db/client.js';
import { claimOrReplay, completeKey } from '../ledger/idempotency.js';
import { hashPayload } from '../ledger/hash.js';
import { postTransaction } from '../ledger/postTransaction.js';
import { refund } from '../ledger/refund.js';
import { RefundCapExceededError } from '../errors/index.js';
import type { OutboxPayload } from '../outbox/types.js';
import { outboxMessages, paymentStates, webhookEvents } from '../schema/index.js';
import { ledgerKeyFor, outboxKeyFor } from './keys.js';
import type { InboxOutcome, WebhookConfig } from './handler.js';
import type { ParsedEvent } from './parse.js';

type PaymentStatus = 'pending' | 'captured' | 'refunded';
const RANK: Record<PaymentStatus, number> = { pending: 0, captured: 1, refunded: 2 };

/** Moves a payment's state forward only. A lower-ranked status never overwrites a higher one. */
export function raisedStatus(current: PaymentStatus | null, next: PaymentStatus): PaymentStatus {
  return current !== null && RANK[current] >= RANK[next] ? current : next;
}

async function setInbox(
  tx: Tx,
  eventId: string,
  status: 'applied' | 'parked' | 'ignored' | 'rejected',
  rejectionReason?: string,
): Promise<void> {
  await tx
    .update(webhookEvents)
    .set({ status, rejectionReason: rejectionReason ?? null })
    .where(eq(webhookEvents.eventId, eventId));
}

/** Claims the event's derived ledger key. Returns a stored response if the change already exists. */
async function claimLedgerKey(sp: Tx, eventId: string) {
  const key = ledgerKeyFor(eventId);
  const claim = await claimOrReplay(sp, key, hashPayload({ op: 'webhook', eventId }));
  return { key, replay: claim.claimed ? null : claim.response };
}

async function enqueue(
  tx: Tx,
  cfg: WebhookConfig,
  topic: 'payment.captured' | 'payment.refunded',
  payload: OutboxPayload,
): Promise<void> {
  await tx.insert(outboxMessages).values({
    id: randomUUID(),
    idempotencyKey: outboxKeyFor(payload.eventId, topic),
    eventId: payload.eventId,
    topic,
    payload,
    nextAttemptAt: new Date(cfg.clock.now()),
  });
}

/**
 * Applies a refund event (fresh or previously parked) against a captured
 * payment. A cap error rolls back only its savepoint and records the event as
 * rejected. Any other error propagates and rolls back the whole event.
 */
async function applyRefund(
  tx: Tx,
  db: Db,
  cfg: WebhookConfig,
  eventId: string,
  paymentId: string,
  amount: bigint,
): Promise<'applied' | 'rejected'> {
  let transactionId: string;
  try {
    transactionId = await tx.transaction(async (sp) => {
      const { key, replay } = await claimLedgerKey(sp, eventId);
      if (replay) return replay.transactionId;
      const response = await refund(db, { idempotencyKey: key, paymentId, amount }, sp);
      await completeKey(sp, key, response);
      return response.transactionId;
    });
  } catch (e) {
    if (e instanceof RefundCapExceededError) {
      await setInbox(tx, eventId, 'rejected', `refund exceeds remaining ${e.remaining}`);
      return 'rejected';
    }
    throw e;
  }

  // 'refunded' is the highest rank, so a successful refund always raises to it.
  await tx
    .update(paymentStates)
    .set({ status: 'refunded', updatedAt: sql`now()` })
    .where(eq(paymentStates.paymentId, paymentId));
  await tx
    .update(webhookEvents)
    .set({
      status: 'applied',
      rejectionReason: null,
      ledgerTransactionId: transactionId,
      appliedAt: new Date(cfg.clock.now()),
    })
    .where(eq(webhookEvents.eventId, eventId));
  await enqueue(tx, cfg, 'payment.refunded', {
    eventId,
    paymentId,
    ledgerTransactionId: transactionId,
    asset: cfg.asset,
    amount: amount.toString(),
  });
  return 'applied';
}

async function applyCapture(
  tx: Tx,
  db: Db,
  cfg: WebhookConfig,
  event: Extract<ParsedEvent, { known: true }>,
  state: { status: PaymentStatus | null; capturedEventId: string | null },
): Promise<InboxOutcome> {
  const { capturedEventId } = state;
  const amount = event.amount as bigint;
  if (capturedEventId !== null) {
    await setInbox(tx, event.id, 'rejected', 'duplicate capture');
    return 'rejected';
  }

  const transactionId = await tx.transaction(async (sp) => {
    const { key, replay } = await claimLedgerKey(sp, event.id);
    if (replay) return replay.transactionId;
    const response = await postTransaction(
      db,
      {
        idempotencyKey: key,
        kind: 'capture',
        paymentId: event.paymentId,
        entries: [
          { accountId: cfg.clearingAccountId, amount },
          { accountId: cfg.revenueAccountId, amount: -amount },
        ],
      },
      sp,
    );
    await completeKey(sp, key, response);
    return response.transactionId;
  });

  await tx
    .update(paymentStates)
    .set({
      capturedEventId: event.id,
      status: raisedStatus(state.status, 'captured'),
      updatedAt: sql`now()`,
    })
    .where(eq(paymentStates.paymentId, event.paymentId));
  await tx
    .update(webhookEvents)
    .set({ ledgerTransactionId: transactionId, appliedAt: new Date(cfg.clock.now()) })
    .where(eq(webhookEvents.eventId, event.id));
  await enqueue(tx, cfg, 'payment.captured', {
    eventId: event.id,
    paymentId: event.paymentId,
    ledgerTransactionId: transactionId,
    asset: event.asset,
    amount: amount.toString(),
  });

  // Apply refunds that arrived before this capture, in arrival order.
  const parked = await tx
    .select({ eventId: webhookEvents.eventId, amount: webhookEvents.amount })
    .from(webhookEvents)
    .where(and(eq(webhookEvents.paymentId, event.paymentId), eq(webhookEvents.status, 'parked')))
    .orderBy(asc(webhookEvents.receivedSeq))
    .for('update');
  for (const p of parked) {
    await applyRefund(tx, db, cfg, p.eventId, event.paymentId, p.amount as bigint);
  }
  return 'applied';
}

/**
 * Applies one verified, parsed rail event inside the caller's transaction.
 * Returns the outcome; the caller commits only if this returns.
 */
export async function applyEvent(
  tx: Tx,
  db: Db,
  cfg: WebhookConfig,
  event: ParsedEvent,
  rawBody: string,
): Promise<InboxOutcome> {
  // 1. Inbox claim. No row back means the event id already exists.
  const claimed = await tx
    .insert(webhookEvents)
    .values({
      eventId: event.id,
      type: event.type,
      paymentId: event.paymentId,
      amount: event.known ? event.amount : null,
      asset: event.asset,
      rawBody,
      status: 'applied',
    })
    .onConflictDoNothing({ target: webhookEvents.eventId })
    .returning({ eventId: webhookEvents.eventId });
  if (claimed.length === 0) return 'duplicate';

  // 2. Unknown types are recorded and otherwise ignored.
  if (!event.known) {
    await setInbox(tx, event.id, 'ignored');
    return 'ignored';
  }

  // 3. Payment lock: create the row if missing, then lock it.
  await tx.insert(paymentStates).values({ paymentId: event.paymentId }).onConflictDoNothing();
  const [state] = await tx
    .select({ status: paymentStates.status, capturedEventId: paymentStates.capturedEventId })
    .from(paymentStates)
    .where(eq(paymentStates.paymentId, event.paymentId))
    .for('update');
  if (!state) throw new Error('payment state row missing after insert');

  // 4. Branch on type.
  switch (event.type) {
    case 'payment.pending': {
      if (state.status === null) {
        await tx
          .update(paymentStates)
          .set({ status: 'pending', updatedAt: sql`now()` })
          .where(eq(paymentStates.paymentId, event.paymentId));
      }
      return 'applied';
    }
    case 'payment.captured':
      return applyCapture(tx, db, cfg, event, state);
    case 'payment.refunded': {
      if (state.capturedEventId === null) {
        await setInbox(tx, event.id, 'parked');
        return 'parked';
      }
      return applyRefund(tx, db, cfg, event.id, event.paymentId, event.amount as bigint);
    }
    default: {
      const unreachable: never = event;
      throw new Error(`unhandled event type: ${String(unreachable)}`);
    }
  }
}
