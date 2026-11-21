# How Kiro was used

Every number here was measured with a command on 2026-11-22, after the last build session had exited. The command is given next to the number, or in the [claims-to-evidence table](#claims-to-evidence). Paths are relative to the repository root.

Some evidence is local only. The headless session logs are in `.run/` (gitignored, so not in a clone), and the session instruction files `docs/session-*.md` were not yet committed when this was written. Claims that rest only on them are marked **(local log)**.

## Which Kiro surfaces were used

| Surface | Used? | What for | Evidence |
|---|---|---|---|
| Kiro IDE | Yes | The first spec, `ledger-core`: requirements, design and task list generated and revised in the IDE, then its tasks run from the IDE. | 5 commits say "in Kiro" (`git log --format=%s \| grep -c "in Kiro"` → 5, all `spec(ledger-core)`). `.kiro/specs/ledger-core/tasks.meta.json` is the IDE's task execution record: 44 executions of 26 tasks, 17 execution ids, 1 chat session, from 2026-11-16T18:49Z to 2026-11-17T16:27Z. |
| Kiro CLI, headless | Yes | The later build sessions: the power, both apps, and two polish sessions (this write-up is the second polish session). Also the one-shot generation of the Vibe Pay twin. | `.run/launch.sh` runs `kiro-cli chat --no-interactive --trust-workspace --model claude-opus-5.5 --trust-tools=fs_read,fs_write,execute_bash "Read <file> and do exactly what it says…"`. Five session logs: `power`, `tipjar`, `tontine`, `polish-tipjar`, `polish-b` **(local log)**. The twin's run: `packages/twin/PRODUCED.md` (Kiro CLI 3.3.0, `kiro-cli chat --no-interactive`, in an empty `mktemp -d` directory). `kiro-cli --version` → `kiro-cli 3.3.0`. |
| Kiro Web | No | | No artefact in the repository. |
| Crew | No | | No artefact in the repository. |

The repository does not record which surface wrote the `webhooks-outbox` and `poltergeist-engine` specs. Both have a `.config.kiro` file, but that does not prove they came from the IDE: the CLI sessions wrote `.config.kiro` by hand. For example, the Tontine session used `printf '{"specId": "%s", …}' "$(uuidgen …)" > .kiro/specs/the-tontine/.config.kiro` **(local log)**. Neither spec has a `tasks.meta.json` or a CLI log.

Headless session sizes, from the logs **(local log)**:

| Session | Instruction file | Shell commands run (`grep -c '^\[tool\] Running'`) | Log created → last write |
|---|---|---|---|
| power | `docs/session-power.md` | 90 | 22:58 → 23:47 |
| tipjar | `docs/session-tipjar.md` | 85 | 22:58 → 00:03 |
| tontine | `docs/session-tontine.md` | 99 | 22:58 → 00:47 |
| polish-tipjar | `docs/session-polish-tipjar.md` | 43 | 00:41 → 01:13 |

The first three ran in parallel, each limited by its instruction file to its own folders. The times are file birth and modification times (`stat -f '%SB -> %Sm'`), not exact session lengths.

## Spec-driven development vs vibe coding

Six specs, each with requirements, design and tasks: 5,552 lines in total (`cat .kiro/specs/*/*.md | wc -l`). Every task is ticked.

| Spec | Requirements | Tasks ticked / open |
|---|---|---|
| `ledger-core` | 9 | 36 / 0 |
| `webhooks-outbox` | 12 | 27 / 0 |
| `poltergeist-engine` | 14 | 33 / 0 |
| `ossuary-power` | 8 | 23 / 0 |
| `the-tontine` | 13 | 29 / 0 |
| `haunted-tip-jar` | 10 | 33 / 0 |

Counted with `grep -cE '^#+ *Requirement [0-9]+' requirements.md` and `grep -cE '^\s*- \[(x| )\]' tasks.md`. The prompts that started the specs are in `docs/*-spec-prompt.md` (6 files).

The vibe-coded comparison is the twin, **Vibe Pay** (`packages/twin`). A coding agent wrote it from a single paragraph of prompt, in one attempt, in an empty directory with no steering and no power, and nobody edited it afterwards. The prompt, the run and the SHA-256 are in `packages/twin/PRODUCED.md`. `shasum -a 256 packages/twin/src/index.ts` still gives the recorded `92ed1251…8af0f`, and `git log -- packages/twin/src/index.ts` shows a single commit.

| | Spec-driven (Ossuary core) | Vibe-coded (Vibe Pay) |
|---|---|---|
| Source lines (`.ts`, excluding generated) | 3,860 | 185 |
| Test lines | 7,381 | 0 (the twin is tested from `packages/core`) |
| Poltergeist, seed 7, 2,000 events, 728 ghosts | 728 blocked, 0 drifted | 202 blocked, 526 drifted |
| Drift (USDC) | 0 | 55,504.318662 net. 88,043.008732 lost, 32,538.69007 conjured. 5 members paid twice. |

The drift row comes from `pnpm --silent poltergeist --seed 7 --events 2000 --target ossuary --json` and the same command with `--target twin`.

The twin is **less naive than the spec expected**. It stores amounts as Postgres `numeric`, deduplicates webhooks by payment status, and makes every write a single atomic SQL statement. Its drift comes from the traits it does have: no signature check, no idempotency key on payouts, refunds that remove the whole capture, and early refunds answered `409` and never retried. `packages/twin/PRODUCED.md` lists each trait with line numbers.

## Steering

`.kiro/steering` has 6 files, 91 lines in total (`wc -l .kiro/steering/*.md`):

| File | Inclusion |
|---|---|
| `money.md`, `idempotency.md`, `product.md`, `tech.md` | `always` |
| `ledger.md` | `fileMatch: packages/core/**/*.ts` |
| `webhooks.md` | `fileMatch: **/webhooks/**` |

The rules are also used outside the chat. The power's rule catalog (`power/mcp/src/rules.ts`) quotes each steering bullet word for word, with its file. The `money-auditor` agent loads `.kiro/steering/**/*.md` as resources.

The steering is out of date in two places, and this session did not change it:
- `tech.md` says Next.js, Neon and Vercel. Both apps are static Vite + React sites running Postgres in the browser (PGlite). Core has a Neon client (`packages/core/src/db/client.ts`), but no app uses it.
- `product.md` names MCP tools `summon_poltergeist` and `query_ledger`. The server exposes `ossuary_check_money_code`, `ossuary_run_poltergeist` and `ossuary_explain_rule` (`power/mcp/src/server.ts`, lines 37, 49 and 62).

## Agent hooks

Four IDE hooks are defined in `.kiro/hooks`:

| Hook | Trigger | Action |
|---|---|---|
| `money-guard-on-save` | `fileEdited` on `packages/core/src/**/*.ts` | Asks the agent to check the changed file against `money.md`, `ledger.md` and `idempotency.md` |
| `post-task-tests` | `postTaskExecution` | Runs `pnpm --filter core test --run` |
| `webhook-handler-check` | `fileCreated` on `**/webhooks/**/*.ts` | Asks the agent to check signature, replay window, dedupe and outbox |
| `summon-poltergeist` | `userTriggered` (a button) | Calls `ossuary_run_poltergeist` for both targets, with the CLI as a fallback |

The repository holds no record of how often these hooks fired, so this write-up makes no claim about it. They are IDE hooks, and the headless CLI sessions do not run them.

## Custom agent

`.kiro/agents/money-auditor.json` is a read-only reviewer. Its tools are `read`, `grep`, `glob`, `ossuary_check_money_code` and `ossuary_explain_rule`. It ends every report with `VERDICT: PASS` or `VERDICT: FAIL`.

- The power session ran `kiro-cli agent validate` on it and it passed. Run headless with `--no-interactive`, it started the MCP server, called `ossuary_check_money_code`, and returned `float-money, line 1` and `VERDICT: FAIL` on a planted violation **(local log)**.
- `.github/workflows/money-audit.yml` runs this agent on pull requests. It has **never run**: `gh run list` returns `[]` for the repository.
- A non-interactive session cannot approve the agent's tools when it is used as a subagent, so the tip-jar session ran the same review through the skill and the MCP tool directly (`.kiro/specs/haunted-tip-jar/tasks.md`, task 8).

## MCP

`power/mcp` is a stdio MCP server with three tools:
- `ossuary_check_money_code`: line-level checks against the money rules.
- `ossuary_run_poltergeist`: runs the poltergeist CLI from a fixed argument template.
- `ossuary_explain_rule`: returns the steering text for a rule.

`pnpm --dir power/mcp test` gives 227 tests in 11 files, including a smoke test that starts the server over stdio. Both app sessions called the server: the tip-jar session ran `ossuary_check_money_code` on 15 app files and `ossuary_run_poltergeist` on seed 7 (`.kiro/specs/haunted-tip-jar/tasks.md`, task 8).

## The Kiro power

`power/plugin.json` declares:
- the steering (`../.kiro/steering`);
- 3 skills: `add-a-money-flow`, `money-code-review` and `poltergeist-test`, 150 lines in total (`wc -l power/skills/*/SKILL.md`);
- the MCP server above.

`power/README.md` documents two install routes, both through `.kiro/settings/mcp.json`. For the CLI: `kiro-cli mcp add --name ossuary --scope workspace …`. For the IDE: the same JSON file. The IDE's **"install power from a local folder" route is unconfirmed**. The README says so, and no test covers it.

## Property-based testing

Every property is a fast-check test. Core's run on PGlite, in-process Postgres.

A **mutation** is a deliberate break in the code, run against the property, then reverted. "Failed" means the property caught the break.

### Core: `ledger-core`

The commit that added these properties (`3bb481b`, "six property tests…, each mutation-checked") **does not record which mutations were used**. Only one is named anywhere in the repository: "swallowed entries insert", which `atomicity.property.ts` catches (`.kiro/specs/webhooks-outbox/tasks.md` and `.kiro/specs/poltergeist-engine/tasks.md` both re-run it).

| Property | File | Mutations on record |
|---|---|---|
| Every transaction's entries sum to zero, including rejected calls | `packages/core/tests/property/entrySum.property.ts` | Not recorded |
| A replayed idempotency key leaves the ledger unchanged | `packages/core/tests/property/idempotency.property.ts` | Not recorded |
| Replay in any order with duplicates gives the same balances | `packages/core/tests/property/idempotency.property.ts` | Not recorded |
| Total refunded never exceeds total captured | `packages/core/tests/property/refundCap.property.ts` | Not recorded |
| Exactly the remaining amount is accepted; one unit over is rejected | `packages/core/tests/property/refundCap.property.ts` | Not recorded |
| A crash at any step is all-or-nothing | `packages/core/tests/property/atomicity.property.ts` | Swallowed entries insert: failed |

### Core: `webhooks-outbox`

The mutations are listed in each file's header.

| Property | File | Mutations, each failed |
|---|---|---|
| A stale or future timestamp is always rejected | `staleTimestamp.property.ts` | Timestamp check skipped. Tolerance widened to 300,000 s. |
| Duplicate and reordered webhooks give the same final balances | `webhookOrder.property.ts` | Inbox dedupe dropped (removed, and separately an always-claiming upsert). Refund on an uncaptured payment marked `rejected` instead of `parked`. `pending` allowed to overwrite `captured`. |
| The outbox never loses a message across crashes | `outboxDurability.property.ts` | Outbox write in a separate transaction after commit. `sent` marked before the sender is called. Lease check skipped in the claim. Attempt counted on failure instead of at claim. |

### Core: `poltergeist-engine`

The mutations are listed in each file's header.

| Property | File | Mutations, each failed |
|---|---|---|
| Same seed, same storm, same report | `stormDeterminism.property.ts` | Replay age drawn from `Math.random`. `generatedAt` timestamp added to the report. Members matched by concrete id instead of member ref. |
| Ossuary never drifts (any seed, up to 2,000 events) | `ossuaryZeroDrift.property.ts` | Early refunds `rejected` instead of `parked`. Parked refunds never applied. A fresh idempotency key per payout request. Every error caught in `applyRefund`'s savepoint. Dropping only the inbox dedupe is **not** detected, by design: three other defenses still stop the duplicate (see the file header). |
| The twin drifts, and the report names the fault | `twinDrifts.property.ts` | "Expected" computed from the snapshot. Unit delta measured against the run's start. Counterexample takes the main run's drift. |
| Every blocked ghost maps to a fault in the catalog | `blockedGhosts.property.ts` | Honest units listed as blocked. `faultId` filled from the fault name. Every ghost put in `blocked`. |

### Apps and power

| Area | Properties | Where the mutations are recorded |
|---|---|---|
| The Tontine | 3: zero-sum circle ledger, conservation against a model, idempotent contributions and payouts (`apps/the-tontine/tests/property/`) | `.kiro/specs/the-tontine/tasks.md`, "Mutation log": 8 breaks (M1a–M3). 7 failed. M1d passed, because the app's dues check still held. |
| Haunted Tip Jar | 4: delivery order, reversal cap, money round-trip, crypto shim (`apps/haunted-tip-jar/tests/property/`) | `.kiro/specs/haunted-tip-jar/tasks.md`, tasks 1.3–3.3 and 8. Survivors are listed with reasons: for example, `Math.round(Number(s)*1e6)` is exact in range, so the source scan catches it instead. |
| Power MCP | 4: paths stay inside the workspace, injected violations found on their line, comment stripping keeps line structure, poltergeist command is a fixed template (`power/mcp/tests/property/`) | Each file's header. In `resolveInside`, removing the lexical `..` check passes, as expected, because the `realpath` check still holds. |

## Claims to evidence

| Claim | File | Command to reproduce |
|---|---|---|
| Core: 348 tests pass | `packages/core/tests` | `pnpm --filter core test` (52 files, 348 tests, 44.7 s on this machine) |
| The Tontine: 99 tests and 8 e2e pass (1280 px and 390 px) | `apps/the-tontine` | `pnpm --filter the-tontine test`, then `pnpm --filter the-tontine build && pnpm --filter the-tontine e2e` |
| Haunted Tip Jar: 79 tests and 3 e2e pass | `apps/haunted-tip-jar` | `pnpm --filter haunted-tip-jar test`, then `pnpm --filter haunted-tip-jar e2e` |
| Power: 227 tests pass | `power/mcp/tests` | `pnpm --dir power/mcp install --frozen-lockfile && pnpm --dir power/mcp test` |
| Ossuary does not drift; the twin does | `packages/core/src/poltergeist` | `pnpm --silent poltergeist --seed 7 --events 2000 --target ossuary --json` (and `--target twin`) |
| The twin is unedited agent output | `packages/twin/PRODUCED.md` | `shasum -a 256 packages/twin/src/index.ts` → `92ed1251…8af0f`; `git log --oneline -- packages/twin/src/index.ts` → 1 commit |
| The first spec was written and run in the IDE | `.kiro/specs/ledger-core/tasks.meta.json` | `git log --format=%s \| grep "in Kiro"` |
| Mutation checks for the later properties | Each `*.property.ts` header | `grep -n -A6 "Mutation checks" packages/core/tests/property/*.ts power/mcp/tests/property/*.ts` |
| The Tontine's mutation log | `.kiro/specs/the-tontine/tasks.md` | `awk '/^## Mutation log/,0' .kiro/specs/the-tontine/tasks.md` |
| A drifted fault row never reads zero (Tontine) | `apps/the-tontine/tests/component/faultTable.test.tsx` | `pnpm --filter the-tontine exec vitest --run tests/component/faultTable.test.tsx` (it failed 3 of 3 before the fix) |
| No GitHub Actions run yet | `.github/workflows/` | `gh run list` → `[]` |
| All code written in the hackathon period | git history | `git log --reverse --format=%ad --date=iso \| head -1` → 2026-11-16 19:58 +0530 |

## Repository map

```
.kiro/
  steering/        6 rule files (money, idempotency, ledger, webhooks, product, tech)
  specs/           6 specs: ledger-core, webhooks-outbox, poltergeist-engine, ossuary-power, the-tontine, haunted-tip-jar
  hooks/           4 IDE hooks
  agents/          money-auditor.json (headless read-only reviewer)
packages/
  core/            the skeleton: ledger, idempotency, webhooks, outbox, poltergeist engine, drift meter, CLI
  twin/            Vibe Pay, the vibe-coded twin (unedited; PRODUCED.md)
power/
  plugin.json      the Kiro power: steering + skills + MCP server
  skills/          add-a-money-flow, money-code-review, poltergeist-test
  mcp/             MCP server (own pnpm workspace and lockfile)
apps/
  the-tontine/     savings circle, static Vite + React, PGlite in the browser
  haunted-tip-jar/ streamer tips, static Vite + React, PGlite in the browser
.github/workflows/
  ci.yml           tests, type checks, builds; e2e in a separate job (not yet run)
  money-audit.yml  money-auditor on pull requests (never run)
docs/              spec prompts, session instructions, polish follow-ups, this file
```

## Known limits

- **CI has not run on GitHub.** `.github/workflows/ci.yml` is new in this session and not committed. `money-audit.yml` is committed but has never been triggered (`gh run list` → `[]`). The CI file was checked locally only: the YAML parses, the structure is valid, every `pnpm --filter` target and script exists, and both `--frozen-lockfile` installs succeed.
- **The IDE "install power from folder" route is unconfirmed.** Only the `.kiro/settings/mcp.json` route is tested.
- **The twin is less naive than expected.** See `packages/twin/PRODUCED.md`. Its drift comes from missing signature checks and payout idempotency, and from its refund handling, not from float maths or torn transactions.
- **PGlite logs one harmless `ErrnoError` in the browser.** The Tontine design records it on every open of the IndexedDB database (`.kiro/specs/the-tontine/design.md`, Facts and Q11), and both Tontine e2e specs ignore exactly that error. In this session's headless Chromium, it did not appear on a first load or after a reload, in either app.
- **Some steering is out of date.** See [Steering](#steering).
- **Hook activity is not measured.** See [Agent hooks](#agent-hooks).
