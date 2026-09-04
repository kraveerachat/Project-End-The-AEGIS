---
owner: kla
area: idea1
branch: feat/idea1-raid-telemetry-ui
status: partial
edit_policy: append-by-new-file
---

# IDEA1 RAID telemetry-ready UI

## What changed

- Replaced the plain RAID not-configured text block with a presentation-only hardware topology card that remains truthful while no host RAID telemetry exists.
- Added two primary physical-member slots for the planned USB RAID1 prototype, plus support for additional members.
- Added optional rendering for future validated RAID level, array device/state, usable capacity, mount point, member state/capacity/transport, measured read/write probe latency, I/O errors, temperature, and rebuild/resync progress.
- Kept array creation, formatting, USB discovery, serial exposure, and synthetic stability scores out of the browser UI.

## Source files changed

- `IDEA1-AEGIS_Drive_LC/src/components/RaidStatusCard.jsx` — new RAID standby/measured hardware surface.
- `IDEA1-AEGIS_Drive_LC/src/screens/Storage.jsx` — mounts the RAID card using `/api/storage.raid`.
- `IDEA1-AEGIS_Drive_LC/src/lib/strings.js` — EN/TH/ZH copy.
- `IDEA1-AEGIS_Drive_LC/tests/storageBackupUi.test.js` — standby and future measured-state regression fixtures.

## Verification evidence

- `node scripts/validate-collaboration-policy.mjs --event "$GITHUB_EVENT_PATH" --changed-files "$RUNNER_TEMP/aegis-changed-files.txt"` — **FAIL** on the first Pull Request run because the PR metadata block and immutable task receipt had not yet been added; this receipt and the follow-up PR-body update address that policy failure.
- Feature-focused `node --test tests/storageBackupUi.test.js` and `npm run build` have not been executed in this connector session and remain pending before merge.

## Canonical notes updated

- None in this UI-only task. Canonical production status remains unchanged until a real host RAID collector and accepted hardware evidence exist.

## Shared surfaces touched

None.

## Integration requests

None.

## Known limitations

- The production backend still returns `raid.status = NOT_CONFIGURED`; this task does not add a host collector.
- No `mdadm` command, formatting operation, automatic array creation, or USB discovery exists in this UI task.
- Optional latency/I/O/temperature fields render only when future validated telemetry supplies them; unavailable measurements remain explicitly unmeasured.
- Feature tests and a production build are still pending; the Pull Request remains draft until they are run.
