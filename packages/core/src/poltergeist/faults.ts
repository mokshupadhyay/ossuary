/*
 * The fault catalog (poltergeist-engine Requirement 1). Fault ids are stable:
 * reports, the apps and the demo video refer to them. Never rename one; add a
 * new fault and bump the generator version instead.
 */

export type FaultId =
  | 'duplicate-delivery'
  | 'replayed-timestamp'
  | 'out-of-order'
  | 'refund-before-capture'
  | 'double-tap'
  | 'crash-mid-step'
  | 'refund-races-payout'
  | 'late-after-refund';

export interface Fault {
  readonly id: FaultId;
  readonly name: string;
  /** One line, with `{subject}` and `{fate}` placeholders. */
  readonly epitaph: string;
  /** Planned deliveries a ghost of this fault needs, at least and at most. */
  readonly minDeliveries: number;
  readonly maxDeliveries: number;
}

const fault = (f: Fault): Fault => Object.freeze(f);

export const FAULTS: readonly Fault[] = Object.freeze([
  fault({ id: 'duplicate-delivery', name: 'Duplicate delivery', epitaph: '{subject} delivered twice, {fate}', minDeliveries: 2, maxDeliveries: 4 }),
  fault({ id: 'replayed-timestamp', name: 'Replayed old timestamp', epitaph: '{subject} replayed webhook, {fate}', minDeliveries: 2, maxDeliveries: 2 }),
  fault({ id: 'out-of-order', name: 'Out-of-order events', epitaph: '{subject} arrived out of order, {fate}', minDeliveries: 2, maxDeliveries: 3 }),
  fault({ id: 'refund-before-capture', name: 'Refund before capture', epitaph: '{subject} refund arrived before its capture, {fate}', minDeliveries: 2, maxDeliveries: 3 }),
  fault({ id: 'double-tap', name: 'Concurrent double-tap', epitaph: '{subject} double-tapped payout, {fate}', minDeliveries: 3, maxDeliveries: 4 }),
  fault({ id: 'crash-mid-step', name: 'Crash between steps', epitaph: '{subject} crashed mid-step, {fate}', minDeliveries: 1, maxDeliveries: 2 }),
  fault({ id: 'refund-races-payout', name: 'Refund racing a payout', epitaph: '{subject} refund raced a payout, {fate}', minDeliveries: 3, maxDeliveries: 3 }),
  fault({ id: 'late-after-refund', name: 'Late delivery after a refund', epitaph: '{subject} arrived late after its refund, {fate}', minDeliveries: 3, maxDeliveries: 3 }),
]);

export const FAULT_IDS: readonly FaultId[] = Object.freeze(FAULTS.map((f) => f.id));

const BY_ID: ReadonlyMap<string, Fault> = new Map(FAULTS.map((f) => [f.id, f]));

export function faultById(id: FaultId): Fault {
  const f = BY_ID.get(id);
  if (!f) throw new RangeError(`unknown fault id: ${id}`);
  return f;
}

export const isFaultId = (value: unknown): value is FaultId => typeof value === 'string' && BY_ID.has(value);

/** A mechanism a SUT reports as having neutralized a delivery (Requirement 5.6). */
export type DefenseId = 'inbox-dedupe' | 'timestamp-check' | 'signature-check' | 'parking' | 'idempotency-key' | 'rollback';

export const DEFENSE_LABELS: Readonly<Record<DefenseId, string>> = Object.freeze({
  'inbox-dedupe': 'inbox dedupe',
  'timestamp-check': 'timestamp check',
  'signature-check': 'signature check',
  parking: 'parked until its capture',
  'idempotency-key': 'idempotency key',
  rollback: 'transaction rollback',
});

/** `evt_9f3a01c2` → `evt_9f…`. */
export function shortSubject(logicalId: string): string {
  const m = /^([a-z]+_)([0-9a-f]{2})/.exec(logicalId);
  return m ? `${m[1]}${m[2]}…` : `${logicalId.slice(0, 6)}…`;
}

/**
 * Renders a fault's epitaph. `{fate}` names the defenses the SUT reported, in
 * first-seen order without repeats, or says the ghost passed without drift
 * when the SUT reported none (design D4).
 */
export function renderEpitaph(fault: Fault, subject: string, defenses: readonly DefenseId[]): string {
  const labels = [...new Set(defenses)].map((d) => DEFENSE_LABELS[d]);
  const fate = labels.length > 0 ? `buried by ${labels.join(' and ')}` : 'passed without drift';
  return fault.epitaph.replace('{subject}', shortSubject(subject)).replace('{fate}', fate).replace(/[\r\n]+/g, ' ');
}
