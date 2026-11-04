import { useTranslation } from 'react-i18next';
import type { RequestItem } from '@shared/domain/types';
import type { ReviewSubject } from '@shared/ipc/contract';
import { useAction, vss } from '../../lib/api';
import { PersonPicker } from '../PersonPicker';

/** The request item as a comparison subject, so a pick is compared side by side before it is linked. */
export function itemSubject(item: RequestItem, displayName: string): ReviewSubject {
  const o = item.observed;
  const sex = o.sex.trim().toUpperCase();
  return {
    id: item.id,
    kind: 'request-item',
    displayName,
    dob: o.dob.parsed,
    dobRaw: o.dob.value,
    sex: sex === 'M' || sex === 'F' ? sex : null,
    pobCountry: o.pobCountry || null,
    unitName: o.unitName || null,
    identifiers: [o.passport, o.nationalId].filter(Boolean),
    source: o.rowRef,
    edited: false,
  };
}

/**
 * Link a request item to a known person (lane K picker): likely persons for the item are listed at once; a pick is
 * compared with the item and must be confirmed (never linked on the first click). When none fits, the item can
 * become a new person from its own observation.
 */
export function LinkItemDialog({
  opened,
  onClose,
  itemId,
  onChanged,
  itemName,
  item,
}: {
  opened: boolean;
  onClose: () => void;
  itemId: string | null;
  onChanged: () => void;
  /** Pre-fills the search (the item's observed name), when the caller knows it. */
  itemName?: string;
  /** The item itself: enables the side-by-side comparison before linking. */
  item?: RequestItem;
}) {
  const { t } = useTranslation();
  const act = useAction();
  if (!itemId) return null;
  const link = async (personId: string | null, done: string) => {
    const r = await act(vss().requests.linkItem({ itemId, personId }), done);
    if (r) {
      onChanged();
      onClose();
    }
  };
  return (
    <PersonPicker
      opened={opened}
      title={t('link.title')}
      onClose={onClose}
      forSubject={{ kind: 'request-item', id: itemId }}
      initialText={itemName ?? ''}
      {...(item ? { subject: itemSubject(item, itemName ?? '') } : {})}
      onPick={(p) => void link(p.id, t('link.done'))}
      alternatives={{ createNew: () => void link(null, t('review.newPerson')) }}
    />
  );
}
