---
name: add-a-money-flow
description: Step-by-step procedure for adding a new flow that moves money (a tip, payout, contribution, refund or transfer) on the Ossuary skeleton, with an idempotency key, one database transaction, a property test, a mutation check, a checker run and a poltergeist run. Use when asked to add or change any feature that moves money.
---
# Add a money flow

Follow these steps in order. Do not skip the test steps; the poltergeist exists because money bugs pass demos.

## 1. Model it as ledger entries

Write down the accounts and the entries for one operation. Amounts are `bigint` minor units of the one ledger asset, debits positive, credits negative, and every transaction sums to `0n`. If a split leaves a remainder, give it to the first recipient as its own entry. Do not add a balance column; balances come from `balance(db, accountId)`.

## 2. Take an idempotency key

The flow takes `idempotencyKey: string` (a client-generated UUID) as input. The UI creates it once per user intent and reuses it on retries and double-taps. Pass it straight to `postTransaction` or `refund` from `@ossuary/core`:

```ts
import { postTransaction } from '@ossuary/core';

export async function sendTip(db: Db, idempotencyKey: string, fanId: string, jarId: string, amount: bigint) {
  return postTransaction(db, {
    idempotencyKey,
    kind: 'transfer',
    entries: [
      { accountId: jarId, amount },
      { accountId: fanId, amount: -amount },
    ],
  });
}
```

Same key and same request returns the stored result. Same key and a different request throws; surface it as `409 Conflict`.

## 3. Keep it in one transaction

`postTransaction` claims the key and writes the entries in one database transaction. If the flow writes anything else (a row in your own table, an outbox message), open `db.transaction(async (tx) => { ... })`, claim the key on `tx`, and pass `tx` as the third argument to `postTransaction` or `refund`. Never call two money functions back to back outside a transaction.

For refunds use `refund(db, { idempotencyKey, paymentId, amount })`. It caps at captured minus already refunded and throws `RefundCapExceededError`. For webhooks use `createWebhookHandler`, which verifies the signature before anything else, dedupes by event id and writes side effects to the outbox.

## 4. Check the code

Call `ossuary_check_money_code` on each new or changed file, for example `{ "path": "apps/haunted-tip-jar/src/tips.ts" }`. Fix every violation; use `ossuary_explain_rule` with the rule id if the fix is unclear. Then follow the `money-code-review` skill for what the checker cannot see.

## 5. Write a property test

Follow the `poltergeist-test` skill. At minimum:

- replaying the flow with the same key changes nothing;
- a crash between any two statements leaves the ledger fully before or fully after;
- the entry sum stays `0n` for any sequence of calls.

Use at least 25 runs.

## 6. Break it on purpose

Make one deliberate break that the property should catch, for example generate a new idempotency key inside the flow or move the second write out of the transaction. Run the test and confirm it fails with a counterexample. Record the break in the test file's header, revert it, and run the test again.

## 7. Run the poltergeist

Call `ossuary_run_poltergeist` with `{ "seed": 7, "events": 300, "target": "ossuary" }` and confirm `summary.driftTotal` is `"0"`. Then run the package's tests and `pnpm --filter core test`.

## 8. Report

List the files changed, the property tests and their run counts, the break you tried and its counterexample, the checker result and the poltergeist drift.
