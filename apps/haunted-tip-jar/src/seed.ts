/*
 * Demo tips so the first screen is never empty (Requirement 1.2). Every one
 * goes through the rail and core's handler, exactly like a real tip: the seed
 * has no shortcut into the ledger. It includes a partial refund, a full
 * chargeback, and an over-cap refund that core rejects.
 */
import type { TipJar } from './jar';
import { UNIT } from './money';

export interface SeedTip {
  viewer: string;
  amount: bigint;
  message: string;
}

export const SEED_TIPS: readonly SeedTip[] = [
  { viewer: 'Casper', amount: 5n * UNIT, message: 'Boo! Love the stream' },
  { viewer: 'Moaning Myrtle', amount: 12_500_000n, message: 'For the new mic' },
  { viewer: 'Headless Nick', amount: 3n * UNIT, message: 'Keep your head up' },
  { viewer: 'Bloody Mary', amount: 20n * UNIT, message: 'Say my name three times' },
  { viewer: 'Slimer', amount: 1_250_000n, message: 'nom nom' },
];

export interface SeedResult {
  paymentIds: string[];
}

const key = () => globalThis.crypto.randomUUID();

export async function seedJar(jar: TipJar): Promise<SeedResult> {
  const paymentIds: string[] = [];
  for (const t of SEED_TIPS) {
    const r = await jar.sendTip(key(), t);
    if (!r.ok) throw new Error(`seed tip failed: ${r.error}`);
    paymentIds.push(r.paymentId);
  }
  const [, myrtle, nick, mary] = paymentIds as [string, string, string, string, string];

  // Partial refund: the creator gives Myrtle 2.5 back.
  await jar.reverse(key(), { paymentId: myrtle, amount: 2_500_000n, reason: 'refund' });
  // Full chargeback: the bank pulls Nick's 3 USDC.
  await jar.reverse(key(), { paymentId: nick, amount: 3n * UNIT, reason: 'chargeback' });
  // Refund Mary 5, then a chargeback for her full 20 exceeds what is left: core rejects it.
  await jar.reverse(key(), { paymentId: mary, amount: 5n * UNIT, reason: 'refund' });
  await jar.reverse(key(), { paymentId: mary, amount: 20n * UNIT, reason: 'chargeback' });
  return { paymentIds };
}

/**
 * What the seed leaves in the jar, per tip: Casper 5, Myrtle 12.5 − 2.5, Nick 3 − 3, Mary 20 − 5, Slimer 1.25.
 * 41.75 in, 10.5 out, 31.25 held.
 */
export const SEED_HELD = 5n * UNIT + (12_500_000n - 2_500_000n) + (3n * UNIT - 3n * UNIT) + (20n * UNIT - 5n * UNIT) + 1_250_000n;
