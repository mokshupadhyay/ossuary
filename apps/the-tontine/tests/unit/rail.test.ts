import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { balance, createAccount, verifyWebhook } from '@ossuary/core';
import { openLedger, type LedgerHandle } from '../../src/ledger/database';
import { createRail, eventIdFor, type DueRef, type WebhookHandler } from '../../src/tontine/rail';
import { TontineError } from '../../src/tontine/types';

const SECRET = 'a'.repeat(64);
const clock = { now: () => Date.now() };
let client: PGlite;
let ledger: LedgerHandle;

beforeAll(async () => {
  client = new PGlite();
  ledger = await openLedger(client);
});
afterAll(() => client.close());

async function accounts() {
  const clearingAccountId = crypto.randomUUID();
  const potAccountId = crypto.randomUUID();
  await createAccount(ledger.db, { accountId: clearingAccountId, name: 'clearing', type: 'asset', allowOverdraft: true });
  await createAccount(ledger.db, { accountId: potAccountId, name: 'pot', type: 'revenue' });
  return { clearingAccountId, potAccountId };
}

const due = (): DueRef => ({
  circleId: crypto.randomUUID(),
  memberId: crypto.randomUUID(),
  paymentId: crypto.randomUUID(),
  idempotencyKey: crypto.randomUUID(),
});

const captures = async (paymentId: string) =>
  (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM transactions WHERE payment_id = $1 AND kind = 'capture'`, [paymentId])).rows[0]!.n;

describe('rail', () => {
  it('posts one capture for a contribution, and the same due again is a duplicate', async () => {
    const acc = await accounts();
    const rail = await createRail(ledger, acc, SECRET, clock);
    const d = due();
    expect(await rail.deliverCapture(d, 50_000_000n)).toBe('applied');
    expect(await rail.deliverCapture(d, 50_000_000n)).toBe('duplicate');
    const [a, b] = await Promise.all([rail.deliverCapture(d, 50_000_000n), rail.deliverCapture(d, 50_000_000n)]);
    expect([a, b]).toEqual(['duplicate', 'duplicate']);
    expect(await captures(d.paymentId)).toBe(1);
    expect(await balance(ledger.db, acc.potAccountId)).toBe(-50_000_000n);
    expect(await balance(ledger.db, acc.clearingAccountId)).toBe(50_000_000n);
  });

  it('signs every delivery so that Core verifies it, with the due-derived event id', async () => {
    const acc = await accounts();
    const seen: { rawBody: string; headers: Record<string, string> }[] = [];
    const rail = await createRail(ledger, acc, SECRET, clock, {
      intercept: (h) => async (req) => {
        seen.push({ rawBody: String(req.rawBody), headers: req.headers as Record<string, string> });
        return h(req);
      },
    });
    const d = due();
    await rail.deliverCapture(d, 7n);
    expect(seen).toHaveLength(1);
    const body = JSON.parse(seen[0]!.rawBody);
    expect(body).toEqual({ id: eventIdFor(d.idempotencyKey), type: 'payment.captured', paymentId: d.paymentId, circleId: d.circleId, memberId: d.memberId, asset: 'USDC', amount: '7' });
    expect(verifyWebhook({ secret: SECRET, rawBody: seen[0]!.rawBody, headers: seen[0]!.headers, clock }).ok).toBe(true);
    expect(verifyWebhook({ secret: 'b'.repeat(64), rawBody: seen[0]!.rawBody, headers: seen[0]!.headers, clock }).ok).toBe(false);
  });

  it('retries a 5xx or a thrown error, re-signed, and succeeds on the third attempt', async () => {
    const acc = await accounts();
    let calls = 0;
    const stamps: string[] = [];
    let now = Date.now();
    const ticking = { now: () => (now += 1000) };
    const flaky = (h: WebhookHandler): WebhookHandler => async (req) => {
      calls += 1;
      stamps.push((req.headers as Record<string, string>)['ossuary-timestamp']!);
      if (calls === 1) return { status: 500, body: { ok: false, error: 'internal' } };
      if (calls === 2) throw new Error('connection reset');
      return h(req);
    };
    const rail = await createRail(ledger, acc, SECRET, ticking, { intercept: flaky });
    const d = due();
    expect(await rail.deliverCapture(d, 3n)).toBe('applied');
    expect(calls).toBe(3);
    expect(new Set(stamps).size).toBe(3);
    expect(await captures(d.paymentId)).toBe(1);
  });

  it('gives up after 3 failed attempts with rail-failed, and a 4xx is not retried', async () => {
    const acc = await accounts();
    let calls = 0;
    const down = await createRail(ledger, acc, SECRET, clock, {
      intercept: () => async () => {
        calls += 1;
        return { status: 500, body: { ok: false, error: 'internal' } };
      },
    });
    const d = due();
    await expect(down.deliverCapture(d, 3n)).rejects.toSatisfy((e) => e instanceof TontineError && e.code === 'rail-failed');
    expect(calls).toBe(3);

    // A forged signature gets Core's 401, which is final: no retry, no money.
    calls = 0;
    const forged = await createRail(ledger, acc, SECRET, clock, {
      intercept: (h) => async (req) => {
        calls += 1;
        return h({ ...req, headers: { ...(req.headers as Record<string, string>), 'ossuary-signature': '0'.repeat(64) } });
      },
    });
    const f = due();
    await expect(forged.deliverCapture(f, 3n)).rejects.toSatisfy((e) => e instanceof TontineError && e.code === 'rail-failed' && /401/.test(e.message));
    expect(calls).toBe(1);
    expect(await captures(f.paymentId)).toBe(0);
    expect(await captures(d.paymentId)).toBe(0);
  });
});
