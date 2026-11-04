/**
 * The one e-mail address rule of VSS: used by main's e-mail service (`assertAddress`) and by the IPC schemas
 * (vetting-authority contacts), so the renderer, the settings store and the .eml writer can never disagree.
 * Deliberately simple: one `@`, no whitespace, no characters that would need quoting in a header, no control
 * characters, at most 320 characters.
 */
// eslint-disable-next-line no-control-regex
export const EMAIL_CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
export const EMAIL_ADDRESS = /^[^\s<>()[\]",;:\\@]+@[^\s<>()[\]",;:\\@]+$/;
export const EMAIL_ADDRESS_MAX = 320;

export function isValidEmailAddress(a: string): boolean {
  return !EMAIL_CONTROL_CHARS.test(a) && EMAIL_ADDRESS.test(a) && a.length <= EMAIL_ADDRESS_MAX;
}
