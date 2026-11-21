# Requirements Document

## Introduction

`the-tontine` is the second app of the Ossuary Skeleton Crew entry, in `apps/the-tontine`. It is a rotating savings circle (a chit fund in India, a susu in West Africa, a tanda in Mexico). N members each contribute a fixed amount every round, and each round the whole pot goes to one member, in turn, until every member has received it once. The story: "Tontines were banned for being deadly. We kept the good half."

The app is built **from** the skeleton, not around it:

- every money movement goes through `packages/core`: contributions arrive as signed webhooks through `createWebhookHandler` (which posts a `capture` with `postTransaction`), payouts are `postTransaction` transfers with an idempotency key, and the outbox (`runOutboxOnce`) delivers receipts;
- balances come from core's `balance()`, the sum of ledger entries;
- the "Summon the Poltergeist" button runs `@ossuary/core/poltergeist` against the circle's own database, and against the Vibe Pay twin (`packages/twin`), live in the page.

It is a static site. Vite, React and TypeScript, with the ledger on PGlite in the browser, persisted to IndexedDB. There is no server and no sign-up. Money is testnet-style fake USDC (6 decimals) held as `bigint` base units. No real money, chain or bank is touched.

Design and presentation carry 40% of the score, so the experience requirements (a candlelit table, a coffin of coins, accessibility) are requirements, not polish.

## Glossary

- **App**: The static web app in `apps/the-tontine`.
- **Core**: `packages/core` (`@ossuary/core`), the skeleton. The App imports it and never copies its code.
- **Poltergeist**: `@ossuary/core/poltergeist`, the storm generator, runner, drift meter and report.
- **Twin**: The Vibe Pay twin, `@ossuary/twin`, run through the Poltergeist's `twinFactory`.
- **Ledger**: Core's tables (accounts, transactions, entries, idempotency records, webhook inbox, outbox) in the App's PGlite database.
- **Circle**: One savings circle: a name, an ordered list of 2 to 12 Members, a Contribution and its Rounds.
- **Member**: A participant of a Circle, with a name, a position (0-based, the entry order) and a Wallet.
- **Contribution**: The fixed amount every Member pays each Round, a positive `bigint` of USDC base units.
- **Round**: One cycle of a Circle, numbered from 1. A Circle has exactly as many Rounds as Members.
- **Recipient**: The Member who receives the Pot in a Round: the Member at position `round − 1`.
- **Due**: The obligation of one Member to pay the Contribution in one Round. Each Due has a client-generated Idempotency_Key and a payment id, minted once when the Circle is created.
- **Current_Round**: The lowest-numbered Round whose Payout has not happened. A Circle whose every Round is paid out is **Complete**.
- **Pot**: The Circle's revenue account in the Ledger. It holds Contributions until they are paid out.
- **Wallet**: A Member's liability account in the Ledger. It holds what the Circle has paid that Member.
- **Clearing_Account**: The Circle's asset account with overdraft allowed, the rail side of every Contribution.
- **Rail**: The simulated payment rail inside the App. It turns a recorded Contribution into a signed `payment.captured` webhook and delivers it to Core's webhook handler.
- **Payout**: Moving the Pot (Contribution × number of Members) to the Recipient's Wallet with a `transfer` through `postTransaction`, under the Round's Payout_Key.
- **Payout_Key**: The client-generated Idempotency_Key of one Round's Payout, minted once when the Circle is created.
- **Idempotency_Key**: A lowercase UUID that identifies one intended money movement. Every tap, retry or tab that means the same movement reuses it.
- **Missed_Payment**: A Due the organiser has marked as late. It moves no money.
- **Candle**: The visual for one Member. Lit when their Current_Round Due is paid, guttering when it is marked missed, unlit when it is still owed.
- **Coffin**: The visual for the Pot at the centre of the table, holding coins.
- **Timeline**: The Circle's history: every Contribution, Payout, Missed_Payment and receipt, in order, each money entry with its Idempotency_Key.
- **Seance**: One "Summon the Poltergeist" run: the same seeded Storm against Ossuary on the App's database and against the Twin, shown side by side.
- **Demo_Circle**: The pre-seeded Circle that the App creates on first start.
- **Runtime**: The App's database lifecycle: open, seed, reset. The browser Runtime persists to IndexedDB; the test Runtime is in memory.

---

## Requirements

### Requirement 1: Static, browser-only delivery

**User Story:** As a judge, I want to open a link and use the app at once, so that I can try it with no server, no database to host and no sign-up.

#### Acceptance Criteria

