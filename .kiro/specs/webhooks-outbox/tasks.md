# Implementation Plan: webhooks-outbox

## Overview

Implement signed webhook intake and a transactional outbox in `packages/core`, on top of `ledger-core`, as laid out in design.md. Work proceeds bottom-up:

1. the one ledger change (`refund` on a caller transaction);
2. schema and migrations;
3. key derivation, verification and parsing;
4. the handler and its apply flows;
5. the outbox worker;
6. public API wiring;
7. shared test helpers;
8. one required property test per correctness property (Properties 1–3).

Conventions for every task:
- Amounts are `bigint` in minor units, in the single configured asset. No floats, no currency conversion. Only `entries.amount` counts toward a balance.
- All tests run on pglite with an injected clock and, where needed, a fake sender. No network, no environment variables. Run with `vitest --run`, never watch mode.
- Each task ends with its own tests passing, the full suite passing, and `tsc --noEmit` clean.
- No secret, signature or raw webhook body appears in any response, error message or log line.
- New test files use one migrated database per file (`beforeAll`), with fresh accounts, payment ids and event ids per test, rather than a new database per test.
- Code is written under `packages/core/`. Paths below are relative to that directory.

## Tasks

- [ ] 1. Ledger change: refund on a caller transaction
  - [ ] 1.1 Add the optional `callerTx` parameter to `refund` in `src/ledger/refund.ts`
    - Move the body of today's transaction callback (lock the payment's rows, compute the cap, allocate, post) into an internal `refundOnTx(tx, db, paymentId, amount, idempotencyKey)`
    - Without `callerTx`: keep today's behavior exactly (validate, hash, open the transaction, `claimOrReplay`, `refundOnTx`, `completeKey`)
    - With `callerTx`: validate and lowercase as today, then run `refundOnTx` on `callerTx`. Leave the key claim, the request-hash check and the `completed` update to the caller, and say so in the JSDoc, mirroring `postTransaction`
    - Write `tests/unit/refundTx.test.ts`:
      - a refund on a caller transaction commits atomically with the caller's own work;
      - rolling back the outer transaction removes it;
      - a `RefundCapExceededError` raised inside a savepoint (`tx.transaction(...)`) leaves the outer transaction usable and committing.
    - Every existing `refund.test.ts` and `refundCap.property.ts` test must pass unchanged
    - _Requirements: 7.1, 7.2, 7.3, 6.4_

- [ ] 2. Schema and migrations
  - [ ] 2.1 Add the Drizzle schema and migrations `0005`–`0007`
    - Create `src/schema/webhookEvents.ts`, `paymentStates.ts` and `outboxMessages.ts` exactly as in design.md, and re-export them from `src/schema/index.ts`
    - Generate one migration per table with drizzle-kit, in dependency order: `0005_create_webhook_events`, `0006_create_payment_states`, `0007_create_outbox_messages`. Do not hand-edit snapshots
    - Update the count assertions that pin the migration set, keeping every check they make:
      - `tests/unit/migrationFiles.test.ts`: 8 tags, with `0004_append_only_trigger` still at index 4;
      - `tests/unit/migrate.test.ts`: 8 applied migrations.
    - Write `tests/unit/webhooksSchema.test.ts`. It queries the live pglite catalogs, not the Drizzle definitions, and checks:
      - the unique constraint on `webhook_events.event_id`;
      - the `payment_states` primary key on `payment_id`;
      - the unique constraint on `outbox_messages.idempotency_key`;
      - the `outbox_due_idx` index on `(status, next_attempt_at)`;
      - the partial parked index;
      - the foreign keys from `outbox_messages.event_id`, `webhook_events.ledger_transaction_id` and `payment_states.captured_event_id`;
      - that every enum rejects values outside its list;
      - that no new column is named like `balance` or `total`.
    - _Requirements: 11.1, 11.2, 11.3, 11.4_

