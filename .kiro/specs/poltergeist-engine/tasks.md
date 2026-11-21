# Implementation Plan: poltergeist-engine

## Overview

Build the poltergeist in `packages/core/src/poltergeist/` and the Vibe Pay twin in `packages/twin/`, as laid out in design.md. Work proceeds bottom-up:

1. move the shared helpers that `src/` needs, and add the seeded PRNG;
2. the fault catalog, the storm generator and id materialization;
3. the drift meter and the report;
4. the SUT interface, the Ossuary adapter and the runner;
5. the Vibe Pay twin and its adapter;
6. the CLI;
7. one required property test per correctness property (Properties 1–4).

Conventions for every task:

- **Money.** Amounts are `bigint` minor units of USDC (6 decimals), carried with their asset. There are no floats, no conversion and no rounding, except the disclosed truncation in the twin adapter (design Q10).
- **Tests.** All tests run on pglite with the virtual clock, with no network and no environment variables. Run them with `vitest --run`, never in watch mode.
- **Definition of done.** Each task ends with its own tests passing, the full suite passing and `tsc --noEmit` clean.
- **Database per file.** New test files use one migrated database per file (`beforeAll`), with a fresh run tag per run.
- **Secrets and ids.** No secret, signature or raw body appears in any report, error message or log line. No concrete id appears in a report.
- **Paths.** Paths are relative to `packages/core/` unless they start with `packages/twin/`.
- **Scope of source changes.** Nothing under `src/ledger`, `src/webhooks`, `src/outbox`, `src/schema` or `src/migrations` changes in this spec.

## Tasks

- [x] 1. Shared helpers and the seeded PRNG
  - [x] 1.1 Move the helpers that `src/` needs into `src/poltergeist/`, and re-export them from `tests/helpers/`
    - Moves:
      - `fakeClock` and `FakeClock` → `src/poltergeist/clock.ts`;
      - `createCrashingDb`, `SimulatedCrash`, `CrashPoint`, `CrashingDb` and `describeCrashPoint` → `src/poltergeist/crash.ts`;
      - `fakeSender` and its types → `src/poltergeist/sender.ts`;
      - `signedDelivery` and `signedDeliveryAt` → `src/poltergeist/rail.ts`.
    - `tests/helpers/clock.ts`, `crash.ts`, `sender.ts` and `webhooks.ts` re-export the moved names unchanged. `calibrate` stays in `tests/helpers/crash.ts`, and the fast-check arbitraries stay in `tests/helpers/webhooks.ts`
    - In `package.json`, move `@electric-sql/pglite` from `devDependencies` to `dependencies`
    - Write `tests/unit/boundaries.test.ts`, which scans import specifiers and checks:
      - no file under `src/ledger`, `webhooks`, `outbox`, `db`, `schema`, `types` or `errors` imports `poltergeist/`;
      - `src/index.ts` exports nothing from `poltergeist/`;
      - no file under `src/poltergeist` uses `Math.random`.
    - The full suite must pass with no change to any existing test file. Confirm with `git diff --stat -- tests/unit tests/property`, which must be empty
    - Re-run the `atomicity.property.ts` "swallowed entries insert" mutation once, to confirm the moved crash helper still catches it, then restore `src/`
    - _Requirements: 12.1, 12.2, 12.3, 12.4_

  - [x] 1.2 Implement `src/poltergeist/rng.ts` and write `tests/unit/rng.test.ts`
    - `createRng(seed)` with `mulberry32`, plus `u32`, `int`, `bigint`, `pick`, `weighted`, `shuffle` and `hex8`, as in design.md. Use rejection sampling for unbiased ranges. `bigint` combines two `u32` draws
    - `createRng` throws `RangeError` for a seed that is not an integer from 0 to 4294967295
    - Tests:
      - the first 5 `u32` outputs for seeds 0 and 7, pinned and cross-checked against an inline reference implementation;
      - `int` and `bigint` hit both bounds and never leave them (fast-check);
      - `shuffle` returns a permutation and does not mutate its input;
      - `Math.random` is never called (spy).
    - _Requirements: 2.1, 2.3_

  - [x] 1.3 Embed the migrations for browser use
    - Write `scripts/embed-migrations.ts`. It reads `src/migrations/meta/_journal.json` and each `.sql` file, and writes `src/poltergeist/embeddedMigrations.generated.ts`, which exports `EMBEDDED_MIGRATIONS: MigrationMeta[]`. Each entry holds:
      - `sql`: the file split on `--> statement-breakpoint`;
      - `bps`: the journal's breakpoint flag;
      - `folderMillis`: the journal's `when`;
      - `hash`: SHA-256 of the file, computed by the script.

      Add the script `"embed-migrations": "tsx scripts/embed-migrations.ts"`, and add `tsx` and `esbuild` to `devDependencies`
    - Write `src/poltergeist/migrate.ts`, exporting `applyEmbeddedMigrations(db)`. It calls the same `dialect.migrate(migrations, session, config)` that `runMigrations` uses, with no `fs`, `url` or `node:crypto` import
    - Tests in `tests/unit/embeddedMigrations.test.ts`:
      - `EMBEDDED_MIGRATIONS` deep-equals `readMigrationFiles({ migrationsFolder: 'src/migrations' })`. On failure, the message says to run `pnpm --filter core embed-migrations`;
      - a fresh PGlite migrated with `applyEmbeddedMigrations` has the same `drizzle.__drizzle_migrations` hashes and timestamps as one migrated with `runMigrations`, and the same table list;
      - applying it twice is a no-op.
    - _Requirements: 14.4, 5.10_

