/**
 * UI audit harness (docs/PLAN-ALPHA.md section 11, lane H). Drives the BUILT app (`out/`, run `npm run build` first)
 * through Playwright `_electron` (the packaged exe cannot be driven over CDP since F-10), once per viewport profile,
 * in light and dark, against the synthetic demo dataset (fixtures/demo, seeded by tools/demo/seed.ts) and against an
 * empty vault. Output (never in the repo): <out>/<timestamp>/<viewport>/<theme>__<screen>.png, one axe-core JSON per
 * screen and an index.json. A failing screen is logged and the run continues.
 *
 * Run: npm run ui-audit  (VSS_UI_AUDIT_OUT overrides the output root, VSS_UI_AUDIT_ONLY=<viewport id,...> and
 * VSS_UI_AUDIT_SCREENS=<name part,...> limit it).
 * Windows are positioned off-screen and never focused; the harness only touches windows it launched itself.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import type { ElectronApplication, Page } from 'playwright';
import { describe, it } from 'vitest';

// AxeBuilder needs browserContext.newPage(), which Electron does not support: inject axe-core and run it in-page.
const AXE_SOURCE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
type AxeViolation = { id: string; impact?: string | null; nodes: unknown[] };
async function runAxe(page: Page): Promise<{ violations: AxeViolation[]; incompleteContrast: number }> {
  const has = await page.evaluate(() => 'axe' in window);
  if (!has) await page.evaluate(AXE_SOURCE);
  return page.evaluate(async () => {
    const a = (
      window as unknown as {
        axe: { run(): Promise<{ violations: AxeViolation[]; incomplete: AxeViolation[] }> };
      }
    ).axe;
    const r = await a.run();
    const inc = r.incomplete.find((v) => v.id === 'color-contrast');
    return { violations: r.violations, incompleteContrast: inc ? inc.nodes.length : 0 };
  });
}

const PW = 'ui audit synthetic password 1';
const VIEWPORTS = [
  { id: '1024x720', w: 1024, h: 720, dsf: 1 },
  { id: '1280x720', w: 1280, h: 720, dsf: 1 },
  { id: '1366x768', w: 1366, h: 768, dsf: 1 },
  { id: '1920x1080', w: 1920, h: 1080, dsf: 1 },
  // CSS px = physical / Windows scale. 1920x1080 panel at 150 % (the owner's laptop) = 1280x720 CSS px rendered at 1.5x
  // pixel density (PNGs are 1920x1080); 1920x1080 at 125 % = 1536x864 CSS px. A 1280x720 panel at 150 % would be
  // 853x480 CSS px, below the app's minimum window size, so it is not a supported profile.
  { id: '1280x720@1.5', w: 1280, h: 720, dsf: 1.5 },
  { id: '1536x864@1.25', w: 1536, h: 864, dsf: 1.25 },
] as const;
const THEMES = ['light', 'dark'] as const;
type Theme = (typeof THEMES)[number];
type Viewport = (typeof VIEWPORTS)[number];

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT_ROOT = join(process.env['VSS_UI_AUDIT_OUT'] ?? join(process.env['TEMP'] ?? tmpdir(), 'vss-ui-audit'), stamp);
const only = (process.env['VSS_UI_AUDIT_ONLY'] ?? '').split(',').filter(Boolean);
// VSS_UI_AUDIT_SCREENS=<substring,...>: still drive every screen, but capture only those whose name contains one.
const onlyScreens = (process.env['VSS_UI_AUDIT_SCREENS'] ?? '').split(',').filter(Boolean);
const fx = (p: string) => resolve('fixtures', p);
// VSS_UI_AUDIT_CHANNEL=alpha (set by tools/ui-audit-alpha.mjs after an alpha build): also capture the alpha-only
// affordances, and fail loudly if the bundle is not an alpha build.
const ALPHA = process.env['VSS_UI_AUDIT_CHANNEL'] === 'alpha';

interface Entry {
  viewport: string;
  theme: Theme;
  screen: string;
  data: 'seeded' | 'empty';
  png: string | null;
  axe: string | null;
  axeViolations: { id: string; impact: string | null; nodes: number }[];
  pageScroll: number | null;
  spill: string[];
  /** Tables whose scroll box is wider than the view (`clipped`), with the columns the table dropped on its own. */
  tables: { id: string; scrollWidth: number; clientWidth: number; clipped: boolean; dropped: string[] }[];
  /** Header cells whose text is cut. */
  cutHeaders: string[];
  /** axe colour-contrast nodes it could not decide (text on images, gradients): review by eye. */
  incompleteContrast: number;
  pages: number;
  status: 'ok' | 'failed';
  error?: string;
}
const index: { generated: string; outDir: string; entries: Entry[]; failures: string[] } = {
  generated: new Date().toISOString(),
  outDir: OUT_ROOT,
  entries: [],
  failures: [],
};
const flushIndex = () => {
  mkdirSync(OUT_ROOT, { recursive: true });
  writeFileSync(join(OUT_ROOT, 'index.json'), JSON.stringify(index, null, 2));
};

