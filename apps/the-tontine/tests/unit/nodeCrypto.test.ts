import * as real from 'crypto';
import * as aliased from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { signWebhook, verifyWebhook } from '@ossuary/core';
import * as shim from '../../src/platform/nodeCrypto';

/*
 * The browser adapter must be byte-identical to Node's `node:crypto` for every
 * function Core uses (Requirement 1.6). `crypto` (no `node:` prefix) is not
 * aliased, so `real` is Node's own module, while Core's `node:crypto` import
 * resolves to the adapter (vite.config.ts).
 */

const chunk = fc.oneof(fc.string({ unit: 'binary' }), fc.uint8Array({ maxLength: 300 }));
const chunks = fc.array(chunk, { maxLength: 5 });
const key = fc.oneof(fc.string({ unit: 'binary', maxLength: 100 }), fc.uint8Array({ maxLength: 100 }));
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('node:crypto browser adapter', () => {
  it('is what `node:crypto` resolves to in the App (and so in Core)', () => {
    expect(aliased.createHash).toBe(shim.createHash);
    expect(aliased.createHmac).toBe(shim.createHmac);
    expect(real.createHash).not.toBe(shim.createHash);
  });

  for (const alg of ['sha256', 'sha1'] as const) {
    it(`createHash('${alg}') equals node:crypto, hex and buffer digests`, () => {
      fc.assert(
        fc.property(chunks, (parts) => {
          const a = shim.createHash(alg);
          const b = real.createHash(alg);
          const c = shim.createHash(alg);
          for (const p of parts) {
            a.update(p);
            b.update(p);
            c.update(p);
          }
          const expected = b.digest('hex');
          expect(a.digest('hex')).toBe(expected);
          const buf = c.digest();
          expect(buf).toBeInstanceOf(Uint8Array);
          expect(hex(buf)).toBe(expected);
        }),
        { numRuns: 200 },
      );
    });
  }

  it("createHmac('sha256') equals node:crypto for string and byte keys", () => {
    fc.assert(
      fc.property(key, chunks, (k, parts) => {
        const a = shim.createHmac('sha256', k);
        const b = real.createHmac('sha256', k);
        for (const p of parts) {
          a.update(p);
          b.update(p);
        }
        expect(hex(a.digest())).toBe(b.digest('hex'));
      }),
      { numRuns: 200 },
    );
  });

  it('timingSafeEqual agrees with node:crypto, including the length error', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), fc.uint8Array({ maxLength: 64 }), (x, y) => {
        expect(shim.timingSafeEqual(x, x.slice())).toBe(true);
        if (x.length === y.length) {
          expect(shim.timingSafeEqual(x, y)).toBe(real.timingSafeEqual(x, y));
        } else {
          expect(() => real.timingSafeEqual(x, y)).toThrow(RangeError);
          expect(() => shim.timingSafeEqual(x, y)).toThrow(RangeError);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('randomUUID returns distinct lowercase v4 UUIDs', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const id = shim.randomUUID();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      seen.add(id);
    }
    expect(seen.size).toBe(100);
  });

  it('rejects an algorithm Core does not use, and a second digest', () => {
    expect(() => shim.createHash('md5')).toThrow(/unsupported algorithm/);
    const h = shim.createHash('sha256');
    h.digest();
    expect(() => h.digest()).toThrow(/Digest already called/);
    expect(() => h.update('x')).toThrow(/Digest already called/);
  });

  it("Core's signWebhook, running on the adapter, matches an HMAC from node:crypto and verifies", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 32, maxLength: 64 }), fc.integer({ min: 0, max: 2 ** 40 }), fc.string(), (secret, ts, body) => {
        const expected = real.createHmac('sha256', secret).update(`${ts}.`).update(Buffer.from(body, 'utf8')).digest('hex');
        const sig = signWebhook(secret, ts, body);
        expect(sig).toBe(expected);
        const v = verifyWebhook({
          secret,
          rawBody: body,
          headers: { 'ossuary-timestamp': String(ts), 'ossuary-signature': sig },
          clock: { now: () => ts * 1000 },
        });
        expect(v.ok).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});
