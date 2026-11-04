import { Badge, Table, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { dobBoth, dobSwapped, mask } from '../lib/format';
import { useUi } from '../store';

export interface DiffField {
  key: string;
  label: string;
  values: string[];
  kind?: 'name' | 'dob' | 'text';
}

function norm(v: string, kind: DiffField['kind']): string {
  const s = v.trim().toLowerCase();
  if (kind === 'name') return s.replace(/[,]/g, ' ').split(/\s+/).filter(Boolean).sort().join(' ');
  return s;
}

/** True when the non-empty values of a field are not all equivalent. */
export function fieldDiffers(f: DiffField): boolean {
  const set = new Set(f.values.filter((v) => v.trim() !== '').map((v) => norm(v, f.kind)));
  const anyEmpty = f.values.some((v) => v.trim() === '');
  return set.size > 1 || (set.size === 1 && anyEmpty && f.values.length > 1);
}

/**
 * True when two or more records state different values for the field (a missing value is not a conflict). This is
 * conflict evidence: identity decisions that ignore it must be acknowledged explicitly (IdentityConfirm).
 */
export function fieldConflicts(f: DiffField): boolean {
  return new Set(f.values.filter((v) => v.trim() !== '').map((v) => norm(v, f.kind))).size > 1;
}

/** Side-by-side comparison; differing fields are highlighted and marked with text (not colour alone). */
export function DiffGrid({ headers, fields, caption }: { headers: string[]; fields: DiffField[]; caption: string }) {
  const { t } = useTranslation();
  const redact = useUi((s) => s.settings.redactionMode);
  const show = (v: string) => (v === '' ? '-' : redact ? mask(v) : v);
  return (
    <Table withTableBorder data-testid="diff">
      <Table.Caption>{caption}</Table.Caption>
      <Table.Thead>
        <Table.Tr>
          <Table.Th scope="col">{t('diff.field')}</Table.Th>
          {headers.map((h, i) => (
            <Table.Th key={i} scope="col">
              {h}
            </Table.Th>
          ))}
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {fields.map((f) => {
          const differs = fieldDiffers(f);
          const swapped =
            f.kind === 'dob' && f.values.some((a, i) => f.values.some((b, j) => j > i && dobSwapped(a, b)));
          return (
            <Table.Tr
              key={f.key}
              data-differs={differs ? 'true' : 'false'}
              style={differs ? { background: 'var(--mantine-color-yellow-light)' } : undefined}
            >
              <Table.Th scope="row">
                {f.label}
                {differs && (
                  <Badge ml={6} size="xs" color="orange">
                    {t('diff.differs')}
                  </Badge>
                )}
              </Table.Th>
              {f.values.map((v, i) => {
                const both = swapped ? dobBoth(v) : null;
                return (
                  <Table.Td key={i}>
                    {show(v)}
                    {both && (
                      <Text size="xs" c="dimmed">
                        {redact ? '' : t('diff.dobBoth', { dm: both.dm, md: both.md })}
                      </Text>
                    )}
                  </Table.Td>
                );
              })}
            </Table.Tr>
          );
        })}
      </Table.Tbody>
    </Table>
  );
}
