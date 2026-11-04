import { Alert, Button, Checkbox, Group, Modal, PasswordInput, Stack, Text, TextInput } from '@mantine/core';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { vss } from '../../lib/api';
import { useUi } from '../../store';

/** The stop-and-think phrase. Fixed and not translated, so a translated UI keeps working (plan section 15). */
export const WIPE_PHRASE = 'DELETE DATABASE';

export interface WipeDialogProps {
  opened: boolean;
  onClose: () => void;
  /** True when an automatic-backup folder is configured (shows the "also delete the backups" box). */
  hasBackupConfig: boolean;
}

/**
 * Delete database: the current password AND the exact phrase are required. The backend re-checks the password
 * (a wrong one counts towards the unlock back-off) and keeps its own contract literal `confirm: 'WIPE'`, which the
 * UI sends only after the phrase check.
 */
export function WipeDialog({ opened, onClose, hasBackupConfig }: WipeDialogProps) {
  const { t } = useTranslation();
  const setVault = useUi((s) => s.setVault);
  const clearData = useUi((s) => s.clearData);
  const pushToast = useUi((s) => s.pushToast);
  const [pw, setPw] = useState('');
  const [phrase, setPhrase] = useState('');
  const [alsoBackups, setAlsoBackups] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = phrase.trim() === WIPE_PHRASE && pw !== '';

  const close = () => {
    if (busy) return;
    setPw('');
    setPhrase('');
    setAlsoBackups(false);
    setError(null);
    onClose();
  };

  const run = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    let r;
    try {
      r = await vss().vault.wipe({
        password: pw,
        confirm: 'WIPE',
        ...(hasBackupConfig && alsoBackups ? { alsoDeleteScheduledBackups: true } : {}),
      });
    } catch {
      r = null;
    }
    setBusy(false);
    setPw(''); // never keep the password in state after use
    if (r?.ok) {
      setPhrase('');
      setAlsoBackups(false);
      onClose();
      clearData();
      setVault(r.value); // 'no-vault': App routes to the first-run create screen
      pushToast({ kind: 'success', message: t('danger.deletedToast') });
      return;
    }
    const code = r && !r.ok ? r.error.code : null;
    setError(
      code === 'BAD_CREDENTIALS'
        ? t('wipe.badPassword')
        : code === 'RATE_LIMITED'
          ? t('wipe.rateLimited')
          : t('wipe.failed'),
    );
    // Show the lockout (if any) in the store like the unlock screen does.
    const s = await vss().vault.status();
    if (s.ok) setVault(s.value);
  };

  return (
    <Modal opened={opened} onClose={close} title={t('wipe.title')} trapFocus returnFocus closeOnClickOutside={false}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <Stack>
          <Alert color="red" role="alert">
            {t('wipe.warning')}
          </Alert>
          <PasswordInput
            label={t('wipe.password')}
            data-autofocus
            value={pw}
            onChange={(e) => setPw(e.currentTarget.value)}
            autoComplete="current-password"
          />
          <TextInput
            label={t('wipe.phrase', { phrase: WIPE_PHRASE })}
            description={t('wipe.phraseHint')}
            value={phrase}
            onChange={(e) => setPhrase(e.currentTarget.value)}
            autoComplete="off"
            spellCheck={false}
          />
          {hasBackupConfig ? (
            <Checkbox
              label={t('wipe.alsoBackups')}
              description={t('wipe.alsoBackupsHelp')}
              checked={alsoBackups}
              onChange={(e) => setAlsoBackups(e.currentTarget.checked)}
            />
          ) : null}
          {error ? (
            <Text c="red" role="alert" size="sm">
              {error}
            </Text>
          ) : null}
          <Group justify="flex-end">
            <Button variant="default" onClick={close} disabled={busy}>
              {t('wipe.cancel')}
            </Button>
            <Button type="submit" color="red" disabled={!ready} loading={busy}>
              {t('wipe.confirm')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
