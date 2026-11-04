/**
 * Security review F-06, end to end through the request service: a namesake must not be linked automatically to a
 * known person on full name + DOB + birth country alone, and a placeholder DOB never supports an automatic link.
 * Synthetic data only.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { matchResponseRows } from '../../src/main/matching/matcher';
import { commitHeader, fixtureBytes, harness, manualItem, manualRequest, unwrap } from '../unit/services/helpers';
import { item, observed, row } from '../unit/matching/helpers';
import type { Harness } from '../unit/services/helpers';

let h: Harness;
afterEach(() => h?.cleanup());

const itemOf = (h: Harness, requestId: string) => h.fx.repos.requests.listItems(requestId)[0]!;

describe('F-06 cross-request auto-link needs a strong anchor', () => {
  it('same full name + DOB + birth country (and unit) but no ID and no POB city: review, not auto', async () => {
    h = harness();
    const p = unwrap(await h.svc.requests.importFile('r.xlsx', fixtureBytes('requests/req-001-basic.xlsx')));
    unwrap(await h.svc.requests.importCommit(commitHeader(p.previewId)));
    const s = unwrap(
      await h.svc.requests.createManual(
        manualRequest([
          manualItem({
            surname: 'Siarorikpon',
            givenNames: ['Bachop'],
            dob: '1996-12-11',
            pobCountry: 'THAILAND',
            pobCity: null,
            nationality: 'THAILAND',
            unitName: 'Example Highway Patrol Unit 1',
            unitCountry: 'THAILAND',
          }),
        ]),
      ),
    );
    const it1 = itemOf(h, s.id);
    expect(it1.linkState).toBe('pending-review');
    expect(it1.personId).toBeNull();
  });

  it('a placeholder DOB (1 January) never auto-links, even with unit and POB city equal', async () => {
    h = harness();
    const a = unwrap(await h.svc.requests.createManual(manualRequest([manualItem({ dob: '1985-01-01' })])));
    expect(itemOf(h, a.id).linkState).toBe('new-person');
    const b = unwrap(await h.svc.requests.createManual(manualRequest([manualItem({ dob: '1985-01-01' })])));
    expect(itemOf(h, b.id).linkState).toBe('pending-review');
    // the same people with a precise DOB do auto-link (unit + POB city equal)
    const c = unwrap(
      await h.svc.requests.createManual(manualRequest([manualItem({ surname: 'Precisedate', dob: '1985-03-14' })])),
    );
    const d = unwrap(
      await h.svc.requests.createManual(manualRequest([manualItem({ surname: 'Precisedate', dob: '1985-03-14' })])),
    );
    expect(itemOf(h, d.id).linkState).toBe('auto');
    expect(itemOf(h, d.id).personId).toBe(itemOf(h, c.id).personId);
  });

  it("a different father's name blocks the auto-link", async () => {
    h = harness();
    unwrap(await h.svc.requests.createManual(manualRequest([manualItem({ fatherName: 'Orlen Testsurname' })])));
    const b = unwrap(await h.svc.requests.createManual(manualRequest([manualItem({ fatherName: 'Quillon Varemar' })])));
    expect(itemOf(h, b.id).linkState).toBe('pending-review');
  });
});

describe('lane C: mixed Latin + Thai names never auto-link on the Latin part when the Thai parts differ', () => {
  // Synthetic: "Zq..." Latin words and made-up Thai syllables.
  const ROW = (thai: string) => row('R1', `Zqsurname, Zqgiven ${thai}`, '1990-03-07');
  const ITEM = (thai: string) => item('I1', observed({ surname: 'Zqsurname', name1: 'Zqgiven', name2: thai }));

  it('Thai given names differ, Latin equal, same DOB -> not T1 (and never auto)', () => {
    const [m] = matchResponseRows([ROW('กาญจนา')], [ITEM('สมศรี')], { now: () => '2026-11-04T00:00:00.000Z' });
    expect(m!.decision).not.toBe('auto');
    expect(m!.candidates[0]?.tier).toBe('T2');
    expect(m!.candidates[0]?.evidence).toContain('NAME_SCRIPT_CONFLICT');
  });
  it('the same Thai given names (tone marks aside) do auto-link within the request', () => {
    const [m] = matchResponseRows([ROW('สม\u0E48ศรี')], [ITEM('สมศรี')], { now: () => '2026-11-04T00:00:00.000Z' });
    expect(m!.decision).toBe('auto');
    expect(m!.candidates[0]?.evidence).not.toContain('NAME_SCRIPT_CONFLICT');
  });
  it('a Thai part on one side only is information and does not block', () => {
    const [m] = matchResponseRows([ROW('สมศรี')], [item('I1', observed({ surname: 'Zqsurname', name1: 'Zqgiven' }))], {
      now: () => '2026-11-04T00:00:00.000Z',
    });
    expect(m!.candidates[0]?.evidence).toContain('NAME_SCRIPT_IGNORED');
    expect(m!.decision).toBe('auto');
  });
  it('cross-request through the service: a namesake whose Thai given name differs goes to review', async () => {
    h = harness();
    unwrap(
      await h.svc.requests.createManual(
        manualRequest([manualItem({ surname: 'Zqmixedname', givenNames: ['Zqgiven', 'สมศรี'], dob: '1985-03-14' })]),
      ),
    );
    const same = unwrap(
      await h.svc.requests.createManual(
        manualRequest([manualItem({ surname: 'Zqmixedname', givenNames: ['Zqgiven', 'สมศรี'], dob: '1985-03-14' })]),
      ),
    );
    expect(itemOf(h, same.id).linkState).toBe('auto');
    const other = unwrap(
      await h.svc.requests.createManual(
        manualRequest([manualItem({ surname: 'Zqmixedname', givenNames: ['Zqgiven', 'กาญจนา'], dob: '1985-03-14' })]),
      ),
    );
    expect(itemOf(h, other.id).linkState).not.toBe('auto');
    expect(itemOf(h, other.id).personId).toBeNull();
  });
});
