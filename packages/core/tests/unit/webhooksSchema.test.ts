import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { createTestDb, type TestDbHandle } from '../helpers/createTestDb.js';

let handle: TestDbHandle;
let db: Db;

beforeAll(async () => {
  handle = await createTestDb();
  db = handle.db as unknown as Db;
});
afterAll(async () => {
  await handle.close();
});

const rows = async (q: ReturnType<typeof sql>) =>
  (await db.execute(q)).rows as Record<string, unknown>[];

const constraints = (table: string, type: 'u' | 'p' | 'f') =>
  rows(sql`
    SELECT c.conname, pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = ${table} AND c.contype = ${type}`);

const insertEvent = (eventId: string, status = 'applied') =>
  db.execute(sql`
    INSERT INTO webhook_events (event_id, type, payment_id, asset, raw_body, status)
    VALUES (${eventId}, 'payment.pending', ${randomUUID()}, 'USDC', '{}', ${status}::webhook_event_status)`);

describe('webhook schema (live catalogs)', () => {
  it('webhook_events.event_id is unique', async () => {
    const pk = await constraints('webhook_events', 'p');
    expect(pk.map((r) => r['def'])).toContain('PRIMARY KEY (event_id)');
    const id = `evt-${randomUUID()}`;
    await insertEvent(id);
    await expect(insertEvent(id)).rejects.toThrow();
  });

  it('payment_states has a primary key on payment_id', async () => {
    const pk = await constraints('payment_states', 'p');
    expect(pk.map((r) => r['def'])).toEqual(['PRIMARY KEY (payment_id)']);
  });

  it('outbox_messages.idempotency_key is unique', async () => {
    const u = await constraints('outbox_messages', 'u');
    expect(u.map((r) => r['def'])).toContain('UNIQUE (idempotency_key)');
  });

  it('outbox_due_idx is on (status, next_attempt_at)', async () => {
    const [idx] = await rows(sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'outbox_due_idx'`);
    expect(idx!['indexdef']).toMatch(/\(status, next_attempt_at\)/);
  });

  it('the parked index is partial on status = parked', async () => {
    const [idx] = await rows(
      sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'webhook_events_parked_idx'`,
    );
    expect(idx!['indexdef']).toMatch(/\(payment_id, received_seq\)/);
    expect(idx!['indexdef']).toMatch(/WHERE \(status = 'parked'::webhook_event_status\)/);
  });

  it('has the expected foreign keys', async () => {
    const out = await constraints('outbox_messages', 'f');
    expect(out.map((r) => r['def'])).toContain('FOREIGN KEY (event_id) REFERENCES webhook_events(event_id)');
    const ev = await constraints('webhook_events', 'f');
    expect(ev.map((r) => r['def'])).toContain(
      'FOREIGN KEY (ledger_transaction_id) REFERENCES transactions(id)',
    );
    const ps = await constraints('payment_states', 'f');
    expect(ps.map((r) => r['def'])).toContain(
      'FOREIGN KEY (captured_event_id) REFERENCES webhook_events(event_id)',
    );
  });

  it('enums have exactly the listed values', async () => {
    const labels = async (name: string) =>
      (
        await rows(sql`
          SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
          WHERE t.typname = ${name} ORDER BY e.enumsortorder`)
      ).map((r) => r['enumlabel']);
    expect(await labels('webhook_event_status')).toEqual(['applied', 'parked', 'ignored', 'rejected']);
    expect(await labels('payment_status')).toEqual(['pending', 'captured', 'refunded']);
    expect(await labels('outbox_status')).toEqual(['pending', 'sent', 'dead']);
  });

  it('every enum rejects values outside its list', async () => {
    await expect(insertEvent(`evt-${randomUUID()}`, 'bogus')).rejects.toThrow();
    await expect(
      db.execute(sql`INSERT INTO payment_states (payment_id, status) VALUES (${randomUUID()}, 'bogus')`),
    ).rejects.toThrow();
    const evId = `evt-${randomUUID()}`;
    await insertEvent(evId);
    await expect(
      db.execute(sql`
        INSERT INTO outbox_messages (id, idempotency_key, event_id, topic, payload, status, next_attempt_at)
        VALUES (${randomUUID()}, ${randomUUID()}, ${evId}, 't', '{}', 'bogus', now())`),
    ).rejects.toThrow();
  });

  it('no new column is named like balance or total', async () => {
    const cols = await rows(sql`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('webhook_events', 'payment_states', 'outbox_messages')
        AND (column_name ILIKE '%balance%' OR column_name ILIKE '%total%')`);
    expect(cols).toEqual([]);
  });
});
