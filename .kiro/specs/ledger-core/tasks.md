# Implementation Plan: ledger-core

## Overview

Implement `packages/core` in TypeScript (strict, Node 22+, pnpm workspaces) as laid out in design.md. Work proceeds bottom-up: setup, shared errors/types, hash, schema and migrations, pglite test DB, accounts, `postTransaction`, `balance`, `refund`, public API wiring, then one required property-based test per correctness property (Properties 1-6).

Conventions for every task:
- Amounts are `bigint` in minor units. No floats. No balance or total column anywhere; only `entries.amount` holds money.
- All tests run on pglite via `createTestDb()` (once it exists). Run with `vitest --run`, never watch mode.
- Each task ends with its tests passing.
- Code is written under `packages/core/`. Paths below are relative to that directory.

## Tasks

- [x] 1. Project setup
  - [x] 1.1 Scaffold the `packages/core` workspace package
    - Create `package.json` (ESM, name `@ossuary/core`), `tsconfig.json` with `"strict": true`, `drizzle.config.ts`, and `vitest.config.ts` (`testTimeout: 120_000`, `include: ['tests/**/*.test.ts', 'tests/**/*.property.ts']`, so the `*.property.ts` files are picked up)
    - Add dependencies: `drizzle-orm`, `@neondatabase/serverless`; dev dependencies: `typescript`, `vitest`, `fast-check`, `drizzle-kit`, `@electric-sql/pglite`
    - Ensure the repo root has a `pnpm-workspace.yaml` that includes `packages/*` and `apps/*`; set `engines.node` to `>=22`
    - Add a `test` script: `vitest --run`
    - Add `tests/unit/smoke.test.ts` asserting a `bigint` addition so `vitest --run` passes
    - _Requirements: 8.1, 9.1, 9.4_

- [x] 2. Shared errors and types
  - [x] 2.1 Implement `src/types/index.ts` and `src/errors/index.ts`
    - Define all types from design.md (`AccountType`, `TransactionKind`, `Account`, `EntryInput`, `PostTransactionInput`, `RefundInput`, and so on) with `bigint` amounts
    - Define `LedgerError` and every typed subclass listed in design.md
    - Add one error not named in the design: `KeyInFlightError`. It is the retriable conflict that `postTransaction` throws when it sees an existing `in_progress` key (design step 6)
    - Write `tests/unit/errors.test.ts` checking each error is `instanceof LedgerError` and carries its fields
    - _Requirements: 1.3, 1.4, 1.5, 2.2, 2.3, 3.2, 3.3, 3.7, 4.3, 5.3, 5.4, 6.2, 6.3_

- [x] 3. Deterministic request hash
  - [x] 3.1 Implement `src/ledger/hash.ts` and `tests/unit/hash.test.ts`
    - Use a canonical serializer that recursively sorts object keys and encodes `bigint` as a tagged string. The design's `JSON.stringify(payload, Object.keys(payload).sort())` drops nested keys and throws on `bigint`, so do not copy it
    - Hash with SHA-256 from `node:crypto`
    - Tests: identical payloads give the same hash; reordered keys give the same hash; a change to any single field (amount, account, kind, paymentId, entry order) gives a different hash; `bigint` amounts hash without error
    - _Requirements: 3.1_

- [x] 4. Schema, migrations, and test database
  - [x] 4.1 Implement the Drizzle schema in `src/schema/`
    - Create `accounts.ts`, `idempotency.ts`, `transactions.ts` (with the nullable `idempotency_key` FK to `idempotency_records.key`), `entries.ts` (`bigint` mode `'bigint'`, FKs to `transactions` and `accounts`), and `index.ts`
    - Generate migrations `0000`-`0003` with drizzle-kit into `src/migrations/`
    - The unique index on `idempotency_records(key)` must be present
    - Write `tests/unit/schema.test.ts` that inspects the Drizzle table definitions. It asserts that no column named like `balance` or `total` exists on any table, and that `entries.amount` is the only bigint money column
    - _Requirements: 8.1, 8.2, 8.3, 8.4_

  - [x] 4.2 Add append-only trigger migration `0004_append_only_trigger.sql`
    - Create the `entries_no_mutate()` function and the `BEFORE UPDATE OR DELETE` trigger on `entries`. The exception message must contain `append-only`
    - Register it in the drizzle migration journal so it applies in order
    - _Requirements: 2.4, 8.2_

  - [x] 4.3 Implement `tests/helpers/createTestDb.ts` and a migration smoke test
    - Create an in-memory `PGlite`, wrap it with `drizzle-orm/pglite`, and run all migrations from `./src/migrations`. Read no environment variables
    - Write `tests/unit/migrations.test.ts`. It asserts that the four tables exist, that the unique index on `idempotency_records(key)` exists, that the FKs on `entries` exist, and that `transactions.kind` rejects values outside the enum
    - _Requirements: 8.2, 8.3, 8.4, 8.5, 9.1_

  - [x] 4.4 Implement `src/db/client.ts` and `src/db/migrate.ts`
    - `createDb(connectionString)` builds a Neon pool and returns a Drizzle `Db`. Use an ESM `import`, not `require`. Define a `Db` type that both the Neon and pglite drivers satisfy, so business logic accepts either by injection
    - `runMigrations(db)` applies the migrations folder
    - Test: `runMigrations` runs against a pglite `Db` in `tests/unit/migrate.test.ts` (no network)
    - _Requirements: 8.2, 8.5, 9.1_

