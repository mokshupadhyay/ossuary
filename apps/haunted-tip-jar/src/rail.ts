/*
 * The simulated payment rail (design D3, D4). It plays the outside world:
 * it records each Rail_Request under the client's Idempotency_Key, builds
 * the event bodies, signs them in core's scheme with `signWebhook`, and hands
 * them to core's `createWebhookHandler`. It never writes ledger entries.
 *
 * Idempotency (steering idempotency.md): the key is claimed with
 * INSERT ... ON CONFLICT DO NOTHING in the same transaction as the tip row.
 * Same key + same request → the stored response and the same event bytes are
 * redelivered. Same key + different request → 409, nothing is delivered.
 */
import { sql } from 'drizzle-orm';
import { createWebhookHandler, signWebhook, type Clock, type WebhookResponse } from '@ossuary/core';
import type { Db } from './db';
import { ASSET, MAX_AMOUNT } from './money';

export type Reason = 'refund' | 'chargeback';
export type RequestKind = 'tip' | Reason;
export type EventType = 'payment.pending' | 'payment.captured' | 'payment.refunded';
export type DeliveryMode = 'normal' | 'retry' | 'duplicate' | 'late' | 'replay' | 'stale';
export type Outcome =
  | 'applied'
  | 'duplicate'
  | 'parked'
  | 'rejected'
  | 'ignored'
  | 'unauthorized'
  | 'invalid'
  | 'error';

/** One event as the rail stores it: `body` is the exact bytes that are signed and sent. */
export interface RailEvent {
  eventId: string;
  type: EventType;
  body: string;
}

export interface DeliveryOutcome {
  eventId: string;
  type: EventType;
  mode: DeliveryMode;
  attempt: number;
  status: number | null;
  outcome: Outcome;
}

export type RailResult =
  | { ok: true; paymentId: string; replayed: boolean; events: RailEvent[]; outcomes: DeliveryOutcome[] }
  | { ok: false; status: 409; error: 'key reused with a different request' }
  | { ok: false; status: 400; error: string };

export interface JarRef {
  id: string;
  jarAccountId: string;
  clearingAccountId: string;
  railSecret: string;
}

export interface TipRequest {
  viewer: string;
  amount: bigint;
  message: string;
}

export interface ReversalRequest {
  paymentId: string;
  amount: bigint;
  reason: Reason;
}

export interface SendOptions {
  /** Default true. False records the request and returns its events without delivering (tests). */
  deliver?: boolean;
}

/** Attempts per delivery, the first included (Requirement 4.2). */
export const MAX_ATTEMPTS = 3;
/** One second past core's 5-minute tolerance. */
export const STALE_AGE_S = 301;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ---------------------------------------------------------------- event bodies

/** Event ids are derived from the request key, so a retried request can never mint a new event. */
export const tipEventIds = (key: string) => ({ pending: `tip_${key}_pending`, captured: `tip_${key}_captured` });
export const reversalEventId = (key: string, reason: Reason) => `${reason}_${key}`;

/** Body field order is fixed, so the same request always gives the same bytes. */
export function tipEvents(key: string, paymentId: string, amount: bigint): RailEvent[] {
  const ids = tipEventIds(key);
  return [
    {
      eventId: ids.pending,
      type: 'payment.pending',
      body: JSON.stringify({ id: ids.pending, type: 'payment.pending', paymentId, asset: ASSET }),
    },
    {
      eventId: ids.captured,
      type: 'payment.captured',
      body: JSON.stringify({ id: ids.captured, type: 'payment.captured', paymentId, asset: ASSET, amount: amount.toString() }),
    },
  ];
}

export function reversalEvent(key: string, paymentId: string, amount: bigint, reason: Reason): RailEvent {
  const id = reversalEventId(key, reason);
  return {
    eventId: id,
    type: 'payment.refunded',
    body: JSON.stringify({ id, type: 'payment.refunded', paymentId, asset: ASSET, amount: amount.toString(), reason }),
  };
}

/** Sorted keys, amounts as decimal strings: the request's identity for the 409 check. */
export function canonicalRequest(kind: RequestKind, fields: Record<string, string>): string {
  const all: Record<string, string> = { ...fields, kind };
  return JSON.stringify(Object.fromEntries(Object.keys(all).sort().map((k) => [k, all[k]!])));
}

// ---------------------------------------------------------------- validation

const bad = (error: string): RailResult => ({ ok: false, status: 400, error });

function checkKey(key: unknown): string | null {
  return typeof key === 'string' && UUID_RE.test(key) ? null : 'idempotency key must be a lowercase UUID';
}

function checkAmount(amount: unknown): string | null {
  if (typeof amount !== 'bigint') return 'amount must be a bigint';
  if (amount < 1n) return 'amount must be at least 1 unit';
  if (amount > MAX_AMOUNT) return 'amount must be at most 1,000,000 USDC';
  return null;
}

const length = (s: string) => [...s].length;

