import type { CSSProperties } from 'react';
import { formatUsdc } from '../money';
import type { CircleView } from '../tontine/types';
import { Candle } from './Candle';

export interface Flight {
  /** Increments per payout, so the animation restarts. */
  id: number;
  position: number;
  amount: bigint;
}

export interface CircleTableProps {
  view: CircleView;
  busy: ReadonlySet<string>;
  locked: boolean;
  flight: Flight | null;
  reducedMotion: boolean;
  onContribute: (position: number) => void;
  onMarkLate: (position: number) => void;
}

export const dueBusyKey = (round: number, position: number) => `due:${round}:${position}`;

/** Where seat `i` of `n` sits on the table, as a fraction of the radius (layout only, never money). */
function seatVector(i: number, n: number): { x: number; y: number } {
  const a = (2 * Math.PI * i) / n - Math.PI / 2;
  return { x: Math.cos(a), y: Math.sin(a) };
}

function Coffin({ view, flight, reducedMotion }: { view: CircleView; flight: Flight | null; reducedMotion: boolean }) {
  const coins = Math.min(view.paidThisRound, 12);
  const target = flight ? seatVector(flight.position, view.members.length) : null;
  const style = target ? ({ '--tx': target.x.toFixed(3), '--ty': target.y.toFixed(3) } as CSSProperties) : undefined;
  return (
    <div className="coffin-wrap">
      <div className="coffin" aria-hidden="true" data-coins={coins}>
        <span className="coffin__lid" />
        <span className="coffin__coins">
          {Array.from({ length: coins }, (_, i) => (
            <span key={i} className="coin" style={{ '--c': i } as CSSProperties} />
          ))}
        </span>
      </div>
      {flight && !reducedMotion && (
        <div key={flight.id} className="coin-flight" style={style} aria-hidden="true" data-testid="coin-flight">
          <span className="coin" />
          <span className="coin" />
          <span className="coin" />
        </div>
      )}
      <p className="coffin__pot">
        <span className="coffin__label">Pot</span>
        <strong data-testid="pot">{formatUsdc(view.pot)}</strong>
      </p>
      {view.currentRound !== null ? (
        <p className="coffin__count">
          {view.paidThisRound} of {view.members.length} paid this round
        </p>
      ) : (
        <p className="coffin__count">Circle complete</p>
      )}
    </div>
  );
}

/** The candlelit table: one candle per member around the coffin (Requirement 8). */
export function CircleTable({ view, busy, locked, flight, reducedMotion, onContribute, onMarkLate }: CircleTableProps) {
  const n = view.members.length;
  return (
    <div className={`table${n > 8 ? ' table--crowded' : ''}`}>
      <Coffin view={view} flight={flight} reducedMotion={reducedMotion} />
      <ul className="seats" aria-label={`Members of ${view.name}`}>
        {view.members.map((m, i) => (
          <Candle
            key={m.memberId}
            member={m}
            index={i}
            count={n}
            contribution={view.contribution}
            isRecipient={view.recipientPosition === m.position}
            busy={view.currentRound !== null && busy.has(dueBusyKey(view.currentRound, m.position))}
            locked={locked}
            onContribute={onContribute}
            onMarkLate={onMarkLate}
          />
        ))}
      </ul>
    </div>
  );
}
