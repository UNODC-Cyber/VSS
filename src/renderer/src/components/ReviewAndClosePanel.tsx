import { Alert, Button, Card, Group, Modal, Stack, Text, Textarea, Title } from '@mantine/core';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isExcluded, MIN_REASON_LENGTH } from '@shared/domain/lifecycle';
import type { VettingRequest } from '@shared/domain/types';
import { useAction, vss } from '../lib/api';
import { fmtDate } from '../lib/format';
import { col, DataTable } from './DataTable';

interface OutcomeRow {
  id: string;
  label: string;
  count: number;
}

/**
 * "Review and close" panel of a Finished request (R7): outcome summary, optional note, gated Close with a
 * confirmation; on a Closed request it shows the close note and the Reopen action (reason required).
 */
export function ReviewAndClosePanel({ req, reload }: { req: VettingRequest; reload: () => void }) {
  const { t } = useTranslation();
  const act = useAction();
  const [dlg, setDlg] = useState<'close' | 'reopen' | null>(null);
  const [text, setText] = useState('');
  // The dialog keeps its labels while it fades out, so a closing Close dialog never reads as a Reopen dialog.
  const mode = useRef<'close' | 'reopen'>('close');
  if (dlg) mode.current = dlg;
  if (req.status !== 'finished' && req.status !== 'closed') return null;

  const excluded = req.items.filter((i) => isExcluded(i.exportDecision)).length;
  const rows: OutcomeRow[] = [
    { id: 'answered', label: t('lifecycle.answered'), count: req.items.length - excluded },
    { id: 'excluded', label: t('lifecycle.excluded'), count: excluded },
    { id: 'total', label: t('lifecycle.total'), count: req.items.length },
  ];
  const done = () => {
    setDlg(null);
    setText('');
  };
  const submit = async () => {
    const p =
      dlg === 'close'
        ? act(vss().requests.close({ id: req.id, note: text.trim() }), t('lifecycle.closed'))
        : act(vss().requests.reopen({ id: req.id, reason: text.trim() }), t('lifecycle.reopened'));
    if (await p) {
      done();
      reload();
    }
  };

  return (
    <Card withBorder aria-labelledby="review-close-title" data-testid="review-close-panel">
      <Stack gap="sm">
        <Title order={2} size="h3" id="review-close-title">
          {t('lifecycle.reviewTitle')}
        </Title>
        {req.status === 'finished' ? (
          <Text size="sm">{t('lifecycle.finishedIntro')}</Text>
        ) : (
          <>
            <Text size="sm">{t('lifecycle.closedIntro', { date: fmtDate(req.closedAt?.slice(0, 10)) })}</Text>
            {req.closeNote && (
              <Alert color="gray" title={t('lifecycle.note')} data-testid="close-note">
                {req.closeNote}
              </Alert>
            )}
          </>
        )}
        {req.reopenCount > 0 && (
          <Text size="xs" c="dimmed">
            {t('lifecycle.reopenCount', { count: req.reopenCount })}
          </Text>
        )}
        <DataTable<OutcomeRow>
          caption={t('lifecycle.summaryCaption')}
          data={rows}
          rowId={(r) => r.id}
          columns={[
            col<OutcomeRow>('l', t('lifecycle.outcome'), (r) => r.label, { minWidth: 200, grow: true }),
            col<OutcomeRow>('c', t('lifecycle.people'), (r) => r.count, { width: 100, nowrap: true }),
          ]}
        />
        <Group>
          {req.status === 'finished' ? (
            <Button onClick={() => setDlg('close')}>{t('lifecycle.closeButton')}</Button>
          ) : (
            <Button variant="default" onClick={() => setDlg('reopen')}>
              {t('lifecycle.reopenButton')}
            </Button>
          )}
        </Group>
      </Stack>
      <Modal
        opened={dlg !== null}
        onClose={done}
        title={mode.current === 'close' ? t('lifecycle.closeConfirmTitle') : t('lifecycle.reopenTitle')}
        trapFocus
        returnFocus
      >
        <Stack>
          {mode.current === 'close' && <Text size="sm">{t('lifecycle.closeConfirmBody')}</Text>}
          <Textarea
            label={mode.current === 'close' ? t('lifecycle.closeNote') : t('lifecycle.reopenReason')}
            description={mode.current === 'close' ? t('lifecycle.closeNoteHelp') : t('lifecycle.reopenReasonHelp')}
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            maxLength={4000}
            minRows={2}
            data-autofocus
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={done}>
              {t('common.cancel')}
            </Button>
            <Button
              disabled={mode.current === 'reopen' && text.trim().length < MIN_REASON_LENGTH}
              onClick={() => void submit()}
            >
              {mode.current === 'close' ? t('lifecycle.closeConfirm') : t('lifecycle.reopenConfirm')}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Card>
  );
}
