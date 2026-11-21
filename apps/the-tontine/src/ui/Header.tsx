import type { RefObject } from 'react';
import type { CircleSummary } from '../tontine/types';

export interface HeaderProps {
  circles: CircleSummary[];
  selected: string | null;
  creating: boolean;
  locked: boolean;
  resetButton: RefObject<HTMLButtonElement | null>;
  onSelect: (circleId: string) => void;
  onNew: () => void;
  onReset: () => void;
}

export function Header({ circles, selected, creating, locked, resetButton, onSelect, onNew, onReset }: HeaderProps) {
  return (
    <header className="masthead">
      <div className="masthead__title">
        <h1>
          <span aria-hidden="true" className="masthead__mark">
            🕯
          </span>{' '}
          The Tontine
        </h1>
        <p className="masthead__tagline">Tontines were banned for being deadly. We kept the good half.</p>
      </div>
      <nav className="masthead__tools" aria-label="Circles">
        {circles.length > 1 && !creating && (
          <div className="field field--inline">
            <label htmlFor="circle-select">Circle</label>
            <select id="circle-select" value={selected ?? ''} onChange={(e) => onSelect(e.target.value)} disabled={locked}>
              {circles.map((c) => (
                <option key={c.circleId} value={c.circleId}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {!creating && (
          <button type="button" className="btn" onClick={onNew} disabled={locked}>
            New circle
          </button>
        )}
        <button ref={resetButton} type="button" className="btn btn--quiet" onClick={onReset} disabled={locked}>
          Reset demo
        </button>
      </nav>
    </header>
  );
}
