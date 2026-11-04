import { Alert, Button, Group, List, Modal, Stack, Text } from '@mantine/core';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MatchEvidence, ResponseRow, ReviewKind } from '@shared/domain/types';
import type { ReviewItemDetail, ReviewResolution } from '@shared/ipc/contract';
import { DiffGrid } from '../../components/Diff';
import type { DiffField } from '../../components/Diff';
import { conflictLabels, IdentityConfirmDialog } from '../../components/IdentityConfirm';
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

/** Matcher evidence that contradicts an identity, by the field it is about (label key). */
const CONFLICT_FIELD: Partial<Record<MatchEvidence, string>> = {
  DOB_CONFLICT: 'import.dob',
  SEX_CONFLICT: 'person.sex',
  ID_CONFLICT: 'items.ids',
  FATHER_CONFLICT: 'identity.fatherName',
  POB_CONFLICT: 'person.pob',
  POB_PLACE_CONFLICT: 'person.pob',
  UNIT_CONFLICT: 'import.unit',
  NAME_SCRIPT_CONFLICT: 'import.name',
};
function evidenceConflictLabels(t: (k: string) => string, evidence: readonly MatchEvidence[]): string[] {
  return evidence.flatMap((e) => (CONFLICT_FIELD[e] ? [t(CONFLICT_FIELD[e])] : []));
}

/** "response Final_Results!13" -> "Response file, sheet Final_Results, row 13" (UI review O-38); others unchanged. */
export function sourceLabel(t: (k: string, o?: Record<string, string>) => string, source: string): string {
  const m = /^(response|request) (.+)$/.exec(source);
  if (!m) return source;
  const kind = m[1] as 'response' | 'request';
  const ref = /^(.+)!(\d+)$/.exec(m[2]!);
  return ref
    ? t(`reviewFlow.source.${kind}`, { sheet: ref[1]!, row: ref[2]! })
    : t(`reviewFlow.source.${kind}Ref`, { ref: m[2]! });
}

type Comparing = { kind: 'link'; index: number } | { kind: 'merge'; keepSource: boolean };

/** Which dismiss explanation applies: dismissing a row or an unanswered person can hide a vetting gap. */
function dismissKind(kind: ReviewKind): 'row' | 'unanswered' | 'other' {
  if (kind === 'response-row-match' || kind === 'unmatched-response-row' || kind === 'disposition-unclear')
    return 'row';
  return kind === 'unanswered-request-item' ? 'unanswered' : 'other';
}

