/**
 * Heuristic, comment-aware, line-based money-code checker (design D5).
 * It is a fast first pass, not a proof: it reads text, not types or data flow.
 */
import { RULES_BY_ID, type RuleId } from './rules.js';
import { stripComments, type SourceLanguage } from './strip.js';

export interface Violation {
  rule: RuleId;
  /** 1-based line number in the original source. */
  line: number;
  /** Trimmed original source line, at most 200 characters. */
  excerpt: string;
  message: string;
  fix: string;
}

export interface CheckOptions {
  /** Used to pick SQL or TypeScript comment syntax and to spot webhook handlers. */
  filename?: string | null;
}

const MAX_EXCERPT = 200;

// ---------------------------------------------------------------- identifiers

/** Identifier parts that name money. */
const MONEY_PARTS = new Set([
  'amount', 'amounts', 'balance', 'balances', 'price', 'prices', 'total', 'totals', 'subtotal',
  'fee', 'fees', 'tip', 'tips', 'pot', 'pots', 'cents', 'usdc', 'payout', 'payouts', 'refund',
  'refunds', 'refunded', 'paid', 'paidout', 'captured', 'minor', 'wei',
]);
/** A last part that makes the identifier a label for money, not money. */
const LABEL_SUFFIXES = new Set([
  'id', 'ids', 'key', 'keys', 'name', 'names', 'type', 'types', 'status', 'state', 'count', 'counts',
  'at', 'ref', 'refs', 'url', 'kind', 'code', 'asset', 'currency', 'index', 'idx', 'event', 'events',
  'label', 'labels', 'decimals', 'error', 'errors', 'jar', 'circle', 'button',
]);

/** Splits camelCase, PascalCase, snake_case and kebab-case into lowercase parts. */
export function identifierParts(ident: string): string[] {
  return ident
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_\-$]+/)
    .filter(Boolean)
    .map((p) => p.toLowerCase());
}

export function isMoneyIdentifier(ident: string): boolean {
  const parts = identifierParts(ident);
  if (parts.length === 0 || LABEL_SUFFIXES.has(parts[parts.length - 1]!)) return false;
  return parts.some((p) => MONEY_PARTS.has(p));
}

const IDENT = /[A-Za-z_$][\w$]*/g;
const hasMoneyIdentifier = (line: string): boolean => (line.match(IDENT) ?? []).some(isMoneyIdentifier);

/** True when some match of `re` has a money identifier in capture group 1 (or 2). */
function matchesMoney(line: string, re: RegExp): boolean {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  for (const m of line.matchAll(g)) {
    const ident = m[1] ?? m[2];
    if (ident !== undefined && isMoneyIdentifier(ident)) return true;
  }
  return false;
}

// ---------------------------------------------------------------- patterns

/**
 * An identifier captured in group `n`, matched atomically (lookahead + backreference)
 * and only at an identifier start, so a long identifier cannot cause backtracking.
 */
const id = (n: number): string => `(?<![\\w$])(?=([A-Za-z_$][\\w$]*))\\${n}`;
const ID = id(1);