type R = { ok: boolean; value?: any; error?: { code: string } }; // eslint-disable-line @typescript-eslint/no-explicit-any
const api = (page: Page, ns: string, method: string, arg?: unknown): Promise<R> =>
  page.evaluate(
    ([n, m, a]) =>
      (window.vss as unknown as Record<string, Record<string, (x?: unknown) => Promise<R>>>)[n as string]![
        m as string
      ]!(a),
    [ns, method, arg] as const,
  );
const val = async (p: Promise<R>) => {
  const r = await p;
  if (!r.ok) throw new Error(`api ${r.error?.code}`);
  return r.value;
};

async function launch(dataDir: string, vp: Viewport, seed: boolean): Promise<{ app: ElectronApplication; page: Page }> {
  const env = { ...process.env, VSS_DATA_DIR: dataDir } as Record<string, string>;
  delete env['ELECTRON_RUN_AS_NODE'];
  delete env['ELECTRON_RENDERER_URL'];
  if (seed) env['VSS_DEMO_SEED'] = PW;
  else delete env['VSS_DEMO_SEED'];
  const app = await electron.launch({
    args: [
      resolve('.'),
      `--force-device-scale-factor=${vp.dsf}`,
      '--disable-backgrounding-occluded-windows',
      '--disable-features=CalculateNativeWinOcclusion',
      '--disable-renderer-backgrounding',
    ],
    env,
  });
  await app.evaluate(({ powerMonitor }) => {
    powerMonitor.getSystemIdleTime = () => 0;
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  await app.evaluate(({ BrowserWindow }, v) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    win.setMinimumSize(100, 100);
    win.setContentSize(v.w, v.h);
    win.setPosition(-v.w - 200, 100); // off every monitor; never focused
  }, vp);
  await page.waitForSelector('html[data-vault-state]:not([data-vault-state="booting"])', {
    state: 'attached',
    timeout: 60_000,
  });
  return { app, page };
}

async function stubDialog(app: ElectronApplication, path: string | null): Promise<void> {
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (async () =>
      p ? { canceled: false, filePaths: [p] } : { canceled: true, filePaths: [] }) as typeof dialog.showOpenDialog;
    dialog.showSaveDialog = (async () =>
      p ? { canceled: false, filePath: p } : { canceled: true }) as typeof dialog.showSaveDialog;
  }, path);
}

async function setTheme(page: Page, theme: Theme): Promise<void> {
  await page.evaluate((t) => {
    try {
      localStorage.setItem('mantine-color-scheme-value', t);
    } catch {
      /* storage unavailable */
    }
    document.documentElement.setAttribute('data-mantine-color-scheme', t);
  }, theme);
  await page.waitForTimeout(150);
}

class Run {
  theme: Theme = 'light';
  constructor(
    readonly vp: Viewport,
    readonly data: 'seeded' | 'empty',
    readonly page: Page,
    readonly dir: string,
  ) {}

  /** Escape only while a dialog is open (Escape on a wizard page itself would open its discard dialog). */
  async closeDialogs(): Promise<void> {
    for (let i = 0; i < 3; i++) {
      if (
        !(await this.page
          .getByRole('dialog')
          .first()
          .isVisible()
          .catch(() => false))
      )
        return;
      await this.page.keyboard.press('Escape').catch(() => undefined);
      await this.page.waitForTimeout(250);
    }
  }

  async go(hash: string): Promise<void> {
    await this.closeDialogs();
    await this.page.evaluate((h) => {
      window.location.hash = h;
    }, hash);
    await this.page.waitForTimeout(500);
    // Every screen is captured from its top (R3S-13: the audit page opened scrolled to the bottom).
    await this.page.evaluate(() => {
      document.scrollingElement?.scrollTo(0, 0);
      for (const el of document.querySelectorAll('main, [data-scroll-root]')) (el as HTMLElement).scrollTop = 0;
    });
  }

