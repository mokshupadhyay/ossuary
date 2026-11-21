/*
 * The app is built from the skeleton, not around it (Requirement 10.4):
 * - it imports core only through `@ossuary/core` and `@ossuary/core/poltergeist`;
 * - it contains no copy of core code (no definition of core's internal functions);
 * - money paths never use floats (design D10).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SRC = join(ROOT, 'src');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

const sources = files(SRC).map((p) => ({ path: relative(ROOT, p), text: readFileSync(p, 'utf8') }));

const specifiers = (text: string): string[] =>
  [...text.matchAll(/(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => (m[1] ?? m[2])!);

describe('import boundaries', () => {
  it('scans every source file', () => {
    expect(sources.length).toBeGreaterThan(15);
  });

  it('imports core only through its two public entries, and never by relative path', () => {
    const bad: string[] = [];
    for (const f of sources) {
      for (const s of specifiers(f.text)) {
        const core = s.startsWith('@ossuary/core') && s !== '@ossuary/core' && s !== '@ossuary/core/poltergeist';
        const twin = s.startsWith('@ossuary/twin');
        const reach = /(^|\/)packages\//.test(s) || s.startsWith('../../');
        if (core || twin || reach) bad.push(`${f.path}: ${s}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('defines none of core’s functions (no copied code)', () => {
    const CORE_NAMES = [
      'allocateRefund',
      'claimOrReplay',
      'completeKey',
      'hashPayload',
      'canonicalize',
      'enforceNormalBalances',
      'applyEvent',
      'applyRefund',
      'applyCapture',
      'parseEvent',
      'verifyWebhook',
      'signWebhook',
      'ledgerKeyFor',
      'outboxKeyFor',
      'uuidV5',
      'runOutboxOnce',
      'postTransaction',
      'refund',
      'measureDrift',
      'generateStorm',
      'summon',
    ];
    const bad: string[] = [];
    for (const f of sources) {
      for (const n of CORE_NAMES) {
        const def = new RegExp(`(function\\s+${n}\\b|(const|let|var)\\s+${n}\\s*=|^\\s*(async\\s+)?${n}\\s*\\()`, 'm');
        if (def.test(f.text)) bad.push(`${f.path}: ${n}`);
      }
      if (/CREATE TABLE\s+(IF NOT EXISTS\s+)?(entries|transactions|accounts|webhook_events|outbox_messages|idempotency_records|payment_states)\b/i.test(f.text)) {
        bad.push(`${f.path}: creates a core table`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('the twin is reached only through the poltergeist engine', () => {
    expect(sources.filter((f) => f.text.includes('@ossuary/twin')).map((f) => f.path)).toEqual([]);
  });
});

describe('no floats on money paths', () => {
  // Files that handle amounts. UI files format amounts only via money.ts.
  const MONEY = ['src/money.ts', 'src/rail.ts', 'src/readModel.ts', 'src/jar.ts', 'src/seed.ts', 'src/overlayBus.ts'];

  it('no parseFloat, toFixed, Math.round or float literals near amounts', () => {
    const bad: string[] = [];
    for (const f of sources.filter((s) => MONEY.includes(s.path))) {
      f.text.split('\n').forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '');
        if (/parseFloat|toFixed|Math\.round|Math\.trunc|\*\s*1e\d|\d\.\d+\s*\*/.test(code)) bad.push(`${f.path}:${i + 1}: ${line.trim()}`);
        // Number() is allowed only for counts and HTTP status, never for an amount column.
        if (/Number\([^)]*(amount|captured|refunded|charged|held|total|remaining|goal)/i.test(code)) bad.push(`${f.path}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(bad).toEqual([]);
  });

  it('every SQL sum is cast to text before it reaches JavaScript', () => {
    const bad: string[] = [];
    for (const f of sources) {
      f.text.split('\n').forEach((line, i) => {
        if (!/\bsum\(/.test(line) || /::text/.test(line)) return;
        // CTE intermediates (per-tip sums) are summed again and cast to text in the outer SELECT.
        if (/\) AS (captured|refunded|charged_back)\b/.test(line)) return;
        // Sums of counts (not amounts) may be ints.
        if (/sum\(rejected\).*::int/.test(line)) return;
        bad.push(`${f.path}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(bad).toEqual([]);
  });
});