- [x] 5. Checkpoint - Ensure all tests pass
  - Run `vitest --run`. Ensure all tests pass, ask the user if questions arise.

- [x] 6. Account management
  - [x] 6.1 Implement `src/ledger/accounts.ts` (`createAccount`, `getAccount`) and `tests/unit/accounts.test.ts`
    - `allowOverdraft` defaults to `false`; name length 1-255
    - Throw `MissingFieldError` (naming the field), `InvalidAccountTypeError`, and `DuplicateAccountError`; nothing is written on failure
    - Tests: create/retrieve round trip returns the full record; each missing field is rejected; an invalid type is rejected; a duplicate `accountId` is rejected; the default `allowOverdraft` is `false`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

- [ ] 7. postTransaction
  - [x] 7.1 Implement the core `postTransaction` write path in `src/ledger/postTransaction.ts`
    - Pre-transaction validation: `MissingIdempotencyKeyError`, `InsufficientEntriesError` (fewer than 2 entries), `UnbalancedTransactionError` (`bigint` sum not 0n)
    - Inside one `db.transaction()` (READ COMMITTED, the default): compute the hash with `hashPayload`, then claim the key with `INSERT ... ON CONFLICT (key) DO NOTHING RETURNING key`
    - After a successful claim: insert the `transactions` row (with `idempotency_key`), bulk insert `entries`, `UPDATE idempotency_records SET status='completed', response=...`, and return `{ transactionId, entryIds }`
    - Tests in `tests/unit/postTransaction.test.ts`: valid post persists the transaction, entries, and a `completed` idempotency record; each validation error writes nothing; a failure mid-write (for example an entry on an unknown account that trips the FK) rolls everything back, including the key claim
    - _Requirements: 2.1, 2.2, 2.3, 2.6, 3.1, 3.6, 3.7, 7.2_

  - [x] 7.2 Add replay, conflict, and in-flight handling to `postTransaction`
    - When the claim returns no row, `SELECT` the existing record
    - `completed` with a matching hash and age of at most 24h returns the stored response with no writes; age over 24h throws `IdempotencyWindowExpiredError`
    - A different hash throws `DuplicateKeyError`
    - `in_progress` throws `KeyInFlightError`
    - Tests: replay returns the identical response and leaves the entry count unchanged; a changed payload on the same key throws `DuplicateKeyError`; an old record (backdate `created_at` in the test) throws `IdempotencyWindowExpiredError`; an `in_progress` record throws `KeyInFlightError`
    - _Requirements: 3.2, 3.3, 3.4, 3.5_

  - [x] 7.3 Add account locking and normal-balance enforcement to `postTransaction`
    - After the claim, run `SELECT account_id, type, allow_overdraft FROM accounts WHERE account_id = ANY($ids) ORDER BY account_id FOR UPDATE`. Throw `AccountNotFoundError` for any missing account
    - For each entry, compute the prospective balance (`SUM(entries.amount)` plus the entry amount). Asset/expense with a balance below 0 and liability/revenue with a balance above 0 throw `NormalBalanceViolationError`, unless `allow_overdraft` is true. Multiple entries to one account in a single transaction are summed before the check
    - Tests: each of the four account types, rejected and accepted; `allow_overdraft = true` bypasses the check; a rejected transaction writes no entries and leaves the key unclaimed
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

  - [ ] 7.4 Add the optional `tx` parameter to `postTransaction`
    - When `tx` is supplied, skip `db.transaction()` and the idempotency claim and run all statements on the caller's handle. Account locking, normal-balance checks, and entry writes still run. Setting the final `completed` status is left to the caller
    - Keep the no-`tx` behavior unchanged
    - Tests: calling with a `tx` opened by the test commits atomically with the caller's work; rolling back the outer transaction removes the entries
    - _Requirements: 5.5, 5.6, 7.2_

  - [ ] 7.5 Write `tests/unit/appendOnly.test.ts`
    - After a successful `postTransaction`, a raw `UPDATE entries ...` and a raw `DELETE FROM entries ...` must each throw an error whose message contains `append-only`
    - _Requirements: 2.4_

