import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The real repository root (power/mcp/tests/helpers → ../../../..). */
export const REPO_ROOT = realpathSync(fileURLToPath(new URL('../../../../', import.meta.url)));

export interface Sandbox {
  /** Real path of a parent directory holding the workspace and its neighbours. */
  base: string;
  /** Real path of the workspace root, `<base>/ws`. */
  root: string;
  /** Real path of a sibling sharing the root's name as a prefix, `<base>/ws-evil`. */
  sibling: string;
  /** Real path of an unrelated directory outside, `<base>/outside`. */
  outside: string;
  write(rel: string, text: string): string;
  cleanup(): void;
}

/**
 * A throwaway workspace:
 *   ws/.kiro/steering/money.md (marker), ws/src/pay.ts, ws/sub/inner.ts,
 *   ws/out-link → ../outside (dir symlink), ws/secret-link.ts → ../outside/secret.ts,
 *   ws/in-link.ts → src/pay.ts, ws/evil-link → ../ws-evil (a sibling sharing the root's name as prefix),
 *   ws-evil/x.ts, outside/secret.ts
 */
export function createSandbox(): Sandbox {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'ossuary-power-')));
  const root = path.join(base, 'ws');
  const sibling = path.join(base, 'ws-evil');
  const outside = path.join(base, 'outside');
  const write = (abs: string, text: string): string => {
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, text);
    return abs;
  };
  write(path.join(root, '.kiro/steering/money.md'), '# Money rules\n');
  write(path.join(root, 'src/pay.ts'), 'export const amount = 100n;\n');
  write(path.join(root, 'sub/inner.ts'), 'export {};\n');
  write(path.join(sibling, 'x.ts'), 'export const secret = 1;\n');
  write(path.join(outside, 'secret.ts'), 'export const secret = 2;\n');
  symlinkSync('../outside', path.join(root, 'out-link'), 'dir');
  symlinkSync('../outside/secret.ts', path.join(root, 'secret-link.ts'));
  symlinkSync('src/pay.ts', path.join(root, 'in-link.ts'));
  symlinkSync('../ws-evil', path.join(root, 'evil-link'), 'dir');
  return {
    base,
    root,
    sibling,
    outside,
    write: (rel, text) => write(path.join(root, rel), text),
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}