  /** Run `fn` (navigate / open a dialog), then capture. A throw is logged; the screen is still captured. */
  async screen(
    name: string,
    fn?: () => Promise<void>,
    opts: { scrolled?: boolean; axe?: boolean } = {},
  ): Promise<void> {
    const file = `${this.theme}__${name}`;
    const e: Entry = {
      viewport: this.vp.id,
      theme: this.theme,
      screen: name,
      data: this.data,
      png: null,
      axe: null,
      axeViolations: [],
      pageScroll: null,
      spill: [],
      tables: [],
      cutHeaders: [],
      incompleteContrast: 0,
      pages: 1,
      status: 'ok',
    };
    const skipCapture = onlyScreens.length > 0 && !onlyScreens.some((x) => name.includes(x));
    try {
      await fn?.();
      if (skipCapture) {
        await this.closeDialogs();
        return;
      }
      await this.page.waitForTimeout(350);
    } catch (err) {
      e.status = 'failed';
      e.error = String(err instanceof Error ? err.message : err)
        .split('\n')[0]!
        .slice(0, 200);
      index.failures.push(`${this.vp.id} ${this.data} ${file}: ${e.error}`);
    }
    try {
      // Park the pointer in the corner so no tooltip is open during the capture and the axe run (harness artifact).
      await this.page.mouse.move(0, 0).catch(() => undefined);
      await this.page.waitForTimeout(120);
      await this.page.screenshot({ path: join(this.dir, `${file}.png`) });
      e.png = `${file}.png`;
      const m = await this.page.evaluate(() => {
        const root = document.documentElement;
        const spill: string[] = [];
        // Cells clip their content (overflow hidden), so test the geometry: any visible descendant (badge, button,
        // secondary line) that reaches past the cell's right edge is cut. Ellipsised .vss-truncate-inner is intended.
        for (const c of document.querySelectorAll('.vss-table td, .vss-table th')) {
          const cell = c as HTMLElement;
          const box = cell.getBoundingClientRect();
          for (const d of cell.querySelectorAll('*')) {
            const el = d as HTMLElement;
            if (el.closest('.vss-truncate-inner') || el.getAttribute('aria-hidden') === 'true') continue;
            const b = el.getBoundingClientRect();
            if (b.width < 2 || b.height < 2) continue;
            const text = (el.textContent ?? '').trim();
            if (!text && el.tagName !== 'BUTTON') continue;
            // Text laid out past the edge of an ancestor that clips it (a Badge label cut with an ellipsis).
            let textCut = false;
            for (const n of el.childNodes) {
              if (n.nodeType !== Node.TEXT_NODE || !(n.textContent ?? '').trim()) continue;
              const range = document.createRange();
              range.selectNodeContents(n);
              const tr = range.getBoundingClientRect();
              for (let a: HTMLElement | null = el; a && cell.contains(a); a = a.parentElement) {
                if (getComputedStyle(a).overflowX !== 'visible' && tr.right > a.getBoundingClientRect().right + 1)
                  textCut = true;
              }
            }
            if (textCut || b.right > box.right + 1 || el.scrollWidth > el.clientWidth + 1) {
              spill.push(`${el.tagName.toLowerCase()}: ${text.slice(0, 30)}`);
              break;
            }
          }
        }
        const tables = [...document.querySelectorAll('.vss-table-wrap')].map((w) => {
          const sc = w.querySelector('.vss-table-scroll') as HTMLElement | null;
          const sw = sc?.scrollWidth ?? 0;
          const cw = sc?.clientWidth ?? 0;
          return {
            id: w.getAttribute('data-table-id') ?? w.getAttribute('aria-label') ?? '(table)',
            scrollWidth: sw,
            clientWidth: cw,
            clipped: sw > cw + 1,
            dropped: (w.getAttribute('data-dropped') ?? '').split(',').filter(Boolean),
          };
        });
        const cutHeaders = [...document.querySelectorAll('.vss-table thead th')]
          .filter((th) => th.scrollWidth > th.clientWidth + 1 || th.scrollHeight > th.clientHeight + 1)
          .map((th) => (th.textContent ?? '').slice(0, 30));
        return {
          pageScroll: root.scrollWidth - root.clientWidth,
          spill: spill.slice(0, 10),
          tables,
          cutHeaders: cutHeaders.slice(0, 10),
        };
      });
      e.pageScroll = m.pageScroll;
      e.spill = m.spill;
      e.tables = m.tables;
      e.cutHeaders = m.cutHeaders;
      if (opts.axe !== false) {
        const { violations, incompleteContrast } = await runAxe(this.page);
        writeFileSync(join(this.dir, `${file}.axe.json`), JSON.stringify(violations, null, 2));
        e.axe = `${file}.axe.json`;
        e.axeViolations = violations.map((v) => ({ id: v.id, impact: v.impact ?? null, nodes: v.nodes.length }));
        e.incompleteContrast = incompleteContrast;
      }
      if (opts.scrolled !== false) {
        // Below-the-fold pages: scroll the page and every tall scroll box (not table boxes) by 80 % of a view.
        const plan = await this.page.evaluate(() => {
          const scrollers = () => {
            const out: HTMLElement[] = [document.scrollingElement as HTMLElement];
            for (const el of document.querySelectorAll('*')) {
              if (el.classList.contains('vss-table-scroll')) continue;
              const st = getComputedStyle(el);
              if (/(auto|scroll)/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 40 && el.clientHeight > 200)
                out.push(el as HTMLElement);
            }
            return out;
          };
          const need = Math.max(
            ...scrollers().map((el) => Math.ceil((el.scrollHeight - el.clientHeight) / (el.clientHeight * 0.8))),
          );
          (window as unknown as { __vssScrollers: () => HTMLElement[] }).__vssScrollers = scrollers;
          return Math.min(need, 7);
        });
        for (let k = 1; k <= plan; k++) {
          await this.page.evaluate((step) => {
            for (const el of (window as unknown as { __vssScrollers: () => HTMLElement[] }).__vssScrollers())
              el.scrollTop = Math.min(step * el.clientHeight * 0.8, el.scrollHeight - el.clientHeight);
          }, k);
          await this.page.waitForTimeout(180);
          await this.page.screenshot({ path: join(this.dir, `${file}--p${k + 1}.png`) });
          e.pages = k + 1;
        }
        await this.page.evaluate(() => {
          for (const el of (window as unknown as { __vssScrollers?: () => HTMLElement[] }).__vssScrollers?.() ?? [])
            el.scrollTop = 0;
        });
        // Tables that still scroll sideways: show their right-hand end.
        const wide = await this.page.evaluate(() => {
          const boxes = [...document.querySelectorAll('.vss-table-scroll')] as HTMLElement[];
          let n = 0;
          for (const b of boxes) {
            if (b.scrollWidth > b.clientWidth + 1) {
              b.scrollLeft = b.scrollWidth;
              n++;
            }
          }
          return n;
        });
        if (wide) {
          await this.page.waitForTimeout(150);
          await this.page.screenshot({ path: join(this.dir, `${file}--tableright.png`) });
          await this.page.evaluate(() => {
            for (const b of document.querySelectorAll('.vss-table-scroll')) (b as HTMLElement).scrollLeft = 0;
          });
        }
      }
    } catch (err) {
      e.status = 'failed';
      e.error ??= String(err instanceof Error ? err.message : err)
        .split('\n')[0]!
        .slice(0, 200);
      index.failures.push(`${this.vp.id} ${this.data} ${file} (capture): ${e.error}`);
    }
    index.entries.push(e);
    flushIndex();
    await this.closeDialogs();
    await this.page.waitForTimeout(100);
  }

