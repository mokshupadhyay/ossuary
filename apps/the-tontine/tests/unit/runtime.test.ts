import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { browserRuntime, memoryRuntime, OtherTabError } from '../../src/runtime/runtime';

/** A LockManager with the Web Locks semantics the runtime relies on: exclusive, `ifAvailable`, held until the callback's promise settles. */
function fakeLocks() {
  const held = new Set<string>();
  const locks = {
    async request(name: string, options: { ifAvailable?: boolean }, cb: (lock: { name: string } | null) => unknown) {
      if (held.has(name)) {
        if (!options.ifAvailable) throw new Error('fake supports ifAvailable only');
        return cb(null);
      }
      held.add(name);
      try {
        return await cb({ name });
      } finally {
        held.delete(name);
      }
    },
    query: async () => ({ held: [...held].map((name) => ({ name })), pending: [] }),
  };
  return { locks: locks as unknown as LockManager, held };
}

function fakeIndexedDB() {
  const deleted: string[] = [];
  return {
    deleted,
    idb: {
      deleteDatabase(name: string) {
        deleted.push(name);
        const req = {} as IDBOpenDBRequest;
        queueMicrotask(() => req.onsuccess?.(new Event('success')));
        return req;
      },
    },
  };
}

describe('memoryRuntime', () => {
  it('opens a seeded database, and reset starts again from the demo circle', async () => {
    const rt = memoryRuntime();
    const s = await rt.open();
    const [c] = await s.service.listCircles();
    await s.service.contribute(c!.circleId, 2, 4);
    const r = await rt.reset(s);
    const circles = await r.service.listCircles();
    expect(circles).toHaveLength(1);
    expect((await r.service.view(circles[0]!.circleId)).members[4]!.due?.status).toBe('owes');
    await r.close();
  });

  it('can open empty', async () => {
    const s = await memoryRuntime({ seed: false }).open();
    expect(await s.service.listCircles()).toEqual([]);
    await s.close();
  });
});

describe('browserRuntime', () => {
  it('lets only one tab own the database, and frees it when that tab cannot open', async () => {
    const { locks, held } = fakeLocks();
    const clients: string[] = [];
    const createClient = (dir: string) => {
      clients.push(dir);
      return new PGlite();
    };
    const tabA = browserRuntime({ locks, createClient });
    const tabB = browserRuntime({ locks, createClient });
    const a = await tabA.open();
    expect(clients).toEqual(['idb://the-tontine']);
    expect(held.has('the-tontine-ledger')).toBe(true);
    await expect(tabB.open()).rejects.toBeInstanceOf(OtherTabError);
    expect(clients).toHaveLength(1);
    await a.close();

    const broken = browserRuntime({
      locks: fakeLocks().locks,
      createClient: () => {
        throw new Error('no IndexedDB');
      },
    });
    await expect(broken.open()).rejects.toThrow('no IndexedDB');
  });

  it('reset closes the client, deletes /pglite/<name>, and reopens seeded', async () => {
    const { locks } = fakeLocks();
    const { idb, deleted } = fakeIndexedDB();
    const rt = browserRuntime({ locks, indexedDB: idb, createClient: () => new PGlite() });
    const s = await rt.open();
    const r = await rt.reset(s);
    expect(deleted).toEqual(['/pglite/the-tontine']);
    expect(s.service.ledger.client.closed).toBe(true);
    expect(await r.service.listCircles()).toHaveLength(1);
    await r.close();
  });

  it('works where Web Locks are missing', async () => {
    const s = await browserRuntime({ locks: null, createClient: () => new PGlite() }).open();
    expect(await s.service.listCircles()).toHaveLength(1);
    await s.close();
  });
});
