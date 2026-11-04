import { useEffect } from 'react';
import { clearQueryParam, useRoute } from '../lib/router';

/** Settings cards that screen links may point at: `#/settings?card=<name>` targets the element `card-<name>`. */
export const SETTINGS_CARDS = [
  'backup',
  'templates',
  'updates',
  'password',
  'email-templates',
  'authority',
  'appearance',
] as const;

/**
 * Handles `?card=<name>` on the current route: scrolls the element `id="card-<name>"` into view, moves focus to its
 * heading (made focusable with tabIndex -1) and removes the parameter so a later manual scroll is not undone.
 * Runs on mount and whenever the hash changes, so it works from any screen.
 */
export function useCardAnchor(known: readonly string[] = SETTINGS_CARDS): void {
  const card = useRoute().query.get('card');
  useEffect(() => {
    if (!card) return;
    const el = known.includes(card) ? document.getElementById(`card-${card}`) : null;
    if (el) {
      el.scrollIntoView({ block: 'start' });
      const target = el.querySelector<HTMLElement>('h1, h2, h3, h4, h5, h6') ?? el;
      if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
    }
    clearQueryParam('card');
  }, [card, known]);
}
