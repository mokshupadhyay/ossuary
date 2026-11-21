import './polyfills';
import './styles.css';
import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { bootBrowser, type Boot } from './boot';
import { createOverlayBus } from './overlayBus';
import { App } from './ui/App';

const bus = createOverlayBus();
let booted: Promise<Boot> | null = null;
// One boot per page, even under StrictMode's double effects.
const boot = () => (booted ??= bootBrowser(bus));

// The poltergeist engine and the twin load only when the panel is opened.
const PoltergeistPanel = lazy(() => import('./ui/PoltergeistPanel').then((m) => ({ default: m.PoltergeistPanel })));
const poltergeist = () => (
  <Suspense fallback={<p className="hint" role="status">Waking the poltergeist…</p>}>
    <PoltergeistPanel />
  </Suspense>
);

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <App boot={boot} bus={bus} poltergeist={poltergeist} />
  </StrictMode>,
);
