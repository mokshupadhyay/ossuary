import type { CSSProperties } from 'react';
import { formatUsdc } from '../money';

export interface DriftMeterProps {
  /** Expected minus reported, in base units: positive is lost money, negative is conjured money. */
  drift: bigint;
  label: string;
  /**
   * Money lost and conjured across accounts. When both are given and the
   * total nets to zero, the meter still reads as drifting.
   */
  lost?: bigint;
  conjured?: bigint;
}

/**
 * A needle gauge for drift. The needle's angle grows with the number of
 * digits in the drift, so it never turns a bigint into a float. The value and
 * the verdict are always in text (Requirement 12.3).
 */
export function DriftMeter({ drift, label, lost = 0n, conjured = 0n }: DriftMeterProps) {
  const netting = drift === 0n && (lost > 0n || conjured > 0n);
  const still = drift === 0n && !netting;
  const abs = drift < 0n ? -drift : drift;
  const size = netting ? lost + conjured : abs;
  const digits = still ? 0 : size.toString().length;
  const angle = still ? 0 : Math.min(80, 18 + digits * 6) * (drift < 0n ? -1 : 1);
  const verdict = still
    ? 'No drift: every cent is where it should be'
    : netting
      ? 'Drifting: money lost and conjured, netting to zero'
      : drift > 0n
        ? 'Drifting: money lost'
        : 'Drifting: money conjured';
  return (
    <figure className={`meter ${still ? 'meter--still' : 'meter--drifting'}`}>
      <svg viewBox="0 0 200 110" className="meter__dial" aria-hidden="true" style={{ '--angle': `${angle}deg` } as CSSProperties}>
        <path d="M 20 100 A 80 80 0 0 1 180 100" className="meter__arc" />
        <path d="M 88 21 A 80 80 0 0 1 112 21" className="meter__zero" />
        <line x1="100" y1="100" x2="100" y2="30" className="meter__needle" />
        <circle cx="100" cy="100" r="6" className="meter__hub" />
      </svg>
      <figcaption>
        <span className="meter__label">{label} drift</span>
        <strong className="meter__value" data-testid={`drift-${label.toLowerCase().replace(/\W+/g, '-')}`}>
          {formatUsdc(drift)}
        </strong>
        <span className="meter__verdict">
          <span aria-hidden="true">{still ? '✓ ' : '✗ '}</span>
          {verdict}
        </span>
      </figcaption>
    </figure>
  );
}