function checkTip(req: TipRequest): string | null {
  if (typeof req?.viewer !== 'string' || req.viewer.trim() === '' || length(req.viewer) > 40) {
    return 'viewer must be 1-40 characters';
  }
  if (typeof req.message !== 'string' || length(req.message) > 140) return 'message must be at most 140 characters';
  if (req.viewer.includes('\u0000') || req.message.includes('\u0000')) return 'text must not contain NUL characters';
  return checkAmount(req.amount);
}

// ---------------------------------------------------------------- the rail

type Handler = (r: { rawBody: string; headers: Record<string, string> }) => Promise<WebhookResponse>;

export interface Rail {
  sendTip(key: string, req: TipRequest, options?: SendOptions): Promise<RailResult>;
  reverse(key: string, req: ReversalRequest, options?: SendOptions): Promise<RailResult>;
  /** Delivers one stored event in the given mode, signed now (retries apply to normal mode). */
  deliver(event: RailEvent, mode?: DeliveryMode): Promise<DeliveryOutcome[]>;
  /** Re-sends a stored event signed 301 s in the past. Core must answer 401. */
  replayStale(eventId: string): Promise<DeliveryOutcome | null>;
  /** Every event the rail has recorded for this jar, oldest request first. */
  events(): Promise<RailEvent[]>;
  setHaunted(on: boolean): void;
  readonly haunted: boolean;
}

export interface RailOptions {
  clock: Clock;
  haunted?: boolean;
  /** Test hook: wraps the core handler, e.g. to inject a 5xx. */
  wrapHandler?: (h: Handler) => Handler;
}

function outcomeOf(res: WebhookResponse): Outcome {
  if (res.status === 200) return res.body.outcome ?? 'applied';
  if (res.status === 401) return 'unauthorized';
  if (res.status === 400) return 'invalid';
  return 'error';
}

