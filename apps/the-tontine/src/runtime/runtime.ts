import { PGlite } from '@electric-sql/pglite';
import { openLedger } from '../ledger/database';
import { seedIfEmpty } from '../tontine/seed';
import { createTontineService, type ServiceOptions, type TontineService } from '../tontine/service';

/*
 * The database lifecycle: open, seed, reset (design T6). The browser runtime
 * persists to IndexedDB and lets only one tab own the database; the memory
 * runtime is for tests.
 */

export interface Session {
  readonly service: TontineService;
  close(): Promise<void>;
}

export interface Runtime {
  open(): Promise<Session>;
  /** Deletes everything and starts again with the demo circle. */
  reset(current: Session | null): Promise<Session>;
}

/** Another tab already has the database open. */
export class OtherTabError extends Error {
  constructor() {
    super('The Tontine is already open in another tab. Close it there, then reload this page.');
    this.name = 'OtherTabError';
  }
}

async function start(client: PGlite, seed: boolean, options?: ServiceOptions): Promise<TontineService> {
  try {
    const service = await createTontineService(await openLedger(client), options);
    if (seed) await seedIfEmpty(service);
    return service;
  } catch (e) {
    await client.close().catch(() => undefined);
    throw e;
  }
}

export function memoryRuntime(options: { seed?: boolean; service?: ServiceOptions } = {}): Runtime {
  const seed = options.seed ?? true;
  const open = async (): Promise<Session> => {
    const client = new PGlite();
    const service = await start(client, seed, options.service);
    return { service, close: () => client.close() };
  };
  return {
    open,
    async reset(current) {
      await current?.close();
      return open();
    },
  };
}

export interface BrowserRuntimeOptions {
  name?: string;
  locks?: LockManager | null;
  indexedDB?: Pick<IDBFactory, 'deleteDatabase'>;
  /** Test hook: build the client for a data directory. */
  createClient?: (dataDir: string) => PGlite;
}

const LOCK_NAME = 'the-tontine-ledger';

/** Holds the Web Lock until `release` is called. Resolves to null when another tab holds it. */
function acquire(locks: LockManager, name: string): Promise<(() => void) | null> {
  return new Promise((resolve, reject) => {
    locks
      .request(name, { ifAvailable: true }, (lock) => {
        if (lock === null) {
          resolve(null);
          return undefined;
        }
        return new Promise<void>((release) => resolve(release));
      })
      .catch(reject);
  });
}

function deleteDatabase(idb: Pick<IDBFactory, 'deleteDatabase'>, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = idb.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error(`could not delete ${name}`));
    // Blocked means a connection is still open; PGlite was closed first, so it clears once that close lands.
    req.onblocked = () => undefined;
  });
}

export function browserRuntime(options: BrowserRuntimeOptions = {}): Runtime {
  const name = options.name ?? 'the-tontine';
  const locks = options.locks === undefined ? (globalThis.navigator?.locks ?? null) : options.locks;
  const createClient = options.createClient ?? ((dataDir: string) => new PGlite(dataDir));
  let release: (() => void) | null = null;

  const openClient = async (): Promise<Session> => {
    const client = createClient(`idb://${name}`);
    const service = await start(client, true);
    return { service, close: () => client.close() };
  };

  const ensureLock = async () => {
    if (locks && release === null) {
      release = await acquire(locks, LOCK_NAME);
      if (release === null) throw new OtherTabError();
    }
  };
  const releaseLock = () => {
    release?.();
    release = null;
  };

  return {
    async open() {
      await ensureLock();
      try {
        return await openClient();
      } catch (e) {
        releaseLock();
        throw e;
      }
    },
    async reset(current) {
      // The lock is held across the reset, so no other tab can open the database half-way.
      await ensureLock();
      try {
        await current?.close();
        // PGlite stores idb://<name> in the IndexedDB database "/pglite/<name>" (checked in Chromium).
        await deleteDatabase(options.indexedDB ?? globalThis.indexedDB, `/pglite/${name}`);
        return await openClient();
      } catch (e) {
        releaseLock();
        throw e;
      }
    },
  };
}
