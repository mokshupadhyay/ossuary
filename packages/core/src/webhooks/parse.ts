import { InvalidWebhookPayloadError } from '../errors/index.js';

export type EventType = 'payment.pending' | 'payment.captured' | 'payment.refunded';

export type ParsedEvent =
  | { known: true; id: string; type: EventType; paymentId: string; asset: string; amount: bigint | null }
  | { known: false; id: string; type: string; paymentId: string; asset: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AMOUNT_RE = /^[1-9][0-9]{0,18}$/;
const INT8_MAX = 9223372036854775807n;
const KNOWN: ReadonlySet<string> = new Set(['payment.pending', 'payment.captured', 'payment.refunded']);

const fail = (field: string, reason: string): never => {
  throw new InvalidWebhookPayloadError(field, reason);
};

/**
 * Parses a webhook body that has already been signature-verified. Reasons are
 * fixed text and never echo body content. Amounts go from string to bigint
 * without passing through `number`.
 */
export function parseEvent(rawBody: string, ledgerAsset: string): ParsedEvent {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return fail('body', 'invalid JSON');
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return fail('body', 'must be a JSON object');
  }
  const o = json as Record<string, unknown>;

  const id = o['id'];
  if (typeof id !== 'string') return fail('id', 'must be a string');
  const idLen = Array.from(id).length;
  if (idLen < 1 || idLen > 255) return fail('id', 'must be 1-255 characters');
  // Postgres text cannot store U+0000. Without this check the insert throws, the handler answers 500, and the rail
  // retries the same event forever. A 400 tells it to stop.
  if (id.includes('\u0000')) return fail('id', 'must not contain NUL characters');

  const type = o['type'];
  if (typeof type !== 'string') return fail('type', 'must be a string');
  if (type.includes('\u0000')) return fail('type', 'must not contain NUL characters');

  const paymentId = o['paymentId'];
  if (typeof paymentId !== 'string' || !UUID_RE.test(paymentId)) {
    return fail('paymentId', 'must be a UUID');
  }

  const asset = o['asset'];
  if (typeof asset !== 'string' || asset !== ledgerAsset) {
    return fail('asset', 'must equal the ledger asset');
  }

  const pid = paymentId.toLowerCase();
  if (!KNOWN.has(type)) return { known: false, id, type, paymentId: pid, asset };

  let amount: bigint | null = null;
  if (type !== 'payment.pending') {
    const raw = o['amount'];
    if (typeof raw !== 'string' || !AMOUNT_RE.test(raw)) {
      return fail('amount', 'must be a decimal string of minor units, 1 or more, no leading zeros');
    }
    amount = BigInt(raw);
    if (amount > INT8_MAX) return fail('amount', 'exceeds the maximum amount');
  }
  return { known: true, id, type: type as EventType, paymentId: pid, asset, amount };
}
