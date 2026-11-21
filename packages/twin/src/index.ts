// Vibe Pay payments backend. Amounts are USDC base units (6 decimals).
// Every state change is a single SQL statement, so it is atomic even when
// requests overlap on one connection. No explicit transactions are needed.

export interface Db {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

type WebhookType = "payment.pending" | "payment.captured" | "payment.refunded";

interface WebhookEvent {
  id: string;
  type: WebhookType;
  paymentId: string;
  circleId: string;
  memberId: string;
  amount: string;
}

interface Payout {
  circleId: string;
  memberId: string;
  amount: string;
}

const WEBHOOK_TYPES: readonly string[] = ["payment.pending", "payment.captured", "payment.refunded"];
const CHECK_VIOLATION = "23514";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** Accepts a positive integer as a digit string (or a safe integer number) and returns it as a string. */
function parseAmount(v: unknown): string | null {
  const s = typeof v === "number" && Number.isSafeInteger(v) ? String(v) : v;
  if (typeof s !== "string" || !/^\d+$/.test(s)) return null;
  return /^0+$/.test(s) ? null : s.replace(/^0+(?=\d)/, "");
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await req.json();
    return isObject(body) ? body : null;
  } catch {
    return null;
  }
}

function parseWebhook(body: Record<string, unknown>): WebhookEvent | null {
  const amount = parseAmount(body.amount);
  const { id, type, paymentId, circleId, memberId, asset } = body;
  if (!isId(id) || !isId(paymentId) || !isId(circleId) || !isId(memberId)) return null;
  if (typeof type !== "string" || !WEBHOOK_TYPES.includes(type)) return null;
  if (asset !== "USDC" || amount === null) return null;
  return { id, type: type as WebhookType, paymentId, circleId, memberId, amount };
}

function parsePayout(body: Record<string, unknown>): Payout | null {
  const amount = parseAmount(body.amount);
  const { circleId, memberId } = body;
  if (!isId(circleId) || !isId(memberId) || amount === null) return null;
  return { circleId, memberId, amount };
}

export function createVibePay(db: Db) {
  async function init(): Promise<void> {
    await db.query(`CREATE TABLE IF NOT EXISTS circles (
      circle_id text PRIMARY KEY,
      pot numeric NOT NULL DEFAULT 0 CHECK (pot >= 0)
    )`);
    await db.query(`CREATE TABLE IF NOT EXISTS members (
      circle_id text NOT NULL,
      member_id text NOT NULL,
      paid_out numeric NOT NULL DEFAULT 0,
      PRIMARY KEY (circle_id, member_id)
    )`);
    await db.query(`CREATE TABLE IF NOT EXISTS payments (
      payment_id text PRIMARY KEY,
      circle_id text NOT NULL,
      member_id text NOT NULL,
      amount numeric NOT NULL,
      status text NOT NULL CHECK (status IN ('pending', 'captured', 'refunded'))
    )`);
  }

  // Moves a payment to 'captured' (once) and adds it to the pot.
  // A retried or out-of-order event finds the status already moved on and does nothing.
  async function capture(e: WebhookEvent): Promise<void> {
    await db.query(
      `WITH moved AS (
         INSERT INTO payments (payment_id, circle_id, member_id, amount, status)
         VALUES ($1, $2, $3, $4, 'captured')
         ON CONFLICT (payment_id) DO UPDATE SET status = 'captured'
           WHERE payments.status = 'pending'
         RETURNING circle_id, amount
       )
       INSERT INTO circles (circle_id, pot)
       SELECT circle_id, amount FROM moved
       ON CONFLICT (circle_id) DO UPDATE SET pot = circles.pot + EXCLUDED.pot`,
      [e.paymentId, e.circleId, e.memberId, e.amount],
    );
  }

  // Moves a captured payment to 'refunded' and removes its stored amount from the pot.
  // Returns false if the payment was never captured, so the provider can retry later.
  async function refund(e: WebhookEvent): Promise<boolean> {
    const done = await db.query(
      `WITH moved AS (
         UPDATE payments SET status = 'refunded'
         WHERE payment_id = $1 AND status = 'captured'
         RETURNING circle_id, amount
       )
       UPDATE circles SET pot = circles.pot - moved.amount
       FROM moved WHERE circles.circle_id = moved.circle_id
       RETURNING 1`,
      [e.paymentId],
    );
    if (done.rows.length > 0) return true;
    const current = await db.query(`SELECT status FROM payments WHERE payment_id = $1`, [e.paymentId]);
    return current.rows[0]?.status === "refunded"; // duplicate delivery counts as success
  }

  async function handleWebhook(req: Request): Promise<Response> {
    const body = await readJson(req);
    const event = body && parseWebhook(body);
    if (!event) return json(400, { error: "invalid webhook" });

    try {
      if (event.type === "payment.pending") {
        await db.query(
          `INSERT INTO payments (payment_id, circle_id, member_id, amount, status)
           VALUES ($1, $2, $3, $4, 'pending') ON CONFLICT (payment_id) DO NOTHING`,
          [event.paymentId, event.circleId, event.memberId, event.amount],
        );
      } else if (event.type === "payment.captured") {
        await capture(event);
      } else if (!(await refund(event))) {
        return json(409, { error: "payment is not captured" });
      }
    } catch (err) {
      // The pot cannot go negative, e.g. a refund of money that was already paid out.
      if (isObject(err) && err.code === CHECK_VIOLATION) {
        return json(409, { error: "pot too small to refund" });
      }
      throw err;
    }
    return json(200, { ok: true });
  }

  async function handlePayout(req: Request): Promise<Response> {
    const body = await readJson(req);
    const payout = body && parsePayout(body);
    if (!payout) return json(400, { error: "invalid payout" });

    // The pot is only reduced when it covers the amount; the member is credited in the same statement.
    const done = await db.query(
      `WITH debited AS (
         UPDATE circles SET pot = pot - $3::numeric
         WHERE circle_id = $1 AND pot >= $3::numeric
         RETURNING circle_id
       )
       INSERT INTO members (circle_id, member_id, paid_out)
       SELECT circle_id, $2, $3::numeric FROM debited
       ON CONFLICT (circle_id, member_id) DO UPDATE SET paid_out = members.paid_out + EXCLUDED.paid_out
       RETURNING 1`,
      [payout.circleId, payout.memberId, payout.amount],
    );
    if (done.rows.length === 0) return json(400, { error: "pot too small" });
    return json(200, { ok: true });
  }

  async function getBalances(circleId: string): Promise<{ pot: number; members: Record<string, number> }> {
    const pot = await db.query(`SELECT pot FROM circles WHERE circle_id = $1`, [circleId]);
    const members = await db.query(`SELECT member_id, paid_out FROM members WHERE circle_id = $1`, [circleId]);
    const result: Record<string, number> = {};
    for (const row of members.rows) result[String(row.member_id)] = Number(row.paid_out);
    return { pot: pot.rows[0] ? Number(pot.rows[0].pot) : 0, members: result };
  }

  return { init, handleWebhook, handlePayout, getBalances };
}
