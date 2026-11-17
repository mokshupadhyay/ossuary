import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import * as schema from '../../src/schema/index.js';

export type TestDb = ReturnType<typeof drizzle<typeof schema>>;

export interface TestDbHandle {
  db: TestDb;
  client: PGlite;
  close: () => Promise<void>;
}

const migrationsFolder = fileURLToPath(
  new URL('../../src/migrations', import.meta.url),
);

/** Creates an independent in-memory Postgres with all migrations applied. */
export async function createTestDb(): Promise<TestDbHandle> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });
  return { db, client, close: () => client.close() };
}
