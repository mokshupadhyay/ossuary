import { describe, expect, it } from 'vitest';
import {
  DEFENSE_LABELS,
  FAULTS,
  FAULT_IDS,
  faultById,
  isFaultId,
  renderEpitaph,
  shortSubject,
  type DefenseId,
} from '../../src/poltergeist/faults.js';

describe('fault catalog', () => {
  it('matches Requirement 1.1 exactly, in order', () => {
    expect(FAULTS.map((f) => [f.id, f.name, f.epitaph])).toEqual([
      ['duplicate-delivery', 'Duplicate delivery', '{subject} delivered twice, {fate}'],
      ['replayed-timestamp', 'Replayed old timestamp', '{subject} replayed webhook, {fate}'],
      ['out-of-order', 'Out-of-order events', '{subject} arrived out of order, {fate}'],
      ['refund-before-capture', 'Refund before capture', '{subject} refund arrived before its capture, {fate}'],
      ['double-tap', 'Concurrent double-tap', '{subject} double-tapped payout, {fate}'],
      ['crash-mid-step', 'Crash between steps', '{subject} crashed mid-step, {fate}'],
      ['refund-races-payout', 'Refund racing a payout', '{subject} refund raced a payout, {fate}'],
      ['late-after-refund', 'Late delivery after a refund', '{subject} arrived late after its refund, {fate}'],
    ]);
    expect(FAULT_IDS).toEqual(FAULTS.map((f) => f.id));
  });

  it('is frozen, with unique ids and sizes of at most 4 deliveries', () => {
    expect(Object.isFrozen(FAULTS)).toBe(true);
    expect(Object.isFrozen(FAULT_IDS)).toBe(true);
    for (const f of FAULTS) {
      expect(Object.isFrozen(f)).toBe(true);
      expect(f.minDeliveries).toBeGreaterThanOrEqual(1);
      expect(f.maxDeliveries).toBeGreaterThanOrEqual(f.minDeliveries);
      expect(f.maxDeliveries).toBeLessThanOrEqual(4);
      expect(f.id).toMatch(/^[a-z]+(-[a-z]+)*$/);
    }
    expect(new Set(FAULT_IDS).size).toBe(8);
  });

  it('minimum deliveries sum to 18 (the smallest ensureEveryFault storm)', () => {
    expect(FAULTS.reduce((s, f) => s + f.minDeliveries, 0)).toBe(18);
  });

  it('looks faults up by id', () => {
    expect(faultById('double-tap').name).toBe('Concurrent double-tap');
    expect(isFaultId('crash-mid-step')).toBe(true);
    expect(isFaultId('Crash between steps')).toBe(false);
    expect(() => faultById('nope' as never)).toThrow(RangeError);
  });
});

describe('epitaphs', () => {
  it('shortens subjects to prefix, two hex characters and an ellipsis', () => {
    expect(shortSubject('evt_9f3a01c2')).toBe('evt_9f…');
    expect(shortSubject('key_3a00ffee')).toBe('key_3a…');
    expect(shortSubject('pay_0011aabb')).toBe('pay_00…');
  });

  it('names reported defenses, in first-seen order without repeats', () => {
    const dup = faultById('duplicate-delivery');
    expect(renderEpitaph(dup, 'evt_9f3a01c2', ['inbox-dedupe'])).toBe('evt_9f… delivered twice, buried by inbox dedupe');
    expect(renderEpitaph(dup, 'evt_9f3a01c2', ['rollback', 'inbox-dedupe', 'rollback'])).toBe(
      'evt_9f… delivered twice, buried by transaction rollback and inbox dedupe',
    );
  });

  it('says "passed without drift" when no defense was reported', () => {
    expect(renderEpitaph(faultById('out-of-order'), 'pay_0011aabb', [])).toBe('pay_00… arrived out of order, passed without drift');
  });

  it('renders every fault and defense on one line', () => {
    const all = Object.keys(DEFENSE_LABELS) as DefenseId[];
    for (const f of FAULTS) {
      for (const d of [[], all]) {
        const e = renderEpitaph(f, 'evt_abcdef01', d);
        expect(e).not.toMatch(/[\r\n{}]/);
      }
    }
  });
});
