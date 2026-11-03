import {
  Alert,
  Button,
  Card,
  Group,
  NumberInput,
  PasswordInput,
  Select,
  Stack,
  Switch,
  Text,
  Title,
} from '@mantine/core';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Settings } from '@shared/domain/types';
import { BackupCard } from '../components/BackupCard';
import { PageHeader } from '../components/common';
import { TemplatesCard } from '../components/TemplatesCard';
import { useAction, vss } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { useUi } from '../store';
import { MIN_PASSWORD } from './CreateVaultScreen';

const asNum = (v: string | number, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

function PasswordCard() {
  const { t } = useTranslation();
  const act = useAction();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [conf, setConf] = useState('');
  const ok = cur !== '' && next.length >= MIN_PASSWORD && next === conf;
  return (
    <Card withBorder>
      <Title order={4}>{t('settings.changePassword')}</Title>
      <Group align="flex-end" mt="sm">
        <PasswordInput
          label={t('settings.currentPassword')}
          value={cur}
          onChange={(e) => setCur(e.currentTarget.value)}
          autoComplete="current-password"
        />
        <PasswordInput
          label={t('settings.newPassword')}
          value={next}
          onChange={(e) => setNext(e.currentTarget.value)}
          autoComplete="new-password"
          description={t('vault.guidanceLength', { min: MIN_PASSWORD })}
        />
        <PasswordInput
          label={t('vault.confirm')}
          value={conf}
          onChange={(e) => setConf(e.currentTarget.value)}
          autoComplete="new-password"
          error={conf !== '' && conf !== next ? t('vault.mismatch') : undefined}
        />
        <Button
          disabled={!ok}
          onClick={async () => {
            const r = await act(
              vss().vault.changePassword({ currentPassword: cur, newPassword: next }),
              t('settings.passwordChanged'),
            );
            setCur('');
            if (r) {
              setNext('');
              setConf('');
            }
          }}
        >
          {t('settings.changePassword')}
        </Button>
      </Group>
    </Card>
  );
}

function UpdatesCard() {
  const { t } = useTranslation();
  const act = useAction();
  const upd = useUi((s) => s.update);
  const setUpdate = useUi((s) => s.setUpdate);
  return (
    <Card withBorder>
      <Title order={4}>{t('settings.updates')}</Title>
      <Text size="sm" role="status">
        {t('settings.updateState', {
          version: upd?.currentVersion ?? '-',
          phase: upd ? t(`updphase.${upd.phase}`) : '-',
        })}
        {upd?.checkedAt ? ` (${fmtDateTime(upd.checkedAt)})` : ''}
      </Text>
      <Group mt="sm">
        <Button
          variant="default"
          onClick={async () => {
            const r = await act(vss().updates.check());
            if (r) setUpdate(r);
          }}
        >
          {t('settings.checkNow')}
        </Button>
        {upd?.phase === 'available' && (
          <Button
            onClick={async () => {
              const r = await act(vss().updates.download());
              if (r) setUpdate(r);
            }}
          >
            {t('settings.download')}
          </Button>
        )}
        {upd?.phase === 'verified' && (
          <Button onClick={() => void act(vss().updates.install())}>{t('settings.install')}</Button>
        )}
      </Group>
    </Card>
  );
}

export function SettingsScreen() {
  const { t } = useTranslation();
  const act = useAction();
  const current = useUi((s) => s.settings);
  const setSettings = useUi((s) => s.setSettings);
  const [s, setS] = useState<Settings>(structuredClone(current));
  const [pw, setPw] = useState('');
  const dirty = JSON.stringify(s) !== JSON.stringify(current);
  const policy = s.exportPolicy;
  const setPolicy = (patch: Partial<Settings['exportPolicy']>) => setS({ ...s, exportPolicy: { ...policy, ...patch } });

  const save = async () => {
    const r = await act(vss().settings.update({ settings: s, reauth: { password: pw } }), t('settings.saved'));
    setPw('');
    if (!r) return;
    setSettings(r);
    setS(structuredClone(r));
    if (r.peerModeEnabled !== current.peerModeEnabled) await vss().peer.setEnabled({ enabled: r.peerModeEnabled });
  };

  return (
    <Stack>
      <PageHeader title={t('settings.title')} />
      <Card withBorder>
        <Stack>
          <Title order={4}>{t('settings.general')}</Title>
          <NumberInput
            label={t('settings.autoLock')}
            min={1}
            max={120}
            value={s.autoLockMinutes}
            onChange={(v) => setS({ ...s, autoLockMinutes: asNum(v, s.autoLockMinutes) })}
          />
          <NumberInput
            label={t('settings.clipboardClear')}
            min={5}
            max={300}
            value={s.clipboardClearSeconds}
            onChange={(v) => setS({ ...s, clipboardClearSeconds: asNum(v, s.clipboardClearSeconds) })}
          />
          <NumberInput
            label={t('settings.emailDays')}
            description={t('settings.emailDaysHelp')}
            min={1}
            max={3650}
            value={s.emailClearanceDefaultDays}
            onChange={(v) => setS({ ...s, emailClearanceDefaultDays: asNum(v, s.emailClearanceDefaultDays) })}
          />
          <Switch
            label={t('settings.redaction')}
            description={t('settings.redactionHelp')}
            checked={s.redactionMode}
            onChange={(e) => setS({ ...s, redactionMode: e.currentTarget.checked })}
          />
          <Switch
            label={t('settings.updateCheck')}
            description={t('settings.updateCheckHelp')}
            checked={s.updateCheckEnabled}
            onChange={(e) => setS({ ...s, updateCheckEnabled: e.currentTarget.checked })}
          />
        </Stack>
      </Card>
      <Card withBorder>
        <Stack>
          <Title order={4}>{t('settings.exportPolicy')}</Title>
          <NumberInput
            label={t('settings.expiringWithin')}
            min={1}
            max={365}
            value={policy.expiringWithinDays}
            onChange={(v) => setPolicy({ expiringWithinDays: asNum(v, policy.expiringWithinDays) })}
          />
          <Switch
            label={t('settings.includePending')}
            checked={policy.includePending}
            onChange={(e) => setPolicy({ includePending: e.currentTarget.checked })}
          />
          <Switch
            label={t('settings.includeUnitChanged')}
            checked={policy.includeUnitChanged}
            onChange={(e) => setPolicy({ includeUnitChanged: e.currentTarget.checked })}
          />
          <Switch
            label={t('settings.includeNonApproved')}
            checked={policy.includeNonApproved}
            onChange={(e) => setPolicy({ includeNonApproved: e.currentTarget.checked })}
          />
          <Select
            label={t('settings.flagged')}
            data={(['include', 'exclude', 'block'] as const).map((v) => ({ value: v, label: t(`flagged.${v}`) }))}
            value={policy.includeFlaggedUnresolved}
            allowDeselect={false}
            onChange={(v) =>
              v && setPolicy({ includeFlaggedUnresolved: v as Settings['exportPolicy']['includeFlaggedUnresolved'] })
            }
          />
        </Stack>
      </Card>
      <Card withBorder>
        <Stack>
          <Title order={4}>{t('settings.peer')}</Title>
          <Switch
            label={t('settings.peerMode')}
            checked={s.peerModeEnabled}
            onChange={(e) => setS({ ...s, peerModeEnabled: e.currentTarget.checked })}
          />
          {s.peerModeEnabled && (
            <Alert color="red" title={t('settings.peerWarningTitle')}>
              {t('settings.peerWarning')}
            </Alert>
          )}
        </Stack>
      </Card>
      <Card withBorder>
        <Group align="flex-end">
          <PasswordInput
            label={t('settings.reauth')}
            description={t('settings.reauthHelp')}
            value={pw}
            onChange={(e) => setPw(e.currentTarget.value)}
            autoComplete="current-password"
          />
          <Button disabled={!dirty || pw === ''} onClick={() => void save()}>
            {t('settings.save')}
          </Button>
          <Button variant="default" disabled={!dirty} onClick={() => setS(structuredClone(current))}>
            {t('settings.revert')}
          </Button>
        </Group>
      </Card>
      <TemplatesCard />
      <PasswordCard />
      <BackupCard />
      <UpdatesCard />
    </Stack>
  );
}
