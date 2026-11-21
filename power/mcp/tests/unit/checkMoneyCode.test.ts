import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RULES } from '../../src/rules.js';
import { CHECKER_NOTE, checkMoneyCode, MAX_CODE_CHARS, MAX_FILE_BYTES } from '../../src/tools/checkMoneyCode.js';
import { createSandbox, type Sandbox } from '../helpers/sandbox.js';

let sb: Sandbox;
beforeAll(() => {
  sb = createSandbox();
  sb.write('src/float.ts', 'export const x = 1n;\nexport let amount: number = 0;\n');
  sb.write('db/0001.sql', 'CREATE TABLE w (\n  balance bigint NOT NULL -- running total\n);\n');
  sb.write('notes.md', 'amount: number\n');
  sb.write('big.ts', `export const s = "${'x'.repeat(MAX_FILE_BYTES)}";\n`);
  mkdirSync(path.join(sb.root, 'dir.ts'));
});
afterAll(() => sb.cleanup());

const call = (input: unknown) => checkMoneyCode(input, { workspaceRoot: sb.root });
const code = async (input: unknown) => {
  const r = await call(input);
  return r.ok ? 'ok' : r.error.code;
};

describe('ossuary_check_money_code: valid input', () => {
  it('checks a workspace file and reports workspace-relative paths', async () => {
    const r = await call({ path: 'src/float.ts' });
    expect(r).toEqual({
      ok: true,
      data: {
        source: { kind: 'path', path: 'src/float.ts' },
        clean: false,
        violations: [expect.objectContaining({ rule: 'float-money', line: 2, excerpt: 'export let amount: number = 0;' })],
        summary: { total: 1, byRule: { 'float-money': 1 } },
        note: CHECKER_NOTE,
      },
    });
  });

  it('uses SQL comment rules for .sql files', async () => {
    const r = await call({ path: 'db/0001.sql' });
    expect(r.ok && r.data.violations.map((v) => `${v.rule}@${v.line}`)).toEqual(['mutable-balance@2']);
  });

  it('reports clean files as clean', async () => {
    const r = await call({ path: './src/pay.ts' });
    expect(r.ok && r.data).toMatchObject({ clean: true, violations: [], summary: { total: 0, byRule: {} } });
  });

  it('checks a snippet with and without a filename', async () => {
    const a = await call({ code: 'wallet.balance += amount;\n' });
    expect(a.ok && a.data.source).toEqual({ kind: 'snippet', filename: null });
    expect(a.ok && a.data.violations[0]?.rule).toBe('mutable-balance');
    const b = await call({ code: '-- amount real\n', filename: 'x.sql' });
    expect(b.ok && b.data).toMatchObject({ source: { kind: 'snippet', filename: 'x.sql' }, clean: true });
    const c = await call({ code: '' });
    expect(c.ok && c.data.clean).toBe(true);
  });

  it.each(RULES.map((r) => [r.id, r.bug] as const))('reports a %s snippet', async (id, bug) => {
    const r = await call({ code: bug });
    expect(r.ok && r.data.violations.map((v) => v.rule)).toContain(id);
  });

  it('states that the check is heuristic', () => {
    expect(CHECKER_NOTE).toMatch(/heuristic/i);
    expect(CHECKER_NOTE).toMatch(/not proof/i);
  });
});

describe('ossuary_check_money_code: invalid input', () => {
  it.each([
    ['nothing', {}],
    ['undefined', undefined],
    ['a non-object', 'src/pay.ts'],
    ['both path and code', { path: 'src/pay.ts', code: 'x' }],
    ['filename without code', { path: 'src/pay.ts', filename: 'a.ts' }],
    ['an unknown property', { code: 'x', shell: 'rm -rf /' }],
    ['a non-string path', { path: 42 }],
    ['an empty path', { path: '' }],
    ['a NUL byte', { path: 'src/pay.ts\0' }],
    ['an absolute path', { path: '/etc/passwd' }],
  ])('rejects %s as invalid_input', async (_name, input) => {
    expect(await code(input)).toBe('invalid_input');
  });

  it('rejects an absolute path even when it points inside the workspace', async () => {
    expect(await code({ path: path.join(sb.root, 'src/pay.ts') })).toBe('invalid_input');
  });

  it('rejects oversized snippets and files as too_large', async () => {
    expect(await code({ code: 'x'.repeat(MAX_CODE_CHARS + 1) })).toBe('too_large');
    expect(await code({ code: 'x'.repeat(MAX_CODE_CHARS) })).toBe('ok');
    expect(await code({ path: 'big.ts' })).toBe('too_large');
  });

  it('reports missing files, directories and unsupported types', async () => {
    expect(await code({ path: 'src/missing.ts' })).toBe('not_found');
    expect(await code({ path: 'dir.ts' })).toBe('not_a_file');
    expect(await code({ path: 'src' })).toBe('not_a_file');
    expect(await code({ path: 'notes.md' })).toBe('unsupported_file_type');
    expect(await code({ path: '.kiro/steering/money.md' })).toBe('unsupported_file_type');
  });
});

describe('ossuary_check_money_code: path escape attempts', () => {
  it.each([
    ['parent directory', '../outside/secret.ts'],
    ['nested parent directory', 'src/../../outside/secret.ts'],
    ['sibling with the same prefix', '../ws-evil/x.ts'],
    ['file symlink out', 'secret-link.ts'],
    ['directory symlink out', 'out-link/secret.ts'],
    ['symlink to the same-prefix sibling', 'evil-link/x.ts'],
  ])('refuses a %s', async (_name, p) => {
    const r = await call({ path: p });
    expect(r.ok ? 'ok' : r.error.code).toBe('path_outside_workspace');
    // Never echo the outside file's contents.
    expect(JSON.stringify(r)).not.toContain('secret =');
  });

  it('allows a symlink that stays inside', async () => {
    const r = await call({ path: 'in-link.ts' });
    expect(r.ok && r.data.source).toEqual({ kind: 'path', path: 'src/pay.ts' });
  });

  it('does not read through a symlink created after the root was resolved', async () => {
    writeFileSync(path.join(sb.outside, 'late.ts'), 'export let amount: number = 1;\n');
    const { symlinkSync } = await import('node:fs');
    symlinkSync('../outside/late.ts', path.join(sb.root, 'late-link.ts'));
    expect(await code({ path: 'late-link.ts' })).toBe('path_outside_workspace');
  });
});
