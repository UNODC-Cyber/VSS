import { Alert, Badge, Button, Group, Modal, Select, Stack, Text } from '@mantine/core';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { VettingRequest } from '@shared/domain/types';
import type { MatchCandidate } from '@shared/domain/types';
import type {
  PersonDetail,
  ResponsePreview,
  ResponsePreviewRow,
  ResponseRowDecision,
  ResponseSummary,
} from '@shared/ipc/contract';
import { col, DataTable } from '../components/DataTable';
import { DiffGrid } from '../components/Diff';
import type { DiffField } from '../components/Diff';
import { PageHeader, QueryBoundary, Sensitive, SimplePager, TierBadge } from '../components/common';
import { useAction, useQuery, vss } from '../lib/api';
import { fmtDate, fmtDateTime } from '../lib/format';
import { navigate } from '../lib/router';

const PAGE = 25;

export function ResponsesScreen() {
  const { t } = useTranslation();
  const [offset, setOffset] = useState(0);
  const q = useQuery(() => vss().responses.list({ offset, limit: PAGE }), [offset]);
  return (
    <Stack>
      <PageHeader
        title={t('responses.title')}
        actions={<Button onClick={() => navigate('/responses/import')}>{t('responses.import')}</Button>}
      />
      <QueryBoundary loading={q.loading && !q.data} error={q.error}>
        {q.data && (
          <>
            <DataTable<ResponseSummary>
              caption={t('responses.caption')}
              data={q.data.items}
              empty={t('responses.empty')}
              rowId={(r) => r.id}
              columns={[
                col<ResponseSummary>('batch', t('responses.batch'), (r) => r.batchId),
                col<ResponseSummary>('post', t('responses.post'), (r) => r.post),
                col<ResponseSummary>('asof', t('responses.asOf'), (r) => fmtDate(r.resultsAsOf)),
                col<ResponseSummary>('imported', t('responses.imported'), (r) => fmtDateTime(r.importedAt)),
                col<ResponseSummary>('rows', t('responses.rows'), (r) => r.rowCount),
                col<ResponseSummary>('approved', t('responses.approved'), (r) => r.approvedCount),
                col<ResponseSummary>('non', t('responses.nonApproved'), (r) => r.nonApprovedCount),
                col<ResponseSummary>('unres', t('responses.unresolved'), (r) =>
                  r.unresolvedCount ? <Badge color="orange">{r.unresolvedCount}</Badge> : '-',
                ),
                col<ResponseSummary>('req', t('responses.request'), (r) =>
                  r.requestId ? <a href={`#/requests/${r.requestId}`}>{t('responses.openRequest')}</a> : '-',
                ),
              ]}
            />
            <SimplePager total={q.data.total} offset={offset} limit={PAGE} onChange={setOffset} />
          </>
        )}
      </QueryBoundary>
    </Stack>
  );
}

// ------------------------------------------------------------------------------------------------------------

/** Explicit row decision in the preview; 'review' leaves the row pending (it becomes a review item). */
type Choice = { kind: 'item'; itemId: string } | { kind: 'review' } | { kind: 'new' } | { kind: 'skip' };
const choiceValue = (c: Choice | undefined): string | null => (!c ? null : c.kind === 'item' ? c.itemId : c.kind);
const needsChoice = (r: ResponsePreviewRow): boolean => r.decision !== 'auto' && r.candidates.length > 0;

const bestTier = (cs: MatchCandidate[]) => [...cs].sort((a, b) => a.tier.localeCompare(b.tier))[0]?.tier ?? null;
const itemLabel = (r: VettingRequest, id: string) => {
  const i = r.items.find((x) => x.id === id);
  return i ? `${i.observed.surname}, ${i.observed.name1}` : id;
};

