import { formatUsdc } from '../money';
import type { CircleView, TimelineEntry } from '../tontine/types';

const time = (d: Date) => d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });

function Keys({ entry }: { entry: Extract<TimelineEntry, { kind: 'contribution' | 'payout' }> }) {
  return (
    <dl className="keys">
      <div>
        <dt>Idempotency-Key</dt>
        <dd>
          <code>{entry.clientKey}</code>
        </dd>
      </div>
      {entry.ledgerKey !== entry.clientKey && (
        <div>
          <dt>Ledger key</dt>
          <dd>
            <code>{entry.ledgerKey}</code>
          </dd>
        </div>
      )}
      <div>
        <dt>Entries</dt>
        <dd>
          <ul className="entries">
            {entry.entries.map((e) => (
              <li key={e.accountId}>
                {e.account} <span className={e.amount > 0n ? 'debit' : 'credit'}>{formatUsdc(e.amount, { sign: true })}</span>
              </li>
            ))}
          </ul>
        </dd>
      </div>
    </dl>
  );
}

function Item({ entry }: { entry: TimelineEntry }) {
  const when = (
    <time className="event__time" dateTime={entry.at.toISOString()}>
      {time(entry.at)}
    </time>
  );
  if (entry.kind === 'missed') {
    return (
      <li className="event event--missed">
        <p className="event__title">
          <span aria-hidden="true">⌛ </span>Round {entry.round} · {entry.memberName} marked late
        </p>
        <p className="event__note">No money moved. The circle waits.</p>
        {when}
      </li>
    );
  }
  if (entry.kind === 'payout') {
    return (
      <li className="event event--payout">
        <p className="event__title">
          <span aria-hidden="true">⚱ </span>Round {entry.round} · {entry.memberName} received the pot, {formatUsdc(entry.amount)}
        </p>
        {when}
        <Keys entry={entry} />
      </li>
    );
  }
  return (
    <li className="event event--contribution">
      <p className="event__title">
        <span aria-hidden="true">🕯 </span>Round {entry.round} · {entry.memberName} paid {formatUsdc(entry.amount)}
        {entry.late && <span className="tag">late</span>}
        {entry.receipt && <span className="tag tag--ok">receipt sent</span>}
      </p>
      {when}
      <Keys entry={entry} />
    </li>
  );
}

/** The circle's history, newest first, from the ledger (Requirement 9). */
export function Timeline({ view }: { view: CircleView }) {
  return (
    <section className="panel timeline" aria-labelledby="timeline-title">
      <h2 id="timeline-title">History</h2>
      <p className="muted">
        Every movement, newest first, with the key it was made under. Contributions arrive as signed webhooks; Core derives the ledger key from the
        rail's event id. Payouts use the round's key directly.
      </p>
      {view.timeline.length === 0 ? (
        <p>Nothing yet. Record the first contribution.</p>
      ) : (
        <ol className="events">
          {view.timeline.map((e) => (
            <Item key={e.kind === 'missed' ? `missed:${e.round}:${e.position}` : e.transactionId} entry={e} />
          ))}
        </ol>
      )}
    </section>
  );
}
