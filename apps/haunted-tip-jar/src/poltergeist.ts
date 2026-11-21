/*
 * Summon the Poltergeist (design D9): the same seeded storm against Ossuary
 * and the Vibe Pay twin, live in the page. Each factory makes its own
 * in-memory PGlite, so a storm never touches the jar's ledger. The engine is
 * used unchanged; this module only validates input and runs both sides.
 */
import {
  generateStorm,
  ossuaryFactory,
  summon,
  twinFactory,
  type FaultId,
  type PoltergeistReport,
} from '@ossuary/core/poltergeist';

export const DEFAULT_SEED = 7;
export const DEFAULT_SIZE = 200;
export const MIN_SIZE = 50;
export const MAX_SIZE = 2000;
/** The engine needs at least this many deliveries to include every fault once. */
const ENSURE_EVERY_FAULT_FROM = 21;

export interface Duel {
  seed: number;
  size: number;
  ossuary: PoltergeistReport;
  twin: PoltergeistReport;
}

export type Phase = 'storm' | 'ossuary' | 'twin';

export function checkSeed(text: string): number | string {
  if (!/^\d{1,10}$/.test(text.trim())) return 'Seed must be a whole number from 0 to 4294967295';
  const n = Number(text.trim());
  return n <= 0xffff_ffff ? n : 'Seed must be a whole number from 0 to 4294967295';
}

export function checkSize(text: string, min = MIN_SIZE): number | string {
  if (!/^\d{1,5}$/.test(text.trim())) return `Size must be a whole number from ${min} to ${MAX_SIZE}`;
  const n = Number(text.trim());
  return n >= min && n <= MAX_SIZE ? n : `Size must be a whole number from ${min} to ${MAX_SIZE}`;
}

/** Runs Ossuary first, then the twin, reporting each phase. */
export async function runDuel(seed: number, size: number, onPhase: (p: Phase) => void = () => {}): Promise<Duel> {
  onPhase('storm');
  const storm = generateStorm({ seed, size, ensureEveryFault: size >= ENSURE_EVERY_FAULT_FROM });
  onPhase('ossuary');
  const ossuary = await summon({ storm, factory: ossuaryFactory(), target: 'ossuary' });
  onPhase('twin');
  const twin = await summon({ storm, factory: twinFactory(), target: 'twin' });
  return { seed, size, ossuary, twin };
}

/** Gross money a fault moved the wrong way, in minor units (both are ≥ 0). */
export interface FaultMoney {
  lost: bigint;
  conjured: bigint;
}

/*
 * Lost and conjured per fault, summed ghost by ghost and account by account
 * from `report.drifted`. A fault's net `drift.total` can be zero while its
 * ghosts drifted (a double-tap moves money from the pot to a member), and its
 * per-account sums can cancel across ghosts, so neither is used here. Every
 * drifted ghost has a non-zero account (that is what "drifted" means in the
 * report), so a fault with drifted ghosts always has lost + conjured > 0.
 * These are gross figures: they can add up to more than the meter's net
 * per-account lost and conjured, which are left as the report gives them.
 */
export function moneyByFault(report: PoltergeistReport): Map<FaultId, FaultMoney> {
  const out = new Map<FaultId, FaultMoney>(report.faults.map((f) => [f.id, { lost: 0n, conjured: 0n }]));
  for (const g of report.drifted) {
    const m = out.get(g.faultId) ?? { lost: 0n, conjured: 0n };
    for (const a of g.drift.accounts) {
      const d = BigInt(a.drift);
      if (d > 0n) m.lost += d;
      if (d < 0n) m.conjured -= d;
    }
    out.set(g.faultId, m);
  }
  return out;
}

/** One ghost of the storm as each side handled it, for the replay animation. */
export interface ReplayGhost {
  id: string;
  faultId: FaultId;
  ossuaryDrifted: boolean;
  twinDrifted: boolean;
}

/*
 * The storm's ghosts in storm order (unit ids are zero-padded, so they sort),
 * read from both reports' blocked and drifted lists. Both sides ran the same
 * storm, so the ids match. Used only to pace the animation; every number the
 * panel shows still comes from the reports.
 */
export function replayGhosts(duel: Duel): ReplayGhost[] {
  const twinDrifted = new Set(duel.twin.drifted.map((g) => g.ghostId));
  const ossuaryDrifted = new Set(duel.ossuary.drifted.map((g) => g.ghostId));
  return [...duel.ossuary.blocked, ...duel.ossuary.drifted]
    .map((g) => ({ id: g.ghostId, faultId: g.faultId, ossuaryDrifted: ossuaryDrifted.has(g.ghostId), twinDrifted: twinDrifted.has(g.ghostId) }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
