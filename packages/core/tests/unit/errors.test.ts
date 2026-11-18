import { describe, expect, it } from 'vitest';
import * as E from '../../src/errors/index.js';

const cases: Array<[string, E.LedgerError, Record<string, unknown>]> = [
  ['UnbalancedTransactionError', new E.UnbalancedTransactionError(5n), { sum: 5n }],
  ['InsufficientEntriesError', new E.InsufficientEntriesError(), {}],
  ['DuplicateKeyError', new E.DuplicateKeyError('k'), { key: 'k' }],
  ['AccountNotFoundError', new E.AccountNotFoundError('a'), { accountId: 'a' }],
  ['DuplicateAccountError', new E.DuplicateAccountError('a'), { accountId: 'a' }],
  ['MissingFieldError', new E.MissingFieldError('name'), { field: 'name' }],
  ['InvalidAccountTypeError', new E.InvalidAccountTypeError('bogus'), { value: 'bogus' }],
  [
    'NormalBalanceViolationError',
    new E.NormalBalanceViolationError('a', -3n),
    { accountId: 'a', balance: -3n },
  ],
  [
    'RefundCapExceededError',
    new E.RefundCapExceededError(10n, 4n),
    { requested: 10n, remaining: 4n },
  ],
  ['PaymentNotFoundError', new E.PaymentNotFoundError('p'), { paymentId: 'p' }],
  ['IdempotencyWindowExpiredError', new E.IdempotencyWindowExpiredError('k'), { key: 'k' }],
  ['MissingIdempotencyKeyError', new E.MissingIdempotencyKeyError(), {}],
  ['InvalidRefundAmountError', new E.InvalidRefundAmountError(0n), { amount: 0n }],
  ['KeyInFlightError', new E.KeyInFlightError('k'), { key: 'k' }],
  [
    'InvalidWebhookPayloadError',
    new E.InvalidWebhookPayloadError('amount', 'bad'),
    { field: 'amount', reason: 'bad' },
  ],
];

describe('ledger errors', () => {
  it.each(cases)('%s is a LedgerError with its name and fields', (name, err, fields) => {
    expect(err).toBeInstanceOf(E.LedgerError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe(name);
    expect(err.message.length).toBeGreaterThan(0);
    for (const [k, v] of Object.entries(fields)) {
      expect((err as unknown as Record<string, unknown>)[k]).toBe(v);
    }
  });

  it('subclasses are narrowable via instanceof', () => {
    const err: unknown = new E.RefundCapExceededError(2n, 1n);
    expect(err instanceof E.RefundCapExceededError).toBe(true);
    expect(err instanceof E.DuplicateKeyError).toBe(false);
  });
});
