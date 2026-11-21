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
