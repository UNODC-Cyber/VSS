/**
 * Lane E strings (docs/PLAN-ALPHA.md section 16): vetting-authority contacts card.
 * Only lane E edits this file. Add top-level namespaces (e.g. `authorityX: { title: '...' }`); they are spread into
 * `en` (locales/en.ts), so a top-level key must not exist in any other locale file (tests/unit/renderer/i18n-keys.test.ts).
 */
export const authority = {
  vettingAuth: {
    title: 'Vetting authority contacts',
    help: 'Default recipients of the e-mail that sends an exported request to the vetting authority. You can still change them in each draft.',
    to: 'To',
    cc: 'Cc',
    name: 'Name',
    email: 'E-mail address',
    row: '{{list}} contact {{n}}',
    removeBtn: 'Remove',
    add: 'Add {{list}} contact',
    remove: 'Remove {{list}} contact {{n}}',
    empty: 'No contacts yet.',
    invalidEmail: 'Enter a valid e-mail address.',
    missingName: 'Enter a name.',
    tooMany: 'At most {{max}} contacts per list.',
    duplicate: 'This address is already in the list.',
  },
};
