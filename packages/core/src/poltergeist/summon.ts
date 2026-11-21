import { fakeClock, type FakeClock } from './clock.js';
import {
  addEffect,
  emptyTruth,
  isZero,
  measureDrift,
  subtractDrift,
  type Drift,
  type DriftDelta,
  type Truth,
} from './drift.js';
import type { DefenseId } from './faults.js';
import { materialize, newRunTag, type Concrete } from './materialize.js';
import { signedDeliveryAt } from './rail.js';
import { buildReport, type CounterexampleRecord, type PoltergeistReport, type Target, type UnitRecord } from './report.js';
import type { MemberRef, PlannedDelivery, Storm, Unit } from './storm.js';
import type { SutFactory, SystemUnderTest } from './sut.js';

/*
 * The storm runner (Requirements 3 and 6). It plays the rail (signing,
 * re-signing on retry, replaying old requests) and the app client (payouts
 * with idempotency keys, double-taps), runs units one at a time, and
 * attributes every change in drift to the unit during which it happened.
 * Browser-safe (design D8).
 */

/** 2026-10-31T00:00:00Z, where every run's virtual clock starts. */
export const STORM_EPOCH_MS = Date.UTC(2026, 9, 31);
/** Attempts per delivery, the first included (Requirement 3.6). */
export const MAX_ATTEMPTS = 5;

