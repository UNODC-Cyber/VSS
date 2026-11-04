import { Alert, Badge, Button, Card, Checkbox, Group, Stack, Text, Textarea, TextInput, Title } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ExportDecision, ValidationIssue } from '@shared/domain/types';
import type { RequestorRecord } from '@shared/domain/types';
import type { ImportPreview, ImportPreviewItem } from '@shared/ipc/contract';
import { col, DataTable } from '../components/DataTable';
import { LinkBadge, PageHeader, Sensitive, StatusBadge } from '../components/common';
import {
  affectedRequests,
  EMPTY_REQUESTOR,
  RequestorChoiceModal,
  RequestorField,
  toRequestor,
} from '../components/RequestorField';
import type { RequestorForm } from '../components/RequestorField';
import { DiscardDialog, Wizard } from '../components/Wizard';
import type { WizardStep } from '../components/Wizard';
import { useAction, useBusyAction, vss } from '../lib/api';
import { navigate } from '../lib/router';
import { useUi } from '../store';

// ------------------------------------------------------------------------------------------------------------
// Import wizard
// ------------------------------------------------------------------------------------------------------------

interface Decision {
  include: boolean;
  reason: string;
}
const isIncluded = (d: ExportDecision) => d === 'include' || d === 'manual-include';
const isFlagged = (i: ImportPreviewItem) =>
  i.linkState === 'pending-review' || i.issues.some((x) => x.severity !== 'info');