  /** Leave a wizard the way a user does: Cancel, then confirm the discard dialog (a no-op when no wizard is open). */
  async resetWizard(): Promise<void> {
    const cancel = this.page.getByRole('button', { name: /^cancel$/i }).first();
    if (!(await cancel.isVisible().catch(() => false))) return;
    await cancel.click({ timeout: 3000 }).catch(() => undefined);
    await this.page.waitForTimeout(400);
    const discard = this.page.getByRole('button', { name: /discard/i }).first();
    if (await discard.isVisible().catch(() => false)) await discard.click({ timeout: 3000 }).catch(() => undefined);
    await this.page.waitForTimeout(500);
  }

  async click(name: RegExp): Promise<void> {
    await this.page.getByRole('button', { name }).first().click({ timeout: 6000 });
    await this.page.waitForTimeout(350);
  }
}

async function unlockViaUi(run: Run, password: string): Promise<void> {
  await run.page
    .getByLabel(/password/i)
    .first()
    .fill(password);
  await run.page.getByRole('button', { name: /^unlock$/i }).click();
  await run.page.waitForSelector('html[data-vault-state="unlocked"]', { state: 'attached', timeout: 30_000 });
  await run.page.waitForTimeout(600);
}

/**
 * The link-item dialog needs an item in `pending-review`. The demo data has none, so the harness (synthetic data
 * only) creates a manual request whose person is a near copy of an existing one (same name, day and month of birth
 * swapped) and keeps the first request that ends up with a pending-review or unlinked item.
 */
