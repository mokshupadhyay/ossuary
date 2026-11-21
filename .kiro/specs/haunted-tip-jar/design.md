# Design Document

## Overview

`haunted-tip-jar` is a static Vite + React + TypeScript app. Everything, including Postgres, runs in the browser:

```
 viewer / creator / bank (UI)
        │  Rail_Request + Idempotency_Key
        ▼
 ┌──────────────┐  signed webhook   ┌──────────────────────────────┐
 │ Simulated    │ ───────────────▶  │ core createWebhookHandler    │
 │ Rail (app)   │  ossuary-signature│  verify → parse → inbox →    │
 │ rail.ts      │ ◀─────────────────│  ledger (postTransaction /   │
 └──────────────┘   200 / 401 / …   │  refund cap) → outbox        │
                                    └──────────────┬───────────────┘
                                                   │ runOutboxOnce
                                                   ▼
                                     Overlay_Bus (BroadcastChannel)
                                                   │
                                     #/overlay ghosts, in-page preview
```

The app owns four things: the **simulated rail** (requests, signing, delivery, haunting), the **read model** (tips, coffin), the **overlay bus**, and the **UI**. Money rules live in core and are reached only through `@ossuary/core` and `@ossuary/core/poltergeist`.

A spike before this design (since replaced by the real entry) built core into a Vite bundle and ran it in headless Chromium: a signed capture applied, its duplicate returned `duplicate`, the jar balance read `-5000000`, and a 60-event storm gave Ossuary drift `0` and the twin drift `3556856834`. The decisions below rest on that result.

## Design Decisions

### D1. Vite + React, not Next.js

`tech.md` says Next.js, but the spec prompt requires a static app with no server, and the Tontine prompt (which this app follows) names Vite + React. `apps/haunted-tip-jar/package.json` already had Vite scripts. The build is `tsc --noEmit && vite build` into `dist/`, with `base: './'` so `dist/` works from any path. Routing is by URL hash (`#/`, `#/overlay`, `#/coffin`, `#/poltergeist`), so static hosting needs no rewrites.

### D2. Running core in the browser without changing it

Core's browser story is poltergeist-engine D8: the poltergeist entry is browser-safe, and the only Node built-in it reaches is `node:crypto` (`createHash`, `createHmac`, `timingSafeEqual`, `randomUUID`), plus the `Buffer` global in `verify.ts`, `keys.ts` and `handler.ts`. The app's root import (`@ossuary/core`) additionally reaches `db/migrate.ts`, which calls `fileURLToPath` at load time, and drizzle's migrator, which imports `node:fs`.

The app handles these in its Vite config only (`vite.config.ts` `resolve.alias`), so core and its tests are untouched:

| Built-in | Browser replacement | Why it is safe |
|---|---|---|
| `node:crypto` | `src/shims/node-crypto.ts`: `@noble/hashes` SHA-1, SHA-256, HMAC; constant-time XOR compare; `crypto.randomUUID` | Core calls hashes synchronously, so Web Crypto (async) cannot be used. Property 4 checks the shim is byte-identical to Node for every function core uses. |
| `node:url`, `node:fs` | `src/shims/node-stubs.ts`: `fileURLToPath` returns the URL path; every `fs` function throws | Only `runMigrations` uses them; the app migrates with `applyEmbeddedMigrations`. A call would fail loudly, not silently. |
| `Buffer` global | `src/polyfills.ts` installs the `buffer` package, imported first by `main.tsx` | The same polyfill crypto-browserify uses (poltergeist-engine D8). |

Only the `node:`-prefixed specifiers are aliased. PGlite's own guarded imports of bare `fs`, `zlib` and `stream` stay on Vite's browser-external stub, as in the spike.

Vitest runs on Node with no aliases, so every test exercises Node's real `node:crypto`, and the shim is tested separately against it.

### D3. The simulated rail and its idempotency

Steering `idempotency.md` says a key reused with a different request must get `409`, never be silently run. Core's webhook inbox dedupes by **event id** only: if the rail sent a second body under the same event id with a different amount, core would answer `duplicate` and ignore the new amount. So the rail needs its own key table, the same shape as core's:

