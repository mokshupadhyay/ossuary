# Requirements Document

## Introduction

`poltergeist-engine` adds a fault injector with a visible result to `packages/core`, on top of the finished `ledger-core` spec (`postTransaction`, `refund`, `balance`, idempotency keys) and `webhooks-outbox` spec (`createWebhookHandler`, `signWebhook`, `runOutboxOnce`, the shared test helpers). It is the heart of the demo: the same seeded storm of haunted events is thrown at Ossuary and at a naive "Vibe Pay" twin, and the two drift meters are shown side by side.

The engine has seven parts:

1. **Fault catalog.** Eight named faults (duplicate delivery, replayed old timestamp, out-of-order events, refund before capture, concurrent double-tap, crash between steps, refund racing a payout, late delivery after a refund), each with a stable id, a name and an epitaph.
2. **Seeded storm.** A deterministic generator. The same seed and size always give the same storm, so any failure can be replayed.
3. **System-under-test adapter.** A small interface that accepts deliveries and reports balances, with an Ossuary adapter. The twin adapter comes in task group 5.
4. **Storm runner.** Delivers the storm to a system under test, acting as the payment rail and the app client (signing, retrying, replaying, racing and crashing), and attributes any drift to the ghost that caused it.
5. **Drift meter.** Compares what the system under test reports against what really happened, per account and in total, in `bigint`.
6. **Report and CLI.** A versioned JSON report that the apps' UI and the demo video read, and `pnpm poltergeist --seed 7 --events 2000 --target ossuary|twin --json`.
7. **The Vibe Pay twin** (`packages/twin/`). A real, runnable, deliberately naive implementation of the same payment feature, produced by a coding agent from a one-paragraph prompt with no Ossuary, and committed with a note on how it was produced.

Amounts are `bigint` minor units of one asset (USDC, 6 decimals). There is no currency conversion, no network access and no real rail or chain call. Everything runs on in-process Postgres (pglite).

## Glossary

- **Poltergeist**: This engine as a whole: catalog, storm generator, runner, drift meter, report and CLI, under `packages/core/src/poltergeist/`.
- **Fault**: One kind of haunting listed in the Fault_Catalog.
- **Fault_Catalog**: The fixed list of eight Faults in `src/poltergeist/faults.ts`.
- **Fault_Id**: A Fault's stable identifier, in lowercase kebab-case, for example `duplicate-delivery`.
- **Circle**: The single savings circle a Storm runs against: one pot and 5 members.
- **Member_Ref**: A member's logical name in a Storm: `m0` to `m4`.
- **Pot**: The money the Circle holds.
- **Member_Wallet**: The money paid out to one member.
- **Delivery**: One HTTP-style request to the SUT: a raw body, headers, and a route, either `webhook` (from the Rail) or `payout` (from the app).
- **Rail**: The simulated payment rail played by the Runner. It signs webhooks with the Signing_Secret in the `webhooks-outbox` format and retries deliveries that get no success response.
- **Payout**: An app request that moves an amount from the Pot to a Member_Wallet. It carries an `idempotency-key` header.
- **Ghost**: One instance of a Fault in a Storm: a self-contained group of Deliveries on its own payments, with a known true money effect.
- **Honest_Unit**: A unit with no Fault: one capture delivered once. Used to fill a Storm to its exact size.
- **Unit**: A Ghost or an Honest_Unit.
- **Storm**: The ordered list of Units generated from a Seed and a Storm_Size.
- **Seed**: An unsigned 32-bit integer.
- **Storm_Size**: The number of planned Deliveries in a Storm. Retries are not counted.
- **Logical_Id**: An id inside a Storm (event, payment, idempotency key, member, circle). It never depends on the SUT or the run.
- **Run_Tag**: A per-SUT-instance string mixed into Logical_Ids to make concrete ids, so that several runs can share one database.
- **SUT**: System under test: anything that implements the SUT_Interface.
- **SUT_Interface**: `deliver`, `balances`, `settle` and `close`, defined in `src/poltergeist/sut.ts`.
- **Ossuary_Adapter**: The SUT that runs `packages/core`'s webhook handler and ledger.
- **Vibe_Pay_Twin**: The naive implementation in `packages/twin/`.
- **Twin_Adapter**: The SUT that runs the Vibe_Pay_Twin.
- **Runner**: `summon` in `src/poltergeist/summon.ts`, which delivers a Storm to a SUT and builds the Report.
- **Truth**: The money movements that really happened in a Storm: each distinct capture, refund and payout exactly once.
- **Expected_Balances**: Balances computed from Truth: Pot = captured − refunded − paid out; each Member_Wallet = paid out to that member.
- **Reported_Balances**: The balances a SUT returns from `balances()`.
- **Drift**: Expected minus reported, per account, in `bigint` minor units. The total is the sum over accounts, which equals money in minus money out minus money held. Zero means no drift.
- **Drift_Delta**: The change in Drift across one Unit.
- **Conjured_Money**: The sum, over accounts, of the amount by which a reported balance exceeds the expected one.
- **Lost_Money**: The sum, over accounts, of the amount by which a reported balance falls short of the expected one.
- **Double_Credited_Member**: A member whose reported Member_Wallet exceeds the expected one.
- **Blocked_Ghost**: A Ghost whose Drift_Delta is zero on every account.
- **Drifted_Ghost**: A Ghost whose Drift_Delta is non-zero on at least one account.
- **Defense**: A mechanism that a SUT reports as having neutralized a Delivery, such as the inbox dedupe or the timestamp check.
- **Epitaph**: The one-line text the Report shows for a Blocked_Ghost.
- **Crash_Plan**: An instruction to crash a SUT before its k-th step of one Delivery, where a step is one SQL statement the SUT issues.
- **Virtual_Clock**: The injected clock the Runner controls. It is the `fakeClock` from the shared helpers.
- **Report**: The versioned JSON result of one Storm run.
- **Counterexample**: The smallest reproduction of a drift that the Runner finds, included in the Report.
- **Signing_Secret**: The HMAC secret shared by the Rail and the SUT. It is generated per run and never stored.
- **Test_Suite**: The Vitest and fast-check tests for `packages/core`, run on pglite.

