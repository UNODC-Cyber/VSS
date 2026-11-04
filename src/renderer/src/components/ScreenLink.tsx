/**
 * A link inside an inline message that names another screen (docs/PLAN-ALPHA.md section 6, R14). It is a plain
 * hash-route anchor, so it works from any screen, with the keyboard and without JavaScript state. Use it through
 * `<Trans i18nKey="..." components={{ screen: <ScreenLink to="/settings?card=backup" /> }} />` so the sentence stays
 * ONE translatable string with a `<screen>text</screen>` tag (not `<link>`: it is an HTML void element and loses its children).
 */
import { Anchor } from '@mantine/core';
import type { ReactNode } from 'react';

export function ScreenLink({ to, children }: { to: string; children?: ReactNode }) {
  return (
    <Anchor href={`#${to}`} data-screen-link={to} c="inherit" underline="always" fw={600}>
      {children}
    </Anchor>
  );
}
