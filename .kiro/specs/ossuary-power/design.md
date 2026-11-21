# Design Document

## Overview

The power gets a small MCP server, three skills, and CI wiring. The server is a thin MCP layer over pure functions, so each Tool can be unit-tested without a protocol round trip and the smoke test only has to prove the wiring.

```
power/
├── plugin.json                 # unchanged shape; args ./mcp/dist/server.js
├── README.md                   # install + usage (Requirement 6.2)
├── skills/
│   ├── money-code-review/SKILL.md
│   ├── poltergeist-test/SKILL.md
│   └── add-a-money-flow/SKILL.md
└── mcp/
    ├── package.json            # @ossuary/power-mcp, private, type: module
    ├── pnpm-workspace.yaml     # own workspace (Open question 1)
    ├── pnpm-lock.yaml
    ├── .gitignore              # !dist/ (Open question 2)
    ├── tsconfig.json, vitest.config.ts
    ├── scripts/build.mjs       # esbuild bundle → dist/server.js
    ├── dist/server.js          # built
    ├── src/
    │   ├── server.ts           # MCP wiring only (stdio)
    │   ├── workspace.ts        # findWorkspaceRoot, resolveInside
    │   ├── result.ts           # ToolResult, ToolError, codes
    │   ├── rules.ts            # Rule_Catalog (frozen)
    │   ├── strip.ts            # stripComments (length-preserving)
    │   ├── checker.ts          # checkSource(text) → Violation[]
    │   └── tools/
    │       ├── checkMoneyCode.ts
    │       ├── runPoltergeist.ts
    │       └── explainRule.ts
    └── tests/
        ├── unit/*.test.ts
        ├── property/*.property.ts
        └── smoke/server.smoke.test.ts
```

## Design decisions

### D1. Pure tool functions, thin MCP layer

Each Tool is `async (input: unknown, ctx: ToolContext) => ToolResult`, where `ToolResult = { ok: true, data } | { ok: false, error: { code, message } }` and `ToolContext = { workspaceRoot, runner? }`. Validation happens inside the tool with a strict zod schema (`.strict()` rejects unknown keys), so unit tests cover it directly. `server.ts` registers each tool with the MCP SDK (`McpServer.registerTool`) using the same zod shape for the advertised JSON schema, and maps `ToolResult` to `{ content: [{ type: 'text', text: JSON }], structuredContent, isError }`.

The SDK validates arguments against the advertised schema before our handler runs and answers a mismatch with its own error. Both paths produce `isError: true`; the smoke test checks that an invalid call is an error and the server stays up.

### D2. One bundle, no run-time dependencies

`scripts/build.mjs` runs esbuild: `bundle: true, platform: 'node', format: 'esm', target: 'node22', entryPoints: ['src/server.ts'], outfile: 'dist/server.js'`, no minify, no sourcemap, `legalComments: 'none'`, and a `#!/usr/bin/env node` banner plus a `createRequire` shim for CommonJS dependencies. esbuild output is deterministic for the same input and version, which gives Requirement 6.4. Because the bundle carries the SDK and zod, `plugin.json` can start it with plain `node` from any clone.

### D3. Workspace root

Resolved once at start-up by `findWorkspaceRoot({ env, cwd, serverDir })`:

1. `OSSUARY_WORKSPACE`, if set and an existing directory;
2. otherwise the nearest ancestor of `cwd` (inclusive) containing a marker: `.kiro/steering/money.md` or `packages/core/src/poltergeist/cli.ts`;
3. otherwise the nearest ancestor of the server file's directory containing a marker (covers Kiro starting the server with `cwd` set to the plugin directory);
4. otherwise `cwd`.

The result is passed through `realpath`. It is the only directory the server reads from.

### D4. Path containment

`resolveInside(root, p)`:

1. reject non-strings, empty strings, strings with `\0` and absolute paths (`path.isAbsolute`, plus a Windows drive or UNC prefix) → `invalid_input`;
2. `candidate = path.resolve(root, p)`; if `path.relative(root, candidate)` starts with `..` or is absolute → `path_outside_workspace` (lexical check, cheap and before touching the disk);
3. `real = realpath(candidate)`; `ENOENT` → `not_found`;
4. accept only if `real === root` or `real.startsWith(root + path.sep)`; otherwise `path_outside_workspace`. Comparing with the separator rules out a sibling such as `/x/ws-evil` for root `/x/ws`; the `realpath` step rules out symlinks that point outside.

Then `checkMoneyCode` checks the extension, `stat` (`not_a_file` unless a regular file, `too_large` above 256 KiB) and reads the file as UTF-8. Paths in output are workspace-relative with `/` separators.

### D5. The checker is line-based and comment-aware

