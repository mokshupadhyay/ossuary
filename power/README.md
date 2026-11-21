# The Ossuary power

A Kiro power that makes AI-written payment code survive duplicate webhooks, double-taps, retries and crashes. It bundles:

| Part | Where | What it does |
|---|---|---|
| Steering | `../.kiro/steering/` | The money, ledger, idempotency and webhook rules. |
| Skills | `skills/` | `money-code-review`, `poltergeist-test`, `add-a-money-flow`. |
| MCP server | `mcp/` → `mcp/dist/server.js` | Three tools: check money code, run the poltergeist, explain a rule. |
| Manifest | `plugin.json` | Points Kiro at the steering, the skills and the server. |

## Build

The server is one bundled ES module with no run-time dependencies. It needs Node 22 or later.

```bash
pnpm --dir power/mcp install --frozen-lockfile
pnpm --dir power/mcp build        # writes power/mcp/dist/server.js
pnpm --dir power/mcp test         # unit, property and smoke tests
```

`power/mcp` is its own pnpm workspace, so building it does not touch the root lockfile. The build is reproducible: building twice gives identical bytes, and the smoke test checks this. The root `.gitignore` ignores `dist/`; `power/mcp/.gitignore` re-includes it so the bundle can be committed and the power works straight from a clone.

`ossuary_run_poltergeist` also needs the repository's own dependencies (`pnpm install` at the root), because it runs `packages/core` through `tsx`.

## Install

### Kiro CLI

Add the server to the workspace MCP config (`.kiro/settings/mcp.json`) from the repository root:

```bash
kiro-cli mcp add --name ossuary --scope workspace --command node --args power/mcp/dist/server.js
kiro-cli mcp status --name ossuary
```

To give an agent the skills as well, add them to its resources, as `.kiro/agents/money-auditor.json` does:

```json
"resources": ["skill://power/skills/**/SKILL.md", "file://.kiro/steering/**/*.md"]
```

### Kiro IDE

The IDE reads the same workspace file. Create `.kiro/settings/mcp.json` with:

```json
{
  "mcpServers": {
    "ossuary": {
      "command": "node",
      "args": ["power/mcp/dist/server.js"],
      "env": { "OSSUARY_WORKSPACE": "." },
      "disabled": false,
      "autoApprove": ["ossuary_check_money_code", "ossuary_explain_rule"]
    }
  }
}
```

The server then shows up in the MCP panel with its three tools. If your Kiro version installs powers from a local folder, point it at `power/`; `plugin.json` declares the same server, the skills and the steering. This route depends on your Kiro version and is not covered by the tests here. The MCP config above is.

### In another project

Copy `power/` and `.kiro/steering/` into the project, or set `OSSUARY_WORKSPACE` to the project root. `ossuary_check_money_code` and `ossuary_explain_rule` work in any project; `ossuary_run_poltergeist` needs `packages/core` from this repository.

## Tools

Every tool validates its input against a strict schema (unknown properties are rejected), returns JSON as text and as `structuredContent`, and reports failures as `{ "error": { "code", "message" } }` with `isError: true`. No tool runs a shell, uses the network or reads outside the workspace root.

### `ossuary_check_money_code`

Checks a file or a snippet against the six rules that can be spotted in text.

```json
{ "path": "packages/twin/src/index.ts" }
```

```json
{ "code": "let amount: number = 0;", "filename": "tip.ts" }
```

```json
{
  "source": { "kind": "snippet", "filename": "tip.ts" },
  "clean": false,
  "violations": [
    { "rule": "float-money", "line": 1, "excerpt": "let amount: number = 0;", "message": "…", "fix": "…" }
  ],
  "summary": { "total": 1, "byRule": { "float-money": 1 } },
  "note": "Heuristic, line-based check …"
}
```

| Rule id | Flags |
|---|---|
| `float-money` | money typed `number`, `parseFloat`, `toFixed`, `Math.round`, `Number(...)`, decimal literals next to money; `real`, `float`, `double precision`, `numeric(p,s)` money columns |
| `mutable-balance` | `UPDATE … SET <money> =`, `obj.balance +=`, a stored balance column, `UPDATE`/`DELETE` on `entries` |
| `missing-idempotency-key` | money moved (`postTransaction`, `refund`, `payout`, `transfer`, `charge`, inserts into entries) in a file that never mentions an idempotency key |
| `unverified-webhook` | a webhook handler that reads the body and never verifies a signature; a signature compared with `===` |
| `write-outside-transaction` | a second database write in a file that never opens a transaction |
| `refund-over-capture` | a refund written with no comparison against captured or remaining |