- `tipjar_rail_requests(key uuid primary key, jar_id, kind, request text, payment_id uuid, events jsonb, created_at)`.
- `request` is the canonical JSON of the request (sorted keys, amounts as decimal strings). A claim is `INSERT … ON CONFLICT (key) DO NOTHING RETURNING`. No row back means the key exists: same `request` → reuse the stored response (`payment_id`, `events`), different `request` → `409`.
- The claim and the tip row are written in one transaction.
- Event bodies are stored, so a retry or double-tap redelivers **the same bytes**. Each attempt is signed at the current second, as a real rail re-signs retries.
- Event ids are derived from the key: `tip_<key>_pending`, `tip_<key>_captured`, `refund_<key>`, `chargeback_<key>`. The Payment_Id is a fresh `randomUUID()` stored as the response.

The UI mints one key per form or per tip action when it is shown and keeps it until the request succeeds (Requirement 2.3), so a double-tap reuses it. The send button is also disabled while in flight, but correctness does not depend on that.

Delivery (`deliver`): up to 3 attempts while the Handler answers 5xx or throws (Requirement 4.2). Each attempt is written to `tipjar_deliveries` (an append-only log, no amounts that anything sums). A 4xx is final.

Haunted_Rail (Requirement 4.1), per event: deliver; deliver again; for a capture, deliver its `payment.pending` after it; replay the first attempt's exact bytes and headers. The replay is within 5 minutes, so core answers `duplicate`. A stale replay (`401`) is shown by the "Replay a stale webhook" control, which re-sends a stored body with a timestamp 301 s old.

### D4. Refunds and chargebacks are both `payment.refunded`

Core knows three event types. A chargeback moves money the same way as a refund, so both are `payment.refunded`, with an extra body field `reason: "refund" | "chargeback"`. Core's parser ignores unknown fields, and stores the raw body, so the app reads the reason back from `webhook_events.raw_body`. The refund cap (captured − already reversed, checked in core inside the event's transaction) covers both kinds together, which is the rule we want: a tip that was refunded cannot also be charged back.

A refund before its capture is parked by core and applied when the capture arrives. That only happens in tests and the poltergeist; the UI offers reversals only on captured tips.

### D5. One jar at a time, jars archived instead of deleted

- `tipjar_jars(id uuid pk, creator text, goal text, jar_account_id uuid, clearing_account_id uuid, rail_secret text, created_at, archived_at)`. The goal is a decimal string of minor units, parsed to `bigint`.
- `tipjar_tips(payment_id uuid pk, jar_id, viewer text, message text, created_at)`: the checkout record the rail writes. It scopes the read model to one jar, so several jars can share one database (tests share one per file).
- "Reset" sets `archived_at` and creates a new seeded jar. Nothing is deleted, which fits an append-only ledger.

The Rail_Secret is 32 random bytes stored with the jar. It is a simulated rail on the user's own machine. A production deployment would keep the receiver's secret in an environment variable or a vault, never in a table.

### D6. The read model and the coffin use two independent sources

- **Per tip**: captured = amount of the applied `payment.captured` event; refunded and charged back = sums of applied `payment.refunded` events by `reason`; rejected reversals = `rejected` refund events with core's `rejection_reason`. All from `webhook_events` joined to `tipjar_tips`.
- **Total_In / Total_Out** come from the inbox (`webhook_events`, `status = 'applied'`, with a `ledger_transaction_id`).
- **Held** = −(sum of entries on the Jar_Account), from the ledger. **Rail_Clearing** = sum of its entries. **Ledger sum** = sum of entries on both accounts.
- **Coffin_Residual** = Total_In − Total_Out − Held.

If a bug ever lets the ledger and the inbox disagree (a double-posted capture, a refund that was recorded but rolled back), the residual is not zero. Reading both sides from the same table would hide that, so they are kept apart on purpose. All sums are computed in SQL as `numeric`/`bigint` and cast to text, then `BigInt(text)`: money never passes through a JS `number`.

### D7. Overlay alerts go through core's outbox

Showing the ghost straight from the "Send" click would show a tip that never committed, or show it twice on a retry. Core's handler already writes one outbox message per applied capture and refund, in the same transaction. The app drains it with `runOutboxOnce(db, { sender, clock })` after each rail action and on a 1 s interval. The sender looks up the tip's viewer, message and remaining amount and posts `{ key, topic, jarId, paymentId, viewer, message, amount, remaining }` on `BroadcastChannel('haunted-tip-jar')`, and to in-page listeners (the preview). Outbox delivery is at-least-once; the overlay keeps a set of seen keys, so a resend shows nothing new (Requirement 5.3). A `payment.refunded` message with `remaining = 0` fades the ghost.

