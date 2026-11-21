import type { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { expect } from 'vitest';
import type { Db } from '../../src/db/client.js';
import * as schema from '../../src/schema/index.js';

/*
 * Crash injection without touching src/.
 *
 * A second Drizzle instance shares the same PGlite client but has a query
 * logger. Drizzle calls the logger just before it executes each statement, so
 * throwing there stops the operation before a chosen statement, inside its
 * open database transaction. Postgres then rolls back, which is what happens
 * when a process dies mid-transaction and its connection drops.
 *
 * A wrapper around the outermost `db.transaction` adds the two points the
 * logger cannot reach: after the callback's last statement but before COMMIT,
 * and after COMMIT but before the caller receives the result. Savepoints
 * (`tx.transaction(...)`) are not wrapped; their SAVEPOINT / RELEASE
 * statements go through the logger like any other statement.
 *
 * Every crash is one-shot: once it fires the crasher is disarmed, so code
 * that wrongly swallows the error and carries on would commit a partial
 * state, which the property using it must then catch.
 */

export class SimulatedCrash extends Error {
  constructor(where: string) {
    super(`simulated crash ${where}`);
    this.name = 'SimulatedCrash';
  }
}

export type CrashPoint =
  /** Before the statement with this 0-based index, counted from `arm`. */
  | { at: 'statement'; index: number }
  /** After the outermost transaction callback returns, before COMMIT. */
  | { at: 'beforeCommit' }
  /** After COMMIT, before the caller receives the result. */
  | { at: 'afterCommit' }
  /** Before the first statement for which `test` returns true. */
  | { at: 'when'; test: (query: string, index: number, inTransaction: boolean) => boolean };

export const describeCrashPoint = (p: CrashPoint): string =>
  p.at === 'statement'
    ? `before statement ${p.index}`
    : p.at === 'beforeCommit'
      ? 'after the last statement, before commit'
      : p.at === 'afterCommit'
        ? 'after commit, before the caller received the result'
        : 'before a matching statement';

export interface CrashingDb {
  /** Use this wherever production code takes a `Db`. */
  readonly db: Db;
  /** Arms one crash and resets the statement counter and log. */
  arm(point: CrashPoint): void;
  /** Crashes before the very next statement. Does not reset the log. */
  armNext(): void;
  disarm(): void;
  /** True while a crash is armed and has not fired. */
  readonly armed: boolean;
  /** Number of crashes fired since creation. */
  readonly fired: number;
  /** Statements executed since the last `arm` or `resetLog`. */
  readonly log: readonly string[];
  resetLog(): void;
}

export function createCrashingDb(client: PGlite): CrashingDb {
  let point: CrashPoint | null = null;
  let executed = 0;
  let fired = 0;
  let depth = 0;
  let log: string[] = [];

  const fire = (): never => {
    const where = describeCrashPoint(point!);
    point = null;
    fired += 1;
    throw new SimulatedCrash(where);
  };

  const base = drizzle(client, {
    schema,
    logger: {
      logQuery(query: string): void {
        if (point !== null) {
          const hit =
            (point.at === 'statement' && point.index === executed) ||
            (point.at === 'when' && point.test(query, executed, depth > 0));
          if (hit) fire();
        }
        executed += 1;
        log.push(query);
      },
    },
  }) as unknown as Db;

  const db = new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === 'transaction') {
        return async (cb: (tx: unknown) => Promise<unknown>, config?: unknown) => {
          const result = await (target.transaction as (...a: unknown[]) => Promise<unknown>)(
            async (tx: unknown) => {
              depth += 1;
              try {
                const out = await cb(tx);
                if (point?.at === 'beforeCommit') fire();
                return out;
              } finally {
                depth -= 1;
              }
            },
            config,
          );
          if (point?.at === 'afterCommit') fire();
          return result;
        };
      }
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });

  return {
    db,
    arm(p) {
      point = p;
      executed = 0;
      log = [];
    },
    armNext() {
      point = { at: 'statement', index: executed };
    },
    disarm() {
      point = null;
    },
    get armed() {
      return point !== null;
    },
    get fired() {
      return fired;
    },
    get log() {
      return log;
    },
    resetLog() {
      executed = 0;
      log = [];
    },
  };
}

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