1. THE App SHALL build with `vite build` to a `dist/` directory of static files that runs from any static host, under any base path.
2. THE App SHALL run its Ledger on PGlite in the browser and persist it to IndexedDB, so that a reload keeps every Circle and its history.
3. THE App SHALL make no network request other than loading its own static assets.
4. THE App SHALL NOT require an account, a sign-up, a key or any configuration to use.
5. WHERE Core imports Node-only modules (`node:crypto`, `node:url`) or uses the `Buffer` global, THE App SHALL provide browser adapters through its bundler configuration, without editing Core and without changing Core's behavior or its tests.
6. THE `node:crypto` adapter SHALL return byte-identical results to Node's `node:crypto` for every function Core uses (`createHash` with `sha256` and `sha1`, `createHmac` with `sha256`, `timingSafeEqual`, `randomUUID` format), and a test SHALL check this against the real module.
7. WHILE the App's database is open in one browser tab, THE App SHALL refuse to open the same database in a second tab and SHALL say so, so that two tabs never write the same IndexedDB copy.
8. THE production build SHALL pass the TypeScript type check with no errors.

### Requirement 2: Money handling

**User Story:** As a member, I want every amount to be exact, so that nobody loses a cent to rounding.

#### Acceptance Criteria

1. THE App SHALL hold every amount as a `bigint` of USDC base units (6 decimals) and SHALL NOT convert an amount to a JavaScript `number` at any point.
2. THE App SHALL carry the asset code `USDC` with every amount it shows, and SHALL use one asset only, with no conversion.
3. WHEN the user types a Contribution, THE App SHALL parse it from a decimal string with at most 6 fractional digits into base units exactly, and SHALL reject zero, negative values, more than 6 fractional digits, non-numeric input and amounts above 1,000,000 USDC with a message naming the problem.
4. WHEN the App shows an amount, THE App SHALL format it exactly from base units, with at least 2 and at most 6 fractional digits and thousands separators, and the asset code.
5. THE App SHALL derive every balance it shows (Pot, Wallets, money in, money out) from Ledger entries through Core, and SHALL NOT store a balance anywhere.
6. Every money movement SHALL go through Core: Contributions through Core's webhook handler (which calls `postTransaction`), Payouts through `postTransaction`. THE App SHALL NOT write to Core's tables directly.

### Requirement 3: Creating a Circle

**User Story:** As an organiser, I want to set up a circle with its members and contribution, so that we can start saving together.

#### Acceptance Criteria

1. THE App SHALL let the user create a Circle by entering a name (1 to 60 characters after trimming), 2 to 12 member names (each 1 to 40 characters after trimming, unique without regard to case) and a Contribution.
2. THE App SHALL show the number of Rounds, which equals the number of Members, and SHALL explain that each Member receives the Pot once, in the order entered.
3. IF any field is invalid, THEN THE App SHALL NOT create anything, SHALL mark each invalid field with a text message linked to it, and SHALL move focus to the first invalid field.
4. WHEN a Circle is created, THE App SHALL create its Clearing_Account (asset, overdraft allowed), its Pot (revenue) and one Wallet per Member (liability) through Core's `createAccount`, and SHALL mint, once, a Due with its own Idempotency_Key and payment id for every Member and Round, and a Payout_Key for every Round.
5. WHEN a Circle is created, THE App SHALL select it and show its table.

### Requirement 4: Recording Contributions

**User Story:** As an organiser, I want to record each member's contribution for the round, so that the pot fills up and everyone can see who has paid.

#### Acceptance Criteria

1. THE App SHALL accept a new Contribution only for the Current_Round of a Circle that is not Complete. IF a Contribution is recorded for another Round, THEN THE App SHALL reject it and move no money, except that repeating a Due that is already paid is always a no-op as in criterion 5.
2. WHEN a Contribution is recorded, THE Rail SHALL build a `payment.captured` event for the Due's payment id with the Contribution amount, the `USDC` asset, the Circle id and the Member id, whose event id is derived from the Due's Idempotency_Key. It SHALL sign the raw body with HMAC-SHA256 using Core's `signWebhook` at the current second, and deliver it to Core's `createWebhookHandler`.
3. THE App SHALL treat a Contribution as recorded only after the webhook handler returns `200` with outcome `applied` or `duplicate`.
4. IF the webhook handler returns a `5xx` status or throws, THEN THE Rail SHALL retry the same event, re-signed, up to 3 attempts in total, and THE App SHALL report a failure if none succeeds.
5. WHEN the same Contribution is recorded again (a double-tap, a retry, a second click after success), THE App SHALL reuse the Due's Idempotency_Key and payment id, and the Ledger SHALL change by nothing.
6. AFTER each Contribution, THE App SHALL run Core's outbox worker once, with a sender that records a receipt keyed by the outbox message's idempotency key, so that a receipt is recorded once per Contribution however often the worker runs.
7. WHILE a Contribution request for a Due is in flight, THE App SHALL disable that Due's button and show that it is being recorded.

