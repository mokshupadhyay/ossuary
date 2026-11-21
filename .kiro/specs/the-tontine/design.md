# Design Document: the-tontine

## Overview

The Tontine is a static React app in which every cent moves through `packages/core`. The browser holds the whole system:

```
 ┌──────────────────────────── browser tab ─────────────────────────────┐
 │  React UI (candlelit table, timeline, create form, poltergeist panel) │
 │        │ calls                                                       │
 │  TontineService (src/tontine/service.ts) ── app records (tontine_*)  │
 │        │                │                     │                      │
 │   Rail (sign + deliver) │ postTransaction     │ balance()            │
 │        ▼                ▼                     ▼                      │
 │  createWebhookHandler ─► @ossuary/core ledger ◄─ runOutboxOnce       │
 │        └──────────── PGlite (Postgres in WASM) ── IndexedDB ─────────┘
 │  Seance: generateStorm → summon(ossuaryFactory({ client }))  (same DB)│
 │                         summon(twinFactory())               (own DB) │
 └──────────────────────────────────────────────────────────────────────┘
```

- A **Contribution** is a payment from outside the circle, so it arrives the way the steering says external money must: as a signed `payment.captured` webhook, verified by Core's handler, deduplicated by Core's inbox, posted by Core as a `capture` (debit Clearing, credit Pot). The App plays the simulated rail.
- A **Payout** is an app request, exactly as the poltergeist models it (poltergeist-engine D2): a `transfer` through `postTransaction` that debits the Pot and credits the Recipient's Wallet, under the Round's Payout_Key.
- **Receipts** go out through Core's outbox: the capture enqueues a message, and the App runs `runOutboxOnce` with a sender that records a receipt.
- **Balances** are Core's `balance()`. The App stores no amount except each Circle's configured Contribution.

### Facts this design is built on

Checked with a throwaway spike (since deleted) in this workspace, on Node 24.22, Vite 8.3.8, PGlite 0.5.16, Chromium (Playwright 1.65):

