# Session instructions: ossuary-power

Read docs/power-mcp-spec-prompt.md and follow it exactly. Create the spec `ossuary-power` (requirements, design, tasks),
then implement every task.

IMPORTANT: other Kiro sessions are building apps/the-tontine and apps/haunted-tip-jar at the same time in this same
workspace.
- Only create or edit files under `power/`, `.kiro/hooks`, `.kiro/agents`, `.github/workflows/money-audit.yml` and
  `.kiro/specs/ossuary-power`. Do not touch `apps/`, `packages/core/src` or `packages/twin`.
- Add dependencies with `pnpm --filter <your package> add`. If `pnpm-lock.yaml` is busy or conflicts, wait 10 seconds
  and retry.
- Run only your own package's tests while working. Run the full `pnpm --filter core test` once, at the final checkpoint.
- The poltergeist CLI is finished: `pnpm --filter core poltergeist --seed 7 --events 300 --target ossuary|twin --json`.

Follow `.kiro/steering`. Implement one task at a time, verify after each, and tick a task only when it passes. Show each
property failing against a deliberate break before ticking it, then revert the break. Do not commit. Do not stop until
every task including the final checkpoint is done, then report test counts and the mutations you tried.
