/**
 * Lane B strings (docs/PLAN-ALPHA.md section 16): saved requestors, type-ahead field.
 * Only lane B edits this file. Add top-level namespaces (e.g. `requestorsX: { title: '...' }`); they are spread into
 * `en` (locales/en.ts), so a top-level key must not exist in any other locale file (tests/unit/renderer/i18n-keys.test.ts).
 */
export const requestors = {
  requestorField: {
    phone: 'Requestor phone',
    listLabel: 'Saved requestors',
    found: 'Saved requestors found: {{count}}',
    none: 'No saved requestor matches',
    saved: 'Saved requestor selected: {{name}}',
    hint: 'Type to search saved requestors by name or e-mail address.',
  },
  requestorChoice: {
    title: 'Update the saved requestor?',
    body: 'The details you changed belong to a saved requestor. Requests using it: {{count}}.',
    update: 'Update saved requestor',
    updateHint: 'Changes the saved record; requests that still show its details follow it.',
    only: 'Only this request',
    onlyHint: 'Keeps the saved record as it is.',
    cancel: 'Cancel',
  },
};