export class PoltergeistRunError extends Error {
  constructor(
    readonly seed: number,
    readonly unitIndex: number,
    cause: unknown,
  ) {
    super(
      `poltergeist run failed: seed ${seed}, unit index ${unitIndex}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = 'PoltergeistRunError';
  }
}

export interface SummonOptions {
  storm: Storm;
  factory: SutFactory;
  target: Target;
  /** Default: 32 random bytes from the Web Crypto global, as hex. Never reported. */
  secret?: string;
  /** Default: a fresh random run tag. Never reported. */
  runTag?: string;
}

interface Sent {
  rawBody: string;
  headers: Record<string, string>;
}

interface RunResult {
  records: UnitRecord[];
  /** Cumulative drift after each unit. */
  after: Drift[];
  final: Drift;
  settle: DriftDelta;
  fractional: { account: string; value: string }[];
  events: { attempts: number; retries: number; crashes: number };
}

function randomSecret(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function webhookBody(c: Concrete, storm: Storm, d: Extract<PlannedDelivery, { route: 'webhook' }>): string {
  const e = d.event;
  const body: Record<string, string> = {
    id: c.eventId(e.eventId),
    type: e.type,
    paymentId: c.paymentId(e.paymentId),
    circleId: c.circleId,
    memberId: c.memberIds[e.member],
    asset: storm.asset,
  };
  if (e.amount !== null) body['amount'] = e.amount.toString();
  return JSON.stringify(body);
}

async function runUnits(
  storm: Storm,
  units: readonly Unit[],
  factory: SutFactory,
  secret: string,
  runTag: string,
): Promise<RunResult> {
  const c = materialize(runTag);
  const clock: FakeClock = fakeClock(STORM_EPOCH_MS);
  let unitIndex = 0;
  const fail = (e: unknown): never => {
    throw e instanceof PoltergeistRunError ? e : new PoltergeistRunError(storm.seed, unitIndex, e);
  };

  let sut: SystemUnderTest;
  try {
    sut = await factory({
      circleId: c.circleId,
      memberIds: storm.members.map((m) => c.memberIds[m]),
      asset: storm.asset,
      clock,
      secret,
      runTag,
    });
  } catch (e) {
    return fail(e);
  }

  const events = { attempts: 0, retries: 0, crashes: 0 };
  let fractional: { account: string; value: string }[] = [];

  const measure = async (truth: Truth): Promise<Drift> => {
    const snap = await sut.balances();
    if (snap.asset !== storm.asset) {
      throw new Error(`SUT reported asset ${snap.asset}, storm asset is ${storm.asset}`);
    }
    const members = new Map<MemberRef | 'unknown', bigint>();
    for (const [id, v] of snap.members) {
      const ref = c.memberRef(id);
      members.set(ref, (members.get(ref) ?? 0n) + v);
    }
    fractional = (snap.fractional ?? []).map((f) => {
      const ref = f.memberId === null ? null : c.memberRef(f.memberId);
      return { account: ref === null ? 'pot' : `member:${ref}`, value: f.value };
    });
    return measureDrift(truth, { asset: snap.asset, pot: snap.pot, members });
  };

  try {
    const records: UnitRecord[] = [];
    const after: Drift[] = [];
    let truth = emptyTruth(storm.asset);
    let last = await measure(truth);

    for (const [i, unit] of units.entries()) {
      unitIndex = i;
      const defenses: DefenseId[] = [];
      const sent = new Map<string, Sent>();

      // Callers advance the clock by 1 s before every attempt (Requirement 3.3).
      const attempt = async (rawBody: string, headers: Record<string, string>, route: PlannedDelivery['route'], crash?: PlannedDelivery['crash']) => {
        events.attempts += 1;
        const r = await sut.deliver(rawBody, headers, crash ? { route, crash } : { route });
        if (r.crashed) events.crashes += 1;
        if (r.defense !== null) defenses.push(r.defense);
        return r;
      };

      const send = async (d: PlannedDelivery): Promise<void> => {
        for (let n = 1; n <= MAX_ATTEMPTS; n++) {
          if (n > 1) events.retries += 1;
          clock.advance(1000);
          let rawBody: string;
          let headers: Record<string, string>;
          if (d.route === 'webhook') {
            rawBody = webhookBody(c, storm, d);
            // Signed at the second this attempt is sent, as a real rail re-signs every retry.
            const signed = signedDeliveryAt(secret, Math.floor(clock.now() / 1000), rawBody);
            headers = { 'content-type': 'application/json', ...(signed.headers as Record<string, string>) };
          } else {
            rawBody = JSON.stringify({ circleId: c.circleId, memberId: c.memberIds[d.payout.member], amount: d.payout.amount.toString() });
            headers = { 'content-type': 'application/json', 'idempotency-key': c.key(d.payout.key) };
          }
          if (n === 1) sent.set(d.deliveryId, { rawBody, headers });
          const r = await attempt(rawBody, headers, d.route, n === 1 ? d.crash : undefined);
          if (r.status !== null && r.status < 500) return;
        }
        // Gave up: the truth still counts the movement, so any shortfall shows as drift.
      };

      for (const step of unit.steps) {
        switch (step.kind) {
          case 'advance':
            clock.advance(step.seconds * 1000);
            break;
          case 'deliver':
            await send(step.delivery);
            break;
          case 'concurrent':
            // Every delivery is started (in storm order) before any is awaited.
            await Promise.all(step.deliveries.map((d) => send(d)));
            break;
          case 'replay': {
            const original = sent.get(step.deliveryId);
            if (!original) throw new Error(`replay of unknown delivery ${step.deliveryId}`);
            clock.advance(1000);
            await attempt(original.rawBody, original.headers, 'webhook'); // never retried
            break;
          }
        }
      }

      truth = addEffect(truth, unit.truth);
      const now = await measure(truth);
      records.push({ unit, delta: subtractDrift(now, last), defenses });
      after.push(now);
      last = now;
    }

    unitIndex = units.length;
    await sut.settle();
    const final = await measure(truth);
    return { records, after, final, settle: subtractDrift(final, last), fractional, events };
  } catch (e) {
    return fail(e);
  } finally {
    await sut.close();
  }
}

/** Runs the storm against a fresh SUT instance and returns the report (Requirement 6). */
export async function summon(options: SummonOptions): Promise<PoltergeistReport> {
  const { storm, factory, target } = options;
  const secret = options.secret ?? randomSecret();
  const main = await runUnits(storm, storm.units, factory, secret, options.runTag ?? newRunTag());

  let counterexample: CounterexampleRecord | null = null;
  const first = main.records.findIndex((r) => !isZero(r.delta));
  if (first >= 0) {
    const unit = main.records[first]!.unit;
    const isolated = await runUnits(storm, [unit], factory, secret, newRunTag());
    if (!isZero(isolated.final)) {
      counterexample = { kind: 'isolated', unit, drift: isolated.final };
    } else {
      const deliveries = storm.units.slice(0, first + 1).reduce((n, u) => n + u.deliveries, 0);
      counterexample = { kind: 'prefix', unit, deliveries, drift: main.after[first]! };
    }
  }

  return buildReport({
    storm,
    target,
    events: main.events,
    units: main.records,
    final: main.final,
    settle: main.settle,
    fractional: main.fractional,
    counterexample,
  });
}
