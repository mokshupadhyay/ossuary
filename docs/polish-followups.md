# Polish follow-ups

Changes the polish sessions found worth making but did not make, because they sit outside the files those sessions could touch.

## Follow-ups

### The Tontine, design Open Question Q2: run the storm on the circle's own accounts (core change, not made)

- **Where:** `.kiro/specs/the-tontine/design.md`, Open questions, Q2; `packages/core/src/poltergeist/sut.ts` (`ossuaryFactory`).
- **Today:** `ossuaryFactory({ client })` always creates fresh storm-scoped accounts (`poltergeist <run tag> pot`, …). The Tontine runs the storm on the circle's database and on Core's real webhook handler, payout glue and outbox, but not on the circle's own Pot and Wallets. To make up for that, it shows that the circle's books are unchanged and that the whole ledger still sums to zero.
- **Recommendation:** add an optional `accounts` argument to `ossuaryFactory`, for example `{ pot: AccountId, members: Record<MemberRef, AccountId> }`, that adopts existing accounts instead of creating them. Map the storm's five fixed members (`m0`–`m4`) to the circle's first five seats and refuse a circle with fewer than five members. Use a payout handler that calls the same `payout` path the Tontine uses, so a storm payout is a real circle payout under an idempotency key.
- **Why it is deferred:** it changes Core's poltergeist API and its determinism guarantees, and the drift meter would then have to subtract the circle's existing balances from "expected". It needs its own spec change and property tests (zero drift on adopted accounts; the circle's balances afterwards equal its balances before plus the storm's honest effects). Until then, the storm leaves the circle's books untouched and the app says so.
- **Not done in this session:** `packages/` was out of scope (`docs/session-polish-b.md`).
