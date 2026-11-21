import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import type { PoltergeistReport } from '@ossuary/core/poltergeist';
import type { SeancePhase, SeanceResult } from '../tontine/seance';
import { finishedText, ghostsInOrder, lostAndConjured, percentOf, type ReplayGhost } from '../tontine/stormView';

/*
 * The storm on stage (decorative, with the facts in text). While the storm
 * runs, ghosts drift across both lanes. When the reports are in, the storm is
 * replayed in storm order: each ghost crosses both lanes, ends at Ossuary's
 * tombstone, and on Vibe Pay either is buried too or escapes and pushes the
 * red meter up. Ossuary's meter stays at zero. With reduced motion there is no
 * replay: the final state is shown at once.
 */

/** How long the replay of a finished storm takes, whatever its size. */
export const REPLAY_MS = 2400;
const TICK_MS = 80;
const STEPS = Math.round(REPLAY_MS / TICK_MS);
/** A ghost's crossing takes this long; keep in step with `.sprite--buried`/`--escaped` in styles.css. */
const CROSSING_MS = 1200;
const CROSSING_STEPS = Math.round(CROSSING_MS / TICK_MS);
/** Upper bound on ghosts in one lane at once, so a 2,000-event storm stays light. */
const MAX_SPRITES = 8;
const ROWS = 4;

type Side = 'ossuary' | 'twin';

const rowOf = (ghostId: string) => (Number(ghostId.replace(/\D/g, '')) || 0) % ROWS;

function Lane({ side, ghosts, fate, brewing, reduced }: { side: Side; ghosts: readonly ReplayGhost[]; fate: (g: ReplayGhost) => 'buried' | 'escaped'; brewing: boolean; reduced: boolean }) {
  return (
    <div className={`lane lane--${side}${reduced ? ' lane--still' : ''}`} aria-hidden="true" data-testid={`lane-${side}`}>
      {reduced ? (
        <span className="lane__still">👻 → {side === 'ossuary' ? '🪦' : '💸'}</span>
      ) : brewing ? (
        [0, 1, 2, 3].map((i) => (
          <span key={i} className="sprite sprite--brewing" style={{ top: `${12 + i * 20}%`, animationDelay: `${i * -0.5}s` }}>
            👻
          </span>
        ))
      ) : (
        ghosts.map((g) => (
          <span key={g.ghostId} className={`sprite sprite--${fate(g)}`} style={{ top: `${12 + rowOf(g.ghostId) * 20}%` }} data-fate={fate(g)}>
            👻
          </span>
        ))
      )}
      <span className="lane__end">{side === 'ossuary' ? '🪦' : '🕳️'}</span>
    </div>
  );
}

function Gauge({ title, side, percent, through, buried, label }: { title: string; side: Side; percent: number; through: number; buried: number; label: string }) {
  return (
    <div className={`gauge gauge--${side}${through > 0 ? ' gauge--bad' : ' gauge--ok'}`}>
      <div className="gauge__track" role="img" aria-label={`${title}: ${label}`}>
        <span className="gauge__fill" style={{ '--fill': `${percent}%` } as CSSProperties} data-testid={`gauge-${side}`} data-percent={percent} />
      </div>
      <p className="gauge__text">
        <span data-testid={`stage-${side}-buried`}>{buried}</span> buried · <span data-testid={`stage-${side}-through`}>{through}</span> got through
      </p>
    </div>
  );
}

export interface StormStageProps {
  running: boolean;
  phase: SeancePhase | null;
  result: SeanceResult | null;
  reduced: boolean;
  /** Called once per result, when the replay has finished (at once with reduced motion). */
  onFinished: (result: SeanceResult) => void;
}

