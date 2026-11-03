import { Badge, createTheme, Modal } from '@mantine/core';
import { i18n } from './i18n';

/**
 * Darker primary shade and light-variant badges keep text at WCAG AA contrast
 * (filled orange/yellow/red badges with white text do not). Dialog close buttons get an accessible name.
 */
export const theme = createTheme({
  primaryShade: { light: 8, dark: 5 },
  autoContrast: true,
  components: {
    Badge: Badge.extend({ defaultProps: { variant: 'light' } }),
    Modal: Modal.extend({ defaultProps: { closeButtonProps: { 'aria-label': i18n.t('common.closeDialog') } } }),
  },
});
