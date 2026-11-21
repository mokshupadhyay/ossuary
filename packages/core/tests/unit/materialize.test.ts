import { describe, expect, it } from 'vitest';
import { materialize, newRunTag } from '../../src/poltergeist/materialize.js';
import { MEMBERS } from '../../src/poltergeist/storm.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('materialize', () => {
  it('is deterministic per tag and disjoint across tags', () => {
    const a1 = materialize('abc1234~');
    const a2 = materialize('abc1234~');
    const b = materialize('def5678~');
    expect(a1.circleId).toBe(a2.circleId);
    expect(a1.memberIds).toEqual(a2.memberIds);
    expect(a1.paymentId('pay_00000001')).toBe(a2.paymentId('pay_00000001'));
    const ids = (c: ReturnType<typeof materialize>) => [
      c.circleId,
      ...Object.values(c.memberIds),
      c.paymentId('pay_00000001'),
      c.key('key_00000001'),
      c.eventId('evt_00000001'),
    ];
    const overlap = ids(a1).filter((id) => ids(b).includes(id));
    expect(overlap).toEqual([]);
  });

  it('gives lowercase UUIDv5 ids and tagged event ids of at most 255 characters', () => {
    const c = materialize(newRunTag());
    for (const id of [c.circleId, ...Object.values(c.memberIds), c.paymentId('pay_0a0b0c0d'), c.key('key_0a0b0c0d')]) {
      expect(id).toMatch(UUID);
    }
    expect(c.eventId('evt_0a0b0c0d')).toBe(`${c.runTag}evt_0a0b0c0d`);
    expect(c.eventId('evt_0a0b0c0d').length).toBeLessThanOrEqual(255);
    expect(new Set(Object.values(c.memberIds)).size).toBe(MEMBERS.length);
  });

  it('maps member ids back to refs, case-insensitively, and anything else to unknown', () => {
    const c = materialize('t~');
    for (const m of MEMBERS) {
      expect(c.memberRef(c.memberIds[m])).toBe(m);
      expect(c.memberRef(c.memberIds[m].toUpperCase())).toBe(m);
    }
    expect(c.memberRef('00000000-0000-0000-0000-000000000000')).toBe('unknown');
  });

  it('newRunTag is 7 hex characters and a tilde, and varies', () => {
    const tags = new Set(Array.from({ length: 20 }, newRunTag));
    for (const t of tags) expect(t).toMatch(/^[0-9a-f]{7}~$/);
    expect(tags.size).toBeGreaterThan(1);
  });
});
