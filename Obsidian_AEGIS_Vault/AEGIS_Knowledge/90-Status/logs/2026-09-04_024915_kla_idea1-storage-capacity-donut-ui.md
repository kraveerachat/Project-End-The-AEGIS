---
title: Task Receipt — IDEA1 Storage capacity donut/ring UI
date: 2026-09-04T02:49:15+07:00
owner: kla
area: idea1
branch: feat/idea1-storage-capacity-donut-ui
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA1 Storage capacity donut/ring UI

## What changed

- The Storage & Backup `Capacity` card no longer renders a single horizontal
  bar. It renders an SVG ring (donut) plus a column legend and the four summary
  figures Total / Used / Free / Used share.
- The ring's denominator is `capacityBytes.totalBytes`, so the filled sweep *is*
  the used share. Categories are drawn largest-first, then `Other on this
  volume`, then free space closing the ring.
- **The hatch semantics were inverted in the old bar and are now correct.**
  `DESIGN.md` defines the 45° hatch as "the system cannot see/identify this".
  The old bar hatched **free space** (which statfs measures and AEGIS knows is
  empty) and drew **unaccounted bytes** as a solid `--line` fill (which is
  precisely the space AEGIS *cannot* identify). Free is now a plain neutral arc
  with a `--line` rim; unaccounted is the hatched arc.
- Categories too small to draw as a real arc (below ~0.39% of the ring, i.e. a
  sub-2px arc at r=82) are drawn as a **thin inset tick** that is visibly not
  the ring's band thickness, so it cannot be misread as a proportional slice.
  Their legend swatch becomes the same thin tick, and a note under the legend
  states that the mark is a minimum width, not a share. The legend remains the
  authoritative record: exact bytes, and `<0.1%` rather than a rounded `0.0%`.
- Legend rows are real controls: hover, `focus-visible`, and click-to-pin
  (`aria-pressed`) all highlight the matching arc and swap the ring's centre to
  that category's name, size and share. No behaviour is hover-only.
- No `/api/storage` or `/api/backup` contract change. No new chart dependency
  (recharts is present in the project but its `ResponsiveContainer` measures the
  DOM and renders empty under the suite's `renderToStaticMarkup`, and the hatched
  arc needs an SVG `<pattern>` paint that recharts does not expose).
- The Disk Health, RAID and Backup Jobs cards are byte-identical to `origin/main`.

## Source files changed

- `IDEA1-AEGIS_Drive_LC/src/components/CapacityRing.jsx` — new. The ring
  geometry, the minimum-arc disclosure rule, the legend, and the summary block.
- `IDEA1-AEGIS_Drive_LC/src/screens/Storage.jsx` — removed the local `SEG` table
  and `CapacityCard` bar implementation; imports `CapacityCard` from the new
  component; header comment updated (it previously stated the capacity card was
  deliberately left un-redesigned in the data phase).
- `IDEA1-AEGIS_Drive_LC/src/lib/strings.js` — added `capacityRingLabel`,
  `capacityLegendCategory`, `capacityLegendSize`, `capacityLegendShare`,
  `capacityTinyShare`, `capacityFloorNote` in EN/TH/ZH; changed
  `capacityUsedPct` from "Used" to "Used share" (TH "สัดส่วนที่ใช้", ZH "已用占比")
  because it now sits beside `capacityUsed` in the same summary block and the two
  labels were identical.
- `IDEA1-AEGIS_Drive_LC/tests/storageCapacityRingUi.test.js` — new. Seven cases
  covering the bar's removal, per-category legend bytes, the four summary
  figures, the hatch/free split, the minimum-arc disclosure, the unreadable
  fallback, zero-category rows, and EN/TH/ZH rendering.
- `IDEA1-AEGIS_Drive_LC/tests/storageBackupUi.test.js` — comment only: the file
  previously documented that the Capacity card was not redesigned in this phase.
- `IDEA1-AEGIS_Drive_LC/tests/allScreensEmptyState.test.js` — the
  "Storage always renders zero categories" guard read `Storage.jsx` for
  `t('storageZeroGb')` and for the absence of a `bytes > 0` filter. The ring does
  filter zero categories out of the *arc* while keeping them in the *legend*, so
  the assertion now reads `CapacityRing.jsx` and guards the invariant that
  actually matters: zero categories still appear as rows.

