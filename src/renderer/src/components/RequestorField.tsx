/**
 * Requestor fields with a type-ahead over the saved requestors (lane B, docs/PLAN-ALPHA.md section 4).
 * The name and e-mail inputs are accessible comboboxes (arrows, Enter, Escape; `aria-autocomplete="list"`); picking a
 * saved requestor fills name, e-mail, organisation and phone and remembers its id, so the e-mail is there for
 * "Email requestor" without retyping. Typing a different name forgets the id (a new requestor).
 */
import { Button, Combobox, Group, Modal, Stack, Text, TextInput, useCombobox, VisuallyHidden } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Requestor, RequestorRecord, Ulid } from '@shared/domain/types';
import { vss } from '../lib/api';

/** Form state of the requestor fields (empty string = not given). */
export interface RequestorForm {
  id?: Ulid;
  name: string;
  email: string;
  organisation: string;
  phone: string;
}
export const EMPTY_REQUESTOR: RequestorForm = { name: '', email: '', organisation: '', phone: '' };

const DEBOUNCE_MS = 200;
const LIMIT = 8;

const norm = (s: string | null | undefined): string => (s ?? '').trim();

/** Did the user change the saved record's details? (Only the fields the form shows.) */
export function differsFromSaved(v: RequestorForm, saved: RequestorRecord): boolean {
  return (
    norm(v.name) !== norm(saved.name) ||
    norm(v.email) !== norm(saved.email) ||
    norm(v.organisation) !== norm(saved.organisation) ||
    norm(v.phone) !== norm(saved.phone)
  );
}

/**
 * How many requests use the saved requestor whose details the user changed, or null when no question is needed
 * (no saved record selected, nothing changed, or no request uses the record).
 */
export function affectedRequests(v: RequestorForm, saved: RequestorRecord | null): number | null {
  if (!saved || v.id !== saved.id || saved.requestCount < 1 || !differsFromSaved(v, saved)) return null;
  return saved.requestCount;
}

/** The `Requestor` to send. `only-this-request` drops the id, so the saved record is not edited. */
export function toRequestor(v: RequestorForm, choice?: 'update' | 'only-this-request'): Requestor {
  return {
    ...(v.id && choice !== 'only-this-request' ? { id: v.id } : {}),
    name: v.name.trim(),
    email: norm(v.email) || null,
    organisation: norm(v.organisation) || null,
    ...(norm(v.phone) ? { phone: norm(v.phone) } : {}),
  };
}

interface Props {
  value: RequestorForm;
  /** `saved` is the record the user picked (null once they type a different name). */
  onChange(next: RequestorForm, saved: RequestorRecord | null): void;
  /** The record currently picked, to keep it across edits of the other fields. */
  saved: RequestorRecord | null;
}

type SearchField = 'name' | 'email';

