import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoltergeistRunner } from '../../src/context.js';
import {
  CLI_RELATIVE,
  MAX_STDERR,
  planPoltergeistRun,
  runPoltergeist,
  TIMEOUT_MS,
} from '../../src/tools/runPoltergeist.js';
import { createSandbox, REPO_ROOT, type Sandbox } from '../helpers/sandbox.js';

const REPORT = {
  schema: 'ossuary/poltergeist-report',
  version: 1,
  seed: 7,
  size: 300,
  target: 'twin',
  asset: 'USDC',
  decimals: 6,
  drift: { total: '-12' },
  faults: [
    { id: 'duplicate-delivery', drifted: 3 },
    { id: 'out-of-order', drifted: 0 },
  ],
};

/** A runner that records its call and answers with a canned result. */
function fakeRunner(result: Partial<Awaited<ReturnType<PoltergeistRunner>>>) {
  const calls: Parameters<PoltergeistRunner>[0][] = [];
  const runner: PoltergeistRunner = async (cmd) => {
    calls.push(cmd);
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false, ...result };
  };
  return { runner, calls };
}

const errorOf = async (input: unknown, runner: PoltergeistRunner, root = REPO_ROOT) => {
  const r = await runPoltergeist(input, { workspaceRoot: root, runner });
  return r.ok ? null : r.error;
};

describe('ossuary_run_poltergeist: command', () => {
  it('runs node with tsx and the CLI, with defaults seed 7, 300 events, ossuary', async () => {
    const { runner, calls } = fakeRunner({ stdout: JSON.stringify({ ...REPORT, target: 'ossuary', drift: { total: '0' }, faults: [] }) });
    const r = await runPoltergeist({}, { workspaceRoot: REPO_ROOT, runner });
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.file).toBe(process.execPath);
    expect(call!.cwd).toBe(path.join(REPO_ROOT, 'packages/core'));
    expect(call!.timeoutMs).toBe(TIMEOUT_MS);
    expect(call!.args[0]).toMatch(/tsx[\\/]dist[\\/]cli\.m?js$/);
    expect(call!.args.slice(1)).toEqual([path.join(REPO_ROOT, CLI_RELATIVE), '--seed', '7', '--events', '300', '--target', 'ossuary', '--json']);
  });

  it('passes the chosen seed, events and target', () => {
    const plan = planPoltergeistRun({ seed: 4294967295, events: 2000, target: 'twin' }, REPO_ROOT);
    expect(plan.ok && plan.data.args.slice(2)).toEqual(['--seed', '4294967295', '--events', '2000', '--target', 'twin', '--json']);
  });
});

describe('ossuary_run_poltergeist: results', () => {
  it('returns the report unchanged with a summary', async () => {
    const { runner } = fakeRunner({ stdout: `${JSON.stringify(REPORT)}\n` });
    const r = await runPoltergeist({ seed: 7, events: 300, target: 'twin' }, { workspaceRoot: REPO_ROOT, runner });
    expect(r).toEqual({
      ok: true,
      data: {
        summary: {
          target: 'twin',
          seed: 7,
          events: 300,
          asset: 'USDC',
          decimals: 6,
          driftTotal: '-12',
          drifted: true,
          driftedFaults: ['duplicate-delivery'],
        },
        report: REPORT,
      },
    });
  });

  it('counts a drifted fault as drift even when the total nets to zero', async () => {
    const { runner } = fakeRunner({ stdout: JSON.stringify({ ...REPORT, drift: { total: '0' } }) });
    const r = await runPoltergeist({ target: 'twin' }, { workspaceRoot: REPO_ROOT, runner });
    expect(r.ok && r.data.summary).toMatchObject({ driftTotal: '0', drifted: true });
  });

  it('reports a non-zero exit with the tail of stderr', async () => {
    const { runner } = fakeRunner({ exitCode: 2, stderr: `${'x'.repeat(5000)}END` });
    const e = await errorOf({}, runner);
    expect(e?.code).toBe('poltergeist_failed');
    expect(e?.message).toContain('code 2');
    expect(e?.message).toContain('END');
    expect(e!.message.length).toBeLessThan(MAX_STDERR + 100);
  });

  it('reports output that is not JSON, or not a drift report', async () => {
    expect((await errorOf({}, fakeRunner({ stdout: 'Poltergeist vs ossuary' }).runner))?.code).toBe('poltergeist_failed');
    expect((await errorOf({}, fakeRunner({ stdout: '{"schema":"other","version":1}' }).runner))?.code).toBe('poltergeist_failed');
    expect((await errorOf({}, fakeRunner({ stdout: JSON.stringify({ ...REPORT, version: 2 }) }).runner))?.code).toBe('poltergeist_failed');
    expect((await errorOf({}, fakeRunner({ stdout: JSON.stringify({ ...REPORT, drift: { total: 1.5 } }) }).runner))?.code).toBe('poltergeist_failed');
  });

  it('reports a timeout', async () => {
    const e = await errorOf({}, fakeRunner({ timedOut: true, exitCode: null }).runner);
    expect(e?.code).toBe('timeout');
  });
});

describe('ossuary_run_poltergeist: invalid input and missing pieces', () => {
  const never: PoltergeistRunner = async () => {
    throw new Error('must not run');
  };

  it.each([
    ['a negative seed', { seed: -1 }],
    ['a seed above 2^32-1', { seed: 4294967296 }],
    ['a fractional seed', { seed: 1.5 }],
    ['a string seed', { seed: '7' }],
    ['zero events', { events: 0 }],
    ['too many events', { events: 2001 }],
    ['NaN events', { events: Number.NaN }],
    ['an unknown target', { target: 'stripe' }],
    ['a shell-looking target', { target: 'ossuary; rm -rf /' }],
    ['an extra flag', { seed: 7, args: ['--evil'] }],
    ['a non-object', 'seed=7'],
  ])('rejects %s without running anything', async (_name, input) => {
    expect((await errorOf(input, never))?.code).toBe('invalid_input');
  });

  let sb: Sandbox;
  beforeAll(() => {
    sb = createSandbox();
  });
  afterAll(() => sb.cleanup());

  it('reports a workspace without the poltergeist CLI', async () => {
    const e = await errorOf({}, never, sb.root);
    expect(e).toEqual({ code: 'poltergeist_unavailable', message: expect.stringContaining(CLI_RELATIVE) });
  });

  it('reports a workspace without tsx', async () => {
    sb.write(CLI_RELATIVE, 'export {};\n');
    sb.write('packages/core/package.json', '{"name":"@ossuary/core"}\n');
    const e = await errorOf({}, never, sb.root);
    expect(e).toEqual({ code: 'poltergeist_unavailable', message: expect.stringContaining('tsx') });
  });
});

describe('ossuary_run_poltergeist: real runs', () => {
  it('Ossuary does not drift (seed 7, 60 events)', async () => {
    const r = await runPoltergeist({ seed: 7, events: 60, target: 'ossuary' }, { workspaceRoot: REPO_ROOT });
    if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
    expect(r.data.summary).toMatchObject({ target: 'ossuary', events: 60, driftTotal: '0', drifted: false, driftedFaults: [] });
    expect((r.data.report as { size: number }).size).toBe(60);
  });

  it('the twin drifts (seed 7, 60 events)', async () => {
    const r = await runPoltergeist({ seed: 7, events: 60, target: 'twin' }, { workspaceRoot: REPO_ROOT });
    if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
    expect(r.data.summary.drifted).toBe(true);
    expect(r.data.summary.driftedFaults.length).toBeGreaterThan(0);
  });
});
