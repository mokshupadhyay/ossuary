---
name: money-code-review
description: Review payment, ledger, refund or webhook code for float money, mutable balances, missing idempotency keys, unverified webhooks, writes outside one transaction and refunds beyond the captured amount. Use whenever code moves money, handles webhooks, or computes balances.
---
# Money code review

The rules live in `.kiro/steering/money.md`, `ledger.md`, `idempotency.md` and `webhooks.md`. The Ossuary MCP server checks the six that can be spotted in text; you review the rest.

## 1. Run the checker on every changed money file

Call `ossuary_check_money_code` once per changed `.ts`, `.tsx`, `.js` or `.sql` file:

```json
{ "path": "apps/haunted-tip-jar/src/tips.ts" }
```

For code that is not on disk yet, pass it as a snippet (a `.sql` filename switches to SQL comments):

```json
{ "code": "export async function payOut(...) { ... }", "filename": "payout.ts" }
```

Paths are relative to the workspace root; absolute paths and anything outside the workspace are refused. Each violation has `rule`, `line`, `excerpt`, `message` and `fix`. For any rule you need to explain, call `ossuary_explain_rule` with its id (`float-money`, `mutable-balance`, `missing-idempotency-key`, `unverified-webhook`, `write-outside-transaction`, `refund-over-capture`). It returns the steering text and a bug-and-fix example.

The checker is heuristic. A clean result means none of its patterns matched, not that the code is safe.

## 2. Review what the checker cannot see

1. **Units.** `bigint` minor units end to end, from the request body (parse a digit string, never `Number`) to the database (`bigint` or `numeric` with no scale). Every amount travels with its asset; one asset per ledger.
2. **Ledger.** Entries are append-only and every transaction sums to zero. Use `postTransaction` and `balance` from `@ossuary/core`; never store a balance.
3. **Idempotency.** The key is claimed and the entries written in the same database transaction. Same key and same request returns the stored response; same key and a different request is a conflict. A UI double-tap reuses the key.
4. **Normal balances and overdrafts.** Only the rail's clearing account may go negative (`allowOverdraft: true`).
5. **Webhooks.** Verify the signature over the raw body before parsing (`createWebhookHandler` does this), reject stale timestamps, dedupe by event id, apply state transitions only forward, and send side effects through the outbox (`runOutboxOnce`).
6. **Refunds.** Use `refund` from `@ossuary/core`, which locks the payment and caps at captured minus already refunded. A hand-written refund needs the same check inside the same transaction.
7. **Crashes.** Ask what happens if the process dies between any two statements. Anything other than "fully before" or "fully after" is a bug.

## 3. Report

For each finding give the file, line, rule id (or the steering file for rules the checker does not cover) and a concrete fix. If there is nothing, say `clean` and state that the checker is heuristic.