async function ensurePendingItemRequest(page: Page, requests: { id: string }[]): Promise<string | null> {
  const pendingOf = async (id: string): Promise<boolean> => {
    const r = await api(page, 'requests', 'get', { id });
    const items = (r.value?.items ?? []) as { linkState: string }[];
    return items.some((i) => i.linkState === 'pending-review' || i.linkState === 'unlinked');
  };
  for (const r of requests) if (await pendingOf(r.id)) return r.id;
  const persons = (await val(api(page, 'persons', 'list', { offset: 0, limit: 1 }))).items as {
    id: string;
    displayName: string;
    dob: string | null;
  }[];
  const p = persons[0];
  if (!p) return null;
  const detail = await val(api(page, 'persons', 'get', { id: p.id })).catch(() => null);
  const [surname, given] = p.displayName.split(',').map((x: string) => x.trim());
  const dob = (p.dob ?? '1980-02-03').split('-');
  const swapped = dob.length === 3 ? `${dob[0]}-${dob[2]}-${dob[1]}` : '1980-03-02';
  const person = (d: string) => ({
    surname: surname ?? 'Example',
    givenNames: [given ?? 'Person'],
    dob: d,
    dobPrecision: 'exact',
    sex: 'M',
    unitName: detail?.currentUnitName ?? 'Example Cyber Unit',
    unitType: 'Police',
    unitCountry: 'MALAYSIA',
    pobCountry: 'MALAYSIA',
    pobCity: 'Examplton',
    nationality: 'MALAYSIA',
    isHeadOfUnit: false,
  });
  for (const d of [swapped, p.dob ?? '1980-02-03', '1980-01-01']) {
    const created = await val(
      api(page, 'requests', 'createManual', {
        requestor: { name: 'Example Requestor', email: 'requestor@example.invalid', organisation: 'Example Org' },
        eventName: 'Example Link Item Request',
        eventStart: null,
        eventEnd: null,
        eventLocation: null,
        sentToDcAt: null,
        notes: '',
        items: [person(d)],
      }),
    ).catch(() => null);
    if (created && (await pendingOf(created.id))) return created.id as string;
  }
  return null;
}