BroadcastChannel reaches other tabs of the same browser. OBS's browser source is a separate browser process, so see Open question 3.

### D8. One tab owns the database

PGlite on IndexedDB must not be opened by two tabs at once. The app takes a Web Lock (`navigator.locks.request('haunted-tip-jar-db', { ifAvailable: true })`) before opening it, and holds it for the page's life. If the lock is taken, the jar view shows "The jar is open in another tab" and does not open the database (Requirement 1.4). The overlay never opens the database, so any number of overlay tabs can run next to the jar.

### D9. The poltergeist panel runs core's engine unchanged

`summon({ storm: generateStorm({ seed, size, ensureEveryFault: size >= 21 }), factory, target })` runs twice, once with `ossuaryFactory()` and once with `twinFactory()`. Each factory makes its own in-memory PGlite, so a storm never touches the jar's ledger (Requirement 7.4). The storm's shape is the engine's circle (a pot and 5 members, with payouts); see Open question 2. The panel shows the reports: `drift.total`, `conjured`, `lost`, per-fault `blocked`/`drifted`, the `blocked` epitaphs, and the counterexample's fault.

Runs are done one after the other (PGlite is single-threaded per instance and the page stays responsive between awaits). Default size 200, capped at 2 000.

**Per-fault money (Requirement 7.5).** A fault's `drift.total` is net: a double-tap moves money from the pot to a member, so seed 7 × 200 showed "8/8 drifted, 0.000000". Per-account sums of the fault can also cancel across ghosts. `moneyByFault(report)` in `src/poltergeist.ts` reads `report.drifted` (every drifted ghost has at least one non-zero account, by the report's own definition) and sums positive account drifts as lost and negative ones as conjured, ghost by ghost. The table shows those two columns. They are gross figures and can exceed the meter's net `lost`/`conjured`, which stay as the report gives them. Core is unchanged.

**The storm animation (Requirement 7.6).** The engine runs to completion before anything is known, so the panel animates in two stages. While it runs, a few looping ghosts cross both lanes. Then `replayGhosts(duel)` orders the ghosts by unit id (zero-padded, so storm order) and the panel reveals them over `REPLAY_MS` (2.4 s, any storm size): on Ossuary each one sinks into a tombstone; on Vibe Pay a drifted one escapes with a red glow, the drifted count rises and the meter fills in proportion to the drifted ghosts revealed. Lanes are `aria-hidden`; the counters and the final meters carry the meaning. Reduced motion shows a static "👻 → 🪦 / 💸" lane and skips the replay. The panel's own `role="status"` line (`storm-status`) holds phase text, "Replaying the storm…", then "Storm finished: drift …".

### D10. Money in the UI

`src/money.ts` is the only place text becomes money: `parseUsdc(text)` uses a regex (`^\d{1,7}(\.\d{1,6})?$`), splits on the point, pads the fraction to 6 digits, and builds a `bigint`. `formatUsdc(units)` prints all 6 decimals (`12.500000`); `formatUsdcShort` trims trailing zeros for the feed (`12.5`). No `Number`, `parseFloat`, `toFixed` or `Math` touches an amount. Goal-bar width is the only ratio: it is computed in `bigint` per-mille (`held * 1000n / goal`), clamped, and only then turned into a CSS percentage.

## Architecture

