import { useState } from 'react';
import type { TipJar } from '../jar';
import type { OverlayBus } from '../overlayBus';
import { GoalBar } from './GoalBar';
import { OverlayPreview } from './Ghosts';
import { DeliveryLog, RailConsole } from './RailConsole';
import { TipForm } from './TipForm';
import { TipRow } from './TipRow';
import { useJarData } from './useJarData';

export interface JarViewProps {
  jar: TipJar;
  bus: OverlayBus;
  onReset?: () => Promise<void>;
  intervalMs?: number;
}

export function JarView({ jar, bus, onReset, intervalMs }: JarViewProps) {
  const { data, error, refresh } = useJarData(jar, { intervalMs });
  const done = () => void refresh();
  const [resetting, setResetting] = useState(false);

  async function reset() {
    if (!onReset) return;
    if (!window.confirm('Start a fresh jar? The current one is archived; nothing is deleted.')) return;
    setResetting(true);
    try {
      await onReset();
    } finally {
      setResetting(false);
    }
  }

  return (
    <div className="jar-view">
      <header className="jar-header">
        <div>
          <p className="eyebrow">Tip jar of</p>
          <h1>{jar.info.creator}</h1>
        </div>
        {onReset && (
          <button type="button" className="secondary" onClick={() => void reset()} disabled={resetting}>
            {resetting ? 'Resetting…' : 'Reset jar'}
          </button>
        )}
      </header>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {data ? <GoalBar held={data.coffin.held} goal={jar.info.goal} /> : <p className="hint">Opening the jar…</p>}

      <div className="columns">
        <div className="col">
          <TipForm jar={jar} onDone={done} />
          <OverlayPreview bus={bus} />
          <RailConsole jar={jar} onDone={done} />
        </div>
        <div className="col">
          <section className="card" aria-labelledby="feed-title">
            <h2 id="feed-title">Recent tips</h2>
            {data && data.tips.length === 0 && <p className="hint">No tips yet.</p>}
            <ul className="tip-list">
              {data?.tips.map((t) => <TipRow key={t.paymentId} jar={jar} tip={t} onDone={done} />)}
            </ul>
          </section>
          {data && <DeliveryLog rows={data.deliveries} />}
        </div>
      </div>
    </div>
  );
}
