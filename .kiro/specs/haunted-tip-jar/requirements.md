# Requirements Document

## Introduction

`haunted-tip-jar` is the second app of the Ossuary Skeleton Crew entry, in `apps/haunted-tip-jar`. A streamer or creator opens a tip jar; viewers send tips with a message; each tip floats in as a ghost on a stream overlay. The creator can refund a tip and a simulated bank can charge one back. At the end of the stream, "Count the coffin" proves that everything that came in, minus everything that went out, minus what the jar holds, is exactly zero.

It shows a different money shape from the Tontine: **many-to-one**, with **reversals** (refunds and chargebacks) and an end-of-stream **reconciliation**. It is built from the skeleton, not around it:

- every tip and every reversal is a **signed webhook** from a simulated rail, verified and applied by core's `createWebhookHandler`, so duplicate, replayed and out-of-order deliveries are real cases;
- the ledger, idempotency, refund cap and outbox are core's; no core code is copied into the app;
- the overlay alerts are side effects sent from core's **outbox**;
- the "Summon the Poltergeist" panel runs core's poltergeist engine live in the page against Ossuary and the Vibe Pay twin.

The app is static and runs in the browser on PGlite (IndexedDB persistence). There is no server, no sign-up and no real money: the asset is fake testnet-style USDC with 6 decimals.

The app is built through the Ossuary Kiro power: its `money-code-review` and `poltergeist-test` skills are applied while building, and design.md records where they changed the result.

## Glossary

- **App**: the static web app in `apps/haunted-tip-jar`.
- **Core**: `@ossuary/core` (ledger, idempotency, webhooks, outbox) and `@ossuary/core/poltergeist`.
- **Jar**: one creator's tip jar. It owns two core accounts: the Jar_Account and the Rail_Clearing account.
- **Jar_Account**: a core `revenue` account holding the creator's tips. Credit-normal: what the jar holds is minus its entry sum.
- **Rail_Clearing**: a core `asset` account with `allow_overdraft = true`, the rail's side of every tip and reversal.
- **USDC**: the single asset. Amounts are `bigint` minor units (1 USDC = 1 000 000 units).
- **Viewer**: someone sending a tip. Named by free text; there are no accounts or logins.
- **Tip**: one payment from a Viewer to the Jar, identified by a Payment_Id (UUID), with a viewer name, a message and an amount.
- **Reversal**: money leaving the Jar for one Tip: a **Refund** (asked for by the creator) or a **Chargeback** (raised by the simulated bank).
- **Rail**: the simulated payment rail inside the App. It records requests, builds event bodies, signs them with the Rail_Secret in core's scheme (`ossuary-timestamp`, `ossuary-signature`, HMAC-SHA256 over `<timestamp>.<body>`) and delivers them to the Handler.
- **Rail_Secret**: 32 random bytes created per Jar, shared by the Rail and the Handler. Simulated; never a real key.
- **Handler**: core's `createWebhookHandler`, configured with the Jar's accounts and the Rail_Secret.
- **Rail_Request**: one request to the Rail (a tip checkout, a refund or a chargeback) under a client-generated Idempotency_Key.
- **Idempotency_Key**: a UUID minted by the client for one intended action and reused on every retry or double-tap of that action.
- **Delivery**: one attempt to hand a signed event to the Handler, with its outcome (`applied`, `duplicate`, `parked`, `rejected`, `ignored`, `unauthorized`, `invalid` or `error`).
- **Haunted_Rail**: a Rail mode that, for each event, also delivers duplicates, a late `payment.pending`, and an exact-bytes replay.
- **Overlay**: the page for OBS at `#/overlay`, with a transparent background, where each tip floats in as a ghost.
- **Overlay_Bus**: a `BroadcastChannel` that carries outbox messages from the Jar page to Overlay pages in the same browser.
- **Coffin**: the end-of-stream reconciliation screen.
- **Coffin_Residual**: Total_In − Total_Out − Held. Must be exactly 0.
- **Total_In**: the sum of applied capture events for the Jar's tips, read from core's webhook inbox.
- **Total_Out**: the sum of applied refund events (refunds plus chargebacks) for the Jar's tips, read from core's webhook inbox.
- **Held**: what the Jar_Account holds, read from core's ledger entries.
- **Poltergeist_Panel**: the "Summon the Poltergeist" view.
- **Twin**: the Vibe Pay twin in `packages/twin`.

## Requirements

### Requirement 1: Jar setup and persistence

**User Story:** As a creator, I want a tip jar that is ready the moment I open the page, so that a judge can try it without signing up.

#### Acceptance Criteria

1. WHEN the App starts in a browser, THE App SHALL open a PGlite database persisted in IndexedDB and apply core's migrations with `applyEmbeddedMigrations`.
2. WHEN no Jar exists, THE App SHALL create one with a creator name, a goal, a new Jar_Account, a new Rail_Clearing account and a new Rail_Secret, and seed it with demo tips that include at least one refund, one chargeback and one rejected over-cap reversal, all delivered through the Rail and the Handler.
3. WHEN the user presses "Reset" and confirms, THE App SHALL archive the current Jar and create a fresh seeded Jar. Ledger entries SHALL never be updated or deleted.
4. WHILE another tab already holds the Jar database, THE App SHALL show a message saying so and SHALL NOT open the database a second time.
5. THE App SHALL store no balance or total in any column. Amounts SHALL exist only as core ledger entries, core inbox rows and Rail_Request bodies.

