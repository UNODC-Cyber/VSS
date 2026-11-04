/**
 * Lane L strings (docs/PLAN-ALPHA.md section 16): Settings danger zone, delete database dialog, window position.
 * Only lane L edits this file. Add top-level namespaces (e.g. `dangerX: { title: '...' }`); they are spread into
 * `en` (locales/en.ts), so a top-level key must not exist in any other locale file (tests/unit/renderer/i18n-keys.test.ts).
 */
export const danger = {
  danger: {
    title: 'Danger zone',
    intro: 'Delete database permanently removes this vault from this computer. It cannot be undone.',
    deletedHeading: 'What is deleted',
    deleted: {
      vault:
        'The vault file and the encrypted database with everything in it: requests, responses, people, units, the audit log and your settings and templates.',
      stored: 'Every workbook and export that VSS keeps inside the vault.',
      migration: 'The encrypted copies VSS made before upgrading the database.',
    },
    keptHeading: 'What is not deleted',
    kept: {
      exports: 'Workbooks, e-mail (.eml) files and CSV files that you exported to folders you chose.',
      backups:
        'Backups in your backup folder, including the automatic ones, unless you tick the box in the next step. A backup can bring this database back, so keep one if you may need the data.',
    },
    backupAdvice: 'Make a backup first if you may need this data again.',
    backupLink: 'Go to the Backup card',
    open: 'Delete database...',
    afterwards: 'Afterwards VSS returns to the first-run screen, where you can create a new, empty vault.',
    deletedToast: 'The database was deleted',
  },
  wipe: {
    title: 'Delete database',
    warning: 'This permanently deletes the database on this computer. There is no undo.',
    password: 'Password to confirm',
    phrase: 'Type {{phrase}} to confirm',
    phraseHint: 'Type it exactly, in capitals. You can paste it.',
    alsoBackups: 'Also delete the automatic backups in the configured backup folder',
    alsoBackupsHelp: 'Only VSS backup files and the backup key file are removed; other files in that folder stay.',
    confirm: 'Delete database',
    cancel: 'Cancel',
    badPassword: 'The password is incorrect.',
    rateLimited: 'Too many failed attempts. Wait a moment and try again.',
    failed: 'The database could not be deleted. Nothing was changed.',
  },
  windowState: {
    resetButton: 'Reset window position',
    resetHelp: 'Forget the remembered window size and position and centre the window on the main screen.',
    resetDone: 'Window position reset',
  },
};
