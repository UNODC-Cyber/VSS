import type { Settings } from '@shared/domain/types';

/** Props of a Settings card that edits the unsaved settings draft (saved together through SaveCard). */
export interface SettingsDraftProps {
  value: Settings;
  onChange: (next: Settings) => void;
}

/** NumberInput value -> number, keeping `fallback` while the field is empty or invalid. */
export const asNum = (v: string | number, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;
