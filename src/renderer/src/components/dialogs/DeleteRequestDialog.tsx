/**
 * Delete a request (UI review round 3, R3O-05). The dialog names the request, says how many people are on it, lists
 * what is deleted and what stays (the same rules as main's undoRequest), says it cannot be undone, points to a backup,
 * and needs a deliberate tick before the red button works. A request with an imported vetting-authority response
 * cannot be deleted at all (main answers CONFLICT), so that case explains why and offers no delete button.
 */
import { Alert, Button, Checkbox, Group, List, Modal, Stack, Text } from '@mantine/core';
import { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import type { VettingRequest } from '@shared/domain/types';
import { useAction, vss } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { navigate } from '../../lib/router';
import { ScreenLink } from '../ScreenLink';

export function DeleteRequestDialog({
  opened,
  onClose,
  request: req,
}: {
  opened: boolean;
  onClose: () => void;
  request: VettingRequest;
}) {
  const { t } = useTranslation();
  const act = useAction();
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (opened) setSure(false);
  }, [opened]);
  const count = req.items.length;
  const blocked = req.responseKind === 'dc-file';
  const emailRecords = req.responseKind === 'email-clearance' ? (req.recordedPersonIds?.length ?? 0) : 0;
  const remove = async () => {
    setBusy(true);
    const r = await act(vss().requests.remove({ id: req.id }), t('request.deleted'));
    setBusy(false);
    if (r) navigate('/requests');
  };
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={t('requestDelete.title', { name: req.eventName })}
      size="lg"
      trapFocus
      returnFocus
    >
      <Stack data-testid="delete-request">
        <Text size="sm" data-testid="delete-request-summary">
          {t('requestDelete.summary', {
            count,
            status: t(`reqstatus.${req.status}`, { defaultValue: req.status }),
            received: fmtDateTime(req.receivedAt, { zone: true }),
          })}
        </Text>
        {blocked ? (
          <Alert color="orange" title={t('requestDelete.blockedTitle')} data-testid="delete-request-blocked">
            {t('requestDelete.blockedBody')}
          </Alert>
        ) : (
          <>
            <div>
              <Text fw={600} size="sm">
                {t('requestDelete.deletedHeading')}
              </Text>
              <List size="sm">
                <List.Item>{t('requestDelete.deleted.items', { count })}</List.Item>
                <List.Item>{t('requestDelete.deleted.review')}</List.Item>
                <List.Item>{t('requestDelete.deleted.files')}</List.Item>
                {emailRecords > 0 && (
                  <List.Item>{t('requestDelete.deleted.emailRecords', { count: emailRecords })}</List.Item>
                )}
                <List.Item>{t('requestDelete.deleted.newPeople')}</List.Item>
              </List>
            </div>
            <div>
              <Text fw={600} size="sm">
                {t('requestDelete.keptHeading')}
              </Text>
              <List size="sm">
                <List.Item>{t('requestDelete.kept.people')}</List.Item>
                <List.Item>{t('requestDelete.kept.audit')}</List.Item>
              </List>
            </div>
            <Alert color="red" title={t('requestDelete.irreversibleTitle')}>
              <Trans
                i18nKey="requestDelete.irreversibleBody"
                components={{ screen: <ScreenLink to="/settings?card=backup" /> }}
              />
            </Alert>
            {req.status !== 'closed' && <Text size="sm">{t('requestDelete.closeInstead')}</Text>}
            <Checkbox
              label={t('requestDelete.ack', { count, name: req.eventName })}
              checked={sure}
              onChange={(e) => setSure(e.currentTarget.checked)}
            />
          </>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose} data-autofocus>
            {t('common.cancel')}
          </Button>
          {!blocked && (
            <Button color="red" disabled={!sure} loading={busy} onClick={() => void remove()}>
              {t('requestDelete.confirm')}
            </Button>
          )}
        </Group>
      </Stack>
    </Modal>
  );
}
