import { Alert, Button, Center, Paper, PasswordInput, Stack, Text, Title } from '@mantine/core';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { vss } from '../lib/api';
import { useUi } from '../store';

export function UnlockScreen() {
  const { t } = useTranslation();
  const vault = useUi((s) => s.vault);
  const setVault = useUi((s) => s.setVault);
  const [pw, setPw] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const until = vault?.lockedOutUntil ? Date.parse(vault.lockedOutUntil) : 0;
  const waitSecs = Math.max(0, Math.ceil((until - now) / 1000));

  useEffect(() => {
    if (waitSecs <= 0) return;
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, [waitSecs]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const r = await vss().vault.unlock({ password: pw });
    setBusy(false);
    setPw(''); // never keep the password in state after use
    if (r.ok) {
      setVault(r.value);
    } else {
      setError(r.error.message);
      const s = await vss().vault.status();
      if (s.ok) setVault(s.value);
      setNow(Date.now());
    }
  };

  return (
    <Center mih="100vh" p="md">
      <Paper withBorder p="xl" maw={440} w="100%" component="main">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (pw && waitSecs === 0) void submit();
          }}
        >
          <Stack>
            <Title order={1}>{t('unlock.title')}</Title>
            <Text c="dimmed">{t('unlock.intro')}</Text>
            <PasswordInput
              label={t('vault.password')}
              value={pw}
              onChange={(e) => setPw(e.currentTarget.value)}
              autoComplete="current-password"
              data-autofocus
              required
            />
            {error && (
              <Alert color="red" role="alert">
                {error}
              </Alert>
            )}
            {waitSecs > 0 && (
              <Alert color="orange" role="status">
                {t('unlock.backoff', { count: waitSecs })}
              </Alert>
            )}
            {(vault?.failedAttempts ?? 0) > 0 && (
              <Text size="sm" c="dimmed">
                {t('unlock.failed', { count: vault?.failedAttempts ?? 0 })}
              </Text>
            )}
            <Button type="submit" loading={busy} disabled={!pw || waitSecs > 0}>
              {t('unlock.submit')}
            </Button>
          </Stack>
        </form>
      </Paper>
    </Center>
  );
}
