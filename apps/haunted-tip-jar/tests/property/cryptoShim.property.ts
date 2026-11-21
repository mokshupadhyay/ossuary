// Feature: haunted-tip-jar, Property 4: The browser crypto shim matches Node
// Validates: Requirements 9.4, design D2
//
// Mutation check (recorded in tasks.md 1.4): createHmac that ignores its key
// (hashes only the message) fails this property.
import * as node from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import * as shim from '../../src/shims/node-crypto';

const RUNS = { numRuns: 100 };
const chunk = fc.oneof(fc.uint8Array({ maxLength: 200 }), fc.string({ maxLength: 120 }));
const chunks = fc.array(chunk, { minLength: 0, maxLength: 4 });
const key = fc.oneof(fc.uint8Array({ minLength: 1, maxLength: 100 }), fc.string({ minLength: 1, maxLength: 80 }));

describe('Property 4: the node:crypto shim is byte-identical to Node', () => {
  it('createHash sha1 and sha256, over any chunks', () => {
    fc.assert(
      fc.property(fc.constantFrom('sha1', 'sha256'), chunks, (alg, parts) => {
        const a = node.createHash(alg);
        const b = shim.createHash(alg);
        for (const p of parts) {
          a.update(p);
          b.update(p);
        }
        expect(b.digest('hex')).toBe(a.digest('hex'));
      }),
      RUNS,
    );
  });

  it('createHmac sha256 with any key, over any chunks, as bytes and hex', () => {
    fc.assert(
      fc.property(key, chunks, fc.boolean(), (k, parts, asHex) => {
        const a = node.createHmac('sha256', k);
        const b = shim.createHmac('sha256', k);
        for (const p of parts) {
          a.update(p);
          b.update(p);
        }
        if (asHex) expect(b.digest('hex')).toBe(a.digest('hex'));
        else expect(Buffer.from(b.digest()).equals(a.digest())).toBe(true);
      }),
      RUNS,
    );
  });

  it('timingSafeEqual agrees with Node, including the length error', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 40 }), fc.uint8Array({ maxLength: 40 }), fc.boolean(), (x, y, same) => {
        const b = same ? Uint8Array.from(x) : y;
        if (x.length !== b.length) {
          expect(() => node.timingSafeEqual(x, b)).toThrow();
          expect(() => shim.timingSafeEqual(x, b)).toThrow(RangeError);
        } else {
          expect(shim.timingSafeEqual(x, b)).toBe(node.timingSafeEqual(x, b));
        }
      }),
      RUNS,
    );
  });

  it('randomUUID gives RFC 4122 v4 UUIDs', () => {
    for (let i = 0; i < 50; i++) {
      expect(shim.randomUUID()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });
});