async function seededScreens(app: ElectronApplication, run: Run): Promise<void> {
  const { page } = run;
  const requests = (await val(api(page, 'requests', 'list', { offset: 0, limit: 50 }))).items as {
    id: string;
    status: string;
    eventName: string;
  }[];
  const byStatus = (s: string) => requests.find((r) => r.status === s);
  const imported = requests.filter((r) => /Example (Regional Workshop|River City)/.test(r.eventName));
  const people = (await val(api(page, 'persons', 'list', { offset: 0, limit: 5 }))).items as { id: string }[];
  const units = (await val(api(page, 'units', 'list', { offset: 0, limit: 5 }))).items as { id: string }[];
  const review = (await val(api(page, 'review', 'list', { offset: 0, limit: 100, state: 'open' }))).items as {
    id: string;
    kind: string;
  }[];

  await run.screen('dashboard', () => run.go('#/'));
  await run.screen('requests', () => run.go('#/requests'));
  await run.screen('responses', () => run.go('#/responses'));
  await run.screen('people', () => run.go('#/people'));
  await run.screen('units', () => run.go('#/units'));
  await run.screen('review', () => run.go('#/review'));
  await run.screen('search', () => run.go('#/search?q=Example'));
  await run.screen('settings', () => run.go('#/settings'));
  const cardCount = await page.evaluate(() => document.querySelectorAll('main .mantine-Card-root').length);
  for (let c = 0; c < cardCount; c++) {
    await run.screen(
      `settings-card-${String(c + 1).padStart(2, '0')}`,
      async () => {
        await run.go('#/settings');
        await page.evaluate((idx) => {
          const card = document.querySelectorAll('main .mantine-Card-root')[idx] as HTMLElement | undefined;
          card?.scrollIntoView({ block: 'start' });
        }, c);
      },
      { scrolled: false, axe: false },
    );
  }
  await run.screen('audit', () => run.go('#/audit'));
  await run.screen('request-manual', () => run.go('#/requests/new'));

  for (const r of [imported[0], byStatus('finished'), byStatus('closed')].filter(Boolean)) {
    await run.screen(`request-detail-${r!.status}`, () => run.go(`#/requests/${r!.id}`));
  }
  if (imported[1])
    await run.screen(`request-detail-${imported[1].status}-2`, () => run.go(`#/requests/${imported[1]!.id}`));
  if (people[0]) await run.screen('person-detail', () => run.go(`#/people/${people[0]!.id}`));
  if (units[0]) await run.screen('unit-detail', () => run.go(`#/units/${units[0]!.id}`));
  const kinds = [...new Set(review.map((r) => r.kind))];
  for (const k of kinds) {
    const item = review.find((r) => r.kind === k)!;
    await run.screen(`review-detail-${k}`, () => run.go(`#/review/${item.id}`));
  }
  const rv = review.find((r) => r.kind === 'response-row-match') ?? review[0];
  if (rv) {
    await run.screen('dialog-review-picker', async () => {
      await run.go(`#/review/${rv.id}`);
      await run.click(/choose|pick|other person|someone/i);
    });
    await run.screen('dialog-review-compare', async () => {
      await run.go(`#/review/${rv.id}`);
      await page
        .getByRole('button', { name: /same person|compare and decide/i })
        .first()
        .click({ timeout: 6000 });
      await page.getByRole('dialog').first().waitFor({ timeout: 6000 });
    });
    await run.screen('dialog-review-validate', async () => {
      await run.go(`#/review/${rv.id}`);
      await run.click(/validate/i);
    });
    // With a candidate chosen: the disagreement banner, side-by-side values and the "I compared" tick (R3O-04).
    await run.screen('dialog-review-validate-candidate', async () => {
      await run.go(`#/review/${rv.id}`);
      await run.click(/validate/i);
      await page
        .getByRole('dialog')
        .first()
        .getByLabel(/\(candidate\)$/)
        .first()
        .check({ timeout: 6000 });
      await page.waitForTimeout(300);
    });
  }

  const target = imported[0];
  if (target) {
    const dlg = (name: string, btn: RegExp) =>
      run.screen(`dialog-${name}`, async () => {
        await run.go(`#/requests/${target.id}`);
        await run.click(btn);
        await page.getByRole('dialog').first().waitFor({ timeout: 6000 });
      });
    await dlg('export', /export for vetting/i);
    await dlg('email-clearance', /responded by e-?mail/i);
    await dlg('compose-email', /e-?mail (the )?requestor/i);
    await dlg('edit-request', /^edit/i);
    await dlg('delete-request', /^delete/i);
    const pendingId = await ensurePendingItemRequest(page, requests);
    await run.screen('dialog-link-item', async () => {
      if (!pendingId) throw new Error('no request with a pending-review item could be made');
      await run.go(`#/requests/${pendingId}`);
      await page
        .getByRole('button', { name: /^resolve/i })
        .first()
        .click({ timeout: 6000 });
      await page.getByRole('dialog').first().waitFor({ timeout: 6000 });
    });
  }
  const fin = byStatus('finished');
  if (fin)
    await run.screen('dialog-close-request', async () => {
      await run.go(`#/requests/${fin.id}`);
      await run.click(/close request|^close/i);
      await page.getByRole('dialog').first().waitFor({ timeout: 6000 });
    });
  const closed = byStatus('closed');
  if (closed)
    await run.screen('dialog-reopen-request', async () => {
      await run.go(`#/requests/${closed.id}`);
      await run.click(/reopen/i);
      await page.getByRole('dialog').first().waitFor({ timeout: 6000 });
    });

  // wizards: request import (every step), response import (every step), wrong-file error state
  await stubDialog(app, fx('requests/req-001-basic.xlsx'));
  await run.screen('wizard-request-1-pick', () => run.go('#/requests/import'));
  await run.screen('wizard-request-2-after-pick', async () => {
    await run.click(/choose file/i);
    await page.waitForTimeout(800);
  });
  for (let i = 3; i <= 5; i++) {
    const next = page.getByRole('button', { name: /^next$/i });
    if (!(await next.isVisible().catch(() => false)) || !(await next.isEnabled().catch(() => false))) break;
    await run.screen(`wizard-request-${i}-step`, async () => {
      await next.click();
      await page.waitForTimeout(600);
    });
  }
  await run.screen('wizard-request-cancel-discard', async () => {
    await run.click(/^cancel$/i);
    await page.getByRole('dialog').first().waitFor({ timeout: 6000 });
  });
  await run.closeDialogs();

  await stubDialog(app, fx('responses/resp-002-reformatted.xlsx'));
  await run.screen('wizard-response-1-pick', () => run.go('#/responses/import'));
  await run.screen('wizard-response-2-after-pick', async () => {
    await run.click(/choose file/i);
    await page.waitForTimeout(800);
  });
  // The wizard no longer preselects a weak match: choose the first candidate request, and tick the "no row matches"
  // confirmation when it is asked for, as a user must.
  await run.screen('wizard-response-2-request-chosen', async () => {
    const select = page.getByLabel(/matching request/i).first();
    await select.click({ timeout: 6000 });
    const options = page.getByRole('option');
    const n = await options.count();
    await options.nth(n > 1 ? 1 : 0).click({ timeout: 6000 });
    await page.waitForTimeout(900);
    const ack = page.getByTestId('match-zero').getByRole('checkbox').first();
    if (await ack.isVisible().catch(() => false)) await ack.check();
    await page.waitForTimeout(300);
  });
  for (let i = 3; i <= 5; i++) {
    const next = page.getByRole('button', { name: /^next$/i });
    if (!(await next.isVisible().catch(() => false)) || !(await next.isEnabled().catch(() => false))) break;
    await run.screen(`wizard-response-${i}-step`, async () => {
      await next.click();
      await page.waitForTimeout(600);
    });
  }
  await stubDialog(app, fx('responses/resp-011-request-workbook.xlsx'));
  await run.screen('error-wrong-response-file', async () => {
    await run.resetWizard();
    await run.go('#/responses/import');
    await page
      .getByRole('button', { name: /choose file|choose another/i })
      .first()
      .click({ timeout: 8000 });
    await page.waitForTimeout(1000);
  });
  await stubDialog(app, null);

  // a draft request (harness-only data) for the Mark-sent dialog
  await run.screen('dialog-mark-sent', async () => {
    const draft = await val(
      api(page, 'requests', 'createManual', {
        requestor: { name: 'Example Requestor', email: 'requestor@example.invalid', organisation: 'Example Org' },
        eventName: 'Example Draft Request',
        eventStart: null,
        eventEnd: null,
        eventLocation: null,
        sentToDcAt: null,
        notes: '',
        items: [],
      }),
    ).catch(() => null);
    if (!draft) throw new Error('could not create draft request');
    await run.go(`#/requests/${draft.id}`);
    await run.click(/mark (as )?sent/i);
    await page.getByRole('dialog').first().waitFor({ timeout: 6000 });
  });
  // Delete confirmation of a request that can be deleted (the imported one above has a response file: blocked).
  await run.screen('dialog-delete-request-deletable', async () => {
    const pid = await ensurePendingItemRequest(page, []);
    if (!pid) throw new Error('could not create a deletable request');
    await run.go(`#/requests/${pid}`);
    await run.click(/^delete/i);
    await page.getByRole('dialog').first().waitFor({ timeout: 6000 });
  });
}

