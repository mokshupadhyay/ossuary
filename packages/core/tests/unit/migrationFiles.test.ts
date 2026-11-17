import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dir = new URL('../../src/migrations/', import.meta.url);

describe('migration files', () => {
  it('journal lists five migrations in order, ending with the append-only trigger', () => {
    const journal = JSON.parse(readFileSync(new URL('meta/_journal.json', dir), 'utf8'));
    const tags = journal.entries.map((e: { tag: string }) => e.tag);
    expect(tags).toHaveLength(5);
    expect(tags[4]).toBe('0004_append_only_trigger');
  });

  it('0004 installs a BEFORE UPDATE OR DELETE trigger on entries', () => {
    const sql = readFileSync(new URL('0004_append_only_trigger.sql', dir), 'utf8');
    expect(sql).toMatch(/BEFORE UPDATE OR DELETE ON\s+entries/);
    expect(sql).toContain('append-only');
  });
});
