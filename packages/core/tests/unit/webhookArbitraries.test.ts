import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { verifyWebhook } from '../../src/webhooks/verify.js';
import { fakeClock } from '../helpers/clock.js';
import { fakeSender } from '../helpers/sender.js';
import {
  KNOWN_TYPES,
  MAX_EVENT_ID_LENGTH,
  RUN_TAG_LENGTH,
  WEBHOOK_RUNS,
  deliveryOrderArb,
  materialize,
  signedDelivery,
  validRailHistoryArb,
} from '../helpers/webhooks.js';

const SECRET = 'arbitraries-test-secret-0123456789abcdef';
const codePoints = (s: string) => Array.from(s).length;
const KNOWN: ReadonlySet<string> = new Set(KNOWN_TYPES);

describe('webhook arbitraries', () => {
  it('every generated history is a Valid_Rail_History (D1)', () => {
    fc.assert(
      fc.property(validRailHistoryArb(), (h) => {
        expect(h.payments.length).toBeGreaterThanOrEqual(1);
        expect(h.payments.length).toBeLessThanOrEqual(4);
        h.payments.forEach((p, i) => {
          const evs = h.events.filter((e) => e.payment === i);
          const captures = evs.filter((e) => e.type === 'payment.captured');
          const refunds = evs.filter((e) => e.type === 'payment.refunded');
          expect(captures.length).toBeLessThanOrEqual(1);
          const captured = captures[0]?.amount ?? 0n;
          const refunded = refunds.reduce((s, e) => s + e.amount!, 0n);
          expect(refunded <= captured).toBe(true);
          expect(evs.filter((e) => e.type === 'payment.pending').length).toBeLessThanOrEqual(1);
          for (const e of [...captures, ...refunds]) {
            expect(typeof e.amount).toBe('bigint');
            expect(e.amount! >= 1n && e.amount! <= 9223372036854775807n).toBe(true);
          }
          for (const e of evs.filter((x) => !KNOWN.has(x.type))) expect(e.amount).toBeNull();
        });
        // Natural order: indices are positions, and within a payment pending < captured < refunds.
        h.events.forEach((e, i) => expect(e.index).toBe(i));
        const rank = (t: string) => (t === 'payment.pending' ? 0 : t === 'payment.captured' ? 1 : t === 'payment.refunded' ? 2 : 3);
        h.payments.forEach((_, i) => {
          const ranks = h.events.filter((e) => e.payment === i).map((e) => rank(e.type));
          expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
        });
        // Distinct Unicode templates that stay within 255 code points once tagged, with no U+0000.
        const templates = h.events.map((e) => e.template);
        expect(new Set(templates).size).toBe(templates.length);
        for (const t of templates) {
          expect(codePoints(t)).toBeGreaterThanOrEqual(1);
          expect(codePoints(t)).toBeLessThanOrEqual(MAX_EVENT_ID_LENGTH - RUN_TAG_LENGTH);
          expect(t.includes('\u0000')).toBe(false);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('materialized events have tagged ids of 1-255 code points and amounts as strings', () => {
    fc.assert(
      fc.property(validRailHistoryArb(), (h) => {
        const m = materialize(h, 'USDC');
        expect(new Set(m.events.map((e) => e.eventId)).size).toBe(m.events.length);
        for (const e of m.events) {
          expect(codePoints(e.eventId)).toBeLessThanOrEqual(MAX_EVENT_ID_LENGTH);
          expect(e.eventId.startsWith(m.tag)).toBe(true);
          const json = JSON.parse(e.body) as Record<string, unknown>;
          expect(json['id']).toBe(e.eventId);
          expect(json['paymentId']).toBe(m.paymentIds[h.events[e.index]!.payment]);
          if (e.amount === null) expect(json).not.toHaveProperty('amount');
          else expect(json['amount']).toBe(e.amount.toString());
        }
      }),
      { numRuns: 200 },
    );
  });

  it('every delivery order contains each event at least once and at most twice', () => {
    const arb = validRailHistoryArb().chain((h) => deliveryOrderArb(h).map((order) => ({ h, order })));
    fc.assert(
      fc.property(arb, ({ h, order }) => {
        const n = h.events.length;
        expect(order.length).toBeGreaterThanOrEqual(n);
        expect(order.length).toBeLessThanOrEqual(2 * n);
        for (let i = 0; i < n; i++) {
          const k = order.filter((x) => x === i).length;
          expect(k).toBeGreaterThanOrEqual(1);
          expect(k).toBeLessThanOrEqual(2);
        }
        for (const x of order) expect(x >= 0 && x < n).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('every signed delivery verifies at the clock time', () => {
    fc.assert(
      fc.property(
        validRailHistoryArb({ maxPayments: 2 }),
        fc.integer({ min: 1_500_000_000_000, max: 2_500_000_000_000 }),
        (h, start) => {
          const clock = fakeClock(start);
          for (const e of materialize(h, 'USDC').events) {
            const req = signedDelivery(SECRET, clock, e.body);
            expect(verifyWebhook({ secret: SECRET, rawBody: req.rawBody, headers: req.headers, clock })).toEqual({
              ok: true,
              timestamp: Math.floor(start / 1000),
            });
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('every value in WEBHOOK_RUNS is at least 25', () => {
    expect(Object.keys(WEBHOOK_RUNS).sort()).toEqual(['deliveryOrder', 'outboxDurability', 'staleTimestamp']);
    for (const n of Object.values(WEBHOOK_RUNS)) expect(n).toBeGreaterThanOrEqual(25);
  });
});

describe('fakeClock and fakeSender', () => {
  it('fakeClock only moves on advance', () => {
    const c = fakeClock(1000);
    expect(c.now()).toBe(1000);
    c.advance(250);
    expect(c.now()).toBe(1250);
    expect(() => c.advance(-1)).toThrow(RangeError);
  });

  it('fakeSender follows its script, records every call, then cycles or defaults', async () => {
    const msg = (k: string) => ({
      idempotencyKey: k,
      topic: 't',
      payload: { eventId: 'e', paymentId: 'p', ledgerTransactionId: 'x', asset: 'USDC', amount: '1' },
    });
    let crashes = 0;
    const s = fakeSender(['fail', 'crash-after-send'], { whenExhausted: 'cycle', crash: () => void crashes++ });
    await expect(s.sender(msg('a'))).rejects.toThrow('failure');
    await expect(s.sender(msg('a'))).resolves.toBeUndefined();
    await expect(s.sender(msg('b'))).rejects.toThrow('failure'); // cycled
    expect(crashes).toBe(1);
    expect(s.calls.map((c) => [c.idempotencyKey, c.outcome, c.delivered])).toEqual([
      ['a', 'fail', false],
      ['a', 'crash-after-send', true],
      ['b', 'fail', false],
    ]);
    expect(s.callsFor('a')).toHaveLength(2);

    const d = fakeSender(['fail']);
    await expect(d.sender(msg('a'))).rejects.toThrow();
    await expect(d.sender(msg('a'))).resolves.toBeUndefined(); // defaults to ok
    const c = fakeSender(['crash-after-send']);
    await expect(c.sender(msg('a'))).rejects.toThrow('crash after send'); // default crash throws
  });
});
