import type { Drift, DriftDelta } from './drift.js';
import { addDrift, isZero, ZERO_DELTA } from './drift.js';
import { FAULTS, faultById, renderEpitaph, type DefenseId, type FaultId } from './faults.js';
import { MEMBERS, unitToJsonValue, type Storm, type Unit } from './storm.js';

/*
 * The poltergeist report (Requirement 8). JSON-safe and versioned: every
 * amount is a decimal string, keys appear in declaration order, and nothing
 * depends on time, run tags, secrets or concrete ids, so the same storm and
 * target always serialize to the same bytes. Bump REPORT_VERSION on any
 * change to this shape and regenerate tests/fixtures/report-*.json.
 */

export const REPORT_SCHEMA = 'ossuary/poltergeist-report' as const;
export const REPORT_VERSION = 1 as const;

export type Target = 'ossuary' | 'twin';

export interface DriftJson {
  total: string;
  accounts: { account: string; drift: string }[];
}

export interface FaultSummary {
  id: FaultId;
  name: string;
  ghosts: number;
  deliveries: number;
  blocked: number;
  drifted: number;
  drift: DriftJson;
}

export interface BlockedGhost {
  ghostId: string;
  faultId: FaultId;
  subject: string;
  epitaph: string;
}

export interface DriftedGhost {
  ghostId: string;
  faultId: FaultId;
  subject: string;
  drift: DriftJson;
}

export type CounterexampleJson =
  | { kind: 'isolated'; unitId: string; faultId: FaultId | null; unit: unknown; drift: DriftJson }
  | {
      kind: 'prefix';
      unitId: string;
      faultId: FaultId | null;
      seed: number;
      size: number;
      ensureEveryFault: boolean;
      deliveries: number;
      drift: DriftJson;
    };

export interface PoltergeistReport {
  schema: typeof REPORT_SCHEMA;
  version: typeof REPORT_VERSION;
  generator: number;
  seed: number;
  size: number;
  ensureEveryFault: boolean;
  target: Target;
  asset: string;
  decimals: number;
  events: { planned: number; attempts: number; retries: number; crashes: number };
  faults: FaultSummary[];
  honest: { units: number; deliveries: number; drift: DriftJson };
  drift: DriftJson & { conjured: string; lost: string; doubleCreditedMembers: number };
  settleDrift: DriftJson;
  fractionalBalances: { account: string; value: string }[];
  blocked: BlockedGhost[];
  drifted: DriftedGhost[];
  counterexample: CounterexampleJson | null;
}

/** What the runner observed for one unit. */
export interface UnitRecord {
  unit: Unit;
  delta: DriftDelta;
  /** Defenses the SUT reported during the unit, in order (duplicates allowed). */
  defenses: readonly DefenseId[];
}

export type CounterexampleRecord =
  | { kind: 'isolated'; unit: Unit; drift: DriftDelta }
  | { kind: 'prefix'; unit: Unit; deliveries: number; drift: DriftDelta };

/** Everything `summon` collects; `buildReport` turns it into the stable JSON shape. */
export interface RunRecord {
  storm: Storm;
  target: Target;
  events: { attempts: number; retries: number; crashes: number };
  units: readonly UnitRecord[];
  final: Drift;
  settle: DriftDelta;
  fractional: readonly { account: string; value: string }[];
  counterexample: CounterexampleRecord | null;
}

const BASE_ACCOUNTS = ['pot', ...MEMBERS.map((m) => `member:${m}`)];

/** Canonical account order: pot, m0 … m4 (always present), then any others (member:unknown). */
export function driftJson(d: DriftDelta): DriftJson {
  const by = new Map(d.accounts.map((a) => [a.account, a.drift]));
  const extra = d.accounts.map((a) => a.account).filter((a) => !BASE_ACCOUNTS.includes(a)).sort();
  return {
    total: d.total.toString(),
    accounts: [...BASE_ACCOUNTS, ...extra].map((account) => ({ account, drift: (by.get(account) ?? 0n).toString() })),
  };
}

const sumDeltas = (ds: readonly DriftDelta[]): DriftDelta => ds.reduce(addDrift, ZERO_DELTA);

export function buildReport(run: RunRecord): PoltergeistReport {
  const { storm } = run;
  const ghosts = run.units.filter((r): r is UnitRecord & { unit: Extract<Unit, { kind: 'ghost' }> } => r.unit.kind === 'ghost');
  const honest = run.units.filter((r) => r.unit.kind === 'honest');

  const faults: FaultSummary[] = FAULTS.map((f) => {
    const mine = ghosts.filter((g) => g.unit.faultId === f.id);
    const blocked = mine.filter((g) => isZero(g.delta)).length;
    return {
      id: f.id,
      name: f.name,
      ghosts: mine.length,
      deliveries: mine.reduce((n, g) => n + g.unit.deliveries, 0),
      blocked,
      drifted: mine.length - blocked,
      drift: driftJson(sumDeltas(mine.map((g) => g.delta))),
    };
  });

  const blocked: BlockedGhost[] = [];
  const drifted: DriftedGhost[] = [];
  for (const g of ghosts) {
    const { unitId: ghostId, faultId, subject } = g.unit;
    if (isZero(g.delta)) {
      blocked.push({ ghostId, faultId, subject, epitaph: renderEpitaph(faultById(faultId), subject, g.defenses) });
    } else {
      drifted.push({ ghostId, faultId, subject, drift: driftJson(g.delta) });
    }
  }

  const cx = run.counterexample;
  const faultIdOf = (u: Unit): FaultId | null => (u.kind === 'ghost' ? u.faultId : null);
  const counterexample: CounterexampleJson | null =
    cx === null
      ? null
      : cx.kind === 'isolated'
        ? { kind: 'isolated', unitId: cx.unit.unitId, faultId: faultIdOf(cx.unit), unit: unitToJsonValue(cx.unit), drift: driftJson(cx.drift) }
        : {
            kind: 'prefix',
            unitId: cx.unit.unitId,
            faultId: faultIdOf(cx.unit),
            seed: storm.seed,
            size: storm.size,
            ensureEveryFault: storm.ensureEveryFault,
            deliveries: cx.deliveries,
            drift: driftJson(cx.drift),
          };

  const planned = storm.units.reduce((n, u) => n + u.deliveries, 0);
  return {
    schema: REPORT_SCHEMA,
    version: REPORT_VERSION,
    generator: storm.generator,
    seed: storm.seed,
    size: storm.size,
    ensureEveryFault: storm.ensureEveryFault,
    target: run.target,
    asset: storm.asset,
    decimals: storm.decimals,
    events: { planned, attempts: run.events.attempts, retries: run.events.retries, crashes: run.events.crashes },
    faults,
    honest: {
      units: honest.length,
      deliveries: honest.reduce((n, h) => n + h.unit.deliveries, 0),
      drift: driftJson(sumDeltas(honest.map((h) => h.delta))),
    },
    drift: {
      ...driftJson(run.final),
      conjured: run.final.conjured.toString(),
      lost: run.final.lost.toString(),
      doubleCreditedMembers: run.final.doubleCreditedMembers,
    },
    settleDrift: driftJson(run.settle),
    fractionalBalances: run.fractional.map((f) => ({ account: f.account, value: f.value })),
    blocked,
    drifted,
    counterexample,
  };
}

/** The report as JSON. Byte-identical for identical reports. */
export function serializeReport(report: PoltergeistReport): string {
  return JSON.stringify(report);
}
