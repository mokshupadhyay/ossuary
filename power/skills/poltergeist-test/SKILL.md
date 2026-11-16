---
name: poltergeist-test
description: Write fast-check property tests that attack money code with duplicates, reordering and crashes. Use after any change to ledger, refund or webhook code.
---
# Poltergeist tests

For any money-moving function, generate sequences of 1-200 operations with fast-check and assert:
1. The sum of all ledger entries is always 0.
2. Replaying any operation with the same idempotency key changes nothing.
3. Duplicated or reordered deliveries give the same final balances as one in-order delivery.
4. Total refunded never exceeds total captured, per payment.
5. A crash injected between any two steps leaves the ledger fully before or fully after the operation.

Use pglite so tests need no external database. Print the shrunk counterexample on failure.
