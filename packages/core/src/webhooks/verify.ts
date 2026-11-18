import { createHmac, timingSafeEqual } from 'node:crypto';

export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
}

export type VerifyFailure =
  | 'missing_header'
  | 'malformed_signature'
  | 'bad_signature'
  | 'malformed_timestamp'
  | 'stale'
  | 'future';

export type VerifyResult = { ok: true; timestamp: number } | { ok: false; reason: VerifyFailure };

const SIGNATURE_RE = /^[0-9a-f]{64}$/;
const TIMESTAMP_RE = /^[0-9]{1,15}$/;
const DEFAULT_TOLERANCE_SECONDS = 300;

type HeaderBag = Headers | Record<string, string | undefined>;

function readHeader(headers: HeaderBag, name: string): string | undefined {
  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(name) ?? undefined;
  }
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers as Record<string, string | undefined>)) {
    if (k.toLowerCase() === want && typeof v === 'string') return v;
  }
  return undefined;
}

function mac(secret: Uint8Array | string, timestamp: string, rawBody: Uint8Array | string): Buffer {
  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody);
  return createHmac('sha256', secret)
    .update(Buffer.from(`${timestamp}.`, 'utf8'))
    .update(body)
    .digest();
}

/** Signs `<timestamp>.<rawBody>` with HMAC-SHA256. Returns 64 lowercase hex characters. */
export function signWebhook(
  secret: Uint8Array | string,
  timestamp: number,
  rawBody: Uint8Array | string,
): string {
  return mac(secret, String(timestamp), rawBody).toString('hex');
}

/**
 * Verifies a webhook. The timestamp is only used as signed input until the
 * signature has matched; the tolerance check comes last. Never throws on
 * hostile input and never echoes the secret or a signature.
 */
export function verifyWebhook(args: {
  secret: Uint8Array | string;
  rawBody: Uint8Array | string;
  headers: HeaderBag;
  clock: Clock;
  toleranceSeconds?: number;
}): VerifyResult {
  const { secret, rawBody, headers, clock } = args;
  const tolerance = args.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  try {
    const timestamp = readHeader(headers, 'ossuary-timestamp');
    const signature = readHeader(headers, 'ossuary-signature');
    if (timestamp === undefined || signature === undefined) {
      return { ok: false, reason: 'missing_header' };
    }
    if (!SIGNATURE_RE.test(signature)) return { ok: false, reason: 'malformed_signature' };
    if (!TIMESTAMP_RE.test(timestamp)) return { ok: false, reason: 'malformed_timestamp' };

    const expected = mac(secret, timestamp, rawBody);
    const given = Buffer.from(signature, 'hex');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return { ok: false, reason: 'bad_signature' };
    }

    const ts = Number(timestamp);
    const nowS = Math.floor(clock.now() / 1000);
    if (nowS - ts > tolerance) return { ok: false, reason: 'stale' };
    if (ts - nowS > tolerance) return { ok: false, reason: 'future' };
    return { ok: true, timestamp: ts };
  } catch {
    // Hostile or malformed input (for example a body that is not bytes).
    return { ok: false, reason: 'bad_signature' };
  }
}