- [x] 2. Fault catalog, storm and materialization
  - [x] 2.1 Implement `src/poltergeist/faults.ts` and write `tests/unit/faults.test.ts`
    - Define `FAULTS`, frozen, with each fault's id, name, epitaph template and min/max deliveries, exactly as in Requirement 1.1 and the design table. Also define `FAULT_IDS`, `DefenseId`, `DEFENSE_LABELS`, `shortSubject` and `renderEpitaph`
    - Tests:
      - the catalog equals the Requirement 1.1 table, in order;
      - ids are unique and the arrays are frozen;
      - the minimum deliveries sum to 18;
      - `shortSubject('evt_9f3a01c2') === 'evt_9f…'`;
      - `{fate}` renders as `buried by inbox dedupe` and as `passed without drift`;
      - two defenses are joined with ` and ` and duplicates are dropped;
      - no rendered epitaph contains a newline.
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

  - [x] 2.2 Implement `src/poltergeist/storm.ts` and write `tests/unit/storm.test.ts`
    - `generateStorm`, `stormToJson`, `isolateUnit` and `prefixStorm`, with the `Storm`, `Unit`, `Step`, `PlannedDelivery` and `TruthEffect` types from design.md
    - Generation follows the one-pass algorithm in design.md:
      - each pick is fault weight 1 or honest weight 1;
      - the cap is `min(4, remaining)`;
      - a pick that does not fit becomes an honest unit and is never re-rolled;
      - `ensureEveryFault` emits one ghost per fault first, capping each to leave room for the faults after it.
    - Use the amount ranges and ghost shapes from the design table, and record each unit's `truth`. Unit ids are `u0001`, …; logical ids are `evt_`, `pay_` or `key_` plus `hex8`, re-drawn on a collision
    - Tests:
      - exact planned size for 1, 2, 17, 18 and 2,000;
      - `RangeError` for each bad input, including `ensureEveryFault` with size 17, with the message stating 18;
      - with fast-check over seeds and sizes:
        - every ghost is valid and self-funded (Requirement 2.6);
        - each fault's shape rule holds (Requirement 2.7);
        - every amount is a `bigint` in [1, 10^9];
        - ids are unique and well-formed;
        - every units' `deliveries` sum equals the size;
        - prefix stability holds (Requirement 2.12).
      - `ensureEveryFault` puts one ghost of each fault first, in catalog order;
      - `stormToJson` is identical across two calls and contains no JSON number for an amount;
      - `isolateUnit` and `prefixStorm` keep the seed, asset and members.
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 2.10, 2.11, 2.12, 2.13_

  - [x] 2.3 Implement `src/poltergeist/materialize.ts` and write `tests/unit/materialize.test.ts`
    - `materialize(runTag)` and `newRunTag()`, using `uuidV5` from `src/webhooks/keys.ts` with a fixed `POLTERGEIST_NAMESPACE`
    - Tests:
      - the same tag always gives the same ids, and different tags give disjoint ids;
      - payment ids, keys, member ids and the circle id are lowercase UUIDs;
      - event ids are the tag followed by the logical id, at most 255 characters;
      - `memberRef` maps every member id back, and anything else to `unknown`.
    - _Requirements: 3.8_

