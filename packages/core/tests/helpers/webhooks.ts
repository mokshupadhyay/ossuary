import { randomUUID } from 'node:crypto';
import fc from 'fast-check';


/*
 * Arbitraries and helpers for the webhooks-outbox properties.
 *
 * A generated history is a *shape*: payments are referred to by index and
 * event ids are templates. `materialize` turns a shape into concrete events
 * with fresh payment ids and run-unique event ids, so every property run (and
 * every shrink re-run) in a shared database touches only its own rows. The
 * run tag is needed because the ledger key is derived from the event id: a
 * reused id would replay an earlier run's ledger change.
 */

/** Run counts for the three properties. Each must be at least 25 (Req 12.2). */
export const WEBHOOK_RUNS = {
  staleTimestamp: 100, // no writes on the rejected path; cheap
  deliveryOrder: 25,
  outboxDurability: 25,
} as const;

export const KNOWN_TYPES = ['payment.pending', 'payment.captured', 'payment.refunded'] as const;
export const UNKNOWN_TYPES = ['payment.disputed', 'payment.mystery', 'charge.updated', 'PAYMENT.CAPTURED'] as const;

/** Every materialized event id is `<tag><template>`; the tag is this many code points. */
export const RUN_TAG_LENGTH = 8;
export const MAX_EVENT_ID_LENGTH = 255;

/**
 * Any Unicode code point except U+0000 and lone surrogates. Postgres `text`
 * cannot hold U+0000, and the handler answers 500 on every delivery of such an
 * id, so it is outside what this generator covers (reported separately).
 */
const codePointArb: fc.Arbitrary<string> = fc
  .integer({ min: 1, max: 0x10ffff })
  .filter((cp) => cp < 0xd800 || cp > 0xdfff)
  .map((cp) => String.fromCodePoint(cp));

/** Event id templates: 1 to 247 code points, so a tagged id is at most 255. */
export const eventIdTemplateArb: fc.Arbitrary<string> = fc.oneof(
  fc.string({ unit: codePointArb, minLength: 1, maxLength: MAX_EVENT_ID_LENGTH - RUN_TAG_LENGTH }),
  fc.string({ unit: 'grapheme-ascii', minLength: 1, maxLength: 24 }),
  fc.constant('x'.repeat(MAX_EVENT_ID_LENGTH - RUN_TAG_LENGTH)), // exactly 255 once tagged
);

/** Mostly small amounts, sometimes above 2^53 (exact bigint round-trips), never above int8. */
const captureAmountArb: fc.Arbitrary<bigint> = fc.oneof(
  { weight: 3, arbitrary: fc.bigInt({ min: 1n, max: 1_000_000n }) },
  { weight: 1, arbitrary: fc.bigInt({ min: 2n ** 53n, max: 2n ** 60n }) },
);

export interface PaymentShape {
  pending: boolean;
  /** At most one capture (D1). */
  capture: bigint | null;
  /** In event order. Empty unless captured; sums to at most `capture` (D1). */
  refunds: bigint[];
  /** Types outside the three known ones. */
  unknown: string[];
}

export interface EventShape {
  /** Index into `RailHistory.events`; the natural order. */
  index: number;
  template: string;
  type: string;
  payment: number;
  amount: bigint | null;
}

export interface RailHistory {
  payments: PaymentShape[];
  /**
   * Every distinct event in natural order: per payment, `pending`, then the
   * capture, then each refund in event order, then unknown types.
   */
  events: EventShape[];
}

const paymentShapeArb: fc.Arbitrary<PaymentShape> = fc
  .record({
    pending: fc.boolean(),
    capture: fc.option(captureAmountArb, { freq: 5 }), // ~1 in 5 has no capture
    unknown: fc.array(fc.constantFrom(...UNKNOWN_TYPES), { maxLength: 1 }),
  })
  .chain(({ pending, capture, unknown }) => {
    if (capture === null) return fc.constant<PaymentShape>({ pending, capture, refunds: [], unknown });
    const one = fc.oneof(
      { weight: 3, arbitrary: fc.bigInt({ min: 1n, max: capture }) },
      { weight: 1, arbitrary: fc.constant(capture) }, // a full refund
    );
    return fc.array(one, { maxLength: 3 }).map((wanted) => {
      // Keep refunds in order while they still fit, so the total never exceeds the capture.
      const refunds: bigint[] = [];
      let left = capture;
      for (const r of wanted) {
        if (r <= left) {
          refunds.push(r);
          left -= r;
        }
      }
      return { pending, capture, refunds, unknown };
    });
  });

