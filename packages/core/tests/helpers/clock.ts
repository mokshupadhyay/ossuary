import type { Clock } from '../../src/webhooks/verify.js';

export interface FakeClock extends Clock {
  /** Moves time forward by `ms` (never backwards). */
  advance(ms: number): void;
}

/** A clock that starts at `startMs` and only moves when `advance` is called. */
export function fakeClock(startMs: number): FakeClock {
  if (!Number.isSafeInteger(startMs)) throw new RangeError('fakeClock: startMs must be a safe integer');
  let t = startMs;
  return {
    now: () => t,
    advance(ms: number) {
      if (!Number.isSafeInteger(ms) || ms < 0) throw new RangeError('fakeClock: advance(ms) needs ms >= 0');
      t += ms;
    },
  };
}
