/**
 * Lane F strings (docs/PLAN-ALPHA.md section 16): import wizard steps, Back / Cancel, wrong-file state.
 * Only lane F edits this file. The part is spread into `en` (locales/en.ts), so its own top-level key is the
 * namespace (`t('wizard.back')`); no other locale file may define the `wizard` key (tests/unit/renderer/i18n-keys.test.ts).
 */
export const wizard = {
  wizard: {
    stepsLabel: 'Import steps',
    stepOf: 'Step {{n}} of {{total}}',
    steps: {
      pick: 'Pick file',
      match: 'Match request',
      reviewRequestor: 'Review & requestor',
      decide: 'Decide rows',
      confirm: 'Confirm',
    },
    back: 'Back',
    next: 'Next',
    cancel: 'Cancel',
    chooseAnother: 'Choose another file',
    fileReady: 'File ready: {{name}}',
    thisFile: 'This file',
    cannotCommit:
      'This file cannot be imported as it is. Fix the errors listed on the match step, or choose another file.',
    confirmText:
      'Importing saves this response with your decisions. Nothing is saved before this step. Cancel discards the file from memory.',
    requestConfirmText:
      'Importing saves this request with your export decisions. Nothing is saved before this step. Cancel discards the file from memory.',
    discardTitle: 'Discard this import?',
    discardBody: 'Your decisions for this file will be lost. The file is removed from memory and nothing is saved.',
    keepEditing: 'Keep editing',
    discard: 'Discard and cancel',
    wrongKind: {
      title: 'This is not a response file',
      requestBody:
        '{{name}} is a vetting request workbook. This screen imports DC response files. Choose the response file, or open the request importer for this file.',
      otherBody: '{{name}} is not a DC response file this version can read. Choose another file.',
      openRequestImporter: 'Open the request importer',
    },
    importFailed: {
      title: 'This file could not be imported',
      body: 'Choose another file and try again.',
    },
  },
};
