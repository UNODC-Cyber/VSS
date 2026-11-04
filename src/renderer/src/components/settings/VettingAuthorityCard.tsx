import { Button, Card, Group, Stack, Text, TextInput, Title } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import type { Contact } from '@shared/domain/types';
import { isValidEmailAddress } from '@shared/email-address';
import type { SettingsDraftProps } from './types';

const MAX_CONTACTS = 50;
type ListKey = 'to' | 'cc';

/** Default To / Cc contacts of the "send request to the vetting authority" draft. */
export function VettingAuthorityCard({ value, onChange }: SettingsDraftProps) {
  const { t } = useTranslation();
  const auth = value.vettingAuthority;

  const setList = (key: ListKey, list: Contact[]) => onChange({ ...value, vettingAuthority: { ...auth, [key]: list } });

  const rowErrors = (list: Contact[], i: number): { name?: string; email?: string } => {
    const c = list[i]!;
    const out: { name?: string; email?: string } = {};
    if (c.name.trim() === '') out.name = t('vettingAuth.missingName');
    if (!isValidEmailAddress(c.email)) out.email = t('vettingAuth.invalidEmail');
    else if (list.findIndex((o) => o.email.toLowerCase() === c.email.toLowerCase()) < i)
      out.email = t('vettingAuth.duplicate');
    return out;
  };

  const renderList = (key: ListKey) => {
    const list = auth[key];
    const label = t(`vettingAuth.${key}`);
    return (
      <Stack gap="xs" role="group" aria-label={label}>
        <Text fw={600}>{label}</Text>
        {list.length === 0 && (
          <Text size="sm" c="dimmed">
            {t('vettingAuth.empty')}
          </Text>
        )}
        {list.map((c, i) => {
          const errs = rowErrors(list, i);
          const rowLabel = t('vettingAuth.row', { list: label, n: i + 1 });
          const edit = (patch: Partial<Contact>) =>
            setList(
              key,
              list.map((x, j) => (j === i ? { ...x, ...patch } : x)),
            );
          return (
            <Group key={i} align="flex-start" gap="xs" role="group" aria-label={rowLabel}>
              <TextInput
                aria-label={`${rowLabel}: ${t('vettingAuth.name')}`}
                placeholder={t('vettingAuth.name')}
                value={c.name}
                error={errs.name}
                maxLength={256}
                onChange={(e) => edit({ name: e.currentTarget.value })}
              />
              <TextInput
                aria-label={`${rowLabel}: ${t('vettingAuth.email')}`}
                placeholder={t('vettingAuth.email')}
                value={c.email}
                error={errs.email}
                maxLength={320}
                onChange={(e) => edit({ email: e.currentTarget.value.trim() })}
              />
              <Button
                variant="default"
                aria-label={t('vettingAuth.remove', { list: label, n: i + 1 })}
                onClick={() =>
                  setList(
                    key,
                    list.filter((_, j) => j !== i),
                  )
                }
              >
                {t('vettingAuth.removeBtn')}
              </Button>
            </Group>
          );
        })}
        <Group>
          <Button
            size="xs"
            variant="light"
            disabled={list.length >= MAX_CONTACTS}
            onClick={() => setList(key, [...list, { name: '', email: '' }])}
          >
            {t('vettingAuth.add', { list: label })}
          </Button>
          {list.length >= MAX_CONTACTS && (
            <Text size="sm" c="dimmed">
              {t('vettingAuth.tooMany', { max: MAX_CONTACTS })}
            </Text>
          )}
        </Group>
      </Stack>
    );
  };

  return (
    <Card withBorder id="card-authority">
      <Stack>
        <Title order={4}>{t('vettingAuth.title')}</Title>
        <Text size="sm" c="dimmed">
          {t('vettingAuth.help')}
        </Text>
        {renderList('to')}
        {renderList('cc')}
      </Stack>
    </Card>
  );
}
