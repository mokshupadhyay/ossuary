# Haunted Tip Jar 🫙👻

Tips for streamers, where every tip floats onto the stream as a ghost, and the money is poltergeist-proof. The second app of the Ossuary Skeleton Crew entry, built on `packages/core` through the Ossuary Kiro power.

It runs entirely in your browser: Postgres is PGlite in IndexedDB, and the payment rail is simulated in the page. There is no server and no sign-up. Amounts are **fake testnet USDC**, and no real money moves anywhere.

## What it shows

- **Many-to-one money.** Viewers tip one creator. A goal bar fills up.
- **Signed webhooks for everything.** Each tip, refund and chargeback is an event from a simulated rail, signed with core's HMAC scheme and applied by core's `createWebhookHandler`. Duplicates, replays and out-of-order deliveries are real cases here.
- **Refunds and chargebacks, capped.** The creator refunds a tip, or a simulated bank charges it back. Core's refund cap rejects anything over what the tip received ("Rejected: more than this tip received").
- **A haunted rail.** Flip the switch and every event arrives twice, with a late `pending` and an exact replay. A stale (5-minute-old) replay is refused with `401`. The delivery log shows each attempt.
- **An OBS overlay** at `#/overlay`, with a transparent background. Ghosts come from core's **outbox**: one per message, however often a message is resent. A fully reversed tip's ghost fades.
- **Count the coffin** at `#/coffin`: total in − total out − held = **0**. In and out are read from core's webhook inbox, and held from the ledger entries, so a disagreement between the two shows up.
- **Summon the Poltergeist** at `#/poltergeist`: the same seeded storm runs against Ossuary and the vibe-coded Vibe Pay twin. Ossuary stays at drift 0.000000; for seed 7 and 200 events the twin drifts 5871.276351 USDC.
  - While the storm runs, ghosts cross both panels. A 2.4-second replay follows: on Ossuary every ghost sinks into a tombstone; on Vibe Pay the ones that drifted escape, its drifted count rises and its meter climbs red. With `prefers-reduced-motion` the lanes are static and the replay is skipped. A polite live region announces "Storm finished: drift 0.000000 USDC on Ossuary, 5871.276351 USDC on Vibe Pay".
  - "Ghosts by fault" shows what the twin **lost** and **conjured** per fault, added up ghost by ghost. A net figure would hide a double-tap: the pot loses what a member gains, so seed 7's 8/8 drifted double-taps net to 0.000000, but show 2487.332129 lost and 2487.332129 conjured.

## Run it

```sh
pnpm install
pnpm --filter haunted-tip-jar dev        # http://localhost:5173
pnpm --filter haunted-tip-jar build      # type check + static site in apps/haunted-tip-jar/dist/
pnpm --filter haunted-tip-jar preview    # serves dist/ on http://localhost:4174
```

`dist/` is plain static files with relative paths (`base: './'`) and hash routing, so it deploys to any static host or sub-path with no rewrites. Only one tab can own the jar's database at a time; the overlay and the poltergeist work in any number of tabs.

## Tests

```sh
pnpm --filter haunted-tip-jar test       # Vitest: unit, property and component tests (about 10 s)
pnpm --filter haunted-tip-jar e2e        # Playwright: builds, previews, runs the demo path and the 390 px checks
```

| Property (fast-check) | File | Deliberate break it caught |
|---|---|---|
| P1: any duplicates and any order give the same jar as one in-order delivery | `tests/property/deliveryOrder.property.ts` | new reversal event id per attempt; reversal id from the payment instead of the key |
| P2: reversals never exceed a tip, and the coffin balances after every step | `tests/property/reversalCap.property.ts` | refunds summed without `status = 'applied'`; key reuse with a changed request run instead of `409` |
| P3: amounts round-trip exactly | `tests/property/money.property.ts` | parsing through `Number(text) * 1e6` (truncated) |
| P4: the browser `node:crypto` stand-in matches Node byte for byte | `tests/property/cryptoShim.property.ts` | HMAC that ignores its key |

`e2e/demo.spec.ts` walks the demo at desktop size, including the storm animation, the live-region text and the double-tap row. `e2e/mobile.spec.ts` runs at 390 px: no horizontal scroll on any page, visible focus rings, and the still storm under reduced motion. Text contrast was checked at 390 px and 1280 px against 4.5:1; reversed tips and faded ghosts use muted text and dashed outlines rather than opacity so they pass.

## How core runs in a browser

Core is unchanged. The app's `vite.config.ts` replaces `node:crypto` with `src/shims/node-crypto.ts` (`@noble/hashes`, synchronous like Node's), and stubs `node:url`/`node:fs`, which only `runMigrations` uses; the app migrates with `applyEmbeddedMigrations`. `src/polyfills.ts` installs the `buffer` polyfill. Tests run on Node's real modules, and P4 checks the shim against them. Details: `.kiro/specs/haunted-tip-jar/design.md` D2.

## Root README row

This session could not edit the root `README.md` (see design.md, Open question 1). The row for its table:

```
| `apps/haunted-tip-jar` | Streamer tips with refunds, chargebacks, an OBS ghost overlay and a "count the coffin" reconciliation. Static, PGlite in the browser, built through the power |
```
