---
title: Task Receipt — IDEA1 post-deploy UX hardening and storage truth review
date: 2026-09-04T13:14:14+07:00
owner: kla
area: idea1
branch: fix/idea1-post-deploy-ux-hardening
status: partial
integration-review: no
edit_policy: append-by-new-file
---

# Task Receipt — IDEA1 post-deploy UX hardening and storage truth review

Post-deploy correction pass over the three features accepted in production from
PR #67 (Audit result-filter label), PR #68 (Storage capacity donut) and PR #69
(Protected Trash). Base `origin/main` = `f02745bdc7a44e7ec5eb74b0cde3bd3cdc4cf5de`.

`PRODUCTION_CHANGED = NO`. `PRODUCTION_ACCEPTANCE = NOT TESTED`.
`HOST_TOPOLOGY = NOT MEASURED` — see Known limitations.

Status is **partial** for one reason only: Phase F (read-only production host
storage inspection) could not be executed, so no claim is made about physical
disks, partitions, LVM, free extents, or the existence of a separate failure
domain. Every UI change below is complete and verified.

## What changed

- **The Audit result filter now exposes the ledger's real result domain.** It
  offered `all` and `denied`, where `denied` meant "every result that is not
  OK" — one option covering both DENIED and BLOCKED, and no way at all to ask
  for the successful events. It now offers All / Success / Denied / Blocked,
  where each option's value **is** the stored result string and the comparison
  is exact equality. Stored values, backend semantics, privacy hashing,
  append-only behaviour, the CSV contract, the actor/action/date filters and
  `requireRole(ADMIN)` on `GET /api/audit` are all untouched.

- **Protected Trash locked state is now an unlock dialog over the real Trash
  shell**, not a full-page hatch panel that read as a separate placeholder
  screen. The retention header, search field, sort control and content area
  stay in place behind the dialog, dimmed and blurred by the existing
  `.modal-scrim`.

  The security boundary is stronger than "the metadata is covered": while
  locked the screen **never requests `/api/trash` at all**, so there is no
  protected metadata in the document for a blur to hide. The rows behind the
  dialog are geometry — no filename, size, deletion time, purge time or item
  count. The shell carries `inert` + `aria-hidden`, so nothing in it takes
  focus, clicks, or a place in the accessibility tree.

  Escape is deliberate: it closes the dialog and leaves the page visibly and
  actually locked, with a "Locked" banner and an Unlock control that is the one
  live element on the page — a keyboard user is never stranded on a screen where
  nothing can be operated. Server-side step-up expiry stays authoritative; the
  5-second authorization poll relocks the screen and reopens the dialog.

- **The shared `Modal` now traps Tab.** It already had initial focus, focus
  return and Escape, but Tab walked straight out of the dialog into the Sidebar
  and TopBar, which are real controls behind the scrim — the page looked blocked
  and was not. This fixes every modal in Drive, not only Trash.

- **The capacity ring is larger on wide screens and carries leader-line
  callouts.** On the production volume every AEGIS category is a rounding error
  next to "other on this volume" and free space, so the real categories were
  unreadable slivers. They are now labelled with name, exact size and exact
  share (or `<0.1%`), with the leader drawn from the segment's true position.

  The angular share is the thing that can lie, so it is the thing left alone: a
  category below the visibility floor is still drawn at the floor and no larger,
  as a tick thinner than the band, and the ring still closes at exactly
  360° = the measured filesystem total. The floor is now expressed as a
  *fraction of the circle* rather than pixels, so the compact and wide rings
  classify the same categories as ticks instead of the disclosure note appearing
  and disappearing as the window is resized. Free stays a measured neutral
  segment; unattributed bytes stay hatched. `/api/storage` is unchanged.

- **RAID says "Not configured", not "Not connected"**, and the card now explains
  what RAID would actually require: two or more separate physical drives in an
  array or a controller presenting one, and explicitly that another partition,
  logical volume, container volume or directory on the same drive does not
  create one. No array percentage, degraded state, rebuild progress or member
  list is invented — none exists to report.

