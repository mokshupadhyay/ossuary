# Implementation Plan: the-tontine

## Overview

Build `apps/the-tontine` bottom-up, as laid out in design.md: platform adapters, money, the ledger handle, the rail and the circle service, the three properties, seed and runtime, the seance, the UI, then the Playwright demo path.

Conventions for every task:

- **Scope.** Only files under `apps/the-tontine` and `.kiro/specs/the-tontine` change. Core, the twin, the power and the tip jar are not touched. Needed Core changes go to design.md Open questions.
- **Money.** `bigint` base units of USDC, never `number`; every movement through Core (`createWebhookHandler` → `postTransaction`, or `postTransaction`).
- **Definition of done.** `pnpm --filter the-tontine test`, `pnpm --filter the-tontine typecheck` and `pnpm --filter the-tontine build` pass. A property task is ticked only after it was seen failing against a deliberate break, which is then reverted and recorded here.
- **No commits.** The user commits per task.

## Tasks

- [x] 1. App scaffold and browser platform
  - [x] 1.1 Scaffold the Vite + React + TypeScript app
    - `package.json` scripts (`dev`, `build`, `preview`, `typecheck`, `test`, `e2e`), dependencies added with `pnpm --filter the-tontine add`
    - `tsconfig.json` (strict, bundler resolution, `react-jsx`, Node types for Core's `Buffer` use), `index.html`, `public/favicon.svg`, `src/main.tsx` placeholder
    - `vite.config.ts`: React plugin, `base: './'`, aliases `node:crypto` → `src/platform/nodeCrypto.ts` and `node:url` → `src/platform/nodeUrl.ts`, `optimizeDeps.exclude: ['@electric-sql/pglite']`, Vitest config (include `tests/**/*.test.ts(x)` and `tests/**/*.property.ts`)
    - _Requirements: 1.1, 1.4, 1.5, 1.8_
  - [x] 1.2 Browser adapters and their test
    - `src/platform/nodeCrypto.ts`, `nodeUrl.ts`, `polyfills.ts` (design T1)
    - `tests/unit/nodeCrypto.test.ts`: fast-check, against the real `crypto` module: `createHash` sha256/sha1 over string and byte chunks (hex and Buffer digests), `createHmac` sha256 with string and byte keys, `timingSafeEqual` (equal, unequal, length mismatch throws), `randomUUID` format, unsupported algorithm throws; and a check that `signWebhook` from Core (run through the alias) equals an HMAC computed with the real module
    - _Requirements: 1.5, 1.6_

- [x] 2. Money
  - [x] 2.1 `src/money.ts` and `tests/unit/money.test.ts`
    - `parseUsdc` and `formatUsdc` (design); examples for every rejection reason; fast-check round trip `parseUsdc(formatUsdc(x)) === x` for 1 … `MAX_CONTRIBUTION`; no `Number(` on amounts
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

- [x] 3. Ledger handle
  - [x] 3.1 `src/ledger/appSchema.ts`, `src/ledger/database.ts` and `tests/unit/database.test.ts`
    - `openLedger(client)`: Core's `applyEmbeddedMigrations`, then the App tables (design T2); opening twice is a no-op; the App tables have no amount column except `contribution`
    - _Requirements: 1.2, 2.5_

- [x] 4. Rail and circle service
  - [x] 4.1 `src/tontine/types.ts` and `src/tontine/rail.ts`, with `tests/unit/rail.test.ts`
    - Signed `payment.captured` through `createWebhookHandler`; retry on `5xx`/throw up to 3 attempts, re-signed; `applied` / `duplicate`; `rail-failed` otherwise
    - Tests: a capture posts one transaction; the same Due twice is `duplicate`; a handler returning 500 twice then 200 succeeds on attempt 3; three 500s throw `rail-failed`; the delivered signature verifies with Core's `verifyWebhook`
    - _Requirements: 4.2, 4.3, 4.4, 4.5_
  - [x] 4.2 `src/tontine/service.ts` and `tests/unit/service.test.ts`
    - `createCircle`, `contribute` (with outbox receipt), `markMissed`, `payout`, `view`, `listCircles`, `ledgerSum`, as in design
    - Tests: validation errors; accounts and keys minted (N×N Dues, N Rounds); contribute → Pot, money in, receipt; wrong-round contribute and payout rejected with no money moved; mark missed (idempotent, rejected when paid); payout blocked while unpaid (names the Members); payout pays the Recipient once and advances the Round; payout replay returns `replayed: true` with the same transaction; concurrent double-tap payout gives one transfer; full circle completes with Pot 0; Timeline entries with both keys, entries and receipt marks
    - _Requirements: 3.1, 3.4, 4.1, 4.6, 5.1, 5.2, 5.3, 5.4, 6.1, 6.2, 6.3, 6.5, 6.6, 9.1, 9.2, 9.3, 9.4_

- [x] 5. Circle correctness properties
  - [x] 5.1 Shared property helpers `tests/property/helpers/circleModel.ts`
    - Circle and command arbitraries, an independent model, a runner that applies a command to the service and the model, and ledger snapshot helpers (counts, balances, sums)
    - _Requirements: 7.4_
  - [x] 5.2 Property 1, `tests/property/circleConservation.property.ts`
    - Show it failing against a deliberate break in `src/tontine/service.ts`, revert, record the break below
    - _Requirements: 6.4, 6.5, 7.1, 7.5_
  - [x] 5.3 Property 2, `tests/property/circleIdempotency.property.ts`
    - Show it failing against a deliberate break, revert, record
    - _Requirements: 4.5, 6.3, 7.2, 7.5_
  - [x] 5.4 Property 3, `tests/property/circleZeroSum.property.ts`
    - Show it failing against a deliberate break, revert, record
    - _Requirements: 7.3, 7.5_

- [x] 6. Seed and runtime
  - [x] 6.1 `src/tontine/seed.ts`, `src/runtime/runtime.ts`, `tests/unit/seed.test.ts`, `tests/unit/runtime.test.ts`
    - Demo_Circle as in design; seeding only when no Circle exists; `memoryRuntime` open/reset; `browserRuntime` with the Web Lock (`OtherTabError` when held) and IndexedDB delete on reset (tested with a fake `navigator.locks`; the IndexedDB path is covered by the Playwright test)
    - _Requirements: 1.2, 1.7, 11.1, 11.2_

- [x] 7. Seance
  - [x] 7.1 `src/tontine/seance.ts` and `tests/unit/seance.test.ts`
    - One storm, `ossuaryFactory({ client })` on the App's client and `twinFactory()`; books before/after; whole-Ledger sum
    - Tests (size 200, seed 7): Ossuary drift `0` with blocked ghosts for every fault; twin drift ≠ 0; the Circle's books unchanged; Ledger sum 0
    - _Requirements: 10.2, 10.4, 10.5_

- [x] 8. User interface
  - [x] 8.1 App shell, styles, candlelit table, round panel and actions
    - `App`, `Header`, `CircleTable`, `Candle`, `Coffin`, `RoundPanel`, `LedgerSummary`, `useReducedMotion`, `styles.css`, `main.tsx` with `browserRuntime()`; live region; other-tab and open-failure screens
    - `tests/component/table.test.tsx`: seeded table shows five Candles with text states; record a Contribution lights a Candle and announces it; a double-click records one capture; mark late gutters a Candle; payout disabled and names who it waits for; payout moves the Pot to the Recipient and announces it; reduced motion skips the Coffin slide
    - _Requirements: 4.7, 5.3, 8.1–8.8, 12.1–12.5_
  - [x] 8.2 Timeline
    - `Timeline.tsx`; `tests/component/timeline.test.tsx`: entries newest first with both keys, entries and receipt marks, and missed marks
    - _Requirements: 9.1–9.4_
  - [x] 8.3 Create a circle, switch circles
    - `CreateCircleForm.tsx`; `tests/component/createCircle.test.tsx`: field errors linked with `aria-describedby`, focus on the first invalid field, nothing created; valid input creates and selects the Circle; Rounds shown = Members; the circle switcher
    - _Requirements: 3.1, 3.2, 3.3, 3.5, 11.4_
  - [x] 8.4 Reset
    - `ResetDialog.tsx`; `tests/component/reset.test.tsx`: cancel and Escape change nothing and return focus; confirm recreates the Demo_Circle
    - _Requirements: 11.2, 11.3, 12.6_
  - [x] 8.5 Summon the Poltergeist panel
    - `PoltergeistPanel.tsx`, `DriftMeter.tsx`; `tests/component/poltergeist.test.tsx`: summon (seed 7, size 200) shows Ossuary `0.00 USDC` drift in text, twin drift ≠ 0, blocked ghosts with epitaphs, twin drifted ghosts, books unchanged; controls disabled while running
    - _Requirements: 10.1–10.7_

- [x] 9. Playwright demo path
  - [x] 9.1 `playwright.config.ts` and `e2e/demo.spec.ts`
    - Against `vite preview` serving `dist/`: seeded Circle visible; pay Mateo and Nkechi; pay out Round 2 to Kwame; the Timeline shows the Payout key; summon the Poltergeist; Ossuary drift 0, twin drift ≠ 0; no page errors other than PGlite's IndexedDB `ErrnoError` (design Facts); a reload keeps the paid Round
    - _Requirements: 1.1, 1.2, 1.3, 13.2_

- [x] 10. Final checkpoint
  - [x] 10.1 Full verification and README row
    - `test`, `typecheck`, `build`, `e2e` all pass; record test counts and durations here; check `git status` shows changes only under `apps/the-tontine`, `.kiro/specs/the-tontine` and `pnpm-lock.yaml`
    - README row: proposed text in design Open question Q10 (outside this session's write scope)
    - _Requirements: 13.1, 13.3, 13.4_

## Final checkpoint (task 10.1)

Run on 2026-11-22, Node 24.22.2, from `apps/the-tontine`:

| Command | Result |
|---|---|
| `pnpm test` | 16 files, **92 tests passed** in 22.9 s: 71 unit, 3 properties (50 runs each), 18 component (jsdom) |
| `pnpm typecheck` | clean |
| `pnpm build` | clean; `dist/` is static (`index.html`, JS, CSS, PGlite WASM and data) |
| `pnpm e2e` | **2 passed** (desktop 1280 px and mobile 360 px), 27.4 s |

`git status` shows changes only under `apps/the-tontine`, `.kiro/specs/the-tontine` and `pnpm-lock.yaml`. The README row is in design Open question Q10 for the user to apply.

## Mutation log

Every break was made in `src/tontine/service.ts`, run against the property, and reverted (`diff` against the saved original was empty). Properties ran at 30 runs during the checks; the suite now runs 50.

| Id | Break | Property | Result |
|---|---|---|---|
| M1a | Recipient off by one (`recipient_position = round % n`) | 1 | **Failed**: `after command 1 {"t":"doublePayout"}: member 0 holds 0, expected 2` |
| M1b | Contributions accepted for any round (current-round check removed) | 1 | **Failed**: the service accepted a contribution the model rejects |
| M1c | Pot created with overdraft allowed **and** the App's dues check removed | 1 | **Failed**: `payout(r1): got paid, model says dues-unpaid` |
| M1d | Pot created with overdraft allowed only | 1 | Passed: the App's dues check still holds (defence in depth, design T4) |
| M1e | App's dues check removed only | 1 | **Failed** on the error code (`pot-short` instead of `dues-unpaid`); no money moved, because Core's normal-balance check refused the payout |
| M2a | A repeat of a paid due mints a fresh key and payment id | 2 | **Failed**: `replay of {"t":"contribute","round":1,"pos":0} answered applied` |
| M2b | A repeat payout mints a fresh key | 2 | **Failed**: the repeat was not a replay (`pot-short` from Core) |
| M3 | Payout written as a raw single-entry insert instead of `postTransaction` | 3 | **Failed**: `ledger entries sum to -1465309432` |
