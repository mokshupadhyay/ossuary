---
name: money-code-review
description: Review payment or ledger code for double-spend, duplicate-webhook, retry and crash bugs. Use whenever code moves money, handles webhooks, or computes balances.
---
# Money code review

Check, in order:
1. **Units:** integer minor units only (`bigint`). No floats, no rounding.
2. **Ledger:** append-only entries, every transaction sums to zero, balances derived, never stored.
3. **Idempotency:** every money-moving call takes a key; claim the key and write entries in one DB transaction with `ON CONFLICT DO NOTHING`.
4. **Concurrency:** lock the rows you read before you decide (`SELECT ... FOR UPDATE`, ordered by id).
5. **Webhooks:** verify signature, reject stale timestamps, dedupe by event ID, tolerate out-of-order delivery, side effects via the outbox.
6. **Refunds:** cap against captured minus already refunded, inside the same transaction as the write.

Report each finding as: file, rule, fix. If none, say `clean`.
