import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { serializeReport, type DriftJson, type PoltergeistReport } from '../../src/poltergeist/report.js';
import { generateStorm, isolateUnit, prefixStorm, type Storm, type Unit } from '../../src/poltergeist/storm.js';
import { PoltergeistRunError, summon } from '../../src/poltergeist/summon.js';
import { ossuaryFactory, type DeliverOptions, type DeliveryResult, type SutFactory } from '../../src/poltergeist/sut.js';
import type { FaultId } from '../../src/poltergeist/faults.js';

/*
 * A scripted in-memory SUT for exercising the runner. It applies captures,
 * refunds and payouts to a pot and member wallets, with knobs for the bugs
 * and failures a test needs.
 */
interface ToyOptions {
  dedupe?: boolean;
  /** Answer 5xx to the first N attempts of each distinct body, applying nothing. */
  failFirst?: number;
  /** Always answer with this status, applying nothing. */
  always?: number;
  /** Silently drop every Nth capture across the instance's life. */
  loseEvery?: number;
  throwOnDelivery?: number;
  asset?: string;
}
interface Logged {
  rawBody: string;
  headers: Record<string, string>;
  options: DeliverOptions;
}
function toy(opts: ToyOptions = {}) {
  const log: Logged[] = [];
  let closed = 0;
  let maxInFlight = 0;
  const factory: SutFactory = async (ctx) => {
    let pot = 0n;
    const members = new Map(ctx.memberIds.map((m) => [m, 0n]));
    const seen = new Set<string>();
    const tries = new Map<string, number>();
    let captures = 0;
    let deliveries = 0;
    let inFlight = 0;
    return {
      target: 'twin',
      async deliver(rawBody, headers, options): Promise<DeliveryResult> {
        deliveries += 1;
        log.push({ rawBody, headers: { ...headers }, options });
        if (opts.throwOnDelivery === deliveries) throw new Error('adapter broke');
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 0));
        inFlight -= 1;
        if (opts.always !== undefined) return { status: opts.always, crashed: false, defense: null };
        const n = (tries.get(rawBody) ?? 0) + 1;
        tries.set(rawBody, n);
        if (n <= (opts.failFirst ?? 0)) return { status: 503, crashed: false, defense: null };
        const b = JSON.parse(rawBody) as Record<string, string>;
        const id = options.route === 'payout' ? headers['idempotency-key']! : b['id']!;
        if (opts.dedupe !== false && seen.has(id)) return { status: 200, crashed: false, defense: 'inbox-dedupe' };
        seen.add(id);
        const amount = BigInt(b['amount'] ?? '0');
        if (options.route === 'payout') {
          pot -= amount;
          members.set(b['memberId']!, members.get(b['memberId']!)! + amount);
        } else if (b['type'] === 'payment.captured') {
          captures += 1;
          if (!(opts.loseEvery && captures % opts.loseEvery === 0)) pot += amount;
        } else if (b['type'] === 'payment.refunded') pot -= amount;
        return { status: 200, crashed: false, defense: null };
      },
      async balances() {
        return { asset: opts.asset ?? ctx.asset, pot, members };
      },
      async settle() {},
      async close() {
        closed += 1;
      },
    };
  };
  return { factory, log, get closed() { return closed; }, get maxInFlight() { return maxInFlight; } };
}

const pool = generateStorm({ seed: 1, size: 600 });
function unitOf(kind: FaultId | 'honest', nth = 0): Unit {
  const found = pool.units.filter((u) => (u.kind === 'ghost' ? u.faultId : 'honest') === kind);
  return found[nth]!;
}
const stormOf = (...units: Unit[]): Storm => ({ ...pool, units, size: units.reduce((n, u) => n + u.deliveries, 0) });

const sumAccounts = (...ds: DriftJson[]) => {
  const out = new Map<string, bigint>();
  for (const d of ds) for (const a of d.accounts) out.set(a.account, (out.get(a.account) ?? 0n) + BigInt(a.drift));
  return out;
};

