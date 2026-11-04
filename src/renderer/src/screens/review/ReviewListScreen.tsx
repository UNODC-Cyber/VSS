import { MultiSelect, Stack, Text } from '@mantine/core';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ReviewItem, ReviewKind } from '@shared/domain/types';
import { col, DataTable } from '../../components/DataTable';
import { PageHeader, QueryBoundary, SimplePager, TierBadge } from '../../components/common';
import { useQuery, vss } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';

const KINDS: ReviewKind[] = [
  'response-row-match',
  'request-item-link',
  'duplicate-persons',
  'dob-conflict',
  'unmatched-response-row',
  'unanswered-request-item',
];
const PAGE = 25;

export function ReviewScreen() {
  const { t } = useTranslation();
  const [kinds, setKinds] = useState<string[]>([]);
  const [offset, setOffset] = useState(0);
  const q = useQuery(
    () => vss().review.list({ offset, limit: PAGE, state: 'open', kinds: kinds as ReviewKind[] }),
    [offset, kinds.join()],
  );
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
            <DataTable<ReviewItem>
              caption={t('review.caption')}
              data={q.data.items}
              empty={t('review.empty')}
              rowId={(r) => r.id}
              columns={[
                col<ReviewItem>('k', t('review.kind'), (r) => (
                  <a href={`#/review/${r.id}`}>{t(`reviewkind.${r.kind}`)}</a>
                )),
                col<ReviewItem>('c', t('review.created'), (r) => fmtDateTime(r.createdAt)),
                col<ReviewItem>('t', t('review.bestTier'), (r) =>
                  r.candidates[0] ? <TierBadge tier={r.candidates[0].tier} /> : '-',
                ),
                col<ReviewItem>('n', t('review.subjects'), (r) => r.subjectIds.length),
              ]}
            />
            <SimplePager total={q.data.total} offset={offset} limit={PAGE} onChange={setOffset} />
          </>
        )}
      </QueryBoundary>
    </Stack>
  );
}
