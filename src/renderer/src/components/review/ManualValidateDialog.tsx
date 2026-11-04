/**
 * Manual validation (lane K, R12): the reviewer confirms a response row is a valid DC answer for a candidate, another
 * person chosen with the picker, or a new person. Shows what will be recorded and requires a reason (>= 3 chars).
 */
import { Alert, Button, Checkbox, Group, Modal, Radio, Stack, Text, Textarea } from '@mantine/core';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ResponseRow } from '@shared/domain/types';
import type { PersonSummary, ReviewItemDetail, ReviewManualValidateRequest, ReviewSubject } from '@shared/ipc/contract';
import { useAction, vss } from '../../lib/api';
import { KeyValue, Sensitive } from '../common';
import { DiffGrid } from '../Diff';
import type { DiffField } from '../Diff';
import { conflictLabels } from '../IdentityConfirm';
import { PersonPicker } from '../PersonPicker';

type Target = ReviewManualValidateRequest['target'];

export function ManualValidateDialog({
  opened,
  onClose,
  detail,
  row,
  onDone,
}: {
  opened: boolean;
  onClose: () => void;
  detail: ReviewItemDetail;
  /** The full row (null while loading). */
  row: ResponseRow | null;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const act = useAction();
  const { item, subjects } = detail;
  const source = subjects[0];
  const cands = subjects.slice(1).filter((s): s is ReviewSubject => s.kind === 'person' || s.kind === 'request-item');
  const [choice, setChoice] = useState<string>('');
  const [other, setOther] = useState<PersonSummary | null>(null);
  const [picker, setPicker] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  // No target is pre-selected (UI review O-18): the reviewer picks whom the row is about every time.
  useEffect(() => {
    if (!opened) return;
    setChoice('');
    setOther(null);
    setReason('');
  }, [opened, item.id]);
  const [compared, setCompared] = useState(false);
  const chosenCand = cands.find((x) => `c:${x.id}` === choice);
  // The person the row would be recorded against, as comparable fields (a candidate, or one chosen with the picker).
  const chosen: Comparable | null = chosenCand
    ? {
        name: chosenCand.displayName,
        dob: chosenCand.dob ?? chosenCand.dobRaw,
        sex: chosenCand.sex ?? '',
        pob: chosenCand.pobCountry ?? '',
        unit: chosenCand.unitName ?? '',
        ids: chosenCand.identifiers,
      }
    : choice === 'other' && other
      ? {
          name: other.displayName,
          dob: other.dob ?? '',
          sex: other.sex ?? '',
          pob: '',
          unit: other.currentUnitName ?? '',
          ids: [],
        }
      : null;
  const fields: DiffField[] =
    source && chosen
      ? compareFields(
          t,
          {
            name: source.displayName,
            dob: source.dob ?? source.dobRaw,
            sex: source.sex ?? '',
            pob: source.pobCountry ?? '',
            unit: source.unitName ?? '',
            ids: source.identifiers,
          },
          chosen,
        )
      : [];
  // Same safeguard as linking (UI review R3O-04): while the records disagree, nothing is recorded until the
  // reviewer has seen the values side by side and ticked that they compared them.
  const conflicts = conflictLabels(fields);
  const conflictKey = `${choice}|${other?.id ?? ''}|${conflicts.join('|')}`;
  useEffect(() => setCompared(false), [conflictKey]);

  const target = (): Target | null => {
    if (choice === 'new') return { kind: 'new-person' };
    if (choice === 'other') return other ? { kind: 'person', personId: other.id } : null;
    const c = cands.find((x) => `c:${x.id}` === choice);
    if (!c) return null;
    return c.kind === 'person' ? { kind: 'person', personId: c.id } : { kind: 'request-item', itemId: c.id };
  };
  const unknownDisp = row !== null && row.dispClass === 'unknown';
  const ready =
    target() !== null &&
    reason.trim().length >= 3 &&
    row !== null &&
    !unknownDisp &&
    !busy &&
    (conflicts.length === 0 || compared);

  const submit = async () => {
    const tg = target();
    if (!tg) return;
    setBusy(true);
    const r = await act(
      vss().review.manualValidate({ id: item.id, target: tg, reason: reason.trim() }),
      t('reviewAct.validated'),
    );
    setBusy(false);
    if (r) onDone();
  };

  return (
    <>
      <Modal opened={opened && !picker} onClose={onClose} title={t('reviewAct.validateTitle')} size="lg" trapFocus>
        <Stack>
          <Text size="sm">{t('reviewAct.validateIntro')}</Text>
          {source && (
            <Text fw={600}>
              <Sensitive value={source.displayName} />
            </Text>
          )}
          <Radio.Group label={t('reviewAct.validateTarget')} value={choice} onChange={setChoice}>
            <Stack gap={6} mt={4}>
              {cands.map((c) => (
                <Radio key={c.id} value={`c:${c.id}`} label={t('reviewAct.targetCandidate', { name: c.displayName })} />
              ))}
              <Radio
                value="other"
                label={
                  other ? t('reviewAct.targetOtherChosen', { name: other.displayName }) : t('reviewAct.targetOther')
                }
                onClick={() => setPicker(true)}
              />
              <Radio value="new" label={t('reviewAct.targetNew')} />
            </Stack>
          </Radio.Group>
          {conflicts.length > 0 && (
            <>
              <Alert color="orange" title={t('identity.conflictTitle')} data-testid="validate-conflicts">
                {t('identity.conflictBody', { fields: conflicts.join(', ') })}
              </Alert>
              <DiffGrid
                caption={t('identity.compareCaption')}
                headers={[t('reviewAct.validateRowHeader'), t('reviewAct.validatePersonHeader')]}
                fields={fields}
              />
              <Checkbox
                label={t('identity.ack', { fields: conflicts.join(', ') })}
                checked={compared}
                onChange={(e) => setCompared(e.currentTarget.checked)}
                data-testid="validate-ack"
              />
            </>
          )}
          {unknownDisp && <Alert color="orange">{t('reviewAct.setDispFirst')}</Alert>}
          {row && (
            <KeyValue
              rows={[
                [t('reviewAct.disposition'), t(`reviewAct.disp${dispKey(row.dispClass)}`)],
                [t('reviewAct.certDate'), row.certDate.parsed ?? '-'],
                [t('reviewAct.expires'), row.expires.parsed ?? '-'],
              ]}
            />
          )}
          <Textarea
            label={t('reviewAct.reason')}
            description={t('reviewAct.reasonHelp')}
            required
            value={reason}
            onChange={(e) => setReason(e.currentTarget.value)}
            rows={2}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button disabled={!ready} loading={busy} onClick={() => void submit()}>
              {t('reviewAct.confirmValidate')}
            </Button>
          </Group>
        </Stack>
      </Modal>
      <PersonPicker
        opened={picker}
        title={t('reviewAct.choosePersonTitle')}
        onClose={() => setPicker(false)}
        forSubject={{ kind: 'review-item', id: item.id }}
        initialText={source?.displayName ?? ''}
        {...(source ? { subject: source } : {})}
        onPick={(p) => {
          setOther(p);
          setChoice('other');
          setPicker(false);
        }}
      />
    </>
  );
}

interface Comparable {
  name: string;
  dob: string;
  sex: string;
  pob: string;
  unit: string;
  ids: string[];
}

/** The fields compared before a row is recorded against a person; identifiers are compared as a sorted list. */
export function compareFields(t: (k: string) => string, row: Comparable, person: Comparable): DiffField[] {
  const ids = (xs: string[]) =>
    [...xs]
      .map((x) => x.trim())
      .filter(Boolean)
      .sort()
      .join(', ');
  return [
    { key: 'name', label: t('import.name'), kind: 'name', values: [row.name, person.name] },
    { key: 'dob', label: t('import.dob'), kind: 'dob', values: [row.dob, person.dob] },
    { key: 'sex', label: t('person.sex'), kind: 'text', values: [row.sex, person.sex] },
    { key: 'pob', label: t('person.pob'), kind: 'text', values: [row.pob, person.pob] },
    { key: 'unit', label: t('import.unit'), kind: 'text', values: [row.unit, person.unit] },
    { key: 'ids', label: t('items.ids'), kind: 'text', values: [ids(row.ids), ids(person.ids)] },
  ];
}

export const dispKey = (d: ResponseRow['dispClass']): 'Approved' | 'NonApproved' | 'Unknown' =>
  d === 'approved' ? 'Approved' : d === 'non-approved' ? 'NonApproved' : 'Unknown';
