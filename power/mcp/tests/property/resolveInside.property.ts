// Feature: ossuary-power, Property 1: Resolved paths never leave the workspace
// Validates: Requirements 1.6, 2.2, 2.3
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveInside } from '../../src/workspace.js';
import { createSandbox, type Sandbox } from '../helpers/sandbox.js';

/*
 * Mutation checks, each confirmed to fail this property before it was accepted:
 *   - resolveInside skips realpath and checks the lexical `candidate`
 *     → fails, counterexample ["evil-link/."] (a symlink to the ws-evil sibling is accepted).
 *   - isInside compares with `child.startsWith(root)` without the separator
 *     → fails, counterexample ["evil-link/x.ts"] (realpath <base>/ws-evil/x.ts is accepted).
 *   - the lexical `..` check is removed
 *     → passes, as expected: the realpath check still refuses every escape. The
 *       lexical check only saves a disk access, so it is not a gap in the property.
 */

let sb: Sandbox;
beforeAll(() => {
  sb = createSandbox();
});
afterAll(() => sb.cleanup());

const SEGMENTS = ['..', '.', 'src', 'sub', 'pay.ts', 'inner.ts', 'out-link', 'evil-link', 'secret.ts', 'x.ts', 'ws', 'ws-evil', 'secret-link.ts', 'in-link.ts', 'missing'];

const pathArb = fc.tuple(
  fc.constantFrom('', '', '', '/', './', 'C:\\', '\\\\'),
  fc.array(fc.constantFrom(...SEGMENTS), { minLength: 1, maxLength: 6 }),
  fc.constantFrom('/', '/', '\\'),
).map(([prefix, segs, sep]) => prefix + segs.join(sep));

/** Independent oracle: is the real target of `p` (resolved from the root) a file or dir inside the root? */
function trulyInside(root: string, p: string): boolean {
  try {
    const real = realpathSync(path.resolve(root, p));
    const rel = path.relative(root, real);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  } catch {
    return false;
  }
}

describe('Property 1: resolved paths never leave the workspace', () => {
  it('returns an error or a real path inside the root, and succeeds for every path that truly stays inside', () => {
    fc.assert(
      fc.property(pathArb, (p) => {
        const r = resolveInside(sb.root, p);
        const lexicallyRelative = !path.isAbsolute(p) && !/^(?:[a-zA-Z]:|[\\/]{2})/.test(p);
        const lexicallyInside =
          lexicallyRelative && !path.relative(sb.root, path.resolve(sb.root, p)).startsWith('..');
        if (r.ok) {
          // Soundness: what we accept really is inside, after following every link.
          const rel = path.relative(sb.root, realpathSync(r.data));
          expect(rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))).toBe(true);
          expect(r.data).toBe(realpathSync(r.data));
          expect(statSync(r.data)).toBeTruthy();
        } else if (lexicallyInside && trulyInside(sb.root, p)) {
          // Completeness: a relative path that truly stays inside must not be refused.
          throw new Error(`refused an inside path ${JSON.stringify(p)}: ${r.error.code}`);
        }
      }),
      { numRuns: 400 },
    );
  });
});
