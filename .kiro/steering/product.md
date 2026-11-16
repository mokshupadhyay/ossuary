---
inclusion: always
---
# Product: Ossuary

Ossuary is a Skeleton Crew template for **poltergeist-proof money**: payment code that stays correct when
webhooks arrive twice, users double-tap, requests retry, and processes crash mid-transfer.

- `packages/core`: the skeleton. Double-entry ledger, idempotency, signed webhooks, outbox, poltergeist engine, drift meter.
- `power/`: the Ossuary Kiro power (steering, skills, MCP server with `summon_poltergeist` and `query_ledger`).
- `apps/the-tontine`: a savings circle (members contribute each round, one member takes the pot). Candle UI.
- `apps/haunted-tip-jar`: tips for streamers. Built *through* the power to prove the skeleton is reusable.

The demo: "Summon the Poltergeist" against a vibe-coded twin ("Vibe Pay"). Its drift meter goes red; Ossuary stays at $0.00 drift.
