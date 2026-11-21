// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { result } from './reportFixture';
import { PoltergeistPanel } from '../../src/ui/PoltergeistPanel';

/* The fixture's double-tap row is the case from the review: drifted ghosts whose total nets to zero. */
async function renderResult() {
  render(<PoltergeistPanel running={false} phase={null} result={result} error={null} disabled={false} onSummon={() => undefined} />);
  return within(await screen.findByRole('article', { name: 'Vibe Pay' }, { timeout: 10_000 }));
}

describe('Ghosts by fault: a drifted row never reads as zero', () => {
  it('shows money lost and conjured per fault, from the per-account drifts', async () => {
    const twin = await renderResult();
    const table = within(twin.getByRole('table', { name: 'Vibe Pay: ghosts per fault' }));
    const headers = table.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['Fault', 'Ghosts', 'Blocked', 'Drifted', 'Lost (USDC)', 'Conjured (USDC)']);

    const row = within(table.getByRole('row', { name: /Concurrent double-tap/ }));
    const cells = row.getAllByRole('cell').map((c) => c.textContent?.trim());
    // Ghosts, Blocked, Drifted, Lost, Conjured.
    expect(cells).toEqual(['1', '0', '✗ 1', '32.687968', '32.687968']);

    const clean = within(table.getByRole('row', { name: /Duplicate delivery/ }));
    expect(clean.getAllByRole('cell').map((c) => c.textContent?.trim())).toEqual(['1', '1', '0', '0.00', '0.00']);
  });

  it('lists a netting ghost with what it lost and conjured, not “drift 0.00 USDC”', async () => {
    const twin = await renderResult();
    const item = twin.getByText('key_4bdc4c95').closest('li')!;
    expect(item).not.toHaveTextContent(/drift 0\.00 USDC/);
    expect(item).toHaveTextContent('lost 32.687968 USDC, conjured 32.687968 USDC');
  });

  it('keeps the meter value on the total, but a netting twin is not called drift-free', async () => {
    const twin = await renderResult();
    expect(screen.getByTestId('drift-vibe-pay')).toHaveTextContent(/^0\.00 USDC$/);
    expect(screen.getByTestId('drift-ossuary')).toHaveTextContent(/^0\.00 USDC$/);
    expect(twin.queryByText(/No drift/)).not.toBeInTheDocument();
    expect(twin.getByText('Drifting: money lost and conjured, netting to zero')).toBeInTheDocument();
  });
});
