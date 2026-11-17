# Requirements Document

## Introduction

`webhooks-outbox` adds the external-event layer to `packages/core`, on top of the finished `ledger-core` spec (`postTransaction`, `refund`, `balance`, the idempotency helpers, pglite tests and fast-check). It has four parts:

1. **Verification.** A signed webhook from the simulated bank rail is checked with HMAC-SHA256 over its timestamp and raw body before anything is parsed, and stale timestamps are rejected.
2. **Inbox.** Each event is recorded once by event id. Duplicates are acknowledged and do nothing. Events that arrive out of order only move a payment's state forward, and an event whose prerequisite has not arrived yet is held until it does.
3. **Atomic apply.** The inbox row, the ledger change and the outbox message for an event are written in one database transaction, and a success status is returned only after that transaction commits.
4. **Outbox worker.** Pending messages are claimed with `SELECT ... FOR UPDATE SKIP LOCKED`, sent at least once with an idempotency key, retried with exponential backoff, and moved to a dead-letter state after a maximum number of attempts.

The package stays framework-agnostic: the handler takes the raw body and headers and returns a status and body, and the apps wire it into Next.js routes. Side effects are sent through an injected sender, so no test touches a network. Amounts are `bigint` minor units in one asset; there is no currency conversion and no real bank or chain call in this spec.

This spec also covers ledger Property 3 from `.kiro/steering/ledger.md` (webhooks delivered twice or out of order), which `ledger-core` deferred here.

## Glossary

- **Webhook_Handler**: The core function that receives a raw webhook request (raw body and headers) and returns an HTTP-style status and body.
- **Verifier**: The function `verifyWebhook` that checks a webhook's signature and timestamp before the body is parsed.
- **Signing_Secret**: The shared secret used to compute the HMAC. Supplied by configuration, never stored in code.
- **Signed_Payload**: The exact byte string `<timestamp>.<raw body>` over which the HMAC-SHA256 is computed.
- **Signature_Headers**: `ossuary-timestamp` (Unix seconds) and `ossuary-signature` (64 lowercase hexadecimal characters), looked up case-insensitively.
- **Tolerance_Window**: 5 minutes (300 seconds). The maximum allowed distance between a webhook's timestamp and the current time.
- **Event**: A verified, parsed webhook payload with an `id`, a `type`, a `paymentId`, an `amount` and an `asset`.
- **Event_Id**: The rail's identifier for one event: a string of 1–255 characters, unique per event.
- **Event_Type**: One of `payment.pending`, `payment.captured`, `payment.refunded`.
- **Inbox**: The `webhook_events` table, one row per distinct Event_Id, with a unique constraint on the event id.
- **Inbox_Status**: The outcome recorded for an inbox row: `applied`, `parked`, `ignored` or `rejected`.
- **Payment_State**: A payment's lifecycle state: `pending`, `captured` or `refunded`, ranked in that order.
- **Forward_Transition**: A change of Payment_State to a strictly higher rank, or the first state recorded for a payment.
- **Valid_Rail_History**: A set of distinct events in which each payment has at most one `payment.captured` event and the amounts of its `payment.refunded` events sum to no more than its captured amount. It may include `payment.pending` events, unknown event types, and refunds whose capture is delivered later.
- **Parked_Event**: A `payment.refunded` event whose payment has not been captured yet. It is stored and applied later, when the capture is applied.
- **Ledger**: The `ledger-core` package: `postTransaction`, `refund`, `balance`.
- **Ledger_Key**: The idempotency key used for an event's ledger change: a UUID derived deterministically from the Event_Id.
- **Outbox**: The `outbox_messages` table of side effects to send after an event is applied.
- **Outbox_Message**: One row in the Outbox: a topic, a JSON-safe payload, an idempotency key, a status, an attempt count and the time of the next attempt.
- **Outbox_Status**: One of `pending`, `sent`, `dead`.
- **Outbox_Worker**: The function that claims due Outbox_Messages, sends them with the Sender and records the result.
- **Sender**: An injected async function that delivers one Outbox_Message to its receiver. Tests supply a fake.
- **Lease**: The period during which a claimed Outbox_Message cannot be claimed again by any worker.
- **Clearing_Account**: The configured asset account for the rail (`allow_overdraft = true`), debited by captures.
- **Revenue_Account**: The configured revenue account credited by captures.
- **Clock**: An injected source of the current time, so tests control "now".
- **Test_Suite**: The Vitest and fast-check tests for this spec, run on pglite.

