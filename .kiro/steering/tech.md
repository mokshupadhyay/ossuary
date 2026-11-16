---
inclusion: always
---
# Tech

- TypeScript (strict), Node 22+, pnpm workspaces.
- Next.js (App Router) for both apps; deploy on Vercel.
- Postgres on Neon, Drizzle ORM and migrations.
- Tests: Vitest + fast-check (property-based) for core; Playwright for the apps.
- Chain: viem on Base Sepolia, testnet USDC only.
- No Stripe, no real bank APIs, no currency conversion.
