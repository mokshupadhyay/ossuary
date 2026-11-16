# First spec: paste this into Kiro (Spec mode)

Create a spec named `ledger-core` for `packages/core`.

Build the core of Ossuary: a double-entry ledger in TypeScript with Drizzle on Postgres.
- Accounts, transactions and append-only entries; every transaction's entries sum to zero.
- `postTransaction(idempotencyKey, entries)` that is idempotent per the steering rules.
- `balance(accountId)` derived from entries.
- `refund(paymentId, amount)` that can never exceed the captured amount.

Write the requirements in EARS format, and include the five correctness properties from
`.kiro/steering/ledger.md` as acceptance criteria to be tested with fast-check.
Use an in-memory Postgres (pglite) for tests so they run in CI without a database.
