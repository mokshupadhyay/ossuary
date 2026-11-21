import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeClock } from '../../src/poltergeist/clock.js';
import { materialize, newRunTag } from '../../src/poltergeist/materialize.js';
import { signedDelivery } from '../../src/poltergeist/rail.js';
import { MEMBERS } from '../../src/poltergeist/storm.js';
import { ossuaryFactory, ossuaryInternals, type SutContext, type SystemUnderTest } from '../../src/poltergeist/sut.js';
import { createPropertyDb, type PropertyDb } from '../helpers/arbitraries.js';

const SECRET = 'ossuary-sut-test-secret-0123456789abcdef';
const T0 = Date.UTC(2026, 9, 31);

let pdb: PropertyDb;
const open: SystemUnderTest[] = [];

beforeAll(async () => {
  pdb = await createPropertyDb();
});
afterAll(async () => {
  for (const s of open) await s.close();
  await pdb.handle.close();
});

function context(): SutContext & { concrete: ReturnType<typeof materialize> } {
  const concrete = materialize(newRunTag());
  return {
    concrete,
    circleId: concrete.circleId,
    memberIds: MEMBERS.map((m) => concrete.memberIds[m]),
    asset: 'USDC',
    clock: fakeClock(T0),
    secret: SECRET,
    runTag: concrete.runTag,
  };
}

async function sut(ctx = context()) {
  const s = await ossuaryFactory({ client: pdb.handle.client })(ctx);
  open.push(s);
  return { s, ctx };
}

function webhook(ctx: ReturnType<typeof context>, body: Record<string, unknown>) {
  const raw = JSON.stringify({ asset: 'USDC', circleId: ctx.circleId, memberId: ctx.memberIds[0], ...body });
  const req = signedDelivery(SECRET, ctx.clock, raw);
  return { raw, headers: req.headers as Record<string, string> };
}

