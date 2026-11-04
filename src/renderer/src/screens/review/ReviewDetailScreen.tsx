import { Alert, Badge, Button, Group, Stack } from '@mantine/core';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ResponseRow } from '@shared/domain/types';
import type { ReviewItemDetail, ReviewResolution } from '@shared/ipc/contract';
import { DiffGrid } from '../../components/Diff';
import type { DiffField } from '../../components/Diff';
import { PageHeader, QueryBoundary, ReasonDialog, TierBadge } from '../../components/common';
import { PersonPicker } from '../../components/PersonPicker';
import { EditPersonDialog } from '../../components/review/EditPersonDialog';
import { EditRowDialog } from '../../components/review/EditRowDialog';
import { ManualValidateDialog } from '../../components/review/ManualValidateDialog';
import { findResponseRow } from '../../components/review/rowLookup';
import { useAction, useQuery, vss } from '../../lib/api';
import { navigate } from '../../lib/router';

/** Kinds that decide whom a record belongs to: they get the person picker. */
const LINK_KINDS = new Set(['request-item-link', 'response-row-match', 'unmatched-response-row']);
/** Kinds whose response-row subject may be manually validated. */
const VALIDATE_KINDS = new Set(['response-row-match', 'unmatched-response-row', 'request-item-link']);

