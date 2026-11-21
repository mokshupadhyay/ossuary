/*
 * Browser stand-in for `node:crypto`, limited to what @ossuary/core calls:
 * createHash('sha1' | 'sha256'), createHmac('sha256'), timingSafeEqual and
 * randomUUID (poltergeist-engine design D8). Hashes are synchronous because
 * core calls them synchronously, so they come from @noble/hashes rather than
 * Web Crypto. Outputs are `Buffer`s from the `buffer` polyfill so core's
 * `.toString('hex')` and `.subarray()` calls behave as on Node.
 *
 * Vite aliases `node:crypto` to this file for the browser build only. Tests
 * run on Node's real module, and tests/unit/nodeCryptoShim.test.ts checks
 * that this file gives byte-identical results.
 */
import { Buffer } from 'buffer';
import { hmac } from '@noble/hashes/hmac.js';
import { sha1 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';

type Input = string | Uint8Array;
type Algorithm = 'sha1' | 'sha256';

const ALGORITHMS = { sha1, sha256 } as const;

function bytes(data: Input): Uint8Array {
  return typeof data === 'string' ? new TextEncoder().encode(data) : data;
}

function algorithm(name: string): (typeof ALGORITHMS)[Algorithm] {
  if (name !== 'sha1' && name !== 'sha256') throw new Error(`node:crypto shim: unsupported hash ${name}`);
  return ALGORITHMS[name];
}

interface Digester {
  update(data: Input): Digester;
  digest(): Buffer;
  digest(encoding: 'hex'): string;
}

function digester(finish: (chunks: Uint8Array[]) => Uint8Array): Digester {
  const chunks: Uint8Array[] = [];
  let done = false;
  const self: Digester = {
    update(data: Input) {
      if (done) throw new Error('node:crypto shim: digest already called');
      chunks.push(bytes(data));
      return self;
    },
    digest(encoding?: 'hex') {
      if (done) throw new Error('node:crypto shim: digest already called');
      done = true;
      const out = Buffer.from(finish(chunks));
      return (encoding === 'hex' ? out.toString('hex') : out) as never;
    },
  };
  return self;
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

export function createHash(name: string): Digester {
  const h = algorithm(name);
  return digester((chunks) => h(concat(chunks)));
}

export function createHmac(name: string, key: Input): Digester {
  const h = algorithm(name);
  const k = bytes(key);
  return digester((chunks) => hmac(h, k, concat(chunks)));
}

/** Constant-time for equal lengths; throws on different lengths, as Node does. */
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
