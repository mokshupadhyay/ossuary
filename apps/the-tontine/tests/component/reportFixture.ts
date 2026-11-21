import type { PoltergeistReport } from '@ossuary/core/poltergeist';
import type { SeanceResult } from '../../src/tontine/seance';

/*
 * A drifted ghost can net to zero: a double-tapped payout takes 32.687968 USDC
 * from the pot twice and gives it to the member twice, so the pot is short by
 * what the member has too much. The numbers are seed 7's first double-tap on
 * Vibe Pay (u0002). One clean duplicate delivery (u0003) sits beside it.
 */
const MEMBERS = ['m0', 'm1', 'm2', 'm3', 'm4'];
const drift = (pot: bigint, m4 = 0n) => ({
  total: (pot + m4).toString(),
  accounts: [{ account: 'pot', drift: pot.toString() }, ...MEMBERS.map((m) => ({ account: `member:${m}`, drift: m === 'm4' ? m4.toString() : '0' }))],
});
const zero = drift(0n);

export function report(target: 'ossuary' | 'twin'): PoltergeistReport {
  const twin = target === 'twin';
  return {
    schema: 'ossuary/poltergeist-report',
    version: 1,
    generator: 1,
    seed: 7,
    size: 200,
    ensureEveryFault: true,
    target,
    asset: 'USDC',
    decimals: 6,
    events: { planned: 2, attempts: 2, retries: 0, crashes: 0 },
    faults: [
      { id: 'double-tap', name: 'Concurrent double-tap', ghosts: 1, deliveries: 2, blocked: twin ? 0 : 1, drifted: twin ? 1 : 0, drift: twin ? drift(32_687_968n, -32_687_968n) : zero },
      { id: 'duplicate-delivery', name: 'Duplicate delivery', ghosts: 1, deliveries: 2, blocked: 1, drifted: 0, drift: zero },
    ] as PoltergeistReport['faults'],
    honest: { units: 0, deliveries: 0, drift: zero },
    drift: { ...(twin ? drift(32_687_968n, -32_687_968n) : zero), conjured: twin ? '32687968' : '0', lost: twin ? '32687968' : '0', doubleCreditedMembers: twin ? 1 : 0 },
    settleDrift: zero,
    fractionalBalances: [],
    blocked: [
      ...(twin ? [] : [{ ghostId: 'u0002', faultId: 'double-tap' as const, subject: 'key_4bdc4c95', epitaph: 'Here lies a double-tapped payout, buried by idempotency key.' }]),
      { ghostId: 'u0003', faultId: 'duplicate-delivery', subject: 'evt_1', epitaph: 'Here lies evt_1, delivered twice, buried by inbox dedupe.' },
    ],
    drifted: twin ? [{ ghostId: 'u0002', faultId: 'double-tap', subject: 'key_4bdc4c95', drift: drift(32_687_968n, -32_687_968n) }] : [],
    counterexample: null,
  };
}

export const result: SeanceResult = {
  seed: 7,
  size: 200,
  ossuary: report('ossuary'),
  twin: report('twin'),
  books: { circleName: null, before: null, after: null, unchanged: false, ledgerSum: 0n },
};

