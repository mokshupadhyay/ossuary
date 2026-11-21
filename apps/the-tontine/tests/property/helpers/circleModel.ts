import type { PGlite } from '@electric-sql/pglite';
import fc from 'fast-check';
import { balance } from '@ossuary/core';
import { openLedger } from '../../../src/ledger/database';
import { createTontineService, type TontineService } from '../../../src/tontine/service';
import { TontineError, type TontineErrorCode } from '../../../src/tontine/types';

/*
 * Shared machinery for the circle properties (design "Correctness
 * Properties"): circle and command arbitraries, an independent model of a
 * rotating circle, a runner that applies each command to the real service
 * and the model, and ledger facts read straight from Core's tables and
 * balance(), never from the service's own derived view.
 */

export const NUM_RUNS = Number(process.env.TONTINE_PROPERTY_RUNS ?? 50);

export interface CircleSpec {
  names: string[];
  contribution: bigint;
}

export const circleSpec: fc.Arbitrary<CircleSpec> = fc.record({
  names: fc.integer({ min: 2, max: 5 }).map((n) => Array.from({ length: n }, (_, i) => `Member ${i + 1}`)),
  contribution: fc.bigInt({ min: 1n, max: 1_000_000_000n }),
});

export type Command =
  | { t: 'contribute'; pos: number; delta: -1 | 0 | 1 }
  | { t: 'doubleContribute'; pos: number }
  | { t: 'everyonePays' }
  | { t: 'missed'; pos: number; delta: -1 | 0 | 1 }
  | { t: 'payout'; delta: -1 | 0 | 1 }
  | { t: 'doublePayout' }
  | { t: 'replay' };

const delta = fc.constantFrom<-1 | 0 | 1>(0, 0, 0, -1, 1);
/** Positions 0-5: some fall outside a small circle, so unknown members are exercised too. */
const pos = fc.integer({ min: 0, max: 5 });

export const command: fc.Arbitrary<Command> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ t: fc.constant('contribute' as const), pos, delta }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('doubleContribute' as const), pos }) },
  { weight: 2, arbitrary: fc.constant({ t: 'everyonePays' as const }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('missed' as const), pos, delta }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant('payout' as const), delta }) },
  { weight: 1, arbitrary: fc.constant({ t: 'doublePayout' as const }) },
  { weight: 1, arbitrary: fc.constant({ t: 'replay' as const }) },
);

export const commands = (max = 40) => fc.array(command, { minLength: 8, maxLength: max, size: 'max' });

/** A successful money command that can be replayed with the same key. */
export type MoneyOp = { t: 'contribute'; round: number; pos: number } | { t: 'payout'; round: number };

/** The independent model: what a correct rotating circle does. */
export class CircleModel {
  readonly paid = new Set<string>();
  readonly missed = new Set<string>();
  readonly paidOut = new Set<number>();
  readonly done: MoneyOp[] = [];

  constructor(
    readonly n: number,
    readonly contribution: bigint,
  ) {}

  get current(): number | null {
    for (let r = 1; r <= this.n; r++) if (!this.paidOut.has(r)) return r;
    return null;
  }
  /** Round a delta refers to; past the end when the circle is complete. */
  roundAt(d: number): number {
    return (this.current ?? this.n + 1) + d;
  }
  isPaid(round: number, p: number) {
    return this.paid.has(`${round}:${p}`);
  }
  get pot(): bigint {
    return BigInt(this.paid.size) * this.contribution - BigInt(this.paidOut.size) * BigInt(this.n) * this.contribution;
  }
  get moneyIn(): bigint {
    return BigInt(this.paid.size) * this.contribution;
  }

