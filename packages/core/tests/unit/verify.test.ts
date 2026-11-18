import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { signWebhook, verifyWebhook } from '../../src/webhooks/verify.js';

const secret = 'a'.repeat(32);
const NOW_S = 1_800_000_000;
const clock = { now: () => NOW_S * 1000 };
const body = '{"id":"evt_1","type":"payment.pending"}';

const headersFor = (ts: number | string, sig: string) => ({
  'ossuary-timestamp': String(ts),
  'ossuary-signature': sig,
});
const verifyAt = (ts: number, rawBody: string | Uint8Array = body, sigBody: string | Uint8Array = body) =>
  verifyWebhook({
    secret,
    rawBody,
    headers: headersFor(ts, signWebhook(secret, ts, sigBody)),
    clock,
  });

describe('signWebhook / verifyWebhook', () => {
  it('matches a known-good vector (HMAC-SHA256 over "<ts>.<body>")', () => {
    // Computed independently with `openssl dgst -sha256 -hmac`.
    expect(signWebhook(secret, NOW_S, body)).toBe(
      '51eec0de01a62d940009fa788d08f06cec4df5ab9666db52a376d40af8c172e2',
    );
    expect(verifyAt(NOW_S)).toEqual({ ok: true, timestamp: NOW_S });
  });

  it('rejects any single-byte change to the body', () => {
    const original = new TextEncoder().encode(body);
    fc.assert(
      fc.property(fc.nat(original.length - 1), fc.integer({ min: 1, max: 255 }), (pos, delta) => {
        const mutated = Uint8Array.from(original);
        mutated[pos] = (mutated[pos]! + delta) & 0xff;
        const r = verifyAt(NOW_S, mutated, original);
        expect(r).toEqual({ ok: false, reason: 'bad_signature' });
      }),
      { numRuns: 100 },
    );
  });

  it('rejects any single-byte change to the timestamp', () => {
    const ts = String(NOW_S);
    const sig = signWebhook(secret, NOW_S, body);
    fc.assert(
      fc.property(fc.nat(ts.length - 1), fc.integer({ min: 1, max: 9 }), (pos, delta) => {
        const digit = (Number(ts[pos]) + delta) % 10;
        const mutated = ts.slice(0, pos) + String(digit) + ts.slice(pos + 1);
        const r = verifyWebhook({ secret, rawBody: body, headers: headersFor(mutated, sig), clock });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toBe('bad_signature');
      }),
      { numRuns: 100 },
    );
  });

  it('rejects missing headers', () => {
    const sig = signWebhook(secret, NOW_S, body);
    for (const headers of [
      {},
      { 'ossuary-timestamp': String(NOW_S) },
      { 'ossuary-signature': sig },
      { 'ossuary-timestamp': undefined, 'ossuary-signature': sig },
    ]) {
      expect(verifyWebhook({ secret, rawBody: body, headers, clock })).toEqual({
        ok: false,
        reason: 'missing_header',
      });
    }
  });

  it('looks headers up case-insensitively, in plain objects and Headers', () => {
    const sig = signWebhook(secret, NOW_S, body);
    const mixed = { 'Ossuary-Timestamp': String(NOW_S), 'OSSUARY-SIGNATURE': sig };
    expect(verifyWebhook({ secret, rawBody: body, headers: mixed, clock }).ok).toBe(true);
    const h = new Headers({ 'Ossuary-Timestamp': String(NOW_S), 'Ossuary-Signature': sig });
    expect(verifyWebhook({ secret, rawBody: body, headers: h, clock }).ok).toBe(true);
  });

  it('rejects uppercase hex, wrong lengths and non-hex without throwing', () => {
    const sig = signWebhook(secret, NOW_S, body);
    const bad = [sig.toUpperCase(), sig.slice(0, 63), sig + '0', 'z'.repeat(64), '', ' ' + sig.slice(1)];
    for (const s of bad) {
      expect(() =>
        verifyWebhook({ secret, rawBody: body, headers: headersFor(NOW_S, s), clock }),
      ).not.toThrow();
      expect(verifyWebhook({ secret, rawBody: body, headers: headersFor(NOW_S, s), clock })).toEqual({
        ok: false,
        reason: 'malformed_signature',
      });
    }
  });

  it('rejects malformed timestamps', () => {
    const sig = signWebhook(secret, NOW_S, body);
    for (const ts of ['', '-1', '1.5', '1e9', 'abc', '1'.repeat(16), ' 1']) {
      expect(verifyWebhook({ secret, rawBody: body, headers: headersFor(ts, sig), clock })).toEqual({
        ok: false,
        reason: 'malformed_timestamp',
      });
    }
  });

  it('accepts exactly ±300 s and rejects ±301 s', () => {
    expect(verifyAt(NOW_S - 300).ok).toBe(true);
    expect(verifyAt(NOW_S + 300).ok).toBe(true);
    expect(verifyAt(NOW_S - 301)).toEqual({ ok: false, reason: 'stale' });
    expect(verifyAt(NOW_S + 301)).toEqual({ ok: false, reason: 'future' });
  });

  it('never trusts the timestamp before the signature', () => {
    const r = verifyWebhook({
      secret,
      rawBody: body,
      headers: headersFor(NOW_S - 10_000, 'f'.repeat(64)),
      clock,
    });
    expect(r).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('gives the same signature for a string and its UTF-8 bytes', () => {
    const text = 'héllo 💀 {"a":1}';
    expect(signWebhook(secret, NOW_S, text)).toBe(
      signWebhook(secret, NOW_S, new TextEncoder().encode(text)),
    );
    expect(verifyAt(NOW_S, new TextEncoder().encode(text), text).ok).toBe(true);
  });

  it('does not throw or leak the secret on a wrong secret', () => {
    const r = verifyWebhook({
      secret: 'b'.repeat(32),
      rawBody: body,
      headers: headersFor(NOW_S, signWebhook(secret, NOW_S, body)),
      clock,
    });
    expect(r).toEqual({ ok: false, reason: 'bad_signature' });
    expect(JSON.stringify(r)).not.toContain('b'.repeat(32));
  });
});