- **Core bundles for the browser with two aliases.** Without them, Vite externalizes `node:crypto` (used by `ledger/hash.ts`, `ledger/postTransaction.ts`, `webhooks/verify.ts`, `webhooks/keys.ts`, `webhooks/apply.ts`, `outbox/worker.ts`) and `node:url` (`db/migrate.ts`). The page then fails at load with `fileURLToPath is not a function`, because `db/migrate.ts` computes its migrations folder at module level and `@ossuary/core` re-exports `runMigrations`. With `node:crypto` → `src/platform/nodeCrypto.ts` and `node:url` → `src/platform/nodeUrl.ts`, plus the `buffer` package installed as `globalThis.Buffer`, the built page migrated an IndexedDB PGlite with `applyEmbeddedMigrations`, applied a signed capture through `createWebhookHandler` (`200 applied`), posted a transfer, ran `runOutboxOnce`, and ran a 120-event storm: **Ossuary drift `0`, twin drift `3721037217`** base units. Setup took 0.8 s, the Ossuary storm 0.22 s, the twin storm 0.95 s.
- **`node:fs`** (from `drizzle-orm/migrator`) and **`node:module`** (from PGlite's Node file-system code) stay externalized. Neither is touched at load or in any path the App calls.
- **PGlite on IndexedDB reports one unhandled rejection** (`ErrnoError`, errno 44, ENOENT) on every open, fresh or persisted. Queries work and data persists across reloads. It is PGlite's internal file-system probe. The App does not hide it; the Playwright test ignores exactly that error and fails on any other page error.
- **PGlite works under Vitest's jsdom environment**, with the aliases applied, so component tests use the real ledger.
- **Typed arrays from another realm.** Under jsdom, `TextEncoder` and Node's `Buffer` return arrays whose constructor is not the global `Uint8Array`, and `@noble/hashes` rejects them (`expected Uint8Array`). The adapter re-views every input as a plain `Uint8Array` over the same memory. Browsers hit the same case with the `buffer` polyfill's `Buffer` subclass.
- **No package exports Core's Drizzle schema or a PGlite `Db` constructor.** `drizzle(client)` from `drizzle-orm/pglite` without a schema satisfies everything Core calls (Core uses the query builder, never `db.query.*`), so the App casts it to Core's `Db` type (Open question Q4).

---

## Design Decisions

### T1. Browser adapters instead of Core changes

| Core needs | Browser adapter | Why it is safe |
|---|---|---|
| `node:crypto` `createHash('sha256'\|'sha1')`, `createHmac('sha256')`, `timingSafeEqual`, `randomUUID` | `src/platform/nodeCrypto.ts`: `@noble/hashes` (synchronous, as Node's API is; Web Crypto's `subtle` is async), a constant-time compare that throws on unequal lengths as Node does, `globalThis.crypto.randomUUID` | `tests/unit/nodeCrypto.test.ts` compares every function with the real `crypto` module over fast-check inputs, byte for byte, including `Buffer` and string inputs, hex and `Buffer` digests and error cases |
| `node:url` `fileURLToPath` (module-level, unused path) | `src/platform/nodeUrl.ts` | The value is only used by `runMigrations`, which the App never calls. It uses `applyEmbeddedMigrations` |
| `Buffer` global | `src/platform/polyfills.ts` installs the `buffer` package (the same polyfill `crypto-browserify` uses) | Imported first by `main.tsx`. Core reads `Buffer` only inside function bodies |

The aliases live in `vite.config.ts`, which Vitest also loads. So **every App test runs Core through the browser adapters**, and Core's own suite (`pnpm --filter core test`) still runs on real Node modules and is not touched. Core's behavior is unchanged in both places.

### T2. App records hold intent, the Ledger holds money

App tables (prefix `tontine_`) are created by the App's own idempotent SQL after Core's embedded migrations. They never hold a balance.

| Table | Columns | Purpose |
|---|---|---|
| `tontine_settings` | `key text pk`, `value text` | The rail signing secret (32 random bytes, hex), created once per database |
| `tontine_circles` | `circle_id uuid pk`, `name`, `asset`, `contribution bigint check > 0`, `member_count int`, `clearing_account_id uuid`, `pot_account_id uuid`, `created_at`, `seq bigserial` | Circle configuration |
| `tontine_members` | `circle_id`, `position`, `member_id uuid unique`, `name`, `wallet_account_id uuid` | pk `(circle_id, position)` |
| `tontine_dues` | `circle_id`, `round`, `position`, `idempotency_key uuid unique`, `payment_id uuid unique` | One row per Member and Round, minted at creation. pk `(circle_id, round, position)` |
| `tontine_rounds` | `circle_id`, `round`, `recipient_position`, `payout_key uuid unique` | One row per Round, minted at creation |
| `tontine_notices` | `circle_id`, `round`, `position`, `noted_at` | Missed_Payment marks. pk `(circle_id, round, position)`, insert on conflict do nothing |
| `tontine_receipts` | `outbox_key uuid pk`, `event_id`, `payment_id uuid`, `topic`, `recorded_at` | Written by the outbox sender, insert on conflict do nothing |

All derived state comes from the Ledger:

- a Due is **paid** iff a `capture` transaction exists with the Due's `payment_id`;
- a Round is **paid out** iff a transaction exists with `idempotency_key` = the Round's Payout_Key;
- `Current_Round` = the lowest Round not paid out, or none (Complete);
- Pot held = −`balance(pot)` (revenue, credit-normal); Wallet held = −`balance(wallet)`; money in = `balance(clearing)`; money out = Σ Wallets.

### T3. Keys are minted once, at creation

Every intended movement has its key before anyone can tap a button:

- **Due key** (random UUID). The rail's event id is `due:<due key>`, and the event's `paymentId` is the Due's `payment_id`. A double-tap, a retry, a reload or a second tab sends the same event, which Core's inbox dedupes (`duplicate`). Core derives the ledger key from the event id (`ledgerKeyFor`), so the capture is claimed once.
- **Payout_Key** (random UUID). Every payout request for a Round uses it. Same key and same entries means Core returns the stored response; a different payload under it would be a `409`.

This follows `idempotency.md` ("client-generated UUID", "double-taps reuse the same key") and makes "one payout per Round" a unique constraint in Core instead of a UI rule.

### T4. Guards in the App, the last line in Core

| Rule | App guard (first) | Core guard (last) |
|---|---|---|
| Contribution only for the Current_Round | `contribute` checks the round | — |
| Same Contribution twice changes nothing | Due key → same event id and payment id | inbox dedupe, ledger key, one capture per payment |
| No Payout while a Due is unpaid | `payout` counts paid Dues | Pot's normal-balance check (`422`-equivalent `NormalBalanceViolationError` → `pot-short`) |
| One Payout per Round | Payout_Key per Round | unique idempotency key |
| Payout only to the Round's Recipient | `recipient_position = round − 1`, fixed at creation | — |

The App's checks are read-then-write outside a transaction. That is safe because every condition they read is monotonic: a paid Due never becomes unpaid (the App has no refunds), and a paid-out Round never becomes unpaid. A stale read can only reject a request that would now be allowed, never allow a forbidden one, and Core's key and balance checks hold regardless.

### T5. The Seance runs on the Circle's database

`summon({ storm, factory: ossuaryFactory({ client }), target: 'ossuary' })` gets the App's own PGlite client. The Ossuary adapter then runs Core's real webhook handler, payout glue and outbox on the same Ledger the Circle uses. It creates its own storm-scoped accounts (`poltergeist <run tag> pot`, …) next to the Circle's, because Core's adapter does not accept existing accounts (Open question Q2). Before and after the storm the App snapshots the selected Circle's Pot, Wallets and Ledger sum, and the whole Ledger's sum, and shows that the Circle is untouched and everything still sums to zero.

The twin runs on `twinFactory()`, a fresh in-memory PGlite per run, because the twin creates its own tables and has no business in the Circle's database.

Storm options: `ensureEveryFault: true`, so every fault appears; size 200 (default), 500 or 2,000; seed default 7. Both sides get the same `Storm` object. They run one after the other, Ossuary first.

### T6. One tab owns the database

PGlite's IndexedDB file system is one in-memory copy per tab that is flushed back. Two tabs would overwrite each other's ledger. The browser Runtime takes a Web Lock (`navigator.locks.request('the-tontine-ledger', { ifAvailable: true })`) and holds it while the database is open. If the lock is taken, the App shows "The Tontine is open in another tab" and opens nothing. PGlite runs with default durability (flush after every query), not `relaxedDurability`, so a committed Contribution is on disk before the UI says so.

### T7. Rounds equal Members

A rotating circle ends when everyone has received the pot once, so Rounds = Members. The create form shows Rounds as a computed output, not an input (Open question Q1).

### T8. Experience

- **Table.** Candles sit on a circle around the Coffin (CSS `rotate(θ) translate(r) rotate(−θ)` per Candle). Below 640 px wide, the table becomes the Coffin on top and a two-column grid of Candles, so 12 Members fit at 360 px with no horizontal scroll.
- **Candle states.** Lit (flame flickers, text `Paid`), lit and marked (`Paid late`), guttering (small, sputtering, dimmer flame, text `Late`), unlit (wick only, text `Owes`). The Recipient wears a text badge `Takes the pot`; earlier Recipients show `Received round n`. Shapes differ (flame present, small flame, none), so state is not colour alone.
- **Coffin.** A coffin outline with stacked coins, one per paid Due, and the Pot in text. On a successful Payout it slides toward the Recipient's Candle for about 1 s (CSS transition on custom properties), then returns empty.
- **Reduced motion.** A `prefers-reduced-motion: reduce` media query disables flame animation and the Coffin transition, and `useReducedMotion()` skips the slide entirely.
- **Palette.** Near-black table (`#120d0a`), parchment text (`#f3e9d2`, contrast ≈ 16:1), candle gold (`#f5c35b`) for focus rings (≈ 11:1 on the table), blood red (`#e0645a`) only alongside text. System serif fonts, no web fonts (no network).
- **Live region.** One `role="status"` polite region announces every action result.
- **Dialog.** The reset confirmation is an in-page `role="dialog"` with `aria-modal`, focus moved to its Cancel button, a focus trap, Escape to close and focus returned to Reset.

---

## Architecture

```
apps/the-tontine/
├── index.html                  # static entry, base './'
├── package.json                # scripts: dev, build, preview, typecheck, test, e2e
├── tsconfig.json               # strict, bundler resolution, react-jsx; includes src, tests, e2e
├── vite.config.ts              # react plugin, aliases (T1), PGlite optimizeDeps exclude, Vitest config
├── playwright.config.ts        # webServer: vite preview on 4173, serves dist/
├── public/favicon.svg
├── src/
│   ├── main.tsx                # polyfills first, then <App runtime={browserRuntime()} />
│   ├── platform/               # polyfills.ts, nodeCrypto.ts, nodeUrl.ts (T1)
│   ├── money.ts                # parseUsdc, formatUsdc, USDC constants
│   ├── ledger/
│   │   ├── database.ts         # openLedger(client): Core migrations + app schema → LedgerHandle
│   │   └── appSchema.ts        # APP_SCHEMA_SQL (T2)
│   ├── tontine/
│   │   ├── types.ts            # CircleView, MemberView, TimelineEntry, TontineError
│   │   ├── rail.ts             # simulated rail: build, sign, deliver, retry
│   │   ├── service.ts          # createTontineService(ledger)
│   │   ├── seed.ts             # seedDemoCircle(service)
│   │   └── seance.ts           # runSeance(ledger, circleId, options)
│   ├── runtime/runtime.ts      # Runtime, browserRuntime (IndexedDB + Web Lock), memoryRuntime
│   └── ui/
│       ├── App.tsx, Header.tsx, CircleTable.tsx, Candle.tsx, Coffin.tsx, RoundPanel.tsx,
│       │   LedgerSummary.tsx, Timeline.tsx, CreateCircleForm.tsx, ResetDialog.tsx,
│       │   PoltergeistPanel.tsx, DriftMeter.tsx, useReducedMotion.ts
│       └── styles.css
├── tests/
│   ├── unit/                   # nodeCrypto, money, database, rail, service, seed, seance, runtime
│   ├── property/               # circleConservation, circleIdempotency, circleZeroSum (+ helpers/)
│   └── component/              # *.test.tsx on jsdom with memoryRuntime
└── e2e/demo.spec.ts            # Playwright, the full demo path on the built app
```

Dependencies point one way: `ui → tontine → ledger → @ossuary/core`, and `tontine/seance → @ossuary/core/poltergeist`. Nothing in the App imports Core's internals by path; only `@ossuary/core` and `@ossuary/core/poltergeist`.

---

## Components and Interfaces

### `money.ts`

```ts
export const ASSET = 'USDC';
export const DECIMALS = 6;
export const MAX_CONTRIBUTION = 1_000_000_000_000n;        // 1,000,000 USDC
export function parseUsdc(input: string): bigint;           // throws MoneyInputError(reason)
export function formatUsdc(amount: bigint, opts?: { sign?: boolean }): string; // "1,250.50 USDC"
```

Parsing is string-only: `^\d{1,7}(\.\d{1,6})?$` after trimming and removing `,`; the fraction is right-padded to 6 digits and joined. Formatting splits `abs(amount)` at 6 digits, trims trailing zeros down to 2, adds separators every 3 digits, a `−` for negatives (and `+` with `sign`).

### `ledger/database.ts`

```ts
export interface LedgerHandle { client: PGlite; db: Db }
export async function openLedger(client: PGlite): Promise<LedgerHandle>;
```

`db = drizzle(client) as unknown as Db`; `await applyEmbeddedMigrations(db)`; `await client.exec(APP_SCHEMA_SQL)`. Both steps are idempotent, so opening a persisted database again is a no-op.

### `tontine/rail.ts`

```ts
export interface Rail { deliverCapture(due: DueRef, amount: bigint): Promise<'applied' | 'duplicate'> }
export async function createRail(ledger, circle: { clearingAccountId; potAccountId }, secret, clock): Promise<Rail>;
```

Builds the body `{ id: 'due:<key>', type: 'payment.captured', paymentId, circleId, memberId, asset: 'USDC', amount: '<base units>' }`, signs `<ts>.<body>` with Core's `signWebhook` into `ossuary-timestamp` / `ossuary-signature`, calls the handler from `createWebhookHandler(db, { secret, asset, clearingAccountId, revenueAccountId: potAccountId, clock })`. `5xx` or a thrown error is retried, re-signed, up to 3 attempts. `200 applied|duplicate` is success. Any other result throws `TontineError('rail-failed')`. Handlers are cached per Circle.

### `tontine/service.ts`

```ts
export interface TontineService {
  readonly ledger: LedgerHandle;
  listCircles(): Promise<CircleSummary[]>;
  createCircle(input: { name: string; members: string[]; contribution: bigint }): Promise<string>;
  contribute(circleId: string, round: number, position: number): Promise<{ outcome: 'applied' | 'duplicate' }>;
  markMissed(circleId: string, round: number, position: number): Promise<{ changed: boolean }>;
  payout(circleId: string, round: number): Promise<{ transactionId: string; replayed: boolean }>;
  view(circleId: string): Promise<CircleView>;
  ledgerSum(accountIds?: readonly string[]): Promise<bigint>;   // whole Ledger when omitted
}
export async function createTontineService(ledger: LedgerHandle, options?: { clock?: Clock }): Promise<TontineService>;

export type TontineErrorCode =
  | 'invalid-input' | 'unknown-circle' | 'unknown-member' | 'circle-complete'
  | 'not-current-round' | 'already-paid' | 'dues-unpaid' | 'pot-short' | 'rail-failed';
export class TontineError extends Error { constructor(readonly code: TontineErrorCode, message: string) }
```

- `createCircle` validates (Requirement 3.1), creates the accounts with `createAccount`, then writes the Circle, Members, Dues and Rounds in one SQL transaction.
- `contribute`: Circle exists → Member exists → if the Due is already paid (in any Round), send the same event again, which Core answers `duplicate` with no movement; otherwise not Complete and `round === Current_Round` → `rail.deliverCapture` → `runOutboxOnce(db, { sender: recordReceipt, clock })`.
- `markMissed`: Current_Round only; rejects a paid Due with `already-paid`; inserts on conflict do nothing.
- `payout`: if the Round is already paid out, send the same request again (same Payout_Key and entries), which Core answers with its stored response (`replayed: true`); otherwise Current_Round only, every Due paid (else `dues-unpaid` naming the Members), then `postTransaction(db, { idempotencyKey: payoutKey, kind: 'transfer', entries: [{ pot, +amount }, { wallet, −amount }] })`. `NormalBalanceViolationError` → `pot-short`.
- `view` returns:

```ts
interface CircleView {
  circleId: string; name: string; asset: 'USDC'; contribution: bigint; potPerRound: bigint;
  rounds: number; currentRound: number | null; complete: boolean; recipientPosition: number | null;
  members: MemberView[];       // position, memberId, name, walletAccountId, wallet, receivedRound,
                               // due: { round, status: 'paid'|'paid-late'|'late'|'owes', idempotencyKey } | null
  waitingFor: string[];        // names of Members whose Current_Round Due is unpaid
  pot: bigint; moneyIn: bigint; moneyOut: bigint; ledgerSum: bigint;
  accounts: { clearing: string; pot: string };
  timeline: TimelineEntry[];   // newest first
}
type TimelineEntry =
  | { kind: 'contribution'; at: Date; round; position; memberName; amount; clientKey; ledgerKey; transactionId;
      entries: { account: string; amount: bigint }[]; receipt: boolean; late: boolean }
  | { kind: 'payout'; at: Date; round; position; memberName; amount; clientKey; ledgerKey; transactionId; entries }
  | { kind: 'missed'; at: Date; round; position; memberName };
```

Reads use `balance()` from Core for balances and read-only SQL on `transactions`, `entries` and the `tontine_*` tables for derived state and the Timeline.

### `tontine/seed.ts`

`seedDemoCircle(service)` creates "The Midnight Circle" with Asha, Kwame, Lupe, Mateo and Nkechi at 50 USDC, contributes all five Round 1 Dues, pays Round 1 out to Asha, contributes Round 2 for Asha, Kwame and Lupe, and marks Mateo missed. Nkechi still owes. It goes through the service, so it uses the same keys, rail and ledger as a click.

### `tontine/seance.ts`

```ts
export interface SeanceResult {
  ossuary: PoltergeistReport; twin: PoltergeistReport;
  books: { circleId: string | null; before: BooksSnapshot | null; after: BooksSnapshot | null; unchanged: boolean; ledgerSum: bigint };
}
export async function runSeance(service: TontineService, circleId: string | null,
  options: { seed: number; size: 200 | 500 | 2000; onPhase?: (p: 'ossuary' | 'twin' | 'books') => void }): Promise<SeanceResult>;
```

### `runtime/runtime.ts`

```ts
export interface Session { service: TontineService; close(): Promise<void> }
export interface Runtime { open(): Promise<Session>; reset(current: Session): Promise<Session> }
export class OtherTabError extends Error {}
export function browserRuntime(name = 'the-tontine'): Runtime;  // idb://<name>, Web Lock, seeds when empty
export function memoryRuntime(options?: { seed?: boolean }): Runtime;   // tests
```

`reset` closes the client, deletes the IndexedDB database `/pglite/<name>` (PGlite's naming for `idb://<name>`), reopens and seeds.

### UI

`App` owns the Session, the selected Circle id, the latest `CircleView`, a `busy` set (per Due, per payout, `seance`) and the live-region message. After every action it reloads the view from the service. Components are presentational and receive callbacks.

---

## Data flow: a double-tapped Contribution

1. Two clicks call `contribute(c, 2, 4)` twice. The second may start before the first finishes (the button is disabled after the first render, but a test or a fast double-click can still race).
2. Both read the Due: key `K`, payment `P`. Both build the event `due:K` for `P`, signed at the current second.
3. PGlite serializes the two webhook transactions. The first claims `due:K` in the inbox and posts the capture. The second finds `due:K` and returns `200 duplicate`.
4. The outbox has one message (its key is derived from the event id), so one receipt is recorded.

---

## Correctness Properties

Each property runs on one PGlite per test file, through `createTontineService`, with a fresh Circle per run, at least 25 runs.

### Property 1: Circle conservation

For any Circle (2 to 5 Members, Contribution 1 to 10⁹ base units) and any sequence of 1 to 40 commands from:

- `contribute(position, roundDelta ∈ {−1, 0, +1})`,
- `doubleTapContribute(position)` (two concurrent calls),
- `markMissed(position, roundDelta)`,
- `payout(roundDelta)`,
- `doubleTapPayout()` (two concurrent calls),
- `replay()` (repeat the last successful money command),

after every command: the Pot ≥ 0; each Round has ≤ 1 transfer transaction; each Wallet holds 0 or exactly one Pot and only the Recipient of a paid-out Round holds it; money in = money out + Pot; and Pot, money in and the Current_Round equal an independent model's (which accepts a command only for the current round and only when its preconditions hold). Commands the model rejects must throw a `TontineError` and move no money.

**Breaks to try:** recipient off by one (`round % n`); accept Contributions for any Round; Pot created with overdraft allowed and the dues check removed.

### Property 2: Idempotent replays

For any Circle and any command prefix, replaying any money command that succeeded (once, or 2 to 3 times concurrently) leaves the whole Ledger's transaction and entry counts, and every Circle account's balance, unchanged.

**Breaks to try:** a fresh event id and payment id per Contribution call; a fresh Payout key per call.

### Property 3: Zero sum

For any Circle and any command sequence, the entries of the Circle's accounts sum to zero, and so do all entries in the database, after every command.

**Break to try:** a Payout written as a raw single-entry insert instead of `postTransaction`.

---

## Error Handling

| Situation | Result in the UI |
|---|---|
| `TontineError` | The message in the live region and next to the control; the view reloads |
| Rail retries exhausted | `rail-failed`: "The rail did not confirm the payment. Nothing was recorded; try again." (retrying is safe: same key) |
| Another tab holds the lock | A full-page notice, nothing opened |
| PGlite fails to open | A full-page error with a Reset button |
| Seance throws | The error in the panel; controls re-enabled; the Circle unchanged (the storm uses its own accounts) |

---

## Testing Strategy

- **Unit (`tests/unit`, Node env):** `nodeCrypto` against `crypto`; `money` parse/format (examples and fast-check round-trip); `openLedger` idempotent; `rail` (signature verifies, retry on 5xx, duplicate outcome); `service` (every error code, the happy path, the Timeline); `seed`; `seance` (Ossuary 0, twin ≠ 0, books unchanged); `memoryRuntime` reset.
- **Property (`tests/property`):** Properties 1–3, `numRuns: 25` or more, one PGlite per file.
- **Component (`tests/component`, jsdom):** App with `memoryRuntime()`: seeded table, contribute, double-tap, mark late, blocked payout, payout and announcement, Timeline keys, create circle (validation and success), reset dialog (cancel, confirm, Escape, focus return), Seance (size 200), reduced motion.
- **E2E (`e2e/demo.spec.ts`):** Playwright Chromium on `vite preview` of `dist/`.
- **Commands after every task:** `pnpm --filter the-tontine test`, `pnpm --filter the-tontine typecheck`, `pnpm --filter the-tontine build`.

---

## Open questions

Recorded instead of stopping, with the answer this implementation uses.

- **Q1. "Rounds" in the create form.** The prompt lists rounds as a field, but a rotating circle has exactly one Round per Member. *Used:* Rounds is shown as a computed value (= Members) with a one-line explanation, not an editable input.
- **Q2. "Against this circle's ledger."** `ossuaryFactory({ client })` always creates fresh storm accounts; it cannot run on the Circle's existing Pot and Wallets, and the storm's five fixed members (`m0`–`m4`) would not match a Circle anyway. *Used:* the storm runs on the Circle's database and Core code, with its own accounts, and the App proves the Circle's books are untouched and the whole Ledger sums to zero. *Possible core change (not made):* an `ossuaryFactory` option that adopts existing pot/wallet accounts.
- **Q3. Core's Node imports.** `@ossuary/core` re-exports `runMigrations`, whose module computes a file path at load. *Used:* the `node:url` adapter (T1). *Possible core change (not made):* a browser entry (`@ossuary/core/browser`) exporting the ledger, webhook and outbox API without `db/migrate.ts` and `db/client.ts` (which also pulls in `@neondatabase/serverless`).
- **Q4. No exported schema or PGlite `Db`.** *Used:* `drizzle(client) as unknown as Db`. *Possible core change (not made):* export `createPgliteDb(client)`.
- **Q5. The rail secret lives in the browser.** In a static demo the rail and the ledger share one origin, so the signing secret is in the same IndexedDB as the ledger. It is testnet-only and documented; signature verification still runs on every Contribution.
- **Q6. No refunds.** A missed payment makes the circle wait; nothing is refunded. Contributions are accepted only for the Current_Round, so nobody pre-pays.
- **Q7. Who marks a payment missed?** There are no due dates, so "late" is an explicit organiser action, shown as a guttering Candle.
- **Q8. Display unit.** Amounts show as `USDC`, not `$`, so the UI never implies a conversion. The drift meter reads "0.00 USDC drift".
- **Q9. Two keys per Contribution.** The Timeline shows the client Idempotency-Key (the Due's) and the Ledger key Core derived from the event id. For a Payout they are the same.
- **Q10. README write scope.** The spec prompt asks to update the README row, but this session may only write under `apps/the-tontine` and `.kiro/specs/the-tontine`, and another session is editing the tip-jar row. *Used:* the proposed row is below; the user applies it.

  `| apps/the-tontine | A rotating savings circle (chit fund, susu, tanda) as a static Vite + React app. The ledger runs on PGlite in the browser; contributions are signed webhooks, payouts are idempotent transfers, and "Summon the Poltergeist" runs the storm live against the circle's ledger and the Vibe Pay twin. |`
- **Q11. PGlite's IndexedDB `ErrnoError` on open.** Left visible (see Facts); not suppressed by the App.