- [ ] 3. Keys, verification and parsing
  - [ ] 3.1 Implement `src/webhooks/keys.ts` and `tests/unit/keys.test.ts`
    - `uuidV5(namespace, name)` per RFC 4122 §4.3 with SHA-1 from `node:crypto`, plus `ledgerKeyFor(eventId)` and `outboxKeyFor(eventId, topic)` with the two namespaces in design.md
    - Tests:
      - `uuidV5(DNS, 'www.example.com') === '2ed6657d-e927-568b-95e1-2665a8aea6a2'`;
      - the version and variant bits are set;
      - the same input always gives the same key;
      - with fast-check, `ledgerKeyFor` and `outboxKeyFor` never produce the same key for any event id;
      - non-ASCII event ids are hashed as UTF-8.
    - _Requirements: 6.4, 8.3_

  - [ ] 3.2 Implement `src/webhooks/verify.ts` (`verifyWebhook`, `signWebhook`, `Clock`) and `tests/unit/verify.test.ts`
    - Run the checks in the order design.md gives:
      1. read the headers `ossuary-timestamp` and `ossuary-signature`, case-insensitively;
      2. check the signature is `/^[0-9a-f]{64}$/` and the timestamp is `/^[0-9]{1,15}$/`;
      3. compute HMAC-SHA256 over `<timestamp>.<raw body bytes>`;
      4. compare with `timingSafeEqual` on two 32-byte buffers;
      5. only then check the ±300 s tolerance.
    - Never throw on hostile input; return a typed reason instead
    - Tests:
      - a known-good vector;
      - changing any single byte of the body or the timestamp is rejected (fast-check over byte positions);
      - missing headers are rejected, and lookup with mixed-case header names works;
      - uppercase hex, 63 and 65 characters, and non-hex are rejected without throwing;
      - +300 s and −300 s are accepted; +301 s and −301 s are rejected;
      - the timestamp is never trusted before the signature: an unsigned stale request returns `bad_signature`, not `stale`;
      - string and `Uint8Array` bodies give the same signature.
    - _Requirements: 1.1, 1.2, 1.3, 1.7, 2.1, 2.2, 2.3, 2.4, 2.5_

  - [ ] 3.3 Implement `src/webhooks/parse.ts`, add `InvalidWebhookPayloadError(field, reason)` to `src/errors/index.ts`, and write `tests/unit/parse.test.ts`
    - Follow design.md:
      - `id` is 1–255 characters, and `paymentId` is a UUID, lowercased;
      - `asset` must equal the ledger asset exactly;
      - for `captured` and `refunded`, `amount` matches `/^[1-9][0-9]{0,18}$/` and is at most `9223372036854775807`, converted with `BigInt` and never through `number`;
      - unknown types give `known: false`.
    - Tests:
      - each field rule, with the error naming the field;
      - an amount at exactly the `int8` maximum is accepted;
      - maximum + 1, leading zeros, a sign, a decimal, an exponent and a JSON number are rejected;
      - an asset mismatch is rejected;
      - invalid JSON is rejected;
      - an unknown type returns `known: false` with its other fields still validated;
      - an uppercase `paymentId` is lowercased.
    - Update `tests/unit/errors.test.ts` for the new error class
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

- [ ] 4. Checkpoint - Ensure all tests pass
  - Run `vitest --run` and `tsc --noEmit`. Ensure all tests pass, ask the user if questions arise.

