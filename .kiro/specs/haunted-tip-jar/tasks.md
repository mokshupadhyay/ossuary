# Implementation Plan: haunted-tip-jar

## Overview

Build `apps/haunted-tip-jar` as laid out in design.md, bottom-up: browser runtime and money, then the rail and the jar service, the read model and the coffin, the outbox-fed overlay bus, the UI, the poltergeist panel, and finally the end-to-end test and delivery.

Conventions for every task:

- **Scope.** Only `apps/haunted-tip-jar/**` and `.kiro/specs/haunted-tip-jar/**` change. Core, the twin, the Tontine and the power are read-only.
- **Money.** `bigint` minor units of USDC everywhere; amounts in SQL are summed as `numeric`/`bigint` and read as text. No floats, no rounding.
- **Definition of done.** The task's tests pass, `pnpm --filter haunted-tip-jar test` passes, `pnpm --filter haunted-tip-jar typecheck` is clean and `pnpm --filter haunted-tip-jar build` succeeds.
- **Properties.** A property task is ticked only after the property has been seen failing against its deliberate break, and the break reverted. The break and the result are written under the task.
- **Power.** After each task that touches money code, apply the `money-code-review` skill to the changed files and record the findings under the task.

## Tasks

- [x] 1. Browser runtime, project setup and money
  - [x] 1.1 Project setup: `tsconfig.json`, `vite.config.ts` (D2 aliases), `vitest.config.ts`, `index.html`, `src/polyfills.ts`, shims, and a minimal `main.tsx`; check whether `power/mcp/dist/server.js` exists and record it in design.md
    - _Requirements: 10.1, 10.4_
    - Done: smoke test (core migrates and reads a balance from the app) passes; typecheck clean; build passes. `power/mcp/dist/server.js` absent, recorded in design.md.
    - Note: the root `.gitignore` ignores `dist/`, so the deploy-ready `dist/` is a build output, not a committed folder.
  - [x] 1.2 `src/money.ts` (`parseUsdc`, `formatUsdc`, `formatUsdcShort`, `goalPerMille`) with unit tests
    - _Requirements: 2.2, 6.1_
    - Done: 6 unit tests pass. `money-code-review`: clean (the one `Number()` converts the clamped per-mille, not an amount).
  - [x] 1.3 Property 3 (`tests/property/money.property.ts`), shown failing against `Number(text) * 1e6`
    - _Requirements: 9.3, 9.5_
    - Done: 2 properties × 200 runs, pass in < 0.1 s.
    - Mutation A, `BigInt(Math.trunc(Number(s) * 1e6))`: **fails**, counterexample `503709n` parsed back as `503708n`.
    - Mutation B, `BigInt(Math.round(Number(s) * 1e6))`: **survives** 200 runs. Not a test gap we can close with this property: for inputs with at most 6 decimals and at most 10¹² units (below 2⁵³), rounding exactly undoes the float error. The float ban is enforced instead by the source scan in 7.1 (no `Number(`, `parseFloat`, `toFixed` or `Math.` on money paths).
  - [x] 1.4 Property 4 (`tests/property/cryptoShim.property.ts`), shown failing against an HMAC that drops its key
    - _Requirements: 9.4, 9.5_
    - Done: 3 properties × 100 runs plus `tests/unit/verifyOnShim.test.ts`, which `vi.mock`s `node:crypto` with the shim and runs core's own `signWebhook`/`verifyWebhook` on it (a pinned vector from real Node, round-trip, tampered body rejected).
    - Mutation, `createHmac` hashes only the message: **fails**, counterexample `[Uint8Array.from([0]), [], false]`; the pinned-vector test also fails.

