import type { OutboxMessageToSend, Sender } from '../../src/outbox/worker.js';

/**
 * - `ok`: the receiver gets the message and the send resolves.
 * - `fail`: the receiver does not get it and the send throws.
 * - `crash-after-send`: the receiver gets the message, then the worker
 *   process dies before it can record the result.
 */
export type SendOutcome = 'ok' | 'fail' | 'crash-after-send';

export interface SenderCall extends OutboxMessageToSend {
  outcome: SendOutcome;
  /** True when the receiver got the message (`ok` or `crash-after-send`). */
  delivered: boolean;
}

export interface FakeSenderOptions {
  /**
   * What happens once the script runs out: `'cycle'` repeats the script from
   * the start (an empty script then falls back to `ok`), or a fixed outcome.
   * Default `'ok'`.
   */
  whenExhausted?: 'cycle' | SendOutcome;
  /**
   * Called for `crash-after-send`, after the call is recorded as delivered.
   * The worker treats any error the sender throws as a failed send, so a real
   * crash must happen outside it: Property 3 passes `crashing.armNext`, which
   * kills the worker at its next statement (the result update). The default
   * throws, which the worker records as a failure.
   */
  crash?: () => void;
}

export class SenderCrashError extends Error {
  constructor() {
    super('fake sender: crash after send');
    this.name = 'SenderCrashError';
  }
}

export interface FakeSender {
  sender: Sender;
  /** Every call, in order. */
  readonly calls: readonly SenderCall[];
  callsFor(idempotencyKey: string): SenderCall[];
}

/** A scripted sender that records every call it receives. */
export function fakeSender(script: readonly SendOutcome[] = [], options: FakeSenderOptions = {}): FakeSender {
  const whenExhausted = options.whenExhausted ?? 'ok';
  const crash =
    options.crash ??
    (() => {
      throw new SenderCrashError();
    });
  const calls: SenderCall[] = [];

  const next = (n: number): SendOutcome => {
    if (n < script.length) return script[n]!;
    if (whenExhausted !== 'cycle') return whenExhausted;
    return script.length === 0 ? 'ok' : script[n % script.length]!;
  };

  const sender: Sender = async (m) => {
    const outcome = next(calls.length);
    calls.push({
      idempotencyKey: m.idempotencyKey,
      topic: m.topic,
      payload: m.payload,
      outcome,
      delivered: outcome !== 'fail',
    });
    if (outcome === 'fail') throw new Error(`fake sender: failure on call ${calls.length}`);
    if (outcome === 'crash-after-send') crash();
  };

  return {
    sender,
    calls,
    callsFor: (key) => calls.filter((c) => c.idempotencyKey === key),
  };
}
