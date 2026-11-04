import { Alert, Badge, Button, Group, Modal, Select, Stack, Text } from '@mantine/core';
import { useEffect, useMemo, useRef, useState } from 'react';
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
import { DiscardDialog, Wizard } from '../components/Wizard';
import type { WizardStep } from '../components/Wizard';
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

/** What a picked file turned out to be: a usable preview, the wrong kind of workbook, or a plain failure. */
type Loaded =
  | { kind: 'ok'; preview: ResponsePreview }
  | { kind: 'wrong'; fileName: string; detected: 'request' | 'other' }
  | { kind: 'error'; message: string };
type Problem = Exclude<Loaded, { kind: 'ok' }>;

const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p;

/** Release a preview held in main. Best effort: an already consumed or expired id is a no-op on the main side. */
function discardQuietly(previewId: string | null): void {
  if (previewId)
    void vss()
      .responses.discardPreview({ previewId })
      .catch(() => undefined);
}

/**
 * Parse a file in the response importer. A file that is a request workbook (or otherwise not a response) is
 * reported as `wrong` and its preview is dropped from main at once; any other failure is `error` (never thrown).
 * `WRONG_FILE_KIND` is the code lane C uses for a request workbook; `fileKindGuess` and the LOOKS_LIKE_REQUEST issue
 * cover a preview that comes back ok but says so.
 */
async function fetchPreview(path: string, requestId: string | null, fileName: string): Promise<Loaded> {
  try {
    const r = await vss().responses.importPreview({ path, ...(requestId ? { requestId } : {}) });
    if (!r.ok) {
      return r.error.code === 'WRONG_FILE_KIND'
        ? { kind: 'wrong', fileName, detected: 'request' }
        : { kind: 'error', message: r.error.message };
    }
    const pv = r.value;
    const detected =
      pv.fileKindGuess === 'investc-request' || pv.issues.some((i) => i.code === 'LOOKS_LIKE_REQUEST')
        ? 'request'
        : pv.fileKindGuess === 'unknown'
          ? 'other'
          : null;
    if (detected) {
      discardQuietly(pv.previewId);
      return { kind: 'wrong', fileName, detected };
    }
    return { kind: 'ok', preview: pv };
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : 'Unexpected error' };
  }
}

