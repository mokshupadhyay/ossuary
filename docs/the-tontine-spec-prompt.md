# the-tontine spec prompt

Create a new spec named `the-tontine` for `apps/the-tontine`, built on `packages/core` (ledger, idempotency, signed
webhooks, outbox) and `packages/core/src/poltergeist` (the poltergeist engine). Follow `.kiro/steering/*.md`.

## What it is
A rotating savings circle (chit fund in India, susu in West Africa, tanda in Mexico, hundreds of millions of users).
N members each contribute a fixed amount every round; each round the whole pot goes to one member, in turn, until
everyone has received it once. The story: "Tontines were banned for being deadly. We kept the good half."

## Hard constraints
- **Static, runs entirely in the browser.** Vite + React + TypeScript. The ledger runs on PGlite in the browser (IndexedDB
  persistence). No server, no database to host. It must deploy to static hosting and a judge must be able to use it with
  no sign-up. If `packages/core` imports Node-only modules (for example `node:crypto`), the design must say how it runs
  in the browser (Web Crypto adapter or a browser entry) without changing its behavior or weakening its tests.
- Money is bigint minor units everywhere. No floats, no mutable balances. Every money movement goes through
  `postTransaction`/`refund` with an idempotency key. Use testnet-style fake USDC; no real money anywhere.
- It is the second app of a Skeleton Crew entry, so it must be built from the skeleton, not around it. Do not copy
  core code into the app.

## Experience (Design and Presentation are 40% of the score, so this matters as much as the logic)
- A candlelit table: each member is a candle. A paid member's candle is lit; a late member's is guttering. The pot is a
  coffin of coins at the center that passes to this round's member with a short animation.
- Create a circle (name, members, contribution, rounds), record contributions, see whose turn it is, run the payout, handle a
  missed payment (the circle waits, nobody is paid twice), and a clear history timeline with each entry's idempotency key.
- Accessible: keyboard operable, visible focus, colour is never the only signal, respects reduced motion, readable at
  mobile width.
- **Summon the Poltergeist**: a button that runs the poltergeist storm against this circle's ledger live in the browser and
  shows the drift meter, the blocked ghosts with their epitaphs, and the split screen against the Vibe Pay twin
  (`packages/twin`). The Ossuary side must stay at drift 0; the twin must visibly lose money.
- Pre-seeded demo circle so the first screen is never empty, plus a "reset" control.

## Required property tests (fast-check)
- Over any sequence of contributions, missed payments, payouts and duplicate or replayed operations, the pot never goes
  negative, every member is paid at most once per round, and total money in equals total money out plus the pot.
- A duplicate contribution or payout with the same idempotency key changes nothing.
- A circle's ledger always sums to zero.
Each property must be mutation-checkable. At least 25 runs per property, suite under 120 seconds, and show each property
failing against a deliberate break before ticking its task.

## Also required
- Component tests for the main flows, and one Playwright test that runs the full demo path (seeded circle, pay a round,
  summon the poltergeist) against the built app.
- A production build that passes with no type errors, and a deploy-ready `dist/`.
- Update the README table row for this app.

## Process
Generate requirements, then design, then tasks. Do not stop between them: record ambiguities under "Open questions" at
the end of design.md and continue. Then implement every task, one at a time, running `pnpm test`, the type check and the
build after each, and tick the task only when it passes. Do not commit; the user commits per task.
