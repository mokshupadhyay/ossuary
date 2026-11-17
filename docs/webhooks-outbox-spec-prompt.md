# webhooks-outbox spec prompt

Create a new spec named `webhooks-outbox` for `packages/core`, building on the finished `ledger-core` spec
(postTransaction, refund, balance, idempotency helpers, pglite tests, fast-check).

Follow `.kiro/steering/webhooks.md`, `money.md`, `ledger.md` and `idempotency.md`.

## Scope

1. **verifyWebhook**: HMAC-SHA256 over `timestamp + raw body`, constant-time compare, reject timestamps older than
   5 minutes. The signature is checked before anything is parsed.
2. **Event inbox**: dedupe by event id with a unique constraint. A duplicate returns 200 and does nothing.
   Out-of-order events only apply forward state transitions (`pending -> captured -> refunded`, never back).
3. **Apply an event** by writing the inbox row, the ledger change (via `postTransaction` with the `tx` handle) and an
   outbox row in ONE database transaction. Return 2xx only after commit.
4. **Outbox worker**: claims rows with `SELECT ... FOR UPDATE SKIP LOCKED`, sends side effects with exponential
   backoff retries and a max-attempts dead-letter state. Sends are at-least-once with an idempotency key so the
   receiver can dedupe.

## Required property tests (fast-check, on pglite)

- Delivering any webhook twice, or out of order, gives the same final balances as delivering it once, in order.
- The outbox never loses an event across simulated crashes between any two steps.
- A replayed old timestamp is always rejected.

Each property must be mutation-checkable (it must fail when the code is deliberately broken).

## Process

Generate requirements first and stop for review. Do not start implementation.
