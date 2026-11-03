import { Alert, Badge, Button, Group, MultiSelect, Stack, Text } from '@mantine/core';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ReviewItem, ReviewKind } from '@shared/domain/types';
import type { ReviewItemDetail, ReviewResolution } from '@shared/ipc/contract';
import { col, DataTable } from '../components/DataTable';
import { DiffGrid } from '../components/Diff';
import type { DiffField } from '../components/Diff';
import { PageHeader, PersonPicker, QueryBoundary, SimplePager, TierBadge } from '../components/common';
import { useAction, useQuery, vss } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { navigate } from '../lib/router';

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

function ReviewBody({ detail }: { detail: ReviewItemDetail }) {
  const { t } = useTranslation();
  const act = useAction();
  const [picker, setPicker] = useState(false);
  const { item, subjects } = detail;
  const [source, ...cands] = subjects;

  const resolve = async (resolution: ReviewResolution, msg: string) => {
    const r = await act(vss().review.resolve({ id: item.id, resolution }), msg);
    if (!r) return;
    const next = await vss().review.list({ offset: 0, limit: 1, state: 'open' });
    navigate(next.ok && next.value.items[0] ? `/review/${next.value.items[0].id}` : '/review');
  };

  const fields: DiffField[] = [
    { key: 'name', label: t('import.name'), kind: 'name', values: subjects.map((s) => s.displayName) },
    { key: 'dob', label: t('import.dob'), kind: 'dob', values: subjects.map((s) => s.dob ?? s.dobRaw) },
    { key: 'sex', label: t('person.sex'), kind: 'text', values: subjects.map((s) => s.sex ?? '') },
    { key: 'pob', label: t('person.pob'), kind: 'text', values: subjects.map((s) => s.pobCountry ?? '') },
    { key: 'unit', label: t('import.unit'), kind: 'text', values: subjects.map((s) => s.unitName ?? '') },
    { key: 'ids', label: t('items.ids'), kind: 'text', values: subjects.map((s) => s.identifiers.join(', ')) },
  ];

  const isLink = item.kind === 'request-item-link' || item.kind === 'response-row-match';
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
      <DiffGrid caption={t('review.diffCaption')} headers={subjects.map((s) => s.source)} fields={fields} />
      <Group role="group" aria-label={t('review.actions')}>
        {isLink &&
          cands.map((c) => (
            <Button key={c.id} onClick={() => void resolve({ action: 'link', targetId: c.id }, t('review.linked'))}>
              {t('review.confirmCandidate', { name: c.displayName })}
            </Button>
          ))}
        {isLink && (
          <Button variant="default" onClick={() => setPicker(true)}>
            {t('review.chooseOther')}
          </Button>
        )}
        {isLink && (
          <Button variant="default" onClick={() => void resolve({ action: 'new-person' }, t('review.newPerson'))}>
            {t('review.createNew')}
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
      <PersonPicker
        opened={picker}
        title={t('review.chooseOther')}
        onClose={() => setPicker(false)}
        onPick={(p) => {
          setPicker(false);
          void resolve({ action: 'link', targetId: p.id }, t('review.linked'));
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
      {q.data && <ReviewBody detail={q.data} />}
    </QueryBoundary>
  );
}
