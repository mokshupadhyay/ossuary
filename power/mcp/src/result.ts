/** Structured results shared by every tool. Tools never throw; they return one of these. */

export type ToolErrorCode =
  | 'invalid_input'
  | 'path_outside_workspace'
  | 'not_found'
  | 'not_a_file'
  | 'unsupported_file_type'
  | 'too_large'
  | 'poltergeist_unavailable'
  | 'poltergeist_failed'
  | 'timeout'
  | 'internal';

export interface ToolError {
  code: ToolErrorCode;
  message: string;
}

export type ToolResult<T> = { ok: true; data: T } | { ok: false; error: ToolError };

export const ok = <T>(data: T): ToolResult<T> => ({ ok: true, data });

export const fail = (code: ToolErrorCode, message: string): { ok: false; error: ToolError } => ({
  ok: false,
  error: { code, message },
});

/** Turns a zod error into a one-line, path-qualified message. */
export function describeZodError(error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }): string {
  return error.issues
    .map((i) => (i.path.length > 0 ? `${i.path.map(String).join('.')}: ${i.message}` : i.message))
    .join('; ');
}
