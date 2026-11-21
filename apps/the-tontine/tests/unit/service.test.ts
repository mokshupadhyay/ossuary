import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openLedger } from '../../src/ledger/database';
import { createTontineService, type TontineService } from '../../src/tontine/service';
import { TontineError, type TontineErrorCode } from '../../src/tontine/types';

const C = 50_000_000n; // 50 USDC
let client: PGlite;
let svc: TontineService;

beforeAll(async () => {
  client = new PGlite();
  svc = await createTontineService(await openLedger(client));
});
afterAll(() => client.close());

const rejects = (p: Promise<unknown>, code: TontineErrorCode) =>
  expect(p).rejects.toSatisfy((e) => e instanceof TontineError && e.code === code);

const count = async (sql: string, params: unknown[] = []) => (await client.query<{ n: number }>(sql, params)).rows[0]!.n;
const totals = async () => ({
  tx: await count('SELECT count(*)::int AS n FROM transactions'),
  entries: await count('SELECT count(*)::int AS n FROM entries'),
});

async function circle(names = ['Asha', 'Kwame', 'Lupe']) {
  return svc.createCircle({ name: 'Test circle', members: names, contribution: C });
}
async function payRound(id: string, round: number, n: number) {
  for (let p = 0; p < n; p++) await svc.contribute(id, round, p);
}

describe('createCircle', () => {
  it.each([
    [{ name: '  ', members: ['a', 'b'], contribution: C }, 'name'],
    [{ name: 'x'.repeat(61), members: ['a', 'b'], contribution: C }, 'name'],
    [{ name: 'ok', members: ['a'], contribution: C }, 'members'],
    [{ name: 'ok', members: Array.from({ length: 13 }, (_, i) => `m${i}`), contribution: C }, 'members'],
    [{ name: 'ok', members: ['a', ' '], contribution: C }, 'member-1'],
    [{ name: 'ok', members: ['Asha', 'asha'], contribution: C }, 'member-1'],
    [{ name: 'ok', members: ['a', 'b'.repeat(41)], contribution: C }, 'member-1'],
    [{ name: 'ok', members: ['a', 'b'], contribution: 0n }, 'contribution'],
    [{ name: 'ok', members: ['a', 'b'], contribution: 1_000_000_000_001n }, 'contribution'],
  ])('rejects invalid input %#, naming the field, and creates nothing', async (input, field) => {
    const before = await count('SELECT count(*)::int AS n FROM accounts');
    await expect(svc.createCircle(input)).rejects.toSatisfy((e) => e instanceof TontineError && e.code === 'invalid-input' && e.field === field);
    expect(await count('SELECT count(*)::int AS n FROM accounts')).toBe(before);
  });

  it('creates the accounts, mints a key per due and per round, and starts at round 1', async () => {
    const id = await svc.createCircle({ name: '  The Lantern Circle ', members: [' Asha', 'Kwame ', 'Lupe', 'Mateo'], contribution: C });
    expect(await count('SELECT count(*)::int AS n FROM tontine_dues WHERE circle_id = $1', [id])).toBe(16);
    expect(await count('SELECT count(DISTINCT idempotency_key)::int AS n FROM tontine_dues WHERE circle_id = $1', [id])).toBe(16);
    expect(await count('SELECT count(*)::int AS n FROM tontine_rounds WHERE circle_id = $1', [id])).toBe(4);
    const v = await svc.view(id);
    expect(v.name).toBe('The Lantern Circle');
    expect(v.members.map((m) => m.name)).toEqual(['Asha', 'Kwame', 'Lupe', 'Mateo']);
    expect(v.rounds).toBe(4);
    expect(v.currentRound).toBe(1);
    expect(v.recipientPosition).toBe(0);
    expect(v.potPerRound).toBe(4n * C);
    expect(v.pot).toBe(0n);
    expect(v.members.every((m) => m.due?.status === 'owes')).toBe(true);
    expect(v.waitingFor).toEqual(['Asha', 'Kwame', 'Lupe', 'Mateo']);
    const types = await client.query<{ type: string; allow_overdraft: boolean }>(
      'SELECT type, allow_overdraft FROM accounts WHERE account_id = ANY($1::uuid[]) ORDER BY type',
      [[v.accounts.clearing, v.accounts.pot, ...v.members.map((m) => m.walletAccountId)]],
    );
    expect(types.rows.map((r) => `${r.type}:${r.allow_overdraft}`)).toEqual([
      'asset:true',
      'liability:false',
      'liability:false',
      'liability:false',
      'liability:false',
      'revenue:false',
    ]);
    expect((await svc.listCircles()).map((c) => c.circleId)).toContain(id);
  });
});

