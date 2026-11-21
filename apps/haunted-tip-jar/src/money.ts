/*
 * The only place text becomes money (design D10). Amounts are bigint minor
 * units of USDC (6 decimals). Nothing here passes an amount through a JS
 * number: parsing is a regex and string arithmetic, formatting is bigint
 * division and remainder.
 */

export const ASSET = 'USDC' as const;
export const DECIMALS = 6;
export const UNIT = 1_000_000n;
/** Largest tip or reversal the UI accepts: 1 000 000 USDC. */
export const MAX_AMOUNT = 1_000_000n * UNIT;

export type ParseResult = { ok: true; units: bigint } | { ok: false; error: string };

const AMOUNT_RE = /^(\d+)(?:\.(\d*))?$/;

/** Parses decimal USDC text ("12", "12.5", "0.000001") to minor units. */
export function parseUsdc(text: string): ParseResult {
  const s = text.trim();
  if (s === '') return { ok: false, error: 'Enter an amount' };
  if (s.startsWith('-')) return { ok: false, error: 'Amount must be positive' };
  const m = AMOUNT_RE.exec(s);
  if (!m) return { ok: false, error: 'Use digits and an optional decimal point, like 5 or 2.50' };
  const whole = m[1]!;
  const frac = m[2] ?? '';
  if (frac.length > DECIMALS) return { ok: false, error: `At most ${DECIMALS} decimal places` };
  if (whole.length > 13) return { ok: false, error: 'At most 1,000,000 USDC' };
  const units = BigInt(whole) * UNIT + BigInt(frac.padEnd(DECIMALS, '0') || '0');
  if (units === 0n) return { ok: false, error: 'Amount must be more than zero' };
  if (units > MAX_AMOUNT) return { ok: false, error: 'At most 1,000,000 USDC' };
  return { ok: true, units };
}

function split(units: bigint): { sign: string; whole: bigint; frac: string } {
  const neg = units < 0n;
  const abs = neg ? -units : units;
  return { sign: neg ? '-' : '', whole: abs / UNIT, frac: (abs % UNIT).toString().padStart(DECIMALS, '0') };
}

/** All 6 decimals: 12500000n → "12.500000". */
export function formatUsdc(units: bigint): string {
  const { sign, whole, frac } = split(units);
  return `${sign}${whole}.${frac}`;
}

/** Trailing zeros trimmed: 12500000n → "12.5", 3000000n → "3". */
export function formatUsdcShort(units: bigint): string {
  const { sign, whole, frac } = split(units);
  const f = frac.replace(/0+$/, '');
  return f === '' ? `${sign}${whole}` : `${sign}${whole}.${f}`;
}

/** Progress toward a goal in per-mille, clamped to 0–1000. The only ratio in the app, and it stays in bigint. */
export function goalPerMille(held: bigint, goal: bigint): number {
  if (goal <= 0n || held <= 0n) return 0;
  const p = (held * 1000n) / goal;
  return Number(p > 1000n ? 1000n : p);
}
