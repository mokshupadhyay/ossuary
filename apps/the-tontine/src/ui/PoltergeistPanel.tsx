import { useId, useState, type FormEvent } from 'react';
import type { PoltergeistReport } from '@ossuary/core/poltergeist';
import { formatUsdc } from '../money';
import { DEFAULT_SEED, MAX_SEED, STORM_SIZES, type SeancePhase, type SeanceResult, type StormSize } from '../tontine/seance';
import { DriftMeter } from './DriftMeter';

export interface PoltergeistPanelProps {
  running: boolean;
  phase: SeancePhase | null;
  result: SeanceResult | null;
  error: string | null;
  disabled: boolean;
  onSummon: (seed: number, size: StormSize) => void;
}

const PHASE_TEXT: Record<SeancePhase, string> = {
  ossuary: 'The poltergeist is loose in Ossuary’s ledger…',
  twin: 'Now it is haunting Vibe Pay…',
  books: 'Counting the circle’s books…',
};

function Side({ title, report, story }: { title: string; report: PoltergeistReport; story: string }) {
  const total = BigInt(report.drift.total);
  const isTwin = report.target === 'twin';
  return (
    <article className={`side side--${report.target}`} aria-labelledby={`side-${report.target}`}>
      <h3 id={`side-${report.target}`}>{title}</h3>
      <p className="muted">{story}</p>
      <DriftMeter drift={total} label={title} />
      <dl className="side__facts">
        <div>
          <dt>Money conjured</dt>
          <dd>{formatUsdc(BigInt(report.drift.conjured))}</dd>
        </div>
        <div>
          <dt>Money lost</dt>
          <dd>{formatUsdc(BigInt(report.drift.lost))}</dd>
        </div>
        <div>
          <dt>Members paid twice</dt>
          <dd>{report.drift.doubleCreditedMembers}</dd>
        </div>
        <div>
          <dt>Deliveries</dt>
          <dd>
            {report.events.attempts} attempts, {report.events.retries} retries, {report.events.crashes} crashes
          </dd>
        </div>
      </dl>
      <table className="faults">
        <caption className="sr-only">{title}: ghosts per fault</caption>
        <thead>
          <tr>
            <th scope="col">Fault</th>
            <th scope="col">Ghosts</th>
            <th scope="col">Blocked</th>
            <th scope="col">Drifted</th>
          </tr>
        </thead>
        <tbody>
          {report.faults.map((f) => (
            <tr key={f.id} className={f.drifted > 0 ? 'faults__row--drifted' : undefined}>
              <th scope="row">{f.name}</th>
              <td>{f.ghosts}</td>
              <td>{f.blocked}</td>
              <td>
                {f.drifted > 0 && <span aria-hidden="true">✗ </span>}
                {f.drifted}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {isTwin && report.drifted.length > 0 && (
        <details className="ghosts" open>
          <summary>Ghosts that got through ({report.drifted.length})</summary>
          <ul>
            {report.drifted.map((g) => (
              <li key={g.ghostId}>
                <span className="ghost__fault">{report.faults.find((f) => f.id === g.faultId)?.name ?? g.faultId}</span> · <code>{g.subject}</code> ·
                drift {formatUsdc(BigInt(g.drift.total))}
              </li>
            ))}
          </ul>
        </details>
      )}
      <details className="ghosts" open={!isTwin}>
        <summary>
          Blocked ghosts and their epitaphs ({report.blocked.length})
        </summary>
        {report.blocked.length === 0 ? (
          <p>None.</p>
        ) : (
          <ul className="epitaphs">
            {report.blocked.map((g) => (
              <li key={g.ghostId}>
                <span aria-hidden="true">✝ </span>
                {g.epitaph}
              </li>
            ))}
          </ul>
        )}
      </details>
    </article>
  );
}

/** Summon the Poltergeist: the same storm against this circle's ledger and against Vibe Pay (Requirement 10). */
export function PoltergeistPanel({ running, phase, result, error, disabled, onSummon }: PoltergeistPanelProps) {
  const id = useId();
  const [seed, setSeed] = useState(String(DEFAULT_SEED));
  const [size, setSize] = useState<StormSize>(200);
  const [seedError, setSeedError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const text = seed.trim();
    const value = /^\d{1,10}$/.test(text) ? Number(text) : NaN;
    if (!Number.isInteger(value) || value > MAX_SEED) {
      setSeedError(`The seed is a whole number from 0 to ${MAX_SEED.toLocaleString('en-US')}.`);
      return;
    }
    setSeedError(null);
    onSummon(value, size);
  };

  const books = result?.books;
  return (
    <section className="panel seance" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>Summon the Poltergeist</h2>
      <p>
        One seeded storm of duplicate webhooks, replayed signatures, out-of-order events, double-taps, refunds racing payouts and crashes mid-step,
        thrown live in this page at two systems: <strong>Ossuary</strong>, on this circle’s own ledger, and <strong>Vibe Pay</strong>, a twin a coding
        agent wrote from a one-paragraph prompt.
      </p>
      <form className="seance__form" onSubmit={submit} noValidate>
        <div className="field field--inline">
          <label htmlFor={`${id}-seed`}>Seed</label>
          <input
            id={`${id}-seed`}
            value={seed}
            inputMode="numeric"
            onChange={(e) => setSeed(e.target.value)}
            aria-invalid={seedError ? true : undefined}
            aria-describedby={seedError ? `${id}-seed-error` : undefined}
          />
        </div>
        <div className="field field--inline">
          <label htmlFor={`${id}-size`}>Events</label>
          <select id={`${id}-size`} value={size} onChange={(e) => setSize(Number(e.target.value) as StormSize)}>
            {STORM_SIZES.map((s) => (
              <option key={s} value={s}>
                {s.toLocaleString('en-US')}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="btn btn--summon" disabled={running || disabled}>
          {running ? 'Summoning…' : 'Summon the Poltergeist'}
        </button>
        {seedError && (
          <p id={`${id}-seed-error`} className="field__error">
            <span aria-hidden="true">⚠ </span>
            {seedError}
          </p>
        )}
      </form>

      {running && phase && (
        <p className="seance__phase">
          <span className="seance__spinner" aria-hidden="true" /> {PHASE_TEXT[phase]}
        </p>
      )}
      {error && (
        <p className="field__error" role="alert">
          The séance failed: {error}
        </p>
      )}

      {result && (
        <div className="seance__result" data-testid="seance-result">
          <p className="seance__summary">
            Seed {result.seed}, {result.size.toLocaleString('en-US')} events. Ossuary drift <strong>{formatUsdc(BigInt(result.ossuary.drift.total))}</strong>
            . Vibe Pay drift <strong>{formatUsdc(BigInt(result.twin.drift.total))}</strong>.
          </p>
          <div className="split">
            <Side
              title="Ossuary"
              report={result.ossuary}
              story="Core’s webhook handler, idempotency keys, ledger and outbox, on the same database as this circle."
            />
            <Side title="Vibe Pay" report={result.twin} story="The vibe-coded twin: balance columns updated in place, no signature check, no idempotency key on payouts." />
          </div>
          {books && (
            <p className={`seance__books ${books.unchanged && books.ledgerSum === 0n ? 'tag--ok' : 'tag--bad'}`} data-testid="seance-books">
              {books.circleName !== null && books.before !== null ? (
                books.unchanged ? (
                  <>
                    ✓ {books.circleName}’s books are untouched: pot {formatUsdc(books.before.pot)} before and after.
                  </>
                ) : (
                  <>✗ {books.circleName}’s books changed during the storm.</>
                )
              ) : null}{' '}
              {books.ledgerSum === 0n ? '✓' : '✗'} The whole ledger, storm included, sums to {formatUsdc(books.ledgerSum)}.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
