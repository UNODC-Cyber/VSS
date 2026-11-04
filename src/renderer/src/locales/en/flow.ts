/**
 * Flow and decision-safety strings (UI review round 1, 2026-11-04): the explicit identity compare step, email
 * clearance confirmation, response-to-request matching, empty states and next-step lines.
 * Add top-level namespaces only; they are spread into `en` (locales/en.ts), so a top-level key must not exist in any
 * other locale file (tests/unit/renderer/i18n-keys.test.ts).
 */
export const flow = {
  identity: {
    conflictTitle: 'These records disagree',
    conflictBody:
      'Different values for: {{fields}}. Check them before deciding; a mismatch often means two different people.',
    noConflict: 'Compare the records field by field before you decide.',
    loading: 'Loading the full record...',
    ack: 'I compared {{fields}} and I am sure this is the same person.',
    back: 'Back',
    compareWith: 'Compare and decide: {{name}}...',
    compareTitle: 'Is this the same person as {{name}}?',
    mergeTitle: 'Merge these two person records?',
    compareCaption: 'The two records side by side',
    tierLegend:
      'Match tiers: T1 = name, date of birth and an anchor (unit or ID) agree; T2 = strong but not exact; T3 = weak or conflicting; T4 = name only. A tier is a hint: you decide.',
    fatherName: "Father's name",
  },
  evidence: {
    NAME_CORE_EQUAL: 'Main name parts identical',
    NAME_FULL_EQUAL: 'Full name identical',
    NAME_SUBSET_1: 'One name has an extra part',
    NAME_SURNAME_EQUAL: 'Same surname',
    NAME_JW_HIGH: 'Names spelled similarly',
    NAME_PHONETIC_EQUAL: 'Names sound alike',
    DOB_EQUAL: 'Same date of birth',
    DOB_SWAPPED: 'Day and month of birth swapped',
    DOB_YEAR_EQUAL: 'Same year of birth only',
    DOB_CONFLICT: 'Dates of birth differ',
    DOB_MISSING: 'Date of birth missing on one side',
    DOB_PLACEHOLDER: 'Date of birth looks like a placeholder',
    POB_COUNTRY_EQUAL: 'Same country of birth',
    POB_CONFLICT: 'Countries of birth differ',
    POB_PLACE_EQUAL: 'Same place of birth',
    POB_PLACE_CONFLICT: 'Places of birth differ',
    UNIT_EQUAL: 'Same unit',
    UNIT_CONFLICT: 'Units differ',
    ID_EQUAL: 'Same ID number',
    ID_CONFLICT: 'ID numbers differ',
    SEX_CONFLICT: 'Sex differs',
    FATHER_CONFLICT: "Father's names differ",
    NAME_SCRIPT_CONFLICT: 'Names in non-Latin script differ',
    NAME_SCRIPT_IGNORED: 'Non-Latin name on one side only',
  },
  reviewFlow: {
    intro: {
      'response-row-match':
        'A row of the vetting authority response may be about a person on the request. Compare the records, then decide.',
      'request-item-link':
        'A person on this request may already be known in VSS. Compare the records, then decide whether they are the same person.',
      'duplicate-persons': 'These two person records may be the same person. Merge them only if you are sure.',
      'dob-conflict': 'The records give different dates of birth. Keep the one that is correct.',
      'unmatched-response-row':
        'This row of the response matched nobody on the request. Choose the person it is about, create a new person, or validate it manually.',
      'unanswered-request-item':
        'The vetting authority response has no row for this person. Usually the answer is still to come: wait for it, record an e-mailed outcome on the request, or exclude the person on the request. Dismissing this item records nothing.',
      'disposition-unclear':
        'The outcome of this row could not be read with certainty. Record it as approved or not approved, as the response states.',
    },
    caption: {
      'response-row-match': 'Response row and possible matches side by side',
      'request-item-link': 'Request row and known person side by side',
      'duplicate-persons': 'The two person records side by side',
      'dob-conflict': 'The records with differing dates of birth',
      'unmatched-response-row': 'The response row',
      'unanswered-request-item': 'The person on the request',
      'disposition-unclear': 'The response row',
    },
    help: {
      compare: 'Compare and decide: shows both records and asks you to confirm. Nothing is linked before you confirm.',
      notSame: 'Not the same person: VSS remembers that these records are different people and stops suggesting them.',
      skip: 'Skip for now: leaves the item open in the queue.',
      dismiss: 'Dismiss: closes the item without any decision. The record stays exactly as it is.',
    },
    dismissTitle: 'Dismiss this review item?',
    dismissBody: {
      row: 'The response row stays unlinked: no vetting record is created from it. Use this only when the row needs no action (for example a duplicate line).',
      unanswered:
        'Nothing is recorded for this person and the request still shows them without an answer. Use this only when you are handling the person another way.',
      other: 'The item is closed without any decision. Nothing is linked or merged.',
    },
    dismissConfirm: 'Dismiss item',
    source: {
      response: 'Response file, sheet {{sheet}}, row {{row}}',
      request: 'Request file, sheet {{sheet}}, row {{row}}',
      responseRef: 'Response file, row {{ref}}',
      requestRef: 'Request file, row {{ref}}',
    },
  },
  requestFlow: {
    markSentDisabled: 'This request already has an answer, so it cannot be marked as sent again.',
    next: {
      export: 'Next step: export the file for vetting, then send it to the vetting authority.',
      markSent: 'Next step: after you send the exported file to the vetting authority, click Mark sent.',
      import: 'Next step: when the answer arrives, import the response file or record an e-mailed outcome.',
      review: 'Next step: resolve the open identity decisions in the review queue, then close the request.',
      close: 'Next step: check the summary below and close the request.',
      closed: 'This request is closed. Reopen it below if more work is needed.',
    },
  },
  clearance: {
    intro:
      'Record the outcome the vetting authority sent by e-mail. Choose the outcome and who it applies to; you will see a summary before anything is saved.',
    outcomeHelp: 'Nothing is chosen for you. Pick the outcome stated in the e-mail.',
    everyone: 'Everyone on the request ({{count}} people)',
    everyone_one: 'Everyone on the request ({{count}} person)',
    everyone_other: 'Everyone on the request ({{count}} people)',
    selectAll: 'Select all',
    selectNone: 'Select none',
    choose: 'Choose outcome',
    needOutcome: 'Choose the outcome stated in the e-mail.',
    needScope: 'Choose who the outcome applies to.',
    needPeople: 'Select at least one person.',
    review: 'Review before recording',
    back: 'Back to edit',
    summaryTitle: 'This records an outcome for {{count}} people:',
    summaryTitle_one: 'This records an outcome for {{count}} person:',
    summaryTitle_other: 'This records an outcome for {{count}} people:',
    summaryDates: 'Clearance date {{cert}}. Expires {{expiry}}.',
    summaryAssumed: '(assumed expiry)',
    summaryCaption: 'Outcome per person',
    notIncluded: '{{count}} people on the request are not included and get no outcome.',
    notIncluded_one: '{{count}} person on the request is not included and gets no outcome.',
    notIncluded_other: '{{count}} people on the request are not included and get no outcome.',
  },
  matchRequest: {
    placeholder: 'Choose the request this response answers',
    rows: '{{count}} matched rows',
    rows_one: '{{count}} matched row',
    rows_other: '{{count}} matched rows',
    batchSame: 'batch ID matches',
    batchDiffers: 'batch ID differs',
    rowsOf: '{{count}} of {{total}} person rows match people on it',
    preselected: 'Pre-selected because {{why}}. Check it before you continue.',
    noneTitle: 'No confident match',
    weak: 'The best candidate is weak ({{why}}), so nothing is pre-selected.',
    noCandidates: 'No open request looks like this response.',
    choose: 'Choose the request this response answers, or choose "No request" to record the rows without one.',
    zeroTitle: 'No row matches anybody on this request',
    zeroBody:
      'None of the rows in the response matches a person on the chosen request. This is often the wrong request or the wrong file.',
    zeroAck: 'I checked: this response answers this request.',
    hintChoose: 'Choose the matching request to continue.',
    hintZero: 'Confirm the request choice to continue.',
    dobInFile: 'in the file:',
  },
  importSummary: {
    title: 'What will be recorded',
    rows: '{{count}} rows in the response',
    rows_one: '{{count}} row in the response',
    rows_other: '{{count}} rows in the response',
    auto: '{{count}} exact matches linked on import',
    auto_one: '{{count}} exact match linked on import',
    auto_other: '{{count}} exact matches linked on import',
    linked: '{{count}} rows linked to the person you chose',
    linked_one: '{{count}} row linked to the person you chose',
    linked_other: '{{count}} rows linked to the person you chose',
    created: '{{count}} new people created from rows',
    created_one: '{{count}} new person created from a row',
    created_other: '{{count}} new people created from rows',
    skipped: '{{count}} rows not matched ("None of these")',
    skipped_one: '{{count}} row not matched ("None of these")',
    skipped_other: '{{count}} rows not matched ("None of these")',
    review: '{{count}} rows go to the review queue (no decision yet)',
    review_one: '{{count}} row goes to the review queue (no decision yet)',
    review_other: '{{count}} rows go to the review queue (no decision yet)',
    unanswered: '{{count}} people on the request have no answer in this file',
    unanswered_one: '{{count}} person on the request has no answer in this file',
    unanswered_other: '{{count}} people on the request have no answer in this file',
  },
  importFlow: {
    fileShown: 'File: {{name}}',
    needDetails: 'Fill in Requestor name and Event name (in Request details below the table) to continue.',
  },
  exportFlow: {
    regenerateHelp: 'A fresh workbook built from the export template, with the included people only.',
    filterOriginalHelp:
      'The workbook as received, with the excluded rows removed. Use it when the counterpart wants their own file back.',
    nextStep: 'Next: send this file to the vetting authority, then click Mark sent on the request.',
  },
  sentFlow: {
    noItems: 'This request has no individuals. Check that this is the right request before marking it as sent.',
    help: 'Record when you sent the export to the vetting authority. The waiting time is counted from this date.',
    zone: 'Local time on this computer ({{zone}}). All times in VSS are shown in this time zone.',
    notExported:
      'No export has been made for this request yet. Mark it as sent only if you sent the individuals to the vetting authority another way.',
  },
  composeFlow: {
    notSent:
      'VSS does not send e-mail. It prepares the message; you send it from your mail program or save it as a .eml file.',
  },
  emptyFlow: {
    requests: 'No requests yet.',
    requestsHint: 'Import a request file or create a manual request with the buttons above.',
    people: 'No people yet.',
    peopleHint: 'People are added when you import or create a request.',
    searchHint: 'Try another spelling, part of the name, a date of birth or an identifier.',
    units: 'No units yet.',
    unitsHint: 'Units are added when you import or create a request.',
    responsesHint: 'Import a response file when the vetting authority answers a request.',
    anyStatus: 'Any status',
    anyType: 'All types',
    allKinds: 'All kinds',
  },
  dashboardFlow: {
    startTitle: 'Get started',
    step1: 'Import a request file (or create a manual request).',
    step2: 'Export it for vetting and send it to the vetting authority, then click Mark sent.',
    step3: 'Import the response file when it arrives, or record an e-mailed outcome.',
    step4: 'Resolve the review queue, then close the request.',
    noData: 'No data yet',
  },
  backupFlow: {
    none: 'No backup has been made yet.',
    setUpFirst: 'Choose a folder, enter your password and click Set up backups first.',
  },
  // UI review round 2 (2026-11-04): dates of birth that are not valid or not certain, unit rows of a response.
  dobView: {
    invalid: 'Invalid date',
    ambiguous: 'Ambiguous',
    invalidHelp:
      'This is not a real calendar date. It is shown exactly as written, is not used for matching, and must be checked with the source.',
    ambiguousHelp:
      'Day and month can be read either way: as month/day {{md}}, as day/month {{dm}}. VSS uses the month/day reading of vetting authority files. Check it before you decide.',
    ambiguousHelpRedacted: 'Day and month can be read either way. Turn off redaction to see both readings.',
    ambiguousRows:
      'Dates marked "Ambiguous" can be read as month/day or day/month. VSS reads them as month/day, the format of vetting authority files; the value as written in the file is shown below each date. Use Compare to check them.',
    invalidRows:
      'Dates marked "Invalid date" are not real dates. They are kept as written and are not used for matching.',
    invalidInput: 'Not a real calendar date.',
  },
  auditFlow: {
    allEvents: 'All events',
    filterHelp: 'Type part of an event name, for example request.import.',
    timeIn: 'Time ({{zone}})',
  },
  reviewHelp: {
    compareShort: 'Compare and decide...',
    compareN: 'Compare and decide (candidate {{n}})...',
    choose: 'Choose person: search for the person this record is about; you compare before anything is linked.',
    createNew: 'Create new person: this record is somebody VSS does not know yet.',
    validate: 'Manually validate: record this row as a valid answer for a person you choose, with a reason.',
    openRequest: 'Open request',
    openRequestHelp:
      'Open request: go to the request to record an e-mailed outcome for this person or to exclude them.',
  },
  personFlow: {
    checkedOn: 'Status on {{date}} (today).',
    basedOn: 'Based on the latest record: {{disp}} {{cert}}, expires {{expires}}.',
    basedOnNoExpiry: 'Based on the latest record: {{disp}} {{cert}}.',
    noRecord: 'No vetting record yet.',
    assumed: '(expiry assumed)',
  },
  lifecycleFlow: {
    waiting: 'No answer yet',
  },
  unitRow: {
    badge: 'Unit approval',
    label: 'Unit approval: {{unit}}',
    commanderLabel: 'Commander:',
    commander: 'Commander: {{name}}',
    commanderUnknown:
      'Commander not named in the file ("UNKNOWN"): the result is recorded for the unit only; no person is created or linked.',
    explain:
      'Rows marked "Unit approval" are results for a unit, not for a person. The result is recorded for the unit. A commander named in the file is matched to the request like a person; an "UNKNOWN" commander is not matched to anybody.',
  },
};
