import { useTranslation } from 'react-i18next';
import { useAction, vss } from '../../lib/api';
import { PersonPicker } from '../PersonPicker';

/**
 * Link a request item to a known person (lane K picker): likely persons for the item are listed at once; when none
 * fits, the item can become a new person from its own observation.
 */
export function LinkItemDialog({
  opened,
  onClose,
  itemId,
  onChanged,
  itemName,
}: {
  opened: boolean;
  onClose: () => void;
  itemId: string | null;
  onChanged: () => void;
  /** Pre-fills the search (the item's observed name), when the caller knows it. */
  itemName?: string;
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
      onPick={(p) => void link(p.id, t('link.done'))}
      alternatives={{ createNew: () => void link(null, t('review.newPerson')) }}
    />
  );
}