### Requirement 2: Sending a tip

**User Story:** As a viewer, I want to send a tip with a message, so that the creator sees it on stream.

#### Acceptance Criteria

1. THE tip form SHALL take a viewer name (1–40 characters), an amount in USDC and a message (0–140 characters).
2. THE App SHALL parse the amount from its decimal text to `bigint` minor units without passing through a floating-point number. It SHALL reject amounts with more than 6 decimals, zero, negative amounts, non-numeric text and amounts above 1 000 000 USDC, with a message naming the problem.
3. WHEN the form is shown, THE App SHALL mint an Idempotency_Key for it. Pressing "Send" any number of times, including a double-tap while a send is in flight, SHALL reuse that key. A new key SHALL be minted only after the send succeeds.
4. WHEN a tip is sent, THE Rail SHALL record the Rail_Request together with its response (a new Payment_Id and the event bodies), create the Tip, and deliver signed `payment.pending` and `payment.captured` events to the Handler.
5. WHEN the same Idempotency_Key arrives with the same request, THE Rail SHALL redeliver the same event bytes and SHALL NOT create a second Tip. WHEN it arrives with a different request, THE Rail SHALL answer `409 Conflict` and deliver nothing.
6. WHEN the capture is applied, THE Jar view SHALL show the tip in the recent-tips ghost feed and move the goal bar.

### Requirement 3: Refunds and chargebacks

**User Story:** As a creator, I want to refund a tip, and to see a bank chargeback, without ever paying back more than I received.

#### Acceptance Criteria

1. EACH tip in the Jar view SHALL offer "Refund" (creator) and "Chargeback" (simulated bank) actions, each with its own Idempotency_Key, reused on double-tap.
2. A refund SHALL default to the tip's remaining amount and MAY be partial. A chargeback SHALL ask for the tip's full captured amount.
3. THE Rail SHALL deliver each reversal as a signed `payment.refunded` event with a `reason` of `refund` or `chargeback`. THE Handler's refund cap SHALL decide whether it applies.
4. WHEN a reversal would take the tip's total reversals above its captured amount, THE Handler SHALL reject it, THE ledger SHALL not change, and THE App SHALL say "Rejected: more than this tip received" next to the tip.
5. WHEN a tip has been fully reversed, ITS ghost SHALL fade in the feed and on the Overlay, and THE tip SHALL show "Reversed" in text, not only by colour.
6. THE Jar view SHALL show each tip's captured amount, refunded amount and charged-back amount, read from core's inbox and ledger.

### Requirement 4: Haunted rail and the delivery log

**User Story:** As a judge, I want to watch the rail misbehave and see the jar shrug it off.

#### Acceptance Criteria

1. THE Jar view SHALL offer a "Haunted rail" switch. WHILE it is on, FOR each event THE Rail SHALL deliver the event, deliver it again, deliver `payment.pending` after the capture, and replay the first delivery's exact bytes and headers.
2. THE Rail SHALL retry a Delivery that returns a 5xx status or throws, up to 3 attempts, re-signing each attempt at the current second.
3. THE App SHALL show a delivery log with each Delivery's event, attempt and outcome, newest first.
4. WHEN a Haunted_Rail run completes, THE Jar's balances SHALL equal those of the same events delivered once, in order.

### Requirement 5: The overlay

**User Story:** As a streamer, I want an OBS browser source where each tip floats in as a ghost with its message.

#### Acceptance Criteria

1. THE App SHALL serve the Overlay at `#/overlay`, with a transparent page background and no controls.
2. Overlay alerts SHALL be side effects sent from core's outbox: THE App SHALL drain the outbox with `runOutboxOnce` and a sender that publishes each message, with its idempotency key, on the Overlay_Bus.
3. THE Overlay SHALL show at most one ghost per outbox idempotency key, however many times a message is sent.
4. WHEN a `payment.refunded` message arrives for a tip that is now fully reversed, THE Overlay SHALL fade that tip's ghost.
5. THE Jar view SHALL include an in-page Overlay preview fed by the same bus messages.

### Requirement 6: Count the coffin

**User Story:** As a creator, at the end of the stream I want proof that the money adds up.

#### Acceptance Criteria

1. THE Coffin SHALL show Total_In, Total_Out (split into refunds and chargebacks), Held and Coffin_Residual, each in USDC with all 6 decimals.
2. Total_In and Total_Out SHALL be read from core's webhook inbox; Held SHALL be read from core's ledger entries. The two sources SHALL be independent.
3. THE Coffin SHALL also show: the sum of all of the Jar's ledger entries (must be 0), the Rail_Clearing balance (must equal Total_In − Total_Out), the number of tips whose reversals exceed their capture (must be 0), and counts of deliveries absorbed by each defense (duplicates, replays rejected, parked, rejected reversals).
4. WHEN every check holds, THE Coffin SHALL say "The coffin balances" and show residual 0.000000. WHEN any check fails, IT SHALL name the failing check.

