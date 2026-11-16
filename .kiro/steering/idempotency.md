---
inclusion: always
---
# Idempotency

- Every money-moving request carries an `Idempotency-Key` (client-generated UUID).
- Store `(key, request_hash, status, response)` with a **unique constraint on key**.
- Same key + same request hash → return the stored response, do nothing else.
- Same key + different request hash → `409 Conflict`. Never silently run it.
- Claim the key and write the ledger entries **in the same database transaction**.
- A key stuck `in_progress` past a timeout may be retried by the same caller only.
- Double-taps in the UI must reuse the same key, not mint a new one.
