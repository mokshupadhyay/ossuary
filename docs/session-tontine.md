# Session instructions: the-tontine

Read docs/the-tontine-spec-prompt.md and follow it exactly. Create the spec `the-tontine` (requirements, design, tasks),
then implement every task.

The poltergeist engine is finished: import it from `@ossuary/core/poltergeist` (browser-safe library entry, see
`.kiro/specs/poltergeist-engine`) and the Vibe Pay twin from `packages/twin`.

IMPORTANT: other Kiro sessions are building apps/haunted-tip-jar and the Ossuary power (power/) at the same time in this
same workspace.
- Only create or edit files under `apps/the-tontine` and `.kiro/specs/the-tontine`. Do not touch `apps/haunted-tip-jar`,
  `power/`, `packages/core/src` or `packages/twin`. If you need a change in core, write it down under "Open questions" in
  design.md instead of editing core.
- Add dependencies with `pnpm --filter the-tontine add`. If `pnpm-lock.yaml` is busy or conflicts, wait 10 seconds and
  retry. Run only your own app's tests while working.

Follow `.kiro/steering`. Do not stop between requirements, design and tasks; record ambiguities under "Open questions" in
design.md. Implement one task at a time, verify after each (tests, type check, production build), and tick a task only
when it passes. Show each property failing against a deliberate break before ticking it, then revert the break. Do not
commit. Do not stop until every task including the final checkpoint is done, then report test counts and the mutations
you tried.
