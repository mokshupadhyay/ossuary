import { useEffect, useRef } from 'react';
import type { TipJar } from '../jar';
import { formatUsdc } from '../money';
import { useAnnounce } from './Announcer';
import { useJarData } from './useJarData';

/** Count the coffin: the end-of-stream reconciliation (Requirement 6). */
export function Coffin({ jar, intervalMs }: { jar: TipJar; intervalMs?: number }) {
  const { data, error, refresh } = useJarData(jar, { intervalMs });
  const announce = useAnnounce();
  const announced = useRef<string | null>(null);
  const c = data?.coffin;

  const verdict = c ? (c.balanced ? 'The coffin balances' : `The coffin does not balance: ${c.checks.filter((k) => !k.ok).map((k) => k.label).join('; ')}`) : null;
  useEffect(() => {
    if (verdict && verdict !== announced.current) {
      announced.current = verdict;
      announce(`${verdict}. Residual ${formatUsdc(c!.residual)} USDC.`);
    }
  }, [verdict, announce, c]);

  if (error) return <p className="error" role="alert">{error}</p>;
  if (!c) return <p className="hint">Counting…</p>;

  const row = (label: string, value: bigint, sign: string, strong = false) => (
    <tr className={strong ? 'total' : undefined}>
      <th scope="row">{label}</th>
      <td aria-hidden="true">{sign}</td>
      <td className="num">{formatUsdc(value)}</td>
    </tr>
  );

  return (
    <div className="coffin">
      <header>
        <p className="eyebrow">End of stream</p>
        <h1>Count the coffin ⚰️</h1>
        <p className="hint">
          What came in, minus what went out, minus what the jar holds. In and out are read from the webhook inbox; held is
          read from the ledger. Two sources, one answer.
        </p>
      </header>

      <section className={`card verdict ${c.balanced ? 'ok' : 'bad'}`} aria-labelledby="verdict">
        <h2 id="verdict" data-testid="coffin-verdict">
          <span aria-hidden="true">{c.balanced ? '⚰️✅ ' : '⚰️❌ '}</span>
          {verdict}
        </h2>
        <p className="residual">
          Residual <strong data-testid="coffin-residual">{formatUsdc(c.residual)}</strong> USDC
        </p>
      </section>

      <section className="card" aria-labelledby="equation">
        <h2 id="equation">The equation</h2>
        <table className="equation">
          <caption className="sr-only">In minus out minus held, in USDC</caption>
          <tbody>
            {row(`In: ${c.tipCount} tips captured`, c.totalIn, '')}
            {row('Out: refunds', c.refunds, '−')}
            {row('Out: chargebacks', c.chargebacks, '−')}
            {row('Held in the jar', c.held, '−')}
            {row('Residual', c.residual, '=', true)}
          </tbody>
        </table>
      </section>

      <section className="card" aria-labelledby="checks">
        <h2 id="checks">Checks</h2>
        <ul className="checks">
          {c.checks.map((k) => (
            <li key={k.id} className={k.ok ? 'ok' : 'bad'} data-testid={`check-${k.id}`}>
              <span aria-hidden="true">{k.ok ? '✅' : '❌'} </span>
              {k.label}: <strong>{k.ok ? 'pass' : `fail (${k.detail})`}</strong>
            </li>
          ))}
        </ul>
      </section>

      <section className="card" aria-labelledby="buried">
        <h2 id="buried">Ghosts buried during the stream</h2>
        <ul className="defenses">
          <li>
            <strong>{c.defenses.duplicates}</strong> duplicate deliveries ignored by the inbox
          </li>
          <li>
            <strong>{c.defenses.staleRejected}</strong> stale or forged webhooks refused by the signature check
          </li>
          <li>
            <strong>{c.defenses.parked}</strong> reversals parked until their capture arrived
          </li>
          <li>
            <strong>{c.defenses.rejectedReversals}</strong> reversals rejected for asking more than a tip received
          </li>
        </ul>
        <button type="button" className="secondary" onClick={() => void refresh()}>
          Count again
        </button>
      </section>
    </div>
  );
}
