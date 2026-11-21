import { PGlite } from '@electric-sql/pglite';
import { createVibePay } from '@ossuary/twin';
import { SimulatedCrash } from './crash.js';
import type { BalanceSnapshot, SutContext, SutFactory, SystemUnderTest } from './sut.js';

/*
 * The Vibe Pay twin behind the SUT interface (Requirement 11). The twin is
 * generated code and never edited; this adapter is the only place that
 * adapts to it. Browser-safe (design D8).
 *
 * Crash model (design D5): the twin's k-th database statement of a delivery
 * fails, and so does every later statement of that delivery, because its
 * process is dead. What it already ran stays committed: it uses no
 * transactions. A delivery that finishes in k statements or fewer crashes
 * after it finished, before its response reaches the caller.
 */

/**
 * Twin instances share a supplied client safely: tests/unit/twin.test.ts shows
 * its `init` is idempotent and its rows are keyed by circle, so two circles on
 * one database never see each other's balances (Requirement 11.1).
 */
export function twinFactory(options: { client?: PGlite } = {}): SutFactory {
  return (ctx) => createTwinSut(ctx, options.client);
}

async function createTwinSut(ctx: SutContext, shared?: PGlite): Promise<SystemUnderTest> {
  const client = shared ?? new PGlite();
  let statement = 0;
  let crashAt: number | null = null;
  let dead = false;

  const db = {
    async query(text: string, params?: unknown[]) {
      if (dead) throw new SimulatedCrash('(process already dead)');
      if (crashAt !== null && statement === crashAt) {
        dead = true;
        crashAt = null;
        throw new SimulatedCrash(`before statement ${statement}`);
      }
      statement += 1;
      const r = await client.query<Record<string, unknown>>(text, params);
      return { rows: r.rows };
    },
  };

  const twin = createVibePay(db);
  try {
    await twin.init();
  } catch (e) {
    if (!shared) await client.close();
    throw e;
  }

  return {
    target: 'twin',

    async deliver(rawBody, headers, options) {
      statement = 0;
      dead = false;
      crashAt = options.crash ? options.crash.beforeStep : null;
      const request = new Request(`http://twin.local/${options.route}`, { method: 'POST', headers: { ...headers }, body: rawBody });
      let status: number | null = null;
      try {
        const res = options.route === 'payout' ? await twin.handlePayout(request) : await twin.handleWebhook(request);
        status = res.status;
      } catch {
        status = null;
      }
      const crashed = dead || status === null || crashAt !== null;
      crashAt = null;
      dead = false;
      if (crashed) return { status: null, crashed: true, defense: null };
      return { status, crashed: false, defense: null };
    },

    async balances(): Promise<BalanceSnapshot> {
      const b = await twin.getBalances(ctx.circleId);
      const fractional: { memberId: string | null; value: string }[] = [];
      const toMinor = (x: number, memberId: string | null): bigint => {
        if (Number.isInteger(x)) return BigInt(x);
        // Not a whole number of minor units: truncate toward zero and report the exact value (design Q10).
        fractional.push({ memberId, value: String(x) });
        return BigInt(Math.trunc(x));
      };
      const members = new Map<string, bigint>();
      for (const [memberId, v] of Object.entries(b.members)) members.set(memberId, toMinor(v, memberId));
      return { asset: ctx.asset, pot: toMinor(b.pot, null), members, fractional };
    },

    async settle() {
      // The twin has no background work.
    },

    async close() {
      if (!shared) await client.close();
    },
  };
}
