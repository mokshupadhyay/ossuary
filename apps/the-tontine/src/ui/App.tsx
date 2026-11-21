import { useCallback, useEffect, useRef, useState } from 'react';
import { formatUsdc } from '../money';
import { OtherTabError, type Runtime, type Session } from '../runtime/runtime';
import { runSeance, type SeancePhase, type SeanceResult, type StormSize } from '../tontine/seance';
import type { CreateCircleInput } from '../tontine/service';
import { TontineError, type CircleSummary, type CircleView } from '../tontine/types';
import { CircleTable, dueBusyKey, type Flight } from './CircleTable';
import { CreateCircleForm } from './CreateCircleForm';
import { Header } from './Header';
import { LedgerSummary } from './LedgerSummary';
import { PoltergeistPanel } from './PoltergeistPanel';
import { ResetDialog } from './ResetDialog';
import { RoundPanel } from './RoundPanel';
import { Timeline } from './Timeline';
import { useReducedMotion } from './useReducedMotion';

type Fatal = { kind: 'other-tab' | 'error'; message: string };
type Notice = { text: string; tone: 'ok' | 'error' };
interface SeanceState {
  running: boolean;
  phase: SeancePhase | null;
  result: SeanceResult | null;
  error: string | null;
}

const FLIGHT_MS = 1200;
const errorText = (e: unknown) => (e instanceof TontineError ? e.message : `Something went wrong: ${e instanceof Error ? e.message : String(e)}`);