### Requirement 7: Summon the Poltergeist

**User Story:** As a judge, I want to throw the same storm at Ossuary and at a vibe-coded twin and see who loses money.

#### Acceptance Criteria

1. THE Poltergeist_Panel SHALL take a seed (default 7) and a storm size (default 200, 50–2000), and run `generateStorm` and `summon` live in the page against `ossuaryFactory()` and `twinFactory()`.
2. THE panel SHALL show a drift meter for each side in USDC, conjured and lost amounts, per-fault blocked and drifted counts, and a feed of blocked ghosts with their epitaphs.
3. FOR any seed, THE Ossuary side SHALL show drift 0.000000; THE Twin side SHALL show its drift and the counterexample's fault.
4. WHILE a storm runs, THE panel SHALL disable its button and announce progress in a polite live region. Running a storm SHALL not touch the Jar's ledger.
5. THE per-fault table SHALL never show zero money for a fault with drifted ghosts: it SHALL show the twin's lost and conjured amounts per fault, summed ghost by ghost and account by account, instead of the net drift. THE meters SHALL keep the report's per-account totals.
6. WHILE a storm runs and for a short replay after it (about 2.4 s), THE panel SHALL animate ghosts across an Ossuary lane and a Vibe Pay lane; the Vibe Pay meter SHALL climb as its drifted ghosts are revealed, and Ossuary's SHALL stay at zero. WHEN the user prefers reduced motion, THE panel SHALL show a static lane and skip the replay. WHEN the final numbers are shown, a polite live region SHALL announce "Storm finished: drift X USDC on Ossuary, Y USDC on Vibe Pay".

### Requirement 8: Accessibility and presentation

**User Story:** As any user, I want to use the jar with a keyboard, a screen reader, or on a phone.

#### Acceptance Criteria

1. EVERY control SHALL be reachable and operable by keyboard, with a visible focus indicator.
2. Colour SHALL never be the only signal: states (applied, reversed, rejected, drift) SHALL also be shown in text or icons with text alternatives.
3. WHEN the user prefers reduced motion, THE App SHALL not animate ghosts or the goal bar; ghosts SHALL appear and fade without movement.
4. THE App SHALL be readable at 360 px width without horizontal scrolling, and checked at 390 px and 1280 px: no horizontal scroll, text contrast at least 4.5:1 (reversed and faded tips included), visible focus rings. A Playwright test covers 390 px.
5. New tips and Coffin results SHALL be announced through polite live regions.

### Requirement 9: Correctness properties

**User Story:** As the Ossuary team, I want fast-check properties that prove the jar's money is poltergeist-proof, each shown to fail against a deliberate break.

#### Acceptance Criteria

1. **Delivery order.** FOR any valid set of tips and reversals (each tip's reversals sum to no more than its capture), delivering each event any number of times (1–3), in any order, including reversals before their capture, SHALL give the same Held, Rail_Clearing balance, per-tip captured and reversed amounts and Coffin numbers as delivering each once in order, and those SHALL match a model.
2. **Reversal cap and the coffin.** FOR any sequence of 1–40 operations (tips, double-taps, refunds and chargebacks of any amount including over-cap, duplicate deliveries and replays), after every operation each tip's reversals SHALL be at most its capture, the Coffin_Residual SHALL be 0, the Jar's ledger SHALL sum to 0, and Held SHALL equal the model's accepted captures minus accepted reversals.
3. **Amount parsing.** FOR any `bigint` in range, formatting then parsing SHALL return it exactly; no money path SHALL use a floating-point number.
4. **Browser crypto shim.** FOR any key and inputs, the App's `node:crypto` stand-in SHALL produce the same bytes as Node's `node:crypto` for every function core uses.
5. EACH property SHALL run at least 25 times, the App's whole test suite SHALL finish in under 120 seconds, and EACH property SHALL be shown failing against a recorded deliberate break before its task is ticked.

### Requirement 10: Build, tests and delivery

**User Story:** As the Ossuary team, I want the app to ship as a static site with tests that prove the demo path works.

#### Acceptance Criteria

1. `pnpm --filter haunted-tip-jar build` SHALL type-check with no errors and write a deploy-ready static site to `apps/haunted-tip-jar/dist/` that works from any base path.
2. Component tests SHALL cover the tip form (including double-tap), reversals (including a rejected over-cap reversal), the Overlay, the Coffin and the Poltergeist_Panel.
3. ONE Playwright test SHALL run the full demo path against the built app: seeded jar, send a tip, refund it, see the ghost fade, count the coffin, summon the poltergeist and see Ossuary at drift 0 and the twin drifting.
4. THE App SHALL import core only through its public entries `@ossuary/core` and `@ossuary/core/poltergeist`, and SHALL contain no copy of core code.
5. THE README row for the app SHALL describe it (see design.md Open questions: README.md is outside this session's write scope).
