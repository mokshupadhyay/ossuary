import {
  balance,
  createAccount,
  NormalBalanceViolationError,
  postTransaction,
  runOutboxOnce,
  type Clock,
  type OutboxMessageToSend,
} from '@ossuary/core';
import type { LedgerHandle } from '../ledger/database';
import { ASSET, formatUsdc, MAX_CONTRIBUTION } from '../money';
import { createRail, eventIdFor, type Rail, type RailOptions } from './rail';
import {
  TontineError,
  type CircleSummary,
  type CircleView,
  type DueStatus,
  type LedgerLine,
  type MemberView,
  type TimelineEntry,
} from './types';

/*
 * The circle service: every rule of a rotating savings circle, on top of
 * Core. Money moves only through Core (contributions through the rail and
 * Core's webhook handler, payouts through postTransaction); this file adds
 * the circle's rules in front of Core's guarantees (design T4) and derives
 * every state it reports from the ledger (design T2).
 */

export const MIN_MEMBERS = 2;
export const MAX_MEMBERS = 12;
export const MAX_CIRCLE_NAME = 60;
export const MAX_MEMBER_NAME = 40;

export interface CreateCircleInput {
  name: string;
  members: readonly string[];
  contribution: bigint;
}

export interface TontineService {
  readonly ledger: LedgerHandle;
  listCircles(): Promise<CircleSummary[]>;
  createCircle(input: CreateCircleInput): Promise<string>;
  /** Records a member's contribution for a round. Repeating a recorded one is a no-op (`duplicate`). */
  contribute(circleId: string, round: number, position: number): Promise<{ outcome: 'applied' | 'duplicate' }>;
  /** Marks an unpaid due of the current round as late. Moves no money. */
  markMissed(circleId: string, round: number, position: number): Promise<{ changed: boolean }>;
  /** Pays a round's pot to its recipient. Repeating a paid-out round returns the same transaction. */
  payout(circleId: string, round: number): Promise<{ transactionId: string; replayed: boolean }>;
  view(circleId: string): Promise<CircleView>;
  /** Sum of entries on the given accounts, or on the whole ledger when omitted. */
  ledgerSum(accountIds?: readonly string[]): Promise<bigint>;
}

export interface ServiceOptions {
  clock?: Clock;
  rail?: RailOptions;
}

interface CircleRow {
  circleId: string;
  name: string;
  contribution: bigint;
  memberCount: number;
  clearingAccountId: string;
  potAccountId: string;
}
interface MemberRow {
  position: number;
  memberId: string;
  name: string;
  walletAccountId: string;
}
interface DueRow {
  round: number;
  position: number;
  idempotencyKey: string;
  paymentId: string;
  paid: boolean;
  missed: boolean;
  notedAt: Date | null;
}
interface RoundRow {
  round: number;
  recipientPosition: number;
  payoutKey: string;
  payoutTransactionId: string | null;
}
interface CircleState {
  circle: CircleRow;
  members: MemberRow[];
  dues: DueRow[];
  rounds: RoundRow[];
  currentRound: number | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET_KEY = 'rail_signing_secret';
const length = (s: string) => [...s].length;
const invalid = (message: string, field: string) => new TontineError('invalid-input', message, field);

function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export interface FieldError {
  field: string;
  message: string;
}

/** Every problem with a create-circle input, in form order. Fields: `name`, `member-<i>`, `members`, `contribution`. */
export function circleInputErrors(input: CreateCircleInput): FieldError[] {
  const errors: FieldError[] = [];
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name === '') errors.push({ field: 'name', message: 'Give the circle a name.' });
  else if (length(name) > MAX_CIRCLE_NAME) errors.push({ field: 'name', message: `The name can be at most ${MAX_CIRCLE_NAME} characters.` });

  const members = Array.isArray(input.members) ? input.members.map((m) => (typeof m === 'string' ? m.trim() : '')) : [];
  const seen = new Set<string>();
  for (const [i, m] of members.entries()) {
    const field = `member-${i}`;
    if (m === '') errors.push({ field, message: `Member ${i + 1} needs a name.` });
    else if (length(m) > MAX_MEMBER_NAME) errors.push({ field, message: `Member ${i + 1}'s name can be at most ${MAX_MEMBER_NAME} characters.` });
    else if (seen.has(m.toLocaleLowerCase())) errors.push({ field, message: `${m} is already in the circle. Each member needs a different name.` });
    seen.add(m.toLocaleLowerCase());
  }
  if (members.length < MIN_MEMBERS) errors.push({ field: 'members', message: `A circle needs at least ${MIN_MEMBERS} members.` });
  if (members.length > MAX_MEMBERS) errors.push({ field: 'members', message: `A circle can have at most ${MAX_MEMBERS} members.` });