describe('Ossuary adapter: webhooks, balances, settle', () => {
  it('a signed capture moves the pot; a refund lowers it', async () => {
    const { s, ctx } = await sut();
    const pay = ctx.concrete.paymentId('pay_00000001');
    const cap = webhook(ctx, { id: ctx.concrete.eventId('evt_00000001'), type: 'payment.captured', paymentId: pay, amount: '1000' });
    expect(await s.deliver(cap.raw, cap.headers, { route: 'webhook' })).toEqual({ status: 200, crashed: false, defense: null });
    expect((await s.balances()).pot).toBe(1000n);
    const ref = webhook(ctx, { id: ctx.concrete.eventId('evt_00000002'), type: 'payment.refunded', paymentId: pay, amount: '300' });
    expect((await s.deliver(ref.raw, ref.headers, { route: 'webhook' })).status).toBe(200);
    const b = await s.balances();
    expect(b.pot).toBe(700n);
    expect(b.asset).toBe('USDC');
    expect([...b.members.values()]).toEqual([0n, 0n, 0n, 0n, 0n]);
    expect([...b.members.keys()]).toEqual(ctx.memberIds.map((m) => m.toLowerCase()));
  });

  it('balances() issues exactly one statement', async () => {
    const { s } = await sut();
    const { crashing } = ossuaryInternals.get(s)!;
    crashing.resetLog();
    await s.balances();
    expect(crashing.log).toHaveLength(1);
    expect(crashing.log[0]).toMatch(/^select .*sum\(.*from "entries".*group by/i);
  });

  it('settle() drains the outbox and leaves balances unchanged', async () => {
    const { s, ctx } = await sut();
    for (let i = 0; i < 3; i++) {
      const cap = webhook(ctx, {
        id: ctx.concrete.eventId(`evt_1000000${i}`),
        type: 'payment.captured',
        paymentId: ctx.concrete.paymentId(`pay_1000000${i}`),
        amount: '5',
      });
      await s.deliver(cap.raw, cap.headers, { route: 'webhook' });
    }
    const before = await s.balances();
    await s.settle();
    expect(await s.balances()).toEqual(before);
    const { db } = ossuaryInternals.get(s)!;
    const pending = await db.execute(`select count(*)::int as n from outbox_messages where status = 'pending'` as never);
    expect(Number((pending.rows[0] as { n: number }).n)).toBe(0);
  });

  it('two instances on one client never see each other\'s balances', async () => {
    const a = await sut();
    const b = await sut();
    const cap = webhook(a.ctx, {
      id: a.ctx.concrete.eventId('evt_20000000'),
      type: 'payment.captured',
      paymentId: a.ctx.concrete.paymentId('pay_20000000'),
      amount: '77',
    });
    await a.s.deliver(cap.raw, cap.headers, { route: 'webhook' });
    expect((await a.s.balances()).pot).toBe(77n);
    expect((await b.s.balances()).pot).toBe(0n);
  });

  it('a fresh instance without a client migrates its own database', async () => {
    const ctx = context();
    const s = await ossuaryFactory()(ctx);
    try {
      const cap = webhook(ctx, { id: 'evt_x', type: 'payment.captured', paymentId: ctx.concrete.paymentId('pay_x'), amount: '9' });
      expect((await s.deliver(cap.raw, cap.headers, { route: 'webhook' })).status).toBe(200);
      expect((await s.balances()).pot).toBe(9n);
    } finally {
      await s.close();
    }
  });
});

describe('Ossuary adapter: payouts', () => {
  async function funded(amount = 1000n) {
    const { s, ctx } = await sut();
    const cap = webhook(ctx, {
      id: ctx.concrete.eventId('evt_30000000'),
      type: 'payment.captured',
      paymentId: ctx.concrete.paymentId('pay_30000000'),
      amount: amount.toString(),
    });
    await s.deliver(cap.raw, cap.headers, { route: 'webhook' });
    return { s, ctx };
  }
  const body = (ctx: ReturnType<typeof context>, over: Record<string, unknown> = {}) =>
    JSON.stringify({ circleId: ctx.circleId, memberId: ctx.memberIds[2], amount: '400', ...over });
  const keyed = (key: string) => ({ 'Idempotency-Key': key });

  it('rejects a bad key or body with 400 and writes nothing', async () => {
    const { s, ctx } = await funded();
    const key = globalThis.crypto.randomUUID();
    const cases: [string, Record<string, string>][] = [
      [body(ctx), {}],
      [body(ctx), keyed('not-a-uuid')],
      ['{not json', keyed(key)],
      ['[]', keyed(key)],
      [body(ctx, { circleId: globalThis.crypto.randomUUID() }), keyed(key)],
      [body(ctx, { memberId: globalThis.crypto.randomUUID() }), keyed(key)],
      [body(ctx, { amount: 400 }), keyed(key)],
      [body(ctx, { amount: '0400' }), keyed(key)],
      [body(ctx, { amount: '-1' }), keyed(key)],
      [body(ctx, { amount: '9223372036854775808' }), keyed(key)],
    ];
    for (const [raw, headers] of cases) {
      expect((await s.deliver(raw, headers, { route: 'payout' })).status, raw).toBe(400);
    }
    expect((await s.balances()).pot).toBe(1000n);
  });

  it('moves money from the pot to the member wallet', async () => {
    const { s, ctx } = await funded();
    const r = await s.deliver(body(ctx), keyed(globalThis.crypto.randomUUID()), { route: 'payout' });
    expect(r).toEqual({ status: 200, crashed: false, defense: null });
    const b = await s.balances();
    expect(b.pot).toBe(600n);
    expect(b.members.get(ctx.memberIds[2]!.toLowerCase())).toBe(400n);
  });

  it('answers 409 for the same key with a different body, and 422 when the pot is too small', async () => {
    const { s, ctx } = await funded();
    const key = globalThis.crypto.randomUUID();
    expect((await s.deliver(body(ctx), keyed(key), { route: 'payout' })).status).toBe(200);
    expect((await s.deliver(body(ctx, { amount: '401' }), keyed(key), { route: 'payout' })).status).toBe(409);
    expect((await s.deliver(body(ctx, { amount: '601' }), keyed(globalThis.crypto.randomUUID()), { route: 'payout' })).status).toBe(422);
    expect((await s.balances()).pot).toBe(600n);
  });

  it('three concurrent identical taps post once; the repeats report idempotency-key', async () => {
    const { s, ctx } = await funded();
    const key = globalThis.crypto.randomUUID();
    const results = await Promise.all([0, 1, 2].map(() => s.deliver(body(ctx), keyed(key), { route: 'payout' })));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(results.map((r) => r.defense)).toEqual([null, 'idempotency-key', 'idempotency-key']);
    const b = await s.balances();
    expect(b.pot).toBe(600n);
    expect(b.members.get(ctx.memberIds[2]!.toLowerCase())).toBe(400n);
  });
});

describe('Ossuary adapter: crashes and defenses (design D5)', () => {
  const CAPTURE: readonly RegExp[] = [
    /^insert into "webhook_events"/, /^insert into "payment_states"/, /^select .* from "payment_states" .*for update/,
    /^savepoint/, /^insert into "idempotency_records"/, /^select .* from "accounts" .*for update/, /^select .* from "entries"/,
    /^insert into "transactions"/, /^insert into "entries"/, /^update "idempotency_records"/, /^release savepoint/,
    /^update "payment_states"/, /^update "webhook_events"/, /^insert into "outbox_messages"/, /^select .* from "webhook_events" .*for update/,
  ];
  const REFUND: readonly RegExp[] = [
    /^insert into "webhook_events"/, /^insert into "payment_states"/, /^select .* from "payment_states" .*for update/,
    /^savepoint/, /^insert into "idempotency_records"/, /^select .* from "transactions" .*for update/, /^select .* from "entries" inner join/,
    /^select .* from "accounts" .*for update/, /^select .* from "entries"/, /^insert into "transactions"/, /^insert into "entries"/,
    /^update "idempotency_records"/, /^release savepoint/, /^update "payment_states"/, /^update "webhook_events"/, /^insert into "outbox_messages"/,
  ];
  const PAYOUT: readonly RegExp[] = [
    /^insert into "idempotency_records"/, /^select .* from "accounts" .*for update/, /^select .* from "entries"/,
    /^insert into "transactions"/, /^insert into "entries"/, /^update "idempotency_records"/,
  ];

  let n = 0;
  const fresh = () => `${++n}`.padStart(8, '0');

  /** One delivery of a kind, built fresh each call so every crash index gets its own ids. */
  async function scenario(kind: 'capture' | 'refund' | 'payout') {
    const { s, ctx } = await sut();
    const pay = ctx.concrete.paymentId(`pay_${fresh()}`);
    const capture = webhook(ctx, { id: ctx.concrete.eventId(`evt_${fresh()}`), type: 'payment.captured', paymentId: pay, amount: '1000' });
    if (kind !== 'capture') await s.deliver(capture.raw, capture.headers, { route: 'webhook' });
    const target =
      kind === 'capture'
        ? { ...capture, route: 'webhook' as const, pot: 1000n }
        : kind === 'refund'
          ? { ...webhook(ctx, { id: ctx.concrete.eventId(`evt_${fresh()}`), type: 'payment.refunded', paymentId: pay, amount: '300' }), route: 'webhook' as const, pot: 700n }
          : {
              raw: JSON.stringify({ circleId: ctx.circleId, memberId: ctx.memberIds[1], amount: '250' }),
              headers: { 'idempotency-key': globalThis.crypto.randomUUID() },
              route: 'payout' as const,
              pot: 750n,
            };
    const before = (await s.balances()).pot;
    return { s, ctx, target, before, crashing: ossuaryInternals.get(s)!.crashing };
  }

  for (const [kind, expected] of [['capture', CAPTURE], ['refund', REFUND], ['payout', PAYOUT]] as const) {
    it(`${kind}: a crash before any statement leaves nothing, logs only rollbacks after it, and a retry applies once`, async () => {
      const cal = await scenario(kind);
      const { calibrate } = await import('../helpers/crash.js');
      await calibrate(cal.crashing, () => cal.s.deliver(cal.target.raw, cal.target.headers, { route: cal.target.route }), expected);

      for (let k = 0; k < expected.length; k++) {
        const { s, target, before, crashing } = await scenario(kind);
        const r = await s.deliver(target.raw, target.headers, { route: target.route, crash: { beforeStep: k } });
        expect(r, `crash before ${k}`).toEqual({ status: null, crashed: true, defense: 'rollback' });
        expect(crashing.log.slice(k).every((q) => /^rollback( to savepoint \w+)?$/i.test(q)), crashing.log.slice(k).join('\n')).toBe(true);
        expect((await s.balances()).pot, `nothing left behind at ${k}`).toBe(before);
        const retry = await s.deliver(target.raw, target.headers, { route: target.route });
        expect(retry.status).toBe(200);
        expect((await s.balances()).pot).toBe(target.pot);
        const again = await s.deliver(target.raw, target.headers, { route: target.route });
        expect(again.status).toBe(200);
        expect((await s.balances()).pot, `applied exactly once at ${k}`).toBe(target.pot);
      }
    });

    it(`${kind}: a crash past the last statement leaves it committed; the retry is neutralized`, async () => {
      const { s, target } = await scenario(kind);
      const r = await s.deliver(target.raw, target.headers, { route: target.route, crash: { beforeStep: expected.length } });
      expect(r).toEqual({ status: null, crashed: true, defense: null });
      expect((await s.balances()).pot).toBe(target.pot);
      const retry = await s.deliver(target.raw, target.headers, { route: target.route });
      expect(retry).toEqual({ status: 200, crashed: false, defense: kind === 'payout' ? 'idempotency-key' : 'inbox-dedupe' });
      expect((await s.balances()).pot).toBe(target.pot);
    });
  }

  it('reports timestamp-check for a stale request, signature-check for a bad one, parking for an early refund', async () => {
    const { s, ctx } = await sut();
    const raw = JSON.stringify({ id: ctx.concrete.eventId('evt_40000000'), type: 'payment.captured', paymentId: ctx.concrete.paymentId('pay_4'), asset: 'USDC', amount: '5' });
    const { signedDeliveryAt } = await import('../../src/poltergeist/rail.js');
    const stale = signedDeliveryAt(SECRET, Math.floor(ctx.clock.now() / 1000) - 400, raw);
    expect(await s.deliver(raw, stale.headers as Record<string, string>, { route: 'webhook' })).toEqual({ status: 401, crashed: false, defense: 'timestamp-check' });
    const forged = signedDeliveryAt('another-secret-that-is-long-enough-000', Math.floor(ctx.clock.now() / 1000), raw);
    expect((await s.deliver(raw, forged.headers as Record<string, string>, { route: 'webhook' })).defense).toBe('signature-check');
    const early = webhook(ctx, { id: ctx.concrete.eventId('evt_40000001'), type: 'payment.refunded', paymentId: ctx.concrete.paymentId('pay_5'), amount: '1' });
    expect(await s.deliver(early.raw, early.headers, { route: 'webhook' })).toEqual({ status: 200, crashed: false, defense: 'parking' });
    expect((await s.balances()).pot).toBe(0n);
  });
});