- [x] 2. Database, rail and jar service
  - [x] 2.1 `src/db.ts`: open PGlite (memory or `idb://`), drizzle, `applyEmbeddedMigrations`, the four app tables
    - _Requirements: 1.1, 1.5_
    - Done: `tests/unit/db.test.ts` (tables exist, migrate is idempotent, no app column named like a balance/total/amount). 19 tests pass, typecheck clean, build passes.
  - [x] 2.2 `src/rail.ts`: Rail_Request claim with `409` on a changed request, event bodies and ids, signing with core's `signWebhook`, delivery with retries, the delivery log, Haunted_Rail, stale replay; unit tests
    - _Requirements: 2.3, 2.4, 2.5, 3.1, 3.3, 4.1, 4.2, 4.3_
    - Done: `tests/unit/rail.test.ts`, 12 tests: concurrent double-tap gives one tip; changed request → 409; cross-jar key → 409; boundary validation; refund then over-cap chargeback → `rejected`; unknown tip → 400; haunted run (7 deliveries, all extra ones `duplicate`); 5xx retried 3 times with 3 different signatures; stale replay → 401. 31 tests pass, typecheck clean, build passes.
    - Added a `seq` identity to `tipjar_rail_requests` so `events()` has a stable order.
    - `money-code-review`: clean on all 6 checks. What the skill changed: check 3 ("claim the key and write in one DB transaction with ON CONFLICT DO NOTHING") is why the tip row is inserted inside the claim transaction, so a crash can't leave a claimed key with no tip.
  - [x] 2.3 `src/jar.ts` and `src/seed.ts`: `openJar`, create, archive and reseed, `sendTip`, `reverse`; unit tests including the seed's rejected over-cap reversal
    - _Requirements: 1.2, 1.3, 2.4, 3.2, 3.4_
    - Done: `tests/unit/jar.test.ts`, 5 tests: open is idempotent; the seed leaves 31.25 USDC held and in clearing, with reasons `refund:applied, chargeback:applied, refund:applied, chargeback:rejected`; reset archives without touching entries and leaves one active jar; an unseeded jar starts at 0; two jars on one database are isolated. 36 tests pass, typecheck clean, build passes.
    - `money-code-review`: clean. The seed has no shortcut into the ledger: every demo tip and reversal is a signed webhook through the rail. The only `UPDATE` is `tipjar_jars.archived_at`.

- [x] 3. Read model and the coffin
  - [x] 3.1 `src/readModel.ts`: `tips()`, `coffin()`, `deliveries()`; unit tests on hand-built histories
    - _Requirements: 3.6, 6.1, 6.2, 6.3, 6.4_
    - Done: `tests/unit/readModel.test.ts`, 8 tests: seeded jar per-tip rows and coffin (in 41.75, out 10.5 = 7.5 refunds + 3 chargebacks, held 31.25, residual 0); empty jar; pending-only tip counts nothing; refund before capture is parked then applied; defense counts (5 duplicates, 1 stale) from a haunted run; delivery log newest first; a capture posted to the ledger with no inbox event makes the coffin fail `residual` and `clearing` by name. 44 tests pass, typecheck clean, build passes.
    - `money-code-review`: clean. Every sum runs in SQL and is read as text then `BigInt`; `Number()` is used only for counts and HTTP status. What the skill changed: check 2 ("balances derived, never stored") is why Held is read from `entries` and not from the inbox, which is what lets the last test catch a ledger/inbox disagreement.
  - [x] 3.2 Property 1 (`tests/property/deliveryOrder.property.ts`), shown failing against its two planned breaks
    - _Requirements: 4.4, 9.1, 9.5_
    - Done: 30 runs, about 2 s. 1–4 tips, each with 0–3 reversals that fit; every event delivered 1–3 times in a shuffled order, through the real rail bodies, signing and core handler. The shuffled jar is compared with an in-order reference jar, and both with a model.
    - Mutation A1, the rail mints a fresh reversal event id on every attempt: **fails** after 7 runs, counterexample `{history:[{amount:2n,reversals:[{amount:1n,reason:"refund"}]},{amount:1n}], schedule:[4,2,0,2,1,3]}` (the delivered-twice refund is applied twice).
    - Mutation C, reversal event ids derived from the payment and reason instead of the request key: **fails** after 1 run, because the second chargeback on a tip comes back `duplicate` and is lost.
    - Planned mutation A2, a fresh *capture* event id per attempt: **survives**. Core's handler already rejects a second capture on a payment (`rejected: duplicate capture`), so the jar does not drift. This is a core defense, not a gap in the test.
    - Planned mutation B, refunds summed without `status = 'applied'`: **survives**. In Property 1's domain every reversal fits, so every refund event is applied and the filter changes nothing. B moved to Property 2, where over-cap reversals exist.
    - Planned breaks were replaced by A1 and C; this is the deviation from design.md's plan.
  - [x] 3.3 Property 2 (`tests/property/reversalCap.property.ts`), shown failing against its two planned breaks
    - _Requirements: 9.2, 9.5_
    - Done: 25 runs of 1–40 operations, about 1.5 s. Operations: tip, double-tap (same key, same request), key reuse with a changed amount, refund or chargeback of 0.1 %–200 % of a tip's capture, redelivery of any earlier event, stale replay of any earlier event. After every operation it checks: each tip's reversals ≤ its capture, residual 0, ledger sum 0, clearing = in − out, held and total out equal to the model (which accepts a reversal only if it fits), and the tip count.
    - Mutation B, refunds summed without `status = 'applied'` (moved here from 3.2): **fails** after 4 runs, counterexample `[tip 1n, refund 1n, refund 1n, redeliver 0]`, "step 2 (reverse): tip reversed beyond its capture: expected 2 to be ≤ 1".
    - Mutation D, the rail runs a changed request under a used key as a new tip instead of answering 409: **fails** after 13 runs, counterexample `[tip 1n, reuse-key +1n]`.
    - 46 tests pass, typecheck clean, build passes.
    - `poltergeist-test` skill: its checks 1 (entries sum to 0), 2 (same key changes nothing), 3 (duplicates and reordering) and 4 (refunds ≤ captured per payment) are all covered by P1 and P2. Check 5 (crash between steps) is core's: the jar has no multi-step write of its own except the rail's claim + tip insert, which is one transaction.