export function ImportRequestScreen() {
  const { t } = useTranslation();
  const act = useAction();
  const toast = useUi((s) => s.pushToast);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [focusRow, setFocusRow] = useState<string | null>(null);
  const [requestor, setRequestor] = useState<RequestorForm>(EMPTY_REQUESTOR);
  const [saved, setSaved] = useState<RequestorRecord | null>(null);
  const [askCount, setAskCount] = useState<number | null>(null);
  const [form, setForm] = useState({
    eventName: '',
    eventStart: '',
    eventEnd: '',
    eventLocation: '',
    notes: '',
  });
  const [busy, setBusy] = useState(false);
  const picker = useBusyAction();
  const [step, setStep] = useState(0);
  const [pendingDiscard, setPendingDiscard] = useState<(() => void) | null>(null);
  /** The preview id this screen holds in main; released when replaced, cancelled or left (no-op once committed). */
  const heldId = useRef<string | null>(null);
  const discardHeld = () => {
    const id = heldId.current;
    heldId.current = null;
    if (id)
      void vss()
        .requests.discardPreview({ previewId: id })
        .catch(() => undefined);
  };
  useEffect(
    () => () => {
      const id = heldId.current;
      if (id)
        void vss()
          .requests.discardPreview({ previewId: id })
          .catch(() => undefined);
    },
    [],
  );

  const pick = async () => {
    const f = await picker.act(() => vss().files.pickOpen({ kind: 'request-xlsx', title: t('import.pickTitle') }));
    if (!f?.path) return;
    const p = await act(vss().requests.importPreview({ path: f.path }));
    if (!p) return;
    discardHeld();
    heldId.current = p.previewId;
    setPreview(p);
    setDecisions(
      Object.fromEntries(
        p.items.map((i) => [i.rowRef, { include: isIncluded(i.exportDecision), reason: i.exportReason }]),
      ),
    );
  };

  const jumpTo = (rowRef: string | null) => {
    if (!rowRef) return;
    setFocusRow(rowRef);
    const el = document.getElementById(`row-${rowRef}`);
    el?.scrollIntoView?.({ block: 'center' });
    el?.focus();
  };

  const commit = async (choice?: 'update' | 'only-this-request') => {
    if (!preview) return;
    const affected = affectedRequests(requestor, saved);
    if (affected !== null && !choice) {
      setAskCount(affected);
      return;
    }
    setAskCount(null);
    setBusy(true);
    try {
      const s = await act(
        vss().requests.importCommit({
          previewId: preview.previewId,
          requestor: toRequestor(requestor, choice),
          eventName: form.eventName.trim(),
          eventStart: form.eventStart || null,
          eventEnd: form.eventEnd || null,
          eventLocation: form.eventLocation.trim() || null,
          notes: form.notes,
          // Rows whose export choice differs from the policy proposal, committed in the same transaction.
          exportDecisions: preview.items.flatMap((pi) => {
            const d = decisions[pi.rowRef];
            return d && d.include !== isIncluded(pi.exportDecision)
              ? [
                  {
                    rowRef: pi.rowRef,
                    decision: d.include ? ('manual-include' as const) : ('manual-exclude' as const),
                    reason: d.reason.trim(),
                  },
                ]
              : [];
          }),
        }),
        t('import.done'),
      );
      if (!s) return;
      heldId.current = null;
      if (s.templateCaptured)
        toast({
          kind: 'info',
          message: t('templates.captured', { version: s.templateCaptured.templateVersion ?? '?' }),
        });
      navigate(`/requests/${s.id}`);
    } finally {
      setBusy(false);
    }
  };

  const steps: WizardStep[] = [
    { id: 'pick', label: t('wizard.steps.pick') },
    { id: 'review', label: t('wizard.steps.reviewRequestor') },
    { id: 'confirm', label: t('wizard.steps.confirm') },
  ];
  const confirmLast = step === steps.length - 1;

  /** Cancel drops the held preview from main's memory at once. */
  const cancel = () => {
    discardHeld();
    navigate('/requests');
  };
  const guarded = (action: () => void) => (preview ? setPendingDiscard(() => action) : action());

  const counts = {
    include: Object.values(decisions).filter((d) => d.include).length,
    exclude: Object.values(decisions).filter((d) => !d.include).length,
    flagged: preview ? preview.items.filter(isFlagged).length : 0,
  };
  const reasonMissing =
    !!preview &&
    preview.items.some((i) => {
      const d = decisions[i.rowRef];
      return d && d.include !== isIncluded(i.exportDecision) && d.reason.trim().length < 3;
    });
  const formValid = requestor.name.trim() !== '' && form.eventName.trim() !== '';
  const bySeverity = (sev: ValidationIssue['severity']) =>
    preview ? preview.issues.filter((i) => i.severity === sev) : [];

  const nextDisabled =
    !preview ||
    (step === 1 && (!formValid || reasonMissing)) ||
    (confirmLast && (!preview.canCommit || !formValid || reasonMissing));
  const onNext = () => {
    if (confirmLast) void commit();
    else setStep(step + 1);
  };

  const countBadges = (
    <Group gap="sm" aria-label={t('import.summary')} role="group">
      <Badge size="lg" color="green" data-testid="count-include">
        {t('import.countInclude', { count: counts.include })}
      </Badge>
      <Badge size="lg" color="gray" data-testid="count-exclude">
        {t('import.countExclude', { count: counts.exclude })}
      </Badge>
      <Badge size="lg" color="orange" data-testid="count-flagged">
        {t('import.countFlagged', { count: counts.flagged })}
      </Badge>
    </Group>
  );

  return (
    <Stack>
      <PageHeader title={t('import.title')} />
      {preview && <Text size="sm">{t('importFlow.fileShown', { name: preview.fileName })}</Text>}
      <Wizard
        steps={steps}
        current={step}
        onBack={step > 0 ? () => setStep(step - 1) : null}
        onNext={onNext}
        nextLabel={confirmLast ? t('import.commit') : t('wizard.next')}
        nextDisabled={nextDisabled}
        nextHint={
          step >= 1 && preview
            ? !formValid
              ? t('importFlow.needDetails')
              : reasonMissing
                ? t('import.reasonNeeded')
                : null
            : null
        }
        nextLoading={busy && confirmLast}
        dirty={preview !== null}
        onCancel={cancel}
      >
        {step === 0 && (
          <Stack>
            <Text>{preview ? t('wizard.fileReady', { name: preview.fileName }) : t('import.intro')}</Text>
            <Group>
              <Button
                variant={preview ? 'default' : 'filled'}
                onClick={() => guarded(() => void pick())}
                loading={picker.busy}
              >
                {preview ? t('import.chooseAnother') : t('import.pick')}
              </Button>
            </Group>
          </Stack>
        )}

        {step === 1 && preview && (
          <Stack>
            {preview.duplicateOfRequestId && (
              <Alert color="orange" title={t('import.duplicateTitle')}>
                {t('import.duplicateBody')}{' '}
                <a href={`#/requests/${preview.duplicateOfRequestId}`}>{t('import.openExisting')}</a>
              </Alert>
            )}
            {countBadges}
            {(['error', 'warning', 'info'] as const).map((sev) => {
              const list = bySeverity(sev);
              if (list.length === 0) return null;
              return (
                <Card key={sev} withBorder padding="sm" aria-label={t(`severity.${sev}`)}>
                  <Title order={2} size="h4">
                    {t(`severity.${sev}`)} ({list.length})
                  </Title>
                  <ul style={{ margin: 0, paddingLeft: 20 }}>
                    {list.map((iss, n) => (
                      <li key={`${iss.code}-${n}`}>
                        {iss.rowRef ? (
                          <Button variant="subtle" size="compact-sm" onClick={() => jumpTo(iss.rowRef)}>
                            {iss.rowRef}: {iss.message}
                          </Button>
                        ) : (
                          <Text size="sm" component="span">
                            {iss.message}
                          </Text>
                        )}
                      </li>
                    ))}
                  </ul>
                </Card>
              );
            })}

            <DataTable<ImportPreviewItem>
              caption={t('import.itemsCaption')}
              tableId="import-request"
              data={preview.items}
              rowId={(i) => i.rowRef}
              rowProps={(i) => ({
                id: `row-${i.rowRef}`,
                tabIndex: -1,
                ...(focusRow === i.rowRef ? { 'data-focused': 'true' } : {}),
              })}
              columns={[
                col<ImportPreviewItem>('name', t('import.name'), (i) => <Sensitive value={i.displayName} />, {
                  sticky: 'first',
                  minWidth: 200,
                  grow: true,
                  truncate: true,
                  tooltip: (i) => i.displayName,
                }),
                col<ImportPreviewItem>(
                  'export',
                  t('import.export'),
                  (i) => {
                    const d = decisions[i.rowRef] ?? { include: true, reason: '' };
                    const changed = d.include !== isIncluded(i.exportDecision);
                    return (
                      <Stack gap={4}>
                        <Checkbox
                          label={t('import.includeInExport')}
                          aria-label={t('import.includeRow', { row: i.rowRef })}
                          checked={d.include}
                          onChange={(e) => {
                            const include = e.currentTarget.checked;
                            setDecisions((prev) => ({ ...prev, [i.rowRef]: { include, reason: '' } }));
                          }}
                        />
                        {changed ? (
                          <TextInput
                            size="xs"
                            aria-label={t('import.reasonFor', { row: i.rowRef })}
                            placeholder={t('common.reason')}
                            value={d.reason}
                            onChange={(e) => {
                              const reason = e.currentTarget.value;
                              setDecisions((prev) => ({
                                ...prev,
                                [i.rowRef]: { include: prev[i.rowRef]?.include ?? d.include, reason },
                              }));
                            }}
                          />
                        ) : (
                          <Text size="xs" c="dimmed">
                            {d.reason}
                          </Text>
                        )}
                      </Stack>
                    );
                  },
                  { minWidth: 240 },
                ),
                col<ImportPreviewItem>('row', t('import.row'), (i) => i.rowRef, { width: 80, nowrap: true, drop: 1 }),
                col<ImportPreviewItem>('unit', t('import.unit'), (i) => i.unitName, {
                  minWidth: 140,
                  grow: true,
                  drop: 3,
                  truncate: true,
                  tooltip: (i) => i.unitName,
                }),
                // The parsed date (ISO), as it will be saved; an Excel serial is never shown raw (UI review O-05).
                col<ImportPreviewItem>(
                  'dob',
                  t('import.dob'),
                  (i) =>
                    i.dob ? (
                      <Sensitive value={i.dob} />
                    ) : i.dobRaw.trim() ? (
                      <Stack gap={0}>
                        <Sensitive value={i.dobRaw} />
                        <Text size="xs" data-testid="dob-unreadable">
                          {t('importFlow.dobUnreadable')}
                        </Text>
                      </Stack>
                    ) : (
                      '-'
                    ),
                  { width: 120, nowrap: true },
                ),
                col<ImportPreviewItem>('link', t('import.link'), (i) => <LinkBadge state={i.linkState} />, {
                  minWidth: 140,
                  nowrap: true,
                }),
                col<ImportPreviewItem>(
                  'prior',
                  t('import.prior'),
                  (i) => (i.prior ? <StatusBadge status={i.prior.status} /> : '-'),
                  { minWidth: 140, nowrap: true, drop: 2 },
                ),
                col<ImportPreviewItem>(
                  'issues',
                  t('import.issues'),
                  (i) => (i.issues.length ? i.issues.map((x) => x.code).join(', ') : '-'),
                  {
                    minWidth: 160,
                    drop: 4,
                    truncate: true,
                    tooltip: (i) => i.issues.map((x) => x.code).join(', '),
                  },
                ),
              ]}
            />

            <Card withBorder maw={720}>
              <Title order={2} size="h4" mb="sm">
                {t('import.detailsTitle')}
              </Title>
              <RequestorField
                value={requestor}
                saved={saved}
                onChange={(next, rec) => {
                  setRequestor(next);
                  setSaved(rec);
                }}
              />
              <Group grow align="flex-start" mt="sm" wrap="wrap">
                <TextInput
                  label={t('request.eventName')}
                  required
                  value={form.eventName}
                  onChange={(e) => setForm({ ...form, eventName: e.currentTarget.value })}
                />
                <TextInput
                  label={t('request.eventStart')}
                  type="date"
                  value={form.eventStart}
                  onChange={(e) => setForm({ ...form, eventStart: e.currentTarget.value })}
                />
                <TextInput
                  label={t('request.eventEnd')}
                  type="date"
                  value={form.eventEnd}
                  onChange={(e) => setForm({ ...form, eventEnd: e.currentTarget.value })}
                />
                <TextInput
                  label={t('request.eventLocation')}
                  value={form.eventLocation}
                  onChange={(e) => setForm({ ...form, eventLocation: e.currentTarget.value })}
                />
              </Group>
              <Textarea
                mt="sm"
                label={t('request.notes')}
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.currentTarget.value })}
              />
            </Card>
          </Stack>
        )}

        {step === 2 && preview && (
          <Stack maw={720}>
            <Text size="sm">{t('wizard.requestConfirmText')}</Text>
            {countBadges}
            {!preview.canCommit && <Alert color="red">{t('import.cannotCommit')}</Alert>}
            {reasonMissing && <Text size="sm">{t('import.reasonNeeded')}</Text>}
          </Stack>
        )}
      </Wizard>
      <RequestorChoiceModal count={askCount} onChoose={(c) => void commit(c)} onCancel={() => setAskCount(null)} />
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
