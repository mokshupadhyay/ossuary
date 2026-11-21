/*
 * The read model (design D6). Per-tip amounts and the coffin's Total_In and
 * Total_Out come from core's webhook inbox; Held, Rail_Clearing and the
 * ledger sum come from core's ledger entries. The two sources are kept apart
 * on purpose: if the ledger and the inbox ever disagree, the residual is not
 * zero. Every sum is done in SQL and read as text, then BigInt: money never
 * passes through a JS number.
 */
import { sql } from 'drizzle-orm';
import type { Db } from './db';
import type { DeliveryMode, JarRef, Outcome } from './rail';

export type TipStatus = 'pending' | 'arrived' | 'partly reversed' | 'reversed';

export interface TipView {
  paymentId: string;
  viewer: string;
  message: string;
  captured: bigint;
  refunded: bigint;
  chargedBack: bigint;
  /** captured − refunded − chargedBack. */
  remaining: bigint;
  /** Reversals core refused because they exceeded what was left. */
  rejectedReversals: number;
  status: TipStatus;
}

export interface CoffinCheck {
  id: 'residual' | 'ledger-sum' | 'clearing' | 'over-cap';
  label: string;
  ok: boolean;
  detail: string;
}

export interface CoffinReport {
  tipCount: number;
  totalIn: bigint;
  refunds: bigint;
  chargebacks: bigint;
  totalOut: bigint;
  held: bigint;
  /** totalIn − totalOut − held. Must be 0. */
  residual: bigint;
  clearing: bigint;
  ledgerSum: bigint;
  overCapTipCount: number;
  defenses: { duplicates: number; staleRejected: number; parked: number; rejectedReversals: number };
  checks: CoffinCheck[];
  balanced: boolean;
}

export interface DeliveryRow {
  seq: string;
  eventId: string;
  type: string;
  attempt: number;
  mode: DeliveryMode;
  status: number | null;
  outcome: Outcome;
}

const big = (v: unknown): bigint => BigInt(String(v ?? '0'));

/*
 * Inbox filters shared by tips() and coffin(). An event moved money only if
 * core marked it applied and linked a ledger transaction.
 */
const APPLIED = sql`w.status = 'applied' AND w.ledger_transaction_id IS NOT NULL`;
const IS_CHARGEBACK = sql`(w.raw_body::jsonb ->> 'reason') = 'chargeback'`;

/** Every tip in the jar, newest first; or only `paymentId`'s, when given. */
export async function tips(db: Db, jar: JarRef, paymentId?: string): Promise<TipView[]> {
  const only = paymentId === undefined ? sql`` : sql`AND t.payment_id = ${paymentId}`;
  const r = await db.execute(sql`
    SELECT t.payment_id, t.viewer, t.message,
      coalesce(sum(w.amount) FILTER (WHERE w.type = 'payment.captured' AND ${APPLIED}), 0)::text AS captured,
      coalesce(sum(w.amount) FILTER (WHERE w.type = 'payment.refunded' AND ${APPLIED} AND NOT coalesce(${IS_CHARGEBACK}, false)), 0)::text AS refunded,
      coalesce(sum(w.amount) FILTER (WHERE w.type = 'payment.refunded' AND ${APPLIED} AND coalesce(${IS_CHARGEBACK}, false)), 0)::text AS charged_back,
      count(w.event_id) FILTER (WHERE w.type = 'payment.refunded' AND w.status = 'rejected')::int AS rejected
    FROM tipjar_tips t
    JOIN tipjar_rail_requests q ON q.key = t.request_key
    LEFT JOIN webhook_events w ON w.payment_id = t.payment_id
    WHERE t.jar_id = ${jar.id} ${only}
    GROUP BY t.payment_id, t.viewer, t.message, q.seq
    ORDER BY q.seq DESC`);
  return r.rows.map((row) => {
    const captured = big(row['captured']);
    const refunded = big(row['refunded']);
    const chargedBack = big(row['charged_back']);
    const remaining = captured - refunded - chargedBack;
    const status: TipStatus =
      captured === 0n ? 'pending' : remaining <= 0n ? 'reversed' : refunded + chargedBack > 0n ? 'partly reversed' : 'arrived';
    return {
      paymentId: String(row['payment_id']),
      viewer: String(row['viewer']),
      message: String(row['message']),
      captured,
      refunded,
      chargedBack,
      remaining,
      rejectedReversals: Number(row['rejected']),
      status,
    };
  });
}

