/**
 * Lane I strings (docs/PLAN-ALPHA.md section 16): alpha banner, About card, feedback.
 * Only lane I edits this file. Add top-level namespaces (e.g. `alphaX: { title: '...' }`); they are spread into
 * `en` (locales/en.ts), so a top-level key must not exist in any other locale file (tests/unit/renderer/i18n-keys.test.ts).
 */
export const alpha = {
  alpha: {
    bannerText: 'Alpha build {{version}}: for testing with synthetic data; no automatic updates; send feedback.',
    bannerDismiss: 'Dismiss the alpha notice',
    feedbackLink: 'Send feedback',
    feedbackOpened: 'Feedback page opened in your browser. Do not paste names, dates of birth or file content.',
    helpMenu: 'Help',
    aboutItem: 'About VSS',
    aboutTitle: 'About',
    version: 'Version',
    schema: 'Database schema',
    channel: 'Build channel',
    channelValue: { dev: 'Development', alpha: 'Alpha (testing)', release: 'Release' },
    licence:
      'Licence: Apache-2.0. Third-party notices are listed in docs/THIRD-PARTY-NOTICES.md in the source repository.',
    feedbackHelp:
      'Feedback opens a pre-filled GitHub issue form in your browser. Only the version, Windows version and processor type are added; nothing from your vault ever is.',
    unknown: 'Unknown',
  },
  updates: {
    alphaDisabled: 'Updates are disabled in alpha builds. Install each new alpha by hand.',
  },
};
