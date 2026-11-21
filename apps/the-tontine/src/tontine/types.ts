import type { ASSET } from '../money';

export type TontineErrorCode =
  | 'invalid-input'
  | 'unknown-circle'
  | 'unknown-member'
  | 'circle-complete'
  | 'not-current-round'
  | 'already-paid'
  | 'dues-unpaid'
  | 'pot-short'
  | 'rail-failed';

/** A rule the App refused to break. No money moved. */
export class TontineError extends Error {
  constructor(
    readonly code: TontineErrorCode,
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = 'TontineError';
  }
}

export interface CircleSummary {
  circleId: string;
  name: string;
}

export type DueStatus = 'paid' | 'paid-late' | 'late' | 'owes';

export interface MemberView {
  position: number;
  memberId: string;
  name: string;
  walletAccountId: string;
  /** What the circle has paid this member, from the ledger. */
  wallet: bigint;
  /** The round in which this member received the pot, if they have. */
  receivedRound: number | null;
  /** The round in which this member is the recipient. */
  recipientRound: number;
  /** This member's due in the current round, or null when the circle is complete. */
  due: { round: number; status: DueStatus; idempotencyKey: string } | null;
}

export interface LedgerLine {
  /** Human label of the account: "Clearing", "Pot" or "Wallet · <name>". */
  account: string;
  accountId: string;
  /** Signed: debits positive, credits negative (ledger.md). */
  amount: bigint;
}

interface MoneyEntryBase {
  at: Date;
  round: number;
  position: number;
  memberName: string;
  amount: bigint;
  /** The Idempotency-Key the App sent: the due's or the round's payout key. */
  clientKey: string;
  /** The idempotency key stored on the ledger transaction. */
  ledgerKey: string;
  transactionId: string;
  entries: LedgerLine[];
}

export type TimelineEntry =
  | (MoneyEntryBase & { kind: 'contribution'; receipt: boolean; late: boolean; eventId: string })
  | (MoneyEntryBase & { kind: 'payout' })
  | { kind: 'missed'; at: Date; round: number; position: number; memberName: string };

export interface CircleView {
  circleId: string;
  name: string;
  asset: typeof ASSET;
  contribution: bigint;
  /** contribution × members: what each round pays out. */
  potPerRound: bigint;
  rounds: number;
  currentRound: number | null;
  complete: boolean;
  recipientPosition: number | null;
  members: MemberView[];
  /** Names of members whose current-round due is unpaid, in position order. */
  waitingFor: string[];
  /** Paid dues in the current round. */
  paidThisRound: number;
  /** Money the pot holds now. */
  pot: bigint;
  /** Everything contributed so far (the clearing account's balance). */
  moneyIn: bigint;
  /** Everything paid out so far (the sum of the wallets). */
  moneyOut: bigint;
  /** Sum of every entry on this circle's accounts. Always 0. */
  ledgerSum: bigint;
  accounts: { clearing: string; pot: string };
  /** Newest first. */
  timeline: TimelineEntry[];
}