- [x] 3. Drift meter and report
  - [x] 3.1 Implement `src/poltergeist/drift.ts` and write `tests/unit/drift.test.ts`
    - `emptyTruth`, `addEffect`, `measureDrift`, `subtractDrift` and `isZero`, as in design.md D3, all in `bigint`
    - Tests:
      - with fast-check:
        - drift is zero on every account if and only if every reported balance equals the expected one;
        - the total equals the sum of the accounts, and also equals captured − refunded − (pot + Σ wallets);
        - `conjured − lost = −total`.
      - the double-credited member count;
      - an unknown member gives a `member:unknown` account with expected 0;
      - an asset mismatch throws;
      - account order is `pot`, `m0` to `m4`, then unknown;
      - `subtractDrift` works per account.
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7_

  - [x] 3.2 Implement `src/poltergeist/report.ts` and write `tests/unit/report.test.ts`
    - Define `PoltergeistReport` (version 1), `REPORT_SCHEMA`, `REPORT_VERSION`, `buildReport` (from the runner's internal `RunRecord`) and `serializeReport`, with the fixed key and account order from design.md
    - All eight faults are always present, in catalog order. Every amount is a decimal string
    - Tests, using a hand-built `RunRecord`:
      - key order and account order;
      - no JSON number anywhere for an amount;
      - per-fault counts add up;
      - no output contains the run tag, the secret, a UUID or an ISO time;
      - `serializeReport` is identical across two calls.

      The golden file is added in task 4.4.
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8_

- [x] 4. SUT interface, Ossuary adapter and runner
  - [x] 4.1 Implement the SUT interface and the Ossuary adapter's webhook route, `balances` and `settle` in `src/poltergeist/sut.ts`
    - Define the interface types from design.md (`SystemUnderTest`, `SutFactory`, `SutContext`, `DeliverOptions`, `DeliveryResult`, `BalanceSnapshot`, `CrashPlan`) and `ossuaryFactory({ client? })`
    - **Setup:**
      - with no client, create a fresh pglite and run `applyEmbeddedMigrations` (never `runMigrations`, D8);
      - wrap the client with `createCrashingDb`;
      - create the clearing, pot and wallet accounts;
      - create the webhook handler.
    - **`webhook` route:** pass the raw body and headers unchanged to the handler
    - **`balances()`:** one grouped `SUM` over `entries`, with the pot and wallets negated
    - **`settle()`:** run `runOutboxOnce` with `fakeSender()`, advancing the clock past leases between rounds, and throw if it has not drained after `messages + 1` rounds
    - **`close()`:** close the client only if the adapter created it
    - Tests in `tests/unit/ossuarySut.test.ts`:
      - a signed capture gives `200`, and the pot reports `+C`;
      - a refund lowers the pot;
      - `balances()` issues exactly one statement (checked with the crashing db's log);
      - `settle()` sends every outbox message and leaves balances unchanged;
      - two instances on one shared client do not see each other's balances.
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 5.1, 5.2, 5.3, 5.8, 5.9, 5.10_

  - [x] 4.2 Add the Ossuary adapter's payout route
    - `handlePayout(rawBody, headers)`, exactly as in design.md:
      1. validate the header and the body, with the amount as a decimal string converted to `bigint`;
      2. `postTransaction` a `transfer` that debits the pot and credits the member's wallet, using the header's key;
      3. map the result to a status.
    - Tests:
      - each `400` case: missing key, key not a UUID, bad JSON, wrong circle, unknown member, bad amount, amount above the `int8` maximum;
      - a successful payout moves the pot and the wallet;
      - the same key with a different body gives `409`;
      - a payout above the pot gives `422`, with nothing written;
      - three concurrent identical payouts post one transaction, and the second and third report `idempotency-key`.
    - _Requirements: 5.4, 5.5, 5.6, 3.2_

  - [x] 4.3 Add crash injection and defense reporting to the Ossuary adapter
    - **Arming:** when a crash plan is given, arm the crashing db `{ at: 'statement', index: beforeStep }`
    - **Results:**
      - a crash that fires returns `{ status: null, crashed: true, defense: 'rollback' }`;
      - a crash armed but not reached returns `{ status: null, crashed: true, defense: null }`, after disarming.
    - **Defenses:** report them per the design table. For a `401`, re-run `verifyWebhook` to tell `timestamp-check` from `signature-check`
    - Tests:
      - **D5:** for a capture, a refund and a payout, crash before each statement index in turn (calibrated with `calibrate`). For each index, check:
        - nothing is left behind;
        - the statements logged after the crash are only `ROLLBACK TO SAVEPOINT` or `ROLLBACK`;
        - a retry applies the delivery exactly once.
      - an index past the last statement leaves the delivery committed, and the retry reports `inbox-dedupe` (webhook) or `idempotency-key` (payout);
      - a stale signed request reports `timestamp-check`, and a bad signature reports `signature-check`;
      - an early refund reports `parking`.
    - _Requirements: 3.7, 5.6, 5.7_

  - [x] 4.4 Implement `summon` in `src/poltergeist/summon.ts`, add `PoltergeistRunError`, and write `tests/unit/summon.test.ts` and the golden report
    - Follow the flow in design.md:
      - materialize with a fresh run tag, and use a virtual clock at 2026-10-31T00:00:00Z with +1 s before every attempt;
      - sign webhooks with `signedDeliveryAt`, and send payouts with the `idempotency-key` header;
      - replay the exact original bytes and headers;
      - start concurrent deliveries before awaiting any;
      - retry up to 5 attempts on a crash or `5xx`, re-signing webhooks; `2xx` and `4xx` stop; replays are not retried;
      - snapshot and drift after every unit, then settle, then the final drift and the settle drift;
      - build the counterexample (isolated, or prefix via `prefixStorm`);
      - close every instance, including on error;
      - throw `PoltergeistRunError(seed, unitIndex, cause)` when `deliver` or `balances` throws or the asset differs.
    - Tests, on a scripted fake SUT and hand-built storms:
      - the retry policy, including that the re-signed timestamp moves forward;
      - replays use the original headers and are not retried;
      - all concurrent deliveries are started before the first resolves;
      - each unit's delta is attributed to it;
      - the identity of Requirement 6.4;
      - isolated and prefix counterexamples, and replaying each reproduces its drift;
      - `PoltergeistRunError` and `close()` on error;
      - the secret is never in the report.
    - Generate `tests/fixtures/report-seed7-size60-ossuary.json` from `summon` with Seed 7, size 60 and target ossuary. Add a test that compares a fresh run to it byte for byte. The test file states that a shape change must bump `REPORT_VERSION` and regenerate this file
    - _Requirements: 3.1, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 8.7_

  - [x] 4.5 Add the `@ossuary/core/poltergeist` entry point
    - `src/poltergeist/index.ts` exports:
      - `generateStorm`, `stormToJson`, `isolateUnit`, `prefixStorm`;
      - `FAULTS`, `FAULT_IDS`, `renderEpitaph`;
      - `measureDrift`;
      - `summon`, `PoltergeistRunError`;
      - `ossuaryFactory`;
      - `REPORT_VERSION`, `REPORT_SCHEMA`, `serializeReport`;
      - the public types.
    - Add `exports` to `package.json` with `"."` → `./src/index.ts` and `"./poltergeist"` → `./src/poltergeist/index.ts`
    - Extend `boundaries.test.ts` to check the subpath export resolves, and that `src/index.ts` is unchanged (`tests/unit/publicApi.test.ts` must pass unchanged)
    - _Requirements: 12.3, 8.8_

  - [x] 4.6 Prove the library entry is browser-safe
    - Write `tests/unit/browserBundle.test.ts`:
      - Bundle `src/poltergeist/index.ts` with esbuild's JS API (`bundle: true`, `write: false`, `platform: 'browser'`, `format: 'esm'`), with `@electric-sql/pglite` external.
      - A resolve plugin records every import whose path is a Node built-in (from `node:module`'s `builtinModules`, with or without `node:`), static or dynamic, along with its importer. It marks each one external.
      - Fail if anything other than `node:crypto` was recorded, listing each offender and its importer.
      - Parse the bundle's `import { … } from "node:crypto"` statements, and fail unless the names are a subset of `randomUUID`, `createHash`, `createHmac` and `timingSafeEqual`.
      - Scan `src/poltergeist/*.ts`, except `cli.ts`, and fail on `process.` or `Buffer`.
    - Extend `boundaries.test.ts`: no module imports `cli.ts`
    - **Before marking done**, confirm the test fails against each break below, then restore `src/` (`git diff --quiet -- src`):
      - add `import 'node:fs';` at the top of `src/poltergeist/storm.ts`;
      - import and call `runMigrations` in `sut.ts` instead of `applyEmbeddedMigrations`;
      - use `Buffer.from` in `rail.ts` (caught by the source scan).
    - _Requirements: 14.1, 14.2, 14.3, 14.5, 14.6_

- [x] 4.7 Checkpoint - Ensure all tests pass
  - Run `vitest --run` and `tsc --noEmit`. Ensure all tests pass, ask the user if questions arise.

- [x] 5. The Vibe Pay twin
  - [x] 5.1 Generate the twin and write `packages/twin/PRODUCED.md`
    - Use the prompt from design.md ("The Vibe Pay prompt"), verbatim, as approved in review
    - Run `kiro-cli chat --no-interactive "<prompt>"` in a fresh `mktemp -d` directory. It must have no `.kiro/`, no git history and no Ossuary files. Before running, confirm that `~/.kiro/steering` is absent and that no power is active
    - Copy the generated `src/index.ts` into `packages/twin/src/index.ts` byte for byte. Add only the scaffolding: `package.json` (`@ossuary/twin`, `type: module`, `main: ./src/index.ts`, no dependencies) and a strict `tsconfig.json`
    - If the result fails strict `tsc` or the happy-path test in task 5.2, regenerate in a new directory. Allow at most 3 attempts in total, then stop and ask the user. Never edit the generated source
    - Write `PRODUCED.md` with:
      - the prompt;
      - the agent, model, date, directory and exact command;
      - the attempt count, with the reason each rejected attempt failed;
      - the scaffolding files added;
      - a statement that `src/` was not edited;
      - the five-trait checklist, each trait with `present` or `absent` and a file:line reference;
      - the note that the prompt mentions neither signatures, idempotency keys nor transactions (design Q9).
    - Add `@ossuary/twin: workspace:*` to core's `dependencies` and run `pnpm install`
    - _Requirements: 10.1, 10.2, 10.3, 10.5, 10.6_

  - [x] 5.2 Write `tests/unit/twin.test.ts` for the twin itself
    - Test it directly, on pglite, through `createVibePay(db)`:
      - **Happy path:** deliver captures, a refund and a payout once each, in order, with no crash. The pot and the member's paid-out total must be correct, which shows it is not a strawman. *Amended during implementation:* the refund is a full refund. The prompt says "a refund takes it back out", and the generated twin reads that as a full refund (see `packages/twin/PRODUCED.md`). A partial refund in the happy path would test something the prompt never asked for. The twin's partial-refund behavior is pinned by a separate, documenting test instead.
      - **Shared database:** `init()` runs twice without error, and two circles on one database never see each other's balances. The result decides whether `twinFactory` may share a client (Requirement 11.1); record it in a comment.
    - Extend `boundaries.test.ts`: no file under `packages/twin/src` imports `@ossuary/core` or a path outside `packages/twin/`
    - `packages/twin` must pass `tsc --noEmit` under its own strict `tsconfig.json`, and core's `tsc --noEmit` must stay clean
    - _Requirements: 10.4, 10.6, 11.1_

  - [x] 5.3 Implement `twinFactory` in `src/poltergeist/twinSut.ts` and write `tests/unit/twinSut.test.ts`
    - **Setup:**
      - use a fresh pglite per instance, or share the supplied client only if task 5.2 showed that is safe;
      - give the twin a guarded `query` handle;
      - call `init()`.
    - **`deliver`:**
      - build a Web `Request` and route it to `handleWebhook` or `handlePayout`;
      - apply the crash model from D5: fail before statement k and every later statement of the delivery, or crash after the response when the delivery finished in k steps or fewer;
      - always report `defense: null`.
    - **`balances`:** call `getBalances(circleId)` and convert each value per Requirement 11.4 (exact for integral values, truncation toward zero plus a `fractional` entry otherwise)
    - **`settle`:** a no-op
    - Tests:
      - process death: after the crash, no later statement of that delivery runs, and earlier statements stay committed;
      - an after-response crash;
      - integral conversion is exact;
      - a forced non-integral value is truncated and listed under `fractional`;
      - `defense` is always null;
      - a tiny `summon` run against the twin completes and returns a report.
    - Export `twinFactory` from `src/poltergeist/index.ts`
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 4.1, 4.2, 4.3_

- [x] 6. Command-line interface
  - [x] 6.1 Implement `src/poltergeist/cli.ts`, the package scripts and `tests/unit/cli.test.ts`
    - Export `main(argv, io)` with injectable stdout, stderr and exit, plus a thin bin wrapper. All `process` use stays in this file (D8), and the browser bundle test must still pass
    - Parse with `parseArgs({ strict: true, tokens: true })`: `--seed` (default 7), `--events` (default 2000), `--target ossuary|twin` (default ossuary) and `--json`. An unknown, repeated or out-of-range argument prints usage to stderr and exits 2
    - Run `generateStorm` and `summon` with `ossuaryFactory()` or `twinFactory()`, each with its own in-memory pglite
    - **Output:**
      - with `--json`: exactly `serializeReport(report) + '\n'` on stdout;
      - without it: the human summary from design.md, with exact 6-decimal amounts and the asset code, and the run time on stderr only.

      Exit 0 when the run completes, whether or not there was drift, and 1 when it throws.
    - Scripts:
      - add `tsx` to core's `devDependencies`;
      - core: `"poltergeist": "tsx src/poltergeist/cli.ts"`;
      - root: `"poltergeist": "pnpm --filter @ossuary/core poltergeist"`.
    - Tests, running `main` in-process:
      - `--json` output parses, and equals `serializeReport` of a direct `summon` with the same seed, events and target (small sizes, both targets);
      - each usage error exits 2 and writes nothing to stdout;
      - the defaults are 7, 2000 and ossuary, checked from the parsed options without running 2,000 events;
      - stdout in `--json` mode contains no human text.
    - Run `pnpm poltergeist --seed 7 --events 2000 --target ossuary --json` once from the repository root and confirm it exits 0 with zero drift. Run it again with `--target twin` and confirm it exits 0 with non-zero drift. Record both wall times in the task notes
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6_
    - *Notes (run on 2026-11-21):*
      - **ossuary:** exit 0, drift `0`, 728 blocked ghosts, 0 drifted. 2,103 attempts (103 crash retries). 6.1 s wall time (5.5 s in the run).
      - **twin:** exit 0, drift `55504318662`, 526 drifted ghosts, 5 double-credited members. 1.95 s wall time.
      - The root script uses `pnpm --silent`, so stdout carries only the report JSON.

- [x] 7. Checkpoint - Ensure all tests pass
  - Run `vitest --run` and `tsc --noEmit`. Ensure all tests pass, ask the user if questions arise.

- [x] 8. Property-based tests (required)
  - [x] 8.1 Create `tests/helpers/poltergeist.ts`
    - It holds:
      - `POLTERGEIST_RUNS`, with each value at least 25;
      - `seedArb`, an integer from 0 to 4294967295;
      - the size arbitraries for each property (design.md);
      - `sharedOssuary(propertyDb)` and `sharedOrFreshTwin()`, the factories.
    - It reuses `createPropertyDb` and `runConfig` from `tests/helpers/arbitraries.ts`
    - Add a check to an existing helper test, or a new `tests/unit/poltergeistHelpers.test.ts`, that every `POLTERGEIST_RUNS` value is at least 25
    - _Requirements: 13.1, 13.6_

  - [x] 8.2 Write the property test for Property 1 in `tests/property/stormDeterminism.property.ts`
    - **Property 1: The same seed gives the same storm and the same report**
    - **Generate** a seed, a size from 1 to 100, and a target (`ossuary` or `twin`)
    - **Assert:**
      - two `generateStorm` calls give deep-equal storms with identical `stormToJson`;
      - two `summon` runs with different run tags give byte-identical `serializeReport`.
    - At least 25 runs
    - **Before marking done**, confirm it fails against each break below, then restore `src/` (`git diff --quiet -- src`):
      - draw the replay age from `Math.random`;
      - add `generatedAt: new Date().toISOString()` to the report;
      - order member accounts by concrete member id instead of `Member_Ref`.
    - Tag: `// Feature: poltergeist-engine, Property 1`
    - **Validates: Requirements 2.1, 2.2, 3.8, 8.7, 13.2, 13.7**

  - [x] 8.3 Write the property test for Property 2 in `tests/property/ossuaryZeroDrift.property.ts`
    - **Property 2: Ossuary never drifts**
    - **Generate** a seed and a size, weighted 60% from 1–60, 30% from 61–300 and 10% from 301–2,000, with `examples: [[7, 2000]]`. Use one shared migrated database
    - **Assert:**
      - total drift and every account drift are `"0"`;
      - conjured, lost, honest drift and settle drift are `"0"`;
      - `doubleCreditedMembers` is 0;
      - `drifted` is empty and `counterexample` is null;
      - the global entry sum is 0.
    - At least 25 runs, plus the example
    - **Before marking done**, confirm it fails against each break below, then restore `src/`:
      - skip applying parked refunds when their capture arrives. This replaces "drop the inbox dedupe", which was tried and is not detected because three other defenses still stop duplicates (design, mutation checks);
      - record refunds of uncaptured payments as `rejected` instead of `parked`;
      - mint a fresh idempotency key per payout request in the Ossuary adapter;
      - catch every error in `applyRefund`'s savepoint, not only `RefundCapExceededError`.
    - Tag: `// Feature: poltergeist-engine, Property 2`
    - **Validates: Requirements 13.3, 5.2–5.9, 6.2, 7.2, 7.7, 13.7**

  - [x] 8.4 Write the property test for Property 3 in `tests/property/twinDrifts.property.ts`
    - **Property 3: The twin visibly loses money, and the report names the fault**
    - **Generate** a seed and a size from 18 to 200, with `ensureEveryFault`
    - **Assert:**
      - at least one account has non-zero drift, and `drifted` is non-empty;
      - each drifted ghost's `faultId` is in `FAULT_IDS` and equals its storm unit's;
      - per account, the sum of the drifted deltas, the honest drift and the settle drift equals the final drift;
      - the counterexample is non-null, its `faultId` is in `FAULT_IDS` or `null`, and re-running it on a fresh twin (`isolateUnit` or `prefixStorm`) reproduces its drift.
    - At least 25 runs
    - **Before marking done**, confirm it fails against each break below, then restore `src/`:
      - compute "expected" from the snapshot in `measureDrift`;
      - measure deltas against the run's start instead of the previous unit;
      - record the main run's final drift in an `isolated` counterexample.
    - If the property fails on the unbroken code because the twin does not drift, stop and ask the user (design Q9). Do not edit the twin
    - Tag: `// Feature: poltergeist-engine, Property 3`
    - **Validates: Requirements 13.4, 6.3, 6.4, 6.5, 8.4, 13.7**

  - [x] 8.5 Write the property test for Property 4 in `tests/property/blockedGhosts.property.ts`
    - **Property 4: Every blocked ghost maps to a fault in the catalog**
    - **Generate** a seed, a size from 1 to 150, and a target
    - **Assert:**
      - every `blocked` entry's `faultId` is in `FAULT_IDS` and equals the storm ghost's with the same `ghostId`;
      - its epitaph equals `renderEpitaph` for that fault and subject, with a `{fate}` consistent with the target (the twin never `buried by`);
      - no honest unit appears in `blocked`;
      - `blocked` and `drifted` partition the storm's ghosts;
      - each fault's `blocked + drifted = ghosts`.
    - At least 25 runs
    - **Before marking done**, confirm it fails against each break below, then restore `src/`:
      - list honest units in `blocked` with `faultId: 'honest'`;
      - fill `faultId` from the fault's `name`;
      - put every ghost in `blocked`.
    - Tag: `// Feature: poltergeist-engine, Property 4`
    - **Validates: Requirements 13.5, 1.3, 1.4, 6.3, 8.4, 13.7**

- [x] 9. Final checkpoint - Ensure all tests pass
  - Run the full `vitest --run` three times, recording each wall time, and run `tsc --noEmit` in `packages/core` and `packages/twin`
  - *Result (2026-11-21):* 52 files and 348 tests passed on all three runs, in 56.6 s, 72.6 s and 69.3 s. `tsc --noEmit` is clean in both packages.
  - Every run must pass and finish in under 120 seconds. If a run comes close (over about 90 s), reduce per-case sizes, keeping the 2,000-event example in Property 2 and at least 25 runs per property, and ask the user if questions arise
  - Update the README's correctness-properties table with the four new property files

## Notes

- Every task, including the property tests, is required. None are marked optional.
- Each property task is one test with one property number, tagged to the design. It cannot be marked done until it has been shown to fail against every break listed for it. Afterwards, `git diff --quiet -- src packages/twin/src` must hold.
- **The twin is generated, not written.** Its source under `packages/twin/src/` is never edited by hand, including to make a property pass. All adaptation happens in `src/poltergeist/twinSut.ts`.
- **Existing behavior is unchanged.** The only changes to existing files outside `src/poltergeist/` are:
  - the helper re-exports in `tests/helpers/` (task 1.1);
  - `package.json` dependencies, `exports` and scripts (tasks 1.1, 4.5, 5.1, 6.1);
  - the README table (task 9).

  Existing test files must not change.
- **Concurrency on pglite.** pglite serializes transactions, so Ossuary's double-tap and race ghosts exercise its idempotency and normal-balance logic, not real row-lock contention (design Q13).
- This workflow only produces planning artifacts. Begin implementation by opening this file and clicking "Start task" on a task.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3", "2.1", "2.3"] },
    { "id": 1, "tasks": ["2.2", "4.1", "5.1"] },
    { "id": 2, "tasks": ["3.1", "4.2", "5.2"] },
    { "id": 3, "tasks": ["3.2", "4.3"] },
    { "id": 4, "tasks": ["4.4"] },
    { "id": 5, "tasks": ["4.5", "5.3"] },
    { "id": 6, "tasks": ["4.6", "6.1", "8.1"] },
    { "id": 7, "tasks": ["8.2", "8.3", "8.4", "8.5"] }
  ]
}
```
