# AEGIS Monitor Layout and Contrast Refactor

## Scope

Fix the AEGIS Monitor desktop layout and readability issues without changing application logic, data flow, permissions, or navigation behavior.

## Design

- Keep the existing `AegisLockup` in the start zone of `TopBar` and make its wrapper and text non-shrinking/non-truncating so the full title and subtitle remain visible.
- Remove obsolete sidebar-brand styling and widen the desktop sidebar to 280px. Force section headings and menu labels to stay on one line.
- Set explicit dark and light theme colors for page subtitles, sidebar footer text, and live event-stream rows so these elements remain readable against their panel backgrounds.
- Preserve responsive behavior by allowing the navbar to hide the full brand at the existing compact breakpoint and keeping mobile navigation unchanged.

## Verification

- Run the existing automated tests.
- Run the Vite production build.
- Inspect the final diff for changes limited to layout/contrast and knowledge-base documentation.

