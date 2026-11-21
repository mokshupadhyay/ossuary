import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { z } from 'zod';
import type { PoltergeistRunner, ToolContext } from '../context.js';
import { describeZodError, fail, ok, type ToolResult } from '../result.js';

export const CLI_RELATIVE = 'packages/core/src/poltergeist/cli.ts';
export const CORE_RELATIVE = 'packages/core';
export const MAX_EVENTS = 2000;
export const MAX_SEED = 0xffff_ffff;
export const TIMEOUT_MS = 120_000;
export const MAX_STDERR = 2000;
const MAX_BUFFER = 32 * 1024 * 1024;

export const runPoltergeistShape = {
  seed: z.number().int().min(0).max(MAX_SEED).default(7).describe('Storm seed, 0 to 4294967295. Same seed, same storm.'),
  events: z.number().int().min(1).max(MAX_EVENTS).default(300).describe(`Planned deliveries, 1 to ${MAX_EVENTS}.`),
  target: z.enum(['ossuary', 'twin']).default('ossuary').describe('ossuary (the skeleton) or twin (the vibe-coded Vibe Pay).'),
};

const schema = z.object(runPoltergeistShape).strict();

export type PoltergeistOptions = z.infer<typeof schema>;

export interface PoltergeistCommand {
  file: string;
  args: string[];
  cwd: string;
}

export function parsePoltergeistInput(input: unknown): ToolResult<PoltergeistOptions> {
  const parsed = schema.safeParse(input ?? {});
  return parsed.success ? ok(parsed.data) : fail('invalid_input', describeZodError(parsed.error));
}

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * Validates input and builds the one command this tool ever runs (design D7):
 * `node <tsx cli> <poltergeist cli> --seed S --events E --target T --json`.
 */
export function planPoltergeistRun(input: unknown, workspaceRoot: string): ToolResult<PoltergeistCommand> {
  const opts = parsePoltergeistInput(input);
  if (!opts.ok) return opts;
  const coreDir = path.join(workspaceRoot, CORE_RELATIVE);
  const cli = path.join(workspaceRoot, CLI_RELATIVE);
  if (!isFile(cli)) return fail('poltergeist_unavailable', `${CLI_RELATIVE} not found in the workspace`);
  let tsx: string;
  try {
    tsx = createRequire(path.join(coreDir, 'package.json')).resolve('tsx/cli');
  } catch {
    return fail('poltergeist_unavailable', `tsx is not installed for ${CORE_RELATIVE}; run pnpm install at the workspace root`);
  }
  const { seed, events, target } = opts.data;
  return ok({
    file: process.execPath,
    args: [tsx, cli, '--seed', String(seed), '--events', String(events), '--target', target, '--json'],
    cwd: coreDir,
  });
}

/** Runs without a shell; kills the child at the timeout. */
export const execFileRunner: PoltergeistRunner = ({ file, args, cwd, timeoutMs }) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { cwd, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: MAX_BUFFER, windowsHide: true, shell: false, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const e = error as (NodeJS.ErrnoException & { killed?: boolean; signal?: string | null; code?: unknown }) | null;
        const timedOut = e !== null && e.killed === true && e.signal === 'SIGKILL';
        const exitCode = e === null ? 0 : typeof e.code === 'number' ? e.code : null;
        resolve({ exitCode, stdout: String(stdout), stderr: e && typeof e.code === 'string' && !stderr ? e.message : String(stderr), timedOut });
      },
    );
  });

interface DriftReport {
  schema: 'ossuary/poltergeist-report';
  version: 1;
  seed: number;
  size: number;
  target: string;
  asset: string;
  decimals: number;
  drift: { total: string };
  faults: { id: string; drifted: number }[];
}

function asDriftReport(v: unknown): DriftReport | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;
  const drift = r.drift as Record<string, unknown> | undefined;
  if (r.schema !== 'ossuary/poltergeist-report' || r.version !== 1) return null;
  if (typeof drift !== 'object' || drift === null || typeof drift.total !== 'string' || !/^-?\d+$/.test(drift.total)) return null;
  if (!Array.isArray(r.faults) || !r.faults.every((f) => typeof f?.id === 'string' && typeof f?.drifted === 'number')) return null;
  if (typeof r.asset !== 'string' || typeof r.decimals !== 'number') return null;
  return v as DriftReport;
}

export interface RunPoltergeistResult {
  summary: {
    target: 'ossuary' | 'twin';
    seed: number;
    events: number;
    asset: string;
    decimals: number;
    /** Total drift in minor units, as a decimal string. */
    driftTotal: string;
    drifted: boolean;
    driftedFaults: string[];
  };
  report: unknown;
}

const tail = (s: string) => (s.length > MAX_STDERR ? s.slice(s.length - MAX_STDERR) : s);

export async function runPoltergeist(input: unknown, ctx: ToolContext): Promise<ToolResult<RunPoltergeistResult>> {
  const plan = planPoltergeistRun(input, ctx.workspaceRoot);
  if (!plan.ok) return plan;
  const { seed, events, target } = (parsePoltergeistInput(input) as { ok: true; data: PoltergeistOptions }).data;

  const run = await (ctx.runner ?? execFileRunner)({ ...plan.data, timeoutMs: TIMEOUT_MS });
  if (run.timedOut) return fail('timeout', `the poltergeist did not finish within ${TIMEOUT_MS / 1000} s`);
  if (run.exitCode !== 0) {
    return fail('poltergeist_failed', `poltergeist exited with code ${run.exitCode ?? 'unknown'}: ${tail(run.stderr.trim())}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(run.stdout);
  } catch {
    return fail('poltergeist_failed', `poltergeist printed something that is not JSON: ${tail(run.stdout.trim()).slice(0, 200)}`);
  }
  const report = asDriftReport(parsed);
  if (!report) return fail('poltergeist_failed', 'poltergeist output is not an ossuary/poltergeist-report version 1');

  const driftedFaults = report.faults.filter((f) => f.drifted > 0).map((f) => f.id);
  return ok({
    summary: {
      target,
      seed,
      events,
      asset: report.asset,
      decimals: report.decimals,
      driftTotal: report.drift.total,
      drifted: report.drift.total !== '0' || driftedFaults.length > 0,
      driftedFaults,
    },
    report: parsed,
  });
}