```
apps/haunted-tip-jar/
├── index.html
├── vite.config.ts           # aliases node:crypto, node:url, node:fs (D2)
├── vitest.config.ts         # Node environment by default; jsdom per component test file
├── playwright.config.ts     # builds and previews dist/ on :4174
├── src/
│   ├── main.tsx             # polyfills, Web Lock, open jar, render
│   ├── polyfills.ts         # Buffer global (D2)
│   ├── shims/node-crypto.ts, node-stubs.ts
│   ├── money.ts             # parseUsdc / formatUsdc (D10)
│   ├── db.ts                # PGlite (idb:// or memory) + drizzle, migrations, app tables
│   ├── jar.ts               # openJar / createJar / archive; TipJar service
│   ├── rail.ts              # Rail_Requests, event bodies, signing, delivery, haunting (D3, D4)
│   ├── readModel.ts         # tips(), coffin(), deliveryLog() (D6)
│   ├── overlayBus.ts        # outbox sender → BroadcastChannel; receiver with key dedupe (D7)
│   ├── seed.ts              # demo tips
│   ├── poltergeist.ts       # runs both summons (D9)
│   ├── ui/                  # App, JarView, TipForm, GoalBar, GhostFeed, TipRow, RailConsole,
│   │                        # DeliveryLog, Overlay, Coffin, PoltergeistPanel, DriftMeter
│   └── styles.css
├── tests/
│   ├── helpers.ts           # memory jar on a shared PGlite, fake clock
│   ├── unit/                # money, shim, rail, readModel, overlayBus, imports
│   ├── property/            # P1–P4
│   └── components/          # jsdom + Testing Library
└── e2e/demo.spec.ts         # Playwright, full demo path
```

### Service interface (`jar.ts`)

```ts
interface TipJar {
  readonly jarId: string;
  readonly info: { creator: string; goal: bigint; asset: 'USDC' };
  sendTip(key: string, req: { viewer: string; amount: bigint; message: string }): Promise<RailResult>;
  reverse(key: string, req: { paymentId: string; amount: bigint; reason: 'refund' | 'chargeback' }): Promise<RailResult>;
  replayStale(eventId: string): Promise<DeliveryOutcome>;
  setHaunted(on: boolean): void;
  tips(): Promise<TipView[]>;
  coffin(): Promise<CoffinReport>;
  deliveries(limit?: number): Promise<DeliveryRow[]>;
  drainOutbox(): Promise<number>;      // runOutboxOnce until nothing is claimed
}

type RailResult =
  | { ok: true; paymentId: string; outcomes: DeliveryOutcome[] }
  | { ok: false; status: 409; error: 'key reused with a different request' }
  | { ok: false; status: 400; error: string };
```

`openJar(db, { clock, haunted?, bus? })` returns the current jar or creates a seeded one. The clock is injected (`{ now: () => Date.now() }` in the app, a fake clock in tests).

### Data the app adds

Three app tables, created with `CREATE TABLE IF NOT EXISTS` after core's migrations: `tipjar_jars`, `tipjar_tips`, `tipjar_rail_requests` (D3, D5) and `tipjar_deliveries(seq bigint identity, jar_id, event_id, type, attempt, status, outcome, mode, at)`. None holds a balance or a total.

## UI

- **Jar** (`#/`): header with creator and "Reset"; goal bar (`held / goal`, text "12.5 of 100 USDC"); tip form; ghost feed of recent tips (each ghost has viewer, amount, message, and a status word: "Arrived", "Partly reversed", "Reversed"); per-tip Refund and Chargeback with an inline amount; rail console (Haunted rail switch, Replay a stale webhook) and delivery log; in-page overlay preview.
- **Overlay** (`#/overlay`): transparent `html, body` background; ghosts float up from the bottom and fade after 8 s; reversed ghosts fade at once with a "reversed" label.
- **Coffin** (`#/coffin`): the equation as a table (In, Out: refunds, Out: chargebacks, Held, Residual), the extra checks with pass/fail text, the defense counts, and the verdict in a live region.
- **Poltergeist** (`#/poltergeist`): seed and size inputs, "Summon the Poltergeist", two drift meters (Ossuary, Vibe Pay) with a text value and a meter element, per-fault table, blocked-ghost feed (epitaphs), and the twin's counterexample.

Visuals: dark candlelit palette, ghost cards with a soft glow. One ghost treatment (`--ghost-shape`, `--ghost-glow`) on tip cards, the preview, the overlay and the storm lanes; one tombstone treatment (`.tombstone`) for buried ghosts on the poltergeist page and in the coffin; an amber glow at the foot of the page and on cards (`--candle-glow`), and a slow flicker on the goal bar. Reversed tips and faded ghosts use muted text and a dashed outline instead of opacity, so their text keeps at least 4.5:1. Focus ring: 3 px solid outline with offset on every interactive element. `@media (prefers-reduced-motion: reduce)` turns off float and pulse animations (fade becomes an instant change). Layout is a single column below 720 px.

## Correctness Properties

