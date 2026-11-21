// Core's own signWebhook / verifyWebhook / handler, running on the browser shim
// instead of Node's node:crypto, as they do in the built app (design D2).
import { vi, describe, expect, it } from 'vitest';

vi.mock('node:crypto', async () => {
  const shim = await import('../../src/shims/node-crypto');
  return { ...shim, default: shim.default };
});

const { signWebhook, verifyWebhook } = await import('@ossuary/core');
const { createHash: shimHash } = await import('../../src/shims/node-crypto');
const nodeCrypto = await import('node:crypto');

describe('core webhook signing on the shim', () => {
  it('node:crypto is the shim in this file', () => {
    expect(nodeCrypto.createHash).toBe(shimHash);
  });

  it('a vector pinned from real node:crypto matches', () => {
    // node -e "require('crypto').createHmac('sha256','k'.repeat(32)).update('1700000000.{}').digest('hex')"
    expect(signWebhook('k'.repeat(32), 1_700_000_000, '{}')).toBe(
      '0b3b35525c10b3757ffa78df69037021fc3168d8390a51a4fcb4a8d56a25b557',
    );
  });

  it('sign then verify round-trips, and a changed body fails', () => {
    const secret = 's'.repeat(40);
    const ts = 1_800_000_000;
    const body = JSON.stringify({ id: 'evt', amount: '5' });
    const sig = signWebhook(secret, ts, body);
    const clock = { now: () => ts * 1000 };
    const headers = { 'ossuary-timestamp': String(ts), 'ossuary-signature': sig };
    expect(verifyWebhook({ secret, rawBody: body, headers, clock })).toEqual({ ok: true, timestamp: ts });
    expect(verifyWebhook({ secret, rawBody: body.replace('5', '6'), headers, clock })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });
});
