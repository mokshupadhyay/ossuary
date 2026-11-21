/*
 * pnpm poltergeist --seed 7 --events 2000 --target ossuary|twin [--json]
 *
 * The only Node-only module of the poltergeist (design D8): argument parsing,
 * process, stdout/stderr and exit codes live here and nowhere else. Every
 * target runs on in-memory PGlite; no environment variables, no network.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { FAULTS } from './faults.js';
import type { DriftJson, PoltergeistReport, Target } from './report.js';
import { serializeReport } from './report.js';
import { DEFAULT_STORM_SIZE, generateStorm, MAX_STORM_SIZE } from './storm.js';
import { summon } from './summon.js';
import { ossuaryFactory } from './sut.js';
import { twinFactory } from './twinSut.js';

export interface CliOptions {
  seed: number;
  events: number;
  target: Target;
  json: boolean;
}

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  /** Milliseconds, for the run time printed to stderr. */
  now(): number;
}

export const USAGE = `usage: pnpm poltergeist [--seed <0-4294967295>] [--events <1-${MAX_STORM_SIZE}>] [--target ossuary|twin] [--json]
  defaults: --seed 7 --events ${DEFAULT_STORM_SIZE} --target ossuary`;

export class UsageError extends Error {}

const DIGITS = /^[0-9]+$/;

/** Parses and validates arguments; throws UsageError for anything unknown, repeated or out of range. */
export function parseCliArgs(argv: readonly string[]): CliOptions {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        seed: { type: 'string' },
        events: { type: 'string' },
        target: { type: 'string' },
        json: { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
      tokens: true,
    });
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
  const counts = new Map<string, number>();
  for (const t of parsed.tokens ?? []) if (t.kind === 'option') counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
  for (const [name, n] of counts) if (n > 1) throw new UsageError(`--${name} given ${n} times`);

  const { seed = '7', events = String(DEFAULT_STORM_SIZE), target = 'ossuary', json = false } = parsed.values;
  if (!DIGITS.test(seed) || Number(seed) > 0xffff_ffff) throw new UsageError('--seed must be an integer from 0 to 4294967295');
  if (!DIGITS.test(events) || Number(events) < 1 || Number(events) > MAX_STORM_SIZE) {
    throw new UsageError(`--events must be an integer from 1 to ${MAX_STORM_SIZE}`);
  }
  if (target !== 'ossuary' && target !== 'twin') throw new UsageError('--target must be ossuary or twin');
  return { seed: Number(seed), events: Number(events), target, json };
}

/** Exact decimal rendering of minor units: no rounding, all decimals shown. */
export function formatUnits(minor: string | bigint, decimals: number): string {
  const v = BigInt(minor);
  const neg = v < 0n;
  const abs = (neg ? -v : v).toString().padStart(decimals + 1, '0');
  const int = abs.slice(0, abs.length - decimals);
  const frac = abs.slice(abs.length - decimals);
  return `${neg ? '-' : ''}${int}${decimals > 0 ? `.${frac}` : ''}`;
}

export function summarize(r: PoltergeistReport): string {
  const amt = (s: string) => formatUnits(s, r.decimals);
  const drift = (d: DriftJson) => `${amt(d.total)} ${r.asset}`;
  const lines = [
    `Poltergeist vs ${r.target} · seed ${r.seed} · ${r.size} events · generator ${r.generator}`,
    `Drift: ${drift(r.drift)}   conjured ${amt(r.drift.conjured)}   lost ${amt(r.drift.lost)}   double-credited members ${r.drift.doubleCreditedMembers}`,
    `Deliveries: ${r.events.planned} planned, ${r.events.attempts} attempts, ${r.events.retries} retries, ${r.events.crashes} crashes`,
  ];
  const width = Math.max(...FAULTS.map((f) => f.id.length));
  for (const f of r.faults) {
    lines.push(
      `  ${f.id.padEnd(width)}  ${String(f.ghosts).padStart(4)} ghosts  ${String(f.blocked).padStart(4)} blocked  ${String(f.drifted).padStart(4)} drifted  drift ${drift(f.drift)}`,
    );
  }
  lines.push(`  ${'honest'.padEnd(width)}  ${String(r.honest.units).padStart(4)} units                          drift ${drift(r.honest.drift)}`);
  if (r.blocked.length > 0) {
    lines.push('Epitaphs:');
    for (const b of r.blocked.slice(0, 10)) lines.push(`  ${b.epitaph}`);
  }
  if (r.drifted.length > 0) {
    lines.push('Drifted ghosts:');
    for (const d of r.drifted.slice(0, 10)) lines.push(`  ${d.ghostId} ${d.faultId} ${d.subject}: drift ${drift(d.drift)}`);
  }
  if (r.counterexample) {
    const cx = r.counterexample;
    lines.push(`Counterexample: ${cx.kind} ${cx.unitId} (${cx.faultId ?? 'honest'}), drift ${drift(cx.drift)}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Runs the CLI and returns its exit code: 0 completed (drift or not), 1 run failed, 2 usage error. */
export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  let options: CliOptions;
  try {
    options = parseCliArgs(argv);
  } catch (e) {
    io.stderr(`${e instanceof Error ? e.message : String(e)}\n${USAGE}\n`);
    return 2;
  }
  const started = io.now();
  try {
    const report = await summon({
      storm: generateStorm({ seed: options.seed, size: options.events }),
      factory: options.target === 'ossuary' ? ossuaryFactory() : twinFactory(),
      target: options.target,
    });
    io.stdout(options.json ? `${serializeReport(report)}\n` : summarize(report));
    io.stderr(`ran in ${Math.round(io.now() - started)} ms\n`);
    return 0;
  } catch (e) {
    io.stderr(`poltergeist: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  const code = await main(process.argv.slice(2), {
    stdout: (t) => process.stdout.write(t),
    stderr: (t) => process.stderr.write(t),
    now: () => performance.now(),
  });
  process.exitCode = code;
}