  const { contribution } = input;
  if (typeof contribution !== 'bigint') errors.push({ field: 'contribution', message: 'Enter a contribution.' });
  else if (contribution <= 0n) errors.push({ field: 'contribution', message: 'The contribution must be more than zero.' });
  else if (contribution > MAX_CONTRIBUTION) errors.push({ field: 'contribution', message: 'The most a contribution can be is 1,000,000 USDC.' });
  return errors;
}

/** Validates and normalises the create-circle input. Throws `invalid-input` naming the first bad field. */
export function validateCircleInput(input: CreateCircleInput): { name: string; members: string[]; contribution: bigint } {
  const [first] = circleInputErrors(input);
  if (first) throw invalid(first.message, first.field);
  return { name: input.name.trim(), members: input.members.map((m) => m.trim()), contribution: input.contribution };
}

export async function createTontineService(ledger: LedgerHandle, options: ServiceOptions = {}): Promise<TontineService> {
  const { client, db } = ledger;
  const clock: Clock = options.clock ?? { now: () => Date.now() };

  // The simulated rail's signing secret, created once per database (design Q5).
  await client.query(`INSERT INTO tontine_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`, [SECRET_KEY, randomHex(32)]);
  const secret = (await client.query<{ value: string }>(`SELECT value FROM tontine_settings WHERE key = $1`, [SECRET_KEY])).rows[0]!.value;

  const rails = new Map<string, Promise<Rail>>();
  const railFor = (c: CircleRow): Promise<Rail> => {
    let r = rails.get(c.circleId);
    if (!r) {
      r = createRail(ledger, { clearingAccountId: c.clearingAccountId, potAccountId: c.potAccountId }, secret, clock, options.rail);
      r.catch(() => rails.delete(c.circleId));
      rails.set(c.circleId, r);
    }
    return r;
  };

  /** The outbox sender: records a receipt once per message, however often it is sent (at-least-once). */
  const recordReceipt = async (m: OutboxMessageToSend): Promise<void> => {
    await client.query(
      `INSERT INTO tontine_receipts (outbox_key, event_id, payment_id, topic) VALUES ($1, $2, $3, $4) ON CONFLICT (outbox_key) DO NOTHING`,
      [m.idempotencyKey, m.payload.eventId, m.payload.paymentId, m.topic],
    );
  };

  async function load(circleId: string): Promise<CircleState> {
    if (typeof circleId !== 'string' || !UUID_RE.test(circleId)) throw new TontineError('unknown-circle', 'There is no such circle.');
    const id = circleId.toLowerCase();
    const c = await client.query<{ circle_id: string; name: string; contribution: string; member_count: number; clearing_account_id: string; pot_account_id: string }>(
      `SELECT circle_id, name, contribution::text AS contribution, member_count, clearing_account_id, pot_account_id FROM tontine_circles WHERE circle_id = $1`,
      [id],
    );
    const row = c.rows[0];
    if (!row) throw new TontineError('unknown-circle', 'There is no such circle.');
    const circle: CircleRow = {
      circleId: row.circle_id,
      name: row.name,
      contribution: BigInt(row.contribution),
      memberCount: row.member_count,
      clearingAccountId: row.clearing_account_id,
      potAccountId: row.pot_account_id,
    };
    const members = (
      await client.query<{ position: number; member_id: string; name: string; wallet_account_id: string }>(
        `SELECT position, member_id, name, wallet_account_id FROM tontine_members WHERE circle_id = $1 ORDER BY position`,
        [id],
      )
    ).rows.map((m) => ({ position: m.position, memberId: m.member_id, name: m.name, walletAccountId: m.wallet_account_id }));
    // A due is paid iff Core holds a capture for its payment id (design T2).
    const dues = (
      await client.query<{ round: number; position: number; idempotency_key: string; payment_id: string; paid: boolean; noted_at: Date | null }>(
        `SELECT d.round, d.position, d.idempotency_key, d.payment_id,
                EXISTS (SELECT 1 FROM transactions t WHERE t.payment_id = d.payment_id AND t.kind = 'capture') AS paid,
                n.noted_at
           FROM tontine_dues d
           LEFT JOIN tontine_notices n ON n.circle_id = d.circle_id AND n.round = d.round AND n.position = d.position
          WHERE d.circle_id = $1
          ORDER BY d.round, d.position`,
        [id],
      )
    ).rows.map((d) => ({
      round: d.round,
      position: d.position,
      idempotencyKey: d.idempotency_key,
      paymentId: d.payment_id,
      paid: d.paid,
      missed: d.noted_at !== null,
      notedAt: d.noted_at,
    }));
    // A round is paid out iff Core holds a transaction under its payout key.
    const rounds = (
      await client.query<{ round: number; recipient_position: number; payout_key: string; tx_id: string | null }>(
        `SELECT r.round, r.recipient_position, r.payout_key, t.id AS tx_id
           FROM tontine_rounds r
           LEFT JOIN transactions t ON t.idempotency_key = r.payout_key
          WHERE r.circle_id = $1
          ORDER BY r.round`,
        [id],
      )
    ).rows.map((r) => ({ round: r.round, recipientPosition: r.recipient_position, payoutKey: r.payout_key, payoutTransactionId: r.tx_id }));
    const open = rounds.find((r) => r.payoutTransactionId === null);
    return { circle, members, dues, rounds, currentRound: open ? open.round : null };
  }

  const memberAt = (s: CircleState, position: number): MemberRow => {
    const m = Number.isInteger(position) ? s.members.find((x) => x.position === position) : undefined;
    if (!m) throw new TontineError('unknown-member', 'There is no such member in this circle.');
    return m;
  };
  const dueOf = (s: CircleState, round: number, position: number): DueRow | undefined =>
    s.dues.find((d) => d.round === round && d.position === position);
  const requireCurrent = (s: CircleState, round: number): number => {
    if (s.currentRound === null) throw new TontineError('circle-complete', 'This circle is complete: every member has received the pot.');
    if (round !== s.currentRound) {
      throw new TontineError('not-current-round', `Round ${round} is not open. The circle is on round ${s.currentRound}.`);
    }
    return s.currentRound;
  };
  const potPerRound = (c: CircleRow) => c.contribution * BigInt(c.memberCount);

  const ledgerSum = async (accountIds?: readonly string[]): Promise<bigint> => {
    const r =
      accountIds === undefined
        ? await client.query<{ s: string }>(`SELECT coalesce(sum(amount), 0)::text AS s FROM entries`)
        : await client.query<{ s: string }>(`SELECT coalesce(sum(amount), 0)::text AS s FROM entries WHERE account_id = ANY($1::uuid[])`, [
            [...accountIds],
          ]);
    return BigInt(r.rows[0]!.s);
  };

  const service: TontineService = {
    ledger,

    async listCircles() {
      const r = await client.query<{ circle_id: string; name: string }>(`SELECT circle_id, name FROM tontine_circles ORDER BY seq`);
      return r.rows.map((x) => ({ circleId: x.circle_id, name: x.name }));
    },

    async createCircle(input) {
      const { name, members, contribution } = validateCircleInput(input);
      const n = members.length;
      const newId = () => globalThis.crypto.randomUUID();
      const circleId = newId();

      const account = async (label: string, type: 'asset' | 'revenue' | 'liability', allowOverdraft = false) => {
        const accountId = newId();
        await createAccount(db, { accountId, name: `${name} · ${label}`, type, allowOverdraft });
        return accountId;
      };
      // The rail side of every contribution: an asset account that may go below zero (ledger.md).
      const clearingAccountId = await account('clearing', 'asset', true);
      // The pot: credit-normal and never overdrawn, so Core refuses any payout it cannot cover.
      const potAccountId = await account('pot', 'revenue');
      const wallets: string[] = [];
      for (const m of members) wallets.push(await account(`wallet ${m}`, 'liability'));

      // Every key is minted now, once (design T3).
      await client.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO tontine_circles (circle_id, name, asset, contribution, member_count, clearing_account_id, pot_account_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [circleId, name, ASSET, contribution.toString(), n, clearingAccountId, potAccountId],
        );
        for (const [position, m] of members.entries()) {
          await tx.query(`INSERT INTO tontine_members (circle_id, position, member_id, name, wallet_account_id) VALUES ($1, $2, $3, $4, $5)`, [
            circleId,
            position,
            newId(),
            m,
            wallets[position],
          ]);
        }
        for (let round = 1; round <= n; round++) {
          await tx.query(`INSERT INTO tontine_rounds (circle_id, round, recipient_position, payout_key) VALUES ($1, $2, $3, $4)`, [
            circleId,
            round,
            round - 1,
            newId(),
          ]);
          for (let position = 0; position < n; position++) {
            await tx.query(`INSERT INTO tontine_dues (circle_id, round, position, idempotency_key, payment_id) VALUES ($1, $2, $3, $4, $5)`, [
              circleId,
              round,
              position,
              newId(),
              newId(),
            ]);
          }
        }
      });
      return circleId;
    },

    async contribute(circleId, round, position) {
      const s = await load(circleId);
      const member = memberAt(s, position);
      let due = dueOf(s, round, position);
      // A due already paid is sent again as-is: Core's inbox answers `duplicate` and nothing moves.
      if (!due?.paid) {
        requireCurrent(s, round);
        due = dueOf(s, round, position);
      }
      if (!due) throw new TontineError('unknown-member', 'There is no such member in this circle.');

      const rail = await railFor(s.circle);
      const outcome = await rail.deliverCapture(
        { circleId: s.circle.circleId, memberId: member.memberId, paymentId: due.paymentId, idempotencyKey: due.idempotencyKey },
        s.circle.contribution,
      );
      // Receipts go out through Core's outbox. The money is already committed, so a failed send only delays the receipt.
      await runOutboxOnce(db, { sender: recordReceipt, clock }).catch(() => undefined);
      return { outcome };
    },

    async markMissed(circleId, round, position) {
      const s = await load(circleId);
      memberAt(s, position);
      requireCurrent(s, round);
      const due = dueOf(s, round, position);
      if (!due) throw new TontineError('unknown-member', 'There is no such member in this circle.');
      if (due.paid) throw new TontineError('already-paid', 'This member has already paid this round.');
      const r = await client.query(
        `INSERT INTO tontine_notices (circle_id, round, position) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING round`,
        [s.circle.circleId, round, position],
      );
      return { changed: r.rows.length > 0 };
    },

    async payout(circleId, round) {
      const s = await load(circleId);
      const r = Number.isInteger(round) ? s.rounds.find((x) => x.round === round) : undefined;
      const replayed = r?.payoutTransactionId != null;
      if (!replayed) {
        requireCurrent(s, round);
        const waiting = s.dues.filter((d) => d.round === round && !d.paid).map((d) => memberAt(s, d.position).name);
        if (waiting.length > 0) {
          throw new TontineError('dues-unpaid', `The circle is waiting for ${waiting.join(', ')}. Nobody is paid until everyone has paid.`);
        }
      }
      if (!r) throw new TontineError('not-current-round', `There is no round ${round}.`);
      const recipient = memberAt(s, r.recipientPosition);
      const amount = potPerRound(s.circle);
      try {
        // Same key, same entries: a repeat returns Core's stored response and moves nothing (idempotency.md).
        const res = await postTransaction(db, {
          idempotencyKey: r.payoutKey,
          kind: 'transfer',
          entries: [
            { accountId: s.circle.potAccountId, amount },
            { accountId: recipient.walletAccountId, amount: -amount },
          ],
        });
        return { transactionId: res.transactionId, replayed };
      } catch (e) {
        if (e instanceof NormalBalanceViolationError) {
          throw new TontineError('pot-short', `The pot cannot cover ${formatUsdc(amount)}. Nothing was paid.`);
        }
        throw e;
      }
    },

    async view(circleId) {
      const s = await load(circleId);
      const { circle } = s;
      const held = async (accountId: string) => -(await balance(db, accountId));
      const pot = await held(circle.potAccountId);
      const moneyIn = await balance(db, circle.clearingAccountId);
      const wallets = new Map<number, bigint>();
      for (const m of s.members) wallets.set(m.position, await held(m.walletAccountId));
      const accountIds = [circle.clearingAccountId, circle.potAccountId, ...s.members.map((m) => m.walletAccountId)];

      const receivedRound = new Map<number, number>();
      for (const r of s.rounds) if (r.payoutTransactionId !== null) receivedRound.set(r.recipientPosition, r.round);

      const statusOf = (d: DueRow): DueStatus => (d.paid ? (d.missed ? 'paid-late' : 'paid') : d.missed ? 'late' : 'owes');
      const current = s.currentRound;
      const members: MemberView[] = s.members.map((m) => {
        const d = current === null ? undefined : dueOf(s, current, m.position);
        return {
          position: m.position,
          memberId: m.memberId,
          name: m.name,
          walletAccountId: m.walletAccountId,
          wallet: wallets.get(m.position) ?? 0n,
          receivedRound: receivedRound.get(m.position) ?? null,
          recipientRound: s.rounds.find((r) => r.recipientPosition === m.position)?.round ?? m.position + 1,
          due: d ? { round: d.round, status: statusOf(d), idempotencyKey: d.idempotencyKey } : null,
        };
      });
      const currentDues = current === null ? [] : s.dues.filter((d) => d.round === current);

      return {
        circleId: circle.circleId,
        name: circle.name,
        asset: ASSET,
        contribution: circle.contribution,
        potPerRound: potPerRound(circle),
        rounds: s.rounds.length,
        currentRound: current,
        complete: current === null,
        recipientPosition: current === null ? null : (s.rounds.find((r) => r.round === current)?.recipientPosition ?? null),
        members,
        waitingFor: currentDues.filter((d) => !d.paid).map((d) => memberAt(s, d.position).name),
        paidThisRound: currentDues.filter((d) => d.paid).length,
        pot,
        moneyIn,
        moneyOut: [...wallets.values()].reduce((a, b) => a + b, 0n),
        ledgerSum: await ledgerSum(accountIds),
        accounts: { clearing: circle.clearingAccountId, pot: circle.potAccountId },
        timeline: await timeline(s, accountIds),
      };
    },

    ledgerSum,
  };

  async function timeline(s: CircleState, accountIds: string[]): Promise<TimelineEntry[]> {
    const label = new Map<string, string>([
      [s.circle.clearingAccountId, 'Clearing'],
      [s.circle.potAccountId, 'Pot'],
      ...s.members.map((m) => [m.walletAccountId, `Wallet · ${m.name}`] as [string, string]),
    ]);
    const rows = (
      await client.query<{ id: string; kind: string; payment_id: string | null; idempotency_key: string | null; created_at: Date; account_id: string; amount: string }>(
        `SELECT t.id, t.kind, t.payment_id, t.idempotency_key, t.created_at, e.account_id, e.amount::text AS amount
           FROM transactions t
           JOIN entries e ON e.transaction_id = t.id
          WHERE t.id IN (SELECT transaction_id FROM entries WHERE account_id = ANY($1::uuid[]))
          ORDER BY t.created_at, t.id, e.amount DESC`,
        [accountIds],
      )
    ).rows;
    const receipts = new Set(
      (
        await client.query<{ payment_id: string }>(`SELECT DISTINCT payment_id FROM tontine_receipts WHERE payment_id = ANY($1::uuid[])`, [
          s.dues.map((d) => d.paymentId),
        ])
      ).rows.map((r) => r.payment_id),
    );
    const dueByPayment = new Map(s.dues.map((d) => [d.paymentId, d]));
    const roundByKey = new Map(s.rounds.map((r) => [r.payoutKey, r]));

    const txs = new Map<string, { kind: string; paymentId: string | null; key: string | null; at: Date; entries: LedgerLine[] }>();
    for (const r of rows) {
      let t = txs.get(r.id);
      if (!t) {
        t = { kind: r.kind, paymentId: r.payment_id, key: r.idempotency_key, at: r.created_at, entries: [] };
        txs.set(r.id, t);
      }
      t.entries.push({ account: label.get(r.account_id) ?? 'Other', accountId: r.account_id, amount: BigInt(r.amount) });
    }

    const out: TimelineEntry[] = [];
    for (const [transactionId, t] of txs) {
      const moved = t.entries.reduce((a, e) => (e.amount > 0n ? a + e.amount : a), 0n);
      if (t.kind === 'capture' && t.paymentId !== null) {
        const d = dueByPayment.get(t.paymentId);
        if (!d) continue;
        out.push({
          kind: 'contribution',
          at: t.at,
          round: d.round,
          position: d.position,
          memberName: memberAt(s, d.position).name,
          amount: moved,
          clientKey: d.idempotencyKey,
          ledgerKey: t.key ?? '',
          eventId: eventIdFor(d.idempotencyKey),
          transactionId,
          entries: t.entries,
          receipt: receipts.has(d.paymentId),
          late: d.missed,
        });
      } else if (t.kind === 'transfer' && t.key !== null) {
        const r = roundByKey.get(t.key);
        if (!r) continue;
        out.push({
          kind: 'payout',
          at: t.at,
          round: r.round,
          position: r.recipientPosition,
          memberName: memberAt(s, r.recipientPosition).name,
          amount: moved,
          clientKey: r.payoutKey,
          ledgerKey: t.key,
          transactionId,
          entries: t.entries,
        });
      }
    }
    for (const d of s.dues) {
      if (d.notedAt !== null) out.push({ kind: 'missed', at: d.notedAt, round: d.round, position: d.position, memberName: memberAt(s, d.position).name });
    }
    // Newest first; on equal times, the later step of a round first (payout, then contribution, then a missed mark).
    const rank = { payout: 2, contribution: 1, missed: 0 } as const;
    return out
      .map((e, i) => ({ e, i }))
      .sort((a, b) => b.e.at.getTime() - a.e.at.getTime() || b.e.round - a.e.round || rank[b.e.kind] - rank[a.e.kind] || b.i - a.i)
      .map((x) => x.e);
  }

  return service;
}
