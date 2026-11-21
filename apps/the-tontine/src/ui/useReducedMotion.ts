import { useEffect, useState } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

function matches(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(QUERY).matches;
}

/** True when the user asked the system for less motion (Requirement 8.6). */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const m = window.matchMedia(QUERY);
    const onChange = () => setReduced(m.matches);
    m.addEventListener?.('change', onChange);
    return () => m.removeEventListener?.('change', onChange);
  }, []);
  return reduced;
}