describe('summon: rail and client behavior', () => {
  it('retries 5xx with a fresh signature each second, and stops at 2xx', async () => {
    const t = toy({ failFirst: 2 });
    const r = await summon({ storm: stormOf(unitOf('honest')), factory: t.factory, target: 'twin' });
    expect(t.log).toHaveLength(3);
    expect(new Set(t.log.map((l) => l.rawBody)).size).toBe(1);
    const ts = t.log.map((l) => Number(l.headers['ossuary-timestamp']));
    expect(ts[1]! - ts[0]!).toBe(1);
    expect(ts[2]! - ts[1]!).toBe(1);
    expect(new Set(t.log.map((l) => l.headers['ossuary-signature'])).size).toBe(3);
    expect(r.events).toEqual({ planned: 1, attempts: 3, retries: 2, crashes: 0 });
    expect(r.drift.total).toBe('0');
  });

  it('gives up after 5 attempts, and a 4xx ends a delivery at once', async () => {
    const down = toy({ always: 500 });
    const r = await summon({ storm: stormOf(unitOf('honest')), factory: down.factory, target: 'twin' });
    expect(r.events).toEqual({ planned: 1, attempts: 5, retries: 4, crashes: 0 });
    expect(down.log).toHaveLength(10); // the main run, then the counterexample's isolated run
    expect(BigInt(r.drift.total)).toBeGreaterThan(0n); // the capture happened at the rail but never landed
    const reject = toy({ always: 400 });
    const r4 = await summon({ storm: stormOf(unitOf('honest')), factory: reject.factory, target: 'twin' });
    expect(r4.events).toEqual({ planned: 1, attempts: 1, retries: 0, crashes: 0 });
  });

  it('replays the exact original bytes and headers, once, never retried', async () => {
    const t = toy({ always: 500 });
    const r = await summon({ storm: stormOf(unitOf('replayed-timestamp')), factory: t.factory, target: 'twin' });
    expect(r.events.attempts).toBe(6); // 5 attempts of the original, then 1 replay
    expect(t.log[5]).toEqual({ ...t.log[0]!, options: { route: 'webhook' } });
    const age = Number(t.log[5]!.headers['ossuary-timestamp']);
    expect(age).toBe(Number(t.log[0]!.headers['ossuary-timestamp']));
  });

  it('sends payouts with an idempotency-key header, and starts concurrent taps before awaiting any', async () => {
    const t = toy();
    const u = unitOf('double-tap');
    await summon({ storm: stormOf(u), factory: t.factory, target: 'twin' });
    const taps = t.log.filter((l) => l.options.route === 'payout');
    expect(taps.length).toBe(u.deliveries - 1);
    expect(t.maxInFlight).toBe(taps.length);
    expect(new Set(taps.map((l) => l.headers['idempotency-key'])).size).toBe(1);
    expect(taps[0]!.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('passes a crash plan only on the first attempt of its delivery', async () => {
    const t = toy({ failFirst: 1 });
    const u = unitOf('crash-mid-step');
    await summon({ storm: stormOf(u), factory: t.factory, target: 'twin' });
    const crashed = t.log.filter((l) => l.options.crash !== undefined);
    expect(crashed).toHaveLength(1);
    const same = t.log.filter((l) => l.rawBody === crashed[0]!.rawBody);
    expect(same.indexOf(crashed[0]!)).toBe(0);
  });
});

describe('summon: attribution and counterexamples', () => {
  const storm = generateStorm({ seed: 3, size: 80, ensureEveryFault: true });

  it('attributes drift to the ghost that caused it, and the deltas add up to the final drift', async () => {
    const r = await summon({ storm, factory: toy({ dedupe: false }).factory, target: 'twin' });
    expect(r.drifted.length).toBeGreaterThan(0);
    expect(r.drifted.map((d) => d.faultId)).toContain('duplicate-delivery');
    const ghosts = storm.units.filter((u) => u.kind === 'ghost');
    expect(r.blocked.length + r.drifted.length).toBe(ghosts.length);
    const sums = sumAccounts(...r.drifted.map((d) => d.drift), r.honest.drift, r.settleDrift);
    for (const a of r.drift.accounts) expect(sums.get(a.account) ?? 0n).toBe(BigInt(a.drift));
  });

  it('isolates the first drifting ghost, and replaying it reproduces the drift', async () => {
    const t = toy({ dedupe: false });
    const r = await summon({ storm, factory: t.factory, target: 'twin' });
    const cx = r.counterexample!;
    expect(cx.kind).toBe('isolated');
    expect(cx.unitId).toBe(r.drifted[0]!.ghostId);
    expect(cx.faultId).toBe(r.drifted[0]!.faultId);
    const again = await summon({ storm: isolateUnit(storm, cx.unitId), factory: toy({ dedupe: false }).factory, target: 'twin' });
    expect(again.drift.total).toBe(cx.drift.total);
    expect(again.drift.accounts).toEqual(cx.drift.accounts);
  });

  it('falls back to a prefix counterexample when the unit does not drift alone', async () => {
    const s = stormOf(unitOf('honest', 0), unitOf('honest', 1), unitOf('honest', 2));
    const r = await summon({ storm: s, factory: toy({ loseEvery: 2 }).factory, target: 'twin' });
    expect(r.counterexample).toMatchObject({ kind: 'prefix', unitId: s.units[1]!.unitId, faultId: null, deliveries: 2 });
    const cx = r.counterexample as Extract<PoltergeistReport['counterexample'], { kind: 'prefix' }>;
    const replay = await summon({ storm: prefixStorm(s, cx.unitId), factory: toy({ loseEvery: 2 }).factory, target: 'twin' });
    expect(replay.drift.total).toBe(cx.drift.total);
  });

  it('has no counterexample when nothing drifts', async () => {
    const r = await summon({ storm, factory: toy().factory, target: 'twin' });
    expect(r.drift.total).toBe('0');
    expect(r.drifted).toEqual([]);
    expect(r.counterexample).toBeNull();
  });
});

describe('summon: failures and secrecy', () => {
  it('throws PoltergeistRunError naming seed and unit when the adapter throws, and closes the SUT', async () => {
    const t = toy({ throwOnDelivery: 3 });
    const s = stormOf(unitOf('honest', 0), unitOf('honest', 1), unitOf('honest', 2));
    const err = await summon({ storm: s, factory: t.factory, target: 'twin' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PoltergeistRunError);
    expect((err as PoltergeistRunError).unitIndex).toBe(2);
    expect((err as PoltergeistRunError).seed).toBe(s.seed);
    expect((err as Error).message).toMatch(/seed 1, unit index 2: adapter broke/);
    expect(t.closed).toBe(1);
  });

  it('throws on an asset mismatch instead of converting', async () => {
    const t = toy({ asset: 'USD' });
    await expect(summon({ storm: stormOf(unitOf('honest')), factory: t.factory, target: 'twin' })).rejects.toThrow(/asset USD/);
    expect(t.closed).toBe(1);
  });

  it('never writes the secret or the run tag into the report', async () => {
    const secret = 'super-secret-signing-key-0123456789-abcdef';
    const r = await summon({ storm: generateStorm({ seed: 9, size: 40 }), factory: toy().factory, target: 'twin', secret, runTag: 'TAGTAG1~' });
    const json = serializeReport(r);
    expect(json).not.toContain(secret);
    expect(json).not.toContain('TAGTAG1');
  });
});

describe('golden report', () => {
  it('seed 7, size 60, ossuary matches tests/fixtures/report-seed7-size60-ossuary.json byte for byte', async () => {
    // A change to the report's shape must bump REPORT_VERSION and regenerate this file.
    const file = fileURLToPath(new URL('../fixtures/report-seed7-size60-ossuary.json', import.meta.url));
    const golden = JSON.stringify(JSON.parse(readFileSync(file, 'utf8')));
    const r = await summon({ storm: generateStorm({ seed: 7, size: 60 }), factory: ossuaryFactory(), target: 'ossuary' });
    expect(serializeReport(r)).toBe(golden);
  });
});