- [ ] 5. Webhook handler
  - [ ] 5.1 Implement `createWebhookHandler` in `src/webhooks/handler.ts`, with the inbox claim, unknown types and `payment.pending` in `src/webhooks/apply.ts`
    - **Configuration** is checked once, before any request (design.md):
      - the secret is at least 32 bytes;
      - the asset is non-empty;
      - the clearing account exists, is an `asset` and has `allow_overdraft`;
      - the revenue account exists and is a `revenue` account.

      Each failure throws an error naming the problem.
    - **Handler**: verify, then parse, then `db.transaction(applyEvent)`. It returns `200` only after commit, and never throws. Use the status table in design.md
    - **Inbox claim**: `INSERT ... ON CONFLICT (event_id) DO NOTHING RETURNING`. No row means `200 duplicate`, with the stored row unchanged even if the payload differs
    - **Payment lock**: insert the `payment_states` row if missing, then `SELECT ... FOR UPDATE`
    - **Events handled in this task**:
      - an unknown type is recorded as `ignored`;
      - `payment.pending` sets the state only when none exists, with no ledger change and no outbox message.
    - Tests in `tests/unit/handler.test.ts` (one database per file):
      - `401` for every verification failure, with nothing written and the reason not disclosed;
      - `400` for every parse failure, naming the field;
      - a duplicate event id returns `200 duplicate` and writes nothing, including with a changed payload;
      - an unknown type is `ignored`;
      - `pending` after `captured` leaves the state at `captured` (seed the state row directly for this);
      - each configuration error.
    - _Requirements: 1.4, 1.5, 2.2, 3.3, 3.5, 4.1, 4.2, 4.3, 4.4, 4.6, 5.1, 5.2, 5.9, 6.2, 10.1, 10.2, 10.3_

  - [ ] 5.2 Add the `payment.captured` flow to `src/webhooks/apply.ts`
    - **Duplicate capture**: if `captured_event_id` is already set, record the event as `rejected` with reason `duplicate capture`, with no ledger change and no outbox message
    - **Otherwise, in a savepoint**:
      1. claim `ledgerKeyFor(eventId)` with `claimOrReplay`, hashing `{ op: 'webhook', eventId }`;
      2. `postTransaction(..., { kind: 'capture', paymentId, entries: [clearing +amount, revenue −amount] }, sp)`;
      3. `completeKey`.
    - **Then**:
      - set `captured_event_id`, and raise the state to `captured` if it ranks lower;
      - set `ledger_transaction_id` and `applied_at` on the inbox row;
      - insert one outbox message with topic `payment.captured`, key `outboxKeyFor(eventId, topic)`, a JSON-safe payload with the amount as a string, and `next_attempt_at` from the clock.
    - Tests:
      - a capture moves clearing by +amount and revenue by −amount;
      - exactly one outbox message is written, and its payload has no JSON numbers;
      - a second distinct capture is `rejected` and changes nothing;
      - an amount above 2^53 round-trips exactly;
      - the derived ledger key is the one stored on the transaction.
    - _Requirements: 5.3, 5.4, 6.1, 6.4, 8.1, 8.2, 8.3, 8.5_

  - [ ] 5.3 Add the `payment.refunded` flow, parking, and application of parked refunds
    - **Uncaptured payment**: record the refund as `parked`, with no ledger change and no outbox message
    - **Captured payment**: run `applyRefund` in a savepoint:
      1. claim `ledgerKeyFor(eventId)`;
      2. `refund(db, input, sp)`;
      3. `completeKey`.

      Then:
      - on success, raise the state to `refunded`, set the ledger transaction id, and write an outbox message with topic `payment.refunded`;
      - a `RefundCapExceededError` rolls back only the savepoint, and the event is recorded as `rejected` with reason `refund exceeds remaining <R>`;
      - any other error propagates.
    - **Capture with parked refunds**: in the same transaction, select the payment's parked rows `ORDER BY received_seq FOR UPDATE`, and run `applyRefund` on each in that order
    - Example-based tests for invalid histories (outside Property 2's domain):
      - two captures with different amounts: the first to arrive is applied;
      - refunds that together exceed the capture: the one that no longer fits is `rejected`, with no outbox message;
      - a parked refund that exceeds the capture when applied is `rejected`.
    - Tests for valid histories:
      - a refund before its capture is parked, then applied when the capture arrives;
      - several parked refunds apply in arrival order;
      - a partial refund leaves the state `refunded` and the balances correct.
    - _Requirements: 5.5, 5.6, 5.7, 5.8, 5.9, 6.1, 8.1, 8.4_

  - [ ] 5.4 Prove rollback, lock order and secrecy in the handler
    - Add a code comment at the top of `apply.ts` that lists the lock order from design.md (inbox row, payment row, parked rows, ledger key, payment transactions, accounts) and why it cannot form a cycle with plain `postTransaction` or `refund`
    - Tests:
      - **Rollback**: a failure injected after the ledger change (for example an account deleted from the fixture, or the crash helper's logger once task 9.1 exists) returns `500` and leaves no inbox row, entries, payment state or outbox message. Retrying the same delivery then applies it exactly once.
      - **Secrecy**: no response body or error message from any path contains the secret, either signature or the raw body, checked across every status code with the secret as a distinctive string.
    - _Requirements: 6.3, 6.5, 6.6, 1.6, 10.4_

- [ ] 6. Outbox worker
  - [ ] 6.1 Implement `src/outbox/backoff.ts` and `tests/unit/backoff.test.ts`
    - `nextDelayMs(attempts, base, max) = min(max, base × 2^(attempts − 1))`. Compute it with `bigint` or a capped loop so a large attempt count cannot overflow to `Infinity`
    - Tests: exact values for attempts 1–5; the cap; a large attempt count stays at the cap
    - _Requirements: 9.5, 9.8_

  - [ ] 6.2 Implement `runOutboxOnce` in `src/outbox/worker.ts` and write `tests/unit/worker.test.ts`
    - **Claim**, in a short transaction: select due, unleased `pending` rows `ORDER BY next_attempt_at, id LIMIT $batch FOR UPDATE SKIP LOCKED`. For each row:
      - if `attempts >= maxAttempts`, set it `dead` without sending;
      - otherwise increment `attempts` in the claim transaction (D2), and set `lease_until` and a new `claim_token`.

      Then commit.
    - **Send** each claimed message with the sender, sequentially and outside any transaction
    - **Record** each result with an update fenced by `claim_token`:
      - success: `sent`;
      - failure below the maximum: `last_error` truncated to 1,000 characters, `next_attempt_at = now + nextDelayMs`, and the lease cleared;
      - failure at the maximum: `dead`.

      An update that matches 0 rows is dropped.
    - Tests (fake clock, fake sender):
      - a success is marked `sent` with the idempotency key passed to the sender;
      - retry times follow the backoff exactly;
      - a message is `dead` after `maxAttempts` failures, with the sender called exactly `maxAttempts` times;
      - a message claimed with `attempts == maxAttempts` (a crash loop) becomes `dead` without a send;
      - an unexpired lease is not reclaimed, and an expired one is, with the same idempotency key;
      - a stale result after a takeover is dropped by the fence;
      - `batchSize` is respected;
      - the claim SQL contains `FOR UPDATE SKIP LOCKED` (concurrent workers cannot be run on one pglite connection, so this is checked by inspecting the SQL);
      - nothing is ever deleted.
    - _Requirements: 8.6, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8_

- [ ] 7. Public API
  - [ ] 7.1 Export the new surface from `src/index.ts` and extend `tests/unit/publicApi.test.ts`
    - **Export**:
      - `createWebhookHandler`, `verifyWebhook`, `signWebhook`, `runOutboxOnce`, `nextDelayMs`;
      - the types `WebhookConfig`, `WebhookRequest`, `WebhookResponse`, `InboxOutcome`, `Clock`, `OutboxConfig`, `Sender`, `OutboxMessageToSend`, `OutboxRunResult`, `OutboxPayload`;
      - `InvalidWebhookPayloadError`, which the existing errors export already covers.
    - **Do not export** `applyEvent`, `parseEvent`, `uuidV5`, the key helpers, `refundOnTx`, or any schema object
    - **`publicApi.test.ts`**: update its expected export set to the new exact list and keep the "no schema, no internals" assertions. Add an end-to-end flow through the public entry point only:
      1. sign and deliver a capture, then check the balances;
      2. deliver a refund for another payment before its capture, then check it is parked;
      3. deliver that capture, then check the parked refund is applied;
      4. run `runOutboxOnce` with a fake sender, then check every message is `sent` with its idempotency key;
      5. deliver a duplicate, then check nothing changes.
    - _Requirements: 10.1, 10.2, 8.1, 9.4_

- [ ] 8. Checkpoint - Ensure all tests pass
  - Run `vitest --run` and `tsc --noEmit`. Ensure all tests pass, ask the user if questions arise.

- [ ] 9. Shared test helpers
  - [ ] 9.1 Create `tests/helpers/crash.ts`, `clock.ts`, `sender.ts` and `webhooks.ts`
    - **`crash.ts`**: extract the crash injection from `tests/property/atomicity.property.ts`, with these parts:
      - a second Drizzle instance on the same PGlite client, whose logger throws once before statement N;
      - wrappers for "before commit" and "after commit";
      - a calibration helper that asserts the statements a call issues, in order.

      Switch `atomicity.property.ts` to use it, keep it passing, and re-run its "swallowed entries insert" mutation to confirm it still fails.
    - **`clock.ts`**: `fakeClock(startMs)` with `now()` and `advance(ms)`
    - **`sender.ts`**: `fakeSender(script)`, which takes a list of outcomes (success, failure, or crash-after-send), records every call, and is cycled or defaulted when the list runs out
    - **`webhooks.ts`**:
      - a `validRailHistoryArb` (D1): 1–4 payments, each with an optional `pending`, at most one capture, and refunds summing to no more than the capture, plus optional unknown-type events, with event ids drawn from Unicode strings of 1–255 characters;
      - `deliveryOrderArb(history)`: a permutation with up to 2× duplicates, interleaved across payments;
      - `signedDelivery(secret, clock, event)`, using `signWebhook`;
      - `WEBHOOK_RUNS`, holding the three properties' run counts.
    - Write `tests/unit/webhookArbitraries.test.ts`. It asserts, with fast-check:
      - every generated history is valid per D1;
      - every delivery order contains each event at least once;
      - every signed delivery verifies at the clock's time;
      - every value in `WEBHOOK_RUNS` is at least 25.
    - _Requirements: 12.1, 12.2, 12.3, 12.4_

- [ ] 10. Property-based tests (required)
  - [ ] 10.1 Write the property test for Property 1 in `tests/property/staleTimestamp.property.ts`
    - **Property 1: A replayed old timestamp is always rejected**
    - **Generate**:
      - any body (valid events and arbitrary strings);
      - an age from 301 s to about 10 years, weighted toward 301–400 s.
    - **Check each case**:
      - sign the body correctly at `now − age`, and assert `401`;
      - assert the `webhook_events`, `payment_states`, `outbox_messages`, `transactions` and `entries` row counts are unchanged;
      - deliver the same body signed at `now`, and assert it is not `401` (when the body is a valid event), so the rejection is about age and not a bad signature.
    - At least 25 runs (`WEBHOOK_RUNS`)
    - **Before marking done**, run the property against each break below and confirm it fails, then restore `src/` (`git diff --quiet -- src`):
      - skip the timestamp check;
      - widen the tolerance to 300,000 s.
    - Tag: `// Feature: webhooks-outbox, Property 1`
    - **Validates: Requirements 2.2, 2.6, 1.1, 12.5**

  - [ ] 10.2 Write the property test for Property 2 in `tests/property/webhookOrder.property.ts`
    - **Property 2: Delivery order and duplicates don't change the outcome**
    - **Generate** a `validRailHistoryArb` and a `deliveryOrderArb`
    - **Run the cases**: deliver the shuffled sequence through the handler on one set of accounts and payment ids. Deliver the reference (each distinct event once, in natural order) on a second set, mapped one-to-one, in the same database
    - **Assert**:
      - every delivery returns `200`;
      - the clearing and revenue balances match;
      - every payment's state matches;
      - every event's inbox status matches;
      - there is exactly one outbox message per ledger-changing event on each side;
      - the global entry sum stays 0.
    - At least 25 runs
    - **Before marking done**, confirm it fails against each break below, then restore `src/`:
      - drop the inbox dedupe;
      - record refunds on an uncaptured payment as `rejected` instead of `parked`;
      - let `pending` overwrite `captured`.
    - Tag: `// Feature: webhooks-outbox, Property 2`
    - **Validates: Requirements 5.10, 4.3, 5.6, 5.7, 5.9, 8.1, 12.5**

  - [ ] 10.3 Write the property test for Property 3 in `tests/property/outboxDurability.property.ts`
    - **Property 3: The outbox never loses an event across crashes**
    - **Generate**:
      - a valid rail history of 1–2 payments;
      - a sender script of successes, failures and crash-after-send outcomes;
      - a set of crash points, covering:
        - during application: before each statement of `applyEvent` (calibrated with `crash.ts`), before commit, and after commit;
        - during the worker: before the claim, after the claim commits, after a send, and after a result is recorded.
    - **Drive each case**:
      - deliver each event, with the crash injected at its chosen point;
      - as the rail would, re-deliver every delivery that did not get a `2xx`, until it does;
      - run the worker, advancing the fake clock past every lease and backoff, with crashes injected at their points.

      The worker must drain within `messages × maxAttempts + 1` rounds, or the property fails.
    - **Assert**:
      - every event with a committed ledger change has exactly one outbox message;
      - each message is either `sent`, with the sender called at least once with its key, or `dead`, with `attempts = maxAttempts` and the sender called at most `maxAttempts` times (exactly `maxAttempts` when no crash interrupted one of its attempts);
      - no outbox message exists without a committed ledger change;
      - the outbox row count never decreases.
    - At least 25 runs
    - **Before marking done**, confirm it fails against each break below, then restore `src/`:
      - write the outbox message in a separate transaction after commit;
      - mark `sent` before calling the sender;
      - skip the lease check in the claim query;
      - count the attempt on failure instead of at claim (D2).
    - Tag: `// Feature: webhooks-outbox, Property 3`
    - **Validates: Requirements 9.9, 6.1, 6.3, 6.6, 8.1, 8.6, 9.6, 9.7, 12.5**

- [ ] 11. Final checkpoint - Ensure all tests pass
  - Run the full `vitest --run` three times, recording each wall time, and run `tsc --noEmit`
  - Every run must pass and finish in under 120 seconds. If a run comes close (over about 90 s), reduce per-case size rather than dropping any property below 25 runs, and ask the user if questions arise

## Notes

- Every task, including the property tests, is required. None are marked optional.
- Each property task is one test with one property number, tagged to the design, and it cannot be marked done until it has been shown to fail against every break listed for it. Afterwards `src/` must be byte-identical to before (`git diff --quiet -- src`).
- Three existing tests pin counts that this spec changes on purpose, and their updates are part of the tasks that change them: `migrationFiles.test.ts` and `migrate.test.ts` in task 2.1, and `publicApi.test.ts` in task 7.1. Each update keeps every existing check and changes only the expected count or set.
- The only change to `ledger-core` source is task 1.1. All existing `ledger-core` tests, including its six properties, must keep passing unchanged except for the count updates above.
- Concurrency (`SKIP LOCKED`, the unique-constraint wait, the lock order) cannot be exercised on pglite's single connection. These are verified by SQL inspection and the reasoning in design.md, not by a concurrent test.
- This workflow only produces planning artifacts. Begin implementation by opening this file and clicking "Start task" on a task.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "3.1", "3.2", "3.3", "6.1"] },
    { "id": 1, "tasks": ["5.1", "6.2", "9.1"] },
    { "id": 2, "tasks": ["5.2"] },
    { "id": 3, "tasks": ["5.3"] },
    { "id": 4, "tasks": ["5.4", "10.1"] },
    { "id": 5, "tasks": ["7.1", "10.2"] },
    { "id": 6, "tasks": ["10.3"] }
  ]
}
```
