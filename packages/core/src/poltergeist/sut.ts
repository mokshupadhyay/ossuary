import { PGlite } from '@electric-sql/pglite';
import { count, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  DuplicateKeyError,
  InvalidFieldError,
  KeyInFlightError,
  NormalBalanceViolationError,
} from '../errors/index.js';
import { createAccount } from '../ledger/accounts.js';
import { postTransaction } from '../ledger/postTransaction.js';
import { runOutboxOnce } from '../outbox/worker.js';
import { entries, outboxMessages } from '../schema/index.js';
import { createWebhookHandler } from '../webhooks/handler.js';
import { verifyWebhook } from '../webhooks/verify.js';
import type { FakeClock } from './clock.js';
import { createCrashingDb, type CrashingDb } from './crash.js';
import type { DefenseId } from './faults.js';
import { applyEmbeddedMigrations } from './migrate.js';
import type { Target } from './report.js';
import { fakeSender } from './sender.js';
import type { CrashPlan } from './storm.js';

/*
 * The system-under-test interface (Requirement 4) and the Ossuary adapter
 * (Requirement 5). Browser-safe (design D8): no Node built-ins here; the
 * fresh-database path uses the embedded migrations, never runMigrations.
 */

export type { Target } from './report.js';
export type { CrashPlan } from './storm.js';
export type Route = 'webhook' | 'payout';

export interface DeliverOptions {
  route: Route;
  crash?: CrashPlan;
}

export interface DeliveryResult {
  /** `null` when the SUT crashed before a response reached the caller. */
  status: number | null;
  crashed: boolean;
  defense: DefenseId | null;
}

export interface BalanceSnapshot {
  asset: string;
  pot: bigint;
  /** Concrete member id → wallet, in minor units. */
  members: ReadonlyMap<string, bigint>;
  /** Twin only: balances that were not whole minor units (Requirement 11.4). */
  fractional?: readonly { memberId: string | null; value: string }[];
}

export interface SystemUnderTest {
  readonly target: Target;
  deliver(rawBody: string, headers: Readonly<Record<string, string>>, options: DeliverOptions): Promise<DeliveryResult>;
  balances(): Promise<BalanceSnapshot>;
  settle(): Promise<void>;
  close(): Promise<void>;
}

export interface SutContext {
  circleId: string;
  memberIds: readonly string[];
  asset: string;
  clock: FakeClock;
  secret: string;
  runTag: string;
}

export type SutFactory = (ctx: SutContext) => Promise<SystemUnderTest>;

const OUTBOX_LEASE_MS = 60_000;
const OUTBOX_BATCH = 500;

interface OssuaryInternals {
  crashing: CrashingDb;
  db: Db;
  potAccountId: string;
  walletByMember: ReadonlyMap<string, string>;
  /** Transaction ids this instance has returned for payouts (idempotency-key defense). */
  seenTransactions: Set<string>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AMOUNT_RE = /^[1-9][0-9]{0,18}$/;
const INT8_MAX = 9223372036854775807n;

export interface PayoutResponse {
  status: 200 | 400 | 409 | 422 | 500;
  body: { ok: boolean; transactionId?: string; error?: string };
}

function header(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name) return v;
  return undefined;
}

/**
 * The tontine's "pay the pot to a member" endpoint, as glue over
 * postTransaction (design D2): a `transfer` that debits the pot (revenue)
 * and credits the member's wallet (liability), under the client's
 * Idempotency-Key. The pot's normal-balance check stops it going negative.
 */
async function payout(
  db: Db,
  circle: { circleId: string; potAccountId: string; walletByMember: ReadonlyMap<string, string> },
  rawBody: string,
  headers: Readonly<Record<string, string>>,
): Promise<PayoutResponse> {
  const bad = (error: string): PayoutResponse => ({ status: 400, body: { ok: false, error } });
  const key = header(headers, 'idempotency-key');
  if (key === undefined || !UUID_RE.test(key)) return bad('idempotency-key: must be a UUID');
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return bad('body: invalid JSON');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return bad('body: must be a JSON object');
  const { circleId, memberId, amount } = body as Record<string, unknown>;
  if (typeof circleId !== 'string' || circleId.toLowerCase() !== circle.circleId) return bad('circleId: unknown circle');
  const wallet = typeof memberId === 'string' ? circle.walletByMember.get(memberId.toLowerCase()) : undefined;
  if (wallet === undefined) return bad('memberId: not a member of this circle');
  if (typeof amount !== 'string' || !AMOUNT_RE.test(amount)) return bad('amount: must be a decimal string of minor units');
  const value = BigInt(amount);
  if (value > INT8_MAX) return bad('amount: exceeds the maximum amount');
  try {
    const r = await postTransaction(db, {
      idempotencyKey: key.toLowerCase(),
      kind: 'transfer',
      entries: [
        { accountId: circle.potAccountId, amount: value },
        { accountId: wallet, amount: -value },
      ],
    });
    return { status: 200, body: { ok: true, transactionId: r.transactionId } };
  } catch (e) {
    if (e instanceof DuplicateKeyError || e instanceof KeyInFlightError) return { status: 409, body: { ok: false, error: 'conflict' } };
    if (e instanceof NormalBalanceViolationError) return { status: 422, body: { ok: false, error: 'insufficient pot' } };
    if (e instanceof InvalidFieldError) return bad(`${e.field}: ${e.reason}`);
    return { status: 500, body: { ok: false, error: 'internal' } };
  }
}

