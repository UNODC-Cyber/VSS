import type { VettingRequest } from '@shared/domain/types';

/** Props shared by the request dialogs. */
export interface DialogProps {
  opened: boolean;
  onClose: () => void;
  request: VettingRequest;
  onChanged: () => void;
}
