import { useRef, useState, type FormEvent } from 'react';
import type { TipJar } from '../jar';
import { formatUsdc, formatUsdcShort, parseUsdc } from '../money';
import type { Reason } from '../rail';
import type { TipView } from '../readModel';
import { useAnnounce } from './Announcer';

const newKey = () => globalThis.crypto.randomUUID();

const STATUS_TEXT: Record<TipView['status'], string> = {
  pending: 'Pending',
  arrived: 'Arrived',
  'partly reversed': 'Partly reversed',
  reversed: 'Reversed',
};

export const REJECTED_TEXT = 'Rejected: more than this tip received';

/**
 * One tip with its reversal controls (Requirement 3). Each action keeps its
 * own Idempotency_Key until the rail has answered, so a double-tap is one
 * reversal.
 */
export function TipRow({ jar, tip, onDone }: { jar: TipJar; tip: TipView; onDone: () => void }) {
  const announce = useAnnounce();
  const keys = useRef<Record<Reason, string>>({ refund: newKey(), chargeback: newKey() });
  const [refund, setRefund] = useState('');
  const [note, setNote] = useState<{ kind: 'ok' | 'rejected' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const reversed = tip.status === 'reversed';

  async function reverse(reason: Reason, amount: bigint) {
    const key = keys.current[reason];
    setBusy(true);
    try {
      const r = await jar.reverse(key, { paymentId: tip.paymentId, amount, reason });
      if (!r.ok) {
        if (r.status === 409) keys.current[reason] = newKey();
        setNote({ kind: 'error', text: r.error });
        return;
      }
      const outcome = r.outcomes.find((o) => o.mode === 'normal' || o.mode === 'retry')?.outcome;
      if (outcome === 'error') {
        // Keep the key: pressing again retries the same reversal.
        setNote({ kind: 'error', text: 'The rail did not answer. Press again to retry.' });
        return;
      }
      if (keys.current[reason] === key) keys.current[reason] = newKey();
      if (outcome === 'rejected') {
        setNote({ kind: 'rejected', text: REJECTED_TEXT });
        announce(`${REJECTED_TEXT}. ${tip.viewer}'s tip is unchanged.`);
      } else {
        const what = reason === 'refund' ? 'Refunded' : 'Charged back';
        setNote({ kind: 'ok', text: `${what} ${formatUsdcShort(amount)} USDC` });
        announce(`${what} ${formatUsdcShort(amount)} USDC to ${tip.viewer}`);
        setRefund('');
      }
    } finally {
      setBusy(false);
      onDone();
    }
  }

  function submitRefund(e: FormEvent) {
    e.preventDefault();
    if (refund.trim() === '') return void reverse('refund', tip.remaining > 0n ? tip.remaining : tip.captured);
    const p = parseUsdc(refund);
    if (!p.ok) return setNote({ kind: 'error', text: p.error });
    void reverse('refund', p.units);
  }

  const id = `tip-${tip.paymentId}`;
  return (
    <li className={`tip ghost-card status-${tip.status.replace(' ', '-')}`} aria-labelledby={`${id}-who`} data-testid="tip-row">
      <div className="tip-head">
        <span className="ghost-icon" aria-hidden="true">
          {reversed ? '🕯️' : '👻'}
        </span>
        <strong id={`${id}-who`}>{tip.viewer}</strong>
        <span className="tip-amount">{formatUsdcShort(tip.captured)} USDC</span>
        <span className={`badge badge-${tip.status.replace(' ', '-')}`}>{STATUS_TEXT[tip.status]}</span>
      </div>
      {tip.message && <p className="tip-message">“{tip.message}”</p>}
      <dl className="tip-amounts">
        <div>
          <dt>Received</dt>
          <dd>{formatUsdc(tip.captured)}</dd>
        </div>
        <div>
          <dt>Refunded</dt>
          <dd>{formatUsdc(tip.refunded)}</dd>
        </div>
        <div>
          <dt>Charged back</dt>
          <dd>{formatUsdc(tip.chargedBack)}</dd>
        </div>
        <div>
          <dt>Kept</dt>
          <dd>{formatUsdc(tip.remaining)}</dd>
        </div>
      </dl>
      {tip.rejectedReversals > 0 && (
        <p className="tip-rejected">
          <span aria-hidden="true">⛔ </span>
          {tip.rejectedReversals === 1 ? '1 reversal' : `${tip.rejectedReversals} reversals`} rejected by the refund cap
        </p>
      )}
      {tip.captured > 0n && (
        <div className="tip-actions">
          <form onSubmit={submitRefund} className="inline">
            <label>
              <span className="sr-only">Refund amount for {tip.viewer} (USDC)</span>
              <input
                value={refund}
                onChange={(e) => setRefund(e.target.value)}
                inputMode="decimal"
                placeholder={formatUsdcShort(tip.remaining > 0n ? tip.remaining : tip.captured)}
                size={8}
              />
            </label>
            <button type="submit" disabled={busy} aria-label={`Refund ${tip.viewer}`}>
              Refund
            </button>
          </form>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            aria-label={`Chargeback ${tip.viewer}'s tip`}
            onClick={() => void reverse('chargeback', tip.captured)}
          >
            Chargeback (bank)
          </button>
        </div>
      )}
      {note && (
        <p className={`note note-${note.kind}`} data-testid="tip-note">
          {note.kind === 'rejected' && <span aria-hidden="true">⛔ </span>}
          {note.text}
        </p>
      )}
    </li>
  );
}