---

## Requirements

### Requirement 1: Webhook Signature Verification

**User Story:** As a developer, I want every webhook's signature checked before its body is read, so that forged or altered events can never reach the ledger.

#### Acceptance Criteria

1. WHEN a webhook is received, THE Verifier SHALL compute HMAC-SHA256 with the Signing_Secret over the Signed_Payload `<timestamp>.<raw body>`, where the raw body is the exact received bytes, and compare it with the received signature before the body is parsed or decoded as JSON.
2. THE Verifier SHALL compare the computed and received signatures using a constant-time comparison over equal-length byte buffers.
3. IF either of the Signature_Headers is missing, the signature is not exactly 64 lowercase hexadecimal characters, or its decoded length differs from 32 bytes, THEN THE Verifier SHALL reject the webhook without performing a variable-time comparison and without throwing an uncaught error.
4. IF the computed signature does not match the received signature, THEN THE Webhook_Handler SHALL return status `401`, write nothing to the database, and not parse the body.
5. THE Verifier SHALL read the Signing_Secret only from the configuration passed to it, and SHALL reject a configuration whose Signing_Secret is shorter than 32 bytes.
6. THE Webhook_Handler SHALL NOT include the Signing_Secret, the computed signature, or the received signature in any returned body, error message or log line.
7. WHEN any single byte of the raw body or timestamp of a validly signed webhook is changed, THE Verifier SHALL reject the altered webhook.

---

### Requirement 2: Timestamp Replay Protection

**User Story:** As a developer, I want old webhooks rejected even when their signature is valid, so that a captured request cannot be replayed later.

#### Acceptance Criteria

1. THE Verifier SHALL accept a timestamp only if it is a base-10 integer number of Unix seconds with no sign, decimal point or surrounding whitespace.
2. IF a webhook's timestamp is more than 300 seconds before the current time from the Clock, THEN THE Verifier SHALL reject it, and THE Webhook_Handler SHALL return status `401` and write nothing, even when the signature is valid.
3. IF a webhook's timestamp is more than 300 seconds after the current time from the Clock, THEN THE Verifier SHALL reject it in the same way.
4. WHEN a webhook's timestamp is exactly 300 seconds from the current time, THE Verifier SHALL accept it.
5. THE Verifier SHALL check the timestamp only after the signature has been verified, so that an unsigned timestamp is never trusted.
6. **Property (fast-check):** FOR ALL validly signed webhooks whose timestamp is more than 300 seconds older than the Clock's current time, THE Webhook_Handler SHALL return status `401` and the Inbox, Ledger and Outbox SHALL be unchanged.

---

### Requirement 3: Event Payload Validation

**User Story:** As a developer, I want a verified webhook's payload checked before it is applied, so that malformed events or events in the wrong asset never move money.

#### Acceptance Criteria

1. WHEN a webhook has been verified, THE Webhook_Handler SHALL parse the raw body as JSON and require the fields `id` (string of 1–255 characters), `type`, `paymentId` (UUID) and `asset` (string).
2. WHERE the Event_Type is `payment.captured` or `payment.refunded`, THE Webhook_Handler SHALL require an `amount` field that is a decimal string of a positive integer in minor units, with no sign, leading zeros, decimal point or exponent, and no greater than 9223372036854775807, and SHALL convert it to `bigint` without passing through a JavaScript `number`.
3. IF the body is not valid JSON or any required field is missing or invalid, THEN THE Webhook_Handler SHALL return status `400` with a message naming the invalid field and write nothing.
4. IF the event's `asset` differs from the asset configured for the ledger, THEN THE Webhook_Handler SHALL return status `400` and write nothing; no currency conversion of any kind SHALL be attempted.
5. IF the Event_Type is not one of the three known types, THEN THE Webhook_Handler SHALL record the event in the Inbox with Inbox_Status `ignored`, make no ledger change and no outbox message, and return status `200`.
6. THE Webhook_Handler SHALL lowercase the `paymentId` before using it, so that the same payment in different letter case is treated as one payment.

---

### Requirement 4: Event Inbox and Deduplication

**User Story:** As a developer, I want each event applied at most once no matter how many times the rail delivers it, so that retries can never double-count money.