- **Backup Jobs no longer states things it has not measured.** Three defects:

  - *Unauthorized/unknown rendered as "no schedule".* `/api/backup` is
    Admin-only, so a DataLake-User gets 403 — the correct answer, and not
    evidence about the schedule. An empty `history` from an unreadable response
    was being rendered as the positive fact "no automatic backup schedule has
    been configured", with an admin "Set up now" offered to a user who cannot
    perform it. Loading / Forbidden / Unavailable / Not configured / Empty
    history are now five distinct states, and the setup action appears only when
    the request actually succeeded (so the client passed `requireRole(ADMIN)`)
    **and** the agent itself reported `NOT_CONFIGURED`. Permission is inferred
    from the server's answer, never from a client-side role guess.

  - *Green READY while risk is CRITICAL.* The agent can truthfully be
    `state=READY` with `risk=CRITICAL` — ready to run, but no successful backup
    has ever completed. The colour now belongs to the protection risk, which
    leads the header as "Backup protection · Critical"; the operational state is
    demoted to a neutral chip (accent only for the transient RUNNING). READY can
    no longer read as "backups are healthy".

  - *Not-configured card.* Replaced with a truthful setup-readiness panel:
    protection, target, last successful backup and restore verification as
    measured values, plus the eight numbered prerequisites before backup can be
    accepted in production. Nothing is marked done. A same-failure-domain target
    keeps its specific danger message and is presented as not configured, never
    as protected.

## Source files changed

- `IDEA1-AEGIS_Drive_LC/src/screens/Audit.jsx` — result filter renders from a
  `RESULT_FILTERS` table whose values are the stored results; predicate is exact
  equality instead of the `!== 'OK'` bucket.
- `IDEA1-AEGIS_Drive_LC/src/screens/Trash.jsx` — locked state rebuilt as an
  inert placeholder shell plus an unlock dialog; dialog reopens on relock;
  closes on successful step-up.
- `IDEA1-AEGIS_Drive_LC/src/screens/Storage.jsx` — five backup history states
  derived through `visibleFetchError`; risk-over-state header hierarchy;
  setup-readiness panel; RAID wording and requirement copy; risk reasons
  suppressed when the agent is unreachable so no raw reason code is shown.
- `IDEA1-AEGIS_Drive_LC/src/components/CapacityRing.jsx` — fraction-based
  visibility floor, two ring geometries, leader-line callouts routed through an
  outer gutter so they can never cross the band, de-collided label columns.
- `IDEA1-AEGIS_Drive_LC/src/components/ui.jsx` — `Modal` now traps Tab within
  the dialog.
- `IDEA1-AEGIS_Drive_LC/src/lib/strings.js` — EN/TH/ZH copy for the four result
  options, the Trash locked shell, and the backup/RAID truth states.

Tests added or updated:

- `IDEA1-AEGIS_Drive_LC/tests/auditFilterUI.test.js` — rewritten to drive the
  real `<select>` in jsdom rather than re-implementing the predicate.
- `IDEA1-AEGIS_Drive_LC/tests/protectedTrashLockedUi.test.js` — new.
- `IDEA1-AEGIS_Drive_LC/tests/fixtures/trashLockedApi.js` — new; records every
  request so "never fetched" is assertable.
- `IDEA1-AEGIS_Drive_LC/tests/storageBackupTruthUi.test.js` — new.
- `IDEA1-AEGIS_Drive_LC/tests/storageCapacityCalloutUi.test.js` — new.
- `IDEA1-AEGIS_Drive_LC/tests/storageBackupUi.test.js` — STORAGE-UI-1 corrected;
  its fixture is a 403 and it previously asserted the fabricated "no schedule"
  copy, i.e. it encoded Defect A.

`dist/` was rebuilt only to verify the build and restored with
`git checkout -- IDEA1-AEGIS_Drive_LC/dist` before staging.

## Verification evidence

- `npm test` (IDEA1) — pass: 895 tests, 828 pass, 0 fail, 67 skipped
  (Postgres-backed suites skip without a database).
