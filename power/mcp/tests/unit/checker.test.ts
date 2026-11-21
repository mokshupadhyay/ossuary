import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkSource, identifierParts, isMoneyIdentifier, languageFor, summarize } from '../../src/checker.js';
import { RULE_IDS, RULES, type RuleId } from '../../src/rules.js';
import { REPO_ROOT } from '../helpers/sandbox.js';

const at = (src: string, filename?: string) => checkSource(src, { filename }).map((v) => `${v.rule}@${v.line}`);
const rulesIn = (src: string, filename?: string) => [...new Set(checkSource(src, { filename }).map((v) => v.rule))];

/** One snippet per rule, with the line the violation must be reported on. */
const SNIPPETS: Record<RuleId, { src: string; line: number; filename?: string }[]> = {
  'float-money': [
    { src: 'const x = 1n;\nlet tipAmount: number = 0;\n', line: 2 },
    { src: 'const fee = amount * 0.029;\n', line: 1 },
    { src: 'const total = parseFloat(input.total);\n', line: 1 },
    { src: 'label.textContent = (balance / 1e6).toFixed(2);\n', line: 1 },
    { src: 'const cents = Math.round(price * 100);\n', line: 1 },
    { src: 'return Number(row.paid_out);\n', line: 1 },
    { src: 'interface Tip {\n  amount?: number;\n}\n', line: 2 },
    { src: 'export const tips = pgTable("tips", {\n  amount: real("amount"),\n});\n', line: 2 },
    { src: 'CREATE TABLE tips (\n  id uuid,\n  amount double precision NOT NULL\n);\n', line: 3, filename: 'm.sql' },
    { src: 'CREATE TABLE tips (\n  price numeric(12, 2)\n);\n', line: 2, filename: 'm.sql' },
    { src: 'await sql`ALTER TABLE tips ADD COLUMN fee real`;\n', line: 1 },
  ],
  'mutable-balance': [
    { src: 'const idempotencyKey = k;\nawait db.transaction(async (tx) => {\n  await tx.execute(sql`UPDATE wallets SET balance = balance - ${amount}`);\n});\n', line: 3 },
    { src: 'wallet.balance += amount;\n', line: 1 },
    { src: 'balances[memberId] -= payout;\n', line: 1 },
    { src: 'this.pot -= amount;\n', line: 1 },
    { src: 'await tx.update(wallets).set({ balance: next });\n', line: 1 },
    { src: 'await tx.execute(sql`DELETE FROM entries WHERE id = ${id}`);\n', line: 1 },
    { src: 'await tx.update(entries).set({ note: "x" });\n', line: 1 },
    { src: 'CREATE TABLE wallets (\n  id uuid PRIMARY KEY,\n  balance bigint NOT NULL\n);\n', line: 3, filename: 'w.sql' },
    { src: 'export const wallets = pgTable("wallets", {\n  balance: bigint("balance", { mode: "bigint" }),\n});\n', line: 2 },
    { src: 'INSERT INTO circles (id, pot) VALUES ($1, $2)\nON CONFLICT (id) DO UPDATE SET pot = circles.pot + EXCLUDED.pot;\n', line: 2, filename: 'x.sql' },
  ],
  'missing-idempotency-key': [
    { src: 'export async function payOut(db, potId, memberId, amount) {\n  return postTransaction(db, { kind: "transfer", entries });\n}\n', line: 2 },
    { src: 'await refund(db, { paymentId, amount });\n', line: 1 },
    { src: 'const r = await transfer(from, to, amount);\n', line: 1 },
    { src: 'await client.query("INSERT INTO entries (account_id, amount) VALUES ($1, $2)", [a, n]);\n', line: 1 },
  ],
  'unverified-webhook': [
    { src: 'export async function handleWebhook(req: Request) {\n  const event = await req.json();\n  return apply(event);\n}\n', line: 2 },
    { src: 'export async function POST(request: Request) {\n  const body = await request.text();\n  return apply(JSON.parse(body));\n}\n', line: 2, filename: 'app/api/webhooks/rail/route.ts' },
    { src: 'const expected = hmac(secret, body);\nif (signature === expected) accept();\n', line: 2 },
    { src: 'if (expected !== req.headers["x-signature"]) return reject();\n', line: 1 },
  ],
  'write-outside-transaction': [
    { src: 'const idempotencyKey = k;\nawait db.insert(payouts).values(p);\nawait db.insert(outboxMessages).values(m);\n', line: 3 },
    { src: 'const idempotencyKey = k;\nawait postTransaction(db, a);\nawait postTransaction(db, b);\n', line: 3 },
    { src: 'INSERT INTO payouts VALUES (1);\nUPDATE members SET paid = true WHERE id = 1;\n', line: 2, filename: 'seed.sql' },
  ],
  'refund-over-capture': [
    { src: 'const idempotencyKey = k;\nawait postTransaction(db, {\n  idempotencyKey,\n  kind: "refund",\n  entries,\n});\n', line: 4 },
    { src: 'await tx.execute(sql`INSERT INTO refunds (payment_id, amount) VALUES (${id}, ${amount})`);\n', line: 1 },
  ],
};

