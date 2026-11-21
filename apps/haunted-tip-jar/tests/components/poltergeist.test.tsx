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
    await waitFor(() => expect(screen.getByTestId('announcer')).toHaveTextContent(/Storm 7 done\. Ossuary drift 0\.000000 USDC\. Vibe Pay drift/), WAIT);
    expect(screen.getByRole('button', { name: /summon the poltergeist/i })).toBeEnabled();
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
