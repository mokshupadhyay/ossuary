// poltergeist-engine Requirement 10.4: the generated Vibe Pay twin is real and runnable.
// It is tested here, not edited: packages/twin/src is the agent's unedited output.
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createVibePay } from '@ossuary/twin';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let pg: PGlite;
beforeAll(async () => {
  pg = new PGlite();
});
afterAll(async () => {
  await pg.close();
});

const post = (body: unknown) =>
  new Request('http://twin.local/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

function circle() {
  const circleId = randomUUID();
  const members = [randomUUID(), randomUUID()];
  const event = (type: string, paymentId: string, amount: string, memberId = members[0]!) => ({
    id: `evt_${randomUUID()}`,
    type,
    paymentId,
    circleId,
    memberId,
    amount,
    asset: 'USDC',
  });
  return { circleId, members, event };
}

describe('the Vibe Pay twin', () => {
  it('happy path: captures, a refund and a payout, each once and in order, give correct balances', async () => {
    const twin = createVibePay(pg);
    await twin.init();
    const c = circle();
    const p1 = randomUUID();
    const p2 = randomUUID();
    expect((await twin.handleWebhook(post(c.event('payment.captured', p1, '1000000')))).status).toBe(200);
    expect((await twin.handleWebhook(post(c.event('payment.captured', p2, '250000')))).status).toBe(200);
    expect((await twin.handleWebhook(post(c.event('payment.refunded', p2, '250000')))).status).toBe(200);
    expect((await twin.handlePayout(post({ circleId: c.circleId, memberId: c.members[1], amount: '400000' }))).status).toBe(200);
    expect(await twin.getBalances(c.circleId)).toEqual({ pot: 600000, members: { [c.members[1]!]: 400000 } });
    expect((await twin.handlePayout(post({ circleId: c.circleId, memberId: c.members[1], amount: '600001' }))).status).toBe(400);
  });

  it('init runs twice, and two circles on one database never see each other (so the twin adapter may share a client)', async () => {
    const twin = createVibePay(pg);
    await twin.init();
    await twin.init();
    const a = circle();
    const b = circle();
    await twin.handleWebhook(post(a.event('payment.captured', randomUUID(), '7')));
    await twin.handleWebhook(post(b.event('payment.captured', randomUUID(), '11')));
    expect((await twin.getBalances(a.circleId)).pot).toBe(7);
    expect((await twin.getBalances(b.circleId)).pot).toBe(11);
    expect(await twin.getBalances(randomUUID())).toEqual({ pot: 0, members: {} });
  });

  it('documents observed behavior: a partial refund removes the whole captured amount', async () => {
    const twin = createVibePay(pg);
    const c = circle();
    const p = randomUUID();
    await twin.handleWebhook(post(c.event('payment.captured', p, '1000')));
    expect((await twin.handleWebhook(post(c.event('payment.refunded', p, '300')))).status).toBe(200);
    expect((await twin.getBalances(c.circleId)).pot).toBe(0); // truth: 700
  });

  it('documents observed behavior: a double-tapped payout pays twice (no idempotency key handling)', async () => {
    const twin = createVibePay(pg);
    const c = circle();
    await twin.handleWebhook(post(c.event('payment.captured', randomUUID(), '1000')));
    const tap = { circleId: c.circleId, memberId: c.members[1], amount: '300' };
    const headers = { 'content-type': 'application/json', 'idempotency-key': randomUUID() };
    const req = () => new Request('http://twin.local/', { method: 'POST', headers, body: JSON.stringify(tap) });
    const results = await Promise.all([twin.handlePayout(req()), twin.handlePayout(req())]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(await twin.getBalances(c.circleId)).toEqual({ pot: 400, members: { [c.members[1]!]: 600 } }); // truth: 700 / 300
  });

  it('documents observed behavior: a duplicate capture and a refund before its capture', async () => {
    const twin = createVibePay(pg);
    const c = circle();
    const p = randomUUID();
    const cap = c.event('payment.captured', p, '500');
    await twin.handleWebhook(post(cap));
    await twin.handleWebhook(post(cap));
    expect((await twin.getBalances(c.circleId)).pot).toBe(500); // deduplicated by payment status
    const early = randomUUID();
    expect((await twin.handleWebhook(post(c.event('payment.refunded', early, '100')))).status).toBe(409);
  });
});
