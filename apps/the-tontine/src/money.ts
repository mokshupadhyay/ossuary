/*
 * Money in the Tontine: testnet-style USDC, held as bigint base units
 * (6 decimals). Amounts never pass through a JavaScript number: parsing and
 * formatting work on digit strings (money.md).
 */

export const ASSET = 'USDC' as const;
export const DECIMALS = 6;
const SCALE = 10n ** BigInt(DECIMALS);
/** 1,000,000 USDC. */
export const MAX_CONTRIBUTION = 1_000_000n * SCALE;

export class MoneyInputError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'MoneyInputError';
  }
}

/** Parses a decimal USDC amount ("50", "1,250.5", "0.000001") into base units. */
export function parseUsdc(input: string): bigint {
  const text = input.trim().replace(/\s*usdc$/i, '').replace(/,/g, '');
  if (text === '') throw new MoneyInputError('Enter an amount.');
  if (text.startsWith('-')) throw new MoneyInputError('The amount must be more than zero.');
  const m = /^(\d+)(?:\.(\d*))?$/.exec(text);
  if (!m) throw new MoneyInputError('Use digits and at most one decimal point, like 50 or 12.75.');
  const [, whole = '', fraction = ''] = m;
  if (fraction.length > DECIMALS) throw new MoneyInputError(`USDC has ${DECIMALS} decimal places at most.`);
  const units = BigInt(whole) * SCALE + BigInt(fraction.padEnd(DECIMALS, '0') || '0');
  if (units === 0n) throw new MoneyInputError('The amount must be more than zero.');
  if (units > MAX_CONTRIBUTION) throw new MoneyInputError('The most a contribution can be is 1,000,000 USDC.');
  return units;
}

function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Formats base units exactly: "1,250.50 USDC". At least 2, at most 6 decimals. */
export function formatUsdc(amount: bigint, options: { sign?: boolean; code?: boolean } = {}): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const whole = abs / SCALE;
  let fraction = (abs % SCALE).toString().padStart(DECIMALS, '0');
  while (fraction.length > 2 && fraction.endsWith('0')) fraction = fraction.slice(0, -1);
  const sign = negative ? '−' : options.sign && amount > 0n ? '+' : '';
  const code = options.code === false ? '' : ` ${ASSET}`;
  return `${sign}${group(whole.toString())}.${fraction}${code}`;
}
