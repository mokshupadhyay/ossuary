import { useState } from 'react';
import type { TipJar } from '../jar';
import type { DeliveryOutcome, Outcome } from '../rail';
import type { DeliveryRow } from '../readModel';
import { useAnnounce } from './Announcer';

const OUTCOME_TEXT: Record<Outcome, string> = {
  applied: 'applied',
  duplicate: 'duplicate, ignored',
  parked: 'parked until its capture',
  rejected: 'rejected by the refund cap',
  ignored: 'ignored',
  unauthorized: 'refused: bad or stale signature',
  invalid: 'refused: invalid body',
  error: 'server error',
};

const OUTCOME_ICON: Record<Outcome, string> = {
  applied: '✅',
  duplicate: '🛡️',
  parked: '⏸️',
  rejected: '⛔',
  ignored: '➖',
  unauthorized: '🛡️',
  invalid: '⚠️',
  error: '⚠️',
};

const shortEvent = (id: string) => id.replace(/^(tip|refund|chargeback)_([0-9a-f]{6})[0-9a-f-]*/, '$1_$2…');

/** Haunted rail switch and stale replay (Requirement 4). */
export function RailConsole({ jar, onDone }: { jar: TipJar; onDone: () => void }) {
  const announce = useAnnounce();
  const [haunted, setHaunted] = useState(jar.rail.haunted);
  const [last, setLast] = useState<DeliveryOutcome | null>(null);
  const [busy, setBusy] = useState(false);

  function toggle(on: boolean) {
    jar.setHaunted(on);
    setHaunted(on);
    announce(on ? 'Haunted rail on: every event is delivered twice, late and replayed.' : 'Haunted rail off.');
  }

  async function replayStale() {
    setBusy(true);
    try {
      const events = await jar.rail.events();
      const capture = [...events].reverse().find((e) => e.type === 'payment.captured');
      if (!capture) return;
      const r = await jar.rail.replayStale(capture.eventId);
      setLast(r);
      if (r) announce(`Stale replay of ${shortEvent(r.eventId)}: ${OUTCOME_TEXT[r.outcome]}`);
    } finally {
      setBusy(false);
      onDone();
    }
  }

  return (
    <section className="card rail" aria-labelledby="rail-title">
      <h2 id="rail-title">The rail</h2>
      <p className="hint">Tips arrive as signed webhooks from a simulated payment rail.</p>
      <label className="switch">
        <input type="checkbox" role="switch" checked={haunted} onChange={(e) => toggle(e.target.checked)} />
        <span>Haunted rail {haunted ? '(on)' : '(off)'}</span>
      </label>
      <small>Delivers every event twice, sends a late “pending” after the capture, and replays the exact bytes.</small>
      <button type="button" className="secondary" disabled={busy} onClick={() => void replayStale()}>
        Replay a stale webhook (5 min old)
      </button>
      {last && (
        <p className="note" data-testid="stale-result">
          {OUTCOME_ICON[last.outcome]} {shortEvent(last.eventId)}: {last.status ?? '—'} {OUTCOME_TEXT[last.outcome]}
        </p>
      )}
    </section>
  );
}

export function DeliveryLog({ rows }: { rows: readonly DeliveryRow[] }) {
  return (
    <section className="card log" aria-labelledby="log-title">
      <h2 id="log-title">Delivery log</h2>
      {rows.length === 0 ? (
        <p className="hint">No deliveries yet.</p>
      ) : (
        <div className="table-scroll">
          <table>
            <caption className="sr-only">Webhook deliveries, newest first</caption>
            <thead>
              <tr>
                <th scope="col">Event</th>
                <th scope="col">How</th>
                <th scope="col">Status</th>
                <th scope="col">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.seq} data-testid="delivery-row">
                  <td>
                    <code>{shortEvent(r.eventId)}</code> <span className="hint">{r.type.replace('payment.', '')}</span>
                  </td>
                  <td>
                    {r.mode}
                    {r.attempt > 1 ? ` #${r.attempt}` : ''}
                  </td>
                  <td>{r.status ?? '—'}</td>
                  <td>
                    <span aria-hidden="true">{OUTCOME_ICON[r.outcome]} </span>
                    {OUTCOME_TEXT[r.outcome]}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