/**
 * Alpha-channel affordances (UI review R3O-H1 / R3S-07): only rendered by a bundle built with VSS_CHANNEL=alpha
 * (`npm run ui-audit:alpha`). Captures the banner, the Help menu, the About dialog, the Send feedback result (the
 * browser launch is stubbed in main, nothing opens), and the Settings Updates note and About card.
 */
async function alphaScreens(app: ElectronApplication, run: Run): Promise<void> {
  const { page } = run;
  const info = await val(api(page, 'app', 'info'));
  if (info.channel !== 'alpha') throw new Error(`alpha profile, but the build reports channel ${info.channel}`);
  await app.evaluate(({ shell }) => {
    shell.openExternal = (async () => undefined) as typeof shell.openExternal;
  });
  await run.screen('alpha-banner-dashboard', async () => {
    await run.go('#/');
    await page.getByTestId('alpha-banner').waitFor({ timeout: 6000 });
  });
  await run.screen('alpha-banner-request-detail', async () => {
    const reqs = (await val(api(page, 'requests', 'list', { offset: 0, limit: 5 }))).items as { id: string }[];
    if (reqs[0]) await run.go(`#/requests/${reqs[0].id}`);
  });
  await run.screen(
    'alpha-help-menu',
    async () => {
      await run.go('#/');
      await run.click(/^help$/i);
      await page.getByRole('menuitem', { name: /about vss/i }).waitFor({ timeout: 6000 });
    },
    { scrolled: false },
  );
  await page.keyboard.press('Escape').catch(() => undefined);
  await run.screen(
    'alpha-about-dialog',
    async () => {
      await run.go('#/');
      await run.click(/^help$/i);
      await page.getByRole('menuitem', { name: /about vss/i }).click({ timeout: 6000 });
      await page.getByTestId('about-body').waitFor({ timeout: 6000 });
    },
    { scrolled: false },
  );
  await run.screen(
    'alpha-send-feedback',
    async () => {
      await run.go('#/');
      await run.click(/^help$/i);
      await page.getByRole('menuitem', { name: /send feedback/i }).click({ timeout: 6000 });
      await page.waitForTimeout(400);
    },
    { scrolled: false },
  );
  await run.screen(
    'alpha-settings-updates',
    async () => {
      await run.go('#/settings');
      await page.getByTestId('updates-alpha-note').scrollIntoViewIfNeeded({ timeout: 6000 });
    },
    { scrolled: false },
  );
  await run.screen(
    'alpha-settings-about',
    async () => {
      await run.go('#/settings');
      await page.getByTestId('about-version').scrollIntoViewIfNeeded({ timeout: 6000 });
    },
    { scrolled: false },
  );
}

