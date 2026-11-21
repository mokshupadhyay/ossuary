import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FAULTS, FAULT_IDS } from '../../src/poltergeist/faults.js';
import {
  ENSURE_EVERY_FAULT_MIN_SIZE,
  MAX_AMOUNT,
  MAX_CRASH_STEP,
  MAX_REPLAY_AGE_S,
  MEMBERS,
  MIN_REPLAY_AGE_S,
  generateStorm,
  isolateUnit,
  prefixStorm,
  stormToJson,
  type PlannedDelivery,
  type RailEvent,
  type Storm,
  type Unit,
} from '../../src/poltergeist/storm.js';

const seedArb = fc.integer({ min: 0, max: 2 ** 32 - 1 });

/** Every planned delivery of a unit in order, with the step it came from. */
type Flat = { d: PlannedDelivery | null; step: Unit['steps'][number]; concurrent: boolean };
function flat(unit: Unit): Flat[] {
  return unit.steps.flatMap((step): Flat[] =>
    step.kind === 'deliver'
      ? [{ d: step.delivery, step, concurrent: false }]
      : step.kind === 'concurrent'
        ? step.deliveries.map((d) => ({ d, step, concurrent: true }))
        : step.kind === 'replay'
          ? [{ d: null, step, concurrent: false }]
          : [],
  );
}

const events = (unit: Unit): RailEvent[] =>
  flat(unit).flatMap(({ d }) => (d && d.route === 'webhook' ? [d.event] : []));

/** Checks Requirement 2.6: valid, self-funded, and truth equals the distinct movements. */
function checkValid(unit: Unit): void {
  const distinct = new Map(events(unit).map((e) => [e.eventId, e]));
  const captures = [...distinct.values()].filter((e) => e.type === 'payment.captured');
  const refunds = [...distinct.values()].filter((e) => e.type === 'payment.refunded');
  expect(captures).toHaveLength(1);
  const c = captures[0]!.amount!;
  const refunded = refunds.reduce((s, e) => s + e.amount!, 0n);
  expect(refunded).toBeLessThanOrEqual(c);
  const payouts = new Map(
    flat(unit).flatMap(({ d }) => (d && d.route === 'payout' ? [[d.payout.key, d.payout] as const] : [])),
  );
  const paid = [...payouts.values()].reduce((s, p) => s + p.amount, 0n);
  expect(refunded + paid).toBeLessThanOrEqual(c);
  for (const e of distinct.values()) {
    expect(e.paymentId).toBe(captures[0]!.paymentId);
    if (e.amount !== null) {
      expect(typeof e.amount).toBe('bigint');
      expect(e.amount >= 1n && e.amount <= MAX_AMOUNT).toBe(true);
    }
  }
  for (const p of payouts.values()) expect(p.amount >= 1n && p.amount <= MAX_AMOUNT).toBe(true);
  const paidOut: Record<string, bigint> = {};
  for (const p of payouts.values()) paidOut[p.member] = (paidOut[p.member] ?? 0n) + p.amount;
  expect(unit.truth).toEqual({ captured: c, refunded, paidOut });
  expect(unit.deliveries).toBe(flat(unit).length);
  expect(unit.deliveries).toBeLessThanOrEqual(4);
}