- [ ] 8. Derived balance
  - [ ] 8.1 Implement `src/ledger/balance.ts` and `tests/unit/balance.test.ts`
    - Check the account exists (`AccountNotFoundError` if not), then `SELECT COALESCE(SUM(amount), 0)` and return a `bigint`. No transaction wrapper
    - Tests: 0n for an account with no entries; the sum is correct after several posts; an unknown account throws; a balance read after a new post reflects it immediately
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

- [ ] 9. Checkpoint - Ensure all tests pass
  - Run `vitest --run`. Ensure all tests pass, ask the user if questions arise.

- [ ] 10. Refund
  - [ ] 10.1 Implement `src/ledger/refund.ts` and `tests/unit/refund.test.ts`
    - Validate `amount > 0n` (`InvalidRefundAmountError`) and a present key (`MissingIdempotencyKeyError`) before opening a transaction
    - Open `db.transaction()` and claim the idempotency key first, using the same `ON CONFLICT DO NOTHING RETURNING` pattern, with the same replay, `DuplicateKeyError`, expiry, and in-flight handling as `postTransaction`. Factor the claim and replay logic into a shared helper used by both functions
    - Lock capture transactions for the payment with `FOR UPDATE`; throw `PaymentNotFoundError` if none. Lock the existing refund transactions for the payment as well
    - Compute `captured` and `alreadyRefunded` as sums of positive `entries.amount` only (summing all entries gives 0). Compute `remaining`; throw `RefundCapExceededError(requested, remaining)` if `amount > remaining`
    - Build reversing entries for `amount`, call `postTransaction(..., 'refund', paymentId, tx)`, then mark the idempotency record `completed` with the response, all in the same transaction
    - Tests: a full refund succeeds; a partial refund followed by the remainder succeeds; an over-cap refund throws and writes nothing; an unknown payment throws; a non-positive amount throws; a replay with the same key returns the stored response even after the payment is fully refunded; a different amount on the same key throws `DuplicateKeyError`
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

  - [ ] 10.2 Wire the public API in `src/index.ts`
    - Export `createAccount`, `getAccount`, `postTransaction`, `balance`, `refund`, `createDb`, `runMigrations`, and all types and errors. Do not export anything from `schema/`
    - Write `tests/unit/publicApi.test.ts`. It checks the exported names and that no schema objects are exposed. It also runs an end-to-end flow (create accounts, capture, balance, partial refund, balance) through the public entry point
    - _Requirements: 2.5, 4.4, 5.5_

- [ ] 11. Checkpoint - Ensure all tests pass
  - Run `vitest --run`. Ensure all tests pass, ask the user if questions arise.