---

## Requirements

### Requirement 1: Fault Catalog

**User Story:** As a demo viewer, I want every haunting to have a name and a one-line epitaph, so that I can see exactly which ghosts were stopped and how.

#### Acceptance Criteria

1. THE Fault_Catalog SHALL define exactly these eight Faults, in this order, each with a Fault_Id, a human name and an Epitaph template:

   | Fault_Id | Name | Epitaph template |
   |---|---|---|
   | `duplicate-delivery` | Duplicate delivery | `{subject} delivered twice, {fate}` |
   | `replayed-timestamp` | Replayed old timestamp | `{subject} replayed webhook, {fate}` |
   | `out-of-order` | Out-of-order events | `{subject} arrived out of order, {fate}` |
   | `refund-before-capture` | Refund before capture | `{subject} refund arrived before its capture, {fate}` |
   | `double-tap` | Concurrent double-tap | `{subject} double-tapped payout, {fate}` |
   | `crash-mid-step` | Crash between steps | `{subject} crashed mid-step, {fate}` |
   | `refund-races-payout` | Refund racing a payout | `{subject} refund raced a payout, {fate}` |
   | `late-after-refund` | Late delivery after a refund | `{subject} arrived late after its refund, {fate}` |

2. THE Fault_Catalog SHALL be frozen data, and no two Faults SHALL share a Fault_Id.
3. WHEN an Epitaph is rendered, THE Poltergeist SHALL replace `{subject}` with the Ghost's subject Logical_Id shortened to its prefix, its first two hexadecimal characters and `…` (for example `evt_9f…`), and replace `{fate}` with `buried by <defenses>` when the SUT reported one or more Defenses for the Ghost, or `passed without drift` when it reported none.
4. WHEN a rendered Epitaph names Defenses, THE Poltergeist SHALL list them in the order they were first reported within the Ghost, without repeats, joined by ` and `.
5. A rendered Epitaph SHALL be a single line.

---

### Requirement 2: Seeded Storm Generator

**User Story:** As a developer, I want the same seed to always give the same storm, so that any drift the poltergeist finds can be replayed exactly.

#### Acceptance Criteria

