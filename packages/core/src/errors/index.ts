export class LedgerError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class UnbalancedTransactionError extends LedgerError {
  constructor(public readonly sum: bigint) {
    super(`Transaction entries sum to ${sum}, expected 0`);
  }
}

export class InsufficientEntriesError extends LedgerError {
  constructor() {
    super('A transaction requires at least 2 entries');
  }
}

export class DuplicateKeyError extends LedgerError {
  constructor(public readonly key: string) {
    super(`Idempotency key already claimed with a different payload: ${key}`);
  }
}

export class AccountNotFoundError extends LedgerError {
  constructor(public readonly accountId: string) {
    super(`Account not found: ${accountId}`);
  }
}

export class DuplicateAccountError extends LedgerError {
  constructor(public readonly accountId: string) {
    super(`Account already exists: ${accountId}`);
  }
}

export class MissingFieldError extends LedgerError {
  constructor(public readonly field: string) {
    super(`Required field missing: ${field}`);
  }
}

export class InvalidAccountTypeError extends LedgerError {
  constructor(public readonly value: string) {
    super(`Invalid account type: ${value}`);
  }
}

/** A field is present but its value is not acceptable (bad format or length). */
export class InvalidFieldError extends LedgerError {
  constructor(
    public readonly field: string,
    public readonly reason: string,
  ) {
    super(`Invalid ${field}: ${reason}`);
  }
}

export class NormalBalanceViolationError extends LedgerError {
  constructor(
    public readonly accountId: string,
    public readonly balance: bigint,
  ) {
    super(`Account ${accountId} would cross its normal balance: ${balance}`);
  }
}

export class RefundCapExceededError extends LedgerError {
  constructor(
    public readonly requested: bigint,
    public readonly remaining: bigint,
  ) {
    super(`Refund of ${requested} exceeds remaining refundable amount ${remaining}`);
  }
}

export class PaymentNotFoundError extends LedgerError {
  constructor(public readonly paymentId: string) {
    super(`No captured transactions found for payment: ${paymentId}`);
  }
}

export class IdempotencyWindowExpiredError extends LedgerError {
  constructor(public readonly key: string) {
    super(`Idempotency key ${key} is older than 24 hours`);
  }
}

export class MissingIdempotencyKeyError extends LedgerError {
  constructor() {
    super('An idempotency key is required');
  }
}

export class InvalidRefundAmountError extends LedgerError {
  constructor(public readonly amount: bigint) {
    super(`Refund amount must be > 0, got ${amount}`);
  }
}

/** Retriable conflict: the key is claimed by a transaction that has not completed. */
export class KeyInFlightError extends LedgerError {
  constructor(public readonly key: string) {
    super(`Idempotency key is in flight, retry later: ${key}`);
  }
}

/** A verified webhook body failed validation. `reason` is fixed text and never echoes the body. */
export class InvalidWebhookPayloadError extends LedgerError {
  constructor(
    public readonly field: string,
    public readonly reason: string,
  ) {
    super(`Invalid webhook payload, ${field}: ${reason}`);
  }
}
