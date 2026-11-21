import { FAULTS, faultById, type Fault, type FaultId } from './faults.js';
import { createRng, type Rng } from './rng.js';

/*
 * The seeded storm generator (poltergeist-engine Requirement 2, design D1/D7).
 *
 * A storm is a list of units. Each ghost is one instance of a fault, with its
 * own payments and its own money, so its true effect is known here and any
 * drift it causes can be attributed to it exactly. Honest units (one capture
 * delivered once) fill the storm to its exact size.
 *
 * Everything is drawn from one seeded Rng, in one pass. A draw is never
 * re-rolled, and every unit's cap is 4 while 4 or more deliveries remain, so
 * a smaller size replays a prefix of a larger one.
 */

export const GENERATOR_VERSION = 1 as const;
export const DEFAULT_STORM_SIZE = 2000;
export const MAX_STORM_SIZE = 20_000;
export const STORM_ASSET = 'USDC' as const;
export const STORM_DECIMALS = 6 as const;
export const MEMBERS = ['m0', 'm1', 'm2', 'm3', 'm4'] as const;
export type MemberRef = (typeof MEMBERS)[number];

export const MIN_AMOUNT = 1n;
export const MAX_AMOUNT = 1_000_000_000n;
export const MIN_REPLAY_AGE_S = 301;
export const MAX_REPLAY_AGE_S = 604_800;
export const MAX_CRASH_STEP = 24;
const MAX_UNIT_DELIVERIES = 4;

export type RailEventType = 'payment.pending' | 'payment.captured' | 'payment.refunded';

export interface RailEvent {
  eventId: string;
  type: RailEventType;
  paymentId: string;
  /** The payer. */
  member: MemberRef;
  /** Minor units; null for `payment.pending`. */
  amount: bigint | null;
}

export interface PayoutRequest {
  key: string;
  member: MemberRef;
  amount: bigint;
}

export interface CrashPlan {
  /** Crash before the SUT's step with this 0-based index, or after its response if it has fewer steps. */
  beforeStep: number;
}

export type PlannedDelivery =
  | { deliveryId: string; route: 'webhook'; event: RailEvent; crash?: CrashPlan }
  | { deliveryId: string; route: 'payout'; payout: PayoutRequest; crash?: CrashPlan };

export type Step =
  | { kind: 'deliver'; delivery: PlannedDelivery }
  | { kind: 'concurrent'; deliveries: readonly PlannedDelivery[] }
  | { kind: 'advance'; seconds: number }
  /** Resend that delivery's original bytes and headers. */
  | { kind: 'replay'; deliveryId: string };

export interface TruthEffect {
  captured: bigint;
  refunded: bigint;
  paidOut: Partial<Record<MemberRef, bigint>>;
}

interface UnitBase {
  unitId: string;
  /** Planned deliveries in this unit (replays included, retries excluded). */
  deliveries: number;
  steps: readonly Step[];
  truth: TruthEffect;
}
export interface Ghost extends UnitBase {
  kind: 'ghost';
  faultId: FaultId;
  /** The logical id the epitaph names. */
  subject: string;
}
export interface HonestUnit extends UnitBase {
  kind: 'honest';
}
export type Unit = Ghost | HonestUnit;

export interface Storm {
  generator: typeof GENERATOR_VERSION;
  seed: number;
  size: number;
  ensureEveryFault: boolean;
  asset: typeof STORM_ASSET;
  decimals: typeof STORM_DECIMALS;
  members: readonly MemberRef[];
  units: readonly Unit[];
}

export interface StormOptions {
  seed: number;
  size?: number;
  ensureEveryFault?: boolean;
}

export const ENSURE_EVERY_FAULT_MIN_SIZE = FAULTS.reduce((s, f) => s + f.minDeliveries, 0);

class Builder {
  private readonly used = new Set<string>();
  private deliveryCount = 0;
  private unitCount = 0;

  constructor(readonly rng: Rng) {}

