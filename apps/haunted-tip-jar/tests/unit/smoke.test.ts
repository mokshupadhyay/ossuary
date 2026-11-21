import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { createAccount, balance, type Db } from '@ossuary/core';
import { applyEmbeddedMigrations } from '@ossuary/core/poltergeist';

describe('core runs from the app', () => {
  it('migrates an in-memory PGlite and reads a zero balance', async () => {
    const client = new PGlite();
    const db = drizzle(client) as unknown as Db;
    await applyEmbeddedMigrations(db);
    const id = globalThis.crypto.randomUUID();
    await createAccount(db, { accountId: id, name: 'jar', type: 'revenue' });
    expect(await balance(db, id)).toBe(0n);
    await client.close();
  });
});
