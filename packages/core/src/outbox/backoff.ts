/**
 * Retry delay after `attempts` failed attempts: min(max, base × 2^(attempts − 1)).
 * No jitter, so it is deterministic. Doubling stops once the cap is reached,
 * so a huge attempt count cannot overflow to Infinity.
 */
export function nextDelayMs(attempts: number, baseDelayMs: number, maxDelayMs: number): number {
  if (!Number.isInteger(attempts) || attempts < 1) throw new RangeError('attempts must be an integer >= 1');
  if (!(baseDelayMs >= 0) || !(maxDelayMs >= 0)) throw new RangeError('delays must be >= 0');
  let delay = baseDelayMs;
  for (let i = 1; i < attempts && delay < maxDelayMs; i++) delay *= 2;
  return Math.min(maxDelayMs, delay);
}