Each property is a fast-check test under `tests/property/`, at least 25 runs, on one in-memory PGlite per file with fresh jars per run. Each was run against the deliberate break listed before being accepted; results are in tasks.md.

### Property 1: Delivery order and duplicates do not change the jar

*For any* valid history (1–5 tips, amounts 1–10⁹ units, each with 0–3 reversals of mixed reason whose sum is at most the capture), and *any* delivery schedule that sends every event 1–3 times in any order (reversals may come before their capture), the jar's Held, Rail_Clearing balance, per-tip captured/refunded/charged-back amounts and Coffin numbers equal those of a reference jar that received each event once in order, and both equal the model.

The test builds events with the real rail (`rail.ts` bodies, event ids and signing) and delivers through the real handler. **Validates: Requirements 4.4, 9.1, 3.6, 6.2.** Planned breaks: the rail derives a capture event id per attempt instead of per key; the read model sums refund events without `status = 'applied'`.

### Property 2: Reversals never exceed a tip, and the coffin balances

*For any* sequence of 1–40 operations, drawn from: send a tip; double-tap the last send (same key, same request); reuse a key with a different request; refund or charge back any existing tip by any amount from 1 to twice its capture; redeliver an earlier event; replay an earlier event stale; after every operation:

- every tip's reversals ≤ its capture;
- Coffin_Residual = 0, the jar's ledger sums to 0, Rail_Clearing = Total_In − Total_Out;
- Held = the model's accepted captures − accepted reversals, where the model accepts a reversal only if it fits the tip's remaining amount;
- a key reused with a different request returned `409` and changed nothing.

**Validates: Requirements 2.5, 3.3, 3.4, 6.1–6.4, 9.2.** Planned breaks: the coffin counts every refund event, not only applied ones; the rail mints a fresh event id when a key is reused with a different request instead of answering `409`.

### Property 3: Amounts round-trip exactly

*For any* `bigint` from 1 to 10¹² units, `parseUsdc(formatUsdc(x)) === x` and `parseUsdc(formatUsdcShort(x)) === x`; *for any* string with more than 6 decimals, `parseUsdc` rejects it. **Validates: Requirements 2.2, 9.3.** Planned break: parse through `Number(text) * 1e6`.

### Property 4: The browser crypto shim matches Node

*For any* byte strings, the shim's `createHash('sha1'|'sha256')`, `createHmac('sha256', key)` (multiple `update` calls) and `timingSafeEqual` give the same results as Node's `node:crypto`; and `signWebhook` → `verifyWebhook` round-trips when core's verify uses the shim. **Validates: Requirements 9.4, D2.** Planned break: drop the HMAC key (hash only the message).

## Testing Strategy

- **Unit** (Node): money, shim, rail (claim/409/redeliver, retry on 5xx), read model on hand-built histories, overlay bus dedupe, an import scan that fails if `src/` imports a core path other than the two public entries or contains a copy of a core function name such as `allocateRefund` or `claimOrReplay`.
- **Property**: P1–P4 above.
- **Component** (jsdom, Testing Library): tip form double-tap → one tip; refund then chargeback → second rejected with text; full reversal → "Reversed"; overlay dedupe and fade; coffin verdict; poltergeist panel on size 30 shows Ossuary 0 and twin non-zero.
- **E2E** (Playwright, built `dist/` on `vite preview`): the demo path in Requirement 10.3.
- Whole Vitest suite target: under 120 s.

## How the Ossuary power was used

The power has three parts. Its MCP server (`power/mcp/dist/server.js`) did **not** exist when implementation started: at task 1.1 (2026-11-21 23:09 IST) `power/mcp/` held only sources and tests from the other session, with no `dist/`. So `summon_poltergeist` and `query_ledger` were not available. Everything below was done with the two skills instead, and the MCP gaps are listed at the end of this section.

Where the skills changed what was produced is recorded per task in tasks.md and summarised here as implementation goes:

