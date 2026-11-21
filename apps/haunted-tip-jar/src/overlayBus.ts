/*
 * Overlay alerts as outbox side effects (design D7).
 *
 * Core's handler writes one outbox message per applied capture or refund, in
 * the same transaction as the ledger change. `drainOutbox` runs core's
 * `runOutboxOnce` with a sender that turns each message into an
 * OverlayMessage and publishes it on the Overlay_Bus: a BroadcastChannel for
 * other tabs, plus in-page listeners for the preview (a BroadcastChannel does
 * not deliver to its own sender).
 *
 * Delivery is at-least-once, so the receiver (`createGhostStore`) keeps the
 * outbox idempotency keys it has seen and ignores repeats.
 *
 * Amounts travel as decimal strings: the channel is a trust boundary (any tab
 * of this origin can post), so the receiver validates every message.
 */
import { sql } from 'drizzle-orm';
import { runOutboxOnce, type Clock, type OutboxMessageToSend } from '@ossuary/core';
import type { Db } from './db';
import type { JarRef, Reason } from './rail';
import { tips } from './readModel';

export const CHANNEL_NAME = 'haunted-tip-jar';
export const OVERLAY_VERSION = 1 as const;

export type OverlayTopic = 'payment.captured' | 'payment.refunded';

export interface OverlayMessage {
  v: typeof OVERLAY_VERSION;
  /** The outbox message's idempotency key: one ghost per key. */
  key: string;
  topic: OverlayTopic;
  jarId: string;
  paymentId: string;
  viewer: string;
  message: string;
  /** This event's amount, minor units as a decimal string. */
  amount: string;
  /** The tip's remaining amount after this event, minor units as a decimal string. */
  remaining: string;
  reason: Reason | null;
}

export type Listener = (m: OverlayMessage) => void;

