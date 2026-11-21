// poltergeist-engine Requirement 14, design D8: the library entry must load in a browser bundle.
/*
 * Mutation checks (Requirement 14.6), each confirmed to fail this file:
 *   - `import 'node:fs';` at the top of src/poltergeist/storm.ts;
 *   - importing and calling runMigrations in sut.ts instead of applyEmbeddedMigrations
 *     (reaches node:fs and node:url through drizzle's migrator);
 *   - `Buffer.from` in src/poltergeist/rail.ts (caught by the source scan).
 */
import { builtinModules } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Plugin } from 'esbuild';
import { describe, expect, it } from 'vitest';

const coreRoot = fileURLToPath(new URL('../..', import.meta.url));
const poltergeistDir = join(coreRoot, 'src/poltergeist');
const BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
const ALLOWED_CRYPTO = new Set(['randomUUID', 'createHash', 'createHmac', 'timingSafeEqual']);

const isBuiltin = (path: string) => BUILTINS.has(path) || BUILTINS.has(path.split('/')[0]!) || path.startsWith('node:');

async function bundle() {
  const hits: { path: string; importer: string; kind: string }[] = [];
  const recorder: Plugin = {
    name: 'record-node-builtins',
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) => {
        if (!isBuiltin(args.path)) return undefined;
        hits.push({ path: args.path, importer: args.importer.replace(coreRoot, ''), kind: args.kind });
        return { path: args.path, external: true };
      });
    },
  };
  const result = await build({
    entryPoints: [join(poltergeistDir, 'index.ts')],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'esm',
    logLevel: 'silent',
    // PGlite is the apps' browser database; its browser build keeps guarded
    // dynamic imports for its Node file systems, which are its own concern.
    external: ['@electric-sql/pglite', '@electric-sql/pglite/*'],
    plugins: [recorder],
  });
  return { hits, code: result.outputFiles[0]!.text };
}

describe('browser-safe library entry', () => {
  it('bundles for the browser importing no Node built-in except node:crypto', async () => {
    const { hits } = await bundle();
    const offenders = hits.filter((h) => h.path !== 'node:crypto').map((h) => `${h.path} <- ${h.importer} (${h.kind})`);
    expect(offenders, offenders.join('\n')).toEqual([]);
  }, 60_000);

  it('uses only randomUUID, createHash, createHmac and timingSafeEqual from node:crypto', async () => {
    const { code } = await bundle();
    const names = [...code.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']node:crypto["']/g)].flatMap((m) =>
      m[1]!.split(',').map((s) => s.trim().split(/\s+as\s+/)[0]!).filter(Boolean),
    );
    expect(names.length).toBeGreaterThan(0);
    const extra = names.filter((n) => !ALLOWED_CRYPTO.has(n));
    expect(extra, `node:crypto imports outside the allowed set: ${extra.join(', ')}`).toEqual([]);
    expect(code).not.toMatch(/import\s+\*\s+as\s+\w+\s+from\s*["']node:crypto["']|import\s+\w+\s+from\s*["']node:crypto["']/);
  }, 60_000);

  it('no poltergeist module except cli.ts reads process or Buffer', () => {
    const offenders: string[] = [];
    for (const name of readdirSync(poltergeistDir)) {
      if (!name.endsWith('.ts') || name === 'cli.ts') continue;
      const text = readFileSync(join(poltergeistDir, name), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      for (const word of ['process.', 'process[', 'Buffer']) if (text.includes(word)) offenders.push(`${name}: ${word}`);
    }
    expect(offenders).toEqual([]);
  });
});
