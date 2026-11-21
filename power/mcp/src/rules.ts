/**
 * The Rule_Catalog (design D6). `rule` is a verbatim quote of the steering
 * bullet; tests/unit/checker.test.ts checks each quote is still in its file.
 * `bug` must be flagged for its rule by the checker and `fixExample` must be
 * entirely clean.
 */

export const RULE_IDS = [
  'float-money',
  'mutable-balance',
  'missing-idempotency-key',
  'unverified-webhook',
  'write-outside-transaction',
  'refund-over-capture',
] as const;

export type RuleId = (typeof RULE_IDS)[number];

export interface Rule {
  id: RuleId;
  title: string;
  /** Repository-relative path of the steering file the quote comes from. */
  steeringFile: string;
  /** Verbatim text of the steering bullet. */
  rule: string;
  /** One-line message attached to each violation. */
  message: string;
  /** One-line fix attached to each violation. */
  fix: string;
  bug: string;
  fixExample: string;
}

const RULE_LIST: Rule[] = [
  {
    id: 'float-money',
    title: 'Money is an integer in minor units, never a float',
    steeringFile: '.kiro/steering/money.md',
    rule: 'Amounts are **integers in minor units** (cents, or USDC base units with 6 decimals). Never use floats for money.',
    message: 'Money held, parsed, rounded or stored as a floating-point number.',
    fix: 'Use bigint minor units in TypeScript and bigint/numeric (no scale) in Postgres; format only at the edge, without rounding.',
    bug: `export function tipTotal(tips: { amount: number }[]): number {
  return tips.reduce((sum, t) => sum + t.amount, 0);
}
`,
    fixExample: `export function tipTotal(tips: { amount: bigint }[]): bigint {
  return tips.reduce((sum, t) => sum + t.amount, 0n);
}
`,
  },
  {
    id: 'mutable-balance',
    title: 'A balance is the sum of ledger entries, never a mutable column',
    steeringFile: '.kiro/steering/money.md',
    rule: 'Money never changes in place. A balance is the **sum of ledger entries**, never a mutable column.',
    message: 'Money is changed in place (UPDATE of an amount column, a stored balance, or an UPDATE/DELETE on entries).',
    fix: 'Append balanced entries with postTransaction and derive the balance with balance(db, accountId).',
    bug: `export async function credit(db: Db, idempotencyKey: string, walletId: string, amount: bigint) {
  await db.transaction(async (tx) => {
    await claimKey(tx, idempotencyKey);
    await tx.execute(sql\`UPDATE wallets SET balance = balance + \${amount} WHERE id = \${walletId}\`);
  });
}
`,
    fixExample: `export async function credit(db: Db, idempotencyKey: string, potId: string, walletId: string, amount: bigint) {
  return postTransaction(db, {
    idempotencyKey,
    kind: 'transfer',
    entries: [
      { accountId: walletId, amount },
      { accountId: potId, amount: -amount },
    ],
  });
}
`,
  },
  {
    id: 'missing-idempotency-key',
    title: 'Every money-moving operation takes an idempotency key',
    steeringFile: '.kiro/steering/money.md',
    rule: 'Every operation that moves money takes an **idempotency key** (see `idempotency.md`).',
    message: 'Money moves here but nothing in this file carries an idempotency key, so a retry or double-tap moves it twice.',
    fix: 'Take a client-generated idempotencyKey (UUID) and pass it to postTransaction/refund; reuse the same key on retries and double-taps.',
    bug: `export async function payOut(db: Db, potId: string, memberId: string, amount: bigint) {
  return postTransaction(db, {
    kind: 'transfer',
    entries: [
      { accountId: memberId, amount },
      { accountId: potId, amount: -amount },
    ],
  });
}
`,
    fixExample: `export async function payOut(db: Db, idempotencyKey: string, potId: string, memberId: string, amount: bigint) {
  return postTransaction(db, {
    idempotencyKey,
    kind: 'transfer',
    entries: [
      { accountId: memberId, amount },
      { accountId: potId, amount: -amount },
    ],
  });
}
`,
  },
  {
    id: 'unverified-webhook',
    title: 'Verify the webhook signature first, with a constant-time compare',
    steeringFile: '.kiro/steering/webhooks.md',
    rule: '**Verify the signature first** (HMAC-SHA256 over the raw body plus timestamp) using a constant-time compare. Reject on failure.',
    message: 'Webhook body is trusted without a signature check, or the signature is compared with ===, which leaks timing.',
    fix: 'Pass the raw body and headers to createWebhookHandler (or verifyWebhook) before parsing; compare signatures with crypto.timingSafeEqual.',
    bug: `export async function handleWebhook(req: Request): Promise<Response> {
  const event = await req.json();
  await markCaptured(event.paymentId);
  return new Response('ok');
}
`,
    fixExample: `const handle = await createWebhookHandler(db, config);

export async function handleWebhook(req: Request): Promise<Response> {
  const res = await handle({ rawBody: await req.text(), headers: req.headers });
  return Response.json(res.body, { status: res.status });
}
`,
  },
  {
    id: 'write-outside-transaction',
    title: 'Related writes happen in one database transaction',
    steeringFile: '.kiro/steering/ledger.md',
    rule: 'A transaction and its entries are written in **one database transaction**.',
    message: 'Several writes with no surrounding transaction: a crash between them leaves half an operation behind.',
    fix: 'Wrap the writes in db.transaction(async (tx) => { ... }) and use tx for every write, or pass callerTx to postTransaction/refund.',
    bug: `export async function recordPayout(db: Db, idempotencyKey: string, payoutId: string) {
  await db.insert(payouts).values({ id: payoutId, idempotencyKey });
  await db.insert(outboxMessages).values({ key: \`payout:\${payoutId}\`, topic: 'payout.sent' });
}
`,
    fixExample: `export async function recordPayout(db: Db, idempotencyKey: string, payoutId: string) {
  await db.transaction(async (tx) => {
    await tx.insert(payouts).values({ id: payoutId, idempotencyKey });
    await tx.insert(outboxMessages).values({ key: \`payout:\${payoutId}\`, topic: 'payout.sent' });
  });
}
`,
  },
  {
    id: 'refund-over-capture',
    title: 'Refunds never exceed the captured amount',
    steeringFile: '.kiro/steering/ledger.md',
    rule: 'Refunds can never exceed the captured amount of the original payment.',
    message: 'A refund is written with no check against what was captured and already refunded.',
    fix: "Use refund(db, { idempotencyKey, paymentId, amount }) from @ossuary/core, which locks the payment, caps at captured minus refunded and throws RefundCapExceededError.",
    bug: `export async function refundTip(db: Db, idempotencyKey: string, paymentId: string, potId: string, fanId: string, amount: bigint) {
  return postTransaction(db, {
    idempotencyKey,
    kind: 'refund',
    paymentId,
    entries: [
      { accountId: potId, amount },
      { accountId: fanId, amount: -amount },
    ],
  });
}
`,
    fixExample: `export async function refundTip(db: Db, idempotencyKey: string, paymentId: string, amount: bigint) {
  return refund(db, { idempotencyKey, paymentId, amount });
}
`,
  },
];

export const RULES: readonly Readonly<Rule>[] = Object.freeze(RULE_LIST.map((r) => Object.freeze(r)));

export const RULES_BY_ID: ReadonlyMap<RuleId, Readonly<Rule>> = new Map(RULES.map((r) => [r.id, r]));

export const isRuleId = (v: unknown): v is RuleId => typeof v === 'string' && (RULE_IDS as readonly string[]).includes(v);
