import {
  createWebhookHandler,
  signWebhook,
  type Clock,
  type WebhookRequest,
  type WebhookResponse,
} from '@ossuary/core';
import type { LedgerHandle } from '../ledger/database';
import { ASSET } from '../money';
import { TontineError } from './types';

/*
 * The simulated payment rail. A recorded contribution is a payment from
 * outside the circle, so it reaches the ledger the way every external money
 * event must (webhooks.md): as a signed `payment.captured` webhook, verified,
 * deduplicated and posted by Core's handler. The rail is the only sender.
 */

export type WebhookHandler = (request: WebhookRequest) => Promise<WebhookResponse>;

export interface DueRef {
  circleId: string;
  memberId: string;
  paymentId: string;
  /** The due's client Idempotency-Key, minted when the circle was created. */
  idempotencyKey: string;
}

export interface RailOptions {
  /** Attempts per contribution, the first included. Default 3. */
  maxAttempts?: number;
  /** Test hook: wrap Core's handler (for example to fail the first attempts). */
  intercept?: (handler: WebhookHandler) => WebhookHandler;
}

export interface Rail {
  deliverCapture(due: DueRef, amount: bigint): Promise<'applied' | 'duplicate'>;
}

/** The rail event id for a due. Every tap, retry and tab sends the same one, so Core's inbox dedupes them. */
export const eventIdFor = (dueKey: string): string => `due:${dueKey}`;

export async function createRail(
  ledger: LedgerHandle,
  accounts: { clearingAccountId: string; potAccountId: string },
  secret: string,
  clock: Clock,
  options: RailOptions = {},
): Promise<Rail> {
  const maxAttempts = options.maxAttempts ?? 3;
  const core = await createWebhookHandler(ledger.db, {
    secret,
    asset: ASSET,
    clearingAccountId: accounts.clearingAccountId,
    revenueAccountId: accounts.potAccountId,
    clock,
  });
  const handler = options.intercept ? options.intercept(core) : core;

  return {
    async deliverCapture(due, amount) {
      // Field order is fixed so the same due always produces the same bytes.
      const rawBody = JSON.stringify({
        id: eventIdFor(due.idempotencyKey),
        type: 'payment.captured',
        paymentId: due.paymentId,
        circleId: due.circleId,
        memberId: due.memberId,
        asset: ASSET,
        amount: amount.toString(),
      });
      let last = 'no attempt';
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        // Re-signed at the current second on every attempt, as a real rail does.
        const ts = Math.floor(clock.now() / 1000);
        let res: WebhookResponse;
        try {
          res = await handler({
            rawBody,
            headers: {
              'content-type': 'application/json',
              'ossuary-timestamp': String(ts),
              'ossuary-signature': signWebhook(secret, ts, rawBody),
            },
          });
        } catch (e) {
          last = e instanceof Error ? e.message : String(e);
          continue;
        }
        if (res.status === 200 && (res.body.outcome === 'applied' || res.body.outcome === 'duplicate')) {
          return res.body.outcome;
        }
        last = `${res.status} ${res.body.outcome ?? res.body.error ?? ''}`.trim();
        if (res.status < 500) break;
      }
      throw new TontineError('rail-failed', `The rail did not confirm the payment (${last}). Trying again is safe: it reuses the same key.`);
    },
  };
}
