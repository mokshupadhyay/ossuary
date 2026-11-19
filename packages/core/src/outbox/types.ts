/** JSON-safe outbox payload. Amounts are decimal strings of minor units, never JSON numbers. */
export interface OutboxPayload {
  eventId: string;
  paymentId: string;
  ledgerTransactionId: string;
  asset: string;
  amount: string;
}
