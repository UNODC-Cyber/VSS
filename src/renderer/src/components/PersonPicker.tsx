/**
 * Person picker (lane K, R11). Opens pre-filled with the subject's name and lists likely persons at once
 * (`persons.suggest`: candidates, then persons of the same request / unit, then tolerant search hits); typing
 * refines the list after a 200 ms pause. The list is a combobox listbox: arrow keys / Home / End move, Enter or a
 * click selects. With a `subject`, selecting first shows a side-by-side comparison with Confirm / Back. When nothing
 * matches, the alternatives passed in (create new person / not the same person / dismiss) are offered.
 * Nothing is linked here: the caller decides what a confirmed pick means.
 */
import { Alert, Badge, Button, Group, Loader, Modal, Stack, Text, TextInput } from '@mantine/core';
import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { PersonDetail, PersonSuggestion, ReviewSubject, SuggestSubject } from '@shared/ipc/contract';
import { vss } from '../lib/api';
import type { DiffField } from './Diff';
import { IdentityConfirm } from './IdentityConfirm';
import { Sensitive, TierBadge } from './common';

export const PICKER_DEBOUNCE_MS = 200;

export interface PickerAlternatives {
  createNew?: () => void;
  notSame?: () => void;
  dismiss?: () => void;
}

export interface PersonPickerProps {
  opened: boolean;
  title: string;
  onClose: () => void;
  onPick: (p: PersonSuggestion['person']) => void;
  excludeId?: string;
  /** What the person is chosen for: enables candidates and recent persons (persons.suggest). */
  forSubject?: SuggestSubject;
  /** Pre-filled search text (the subject's display name). */
  initialText?: string;
  /** When given, a pick is compared side by side with this record before it is confirmed. */
  subject?: ReviewSubject;
  alternatives?: PickerAlternatives;
}

async function fetchSuggestions(
  text: string,
  forSubject: SuggestSubject | undefined,
): Promise<PersonSuggestion[] | null> {
  if (forSubject) {
    const r = await vss().persons.suggest({ forSubject, ...(text.trim() ? { text } : {}), limit: 20 });
    return r.ok ? r.value : null;
  }
  const r = await vss().persons.list({ offset: 0, limit: 20, ...(text.trim() ? { text } : {}) });
  return r.ok ? r.value.items.map((person) => ({ person, tier: null, evidence: [], why: 'search' as const })) : null;
}

