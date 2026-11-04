import { useTranslation } from 'react-i18next';
import { useAction, vss } from '../../lib/api';
import { PersonPicker } from '../PersonPicker';

export function LinkItemDialog({
  opened,
  onClose,
  itemId,
  onChanged,
}: {
  opened: boolean;
  onClose: () => void;
  itemId: string | null;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const act = useAction();
  if (!itemId) return null;
  return (
    <PersonPicker
      opened={opened}
      title={t('link.title')}
      onClose={onClose}
      onPick={async (p) => {
        const r = await act(vss().requests.linkItem({ itemId, personId: p.id }), t('link.done'));
        if (r) {
          onChanged();
          onClose();
        }
      }}
    />
  );
}