- **`money-code-review` check 3 (claim the key and write in one transaction, `ON CONFLICT DO NOTHING`).** Core's webhook inbox dedupes by event id only, so the rail needed its own key table (D3). The skill's check 3 set its shape before any code was written: the claim and the tip row are inserted in one transaction (task 2.2), so a crash cannot leave a claimed key with no tip, or a retry that 409s forever. Without the skill, the natural shortcut would have been to rely on core's event-id dedupe, which silently ignores a changed amount under a reused key instead of answering 409. Mutation D in task 3.3 shows that this case is now caught.
- **Check 2 (balances derived, never stored).** This is why the coffin reads Held from `entries` and In/Out from the inbox instead of one table. The unit test where a capture is posted straight to the ledger fails the coffin by name (task 3.1).
- **Check 5 (side effects via the outbox).** The overlay ghost comes from core's outbox, not from the Send click (task 4.1). That made the overlay at-least-once, so the receiver dedupes by outbox key, and it surfaced that core's outbox can send two messages from the same millisecond in either order.
- **Check 1 (integer minor units, no floats).** This produced `src/money.ts` as the only text-to-money path, plus a source scan (task 7.1) that bans `parseFloat`, `toFixed`, `Math.round`/`trunc` and `Number(<amount>)` on money files. The scan catches the `Math.round(Number(s) * 1e6)` parser that Property 3 alone cannot (task 1.3).
- **`poltergeist-test` checks 2–4.** These shaped Properties 1 and 2: duplicated and reordered deliveries compared against one in-order delivery, same-key replays, and refunds ≤ captured per tip, checked after every operation. Check 5 (crash between steps) is left to core's own atomicity property, because the app's only multi-statement write (rail claim + tip row) is a single transaction.
- **Where the skills found nothing.** Reviews of `money.ts`, `rail.ts`, `jar.ts`, `seed.ts`, `readModel.ts` and `overlayBus.ts` reported `clean` after the change above. The final review is in tasks.md, task 8.

MCP tools not used, and what replaced them:

- `summon_poltergeist`: replaced by calling the engine's `summon` directly: in a timing probe that chose the panel's default size (200 events ≈ 0.9 s per side in Node), in the component test, and in the app itself.
- `query_ledger`: replaced by the read model's SQL and direct `entries` sums in tests (`tests/helpers.ts` `entrySum`), and by reading `webhook_events` rows while debugging Property 1.
- **At the final checkpoint the server existed** (built by the other session after task 1.1), with tools `ossuary_check_money_code`, `ossuary_run_poltergeist` and `ossuary_explain_rule`. They were used over stdio. The money check flagged four count fields in `readModel.ts` named like amounts, which were renamed; that is the one change the MCP tool made. The poltergeist tool confirmed Ossuary at drift 0 for seed 7. So the MCP tools were **not** available for tasks 1–7 (design, rail, read model, properties, UI) and were used only for the final review (tasks.md, task 8).

## Open questions

1. **README row.** The spec prompt asks for a README row, but this session may only write under `apps/haunted-tip-jar` and `.kiro/specs/haunted-tip-jar`. The proposed row is in `apps/haunted-tip-jar/README.md`; whoever owns `README.md` should paste it into the table:
   `| apps/haunted-tip-jar | Streamer tips with refunds, chargebacks and a "count the coffin" reconciliation, built through the power. Static, PGlite in the browser |`
2. **A tip-shaped storm.** The poltergeist's storm is circle-shaped (pot, members, payouts). The tip jar has no payouts, so the panel runs the engine's own Ossuary adapter, which uses the same `createWebhookHandler` the jar uses, rather than the jar's own accounts. A core change could let a SUT declare "no payout route" so the storm skips payout faults, and the jar could then be its own SUT. Not done: core is out of scope here.
3. **OBS is another process.** BroadcastChannel reaches only tabs of the same browser. A real OBS browser source would need a relay (a tiny WebSocket or a hosted channel), which conflicts with "no server". The overlay works in any browser tab next to the jar, and the in-page preview shows the same ghosts.
4. **A browser entry in core.** The app aliases `node:url` and `node:fs` only because `@ossuary/core`'s root entry loads `db/migrate.ts`. A `@ossuary/core/browser` entry (everything except `createDb` and `runMigrations`) would let apps drop the stubs. Proposed for core; not done here.
5. **Reason on reversals.** Core's refund event has no `reason`. The app adds it to the body and reads it back from `raw_body`. If core grows a `payment.charged_back` type, the rail should switch to it.
6. **Stale replays in Haunted_Rail.** A real stale replay needs the clock to move 5 minutes. The haunted run replays immediately (core answers `duplicate`); the stale case is a separate control that signs with a timestamp 301 s in the past.
