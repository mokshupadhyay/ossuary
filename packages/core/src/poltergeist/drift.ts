import { MEMBERS, type MemberRef, type TruthEffect } from './storm.js';

/*
 * The drift meter (Requirement 7, design D3). Pure, bigint only.
 *
 *   drift(account) = expected − reported
 *   expected pot      = captured − refunded − paid out
 *   expected member m = paid out to m
 *
 * Positive drift is lost money; negative is conjured money. The total is the
 * sum over accounts, which is money in − money out − money held.
 */

export interface Truth {
  readonly asset: string;
  readonly captured: bigint;
  readonly refunded: bigint;
  readonly paidOut: ReadonlyMap<MemberRef, bigint>;
}

/** A balance snapshot with member ids already mapped to refs by the runner. */
export interface RefSnapshot {
  readonly asset: string;
  readonly pot: bigint;
  readonly members: ReadonlyMap<MemberRef | 'unknown', bigint>;
}

export interface AccountDrift {
  readonly account: string;
  readonly drift: bigint;
}

export interface DriftDelta {
  readonly accounts: readonly AccountDrift[];
  readonly total: bigint;
}

export interface Drift extends DriftDelta {
  readonly conjured: bigint;
  readonly lost: bigint;
  readonly doubleCreditedMembers: number;
}

export function emptyTruth(asset: string): Truth {
  return { asset, captured: 0n, refunded: 0n, paidOut: new Map(MEMBERS.map((m) => [m, 0n])) };
}

export function addEffect(truth: Truth, effect: TruthEffect): Truth {
  const paidOut = new Map(truth.paidOut);
  for (const m of MEMBERS) {
    const p = effect.paidOut[m];
    if (p !== undefined) paidOut.set(m, (paidOut.get(m) ?? 0n) + p);
  }
  return {
    asset: truth.asset,
    captured: truth.captured + effect.captured,
    refunded: truth.refunded + effect.refunded,
    paidOut,
  };
}

export function measureDrift(truth: Truth, snapshot: RefSnapshot): Drift {
  if (snapshot.asset !== truth.asset) {
    throw new Error(`drift meter: snapshot asset ${snapshot.asset} differs from ${truth.asset}; no conversion is attempted`);
  }
  const paid = (m: MemberRef) => truth.paidOut.get(m) ?? 0n;
  const rows: { account: string; expected: bigint; reported: bigint; member: boolean }[] = [
    {
      account: 'pot',
      expected: truth.captured - truth.refunded - MEMBERS.reduce((s, m) => s + paid(m), 0n),
      reported: snapshot.pot,
      member: false,
    },
    ...MEMBERS.map((m) => ({ account: `member:${m}`, expected: paid(m), reported: snapshot.members.get(m) ?? 0n, member: true })),
  ];
  const unknown = snapshot.members.get('unknown');
  if (unknown !== undefined) rows.push({ account: 'member:unknown', expected: 0n, reported: unknown, member: false });

  let total = 0n;
  let conjured = 0n;
  let lost = 0n;
  let doubleCreditedMembers = 0;
  const accounts = rows.map((r) => {
    const drift = r.expected - r.reported;
    total += drift;
    if (drift < 0n) conjured -= drift;
    if (drift > 0n) lost += drift;
    if (r.member && r.reported > r.expected) doubleCreditedMembers += 1;
    return { account: r.account, drift };
  });
  return { accounts, total, conjured, lost, doubleCreditedMembers };
}

/** Per-account change from `before` to `after`. Accounts missing on one side count as 0. */
export function subtractDrift(after: DriftDelta, before: DriftDelta): DriftDelta {
  const prior = new Map(before.accounts.map((a) => [a.account, a.drift]));
  const names = [...after.accounts.map((a) => a.account), ...before.accounts.map((a) => a.account)];
  const now = new Map(after.accounts.map((a) => [a.account, a.drift]));
  const accounts = [...new Set(names)].map((account) => ({
    account,
    drift: (now.get(account) ?? 0n) - (prior.get(account) ?? 0n),
  }));
  return { accounts, total: after.total - before.total };
}

/** Per-account sum of deltas (used for per-fault and honest totals). */
export function addDrift(a: DriftDelta, b: DriftDelta): DriftDelta {
  const sum = new Map<string, bigint>();
  for (const x of [...a.accounts, ...b.accounts]) sum.set(x.account, (sum.get(x.account) ?? 0n) + x.drift);
  return { accounts: [...sum].map(([account, drift]) => ({ account, drift })), total: a.total + b.total };
}

export const ZERO_DELTA: DriftDelta = Object.freeze({
  accounts: Object.freeze([{ account: 'pot', drift: 0n }, ...MEMBERS.map((m) => ({ account: `member:${m}`, drift: 0n }))]),
  total: 0n,
});

export const isZero = (d: DriftDelta): boolean => d.total === 0n && d.accounts.every((a) => a.drift === 0n);
