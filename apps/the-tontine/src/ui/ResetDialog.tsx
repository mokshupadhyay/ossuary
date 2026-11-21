import { useEffect, useRef, type KeyboardEvent } from 'react';

export interface ResetDialogProps {
  open: boolean;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Confirms the reset (Requirements 11.2, 11.3, 12.6): focus moves to Cancel,
 * Tab stays inside, Escape cancels. The opener returns focus to Reset.
 */
export function ResetDialog({ open, busy, onCancel, onConfirm }: ResetDialogProps) {
  const cancel = useRef<HTMLButtonElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) cancel.current?.focus();
  }, [open]);

  if (!open) return null;

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !busy) {
      e.preventDefault();
      onCancel();
    } else if (e.key === 'Tab') {
      // Two buttons: keep focus on them.
      const first = cancel.current;
      const last = confirm.current;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    }
  };

  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="reset-title" aria-describedby="reset-body" onKeyDown={onKeyDown}>
        <h2 id="reset-title">Reset the demo?</h2>
        <p id="reset-body">
          This deletes every circle and its whole ledger from this browser, then lays the table again with The Midnight Circle. It cannot be undone.
        </p>
        <div className="actions">
          <button ref={cancel} type="button" className="btn" onClick={onCancel} disabled={busy}>
            Keep my circles
          </button>
          <button ref={confirm} type="button" className="btn btn--danger" onClick={onConfirm} disabled={busy}>
            {busy ? 'Resetting…' : 'Delete and reset'}
          </button>
        </div>
      </div>
    </div>
  );
}