1. THE storm generator SHALL be a pure function of its Seed, its Storm_Size and its options. It SHALL draw every random choice from its own seeded generator, and SHALL NOT use `Math.random`, the system clock, `crypto` randomness or any state from earlier calls.
2. WHEN called twice with the same Seed, Storm_Size and options, in the same or different processes, THE storm generator SHALL return deep-equal Storms with identical JSON serializations.
3. THE storm generator SHALL accept a Seed that is an integer from 0 to 4294967295 and a Storm_Size that is an integer from 1 to 20,000, with a default Storm_Size of 2,000. IF either is out of range or not an integer, THEN it SHALL throw a `RangeError` naming the parameter, before generating anything.
4. THE storm generator SHALL produce exactly Storm_Size planned Deliveries. WHEN the next drawn Ghost would not fit in the remaining budget, it SHALL emit an Honest_Unit instead.
5. Every amount in a Storm SHALL be a `bigint` from 1 to 1,000,000,000 minor units. THE Storm SHALL record its asset (`USDC`) and its decimals (6), and every amount SHALL be in that asset.
6. Every Ghost SHALL be self-funded and valid. Its payouts SHALL be paid only from captures made in the same Ghost. Each payment's refunds SHALL sum to no more than its capture. Each payout SHALL be no more than the Ghost's captures minus its refunds. For a refund that races a payout, refund plus payout SHALL be no more than the capture, so that every serial order of the race is valid.
7. THE storm generator SHALL build each Ghost so that it actually exercises its Fault:
   - `duplicate-delivery`: a capture, or a capture followed by a refund, where the capture or the refund is delivered 2 to 3 times in a row.
   - `replayed-timestamp`: a capture delivered once, then, after the Virtual_Clock advances by 301 seconds to 7 days, the exact same bytes and headers delivered again.
   - `out-of-order`: a payment's `pending`, its capture and 0 to 1 refunds, delivered so that the capture arrives before the `pending` and every refund arrives after the capture.
   - `refund-before-capture`: a capture and 1 to 2 refunds, with every refund delivered before the capture.
   - `double-tap`: a capture, then 2 to 3 identical Payouts with the same idempotency key, delivered concurrently.
   - `crash-mid-step`: a target Delivery (a capture, a refund after a capture, or a Payout after a capture) carrying a Crash_Plan with a step index from 0 to 24.
   - `refund-races-payout`: a capture, then a refund of it and a Payout to a different member, delivered concurrently.
   - `late-after-refund`: a capture and a refund delivered in order, then a late re-delivery of the capture after the refund.
8. No Ghost SHALL have more than 4 planned Deliveries.
9. WHERE the option `ensureEveryFault` is set, THE storm generator SHALL make the first eight Units one Ghost of each Fault, in Fault_Catalog order. IF Storm_Size is too small to hold them, THEN it SHALL throw a `RangeError` that states the minimum size.
10. Logical_Ids SHALL be unique within a Storm, SHALL be derived only from the seeded generator, and SHALL use the prefixes `evt_` (events), `pay_` (payments) and `key_` (idempotency keys), each followed by 8 lowercase hexadecimal characters.
11. THE Storm SHALL record a generator version, starting at `1`. Any change to the generator that changes the Storm for some Seed SHALL increment it.
12. FOR two Storms with the same Seed and options and sizes `n < m`, every Unit of the size-`n` Storm that starts while at least 4 planned Deliveries remain SHALL equal the Unit at the same position in the size-`m` Storm, so that a smaller size replays a prefix of a larger one. WHERE `ensureEveryFault` is set, this SHALL hold when `n` is at least 32, the size at which none of the first eight Ghosts has to shrink to leave room for the ones after it.
13. THE storm generator SHALL record, for each Unit, its true money effect: the amount captured, the amount refunded, and the amount paid out to each member.

---

### Requirement 3: Haunted Delivery Semantics

**User Story:** As a developer, I want the poltergeist to behave like a real rail and a real app client, so that a SUT that survives the storm would survive production.

#### Acceptance Criteria

