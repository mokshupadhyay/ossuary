import { PGlite } from '@electric-sql/pglite';
import { FAULT_IDS } from '@ossuary/core/poltergeist';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openLedger } from '../../src/ledger/database';
import { runSeance, SeanceInputError, type SeanceResult } from '../../src/tontine/seance';
import { seedDemoCircle } from '../../src/tontine/seed';
import { createTontineService, type TontineService } from '../../src/tontine/service';

let client: PGlite;
let svc: TontineService;
let circleId: string;
let result: SeanceResult;
const phases: string[] = [];

beforeAll(async () => {
  client = new PGlite();
  svc = await createTontineService(await openLedger(client));
  circleId = await seedDemoCircle(svc);
  result = await runSeance(svc, circleId, { seed: 7, size: 200, onPhase: (p) => phases.push(p) });
});
afterAll(() => client.close());

describe('runSeance (seed 7, 200 events)', () => {
  it('runs both targets on the same storm, in order', () => {
    expect(phases).toEqual(['ossuary', 'twin', 'books']);
    expect(result.ossuary.target).toBe('ossuary');
    expect(result.twin.target).toBe('twin');
    expect(result.ossuary.seed).toBe(7);
    expect(result.twin.size).toBe(200);
    expect(result.ossuary.events.planned).toBe(200);
  });

  it('Ossuary, on the circle’s own database, does not drift and blocks a ghost of every fault', () => {
    expect(result.ossuary.drift.total).toBe('0');
    expect(result.ossuary.drift.conjured).toBe('0');
    expect(result.ossuary.drift.lost).toBe('0');
    expect(result.ossuary.drifted).toEqual([]);
    expect(new Set(result.ossuary.blocked.map((g) => g.faultId))).toEqual(new Set(FAULT_IDS));
    expect(result.ossuary.blocked.every((g) => g.epitaph.length > 0)).toBe(true);
  });

  it('the Vibe Pay twin visibly drifts', () => {
    expect(result.twin.drift.total).not.toBe('0');
    expect(result.twin.drifted.length).toBeGreaterThan(0);
  });

  it("leaves the circle's books exactly as they were, and the whole ledger at zero", async () => {
    expect(result.books.circleName).toBe('The Midnight Circle');
    expect(result.books.unchanged).toBe(true);
    expect(result.books.after).toEqual(result.books.before);
    expect(result.books.ledgerSum).toBe(0n);
    // The storm really ran on this database: its accounts and events are here.
    const n = (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM accounts WHERE name LIKE 'poltergeist %'`)).rows[0]!.n;
    expect(n).toBeGreaterThan(0);
    // And the circle still works afterwards.
    await svc.contribute(circleId, 2, 3);
    await svc.contribute(circleId, 2, 4);
    await svc.payout(circleId, 2);
    expect((await svc.view(circleId)).currentRound).toBe(3);
  });

  it('rejects a bad seed or size before running anything', async () => {
    await expect(runSeance(svc, circleId, { seed: -1, size: 200 })).rejects.toBeInstanceOf(SeanceInputError);
    await expect(runSeance(svc, circleId, { seed: 1.5, size: 200 })).rejects.toBeInstanceOf(SeanceInputError);
    await expect(runSeance(svc, circleId, { seed: 1, size: 300 as 200 })).rejects.toBeInstanceOf(SeanceInputError);
  });
});
