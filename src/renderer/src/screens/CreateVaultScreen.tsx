import {
  Alert,
  Button,
  Center,
  List,
  Paper,
  PasswordInput,
  Progress,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAction, vss } from '../lib/api';
import { useUi } from '../store';

export const MIN_PASSWORD = 12;

/** 0-4 crude strength score; guidance only, the real KDF cost is the protection. */
export function passwordScore(pw: string): number {
  let score = 0;
  if (pw.length >= MIN_PASSWORD) score += 1;
  if (pw.length >= 16) score += 1;
  if (/\s/.test(pw) || pw.split(/[^A-Za-z]+/).filter((w) => w.length > 2).length >= 4) score += 1;
  if (/[a-z]/.test(pw) && /[A-Z0-9]/.test(pw) && /[^A-Za-z0-9\s]|\d/.test(pw)) score += 1;
  return score;
}

/** Words for the strength meter (it is never an unlabeled bar). */
export function strengthLevel(pw: string, score: number): 'none' | 'tooShort' | 'weak' | 'fair' | 'strong' {
  if (pw === '') return 'none';
  if (pw.length < MIN_PASSWORD) return 'tooShort';
  return score < 2 ? 'weak' : score < 4 ? 'fair' : 'strong';
}

export function CreateVaultScreen() {
  const { t } = useTranslation();
  const act = useAction();
  const setVault = useUi((s) => s.setVault);
  const [name, setName] = useState('');
  const [restorePass, setRestorePass] = useState('');
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const score = passwordScore(pw);
  const match = pw.length > 0 && pw === confirm;
  const valid = pw.length >= MIN_PASSWORD && match && name.trim() !== '';

  /** Restore an encrypted backup into this computer's (empty) vault folder; then unlock with the vault password. */
  const restore = async () => {
    const r = await act(vss().files.pickOpen({ kind: 'backup', title: t('vault.restoreTitle') }));
    if (!r?.path) return;
    const s = await act(vss().backup.restore({ srcPath: r.path, passphrase: restorePass }), t('settings.restoreDone'));
    setRestorePass('');
    if (s) setVault(s);
  };
  const submit = async () => {
    setBusy(true);
    const s = await act(vss().vault.create({ password: pw, displayName: name.trim() }));
    setBusy(false);
    setPw('');
    setConfirm('');
    if (s) setVault(s);
  };

  return (
    <Center mih="100vh" p="md">
      <Paper withBorder p="xl" maw={520} w="100%" component="main">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) void submit();
          }}
        >
          <Stack>
            <Title order={1}>{t('vault.createTitle')}</Title>
            <Text c="dimmed">{t('vault.createIntro')}</Text>
            <Text size="sm" c="dimmed">
              {t('vault.locationFixed')}
            </Text>
            <Alert color="orange" variant="light" title={t('vault.noRecoveryTitle')} data-testid="no-recovery">
              <Stack gap="xs">
                <Text size="sm">{t('vault.noRecovery')}</Text>
                <Text size="sm">{t('vault.noRecoveryBackup')}</Text>
              </Stack>
            </Alert>
            <TextInput
              label={t('vault.displayName')}
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              required
            />
            <PasswordInput
              label={t('vault.password')}
              value={pw}
              onChange={(e) => setPw(e.currentTarget.value)}
              required
              autoComplete="new-password"
              aria-describedby="pw-guidance"
            />
            <Progress
              value={(score / 4) * 100}
              color={score < 2 ? 'red' : score < 4 ? 'yellow' : 'green'}
              aria-label={t('vault.strength')}
            />
            <Text size="xs" data-testid="strength-label">
              {t('vault.strengthLabel', { level: t(`vault.strengthLevel.${strengthLevel(pw, score)}`) })}
            </Text>
            <div id="pw-guidance">
              <Text size="sm" fw={600}>
                {t('vault.guidanceTitle')}
              </Text>
              <List size="sm">
                <List.Item>{t('vault.guidanceLength', { min: MIN_PASSWORD })}</List.Item>
                <List.Item>{t('vault.guidancePassphrase')}</List.Item>
                <List.Item>{t('vault.guidanceReuse')}</List.Item>
              </List>
            </div>
            <PasswordInput
              label={t('vault.confirm')}
              value={confirm}
              onChange={(e) => setConfirm(e.currentTarget.value)}
              required
              autoComplete="new-password"
              error={confirm !== '' && !match ? t('vault.mismatch') : undefined}
            />
            <Button type="submit" disabled={!valid} loading={busy}>
              {t('vault.create')}
            </Button>
            <Title order={2} size="h4" mt="md">
              {t('vault.restoreHeading')}
            </Title>
            <Text size="sm">{t('vault.restoreIntro')}</Text>
            <PasswordInput
              label={t('vault.restorePass')}
              value={restorePass}
              onChange={(e) => setRestorePass(e.currentTarget.value)}
              autoComplete="off"
            />
            <Button variant="default" disabled={restorePass.length < 12} onClick={() => void restore()}>
              {t('vault.restore')}
            </Button>
          </Stack>
        </form>
      </Paper>
    </Center>
  );
}