1. THE Runner SHALL send each webhook as a JSON body with `id`, `type`, `paymentId`, `circleId`, `memberId`, `asset`, and an `amount` written as a decimal string of minor units (omitted for `payment.pending`). It SHALL sign the body with the Signing_Secret at the Virtual_Clock's current second, using `signWebhook` and the `ossuary-timestamp` and `ossuary-signature` headers from `webhooks-outbox`.
2. THE Runner SHALL send each Payout as a JSON body `{ circleId, memberId, amount }`, with the amount as a decimal string, and an `idempotency-key` header holding a lowercase UUID. Every tap of a double-tap SHALL carry the same key and the same body.
3. THE Virtual_Clock SHALL start at 2026-10-31T00:00:00Z and SHALL advance by 1 second before every Delivery attempt. A replay Ghost SHALL also advance it by the Ghost's generated age.
4. WHEN a Ghost replays a Delivery, THE Runner SHALL resend the exact original raw body and headers, including the original timestamp and signature.
5. WHEN a Ghost has concurrent Deliveries, THE Runner SHALL start all of them in storm order before awaiting any, and SHALL wait for all of them, retries included, before the Ghost ends.
6. IF a Delivery attempt gets no response (a crash) or a `5xx` status, THEN THE Runner SHALL retry it, up to 5 attempts in total. A webhook retry SHALL resend the same body, re-signed at the current Virtual_Clock second. A Payout retry SHALL resend the same body and idempotency key. A `2xx` or `4xx` status SHALL end the Delivery. Replayed copies SHALL NOT be retried.
7. THE Runner SHALL apply a Crash_Plan only to the first attempt of its Delivery, and never to a concurrent Delivery. IF the SUT finishes the Delivery in k steps or fewer, THEN the crash SHALL happen after the SUT finished and before its response reaches the Runner, so that every Crash_Plan causes exactly one crash.
8. THE Runner SHALL turn Logical_Ids into concrete ids per SUT instance using a fresh Run_Tag. Payment ids, idempotency keys, member ids and the circle id SHALL be UUIDv5 values derived from the Run_Tag and the Logical_Id. Event ids SHALL be the Run_Tag followed by the Logical_Id. Concrete ids SHALL NOT appear in the Report.
9. THE Runner SHALL generate a fresh Signing_Secret of 32 random bytes per run, from the Web Crypto global, unless a test supplies one. It SHALL NOT write the secret to the Report, to any log line or to any file.

---

### Requirement 4: System-Under-Test Interface

**User Story:** As a developer, I want one small interface for anything that takes payment webhooks and reports balances, so that Ossuary and the twin face the identical storm.

#### Acceptance Criteria

1. THE SUT_Interface SHALL expose:
   - `target`, the SUT's name;
   - `deliver(rawBody, headers, options)`, where `options` holds the route (`webhook` or `payout`) and an optional Crash_Plan;
   - `balances()`;
   - `settle()`;
   - `close()`.
2. `deliver` SHALL resolve to the response status (or `null` when the SUT crashed before responding), whether a crash fired, and the Defense the SUT reports for this Delivery, if any. It SHALL NOT throw for any failure inside the SUT. A thrown error means the adapter itself is broken.
3. `balances()` SHALL resolve to the asset code, the Pot and each member's Member_Wallet, keyed by concrete member id, all in `bigint` minor units.
4. `settle()` SHALL let the SUT finish any background work it has, such as draining an outbox.
5. `close()` SHALL release every resource the SUT instance holds.
6. A SUT factory SHALL receive the Circle (circle id and member ids), the asset, the Virtual_Clock, the Signing_Secret and the Run_Tag, and SHALL return a new, independent SUT instance.

---

### Requirement 5: Ossuary Adapter

**User Story:** As a developer, I want Ossuary tested through its real public building blocks, so that zero drift means the shipped code is poltergeist-proof.

#### Acceptance Criteria

1. THE Ossuary_Adapter SHALL use `packages/core` only through `createAccount`, `createWebhookHandler`, `verifyWebhook`, `postTransaction`, `runOutboxOnce`, the embedded migrations (Requirement 14.4) and reads of `entries`. It SHALL NOT change any file under `src/ledger`, `src/webhooks`, `src/outbox`, `src/schema` or `src/migrations`.
2. WHEN an Ossuary_Adapter instance is created, it SHALL create fresh accounts for its Circle:
   - a clearing account (`asset`, `allow_overdraft = true`);
   - a pot account (`revenue`);
   - one wallet account (`liability`) per member.

   It SHALL then create a webhook handler configured with the clearing and pot accounts, the asset, the Virtual_Clock and the Signing_Secret.
3. WHEN a `webhook` Delivery arrives, THE Ossuary_Adapter SHALL pass the raw body and headers unchanged to the webhook handler and return its status.
4. WHEN a `payout` Delivery arrives, THE Ossuary_Adapter SHALL:
   - require an `idempotency-key` header holding a UUID;
   - require a body whose `circleId` is its own Circle, whose `memberId` is one of its members, and whose `amount` is a decimal string of a positive integer no greater than 9223372036854775807, converted to `bigint` without passing through `number`;
   - post a `transfer` through `postTransaction` with that key, debiting the pot account and crediting the member's wallet account by the amount.
