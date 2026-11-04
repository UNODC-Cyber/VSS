import {
  Alert,
  Button,
  Card,
  Checkbox,
  Code,
  Group,
  Modal,
  NumberInput,
  PasswordInput,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BackupConfigInput, BackupListResult } from '@shared/ipc/contract';
import { useAction, vss } from '../lib/api';
import { CopyIconButton } from './ui/CopyIconButton';
import { fmtDateTime } from '../lib/format';
import { col, DataTable } from './DataTable';

const asNum = (v: string | number, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/**
 * Shows a freshly generated recovery passphrase exactly once. It cannot be dismissed until the user confirms they
 * saved it (no close button, no Escape, no outside click).
 */
export function RecoveryPassphraseModal({ passphrase, onDone }: { passphrase: string | null; onDone: () => void }) {
  const { t } = useTranslation();
  const [saved, setSaved] = useState(false);
  useEffect(() => setSaved(false), [passphrase]);
  return (
    <Modal
      opened={passphrase !== null}
      onClose={() => undefined}
      withCloseButton={false}
      closeOnEscape={false}
      closeOnClickOutside={false}
      title={t('backup.passphraseTitle')}
      size="lg"
      trapFocus
    >
      <Stack>
        <Text size="sm">{t('backup.passphraseIntro')}</Text>
        <Code block fz="lg" data-testid="recovery-passphrase" style={{ letterSpacing: '0.08em' }}>
          {passphrase}
        </Code>
        <Alert color="orange">{t('backup.passphraseWarning')}</Alert>
        <Group>
          <CopyIconButton text={passphrase ?? ''} label={t('ui.copyField.passphrase')} />
        </Group>
        <Checkbox
          label={t('backup.passphraseSaved')}
          checked={saved}
          onChange={(e) => setSaved(e.currentTarget.checked)}
        />
        <Group justify="flex-end">
          <Button disabled={!saved} onClick={onDone}>
            {t('backup.passphraseDone')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** Scheduled / on-lock backups to a folder the user picks; restore lives on the create-vault screen. */
export function BackupCard() {
  const { t } = useTranslation();
  const act = useAction();
  const [info, setInfo] = useState<BackupListResult | null>(null);
  const [cfg, setCfg] = useState<BackupConfigInput>({ dir: '', keep: 10, onLock: true, everyHours: 24 });
  /** The folder as the user sees it; `cfg.dir` holds the dialog token until saved (F-02). */
  const [dirShown, setDirShown] = useState('');
  const [pw, setPw] = useState('');
  const [shown, setShown] = useState<string | null>(null);

  const load = async () => {
    const r = await vss().backup.list();
    if (!r.ok) return;
    setInfo(r.value);
    if (r.value.config) {
      const { dir, keep, onLock, everyHours } = r.value.config;
      setCfg({ dir, keep, onLock, everyHours });
      setDirShown(dir);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const configure = async (regeneratePassphrase: boolean) => {
    const r = await act(
      vss().backup.configure({
        config: cfg,
        reauth: { password: pw },
        ...(regeneratePassphrase ? { regeneratePassphrase } : {}),
      }),
      t('backup.saved'),
    );
    setPw('');
    if (!r) return;
    setInfo(r);
    // The folder token is used up; from now on the configured folder itself identifies it.
    if (r.config) {
      setCfg((c) => ({ ...c, dir: r.config!.dir }));
      setDirShown(r.config.dir);
    }
    if (r.newPassphrase) setShown(r.newPassphrase);
  };
  const pickDir = async () => {
    const r = await act(vss().files.pickOpen({ kind: 'directory', title: t('backup.chooseFolder') }));
    if (r?.path) {
      setCfg({ ...cfg, dir: r.path });
      setDirShown(r.displayPath ?? r.path);
    }
  };
  const runNow = async () => {
    const r = await act(vss().backup.runNow(), t('settings.backupDone'));
    if (r) await load();
  };

  const configured = info?.config ?? null;
  return (
    <Card withBorder>
      <Title order={2} size="h4">
        {t('settings.backup')}
      </Title>
      <Text size="sm" c="dimmed">
        {t('backup.help')}
      </Text>
      <Stack mt="sm">
        <Group align="flex-end">
          <TextInput
            label={t('backup.folder')}
            value={dirShown}
            readOnly
            style={{ flex: 1 }}
            placeholder={t('backup.noFolder')}
          />
          <Button variant="default" onClick={() => void pickDir()}>
            {t('backup.chooseFolder')}
          </Button>
        </Group>
        <Group>
          <NumberInput
            label={t('backup.keep')}
            min={1}
            max={100}
            value={cfg.keep}
            onChange={(v) => setCfg({ ...cfg, keep: asNum(v, cfg.keep) })}
          />
          <NumberInput
            label={t('backup.everyHours')}
            description={t('backup.everyHoursHelp')}
            min={0}
            max={720}
            value={cfg.everyHours ?? 0}
            onChange={(v) => {
              const n = asNum(v, cfg.everyHours ?? 0);
              setCfg({ ...cfg, everyHours: n > 0 ? n : null });
            }}
          />
        </Group>
        <Switch
          label={t('backup.onLock')}
          checked={cfg.onLock}
          onChange={(e) => setCfg({ ...cfg, onLock: e.currentTarget.checked })}
        />
        <Group align="flex-end">
          <PasswordInput
            label={t('backup.reauth')}
            value={pw}
            onChange={(e) => setPw(e.currentTarget.value)}
            autoComplete="current-password"
          />
          <Button disabled={pw === '' || cfg.dir === ''} onClick={() => void configure(false)}>
            {configured ? t('backup.save') : t('backup.setUp')}
          </Button>
          {configured && (
            <Button variant="default" color="orange" disabled={pw === ''} onClick={() => void configure(true)}>
              {t('backup.regenerate')}
            </Button>
          )}
        </Group>
        {configured && <Text size="xs">{t('backup.regenerateHelp')}</Text>}
        <Group>
          <Button disabled={!configured} onClick={() => void runNow()}>
            {t('settings.backupNow')}
          </Button>
          {!configured && (
            <Text size="sm" data-testid="backup-now-why">
              {t('backupFlow.setUpFirst')}
            </Text>
          )}
          <Text size="sm" data-testid="backup-last">
            {info?.lastBackupAt ? t('backup.last', { at: fmtDateTime(info.lastBackupAt) }) : t('backupFlow.none')}
          </Text>
        </Group>
        {info && info.backups.length > 0 && (
          <DataTable
            caption={t('backup.listCaption')}
            data={info.backups}
            rowId={(b) => b.name}
            columns={[
              col<BackupListResult['backups'][number]>('n', t('backup.file'), (b) => b.name, {
                sticky: 'first',
                minWidth: 220,
                grow: true,
                truncate: true,
                tooltip: (b) => b.name,
              }),
              col<BackupListResult['backups'][number]>('d', t('backup.when'), (b) => fmtDateTime(b.modifiedAt), {
                width: 170,
                nowrap: true,
              }),
              col<BackupListResult['backups'][number]>(
                's',
                t('backup.size'),
                (b) => `${Math.ceil(b.bytes / 1024)} KB`,
                { width: 100, nowrap: true },
              ),
            ]}
          />
        )}
      </Stack>
      <RecoveryPassphraseModal passphrase={shown} onDone={() => setShown(null)} />
    </Card>
  );
}
