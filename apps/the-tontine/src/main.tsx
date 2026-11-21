import './platform/polyfills';
import './ui/styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { browserRuntime } from './runtime/runtime';
import { App } from './ui/App';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
const runtime = browserRuntime();
createRoot(root).render(
  <StrictMode>
    <App runtime={runtime} />
  </StrictMode>,
);