/** Checks Requirement 2.7 for a ghost. */
function checkShape(unit: Unit): void {
  if (unit.kind !== 'ghost') {
    expect(unit.deliveries).toBe(1);
    expect(events(unit).map((e) => e.type)).toEqual(['payment.captured']);
    return;
  }
  const seq = flat(unit);
  const types = seq.map(({ d }) => (d ? (d.route === 'webhook' ? d.event.type : 'payout') : 'replay'));
  const ids = seq.map(({ d }) => (d ? (d.route === 'webhook' ? d.event.eventId : d.payout.key) : 'replay'));
  const crashes = seq.filter(({ d }) => d?.crash);
  if (unit.faultId !== 'crash-mid-step') expect(crashes).toHaveLength(0);
  const fault = FAULTS.find((f) => f.id === unit.faultId)!;
  expect(unit.deliveries).toBeGreaterThanOrEqual(fault.minDeliveries);
  expect(unit.deliveries).toBeLessThanOrEqual(fault.maxDeliveries);
  switch (unit.faultId) {
    case 'duplicate-delivery': {
      const repeats = ids.filter((id) => id === unit.subject).length;
      expect(repeats).toBeGreaterThanOrEqual(2);
      expect(repeats).toBeLessThanOrEqual(3);
      const first = ids.indexOf(unit.subject);
      expect(ids.slice(first, first + repeats).every((id) => id === unit.subject)).toBe(true);
      break;
    }
    case 'replayed-timestamp': {
      expect(unit.steps.map((s) => s.kind)).toEqual(['deliver', 'advance', 'replay']);
      const adv = unit.steps[1] as { kind: 'advance'; seconds: number };
      expect(adv.seconds).toBeGreaterThanOrEqual(MIN_REPLAY_AGE_S);
      expect(adv.seconds).toBeLessThanOrEqual(MAX_REPLAY_AGE_S);
      const first = unit.steps[0] as { kind: 'deliver'; delivery: PlannedDelivery };
      expect((unit.steps[2] as { deliveryId: string }).deliveryId).toBe(first.delivery.deliveryId);
      break;
    }
    case 'out-of-order': {
      const cap = types.indexOf('payment.captured');
      expect(cap).toBe(0);
      expect(types.indexOf('payment.pending')).toBeGreaterThan(cap);
      types.forEach((t, i) => t === 'payment.refunded' && expect(i).toBeGreaterThan(cap));
      break;
    }
    case 'refund-before-capture': {
      const cap = types.indexOf('payment.captured');
      const refundIdx = types.flatMap((t, i) => (t === 'payment.refunded' ? [i] : []));
      expect(refundIdx.length).toBeGreaterThanOrEqual(1);
      expect(refundIdx.every((i) => i < cap)).toBe(true);
      break;
    }
    case 'double-tap': {
      expect(unit.steps.map((s) => s.kind)).toEqual(['deliver', 'concurrent']);
      const taps = seq.filter((x) => x.concurrent).map((x) => x.d as Extract<PlannedDelivery, { route: 'payout' }>);
      expect(taps.length).toBeGreaterThanOrEqual(2);
      expect(taps.length).toBeLessThanOrEqual(3);
      expect(new Set(taps.map((t) => JSON.stringify(t.payout, (_k, v) => (typeof v === 'bigint' ? `${v}` : v)))).size).toBe(1);
      expect(new Set(taps.map((t) => t.deliveryId)).size).toBe(taps.length);
      break;
    }
    case 'crash-mid-step': {
      expect(crashes).toHaveLength(1);
      expect(crashes[0]!.concurrent).toBe(false);
      expect(crashes[0]!.d!.crash!.beforeStep).toBeGreaterThanOrEqual(0);
      expect(crashes[0]!.d!.crash!.beforeStep).toBeLessThanOrEqual(MAX_CRASH_STEP);
      break;
    }
    case 'refund-races-payout': {
      expect(unit.steps.map((s) => s.kind)).toEqual(['deliver', 'concurrent']);
      const race = unit.steps[1]!;
      if (race.kind !== 'concurrent') throw new Error('expected a concurrent step');
      const [refund, payout] = race.deliveries;
      expect(refund!.route === 'webhook' && refund!.event.type).toBe('payment.refunded');
      expect(payout!.route).toBe('payout');
      const payer = events(unit)[0]!.member;
      expect(payout!.route === 'payout' && payout!.payout.member).not.toBe(payer);
      break;
    }
    case 'late-after-refund': {
      expect(types).toEqual(['payment.captured', 'payment.refunded', 'payment.captured']);
      expect(ids[0]).toBe(ids[2]);
      expect(unit.subject).toBe(ids[0]);
      break;
    }
  }
}

function checkIds(storm: Storm): void {
  const seen = new Map<string, string>(); // id -> unit
  for (const u of storm.units) {
    for (const e of events(u)) {
      expect(e.eventId).toMatch(/^evt_[0-9a-f]{8}$/);
      expect(e.paymentId).toMatch(/^pay_[0-9a-f]{8}$/);
      for (const id of [e.eventId, e.paymentId]) {
        const owner = seen.get(id);
        if (owner !== undefined) expect(owner).toBe(u.unitId);
        seen.set(id, u.unitId);
      }
    }
    for (const { d } of flat(u)) {
      if (d?.route === 'payout') {
        expect(d.payout.key).toMatch(/^key_[0-9a-f]{8}$/);
        const owner = seen.get(d.payout.key);
        if (owner !== undefined) expect(owner).toBe(u.unitId);
        seen.set(d.payout.key, u.unitId);
      }
    }
  }
  expect(new Set(storm.units.map((u) => u.unitId)).size).toBe(storm.units.length);
}

