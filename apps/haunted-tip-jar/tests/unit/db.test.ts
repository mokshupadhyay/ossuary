import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateApp, openDatabase, type AppDb } from '../../src/db';

let app: AppDb;
beforeAll(async () => {
  app = await openDatabase();
});
afterAll(async () => {
  await app.close();
});

describe('db', () => {
  it('creates core tables and the app tables', async () => {
    const r = await app.db.execute(sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
    const names = r.rows.map((x) => x['table_name']);
    for (const t of ['accounts', 'entries', 'webhook_events', 'outbox_messages', 'tipjar_jars', 'tipjar_tips', 'tipjar_rail_requests', 'tipjar_deliveries']) {
      expect(names).toContain(t);
    }
  });

  it('migrating twice is a no-op', async () => {
    await migrateApp(app.db);
    await migrateApp(app.db);
  });

  it('no app column stores a balance or a total', async () => {
    const r = await app.db.execute(
      sql`SELECT table_name, column_name FROM information_schema.columns WHERE table_name LIKE 'tipjar_%'`,
    );
    const cols = r.rows.map((x) => String(x['column_name']));
    expect(cols.length).toBeGreaterThan(10);
    for (const c of cols) expect(c).not.toMatch(/balance|total|held|amount|sum/);
  });
});