export function App({ runtime }: { runtime: Runtime }) {
  const opening = useRef<Promise<Session> | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [fatal, setFatal] = useState<Fatal | null>(null);
  const [circles, setCircles] = useState<CircleSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<CircleView | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<Notice | null>(null);
  const [creating, setCreating] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [flight, setFlight] = useState<Flight | null>(null);
  const [seance, setSeance] = useState<SeanceState>({ running: false, phase: null, result: null, error: null });
  const resetButton = useRef<HTMLButtonElement>(null);
  const flightId = useRef(0);
  const reducedMotion = useReducedMotion();

  const announce = (text: string, tone: Notice['tone'] = 'ok') => setNotice({ text, tone });

  const load = useCallback(async (s: Session, prefer?: string | null) => {
    const list = await s.service.listCircles();
    const id = prefer && list.some((c) => c.circleId === prefer) ? prefer : (list[0]?.circleId ?? null);
    setCircles(list);
    setSelected(id);
    setView(id === null ? null : await s.service.view(id));
  }, []);

  const adopt = useCallback(
    async (s: Session, prefer?: string | null) => {
      sessionRef.current = s;
      setSession(s);
      setFatal(null);
      await load(s, prefer);
    },
    [load],
  );

  useEffect(() => {
    // Open once, even when React runs effects twice in development.
    if (opening.current) return;
    opening.current = runtime.open();
    opening.current.then(
      (s) => adopt(s),
      (e: unknown) =>
        setFatal(e instanceof OtherTabError ? { kind: 'other-tab', message: e.message } : { kind: 'error', message: e instanceof Error ? e.message : String(e) }),
    );
  }, [runtime, adopt]);

  useEffect(() => {
    if (!flight) return undefined;
    const t = setTimeout(() => setFlight(null), FLIGHT_MS);
    return () => clearTimeout(t);
  }, [flight]);

  /** Runs an action under a busy key, announces failures, and reloads the view from the ledger. */
  const run = async (key: string, action: (s: Session) => Promise<void>) => {
    const s = sessionRef.current;
    if (!s) return;
    setBusy((b) => new Set(b).add(key));
    try {
      await action(s);
    } catch (e) {
      announce(errorText(e), 'error');
    } finally {
      setBusy((b) => {
        const next = new Set(b);
        next.delete(key);
        return next;
      });
      await load(s, selected).catch((e: unknown) => announce(errorText(e), 'error'));
    }
  };

  const onContribute = (position: number) => {
    if (!view || view.currentRound === null) return;
    const round = view.currentRound;
    const member = view.members.find((m) => m.position === position);
    void run(dueBusyKey(round, position), async (s) => {
      const r = await s.service.contribute(view.circleId, round, position);
      announce(
        r.outcome === 'applied'
          ? `${member?.name}’s ${formatUsdc(view.contribution)} is in the pot. Their candle is lit.`
          : `${member?.name}’s round ${round} payment was already recorded under the same key. Nothing changed.`,
      );
    });
  };

  const onMarkLate = (position: number) => {
    if (!view || view.currentRound === null) return;
    const round = view.currentRound;
    const member = view.members.find((m) => m.position === position);
    void run(`missed:${round}:${position}`, async (s) => {
      const r = await s.service.markMissed(view.circleId, round, position);
      announce(r.changed ? `${member?.name} is marked late. Their candle gutters, and the circle waits.` : `${member?.name} was already marked late.`);
    });
  };

  const onPayout = (round: number) => {
    if (!view) return;
    const recipient = view.members.find((m) => m.position === view.recipientPosition);
    void run(`payout:${round}`, async (s) => {
      const r = await s.service.payout(view.circleId, round);
      if (r.replayed) {
        announce(`Round ${round} was already paid out under the same key. Nothing changed.`);
        return;
      }
      if (recipient) {
        flightId.current += 1;
        setFlight({ id: flightId.current, position: recipient.position, amount: view.potPerRound });
      }
      announce(`${recipient?.name} received the pot: ${formatUsdc(view.potPerRound)}.`);
    });
  };

  const onCreate = async (input: CreateCircleInput) => {
    const s = sessionRef.current;
    if (!s) return;
    setBusy((b) => new Set(b).add('create'));
    try {
      const id = await s.service.createCircle(input);
      setCreating(false);
      await load(s, id);
      announce(`${input.name.trim()} is set. The candles are waiting for round 1.`);
    } finally {
      setBusy((b) => {
        const next = new Set(b);
        next.delete('create');
        return next;
      });
    }
  };

  const onSummon = (seed: number, size: StormSize) => {
    const s = sessionRef.current;
    if (!s) return;
    setSeance({ running: true, phase: null, result: null, error: null });
    announce(`Summoning the poltergeist: seed ${seed}, ${size} events.`);
    runSeance(s.service, selected, { seed, size, onPhase: (phase) => setSeance((st) => ({ ...st, phase })) })
      .then((result) => {
        setSeance({ running: false, phase: null, result, error: null });
        announce(
          `The poltergeist is gone. Ossuary drift ${formatUsdc(BigInt(result.ossuary.drift.total))}; Vibe Pay drift ${formatUsdc(BigInt(result.twin.drift.total))}.`,
        );
      })
      .catch((e: unknown) => {
        const message = e instanceof Error ? e.message : String(e);
        setSeance({ running: false, phase: null, result: null, error: message });
        announce(`The séance failed: ${message}`, 'error');
      })
      .finally(() => void load(s, selected).catch(() => undefined));
  };

  // Focus returns to Reset after the render that re-enables it (Requirement 12.6).
  const [focusReset, setFocusReset] = useState(0);
  useEffect(() => {
    if (focusReset > 0) resetButton.current?.focus();
  }, [focusReset]);
  const closeReset = () => {
    setResetOpen(false);
    setFocusReset((n) => n + 1);
  };

  const onConfirmReset = async () => {
    setBusy((b) => new Set(b).add('reset'));
    try {
      const next = await runtime.reset(sessionRef.current);
      setCreating(false);
      setSeance({ running: false, phase: null, result: null, error: null });
      await adopt(next, null);
      announce('The table is laid again with The Midnight Circle.');
    } catch (e) {
      announce(errorText(e), 'error');
    } finally {
      setBusy((b) => {
        const next = new Set(b);
        next.delete('reset');
        return next;
      });
      closeReset();
    }
  };

  const liveRegion = (
    <div className={`whisper${notice?.tone === 'error' ? ' whisper--error' : ''}`} role="status" aria-live="polite" data-testid="announcer">
      {notice && (
        <>
          <span aria-hidden="true">{notice.tone === 'error' ? '⚠ ' : '🕯 '}</span>
          {notice.text}
        </>
      )}
    </div>
  );

  if (fatal) {
    return (
      <div className="app">
        <main id="main" className="fatal">
          <h1>The Tontine</h1>
          <p>{fatal.message}</p>
          {fatal.kind === 'error' && (
            <button
              type="button"
              className="btn"
              onClick={() => {
                runtime.reset(null).then(
                  (s) => adopt(s),
                  (e: unknown) => setFatal({ kind: 'error', message: e instanceof Error ? e.message : String(e) }),
                );
              }}
            >
              Reset the demo database
            </button>
          )}
        </main>
      </div>
    );
  }

  const locked = seance.running || busy.has('reset');
  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to the table
      </a>
      <Header
        circles={circles}
        selected={selected}
        creating={creating}
        locked={locked || session === null}
        resetButton={resetButton}
        onSelect={(id) => session && void load(session, id)}
        onNew={() => setCreating(true)}
        onReset={() => setResetOpen(true)}
      />
      <main id="main" tabIndex={-1}>
        {session === null ? (
          <p className="loading">Lighting the candles… (starting Postgres in your browser)</p>
        ) : creating || view === null ? (
          <CreateCircleForm busy={busy.has('create')} onCreate={onCreate} onCancel={view ? () => setCreating(false) : undefined} />
        ) : (
          <>
            <section className="circle" aria-labelledby="circle-title">
              <div className="circle__heading">
                <h2 id="circle-title">{view.name}</h2>
                <p className="muted">
                  {view.members.length} members · {formatUsdc(view.contribution)} each round · {view.rounds} rounds
                </p>
              </div>
              <CircleTable
                view={view}
                busy={busy}
                locked={locked}
                flight={flight}
                reducedMotion={reducedMotion}
                onContribute={onContribute}
                onMarkLate={onMarkLate}
              />
              <div className="circle__panels">
                <RoundPanel view={view} busy={view.currentRound !== null && busy.has(`payout:${view.currentRound}`)} locked={locked} onPayout={onPayout} />
                <LedgerSummary view={view} />
              </div>
            </section>
            <PoltergeistPanel
              running={seance.running}
              phase={seance.phase}
              result={seance.result}
              error={seance.error}
              disabled={locked && !seance.running}
              onSummon={onSummon}
            />
            <Timeline view={view} />
          </>
        )}
      </main>
      <footer className="colophon">
        <p>
          Testnet-style USDC only: no real money, no chain, no bank. Every cent moves through the Ossuary skeleton (<code>packages/core</code>): contributions
          arrive as signed webhooks, payouts carry idempotency keys, receipts leave through the outbox, and the ledger is Postgres running in this tab.
        </p>
      </footer>
      {liveRegion}
      <ResetDialog open={resetOpen} busy={busy.has('reset')} onCancel={closeReset} onConfirm={() => void onConfirmReset()} />
    </div>
  );
}
