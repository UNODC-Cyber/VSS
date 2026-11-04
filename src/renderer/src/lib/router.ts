import { useEffect, useState } from 'react';

export interface Route {
  path: string;
  segments: string[];
  query: URLSearchParams;
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, '') || '/';
  const [p = '/', q = ''] = raw.split('?');
  const path = p.startsWith('/') ? p : `/${p}`;
  return { path, segments: path.split('/').filter(Boolean), query: new URLSearchParams(q) };
}

export function navigate(to: string): void {
  const next = `#${to}`;
  if (window.location.hash === next) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else window.location.hash = next;
}

export function useRoute(): Route {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return parseHash(hash);
}

/**
 * Remove one query parameter from the current hash without adding a history entry (used after a one-shot anchor such
 * as `#/settings?card=backup` has been handled, so a later manual scroll is not undone). Re-fires hashchange so
 * `useRoute` follows.
 */
export function clearQueryParam(name: string): void {
  const route = parseHash(window.location.hash);
  if (!route.query.has(name)) return;
  route.query.delete(name);
  const q = route.query.toString();
  window.history.replaceState(window.history.state, '', `#${route.path}${q ? `?${q}` : ''}`);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}