  id(prefix: 'evt_' | 'pay_' | 'key_'): string {
    for (;;) {
      const id = `${prefix}${this.rng.hex8()}`;
      if (!this.used.has(id)) {
        this.used.add(id);
        return id;
      }
    }
  }

  nextUnitId(): string {
    this.unitCount += 1;
    return `u${String(this.unitCount).padStart(4, '0')}`;
  }

  nextDeliveryId(): string {
    this.deliveryCount += 1;
    return `d${String(this.deliveryCount).padStart(5, '0')}`;
  }

  member(): MemberRef {
    return this.rng.pick(MEMBERS);
  }

  otherMember(than: MemberRef): MemberRef {
    return this.rng.pick(MEMBERS.filter((m) => m !== than));
  }

  capture(): bigint {
    return this.rng.bigint(2n, MAX_AMOUNT);
  }

  event(type: RailEventType, paymentId: string, member: MemberRef, amount: bigint | null): RailEvent {
    return { eventId: this.id('evt_'), type, paymentId, member, amount };
  }

  webhook(event: RailEvent, crash?: CrashPlan): PlannedDelivery {
    return crash
      ? { deliveryId: this.nextDeliveryId(), route: 'webhook', event, crash }
      : { deliveryId: this.nextDeliveryId(), route: 'webhook', event };
  }

  payout(payout: PayoutRequest, crash?: CrashPlan): PlannedDelivery {
    return crash
      ? { deliveryId: this.nextDeliveryId(), route: 'payout', payout, crash }
      : { deliveryId: this.nextDeliveryId(), route: 'payout', payout };
  }
}

const deliver = (delivery: PlannedDelivery): Step => ({ kind: 'deliver', delivery });

function countDeliveries(steps: readonly Step[]): number {
  return steps.reduce(
    (n, s) => n + (s.kind === 'deliver' || s.kind === 'replay' ? 1 : s.kind === 'concurrent' ? s.deliveries.length : 0),
    0,
  );
}

const truth = (captured: bigint, refunded: bigint, paidOut: Partial<Record<MemberRef, bigint>> = {}): TruthEffect => ({
  captured,
  refunded,
  paidOut,
});

function ghost(b: Builder, faultId: FaultId, subject: string, steps: Step[], effect: TruthEffect): Ghost {
  return { unitId: b.nextUnitId(), deliveries: countDeliveries(steps), steps, truth: effect, kind: 'ghost', faultId, subject };
}

function honest(b: Builder): HonestUnit {
  const pay = b.id('pay_');
  const payer = b.member();
  const c = b.capture();
  const steps = [deliver(b.webhook(b.event('payment.captured', pay, payer, c)))];
  return { unitId: b.nextUnitId(), deliveries: 1, steps, truth: truth(c, 0n), kind: 'honest' };
}

