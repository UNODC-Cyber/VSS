/**
 * Lane D strings (docs/PLAN-ALPHA.md section 16): Finished / Closed, close and reopen, dashboard tiles, screen links.
 * Only lane D edits this file. Add top-level namespaces (e.g. `lifecycleX: { title: '...' }`); they are spread into
 * `en` (locales/en.ts), so a top-level key must not exist in any other locale file (tests/unit/renderer/i18n-keys.test.ts).
 */
export const lifecycle = {
  lifecycle: {
    needsClosing: 'Needs closing',
    allRequests: 'All requests',
    presets: 'Quick filters',
    awaitingClose: 'Finished, awaiting close',
    byStatus: 'Requests by status',
    reviewTitle: 'Review and close',
    finishedIntro:
      'Every person on this request has an answer. Check the summary, add a note if you like, then close the request.',
    closedIntro: 'This request was closed on {{date}}. Reopen it if more work is needed.',
    summaryCaption: 'Outcomes on this request',
    outcome: 'Outcome',
    people: 'People',
    answered: 'Answered (record on file)',
    excluded: 'Excluded (no answer needed)',
    total: 'Total',
    closeNote: 'Close note (optional)',
    closeNoteHelp: 'Kept with the request. It is not written to the audit log.',
    closeButton: 'Close request',
    closeConfirmTitle: 'Close this request?',
    closeConfirmBody:
      'The request moves to Closed and is recorded in the audit log. You can reopen it later with a reason.',
    closeConfirm: 'Close request',
    closed: 'Request closed',
    note: 'Close note',
    reopenButton: 'Reopen request',
    reopenTitle: 'Reopen this request',
    reopenReason: 'Reason for reopening',
    reopenReasonHelp: 'At least 3 characters. Kept with the request; the audit log records only that it was reopened.',
    reopenConfirm: 'Reopen request',
    reopened: 'Request reopened',
    reopenCount: 'Reopened {{count}} time(s)',
    autoFinished: 'All people on this request have an answer, so it is marked Finished.',
  },
};