function ReviewBody({ detail, onChanged }: { detail: ReviewItemDetail; onChanged: () => void }) {
  const { t } = useTranslation();
  const act = useAction();
  const [picker, setPicker] = useState(false);
  const [validating, setValidating] = useState(false);
  const [editingRow, setEditingRow] = useState(false);
  const [editingPerson, setEditingPerson] = useState<string | null>(null);
  const [reverting, setReverting] = useState(false);
  const [row, setRow] = useState<ResponseRow | null>(null);
  const { item, subjects } = detail;
  const [source, ...cands] = subjects;
  const open = item.state === 'open';
  const rowSubject = source?.kind === 'response-row' ? source : null;

  // The full row (dates, disposition, raw name) for the validate / edit dialogs.
  useEffect(() => {
    let alive = true;
    setRow(null);
    if (rowSubject)
      void findResponseRow(item.id, item.kind, rowSubject.id).then((r) => {
        if (alive) setRow(r);
      });
    return () => {
      alive = false;
    };
  }, [item.id, rowSubject?.id, detail]);

  const resolve = async (resolution: ReviewResolution, msg: string) => {
    const r = await act(vss().review.resolve({ id: item.id, resolution }), msg);
    if (!r) return;
    await next();
  };
  const next = async () => {
    const n = await vss().review.list({ offset: 0, limit: 1, state: 'open' });
    navigate(n.ok && n.value.items[0] ? `/review/${n.value.items[0].id}` : '/review');
  };

  const original = source?.edited ? source.original : undefined;
  const pick = (k: 'displayName' | 'dob' | 'sex' | 'pobCountry' | 'unitName'): string => {
    const v = original?.[k];
    return v === undefined || v === null ? '' : String(v);
  };
  const withOrig = (values: string[], o: string) => (original ? [...values, o] : values);
  const fields: DiffField[] = [
    {
      key: 'name',
      label: t('import.name'),
      kind: 'name',
      values: withOrig(
        subjects.map((s) => s.displayName),
        pick('displayName'),
      ),
    },
    {
      key: 'dob',
      label: t('import.dob'),
      kind: 'dob',
      values: withOrig(
        subjects.map((s) => s.dob ?? s.dobRaw),
        pick('dob'),
      ),
    },
    {
      key: 'sex',
      label: t('person.sex'),
      kind: 'text',
      values: withOrig(
        subjects.map((s) => s.sex ?? ''),
        pick('sex'),
      ),
    },
    {
      key: 'pob',
      label: t('person.pob'),
      kind: 'text',
      values: withOrig(
        subjects.map((s) => s.pobCountry ?? ''),
        pick('pobCountry'),
      ),
    },
    {
      key: 'unit',
      label: t('import.unit'),
      kind: 'text',
      values: withOrig(
        subjects.map((s) => s.unitName ?? ''),
        pick('unitName'),
      ),
    },
    {
      key: 'ids',
      label: t('items.ids'),
      kind: 'text',
      values: withOrig(
        subjects.map((s) => s.identifiers.join(', ')),
        '',
      ),
    },
  ];
  const headers = withOrig(
    subjects.map((s) => (s.edited ? `${s.source} (${t('reviewAct.edited')})` : s.source)),
    t('reviewAct.dcOriginal'),
  );

  const isLink = LINK_KINDS.has(item.kind);
  const canValidate = open && rowSubject !== null && VALIDATE_KINDS.has(item.kind);
  const rowLinked = row !== null && (row.match.decision === 'confirmed' || row.match.decision === 'auto');
  const persons = subjects.filter((s) => s.kind === 'person');
  const alternatives = {
    createNew: () => {
      setPicker(false);
      void resolve({ action: 'new-person' }, t('review.newPerson'));
    },
    notSame: () => {
      setPicker(false);
      void resolve({ action: 'not-same' }, t('review.notSame'));
    },
    dismiss: () => {
      setPicker(false);
      void resolve({ action: 'dismiss' }, t('review.dismissed'));
    },
  };

  return (
    <Stack>
      <PageHeader
        title={t(`reviewkind.${item.kind}`)}
        actions={
          <Button variant="default" onClick={() => navigate('/review')}>
            {t('review.backToList')}
          </Button>
        }
      />
      {item.candidates.length > 0 && (
        <Group gap="xs">
          {item.candidates.map((c) => (
            <Badge key={c.targetId} variant="outline" leftSection={<TierBadge tier={c.tier} />}>
              {c.evidence.join(', ')}
            </Badge>
          ))}
        </Group>
      )}
      <DiffGrid caption={t('review.diffCaption')} headers={headers} fields={fields} />
      {open && (
        <Group role="group" aria-label={t('review.actions')}>
          {isLink &&
            cands.map((c) => (
              <Button key={c.id} onClick={() => void resolve({ action: 'link', targetId: c.id }, t('review.linked'))}>
                {t('review.confirmCandidate', { name: c.displayName })}
              </Button>
            ))}
          {isLink && (
            <Button variant="default" onClick={() => setPicker(true)}>
              {t('reviewAct.choosePerson')}
            </Button>
          )}
          {isLink && (
            <Button variant="default" onClick={() => void resolve({ action: 'new-person' }, t('review.newPerson'))}>
              {t('review.createNew')}
            </Button>
          )}
          {canValidate && (
            <Button variant="light" color="teal" onClick={() => setValidating(true)}>
              {t('reviewAct.validate')}
            </Button>
          )}
          {item.kind === 'duplicate-persons' && subjects.length >= 2 && source && cands[0] && (
            <>
              <Button
                onClick={() =>
                  void resolve({ action: 'merge', survivorId: source.id, mergedId: cands[0]!.id }, t('review.merged'))
                }
              >
                {t('review.mergeKeep', { name: source.displayName })}
              </Button>
              <Button
                onClick={() =>
                  void resolve({ action: 'merge', survivorId: cands[0]!.id, mergedId: source.id }, t('review.merged'))
                }
              >
                {t('review.mergeKeep', { name: cands[0].displayName })}
              </Button>
            </>
          )}
          {item.kind === 'dob-conflict' &&
            subjects.map((s) => (
              <Button
                key={s.id}
                onClick={() => void resolve({ action: 'keep-dob', subjectId: s.id }, t('review.dobKept'))}
              >
                {t('review.keepDob', { name: s.displayName })}
              </Button>
            ))}
          {item.kind === 'disposition-unclear' && (
            <>
              <Button
                onClick={() =>
                  void resolve({ action: 'set-disposition', disposition: 'approved' }, t('reviewAct.dispositionSet'))
                }
              >
                {t('reviewAct.setApproved')}
              </Button>
              <Button
                onClick={() =>
                  void resolve(
                    { action: 'set-disposition', disposition: 'non-approved' },
                    t('reviewAct.dispositionSet'),
                  )
                }
              >
                {t('reviewAct.setNonApproved')}
              </Button>
            </>
          )}
          {(isLink || item.kind === 'duplicate-persons') && (
            <Button
              color="orange"
              variant="light"
              onClick={() => void resolve({ action: 'not-same' }, t('review.notSame'))}
            >
              {t('review.notSamePerson')}
            </Button>
          )}
          <Button variant="subtle" onClick={() => navigate('/review')}>
            {t('review.skip')}
          </Button>
          <Button
            variant="subtle"
            color="gray"
            onClick={() => void resolve({ action: 'dismiss' }, t('review.dismissed'))}
          >
            {t('review.dismiss')}
          </Button>
        </Group>
      )}
      {(rowSubject || persons.length > 0) && (
        <Group gap="xs">
          {rowSubject && (
            <Button
              size="compact-sm"
              variant="default"
              disabled={rowLinked || !row}
              onClick={() => setEditingRow(true)}
            >
              {t('reviewAct.editRow')}
            </Button>
          )}
          {rowSubject?.edited && (
            <Button size="compact-sm" variant="subtle" disabled={rowLinked} onClick={() => setReverting(true)}>
              {t('reviewAct.revert')}
            </Button>
          )}
          {persons.map((p) => (
            <Button key={p.id} size="compact-sm" variant="default" onClick={() => setEditingPerson(p.id)}>
              {t('reviewAct.editPerson', { name: p.displayName })}
            </Button>
          ))}
        </Group>
      )}
      {rowLinked && <Alert color="gray">{t('reviewAct.linkedNoEdit')}</Alert>}
      <PersonPicker
        opened={picker}
        title={t('reviewAct.choosePersonTitle')}
        onClose={() => setPicker(false)}
        forSubject={{ kind: 'review-item', id: item.id }}
        initialText={source?.displayName ?? ''}
        {...(source ? { subject: source } : {})}
        alternatives={alternatives}
        onPick={(p) => {
          setPicker(false);
          void resolve({ action: 'link', targetId: p.id }, t('review.linked'));
        }}
      />
      <ManualValidateDialog
        opened={validating}
        onClose={() => setValidating(false)}
        detail={detail}
        row={row}
        onDone={() => {
          setValidating(false);
          void next();
        }}
      />
      <EditRowDialog
        opened={editingRow}
        onClose={() => setEditingRow(false)}
        itemId={item.id}
        row={row}
        onDone={() => {
          setEditingRow(false);
          onChanged();
        }}
      />
      <EditPersonDialog
        opened={editingPerson !== null}
        onClose={() => setEditingPerson(null)}
        itemId={item.id}
        personId={editingPerson}
        onDone={() => {
          setEditingPerson(null);
          onChanged();
        }}
      />
      <ReasonDialog
        opened={reverting}
        title={t('reviewAct.revertTitle')}
        confirmLabel={t('reviewAct.revert')}
        onClose={() => setReverting(false)}
        onConfirm={async (reason) => {
          if (!rowSubject) return;
          const r = await act(
            vss().review.editSubject({
              id: item.id,
              subject: { kind: 'response-row', rowId: rowSubject.id, patch: {} },
              reason,
            }),
            t('reviewAct.reverted'),
          );
          setReverting(false);
          if (r) onChanged();
        }}
      />
    </Stack>
  );
}

export function ReviewDetailScreen({ id }: { id: string }) {
  const { t } = useTranslation();
  const q = useQuery(() => vss().review.get({ id }), [id]);
  return (
    <QueryBoundary loading={q.loading && !q.data} error={q.error}>
      {q.data && q.data.item.state !== 'open' ? <Alert color="blue">{t('review.alreadyResolved')}</Alert> : null}
      {q.data && <ReviewBody detail={q.data} onChanged={q.reload} />}
    </QueryBoundary>
  );
}
