---
name: poltergeist-test
description: Write fast-check property tests that attack money code with duplicates, replays, reordering, double-taps and crashes, prove each one by breaking the code, and run the poltergeist drift meter. Use after any change to ledger, refund, payout or webhook code.
---
# Poltergeist tests

Every money property in Ossuary is a fast-check test on in-process Postgres (pglite), so no database or network is needed. Existing examples are in `packages/core/tests/property/`.

## 1. Pick the property

Assert one of these for any generated sequence of operations:

1. The sum of all ledger entries is 0 (`globalEntrySum(db) === 0n`).
2. Replaying an operation with the same idempotency key changes nothing (compare `tableCounts(db)` and balances before and after).
3. Delivering webhooks twice or out of order gives the same balances as one in-order delivery.
4. Total refunded never exceeds total captured, per payment.
5. A crash between any two statements leaves the ledger fully before or fully after the operation.

## 2. Use the helpers in `packages/core/tests/helpers/`

- `arbitraries.ts`: `createPropertyDb()` (one migrated pglite per file, in `beforeAll`), `seedAccounts`, `validTransactionArb`, `captureTransactionArb`, `refundArb`, `globalEntrySum`, `tableCounts`, and `runConfig(numRuns)`, which adds a time limit that counts as a failure.
- `crash.ts`: `createCrashingDb(client)` crashes before statement N, before commit or after commit; `calibrate` first checks the exact statement list so crash points mean what they say.
- `webhooks.ts`: `validRailHistoryArb`, `deliveryOrderArb`, `materialize` and `signedDelivery` for signed, replayed and reordered webhook deliveries.
- `clock.ts`: `fakeClock` for timestamps and backoff.
- `poltergeist.ts`: `seedArb`, `targetArb` and `createPoltergeistDbs` for storm-level properties.

Use at least 25 runs (`fc.assert(property, runConfig(25))`) unless one run is itself a long sequence, and say why in a comment. Put the property name and the requirements it validates in the first two lines, like the existing files.

## 3. Prove the test can fail

Before you accept a property, break the code it protects on purpose and watch it fail. Examples: drop `ON CONFLICT DO NOTHING`, mint a fresh idempotency key per request, skip the refund cap, move a write outside the transaction. Record each break and its counterexample in a comment at the top of the test file, then revert the break and confirm `git diff` is empty for the source file.

## 4. Run the poltergeist

Call `ossuary_run_poltergeist` to throw a seeded storm at the skeleton and at the Vibe Pay twin:

```json
{ "seed": 7, "events": 300, "target": "ossuary" }
```

Ossuary must report `summary.driftTotal` `"0"` and `summary.drifted` `false`. The twin is expected to drift, and `summary.driftedFaults` names the faults. Without the MCP server, run the CLI instead:

```bash
pnpm --filter core poltergeist --seed 7 --events 300 --target ossuary --json
```

The same seed always gives the same storm and the same report, so a failing seed can be replayed exactly. Finish with `pnpm --filter core test`.