// float-money
const TYPED_NUMBER = new RegExp(String.raw`${ID}\s*(?:\?\s*)?:\s*number\b`);
const FLOAT_OPS = [/\bparseFloat\s*\(/, /\.toFixed\s*\(/, /\bMath\.(?:round|floor|ceil|trunc)\s*\(/, /\bNumber\s*\(/, /(?<![\w.'"$`])\d+\.\d+(?![\w.])/];
const FLOAT_SQL_COLUMN = new RegExp(
  String.raw`"?${ID}"?\s+(?:real|float4|float8|float|double\s+precision|(?:decimal|numeric)\s*\(\s*\d+\s*,\s*[1-9]\d*\s*\))(?![\w])`,
  'i',
);
const FLOAT_DRIZZLE = new RegExp(String.raw`\b(?:real|doublePrecision|float)\s*\(\s*['"]${ID}['"]`);

// mutable-balance
const SET_COLUMN = new RegExp(String.raw`\bSET\s+(?:[\w"]+\.)?"?${ID}"?\s*=`, 'i');
const DRIZZLE_SET = /\.set\s*\(\s*\{([^}]*)/;
const COMPOUND_ON_STATE = new RegExp(String.raw`(?:[\w$\])]\s*\.\s*${id(1)}|${id(2)}\s*\[[^\]]{0,200}\])\s*(?:\+\+|--|[+\-*/]=)`);
const BALANCE_COLUMN_SQL = new RegExp(String.raw`"?${ID}"?\s+(?:bigint|integer|int|int8|numeric|decimal|real|float|double\s+precision|money)\b`, 'i');
const BALANCE_COLUMN_DRIZZLE = /\b(?:bigint|integer|numeric|decimal|real|doublePrecision)\s*\(\s*['"](\w+)['"]/;
const ENTRIES_MUTATION = /\bUPDATE\s+(?:ONLY\s+)?"?entries"?\s+SET\b|\bDELETE\s+FROM\s+(?:ONLY\s+)?"?entries"?(?![\w])|\.\s*(?:update|delete)\s*\(\s*entries\s*\)/i;

// missing-idempotency-key
const MONEY_CALL = /\b(?:postTransaction|refund|payout|payOut|transfer|charge)\s*\(|\bINSERT\s+INTO\s+"?(?:entries|transactions|ledger\w*)"?(?![\w])|\.\s*insert\s*\(\s*(?:entries|transactions)\s*\)/;
const MONEY_FN_DEF = /\bfunction\s*\*?\s*(?:postTransaction|refund|payout|payOut|transfer|charge)\s*\(|^\s*(?:async\s+)?(?:postTransaction|refund|payout|payOut|transfer|charge)\s*\([^)]*\)\s*(?::[^={]*)?\{/;
const MENTIONS_IDEMPOTENCY = /idempoten/i;

// unverified-webhook
const BODY_READ = /\.\s*(?:json|text|arrayBuffer|formData)\s*\(\s*\)|\b(?:req|request)\.body\b/;
const VERIFIER = /\b(?:verifyWebhook|createWebhookHandler|timingSafeEqual|verify\w*Signature|constructEvent)\b/;
/** A signature-like operand on either side of ==, ===, != or !==. */
const SIG = String.raw`(?:[sS]ignature|[sS]ig(?![a-z])|[hH]mac|HMAC|[dD]igest)`;
const SIGNATURE_COMPARE = [
  new RegExp(String.raw`${SIG}[\w$]{0,64}(?:\(\))?\s*[!=]==?(?!=)\s*(?!undefined\b|null\b|''|""|0\b)\S`),
  new RegExp(String.raw`(?<![\w.'"\`])[!=]==?(?!=)\s*[\w.$\[\]'"\-]{0,200}${SIG}`),
];
const BENIGN_COMPARE = /\btypeof\b|\.length\b|\b(?:undefined|null)\s*[!=]==?/;

// write-outside-transaction
const WRITE = /\bINSERT\s+INTO\b|\bUPDATE\s+[\w".]+\s+SET\b|\bDELETE\s+FROM\b|\b(?:db|client|pool|conn)\s*\.\s*(?:insert|update|delete)\s*\(|\bpostTransaction\s*\(/i;
const TRANSACTION = /\.\s*transaction\s*\(|\bBEGIN\b|\bwithTransaction\b|\btx\b|\btrx\b|\bcallerTx\b/;

// refund-over-capture
const WRITE_ON_LINE = /\bINSERT\s+INTO\b|\bUPDATE\s+[\w".]+\s+SET\b|\bpostTransaction\s*\(|\.\s*insert\s*\(/i;
const REFUND_KIND = /\bkind\s*:\s*['"]refund['"]/;
const REFUND_CAP = /(?:captured|remaining|refundable)\w{0,64}\s*(?<![=-])[<>]=?|(?<![=-])[<>]=?\s*[\w.]{0,100}(?:captured|remaining|refundable)|RefundCapExceeded/i;

// ---------------------------------------------------------------- checker

/** Picks comment syntax from the file extension. */
export function languageFor(filename: string | null | undefined): SourceLanguage {
  return filename && /\.sql$/i.test(filename) ? 'sql' : 'ts';
}

const isFloatMoney = (line: string, lang: SourceLanguage): boolean =>
  matchesMoney(line, FLOAT_SQL_COLUMN) ||
  (lang === 'ts' &&
    (matchesMoney(line, TYPED_NUMBER) ||
      matchesMoney(line, FLOAT_DRIZZLE) ||
      (hasMoneyIdentifier(line) && FLOAT_OPS.some((re) => re.test(line)))));

const isBalanceName = (name: string): boolean => identifierParts(name).some((p) => p === 'balance' || p === 'balances');

function isMutableBalance(line: string, lang: SourceLanguage): boolean {
  if (matchesMoney(line, SET_COLUMN) || ENTRIES_MUTATION.test(line)) return true;
  const drizzleSet = DRIZZLE_SET.exec(line);
  if (drizzleSet && [...drizzleSet[1]!.matchAll(new RegExp(String.raw`${ID}\s*:`, 'g'))].some((m) => isMoneyIdentifier(m[1]!))) return true;
  if (lang === 'ts' && matchesMoney(line, COMPOUND_ON_STATE)) return true;
  const sqlCol = BALANCE_COLUMN_SQL.exec(line);
  if (sqlCol && isBalanceName(sqlCol[1]!) && !/\bAS\b|\bSELECT\b|\bsum\s*\(/i.test(line)) return true;
  const drizzleCol = BALANCE_COLUMN_DRIZZLE.exec(line);
  return drizzleCol !== null && isBalanceName(drizzleCol[1]!);
}

const isSignatureCompare = (line: string): boolean =>
  SIGNATURE_COMPARE.some((re) => re.test(line)) && !BENIGN_COMPARE.test(line) && !/timingSafeEqual/.test(line);

/** Checks one source text. Deterministic; sorted by line, then rule id; one violation per (line, rule). */
export function checkSource(src: string, options: CheckOptions = {}): Violation[] {
  const filename = options.filename ?? null;
  const lang = languageFor(filename);
  const originalLines = src.split('\n');
  const stripped = stripComments(src, lang);
  const lines = stripped.split('\n');

  const found = new Map<string, Violation>();
  const report = (rule: RuleId, index: number): void => {
    const key = `${index}:${rule}`;
    if (found.has(key)) return;
    const r = RULES_BY_ID.get(rule)!;
    const excerpt = (originalLines[index] ?? '').trim().slice(0, MAX_EXCERPT);
    found.set(key, { rule, line: index + 1, excerpt, message: r.message, fix: r.fix });
  };

  // File-level facts, all on comment-free text.
  const isWebhookHandler = (/webhook/i.test(stripped) || /webhook/i.test(filename ?? '')) && BODY_READ.test(stripped);
  const hasIdempotency = MENTIONS_IDEMPOTENCY.test(stripped);
  const hasVerifier = VERIFIER.test(stripped);
  const hasTransaction = TRANSACTION.test(stripped);
  const hasRefundCap = REFUND_CAP.test(stripped);

  lines.forEach((line, i) => {
    if (isFloatMoney(line, lang)) report('float-money', i);
    if (isMutableBalance(line, lang)) report('mutable-balance', i);
    if (lang === 'ts' && isSignatureCompare(line)) report('unverified-webhook', i);
  });

  if (!hasIdempotency && !isWebhookHandler) {
    const i = lines.findIndex((l) => MONEY_CALL.test(l) && !MONEY_FN_DEF.test(l));
    if (i >= 0) report('missing-idempotency-key', i);
  }

  if (isWebhookHandler && !hasVerifier) {
    const i = lines.findIndex((l) => BODY_READ.test(l));
    if (i >= 0) report('unverified-webhook', i);
  }

  if (!hasTransaction) {
    const writes = lines.flatMap((l, i) => (WRITE.test(l) && !MONEY_FN_DEF.test(l) ? [i] : []));
    if (writes.length >= 2) report('write-outside-transaction', writes[1]!);
  }

  if (!hasRefundCap) {
    const i = lines.findIndex((l) => REFUND_KIND.test(l) || (/refund/i.test(l) && WRITE_ON_LINE.test(l)));
    if (i >= 0) report('refund-over-capture', i);
  }

  return [...found.values()].sort((a, b) => a.line - b.line || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0));
}

/** Counts violations per rule. */
export function summarize(violations: readonly Violation[]): { total: number; byRule: Partial<Record<RuleId, number>> } {
  const byRule: Partial<Record<RuleId, number>> = {};
  for (const v of violations) byRule[v.rule] = (byRule[v.rule] ?? 0) + 1;
  return { total: violations.length, byRule };
}