  /** Expected result of a contribution: an error code, or the outcome. */
  contribute(round: number, p: number): TontineErrorCode | 'applied' | 'duplicate' {
    if (p < 0 || p >= this.n) return 'unknown-member';
    if (this.isPaid(round, p)) return 'duplicate';
    if (this.current === null) return 'circle-complete';
    if (round !== this.current) return 'not-current-round';
    this.paid.add(`${round}:${p}`);
    return 'applied';
  }
  markMissed(round: number, p: number): TontineErrorCode | 'ok' {
    if (p < 0 || p >= this.n) return 'unknown-member';
    if (this.current === null) return 'circle-complete';
    if (round !== this.current) return 'not-current-round';
    if (this.isPaid(round, p)) return 'already-paid';
    this.missed.add(`${round}:${p}`);
    return 'ok';
  }
  payout(round: number): TontineErrorCode | 'paid' | 'replayed' {
    if (this.paidOut.has(round)) return 'replayed';
    if (this.current === null) return 'circle-complete';
    if (round !== this.current) return 'not-current-round';
    for (let p = 0; p < this.n; p++) if (!this.isPaid(round, p)) return 'dues-unpaid';
    this.paidOut.add(round);
    return 'paid';
  }
}

export interface Harness {
  client: PGlite;
  svc: TontineService;
}

export async function harness(client: PGlite): Promise<Harness> {
  return { client, svc: await createTontineService(await openLedger(client)) };
}

async function outcome<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; code: TontineErrorCode }> {
  try {
    return { ok: true, value: await p };
  } catch (e) {
    if (e instanceof TontineError) return { ok: false, code: e.code };
    throw e;
  }
}

export class Mismatch extends Error {}
const expectEq = (what: string, actual: unknown, expected: unknown) => {
  if (actual !== expected) throw new Mismatch(`${what}: got ${String(actual)}, model says ${String(expected)}`);
};

/** Applies one command to the service and the model, and checks the service answered what the model expects. */
export async function step(h: Harness, circleId: string, m: CircleModel, cmd: Command): Promise<void> {
  const { svc } = h;
  switch (cmd.t) {
    case 'contribute': {
      const round = m.roundAt(cmd.delta);
      const want = m.contribute(round, cmd.pos);
      const got = await outcome(svc.contribute(circleId, round, cmd.pos));
      expectEq(`contribute(r${round}, p${cmd.pos})`, got.ok ? got.value.outcome : got.code, want);
      if (got.ok) m.done.push({ t: 'contribute', round, pos: cmd.pos });
      return;
    }
    case 'doubleContribute': {
      const round = m.roundAt(0);
      const want = m.contribute(round, cmd.pos);
      const got = await Promise.all([outcome(svc.contribute(circleId, round, cmd.pos)), outcome(svc.contribute(circleId, round, cmd.pos))]);
      const codes = got.map((g) => (g.ok ? g.value.outcome : g.code)).sort();
      const expected = want === 'applied' ? ['applied', 'duplicate'] : [want, want];
      expectEq(`double contribute(r${round}, p${cmd.pos})`, codes.join(','), expected.join(','));
      if (want === 'applied' || want === 'duplicate') m.done.push({ t: 'contribute', round, pos: cmd.pos });
      return;
    }
    case 'everyonePays': {
      const round = m.current;
      if (round === null) return;
      for (let p = 0; p < m.n; p++) {
        const want = m.contribute(round, p);
        const got = await outcome(svc.contribute(circleId, round, p));
        expectEq(`everyone pays (r${round}, p${p})`, got.ok ? got.value.outcome : got.code, want);
        m.done.push({ t: 'contribute', round, pos: p });
      }
      return;
    }
    case 'missed': {
      const round = m.roundAt(cmd.delta);
      const want = m.markMissed(round, cmd.pos);
      const got = await outcome(svc.markMissed(circleId, round, cmd.pos));
      expectEq(`markMissed(r${round}, p${cmd.pos})`, got.ok ? 'ok' : got.code, want);
      return;
    }
    case 'payout': {
      const round = m.roundAt(cmd.delta);
      const want = m.payout(round);
      const got = await outcome(svc.payout(circleId, round));
      expectEq(`payout(r${round})`, got.ok ? (got.value.replayed ? 'replayed' : 'paid') : got.code, want);
      if (got.ok) m.done.push({ t: 'payout', round });
      return;
    }
    case 'doublePayout': {
      const round = m.roundAt(0);
      const want = m.payout(round);
      const got = await Promise.all([outcome(svc.payout(circleId, round)), outcome(svc.payout(circleId, round))]);
      const ok = want === 'paid' || want === 'replayed';
      for (const g of got) expectEq(`double payout(r${round})`, g.ok ? 'ok' : g.code, ok ? 'ok' : want);
      if (got[0]!.ok && got[1]!.ok) expectEq('double payout transaction', got[0]!.value.transactionId, got[1]!.value.transactionId);
      if (ok) m.done.push({ t: 'payout', round });
      return;
    }
    case 'replay': {
      const last = m.done.at(-1);
      if (!last) return;
      await replay(h, circleId, last, 1);
      return;
    }
  }
}

