import { Badge } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import type { RequestStatus } from '@shared/domain/types';
import { REQUEST_STATUS_COLOR } from '../lib/format';

/** Request status as text and colour (colour is never the only signal). */
export function RequestStatusBadge({ status }: { status: RequestStatus }) {
  const { t } = useTranslation();
  return (
    <Badge color={REQUEST_STATUS_COLOR[status]} variant="light" data-request-status={status}>
      {t(`reqstatus.${status}`)}
    </Badge>
  );
}