export interface OverlayBus {
  publish(m: OverlayMessage): void;
  subscribe(fn: Listener): () => void;
  close(): void;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNITS_RE = /^(0|[1-9][0-9]{0,18})$/;

/** Shape check for anything that arrives on the channel. */
export function isOverlayMessage(x: unknown): x is OverlayMessage {
  if (typeof x !== 'object' || x === null) return false;
  const m = x as Record<string, unknown>;
  return (
    m['v'] === OVERLAY_VERSION &&
    typeof m['key'] === 'string' &&
    UUID_RE.test(m['key']) &&
    (m['topic'] === 'payment.captured' || m['topic'] === 'payment.refunded') &&
    typeof m['jarId'] === 'string' &&
    UUID_RE.test(m['jarId']) &&
    typeof m['paymentId'] === 'string' &&
    UUID_RE.test(m['paymentId']) &&
    typeof m['viewer'] === 'string' &&
    m['viewer'].length <= 40 &&
    typeof m['message'] === 'string' &&
    m['message'].length <= 140 &&
    typeof m['amount'] === 'string' &&
    UNITS_RE.test(m['amount']) &&
    typeof m['remaining'] === 'string' &&
    UNITS_RE.test(m['remaining']) &&
    (m['reason'] === null || m['reason'] === 'refund' || m['reason'] === 'chargeback')
  );
}

/** A bus over BroadcastChannel (when the runtime has one) plus in-page listeners. */
export function createOverlayBus(options: { channel?: boolean } = {}): OverlayBus {
  const listeners = new Set<Listener>();
  const useChannel = (options.channel ?? true) && typeof BroadcastChannel !== 'undefined';
  const channel = useChannel ? new BroadcastChannel(CHANNEL_NAME) : null;
  const deliver = (m: OverlayMessage) => {
    for (const fn of [...listeners]) fn(m);
  };
  if (channel) {
    channel.onmessage = (e: MessageEvent) => {
      if (isOverlayMessage(e.data)) deliver(e.data);
    };
  }
  return {
    publish(m) {
      channel?.postMessage(m);
      deliver(m);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    close() {
      listeners.clear();
      channel?.close();
    },
  };
}

// ---------------------------------------------------------------- sender

async function reasonOf(db: Db, eventId: string): Promise<Reason | null> {
  const r = await db.execute(sql`SELECT raw_body::jsonb ->> 'reason' AS reason FROM webhook_events WHERE event_id = ${eventId}`);
  const v = r.rows[0]?.['reason'];
  return v === 'refund' || v === 'chargeback' ? v : null;
}

/**
 * Builds the OverlayMessage for one outbox message, or null if the message is
 * not for this jar. Outbox rows are global to the database, so messages for
 * other (archived) jars are acknowledged without being shown.
 */
export async function toOverlayMessage(db: Db, jar: JarRef, msg: OutboxMessageToSend): Promise<OverlayMessage | null> {
  if (msg.topic !== 'payment.captured' && msg.topic !== 'payment.refunded') return null;
  const [tip] = await tips(db, jar, msg.payload.paymentId);
  if (!tip) return null;
  return {
    v: OVERLAY_VERSION,
    key: msg.idempotencyKey,
    topic: msg.topic,
    jarId: jar.id,
    paymentId: tip.paymentId,
    viewer: tip.viewer,
    message: tip.message,
    amount: msg.payload.amount,
    remaining: tip.remaining.toString(),
    reason: msg.topic === 'payment.refunded' ? await reasonOf(db, msg.payload.eventId) : null,
  };
}

export interface DrainOptions {
  clock: Clock;
  bus: Pick<OverlayBus, 'publish'>;
  /** Test hook: runs before each publish and may throw to simulate a failed send. */
  beforePublish?: (m: OverlayMessage) => void;
  maxRounds?: number;
}

/** Runs the outbox worker until a round claims nothing. Returns the number of messages published. */
export async function drainOutbox(db: Db, jar: JarRef, options: DrainOptions): Promise<number> {
  let published = 0;
  const sender = async (msg: OutboxMessageToSend) => {
    const m = await toOverlayMessage(db, jar, msg);
    if (m === null) return;
    options.beforePublish?.(m);
    options.bus.publish(m);
    published++;
  };
  const rounds = options.maxRounds ?? 20;
  for (let i = 0; i < rounds; i++) {
    const r = await runOutboxOnce(db, { sender, clock: options.clock, batchSize: 100 });
    if (r.claimed === 0) break;
  }
  return published;
}

// ---------------------------------------------------------------- receiver

export interface Ghost {
  paymentId: string;
  viewer: string;
  message: string;
  amount: bigint;
  remaining: bigint;
  /** Fully reversed: the ghost fades. */
  faded: boolean;
  lastReason: Reason | null;
  /** Arrival order, for stable rendering. */
  order: number;
}

export interface GhostStore {
  /** Applies a message; returns false when its key was already seen or it is for another jar. */
  receive(m: OverlayMessage): boolean;
  ghosts(): Ghost[];
  subscribe(fn: () => void): () => void;
}

export function createGhostStore(options: { jarId?: string } = {}): GhostStore {
  const seen = new Set<string>();
  const byPayment = new Map<string, Ghost>();
  const listeners = new Set<() => void>();
  let order = 0;
  let jarId = options.jarId;

  return {
    receive(m) {
      if (!isOverlayMessage(m) || seen.has(m.key)) return false;
      // An overlay follows the jar it first hears from; a reset jar starts a new feed.
      if (jarId !== undefined && m.jarId !== jarId) {
        if (m.topic !== 'payment.captured') return false;
        byPayment.clear();
      }
      jarId = m.jarId;
      seen.add(m.key);
      const remaining = BigInt(m.remaining);
      const existing = byPayment.get(m.paymentId);
      if (m.topic === 'payment.captured') {
        if (!existing) {
          byPayment.set(m.paymentId, {
            paymentId: m.paymentId,
            viewer: m.viewer,
            message: m.message,
            amount: BigInt(m.amount),
            remaining,
            faded: remaining === 0n,
            lastReason: null,
            order: order++,
          });
        }
      } else if (existing) {
        // The latest remaining wins; it only ever goes down.
        existing.remaining = remaining < existing.remaining ? remaining : existing.remaining;
        existing.faded = existing.remaining === 0n;
        existing.lastReason = m.reason;
      } else {
        // A refund whose capture we never saw (overlay opened late): nothing to fade.
        return true;
      }
      for (const fn of [...listeners]) fn();
      return true;
    },
    ghosts() {
      return [...byPayment.values()].sort((a, b) => b.order - a.order);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
