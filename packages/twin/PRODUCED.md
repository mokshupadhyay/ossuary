# How the Vibe Pay twin was produced

`src/index.ts` is the unedited output of one headless coding-agent run, given only the prompt below. Nothing in `src/` has been changed by hand. See `.kiro/specs/poltergeist-engine/` (Requirement 10, design "The Vibe Pay prompt", Q9) for the procedure.

## The prompt (verbatim)

> Write the payments backend for Vibe Pay, a savings-circle app, as one strict TypeScript module (`src/index.ts`, no framework, no dependencies). Export `createVibePay(db)`, where `db` is a node-postgres-style client with `query(text, params)` returning `{ rows }`, and return `{ init, handleWebhook, handlePayout, getBalances }`; `init()` creates the tables. Our payment provider POSTs JSON webhooks to `handleWebhook(req: Request): Promise<Response>` with `{ id, type, paymentId, circleId, memberId, amount, asset }`, where `type` is `payment.pending`, `payment.captured` or `payment.refunded` and `amount` is a string in USDC base units (6 decimals): a captured payment adds its amount to the circle's pot, and a refund takes it back out. The organiser pays the pot to a member through `handlePayout(req: Request): Promise<Response>` with `{ circleId, memberId, amount }`: subtract the amount from the pot, answering 400 if the pot is too small, and add it to that member's paid-out total. `getBalances(circleId)` returns `{ pot, members }`, where `members` maps each member id to their paid-out total, as numbers in base units. Keep it simple and readable.

The prompt describes the feature only. It names the harness seam (`createVibePay(db)`, Web `Request`/`Response`), so no hand edits were needed. It says nothing about signatures, idempotency keys or transactions, in either direction.

## The run

| | |
|---|---|
| Agent | Kiro CLI 3.3.0 (`kiro-cli chat`), headless |
| Model | `auto`, the CLI default ("models chosen by task"). The CLI does not report which model served the run. |
| Date | 2026-11-21T16:15:42Z |
| Directory | `/tmp/vibe-pay.OIpOSI`, fresh from `mktemp -d`: empty, no `.kiro/`, no git history, no Ossuary files. There was no `~/.kiro/steering` and no power was active. |
| Command | `kiro-cli chat --no-interactive --trust-tools=fs_read,fs_write '<the prompt above>'` |
| Attempts | 1. The first attempt compiled under strict TypeScript and passed the happy-path test, so it was kept. |
| SHA-256 of `src/index.ts` | `92ed1251d146581e31a2aa3c5e3dda5bf085379dc239a291e2eedc82cce8af0f` |

The agent's own closing summary listed these limitations, in its words:

- no webhook signature check;
- payouts are not idempotent ("a retried payout request pays twice");
- `getBalances` returns JS numbers, which lose precision above 2^53.

## Files added after generation (scaffolding only)

- `package.json`: the workspace package `@ossuary/twin`, with no runtime dependencies.
- `tsconfig.json`: strict TypeScript, with the `DOM` lib for `Request` and `Response`.
- `PRODUCED.md`: this file.

`src/index.ts` is byte-identical to the agent's output (the SHA-256 above).

## The five naive traits

The spec expected a twin with all five. The agent produced something more defensive than that, and that is recorded here rather than edited.

| Trait | In the generated code? | Where |
|---|---|---|
| Float amounts | **Partly.** Amounts are stored as Postgres `numeric` and passed as strings, so the database math is exact. `getBalances` converts to JS `number`. | `index.ts:73`, `:78` (`numeric`); `:180–181` (`Number(...)`) |
| Mutable balance columns | **Present.** `circles.pot` and `members.paid_out` are updated in place. No ledger is kept. | `index.ts:73`, `:78`; updates at `:117`, `:162`, `:168` |
| No idempotency key handling | **Present for payouts.** `handlePayout` ignores the `idempotency-key` header, so a retried or double-tapped payout pays again. Webhooks are deduplicated by the payment's status, not by event id. | `index.ts:154–172`; status dedupe at `:97`, `:114` |
| No signature check | **Present.** `handleWebhook` never reads the request headers. | `index.ts:127–152` |
| No transaction around the writes | **Absent in effect.** There is no `BEGIN`, but every state change is one SQL statement built from CTEs, so each one is atomic. | `index.ts:1–3`, `:93–106`, `:112–120`, `:158–170` |

## Behaviors that matter when reading the twin's drift

These are facts about the generated code, observed in `tests/unit/twin.test.ts` in `packages/core`. They are not hand changes.

- **A refund removes the whole captured amount, whatever the webhook's `amount` says** (`index.ts:110–120`). The agent read "a refund takes it back out" as a full refund. The poltergeist's storm sends partial refunds, which every real rail supports, so any ghost containing a partial refund over-refunds on the twin. In the report, that drift is attributed to the ghost it happened in. The ghost's fault (for example "Late delivery after a refund") is then the setting, not the mechanism. The counterexample's deliveries show the mechanism.
- **A refund for a payment that is not captured yet gets `409`** (`index.ts:145–147`), which leaves the retry to the provider. The poltergeist's rail treats a `4xx` as final and retries only crashes and `5xx`, up to 5 times, 1 second apart. So a refund that arrives before its capture is lost on the twin, where a rail that retries hours later would eventually land it. Ossuary parks such a refund instead (`webhooks-outbox` Requirement 5.6).
- **`payment.pending` without an `amount` gets `400`** (`index.ts:58`). The rail sends `pending` without an amount, as Ossuary's format specifies. No money moves on `pending`, so this has no effect on drift.
- **Concurrent requests do not lose updates.** The writes are single statements, so a refund racing a payout cannot lose an update. A refund of money that was already paid out hits `CHECK (pot >= 0)` and gets `409`.
