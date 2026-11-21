import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fail, ok, type ToolResult } from './result.js';

/** Files whose presence marks an Ossuary workspace (design D3). */
export const WORKSPACE_MARKERS = ['.kiro/steering/money.md', 'packages/core/src/poltergeist/cli.ts'] as const;

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** Nearest ancestor of `start` (inclusive) that contains a workspace marker, or null. */
export function findMarkedAncestor(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (WORKSPACE_MARKERS.some((m) => isFile(path.join(dir, m)))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export interface WorkspaceRootOptions {
  env: Record<string, string | undefined>;
  cwd: string;
  /** Directory of the running server file, if known. */
  serverDir?: string;
}

/**
 * Resolves the one directory the server may read from (design D3):
 * OSSUARY_WORKSPACE, else the nearest marked ancestor of cwd, else of the
 * server file, else cwd. Always returned as a real path.
 */
export function findWorkspaceRoot({ env, cwd, serverDir }: WorkspaceRootOptions): string {
  const fromEnv = env.OSSUARY_WORKSPACE;
  const chosen =
    (fromEnv && isDir(path.resolve(cwd, fromEnv)) ? path.resolve(cwd, fromEnv) : null) ??
    findMarkedAncestor(cwd) ??
    (serverDir ? findMarkedAncestor(serverDir) : null) ??
    cwd;
  return realpathSync(chosen);
}

const WINDOWS_ABSOLUTE = /^(?:[a-zA-Z]:|[\\/]{2})/;

/** True when `child` is `root` or strictly inside it. Both must be absolute and normalised. */
export function isInside(root: string, child: string): boolean {
  return child === root || child.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/**
 * Resolves a workspace-relative path to a real path inside `root` (design D4).
 * `root` must already be a real path. Never reads file contents.
 */
export function resolveInside(root: string, p: unknown): ToolResult<string> {
  if (typeof p !== 'string' || p.length === 0) return fail('invalid_input', 'path must be a non-empty string');
  if (p.includes('\0')) return fail('invalid_input', 'path must not contain NUL bytes');
  if (path.isAbsolute(p) || WINDOWS_ABSOLUTE.test(p)) {
    return fail('invalid_input', 'path must be relative to the workspace root');
  }
  const candidate = path.resolve(root, p);
  const rel = path.relative(root, candidate);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return fail('path_outside_workspace', `${p} is outside the workspace`);
  }
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return fail('not_found', `${p} does not exist`);
    return fail('internal', `cannot resolve ${p}: ${code ?? 'unknown error'}`);
  }
  if (!isInside(root, real)) return fail('path_outside_workspace', `${p} resolves outside the workspace`);
  return ok(real);
}

/** Workspace-relative display path with forward slashes. */
export function displayPath(root: string, real: string): string {
  return path.relative(root, real).split(path.sep).join('/') || '.';
}
