import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { outboxMessages } from '../schema/index.js';
import type { Clock } from '../webhooks/verify.js';
import { nextDelayMs } from './backoff.js';
import type { OutboxPayload } from './types.js';

export interface OutboxMessageToSend {
  idempotencyKey: string;
  topic: string;
  payload: OutboxPayload;
}

/** Delivers one message to its receiver. Throws on failure. */
export type Sender = (message: OutboxMessageToSend) => Promise<void>;

export interface OutboxConfig {
  sender: Sender;
  clock: Clock;
  /** Messages claimed per run. Default 50. */
  batchSize?: number;
  /** How long a claim excludes other workers. Default 60_000. */
  leaseMs?: number;
  /** Delay after the first failed attempt. Default 1_000. */
  baseDelayMs?: number;
  /** Cap on the retry delay. Default 3_600_000. */
  maxDelayMs?: number;
  /** Attempts (counted at claim time) before a message is dead. Default 8. */
  maxAttempts?: number;
}

export interface OutboxRunResult {
  /** Messages leased for sending in this run. */
  claimed: number;
  /** Sends that succeeded and were recorded. */
  sent: number;
  /** Sends that failed and were rescheduled. */
  failed: number;
  /** Messages moved to `dead` in this run, at claim time or after a failed send. */
  dead: number;
}

const MAX_ERROR_CHARS = 1000;

function positiveInt(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`outbox config: ${name} must be an integer >= 1`);
  return value;
}

function errorText(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  return text.slice(0, MAX_ERROR_CHARS);
}

interface Claimed {
  id: string;
  idempotencyKey: string;
  topic: string;
  payload: OutboxPayload;
  attempts: number; // the count after this claim
  claimToken: string;
}

/**
 * One pass of the outbox worker: claim due messages, send them, record results.
 *
 * Attempts are counted when a message is claimed (not when a send fails), so an
 * attempt that crashes the worker still uses one. A message found with
 * `attempts >= maxAttempts` at claim time was interrupted on its last attempt
 * and is moved to `dead` without another send.
 *
 * Sends are at-least-once: the same idempotency key is passed on every attempt,
 * and a message whose lease expired is claimed and sent again. Rows are never
 * deleted.
 */
export async function runOutboxOnce(db: Db, config: OutboxConfig): Promise<OutboxRunResult> {
  const batchSize = positiveInt('batchSize', config.batchSize ?? 50);
  const leaseMs = positiveInt('leaseMs', config.leaseMs ?? 60_000);
  const baseDelayMs = positiveInt('baseDelayMs', config.baseDelayMs ?? 1_000);
  const maxDelayMs = positiveInt('maxDelayMs', config.maxDelayMs ?? 3_600_000);
  const maxAttempts = positiveInt('maxAttempts', config.maxAttempts ?? 8);
  const { sender, clock } = config;

  const result: OutboxRunResult = { claimed: 0, sent: 0, failed: 0, dead: 0 };

  // 1. Claim, in a short transaction. SKIP LOCKED lets concurrent workers take
  //    disjoint rows; the lease keeps them exclusive after this commits.
  const claimNow = new Date(clock.now());
  const claimed: Claimed[] = await db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: outboxMessages.id,
        idempotencyKey: outboxMessages.idempotencyKey,
        topic: outboxMessages.topic,
        payload: outboxMessages.payload,
        attempts: outboxMessages.attempts,
      })
      .from(outboxMessages)
      .where(
        and(
          eq(outboxMessages.status, 'pending'),
          lte(outboxMessages.nextAttemptAt, claimNow),
          or(isNull(outboxMessages.leaseUntil), lte(outboxMessages.leaseUntil, claimNow)),
        ),
      )
      .orderBy(asc(outboxMessages.nextAttemptAt), asc(outboxMessages.id))
      .limit(batchSize)
      .for('update', { skipLocked: true });

    const out: Claimed[] = [];
    for (const row of rows) {
      if (row.attempts >= maxAttempts) {
        await tx
          .update(outboxMessages)
          .set({
            status: 'dead',
            leaseUntil: null,
            lastError: sql`coalesce(${outboxMessages.lastError}, 'attempt limit reached without a recorded result')`,
          })
          .where(eq(outboxMessages.id, row.id));
        result.dead++;
        continue;
      }
      const claimToken = randomUUID();
      const attempts = row.attempts + 1;
      await tx
        .update(outboxMessages)
        .set({ attempts, leaseUntil: new Date(claimNow.getTime() + leaseMs), claimToken })
        .where(eq(outboxMessages.id, row.id));
      out.push({
        id: row.id,
        idempotencyKey: row.idempotencyKey,
        topic: row.topic,
        payload: row.payload as OutboxPayload,
        attempts,
        claimToken,
      });
    }
    return out;
  });
  result.claimed = claimed.length;

  // 2-3. Send each message outside any transaction, then record the result.
  //      Every result update is fenced by the claim token: if the lease expired
  //      and another worker took the message over, this update matches no row
  //      and the stale result is dropped.
  for (const msg of claimed) {
    const fence = and(eq(outboxMessages.id, msg.id), eq(outboxMessages.claimToken, msg.claimToken));
    let failure: string | null = null;
    try {
      await sender({ idempotencyKey: msg.idempotencyKey, topic: msg.topic, payload: msg.payload });
    } catch (e) {
      failure = errorText(e);
    }

    const now = clock.now();
    if (failure === null) {
      const done = await db
        .update(outboxMessages)
        .set({ status: 'sent', sentAt: new Date(now), leaseUntil: null })
        .where(fence)
        .returning({ id: outboxMessages.id });
      if (done.length > 0) result.sent++;
    } else if (msg.attempts >= maxAttempts) {
      const done = await db
        .update(outboxMessages)
        .set({ status: 'dead', lastError: failure, leaseUntil: null })
        .where(fence)
        .returning({ id: outboxMessages.id });
      if (done.length > 0) result.dead++;
    } else {
      const done = await db
        .update(outboxMessages)
        .set({
          lastError: failure,
          nextAttemptAt: new Date(now + nextDelayMs(msg.attempts, baseDelayMs, maxDelayMs)),
          leaseUntil: null,
        })
        .where(fence)
        .returning({ id: outboxMessages.id });
      if (done.length > 0) result.failed++;
    }
  }

  return result;
}
