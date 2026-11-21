import type { CSSProperties } from 'react';
import { formatUsdc } from '../money';
import type { DueStatus, MemberView } from '../tontine/types';

export const STATUS_LABEL: Record<DueStatus, string> = {
  paid: 'Paid',
  'paid-late': 'Paid late',
  late: 'Late',
  owes: 'Owes',
};

/** A text glyph per state, so the state has a shape as well as a colour (Requirement 12.3). */
const STATUS_GLYPH: Record<DueStatus, string> = {
  paid: '✓',
  'paid-late': '✓',
  late: '⌛',
  owes: '○',
};

export interface CandleProps {
  member: MemberView;
  index: number;
  count: number;
  contribution: bigint;
  isRecipient: boolean;
  busy: boolean;
  locked: boolean;
  onContribute: (position: number) => void;
  onMarkLate: (position: number) => void;
}

/** One member at the table: a candle, their name, their state in text, and their actions. */
export function Candle({ member, index, count, contribution, isRecipient, busy, locked, onContribute, onMarkLate }: CandleProps) {
  const status = member.due?.status ?? null;
  const flame = status === 'paid' || status === 'paid-late' ? 'lit' : status === 'late' ? 'guttering' : 'unlit';
  const unpaid = status === 'owes' || status === 'late';
  const style = { '--i': index, '--n': count } as CSSProperties;

  return (
    <li className={`seat seat--${flame}${isRecipient ? ' seat--recipient' : ''}`} style={style} data-testid={`seat-${member.position}`}>
      <div className={`candle candle--${flame}`} aria-hidden="true">
        <span className="candle__glow" />
        <span className="candle__flame" />
        <span className="candle__wick" />
        <span className="candle__wax" />
      </div>
      <div className="seat__card">
        <h3 className="seat__name">{member.name}</h3>
        {status !== null && (
          <p className={`seat__status status--${status}`}>
            <span aria-hidden="true" className="seat__glyph">
              {STATUS_GLYPH[status]}
            </span>{' '}
            {STATUS_LABEL[status]}
          </p>
        )}
        {isRecipient && <p className="badge badge--recipient">Takes the pot</p>}
        {member.receivedRound !== null && <p className="badge">Received round {member.receivedRound}</p>}
        {unpaid && (
          <div className="seat__actions">
            <button type="button" className="btn btn--small" disabled={busy || locked} onClick={() => onContribute(member.position)}>
              {busy ? 'Recording…' : `Record ${formatUsdc(contribution)}`} <span className="sr-only">from {member.name}</span>
            </button>
            {status === 'owes' && (
              <button type="button" className="btn btn--small btn--quiet" disabled={busy || locked} onClick={() => onMarkLate(member.position)}>
                Mark <span className="sr-only">{member.name}</span> late
              </button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}