- [x] 4. Overlay bus
  - [x] 4.1 `src/overlayBus.ts`: outbox drain with `runOutboxOnce` and a bus sender; receiver with key dedupe; unit tests including an at-least-once resend
    - _Requirements: 5.2, 5.3, 5.4_
    - Done: `tests/unit/overlayBus.test.ts`, 11 tests: one message per applied event (also under a haunted rail); a failed send is retried by core with the same key and the store shows one ghost; other jars' messages are acknowledged but not published; the seed publishes 5 captures and 3 refunds (the rejected one sends nothing); partial vs full reversal; a stale remaining never un-fades a ghost; malformed channel messages are dropped; a new jar id starts a new feed; a real `BroadcastChannel` round-trip. 57 tests pass, typecheck clean, build passes.
    - Found while verifying: core's outbox sends messages in order of `next_attempt_at`, then by a random id, so two messages from the same millisecond can arrive in either order (the haunted test failed 1 run in 4). The overlay doesn't depend on order: every message carries the tip's remaining amount at send time, and remaining only ever goes down in the store. The test now compares sorted topics, and a store test covers a refund that arrives before its capture.
    - `money-code-review` check 5 ("side effects via the outbox") is why the ghost comes from the outbox and not from the Send click.

- [x] 5. UI
  - [x] 5.1 App shell, hash routes, Web Lock (D8), styles with focus, reduced motion and 360 px layout
    - _Requirements: 1.4, 8.1, 8.3, 8.4_
    - Done: `src/boot.ts` (Web Lock `haunted-tip-jar-db`, `idb://haunted-tip-jar`), `src/ui/App.tsx`, `routes.ts`, `Announcer.tsx`, `styles.css`. Checked in headless Chromium against the built `dist/` at 360 × 800 with reduced motion: boots in about 2 s with 5 seeded tips; `scrollWidth` 360 = viewport (no horizontal scroll); ghost `animation-name: none`; a second tab shows "The jar is open in another tab"; after a reload the jar persists (5 tips, not reseeded); no console errors.
    - Test-only fix: under jsdom, core's `db/migrate.ts` gets a non-`file:` `import.meta.url` and Node's `fileURLToPath` throws when the module loads. `tests/setup.ts` partially mocks `node:url` so non-file URLs return their pathname, the same as the browser stub. Core is unchanged.
  - [x] 5.2 Jar view: goal bar, tip form with key reuse, ghost feed, tip rows with Refund and Chargeback, rail console, delivery log, overlay preview, Reset; component tests
    - _Requirements: 2.1–2.6, 3.1–3.6, 4.1, 4.3, 5.5, 8.2, 8.5, 10.2_
    - Done: `tests/components/jarView.test.tsx`, 4 tests: two submits before either resolves → one tip, goal "2.5 of 100 USDC", announcement, one preview ghost; a 7-decimal amount is refused before the rail; refund 4 → "Partly reversed", a full chargeback → "Rejected: more than this tip received" and "1 reversal rejected by the refund cap", held 6, then refunding the rest → "Reversed" and the preview ghost fades with the text "refunded"; the haunted switch logs 7 deliveries (5 "duplicate, ignored") and a stale replay shows "401 refused".
  - [x] 5.3 Overlay page; component tests
    - _Requirements: 5.1, 5.3, 5.4, 10.2_
    - Done (`tests/components/pages.test.tsx`): the `overlay-mode` class makes the page transparent; no buttons; three sends of one key → one ghost; a full chargeback fades it with the text "charged back". The overlay route never calls `boot`.
  - [x] 5.4 Coffin view; component tests
    - _Requirements: 6.1–6.4, 8.5, 10.2_
    - Done: seeded jar → "The coffin balances", residual 0.000000, rows 41.750000 / 7.500000 / 3.000000 / 31.250000, 4 checks pass, announced in the live region. A capture posted straight to the ledger → "does not balance: In − out − held = 0; Rail clearing = in − out", residual -1.000000. App shell: one boot across jar → coffin routes, `aria-current` follows the route. 66 tests pass in about 7 s, typecheck clean, build passes.

