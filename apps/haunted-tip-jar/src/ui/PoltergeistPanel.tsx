import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { PoltergeistReport } from '@ossuary/core/poltergeist';
import { formatUsdc } from '../money';
import {
  checkSeed,
  checkSize,
  DEFAULT_SEED,
  DEFAULT_SIZE,
  MAX_SIZE,
  MIN_SIZE,
  moneyByFault,
  replayGhosts,
  runDuel,
  type Duel,
  type Phase,
  type ReplayGhost,
} from '../poltergeist';

const PHASE_TEXT: Record<Phase, string> = {
  storm: 'Brewing the storm…',
  ossuary: 'Throwing it at Ossuary…',
  twin: 'Throwing it at Vibe Pay…',
};
const REPLAY_TEXT = 'Replaying the storm…';
/** How long the replay of a finished storm takes, whatever its size. */
export const REPLAY_MS = 2400;
const REPLAY_TICK_MS = 80;
/** A replayed ghost's crossing takes this long (keep in step with `.sprite.buried`/`.escaped` in styles.css). */
const CROSSING_MS = 1400;
/** Upper bound on ghosts in one lane at once, so a 2,000-event storm stays light. */
const MAX_SPRITES = 14;
const SPRITE_ROWS = 4;

const abs = (x: bigint) => (x < 0n ? -x : x);
/** Meter fill on a log-ish scale by digit count: purely visual, derived from a string length. */
const meterDigits = (r: PoltergeistReport) => {
  const size = abs(BigInt(r.drift.conjured)) + abs(BigInt(r.drift.lost));
  return size === 0n && BigInt(r.drift.total) === 0n ? 0 : size.toString().length;
};
const METER_MAX = 13;

export function finishedText(duel: Duel): string {
  return `Storm finished: drift ${formatUsdc(BigInt(duel.ossuary.drift.total))} USDC on Ossuary, ${formatUsdc(BigInt(duel.twin.drift.total))} USDC on Vibe Pay (seed ${duel.seed}, ${duel.size} events).`;
}

/** Follows `prefers-reduced-motion`, live. Without `matchMedia` (jsdom) it reports false. */
export function useReducedMotion(): boolean {
  const query = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null);
  const [reduced, setReduced] = useState(() => query()?.matches ?? false);
  useEffect(() => {
    const q = query();
    if (!q) return;
    const on = () => setReduced(q.matches);
    on();
    q.addEventListener('change', on);
    return () => q.removeEventListener('change', on);
  }, []);
  return reduced;
}

type Side = 'ossuary' | 'twin';

/**
 * The lane ghosts cross. Decorative only (aria-hidden): the numbers next to it carry the meaning.
 * Ossuary's lane ends at a tombstone; on Vibe Pay a ghost that drifted escapes with the money.
 */
function Sky({ side, ghosts, brewing, reduced }: { side: Side; ghosts: readonly ReplayGhost[]; brewing: boolean; reduced: boolean }) {
  let sprites: { key: string; fate: 'buried' | 'escaped' | 'brewing'; delay?: string }[];
  if (reduced) sprites = [];
  else if (brewing) sprites = [0, 1, 2, 3].map((i) => ({ key: `b${i}`, fate: 'brewing', delay: `${i * -0.45}s` }));
  else sprites = ghosts.map((g) => ({ key: g.id, fate: (side === 'twin' ? g.twinDrifted : g.ossuaryDrifted) ? 'escaped' : 'buried' }));
  // Spread ghosts over a few rows (by storm position) so a burst does not stack on one line.
  const row = (key: string) => (Number(key.replace(/\D/g, '')) || 0) % SPRITE_ROWS;
  return (
    <div className={`sky sky-${side}${reduced ? ' still' : ''}`} aria-hidden="true" data-testid={`sky-${side}`}>
      {reduced && <span className="sky-still">👻 → {side === 'ossuary' ? '🪦' : '💸'}</span>}
      {sprites.map((s) => (
        <span key={s.key} className={`sprite ${s.fate}`} style={{ top: `${18 + row(s.key) * 20}%`, animationDelay: s.delay }} data-fate={s.fate}>
          👻
        </span>
      ))}
      <span className="sky-end">{side === 'ossuary' ? '🪦' : '🕳️'}</span>
    </div>
  );
}