## Verification evidence

- `npm run build` — pass: built in 4.33s. The ">500 kB chunk" warning is
  pre-existing on `origin/main` and unrelated. `dist/` was restored to HEAD
  afterwards and is not part of this change.
- `node --test tests/storageCapacityRingUi.test.js tests/storageBackupUi.test.js tests/allScreensEmptyState.test.js`
  — pass: 27/27, 0 fail.
- `node --test tests/i18nCopyAudit.test.js` — pass: EN/TH/ZH key parity holds at
  717 keys each with no empty values and no wrong-script fallback.
- `npm test` (full IDEA1 suite) — pass: 837 tests, 770 pass, **0 fail**, 67
  skipped, 105 s. The 67 skips are the Postgres-backed suites, gated on
  `TEST_DATABASE_URL` which is not set in this environment; the same 67 skip on
  `origin/main` and none of them touch the Storage screen.
- Browser verification against the real Vite/Tailwind pipeline at 1440, 1280,
  1100, 760 and 390 px, in light and dark, in EN and TH, across four data
  fixtures (multi-category with a 4 MB sub-visible category; all-categories-zero;
  98.6%-full volume; unreadable capacity). Hover, keyboard `focus-visible` (accent
  outline, `outlineColor` measured as `rgb(37, 99, 235)`) and click-to-pin
  (`aria-pressed` toggling, centre readout persisting after blur) all confirmed
  in-page. The temporary preview harness was deleted before staging.

## Canonical notes updated

- `None` — the durable IDEA1 facts (what `/api/storage` measures, which sources
  are unavailable and why) are unchanged by this task. This was a presentation
  change over the already-recorded data phase from PR #65.

## Shared surfaces touched

- `None` — every changed path is inside `IDEA1-AEGIS_Drive_LC/`.

## Integration requests

- None — no cross-scope or shared path changed.

## Known limitations

- The ring's minimum-arc rule borrows sweep from the truthfully-drawn segments
  (in practice free space) so the ring still closes at exactly 360°. This is a
  documented, disclosed rendering floor; the arcs of floored categories are
  therefore not proportional, which is why they are drawn as a distinct thin tick
  and why the legend carries the exact figures.
- `capacityBytes` from `filesystemCapacity()` guarantees
  `categories + unaccounted + free === total`. If a future source made those sum
  to more than `total`, `ringLayout()` scales the drawn arcs down to fit rather
  than overflowing the ring; the legend would still report exact bytes. This path
  is defensive and is not exercised by any current fixture.
- Verified against fixtures in a browser, not against a live host with a real
  Data Lake mount. No deployment, container, gateway or database claim is made.
- The Postgres-backed tests did not run here (`TEST_DATABASE_URL` unset). They
  are unrelated to this change, but this run therefore does not re-prove them.
- Three pre-existing discrepancies on this screen were found and **reported as
  suggestions only, not fixed**, because they sit outside this task's scope:
  1. `Storage.jsx` reads backup job history from `/api/backup`, which is
     `requireRole(ROLES.ADMIN)`. A non-admin receives 403, `history` falls back
     to `[]`, and the jobs table then renders "No automatic backup schedule has
     been configured" plus a "Set up now" button — asserting a negative fact the
     app was denied the data to know, and offering an action the viewer cannot
     perform. The same wrong message appears while `/api/backup` is loading or
     has failed. This is the fabricated-state class this screen exists to avoid.
  2. The Backup Jobs card's header chip shows `state`, where `READY` carries the
     `ok` (green) tone, while `risk` is shown lower down as a separate chip.
     `server/backup/derive.js` can legitimately produce `state: READY` together
     with `risk: CRITICAL` (a valid, reachable target that has never completed a
     successful backup). The most prominent badge on the card then reads green
     while protection is critical.
  3. The RAID card is labelled `t('notConnected')` ("Not connected") while its
     body correctly says no array is configured. RAID is not a thing that
     connects; `t('notConfigured')` already exists and is the accurate label.
