/*
 * Browser start-up (design D8): take a Web Lock so only one tab opens the
 * IndexedDB database, then open it and the active jar. Pages that do not need
 * the jar (overlay, poltergeist) never call this.
 */
import type { Clock } from '@ossuary/core';
import { IDB_NAME, openDatabase, type AppDb } from './db';
import { openJar, resetJar, type TipJar } from './jar';
import type { OverlayBus } from './overlayBus';

export type Boot =
  | { kind: 'ready'; app: AppDb; jar: TipJar; reset(): Promise<TipJar> }
  | { kind: 'locked' }
  | { kind: 'error'; message: string };

export const LOCK_NAME = 'haunted-tip-jar-db';

export const wallClock: Clock = { now: () => Date.now() };

interface LockManagerLike {
  request(name: string, options: { ifAvailable: boolean }, cb: (lock: unknown) => Promise<unknown>): Promise<unknown>;
}

/**
 * Holds the lock for the life of the page. Resolves `locked` at once if
 * another tab has it. Browsers without Web Locks open the database directly.
 */
export function bootBrowser(bus: OverlayBus, options: { dataDir?: string } = {}): Promise<Boot> {
  const dataDir = options.dataDir ?? IDB_NAME;
  const open = async (): Promise<Boot> => {
    try {
      const app = await openDatabase({ dataDir });
      const opts = { clock: wallClock, bus };
      const jar = await openJar(app.db, opts);
      return { kind: 'ready', app, jar, reset: () => resetJar(app.db, opts) };
    } catch (e) {
      return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
    }
  };
  const locks = (globalThis.navigator as { locks?: LockManagerLike } | undefined)?.locks;
  if (!locks) return open();
  return new Promise<Boot>((resolve) => {
    void locks.request(LOCK_NAME, { ifAvailable: true }, async (lock) => {
      if (!lock) {
        resolve({ kind: 'locked' });
        return;
      }
      resolve(await open());
      // Keep the lock until the page goes away.
      await new Promise<never>(() => {});
    });
  });
}