async function emptyScreens(run: Run): Promise<void> {
  for (const [n, h] of [
    ['dashboard', '#/'],
    ['requests', '#/requests'],
    ['responses', '#/responses'],
    ['people', '#/people'],
    ['units', '#/units'],
    ['review', '#/review'],
    ['search', '#/search?q=nothing'],
    ['audit', '#/audit'],
  ] as const)
    await run.screen(`empty-${n}`, () => run.go(h), { scrolled: false });
}

async function lockWarning(app: ElectronApplication, run: Run): Promise<void> {
  const settings = await val(api(run.page, 'settings', 'get'));
  const limit = (settings.autoLockMinutes ?? 10) * 60;
  await run.screen(
    'lock-warning',
    async () => {
      await run.go('#/');
      await app.evaluate(({ powerMonitor }, secs) => {
        powerMonitor.getSystemIdleTime = () => secs;
      }, limit - 20);
      await run.page.getByRole('dialog').first().waitFor({ timeout: 20_000 });
    },
    { scrolled: false },
  );
  await app.evaluate(({ powerMonitor }) => {
    powerMonitor.getSystemIdleTime = () => 0;
  });
  await run.page
    .getByRole('button', { name: /stay/i })
    .click()
    .catch(() => undefined);
}

describe('UI audit', () => {
  for (const vp of VIEWPORTS) {
    if (only.length && !only.includes(vp.id)) continue;
    it(`viewport ${vp.id}`, async () => {
      const vdir = join(OUT_ROOT, vp.id.replace('@', '_dsf'));
      mkdirSync(vdir, { recursive: true });
      const root = mkdtempSync(join(tmpdir(), 'vss-ui-audit-'));
      const noop = () => undefined;
      let app: ElectronApplication | null = null;
      // ---- empty vault (no seed): create screen, then empty lists
      try {
        const l = await launch(join(root, 'empty', 'vault'), vp, false);
        app = l.app;
        const run = new Run(vp, 'empty', l.page, vdir);
        for (const th of THEMES) {
          run.theme = th;
          await setTheme(l.page, th);
          await run.screen('create-vault', () => run.go('#/create'), { scrolled: false });
        }
        await val(api(l.page, 'vault', 'create', { password: PW, displayName: 'Empty office' }));
        await l.page.waitForSelector('html[data-vault-state="unlocked"]', { state: 'attached' });
        for (const th of THEMES) {
          run.theme = th;
          await setTheme(l.page, th);
          await emptyScreens(run);
        }
      } catch (e) {
        index.failures.push(`${vp.id} empty run: ${String(e).slice(0, 200)}`);
      } finally {
        await app?.close().catch(noop);
        app = null;
      }

      // ---- seeded vault
      try {
        const l = await launch(join(root, 'seeded', 'vault'), vp, true);
        app = l.app;
        const run = new Run(vp, 'seeded', l.page, vdir);
        for (const th of THEMES) {
          run.theme = th;
          await setTheme(l.page, th);
          await run.screen('unlock', undefined, { scrolled: false });
        }
        await l.page
          .getByLabel(/password/i)
          .first()
          .fill('wrong password wrong password');
        await l.page.getByRole('button', { name: /^unlock$/i }).click();
        await l.page.waitForTimeout(1500);
        await run.screen('unlock-wrong-password', undefined, { scrolled: false });
        await unlockViaUi(run, PW);
        for (const th of THEMES) {
          run.theme = th;
          await setTheme(l.page, th);
          if (ALPHA) await alphaScreens(app, run);
          await seededScreens(app, run);
        }
        run.theme = 'light';
        await setTheme(l.page, 'light');
        await lockWarning(app, run);
        await run.screen('after-lock', async () => {
          await api(l.page, 'vault', 'lock');
          await l.page.waitForSelector('html[data-vault-state="locked"]', { state: 'attached' });
        });
      } catch (e) {
        index.failures.push(`${vp.id} seeded run: ${String(e).slice(0, 200)}`);
      } finally {
        await app?.close().catch(noop);
        try {
          rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
        } catch {
          /* Chromium helpers may hold the profile briefly; it is a temp dir */
        }
        flushIndex();
      }
    });
  }
});
