# Accessibility checklist

Every UI change ticks this list in its pull request (docs/PLAN-ALPHA.md section 9). Target: WCAG 2.2 AA. The automated
part is `tests/e2e/mock-journey.test.ts` (axe, tags wcag2a and wcag2aa); the rest is a manual pass with the dev build
(`npm run dev`, or `?mock=1` in the renderer dev server).

## Per screen

- [ ] Keyboard only: every control is reachable with Tab and Shift+Tab, operated with Enter or Space, and nothing traps
      focus (dialogs trap it on purpose and release it on Escape or Close).
- [ ] Focus order follows the reading order; a new dialog moves focus into it and returns it to the opener.
- [ ] Focus is always visible (2 px outline, not removed by custom CSS). The horizontal scroll region of a table is
      focusable and scrolls with the arrow keys.
- [ ] Every icon-only button has an accessible name that says what it acts on ("Copy passport", not "Copy").
      Icons themselves are `aria-hidden`.
- [ ] Tables: a caption (or region label), `scope="col"` headers, no layout tables, no cell content hidden from
      assistive technology. Truncated text keeps its full value available (tooltip on hover and focus,
      accessible name on the truncated element).
- [ ] Status is never conveyed by colour alone: a badge always carries its text.
- [ ] Text contrast is at least 4.5:1 (3:1 for large text and UI boundaries) in light and dark. New colours go
      through `styles.css` tokens and are checked.
- [ ] Form fields have visible labels; errors are announced (`role="alert"` or a live region) and name the field.
- [ ] Live feedback (toasts, copy confirmation) uses `aria-live="polite"`; destructive confirmations do not.
- [ ] Reduced motion: no animation beyond a brief fade; `prefers-reduced-motion` is honoured (global rule in
      `styles.css`).
- [ ] 150 % scaling and 1024 px width: no clipped controls, no horizontal page scroll (tables scroll inside their own
      region), text can be enlarged to 200 % without loss.
- [ ] No time limit except the auto-lock, which warns first and can be extended.
- [ ] Language and strings: no literal user-visible string in code; everything goes through i18n.

## Tables (DataTable v2)

- [ ] Every column that holds a date, status or identifier has a fixed `width` and `nowrap`.
- [ ] Every free-text column has `truncate` (with a `tooltip` function when the cell shows something other than plain
      text) or a documented reason to wrap.
- [ ] The first column that names the row is `sticky: 'first'`.
- [ ] Optional columns are `hideable` and the table has a `tableId`.
- [ ] Checked at 1280x720 and 1366x768, comfortable and compact density.

## Sign-off line for the PR

`A11Y: keyboard pass, focus visible, names on icon buttons, table semantics, contrast, reduced motion, 150 % - done by <name> on <date>`