5. THE Ossuary_Adapter SHALL answer a Payout with `400` for an invalid header or body, `409` for `DuplicateKeyError` or `KeyInFlightError`, `422` for `NormalBalanceViolationError`, `500` for any other error, and `200` on success, including a replay of a completed key.
6. THE Ossuary_Adapter SHALL report these Defenses:
   - `inbox-dedupe` for a webhook answered with outcome `duplicate`;
   - `timestamp-check` for a webhook answered `401` whose timestamp `verifyWebhook` reports as `stale` or `future`;
   - `signature-check` for any other `401`;
   - `parking` for a webhook answered with outcome `parked`;
   - `idempotency-key` for a Payout answered with a transaction id that this instance already returned;
   - `rollback` for a Delivery whose crash fired before its database transaction committed.
7. THE Ossuary_Adapter SHALL inject crashes with the shared crash helper, which stops the Delivery before the chosen SQL statement inside its open transaction. After the crash, Ossuary SHALL issue no statement for that Delivery except rollbacks (`ROLLBACK TO SAVEPOINT` and `ROLLBACK`).
8. `balances()` SHALL read all of the instance's account balances with one grouped `SUM` over `entries`, and SHALL report the Pot as the negated pot-account sum and each Member_Wallet as the negated wallet-account sum. No balance SHALL be stored.
9. `settle()` SHALL run `runOutboxOnce` with a recording sender that always succeeds, advancing the Virtual_Clock past every lease, until no message is due. IF it has not drained after `messages + 1` rounds, THEN it SHALL throw.
10. WHERE no database is supplied, THE Ossuary_Adapter SHALL create a fresh in-memory pglite database and apply every migration from the embedded copy (Requirement 14.4). WHERE a PGlite client is supplied, it SHALL share it, and the Run_Tag SHALL keep its rows apart from other instances'.

---

### Requirement 6: Storm Runner and Drift Attribution

**User Story:** As a demo viewer, I want every cent of drift traced to the ghost that caused it, so that the twin's red meter points at a named bug.

#### Acceptance Criteria

1. THE Runner SHALL run Units one at a time, in storm order. Deliveries inside a Unit follow Requirement 3, and no two Units overlap.
2. WHEN a Unit ends, THE Runner SHALL add the Unit's true effect to Truth, read `balances()`, compute Drift, and record the Unit's Drift_Delta per account.
3. THE Runner SHALL classify each Ghost as a Blocked_Ghost or a Drifted_Ghost from its Drift_Delta. It SHALL add the Drift_Deltas of Honest_Units to a separate honest-drift total.
4. WHEN every Unit has run, THE Runner SHALL call `settle()`, read `balances()` again, and record the change since the last Unit as the settle drift. For every account, the sum of all Ghost Drift_Deltas, the honest drift and the settle drift SHALL equal the final Drift.
5. WHEN the final Report has at least one Drifted_Ghost or non-zero honest drift, THE Runner SHALL build a Counterexample:
   - take the first drifting Unit in storm order;
   - run that Unit alone on a fresh SUT instance from the same factory;
   - if it drifts alone, record it as an `isolated` Counterexample with its Deliveries and Drift;
   - otherwise record a `prefix` Counterexample: the Seed, Storm_Size and options of the Storm, the id of the Unit the prefix runs through, the number of planned Deliveries up to and including that Unit, and the Drift just after it. The prefix is replayed by generating the same Storm and cutting it after that Unit, because regenerating with a smaller size could change its last Units (Requirement 2.12).
6. IF `deliver` throws, or `balances()` reports a different asset from the Storm's, THEN THE Runner SHALL stop and throw an error naming the Seed, the Unit index and the cause, and SHALL NOT return a partial Report.
7. THE Runner SHALL close every SUT instance it creates, including on error.

---

### Requirement 7: Drift Meter

**User Story:** As a developer, I want drift computed exactly, in integers, from what really happened, so that "$0.00 drift" is a fact and not a rounding artifact.

#### Acceptance Criteria

