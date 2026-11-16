---
inclusion: always
---
# Money rules

Ossuary handles money. These rules apply to every file Kiro writes in this repo.

- Amounts are **integers in minor units** (cents, or USDC base units with 6 decimals). Never use floats for money.
  Use `bigint` in TypeScript and `bigint`/`numeric` in Postgres.
- Every amount travels with its **currency/asset code**. Never add amounts of different assets.
- Single asset per ledger: this project uses one currency only. No currency conversion of any kind.
- Money never changes in place. A balance is the **sum of ledger entries**, never a mutable column.
- Every operation that moves money takes an **idempotency key** (see `idempotency.md`).
- Every external event that moves money is a **signed webhook** that is verified before it is trusted (see `webhooks.md`).
- Rounding: never round. If a split leaves a remainder, assign it deterministically (to the first recipient) and record it as an entry.
- Testnets only: USDC on Base Sepolia and a simulated bank rail. Never mainnet, never real keys in code.
- When unsure whether something is safe, write a failing property test first.