/**
 * A Valid_Rail_History (D1) over `minPayments`..`maxPayments` payments (default
 * 1-4). Each payment has an optional `pending`, at most one capture, refunds
 * summing to no more than the capture, and optional unknown-type events.
 * Event id templates are distinct Unicode strings.
 */
export function validRailHistoryArb(
  opts: { minPayments?: number; maxPayments?: number } = {},
): fc.Arbitrary<RailHistory> {
  const minPayments = opts.minPayments ?? 1;
  const maxPayments = opts.maxPayments ?? 4;
  return fc
    .array(paymentShapeArb, { minLength: minPayments, maxLength: maxPayments })
    .chain((payments) => {
      const count = payments.reduce(
        (n, p) => n + (p.pending ? 1 : 0) + (p.capture !== null ? 1 : 0) + p.refunds.length + p.unknown.length,
        0,
      );
      return fc
        .uniqueArray(eventIdTemplateArb, { minLength: count, maxLength: count })
        .map((ids) => {
          const events: EventShape[] = [];
          const push = (payment: number, type: string, amount: bigint | null) =>
            events.push({ index: events.length, template: ids[events.length]!, type, payment, amount });
          payments.forEach((p, i) => {
            if (p.pending) push(i, 'payment.pending', null);
            if (p.capture !== null) push(i, 'payment.captured', p.capture);
            for (const r of p.refunds) push(i, 'payment.refunded', r);
            for (const t of p.unknown) push(i, t, null);
          });
          return { payments, events };
        });
    });
}

/**
 * A delivery sequence for `history`: indices into `history.events`, a
 * permutation of every event with each one delivered once or twice, so
 * deliveries of different payments interleave freely.
 */
export function deliveryOrderArb(history: RailHistory): fc.Arbitrary<number[]> {
  const n = history.events.length;
  return fc.array(fc.boolean(), { minLength: n, maxLength: n }).chain((twice) => {
    const items = history.events.flatMap((e) => (twice[e.index] ? [e.index, e.index] : [e.index]));
    return fc.shuffledSubarray(items, { minLength: items.length, maxLength: items.length });
  });
}

export interface ConcreteEvent {
  index: number;
  eventId: string;
  type: string;
  paymentId: string;
  amount: bigint | null;
  /** The exact JSON body the rail sends; amounts are decimal strings. */
  body: string;
}

export interface MaterializedHistory {
  tag: string;
  paymentIds: string[];
  events: ConcreteEvent[];
}

/** A fresh run tag of exactly `RUN_TAG_LENGTH` code points. */
export const runTag = (): string => `${randomUUID().slice(0, RUN_TAG_LENGTH - 1)}~`;

/** Concrete events with fresh payment ids and run-unique event ids. */
export function materialize(history: RailHistory, asset: string, tag: string = runTag()): MaterializedHistory {
  const paymentIds = history.payments.map(() => randomUUID());
  const events = history.events.map((e): ConcreteEvent => {
    const eventId = `${tag}${e.template}`;
    const paymentId = paymentIds[e.payment]!;
    const body: Record<string, unknown> = { id: eventId, type: e.type, paymentId, asset };
    if (e.amount !== null) body['amount'] = e.amount.toString();
    return { index: e.index, eventId, type: e.type, paymentId, amount: e.amount, body: JSON.stringify(body) };
  });
  return { tag, paymentIds, events };
}

// Moved to src/poltergeist/rail.ts so the poltergeist can use them from src/ (poltergeist-engine D6).
export { signedDelivery, signedDeliveryAt } from '../../src/poltergeist/rail.js';
