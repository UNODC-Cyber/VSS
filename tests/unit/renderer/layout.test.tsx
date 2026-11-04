// @vitest-environment jsdom
import { mock, ui } from './helpers';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuditScreen } from '../../../src/renderer/src/screens/AuditScreen';
import { DashboardScreen } from '../../../src/renderer/src/screens/DashboardScreen';
import { ImportRequestScreen } from '../../../src/renderer/src/screens/ImportRequestScreen';
import { PeopleScreen } from '../../../src/renderer/src/screens/people/PeopleScreen';
import { PersonDetailScreen } from '../../../src/renderer/src/screens/people/PersonDetailScreen';
import { RequestDetailScreen } from '../../../src/renderer/src/screens/RequestDetailScreen';
import { RequestsScreen } from '../../../src/renderer/src/screens/RequestsScreen';
import { ImportResponseScreen, ResponsesScreen } from '../../../src/renderer/src/screens/ResponsesScreens';
import { ReviewScreen } from '../../../src/renderer/src/screens/review/ReviewListScreen';
import { SearchScreen } from '../../../src/renderer/src/screens/SearchScreen';
import { SettingsScreen } from '../../../src/renderer/src/screens/SettingsScreen';
import { UnitsScreen } from '../../../src/renderer/src/screens/UnitsScreens';

/**
 * Layout smoke test (docs/PLAN-ALPHA.md section 10): every screen at 1024 px (jsdom has no layout, so the width is a
 * stub) renders its tables through the fixed-layout engine, and no column is both unbounded and free to spill:
 * every <col> carries a pixel width or minimum, and no table cell may use the old auto layout.
 */
beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1024 });
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 1024 });
});

function assertBounded(): number {
  const tables = Array.from(document.querySelectorAll('table'));
  for (const table of tables) {
    const name = table.querySelector('caption')?.textContent ?? '(no caption)';
    expect(table.getAttribute('data-layout'), `${name} uses the fixed layout`).toBe('fixed');
    const cols = Array.from(table.querySelectorAll('colgroup > col')) as HTMLElement[];
    expect(cols.length, `${name} has a colgroup`).toBeGreaterThan(0);
    for (const c of cols) {
      const bounded = c.style.width !== '' || c.style.minWidth !== '';
      expect(bounded, `${name}: a column has neither width nor minimum`).toBe(true);
    }
    // Every table scrolls inside its own keyboard-reachable region, never the page.
    expect(table.closest('[role="region"]'), `${name} sits in a scroll region`).not.toBeNull();
  }
  return tables.length;
}

const SCREENS: [string, () => ReactElement, () => Promise<unknown>][] = [
  ['Requests', () => <RequestsScreen />, () => screen.findByRole('link', { name: 'Regional Cyber Workshop' })],
  ['People', () => <PeopleScreen />, () => screen.findByText('8 people')],
  ['Units', () => <UnitsScreen />, () => screen.findByRole('table')],
  ['Review list', () => <ReviewScreen />, () => screen.findByRole('table')],
  ['Responses', () => <ResponsesScreen />, () => screen.findByRole('table')],
  ['Audit', () => <AuditScreen />, () => screen.findByRole('table')],
  ['Dashboard', () => <DashboardScreen />, () => screen.findByTestId('stat-outstanding')],
  ['Search', () => <SearchScreen initial="Alder" />, () => screen.findAllByRole('table')],
  ['Settings', () => <SettingsScreen />, () => screen.findByRole('heading', { name: 'Settings' })],
];

describe('layout at 1024 px', () => {
  for (const [name, el, ready] of SCREENS) {
    it(`${name}: tables use the bounded fixed layout`, async () => {
      mock();
      ui(el());
      await ready();
      assertBounded();
    });
  }

  it('Request detail items and Person detail tables are bounded', async () => {
    const ctl = mock();
    const req = ctl.db.requests.find((r) => r.eventName === 'Regional Cyber Workshop')!;
    const view = ui(<RequestDetailScreen id={req.id} />);
    await screen.findByRole('table', { name: 'Individuals on this request' });
    expect(assertBounded()).toBeGreaterThan(0);
    view.unmount();
    ui(<PersonDetailScreen id={ctl.db.persons[0]!.id} />);
    await screen.findByRole('heading', { name: 'Linked requests' });
    assertBounded();
  });

  it('Request import preview is bounded and only the active wizard step is shown', async () => {
    mock();
    const user = userEvent.setup();
    ui(<ImportRequestScreen />);
    await user.click(screen.getByRole('button', { name: 'Choose file' }));
    await user.click(await screen.findByRole('button', { name: 'Next' }));
    await screen.findByRole('table', { name: 'Rows in the file' });
    expect(assertBounded()).toBe(1);
  });

  it('Response import rows are bounded', async () => {
    const ctl = mock();
    const user = userEvent.setup();
    const req = ctl.db.requests.find((r) => r.eventName === 'Regional Cyber Workshop')!;
    ui(<ImportResponseScreen requestId={req.id} />);
    await user.click(screen.getByRole('button', { name: 'Choose file' }));
    await user.click(await screen.findByRole('button', { name: 'Next' }));
    await user.click(await screen.findByRole('button', { name: 'Next' }));
    await screen.findByRole('table', { name: 'Rows in the response' });
    await waitFor(() => expect(assertBounded()).toBe(1));
    // The disposition class is a visible text label on every row.
    expect(document.querySelectorAll('[data-disp]').length).toBeGreaterThan(0);
  });
});
