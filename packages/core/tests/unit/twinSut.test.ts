import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeClock } from '../../src/poltergeist/clock.js';
import { materialize, newRunTag } from '../../src/poltergeist/materialize.js';
import { generateStorm, MEMBERS } from '../../src/poltergeist/storm.js';
import { summon } from '../../src/poltergeist/summon.js';
import type { SutContext } from '../../src/poltergeist/sut.js';
import { twinFactory } from '../../src/poltergeist/twinSut.js';

let pg: PGlite;
beforeAll(async () => {
  pg = new PGlite();
});
afterAll(async () => {
  await pg.close();
});

function context(): SutContext & { c: ReturnType<typeof materialize> } {
  const c = materialize(newRunTag());
  return {
    c,
    circleId: c.circleId,
    memberIds: MEMBERS.map((m) => c.memberIds[m]),
    asset: 'USDC',
    clock: fakeClock(Date.UTC(2026, 9, 31)),
    secret: 'x'.repeat(40),
    runTag: c.runTag,
  };
}

const capture = (ctx: ReturnType<typeof context>, n: number, amount = '100') =>
  JSON.stringify({ id: ctx.c.eventId(`evt_${n}`), type: 'payment.captured', paymentId: ctx.c.paymentId(`pay_${n}`), circleId: ctx.circleId, memberId: ctx.memberIds[0], asset: 'USDC', amount });

describe('twin adapter', () => {
  it('routes webhooks and payouts and never reports a defense', async () => {
    const ctx = context();
    const s = await twinFactory({ client: pg })(ctx);
    expect(await s.deliver(capture(ctx, 1), {}, { route: 'webhook' })).toEqual({ status: 200, crashed: false, defense: null });
    expect(await s.deliver(capture(ctx, 1), {}, { route: 'webhook' })).toEqual({ status: 200, crashed: false, defense: null });
    const payout = JSON.stringify({ circleId: ctx.circleId, memberId: ctx.memberIds[3], amount: '40' });
    expect((await s.deliver(payout, { 'idempotency-key': globalThis.crypto.randomUUID() }, { route: 'payout' })).status).toBe(200);
    const b = await s.balances();
    expect(b.pot).toBe(60n);
    expect(b.members.get(ctx.memberIds[3]!)).toBe(40n);
    expect(b.fractional).toEqual([]);
  });

  it('a crash before statement 0 kills the delivery; nothing ran, and later statements of it also fail', async () => {
    const ctx = context();
    const s = await twinFactory({ client: pg })(ctx);
    expect(await s.deliver(capture(ctx, 2), {}, { route: 'webhook', crash: { beforeStep: 0 } })).toEqual({ status: null, crashed: true, defense: null });
    expect((await s.balances()).pot).toBe(0n);
    // The next delivery runs normally: the process was restarted.
    expect((await s.deliver(capture(ctx, 2), {}, { route: 'webhook' })).status).toBe(200);
    expect((await s.balances()).pot).toBe(100n);
  });

  it('a crash past the last statement leaves the work committed and drops the response', async () => {
    const ctx = context();
    const s = await twinFactory({ client: pg })(ctx);
    await s.deliver(capture(ctx, 3, '500'), {}, { route: 'webhook' });
    const payout = JSON.stringify({ circleId: ctx.circleId, memberId: ctx.memberIds[1], amount: '100' });
    const r = await s.deliver(payout, {}, { route: 'payout', crash: { beforeStep: 24 } });
    expect(r).toEqual({ status: null, crashed: true, defense: null });
    expect((await s.balances()).pot).toBe(400n);
    await s.deliver(payout, {}, { route: 'payout' }); // the client's retry pays again
    expect((await s.balances()).members.get(ctx.memberIds[1]!)).toBe(200n);
  });

  it('converts integral balances exactly, and truncates and reports a non-integral one', async () => {
    const ctx = context();
    const s = await twinFactory({ client: pg })(ctx);
    await s.deliver(capture(ctx, 4, '9007199254740993'), {}, { route: 'webhook' });
    expect((await s.balances()).pot).toBe(9007199254740992n); // the twin's Number() is the float trait, reported as is
    await pg.query(`update circles set pot = 12.75 where circle_id = $1`, [ctx.circleId]);
    const b = await s.balances();
    expect(b.pot).toBe(12n);
    expect(b.fractional).toEqual([{ memberId: null, value: '12.75' }]);
  });

  it('runs a small storm end to end', async () => {
    const r = await summon({ storm: generateStorm({ seed: 4, size: 30 }), factory: twinFactory({ client: pg }), target: 'twin' });
    expect(r.target).toBe('twin');
    expect(r.events.planned).toBe(30);
  });
});