function ReviewBody({ detail, onChanged }: { detail: ReviewItemDetail; onChanged: () => void }) {
  const { t } = useTranslation();
  const act = useAction();
  const [picker, setPicker] = useState(false);
  const [validating, setValidating] = useState(false);
  const [editingRow, setEditingRow] = useState(false);
  const [editingPerson, setEditingPerson] = useState<string | null>(null);
  const [reverting, setReverting] = useState(false);
  const [row, setRow] = useState<ResponseRow | null>(null);
  const [comparing, setComparing] = useState<Comparing | null>(null);
  const [dismissing, setDismissing] = useState(false);
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
    subjects.map((s) =>
      s.edited ? `${sourceLabel(t, s.source)} (${t('reviewAct.edited')})` : sourceLabel(t, s.source),
    ),
    t('reviewAct.dcOriginal'),
  );

  const isLink = LINK_KINDS.has(item.kind);
  const isIdentity = isLink || item.kind === 'duplicate-persons';
  /** Conflict evidence: fields that state different values, plus the matcher's own conflict codes. */
  const conflicts = [
    ...new Set([...conflictLabels(fields), ...item.candidates.flatMap((c) => evidenceConflictLabels(t, c.evidence))]),
  ];
  /** Two-column comparison of the source with subject `k` (1-based), for the explicit compare step. */
  const pairFields = (k: number): DiffField[] =>
    fields.map((f) => ({ ...f, values: [f.values[0] ?? '', f.values[k] ?? ''] }));
  const pairHeaders = (k: number): string[] => [headers[0] ?? '', headers[k] ?? ''];
  const evidenceConflicts = (k: number): string[] =>
    evidenceConflictLabels(t, item.candidates.find((x) => x.targetId === subjects[k]?.id)?.evidence ?? []);
  const canValidate = open && rowSubject !== null && VALIDATE_KINDS.has(item.kind);
  const rowLinked = row !== null && (row.match.decision === 'confirmed' || row.match.decision === 'auto');
  const persons = subjects.filter((s) => s.kind === 'person');
  /** Help and actions follow what is on screen (UI review R2O-11): no compare / "not the same" without a candidate. */
  const showCompare = (isLink && cands.length > 0) || (item.kind === 'duplicate-persons' && cands.length > 0);
  const showNotSame = showCompare;
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
      <Text size="sm">{t(`reviewFlow.intro.${item.kind}`)}</Text>
      {item.candidates.length > 0 && (
        <Stack gap={4}>
          {item.candidates.map((c) => (
            <Group key={c.targetId} gap="xs" wrap="nowrap" align="flex-start" data-testid="match-evidence">
              <TierBadge tier={c.tier} />
              <Text size="sm" title={c.evidence.join(', ')} style={{ flex: '1 1 0', minWidth: 0 }}>
                {c.evidence.map((e) => t(`evidence.${e}`, { defaultValue: e })).join('; ')}
              </Text>
            </Group>
          ))}
          <Text size="sm" c="dimmed">
            {t('identity.tierLegend')}
          </Text>
        </Stack>
      )}
      {open && isIdentity && conflicts.length > 0 && (
        <Alert color="orange" title={t('identity.conflictTitle')} data-testid="review-conflicts">
          {t('identity.conflictBody', { fields: conflicts.join(', ') })}
        </Alert>
      )}
      <DiffGrid caption={t(`reviewFlow.caption.${item.kind}`)} headers={headers} fields={fields} />
      {open && (
        <Group role="group" aria-label={t('review.actions')}>
          {isLink &&
            cands.map((c, k) => (
              <Button
                key={c.id}
                variant="default"
                // Short visible label (never truncated, UI review R2O-14); the name is in the accessible name and
                // in the dialog title.
                aria-label={t('identity.compareWith', { name: c.displayName })}
                title={t('identity.compareWith', { name: c.displayName })}
                onClick={() => setComparing({ kind: 'link', index: k + 1 })}
              >
                {cands.length > 1 ? t('reviewHelp.compareN', { n: k + 1 }) : t('reviewHelp.compareShort')}
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
            <Button variant="default" onClick={() => setValidating(true)}>
              {t('reviewAct.validate')}
            </Button>
          )}
          {item.kind === 'duplicate-persons' && subjects.length >= 2 && source && cands[0] && (
            <>
              <Button variant="default" onClick={() => setComparing({ kind: 'merge', keepSource: true })}>
                {t('review.mergeKeep', { name: source.displayName })}
              </Button>
              <Button variant="default" onClick={() => setComparing({ kind: 'merge', keepSource: false })}>
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
          {item.kind === 'unanswered-request-item' && detail.context && 'requestId' in detail.context && (
            <Button
              variant="default"
              data-testid="open-request"
              onClick={() => {
                const c = detail.context;
                if (c && 'requestId' in c) navigate(`/requests/${c.requestId}`);
              }}
            >
              {t('reviewHelp.openRequest')}
            </Button>
          )}
          {showNotSame && (
            <Button variant="default" onClick={() => void resolve({ action: 'not-same' }, t('review.notSame'))}>
              {t('review.notSamePerson')}
            </Button>
          )}
          <Button variant="subtle" onClick={() => navigate('/review')}>
            {t('review.skip')}
          </Button>
          <Button variant="subtle" color="gray" onClick={() => setDismissing(true)}>
            {t('review.dismiss')}
          </Button>
        </Group>
      )}
      {open && (
        <List size="sm" c="dimmed" spacing={2} data-testid="review-action-help">
          {showCompare && <List.Item>{t('reviewFlow.help.compare')}</List.Item>}
          {isLink && <List.Item>{t('reviewHelp.choose')}</List.Item>}
          {isLink && <List.Item>{t('reviewHelp.createNew')}</List.Item>}
          {canValidate && <List.Item>{t('reviewHelp.validate')}</List.Item>}
          {showNotSame && <List.Item>{t('reviewFlow.help.notSame')}</List.Item>}
          {item.kind === 'unanswered-request-item' && detail.context && 'requestId' in detail.context && (
            <List.Item>{t('reviewHelp.openRequestHelp')}</List.Item>
          )}
          <List.Item>{t('reviewFlow.help.skip')}</List.Item>
          <List.Item>{t('reviewFlow.help.dismiss')}</List.Item>
        </List>
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
      {comparing && (
        <IdentityConfirmDialog
          opened
          title={
            comparing.kind === 'link'
              ? t('identity.compareTitle', { name: subjects[comparing.index]?.displayName ?? '' })
              : t('identity.mergeTitle')
          }
          caption={t('identity.compareCaption')}
          headers={pairHeaders(comparing.kind === 'link' ? comparing.index : 1)}
          fields={pairFields(comparing.kind === 'link' ? comparing.index : 1)}
          extraConflicts={evidenceConflicts(comparing.kind === 'link' ? comparing.index : 1)}
          confirmLabel={
            comparing.kind === 'link'
              ? t('review.confirmCandidate', { name: subjects[comparing.index]?.displayName ?? '' })
              : t('review.mergeKeep', {
                  name: (comparing.keepSource ? source : cands[0])?.displayName ?? '',
                })
          }
          onBack={() => setComparing(null)}
          onConfirm={() => {
            const c = comparing;
            setComparing(null);
            if (c.kind === 'link') {
              const target = subjects[c.index];
              if (target) void resolve({ action: 'link', targetId: target.id }, t('review.linked'));
            } else if (source && cands[0]) {
              const [survivorId, mergedId] = c.keepSource ? [source.id, cands[0].id] : [cands[0].id, source.id];
              void resolve({ action: 'merge', survivorId, mergedId }, t('review.merged'));
            }
          }}
        />
      )}
      <Modal
        opened={dismissing}
        onClose={() => setDismissing(false)}
        title={t('reviewFlow.dismissTitle')}
        trapFocus
        returnFocus
      >
        <Text size="sm">{t(`reviewFlow.dismissBody.${dismissKind(item.kind)}`)}</Text>
        <Group justify="flex-end" mt="md">
          <Button variant="default" data-autofocus onClick={() => setDismissing(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            color="gray"
            onClick={() => {
              setDismissing(false);
              void resolve({ action: 'dismiss' }, t('review.dismissed'));
            }}
          >
            {t('reviewFlow.dismissConfirm')}
          </Button>
        </Group>
      </Modal>
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
