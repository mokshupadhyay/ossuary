import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  addDrift,
  addEffect,
  emptyTruth,
  isZero,
  measureDrift,
  subtractDrift,
  ZERO_DELTA,
  type RefSnapshot,
  type Truth,
} from '../../src/poltergeist/drift.js';
import { MEMBERS, type MemberRef } from '../../src/poltergeist/storm.js';

const amount = fc.bigInt({ min: 0n, max: 10n ** 12n });
const effectArb = fc.record({
  captured: amount,
  refunded: amount,
  paidOut: fc.dictionary(fc.constantFrom(...MEMBERS), amount),
});
const truthArb = fc.array(effectArb, { maxLength: 6 }).map((es) => es.reduce(addEffect, emptyTruth('USDC')));

function expectedSnapshot(t: Truth): RefSnapshot {
  const paid = MEMBERS.reduce((s, m) => s + (t.paidOut.get(m) ?? 0n), 0n);
  return {
    asset: 'USDC',
    pot: t.captured - t.refunded - paid,
    members: new Map(MEMBERS.map((m) => [m, t.paidOut.get(m) ?? 0n])),
  };
}

const offsetsArb = fc.record({
  pot: fc.bigInt({ min: -1000n, max: 1000n }),
  members: fc.array(fc.bigInt({ min: -1000n, max: 1000n }), { minLength: 5, maxLength: 5 }),
});

function perturb(s: RefSnapshot, o: { pot: bigint; members: bigint[] }): RefSnapshot {
  return {
    asset: s.asset,
    pot: s.pot + o.pot,
    members: new Map(MEMBERS.map((m, i) => [m, (s.members.get(m) ?? 0n) + o.members[i]!])),
  };
}

describe('measureDrift', () => {
  it('is zero on every account exactly when reported equals expected', () => {
    fc.assert(
      fc.property(truthArb, offsetsArb, (t, o) => {
        const exact = measureDrift(t, expectedSnapshot(t));
        expect(isZero(exact)).toBe(true);
        expect([exact.conjured, exact.lost, exact.doubleCreditedMembers]).toEqual([0n, 0n, 0]);
        const off = measureDrift(t, perturb(expectedSnapshot(t), o));
        const allZero = o.pot === 0n && o.members.every((x) => x === 0n);
        expect(isZero(off)).toBe(allZero);
      }),
    );
  });

  it('total = Σ accounts = captured − refunded − (pot + Σ wallets), and conjured − lost = −total', () => {
    fc.assert(
      fc.property(truthArb, offsetsArb, (t, o) => {
        const snap = perturb(expectedSnapshot(t), o);
        const d = measureDrift(t, snap);
        expect(d.total).toBe(d.accounts.reduce((s, a) => s + a.drift, 0n));
        const held = snap.pot + MEMBERS.reduce((s, m) => s + snap.members.get(m)!, 0n);
        expect(d.total).toBe(t.captured - t.refunded - held);
        expect(d.conjured - d.lost).toBe(-d.total);
        expect(d.doubleCreditedMembers).toBe(o.members.filter((x) => x > 0n).length);
      }),
    );
  });

  it('orders accounts pot, m0 … m4, then member:unknown', () => {
    const t = emptyTruth('USDC');
    const members = new Map<MemberRef | 'unknown', bigint>([['unknown', 5n]]);
    const d = measureDrift(t, { asset: 'USDC', pot: 0n, members });
    expect(d.accounts.map((a) => a.account)).toEqual(['pot', ...MEMBERS.map((m) => `member:${m}`), 'member:unknown']);
    expect(d.accounts.at(-1)!.drift).toBe(-5n);
    expect(d.conjured).toBe(5n);
    expect(d.doubleCreditedMembers).toBe(0);
  });

  it('throws on an asset mismatch instead of converting', () => {
    expect(() => measureDrift(emptyTruth('USDC'), { asset: 'USD', pot: 0n, members: new Map() })).toThrow(/no conversion/);
  });

  it('double payout with a lost update: pot right, member paid twice, conjured money', () => {
    const t = addEffect(emptyTruth('USDC'), { captured: 100n, refunded: 0n, paidOut: { m1: 40n } });
    const d = measureDrift(t, { asset: 'USDC', pot: 60n, members: new Map([['m1', 80n]]) });
    expect(d.total).toBe(-40n);
    expect(d.conjured).toBe(40n);
    expect(d.doubleCreditedMembers).toBe(1);
  });
});

describe('subtractDrift and addDrift', () => {
  it('work per account, treating a missing account as zero', () => {
    const t = emptyTruth('USDC');
    const before = measureDrift(t, { asset: 'USDC', pot: 0n, members: new Map() });
    const after = measureDrift(t, { asset: 'USDC', pot: -7n, members: new Map([['m2', 3n], ['unknown', 1n]]) });
    const delta = subtractDrift(after, before);
    expect(delta.total).toBe(after.total);
    expect(Object.fromEntries(delta.accounts.map((a) => [a.account, a.drift]))).toMatchObject({
      pot: 7n,
      'member:m2': -3n,
      'member:unknown': -1n,
      'member:m0': 0n,
    });
    const back = addDrift(before, delta);
    expect(back.total).toBe(after.total);
    expect(isZero(subtractDrift(after, after))).toBe(true);
    expect(isZero(ZERO_DELTA)).toBe(true);
  });
});
