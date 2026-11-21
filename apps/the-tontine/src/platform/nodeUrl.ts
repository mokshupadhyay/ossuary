/*
 * Browser adapter for `node:url`. core's src/db/migrate.ts computes its
 * migrations folder with `fileURLToPath(new URL('../migrations', import.meta.url))`
 * when the module loads, because `@ossuary/core` re-exports `runMigrations`.
 * The app never calls `runMigrations` (it has no file system); it uses
 * `applyEmbeddedMigrations` from `@ossuary/core/poltergeist`. This adapter
 * only lets that one module-level expression evaluate in the page.
 */
export function fileURLToPath(url: string | URL): string {
  return decodeURIComponent(new URL(url).pathname);
}

export function pathToFileURL(path: string): URL {
  return new URL(`file://${encodeURI(path)}`);
}

export default { fileURLToPath, pathToFileURL };
