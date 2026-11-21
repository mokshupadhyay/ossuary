import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { displayPath, findWorkspaceRoot, isInside, resolveInside } from '../../src/workspace.js';
import { createSandbox, REPO_ROOT, type Sandbox } from '../helpers/sandbox.js';

let sb: Sandbox;
beforeAll(() => {
  sb = createSandbox();
  mkdirSync(path.join(sb.root, 'deep/er'), { recursive: true });
});
afterAll(() => sb.cleanup());

describe('findWorkspaceRoot', () => {
  it('uses OSSUARY_WORKSPACE when it names a directory', () => {
    expect(findWorkspaceRoot({ env: { OSSUARY_WORKSPACE: sb.outside }, cwd: sb.root })).toBe(sb.outside);
  });

  it('resolves a relative OSSUARY_WORKSPACE against cwd', () => {
    expect(findWorkspaceRoot({ env: { OSSUARY_WORKSPACE: '.' }, cwd: sb.root })).toBe(sb.root);
  });

  it('ignores OSSUARY_WORKSPACE when it is not a directory', () => {
    const env = { OSSUARY_WORKSPACE: path.join(sb.base, 'missing') };
    expect(findWorkspaceRoot({ env, cwd: path.join(sb.root, 'deep/er') })).toBe(sb.root);
  });

  it('finds the nearest marked ancestor of cwd', () => {
    expect(findWorkspaceRoot({ env: {}, cwd: path.join(sb.root, 'deep/er') })).toBe(sb.root);
  });

  it('falls back to the server directory, then to cwd', () => {
    expect(findWorkspaceRoot({ env: {}, cwd: sb.outside, serverDir: path.join(sb.root, 'sub') })).toBe(sb.root);
    expect(findWorkspaceRoot({ env: {}, cwd: sb.outside })).toBe(sb.outside);
  });

  it('finds this repository from power/mcp', () => {
    expect(findWorkspaceRoot({ env: {}, cwd: path.join(REPO_ROOT, 'power/mcp') })).toBe(REPO_ROOT);
  });
});

describe('resolveInside', () => {
  const errorCode = (p: unknown) => {
    const r = resolveInside(sb.root, p);
    return r.ok ? 'ok' : r.error.code;
  };

  it('accepts files inside the workspace, including through an inside symlink', () => {
    expect(resolveInside(sb.root, 'src/pay.ts')).toEqual({ ok: true, data: path.join(sb.root, 'src/pay.ts') });
    expect(resolveInside(sb.root, './sub/../src/pay.ts')).toEqual({ ok: true, data: path.join(sb.root, 'src/pay.ts') });
    expect(resolveInside(sb.root, 'in-link.ts')).toEqual({ ok: true, data: path.join(sb.root, 'src/pay.ts') });
  });

  it('rejects .. escapes before touching the disk', () => {
    expect(errorCode('..')).toBe('path_outside_workspace');
    expect(errorCode('../outside/secret.ts')).toBe('path_outside_workspace');
    expect(errorCode('src/../../outside/secret.ts')).toBe('path_outside_workspace');
    expect(errorCode('../ws-evil/x.ts')).toBe('path_outside_workspace');
    expect(errorCode('../does-not-exist')).toBe('path_outside_workspace');
  });

  it('rejects absolute paths, even ones inside the workspace', () => {
    expect(errorCode(path.join(sb.root, 'src/pay.ts'))).toBe('invalid_input');
    expect(errorCode('/etc/passwd')).toBe('invalid_input');
    expect(errorCode('C:\\Windows\\win.ini')).toBe('invalid_input');
    expect(errorCode('\\\\server\\share\\x.ts')).toBe('invalid_input');
  });

  it('rejects symlinks that lead outside', () => {
    expect(errorCode('secret-link.ts')).toBe('path_outside_workspace');
    expect(errorCode('out-link/secret.ts')).toBe('path_outside_workspace');
    expect(errorCode('out-link')).toBe('path_outside_workspace');
    expect(errorCode('evil-link/x.ts')).toBe('path_outside_workspace');
  });

  it('rejects bad input and reports missing files', () => {
    expect(errorCode('')).toBe('invalid_input');
    expect(errorCode(42)).toBe('invalid_input');
    expect(errorCode(undefined)).toBe('invalid_input');
    expect(errorCode('src/pay.ts\0.md')).toBe('invalid_input');
    expect(errorCode('src/nope.ts')).toBe('not_found');
    expect(errorCode('src/pay.ts/child.ts')).toBe('not_found');
  });
});

describe('isInside and displayPath', () => {
  it('does not treat a name-prefix sibling as inside', () => {
    expect(isInside(sb.root, sb.sibling)).toBe(false);
    expect(isInside(sb.root, path.join(sb.sibling, 'x.ts'))).toBe(false);
    expect(isInside(sb.root, sb.root)).toBe(true);
    expect(isInside(sb.root, path.join(sb.root, 'a'))).toBe(true);
  });

  it('prints workspace-relative paths with forward slashes', () => {
    expect(displayPath(sb.root, path.join(sb.root, 'src', 'pay.ts'))).toBe('src/pay.ts');
    expect(displayPath(sb.root, sb.root)).toBe('.');
  });
});
