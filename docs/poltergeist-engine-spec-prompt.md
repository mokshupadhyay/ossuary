# poltergeist-engine spec prompt

Create a new spec named `poltergeist-engine` for `packages/core`, building on the finished `ledger-core` and
`webhooks-outbox` specs (postTransaction, refund, createWebhookHandler, runOutboxOnce, pglite tests, fast-check).

Follow `.kiro/steering/*.md` (money, ledger, idempotency, webhooks). Read both finished specs first and reuse their
helpers in `tests/helpers/` (crash.ts, clock.ts, sender.ts, webhooks.ts, arbitraries.ts) instead of duplicating them.

## What it is
The poltergeist is a fault injector with a visible result. It takes a **system under test** (anything that can accept
payment webhooks and report balances), throws a seeded storm of "haunted events" at it, and reports how much money
drifted. It is the heart of the demo: the same storm is run against Ossuary and against a naive "Vibe Pay" twin, and
the two drift meters are shown side by side.

## Scope
1. **Fault catalog** (`src/poltergeist/faults.ts`): duplicate delivery, replayed old timestamp, out-of-order events,
   refund before capture, concurrent double-taps on the same idempotency key, a crash between any two steps,
   a refund racing a payout, and late delivery after a refund. Each fault has a stable id, a human name, and a one-line
   "epitaph" used when the fault is blocked (for example "evt_9f… replayed webhook, buried by idempotency key").
2. **Seeded storm** (`src/poltergeist/storm.ts`): a deterministic generator. The same seed always produces the same
   storm, so a failure can be replayed. Size is configurable (default 2,000 events). Amounts are bigint minor units.
3. **System-under-test adapter** (`src/poltergeist/sut.ts`): a small interface (`deliver(rawBody, headers)`,
   `balances()`, `settle()`), with an Ossuary adapter. The twin adapter comes in task group 5.
4. **Drift meter** (`src/poltergeist/drift.ts`): computes "money in minus money out minus money held" per account and
   in total, in bigint. Zero means no drift. Also counts double-credited members and conjured money.
5. **Report** (`src/poltergeist/report.ts`): a JSON report with seed, event counts per fault, drift, the list of blocked
   ghosts with epitaphs, and the shrunk counterexample when a property fails. Stable schema, versioned, so the apps'
   UI and the video can read it.
6. **CLI** (`src/poltergeist/cli.ts`): `pnpm poltergeist --seed 7 --events 2000 --target ossuary|twin --json`.
7. **The Vibe Pay twin** (`packages/twin/`): a deliberately naive implementation of the same payment feature that a
   coding agent would write from a one-paragraph prompt with no Ossuary: float amounts, a mutable balance column,
   no idempotency key, no signature check, no transaction around the writes. It must be real, runnable code (not a
   strawman with an obvious bug), and committed with a note on how it was produced.

## Required property tests (fast-check, on pglite)
- The same seed always produces the same storm and the same report.
- Against the Ossuary adapter, drift is always exactly zero for any seed, any storm size up to 2,000.
- Against the twin adapter, drift is non-zero for at least one fault in the catalog (the demo only works if the twin
  visibly loses money), and the report names which fault caused it.
- Every blocked ghost in the report maps to a fault id in the catalog.

Each property must be mutation-checkable. Use at least 25 runs per property in the default run and keep the whole
suite under 120 seconds. Show each property failing against a deliberate break before ticking its task.

## Process
Generate requirements first, then design, then tasks. Do not stop between them: where something is ambiguous, pick
the simplest option, record it under "Open questions" at the end of design.md, and continue. Stop before
implementation and wait for review. Do not start implementation.
