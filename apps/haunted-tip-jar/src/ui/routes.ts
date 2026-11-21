import { useEffect, useState } from 'react';

export type Route = 'jar' | 'overlay' | 'coffin' | 'poltergeist';

export function parseRoute(hash: string): Route {
  const h = hash.replace(/^#\/?/, '').split(/[?/]/)[0];
  return h === 'overlay' || h === 'coffin' || h === 'poltergeist' ? h : 'jar';
}

export const hrefFor = (r: Route): string => (r === 'jar' ? '#/' : `#/${r}`);

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}