export function StormStage({ running, phase, result, reduced, onFinished }: StormStageProps) {
  const id = useId();
  // Progress belongs to one result, so a new result never renders with the last one's finished state.
  const [progress, setProgress] = useState<{ of: SeanceResult | null; step: number }>({ of: null, step: 0 });
  const step = progress.of === result ? progress.step : reduced ? STEPS : 0;
  const [announcement, setAnnouncement] = useState('');
  const finished = useRef(onFinished);
  finished.current = onFinished;
  const order = result ? ghostsInOrder(result.twin) : [];
  const total = order.length;

  useEffect(() => {
    if (!result) return undefined;
    setAnnouncement('');
    const n = ghostsInOrder(result.twin).length;
    const finish = () => {
      setProgress({ of: result, step: STEPS });
      setAnnouncement(finishedText(result.ossuary, result.twin));
      finished.current(result);
    };
    if (reduced || n === 0) {
      finish();
      return undefined;
    }
    let at = 0;
    const t = setInterval(() => {
      at += 1;
      if (at >= STEPS) {
        clearInterval(t);
        finish();
      } else setProgress({ of: result, step: at });
    }, TICK_MS);
    return () => clearInterval(t);
    // The replay restarts only for a new result (or a change of motion preference), not when onFinished changes.
  }, [result, reduced]);

  if (!running && !result) return null;

  const revealed = (at: number) => Math.ceil((total * Math.max(0, Math.min(at, STEPS))) / STEPS);
  const shown = revealed(step);
  const seen = order.slice(0, shown);
  // Ghosts revealed within one crossing are still in the air; sample every k-th so at most MAX_SPRITES fly at once.
  const from = step >= STEPS ? shown : revealed(step - CROSSING_STEPS);
  const stride = Math.max(1, Math.ceil(revealed(CROSSING_STEPS) / MAX_SPRITES));
  const crossing = order.slice(from, shown).filter((_, j) => (from + j) % stride === 0);
  const ossuaryDrifted = new Set(result?.ossuary.drifted.map((g) => g.ghostId) ?? []);
  const twinDrifted = new Set(result?.twin.drifted.map((g) => g.ghostId) ?? []);

  const sideStats = (report: PoltergeistReport | undefined, drifted: Set<string>) => {
    const through = seen.filter((g) => drifted.has(g.ghostId)).length;
    if (!report) return { through: 0, buried: 0, percent: 0 };
    const sizeOf = (ghostId: string) => {
      const g = report.drifted.find((d) => d.ghostId === ghostId);
      if (!g) return 0n;
      const { lost, conjured } = lostAndConjured(g.drift);
      return lost + conjured;
    };
    const all = report.drifted.reduce((s, g) => s + sizeOf(g.ghostId), 0n);
    const sofar = seen.reduce((s, g) => s + (drifted.has(g.ghostId) ? sizeOf(g.ghostId) : 0n), 0n);
    return { through, buried: seen.length - through, percent: percentOf(sofar, all) };
  };
  const o = sideStats(result?.ossuary, ossuaryDrifted);
  const t = sideStats(result?.twin, twinDrifted);
  const brewing = running || !result;
  const replaying = !brewing && step < STEPS;

  return (
    <div className="stage" aria-labelledby={`${id}-title`} role="group" data-testid="storm-stage" data-state={brewing ? 'storm' : replaying ? 'replay' : 'done'}>
      <h3 id={`${id}-title`} className="sr-only">
        The storm
      </h3>
      <p className="stage__caption muted">
        {brewing
          ? phase === 'twin'
            ? 'Ghosts are loose in Vibe Pay…'
            : phase === 'books'
              ? 'Counting the circle’s books…'
              : 'Ghosts are loose in Ossuary’s ledger…'
          : replaying
            ? `Replaying the storm: ghost ${shown} of ${total}…`
            : `All ${total} ghosts have crossed.`}
      </p>
      <div className="stage__lanes">
        <div className="stage__side">
          <p className="stage__name">Ossuary</p>
          <Lane side="ossuary" ghosts={crossing} fate={(g) => (ossuaryDrifted.has(g.ghostId) ? 'escaped' : 'buried')} brewing={brewing} reduced={reduced} />
          <Gauge title="Ossuary" side="ossuary" percent={o.percent} through={o.through} buried={o.buried} label={o.through === 0 ? 'no drift' : `${o.through} ghosts got through`} />
        </div>
        <div className="stage__side">
          <p className="stage__name">Vibe Pay</p>
          <Lane side="twin" ghosts={crossing} fate={(g) => (twinDrifted.has(g.ghostId) ? 'escaped' : 'buried')} brewing={brewing} reduced={reduced} />
          <Gauge title="Vibe Pay" side="twin" percent={t.percent} through={t.through} buried={t.buried} label={t.through === 0 ? 'no drift' : `${t.through} ghosts got through`} />
        </div>
      </div>
      <p className="stage__status" role="status" aria-live="polite" data-testid="storm-status">
        {announcement}
      </p>
    </div>
  );
}