- [x] 6. Summon the Poltergeist
  - [x] 6.1 `src/poltergeist.ts` and the panel with two drift meters, per-fault table, blocked-ghost feed, counterexample; component test on a small storm
    - _Requirements: 7.1–7.4, 10.2_
    - Done: `src/poltergeist.ts` (`runDuel`, `checkSeed`, `checkSize`), `src/ui/PoltergeistPanel.tsx`, lazy-loaded from `main.tsx` (its own 6 kB chunk). `tests/components/poltergeist.test.tsx`, 2 tests: a 30-event storm shows Ossuary `0.000000` and the twin non-zero with its fault named, epitaphs "buried by …", 8 fault rows, a live-region announcement, and the button disabled while it runs; seed and size validation. 68 tests pass, typecheck clean, build passes.
    - Built app in Chromium, seed 7, 200 events: both storms finish in 2.8 s; Ossuary drift 0.000000 with 73 ghosts blocked and 0 drifted; Vibe Pay drift 5871.276351 (conjured 2781.470452, lost 8652.746803), 50 ghosts drifted, first drift `u0001` duplicate-delivery; no page errors.
    - Without the MCP server, `summon_poltergeist` was replaced by calling the engine's `summon` directly, here and in a timing probe (Node: 200 events take about 0.9 s per side).

- [x] 7. End-to-end and delivery
  - [x] 7.1 Import-boundary test (public entries only, no copied core code)
    - _Requirements: 10.4_
    - Done: `tests/unit/imports.test.ts`, 6 tests: only `@ossuary/core` and `@ossuary/core/poltergeist` are imported, never by relative path; no definition of 21 core function names, and no `CREATE TABLE` for a core table; the twin is reached only through the engine; no `parseFloat`/`toFixed`/`Math.round`/`Math.trunc`/`* 1e6`/`Number(<amount>)` in the 6 money files; every SQL `sum(` is read as `::text` (CTE intermediates and a sum of counts are allowed).
    - Mutations: a relative import of core's `ledger/hash.js` into `rail.ts`, and a `BigInt(Math.round(parseFloat(t) * 1e6))` parser in `money.ts`: both **fail** the scan (2 tests). That covers the `Math.round` mutation Property 3 could not catch (task 1.3).
    - The scan's first version flagged false positives (a `REFERENCES accounts(...)` clause, and `coalesce(sum(...), 0)::text` cut off at the first `)`). Both rules now match whole lines.
  - [x] 7.2 Playwright demo-path test against the built app
    - _Requirements: 10.3_
    - Done: `playwright.config.ts` (webServer `pnpm build && pnpm preview` on :4174) and `e2e/demo.spec.ts`, which **passes** in Chromium (6.2 s): overlay tab open; seeded jar (5 tips, goal 31.25); a double-clicked 6.66 tip → one row, goal 37.91, one ghost on the overlay tab and in the preview; full refund → "Reversed"; a chargeback after it → rejected text; the overlay ghost fades with "refunded"; coffin balances (in 48.41, refunds 14.16, held 31.25, residual 0.000000); poltergeist seed 7 × 200 → Ossuary 0.000000, twin non-zero with its fault named, epitaphs; the coffin is unchanged afterwards; no page errors.
  - [x] 7.3 `apps/haunted-tip-jar/README.md` with the proposed root README row; fill in design.md's power section
    - _Requirements: 10.5_
    - Done: the app README covers what it shows, how to run and deploy it, the properties with their breaks, and the browser runtime. The root README row is in it, because the root README is outside this session's write scope (design.md Open question 1). design.md "How the Ossuary power was used" lists where each skill check changed the code, and the MCP gaps. 74 tests pass, typecheck clean, build passes.

