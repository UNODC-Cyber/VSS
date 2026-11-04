import { Anchor, Badge, createTheme, Modal, ModalHeader } from '@mantine/core';
import { i18n } from './i18n';

/**
 * Darker primary shade and light-variant badges keep text at WCAG AA contrast
 * (filled orange/yellow/red badges with white text do not). Dialog close buttons get an accessible name.
 */
export const theme = createTheme({
  fontFamily: "'Inter Variable', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  headings: { fontFamily: "'Inter Variable', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" },
  primaryShade: { light: 8, dark: 8 },
  autoContrast: true,
  components: {
    Badge: Badge.extend({ defaultProps: { variant: 'light' } }),
    // Links inside running text must not rely on colour alone (WCAG 1.4.1); table links are plain anchors.
    Anchor: Anchor.extend({ defaultProps: { underline: 'always' } }),
    // Mantine renders the dialog title bar as <header>, which assistive technology lists as a second banner landmark.
    ModalHeader: ModalHeader.extend({ defaultProps: { component: 'div' } as never }),
    Modal: Modal.extend({ defaultProps: { closeButtonProps: { 'aria-label': i18n.t('common.closeDialog') } } }),
  },
});
