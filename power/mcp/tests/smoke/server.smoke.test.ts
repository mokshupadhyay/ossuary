import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../helpers/sandbox.js';

const PKG = fileURLToPath(new URL('../../', import.meta.url));
const SERVER = path.join(PKG, 'dist/server.js');

const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const build = () => execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: PKG, stdio: 'pipe' });

const baseEnv = (): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const k of ['PATH', 'HOME', 'TMPDIR', 'SystemRoot']) if (process.env[k]) env[k] = process.env[k]!;
  return env;
};

interface Connected {
  client: Client;
  stderr: () => string;
  close: () => Promise<void>;
}

/** Spawns `node dist/server.js` over stdio, from a directory outside the repo. */
async function connect(env: Record<string, string> = {}, server = SERVER): Promise<Connected> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [server],
    cwd: tmpdir(),
    env: { ...baseEnv(), ...env },
    stderr: 'pipe',
  });
  let err = '';
  transport.stderr?.on('data', (d: Buffer) => {
    err += d.toString();
  });
  const client = new Client({ name: 'ossuary-smoke', version: '0.0.0' });
  await client.connect(transport);
  return { client, stderr: () => err, close: () => client.close() };
}

type Result = Awaited<ReturnType<Client['callTool']>>;
const payload = (r: Result) => {
  const text = (r.content as { type: string; text: string }[])[0]!.text;
  const parsed = JSON.parse(text) as Record<string, unknown>;
  expect(r.structuredContent).toEqual(parsed);
  return parsed;
};
const errorCode = (r: Result) => {
  expect(r.isError).toBe(true);
  return (payload(r).error as { code: string }).code;
};

describe('build', () => {
  it('produces the same bytes twice', () => {
    build();
    const first = sha(SERVER);
    build();
    expect(sha(SERVER)).toBe(first);
    expect(readFileSync(SERVER, 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
  });

  it('runs without node_modules: a copy in an empty directory starts and answers', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ossuary-bundle-'));
    try {
      const copy = path.join(dir, 'server.js');
      copyFileSync(SERVER, copy);
      const s = await connect({ OSSUARY_WORKSPACE: REPO_ROOT }, copy);
      try {
        expect((await s.client.listTools()).tools).toHaveLength(3);
        const r = payload(await s.client.callTool({ name: 'ossuary_check_money_code', arguments: { code: 'wallet.balance += 1n;' } }));
        expect(r).toMatchObject({ violations: [{ rule: 'mutable-balance' }] });
      } finally {
        await s.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the built server over stdio', () => {
  let s: Connected;
  beforeAll(async () => {
    build();
    s = await connect();
  });
  afterAll(async () => {
    await s?.close();
  });

  it('finds this repository as its workspace from the server path', () => {
    expect(s.stderr()).toContain(`workspace ${REPO_ROOT}`);
  });

  it('lists exactly the three tools, each with a strict JSON input schema', async () => {
    const { tools } = await s.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['ossuary_check_money_code', 'ossuary_explain_rule', 'ossuary_run_poltergeist']);
    for (const t of tools) {
      expect(t.description?.length).toBeGreaterThan(40);
      expect(t.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    }
  });

  it('ossuary_check_money_code: snippet, workspace file, escape and bad input', async () => {
    const snippet = payload(await s.client.callTool({ name: 'ossuary_check_money_code', arguments: { code: 'let amount: number = 0;\n' } }));
    expect(snippet).toMatchObject({ clean: false, violations: [{ rule: 'float-money', line: 1 }] });

    const twin = payload(await s.client.callTool({ name: 'ossuary_check_money_code', arguments: { path: 'packages/twin/src/index.ts' } }));
    expect(twin).toMatchObject({ source: { kind: 'path', path: 'packages/twin/src/index.ts' }, clean: false });

    const core = payload(await s.client.callTool({ name: 'ossuary_check_money_code', arguments: { path: 'packages/core/src/ledger/refund.ts' } }));
    expect(core).toMatchObject({ clean: true });

    expect(errorCode(await s.client.callTool({ name: 'ossuary_check_money_code', arguments: { path: '../../../etc/passwd' } }))).toBe('path_outside_workspace');
    expect(errorCode(await s.client.callTool({ name: 'ossuary_check_money_code', arguments: { path: '/etc/passwd' } }))).toBe('invalid_input');
    expect(errorCode(await s.client.callTool({ name: 'ossuary_check_money_code', arguments: {} }))).toBe('invalid_input');
    expect(errorCode(await s.client.callTool({ name: 'ossuary_check_money_code', arguments: { code: 'x', cmd: 'ls' } }))).toBe('invalid_input');
  });

  it('ossuary_explain_rule: valid and invalid', async () => {
    const r = payload(await s.client.callTool({ name: 'ossuary_explain_rule', arguments: { rule: 'refund-over-capture' } }));
    expect(r).toMatchObject({ id: 'refund-over-capture', steeringFile: '.kiro/steering/ledger.md' });
    expect(errorCode(await s.client.callTool({ name: 'ossuary_explain_rule', arguments: { rule: 'nope' } }))).toBe('invalid_input');
  });

  it('ossuary_run_poltergeist: a real run and invalid input', async () => {
    const r = payload(await s.client.callTool({ name: 'ossuary_run_poltergeist', arguments: { seed: 7, events: 40, target: 'ossuary' } }, undefined, { timeout: 120_000 }));
    expect(r.summary).toMatchObject({ target: 'ossuary', seed: 7, events: 40, driftTotal: '0', drifted: false });
    expect(r.report).toMatchObject({ schema: 'ossuary/poltergeist-report', version: 1, size: 40 });
    expect(errorCode(await s.client.callTool({ name: 'ossuary_run_poltergeist', arguments: { target: 'stripe' } }))).toBe('invalid_input');
    expect(errorCode(await s.client.callTool({ name: 'ossuary_run_poltergeist', arguments: { events: 1e9 } }))).toBe('invalid_input');
  });

  it('answers an unknown tool with an error and keeps serving', async () => {
    expect(errorCode(await s.client.callTool({ name: 'run_shell', arguments: { cmd: 'id' } }))).toBe('invalid_input');
    const { tools } = await s.client.listTools();
    expect(tools).toHaveLength(3);
  });
});

describe('OSSUARY_WORKSPACE', () => {
  it('confines the server to the directory it names', async () => {
    const s = await connect({ OSSUARY_WORKSPACE: path.join(REPO_ROOT, 'packages/twin') });
    try {
      const inside = payload(await s.client.callTool({ name: 'ossuary_check_money_code', arguments: { path: 'src/index.ts' } }));
      expect(inside).toMatchObject({ clean: false });
      const r = await s.client.callTool({ name: 'ossuary_check_money_code', arguments: { path: '../core/src/ledger/refund.ts' } });
      expect(errorCode(r)).toBe('path_outside_workspace');
      const p = await s.client.callTool({ name: 'ossuary_run_poltergeist', arguments: {} });
      expect(errorCode(p)).toBe('poltergeist_unavailable');
    } finally {
      await s.close();
    }
  });
});
