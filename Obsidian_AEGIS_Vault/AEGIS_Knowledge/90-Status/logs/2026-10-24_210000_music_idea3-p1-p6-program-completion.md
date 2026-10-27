---
title: Task Receipt — IDEA3 program completion P1-P6 (device presence, Desktop pages, translations, RESTORE record expiry)
date: 2026-10-24T21:00:00+07:00
owner: music
area: idea3
branch: feat/idea3-graduated-response
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 program completion P1-P6

## What changed

- **P1 (F-A2-1):** a lost device is reported as `device=OFFLINE`, `uplink=UNKNOWN` after `DEVICE_OFFLINE_SEC` (45 s) without an authenticated device message; the next authenticated status restores both. Nothing is sent to the device. While OFFLINE a RESTORE is refused with `UPLINK_NOT_LOCKDOWN` (by design).
- **P2:** the Desktop evidence STALE threshold is 60 s (`tools/live_purple_observer.DESKTOP_MAX_AGE_SECONDS`, equal to the dead-man window). `observer.DEFAULT_MAX_AGE_SECONDS` (120 s) is unchanged because the status sidecar and push client use it for a different purpose.
- **P3:** the Desktop Recovery page is a read-only readiness checklist (Core-written `recovery-status.json`, graduated status, last RESTORE attempts from the audit records), th/en/zh, with one navigation-only button to the Lockdown page. No second RESTORE control.
- **P4:** the Incidents and Audit pages show read-only data (graduated decisions; CUT/RESTORE audit records, machine fields only) or `NOT_AVAILABLE — <reason>`.
- **P5:** the CUT/RESTORE dialogs, captions, buttons and result lines are translated (th/en/zh) at display time only; internal English identifiers and codes are unchanged.
- **P6:** an ACKed RESTORE that was never physically confirmed stops blocking a new RESTORE `PHYSICAL_CONFIRM_TIMEOUT_SEC` (8 s) after the ACK; the refusal before that names the remaining seconds.

## Source files changed

- Core: `aegis_soc/supervisor.py` (device presence, recovery view writer), `aegis_soc/local_restore.py` (`_restore_wait_remaining`, `lockout_remaining`), new `aegis_soc/recovery_view.py`.
- Desktop: `tools/live_purple_control_desktop.py`, `tools/live_purple_observer.py`, `tools/live_purple_cut_desktop.py`, `tools/live_purple_incident_desktop.py`, new `tools/live_purple_core_records.py`, new `tools/live_purple_control_strings.py`, `deploy/live-lab/run-control-desktop.sh` (audit database path).
- Tests: `tests/test_runtime.py`, `tests/test_local_restore.py`, `tests/test_core_break_glass.py`, `tests/test_live_purple_control_desktop.py`, new `tests/test_live_purple_core_records.py`, new `tests/test_live_purple_control_strings.py`.
- Docs: `doc/Content/16_GRADUATED_RESPONSE.md`, `19_FAILURE_MODE_TESTS.md`, `21_TEST_EVIDENCE_MATRIX.md`.

## Verification evidence

- Offline tests only; see the commit messages and the unattended summary for the numbers. `recovery_core.py`, `production_detector.py` and every sha-pinned file are untouched; no pin was changed.
- Not run on the hardware: the Core must be restarted on this code first.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — short state entry.

## Shared surfaces touched

- None — task stayed inside its selected area.

## Integration requests

- None.

## Known limitations

- Hardware verification of P1-P6 is pending (steps are in the end-of-batch report).
- Thai and Chinese wording needs a native review.
- The Audit and Recovery attempt rows need `AEGIS_DESKTOP_AUDIT_DB` to point at a database the Desktop user can read; otherwise they say `NOT_AVAILABLE` with the reason.