describe('checkSource: one snippet per rule', () => {
  for (const id of RULE_IDS) {
    for (const [n, s] of SNIPPETS[id].entries()) {
      it(`${id} #${n + 1} is reported on line ${s.line}`, () => {
        const vs = checkSource(s.src, { filename: s.filename });
        expect(vs.filter((v) => v.rule === id).map((v) => v.line)).toContain(s.line);
      });
    }
  }
});

describe('checkSource: things that must stay clean', () => {
  it.each([
    ['bigint amounts', 'const amount: bigint = 1999n;\nconst total = a + b;\n'],
    ['ids and counts named after money', 'const potId: number = 3;\nconst tipCount: number = 0;\nconst refundId: number = 1;\n'],
    ['local accumulators', 'let captured = 0n;\nfor (const r of rows) captured += BigInt(r.positive);\n'],
    ['derived balance queries', "const r = await tx.execute(sql`SELECT coalesce(sum(amount), 0) AS balance FROM entries`);\n"],
    ['a status update', "UPDATE payments SET status = 'captured' WHERE id = $1;\n"],
    ['undefined checks on a signature', 'if (signature === undefined) return reject();\nif (typeof sig !== "string") return reject();\n'],
    ['words that only contain "sig"', 'const ok = sign === 1n;\nif (design === other) go();\n'],
    ['a version string', 'const amount = 5n; const v = "1.2.3";\n'],
    ['core refund() call with a key', 'await refund(db, { idempotencyKey, paymentId, amount });\n'],
    ['writes inside a transaction', 'await db.transaction(async (tx) => {\n  await tx.insert(a).values(x);\n  await tx.insert(b).values(y);\n});\n'],
    ['a capped refund', 'if (amount > remaining) throw new RefundCapExceededError(amount, remaining);\nawait postTransaction(db, { idempotencyKey, kind: "refund", entries }, tx);\n'],
    ['a verified webhook', 'const handle = await createWebhookHandler(db, cfg);\nexport const handleWebhook = async (req: Request) => handle({ rawBody: await req.text(), headers: req.headers });\n'],
  ])('%s', (_name, src) => {
    expect(at(src)).toEqual([]);
  });

  it('ignores violations inside comments, and keeps line numbers after them', () => {
    const src = '/*\n  amount: number\n  UPDATE wallets SET balance = 0\n*/\n// wallet.balance += 1\nconst fee = amount * 0.5;\n';
    expect(at(src)).toEqual(['float-money@6']);
  });

  it('ignores -- comments in SQL files only', () => {
    expect(at('-- amount real\nSELECT 1;\n', 'x.sql')).toEqual([]);
    expect(at('CREATE TABLE t (\n  amount real -- dollars\n);\n', 'x.sql')).toEqual(['float-money@2']);
  });
});

