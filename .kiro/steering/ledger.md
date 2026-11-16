---
inclusion: fileMatch
fileMatchPattern: "packages/core/**/*.ts"
---
# Double-entry ledger

- Every transaction is a set of **entries whose amounts sum to exactly zero**. Reject any transaction that doesn't.
- Accounts have a type (asset, liability, revenue, expense). Debits are positive, credits negative.
- Entries are **append-only**. Corrections are new reversing transactions, never UPDATE or DELETE.
- A transaction and its entries are written in **one database transaction**.
- Balances are derived: `SELECT sum(amount) FROM entries WHERE account_id = $1`.
- Sign convention: debits positive, credits negative. **Normal balances differ by type**: asset and expense
  accounts are debit-normal (balance ≥ 0); liability and revenue accounts are credit-normal (balance ≤ 0).
- No account may cross to the wrong side of its normal balance unless it has `allow_overdraft = true`
  (e.g. the rail's clearing account). Asset/expense: reject if balance < 0. Liability/revenue: reject if balance > 0.
- Never store a balance or a transaction total in a column. Only entries hold amounts.
- A transaction may carry `kind` (e.g. `capture`, `refund`, `transfer`) and an optional `payment_id`, so refunds can be capped per payment.
- Refunds can never exceed the captured amount of the original payment.

## Properties every change must keep (fast-check)
1. For any sequence of operations, the sum of all entries is 0.
2. Replaying any operation with the same idempotency key changes nothing.
3. Delivering any webhook twice, or out of order, gives the same final balances as delivering it once, in order.
4. Total refunded ≤ total captured, per payment.
5. A crash between any two steps leaves the ledger either fully before or fully after the operation.
