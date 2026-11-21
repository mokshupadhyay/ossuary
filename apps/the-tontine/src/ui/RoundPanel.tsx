import { formatUsdc } from '../money';
import type { CircleView } from '../tontine/types';

export interface RoundPanelProps {
  view: CircleView;
  busy: boolean;
  locked: boolean;
  onPayout: (round: number) => void;
}

const list = (names: readonly string[]) =>
  names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/** Whose turn it is, who the circle is waiting for, and the payout control (Requirements 5.3, 6). */
export function RoundPanel({ view, busy, locked, onPayout }: RoundPanelProps) {
  if (view.currentRound === null) {
    return (
      <section className="panel round" aria-labelledby="round-title">
        <h3 id="round-title">Circle complete</h3>
        <p>All {view.rounds} rounds are paid out. Every member received the pot once, and the pot is empty.</p>
      </section>
    );
  }
  const round = view.currentRound;
  const recipient = view.members.find((m) => m.position === view.recipientPosition);
  const waiting = view.waitingFor.length > 0;
  return (
    <section className="panel round" aria-labelledby="round-title">
      <h3 id="round-title">
        Round {round} of {view.rounds}
      </h3>
      <p>
        <strong>{recipient?.name}</strong> takes the pot of {formatUsdc(view.potPerRound)} when everyone has paid {formatUsdc(view.contribution)}.
      </p>
      <p id="payout-reason" className={waiting ? 'round__waiting' : 'round__ready'}>
        {waiting ? (
          <>
            <span aria-hidden="true">⌛ </span>Waiting for {list(view.waitingFor)}. Nobody is paid until everyone has paid.
          </>
        ) : (
          <>
            <span aria-hidden="true">✓ </span>Everyone has paid. The pot is ready.
          </>
        )}
      </p>
      <button
        type="button"
        className="btn btn--primary"
        disabled={waiting || busy || locked}
        aria-describedby="payout-reason"
        onClick={() => onPayout(round)}
      >
        {busy ? 'Paying out…' : `Pay ${formatUsdc(view.potPerRound)} to ${recipient?.name ?? 'the recipient'}`}
      </button>
    </section>
  );
}
