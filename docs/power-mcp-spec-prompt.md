# ossuary-power spec prompt

Create a spec named `ossuary-power` that finishes the Kiro power in `power/`. Today `power/plugin.json` points at
`./mcp/dist/server.js`, which does not exist, so the power is broken. Follow the open Agent Plugins format
(plugin.json, skills/, mcp config) and `.kiro/steering/*.md`.

## Scope
1. An **MCP server** in `power/mcp` (TypeScript, built to `power/mcp/dist/server.js`) exposing tools that make Kiro's money
   code safer while it writes it:
   - `ossuary_check_money_code`: given a file path or snippet, report violations of the steering rules (float money, mutable
     balance, missing idempotency key, unverified webhook, write outside one transaction, refund beyond captured).
   - `ossuary_run_poltergeist`: run the poltergeist CLI with a seed and event count and return the JSON drift report.
   - `ossuary_explain_rule`: return the text of one steering rule with an example of the bug and the fix.
   Tools validate input, never execute arbitrary shell, never read outside the workspace, and return structured JSON.
2. **Skills** (`power/skills/*/SKILL.md`): keep `money-code-review` and `poltergeist-test`; make them accurate to the current code
   and tools. Add one skill, `add-a-money-flow`, that walks Kiro through adding a new flow safely (idempotency key, one
   transaction, property test, poltergeist run).
3. The power must **install and work**: a documented way to install it into Kiro (IDE and CLI), a smoke test that starts the
   MCP server and calls each tool, and a README section.
4. Wire the `summon-poltergeist` hook to the new tool or CLI, and update `money-auditor` (the headless custom agent) so CI can run it
   with `KIRO_API_KEY`. Make `.github/workflows/money-audit.yml` valid and documented; it must skip gracefully, with a clear
   message, when the secret is absent so CI stays green on forks.

## Required tests
Unit tests for each tool (valid and invalid input, path escape attempts, a snippet with each violation). A smoke test that
spawns the built server over stdio and lists and calls the tools. At least 25 runs for any property test; mutation-check each.

## Process
Requirements, design, tasks without stopping (ambiguities under "Open questions"), then implement every task one at a
time, verify after each, tick only when passing. Do not commit.
