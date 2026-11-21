import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { memoryRuntime, type Runtime, type Session } from '../../src/runtime/runtime';
import { App } from '../../src/ui/App';

/** A memory runtime that remembers the sessions it opened, so tests can read the ledger behind the UI. */
export function spyRuntime(base: Runtime = memoryRuntime()) {
  const sessions: Session[] = [];
  const runtime: Runtime = {
    open: async () => {
      const s = await base.open();
      sessions.push(s);
      return s;
    },
    reset: async (current) => {
      const s = await base.reset(current);
      sessions.push(s);
      return s;
    },
  };
  return { runtime, sessions, current: () => sessions[sessions.length - 1]! };
}

export async function renderApp(spy = spyRuntime()) {
  const user = userEvent.setup();
  const utils = render(<App runtime={spy.runtime} />);
  await screen.findByRole('heading', { name: 'The Midnight Circle', level: 2 }, { timeout: 30_000 });
  return { user, spy, ...utils };
}

export const seat = (position: number) => within(screen.getByTestId(`seat-${position}`));
export const announcer = () => screen.getByTestId('announcer');

export async function count(spy: ReturnType<typeof spyRuntime>, sql: string): Promise<number> {
  return (await spy.current().service.ledger.client.query<{ n: number }>(sql)).rows[0]!.n;
}
