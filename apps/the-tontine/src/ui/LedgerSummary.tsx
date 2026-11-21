import { formatUsdc } from '../money';
import type { CircleView } from '../tontine/types';

/** The circle's books, all derived from ledger entries (Requirement 8.7). */
export function LedgerSummary({ view }: { view: CircleView }) {
  const balanced = view.moneyIn === view.moneyOut + view.pot;
  return (
    <section className="panel books" aria-labelledby="books-title">
      <h3 id="books-title">The books</h3>
      <dl className="books__list">
        <div>
          <dt>Money in</dt>
          <dd>{formatUsdc(view.moneyIn)}</dd>
        </div>
        <div>
          <dt>Paid out</dt>
          <dd>{formatUsdc(view.moneyOut)}</dd>
        </div>
        <div>
          <dt>In the pot</dt>
          <dd>{formatUsdc(view.pot)}</dd>
        </div>
        <div>
          <dt>Ledger sum</dt>
          <dd data-testid="ledger-sum">
            {formatUsdc(view.ledgerSum)}{' '}
            <span className={view.ledgerSum === 0n ? 'tag tag--ok' : 'tag tag--bad'}>{view.ledgerSum === 0n ? '✓ balanced' : '✗ unbalanced'}</span>
          </dd>
        </div>
      </dl>
      <p className="books__equation">
        {balanced ? '✓' : '✗'} In {formatUsdc(view.moneyIn, { code: false })} = out {formatUsdc(view.moneyOut, { code: false })} + pot{' '}
        {formatUsdc(view.pot, { code: false })} USDC. Every balance is a sum of ledger entries.
      </p>
    </section>
  );
}