- [x] 8. Final checkpoint
  - Full app test suite under 120 s, type check clean, production build, `dist/` served and checked, Playwright passing, `money-code-review` over all money files with findings recorded, every property's break recorded.
  - **Tests:** `pnpm --filter haunted-tip-jar test`: 16 files, **74 tests**, all passing. The suite took 10.6 s alone and 27.3 s while the Tontine and power sessions ran in parallel; both are under 120 s. It includes 4 property files (6 fast-check properties, 25–200 runs each), 9 unit files, 3 component files.
  - **Type check:** clean. **Build:** `dist/` from a clean `rm -rf dist`: `index.html` with relative `./assets` paths, 11 assets (JS, CSS, PGlite wasm and data, lazy poltergeist chunk). The only `node:` strings left in the bundle are PGlite's guarded `if (ENVIRONMENT_IS_NODE) require(...)` branches and the shim's own error messages.
  - **Playwright:** `e2e/demo.spec.ts` passes (8.1 s), building and previewing `dist/` itself.
  - **MCP server:** `power/mcp/dist/server.js` **now exists**; the other session built it after task 1.1. It exposes `ossuary_check_money_code`, `ossuary_run_poltergeist` and `ossuary_explain_rule`, not the `summon_poltergeist`/`query_ledger` names in the steering product note. Called over stdio:
    - `ossuary_check_money_code` on 15 app files: 14 `clean`; `readModel.ts` had 4 `float-money` hits (`tips: number`, `overCapTips: number`, and their `Number(...)` reads). All four were **counts** whose names looked like money. They were renamed (`tipCount`, `overCapTipCount`, SQL alias `tip_count`), after which all 15 files are `clean`. This is the one place the MCP tool changed the code.
    - `ossuary_run_poltergeist` seed 7, 200 events: Ossuary drift `0` (73 blocked, 0 drifted); twin drift `6602854836` (conjured 1989832669, lost 8592687505), counterexample fault `late-after-refund`. The in-page panel gives the twin 5871.276351 USDC for the same seed and size, because the panel passes `ensureEveryFault: true` (one ghost of every fault first) and the CLI behind the MCP tool does not, so the storms differ. Ossuary is 0 in both.
  - **Money review:** the `money-auditor` subagent could not run (this session is non-interactive and cannot approve its tools), so the review was done with the skill and the MCP tool above. `money-code-review`, all 6 checks, over `money.ts`, `rail.ts`, `jar.ts`, `seed.ts`, `readModel.ts`, `overlayBus.ts`, `db.ts`, the crypto shim, `TipForm.tsx` and `TipRow.tsx`: **clean**. Units are bigint, read from SQL as text. The app writes no ledger entries; every movement goes through core's handler. Keys are claimed with `ON CONFLICT DO NOTHING` in the same transaction as the tip row. Signatures are verified by core, the outbox carries side effects, and the refund cap is core's, inside the event transaction. The only `UPDATE` is `tipjar_jars.archived_at`.
  - **Mutations tried** (all reverted; `diff` against backups confirmed it):
    - Killed: P3 `Math.trunc(Number(s)*1e6)`; P4 HMAC without key; P1 per-attempt reversal id, reversal id from paymentId; P2 refunds without `applied` filter, key reuse run instead of 409; import scan relative core import, `Math.round(parseFloat)` parser.
    - Survived, explained: P3 `Math.round(Number(s)*1e6)` (exact in range; caught by the scan instead); P1 per-attempt capture id (core rejects a second capture); P1 no `applied` filter (no rejected reversals in P1's domain; moved to P2).
  - **Scope:** this session changed only `apps/haunted-tip-jar/**`, `.kiro/specs/haunted-tip-jar/**` and, through `pnpm --filter haunted-tip-jar add`, `pnpm-lock.yaml`. The `apps/the-tontine` changes in `git status` are the other session's. Nothing was committed.