/** Test hook: the internals of an Ossuary adapter instance (accounts, crashing db). */
export const ossuaryInternals = new WeakMap<SystemUnderTest, OssuaryInternals>();

/**
 * Ossuary through its real building blocks. With no client, each instance
 * gets a fresh in-memory PGlite migrated from the embedded migrations; with a
 * client, instances share it and stay apart by run tag and fresh accounts.
 */
export function ossuaryFactory(options: { client?: PGlite } = {}): SutFactory {
  return (ctx) => createOssuarySut(ctx, options.client);
}

async function createOssuarySut(ctx: SutContext, shared?: PGlite): Promise<SystemUnderTest> {
  const client = shared ?? new PGlite();
  const crashing = createCrashingDb(client);
  const db = crashing.db;
  try {
    if (!shared) await applyEmbeddedMigrations(db);

    const newId = () => globalThis.crypto.randomUUID();
    const account = async (name: string, type: 'asset' | 'revenue' | 'liability', allowOverdraft = false) => {
      const accountId = newId();
      await createAccount(db, { accountId, name: `poltergeist ${ctx.runTag} ${name}`, type, allowOverdraft });
      return accountId;
    };
    const clearingAccountId = await account('clearing', 'asset', true);
    const potAccountId = await account('pot', 'revenue');
    const walletByMember = new Map<string, string>();
    for (const [i, memberId] of ctx.memberIds.entries()) {
      walletByMember.set(memberId.toLowerCase(), await account(`wallet ${i}`, 'liability'));
    }

    const handler = await createWebhookHandler(db, {
      secret: ctx.secret,
      asset: ctx.asset,
      clearingAccountId,
      revenueAccountId: potAccountId,
      clock: ctx.clock,
    });

    const seenTransactions = new Set<string>();
    const handlePayout = (rawBody: string, headers: Readonly<Record<string, string>>) =>
      payout(db, { circleId: ctx.circleId, potAccountId, walletByMember }, rawBody, headers);

    const sut: SystemUnderTest = {
      target: 'ossuary',

      async deliver(rawBody, headers, options) {
        // Crash model (design D5): crash before the SUT's k-th SQL statement of this
        // delivery; if it finishes in k statements or fewer, crash after it finished,
        // before the response reaches the caller.
        const firedBefore = crashing.fired;
        if (options.crash) crashing.arm({ at: 'statement', index: options.crash.beforeStep });

        let status: number;
        let defense: DefenseId | null = null;
        if (options.route === 'payout') {
          const res = await handlePayout(rawBody, headers);
          status = res.status;
          const tx = res.body.transactionId;
          if (res.status === 200 && tx !== undefined) {
            if (seenTransactions.has(tx)) defense = 'idempotency-key';
            seenTransactions.add(tx);
          }
        } else {
          const res = await handler({ rawBody, headers });
          status = res.status;
          if (res.status === 200 && res.body.outcome === 'duplicate') defense = 'inbox-dedupe';
          else if (res.status === 200 && res.body.outcome === 'parked') defense = 'parking';
          else if (res.status === 401) {
            // The handler hides the reason on purpose; the adapter holds the same inputs.
            const v = verifyWebhook({ secret: ctx.secret, rawBody, headers, clock: ctx.clock });
            defense = !v.ok && (v.reason === 'stale' || v.reason === 'future') ? 'timestamp-check' : 'signature-check';
          }
        }

        // Every Ossuary write runs inside a transaction, so a statement crash precedes commit.
        if (crashing.fired > firedBefore) return { status: null, crashed: true, defense: 'rollback' };
        if (options.crash && crashing.armed) {
          crashing.disarm();
          return { status: null, crashed: true, defense: null };
        }
        return { status, crashed: false, defense };
      },

      async balances() {
        const ids = [potAccountId, ...walletByMember.values()];
        const rows = await db
          .select({ accountId: entries.accountId, total: sql<string>`coalesce(sum(${entries.amount}), 0)::text` })
          .from(entries)
          .where(inArray(entries.accountId, ids))
          .groupBy(entries.accountId);
        const sum = new Map(rows.map((r) => [r.accountId, BigInt(r.total)]));
        // Pot (revenue) and wallets (liability) are credit-normal: holdings are the negated sums.
        const held = (id: string) => -(sum.get(id) ?? 0n);
        return {
          asset: ctx.asset,
          pot: held(potAccountId),
          members: new Map([...walletByMember].map(([memberId, acct]) => [memberId, held(acct)])),
        };
      },

      async settle() {
        const pending = async () => {
          const [row] = await db.select({ n: count() }).from(outboxMessages).where(eq(outboxMessages.status, 'pending'));
          return Number(row?.n ?? 0);
        };
        const { sender } = fakeSender();
        const bound = (await pending()) + 1;
        for (let round = 0; round <= bound; round++) {
          const r = await runOutboxOnce(db, { sender, clock: ctx.clock, batchSize: OUTBOX_BATCH, leaseMs: OUTBOX_LEASE_MS });
          if (r.claimed > 0) continue;
          if ((await pending()) === 0) return;
          ctx.clock.advance(OUTBOX_LEASE_MS + 1);
        }
        throw new Error(`ossuary settle: outbox not drained after ${bound + 1} rounds`);
      },

      async close() {
        if (!shared) await client.close();
      },
    };
    ossuaryInternals.set(sut, { crashing, db, potAccountId, walletByMember, seenTransactions });
    return sut;
  } catch (e) {
    if (!shared) await client.close();
    throw e;
  }
}
