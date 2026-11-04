import { MultiSelect, Stack, Text } from '@mantine/core';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ReviewKind } from '@shared/domain/types';
import type { ReviewItemSummary } from '@shared/ipc/contract';
import { col, DataTable } from '../../components/DataTable';
import { PageHeader, QueryBoundary, Sensitive, SimplePager, TierBadge } from '../../components/common';
import { useQuery, vss } from '../../lib/api';
import { fmtDateTime, mask } from '../../lib/format';
import { useUi } from '../../store';

const KINDS: ReviewKind[] = [
  'response-row-match',
  'request-item-link',
  'duplicate-persons',
  'dob-conflict',
  'unmatched-response-row',
  'unanswered-request-item',
  'disposition-unclear',
];
const PAGE = 25;

/** Review queue: who each item is about (name, DOB, unit; masked under redaction) and where it comes from. */
export function ReviewScreen() {
  const { t } = useTranslation();
  const redact = useUi((s) => s.settings.redactionMode);
  const [kinds, setKinds] = useState<string[]>([]);
  const [offset, setOffset] = useState(0);
  const q = useQuery(
    () => vss().review.list({ offset, limit: PAGE, state: 'open', kinds: kinds as ReviewKind[] }),
    [offset, kinds.join()],
  );
  const nameOf = (r: ReviewItemSummary) => r.subjectName || t('reviewList.noName');
  return (
    <Stack>
      <PageHeader title={t('review.title')} />
      <MultiSelect
        label={t('review.kinds')}
        data={KINDS.map((k) => ({ value: k, label: t(`reviewkind.${k}`) }))}
        value={kinds}
        onChange={(v) => {
          setKinds(v);
          setOffset(0);
        }}
        clearable
        w={360}
      />
      <QueryBoundary loading={q.loading && !q.data} error={q.error}>
        {q.data && (
          <>
            <Text role="status" size="sm" c="dimmed">
              {t('review.open', { count: q.data.total })}
            </Text>
            <DataTable<ReviewItemSummary>
              caption={t('review.caption')}
              data={q.data.items}
              empty={t('review.empty')}
              rowId={(r) => r.id}
              columns={[
                col<ReviewItemSummary>('s', t('reviewList.subject'), (r) => (
                  <a
                    href={`#/review/${r.id}`}
                    aria-label={t('reviewList.open', { name: redact ? mask(nameOf(r)) : nameOf(r) })}
                    style={{ whiteSpace: 'nowrap' }}
                  >
                    <Sensitive value={nameOf(r)} />
                  </a>
                )),
                col<ReviewItemSummary>('d', t('reviewList.dob'), (r) => (
                  <span style={{ whiteSpace: 'nowrap' }}>
                    <Sensitive value={r.subjectDob} />
                  </span>
                )),
                col<ReviewItemSummary>('u', t('reviewList.unit'), (r) => (
                  <Text size="sm" truncate maw={220}>
                    {r.unitName ?? '-'}
                  </Text>
                )),
                col<ReviewItemSummary>('x', t('reviewList.context'), (r) =>
                  !r.context ? (
                    '-'
                  ) : 'requestId' in r.context ? (
                    <a href={`#/requests/${r.context.requestId}`}>
                      {t('reviewList.contextRequest', { name: r.context.eventName })}
                    </a>
                  ) : (
                    <a href="#/responses">{t('reviewList.contextResponse', { batch: r.context.batchId })}</a>
                  ),
                ),
                col<ReviewItemSummary>('k', t('review.kind'), (r) => t(`reviewkind.${r.kind}`)),
                col<ReviewItemSummary>('t', t('review.bestTier'), (r) =>
                  r.bestTier ? <TierBadge tier={r.bestTier} /> : '-',
                ),
                col<ReviewItemSummary>('c', t('review.created'), (r) => fmtDateTime(r.createdAt)),
              ]}
            />
            <SimplePager total={q.data.total} offset={offset} limit={PAGE} onChange={setOffset} />
          </>
        )}
      </QueryBoundary>
    </Stack>
  );
}