describe('checkSource: shape and order', () => {
  it('sorts by line then rule id, with one violation per (line, rule)', () => {
    const src = 'wallet.balance += 0.5 + Number(amount);\nconst x: { amount: number; total: number } = y;\n';
    const vs = checkSource(src);
    expect(vs.map((v) => `${v.rule}@${v.line}`)).toEqual(['float-money@1', 'mutable-balance@1', 'float-money@2']);
  });

  it('fills excerpt, message and fix from the source and the catalog', () => {
    const [v] = checkSource(`  const x = 1n;\n    let amount: number = ${'9'.repeat(300)};\n`);
    expect(v).toMatchObject({ rule: 'float-money', line: 2 });
    expect(v!.excerpt.startsWith('let amount: number')).toBe(true);
    expect(v!.excerpt.length).toBe(200);
    expect(v!.message).toBe(RULES.find((r) => r.id === 'float-money')!.message);
    expect(v!.fix).toBe(RULES.find((r) => r.id === 'float-money')!.fix);
  });

  it('is deterministic and summarizes per rule', () => {
    const src = SNIPPETS['mutable-balance'].map((s) => s.src).join('\n');
    expect(checkSource(src)).toEqual(checkSource(src));
    const vs = checkSource('a.balance += 1;\nb.balance += 1;\nlet amount: number;\n');
    expect(summarize(vs)).toEqual({ total: 3, byRule: { 'mutable-balance': 2, 'float-money': 1 } });
    expect(summarize([])).toEqual({ total: 0, byRule: {} });
  });

  it('splits identifiers and names money', () => {
    expect(identifierParts('paidOutUSDCTotal_minor')).toEqual(['paid', 'out', 'usdc', 'total', 'minor']);
    expect(isMoneyIdentifier('tipAmount')).toBe(true);
    expect(isMoneyIdentifier('paid_out')).toBe(true);
    expect(isMoneyIdentifier('tipId')).toBe(false);
    expect(isMoneyIdentifier('multiple')).toBe(false);
    expect(isMoneyIdentifier('spotlight')).toBe(false);
    expect(languageFor('a/b.SQL')).toBe('sql');
    expect(languageFor('a.ts')).toBe('ts');
    expect(languageFor(null)).toBe('ts');
  });
});

describe('checkSource: worst-case input', () => {
  // A 262,144-character identifier once took about 2 minutes (quadratic backtracking in `ID\s+`).
  it.each([
    ['one long identifier', 'x'.repeat(262_144)],
    ['repeated sig', 'sig'.repeat(87_381)],
    ['unclosed brackets', 'a['.repeat(131_072)],
    ['comparisons', '>a'.repeat(131_072)],
    ['money words', 'amount '.repeat(37_449)],
    ['spaces after an identifier', `amount${' '.repeat(262_000)}`],
    ['spaces before a colon', `amount${' '.repeat(131_000)}?${' '.repeat(131_000)}`],
    ['a long key inside .set({', `.set({ ${'x'.repeat(262_000)}`],
    ['spaces after keywords', `UPDATE ${' '.repeat(131_000)}SET ${' '.repeat(131_000)}`],
    ['spaces around dots', `a${' . '.repeat(87_000)}`],
    ['open parentheses', `postTransaction${'( '.repeat(131_000)}`],
    ['block comment opener in a string', `'${'/*'.repeat(131_000)}`],
  ])('checks %s in linear time', (_name, src) => {
    const started = performance.now();
    checkSource(src);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('the rule catalog', () => {
  it('has the six rules, in order, frozen', () => {
    expect(RULES.map((r) => r.id)).toEqual([...RULE_IDS]);
    expect(Object.isFrozen(RULES)).toBe(true);
    expect(RULES.every((r) => Object.isFrozen(r))).toBe(true);
  });

  it.each(RULES.map((r) => [r.id, r] as const))('%s quotes its steering file verbatim', (_id, r) => {
    const steering = readFileSync(path.join(REPO_ROOT, r.steeringFile), 'utf8');
    expect(steering).toContain(r.rule);
  });

  it.each(RULES.map((r) => [r.id, r] as const))('%s: the bug is flagged for its rule and the fix is clean', (id, r) => {
    expect(rulesIn(r.bug)).toContain(id);
    expect(checkSource(r.fixExample)).toEqual([]);
  });
});

describe('real code in this repository', () => {
  const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), 'utf8');

  it.each([
    'packages/core/src/ledger/postTransaction.ts',
    'packages/core/src/ledger/refund.ts',
    'packages/core/src/ledger/balance.ts',
    'packages/core/src/ledger/idempotency.ts',
    'packages/core/src/webhooks/handler.ts',
    'packages/core/src/webhooks/apply.ts',
    'packages/core/src/webhooks/verify.ts',
    'packages/core/src/outbox/worker.ts',
    'packages/core/src/migrations/0003_create_entries.sql',
    'packages/core/src/migrations/0004_append_only_trigger.sql',
  ])('Ossuary core is clean: %s', (rel) => {
    expect(at(read(rel), rel)).toEqual([]);
  });

  it('the Vibe Pay twin is flagged for float money, mutable balances and an unverified webhook', () => {
    const rel = 'packages/twin/src/index.ts';
    expect(rulesIn(read(rel), rel)).toEqual(
      expect.arrayContaining(['float-money', 'mutable-balance', 'unverified-webhook', 'refund-over-capture']),
    );
  });
});
