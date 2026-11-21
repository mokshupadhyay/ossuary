/*
 * The jar service (design D5): one active jar per database, archived rather
 * than deleted on reset. Composes the simulated rail with core's accounts.
 * The jar never posts ledger entries itself; every movement arrives as a
 * signed webhook through the rail and core's handler.
 */
import { sql } from 'drizzle-orm';
import { createAccount, type Clock } from '@ossuary/core';
import type { Db } from './db';
import { ASSET } from './money';
import { createRail, type Rail, type RailResult, type Reason, type TipRequest, type JarRef } from './rail';
import {
  coffin as readCoffin,
  deliveries as readDeliveries,
  tips as readTips,
  type CoffinReport,
  type DeliveryRow,
  type TipView,
} from './readModel';
import { drainOutbox, type OverlayBus } from './overlayBus';
import { seedJar } from './seed';

export interface JarInfo {
  creator: string;
  goal: bigint;
  asset: typeof ASSET;
}

export interface TipJar {
  readonly jarId: string;
  readonly ref: JarRef;
  readonly info: JarInfo;
  readonly rail: Rail;
  sendTip(key: string, req: TipRequest): Promise<RailResult>;
  reverse(key: string, req: { paymentId: string; amount: bigint; reason: Reason }): Promise<RailResult>;
  setHaunted(on: boolean): void;
  tips(): Promise<TipView[]>;
  coffin(): Promise<CoffinReport>;
  deliveries(limit?: number): Promise<DeliveryRow[]>;
  /** Sends pending outbox messages to the overlay bus (design D7). Returns how many were published. */
  drainOutbox(): Promise<number>;
}

export interface OpenJarOptions {
  clock: Clock;
  haunted?: boolean;
  /** Seed new jars with demo tips. Default true. */
  seed?: boolean;
  /** Creator and goal for a new jar. */
  creator?: string;
  goal?: bigint;
  /** Where overlay alerts go. Without one, drainOutbox acknowledges messages without publishing. */
  bus?: Pick<OverlayBus, 'publish'>;
}

export const DEFAULT_CREATOR = 'Spooky Streams';
export const DEFAULT_GOAL = 100_000_000n; // 100 USDC

/** 32 random bytes as hex. A simulated rail secret, never a real key (design D5). */
function newRailSecret(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function wrap(db: Db, ref: JarRef, info: JarInfo, options: OpenJarOptions): Promise<TipJar> {
  const rail = await createRail(db, ref, { clock: options.clock, haunted: options.haunted ?? false });
  return {
    jarId: ref.id,
    ref,
    info,
    rail,
    sendTip: (key, req) => rail.sendTip(key, req),
    reverse: (key, req) => rail.reverse(key, req),
    setHaunted: (on) => rail.setHaunted(on),
    tips: () => readTips(db, ref),
    coffin: () => readCoffin(db, ref),
    deliveries: (limit) => readDeliveries(db, ref, limit),
    drainOutbox: () => drainOutbox(db, ref, { clock: options.clock, bus: options.bus ?? { publish: () => {} } }),
  };
}

/** Creates a new jar with fresh core accounts. Does not archive the current one. */
export async function createJar(db: Db, options: OpenJarOptions): Promise<TipJar> {
  const id = globalThis.crypto.randomUUID();
  const jarAccountId = globalThis.crypto.randomUUID();
  const clearingAccountId = globalThis.crypto.randomUUID();
  const creator = options.creator ?? DEFAULT_CREATOR;
  const goal = options.goal ?? DEFAULT_GOAL;
  const railSecret = newRailSecret();

  await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    await createAccount(t, { accountId: jarAccountId, name: `tip jar ${id}`, type: 'revenue' });
    await createAccount(t, { accountId: clearingAccountId, name: `rail clearing ${id}`, type: 'asset', allowOverdraft: true });
    await tx.execute(sql`
      INSERT INTO tipjar_jars (id, creator, goal, jar_account_id, clearing_account_id, rail_secret)
      VALUES (${id}, ${creator}, ${goal}, ${jarAccountId}, ${clearingAccountId}, ${railSecret})`);
  });

  const jar = await wrap(db, { id, jarAccountId, clearingAccountId, railSecret }, { creator, goal, asset: ASSET }, options);
  if (options.seed ?? true) {
    // The seed is never haunted, so the delivery log starts clean.
    const wasHaunted = jar.rail.haunted;
    jar.setHaunted(false);
    await seedJar(jar);
    jar.setHaunted(wasHaunted);
  }
  return jar;
}

/** The active jar, or a new seeded one if there is none. */
export async function openJar(db: Db, options: OpenJarOptions): Promise<TipJar> {
  const r = await db.execute(sql`
    SELECT id, creator, goal::text AS goal, jar_account_id, clearing_account_id, rail_secret
    FROM tipjar_jars WHERE archived_at IS NULL ORDER BY created_at DESC LIMIT 1`);
  const row = r.rows[0];
  if (!row) return createJar(db, options);
  const ref: JarRef = {
    id: String(row['id']),
    jarAccountId: String(row['jar_account_id']),
    clearingAccountId: String(row['clearing_account_id']),
    railSecret: String(row['rail_secret']),
  };
  return wrap(db, ref, { creator: String(row['creator']), goal: BigInt(String(row['goal'])), asset: ASSET }, options);
}

/** Archives every active jar and creates a fresh seeded one. Nothing is deleted. */
export async function resetJar(db: Db, options: OpenJarOptions): Promise<TipJar> {
  await db.execute(sql`UPDATE tipjar_jars SET archived_at = now() WHERE archived_at IS NULL`);
  return createJar(db, options);
}
