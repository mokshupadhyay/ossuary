// Package boundaries for the poltergeist (poltergeist-engine Requirements 12.3, 14.3).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const coreRoot = fileURLToPath(new URL('../..', import.meta.url));
const src = join(coreRoot, 'src');

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return tsFiles(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}

/** Every module specifier in `import`/`export ... from` statements and dynamic `import()` calls. */
export function specifiers(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const out: string[] = [];
  const re = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of text.matchAll(re)) out.push((m[1] ?? m[2] ?? m[3])!);
  return out;
}

const MONEY_DIRS = ['ledger', 'webhooks', 'outbox', 'db', 'schema', 'types', 'errors'];

describe('poltergeist boundaries', () => {
  it('no money module imports src/poltergeist', () => {
    const offenders: string[] = [];
    for (const dir of MONEY_DIRS) {
      for (const f of tsFiles(join(src, dir))) {
        for (const s of specifiers(f)) if (s.includes('poltergeist')) offenders.push(`${relative(coreRoot, f)} -> ${s}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('src/index.ts exports nothing from the poltergeist', () => {
    expect(specifiers(join(src, 'index.ts')).filter((s) => s.includes('poltergeist'))).toEqual([]);
  });

  it('package.json exports "." and "./poltergeist", and the subpath entry loads', async () => {
    const pkg = JSON.parse(readFileSync(join(coreRoot, 'package.json'), 'utf8')) as { exports: Record<string, string> };
    expect(pkg.exports['.']).toBe('./src/index.ts');
    expect(pkg.exports['./poltergeist']).toBe('./src/poltergeist/index.ts');
    const entry = (await import('../../src/poltergeist/index.js')) as Record<string, unknown>;
    for (const name of ['generateStorm', 'summon', 'ossuaryFactory', 'serializeReport', 'FAULTS', 'measureDrift', 'REPORT_VERSION']) {
      expect(entry[name], name).toBeDefined();
    }
  });

  it('the twin imports nothing from Ossuary or from outside packages/twin', () => {
    const twinSrc = join(coreRoot, '../twin/src');
    const files = tsFiles(twinSrc);
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.flatMap((f) =>
      specifiers(f)
        .filter((s) => s.includes('@ossuary') || s.startsWith('..') || s.startsWith('/'))
        .map((s) => `${relative(coreRoot, f)} -> ${s}`),
    );
    expect(offenders).toEqual([]);
  });

  it('no module imports the Node-only cli.ts', () => {
    const offenders = tsFiles(src).filter((f) => specifiers(f).some((s) => /(^|\/)cli(\.js|\.ts)?$/.test(s)));
    expect(offenders.map((f) => relative(coreRoot, f))).toEqual([]);
  });

  it('nothing under src/poltergeist uses Math.random', () => {
    const offenders = tsFiles(join(src, 'poltergeist')).filter((f) => /Math\.random\s*\(/.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => relative(coreRoot, f))).toEqual([]);
  });
});
