# Requirements Document

## Introduction

`ledger-core` is the foundational accounting layer for Ossuary. It provides a double-entry ledger in TypeScript backed by Drizzle ORM on Postgres, exposing three primary operations: `postTransaction`, `balance`, and `refund`. Every amount is stored as a `bigint` in minor units; balances are derived from summed entries rather than stored as mutable columns; and every money-moving operation is idempotent via an `Idempotency-Key`. The implementation must pass five structural correctness properties verifiable with fast-check and pglite (in-memory Postgres) so the test suite runs in CI without an external database.

## Glossary

- **Ledger**: The append-only store of all accounts and their associated entries.
- **Account**: A named record with a type (`asset`, `liability`, `revenue`, `expense`) that participates in transactions. Accounts are identified by a UUID `account_id`.
- **Entry**: An immutable record linking an account to a transaction with a signed `bigint` amount in minor units (positive = debit, negative = credit).
- **Transaction**: A set of entries that must sum to exactly zero, written atomically together with any idempotency key claim.
- **Idempotency_Key**: A client-generated UUID that uniquely identifies a requested operation.
- **Request_Hash**: A deterministic hash of the full request payload, computed by the Ledger and stored alongside the Idempotency_Key.
- **Idempotency_Record**: A row containing `(key, request_hash, status, response)` subject to a unique constraint on `key`.
- **postTransaction**: The function that accepts an idempotency key and a list of entries, validates them, and persists them atomically.
- **balance**: The function that computes a live account balance as `SELECT sum(amount) FROM entries WHERE account_id = $1`.
- **Payment**: A transaction (or group of transactions) that represents a captured monetary collection. Identified by a `payment_id`.
- **refund**: The function that creates a reversing transaction against a payment, subject to a cap equal to the total captured amount.
- **Poltergeist**: A test harness that injects faults (duplicate webhooks, out-of-order delivery, mid-operation crashes) to verify correctness properties.
- **pglite**: An in-memory Postgres-compatible engine used in CI so no external database is required.
- **Minor_Units**: Integer representation of a monetary amount (e.g., cents for USD; six-decimal base units for USDC).
- **Drift**: The difference between the expected and actual ledger sum. Must always be zero.

---

## Requirements

### Requirement 1: Account Management

**User Story:** As a developer building a payment feature, I want to create and retrieve accounts with typed roles, so that the ledger can enforce accounting rules per account type.

#### Acceptance Criteria

1. THE Ledger SHALL represent every account as a record containing a UUID `account_id`, a name of 1–255 characters, an account type (one of `asset`, `liability`, `revenue`, or `expense`), and a boolean `allow_negative` flag that defaults to `false` when omitted.
2. WHEN an account is created, THE Ledger SHALL persist it and return the full account record.
3. IF an account creation request omits `account_id`, name, or type, THEN THE Ledger SHALL reject the request with an error message indicating which field is missing, without writing anything to the database.
4. IF an account creation request supplies a type value other than `asset`, `liability`, `revenue`, or `expense`, THEN THE Ledger SHALL reject the request with an error message indicating the invalid type value, without writing anything to the database.
5. IF an account creation request supplies an `account_id` that already exists, THEN THE Ledger SHALL reject the request with an error message indicating the duplicate `account_id`, without writing anything to the database.

---

### Requirement 2: Append-Only Entries and Zero-Sum Transactions

**User Story:** As a developer, I want every posted transaction to consist of immutable entries that sum to zero, so that the ledger is always in balance and no money is created or destroyed.

#### Acceptance Criteria

1. WHEN a transaction is posted, THE Ledger SHALL verify that the sum of all entry amounts, where each amount is an integer representing the smallest indivisible currency unit, equals exactly zero before writing any entry to the database.
2. IF the sum of entry amounts is not zero, THEN THE Ledger SHALL reject the transaction, write nothing to the database, and return an error indicating that the transaction is unbalanced.
3. IF a posted transaction contains fewer than two entries, THEN THE Ledger SHALL reject the transaction, write nothing to the database, and return an error indicating that a minimum of two entries is required.
4. THE Ledger SHALL store entries as append-only rows; THE Ledger SHALL NOT provide any UPDATE or DELETE path for entry rows.
5. WHEN a correction is required, THE Ledger SHALL accept a new reversing transaction whose entries each negate the amount of a corresponding entry in the original transaction, resulting in a combined sum of zero across both transactions.
6. THE Ledger SHALL write the transaction record and all of its entries in a single database transaction so that partial writes cannot occur.
7. **Property (fast-check):** FOR ALL sequences of `postTransaction` calls where each call supplies two or more integer-amount entries that sum to zero, the sum of every entry amount persisted in the Ledger SHALL equal zero.

---

### Requirement 3: Idempotent `postTransaction`

**User Story:** As a developer, I want `postTransaction` to be safe to retry with the same idempotency key, so that network retries and double-taps in the UI cannot create duplicate ledger entries.

#### Acceptance Criteria

