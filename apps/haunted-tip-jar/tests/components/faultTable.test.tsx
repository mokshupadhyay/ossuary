// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FAULTS, type FaultId, type PoltergeistReport } from '@ossuary/core/poltergeist';
import { DriftMeter, FaultTable } from '../../src/ui/PoltergeistPanel';
import type { Duel } from '../../src/poltergeist';

/*
 * The "Ghosts by fault" table must never read zero for a fault whose ghosts
 * drifted. Two shapes that net to zero are built by hand here:
 *  - double-tap: within each ghost the pot loses what a member gains (the
 *    seed 7 storm does exactly this, 8/8 drifted, net 0.000000);
 *  - crash-mid-step: two ghosts that cancel each other on the same account,
 *    so even per-account absolute sums of the fault total read zero.
 */

type Accounts = Partial<Record<'pot' | 'm0' | 'm1' | 'm2' | 'm3' | 'm4', bigint>>;

const json = (a: Accounts) => {
  const accounts = (['pot', 'm0', 'm1', 'm2', 'm3', 'm4'] as const).map((k) => ({
    account: k === 'pot' ? 'pot' : `member:${k}`,
    drift: (a[k] ?? 0n).toString(),
  }));
  return { total: accounts.reduce((s, x) => s + BigInt(x.drift), 0n).toString(), accounts };
};

const add = (xs: Accounts[]): Accounts => {
  const out: Accounts = {};
  for (const x of xs) for (const [k, v] of Object.entries(x) as [keyof Accounts, bigint][]) out[k] = (out[k] ?? 0n) + v;
  return out;
};

function report(target: 'ossuary' | 'twin', ghosts: { faultId: FaultId; drift: Accounts }[], final: { conjured: bigint; lost: bigint; total: bigint }): PoltergeistReport {
  const drifted = ghosts.filter((g) => Object.values(g.drift).some((v) => v !== 0n));
  return {
    schema: 'ossuary/poltergeist-report',
    version: 1,
    generator: 1,
    seed: 7,
    size: 30,
    ensureEveryFault: true,
    target,
    asset: 'USDC',
    decimals: 6,
    events: { planned: 0, attempts: 0, retries: 0, crashes: 0 },
    faults: FAULTS.map((f) => {
      const mine = ghosts.filter((g) => g.faultId === f.id);
      const bad = mine.filter((g) => drifted.includes(g)).length;
      return { id: f.id, name: f.name, ghosts: mine.length, deliveries: mine.length * 2, blocked: mine.length - bad, drifted: bad, drift: json(add(mine.map((g) => g.drift))) };
    }),
    honest: { units: 0, deliveries: 0, drift: json({}) },
    drift: { ...json({}), total: final.total.toString(), conjured: final.conjured.toString(), lost: final.lost.toString(), doubleCreditedMembers: 2 },
    settleDrift: json({}),
    fractionalBalances: [],
    blocked: ghosts
      .filter((g) => !drifted.includes(g))
      .map((g, i) => ({ ghostId: `b${i}`, faultId: g.faultId, subject: 's', epitaph: 'buried by test' })),
    drifted: drifted.map((g, i) => ({ ghostId: `d${i}`, faultId: g.faultId, subject: 's', drift: json(g.drift) })),
    counterexample: null,
  };
}

const twinGhosts: { faultId: FaultId; drift: Accounts }[] = [
  { faultId: 'double-tap', drift: { pot: 795_939_672n, m0: -795_939_672n } },
  { faultId: 'double-tap', drift: { pot: 228_315_148n, m3: -228_315_148n } },
  { faultId: 'crash-mid-step', drift: { pot: 5_000_000n } },
  { faultId: 'crash-mid-step', drift: { pot: -5_000_000n } },
  { faultId: 'duplicate-delivery', drift: { pot: 1_500_000n } },
  { faultId: 'replayed-timestamp', drift: {} },
];
const ossuaryGhosts = twinGhosts.map((g) => ({ faultId: g.faultId, drift: {} }));

const duel: Duel = {
  seed: 7,
  size: 30,
  ossuary: report('ossuary', ossuaryGhosts, { conjured: 0n, lost: 0n, total: 0n }),
  twin: report('twin', twinGhosts, { conjured: 1_024_254_820n, lost: 1_025_754_820n, total: 1_500_000n }),
};

afterEach(cleanup);

describe('FaultTable', () => {
  it('a row with drifted ghosts never reads as zero drift', () => {
    render(<FaultTable duel={duel} />);
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent ?? '');
    const driftedCol = headers.indexOf('Vibe Pay drifted') - 1; // the row header is not a cell
    expect(driftedCol).toBeGreaterThanOrEqual(0);
    const body = screen.getAllByRole('row').slice(1);
    expect(body).toHaveLength(8);
    let checked = 0;
    for (const row of body) {
      const cells = within(row).getAllByRole('cell').map((c) => c.textContent ?? '');
      const drifted = Number(cells[driftedCol]!.split('/')[0]);
      const money = cells.filter((t) => /^-?\d+\.\d{6}$/.test(t));
      expect(money.length).toBeGreaterThan(0);
      if (drifted > 0) {
        checked += 1;
        expect(money.some((m) => m !== '0.000000'), `${within(row).getByRole('rowheader').textContent}: ${cells.join(' | ')}`).toBe(true);
      } else {
        expect(money.every((m) => m === '0.000000')).toBe(true);
      }
    }
    expect(checked).toBe(3);
  });

  it('shows lost and conjured separately, summed ghost by ghost', () => {
    render(<FaultTable duel={duel} />);
    const cell = (fault: string, col: string) => {
      const headers = screen.getAllByRole('columnheader').map((h) => h.textContent ?? '');
      const row = screen.getByRole('row', { name: new RegExp(`^${fault}`) });
      return within(row).getAllByRole('cell')[headers.findIndex((h) => h.startsWith(col)) - 1]!.textContent;
    };
    expect(cell('Concurrent double-tap', 'Vibe Pay lost')).toBe('1024.254820');
    expect(cell('Concurrent double-tap', 'Vibe Pay conjured')).toBe('1024.254820');
    expect(cell('Crash between steps', 'Vibe Pay lost')).toBe('5.000000');
    expect(cell('Crash between steps', 'Vibe Pay conjured')).toBe('5.000000');
    expect(cell('Duplicate delivery', 'Vibe Pay lost')).toBe('1.500000');
    expect(cell('Duplicate delivery', 'Vibe Pay conjured')).toBe('0.000000');
  });

  it('the meters keep the per-account totals from the report', () => {
    render(<DriftMeter title="Vibe Pay (twin)" report={duel.twin} />);
    expect(screen.getByTestId('drift-twin')).toHaveTextContent(/^1\.500000$/);
    const meter = screen.getByTestId('meter-twin');
    expect(within(meter).getByText('Conjured').nextElementSibling).toHaveTextContent('1024.254820');
    expect(within(meter).getByText('Lost').nextElementSibling).toHaveTextContent('1025.754820');
  });
});
