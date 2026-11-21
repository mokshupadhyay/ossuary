// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { Announcer } from '../../src/ui/Announcer';
import { PoltergeistPanel } from '../../src/ui/PoltergeistPanel';
import { checkSeed, checkSize } from '../../src/poltergeist';

afterEach(cleanup);
const WAIT = { timeout: 30_000 };

describe('PoltergeistPanel', () => {
  it('a small storm: Ossuary at 0.000000, the twin drifting with its fault named, epitaphs listed', async () => {
    render(
      <Announcer>
        <PoltergeistPanel initialSize={30} minSize={21} />
      </Announcer>,
    );
    const user = userEvent.setup();
    const button = screen.getByRole('button', { name: /summon the poltergeist/i });
    await user.click(button);
    // Disabled while it runs, with progress in text.
    expect(screen.getByRole('button', { name: /…/ })).toBeDisabled();

    const ossuary = await screen.findByTestId('meter-ossuary', {}, WAIT);
    expect(screen.getByTestId('drift-ossuary')).toHaveTextContent(/^0\.000000$/);
    expect(within(ossuary).getByText('Not one minor unit out of place.')).toBeInTheDocument();
    expect(screen.getByTestId('drift-twin')).not.toHaveTextContent(/^0\.000000$/);
    expect(screen.getByTestId('cx-twin')).toHaveTextContent(/fault [a-z-]+/);
    expect(screen.queryByTestId('cx-ossuary')).toBeNull();
    expect(within(screen.getByTestId('epitaphs')).getAllByRole('listitem').length).toBeGreaterThan(0);
    expect(screen.getByTestId('epitaphs')).toHaveTextContent('buried by');
    expect(screen.getAllByRole('row').length).toBe(9); // header + 8 faults
    // Seed 7 × 30: double-tap and crash-mid-step drift but net to zero; their rows must still show money.
    for (const row of screen.getAllByRole('row').slice(1)) {
      const cells = within(row).getAllByRole('cell').map((c) => c.textContent ?? '');
      const drifted = Number(cells[2]!.split('/')[0]);
      const money = cells.slice(3);
      expect(money.some((m) => m !== '0.000000')).toBe(drifted > 0);
    }
    await waitFor(() => expect(screen.getByTestId('storm-status')).toHaveTextContent(/^Storm finished: drift 0\.000000 USDC on Ossuary, [1-9]\d*\.\d{6} USDC on Vibe Pay/), WAIT);
    expect(screen.getByRole('button', { name: /summon the poltergeist/i })).toBeEnabled();
  }, 60_000);

  it('animates the storm: ghosts cross both lanes, the twin climbs, Ossuary stays at zero, then it announces the drift', async () => {
    render(<PoltergeistPanel initialSize={30} minSize={21} replayMs={1200} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /summon the poltergeist/i }));

    // While the engine runs: both lanes, looping ghosts, no numbers yet.
    const storm = screen.getByTestId('storm');
    expect(storm).toHaveAttribute('data-state', 'running');
    for (const side of ['ossuary', 'twin']) {
      const sky = screen.getByTestId(`sky-${side}`);
      expect(sky).toHaveAttribute('aria-hidden', 'true');
      expect(sky.querySelectorAll('[data-fate="brewing"]').length).toBeGreaterThan(0);
    }

    // The replay: Ossuary's drifted count stays 0 while the twin's rises; the twin's meter climbs.
    await waitFor(() => expect(screen.getByTestId('storm')).toHaveAttribute('data-state', 'replaying'), WAIT);
    expect(screen.getByTestId('storm-status')).toHaveTextContent('Replaying the storm…');
    expect(screen.getByRole('button', { name: 'Replaying the storm…' })).toBeDisabled();
    const twinCounts: number[] = [];
    const meterValues: number[] = [];
    while (screen.queryByTestId('storm')) {
      expect(screen.getByTestId('storm-ossuary-drifted')).toHaveTextContent(/^0$/);
      expect(screen.getByTestId('storm-ossuary')).toHaveClass('ok');
      twinCounts.push(Number(screen.getByTestId('storm-twin-drifted').textContent));
      meterValues.push(Number(screen.getByTestId('storm-twin').querySelector('meter')!.getAttribute('value')));
      await new Promise((r) => setTimeout(r, 90));
    }
    expect(twinCounts.length).toBeGreaterThan(3);
    expect(twinCounts).toEqual([...twinCounts].sort((a, b) => a - b));
    expect(twinCounts.at(-1)).toBeGreaterThan(twinCounts[0]!);
    expect(meterValues.at(-1)).toBeGreaterThan(meterValues[0]!);

    // Final numbers, and the polite live region says so.
    expect(screen.getByTestId('drift-ossuary')).toHaveTextContent(/^0\.000000$/);
    const status = screen.getByTestId('storm-status');
    expect(status).toHaveAttribute('role', 'status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    await waitFor(() => expect(status).toHaveTextContent(/^Storm finished: drift 0\.000000 USDC on Ossuary, \d+\.\d{6} USDC on Vibe Pay \(seed 7, 30 events\)\.$/));
    expect(status).toHaveTextContent(screen.getByTestId('drift-twin').textContent!);
  }, 60_000);

  it('with reduced motion: no moving ghosts and no replay, straight to the numbers', async () => {
    const original = window.matchMedia;
    window.matchMedia = ((q: string) => ({
      matches: q.includes('prefers-reduced-motion: reduce'),
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    try {
      render(<PoltergeistPanel initialSize={30} minSize={21} />);
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: /summon the poltergeist/i }));
      const sky = screen.getByTestId('sky-twin');
      expect(sky).toHaveClass('still');
      expect(sky.querySelectorAll('.sprite')).toHaveLength(0);
      expect(sky).toHaveTextContent('👻 → 💸');
      await screen.findByTestId('meter-twin', {}, WAIT);
      // No replay state was ever entered: the status went from a phase straight to the result.
      expect(screen.queryByTestId('storm')).toBeNull();
      await waitFor(() => expect(screen.getByTestId('storm-status')).toHaveTextContent(/^Storm finished: drift 0\.000000 USDC on Ossuary/));
    } finally {
      window.matchMedia = original;
    }
  }, 60_000);

  it('validates seed and size', async () => {
    expect(checkSeed('7')).toBe(7);
    expect(checkSeed('4294967296')).toMatch(/Seed/);
    expect(checkSeed('-1')).toMatch(/Seed/);
    expect(checkSize('49')).toMatch(/50 to 2000/);
    expect(checkSize('2001')).toMatch(/50 to 2000/);
    expect(checkSize('200')).toBe(200);
    render(
      <Announcer>
        <PoltergeistPanel />
      </Announcer>,
    );
    const user = userEvent.setup();
    await user.clear(screen.getByLabelText(/Events/));
    await user.type(screen.getByLabelText(/Events/), '5');
    await user.click(screen.getByRole('button', { name: /summon/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Size must be a whole number from 50 to 2000');
  });
});
