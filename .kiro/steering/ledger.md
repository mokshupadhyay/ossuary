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
- No account may go negative unless its type explicitly allows it (e.g. the rail's clearing account).
- Refunds can never exceed the captured amount of the original payment.

## Properties every change must keep (fast-check)
1. For any sequence of operations, the sum of all entries is 0.
2. Replaying any operation with the same idempotency key changes nothing.
3. Delivering any webhook twice, or out of order, gives the same final balances as delivering it once, in order.
4. Total refunded ≤ total captured, per payment.
5. A crash between any two steps leaves the ledger either fully before or fully after the operation.
