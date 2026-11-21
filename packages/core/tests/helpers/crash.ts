import { expect } from 'vitest';
import type { CrashingDb } from '../../src/poltergeist/crash.js';

// The crash injector moved to src/poltergeist/crash.ts so the poltergeist can use it
// from src/ (poltergeist-engine D6). `calibrate` stays here because it uses Vitest.
export { SimulatedCrash, createCrashingDb, describeCrashPoint } from '../../src/poltergeist/crash.js';
export type { CrashPoint, CrashingDb } from '../../src/poltergeist/crash.js';

/**
 * Runs `run` uncrashed and asserts it issues exactly `expected`, in order.
 * Crash points expressed as statement indices only mean what they say if this
 * holds, so every property that uses them calibrates first. Returns the log.
 */
export async function calibrate(
  crashing: CrashingDb,
  run: () => Promise<unknown>,
  expected: readonly RegExp[],
): Promise<string[]> {
  crashing.disarm();
  crashing.resetLog();
  await run();
  const log = [...crashing.log];
  expect(
    log.length,
    `expected ${expected.length} statements, got ${log.length}:\n${log.join('\n')}`,
  ).toBe(expected.length);
  log.forEach((q, i) => expect(q, `statement ${i}`).toMatch(expected[i]!));
  return log;
}