Errors: `invalid_input` (bad or extra fields, both or neither of `path` and `code`, absolute paths, NUL bytes), `path_outside_workspace` (`..`, or a symlink that leads out), `not_found`, `not_a_file`, `unsupported_file_type` (only `.ts .tsx .mts .cts .js .jsx .mjs .cjs .sql`), `too_large` (files over 256 KiB, snippets over 262,144 characters).

**Limits.** The checker reads text, not types or data flow. It skips comments and keeps line numbers, but it does not follow imports, so a key passed in from another file looks missing, and a balance mutated through a helper looks clean. A clean result is not proof of safety: write the property test and run the poltergeist too.

### `ossuary_run_poltergeist`

Runs `packages/core/src/poltergeist/cli.ts` with `node` and `tsx`, with a fixed argument list and a 120-second limit.

```json
{ "seed": 7, "events": 300, "target": "twin" }
```

`seed` is 0 to 4,294,967,295 (default 7), `events` 1 to 2,000 (default 300), `target` `ossuary` (default) or `twin`. The result holds the drift report unchanged, plus a summary:

```json
{
  "summary": { "target": "twin", "seed": 7, "events": 300, "asset": "USDC", "decimals": 6,
               "driftTotal": "9670059954", "drifted": true,
               "driftedFaults": ["duplicate-delivery", "out-of-order", "refund-before-capture", "double-tap",
                                 "crash-mid-step", "refund-races-payout", "late-after-refund"] },
  "report": { "schema": "ossuary/poltergeist-report", "version": 1, "…": "…" }
}
```

Amounts are integer minor units as strings. Errors: `invalid_input`, `poltergeist_unavailable` (no CLI or no `tsx` in the workspace), `poltergeist_failed` (non-zero exit, or output that is not a version-1 report), `timeout`.

### `ossuary_explain_rule`

```json
{ "rule": "refund-over-capture" }
```

Returns `{ id, title, steeringFile, rule, bug, fix }`. `rule` is the steering bullet word for word (a test fails if the steering changes), `bug` is flagged by the checker and `fix` is clean.

## Workspace root

The server picks the one directory it may read, once, at start-up:

1. `OSSUARY_WORKSPACE`, if it names a directory (relative values are resolved against the working directory);
2. else the nearest ancestor of the working directory that contains `.kiro/steering/money.md` or `packages/core/src/poltergeist/cli.ts`;
3. else the nearest such ancestor of the server file itself;
4. else the working directory.

The chosen directory is printed to stderr (`ossuary MCP server 0.1.0 ready; workspace …`). Paths given to tools must be relative to it. Each path is resolved, symlinks are followed, and the real path must be the root or under `root/`. A sibling such as `ossuary-evil/` does not count as inside `ossuary/`.

## Hook, headless agent and CI

- **`.kiro/hooks/summon-poltergeist.kiro.hook`**: a manual button. It asks the agent to call `ossuary_run_poltergeist` for `ossuary` and `twin` (seed 7, 300 events) and report the drift of each. If the tool is not available it falls back to `pnpm --filter core poltergeist … --json`.
- **`.kiro/agents/money-auditor.json`**: a read-only custom agent. It loads this MCP server, may use only `read`, `grep`, `glob`, `ossuary_check_money_code` and `ossuary_explain_rule`, all pre-approved so it runs with `--no-interactive`, and ends its report with `VERDICT: PASS` or `VERDICT: FAIL`. Run it locally with:

  ```bash
  git diff origin/main...HEAD > diff.patch
  kiro-cli chat --no-interactive --agent money-auditor "Audit diff.patch against the steering rules."
  ```

- **`.github/workflows/money-audit.yml`**: runs the money-auditor on pull requests that touch `packages/`, `apps/`, `power/` or `.kiro/`. Add a repository secret `KIRO_API_KEY` to enable it. Without the secret (forks, or before you add it) the job prints a notice that the audit was skipped and why, and passes. With it, the job builds the server, installs the Kiro CLI, audits the diff, writes the report to the job summary and fails unless the report's last line is `VERDICT: PASS`.
