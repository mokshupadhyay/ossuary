# Session instructions: haunted-tip-jar

Read docs/haunted-tip-jar-spec-prompt.md and follow it exactly. Create the spec `haunted-tip-jar` (requirements, design,
tasks), then implement every task.

IMPORTANT: other Kiro sessions are building apps/the-tontine and the Ossuary power (power/) at the same time in this
same workspace.
- Only create or edit files under `apps/haunted-tip-jar` and `.kiro/specs/haunted-tip-jar`. Do not touch
  `apps/the-tontine`, `power/`, `packages/core/src` or `packages/twin`. If you need a change in core, write it down under
  "Open questions" in design.md instead of editing core.
- The poltergeist engine is finished: import it from `@ossuary/core/poltergeist` (browser-safe library entry, see
  `.kiro/specs/poltergeist-engine`) and the Vibe Pay twin from `packages/twin`.
- The Ossuary power's skills already exist in `power/skills/`; use them while building. Its MCP server is being built in
  another session: if `power/mcp/dist/server.js` exists when you start implementing, use its tools; if it does not,
  continue with the skills and record in design.md which parts you could not use the MCP tools for.
- Add dependencies with `pnpm --filter haunted-tip-jar add`. If `pnpm-lock.yaml` is busy or conflicts, wait 10 seconds
  and retry. Run only your own app's tests while working.

Follow `.kiro/steering`. Implement one task at a time, verify after each (tests, type check, production build), and tick a
task only when it passes. Show each property failing against a deliberate break before ticking it. Do not commit. Do not
stop until every task including the final checkpoint is done, then report test counts and the mutations you tried.