/** Builds a ghost of `fault` with at most `cap` planned deliveries (`cap >= fault.minDeliveries`). */
function buildGhost(b: Builder, fault: Fault, cap: number): Ghost {
  const { rng } = b;
  const pay = b.id('pay_');
  const payer = b.member();
  const c = b.capture();
  const captured = b.event('payment.captured', pay, payer, c);

  switch (fault.id) {
    case 'duplicate-delivery': {
      const repeatRefund = rng.int(0, 1) === 1 && cap >= 3;
      if (repeatRefund) {
        const k = rng.int(2, Math.min(3, cap - 1));
        const refund = b.event('payment.refunded', pay, payer, rng.bigint(1n, c));
        const steps = [deliver(b.webhook(captured))];
        for (let i = 0; i < k; i++) steps.push(deliver(b.webhook(refund)));
        return ghost(b, fault.id, refund.eventId, steps, truth(c, refund.amount!));
      }
      const k = rng.int(2, Math.min(3, cap));
      const withRefund = cap >= k + 1 && rng.int(0, 1) === 1;
      const steps: Step[] = [];
      for (let i = 0; i < k; i++) steps.push(deliver(b.webhook(captured)));
      let refunded = 0n;
      if (withRefund) {
        const refund = b.event('payment.refunded', pay, payer, rng.bigint(1n, c));
        steps.push(deliver(b.webhook(refund)));
        refunded = refund.amount!;
      }
      return ghost(b, fault.id, captured.eventId, steps, truth(c, refunded));
    }
    case 'replayed-timestamp': {
      const age = rng.int(MIN_REPLAY_AGE_S, MAX_REPLAY_AGE_S);
      const first = b.webhook(captured);
      const steps: Step[] = [deliver(first), { kind: 'advance', seconds: age }, { kind: 'replay', deliveryId: first.deliveryId }];
      return ghost(b, fault.id, captured.eventId, steps, truth(c, 0n));
    }
    case 'out-of-order': {
      const pending = b.event('payment.pending', pay, payer, null);
      const withRefund = cap >= 3 && rng.int(0, 1) === 1;
      if (!withRefund) {
        return ghost(b, fault.id, pay, [deliver(b.webhook(captured)), deliver(b.webhook(pending))], truth(c, 0n));
      }
      const refund = b.event('payment.refunded', pay, payer, rng.bigint(1n, c));
      const refundFirst = rng.int(0, 1) === 1;
      const steps = [deliver(b.webhook(captured))];
      if (refundFirst) steps.push(deliver(b.webhook(refund)), deliver(b.webhook(pending)));
      else steps.push(deliver(b.webhook(pending)), deliver(b.webhook(refund)));
      return ghost(b, fault.id, pay, steps, truth(c, refund.amount!));
    }
    case 'refund-before-capture': {
      const two = cap >= 3 && rng.int(0, 1) === 1;
      const r1 = two ? rng.bigint(1n, c - 1n) : rng.bigint(1n, c);
      const refunds = [b.event('payment.refunded', pay, payer, r1)];
      if (two) refunds.push(b.event('payment.refunded', pay, payer, rng.bigint(1n, c - r1)));
      const steps = [...refunds.map((r) => deliver(b.webhook(r))), deliver(b.webhook(captured))];
      const refunded = refunds.reduce((s, r) => s + r.amount!, 0n);
      return ghost(b, fault.id, refunds[0]!.eventId, steps, truth(c, refunded));
    }
    case 'double-tap': {
      const k = rng.int(2, Math.min(3, cap - 1));
      const to = b.member();
      const request: PayoutRequest = { key: b.id('key_'), member: to, amount: rng.bigint(1n, c) };
      const taps = Array.from({ length: k }, () => b.payout(request));
      const steps: Step[] = [deliver(b.webhook(captured)), { kind: 'concurrent', deliveries: taps }];
      return ghost(b, fault.id, request.key, steps, truth(c, 0n, { [to]: request.amount }));
    }
    case 'crash-mid-step': {
      const variant = cap >= 2 ? rng.int(0, 2) : 0;
      const crash: CrashPlan = { beforeStep: rng.int(0, MAX_CRASH_STEP) };
      if (variant === 0) {
        return ghost(b, fault.id, captured.eventId, [deliver(b.webhook(captured, crash))], truth(c, 0n));
      }
      if (variant === 1) {
        const refund = b.event('payment.refunded', pay, payer, rng.bigint(1n, c));
        const steps = [deliver(b.webhook(captured)), deliver(b.webhook(refund, crash))];
        return ghost(b, fault.id, refund.eventId, steps, truth(c, refund.amount!));
      }
      const to = b.member();
      const request: PayoutRequest = { key: b.id('key_'), member: to, amount: rng.bigint(1n, c) };
      const steps = [deliver(b.webhook(captured)), deliver(b.payout(request, crash))];
      return ghost(b, fault.id, request.key, steps, truth(c, 0n, { [to]: request.amount }));
    }
    case 'refund-races-payout': {
      const r = rng.bigint(1n, c - 1n);
      const to = b.otherMember(payer);
      const request: PayoutRequest = { key: b.id('key_'), member: to, amount: rng.bigint(1n, c - r) };
      const refund = b.event('payment.refunded', pay, payer, r);
      const steps: Step[] = [
        deliver(b.webhook(captured)),
        { kind: 'concurrent', deliveries: [b.webhook(refund), b.payout(request)] },
      ];
      return ghost(b, fault.id, refund.eventId, steps, truth(c, r, { [to]: request.amount }));
    }
    case 'late-after-refund': {
      const refund = b.event('payment.refunded', pay, payer, rng.bigint(1n, c));
      const steps = [deliver(b.webhook(captured)), deliver(b.webhook(refund)), deliver(b.webhook(captured))];
      return ghost(b, fault.id, captured.eventId, steps, truth(c, refund.amount!));
    }
  }
}

