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
