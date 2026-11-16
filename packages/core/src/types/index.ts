export type AccountType = 'asset' | 'liability' | 'revenue' | 'expense';
export type TransactionKind = 'capture' | 'refund' | 'transfer';
export type IdempotencyStatus = 'in_progress' | 'completed';

export interface Account {
  accountId: string;
  name: string;
  type: AccountType;
  allowOverdraft: boolean;
  createdAt: Date;
}

export interface Transaction {
  id: string;
  kind: TransactionKind;
  paymentId: string | null;
  idempotencyKey: string | null;
  createdAt: Date;
}

export interface Entry {
  id: string;
  transactionId: string;
  accountId: string;
  amount: bigint;
  createdAt: Date;
}

export interface IdempotencyRecord {
  key: string;
  requestHash: string;
  status: IdempotencyStatus;
  response: unknown;
  createdAt: Date;
}

export interface EntryInput {
  accountId: string;
  amount: bigint; // positive = debit, negative = credit
}

export interface PostTransactionInput {
  idempotencyKey: string;
  entries: EntryInput[];
  kind: TransactionKind;
  paymentId?: string;
}

export interface RefundInput {
  idempotencyKey: string;
  paymentId: string;
  amount: bigint;
}
