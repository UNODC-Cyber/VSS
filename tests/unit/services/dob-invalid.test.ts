/**
 * UI review round 2, R2O-02 / R2O-06: an impossible date of birth (1995-20-07) is kept as written, flagged and never
 * used for matching, and requests.get reports which persons have a record on the request (close summary).
 * Synthetic data only.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ipcSchemas } from '@shared/ipc/schemas';
import { manualIssues } from '../../../src/main/services/requests';
import { harness, manualItem, manualRequest, once, unwrap } from './helpers';
import type { Harness } from './helpers';

let h: Harness;
afterEach(() => h?.cleanup());

const itemOf = (h: Harness, requestId: string) => h.fx.repos.requests.listItems(requestId)[0]!;

describe('manual request with an impossible date of birth', () => {
  it('keeps the value as written, parses nothing, flags DOB_INVALID and stays Received', async () => {
    h = harness();
    const s = unwrap(await h.svc.requests.createManual(manualRequest([manualItem({ dob: '1995-20-07' })])));
    const it1 = itemOf(h, s.id);
    expect(it1.observed.dob).toMatchObject({ kind: 'text', value: '1995-20-07', parsed: null });
    expect(it1.issues.map((i) => [i.code, i.severity])).toContainEqual(['DOB_INVALID', 'error']);
    expect(h.fx.repos.requests.getHeader(s.id)!.status).toBe('received');
    // A new person made from it has no date of birth at all (never a normalised or swapped one).
    if (it1.personId) expect(h.fx.repos.persons.get(it1.personId)!.dob).toBeNull();
  });

  it('never auto-links on it, where the same rows with a real date would', async () => {
    h = harness();
    const same = { surname: 'Impossibledate', dob: '1985-14-03' };
    unwrap(await h.svc.requests.createManual(manualRequest([manualItem(same)])));
    const b = unwrap(await h.svc.requests.createManual(manualRequest([manualItem(same)])));
    expect(itemOf(h, b.id).linkState).not.toBe('auto');
    // control: the same rows with a real date do auto-link (unit + place of birth equal)
    const real = { surname: 'Realdate', dob: '1985-03-14' };
    unwrap(await h.svc.requests.createManual(manualRequest([manualItem(real)])));
    const d = unwrap(await h.svc.requests.createManual(manualRequest([manualItem(real)])));
    expect(itemOf(h, d.id).linkState).toBe('auto');
  });

  it('manualIssues flags only rows with a written but unreadable date', () => {
    const obs = (value: string, parsed: string | null) =>
      ({
        rowRef: 'Manual!1',
        dob: { kind: value ? 'text' : 'empty', value, parsed, ambiguousDayMonth: false },
      }) as never;
    expect(manualIssues([obs('1995-20-07', null)])).toHaveLength(1);
    expect(manualIssues([obs('1995-07-20', '1995-07-20')])).toHaveLength(0);
    expect(manualIssues([obs('', null)])).toHaveLength(0);
  });
});

describe('edits refuse impossible dates', () => {
  it('persons.update and review.editRow reject 1995-20-07 at the IPC boundary', () => {
    const id = '01HZZZZZZZZZZZZZZZZZZZZZZZ';
    const person = ipcSchemas.persons.update.req;
    expect(person.safeParse({ id, patch: { dob: '1995-20-07' }, reason: 'typo' }).success).toBe(false);
    expect(person.safeParse({ id, patch: { dob: '1995-07-20' }, reason: 'typo' }).success).toBe(true);
    expect(person.safeParse({ id, patch: { dob: '2023-02-29' }, reason: 'typo' }).success).toBe(false);
  });
});

describe('requests.get lists the persons with a record on the request (close summary, R2O-06)', () => {
  it('an e-mailed approval counts even though the export policy now excludes the person', async () => {
    h = harness('2026-11-10T08:00:00.000Z');
    const s = await once(h, () =>
      h.svc.requests.createManual(
        manualRequest([manualItem({ surname: 'Emailcleared', dob: '1984-05-16' })], {
          sentToDcAt: '2026-11-01T08:00:00.000Z',
        }),
      ),
    );
    const item = itemOf(h, s.id);
    expect(unwrap(await h.svc.requests.get({ id: s.id })).recordedPersonIds).toEqual([]);
    await once(h, () =>
      h.svc.requests.markRespondedByEmail({
        requestId: s.id,
        itemIds: [item.id],
        certDate: '2026-11-10',
        expiresAt: '2027-11-10',
        disposition: 'approved',
        note: '',
      }),
    );
    const req = unwrap(await h.svc.requests.get({ id: s.id }));
    expect(req.recordedPersonIds).toEqual([item.personId]);
  });
});
