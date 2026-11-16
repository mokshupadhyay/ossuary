import { describe, expect, it } from 'vitest';
import { hashPayload } from '../../src/ledger/hash.js';

const base = () => ({
  entries: [
    { accountId: 'a', amount: 100n },
    { accountId: 'b', amount: -100n },
  ],
  kind: 'capture',
  paymentId: 'p1',
});

describe('hashPayload', () => {
  it('returns lowercase hex sha-256', () => {
    expect(hashPayload(base())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is identical for identical payloads', () => {
    expect(hashPayload(base())).toBe(hashPayload(base()));
  });

  it('ignores key order at every depth', () => {
    const reordered = {
      paymentId: 'p1',
      kind: 'capture',
      entries: [
        { amount: 100n, accountId: 'a' },
        { amount: -100n, accountId: 'b' },
      ],
    };
    expect(hashPayload(reordered)).toBe(hashPayload(base()));
  });

  it('changes when any single field changes', () => {
    const h = hashPayload(base());
    const amount = base();
    amount.entries[0]!.amount = 101n;
    const account = base();
    account.entries[0]!.accountId = 'c';
    expect(hashPayload(amount)).not.toBe(h);
    expect(hashPayload(account)).not.toBe(h);
    expect(hashPayload({ ...base(), kind: 'refund' })).not.toBe(h);
    expect(hashPayload({ ...base(), paymentId: 'p2' })).not.toBe(h);
  });

  it('changes when entry order changes', () => {
    const swapped = base();
    swapped.entries.reverse();
    expect(hashPayload(swapped)).not.toBe(hashPayload(base()));
  });

  it('hashes bigint without error, including values beyond 2^53', () => {
    expect(() => hashPayload({ n: 2n ** 80n })).not.toThrow();
    expect(hashPayload({ n: 2n ** 80n })).not.toBe(hashPayload({ n: 2n ** 80n + 1n }));
  });

  it('distinguishes bigint from string and number', () => {
    const a = hashPayload({ n: 1n });
    expect(a).not.toBe(hashPayload({ n: '1' }));
    expect(a).not.toBe(hashPayload({ n: 1 }));
    expect(a).not.toBe(hashPayload({ n: { $bigint: '1' } }));
    expect(a).not.toBe(hashPayload({ n: '1n' }));
  });

  it('treats undefined properties as absent', () => {
    expect(hashPayload({ kind: 'capture', paymentId: undefined })).toBe(
      hashPayload({ kind: 'capture' }),
    );
    expect(hashPayload({ paymentId: null })).not.toBe(hashPayload({}));
  });

  it('throws TypeError on unsupported values', () => {
    expect(() => hashPayload({ f: () => 1 })).toThrow(TypeError);
    expect(() => hashPayload({ s: Symbol('x') })).toThrow(TypeError);
    expect(() => hashPayload({ n: NaN })).toThrow(TypeError);
    expect(() => hashPayload({ n: Infinity })).toThrow(TypeError);
    expect(() => hashPayload({ d: new Date() })).toThrow(TypeError);
    expect(() => hashPayload({ m: new Map() })).toThrow(TypeError);
    expect(() => hashPayload(undefined)).toThrow(TypeError);
    expect(() => hashPayload([undefined])).toThrow(TypeError);
  });
});