1. THE drift meter SHALL be a pure function of Truth and Reported_Balances, and SHALL compute in `bigint` only.
2. THE drift meter SHALL compute Expected_Balances as follows: Pot = captured − refunded − paid out, and each Member_Wallet = the amount paid out to that member.
3. THE drift meter SHALL report Drift for the `pot` account and for one `member:<Member_Ref>` account per member, in that order. The total SHALL be their sum, which equals money in (captured) minus money out (refunded) minus money held (Pot plus every Member_Wallet).
4. THE drift meter SHALL report Conjured_Money, Lost_Money and the number of Double_Credited_Members. Conjured_Money minus Lost_Money SHALL equal the negated total Drift.
5. IF Reported_Balances include a member id outside the Circle, THEN THE drift meter SHALL count it in a `member:unknown` account whose expected balance is 0.
6. IF the Reported_Balances asset differs from the Truth asset, THEN THE drift meter SHALL throw. No conversion of any kind SHALL be attempted.
7. THE drift meter SHALL report zero Drift on every account if and only if every reported balance equals its expected balance.

---

### Requirement 8: Report

**User Story:** As an app or video author, I want a stable, versioned JSON report, so that I can render the drift meter and the blocked ghosts without guessing the format.

#### Acceptance Criteria

1. THE Report SHALL carry `schema: "ossuary/poltergeist-report"`, `version: 1`, the Storm's generator version, the Seed, the Storm_Size, the target, the asset and the decimals.
2. THE Report SHALL carry event counts: planned Deliveries, Delivery attempts, retries and crashes fired. Per Fault, in Fault_Catalog order, it SHALL carry the number of Ghosts, planned Deliveries, Blocked_Ghosts and Drifted_Ghosts. It SHALL also carry the number of Honest_Units.
3. THE Report SHALL carry the final Drift (total, per account, Conjured_Money, Lost_Money, Double_Credited_Members), the Drift per Fault, the honest drift and the settle drift.
4. THE Report SHALL list every Blocked_Ghost in storm order with its Ghost id, Fault_Id, subject Logical_Id and rendered Epitaph. It SHALL list every Drifted_Ghost in storm order with its Ghost id, Fault_Id, subject and Drift_Delta per account.
5. THE Report SHALL carry the Counterexample, or `null` when there is none.
6. THE Report SHALL be JSON-safe. Every amount SHALL be a decimal string of minor units, never a JSON number. Keys SHALL appear in a fixed order.
7. THE Report SHALL NOT contain wall-clock times, durations, concrete ids, the Run_Tag, the Signing_Secret, signatures or raw bodies, so that the same Seed, Storm_Size, options and target always give a byte-identical Report.
8. THE Poltergeist SHALL export the Report's TypeScript type and the `version` constant. Any change to the Report's shape SHALL increment `version`.

---

### Requirement 9: Command-Line Interface

**User Story:** As a presenter, I want one command that summons the poltergeist against either target, so that the demo is one line in a terminal.

#### Acceptance Criteria

1. THE CLI SHALL run as `pnpm poltergeist --seed <n> --events <n> --target ossuary|twin [--json]` from the repository root, with defaults seed `7`, events `2000` and target `ossuary`.
2. IF an argument is unknown, repeated or out of range (seed outside 0–4294967295, events outside 1–20,000, or an unknown target), THEN THE CLI SHALL print a usage message to stderr and exit with code 2 without running a storm.
3. WHERE `--json` is given, THE CLI SHALL write exactly the Report's JSON followed by one newline to stdout, and nothing else.
4. WHERE `--json` is not given, THE CLI SHALL print a human summary: the total Drift as an exact decimal amount with all 6 decimals and the asset code, the per-Fault counts, and up to the first 10 Epitaphs and Drifted_Ghosts.
5. WHEN a storm completes, THE CLI SHALL exit with code 0 whether or not there was drift. IF the run throws, THEN it SHALL print the error to stderr and exit with code 1.
6. THE CLI SHALL need no environment variables and no network access, and SHALL run every target on in-memory pglite.

---

### Requirement 10: The Vibe Pay Twin

**User Story:** As a demo viewer, I want the twin to be the code a coding agent really writes for this feature, so that its drift is a fair warning and not a strawman.

#### Acceptance Criteria

1. THE Vibe_Pay_Twin SHALL live in `packages/twin/` as the workspace package `@ossuary/twin`. It SHALL be produced by a coding agent from the one-paragraph prompt fixed in design.md, run in a workspace that contains no Ossuary code and no steering files.
2. THE Vibe_Pay_Twin SHALL be committed with `packages/twin/PRODUCED.md`, which records:
   - the prompt, verbatim;
   - the agent, the model, the date and the exact command used;
   - the number of generation attempts;
   - every change made to the generated files after generation.