describe('contribute', () => {
  it('fills the pot through the rail, records a receipt, and a repeat is a duplicate', async () => {
    const id = await circle();
    expect(await svc.contribute(id, 1, 1)).toEqual({ outcome: 'applied' });
    const t = await totals();
    expect(await svc.contribute(id, 1, 1)).toEqual({ outcome: 'duplicate' });
    const both = await Promise.all([svc.contribute(id, 1, 1), svc.contribute(id, 1, 1)]);
    expect(both).toEqual([{ outcome: 'duplicate' }, { outcome: 'duplicate' }]);
    expect(await totals()).toEqual(t);
    const v = await svc.view(id);
    expect(v.pot).toBe(C);
    expect(v.moneyIn).toBe(C);
    expect(v.members[1]!.due?.status).toBe('paid');
    expect(v.paidThisRound).toBe(1);
    const c = v.timeline.find((e) => e.kind === 'contribution');
    expect(c?.kind === 'contribution' && c.receipt).toBe(true);
  });

  it('a double-tap on a fresh due records one capture', async () => {
    const id = await circle();
    const t = await totals();
    const r = await Promise.all([svc.contribute(id, 1, 2), svc.contribute(id, 1, 2), svc.contribute(id, 1, 2)]);
    expect(r.map((x) => x.outcome).sort()).toEqual(['applied', 'duplicate', 'duplicate']);
    expect((await totals()).tx).toBe(t.tx + 1);
    expect(await count('SELECT count(*)::int AS n FROM tontine_receipts r JOIN tontine_dues d ON d.payment_id = r.payment_id WHERE d.circle_id = $1', [id])).toBe(1);
  });

  it('rejects a future round, an unknown member and an unknown circle, moving nothing', async () => {
    const id = await circle();
    const t = await totals();
    await rejects(svc.contribute(id, 2, 0), 'not-current-round');
    await rejects(svc.contribute(id, 0, 0), 'not-current-round');
    await rejects(svc.contribute(id, 1, 3), 'unknown-member');
    await rejects(svc.contribute(id, 1, 0.5), 'unknown-member');
    await rejects(svc.contribute(crypto.randomUUID(), 1, 0), 'unknown-circle');
    await rejects(svc.contribute('not-a-uuid', 1, 0), 'unknown-circle');
    expect(await totals()).toEqual(t);
  });
});

describe('markMissed', () => {
  it('marks an unpaid due late, once, and the member can still pay late', async () => {
    const id = await circle();
    const t = await totals();
    expect(await svc.markMissed(id, 1, 0)).toEqual({ changed: true });
    expect(await svc.markMissed(id, 1, 0)).toEqual({ changed: false });
    expect(await totals()).toEqual(t);
    expect((await svc.view(id)).members[0]!.due?.status).toBe('late');
    await svc.contribute(id, 1, 0);
    const v = await svc.view(id);
    expect(v.members[0]!.due?.status).toBe('paid-late');
    expect(v.timeline.map((e) => e.kind)).toEqual(['contribution', 'missed']);
  });

  it('refuses a paid due and another round', async () => {
    const id = await circle();
    await svc.contribute(id, 1, 0);
    await rejects(svc.markMissed(id, 1, 0), 'already-paid');
    await rejects(svc.markMissed(id, 2, 1), 'not-current-round');
  });
});