### Requirement 5: Missed payments

**User Story:** As an organiser, I want to mark a member as late, so that the circle waits for them and nobody is paid out of a short pot.

#### Acceptance Criteria

1. THE App SHALL let the organiser mark an unpaid Due of the Current_Round as a Missed_Payment. Marking SHALL move no money, and marking the same Due again SHALL change nothing.
2. THE App SHALL NOT allow a Due that is already paid to be marked as missed.
3. WHILE any Due of the Current_Round is unpaid, THE App SHALL NOT perform the Payout, SHALL disable the payout control, and SHALL name the Members it is waiting for.
4. WHEN a late Member pays a Due that was marked missed, THE App SHALL record the Contribution as in Requirement 4 and show the Member as paid (late).

### Requirement 6: Payouts

**User Story:** As a member, I want the pot to go to the right person exactly once per round, so that the circle is fair.

#### Acceptance Criteria

1. WHEN the organiser runs the Payout for the Current_Round and every Due of that Round is paid, THE App SHALL call `postTransaction` with kind `transfer`, the Round's Payout_Key, a debit of the Pot and a credit of the Recipient's Wallet, each for Contribution × number of Members.
2. IF the Round is not the Current_Round, or any of its Dues is unpaid, THEN THE App SHALL reject the Payout and move no money, except that repeating the Payout of a Round already paid out is a no-op as in criterion 3.
3. WHEN the Payout for a Round is requested more than once (a double-tap, two concurrent requests, a retry after success), THE App SHALL use the same Payout_Key every time, and the Ledger SHALL hold exactly one Payout transaction for that Round.
4. THE Pot SHALL never go below zero. Core's normal-balance check SHALL be the last line of defence: the Pot is a revenue account without overdraft.
5. Each Member SHALL receive at most one Payout in the whole Circle, and only in the Round in which they are the Recipient.
6. WHEN the last Round is paid out, THE App SHALL show the Circle as Complete, with an empty Pot and every Member paid once.

### Requirement 7: Circle correctness properties

**User Story:** As a developer, I want fast-check properties over the circle's operations, so that the app's money rules are proven on the real ledger, not just demonstrated.

#### Acceptance Criteria

1. THE App's tests SHALL include a property that, over any sequence of Contributions (any Member, current or wrong Round), Missed_Payments, Payouts (current or wrong Round) and duplicate, concurrent or replayed operations, after every operation: the Pot is never negative, each Round has at most one Payout transaction, each Member is paid at most once and only in their own Round, and total money in (Clearing_Account balance) equals total money out (sum of Wallets) plus the Pot, and the Pot equals what an independent model predicts.
2. THE App's tests SHALL include a property that replaying any Contribution or Payout already performed, with the same Idempotency_Key, changes nothing: the same number of transactions and entries, and the same balances, on every account.
3. THE App's tests SHALL include a property that the entries of every Circle's accounts always sum to zero, and so does the whole Ledger.
4. Each property SHALL run on PGlite through the same App code the UI uses, with at least 25 runs, and the whole App test suite SHALL finish in under 120 seconds.
5. Each property SHALL be shown failing against a deliberate break in the App's code before its task is ticked, and the break SHALL then be reverted. The breaks tried SHALL be recorded in tasks.md.

### Requirement 8: The candlelit table

**User Story:** As a viewer, I want the circle to look like a candlelit table, so that the state of the round is obvious at a glance and the demo has a mood.

#### Acceptance Criteria

1. THE App SHALL show each Member of the selected Circle as a Candle around a table, in position order, with the Coffin at the centre.
2. A Member whose Current_Round Due is paid SHALL have a lit Candle; a Member whose Due is marked missed SHALL have a guttering Candle; a Member who still owes SHALL have an unlit Candle.
3. Every Candle state SHALL also be shown in text (`Paid`, `Paid late`, `Late`, `Owes`), and the Recipient of the Current_Round SHALL be marked in text, so that colour and animation are never the only signal.
4. THE Coffin SHALL show the Pot balance in text and a number of coins that grows with the number of paid Dues of the Current_Round.
5. WHEN a Payout succeeds, THE Coffin SHALL animate toward the Recipient's Candle (about 1 second) and the App SHALL announce the Payout in a polite live region.
6. WHERE the user prefers reduced motion, THE App SHALL NOT animate the Coffin's move or the flames, and SHALL show the same state changes without motion.
7. THE App SHALL show, for the selected Circle: the Current_Round, the Recipient, the Pot, total money in and out, the Ledger sum for the Circle's accounts, and which Members have already received the Pot.
8. AT a viewport width of 360 CSS pixels, THE App SHALL show every Candle, its text state and its actions without horizontal scrolling.

