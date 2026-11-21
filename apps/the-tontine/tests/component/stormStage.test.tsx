// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { finishedText } from '../../src/tontine/stormView';
import { REPLAY_MS, StormStage } from '../../src/ui/StormStage';
import { result } from './reportFixture';

afterEach(() => {
  vi.useRealTimers();
});

const percent = (side: 'ossuary' | 'twin') => Number(screen.getByTestId(`gauge-${side}`).dataset['percent']);

describe('The storm stage', () => {
  it('while the storm runs, ghosts drift across both lanes and nothing is announced yet', () => {
    render(<StormStage running phase="ossuary" result={null} reduced={false} onFinished={() => undefined} />);
    expect(screen.getByTestId('storm-stage')).toHaveAttribute('data-state', 'storm');
    expect(screen.getByTestId('lane-ossuary').querySelectorAll('.sprite--brewing')).toHaveLength(4);
    expect(screen.getByTestId('lane-twin').querySelectorAll('.sprite--brewing')).toHaveLength(4);
    expect(screen.getByTestId('lane-twin')).toHaveAttribute('aria-hidden', 'true');
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toBeEmptyDOMElement();
  });

  it('replays the storm: Vibe Pay’s meter climbs red, Ossuary’s stays at zero, then it announces the drift', () => {
    vi.useFakeTimers();
    const onFinished = vi.fn();
    render(<StormStage running={false} phase={null} result={result} reduced={false} onFinished={onFinished} />);
    expect(screen.getByTestId('storm-stage')).toHaveAttribute('data-state', 'replay');
    expect(percent('twin')).toBe(0);

    act(() => vi.advanceTimersByTime(REPLAY_MS / 2));
    // Half way: u0002 (the double-tap that drifts on Vibe Pay) has crossed.
    expect(percent('twin')).toBe(100);
    expect(percent('ossuary')).toBe(0);
    expect(screen.getByTestId('stage-twin-through')).toHaveTextContent('1');
    expect(screen.getByTestId('stage-ossuary-through')).toHaveTextContent('0');
    expect(screen.getByTestId('lane-twin').querySelector('[data-fate="escaped"]')).not.toBeNull();
    expect(screen.getByTestId('lane-ossuary').querySelector('[data-fate="escaped"]')).toBeNull();
    expect(onFinished).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();

    act(() => vi.advanceTimersByTime(REPLAY_MS));
    expect(screen.getByTestId('storm-stage')).toHaveAttribute('data-state', 'done');
    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Storm finished: drift 0.00 USDC on Ossuary, 0.00 USDC (lost 32.687968 USDC, conjured 32.687968 USDC) on Vibe Pay.',
    );
    expect(screen.getByTestId('stage-ossuary-buried')).toHaveTextContent('2');
  });

  it('with reduced motion there are no moving ghosts: the final state and the announcement come at once', () => {
    const onFinished = vi.fn();
    render(<StormStage running={false} phase={null} result={result} reduced onFinished={onFinished} />);
    expect(screen.getByTestId('storm-stage')).toHaveAttribute('data-state', 'done');
    expect(document.querySelectorAll('.sprite')).toHaveLength(0);
    expect(screen.getByTestId('lane-twin')).toHaveTextContent('👻 → 💸');
    expect(percent('twin')).toBe(100);
    expect(percent('ossuary')).toBe(0);
    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveTextContent(finishedText(result.ossuary, result.twin));
  });

  it('with reduced motion the running storm is a still picture too', () => {
    render(<StormStage running phase="twin" result={null} reduced onFinished={() => undefined} />);
    expect(document.querySelectorAll('.sprite')).toHaveLength(0);
    expect(screen.getByText('Ghosts are loose in Vibe Pay…')).toBeInTheDocument();
  });
});