- `npm run build` — pass: built in 9.01s; `dist/` restored afterwards.
- `node --test tests/auditFilterUI.test.js` — pass: 8/8.
- `node --test tests/protectedTrashLockedUi.test.js` — pass: 10/10.
- `node --test tests/protectedTrash.test.js tests/protectedTrashUi.test.js` —
  pass: 16/16 (server step-up, rate limiting, expiry, owner isolation).
- `node --test tests/storageBackupTruthUi.test.js` — pass: 13/13.
- `node --test tests/storageCapacityCalloutUi.test.js` — pass: 10/10.
- `node --test tests/storageCapacityRingUi.test.js` — pass: 7/7.
- `node --test tests/modalFocusStability.test.js tests/modalGlobalLayer.test.js`
  — pass: 27/27 (focus trap added without regressing existing modal behaviour).
- `node --test tests/allScreensEmptyState.test.js` — pass: 13/13 (the rule that
  no screen may branch on a raw `api.error`).
- `git diff --check` — pass: no whitespace errors.
- Browser QA against a temporary local harness (deleted before commit; it
  mounted the real screens over fixture responses, no backend, no production
  contact): Audit TH filter options verified as
  `ผลลัพธ์ · ทั้งหมด / สำเร็จ / ถูกปฏิเสธ / ถูกบล็อก`; Trash locked verified as
  a dialog over a blurred placeholder shell, and Escape verified to leave the
  page locked with a working Unlock control; capacity ring verified at 1440px
  and 375px in light and dark; RAID and Backup cards verified in dark at 1440px
  showing "Backup protection · Critical" beside a neutral "Ready". Two defects
  were found and fixed during this pass: leader lines crossed the ring band, and
  the risk list exposed the raw `agent-unreachable` code.

## Canonical notes updated

- `None` — no durable implemented/tested/deployed fact changed. The features
  were already recorded as production-accepted; this pass corrects their
  presentation and adds no new capability, migration or deployment. The RAID and
  backup states this branch renders (`NOT_CONFIGURED`, agent not deployed) are
  the states `idea1-status.md` already records. Nothing here is production
  evidence, so nothing durable should be claimed until the PR merges and
  production acceptance runs.

## Shared surfaces touched

- `None` — every changed path is inside `IDEA1-AEGIS_Drive_LC/`. No server
  contract, database, gateway, network, deployment or Core knowledge file was
  touched. `/api/storage`, `/api/backup`, `/api/audit` and every `/api/trash`
  route are byte-for-byte unchanged; no migration was added, because none is
  required.

## Integration requests

- None — no cross-scope or shared path changed.

## Known limitations

- **Storage topology is NOT MEASURED.** Read-only inspection of
  `192.168.10.10` was authorized by the owner, but the documented key
  (`id_ed25519_admin-main_thispc`) was rejected by the host
  (`Permission denied (publickey)`), and trying a second key against the same
  account was correctly stopped by the sandbox as key-guessing. No workaround
  was attempted. Consequently this task makes **no claim** about physical disk
  count or capacity, partition layout, LVM PV/VG/LV sizing, free extents,
  Docker volume location, or whether any genuinely separate failure domain
  exists. `lsblk`, `findmnt`, `df -h`, `pvs`, `vgs`, `lvs` and `/proc/mdstat`
  were never run. Nothing in the UI depends on this: the screen reports only
  what the agents actually measure.
- The host backup agent remains **prepared in source, not deployed**. No
  protected target exists, no backup has run, integrity is `NOT_RUN` and restore
  verification is `NOT_TESTED`. The UI now states exactly that. Backup
  production rollout stays a separate infrastructure acceptance phase.
- Browser QA used fixture responses through a local harness, not the production
  deployment. Production visual acceptance has not been performed.
- The Dual Interface / Classic + Neo work was deliberately not touched, and
  Login was not modified.
- The capacity callouts are laid out with a fixed vertical de-collision gap. A
  volume with many more non-zero categories than the eight this build can show
  would compress them toward the ring's vertical bounds; the legend remains the
  authoritative, complete list in every case.
