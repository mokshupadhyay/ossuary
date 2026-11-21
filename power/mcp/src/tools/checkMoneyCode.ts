import { readFileSync, statSync } from 'node:fs';
import { z } from 'zod';
import { checkSource, summarize, type Violation } from '../checker.js';
import type { ToolContext } from '../context.js';
import { describeZodError, fail, ok, type ToolResult } from '../result.js';
import type { RuleId } from '../rules.js';
import { displayPath, resolveInside } from '../workspace.js';

export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_CODE_CHARS = 262_144;
export const CHECKED_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.sql'] as const;

export const CHECKER_NOTE =
  'Heuristic, line-based check against .kiro/steering. A clean result is not proof of safety: also write a property test and run the poltergeist.';

export const checkMoneyCodeShape = {
  path: z.string().min(1).max(4096).optional().describe('Workspace-relative path of a .ts/.tsx/.js/.sql file to check.'),
  code: z.string().max(MAX_CODE_CHARS).optional().describe('Source text to check instead of a file.'),
  filename: z
    .string()
    .min(1)
    .max(260)
    .optional()
    .describe('Display name for `code`; a .sql name switches to SQL comment rules. Only allowed with `code`.'),
};

const schema = z
  .object(checkMoneyCodeShape)
  .strict()
  .superRefine((v, ctx) => {
    if ((v.path === undefined) === (v.code === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'give exactly one of `path` or `code`' });
    }
    if (v.filename !== undefined && v.code === undefined) {
      ctx.addIssue({ code: 'custom', path: ['filename'], message: '`filename` is only allowed with `code`' });
    }
  });

export interface CheckMoneyCodeResult {
  source: { kind: 'path'; path: string } | { kind: 'snippet'; filename: string | null };
  clean: boolean;
  violations: Violation[];
  summary: { total: number; byRule: Partial<Record<RuleId, number>> };
  note: string;
}

export async function checkMoneyCode(input: unknown, ctx: ToolContext): Promise<ToolResult<CheckMoneyCodeResult>> {
  // Size limits get their own error code, ahead of the schema.
  if (typeof input === 'object' && input !== null && typeof (input as { code?: unknown }).code === 'string') {
    if ((input as { code: string }).code.length > MAX_CODE_CHARS) {
      return fail('too_large', `code is longer than ${MAX_CODE_CHARS} characters`);
    }
  }
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success) return fail('invalid_input', describeZodError(parsed.error));
  const { path: p, code, filename } = parsed.data;

  const done = (source: CheckMoneyCodeResult['source'], text: string, name: string | null) => {
    const violations = checkSource(text, { filename: name });
    return ok({ source, clean: violations.length === 0, violations, summary: summarize(violations), note: CHECKER_NOTE });
  };

  if (code !== undefined) return done({ kind: 'snippet', filename: filename ?? null }, code, filename ?? null);

  const resolved = resolveInside(ctx.workspaceRoot, p);
  if (!resolved.ok) return resolved;
  const real = resolved.data;
  const shown = displayPath(ctx.workspaceRoot, real);

  const stat = statSync(real);
  if (!stat.isFile()) return fail('not_a_file', `${shown} is not a regular file`);
  const lower = real.toLowerCase();
  if (!CHECKED_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    return fail('unsupported_file_type', `${shown}: only ${CHECKED_EXTENSIONS.join(', ')} files are checked`);
  }
  if (stat.size > MAX_FILE_BYTES) return fail('too_large', `${shown} is larger than ${MAX_FILE_BYTES} bytes`);

  return done({ kind: 'path', path: shown }, readFileSync(real, 'utf8'), shown);
}
