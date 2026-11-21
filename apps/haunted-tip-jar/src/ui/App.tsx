import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Boot } from '../boot';
import type { TipJar } from '../jar';
import type { OverlayBus } from '../overlayBus';
import { Announcer } from './Announcer';
import { Coffin } from './Coffin';
import { OverlayPage } from './Ghosts';
import { JarView } from './JarView';
import { hrefFor, useRoute, type Route } from './routes';

export interface AppProps {
  /** Opens the jar. Called once, the first time a page needs it. */
  boot: () => Promise<Boot>;
  bus: OverlayBus;
  /** The poltergeist panel (task 6); injected so the jar pages do not load the engine. */
  poltergeist?: () => ReactNode;
  intervalMs?: number;
}

const NAV: { route: Route; label: string }[] = [
  { route: 'jar', label: 'Jar' },
  { route: 'coffin', label: 'Count the coffin' },
  { route: 'poltergeist', label: 'Summon the Poltergeist' },
];

function Shell({ route, children }: { route: Route; children: ReactNode }) {
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="site-header">
        <a className="brand" href="#/">
          <span aria-hidden="true">🫙👻 </span>Haunted Tip Jar
        </a>
        <nav aria-label="Main">
          <ul>
            {NAV.map((n) => (
              <li key={n.route}>
                <a href={hrefFor(n.route)} aria-current={route === n.route ? 'page' : undefined}>
                  {n.label}
                </a>
              </li>
            ))}
            <li>
              <a href="#/overlay" target="_blank" rel="noopener">
                Overlay<span className="sr-only"> (opens in a new tab)</span>
              </a>
            </li>
          </ul>
        </nav>
      </header>
      <main id="main" tabIndex={-1}>
        {children}
      </main>
      <footer className="site-footer">
        Fake testnet USDC only. Runs entirely in your browser on PGlite. Built on Ossuary.
      </footer>
    </>
  );
}

export function App({ boot, bus, poltergeist, intervalMs }: AppProps) {
  const route = useRoute();
  const [state, setState] = useState<Boot | null>(null);
  const [jar, setJar] = useState<TipJar | null>(null);
  const started = useRef(false);
  const needsJar = route === 'jar' || route === 'coffin';

  useEffect(() => {
    if (!needsJar || started.current) return;
    started.current = true;
    void boot().then((b) => {
      setState(b);
      if (b.kind === 'ready') setJar(b.jar);
    });
  }, [needsJar, boot]);

  if (route === 'overlay') return <OverlayPage bus={bus} />;

  let body: ReactNode;
  if (route === 'poltergeist') {
    body = poltergeist ? poltergeist() : <p className="hint">The poltergeist is resting.</p>;
  } else if (!state) {
    body = (
      <p className="hint" role="status">
        Opening the jar… (first load sets up Postgres in your browser)
      </p>
    );
  } else if (state.kind === 'locked') {
    body = (
      <section className="card" role="alert">
        <h1>The jar is open in another tab</h1>
        <p>Only one tab can hold the jar's database. Close the other tab and reload this one. The overlay and the poltergeist work in any tab.</p>
      </section>
    );
  } else if (state.kind === 'error') {
    body = (
      <p className="error" role="alert">
        Could not open the jar: {state.message}
      </p>
    );
  } else if (jar) {
    const reset = async () => setJar(await state.reset());
    body = route === 'coffin' ? <Coffin jar={jar} intervalMs={intervalMs} /> : <JarView jar={jar} bus={bus} onReset={reset} intervalMs={intervalMs} />;
  }

  return (
    <Announcer>
      <Shell route={route}>{body}</Shell>
    </Announcer>
  );
}
