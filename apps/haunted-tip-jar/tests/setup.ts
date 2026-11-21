import { vi } from 'vitest';
import '../src/polyfills';

/*
 * Under jsdom, `import.meta.url` for workspace sources is not a `file:` URL,
 * and core's db/migrate.ts calls Node's `fileURLToPath` on it at load time
 * ("The URL must be of scheme file"). That path is only used by
 * `runMigrations`, which the app never calls (it uses applyEmbeddedMigrations).
 * For non-file URLs this mock returns the URL's pathname, the same as the
 * browser stub in src/shims/node-stubs.ts; file URLs go to Node's real
 * function. Core itself is not changed.
 */
vi.mock('node:url', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:url')>();
  const fileURLToPath = (u: string | URL) => {
    const href = typeof u === 'string' ? u : String(u.href);
    return href.startsWith('file:') ? actual.fileURLToPath(href) : decodeURIComponent(new URL(href).pathname);
  };
  return { ...actual, fileURLToPath, default: { ...actual, fileURLToPath } };
});