1. WHEN `postTransaction` is called with an `Idempotency_Key` and a payload, THE Ledger SHALL compute a `Request_Hash` as a deterministic digest of the full payload such that identical payloads always produce the same hash and any field-level difference produces a different hash, and SHALL attempt to claim the key by inserting an `Idempotency_Record` with status `in_progress` within the same database transaction that writes the entries.
2. IF `postTransaction` is called with an `Idempotency_Key` that matches an existing `Idempotency_Record` whose status is `completed` and whose `Request_Hash` matches the incoming payload hash, THEN THE Ledger SHALL return the stored response and SHALL NOT write any new entries, provided the `Idempotency_Record` was created no more than 24 hours prior; IF the record is older than 24 hours, THEN THE Ledger SHALL return an error indicating the idempotency window has expired.
3. IF `postTransaction` is called with an `Idempotency_Key` that matches an existing `Idempotency_Record` and the incoming `Request_Hash` differs from the stored `Request_Hash`, THEN THE Ledger SHALL return a `409 Conflict` error and SHALL NOT write any new entries.
4. THE Ledger SHALL enforce a unique database constraint on `Idempotency_Key` so that concurrent duplicate requests cannot both succeed.
5. IF the `Idempotency_Record` status is `in_progress` and the elapsed time since the record's creation timestamp exceeds 30 seconds, THEN THE Ledger SHALL mark the record status as `expired` and SHALL allow a subsequent `postTransaction` call with the same `Idempotency_Key` to insert a new `Idempotency_Record` with status `in_progress` as though no prior record existed.
6. IF a database error occurs after the key is claimed but before the response is stored, THEN THE Ledger SHALL roll back the entire transaction so that the key is not claimed and no entries are written.
7. IF `postTransaction` is called without an `Idempotency_Key` header or field, THEN THE Ledger SHALL reject the request with an error indicating the idempotency key is required and SHALL NOT write any entries.
8. **Property (fast-check):** FOR ALL valid `postTransaction` calls replayed with the same `Idempotency_Key` any number of times within the 24-hour retention window, the set of ledger entries SHALL be identical to the set produced by a single execution.

---

### Requirement 4: Derived Balance

**User Story:** As a developer, I want `balance(accountId)` to return the live sum of all entries for that account, so that balances are always consistent with the entry log and cannot drift from it.

#### Acceptance Criteria

1. WHEN `balance` is called with a valid `account_id`, THE Ledger SHALL return the sum of all entry amounts for that account as a signed integer, returning `0` when no entries exist.
2. THE Ledger SHALL derive the balance from the entry log at read time and SHALL NOT maintain a separately stored balance value that can diverge from the entry log.
3. IF `balance` is called with an `account_id` that does not exist in the Ledger, THEN THE Ledger SHALL return an error indicating the account was not found without returning a numeric value.
4. WHEN an entry is successfully written for an `account_id`, THE Ledger SHALL include that entry's amount in the result of any subsequent `balance` call for that `account_id`.

---

### Requirement 5: Refund Cap Enforcement

**User Story:** As a developer, I want `refund(paymentId, amount)` to prevent over-refunding, so that the ledger cannot issue more money back than was originally captured.

#### Acceptance Criteria

1. WHEN `refund` is called, THE Ledger SHALL compute the total captured amount for the given `payment_id` by summing all ledger entries of type `CAPTURE` associated with that `payment_id`.
2. WHEN `refund` is called, THE Ledger SHALL compute the total already-refunded amount for the given `payment_id` by summing all successfully posted refund entries associated with that `payment_id`.
3. IF the requested refund `amount` is less than or equal to zero, or if the requested `amount` would cause the total refunded amount to exceed the total captured amount, THEN THE Ledger SHALL reject the refund with an error indicating the specific reason (invalid amount or cap exceeded), without writing any ledger entries.
4. IF `refund` is called with a `payment_id` that does not correspond to any existing captured transaction in the ledger, THEN THE Ledger SHALL reject the refund with an error indicating the payment was not found, without writing any ledger entries.
5. WHEN a valid refund is accepted, THE Ledger SHALL post it as a new reversing transaction using `postTransaction`, inheriting full idempotency and atomicity guarantees.
6. THE Ledger SHALL enforce the refund cap check and the entry write atomically, such that no two concurrent `refund` calls for the same `payment_id` can both pass the cap check when only one of them fits within the remaining refundable amount.
7. **Property (fast-check):** FOR ALL sequences of `refund` calls against any `payment_id`, the total refunded amount SHALL be less than or equal to the total captured amount for that `payment_id`.

---

### Requirement 6: No Negative Balance for Restricted Accounts

**User Story:** As a developer, I want accounts without `allow_negative` to be protected from going below zero, so that the ledger enforces economic constraints at the data layer.

#### Acceptance Criteria

