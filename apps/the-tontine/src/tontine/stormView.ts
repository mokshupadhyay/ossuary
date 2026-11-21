import type { DriftJson, PoltergeistReport } from '@ossuary/core/poltergeist';
import { formatUsdc } from '../money';

/*
 * View helpers for the poltergeist report. Everything here is derived from
 * fields the report already has; Core is not changed. Amounts stay bigint.
 */

export interface LostAndConjured {
  /** Sum of the positive per-account drifts: money that should be somewhere and is not. */
  lost: bigint;
  /** Sum of the negative per-account drifts, as a positive amount: money that appeared from nowhere. */
  conjured: bigint;
}

/**
 * Splits a drift into lost and conjured from its per-account drifts. A
 * double-tapped payout leaves the pot short by what the member has too much,
 * so its total nets to zero while both of these are non-zero.
 */
export function lostAndConjured(drift: DriftJson): LostAndConjured {
  let lost = 0n;
  let conjured = 0n;
  for (const a of drift.accounts) {
    const d = BigInt(a.drift);
    if (d > 0n) lost += d;
    else conjured -= d;
  }
  return { lost, conjured };
}

/** "lost 1.00 USDC, conjured 1.00 USDC"; "no money moved" when both are zero. */
export function describeDrift({ lost, conjured }: LostAndConjured): string {
  const parts = [lost > 0n ? `lost ${formatUsdc(lost)}` : null, conjured > 0n ? `conjured ${formatUsdc(conjured)}` : null].filter((p) => p !== null);
  return parts.length === 0 ? 'no money moved' : parts.join(', ');
}

export interface ReplayGhost {
  ghostId: string;
  drifted: boolean;
}

/** Every ghost of one side in storm order (ghost ids are zero-padded unit ids, so they sort as text). */
export function ghostsInOrder(report: PoltergeistReport): ReplayGhost[] {
  return [...report.blocked.map((g) => ({ ghostId: g.ghostId, drifted: false })), ...report.drifted.map((g) => ({ ghostId: g.ghostId, drifted: true }))].sort((a, b) =>
    a.ghostId < b.ghostId ? -1 : a.ghostId > b.ghostId ? 1 : 0,
  );
}

/** Whole percent of `part` in `whole`, for a bar width. Bigint division: layout only, never money. */
export function percentOf(part: bigint, whole: bigint): number {
  if (whole <= 0n || part <= 0n) return 0;
  const p = (part * 100n) / whole;
  return Number(p > 100n ? 100n : p);
}

/** The live-region sentence when a storm ends. */
export function finishedText(ossuary: PoltergeistReport, twin: PoltergeistReport): string {
  const side = (r: PoltergeistReport) => {
    const total = formatUsdc(BigInt(r.drift.total));
    const { lost, conjured } = lostAndConjured(r.drift);
    return lost === 0n && conjured === 0n ? total : `${total} (${describeDrift({ lost, conjured })})`;
  };
  return `Storm finished: drift ${side(ossuary)} on Ossuary, ${side(twin)} on Vibe Pay.`;
}
