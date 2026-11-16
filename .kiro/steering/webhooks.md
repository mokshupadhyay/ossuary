---
inclusion: fileMatch
fileMatchPattern: "**/webhooks/**"
---
# Webhooks

- **Verify the signature first** (HMAC-SHA256 over the raw body plus timestamp) using a constant-time compare. Reject on failure.
- Reject events whose timestamp is older than 5 minutes (replay protection).
- Deduplicate by event ID with a unique constraint. A duplicate returns `200` and does nothing.
- Handle events out of order: apply state transitions only if they move forward (e.g. `captured` never goes back to `pending`).
- Do the work through the **outbox**: write the event and the ledger change in one transaction; side effects (emails, on-chain calls) are sent from the outbox by a worker with retries.
- Return `2xx` only after the transaction commits.
