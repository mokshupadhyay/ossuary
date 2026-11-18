import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ledgerKeyFor,
  outboxKeyFor,
  uuidV5,
} from '../../src/webhooks/keys.js';

const DNS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const UUID_V5_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('uuidV5', () => {
  it('matches the RFC 4122 DNS vector', () => {
    expect(uuidV5(DNS, 'www.example.com')).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
  });

  it('sets the version and variant bits', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (name) => {
        expect(uuidV5(DNS, name)).toMatch(UUID_V5_RE);
      }),
      { numRuns: 100 },
    );
  });

  it('is deterministic', () => {
    expect(uuidV5(DNS, 'x')).toBe(uuidV5(DNS, 'x'));
    expect(uuidV5(DNS, 'x')).not.toBe(uuidV5(DNS, 'y'));
  });

  it('hashes non-ASCII names as UTF-8', () => {
    const name = 'événement-💀-日本';
    const hash = createHash('sha1')
      .update(Buffer.from(DNS.replace(/-/g, ''), 'hex'))
      .update(Buffer.from(name, 'utf8'))
      .digest();
    const expectedTail = hash.subarray(0, 16).toString('hex');
    const got = uuidV5(DNS, name).replace(/-/g, '');
    // Everything except the version nibble (index 12) and variant nibble (index 16).
    expect(got.slice(0, 12)).toBe(expectedTail.slice(0, 12));
    expect(got.slice(13, 16)).toBe(expectedTail.slice(13, 16));
    expect(got.slice(17)).toBe(expectedTail.slice(17));
  });

  it('rejects a namespace that is not a UUID', () => {
    expect(() => uuidV5('nope', 'x')).toThrow(TypeError);
  });
});

describe('event keys', () => {
  it('ledger and outbox keys never coincide for any event id and topic', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', minLength: 1, maxLength: 255 }), fc.string(), (id, topic) => {
        expect(ledgerKeyFor(id)).not.toBe(outboxKeyFor(id, topic));
      }),
      { numRuns: 200 },
    );
  });

  it('are stable per event, and differ per topic', () => {
    expect(ledgerKeyFor('evt_1')).toBe(ledgerKeyFor('evt_1'));
    expect(outboxKeyFor('evt_1', 'payment.captured')).toBe(outboxKeyFor('evt_1', 'payment.captured'));
    expect(outboxKeyFor('evt_1', 'payment.captured')).not.toBe(outboxKeyFor('evt_1', 'payment.refunded'));
    expect(ledgerKeyFor('evt_1')).not.toBe(ledgerKeyFor('evt_2'));
  });
});
