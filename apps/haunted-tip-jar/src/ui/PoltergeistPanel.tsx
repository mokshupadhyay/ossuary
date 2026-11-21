import { useState, type FormEvent } from 'react';
import type { PoltergeistReport } from '@ossuary/core/poltergeist';
import { formatUsdc } from '../money';
import { checkSeed, checkSize, DEFAULT_SEED, DEFAULT_SIZE, MAX_SIZE, MIN_SIZE, runDuel, type Duel, type Phase } from '../poltergeist';
import { useAnnounce } from './Announcer';

const PHASE_TEXT: Record<Phase, string> = {
  storm: 'Brewing the storm…',
  ossuary: 'Throwing it at Ossuary…',
  twin: 'Throwing it at Vibe Pay…',
};

const abs = (x: bigint) => (x < 0n ? -x : x);

function DriftMeter({ title, report }: { title: string; report: PoltergeistReport }) {
  const total = BigInt(report.drift.total);
  const conjured = BigInt(report.drift.conjured);
  const lost = BigInt(report.drift.lost);
  const zero = total === 0n && conjured === 0n && lost === 0n;
  const blocked = report.faults.reduce((n, f) => n + f.blocked, 0);
  const drifted = report.faults.reduce((n, f) => n + f.drifted, 0);
  // Meter fill on a log-ish scale by digit count: purely visual, derived from a string length.
  const digits = zero ? 0 : (abs(conjured) + abs(lost)).toString().length;
  const id = `meter-${report.target}`;
  return (
    <section className={`card meter ${zero ? 'ok' : 'bad'}`} aria-labelledby={id} data-testid={`meter-${report.target}`}>
      <h2 id={id}>{title}</h2>
      <p className="drift-value">
        <span aria-hidden="true">{zero ? '🪦✅ ' : '💸❌ '}</span>
        Drift <strong data-testid={`drift-${report.target}`}>{formatUsdc(total)}</strong> USDC
      </p>
      <meter min={0} max={13} low={1} high={6} optimum={0} value={digits} aria-label={`${title} drift size`} />
      <dl className="meter-stats">
        <div>
          <dt>Conjured</dt>
          <dd>{formatUsdc(conjured)}</dd>
        </div>
        <div>
          <dt>Lost</dt>
          <dd>{formatUsdc(lost)}</dd>
        </div>
        <div>
          <dt>Ghosts blocked</dt>
          <dd>{blocked}</dd>
        </div>
        <div>
          <dt>Ghosts that drifted</dt>
          <dd>{drifted}</dd>
        </div>
      </dl>
      <p className="verdict-line">{zero ? 'Not one minor unit out of place.' : `${report.drift.doubleCreditedMembers} members paid more than they were owed.`}</p>
      {report.counterexample && (
        <p className="hint" data-testid={`cx-${report.target}`}>
          First drift: ghost <code>{report.counterexample.unitId}</code>, fault <strong>{report.counterexample.faultId ?? 'honest'}</strong>
        </p>
      )}
    </section>
  );
}

function FaultTable({ duel }: { duel: Duel }) {
  return (
    <section className="card" aria-labelledby="faults-title">
      <h2 id="faults-title">Ghosts by fault</h2>
      <div className="table-scroll">
        <table>
          <caption className="sr-only">Blocked and drifted ghosts per fault, Ossuary versus Vibe Pay</caption>
          <thead>
            <tr>
              <th scope="col">Fault</th>
              <th scope="col">Ghosts</th>
              <th scope="col">Ossuary blocked</th>
              <th scope="col">Vibe Pay drifted</th>
              <th scope="col">Vibe Pay drift (USDC)</th>
            </tr>
          </thead>
          <tbody>
            {duel.ossuary.faults.map((f, i) => {
              const t = duel.twin.faults[i]!;
              return (
                <tr key={f.id}>
                  <th scope="row">{f.name}</th>
                  <td>{f.ghosts}</td>
                  <td>
                    {f.blocked}/{f.ghosts}
                  </td>
                  <td>
                    {t.drifted}/{t.ghosts}
                  </td>
                  <td className="num">{formatUsdc(BigInt(t.drift.total))}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function PoltergeistPanel({ initialSize = DEFAULT_SIZE, minSize = MIN_SIZE }: { initialSize?: number; minSize?: number }) {
  const announce = useAnnounce();
  const [seed, setSeed] = useState(String(DEFAULT_SEED));
  const [size, setSize] = useState(String(initialSize));
  const [phase, setPhase] = useState<Phase | null>(null);
  const [duel, setDuel] = useState<Duel | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function summonIt(e: FormEvent) {
    e.preventDefault();
    if (phase) return;
    const s = checkSeed(seed);
    const n = checkSize(size, minSize);
    if (typeof s === 'string') return setError(s);
    if (typeof n === 'string') return setError(n);
    setError(null);
    try {
      const d = await runDuel(s, n, (p) => {
        setPhase(p);
        announce(PHASE_TEXT[p]);
      });
      setDuel(d);
      announce(
        `Storm ${d.seed} done. Ossuary drift ${formatUsdc(BigInt(d.ossuary.drift.total))} USDC. Vibe Pay drift ${formatUsdc(BigInt(d.twin.drift.total))} USDC.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPhase(null);
    }
  }

  return (
    <div className="poltergeist">
      <header>
        <p className="eyebrow">Ossuary vs Vibe Pay</p>
        <h1>Summon the Poltergeist</h1>
        <p className="hint">
          One seeded storm of duplicate webhooks, replays, out-of-order events, refunds before captures, double-taps and crashes, thrown at Ossuary
          (the skeleton this jar runs on) and at Vibe Pay, a vibe-coded twin. Both run in your browser on their own throwaway Postgres; your jar is
          not touched.
        </p>
      </header>

      <form className="card summon" onSubmit={summonIt} aria-labelledby="summon-title">
        <h2 id="summon-title" className="sr-only">
          Storm settings
        </h2>
        <div className="summon-fields">
          <label>
            Seed
            <input value={seed} onChange={(e) => setSeed(e.target.value)} inputMode="numeric" />
          </label>
          <label>
            Events ({minSize}–{MAX_SIZE})
            <input value={size} onChange={(e) => setSize(e.target.value)} inputMode="numeric" />
          </label>
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" disabled={phase !== null} aria-busy={phase !== null}>
          {phase ? PHASE_TEXT[phase] : 'Summon the Poltergeist 👻'}
        </button>
      </form>

      {duel && (
        <>
          <div className="duel">
            <DriftMeter title="Ossuary" report={duel.ossuary} />
            <DriftMeter title="Vibe Pay (twin)" report={duel.twin} />
          </div>
          <FaultTable duel={duel} />
          <section className="card" aria-labelledby="blocked-title">
            <h2 id="blocked-title">Ghosts Ossuary buried ({duel.ossuary.blocked.length})</h2>
            <ul className="epitaphs" data-testid="epitaphs">
              {duel.ossuary.blocked.slice(0, 40).map((g) => (
                <li key={g.ghostId}>
                  <span aria-hidden="true">🪦 </span>
                  {g.epitaph}
                </li>
              ))}
            </ul>
            {duel.ossuary.blocked.length > 40 && <p className="hint">…and {duel.ossuary.blocked.length - 40} more.</p>}
          </section>
        </>
      )}
    </div>
  );
}