describe('payout', () => {
  it('waits while anyone owes, naming them, and moves nothing', async () => {
    const id = await circle();
    await svc.contribute(id, 1, 0);
    const t = await totals();
    await expect(svc.payout(id, 1)).rejects.toSatisfy(
      (e) => e instanceof TontineError && e.code === 'dues-unpaid' && /Kwame, Lupe/.test(e.message),
    );
    await rejects(svc.payout(id, 2), 'not-current-round');
    expect(await totals()).toEqual(t);
  });

  it("pays the round's recipient once, advances the round, and a repeat returns the same transaction", async () => {
    const id = await circle();
    await payRound(id, 1, 3);
    const first = await svc.payout(id, 1);
    expect(first.replayed).toBe(false);
    const t = await totals();
    const again = await svc.payout(id, 1);
    expect(again).toEqual({ transactionId: first.transactionId, replayed: true });
    expect(await totals()).toEqual(t);
    const v = await svc.view(id);
    expect(v.currentRound).toBe(2);
    expect(v.recipientPosition).toBe(1);
    expect(v.pot).toBe(0n);
    expect(v.members.map((m) => m.wallet)).toEqual([3n * C, 0n, 0n]);
    expect(v.members[0]!.receivedRound).toBe(1);
    // Repeating a recorded contribution of a closed round is still a harmless duplicate.
    expect(await svc.contribute(id, 1, 2)).toEqual({ outcome: 'duplicate' });
    expect(await totals()).toEqual(t);
    await rejects(svc.contribute(id, 3, 0), 'not-current-round');
  });

  it('a concurrent double-tap payout makes exactly one transfer', async () => {
    const id = await circle();
    await payRound(id, 1, 3);
    const r = await Promise.all([svc.payout(id, 1), svc.payout(id, 1), svc.payout(id, 1)]);
    expect(new Set(r.map((x) => x.transactionId)).size).toBe(1);
    const v = await svc.view(id);
    expect(v.timeline.filter((e) => e.kind === 'payout')).toHaveLength(1);
    expect(v.members[0]!.wallet).toBe(3n * C);
  });

  it('runs a whole circle to completion: everyone paid once, pot empty, books balanced', async () => {
    const id = await circle(['Asha', 'Kwame', 'Lupe', 'Mateo']);
    for (let round = 1; round <= 4; round++) {
      await payRound(id, round, 4);
      await svc.payout(id, round);
    }
    const v = await svc.view(id);
    expect(v.complete).toBe(true);
    expect(v.currentRound).toBeNull();
    expect(v.pot).toBe(0n);
    expect(v.members.map((m) => m.receivedRound)).toEqual([1, 2, 3, 4]);
    expect(v.members.every((m) => m.wallet === 4n * C && m.due === null)).toBe(true);
    expect(v.moneyIn).toBe(16n * C);
    expect(v.moneyOut).toBe(16n * C);
    expect(v.ledgerSum).toBe(0n);
    expect(await svc.ledgerSum()).toBe(0n);
    await rejects(svc.contribute(id, 5, 0), 'circle-complete');
    await rejects(svc.markMissed(id, 4, 0), 'circle-complete');
    await rejects(svc.payout(id, 5), 'circle-complete');
  });
});

describe('view timeline', () => {
  it('lists contributions, payouts and missed marks newest first, with both keys and the entries', async () => {
    const id = await circle(['Asha', 'Kwame']);
    await svc.markMissed(id, 1, 1);
    await svc.contribute(id, 1, 0);
    await svc.contribute(id, 1, 1);
    await svc.payout(id, 1);
    const v = await svc.view(id);
    expect(v.timeline.map((e) => `${e.kind}:${e.memberName}`)).toEqual(['payout:Asha', 'contribution:Kwame', 'contribution:Asha', 'missed:Kwame']);
    const [payout, lateContribution] = v.timeline;
    if (payout?.kind !== 'payout' || lateContribution?.kind !== 'contribution') throw new Error('unexpected timeline');
    expect(payout.amount).toBe(2n * C);
    expect(payout.clientKey).toBe(payout.ledgerKey);
    expect(payout.entries.map((e) => `${e.account} ${e.amount}`)).toEqual([`Pot ${2n * C}`, `Wallet · Asha ${-2n * C}`]);
    expect(lateContribution.late).toBe(true);
    expect(lateContribution.receipt).toBe(true);
    expect(lateContribution.eventId).toBe(`due:${lateContribution.clientKey}`);
    expect(lateContribution.ledgerKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(lateContribution.ledgerKey).not.toBe(lateContribution.clientKey);
    expect(lateContribution.entries.map((e) => `${e.account} ${e.amount}`)).toEqual([`Clearing ${C}`, `Pot ${-C}`]);
  });
});