/** Repeats a money command that already succeeded, `times` times concurrently. Every repeat must succeed. */
export async function replay(h: Harness, circleId: string, op: MoneyOp, times: number): Promise<void> {
  const runs = Array.from({ length: times }, () =>
    op.t === 'contribute' ? h.svc.contribute(circleId, op.round, op.pos).then((r) => r.outcome) : h.svc.payout(circleId, op.round).then((r) => (r.replayed ? 'replayed' : 'paid')),
  );
  const got = await Promise.all(runs);
  for (const g of got) {
    if (g !== (op.t === 'contribute' ? 'duplicate' : 'replayed')) throw new Mismatch(`replay of ${JSON.stringify(op)} answered ${g}`);
  }
}

export interface LedgerFacts {
  clearing: bigint;
  /** What the pot holds (credit-normal, so the negated entry sum). */
  pot: bigint;
  /** What each wallet holds, by position. */
  wallets: bigint[];
  /** Credit entries per wallet: how many payouts each member received. */
  walletCredits: number[];
  /** Transfer transactions touching this circle's accounts. */
  transfers: number;
  circleSum: bigint;
  ledgerSum: bigint;
  txCount: number;
  entryCount: number;
  accountIds: string[];
}

/** Ledger facts read from Core's tables and balance() using only the account ids, never the service's view. */
export async function ledgerFacts(h: Harness, circleId: string): Promise<LedgerFacts> {
  const { client, svc } = h;
  const c = (await client.query<{ clearing_account_id: string; pot_account_id: string }>(
    'SELECT clearing_account_id, pot_account_id FROM tontine_circles WHERE circle_id = $1',
    [circleId],
  )).rows[0]!;
  const wallets = (await client.query<{ wallet_account_id: string }>('SELECT wallet_account_id FROM tontine_members WHERE circle_id = $1 ORDER BY position', [circleId])).rows.map(
    (r) => r.wallet_account_id,
  );
  const ids = [c.clearing_account_id, c.pot_account_id, ...wallets];
  const n = async (sql: string, params: unknown[] = []) => (await client.query<{ n: number }>(sql, params)).rows[0]!.n;
  const s = async (sql: string, params: unknown[] = []) => BigInt((await client.query<{ s: string }>(sql, params)).rows[0]!.s);
  const walletCredits: number[] = [];
  for (const w of wallets) walletCredits.push(await n('SELECT count(*)::int AS n FROM entries WHERE account_id = $1 AND amount < 0', [w]));
  return {
    clearing: await balance(svc.ledger.db, c.clearing_account_id),
    pot: -(await balance(svc.ledger.db, c.pot_account_id)),
    wallets: await Promise.all(wallets.map(async (w) => -(await balance(svc.ledger.db, w)))),
    walletCredits,
    transfers: await n(
      `SELECT count(DISTINCT t.id)::int AS n FROM transactions t JOIN entries e ON e.transaction_id = t.id WHERE t.kind = 'transfer' AND e.account_id = ANY($1::uuid[])`,
      [ids],
    ),
    circleSum: await s('SELECT coalesce(sum(amount), 0)::text AS s FROM entries WHERE account_id = ANY($1::uuid[])', [ids]),
    ledgerSum: await s('SELECT coalesce(sum(amount), 0)::text AS s FROM entries'),
    txCount: await n('SELECT count(*)::int AS n FROM transactions'),
    entryCount: await n('SELECT count(*)::int AS n FROM entries'),
    accountIds: ids,
  };
}
