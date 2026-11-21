import {
  generateStorm,
  ossuaryFactory,
  summon,
  twinFactory,
  type PoltergeistReport,
} from '@ossuary/core/poltergeist';
import type { TontineService } from './service';

/*
 * Summon the Poltergeist (Requirement 10, design T5). One seeded storm, thrown
 * live in the page at Ossuary on the App's own database (Core's real webhook
 * handler, payout glue and outbox, on the same ledger the circle uses) and at
 * the Vibe Pay twin on its own in-memory database. The circle's books are
 * checked before and after.
 */

export const STORM_SIZES = [200, 500, 2000] as const;
export type StormSize = (typeof STORM_SIZES)[number];
export const DEFAULT_SEED = 7;
export const MAX_SEED = 4_294_967_295;

export type SeancePhase = 'ossuary' | 'twin' | 'books';

export interface BooksSnapshot {
  pot: bigint;
  wallets: bigint[];
  moneyIn: bigint;
  ledgerSum: bigint;
}

export interface SeanceResult {
  seed: number;
  size: StormSize;
  ossuary: PoltergeistReport;
  twin: PoltergeistReport;
  books: {
    circleName: string | null;
    before: BooksSnapshot | null;
    after: BooksSnapshot | null;
    unchanged: boolean;
    /** Sum of every entry in the App's database after the storm. */
    ledgerSum: bigint;
  };
}

export class SeanceInputError extends Error {}

async function books(service: TontineService, circleId: string | null): Promise<{ name: string; snap: BooksSnapshot } | null> {
  if (circleId === null) return null;
  const v = await service.view(circleId);
  return { name: v.name, snap: { pot: v.pot, wallets: v.members.map((m) => m.wallet), moneyIn: v.moneyIn, ledgerSum: v.ledgerSum } };
}

const same = (a: BooksSnapshot, b: BooksSnapshot) =>
  a.pot === b.pot && a.moneyIn === b.moneyIn && a.ledgerSum === b.ledgerSum && a.wallets.length === b.wallets.length && a.wallets.every((w, i) => w === b.wallets[i]);

export async function runSeance(
  service: TontineService,
  circleId: string | null,
  options: { seed: number; size: StormSize; onPhase?: (phase: SeancePhase) => void },
): Promise<SeanceResult> {
  const { seed, size } = options;
  if (!Number.isInteger(seed) || seed < 0 || seed > MAX_SEED) throw new SeanceInputError(`The seed must be a whole number from 0 to ${MAX_SEED}.`);
  if (!STORM_SIZES.includes(size)) throw new SeanceInputError(`The storm size must be one of ${STORM_SIZES.join(', ')}.`);

  const before = await books(service, circleId);
  const storm = generateStorm({ seed, size, ensureEveryFault: true });

  options.onPhase?.('ossuary');
  const ossuary = await summon({ storm, factory: ossuaryFactory({ client: service.ledger.client }), target: 'ossuary' });
  options.onPhase?.('twin');
  const twin = await summon({ storm, factory: twinFactory(), target: 'twin' });

  options.onPhase?.('books');
  const after = await books(service, circleId);
  return {
    seed,
    size,
    ossuary,
    twin,
    books: {
      circleName: before?.name ?? null,
      before: before?.snap ?? null,
      after: after?.snap ?? null,
      unchanged: before !== null && after !== null && same(before.snap, after.snap),
      ledgerSum: await service.ledgerSum(),
    },
  };
}
