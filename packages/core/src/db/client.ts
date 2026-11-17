import { Pool } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from 'drizzle-orm/pg-core';
import * as schema from '../schema/index.js';

type Schema = typeof schema;

/** Both drivers return `{ rows }` from `execute`; this exposes it in the type. */
export interface RowsQueryResultHKT extends PgQueryResultHKT {
  type: { rows: Record<string, unknown>[] };
}

/**
 * Driver-agnostic database handle. Both the Neon (serverless Pool) and pglite
 * drizzle instances satisfy it, so business logic accepts either by injection.
 */
export type Db = PgDatabase<RowsQueryResultHKT, Schema>;

/** Handle passed to the callback of `db.transaction(...)`. */
export type Tx = PgTransaction<
  RowsQueryResultHKT,
  Schema,
  ExtractTablesWithRelations<Schema>
>;

/**
 * Builds a Drizzle `Db` backed by a Neon serverless Pool (supports interactive
 * transactions). The Pool connects lazily, so no network I/O happens here.
 * The caller supplies the connection string; no env vars are read.
 */
export function createDb(connectionString: string): Db {
  if (typeof connectionString !== 'string' || connectionString.trim() === '') {
    throw new TypeError('createDb requires a non-empty connection string');
  }
  const pool = new Pool({ connectionString });
  return drizzle(pool, { schema }) as unknown as Db;
}
