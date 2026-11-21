import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

/** A polite live region (Requirement 8.5). Children call `announce(text)`. */
const Ctx = createContext<(text: string) => void>(() => {});

export function Announcer({ children }: { children: ReactNode }) {
  const [text, setText] = useState('');
  const announce = useCallback((t: string) => {
    // Clear first so the same message twice is still read out.
    setText('');
    queueMicrotask(() => setText(t));
  }, []);
  return (
    <Ctx.Provider value={announce}>
      {children}
      <div className="sr-only" role="status" aria-live="polite" data-testid="announcer">
        {text}
      </div>
    </Ctx.Provider>
  );
}

export const useAnnounce = () => useContext(Ctx);
