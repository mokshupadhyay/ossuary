// Feature: ossuary-power, Property 2: Injected violations are found on their line; clean code stays clean
// Validates: Requirements 2.5, 2.6, 2.7, 2.8
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { checkSource } from '../../src/checker.js';
import type { RuleId } from '../../src/rules.js';

/*
 * Mutation checks, each confirmed to fail this property before it was accepted:
 *   - disable the float-money detector (`if (false && isFloatMoney(...))`)
 *     → fails the line-level test, counterexample: `let amount: number = 0;` at line 1.
 *   - skip comment stripping (check the raw text)
 *     → fails all five tests (the neutral pool holds commented-out violations).
 *   - report `line: index` instead of `index + 1`
 *     → fails the three injection tests: every violation is one line early.
 *   - drop the transaction gate (`hasTransaction = false`)
 *     → fails the clean-program and line-level tests: gated writes are reported.
 */

/** Lines that trigger nothing. Comments may hold violating text. */
const NEUTRAL = [
  'const x = 1n;',
  'export function f(a: bigint) {',
  '}',
  'return a;',
  '',
  'const label = "hello";',
  'import { y } from "./y.js";',
  '  if (a > 0n) {',
  '// amount: number, wallet.balance += 1',
  '/* UPDATE wallets SET balance = 0 */',
  'const potId: number = 3;',
  'let captured = 0n;',
];

/** Lines that satisfy every file-level gate: a key, a transaction, a verifier and a refund cap. */
const GATES = [
  'const idempotencyKey = randomUUID();',
  'await db.transaction(async (tx) => {',
  'const handle = await createWebhookHandler(db, cfg);',
  'if (amount > remaining) throw new RefundCapExceededError(amount, remaining);',
  'await tx.insert(payouts).values(p);',
  'await postTransaction(db, { idempotencyKey, kind: "refund", entries }, tx);',
];

/** Rules found from one line alone, whatever the rest of the file says. */
const LINE_LEVEL: Record<'float-money' | 'mutable-balance' | 'unverified-webhook', string[]> = {
  'float-money': ['let amount: number = 0;', 'const fee = amount * 0.029;', 'const total = parseFloat(s);', 'return Number(row.paid_out);'],
  'mutable-balance': ['wallet.balance += amount;', 'await tx.execute(sql`UPDATE wallets SET balance = 0`);', 'await tx.update(entries).set({ note: "x" });'],
  'unverified-webhook': ['if (signature === expected) ok();', 'if (expected !== headers["x-signature"]) no();'],
};

/** Rules that need the file-level gate to be missing; checked in a neutral program. */
const GATED: { rule: RuleId; line: string }[] = [
  { rule: 'missing-idempotency-key', line: 'await postTransaction(db, { kind: "transfer", entries });' },
  { rule: 'unverified-webhook', line: 'const webhookEvent = await req.json();' },
  { rule: 'refund-over-capture', line: 'const r = { kind: "refund", entries };' },
];

const program = (pool: string[]) => fc.array(fc.constantFrom(...pool), { maxLength: 30 });
/** Every gate line at least once, mixed in any order with neutral and gate lines. */
const cleanProgram = program([...NEUTRAL, ...GATES]).chain((extra) => {
  const all = [...GATES, ...extra];
  return fc.shuffledSubarray(all, { minLength: all.length });
});
const insertAt = (lines: string[], index: number, line: string) => [...lines.slice(0, index), line, ...lines.slice(index)];
const found = (lines: string[]) => checkSource(lines.join('\n')).map((v) => `${v.rule}@${v.line}`);

const lineLevelArb = fc.constantFrom(...(Object.entries(LINE_LEVEL) as [RuleId, string[]][])).chain(([rule, lines]) =>
  fc.constantFrom(...lines).map((line) => ({ rule, line })),
);

describe('Property 2: injected violations are found on their line; clean code stays clean', () => {
  it('clean programs (neutral lines and every gate) have no violations', () => {
    fc.assert(
      fc.property(cleanProgram, (lines) => {
        expect(found(lines)).toEqual([]);
      }),
      { numRuns: 200 },
    );
  });

  it('a line-level violation inserted anywhere in a clean program is reported on that line, and nothing else is', () => {
    fc.assert(
      fc.property(cleanProgram, lineLevelArb, fc.nat(), (lines, { rule, line }, k) => {
        const index = k % (lines.length + 1);
        expect(found(insertAt(lines, index, line))).toEqual([`${rule}@${index + 1}`]);
      }),
      { numRuns: 200 },
    );
  });

  it('a gated violation inserted into a neutral program is reported on that line, and nothing else is', () => {
    fc.assert(
      fc.property(program(NEUTRAL), fc.constantFrom(...GATED), fc.nat(), (lines, { rule, line }, k) => {
        const index = k % (lines.length + 1);
        expect(found(insertAt(lines, index, line))).toEqual([`${rule}@${index + 1}`]);
      }),
      { numRuns: 200 },
    );
  });

  it('two writes with no transaction are reported on the second write', () => {
    fc.assert(
      fc.property(program(NEUTRAL), fc.nat(), fc.nat(), (lines, a, b) => {
        const i = a % (lines.length + 1);
        const withFirst = insertAt(lines, i, 'await db.insert(payouts).values(p);');
        const j = i + 1 + (b % (withFirst.length - i));
        const withBoth = insertAt(withFirst, j, 'await db.insert(outboxMessages).values(m);');
        expect(found(withBoth)).toEqual([`write-outside-transaction@${j + 1}`]);
      }),
      { numRuns: 200 },
    );
  });

  it('a violation that is commented out is not reported', () => {
    const anyViolation = fc.oneof(lineLevelArb, fc.constantFrom(...GATED));
    fc.assert(
      fc.property(program(NEUTRAL), anyViolation, fc.nat(), fc.boolean(), (lines, { line }, k, block) => {
        const index = k % (lines.length + 1);
        const commented = block ? `/* ${line} */` : `// ${line}`;
        expect(found(insertAt(lines, index, commented))).toEqual([]);
      }),
      { numRuns: 200 },
    );
  });
});
