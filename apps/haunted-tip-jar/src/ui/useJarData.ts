import { useCallback, useEffect, useRef, useState } from 'react';
import type { TipJar } from '../jar';
import type { CoffinReport, DeliveryRow, TipView } from '../readModel';

export interface JarData {
  tips: TipView[];
  coffin: CoffinReport;
  deliveries: DeliveryRow[];
}

/**
 * Loads the jar's read model and keeps it fresh: after every action
 * (`refresh`), and on an interval that also drains the outbox to the overlay.
 */
export function useJarData(jar: TipJar, options: { intervalMs?: number } = {}) {
  const [data, setData] = useState<JarData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const running = useRef<Promise<void> | null>(null);
  const again = useRef(false);

  const refresh = useCallback(async () => {
    // Coalesce overlapping refreshes: one in flight, at most one queued.
    if (running.current) {
      again.current = true;
      return running.current;
    }
    const run = (async () => {
      do {
        again.current = false;
        try {
          await jar.drainOutbox();
          const [tips, coffin, deliveries] = await Promise.all([jar.tips(), jar.coffin(), jar.deliveries(20)]);
          setData({ tips, coffin, deliveries });
          setError(null);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      } while (again.current);
    })();
    running.current = run;
    try {
      await run;
    } finally {
      running.current = null;
    }
  }, [jar]);

  useEffect(() => {
    setData(null);
    void refresh();
    const ms = options.intervalMs ?? 1500;
    if (ms <= 0) return;
    const t = setInterval(() => void refresh(), ms);
    return () => clearInterval(t);
  }, [jar, refresh, options.intervalMs]);

  return { data, error, refresh };
}