/** A meter card while the storm runs (no report yet) or replays (report known, ghosts revealed one by one). */
function StormCard({
  title,
  side,
  report,
  seen,
  inSky,
  reduced,
}: {
  title: string;
  side: Side;
  report: PoltergeistReport | null;
  seen: readonly ReplayGhost[];
  /** How many of the latest revealed ghosts are still crossing the lane. */
  inSky: number;
  reduced: boolean;
}) {
  const drifted = seen.filter((g) => (side === 'twin' ? g.twinDrifted : g.ossuaryDrifted)).length;
  const totalDrifted = report ? report.faults.reduce((n, f) => n + f.drifted, 0) : 0;
  // The fill climbs with the share of this side's drifted ghosts revealed so far, up to the final meter.
  const value = report && totalDrifted > 0 ? (meterDigits(report) * drifted) / totalDrifted : 0;
  const id = `storm-${side}`;
  return (
    <section className={`card meter storming ${drifted > 0 ? 'bad' : 'ok'}`} aria-labelledby={id} data-testid={`storm-${side}`}>
      <h2 id={id}>{title}</h2>
      <Sky side={side} ghosts={seen.slice(-inSky)} brewing={report === null} reduced={reduced} />
      <p className="drift-value">
        Drift <strong>{report ? 'counting…' : 'waiting…'}</strong>
      </p>
      <meter min={0} max={METER_MAX} low={1} high={6} optimum={0} value={value} aria-label={`${title} drift size`} />
      <dl className="meter-stats">
        <div>
          <dt>Ghosts blocked</dt>
          <dd data-testid={`storm-${side}-blocked`}>{seen.length - drifted}</dd>
        </div>
        <div>
          <dt>Ghosts that drifted</dt>
          <dd data-testid={`storm-${side}-drifted`}>{drifted}</dd>
        </div>
      </dl>
    </section>
  );
}

