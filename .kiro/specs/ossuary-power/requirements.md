# Requirements Document

## Introduction

`ossuary-power` finishes the Ossuary Kiro power in `power/`. Today `power/plugin.json` starts `node ./mcp/dist/server.js`, which does not exist, so the power is broken. This spec adds:

1. an MCP server in `power/mcp` (TypeScript, bundled to `power/mcp/dist/server.js`) with three tools: `ossuary_check_money_code`, `ossuary_run_poltergeist` and `ossuary_explain_rule`;
2. accurate skills: `money-code-review` and `poltergeist-test` (rewritten against today's code and tools) and a new `add-a-money-flow`;
3. a documented install for the Kiro IDE and the Kiro CLI, a smoke test that starts the built server over stdio and calls each tool, and a README section;
4. the `summon-poltergeist` hook wired to the new tool, the `money-auditor` custom agent runnable headless in CI with `KIRO_API_KEY`, and a valid `.github/workflows/money-audit.yml` that skips with a clear message when the secret is absent.

The power follows the open Agent Plugins layout (`plugin.json`, `skills/<name>/SKILL.md`, an MCP server entry) and the rules in `.kiro/steering/*.md`.

Files this spec may create or change: anything under `power/`, `.kiro/hooks/`, `.kiro/agents/`, `.kiro/specs/ossuary-power/`, and `.github/workflows/money-audit.yml`. Nothing under `apps/`, `packages/core/src` or `packages/twin` changes.

## Glossary

- **Power**: The Kiro power in `power/`: `plugin.json`, the skills, the steering it points at and the MCP_Server.
- **MCP_Server**: The Model Context Protocol server in `power/mcp`, speaking JSON-RPC over stdio. Its built entry is `power/mcp/dist/server.js`.
- **Tool**: One MCP tool exposed by the MCP_Server.
- **Workspace_Root**: The directory the MCP_Server treats as the project. Resolved once at start-up (design D3).
- **Steering_Rule**: One bullet of a file in `.kiro/steering/` that the Checker enforces.
- **Rule_Id**: A Steering_Rule's stable lowercase kebab-case id. The six checked rules are `float-money`, `mutable-balance`, `missing-idempotency-key`, `unverified-webhook`, `write-outside-transaction`, `refund-over-capture`.
- **Rule_Catalog**: The frozen list of Rules in `power/mcp/src/rules.ts`, each with its Rule_Id, title, steering file, verbatim steering quote, bug example and fix example.
- **Checker**: The static, heuristic analyser behind `ossuary_check_money_code`.
- **Violation**: One Checker finding: Rule_Id, 1-based line, excerpt, message and fix.
- **Snippet**: Source text passed directly to `ossuary_check_money_code` instead of a path.
- **Poltergeist_CLI**: `packages/core/src/poltergeist/cli.ts`, run as `pnpm --filter core poltergeist --seed N --events M --target ossuary|twin --json`.
- **Drift_Report**: The JSON document the Poltergeist_CLI prints with `--json` (`schema: "ossuary/poltergeist-report"`, `version: 1`).
- **Tool_Error**: A structured failure: `{ "error": { "code": <string>, "message": <string> } }`, returned with MCP `isError: true`.
- **Money_Auditor**: The headless custom agent `.kiro/agents/money-auditor.json`.
- **Audit_Workflow**: `.github/workflows/money-audit.yml`.

## Requirements

### Requirement 1: MCP server

**User Story:** As a developer using Kiro, I want the Ossuary power to start an MCP server that works, so that Kiro can check money code while it writes it.

#### Acceptance Criteria

1. THE MCP_Server SHALL be a TypeScript package in `power/mcp`, built to a single self-contained ES module `power/mcp/dist/server.js` that runs with `node` (22 or later) and needs no `node_modules` at run time.
2. THE MCP_Server SHALL speak MCP over stdio and list exactly three Tools: `ossuary_check_money_code`, `ossuary_run_poltergeist` and `ossuary_explain_rule`, each with a description and a JSON input schema.
3. WHEN a Tool succeeds, THE MCP_Server SHALL return the result as JSON text in the first content item and the same object as `structuredContent`.
4. WHEN a Tool fails, THE MCP_Server SHALL return a Tool_Error with `isError: true`, and SHALL NOT crash or write anything but protocol messages to stdout.
5. THE MCP_Server SHALL reject any Tool input that does not match the Tool's schema, including unknown properties, with Tool_Error code `invalid_input`.
6. THE MCP_Server SHALL NOT run a shell, SHALL NOT run any program other than the Poltergeist_CLI (Requirement 3), and SHALL NOT read any file outside the Workspace_Root.
7. THE MCP_Server SHALL NOT use the network.

### Requirement 2: `ossuary_check_money_code`

**User Story:** As Kiro writing payment code, I want to check a file or a snippet against the money rules, so that I catch float money, mutable balances and missing keys before they ship.

#### Acceptance Criteria

1. THE Tool SHALL accept exactly one of `path` (a file path) or `code` (a Snippet). With `code` it SHALL accept an optional `filename` used only for display. Supplying both, or neither, SHALL return Tool_Error `invalid_input`.
2. WHEN `path` is given, THE Tool SHALL resolve it against the Workspace_Root, follow symbolic links, and read the file only if its real path is inside the real Workspace_Root. Otherwise it SHALL return Tool_Error `path_outside_workspace` without reading the file.
3. WHEN `path` is absolute, contains a NUL byte, names a directory, does not exist, has an extension other than `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs` or `.sql`, or is larger than 256 KiB, THE Tool SHALL return a Tool_Error (`invalid_input`, `not_a_file`, `not_found`, `unsupported_file_type` or `too_large`).
4. WHEN `code` is longer than 262,144 characters, THE Tool SHALL return Tool_Error `too_large`.
5. THE Checker SHALL report each Violation with its Rule_Id, 1-based line number, the trimmed source line as excerpt (at most 200 characters), a message and a fix taken from the Rule_Catalog.
6. THE Checker SHALL detect at least these patterns:
   - `float-money`: a money-named value typed as `number`, parsed with `parseFloat`, formatted with `toFixed`, rounded with `Math.round|floor|ceil`, or written as a decimal literal; or a money column declared `real`, `float`, `double precision` or `decimal(...)` with a scale.
   - `mutable-balance`: an `UPDATE ... SET <money column> =`, a `+=`/`-=` on a money-named value, a stored balance column, or any `UPDATE` or `DELETE` on ledger entries.
   - `missing-idempotency-key`: code that moves money (posts a transaction, refunds, pays out, charges, transfers, or inserts ledger rows) in a file that never mentions an idempotency key, unless the file is a webhook handler.
   - `unverified-webhook`: a webhook handler that reads the body and never verifies a signature, or compares a signature with `===`/`!==` instead of a constant-time compare.
   - `write-outside-transaction`: two or more database writes in a file that never opens a transaction.
   - `refund-over-capture`: a refund write with no comparison against the captured or remaining amount.
7. THE Checker SHALL ignore text inside `//` and `/* */` comments, and SHALL keep line numbers of the original source.
8. THE Checker SHALL be deterministic: the same input gives the same Violations, sorted by line and then by Rule_Id, with at most one Violation per (line, Rule_Id).
9. THE Tool SHALL return `{ source, clean, violations, summary }`, where `clean` is true exactly when there are no Violations and `summary` counts Violations per Rule_Id.
10. THE Tool's description and output SHALL state that the Checker is heuristic and that a clean result is not proof of safety.

### Requirement 3: `ossuary_run_poltergeist`

**User Story:** As Kiro or a developer, I want to run the poltergeist from the chat, so that I can see whether a change makes the ledger drift.

#### Acceptance Criteria

1. THE Tool SHALL accept `seed` (integer 0 to 4,294,967,295, default 7), `events` (integer 1 to 2,000, default 300) and `target` (`ossuary` or `twin`, default `ossuary`), and nothing else.
2. THE Tool SHALL run the Poltergeist_CLI found at `packages/core/src/poltergeist/cli.ts` under the Workspace_Root, with `node` and the `tsx` loader from `packages/core`, using a fixed argument list built only from the validated integers and the target. It SHALL NOT use a shell.
3. THE Tool SHALL stop the run after 120 seconds and return Tool_Error `timeout`.
4. WHEN the Poltergeist_CLI or `tsx` is missing, THE Tool SHALL return Tool_Error `poltergeist_unavailable` naming what is missing.
5. WHEN the Poltergeist_CLI exits non-zero or prints something that is not a Drift_Report, THE Tool SHALL return Tool_Error `poltergeist_failed` with the exit code and at most 2,000 characters of stderr.
6. WHEN the run succeeds, THE Tool SHALL return `{ summary, report }`, where `report` is the Drift_Report unchanged and `summary` holds the target, seed, events, total drift as a decimal string of minor units, the asset, `drifted` (true when total drift is not `"0"` or any fault drifted), and the ids of faults that drifted.
7. THE Tool SHALL keep amounts as strings of integer minor units, as the Drift_Report gives them.

### Requirement 4: `ossuary_explain_rule`

**User Story:** As Kiro, I want the exact text of a money rule and a small bug-and-fix example, so that I can explain a Violation and repair it.

#### Acceptance Criteria

1. THE Tool SHALL accept `rule`, one of the Rule_Ids, and return `{ id, title, steeringFile, rule, bug, fix }`.
2. THE `rule` field SHALL be the verbatim text of the bullet in `steeringFile`, and a test SHALL check that each quote still appears in that file.
3. THE `bug` and `fix` examples SHALL be TypeScript or SQL; the Checker SHALL report the rule on the `bug` example and SHALL NOT report it on the `fix` example.
4. WHEN `rule` is not a Rule_Id, THE Tool SHALL return Tool_Error `invalid_input` listing the valid Rule_Ids.

### Requirement 5: Skills

**User Story:** As Kiro, I want skills that match the code and tools that exist today, so that I follow the right procedure.

#### Acceptance Criteria

1. `power/skills/money-code-review/SKILL.md`, `power/skills/poltergeist-test/SKILL.md` and `power/skills/add-a-money-flow/SKILL.md` SHALL exist, each starting with YAML front matter whose `name` equals its directory name and with a `description` that says when to use it.
2. The skills SHALL name only Tools, Rule_Ids, commands, files and `@ossuary/core` exports that exist; a test SHALL check every tool name, Rule_Id, repository path and core export they mention.
3. `money-code-review` SHALL tell Kiro to call `ossuary_check_money_code` and `ossuary_explain_rule`, then review what the Checker cannot see.
4. `poltergeist-test` SHALL describe the real test helpers, the 25-run minimum, the mutation check, and how to run `ossuary_run_poltergeist` or the Poltergeist_CLI.
5. `add-a-money-flow` SHALL walk through adding a flow: idempotency key, one transaction, a property test, a mutation check, a Checker run and a poltergeist run.

### Requirement 6: Install and documentation

**User Story:** As a developer, I want to install the power into Kiro and know it works, so that I can use it in my own project.

#### Acceptance Criteria

1. `power/plugin.json` SHALL be valid JSON, SHALL point its MCP server at `./mcp/dist/server.js`, and every path it lists SHALL exist after the build.
2. `power/README.md` SHALL document building the server, installing the power in the Kiro IDE and in the Kiro CLI, the three Tools with an example call each, the Workspace_Root rule, the hook, the Money_Auditor and the Audit_Workflow.
3. A smoke test SHALL build the MCP_Server, spawn `node power/mcp/dist/server.js` over stdio with an MCP client, list the Tools and call each one with valid input and with invalid input.
4. THE built `dist/server.js` SHALL be reproducible: building twice from the same source gives the same bytes.

### Requirement 7: Hook, custom agent and CI

**User Story:** As a maintainer, I want the manual hook and the CI audit to use the power, so that every pull request is checked against the money rules without breaking forks.

#### Acceptance Criteria

1. `.kiro/hooks/summon-poltergeist.kiro.hook` SHALL stay a `userTriggered` hook and SHALL ask the agent to call `ossuary_run_poltergeist` for both targets (falling back to the Poltergeist_CLI if the Tool is not available) and report drift per target.
2. THE Money_Auditor SHALL load the MCP_Server, SHALL have only read-only built-in tools plus `ossuary_check_money_code` and `ossuary_explain_rule`, SHALL pre-approve exactly those tools so it can run with `--no-interactive`, and SHALL pass `kiro-cli agent validate`.
3. THE Money_Auditor's prompt SHALL tell it to run `ossuary_check_money_code` on each changed source file in the diff, never modify files, and end with exactly one line `VERDICT: PASS` or `VERDICT: FAIL`.
4. THE Audit_Workflow SHALL be valid GitHub Actions YAML, run on pull requests that touch `packages/`, `apps/`, `power/` or `.kiro/`, and use read-only repository permissions.
5. WHEN the `KIRO_API_KEY` secret is absent or empty, THE Audit_Workflow SHALL print a notice that says the audit was skipped and why, and SHALL finish successfully without installing Kiro.
6. WHEN the secret is present, THE Audit_Workflow SHALL build the MCP_Server, install the Kiro CLI, write the diff, run the Money_Auditor headless, publish the report to the job summary, and fail the job unless the report's last non-empty line is `VERDICT: PASS`.
7. THE Audit_Workflow SHALL pass untrusted values (branch names) to scripts through environment variables, never by expanding `${{ }}` inside `run:`.

### Requirement 8: Tests

**User Story:** As a maintainer, I want the power covered by unit, property and smoke tests, so that it keeps working.

#### Acceptance Criteria

1. Each Tool SHALL have unit tests for valid input, invalid input and, for `ossuary_check_money_code`, path escape attempts (`..`, absolute paths, a symlink out of the workspace, a sibling directory sharing the workspace name as prefix) and one Snippet per Rule_Id.
2. Every property test SHALL run at least 25 cases and SHALL be shown to fail against at least one deliberate break of the code before it is accepted; the break and its result SHALL be recorded in the test file.
3. The power's tests SHALL run with `pnpm --dir power/mcp test` and need no network and no environment variables.

## Open questions

1. **Workspace membership.** `pnpm-workspace.yaml` lists only `packages/*` and `apps/*`, and this spec may not edit it. Decision: `power/mcp` is its own small pnpm workspace (its own `pnpm-workspace.yaml` and lockfile). This also keeps it off the shared root lockfile that other sessions are editing. Moving it into the root workspace later is a two-line change.
2. **Committing `dist/`.** The root `.gitignore` ignores `dist/`, which means a fresh clone has no `server.js` and the power fails until someone builds it. Decision: `power/mcp/.gitignore` re-includes `dist/` so the bundle can be committed, and the smoke test checks the bundle is reproducible. Whether to commit it is left to the maintainer; the README documents the build either way.
3. **Workspace root when installed elsewhere.** It is not documented what working directory Kiro gives a plugin's MCP server. Decision: `OSSUARY_WORKSPACE` if set, else the nearest ancestor of the working directory that contains `.kiro/steering/money.md` or `packages/core/src/poltergeist/cli.ts`, else the working directory (design D3).
4. **Heuristic checker.** A full type-aware analysis would need the TypeScript compiler API; the repo uses TypeScript 7, whose JS API is not stable. Decision: a comment-aware, line-based checker with documented false positives and negatives.
5. **Root README.** The prompt asks for "a README section"; the root `README.md` is outside this session's allowed files. Decision: the section lives in `power/README.md`; linking it from the root README's "How Kiro was used" is left to the owner.
6. **Event cap.** The Poltergeist_CLI accepts up to 20,000 events. The Tool caps at 2,000 so a call finishes well inside the 120-second limit.
7. **Hook wiring.** A `runCommand` hook cannot call an MCP tool. Decision: the hook stays `askAgent` and tells the agent to call the Tool, with the CLI as fallback.
