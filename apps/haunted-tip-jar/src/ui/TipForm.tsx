import { useRef, useState, type FormEvent } from 'react';
import type { TipJar } from '../jar';
import { formatUsdcShort, parseUsdc } from '../money';
import { useAnnounce } from './Announcer';

const newKey = () => globalThis.crypto.randomUUID();

/**
 * The viewer's tip form (Requirement 2). One Idempotency_Key per intended tip:
 * minted when the form is shown, reused by every press of Send (a double-tap
 * included), and replaced only after the rail accepts the tip.
 */
export function TipForm({ jar, onDone }: { jar: TipJar; onDone: () => void }) {
  const announce = useAnnounce();
  const key = useRef(newKey());
  const [viewer, setViewer] = useState('');
  const [amount, setAmount] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(0);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = parseUsdc(amount);
    if (!parsed.ok) return setError(parsed.error);
    if (viewer.trim() === '') return setError('Enter your name');
    setError(null);
    const sentKey = key.current;
    setBusy((n) => n + 1);
    try {
      const r = await jar.sendTip(sentKey, { viewer, amount: parsed.units, message });
      if (r.ok) {
        // Several presses may resolve; only the first moves on to a new key.
        if (key.current === sentKey) {
          key.current = newKey();
          setViewer('');
          setAmount('');
          setMessage('');
          announce(`Tip from ${viewer.trim()}: ${formatUsdcShort(parsed.units)} USDC`);
        }
      } else if (r.status === 409) {
        key.current = newKey();
        setError('The tip changed while it was sending. Check it and press Send again.');
      } else {
        setError(r.error);
      }
    } finally {
      setBusy((n) => n - 1);
      onDone();
    }
  }

  return (
    <form className="card tip-form" onSubmit={submit} aria-labelledby="tip-title" noValidate>
      <h2 id="tip-title">Send a tip</h2>
      <label>
        Your name
        <input value={viewer} onChange={(e) => setViewer(e.target.value)} maxLength={40} autoComplete="nickname" required />
      </label>
      <label>
        Amount (USDC)
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          inputMode="decimal"
          placeholder="5.00"
          aria-describedby="amount-hint"
          required
        />
      </label>
      <small id="amount-hint">Fake testnet USDC, up to 6 decimals.</small>
      <label>
        Message
        <textarea value={message} onChange={(e) => setMessage(e.target.value)} maxLength={140} rows={2} />
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" aria-busy={busy > 0}>
        {busy > 0 ? 'Sending…' : 'Send tip 👻'}
      </button>
    </form>
  );
}
