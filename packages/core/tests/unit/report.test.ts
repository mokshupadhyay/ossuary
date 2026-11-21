import { describe, expect, it } from 'vitest';
import { emptyTruth, measureDrift, ZERO_DELTA, type DriftDelta } from '../../src/poltergeist/drift.js';
import { FAULT_IDS } from '../../src/poltergeist/faults.js';
import {
  buildReport,
  REPORT_SCHEMA,
  REPORT_VERSION,
  serializeReport,
  type RunRecord,
} from '../../src/poltergeist/report.js';
import { generateStorm, MEMBERS } from '../../src/poltergeist/storm.js';

const delta = (pot: bigint, m1 = 0n): DriftDelta => ({
  accounts: [{ account: 'pot', drift: pot }, { account: 'member:m1', drift: m1 }],
  total: pot + m1,
});

function record(): RunRecord {
  const storm = generateStorm({ seed: 11, size: 40, ensureEveryFault: true });
  const units = storm.units.map((unit, i) => ({
    unit,
    delta: i === 0 ? delta(-500n) : i === 4 ? delta(0n, -40n) : ZERO_DELTA,
    defenses: i === 1 ? (['timestamp-check'] as const) : [],
  }));
  const final = measureDrift(emptyTruth('USDC'), { asset: 'USDC', pot: 500n, members: new Map([['m1', 40n]]) });
  return {
    storm,
    target: 'twin',
    events: { attempts: 45, retries: 3, crashes: 1 },
    units,
    final,
    settle: ZERO_DELTA,
    fractional: [],
    counterexample: { kind: 'isolated', unit: storm.units[0]!, drift: delta(-500n) },
  };
}

describe('buildReport / serializeReport', () => {
  it('uses the declared key order and canonical account order', () => {
    const r = buildReport(record());
    expect(Object.keys(r)).toEqual([
      'schema', 'version', 'generator', 'seed', 'size', 'ensureEveryFault', 'target', 'asset', 'decimals',
      'events', 'faults', 'honest', 'drift', 'settleDrift', 'fractionalBalances', 'blocked', 'drifted', 'counterexample',
    ]);
    expect(r.schema).toBe(REPORT_SCHEMA);
    expect(r.version).toBe(REPORT_VERSION);
    expect(REPORT_VERSION).toBe(1);
    expect(r.drift.accounts.map((a) => a.account)).toEqual(['pot', ...MEMBERS.map((m) => `member:${m}`)]);
    expect(r.faults.map((f) => f.id)).toEqual(FAULT_IDS);
    expect(Object.keys(r.faults[0]!)).toEqual(['id', 'name', 'ghosts', 'deliveries', 'blocked', 'drifted', 'drift']);
  });

  it('writes every amount as a decimal string', () => {
    const json = serializeReport(buildReport(record()));
    expect(json).not.toMatch(/"(total|drift|conjured|lost|amount|captured|refunded|value)":-?\d/);
    const r = JSON.parse(json);
    expect(r.drift.total).toBe('-540');
    expect(r.drift.conjured).toBe('540');
    expect(r.drift.doubleCreditedMembers).toBe(1);
  });

  it('classifies ghosts by their delta and adds up the per-fault counts', () => {
    const run = record();
    const r = buildReport(run);
    const ghosts = run.units.filter((u) => u.unit.kind === 'ghost');
    expect(r.blocked.length + r.drifted.length).toBe(ghosts.length);
    expect(r.drifted.map((d) => d.ghostId)).toEqual([run.units[0]!.unit.unitId, run.units[4]!.unit.unitId]);
    expect(r.drifted[0]!.faultId).toBe('duplicate-delivery');
    for (const f of r.faults) expect(f.blocked + f.drifted).toBe(f.ghosts);
    expect(r.faults.reduce((n, f) => n + f.ghosts, 0) + r.honest.units).toBe(run.units.length);
    expect(r.events.planned).toBe(40);
    expect(r.faults[0]!.drift.total).toBe('-500');
    const replay = r.blocked.find((b) => b.faultId === 'replayed-timestamp')!;
    expect(replay.epitaph).toMatch(/replayed webhook, buried by timestamp check$/);
    expect(r.blocked.filter((b) => b.faultId !== 'replayed-timestamp').every((b) => b.epitaph.endsWith('passed without drift'))).toBe(true);
  });

  it('contains no run tag, secret, UUID or wall-clock time', () => {
    const json = serializeReport(buildReport(record()));
    expect(json).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    expect(json).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/);
    expect(json).not.toContain('~');
  });

  it('serializes identically twice, and includes a prefix counterexample shape', () => {
    const run = record();
    expect(serializeReport(buildReport(run))).toBe(serializeReport(buildReport(run)));
    const prefix = buildReport({ ...run, counterexample: { kind: 'prefix', unit: run.storm.units[2]!, deliveries: 7, drift: delta(1n) } });
    expect(prefix.counterexample).toEqual({
      kind: 'prefix',
      unitId: run.storm.units[2]!.unitId,
      faultId: 'out-of-order',
      seed: 11,
      size: 40,
      ensureEveryFault: true,
      deliveries: 7,
      drift: expect.objectContaining({ total: '1' }),
    });
    expect(buildReport({ ...run, counterexample: null }).counterexample).toBeNull();
  });
});
