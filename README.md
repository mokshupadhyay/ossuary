# Ossuary 🦴

> Poltergeist-proof money. A Kiro skeleton for payment code that survives duplicate webhooks, double-taps, retries and crashes.

**Hackathon:** Kiroween 2026 · **Category:** Skeleton Crew · **Demo video:** _todo_ · **Live apps:** _todo_

## The problem
AI writes payment code that works in the demo and loses money in production. A webhook arrives twice and a user is paid twice. A double-tap charges twice. A crash mid-transfer leaves money nowhere.

## What's in the skeleton
| Folder | What it is |
|---|---|
| `packages/core` | Double-entry ledger, idempotency keys, signed webhooks, outbox, the poltergeist engine and drift meter |
| `power/` | The Ossuary Kiro power: steering, skills and an MCP server |
| `apps/the-tontine` | A savings circle built on the skeleton |
| `apps/haunted-tip-jar` | Streamer tips, built through the power |

## How Kiro was used
_todo: specs, steering, hooks, power, MCP, headless custom agent. With links to `.kiro/`._

## Correctness properties
| Property | Test |
|---|---|
| Ledger always sums to zero | _todo_ |
| One effect per idempotency key | _todo_ |
| Replayed / out-of-order webhooks change nothing | _todo_ |
| Refunds never exceed captured | _todo_ |
| Crash at any step is all-or-nothing | _todo_ |

## Built during the hackathon
All code written after the submission period opened (30 Oct 2026). Testnet USDC on Base Sepolia only.

## Licence
MIT
