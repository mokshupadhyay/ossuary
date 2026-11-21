/*
 * Browser stand-ins for the Node built-ins that @ossuary/core's root entry
 * reaches but the app never calls: `runMigrations` (node:url at load time,
 * node:fs through drizzle's readMigrationFiles). The app migrates with
 * `applyEmbeddedMigrations` instead (poltergeist-engine design D8).
 *
 * `fileURLToPath` runs when core's db/migrate.ts loads, so it returns the URL
 * path. Every file-system call throws, so an accidental use fails loudly.
 */
export function fileURLToPath(url: string | URL): string {
  return decodeURIComponent(new URL(String(url)).pathname);
}

const unavailable = (name: string) => () => {
  throw new Error(`${name} is not available in the browser`);
};

export const existsSync = unavailable('fs.existsSync');
export const readFileSync = unavailable('fs.readFileSync');
export const readdirSync = unavailable('fs.readdirSync');
export const realpathSync = unavailable('fs.realpathSync');

export default { fileURLToPath, existsSync, readFileSync, readdirSync, realpathSync };