/** Generates the storm for a seed and size. Pure and deterministic (Requirement 2.1, 2.2). */
export function generateStorm(options: StormOptions): Storm {
  const { seed } = options;
  const size = options.size ?? DEFAULT_STORM_SIZE;
  const ensureEveryFault = options.ensureEveryFault ?? false;
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new RangeError('seed must be an integer from 0 to 4294967295');
  }
  if (!Number.isInteger(size) || size < 1 || size > MAX_STORM_SIZE) {
    throw new RangeError(`size must be an integer from 1 to ${MAX_STORM_SIZE}`);
  }
  if (ensureEveryFault && size < ENSURE_EVERY_FAULT_MIN_SIZE) {
    throw new RangeError(`size must be at least ${ENSURE_EVERY_FAULT_MIN_SIZE} with ensureEveryFault`);
  }

  const b = new Builder(createRng(seed));
  const units: Unit[] = [];
  let remaining = size;
  const push = (u: Unit) => {
    units.push(u);
    remaining -= u.deliveries;
  };

  if (ensureEveryFault) {
    FAULTS.forEach((fault, i) => {
      const reserved = FAULTS.slice(i + 1).reduce((s, f) => s + f.minDeliveries, 0);
      push(buildGhost(b, fault, Math.min(fault.maxDeliveries, remaining - reserved)));
    });
  }

  const choices: { weight: number; value: Fault | null }[] = [
    ...FAULTS.map((f) => ({ weight: 1, value: f })),
    { weight: 1, value: null },
  ];
  while (remaining > 0) {
    const choice = b.rng.weighted(choices);
    const cap = Math.min(MAX_UNIT_DELIVERIES, remaining);
    push(choice === null || choice.minDeliveries > cap ? honest(b) : buildGhost(b, choice, cap));
  }

  return {
    generator: GENERATOR_VERSION,
    seed,
    size,
    ensureEveryFault,
    asset: STORM_ASSET,
    decimals: STORM_DECIMALS,
    members: MEMBERS,
    units,
  };
}

/** JSON with bigints as decimal strings. Key order follows construction order, which is fixed. */
export function stormToJson(storm: Storm): string {
  return JSON.stringify(storm, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
}

/** Serializes one unit the same way (used in counterexamples). */
export function unitToJsonValue(unit: Unit): unknown {
  return JSON.parse(JSON.stringify(unit, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)));
}

function withUnits(storm: Storm, units: readonly Unit[]): Storm {
  return { ...storm, size: units.reduce((n, u) => n + u.deliveries, 0), units };
}

function indexOfUnit(storm: Storm, unitId: string): number {
  const i = storm.units.findIndex((u) => u.unitId === unitId);
  if (i < 0) throw new RangeError(`no unit ${unitId} in storm`);
  return i;
}

/** A one-unit storm with the same seed, asset and members. */
export function isolateUnit(storm: Storm, unitId: string): Storm {
  return withUnits(storm, [storm.units[indexOfUnit(storm, unitId)]!]);
}

/** The storm cut after `unitId`. */
export function prefixStorm(storm: Storm, unitId: string): Storm {
  return withUnits(storm, storm.units.slice(0, indexOfUnit(storm, unitId) + 1));
}

export const faultOf = (unit: Unit): Fault | null => (unit.kind === 'ghost' ? faultById(unit.faultId) : null);