export async function createRail(db: Db, jar: JarRef, options: RailOptions): Promise<Rail> {
  const { clock } = options;
  const core = await createWebhookHandler(db, {
    secret: jar.railSecret,
    asset: ASSET,
    clearingAccountId: jar.clearingAccountId,
    revenueAccountId: jar.jarAccountId,
    clock,
  });
  const handler: Handler = options.wrapHandler ? options.wrapHandler(core) : core;
  let haunted = options.haunted ?? false;

  /** Signed copies of each event's first attempt, for exact-bytes replays. */
  const firstSent = new Map<string, { rawBody: string; headers: Record<string, string> }>();

  const sign = (body: string, timestampS: number): Record<string, string> => ({
    'content-type': 'application/json',
    'ossuary-timestamp': String(timestampS),
    'ossuary-signature': signWebhook(jar.railSecret, timestampS, body),
  });

  async function attempt(
    event: RailEvent,
    mode: DeliveryMode,
    n: number,
    request: { rawBody: string; headers: Record<string, string> },
  ): Promise<DeliveryOutcome> {
    let status: number | null = null;
    let outcome: Outcome;
    try {
      const res = await handler(request);
      status = res.status;
      outcome = outcomeOf(res);
    } catch {
      outcome = 'error';
    }
    await db.execute(sql`
      INSERT INTO tipjar_deliveries (jar_id, event_id, type, attempt, mode, status, outcome)
      VALUES (${jar.id}, ${event.eventId}, ${event.type}, ${n}, ${mode}, ${status}, ${outcome})`);
    return { eventId: event.eventId, type: event.type, mode, attempt: n, status, outcome };
  }

  /** Up to MAX_ATTEMPTS while the handler answers 5xx or throws; each attempt re-signed at the current second. */
  async function send(event: RailEvent, mode: DeliveryMode): Promise<DeliveryOutcome[]> {
    const out: DeliveryOutcome[] = [];
    for (let n = 1; n <= MAX_ATTEMPTS; n++) {
      const request = { rawBody: event.body, headers: sign(event.body, Math.floor(clock.now() / 1000)) };
      if (!firstSent.has(event.eventId)) firstSent.set(event.eventId, request);
      const r = await attempt(event, n === 1 ? mode : 'retry', n, request);
      out.push(r);
      if (r.outcome !== 'error') break;
    }
    return out;
  }

  async function replay(event: RailEvent): Promise<DeliveryOutcome[]> {
    const original = firstSent.get(event.eventId);
    if (!original) return [];
    return [await attempt(event, 'replay', 1, original)];
  }

  /** Normal delivery, plus the haunting when it is on (Requirement 4.1). */
  async function deliverAll(events: readonly RailEvent[]): Promise<DeliveryOutcome[]> {
    const out: DeliveryOutcome[] = [];
    for (const e of events) {
      out.push(...(await send(e, 'normal')));
      if (!haunted) continue;
      out.push(...(await send(e, 'duplicate')));
      if (e.type === 'payment.captured') {
        const pending = events.find((p) => p.type === 'payment.pending');
        if (pending) out.push(...(await send(pending, 'late')));
      }
      out.push(...(await replay(e)));
    }
    return out;
  }

  type Claim =
    | { kind: 'new'; paymentId: string; events: RailEvent[] }
    | { kind: 'existing'; paymentId: string; events: RailEvent[] }
    | { kind: 'conflict' };

  async function readExisting(key: string, request: string): Promise<Claim> {
    const r = await db.execute(sql`SELECT request, payment_id, events FROM tipjar_rail_requests WHERE key = ${key} AND jar_id = ${jar.id}`);
    const row = r.rows[0];
    if (!row || row['request'] !== request) return { kind: 'conflict' };
    return { kind: 'existing', paymentId: String(row['payment_id']), events: row['events'] as RailEvent[] };
  }

  async function finish(claim: Claim, deliver: boolean): Promise<RailResult> {
    if (claim.kind === 'conflict') return { ok: false, status: 409, error: 'key reused with a different request' };
    const outcomes = deliver ? await deliverAll(claim.events) : [];
    return { ok: true, paymentId: claim.paymentId, replayed: claim.kind === 'existing', events: claim.events, outcomes };
  }

  return {
    get haunted() {
      return haunted;
    },
    setHaunted(on) {
      haunted = on;
    },

    async sendTip(key, req, opts = {}) {
      const invalid = checkKey(key) ?? checkTip(req);
      if (invalid) return bad(invalid);
      const viewer = req.viewer.trim();
      const request = canonicalRequest('tip', { viewer, message: req.message, amount: req.amount.toString() });

      const claim = await db.transaction(async (tx): Promise<Claim> => {
        const paymentId = globalThis.crypto.randomUUID();
        const events = tipEvents(key, paymentId, req.amount);
        const inserted = await tx.execute(sql`
          INSERT INTO tipjar_rail_requests (key, jar_id, kind, request, payment_id, events)
          VALUES (${key}, ${jar.id}, 'tip', ${request}, ${paymentId}, ${JSON.stringify(events)}::jsonb)
          ON CONFLICT (key) DO NOTHING RETURNING key`);
        if (inserted.rows.length === 0) return { kind: 'conflict' }; // resolved below, outside the tx
        await tx.execute(sql`
          INSERT INTO tipjar_tips (payment_id, jar_id, request_key, viewer, message)
          VALUES (${paymentId}, ${jar.id}, ${key}, ${viewer}, ${req.message})`);
        return { kind: 'new', paymentId, events };
      });
      return finish(claim.kind === 'conflict' ? await readExisting(key, request) : claim, opts.deliver ?? true);
    },

    async reverse(key, req, opts = {}) {
      const invalid =
        checkKey(key) ??
        (typeof req?.paymentId === 'string' && UUID_RE.test(req.paymentId) ? null : 'paymentId must be a UUID') ??
        (req.reason === 'refund' || req.reason === 'chargeback' ? null : 'reason must be refund or chargeback') ??
        checkAmount(req.amount);
      if (invalid) return bad(invalid);
      const request = canonicalRequest(req.reason, { paymentId: req.paymentId, amount: req.amount.toString() });

      const claim = await db.transaction(async (tx): Promise<Claim | 'unknown'> => {
        const tip = await tx.execute(sql`SELECT 1 FROM tipjar_tips WHERE payment_id = ${req.paymentId} AND jar_id = ${jar.id}`);
        if (tip.rows.length === 0) return 'unknown';
        const events = [reversalEvent(key, req.paymentId, req.amount, req.reason)];
        const inserted = await tx.execute(sql`
          INSERT INTO tipjar_rail_requests (key, jar_id, kind, request, payment_id, events)
          VALUES (${key}, ${jar.id}, ${req.reason}, ${request}, ${req.paymentId}, ${JSON.stringify(events)}::jsonb)
          ON CONFLICT (key) DO NOTHING RETURNING key`);
        if (inserted.rows.length === 0) return { kind: 'conflict' };
        return { kind: 'new', paymentId: req.paymentId, events };
      });
      if (claim === 'unknown') {
        // A key already used for something else still answers 409, not 400.
        return (await keyExists(key)) ? finish({ kind: 'conflict' }, false) : bad('no such tip in this jar');
      }
      return finish(claim.kind === 'conflict' ? await readExisting(key, request) : claim, opts.deliver ?? true);
    },

    deliver(event, mode = 'normal') {
      return mode === 'replay' ? replay(event) : send(event, mode);
    },

    async replayStale(eventId) {
      const event = (await allEvents()).find((e) => e.eventId === eventId);
      if (!event) return null;
      const ts = Math.floor(clock.now() / 1000) - STALE_AGE_S;
      return attempt(event, 'stale', 1, { rawBody: event.body, headers: sign(event.body, ts) });
    },

    events: allEvents,
  };

  async function allEvents(): Promise<RailEvent[]> {
    const r = await db.execute(sql`SELECT events FROM tipjar_rail_requests WHERE jar_id = ${jar.id} ORDER BY seq`);
    return r.rows.flatMap((row) => row['events'] as RailEvent[]);
  }

  async function keyExists(key: string): Promise<boolean> {
    const r = await db.execute(sql`SELECT 1 FROM tipjar_rail_requests WHERE key = ${key}`);
    return r.rows.length > 0;
  }
}
