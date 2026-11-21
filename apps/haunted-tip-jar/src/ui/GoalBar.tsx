import { formatUsdcShort, goalPerMille } from '../money';

export function GoalBar({ held, goal }: { held: bigint; goal: bigint }) {
  const perMille = goalPerMille(held, goal);
  const text = `${formatUsdcShort(held)} of ${formatUsdcShort(goal)} USDC`;
  return (
    <section className="goal" aria-labelledby="goal-title">
      <h2 id="goal-title">Stream goal</h2>
      <div
        className="goal-track"
        role="progressbar"
        aria-labelledby="goal-title"
        aria-valuemin={0}
        aria-valuemax={1000}
        aria-valuenow={perMille}
        aria-valuetext={text}
      >
        {/* Width is a display ratio derived in bigint per-mille, never a money value. */}
        <div className="goal-fill" style={{ width: `${perMille / 10}%` }} />
      </div>
      <p className="goal-text" data-testid="goal-text">
        {text}
        {perMille >= 1000 ? ' · goal reached' : ''}
      </p>
    </section>
  );
}