export function PersonPicker({
  opened,
  title,
  onClose,
  onPick,
  excludeId,
  forSubject,
  initialText = '',
  subject,
  alternatives,
}: PersonPickerProps) {
  const { t } = useTranslation();
  const listId = useId();
  const [text, setText] = useState(initialText);
  const [rows, setRows] = useState<PersonSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [active, setActive] = useState(0);
  const [chosen, setChosen] = useState<PersonSuggestion | null>(null);
  const [chosenDetail, setChosenDetail] = useState<PersonDetail | null>(null);
  const seq = useRef(0);
  const subjectKey = forSubject ? `${forSubject.kind}:${forSubject.id}` : '';

  // Reset on every open: pre-fill and list at once.
  useEffect(() => {
    if (!opened) return;
    setText(initialText);
    setChosen(null);
    setChosenDetail(null);
    setActive(0);
    setLoaded(false);
  }, [opened, initialText, subjectKey]);

  useEffect(() => {
    if (!opened) return;
    const my = ++seq.current;
    setLoading(true);
    const timer = setTimeout(
      () => {
        // The pre-filled name is the subject's own: the service searches it anyway and lists candidates and recent
        // persons first; only text the user typed narrows the list.
        const typed = forSubject && text.trim() === initialText.trim() ? '' : text;
        void fetchSuggestions(typed, forSubject).then((r) => {
          if (my !== seq.current) return;
          setRows((r ?? []).filter((s) => s.person.id !== excludeId));
          setActive(0);
          setLoading(false);
          setLoaded(true);
        });
      },
      loaded ? PICKER_DEBOUNCE_MS : 0,
    );
    return () => clearTimeout(timer);
    // Refetch on open, text and subject only (forSubject is compared by key).
  }, [opened, text, subjectKey, excludeId]);

  const choose = (s: PersonSuggestion | undefined) => {
    if (!s) return;
    if (!subject) {
      onPick(s.person);
      return;
    }
    setChosen(s);
    setChosenDetail(null);
    void vss()
      .persons.get({ id: s.person.id })
      .then((r) => {
        if (r.ok) setChosenDetail(r.value);
      });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (rows.length === 0) return;
    const last = rows.length - 1;
    const move: Record<string, number> = {
      ArrowDown: Math.min(active + 1, last),
      ArrowUp: Math.max(active - 1, 0),
      Home: 0,
      End: last,
    };
    if (e.key in move) {
      e.preventDefault();
      setActive(move[e.key]!);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(rows[active]);
    }
  };

  const optionId = (i: number) => `${listId}-opt-${i}`;
  const empty = loaded && !loading && rows.length === 0;

  const compare = chosen && subject && (
    <IdentityConfirm
      caption={t('picker.compareCaption')}
      headers={[subject.source || t('picker.compareSubject'), t('picker.compareChosen')]}
      fields={comparisonFields(t, subject, chosen, chosenDetail)}
      confirmLabel={t('picker.confirm', { name: chosen.person.displayName })}
      backLabel={t('picker.back')}
      ready={chosenDetail !== null}
      onBack={() => setChosen(null)}
      onConfirm={() => onPick(chosen.person)}
    />
  );

  return (
    <Modal opened={opened} onClose={onClose} title={title} size="xl" trapFocus returnFocus>
      {compare || (
        <Stack>
          <TextInput
            data-autofocus
            label={t('picker.searchLabel')}
            description={t('picker.searchHint')}
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            onKeyDown={onKeyDown}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={rows.length > 0}
            aria-controls={listId}
            aria-activedescendant={rows.length > 0 ? optionId(active) : undefined}
            rightSection={loading ? <Loader size="xs" aria-label={t('picker.loading')} /> : null}
          />
          <Text size="xs" c="dimmed">
            {t('picker.keyboard')}
          </Text>
          <Text role="status" size="sm" c="dimmed">
            {loaded ? t('picker.count', { count: rows.length }) : t('picker.loading')}
          </Text>
          {rows.length > 0 && (
            <div
              id={listId}
              role="listbox"
              aria-label={t('picker.results')}
              style={{ maxHeight: 360, overflowY: 'auto' }}
            >
              {rows.map((s, i) => (
                <div
                  key={s.person.id}
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === active}
                  data-testid="picker-option"
                  onClick={() => choose(s)}
                  onMouseEnter={() => setActive(i)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '6px 8px',
                    cursor: 'pointer',
                    borderRadius: 4,
                    background: i === active ? 'var(--mantine-color-default-hover)' : undefined,
                    outline: i === active ? '2px solid var(--mantine-primary-color-filled)' : undefined,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Text fw={600} size="sm">
                      <Sensitive value={s.person.displayName} />
                    </Text>
                    <Text size="xs" c="dimmed">
                      {s.person.dob ? <Sensitive value={s.person.dob} /> : t('picker.noDob')}
                      {' · '}
                      {s.person.currentUnitName ?? t('picker.noUnit')}
                      {s.person.nationality ? ` · ${s.person.nationality}` : ''}
                    </Text>
                  </div>
                  {s.tier && <TierBadge tier={s.tier} />}
                  <Badge variant="light" color="blue" size="sm">
                    {t(`picker.why.${s.why}`)}
                  </Badge>
                  <Button
                    component="span"
                    size="compact-sm"
                    variant="light"
                    color="blue"
                    aria-hidden="true"
                    tabIndex={-1}
                  >
                    {t('picker.select')}
                  </Button>
                </div>
              ))}
            </div>
          )}
          {empty && (
            <Alert color="gray" title={t('picker.emptyTitle')} data-testid="picker-empty">
              <Stack gap="xs">
                <Text size="sm">{t('picker.emptyBody')}</Text>
                <Group gap="xs">
                  {alternatives?.createNew && (
                    <Button size="compact-sm" onClick={alternatives.createNew}>
                      {t('picker.createNew')}
                    </Button>
                  )}
                  {alternatives?.notSame && (
                    <Button size="compact-sm" variant="light" color="orange" onClick={alternatives.notSame}>
                      {t('picker.notSame')}
                    </Button>
                  )}
                  {alternatives?.dismiss && (
                    <Button size="compact-sm" variant="subtle" color="gray" onClick={alternatives.dismiss}>
                      {t('picker.dismiss')}
                    </Button>
                  )}
                </Group>
              </Stack>
            </Alert>
          )}
        </Stack>
      )}
    </Modal>
  );
}

function comparisonFields(
  t: (k: string) => string,
  s: ReviewSubject,
  chosen: PersonSuggestion,
  d: PersonDetail | null,
): DiffField[] {
  const p = chosen.person;
  return [
    { key: 'name', label: t('import.name'), kind: 'name', values: [s.displayName, p.displayName] },
    { key: 'dob', label: t('import.dob'), kind: 'dob', values: [s.dob ?? s.dobRaw, p.dob ?? ''] },
    { key: 'sex', label: t('person.sex'), kind: 'text', values: [s.sex ?? '', d?.person.sex ?? ''] },
    { key: 'pob', label: t('person.pob'), kind: 'text', values: [s.pobCountry ?? '', d?.person.pob.country ?? ''] },
    { key: 'unit', label: t('import.unit'), kind: 'text', values: [s.unitName ?? '', p.currentUnitName ?? ''] },
    {
      key: 'ids',
      label: t('items.ids'),
      kind: 'text',
      values: [s.identifiers.join(', '), (d?.person.identifiers ?? []).map((i) => i.value).join(', ')],
    },
  ];
}