`stripComments(src)` walks the text once with a small state machine (code, `'`, `"`, template, line comment, block comment) and replaces every comment character except `\n` with a space. The output has the same length and the same newline positions as the input, so line numbers carry over. Strings are kept, because SQL lives in them.

`checkSource(src)` builds file-level facts from the stripped text, then runs each rule's line detectors:

| Rule_Id | Line detectors (on stripped lines) | File-level gate |
|---|---|---|
| `float-money` | money word `+` (`: number`, `parseFloat(`, `.toFixed(`, `Math.round/floor/ceil(`, decimal literal `\d+\.\d+`); SQL `real`, `float4/8`, `float`, `double precision`, `decimal(p,s)`/`numeric(p,s)` with s>0 on a money column | none |
| `mutable-balance` | `UPDATE t SET <money col> =`; `<money ident> +=/-=`; column `balance` declared with a numeric type; `UPDATE entries` / `DELETE FROM entries` | none |
| `missing-idempotency-key` | first money-moving line: `postTransaction(`, `refund(`, `payout(`, `transfer(`, `charge(`, `INSERT INTO entries/transactions` | file has no `idempotenc` (any case) and is not a webhook handler |
| `unverified-webhook` | signature compared with `===`/`!==`/`==`/`!=`; else first body read (`.json()`, `.text()`, `req.body`, `JSON.parse(`) | file is a webhook handler and (for the body read) calls no verifier: `verifyWebhook`, `createWebhookHandler`, `timingSafeEqual`, `verify…Signature` |
| `write-outside-transaction` | the second database write (`INSERT INTO`, `UPDATE … SET`, `DELETE FROM`, `.insert(`, `.update(`, `.delete(`, `postTransaction(`) | file has no `.transaction(`, `BEGIN` or `withTransaction` |
| `refund-over-capture` | first refund write: a line with `refund` and a write (`INSERT`, `UPDATE`, `postTransaction(`, `kind: 'refund'`) | file has no cap comparison: `[<>]=?` next to `captured`/`remaining`/`refundable`, or `RefundCapExceeded` |

"Money word" is `amount|balance|price|total|fee|tip|pot|cents|usdc|payout|refund|paid_?out|captured|subtotal` as a word part (case-insensitive). A "webhook handler" is a file that contains `webhook` and reads a request body.

This is a heuristic (Open question 4). The examples in the Rule_Catalog and the per-rule unit snippets pin its behaviour. Known gaps are listed in the README.

### D6. Rule_Catalog

`rules.ts` exports `RULES: readonly Rule[]` (frozen), with `{ id, title, steeringFile, rule, message, fix, bug, fixExample }`. `rule` is a verbatim quote of the steering bullet (minus the leading `- `). A unit test reads each `steeringFile` from the repo and checks that it contains `rule`, so a steering edit that changes the wording fails the test instead of leaving stale text. `ossuary_explain_rule` returns the catalog entry and does not read the disk, so it works in a workspace without Ossuary's steering.

### D7. Running the poltergeist

`buildPoltergeistCommand(root, input)` validates input and returns `{ file: process.execPath, args: [tsxCli, cliPath, '--seed', S, '--events', E, '--target', T, '--json'], cwd: coreDir }`. `tsxCli` is resolved with `createRequire(join(coreDir, 'package.json')).resolve('tsx/cli')`, so no `pnpm` or `PATH` lookup is involved. The command runs through `execFile` (no shell) with `timeout: 120_000`, `maxBuffer: 32 MiB`, `killSignal: 'SIGKILL'`, and the parent's environment. The runner is injectable through `ToolContext` so unit tests can feed canned stdout, failures and timeouts.

The result is parsed with `JSON.parse` and accepted only if `schema === 'ossuary/poltergeist-report'` and `version === 1`. `summary.drifted` is `report.drift.total !== '0' || report.faults.some(f => f.drifted > 0)`.

### D8. Hook, agent and workflow

