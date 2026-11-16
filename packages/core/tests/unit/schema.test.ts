import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { accounts, entries, idempotencyRecords, transactions } from '../../src/schema/index.js';

const tables = [accounts, transactions, entries, idempotencyRecords];

describe('schema', () => {
  it('has no balance or total column on any table', () => {
    for (const t of tables) {
      const { name, columns } = getTableConfig(t);
      for (const c of columns) {
        expect(c.name, `${name}.${c.name}`).not.toMatch(/balance|total/i);
      }
    }
  });

  it('entries.amount is the only bigint column', () => {
    const bigints: string[] = [];
    for (const t of tables) {
      const { name, columns } = getTableConfig(t);
      for (const c of columns) {
        if (c.getSQLType() === 'bigint') bigints.push(`${name}.${c.name}`);
      }
    }
    expect(bigints).toEqual(['entries.amount']);
  });

  it('has a unique index on idempotency_records(key)', () => {
    const { indexes } = getTableConfig(idempotencyRecords);
    const idx = indexes.find((i) => i.config.name === 'idempotency_records_key_idx');
    expect(idx).toBeDefined();
    expect(idx!.config.unique).toBe(true);
    expect(idx!.config.columns.map((c) => (c as { name: string }).name)).toEqual(['key']);
  });

  it('links transactions.idempotency_key (nullable) and entries FKs', () => {
    const tx = getTableConfig(transactions);
    expect(tx.columns.find((c) => c.name === 'idempotency_key')!.notNull).toBe(false);
    expect(tx.columns.find((c) => c.name === 'payment_id')!.notNull).toBe(false);
    expect(tx.columns.find((c) => c.name === 'kind')!.notNull).toBe(true);
    expect(tx.foreignKeys).toHaveLength(1);
    expect(getTableConfig(entries).foreignKeys).toHaveLength(2);
  });
});