export function RequestorField({ value, onChange, saved }: Props) {
  const { t } = useTranslation();
  const [options, setOptions] = useState<RequestorRecord[]>([]);
  const [query, setQuery] = useState<{ text: string; n: number } | null>(null);
  const [active, setActive] = useState<SearchField | null>(null);
  const seq = useRef(0);
  const nameBox = useCombobox({ onDropdownClose: () => nameBox.resetSelectedOption() });
  const emailBox = useCombobox({ onDropdownClose: () => emailBox.resetSelectedOption() });
  const box = (f: SearchField) => (f === 'name' ? nameBox : emailBox);

  useEffect(() => {
    if (!query) return;
    const mine = ++seq.current;
    const timer = setTimeout(() => {
      void vss()
        .requestors.search({ text: query.text, limit: LIMIT })
        .then((r) => {
          if (mine === seq.current && r.ok) setOptions(r.value);
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const search = (field: SearchField, text: string) => {
    setActive(field);
    setQuery({ text, n: (query?.n ?? 0) + 1 });
    box(field).openDropdown();
  };

  const pick = (rec: RequestorRecord) => {
    seq.current++;
    onChange(
      {
        id: rec.id,
        name: rec.name,
        email: rec.email ?? '',
        organisation: rec.organisation ?? '',
        phone: rec.phone ?? '',
      },
      rec,
    );
    nameBox.closeDropdown();
    emailBox.closeDropdown();
  };

  // Only the field being typed in lists the options, so a screen reader sees one listbox at a time.
  const listbox = (field: SearchField) => (
    <Combobox.Dropdown hidden={active !== field}>
      <Combobox.Options aria-label={t('requestorField.listLabel')}>
        {active !== field ? null : options.length === 0 ? (
          <Combobox.Empty>{t('requestorField.none')}</Combobox.Empty>
        ) : (
          options.map((o) => (
            <Combobox.Option key={o.id} value={o.id}>
              <Stack gap={0}>
                <Text size="sm" fw={500}>
                  {o.name}
                </Text>
                <Text size="xs" c="dimmed">
                  {[o.email, o.organisation].filter(Boolean).join(' | ')}
                </Text>
              </Stack>
            </Combobox.Option>
          ))
        )}
      </Combobox.Options>
    </Combobox.Dropdown>
  );

  const onSubmit = (id: string) => {
    const rec = options.find((o) => o.id === id);
    if (rec) pick(rec);
  };

  return (
    <>
      <Group grow align="flex-start">
        <Combobox store={nameBox} onOptionSubmit={onSubmit} withinPortal={false}>
          <Combobox.Target withExpandedAttribute>
            <TextInput
              label={t('request.requestorName')}
              required
              autoComplete="off"
              aria-autocomplete="list"
              description={t('requestorField.hint')}
              value={value.name}
              onChange={(e) => {
                const name = e.currentTarget.value;
                // A different name is a different requestor: forget the saved record.
                const { id: _id, ...rest } = value;
                onChange({ ...rest, name }, null);
                search('name', name);
              }}
              onFocus={() => search('name', value.name)}
              onBlur={() => {
                nameBox.closeDropdown();
                setActive(null);
              }}
            />
          </Combobox.Target>
          {listbox('name')}
        </Combobox>
        <Combobox store={emailBox} onOptionSubmit={onSubmit} withinPortal={false}>
          <Combobox.Target withExpandedAttribute>
            <TextInput
              label={t('request.requestorEmail')}
              autoComplete="off"
              aria-autocomplete="list"
              value={value.email}
              onChange={(e) => {
                const email = e.currentTarget.value;
                onChange({ ...value, email }, saved);
                search('email', email);
              }}
              onFocus={() => search('email', value.email)}
              onBlur={() => {
                emailBox.closeDropdown();
                setActive(null);
              }}
            />
          </Combobox.Target>
          {listbox('email')}
        </Combobox>
        <TextInput
          label={t('request.organisation')}
          value={value.organisation}
          onChange={(e) => onChange({ ...value, organisation: e.currentTarget.value }, saved)}
        />
        <TextInput
          label={t('requestorField.phone')}
          value={value.phone}
          onChange={(e) => onChange({ ...value, phone: e.currentTarget.value }, saved)}
        />
      </Group>
      <VisuallyHidden role="status" aria-live="polite">
        {active
          ? t('requestorField.found', { count: options.length })
          : saved && value.id === saved.id
            ? t('requestorField.saved', { name: saved.name })
            : ''}
      </VisuallyHidden>
    </>
  );
}

/** Asks whether a change to a saved requestor edits the saved record or only the request being saved. */
export function RequestorChoiceModal({
  count,
  onChoose,
  onCancel,
}: {
  /** Requests using the record; null = closed. */
  count: number | null;
  onChoose(choice: 'update' | 'only-this-request'): void;
  onCancel(): void;
}) {
  const { t } = useTranslation();
  return (
    <Modal opened={count !== null} onClose={onCancel} title={t('requestorChoice.title')} trapFocus returnFocus>
      <Stack>
        <Text>{t('requestorChoice.body', { count: count ?? 0 })}</Text>
        <Text size="sm" c="dimmed">
          {t('requestorChoice.updateHint')} {t('requestorChoice.onlyHint')}
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={onCancel}>
            {t('requestorChoice.cancel')}
          </Button>
          <Button variant="default" onClick={() => onChoose('only-this-request')}>
            {t('requestorChoice.only')}
          </Button>
          <Button onClick={() => onChoose('update')} data-autofocus>
            {t('requestorChoice.update')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