### Requirement 9: History timeline

**User Story:** As a member, I want a clear history of every movement, so that I can check the books myself.

#### Acceptance Criteria

1. THE App SHALL show a Timeline for the selected Circle with every Contribution, Payout and Missed_Payment, newest first, each with its Round, its Member, its amount where money moved, and its time.
2. Every Timeline entry that moved money SHALL show the client Idempotency_Key it was made with, the Ledger idempotency key stored on its transaction, and its ledger entries (account and signed amount).
3. THE Timeline SHALL mark a Contribution whose receipt the outbox has delivered.
4. THE Timeline SHALL be built from the Ledger's transactions and entries and the App's own records, never from a cached copy.

### Requirement 10: Summon the Poltergeist

**User Story:** As a judge, I want to throw the poltergeist at this circle's ledger live in the browser, so that I can watch Ossuary hold at zero drift while the vibe-coded twin loses money.

#### Acceptance Criteria

1. THE App SHALL offer a "Summon the Poltergeist" control with a seed (an integer from 0 to 4294967295, default 7) and a storm size (200, 500 or 2,000 events, default 200).
2. WHEN summoned, THE App SHALL generate one Storm with `generateStorm({ seed, size, ensureEveryFault: true })` and run it with `summon` against `ossuaryFactory({ client })` on the App's own PGlite database (the same Ledger as the Circle) and against `twinFactory()`, in the browser.
3. THE App SHALL show the two results side by side (stacked on narrow screens): a drift meter for each, the total drift, the money conjured and lost, the number of double-credited members, the per-fault counts of blocked and drifted ghosts, the blocked ghosts with their epitaphs, and the Twin's drifted ghosts with their drift.
4. THE Ossuary side SHALL show a drift of exactly 0, and THE App SHALL state it in words as well as on the meter.
5. AFTER the Seance, THE App SHALL check that the selected Circle's Pot, Wallets and Ledger sum are exactly what they were before, and that the whole Ledger still sums to zero, and SHALL show the result.
6. WHILE a Seance runs, THE App SHALL disable the Circle's money controls and the summon control, and SHALL announce progress in a live region.
7. IF a Seance fails, THEN THE App SHALL show the error and re-enable the controls, and the Circle SHALL be unchanged.

### Requirement 11: Demo circle and reset

**User Story:** As a judge, I want the first screen to already have a circle in progress, and a way to start over, so that I am never looking at an empty page.

#### Acceptance Criteria

1. WHEN the App starts with no Circle in its database, THE App SHALL create the Demo_Circle through the same operations the UI uses: five Members, a Contribution of 50 USDC, Round 1 fully paid and paid out, and Round 2 part-paid with one Missed_Payment.
2. THE App SHALL offer a "Reset" control that, after the user confirms in a dialog, deletes the App's database and recreates the Demo_Circle.
3. IF the user cancels the reset dialog, THEN THE App SHALL change nothing.
4. THE App SHALL let the user switch between Circles when there is more than one.

### Requirement 12: Accessibility

**User Story:** As a user of a keyboard or a screen reader, I want to use every feature, so that the demo works for everyone.

#### Acceptance Criteria

1. Every control SHALL be a native button, link or form control, reachable and operable with the keyboard in a logical order.
2. Every focusable element SHALL have a visible focus indicator with a contrast of at least 3:1 against its background.
3. Colour SHALL never be the only signal: every state shown by colour or animation SHALL also be shown in text or by shape.
4. Text SHALL have a contrast of at least 4.5:1 against its background.
5. THE App SHALL announce the result of every action (Contribution, Missed_Payment, Payout, Seance, reset) in a live region.
6. THE reset dialog SHALL move focus into itself when opened, close on Escape, and return focus to the Reset control when closed.

### Requirement 13: Tests and delivery

**User Story:** As a developer, I want the main flows tested and a deploy-ready build, so that the app keeps working while other sessions change the skeleton.

#### Acceptance Criteria

1. THE App SHALL have component tests (Vitest, Testing Library, jsdom) for the main flows: the seeded table, recording a Contribution, a double-tap, marking a Missed_Payment, a blocked Payout, a Payout, the Timeline, creating a Circle, reset, and a Seance.
2. THE App SHALL have one Playwright test that runs the full demo path against the built app served from `dist/`: the seeded Circle, paying a Round, and summoning the Poltergeist with Ossuary at zero drift and the Twin drifting.
3. `pnpm --filter the-tontine test`, `pnpm --filter the-tontine typecheck` and `pnpm --filter the-tontine build` SHALL all pass.
4. THE README table row for the App SHALL describe it (see design Open questions on write scope).