3. No change SHALL be made by hand to the generated source under `packages/twin/src/`. Package scaffolding (`package.json`, `tsconfig.json`) MAY be added, and SHALL be listed in `PRODUCED.md`.
4. THE Vibe_Pay_Twin SHALL be real and runnable:
   - it SHALL export `createVibePay(db)`, whose result offers `init`, `handleWebhook`, `handlePayout` and `getBalances`;
   - it SHALL compile under strict TypeScript;
   - WHEN each webhook and Payout of a valid history is delivered once, in order, with no crash, it SHALL report the correct Pot and Member_Wallets.
5. `PRODUCED.md` SHALL include a checklist of the five naive traits (float amounts, mutable balance columns, no idempotency key handling, no signature check, no transaction around the writes), stating for each one whether the generated code has it, with a file and line reference. A trait the generated code lacks SHALL be disclosed, not added by hand.
6. THE Vibe_Pay_Twin SHALL NOT import `@ossuary/core` or any file outside `packages/twin/`.

---

### Requirement 11: Twin Adapter

**User Story:** As a developer, I want the twin driven through the same interface and the same crash model as Ossuary, so that the side-by-side comparison is fair.

#### Acceptance Criteria

1. THE Twin_Adapter SHALL create a fresh in-memory pglite database per instance, call the twin's `init`, and pass the twin a database handle that it controls. WHERE a PGlite client is supplied and a unit test has shown that the twin's `init` can run twice and that two circles on one database never see each other's balances, it MAY share that client instead.
2. WHEN a Delivery arrives, THE Twin_Adapter SHALL build a Web `Request` from the raw body and headers, pass it to `handleWebhook` or `handlePayout` according to the route, and return the `Response` status.
3. THE Twin_Adapter SHALL inject crashes by failing the twin's k-th database statement of the Delivery and every later statement of that Delivery, which models the twin's process dying. Statements the twin had already run stay committed, because the twin uses no transactions.
4. `balances()` SHALL call the twin's `getBalances` and convert each number to `bigint` minor units. An integral value SHALL be converted exactly. A non-integral value SHALL be converted by truncation toward zero, and its exact decimal value SHALL be recorded in the Report as a fractional balance.
5. THE Twin_Adapter SHALL never report a Defense.
6. `settle()` SHALL do nothing unless the twin exposes background work.

---

### Requirement 12: Reuse of Shared Helpers and Package Boundaries

**User Story:** As a maintainer, I want the poltergeist to reuse the helpers the earlier specs built, and money code never to depend on the poltergeist, so that there is one crash model and the ledger stays independent.

#### Acceptance Criteria

1. THE Poltergeist SHALL reuse the existing helpers rather than duplicate them. The parts that `src/` needs (`fakeClock`, the crashing database and `SimulatedCrash`, `fakeSender`, and `signedDelivery` / `signedDeliveryAt`) SHALL move into `src/poltergeist/`. `tests/helpers/clock.ts`, `crash.ts`, `sender.ts` and `webhooks.ts` SHALL re-export them under their current names, and `calibrate` and the fast-check arbitraries SHALL stay in `tests/helpers/`.
2. Every existing test SHALL pass without changes to its own file.
3. No module under `src/ledger`, `src/webhooks`, `src/outbox`, `src/db`, `src/schema`, `src/types` or `src/errors` SHALL import from `src/poltergeist`. `src/index.ts` SHALL NOT export the Poltergeist. The Poltergeist SHALL be reachable through the package subpath `@ossuary/core/poltergeist`.
4. This spec SHALL NOT change the behavior of `ledger-core` or `webhooks-outbox`.

---

### Requirement 14: Browser-Safe Library Entry

**User Story:** As an app developer, I want to run the storm live in the page on PGlite, so that the Tontine and Tip Jar apps can show the poltergeist against Ossuary and the twin in the browser.

#### Acceptance Criteria

1. Every module under `src/poltergeist/` except `cli.ts` SHALL be browser-safe:
   - it SHALL NOT import `fs`, `path`, `child_process`, `url`, `module`, `os` or any other Node built-in, with or without the `node:` prefix;
   - it SHALL NOT read the `process` or `Buffer` globals;
   - it SHALL have no top-level Node-only import, directly or through the core modules it imports.
