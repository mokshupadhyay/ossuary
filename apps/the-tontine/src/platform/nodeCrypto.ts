/*
 * Browser adapter for the four `node:crypto` functions packages/core uses
 * (poltergeist-engine design D8): randomUUID, createHash (sha256, sha1),
 * createHmac (sha256) and timingSafeEqual. Vite aliases `node:crypto` to this
 * file, so core runs unchanged in the page. Hashes are synchronous, like
 * Node's, which Web Crypto's `subtle` API is not, so they come from
 * @noble/hashes. tests/unit/nodeCrypto.test.ts checks every function against
 * the real `node:crypto` byte for byte.
 */
import { Buffer } from 'buffer';
import { hmac } from '@noble/hashes/hmac.js';
import { sha1 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';

type Algorithm = 'sha256' | 'sha1';
type Input = string | Uint8Array;

const HASHES = { sha256, sha1 } as const;

function algorithm(name: string): (typeof HASHES)[Algorithm] {
  const fn = HASHES[name.toLowerCase() as Algorithm];
  if (!fn) throw new Error(`node:crypto browser adapter: unsupported algorithm ${name}`);
  return fn;
}

/**
 * A plain Uint8Array view of the input. @noble/hashes accepts only plain
 * Uint8Arrays; a Buffer, or a typed array from another realm (a jsdom test,
 * an iframe), is re-viewed over the same memory without copying.
 */
function bytes(data: Input): Uint8Array {
  const view = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

function out(digest: Uint8Array, encoding?: 'hex'): Buffer | string {
  const buf = Buffer.from(digest);
  return encoding === undefined ? buf : buf.toString(encoding);
}

interface Hasher {
  update(data: Input): Hasher;
  digest(): Buffer;
  digest(encoding: 'hex'): string;
}

function hasher(update: (b: Uint8Array) => void, finish: () => Uint8Array): Hasher {
  let done = false;
  const h: Hasher = {
    update(data) {
      if (done) throw new Error('Digest already called');
      update(bytes(data));
      return h;
    },
    digest(encoding?: 'hex') {
      if (done) throw new Error('Digest already called');
      done = true;
      return out(finish(), encoding) as never;
    },
  };
  return h;
}

export function createHash(name: string): Hasher {
  const h = algorithm(name).create();
  return hasher((b) => h.update(b), () => h.digest());
}

export function createHmac(name: string, key: Input): Hasher {
  const h = hmac.create(algorithm(name), bytes(key));
  return hasher((b) => h.update(b), () => h.digest());
}

/** Constant time in the length of the inputs, like Node's. Throws on unequal lengths, like Node's. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) throw new RangeError('Input buffers must have the same byte length');
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function randomUUID(): string {
  return globalThis.crypto.randomUUID();
}

export default { createHash, createHmac, timingSafeEqual, randomUUID };
