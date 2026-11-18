import { createHash } from 'node:crypto';

/**
 * UUID version 5 (RFC 4122 §4.3): SHA-1 over the namespace bytes followed by
 * the UTF-8 bytes of `name`. Deterministic: the same input is the same key.
 */
export function uuidV5(namespace: string, name: string): string {
  const hex = namespace.replace(/-/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new TypeError('namespace must be a UUID');
  const hash = createHash('sha1')
    .update(Buffer.from(hex, 'hex'))
    .update(Buffer.from(name, 'utf8'))
    .digest();
  const b = hash.subarray(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x50; // version 5
  b[8] = (b[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export const LEDGER_KEY_NAMESPACE = 'e2dd6ea3-afb0-4b40-9eea-7be99517c2cd';
export const OUTBOX_KEY_NAMESPACE = 'b3328300-043a-4c7a-8156-46bf9f8a1e00';

/** Ledger idempotency key for the ledger change made by a rail event. */
export const ledgerKeyFor = (eventId: string): string => uuidV5(LEDGER_KEY_NAMESPACE, eventId);

/** Idempotency key sent with an outbox message for an event and topic. */
export const outboxKeyFor = (eventId: string, topic: string): string =>
  uuidV5(OUTBOX_KEY_NAMESPACE, `${topic}\n${eventId}`);