export async function coffin(db: Db, jar: JarRef): Promise<CoffinReport> {
  // Source 1: core's inbox, scoped to this jar's tips.
  const inbox = await db.execute(sql`
    WITH per_tip AS (
      SELECT t.payment_id,
        coalesce(sum(w.amount) FILTER (WHERE w.type = 'payment.captured' AND ${APPLIED}), 0) AS captured,
        coalesce(sum(w.amount) FILTER (WHERE w.type = 'payment.refunded' AND ${APPLIED} AND NOT coalesce(${IS_CHARGEBACK}, false)), 0) AS refunded,
        coalesce(sum(w.amount) FILTER (WHERE w.type = 'payment.refunded' AND ${APPLIED} AND coalesce(${IS_CHARGEBACK}, false)), 0) AS charged_back,
        count(w.event_id) FILTER (WHERE w.type = 'payment.refunded' AND w.status = 'rejected') AS rejected
      FROM tipjar_tips t LEFT JOIN webhook_events w ON w.payment_id = t.payment_id
      WHERE t.jar_id = ${jar.id}
      GROUP BY t.payment_id
    )
    SELECT count(*)::int AS tip_count,
      coalesce(sum(captured), 0)::text AS total_in,
      coalesce(sum(refunded), 0)::text AS refunds,
      coalesce(sum(charged_back), 0)::text AS chargebacks,
      count(*) FILTER (WHERE refunded + charged_back > captured)::int AS over_cap,
      coalesce(sum(rejected), 0)::int AS rejected
    FROM per_tip`);

  // Source 2: core's ledger entries on the jar's two accounts.
  const ledger = await db.execute(sql`
    SELECT
      coalesce(sum(amount) FILTER (WHERE account_id = ${jar.jarAccountId}), 0)::text AS jar,
      coalesce(sum(amount) FILTER (WHERE account_id = ${jar.clearingAccountId}), 0)::text AS clearing,
      coalesce(sum(amount), 0)::text AS total
    FROM entries WHERE account_id IN (${jar.jarAccountId}, ${jar.clearingAccountId})`);

  // The rail's delivery log: how many deliveries each defense absorbed.
  const log = await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE outcome = 'duplicate')::int AS duplicates,
      count(*) FILTER (WHERE outcome = 'unauthorized')::int AS stale,
      count(*) FILTER (WHERE outcome = 'parked')::int AS parked
    FROM tipjar_deliveries WHERE jar_id = ${jar.id}`);

  const i = inbox.rows[0]!;
  const l = ledger.rows[0]!;
  const d = log.rows[0]!;
  const totalIn = big(i['total_in']);
  const refunds = big(i['refunds']);
  const chargebacks = big(i['chargebacks']);
  const totalOut = refunds + chargebacks;
  // The jar account is a revenue account: credit-normal, so it holds minus its entry sum.
  const held = -big(l['jar']);
  const clearing = big(l['clearing']);
  const ledgerSum = big(l['total']);
  const overCapTipCount = Number(i['over_cap']);
  const residual = totalIn - totalOut - held;

  const checks: CoffinCheck[] = [
    { id: 'residual', label: 'In − out − held = 0', ok: residual === 0n, detail: residual.toString() },
    { id: 'ledger-sum', label: 'Jar ledger sums to zero', ok: ledgerSum === 0n, detail: ledgerSum.toString() },
    {
      id: 'clearing',
      label: 'Rail clearing = in − out',
      ok: clearing === totalIn - totalOut,
      detail: (clearing - (totalIn - totalOut)).toString(),
    },
    { id: 'over-cap', label: 'No tip reversed beyond what it received', ok: overCapTipCount === 0, detail: String(overCapTipCount) },
  ];

  return {
    tipCount: Number(i['tip_count']),
    totalIn,
    refunds,
    chargebacks,
    totalOut,
    held,
    residual,
    clearing,
    ledgerSum,
    overCapTipCount,
    defenses: {
      duplicates: Number(d['duplicates']),
      staleRejected: Number(d['stale']),
      parked: Number(d['parked']),
      rejectedReversals: Number(i['rejected']),
    },
    checks,
    balanced: checks.every((c) => c.ok),
  };
}

export async function deliveries(db: Db, jar: JarRef, limit = 50): Promise<DeliveryRow[]> {
  const r = await db.execute(sql`
    SELECT seq::text AS seq, event_id, type, attempt, mode, status, outcome
    FROM tipjar_deliveries WHERE jar_id = ${jar.id} ORDER BY seq DESC LIMIT ${limit}`);
  return r.rows.map((row) => ({
    seq: String(row['seq']),
    eventId: String(row['event_id']),
    type: String(row['type']),
    attempt: Number(row['attempt']),
    mode: row['mode'] as DeliveryMode,
    status: row['status'] === null ? null : Number(row['status']),
    outcome: row['outcome'] as Outcome,
  }));
}
