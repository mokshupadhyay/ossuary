import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openLedger } from '../../src/ledger/database';
import { DEMO_CIRCLE, seedDemoCircle, seedIfEmpty } from '../../src/tontine/seed';
import { createTontineService, type TontineService } from '../../src/tontine/service';

let client: PGlite;
let svc: TontineService;
beforeAll(async () => {
  client = new PGlite();
  svc = await createTontineService(await openLedger(client));
});
afterAll(() => client.close());

describe('demo circle', () => {
  it('is round 2 of The Midnight Circle: Asha paid out, Mateo late, Nkechi owing', async () => {
    const id = await seedDemoCircle(svc);
    const v = await svc.view(id);
    expect(v.name).toBe('The Midnight Circle');
    expect(v.members.map((m) => m.name)).toEqual(DEMO_CIRCLE.members);
    expect(v.contribution).toBe(50_000_000n);
    expect(v.currentRound).toBe(2);
    expect(v.recipientPosition).toBe(1);
    expect(v.members.map((m) => m.due?.status)).toEqual(['paid', 'paid', 'paid', 'late', 'owes']);
    expect(v.members[0]!.receivedRound).toBe(1);
    expect(v.members[0]!.wallet).toBe(250_000_000n);
    expect(v.pot).toBe(150_000_000n);
    expect(v.moneyIn).toBe(400_000_000n);
    expect(v.moneyOut).toBe(250_000_000n);
    expect(v.ledgerSum).toBe(0n);
    expect(v.waitingFor).toEqual(['Mateo', 'Nkechi']);
    expect(v.timeline.filter((e) => e.kind === 'contribution')).toHaveLength(8);
    expect(v.timeline.filter((e) => e.kind === 'payout')).toHaveLength(1);
    expect(v.timeline.filter((e) => e.kind === 'missed')).toHaveLength(1);
  });

  it('seedIfEmpty seeds nothing when a circle exists', async () => {
    const before = await svc.listCircles();
    expect(before.length).toBeGreaterThan(0);
    await seedIfEmpty(svc);
    expect(await svc.listCircles()).toEqual(before);
  });
});
