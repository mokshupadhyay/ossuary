import type { Db } from '../db/client.js';
import { getAccount } from '../ledger/accounts.js';
import { InvalidWebhookPayloadError } from '../errors/index.js';
import { applyEvent } from './apply.js';
import { parseEvent } from './parse.js';
import { verifyWebhook, type Clock } from './verify.js';

export interface WebhookConfig {
  /** At least 32 bytes. */
  secret: Uint8Array | string;
  /** The single ledger asset, e.g. 'USDC'. */
  asset: string;
  /** Asset account with allow_overdraft = true. */
  clearingAccountId: string;
  /** Revenue account. */
  revenueAccountId: string;
  clock: Clock;
}

export interface WebhookRequest {
  rawBody: Uint8Array | string;
  headers: Headers | Record<string, string | undefined>;
}

export type InboxOutcome = 'applied' | 'parked' | 'ignored' | 'rejected' | 'duplicate';

export interface WebhookResponse {
  status: 200 | 400 | 401 | 500;
  body: { ok: boolean; outcome?: InboxOutcome; error?: string };
}

const MIN_SECRET_BYTES = 32;

async function assertConfig(db: Db, config: WebhookConfig): Promise<void> {
  const secretBytes =
    typeof config.secret === 'string' ? Buffer.byteLength(config.secret, 'utf8') : config.secret?.byteLength ?? 0;
  if (secretBytes < MIN_SECRET_BYTES) {
    throw new Error(`webhook config: secret must be at least ${MIN_SECRET_BYTES} bytes`);
  }
  if (typeof config.asset !== 'string' || config.asset === '') {
    throw new Error('webhook config: asset must be a non-empty string');
  }
  if (!config.clock || typeof config.clock.now !== 'function') {
    throw new Error('webhook config: clock is required');
  }
  const clearing = await getAccount(db, config.clearingAccountId).catch(() => {
    throw new Error('webhook config: clearing account does not exist');
  });
  if (clearing.type !== 'asset') throw new Error('webhook config: clearing account must be an asset account');
  if (!clearing.allowOverdraft) {
    throw new Error('webhook config: clearing account must allow overdraft');
  }
  const revenue = await getAccount(db, config.revenueAccountId).catch(() => {
    throw new Error('webhook config: revenue account does not exist');
  });
  if (revenue.type !== 'revenue') throw new Error('webhook config: revenue account must be a revenue account');
}

/**
 * Checks the configuration once, then returns a handler that verifies, parses
 * and applies one webhook per call. The handler never throws, returns 200 only
 * after the transaction has committed, and never puts the secret, a signature
 * or the raw body in a response.
 */
export async function createWebhookHandler(
  db: Db,
  config: WebhookConfig,
): Promise<(request: WebhookRequest) => Promise<WebhookResponse>> {
  await assertConfig(db, config);
  const cfg: WebhookConfig = { ...config };

  return async (request) => {
    try {
      const verified = verifyWebhook({
        secret: cfg.secret,
        rawBody: request.rawBody,
        headers: request.headers,
        clock: cfg.clock,
      });
      if (!verified.ok) return { status: 401, body: { ok: false, error: 'unauthorized' } };

      let rawBody: string;
      try {
        rawBody =
          typeof request.rawBody === 'string'
            ? request.rawBody
            : new TextDecoder('utf-8', { fatal: true }).decode(request.rawBody);
      } catch {
        return { status: 400, body: { ok: false, error: 'body: invalid UTF-8' } };
      }

      let event;
      try {
        event = parseEvent(rawBody, cfg.asset);
      } catch (e) {
        if (e instanceof InvalidWebhookPayloadError) {
          return { status: 400, body: { ok: false, error: `${e.field}: ${e.reason}` } };
        }
        throw e;
      }

      const outcome = await db.transaction((tx) => applyEvent(tx, db, cfg, event, rawBody));
      return { status: 200, body: { ok: true, outcome } };
    } catch {
      return { status: 500, body: { ok: false, error: 'internal' } };
    }
  };
}