function RowDiffDialog({
  row,
  request,
  onClose,
}: {
  row: ResponsePreviewRow;
  request: VettingRequest | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [persons, setPersons] = useState<Record<string, PersonDetail>>({});
  useEffect(() => {
    for (const c of row.candidates) {
      if (c.targetKind === 'person') {
        void vss()
          .persons.get({ id: c.targetId })
          .then((r) => r.ok && setPersons((p) => ({ ...p, [c.targetId]: r.value })));
      }
    }
  }, [row]);

  const cols: { header: string; name: string; dob: string; unit: string; tier: string }[] = [
    {
      header: t('diff.responseRow', { row: row.rowRef }),
      name: row.nameRaw,
      dob: row.dobRaw,
      unit: row.unitName,
      tier: '',
    },
  ];
  for (const c of row.candidates) {
    if (c.targetKind === 'request-item') {
      const it = request?.items.find((i) => i.id === c.targetId);
      if (it)
        cols.push({
          header: t('diff.candidateItem', { tier: c.tier, row: it.observed.rowRef }),
          name: `${it.observed.surname}, ${[it.observed.name1, it.observed.name2].filter(Boolean).join(' ')}`,
          dob: it.observed.dob.parsed ?? it.observed.dob.value,
          unit: it.observed.unitName,
          tier: c.tier,
        });
    } else {
      const p = persons[c.targetId];
      if (p)
        cols.push({
          header: t('diff.candidatePerson', { tier: c.tier }),
          name: `${p.person.canonical.surname}, ${p.person.canonical.given.join(' ')}`,
          dob: p.person.dob ?? '',
          unit: p.units[0]?.name ?? '',
          tier: c.tier,
        });
    }
  }
  const fields: DiffField[] = [
    { key: 'name', label: t('import.name'), kind: 'name', values: cols.map((c) => c.name) },
    { key: 'dob', label: t('import.dob'), kind: 'dob', values: cols.map((c) => c.dob) },
    { key: 'unit', label: t('import.unit'), kind: 'text', values: cols.map((c) => c.unit) },
  ];
  return (
    <Modal opened onClose={onClose} title={t('diff.title')} size="xl" trapFocus returnFocus>
      <DiffGrid caption={t('diff.caption')} headers={cols.map((c) => c.header)} fields={fields} />
      <Text size="sm" c="dimmed" mt="xs">
        {t('diff.evidence', { list: row.candidates.flatMap((c) => c.evidence).join(', ') || '-' })}
      </Text>
      <Group justify="flex-end" mt="md">
        <Button onClick={onClose} data-autofocus>
          {t('common.close')}
        </Button>
      </Group>
    </Modal>
  );
}

export function ImportResponseScreen({ requestId }: { requestId?: string }) {
  const { t } = useTranslation();
  const act = useAction();
  const [path, setPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<ResponsePreview | null>(null);
  const [chosenRequest, setChosenRequest] = useState<string | null>(requestId ?? null);
  const [request, setRequest] = useState<VettingRequest | null>(null);
  /** rowId -> explicit decision; auto rows and rows without candidates need none. */
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [diffRow, setDiffRow] = useState<ResponsePreviewRow | null>(null);
  const [busy, setBusy] = useState(false);

  /** Preview matched against `rid`. File-first: the best-ranked request is proposed (and matched), never committed. */
  const load = async (p: string, rid: string | null, propose = false): Promise<void> => {
    const pv = await act(vss().responses.importPreview({ path: p, ...(rid ? { requestId: rid } : {}) }));
    if (!pv) return;
    if (propose && !rid && pv.suggestedRequestId) return load(p, pv.suggestedRequestId);
    setPreview(pv);
    setChosenRequest(pv.matchedRequestId);
    setChoices({});
    if (pv.matchedRequestId) {
      const full = await vss().requests.get({ id: pv.matchedRequestId });
      setRequest(full.ok ? full.value : null);
    } else setRequest(null);
  };

  const pick = async () => {
    const f = await act(vss().files.pickOpen({ kind: 'response-xlsx', title: t('responseImport.pickTitle') }));
    if (!f?.path) return;
    setPath(f.path);
    await load(f.path, requestId ?? null, true);
  };

  const undecided = useMemo(
    () => (preview ? preview.rows.filter((r) => needsChoice(r) && !choices[r.rowId]) : []),
    [preview, choices],
  );

  const commit = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      const decisions: Record<string, ResponseRowDecision> = {};
      for (const [rowId, c] of Object.entries(choices)) {
        if (c.kind === 'item') decisions[rowId] = c.itemId;
        else if (c.kind === 'skip' || c.kind === 'new') decisions[rowId] = c.kind;
      }
      const res = await act(
        vss().responses.importCommit({ previewId: preview.previewId, requestId: chosenRequest, decisions }),
        t('responseImport.done'),
      );
      if (!res) return;
      navigate(chosenRequest ? `/requests/${chosenRequest}` : '/responses');
    } finally {
      setBusy(false);
    }
  };

  if (!preview) {
    return (
      <Stack>
        <PageHeader title={t('responseImport.title')} />
        <Text>{requestId ? t('responseImport.introRequest') : t('responseImport.introFile')}</Text>
        <Group>
          <Button onClick={() => void pick()}>{t('responseImport.pick')}</Button>
        </Group>
      </Stack>
    );
  }

  return (
    <Stack>
      <PageHeader title={t('responseImport.previewTitle', { name: preview.fileName })} />
      {!requestId && (
        <Select
          label={t('responseImport.requestLabel')}
          description={t('responseImport.requestHelp')}
          data={[
            { value: '', label: t('responseImport.noRequest') },
            ...preview.requestCandidates.map((c) => ({
              value: c.requestId,
              label: `${c.eventName} (${t('responseImport.score', { score: c.score.toFixed(2) })})${c.requestId === preview.suggestedRequestId ? ` - ${t('responseImport.suggested')}` : ''}`,
            })),
          ]}
          value={chosenRequest ?? ''}
          allowDeselect={false}
          onChange={(v) => path && void load(path, v || null)}
        />
      )}
      <Group gap="sm" role="group" aria-label={t('responseImport.summary')}>
        <Badge size="lg" color="green">
          {t('responseImport.auto', { count: preview.autoMatchedCount })}
        </Badge>
        <Badge size="lg" color="yellow">
          {t('responseImport.review', { count: preview.needsReviewCount })}
        </Badge>
        <Badge size="lg" color="gray">
          {t('responseImport.unmatched', { count: preview.unmatchedCount })}
        </Badge>
      </Group>
      {preview.duplicateOfResponseId && <Alert color="orange">{t('responseImport.duplicate')}</Alert>}
      {preview.issues.map((iss, n) => (
        <Alert key={n} color={iss.severity === 'error' ? 'red' : 'yellow'}>
          {iss.message}
        </Alert>
      ))}

      <DataTable<ResponsePreviewRow>
        caption={t('responseImport.rowsCaption')}
        data={preview.rows}
        rowId={(r) => r.rowId}
        columns={[
          col<ResponsePreviewRow>('row', t('import.row'), (r) => r.rowRef),
          col<ResponsePreviewRow>(
            'section',
            t('responseImport.section'),
            (r) => `${t(`section.${r.section}`)} (${r.disp})`,
          ),
          col<ResponsePreviewRow>('name', t('import.name'), (r) => <Sensitive value={r.nameRaw} />),
          col<ResponsePreviewRow>('dob', t('import.dob'), (r) => <Sensitive value={r.dobRaw} />),
          col<ResponsePreviewRow>(
            'cert',
            t('responseImport.cert'),
            (r) => `${fmtDate(r.certDate)} / ${fmtDate(r.expires)}`,
          ),
          col<ResponsePreviewRow>('tier', t('responseImport.tier'), (r) => {
            const tier = bestTier(r.candidates);
            return tier ? (
              <Group gap={4}>
                <TierBadge tier={tier} />
                {tier === 'T1' && r.decision === 'auto' && <Text size="xs">{t('responseImport.preConfirmed')}</Text>}
              </Group>
            ) : (
              <Text size="sm">{t('responseImport.noCandidate')}</Text>
            );
          }),
          col<ResponsePreviewRow>('choice', t('responseImport.decision'), (r) => {
            if (r.decision === 'auto') return <Text size="sm">{t('responseImport.autoConfirmed')}</Text>;
            if (r.candidates.length === 0) return <Text size="sm">{t('responseImport.stayUnmatched')}</Text>;
            const individual = r.section === 'approved-individual' || r.section === 'nonapproved-individual';
            return (
              <Group gap={4} wrap="nowrap">
                <Select
                  aria-label={t('responseImport.chooseFor', { row: r.rowRef })}
                  placeholder={t('responseImport.choose')}
                  size="xs"
                  value={choiceValue(choices[r.rowId])}
                  allowDeselect={false}
                  data={[
                    ...r.candidates.map((cand) => ({
                      value: cand.targetId,
                      label: `${cand.tier}: ${request && cand.targetKind === 'request-item' ? itemLabel(request, cand.targetId) : cand.targetId.slice(-6)}`,
                    })),
                    { value: 'review', label: t('responseImport.leaveForReview') },
                    ...(individual ? [{ value: 'new', label: t('responseImport.newPerson') }] : []),
                    { value: 'skip', label: t('responseImport.notMatch') },
                  ]}
                  onChange={(v) => {
                    if (!v) return;
                    const c: Choice =
                      v === 'review' || v === 'new' || v === 'skip' ? { kind: v } : { kind: 'item', itemId: v };
                    setChoices({ ...choices, [r.rowId]: c });
                  }}
                />
                <Button
                  size="compact-xs"
                  variant="light"
                  onClick={() => setDiffRow(r)}
                  aria-label={t('responseImport.compareRow', { row: r.rowRef })}
                >
                  {t('responseImport.compare')}
                </Button>
              </Group>
            );
          }),
        ]}
      />

      {preview.unansweredItemIds.length > 0 && request && (
        <Alert color="orange" title={t('responseImport.unansweredTitle', { count: preview.unansweredItemIds.length })}>
          <ul style={{ margin: 0 }}>
            {preview.unansweredItemIds.map((id) => (
              <li key={id}>
                <Sensitive value={itemLabel(request, id)} />
              </li>
            ))}
          </ul>
        </Alert>
      )}

      <Group>
        <Button onClick={() => void commit()} disabled={!preview.canCommit || undecided.length > 0} loading={busy}>
          {t('responseImport.commit')}
        </Button>
        {undecided.length > 0 && <Text size="sm">{t('responseImport.needChoice', { count: undecided.length })}</Text>}
      </Group>
      {diffRow && <RowDiffDialog row={diffRow} request={request} onClose={() => setDiffRow(null)} />}
    </Stack>
  );
}
