import type { WebhookRequest } from '../webhooks/handler.js';
import { signWebhook, type Clock } from '../webhooks/verify.js';

/** A request signed at the clock's current second, in the Signed_Payload format. */
export function signedDelivery(secret: string, clock: Clock, body: string | Uint8Array): WebhookRequest {
  return signedDeliveryAt(secret, Math.floor(clock.now() / 1000), body);
}

/** A request signed with an explicit Unix-seconds timestamp. */
export function signedDeliveryAt(secret: string, timestampS: number, body: string | Uint8Array): WebhookRequest {
  return {
    rawBody: body,
    headers: { 'ossuary-timestamp': String(timestampS), 'ossuary-signature': signWebhook(secret, timestampS, body) },
  };
}
