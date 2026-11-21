# haunted-tip-jar spec prompt

Create a new spec named `haunted-tip-jar` for `apps/haunted-tip-jar`, built on `packages/core` and the poltergeist engine.
Follow `.kiro/steering/*.md`.

## What it is
A tip jar for a streamer or creator, with an overlay where each tip floats in as a ghost. It shows a different shape of money
flow from the Tontine: many-to-one, with refunds and chargebacks, and an end-of-stream "counting the coffin"
reconciliation. This is the second app of the Skeleton Crew entry, and it is **built through the Ossuary Kiro power**: use
the power's skills (money-code-review, poltergeist-test) and MCP server while building it, and record in design.md where the
power changed what Kiro produced.

## Hard constraints
- Static, runs in the browser on PGlite, same rules as the-tontine (no server, bigint minor units, idempotency keys, fake
  USDC, no real money). Do not copy core code into the app.
- Tips arrive as signed webhook events (simulated in-app, signed with the same scheme as production) through the core
  webhook handler, so duplicates, replays and out-of-order delivery are real cases here too.

## Experience
- Two views: the **jar** (a viewer sends a tip with a message; amounts, a goal bar, a recent-tips ghost feed) and the
  **overlay** (a transparent-background page for OBS, where each tip floats in as a ghost with its message).
- Refund and chargeback flow: the creator or a simulated bank reverses a tip; the ghost fades and the ledger shows the
  reversal, never more than was received.
- **Count the coffin**: an end-of-stream reconciliation screen that proves total in minus total out minus held equals zero.
- **Summon the Poltergeist** button with the drift meter and blocked-ghost feed, like the Tontine. Same accessibility rules.

## Required property tests (fast-check)
- A tip delivered any number of times, in any order relative to its refund, produces the same final balances as delivering it
  once in order.
- Refunds and chargebacks never exceed what was received. The coffin always reconciles to zero.
Each property must be mutation-checkable, at least 25 runs, suite under 120 seconds, shown failing against a deliberate break.

## Also required
- Component tests, one Playwright test of the full demo path, a passing production build, a deploy-ready `dist/`, README row.

## Process
Same as the-tontine: requirements, design, tasks without stopping (ambiguities under "Open questions"), then implement
every task one at a time, verify after each, tick only when passing. Do not commit.
