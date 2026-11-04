/**
 * Manual validation (lane K, R12): the reviewer confirms a response row is a valid DC answer for a candidate, another
 * person chosen with the picker, or a new person. Shows what will be recorded and requires a reason (>= 3 chars).
 */
import { Alert, Button, Group, Modal, Radio, Stack, Text, Textarea } from '@mantine/core';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ResponseRow } from '@shared/domain/types';
import type { PersonSummary, ReviewItemDetail, ReviewManualValidateRequest, ReviewSubject } from '@shared/ipc/contract';
import { useAction, vss } from '../../lib/api';
import { KeyValue, Sensitive } from '../common';
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
  const chosenCand = cands.find((x) => `c:${x.id}` === choice);
  const conflicts =
    source && chosenCand
      ? conflictLabels([
          { key: 'name', label: t('import.name'), kind: 'name', values: [source.displayName, chosenCand.displayName] },
          {
            key: 'dob',
            label: t('import.dob'),
            kind: 'dob',
            values: [source.dob ?? source.dobRaw, chosenCand.dob ?? chosenCand.dobRaw],
          },
          { key: 'sex', label: t('person.sex'), kind: 'text', values: [source.sex ?? '', chosenCand.sex ?? ''] },
          {
            key: 'pob',
            label: t('person.pob'),
            kind: 'text',
            values: [source.pobCountry ?? '', chosenCand.pobCountry ?? ''],
          },
          {
            key: 'unit',
            label: t('import.unit'),
            kind: 'text',
            values: [source.unitName ?? '', chosenCand.unitName ?? ''],
          },
        ])
      : [];

  const target = (): Target | null => {
    if (choice === 'new') return { kind: 'new-person' };
    if (choice === 'other') return other ? { kind: 'person', personId: other.id } : null;
    const c = cands.find((x) => `c:${x.id}` === choice);
    if (!c) return null;
    return c.kind === 'person' ? { kind: 'person', personId: c.id } : { kind: 'request-item', itemId: c.id };
  };
  const unknownDisp = row !== null && row.dispClass === 'unknown';
  const ready = target() !== null && reason.trim().length >= 3 && row !== null && !unknownDisp && !busy;

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
            <Alert color="orange" title={t('identity.conflictTitle')} data-testid="validate-conflicts">
              {t('identity.conflictBody', { fields: conflicts.join(', ') })}
            </Alert>
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

export const dispKey = (d: ResponseRow['dispClass']): 'Approved' | 'NonApproved' | 'Unknown' =>
  d === 'approved' ? 'Approved' : d === 'non-approved' ? 'NonApproved' : 'Unknown';