- **Hook.** `askAgent`: call `ossuary_run_poltergeist` with `{seed: 7, events: 300, target: 'ossuary'}` then `'twin'`; report total drift per target and the drifted faults; Ossuary must be `0`. Fallback: `pnpm --filter core poltergeist --seed 7 --events 300 --target <t> --json`.
- **Agent.** Adds `mcpServers.ossuary` (`node power/mcp/dist/server.js`, `OSSUARY_WORKSPACE: "."`), tools `read`, `grep`, `glob`, `@ossuary/ossuary_check_money_code`, `@ossuary/ossuary_explain_rule`, and the same list in `allowedTools`. `run_poltergeist` is left out: the audit reviews a diff, and a CI review should not depend on a 2,000-event run. Resources: steering files and the `money-code-review` skill.
- **Workflow.** Job `audit` on `pull_request` (paths `packages/**`, `apps/**`, `power/**`, `.kiro/**`), `permissions: contents: read`. Step 1 checks `KIRO_API_KEY` from `env` and sets `outputs.enabled`; when empty it writes a `::notice` and a job-summary line and every later step is skipped with `if: steps.gate.outputs.enabled == 'true'`. Later steps: checkout (`fetch-depth: 0`), pnpm and Node 22, `pnpm --dir power/mcp install --frozen-lockfile`, `pnpm --dir power/mcp build`, install Kiro CLI, `git diff "origin/$BASE_REF...HEAD" > diff.patch` with `BASE_REF: ${{ github.base_ref }}` in `env`, run `kiro-cli chat --no-interactive --agent money-auditor "…"`, append `audit.md` to `$GITHUB_STEP_SUMMARY`, and fail unless the last non-empty line is `VERDICT: PASS`. The `pull-requests: write` permission is dropped because nothing posts a comment.

## Data models

```ts
type ToolErrorCode =
  | 'invalid_input' | 'path_outside_workspace' | 'not_found' | 'not_a_file'
  | 'unsupported_file_type' | 'too_large' | 'poltergeist_unavailable'
  | 'poltergeist_failed' | 'timeout' | 'internal';

interface Violation { rule: RuleId; line: number; excerpt: string; message: string; fix: string }

interface CheckResult {
  source: { kind: 'path'; path: string } | { kind: 'snippet'; filename: string | null };
  clean: boolean;
  violations: Violation[];
  summary: { total: number; byRule: Partial<Record<RuleId, number>> };
  note: string;                                   // "heuristic; clean is not proof"
}

interface PoltergeistResult {
  summary: { target: 'ossuary' | 'twin'; seed: number; events: number; asset: string; decimals: number;
             driftTotal: string; drifted: boolean; driftedFaults: string[] };
  report: unknown;                                // the Drift_Report, unchanged
}
```

## Error handling

Every tool body runs inside `try/catch`; an unexpected exception becomes `internal` with the error's message (never a stack, never file contents). The server never writes to stdout except through the SDK transport; diagnostics go to stderr.

## Correctness properties

### Property 1: Resolved paths never leave the workspace
For any path built from segments `..`, `.`, `a`, `sub`, `out-link` (a symlink to a directory outside), `ws-evil` siblings, absolute prefixes and file names, `resolveInside` either returns an error or a real path equal to the root or under `root + sep`; and for every path whose lexical and real target is a file inside the root, it succeeds. Validates 1.6, 2.2, 2.3. Breaks: drop the `realpath` step; compare with `startsWith(root)` without the separator.

### Property 2: Injected violations are found on their line; clean code stays clean
For any program assembled from a pool of clean lines (all six rules satisfied, including an idempotency key, a transaction, a verifier and a cap check), the checker reports nothing. Inserting one violating line for rule R at any position yields a violation of R on exactly that line. Validates 2.5–2.8. Breaks: disable one detector; ignore comment stripping; off-by-one line numbers.

### Property 3: Comment stripping preserves length and line structure
For any string, `stripComments(s)` has the same length, has `\n` exactly where `s` does, and leaves every character outside comments unchanged. Validates 2.7. Breaks: delete comments instead of blanking them; blank newlines inside block comments.

### Property 4: The poltergeist command is a fixed template
For any JSON value as input, `buildPoltergeistCommand` either returns `invalid_input` or an argv equal to `[tsx, cli, '--seed', S, '--events', E, '--target', T, '--json']` with `S`, `E` decimal integers in range and `T ∈ {ossuary, twin}`, and the accepted inputs are exactly the schema's. Validates 1.5, 1.6, 3.1, 3.2. Breaks: accept non-integer numbers; accept a free-form target string.

Each property runs at least 25 cases (cheap ones run 200). Mutation results are recorded at the top of each property file.

## Testing strategy

- Unit: `workspace.test.ts` (root discovery, each escape), `checkMoneyCode.test.ts` (one snippet per rule, path and snippet inputs, every error code), `explainRule.test.ts` (each rule, quotes present in steering, bug flagged, fix clean, bad id), `runPoltergeist.test.ts` (injected runner: success, non-zero exit, bad JSON, wrong schema, timeout, missing CLI; plus one real 60-event run per target), `config.test.ts` (plugin.json paths, skills front matter and references, hook and agent JSON, workflow YAML structure).
- Smoke: builds with `scripts/build.mjs`, checks that a second build is byte-identical, spawns `node dist/server.js` with `StdioClientTransport`, lists tools, calls each with valid and invalid input.
- Property: Properties 1–4 above.
- Outside the suite: `kiro-cli agent validate --path .kiro/agents/money-auditor.json`.
