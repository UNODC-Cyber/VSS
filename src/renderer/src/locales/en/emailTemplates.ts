/**
 * Lane E strings (docs/PLAN-ALPHA.md section 16): e-mail templates card and template picker.
 * Only lane E edits this file. Add top-level namespaces (e.g. `emailTemplatesX: { title: '...' }`); they are spread into
 * `en` (locales/en.ts), so a top-level key must not exist in any other locale file (tests/unit/renderer/i18n-keys.test.ts).
 */
export const emailTemplates = {
  emailTpl: {
    title: 'E-mail templates',
    help: 'Subject and message of the e-mails VSS drafts. Placeholders in curly braces are replaced when a draft is made. Templates are saved with the other settings.',
    purposes: 'Template purpose',
    purpose: {
      'status-to-requestor': 'Outcome notice to requestor',
      'all-clear': 'All clear to requestor',
      'request-to-dc': 'Request to vetting authority',
      reminder: 'Reminder: outstanding request',
      acknowledgement: 'Acknowledge receipt to requestor',
    },
    subject: 'Subject',
    body: 'Message',
    placeholders: 'Insert placeholder',
    insert: 'Insert {{name}}',
    placeholderHelp: {
      requestor_name: 'name of the requestor',
      requestor_org: 'organisation of the requestor',
      event: 'event name',
      event_dates: 'event start and end dates',
      status_table: 'table of names, units, status and validity (status and reminder e-mails only)',
      valid_until: 'earliest expiry among the approved individuals',
      batch_id: 'batch identifier',
      as_of: 'date of the draft',
      attachment_name: 'file name of the attached export',
      office_name: 'name of the vetting office',
    },
    preview: 'Preview (synthetic sample data)',
    previewSubject: 'Subject',
    previewBody: 'Message',
    previewFailed: 'The preview is not available.',
    unknown: 'Unknown placeholders stay as written in the e-mail: {{names}}',
    personalData: 'With a status table this message names individuals. Check it before sending.',
    modified: 'Changed from default',
    isDefault: 'Default text',
    reset: 'Reset to default',
    subjectTooLong: 'The subject is limited to {{max}} characters.',
    bodyTooLong: 'The message is limited to {{max}} characters.',
    controlChars: 'Remove control characters.',
    editLink: 'Edit templates',
    pickRequestor: 'Requestor',
    pickRequestorHelp: 'Choose a saved requestor to address this message to their e-mail.',
    noRequestorEmail: 'The requestor has no e-mail address on file. Enter one in To.',
  },
};