export function DriftMeter({ title, report }: { title: string; report: PoltergeistReport }) {
  const total = BigInt(report.drift.total);
  const conjured = BigInt(report.drift.conjured);
  const lost = BigInt(report.drift.lost);
  const zero = total === 0n && conjured === 0n && lost === 0n;
  const blocked = report.faults.reduce((n, f) => n + f.blocked, 0);
  const drifted = report.faults.reduce((n, f) => n + f.drifted, 0);
  const id = `meter-${report.target}`;
  return (
    <section className={`card meter ${zero ? 'ok' : 'bad'}`} aria-labelledby={id} data-testid={`meter-${report.target}`}>
      <h2 id={id}>{title}</h2>
      <p className="drift-value">
        <span aria-hidden="true">{zero ? '🪦✅ ' : '💸❌ '}</span>
        Drift <strong data-testid={`drift-${report.target}`}>{formatUsdc(total)}</strong> USDC
      </p>
      <meter min={0} max={METER_MAX} low={1} high={6} optimum={0} value={meterDigits(report)} aria-label={`${title} drift size`} />
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

export function FaultTable({ duel }: { duel: Duel }) {
  const money = moneyByFault(duel.twin);
  return (
    <section className="card" aria-labelledby="faults-title">
      <h2 id="faults-title">Ghosts by fault</h2>
      <p className="hint" id="faults-note">
        Lost and conjured are added up ghost by ghost, so a double-tap that moves money from the pot to a member shows both sides instead of netting to zero.
      </p>
      <div className="table-scroll" role="region" aria-labelledby="faults-title" tabIndex={0}>
        <table aria-describedby="faults-note">
          <caption className="sr-only">Blocked and drifted ghosts per fault, Ossuary versus Vibe Pay, with the USDC Vibe Pay lost and conjured</caption>
          <thead>
            <tr>
              <th scope="col">Fault</th>
              <th scope="col">Ghosts</th>
              <th scope="col">Ossuary blocked</th>
              <th scope="col">Vibe Pay drifted</th>
              <th scope="col">Vibe Pay lost (USDC)</th>
              <th scope="col">Vibe Pay conjured (USDC)</th>
            </tr>
          </thead>
          <tbody>
            {duel.ossuary.faults.map((f, i) => {
              const t = duel.twin.faults[i]!;
              const m = money.get(t.id)!;
              return (
                <tr key={f.id} className={t.drifted > 0 ? 'drifted' : undefined}>
                  <th scope="row">{f.name}</th>
                  <td>{f.ghosts}</td>
                  <td>
                    {f.blocked}/{f.ghosts}
                  </td>
                  <td>
                    {t.drifted}/{t.ghosts}
                  </td>
                  <td className="num">{formatUsdc(m.lost)}</td>
                  <td className="num">{formatUsdc(m.conjured)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function PoltergeistPanel({
  initialSize = DEFAULT_SIZE,
  minSize = MIN_SIZE,
  replayMs = REPLAY_MS,
}: {
  initialSize?: number;
  minSize?: number;
  /** Length of the replay animation; 0 skips it. Reduced motion always skips it. */
  replayMs?: number;
}) {
  const reduced = useReducedMotion();
  const [seed, setSeed] = useState(String(DEFAULT_SEED));
  const [size, setSize] = useState(String(initialSize));
  const [phase, setPhase] = useState<Phase | null>(null);
  const [duel, setDuel] = useState<Duel | null>(null);
  const [ghosts, setGhosts] = useState<ReplayGhost[]>([]);
  /** Ghosts revealed by the replay so far; equal to ghosts.length when it is over. */
  const [shown, setShown] = useState(0);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const finishedFor = useRef<Duel | null>(null);

  const replaying = duel !== null && shown < ghosts.length;
  const busy = phase !== null || replaying;
  // Ghosts revealed per tick, so any storm size replays in about replayMs; and how many are still mid-crossing.
  const stride = Math.max(1, Math.ceil(ghosts.length / Math.max(1, Math.floor(replayMs / REPLAY_TICK_MS))));
  const inSky = Math.min(MAX_SPRITES, Math.ceil(CROSSING_MS / REPLAY_TICK_MS) * stride);

  // Advance the replay one tick at a time; reduced motion (or replayMs 0) jumps to the end.
  useEffect(() => {
    if (!replaying) return;
    if (reduced || replayMs <= 0) {
      setShown(ghosts.length);
      return;
    }
    const t = setTimeout(() => setShown((s) => Math.min(ghosts.length, s + stride)), REPLAY_TICK_MS);
    return () => clearTimeout(t);
  }, [replaying, shown, ghosts.length, reduced, replayMs, stride]);

  // Announce once, when the meters show their final numbers.
  useEffect(() => {
    if (duel && !replaying && finishedFor.current !== duel) {
      finishedFor.current = duel;
      setStatus(finishedText(duel));
    }
  }, [duel, replaying]);

  async function summonIt(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const s = checkSeed(seed);
    const n = checkSize(size, minSize);
    if (typeof s === 'string') return setError(s);
    if (typeof n === 'string') return setError(n);
    setError(null);
    setDuel(null);
    setGhosts([]);
    setShown(0);
    try {
      const d = await runDuel(s, n, (p) => {
        setPhase(p);
        setStatus(PHASE_TEXT[p]);
      });
      const g = replayGhosts(d);
      setGhosts(g);
      setShown(0);
      setDuel(d);
      if (g.length > 0 && !reduced && replayMs > 0) setStatus(REPLAY_TEXT);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus('');
    } finally {
      setPhase(null);
    }
  }

  const running = phase !== null;
  const seen = ghosts.slice(0, shown);

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
        <button type="submit" disabled={busy} aria-busy={busy}>
          {phase ? PHASE_TEXT[phase] : replaying ? REPLAY_TEXT : 'Summon the Poltergeist 👻'}
        </button>
        <p className="storm-status" role="status" aria-live="polite" data-testid="storm-status">
          {status}
        </p>
      </form>

      {(running || replaying) && (
        <div className="duel" data-testid="storm" data-state={running ? 'running' : 'replaying'}>
          <StormCard title="Ossuary" side="ossuary" report={duel?.ossuary ?? null} seen={seen} inSky={inSky} reduced={reduced} />
          <StormCard title="Vibe Pay (twin)" side="twin" report={duel?.twin ?? null} seen={seen} inSky={inSky} reduced={reduced} />
        </div>
      )}

      {duel && !replaying && (
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
                <li key={g.ghostId} className="tombstone">
                  <span className="tombstone-icon" aria-hidden="true">
                    🪦
                  </span>
                  <span>{g.epitaph}</span>
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