1. IF a submitted transaction would cause the post-transaction balance of any account with `allow_negative = false` to be less than `0n`, THEN THE Ledger SHALL reject the entire transaction, persist no entries, and return an error indicating which account would have gone negative.
2. IF a submitted transaction would cause the post-transaction balance of any account with `allow_negative = false` to be less than `0n`, THEN THE Ledger SHALL evaluate the balance check and the entry write as a single atomic operation, such that no entries are written if the check fails.
3. WHERE an account has `allow_negative = true`, THE Ledger SHALL apply the transaction's entries to that account regardless of whether its post-transaction balance is less than `0n`.

---

### Requirement 7: Webhook Idempotency and Ordering

**User Story:** As a developer, I want duplicate or out-of-order webhook deliveries to have no additional effect on ledger balances, so that unreliable external rails cannot corrupt the ledger.

#### Acceptance Criteria

1. WHEN a webhook event is received, THE Ledger SHALL verify its signature and reject the event with an error response indicating authentication failure without modifying any account balances if the signature is invalid.
2. IF a webhook event's event ID matches an already-processed event ID, THEN THE Ledger SHALL return an acknowledgment response identical in status to the original success response without applying any ledger operations.
3. IF a webhook event arrives with a sequence number lower than the highest sequence number already applied for the same payment, THEN THE Ledger SHALL produce final account balances identical to those that would result from processing all distinct events in ascending sequence number order.
4. THE Ledger SHALL ensure that for any combination of duplicate deliveries and sequence-number permutations of a webhook event set, the final account balances equal the balances produced by processing each distinct event exactly once in ascending sequence number order.

---

### Requirement 8: Atomicity Under Fault Injection

**User Story:** As a developer, I want any crash between steps of a ledger operation to leave the database either fully before or fully after the operation, so that partial writes can never create inconsistent state.

#### Acceptance Criteria

1. WHEN a process crash occurs at any point during a `postTransaction` call, THE Ledger SHALL leave the database in a state where either all of the following are present — the idempotency key record, all ledger entries, and the stored response — or none of them are present, with no subset of these records persisted without the others.
2. THE Ledger SHALL use a single database transaction to encompass the idempotency key claim, all entry writes, and the response storage, so that a crash anywhere in the sequence rolls back the entire unit.
3. WHEN a `postTransaction` call is retried after a crash that occurred before the database transaction committed, THE Ledger SHALL treat the operation as not having started, accept the idempotency key as unclaimed, and complete the full write sequence as a new attempt.
4. FOR ALL possible crash injection points within `postTransaction`, the ledger sum SHALL equal zero and, upon retry to completion, THE Ledger SHALL either reject the request as a duplicate by returning the previously stored response or complete the write sequence exactly once, with no crash point producing a retry outcome that differs from these two cases.

---

### Requirement 9: Schema and Migrations

**User Story:** As a developer, I want the database schema to be managed by Drizzle ORM migrations, so that the ledger schema is version-controlled and reproducible.

#### Acceptance Criteria

1. THE Ledger SHALL define its schema using Drizzle ORM with TypeScript `"strict": true` compiler option and `bigint` column types for the monetary amount columns: `accounts.balance`, `entries.amount`, and `transactions.amount`.
2. THE Ledger SHALL provide Drizzle migration files that create the `accounts`, `transactions`, `entries`, and `idempotency_records` tables, where each table has a primary key column, and the migration files are applied in the order determined by their Drizzle-generated sequence identifiers.
3. THE Ledger SHALL apply a unique index on `idempotency_records(key)`, a foreign-key constraint from `entries(transaction_id)` to `transactions(id)`, and a foreign-key constraint from `entries(account_id)` to `accounts(id)`.
4. WHEN tests run, THE Ledger SHALL apply all migrations against a pglite in-memory instance before any test assertion executes, so that no external Postgres database is required.

---

### Requirement 10: Test Infrastructure

**User Story:** As a developer, I want all property-based tests to run against an in-memory Postgres instance, so that the CI pipeline has no external dependencies.

#### Acceptance Criteria

1. THE Test_Suite SHALL use pglite as the Postgres backend for all Vitest unit and property tests, with no connections opened to any external host during test execution.
2. THE Test_Suite SHALL use fast-check to generate arbitrary sequences of `postTransaction`, `refund`, and balance-query operations for property tests, with each generated sequence containing between 1 and 200 operations.
3. THE Test_Suite SHALL assert each of the five correctness properties listed in `ledger.md` with at least one dedicated falsifiable assertion per property:
   a. The sum of all ledger entries is always zero after any sequence of operations.
   b. Submitting an operation with an idempotency key that has already been processed results in the same ledger state as if the duplicate submission never occurred.
   c. WHEN a webhook event is delivered more than once or out of order, THE Test_Suite SHALL assert that the resulting balances are identical to those produced by a single in-order delivery.
   d. The total refunded amount for a given payment never exceeds the total captured amount for that payment.
   e. WHEN a mid-operation interruption is simulated at each step of a transaction, THE Test_Suite SHALL assert that the ledger state is either fully committed or fully absent, with no partial writes persisted.
4. IF `vitest --run` has not exited within 120 seconds, THEN THE Test_Suite SHALL be considered failed, and the process SHALL exit with a non-zero code indicating a timeout.
