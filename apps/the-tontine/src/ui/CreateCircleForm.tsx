import { useId, useRef, useState, type FormEvent } from 'react';
import { MoneyInputError, parseUsdc } from '../money';
import { circleInputErrors, MAX_MEMBERS, MIN_MEMBERS, type CreateCircleInput } from '../tontine/service';

export interface CreateCircleFormProps {
  busy: boolean;
  onCreate: (input: CreateCircleInput) => Promise<void>;
  onCancel?: () => void;
}

type Errors = Partial<Record<string, string>>;

/** Validates every field with the service's own rules, so the user sees all problems at once (Requirement 3.3). */
function check(name: string, members: string[], contribution: string): { errors: Errors; input?: CreateCircleInput } {
  const errors: Errors = {};
  let amount: bigint | undefined;
  try {
    amount = parseUsdc(contribution);
  } catch (e) {
    errors['contribution'] = e instanceof MoneyInputError ? e.reason : 'Enter an amount.';
  }
  for (const e of circleInputErrors({ name, members, contribution: amount ?? 1n })) errors[e.field] ??= e.message;
  if (Object.keys(errors).length > 0 || amount === undefined) return { errors };
  return { errors, input: { name, members, contribution: amount } };
}

export function CreateCircleForm({ busy, onCreate, onCancel }: CreateCircleFormProps) {
  const id = useId();
  const [name, setName] = useState('');
  const [members, setMembers] = useState<string[]>(['', '', '']);
  const [contribution, setContribution] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const form = useRef<HTMLFormElement>(null);

  const fieldId = (f: string) => `${id}-${f}`;
  const errorId = (f: string) => `${id}-${f}-error`;
  const described = (f: string) => (errors[f] ? { 'aria-invalid': true as const, 'aria-describedby': errorId(f) } : {});
  const ErrorText = ({ field }: { field: string }) =>
    errors[field] ? (
      <p id={errorId(field)} className="field__error">
        <span aria-hidden="true">⚠ </span>
        {errors[field]}
      </p>
    ) : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setFailure(null);
    const { errors: next, input } = check(name, members, contribution);
    setErrors(next);
    if (!input) {
      // Focus the first invalid field, in form order (Requirement 3.3).
      const order = ['name', ...members.map((_, i) => `member-${i}`), 'members', 'contribution'];
      const first = order.find((f) => next[f]);
      if (first) {
        const target = first === 'members' ? fieldId('member-0') : fieldId(first);
        queueMicrotask(() => (form.current?.querySelector(`#${CSS.escape(target)}`) as HTMLElement | null)?.focus());
      }
      return;
    }
    try {
      await onCreate(input);
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section className="panel create" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>Start a new circle</h2>
      <p className="muted">
        Each member pays the same amount every round. Each round the whole pot goes to one member, in the order you list them, until everyone has
        received it once.
      </p>
      <form ref={form} onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor={fieldId('name')}>Circle name</label>
          <input id={fieldId('name')} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="off" {...described('name')} />
          <ErrorText field="name" />
        </div>

        <fieldset className="field members" aria-describedby={errors['members'] ? errorId('members') : undefined}>
          <legend>
            Members, in payout order ({MIN_MEMBERS}–{MAX_MEMBERS})
          </legend>
          <ol>
            {members.map((m, i) => (
              <li key={i} className="member-row">
                <label htmlFor={fieldId(`member-${i}`)}>Member {i + 1}</label>
                <input
                  id={fieldId(`member-${i}`)}
                  value={m}
                  autoComplete="off"
                  maxLength={60}
                  onChange={(e) => setMembers((ms) => ms.map((x, j) => (j === i ? e.target.value : x)))}
                  {...described(`member-${i}`)}
                />
                {members.length > MIN_MEMBERS && (
                  <button type="button" className="btn btn--small btn--quiet" onClick={() => setMembers((ms) => ms.filter((_, j) => j !== i))}>
                    Remove <span className="sr-only">member {i + 1}</span>
                  </button>
                )}
                <ErrorText field={`member-${i}`} />
              </li>
            ))}
          </ol>
          <ErrorText field="members" />
          <button type="button" className="btn btn--small" disabled={members.length >= MAX_MEMBERS} onClick={() => setMembers((ms) => [...ms, ''])}>
            Add a member
          </button>
        </fieldset>

        <div className="field">
          <label htmlFor={fieldId('contribution')}>Contribution per round</label>
          <div className="input-suffix">
            <input
              id={fieldId('contribution')}
              value={contribution}
              inputMode="decimal"
              autoComplete="off"
              placeholder="50"
              onChange={(e) => setContribution(e.target.value)}
              {...described('contribution')}
            />
            <span aria-hidden="true">USDC</span>
          </div>
          <p className="field__hint">Testnet-style USDC, up to 6 decimal places.</p>
          <ErrorText field="contribution" />
        </div>

        <p className="field">
          <span className="field__label">Rounds</span>{' '}
          <output htmlFor={fieldId('member-0')} data-testid="rounds">
            {members.length}
          </output>{' '}
          <span className="muted">— one per member, so each member receives the pot once.</span>
        </p>

        {failure && (
          <p className="field__error" role="alert">
            {failure}
          </p>
        )}
        <div className="actions">
          <button type="submit" className="btn btn--primary" disabled={busy}>
            {busy ? 'Lighting the candles…' : 'Light the candles'}
          </button>
          {onCancel && (
            <button type="button" className="btn btn--quiet" onClick={onCancel}>
              Cancel
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