#### Acceptance Criteria

1. THE Inbox SHALL enforce a unique constraint on the event id.
2. WHEN a verified, valid event is received, THE Webhook_Handler SHALL record it with `INSERT ... ON CONFLICT (event_id) DO NOTHING RETURNING` inside the event's database transaction, and SHALL NOT rely on catching a unique-violation error.
3. IF the event id already exists in the Inbox, THEN THE Webhook_Handler SHALL return status `200`, make no ledger change, write no outbox message and leave the existing inbox row unchanged.
4. IF an event with an existing event id arrives with a different payload than the stored one, THEN THE Webhook_Handler SHALL return status `200`, apply nothing, and leave the stored row unchanged, so that the first delivery of an event id is the one that counts.
5. WHEN two deliveries of the same event id are processed concurrently, THE Inbox SHALL let at most one of them apply the event; the other SHALL wait on the unique constraint and then take the duplicate path.
6. THE Inbox SHALL store, for each event, the event id, type, payment id, amount, asset, the raw body, the Inbox_Status and the time it was received.

---

### Requirement 5: Forward-Only Payment State and Out-of-Order Events

**User Story:** As a developer, I want events that arrive out of order to end in the same place as events that arrive in order, so that the rail's delivery order cannot change balances.

#### Acceptance Criteria

1. THE Webhook_Handler SHALL keep one Payment_State per payment id, ranked `pending` < `captured` < `refunded`, and SHALL change it only by a Forward_Transition.
2. WHEN a `payment.pending` event is applied, THE Webhook_Handler SHALL set the Payment_State to `pending` only if the payment has no state yet, make no ledger change, and record Inbox_Status `applied`.
3. WHEN a `payment.captured` event is applied and the payment has no capture yet, THE Webhook_Handler SHALL post a capture transaction of the event's amount through `postTransaction` (kind `capture`, the payment id, debit the Clearing_Account, credit the Revenue_Account) and set the Payment_State to `captured` unless it is already higher.
4. IF a second, distinct `payment.captured` event arrives for a payment that already has a capture, THEN THE Webhook_Handler SHALL record it with Inbox_Status `rejected`, make no ledger change, and return status `200`.
5. WHEN a `payment.refunded` event is applied for a payment that has been captured, THE Webhook_Handler SHALL post a refund of the event's amount through the Ledger's refund logic, inheriting its cap (total refunded never exceeds total captured), and set the Payment_State to `refunded`.
6. WHEN a `payment.refunded` event arrives for a payment that has not been captured yet, THE Webhook_Handler SHALL record it with Inbox_Status `parked`, make no ledger change, and return status `200`.
7. WHEN a `payment.captured` event is applied for a payment with Parked_Events, THE Webhook_Handler SHALL, in the same database transaction, apply each Parked_Event in the order the events were received and change its Inbox_Status from `parked` to `applied` or `rejected`.
8. IF a refund would exceed the payment's remaining refundable amount, THEN THE Webhook_Handler SHALL record the event with Inbox_Status `rejected`, make no ledger change for it, and return status `200`.
9. THE Webhook_Handler SHALL NOT move a Payment_State backwards: an event whose state ranks below the current state still has its own ledger effect applied once if it has one, but SHALL leave the Payment_State unchanged.
10. **Property (fast-check):** FOR ALL Valid_Rail_Histories over one or more payments, and FOR ALL delivery sequences that are any permutation of those events with any number of duplicate deliveries, the final balances of every account, the final Payment_State of every payment and the final Inbox_Status of every event SHALL equal those produced by delivering each distinct event exactly once in its natural order (`pending`, then `captured`, then each `refunded` in event order). The property's domain is limited to Valid_Rail_Histories, in which each payment has at most one `payment.captured` event and its `payment.refunded` amounts sum to no more than its captured amount; duplicates, any interleaving across payments, refunds that arrive before their capture, `pending` events and unknown event types are all inside the domain, while histories outside it keep the behavior of criteria 4 and 8 and are covered by example-based unit tests.

---

### Requirement 6: Atomic Event Application

**User Story:** As a developer, I want an event's inbox row, ledger change and outbox message to be written together or not at all, so that a crash can never record an event without its money movement or lose its side effect.

#### Acceptance Criteria