2. The only Node built-in reachable from `@ossuary/core/poltergeist` SHALL be `node:crypto`. Only the functions core already uses from it (`randomUUID`, `createHash`, `createHmac`, `timingSafeEqual`) SHALL be reachable, so that app bundlers can shim them. New randomness in the poltergeist SHALL use the Web Crypto global (`globalThis.crypto.getRandomValues`).
3. Every Node-only piece of the poltergeist (argument parsing, `process`, stdout and stderr, and exit codes) SHALL live in `cli.ts`, and no other module SHALL import `cli.ts`.
4. WHERE no database is supplied, THE Ossuary_Adapter SHALL migrate its fresh PGlite from migrations embedded as strings in a browser-safe module. It SHALL NOT read migration files from disk. The embedded migrations SHALL be byte-for-byte equal to the files in `src/migrations`, with the same hashes and timestamps that drizzle's `readMigrationFiles` produces, so that a database migrated either way records the same history.
5. THE Test_Suite SHALL bundle `src/poltergeist/index.ts` with esbuild for `platform: 'browser'`, with `@electric-sql/pglite` external because it is the apps' browser database and ships its own browser handling. The test SHALL fail if the bundle imports any Node built-in other than `node:crypto`, statically or dynamically, and SHALL name each offending import and its importer.
6. The bundle test SHALL be shown to fail against at least two deliberate breaks before its task is marked done: a top-level `node:fs` import in a poltergeist module, and an import of `runMigrations` (which reaches `node:fs` and `node:url` through drizzle's migrator) from the Ossuary adapter.

---

### Requirement 13: Test Infrastructure and Correctness Properties

**User Story:** As a developer, I want the poltergeist's own claims proven by property tests that fail when the code is broken, so that the demo's two meters can be trusted.

#### Acceptance Criteria

1. THE Test_Suite SHALL run the Poltergeist on pglite with the Virtual_Clock, with no network access and no environment variables.
2. **Property (fast-check):** FOR ALL Seeds and Storm_Sizes from 1 to 100, and either target, generating the Storm twice SHALL give deep-equal Storms with identical JSON, and running it on two fresh SUT instances with different Run_Tags SHALL give byte-identical Report JSON.
3. **Property (fast-check):** FOR ALL Seeds and Storm_Sizes from 1 to 2,000, the Ossuary_Adapter's Report SHALL have zero total Drift, zero Drift on every account, zero Conjured_Money, Lost_Money, honest drift and settle drift, no Double_Credited_Members, no Drifted_Ghosts and a `null` Counterexample. The global sum of all ledger entries SHALL stay 0. The cases SHALL include Seed 7 with Storm_Size 2,000, the CLI default.
4. **Property (fast-check):** FOR ALL Seeds and Storm_Sizes from 18 to 200 with `ensureEveryFault`, the Twin_Adapter's Report SHALL have non-zero Drift on at least one account and at least one Drifted_Ghost. Every Drifted_Ghost's Fault_Id SHALL be in the Fault_Catalog and equal its Storm Ghost's Fault_Id. The attribution identity of Requirement 6.4 SHALL hold. The Counterexample SHALL name a Fault_Id in the Fault_Catalog, and replaying it on a fresh twin SHALL reproduce its recorded Drift.
5. **Property (fast-check):** FOR ALL Seeds and Storm_Sizes from 1 to 150, and either target, every Blocked_Ghost in the Report SHALL have a Fault_Id in the Fault_Catalog equal to the Fault_Id of the Storm Ghost with the same Ghost id. Its Epitaph SHALL be that Fault's template rendered per Requirement 1.3. No Honest_Unit and no Drifted_Ghost SHALL appear among the Blocked_Ghosts, and every Ghost SHALL appear in exactly one of the blocked and drifted lists.
6. Each property in criteria 2–5 SHALL be one fast-check test, tagged with its property number and the requirements it validates, and SHALL run at least 25 cases in the default `vitest --run`.
7. Each property SHALL be shown to fail against every deliberate break listed for it in design.md before its task is marked done, and `src/` SHALL be byte-identical afterwards.
8. WHEN a property fails, THE Test_Suite SHALL report the counterexample (Seed, Storm_Size, target), and SHALL bound each property run, shrinking included, so that a failure is reported rather than hanging.
9. THE full `vitest --run` for `packages/core`, including every existing test, SHALL finish in under 120 seconds.
