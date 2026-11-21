import { describe, expect, it } from 'vitest';
import { InvalidWebhookPayloadError } from '../../src/errors/index.js';
import { parseEvent } from '../../src/webhooks/parse.js';

const ASSET = 'USDC';
const PID = '3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b';
const body = (o: Record<string, unknown>) => JSON.stringify(o);
const captured = (over: Record<string, unknown> = {}) =>
  body({ id: 'evt_1', type: 'payment.captured', paymentId: PID, asset: ASSET, amount: '1000', ...over });

const rejects = (raw: string, field: string) => {
  try {
    parseEvent(raw, ASSET);
  } catch (e) {
    expect(e).toBeInstanceOf(InvalidWebhookPayloadError);
    expect((e as InvalidWebhookPayloadError).field).toBe(field);
    return;
  }
  throw new Error(`expected rejection on ${field}`);
};

describe('parseEvent', () => {
  it('parses a valid captured event', () => {
    expect(parseEvent(captured(), ASSET)).toEqual({
      known: true,
      id: 'evt_1',
      type: 'payment.captured',
      paymentId: PID,
      asset: ASSET,
      amount: 1000n,
    });
  });

  it('rejects invalid JSON and non-objects', () => {
    rejects('{nope', 'body');
    rejects('', 'body');
    rejects('[]', 'body');
    rejects('null', 'body');
    rejects('"x"', 'body');
  });

  it('validates id: a string of 1-255 characters', () => {
    rejects(captured({ id: '' }), 'id');
    rejects(captured({ id: 'x'.repeat(256) }), 'id');
    rejects(captured({ id: 5 }), 'id');
    rejects(body({ type: 'payment.pending', paymentId: PID, asset: ASSET }), 'id');
    expect(parseEvent(captured({ id: 'x'.repeat(255) }), ASSET).id).toHaveLength(255);
    expect(parseEvent(captured({ id: '💀'.repeat(255) }), ASSET).id).toBe('💀'.repeat(255));
    rejects(captured({ id: '💀'.repeat(256) }), 'id');
  });

  it('validates type is a string', () => {
    rejects(captured({ type: 5 }), 'type');
    rejects(body({ id: 'e', paymentId: PID, asset: ASSET }), 'type');
  });

  it('validates paymentId as a UUID and lowercases it', () => {
    rejects(captured({ paymentId: 'nope' }), 'paymentId');
    rejects(captured({ paymentId: 5 }), 'paymentId');
    rejects(captured({ paymentId: undefined }), 'paymentId');
    expect(parseEvent(captured({ paymentId: PID.toUpperCase() }), ASSET).paymentId).toBe(PID);
  });

  it('requires the asset to equal the ledger asset exactly', () => {
    rejects(captured({ asset: 'usdc' }), 'asset');
    rejects(captured({ asset: 'EUR' }), 'asset');
    rejects(captured({ asset: undefined }), 'asset');
    rejects(captured({ asset: 'USDC ' }), 'asset');
  });

  it('accepts an amount at exactly the int8 maximum', () => {
    const e = parseEvent(captured({ amount: '9223372036854775807' }), ASSET);
    expect(e).toMatchObject({ known: true, amount: 9223372036854775807n });
  });

  it.each([
    ['maximum + 1', '9223372036854775808'],
    ['19 nines', '9999999999999999999'],
    ['leading zero', '01'],
    ['zero', '0'],
    ['plus sign', '+5'],
    ['minus sign', '-5'],
    ['decimal', '1.5'],
    ['exponent', '1e3'],
    ['empty', ''],
    ['padded', ' 5'],
    ['20 digits', '10000000000000000000'],
  ])('rejects an amount: %s', (_n, amount) => {
    rejects(captured({ amount }), 'amount');
  });

  it('rejects a JSON number, null and a missing amount for captured and refunded', () => {
    rejects(captured({ amount: 1000 }), 'amount');
    rejects(captured({ amount: null }), 'amount');
    rejects(captured({ amount: undefined }), 'amount');
    rejects(captured({ type: 'payment.refunded', amount: 5 }), 'amount');
  });

  it('parses refunded with a bigint amount, and above 2^53 exactly', () => {
    const e = parseEvent(captured({ type: 'payment.refunded', amount: '9007199254740993' }), ASSET);
    expect(e).toMatchObject({ known: true, type: 'payment.refunded', amount: 9007199254740993n });
  });

  it('ignores amount on pending and stores null', () => {
    const raw = body({ id: 'e', type: 'payment.pending', paymentId: PID, asset: ASSET, amount: 'junk' });
    expect(parseEvent(raw, ASSET)).toMatchObject({ known: true, type: 'payment.pending', amount: null });
  });

  it('returns known:false for an unknown type, with other fields still validated', () => {
    const raw = body({ id: 'e', type: 'payment.disputed', paymentId: PID.toUpperCase(), asset: ASSET });
    expect(parseEvent(raw, ASSET)).toEqual({
      known: false,
      id: 'e',
      type: 'payment.disputed',
      paymentId: PID,
      asset: ASSET,
    });
    rejects(body({ id: '', type: 'x', paymentId: PID, asset: ASSET }), 'id');
    rejects(body({ id: 'e', type: 'x', paymentId: 'bad', asset: ASSET }), 'paymentId');
    rejects(body({ id: 'e', type: 'x', paymentId: PID, asset: 'EUR' }), 'asset');
  });

  it('does not echo body content in error messages', () => {
    try {
      parseEvent(captured({ amount: 'SECRET-VALUE-123' }), ASSET);
    } catch (e) {
      expect((e as Error).message).not.toContain('SECRET-VALUE-123');
    }
  });
  it('rejects a NUL character in id and in type, so the rail gets a 400 instead of retrying a 500 forever', () => {
    const base = { paymentId: '3f2b8c1e-0b7a-4d53-9a43-6a1d6f0c2e11', asset: 'USDC', type: 'payment.pending' };
    const withId = JSON.stringify({ ...base, id: 'evt\u0000_1' });
    expect(() => parseEvent(withId, 'USDC')).toThrow(/id/);
    const withType = JSON.stringify({ ...base, id: 'evt_1', type: 'payment.\u0000x' });
    expect(() => parseEvent(withType, 'USDC')).toThrow(/type/);
  });
});