- [ ] 12. Property-based tests (required)
  - [ ] 12.1 Create shared fast-check arbitraries in `tests/helpers/arbitraries.ts`
    - `validTransactionArb`: 2 or more entries over a small pool of accounts (set up with `allowOverdraft: true` where the property needs unconstrained postings) whose `bigint` amounts sum to exactly 0n
    - `captureTransactionArb` and `refundArb` for the refund properties
    - A helper to build a fresh `createTestDb()` and seed accounts per run
    - A shared run config of `{ numRuns: 100 }` and sequence lengths between 1 and 200 where sequences are generated
    - Add `tests/unit/arbitraries.test.ts`, which asserts with fast-check that generated transactions always sum to 0n and have at least 2 entries
    - _Requirements: 9.1, 9.2_

  - [ ] 12.2 Write property test for Property 1 in `tests/property/entrySum.property.ts`
    - **Property 1: Global entry sum is always zero**
    - Generate `fc.array(validTransactionArb, { minLength: 1, maxLength: 200 })`; after each `postTransaction`, assert `SUM(entries.amount) === 0n`. Include calls that are rejected (for example by normal-balance violations) and assert the sum stays 0n
    - Tag: `// Feature: ledger-core, Property 1`
    - **Validates: Requirements 2.7, 9.3a**

  - [ ] 12.3 Write property test for Property 2 in `tests/property/idempotency.property.ts`
    - **Property 2: Idempotency replay leaves the ledger unchanged**
    - Generate a valid transaction and a replay count in 1-50; after the first call, replay N times and assert that the entry count, every account balance, and the returned response are unchanged
    - Tag: `// Feature: ledger-core, Property 2`
    - **Validates: Requirements 3.8, 9.3b**

  - [ ] 12.4 Write property test for Property 3 in `tests/property/idempotency.property.ts`
    - **Property 3: Replay in any order with duplicates yields the same balances**
    - Generate 1-20 distinct transactions (distinct keys) and a delivery sequence that is a permutation with duplicates. Use accounts with `allowOverdraft: true` so order cannot change acceptance. Compare final balances with a reference ledger that applies each distinct key once
    - Tag: `// Feature: ledger-core, Property 3`
    - **Validates: Requirements 9.3, 9.3c, 3.8**

  - [ ] 12.5 Write property test for Property 4 in `tests/property/refundCap.property.ts`
    - **Property 4: Total refunded per payment never exceeds total captured**
    - Generate a capture and 0-20 refund attempts of arbitrary positive `bigint` amounts with distinct keys; catch `RefundCapExceededError`; after every call assert that the sum of positive entry amounts on `refund` transactions is at most the sum on `capture` transactions
    - Tag: `// Feature: ledger-core, Property 4`
    - **Validates: Requirements 5.7, 9.3d**

  - [ ] 12.6 Write property test for Property 5 in `tests/property/refundCap.property.ts`
    - **Property 5: Boundary - exact remaining amount accepted, one unit over rejected**
    - Generate a capture and a prior refund total no larger than the capture. Compute `R = captured - alreadyRefunded`. If `R > 0n`, `refund(R)` succeeds, then `refund(R + 1n)` with a new key throws `RefundCapExceededError`. Assert that the rejected call wrote no transaction, entries, or idempotency record. Also cover `R = 0n`, where `refund(1n)` is rejected
    - Tag: `// Feature: ledger-core, Property 5`
    - **Validates: Requirements 5.8, 5.3**

  - [ ] 12.7 Write property test for Property 6 in `tests/property/atomicity.property.ts`
    - **Property 6: Crash at any step leaves the ledger fully committed or fully absent**
    - Generate a valid transaction and a crash point from 0 to NUM_STEPS-1, where the steps are: before the key claim, after the claim, after the account lock, after the transactions insert, after the entries insert, and after the idempotency update. Inject the crash with a wrapper or proxy around the Drizzle transaction handle that throws after the Nth statement. If the proxy cannot intercept every step, add a small internal test-only hook in `postTransaction` and document it
    - After the crash, assert one of two states: all of the idempotency record, the entries, and the `completed` status are present, or none are. Assert `SUM(entries.amount) === 0n` in both cases. Retry the same key to completion and assert that exactly one set of entries exists, or that the stored response is returned
    - Tag: `// Feature: ledger-core, Property 6`
    - **Validates: Requirements 7.4, 7.1, 7.3, 9.3e**

- [ ] 13. Final checkpoint - Ensure all tests pass
  - Run `vitest --run` and confirm it exits in under 120 seconds. Ensure all tests pass, ask the user if questions arise.

## Notes

- Every task, including the property tests, is required. None are marked optional.
- Each property task is one test with one property number, tagged to the design.
- Design deviations to be aware of: the hash serializer (task 3.1) fixes a bug in the design's snippet, and `KeyInFlightError` (task 2.1) names the in-flight conflict that the design describes but does not name.
- `refund` marks the idempotency record `completed` itself because `postTransaction` skips that step when given a `tx` (tasks 7.4 and 10.1).
- This workflow only produces planning artifacts. Begin implementation by opening this file and clicking "Start task" on a task.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1", "4.1"] },
    { "id": 2, "tasks": ["3.1", "4.2"] },
    { "id": 3, "tasks": ["4.3", "4.4"] },
    { "id": 4, "tasks": ["6.1"] },
    { "id": 5, "tasks": ["7.1"] },
    { "id": 6, "tasks": ["7.2", "7.5", "8.1"] },
    { "id": 7, "tasks": ["7.3"] },
    { "id": 8, "tasks": ["7.4"] },
    { "id": 9, "tasks": ["10.1"] },
    { "id": 10, "tasks": ["10.2", "12.1"] },
    { "id": 11, "tasks": ["12.2", "12.3", "12.5", "12.7"] },
    { "id": 12, "tasks": ["12.4", "12.6"] }
  ]
}
```
