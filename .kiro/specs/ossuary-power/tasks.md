# Implementation Plan: ossuary-power

## Overview

Build the MCP server in `power/mcp` bottom-up (workspace and paths, rules and checker, tools, server and bundle), then the skills, docs, hook, agent and workflow. Paths are relative to the repo root.

Conventions for every task:

- **Scope.** Only files under `power/`, `.kiro/hooks/`, `.kiro/agents/`, `.kiro/specs/ossuary-power/` and `.github/workflows/money-audit.yml` change.
- **Tests.** `pnpm --dir power/mcp test` (vitest `--run`), no network, no environment variables. `pnpm --dir power/mcp typecheck` stays clean.
- **Definition of done.** The task's own tests pass, the power suite passes and typecheck is clean.
- **Properties.** A property task is done only after it has failed against each listed break and the break is reverted. Record the breaks in the file header.

## Tasks

- [x] 1. Package scaffold
  - Create `power/mcp/package.json` (`@ossuary/power-mcp`, private, `type: module`, scripts `build`, `test`, `typecheck`), `pnpm-workspace.yaml` (own workspace, `allowBuilds: esbuild`), `tsconfig.json` (strict, NodeNext, noEmit), `vitest.config.ts`, `.gitignore` (`!dist/`)
  - Add dependencies with `pnpm --filter @ossuary/power-mcp add`: `@modelcontextprotocol/sdk`, `zod`; dev: `typescript`, `vitest`, `fast-check`, `esbuild`, `@types/node`, `yaml`
  - Verify: `pnpm --dir power/mcp typecheck` and an empty-ish test run pass
  - _Requirements: 1.1, 8.3_

- [x] 2. Workspace root and path containment
  - [x] 2.1 `src/result.ts` and `src/workspace.ts`: `findWorkspaceRoot`, `resolveInside` (design D3, D4)
    - Unit tests: env override, marker discovery from cwd and from server dir, fallback; `..`, absolute, NUL, empty, symlink out, sibling prefix, not found, inside symlink allowed
    - _Requirements: 1.6, 2.2, 2.3_
  - [x] 2.2 Property 1: resolved paths never leave the workspace
    - Breaks: drop `realpath`; `startsWith(root)` without separator
    - _Requirements: 1.6, 2.2_

- [x] 3. Rules and checker
  - [x] 3.1 `src/strip.ts` and Property 3 (comment stripping preserves length and lines)
    - Breaks: delete comments instead of blanking; blank newlines in block comments
    - _Requirements: 2.7_
  - [x] 3.2 `src/rules.ts` (Rule_Catalog) and `src/checker.ts` (design D5, D6)
    - Unit tests: one violating snippet per rule (reported on the right line), each catalog `bug` flagged and `fix` clean, comments ignored, sorting and de-duplication, each `rule` quote present in its steering file
    - _Requirements: 2.5–2.8, 4.2, 4.3_
  - [x] 3.3 Property 2: injected violations are found on their line; clean code stays clean
    - Breaks: disable a detector; skip comment stripping; off-by-one line numbers
    - _Requirements: 2.5–2.8_

- [x] 4. Tools
  - [x] 4.1 `src/tools/checkMoneyCode.ts`
    - Unit tests: path and snippet success, both/neither, unknown key, every error code, escapes, output shape, note text
    - _Requirements: 2.1–2.10_
  - [x] 4.2 `src/tools/explainRule.ts`
    - Unit tests: every Rule_Id, unknown id lists valid ids, unknown key rejected
    - _Requirements: 4.1–4.4_
  - [x] 4.3 `src/tools/runPoltergeist.ts` (design D7)
    - Unit tests with an injected runner: defaults, success summary, non-zero exit, stderr truncation, invalid JSON, wrong schema, timeout, CLI missing, tsx missing; one real 60-event run per target (ossuary drift `0`, twin drifts)
    - _Requirements: 3.1–3.7_
  - [x] 4.4 Property 4: the poltergeist command is a fixed template
    - Breaks: accept non-integer numbers; accept any target string
    - _Requirements: 1.5, 3.1, 3.2_

- [x] 5. Server, bundle and smoke test
  - [x] 5.1 `src/server.ts` (design D1) and `scripts/build.mjs` (design D2)
  - [x] 5.2 `tests/smoke/server.smoke.test.ts`: build twice (identical bytes), spawn `node dist/server.js`, list tools, call each valid and invalid, server still answers after errors
    - _Requirements: 1.1–1.5, 6.3, 6.4_

- [x] 6. Skills
  - Rewrite `money-code-review` and `poltergeist-test`; add `add-a-money-flow`
  - `tests/unit/config.test.ts`: front matter, and every tool name, Rule_Id, repo path and core export mentioned exists
  - _Requirements: 5.1–5.5_

- [x] 7. Plugin manifest and README
  - Check `power/plugin.json`; write `power/README.md` (build, IDE and CLI install, tools with examples, workspace root, hook, agent, workflow, checker limits)
  - `config.test.ts`: plugin.json paths exist after build
  - _Requirements: 6.1, 6.2_

- [x] 8. Hook, custom agent and workflow
  - [x] 8.1 Rewrite `.kiro/hooks/summon-poltergeist.kiro.hook`; test it parses and names the tool and both targets
    - _Requirements: 7.1_
  - [x] 8.2 Update `.kiro/agents/money-auditor.json`; test its tool lists; run `kiro-cli agent validate`
    - _Requirements: 7.2, 7.3_
  - [x] 8.3 Rewrite `.github/workflows/money-audit.yml`; test YAML structure (triggers, permissions, gate step, every later step guarded, no `${{` inside `run:`); exercise the gate script with and without the key
    - _Requirements: 7.4–7.7_

- [x] 9. Final checkpoint
  - `pnpm --dir power/mcp typecheck`, `pnpm --dir power/mcp test`, `kiro-cli agent validate`, then the full `pnpm --filter core test` once
  - Confirm `git status` shows changes only in the allowed paths
  - _Requirements: all_

## Notes

- Every task is required. None are optional.
- `apps/`, `packages/core/src` and `packages/twin` are read but never edited.
- Nothing is committed.
