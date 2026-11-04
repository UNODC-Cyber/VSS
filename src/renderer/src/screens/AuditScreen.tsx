import { Alert, Button, Group, Stack, Text, TextInput } from '@mantine/core';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AuditEvent } from '@shared/domain/types';
import type { AuditVerifyResult } from '@shared/ipc/contract';
import { col, DataTable } from '../components/DataTable';
import { PageHeader, QueryBoundary, SimplePager } from '../components/common';
import { useAction, useQuery, vss } from '../lib/api';
import { fmtDateTime } from '../lib/format';

const PAGE = 50;

export function AuditScreen() {
  const { t } = useTranslation();
  const act = useAction();
  const [type, setType] = useState('');
  const [offset, setOffset] = useState(0);
  const [verify, setVerify] = useState<AuditVerifyResult | null>(null);
  const q = useQuery(() => vss().audit.list({ offset, limit: PAGE, ...(type ? { type } : {}) }), [offset, type]);

  return (
    <Stack>
      <PageHeader
        title={t('audit.title')}
        actions={
          <>
            <Button
              onClick={async () => {
                const r = await act(vss().audit.verify());
                if (r) setVerify(r);
              }}
            >
              {t('audit.verify')}
            </Button>
            <Button
              variant="default"
              onClick={async () => {
                const f = await act(vss().files.pickSave({ kind: 'audit', suggestedName: 'audit-log.jsonl' }));
                if (f?.path) await act(vss().audit.export({ destPath: f.path }), t('audit.exported'));
              }}
            >
              {t('audit.export')}
            </Button>
          </>
        }
      />
      {verify && (
        <Alert
          color={verify.ok ? 'green' : 'red'}
          role="status"
          title={verify.ok ? t('audit.verifyOk') : t('audit.verifyBroken')}
        >
          {verify.ok
            ? t('audit.verifyOkBody', { count: verify.checked })
            : t('audit.verifyBrokenBody', { seq: verify.brokenAtSeq ?? 0 })}
        </Alert>
      )}
      <Group>
        <TextInput
          label={t('audit.filterType')}
          value={type}
          onChange={(e) => {
            setType(e.currentTarget.value);
            setOffset(0);
          }}
        />
      </Group>
      <Text size="sm" c="dimmed">
        {t('audit.noPersonal')}
      </Text>
      <QueryBoundary loading={q.loading && !q.data} error={q.error}>
        {q.data && (
          <>
            <DataTable<AuditEvent>
              caption={t('audit.caption')}
              data={q.data.items}
              empty={t('audit.empty')}
              rowId={(e) => String(e.seq)}
              tableId="audit"
              columns={[
                col<AuditEvent>('seq', '#', (e) => e.seq, { width: 72, nowrap: true }),
                col<AuditEvent>('at', t('audit.time'), (e) => fmtDateTime(e.at), { width: 170, nowrap: true }),
                col<AuditEvent>('type', t('audit.type'), (e) => e.type, {
                  minWidth: 200,
                  truncate: true,
                  tooltip: (e) => e.type,
                }),
                col<AuditEvent>(
                  'subj',
                  t('audit.subject'),
                  (e) => `${e.subjectType}${e.subjectId ? ` ${e.subjectId.slice(-6)}` : ''}`,
                  { width: 170, truncate: true },
                ),
                col<AuditEvent>(
                  'det',
                  t('audit.details'),
                  (e) =>
                    Object.entries(e.details)
                      .map(([k, v]) => `${k}=${String(v)}`)
                      .join(', ') || '-',
                  {
                    minWidth: 240,
                    grow: true,
                    truncate: true,
                    tooltip: (e) =>
                      Object.entries(e.details)
                        .map(([k, v]) => `${k}=${String(v)}`)
                        .join(', '),
                  },
                ),
                col<AuditEvent>('hash', t('audit.hash'), (e) => <code>{e.hash.slice(0, 10)}</code>, {
                  width: 130,
                  nowrap: true,
                }),
              ]}
            />
            <SimplePager total={q.data.total} offset={offset} limit={PAGE} onChange={setOffset} />
          </>
        )}
      </QueryBoundary>
    </Stack>
  );
}
