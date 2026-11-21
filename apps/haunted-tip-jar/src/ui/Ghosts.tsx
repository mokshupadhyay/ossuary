import { useEffect, useState } from 'react';
import { formatUsdcShort } from '../money';
import { createGhostStore, type Ghost, type GhostStore, type OverlayBus } from '../overlayBus';

/** A ghost store fed by a bus while the component is mounted. Returns a fresh snapshot on every change. */
export function useGhosts(bus: OverlayBus): Ghost[] {
  const [store] = useState<GhostStore>(() => createGhostStore());
  const [ghosts, setGhosts] = useState<Ghost[]>([]);
  useEffect(() => {
    // The store mutates ghosts in place, so copy them for React.
    const offStore = store.subscribe(() => setGhosts(store.ghosts().map((g) => ({ ...g }))));
    const offBus = bus.subscribe((m) => store.receive(m));
    return () => {
      offBus();
      offStore();
    };
  }, [bus, store]);
  return ghosts;
}

export function GhostList({ ghosts, limit = 6 }: { ghosts: readonly Ghost[]; limit?: number }) {
  return (
    <ul className="ghost-list" aria-label="Tips on the overlay">
      {ghosts.slice(0, limit).map((g) => (
        <li key={g.paymentId} className={`floating-ghost${g.faded ? ' faded' : ''}`} data-testid="ghost" data-faded={g.faded}>
          <span className="ghost-icon" aria-hidden="true">
            👻
          </span>
          <span className="ghost-who">{g.viewer}</span>
          <span className="ghost-amount">{formatUsdcShort(g.amount)} USDC</span>
          {g.message && <span className="ghost-message">“{g.message}”</span>}
          {g.faded && <span className="ghost-reversed">{g.lastReason === 'chargeback' ? 'charged back' : 'refunded'}</span>}
        </li>
      ))}
    </ul>
  );
}

/** The in-page preview on the jar view (Requirement 5.5). */
export function OverlayPreview({ bus }: { bus: OverlayBus }) {
  const ghosts = useGhosts(bus);
  return (
    <section className="card overlay-preview" aria-labelledby="preview-title">
      <h2 id="preview-title">Overlay preview</h2>
      <p className="hint">
        Ghosts arrive from the outbox, once each. Open{' '}
        <a href="#/overlay" target="_blank" rel="noopener">
          the overlay
        </a>{' '}
        as a browser source.
      </p>
      <div className="preview-stage">
        {ghosts.length === 0 ? <p className="hint">Waiting for the next tip…</p> : <GhostList ghosts={ghosts} />}
      </div>
    </section>
  );
}

/** `#/overlay`: transparent, no controls (Requirement 5.1). Never opens the database. */
export function OverlayPage({ bus }: { bus: OverlayBus }) {
  const ghosts = useGhosts(bus);
  useEffect(() => {
    document.documentElement.classList.add('overlay-mode');
    return () => document.documentElement.classList.remove('overlay-mode');
  }, []);
  return (
    <main className="overlay-page" aria-label="Tip overlay">
      <GhostList ghosts={ghosts} limit={5} />
    </main>
  );
}
