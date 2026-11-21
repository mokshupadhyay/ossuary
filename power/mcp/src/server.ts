/**
 * Ossuary MCP server: MCP wiring only (design D1). Speaks JSON-RPC over stdio;
 * stdout carries protocol messages only, diagnostics go to stderr.
 */
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { ToolContext } from './context.js';
import { fail, type ToolResult } from './result.js';
import { RULE_IDS } from './rules.js';
import { CHECKER_NOTE, checkMoneyCode, checkMoneyCodeShape } from './tools/checkMoneyCode.js';
import { explainRule, explainRuleShape } from './tools/explainRule.js';
import { MAX_EVENTS, runPoltergeist, runPoltergeistShape } from './tools/runPoltergeist.js';
import { findWorkspaceRoot } from './workspace.js';

export const SERVER_NAME = 'ossuary';
export const SERVER_VERSION = '0.1.0';

interface ToolDef {
  tool: Tool;
  run: (input: unknown, ctx: ToolContext) => Promise<ToolResult<unknown>>;
}

/** The advertised JSON schema; the tool function re-validates with the same zod shape. */
const inputSchema = (shape: z.ZodRawShape): Tool['inputSchema'] =>
  z.toJSONSchema(z.object(shape).strict(), { io: 'input', target: 'draft-7' }) as Tool['inputSchema'];

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;

export const TOOLS: readonly ToolDef[] = [
  {
    tool: {
      name: 'ossuary_check_money_code',
      title: 'Check money code',
      description:
        'Check a workspace file (path) or a snippet (code) against the Ossuary money rules in .kiro/steering: ' +
        `${RULE_IDS.join(', ')}. Give exactly one of path or code. Returns violations with rule, line, excerpt, message and fix. ${CHECKER_NOTE}`,
      inputSchema: inputSchema(checkMoneyCodeShape),
      annotations: READ_ONLY,
    },
    run: checkMoneyCode,
  },
  {
    tool: {
      name: 'ossuary_run_poltergeist',
      title: 'Run the poltergeist',
      description:
        'Throw a seeded storm of duplicate, replayed, out-of-order, racing and crashing payment events at Ossuary (target ossuary) ' +
        `or at the vibe-coded Vibe Pay twin (target twin) and return the drift report. Amounts are integer minor-unit strings. Up to ${MAX_EVENTS} events; ` +
        'runs on in-memory Postgres with no network, and the same seed always gives the same report.',
      inputSchema: inputSchema(runPoltergeistShape),
      annotations: { ...READ_ONLY, idempotentHint: true },
    },
    run: runPoltergeist,
  },
  {
    tool: {
      name: 'ossuary_explain_rule',
      title: 'Explain a money rule',
      description: 'Return the verbatim steering text of one Ossuary money rule, with a small example of the bug and the fix.',
      inputSchema: inputSchema(explainRuleShape),
      annotations: { ...READ_ONLY, idempotentHint: true },
    },
    run: explainRule,
  },
];

export const TOOL_NAMES = TOOLS.map((t) => t.tool.name);

/** Maps a ToolResult to an MCP result: JSON text plus structuredContent; errors set isError. */
export function toCallToolResult(result: ToolResult<unknown>): CallToolResult {
  const payload = (result.ok ? result.data : { error: result.error }) as Record<string, unknown>;
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    ...(result.ok ? {} : { isError: true }),
  };
}

/** Runs one tool call; never throws. */
export async function callTool(name: string, args: unknown, ctx: ToolContext): Promise<CallToolResult> {
  const def = TOOLS.find((t) => t.tool.name === name);
  if (!def) return toCallToolResult(fail('invalid_input', `unknown tool ${JSON.stringify(name)}; tools: ${TOOL_NAMES.join(', ')}`));
  try {
    return toCallToolResult(await def.run(args ?? {}, ctx));
  } catch (e) {
    return toCallToolResult(fail('internal', e instanceof Error ? e.message : String(e)));
  }
}

export function createServer(ctx: ToolContext): Server {
  const server = new Server({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS.map((t) => t.tool) }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => callTool(req.params.name, req.params.arguments, ctx));
  return server;
}

export async function main(): Promise<void> {
  const workspaceRoot = findWorkspaceRoot({
    env: process.env,
    cwd: process.cwd(),
    serverDir: path.dirname(fileURLToPath(import.meta.url)),
  });
  const server = createServer({ workspaceRoot });
  await server.connect(new StdioServerTransport());
  process.stderr.write(`ossuary MCP server ${SERVER_VERSION} ready; workspace ${workspaceRoot}\n`);
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((e: unknown) => {
    process.stderr.write(`ossuary MCP server failed to start: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