describe('generateStorm', () => {
  it('plans exactly `size` deliveries', () => {
    for (const size of [1, 2, 3, 17, 18, 2000]) {
      const s = generateStorm({ seed: 7, size });
      expect(s.units.reduce((n, u) => n + u.deliveries, 0)).toBe(size);
      expect(s.size).toBe(size);
    }
    expect(generateStorm({ seed: 7 }).size).toBe(2000);
  });

  it('rejects bad seeds, sizes and too-small ensureEveryFault storms before generating', () => {
    for (const seed of [-1, 2 ** 32, 0.5]) expect(() => generateStorm({ seed })).toThrow(/seed/);
    for (const size of [0, 20_001, 1.5]) expect(() => generateStorm({ seed: 1, size })).toThrow(/size/);
    expect(() => generateStorm({ seed: 1, size: 17, ensureEveryFault: true })).toThrow(/at least 18/);
    expect(ENSURE_EVERY_FAULT_MIN_SIZE).toBe(18);
  });

  it('every unit is valid, self-funded, well-shaped, in range, with unique ids', () => {
    fc.assert(
      fc.property(seedArb, fc.integer({ min: 1, max: 400 }), fc.boolean(), (seed, size, every) => {
        const s = generateStorm({ seed, size: every ? Math.max(size, 18) : size, ensureEveryFault: every });
        for (const u of s.units) {
          checkValid(u);
          checkShape(u);
        }
        checkIds(s);
        expect(s.asset).toBe('USDC');
        expect(s.decimals).toBe(6);
        expect(s.members).toEqual(MEMBERS);
        expect(s.generator).toBe(1);
      }),
      { numRuns: 60 },
    );
  });

  it('ensureEveryFault puts one ghost of each fault first, in catalog order', () => {
    fc.assert(
      fc.property(seedArb, fc.integer({ min: 18, max: 120 }), (seed, size) => {
        const s = generateStorm({ seed, size, ensureEveryFault: true });
        expect(s.units.slice(0, 8).map((u) => (u.kind === 'ghost' ? u.faultId : 'honest'))).toEqual(FAULT_IDS);
      }),
      { numRuns: 40 },
    );
    const min = generateStorm({ seed: 3, size: 18, ensureEveryFault: true });
    expect(min.units).toHaveLength(8);
  });

  it('a smaller size replays a prefix of a larger one (Requirement 2.12)', () => {
    fc.assert(
      fc.property(seedArb, fc.integer({ min: 1, max: 300 }), fc.integer({ min: 1, max: 300 }), fc.boolean(), (seed, a, b, every) => {
        const lo = every ? Math.max(32, Math.min(a, b)) : Math.min(a, b);
        const hi = Math.max(lo, a, b) + 1;
        const small = generateStorm({ seed, size: lo, ensureEveryFault: every });
        const large = generateStorm({ seed, size: hi, ensureEveryFault: every });
        let remaining = lo;
        for (let i = 0; i < small.units.length && remaining >= 4; i++) {
          expect(small.units[i]).toEqual(large.units[i]);
          remaining -= small.units[i]!.deliveries;
        }
      }),
      { numRuns: 60 },
    );
  });

  it('is deterministic, and stormToJson has no JSON number for an amount', () => {
    const a = generateStorm({ seed: 99, size: 300 });
    const b = generateStorm({ seed: 99, size: 300 });
    expect(a).toEqual(b);
    expect(stormToJson(a)).toBe(stormToJson(b));
    expect(stormToJson(a)).not.toMatch(/"(amount|captured|refunded|m[0-4])":\d/);
    expect(stormToJson(generateStorm({ seed: 100, size: 300 }))).not.toBe(stormToJson(a));
  });

  it('isolateUnit and prefixStorm keep seed, asset and members, and resize', () => {
    const s = generateStorm({ seed: 5, size: 60 });
    const u = s.units[3]!;
    const iso = isolateUnit(s, u.unitId);
    expect(iso.units).toEqual([u]);
    expect(iso.size).toBe(u.deliveries);
    expect([iso.seed, iso.asset, iso.members]).toEqual([s.seed, s.asset, s.members]);
    const pre = prefixStorm(s, u.unitId);
    expect(pre.units).toEqual(s.units.slice(0, 4));
    expect(pre.size).toBe(s.units.slice(0, 4).reduce((n, x) => n + x.deliveries, 0));
    expect(() => isolateUnit(s, 'u9999')).toThrow(RangeError);
  });

  it('draws every fault and honest units in a default storm', () => {
    const s = generateStorm({ seed: 7 });
    const kinds = new Set(s.units.map((u) => (u.kind === 'ghost' ? u.faultId : 'honest')));
    expect([...kinds].sort()).toEqual([...FAULT_IDS, 'honest'].sort());
  });
});
