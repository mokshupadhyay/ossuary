/** Runs a program with a fixed argument list and no shell. Injected in tests. */
export type PoltergeistRunner = (command: {
  file: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
}) => Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }>;

/** What every tool gets besides its input. */
export interface ToolContext {
  /** Real path of the only directory the server may read from (design D3). */
  workspaceRoot: string;
  /** Replaces the child-process runner in tests. */
  runner?: PoltergeistRunner;
}