1. WHEN an event is applied, THE Webhook_Handler SHALL write the inbox row, the Payment_State change, any ledger change (including applied Parked_Events) and the event's Outbox_Messages in one database transaction.
2. THE Webhook_Handler SHALL return a `2xx` status only after that database transaction has committed.
3. IF any step of applying an event fails, THEN THE Webhook_Handler SHALL roll back the whole database transaction, leave no inbox row, ledger entry, Payment_State change or outbox message for the event, and return status `500` so that the rail retries.
4. THE Webhook_Handler SHALL post the event's ledger change with the Ledger_Key, a UUID derived deterministically from the Event_Id, and SHALL claim that key in the same database transaction before calling `postTransaction` or the refund logic with the transaction handle.
5. THE Webhook_Handler SHALL take database locks in one documented order that is compatible with the Ledger's order (idempotency key, then the payment's transaction rows, then account rows), so that concurrent events for the same payment or accounts cannot deadlock.
6. WHEN a delivery is retried after a crash that occurred before commit, THE Webhook_Handler SHALL treat the event as new and apply it exactly once.

---

### Requirement 7: Refund Inside a Caller Transaction (change to ledger-core)

**User Story:** As a developer, I want the ledger's refund logic to run inside a transaction I already opened, so that a refund webhook can commit together with its inbox row and outbox message.

#### Acceptance Criteria

1. THE Ledger SHALL let the refund logic run on a caller-supplied open transaction handle, in the same way `postTransaction` accepts one, without opening its own database transaction.
2. WHEN the refund logic runs on a caller-supplied transaction, THE Ledger SHALL still lock the payment's transaction rows, enforce the refund cap and post the reversing entries on that transaction, and SHALL leave the idempotency-key claim, request-hash check and `completed` update to the caller.
3. WHEN no transaction handle is supplied, THE Ledger SHALL keep `refund`'s current behavior exactly, and all existing `ledger-core` tests SHALL pass unchanged.

---

### Requirement 8: Outbox Messages

**User Story:** As a developer, I want every side effect of an applied event stored durably next to the ledger change, so that it is sent even if the process dies right after commit.

#### Acceptance Criteria

1. WHEN an event changes the ledger, THE Webhook_Handler SHALL write exactly one Outbox_Message for it, with topic `payment.captured` or `payment.refunded`, in the same database transaction.
2. THE Outbox_Message payload SHALL be JSON-safe: it SHALL carry the event id, payment id, ledger transaction id, asset and amount, with the amount as a decimal string of minor units and never as a JSON number.
3. THE Outbox SHALL give each Outbox_Message an idempotency key, derived deterministically from the Event_Id and topic, with a unique constraint, so that a receiver can deduplicate repeated sends.
4. WHEN an event is ignored, rejected, parked or a duplicate, THE Webhook_Handler SHALL NOT write an Outbox_Message for it.
5. THE Outbox SHALL record for each message its status (initially `pending`), its attempt count (initially 0), the time of the next attempt (initially the commit time), the last error message if any, and its creation time.
6. THE Outbox SHALL NOT delete Outbox_Messages; a message only moves from `pending` to `sent` or `dead`.

---

### Requirement 9: Outbox Worker, Retries and Dead Letters

**User Story:** As a developer, I want a worker that sends pending side effects at least once, backs off on failure and gives up visibly, so that a flaky receiver never loses or floods messages.

#### Acceptance Criteria

