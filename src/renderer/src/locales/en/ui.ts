/**
 * Lane G1 strings (docs/PLAN-ALPHA.md section 16): table engine, copy icon, density, appearance card.
 * Only lane G1 edits this file. Add top-level namespaces (e.g. `uiX: { title: '...' }`); they are spread into
 * `en` (locales/en.ts), so a top-level key must not exist in any other locale file (tests/unit/renderer/i18n-keys.test.ts).
 */
export const ui = {
  ui: {
    copyIcon: {
      label: 'Copy {{field}}',
      done: 'Copied',
    },
    dispClass: {
      label: 'Disposition',
      approved: 'Approved',
      'non-approved': 'Non-approved',
      unknown: 'Unclear',
    },
    copyField: {
      body: 'body',
      passphrase: 'passphrase',
      rowText: 'row {{row}} as text',
      rowTsv: 'row {{row}} as TSV',
      allTsv: 'all rows as TSV',
    },
    table: {
      chooseColumns: 'Choose columns',
      scrollHint: 'More columns to the right',
      scrollLeft: 'Scroll table left',
      scrollRight: 'Scroll table right',
      empty: 'Nothing to show',
    },
    people: {
      emptyHint: 'Try a different search or clear the status filter.',
    },
    appearance: {
      title: 'Appearance',
      density: 'Row density',
      densityHelp: 'Compact fits more rows on the screen.',
      comfortable: 'Comfortable',
      compact: 'Compact',
      rememberColumns: 'Remember the columns I chose',
      rememberColumnsHelp:
        'Tables remember hidden columns until you lock the app. This stores them with your settings (press Save below).',
      resetColumns: 'Reset table columns',
      resetColumnsHelp: 'Show every table with its default columns again (press Save below).',
    },
  },
};