export function ImportResponseScreen({ requestId }: { requestId?: string }) {
  const { t } = useTranslation();
  const act = useAction();
  const [step, setStep] = useState(0);
  const [path, setPath] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<ResponsePreview | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [chosenRequest, setChosenRequest] = useState<string | null>(requestId ?? null);
  const [request, setRequest] = useState<VettingRequest | null>(null);
  /** rowId -> explicit decision; auto rows and rows without candidates need none. */
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [diffRow, setDiffRow] = useState<ResponsePreviewRow | null>(null);
  const [busy, setBusy] = useState(false);
  /** Set while a "discard your decisions?" confirmation for an action outside the wizard's own Cancel is open. */
  const [pendingDiscard, setPendingDiscard] = useState<(() => void) | null>(null);
  /** The preview id this screen holds in main; released when replaced, cancelled or left. */
  const heldId = useRef<string | null>(null);
  useEffect(() => () => discardQuietly(heldId.current), []);

  /** Load a file, optionally matched against `rid`. File-first: the best-ranked request is proposed, never committed. */
  const open = async (p: string, name: string, rid: string | null, propose: boolean): Promise<void> => {
    let loaded = await fetchPreview(p, rid, name);
    if (loaded.kind === 'ok' && propose && !rid && loaded.preview.suggestedRequestId) {
      const suggested = loaded.preview.suggestedRequestId;
      discardQuietly(loaded.preview.previewId);
      loaded = await fetchPreview(p, suggested, name);
    }
    // The preview this screen held is replaced now, so it leaves main now.
    const previous = heldId.current;
    heldId.current = loaded.kind === 'ok' ? loaded.preview.previewId : null;
    discardQuietly(previous);
    setPath(p);
    setFileName(name);
    setChoices({});
    setDiffRow(null);
    if (loaded.kind !== 'ok') {
      setPreview(null);
      setProblem(loaded);
      setChosenRequest(null);
      setRequest(null);
      setStep(0);
      return;
    }
    const pv = loaded.preview;
    setPreview(pv);
    setProblem(null);
    setChosenRequest(pv.matchedRequestId);
    setStep(1);
    if (pv.matchedRequestId) {
      const full = await vss().requests.get({ id: pv.matchedRequestId });
      setRequest(full.ok ? full.value : null);
    } else setRequest(null);
  };

  const pick = async () => {
    const f = await act(vss().files.pickOpen({ kind: 'response-xlsx', title: t('responseImport.pickTitle') }));
    if (!f?.path) return;
    await open(f.path, baseName(f.displayPath ?? '') || t('wizard.thisFile'), requestId ?? null, true);
  };

  const hasWork = Object.keys(choices).length > 0;
  /** Runs `action` now, or after the user confirms when entered decisions would be lost. */
  const guarded = (action: () => void) => {
    if (hasWork) setPendingDiscard(() => action);
    else action();
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
      heldId.current = null;
      navigate(chosenRequest ? `/requests/${chosenRequest}` : '/responses');
    } finally {
      setBusy(false);
    }
  };

  /** Cancel: the preview leaves memory at once and the user goes back to where the import started. */
  const cancel = () => {
    discardQuietly(heldId.current);
    heldId.current = null;
    navigate(requestId ? `/requests/${requestId}` : '/responses');
  };

  const steps: WizardStep[] = [
    { id: 'pick', label: t('wizard.steps.pick') },
    { id: 'match', label: t('wizard.steps.match') },
    { id: 'decide', label: t('wizard.steps.decide') },
    { id: 'confirm', label: t('wizard.steps.confirm') },
  ];
  const confirmLast = step === steps.length - 1;
  const nextDisabled =
    !preview || (step === 2 && undecided.length > 0) || (confirmLast && (!preview.canCommit || undecided.length > 0));
  const onNext = () => {
    if (confirmLast) void commit();
    else setStep(step + 1);
  };

  const pickButton = (
    <Button
      variant={preview || problem ? 'default' : 'filled'}
      onClick={() => guarded(() => void pick())}
      disabled={busy}
    >
      {preview || problem ? t('wizard.chooseAnother') : t('responseImport.pick')}
    </Button>
  );

  return (
    <Stack>
      <PageHeader
        title={preview ? t('responseImport.previewTitle', { name: preview.fileName }) : t('responseImport.title')}
      />
      <Wizard
        steps={steps}
        current={step}
        onBack={step > 0 ? () => setStep(step - 1) : null}
        onNext={onNext}
        nextLabel={confirmLast ? t('responseImport.commit') : t('wizard.next')}
        nextDisabled={nextDisabled}
        nextLoading={busy && confirmLast}
        dirty={hasWork}
        onCancel={cancel}
      >
        {step === 0 && (
          <Stack>
            {!preview && !problem && (
              <Text>{requestId ? t('responseImport.introRequest') : t('responseImport.introFile')}</Text>
            )}
            {preview && <Text>{t('wizard.fileReady', { name: preview.fileName })}</Text>}
            {problem?.kind === 'wrong' && (
              <Alert color="orange" title={t('wizard.wrongKind.title')}>
                <Stack gap="sm">
                  <Text size="sm">
                    {problem.detected === 'request'
                      ? t('wizard.wrongKind.requestBody', { name: problem.fileName })
                      : t('wizard.wrongKind.otherBody', { name: problem.fileName })}
                  </Text>
                  <Group>
                    {pickButton}
                    {problem.detected === 'request' && (
                      <Button variant="default" onClick={() => navigate('/requests/import')}>
                        {t('wizard.wrongKind.openRequestImporter')}
                      </Button>
                    )}
                  </Group>
                </Stack>
              </Alert>
            )}
            {problem?.kind === 'error' && (
              <Alert color="red" title={t('wizard.importFailed.title')}>
                <Stack gap="sm">
                  <Text size="sm">{problem.message}</Text>
                  <Text size="sm">{t('wizard.importFailed.body')}</Text>
                  <Group>{pickButton}</Group>
                </Stack>
              </Alert>
            )}
            {!problem && <Group>{pickButton}</Group>}
          </Stack>
        )}

        {step === 1 && preview && (
          <Stack>
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
                onChange={(v) => {
                  if (path) guarded(() => void open(path, fileName, v || null, false));
                }}
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
          </Stack>
        )}

        {step === 2 && preview && (
          <Stack>
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
                      {tier === 'T1' && r.decision === 'auto' && (
                        <Text size="xs">{t('responseImport.preConfirmed')}</Text>
                      )}
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
              <Alert
                color="orange"
                title={t('responseImport.unansweredTitle', { count: preview.unansweredItemIds.length })}
              >
                <ul style={{ margin: 0 }}>
                  {preview.unansweredItemIds.map((id) => (
                    <li key={id}>
                      <Sensitive value={itemLabel(request, id)} />
                    </li>
                  ))}
                </ul>
              </Alert>
            )}
            {undecided.length > 0 && (
              <Text size="sm">{t('responseImport.needChoice', { count: undecided.length })}</Text>
            )}
          </Stack>
        )}

        {step === 3 && preview && (
          <Stack>
            <Text size="sm">{t('wizard.confirmText')}</Text>
            {!preview.canCommit && <Alert color="red">{t('wizard.cannotCommit')}</Alert>}
            {undecided.length > 0 && (
              <Text size="sm">{t('responseImport.needChoice', { count: undecided.length })}</Text>
            )}
          </Stack>
        )}
      </Wizard>

      {diffRow && <RowDiffDialog row={diffRow} request={request} onClose={() => setDiffRow(null)} />}
      <DiscardDialog
        opened={pendingDiscard !== null}
        onKeep={() => setPendingDiscard(null)}
        onDiscard={() => {
          const action = pendingDiscard;
          setPendingDiscard(null);
          action?.();
        }}
      />
    </Stack>
  );
}