1. WHEN the Outbox_Worker runs, THE Outbox_Worker SHALL claim up to a configured batch size of `pending` messages whose next-attempt time is at or before the Clock's current time, using `SELECT ... FOR UPDATE SKIP LOCKED` in a short database transaction, and give each claimed message a Lease before that transaction commits.
2. WHILE a message's Lease has not expired, THE Outbox_Worker SHALL NOT claim it again, from this worker or any other.
3. THE Outbox_Worker SHALL call the Sender outside any database transaction, passing the message's idempotency key, topic and payload.
4. WHEN the Sender succeeds, THE Outbox_Worker SHALL set the message's status to `sent` and record the time sent.
5. WHEN the Outbox_Worker claims a message, THE Outbox_Worker SHALL increment the message's attempt count in the claim transaction, before the Sender is called, so that an attempt interrupted by a crash still counts; IF the Sender then fails, THEN THE Outbox_Worker SHALL record the error message and set the next-attempt time to the current time plus `base × 2^(attempts − 1)`, capped at a configured maximum delay.
6. IF the Sender fails on an attempt whose count equals the configured maximum attempts, or a message is claimed while its attempt count already equals the configured maximum attempts, THEN THE Outbox_Worker SHALL set its status to `dead` without calling the Sender again and stop retrying it.
7. IF the process stops after a message is claimed but before its result is recorded, THEN the message SHALL become claimable again once its Lease expires, and SHALL be sent again with the same idempotency key.
8. THE Outbox_Worker SHALL take the base delay, maximum delay, maximum attempts, batch size and Lease length from configuration, and the current time from the Clock.
9. **Property (fast-check):** FOR ALL sequences of applied events, Sender outcomes (success or failure) and simulated crashes between any two steps of event application or of the worker (before claim, after claim, after send, after recording the result), WHEN the worker is run until no message is due and every Lease has expired, every event that committed a ledger change SHALL have exactly one Outbox_Message, each such message SHALL be `sent` (with the Sender called at least once with its idempotency key) or `dead` (with an attempt count, counted at claim time, equal to the maximum attempts, and the Sender called at most that many times), and no message SHALL be missing, deleted or sent for an event whose transaction did not commit.

---

### Requirement 10: Configuration and Secrets

**User Story:** As a developer, I want all secrets, account ids and tuning values passed in as configuration, so that nothing sensitive lives in code and tests can control every parameter.

#### Acceptance Criteria

1. THE Webhook_Handler SHALL take as configuration the Signing_Secret, the ledger asset code, the Clearing_Account id, the Revenue_Account id and the Clock.
2. THE Webhook_Handler and Outbox_Worker SHALL NOT read environment variables themselves; the apps read them and pass the values in.
3. IF the configured Clearing_Account or Revenue_Account does not exist, THEN THE Webhook_Handler SHALL fail with an error naming the missing account before writing anything.
4. THE Webhook_Handler SHALL NOT log raw webhook bodies or signatures.

---

### Requirement 11: Schema and Migrations

**User Story:** As a developer, I want the new tables managed by Drizzle migrations that follow the ledger's, so that the schema stays versioned and reproducible.

#### Acceptance Criteria

1. THE Ledger SHALL add Drizzle schema and ordered migrations, after the existing `ledger-core` migrations, for the `webhook_events`, `payment_states` and `outbox_messages` tables.
2. THE `webhook_events` table SHALL have a unique constraint on the event id; THE `payment_states` table SHALL have the payment id as its primary key; THE `outbox_messages` table SHALL have a unique constraint on its idempotency key and an index supporting the worker's query on status and next-attempt time.
3. THE new tables SHALL hold no balance or money total; amounts stored in `webhook_events` SHALL be `bigint` minor units, and only `entries.amount` SHALL count toward any balance.
4. WHEN tests run, THE Test_Suite SHALL apply all migrations, old and new, to an in-memory pglite instance.

---

### Requirement 12: Test Infrastructure and Correctness Properties

**User Story:** As a developer, I want the webhook and outbox guarantees proven by property tests that fail when the code is broken, so that the demo's "zero drift" claim is backed by evidence.

#### Acceptance Criteria

1. THE Test_Suite SHALL run on pglite with an injected Clock and a fake Sender, with no network access and no environment variables.
2. THE Test_Suite SHALL include one required fast-check property test for each of the three properties in Requirements 2.6, 5.10 and 9.9, each tagged with its property number and the requirements it validates, and each SHALL run at least 25 generated cases in the default `vitest --run`.
3. THE Test_Suite SHALL generate webhooks by signing them with the same Signed_Payload format, so that every generated delivery passes or fails verification for the reason the property intends.
4. THE Test_Suite SHALL simulate crashes by stopping an operation after a chosen step inside its open database transaction (or after commit, for the worker), without changing production code paths except through a documented test-only injection point if one is unavoidable.
5. THE Test_Suite SHALL document, for each property, at least one deliberate break of the production code that makes the property fail, and each property SHALL be shown to fail against that break before its task is marked done.
6. WHEN a property fails, THE Test_Suite SHALL report the counterexample, and SHALL bound each property run's time (including shrinking) so that a failure is reported rather than hanging.
7. THE full `vitest --run` for `packages/core`, including the existing `ledger-core` tests, SHALL finish in under 120 seconds.
