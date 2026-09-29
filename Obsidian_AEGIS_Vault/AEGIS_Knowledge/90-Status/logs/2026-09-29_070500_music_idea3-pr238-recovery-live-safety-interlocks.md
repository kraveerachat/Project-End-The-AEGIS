---
title: Task Receipt — IDEA3 PR238 Recovery live-safety interlocks
date: 2026-09-29T07:05:00+07:00
owner: music
area: idea3
branch: fix/idea3-pr238-recovery-live-safety-interlocks
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 PR238 Recovery live-safety interlocks

## What changed

- R5 is one-shot per incident: `RecoveryCoordinator.request_physical_restore()` returns the existing R5 evidence unchanged and never calls `controller.issue()` again once an attempt is spent. An attempt is spent when RESTORE was published, dry-run, or `issue()` raised (unknown outcome). A definitively unsent attempt (refused, MQTT unavailable) does not spend it. A new incident resets it.
- R3 is bound to the R1 incident: a target that differs from the incident's `attacker_ip`, or an incident without a valid `attacker_ip`, fails closed before any `ContainmentClient` call.
- The Recovery wizard registers its evidence observer last, so a wizard whose UI build fails is never left registered. Window-manager close already unregistered through `tk.Toplevel`'s default `WM_DELETE_WINDOW -> self.destroy` binding; lifecycle tests now lock that in.
- The GUI opens at most one Recovery wizard (`open_recovery_wizard` reuses a live one); the wizard's R5 button refuses a spent RESTORE before reaching the controller.
- Not changed: protocol format, firmware, RESTORE semantics, R6/R7 config, PR248, L7/L8, main-GUI Restore button. The Thai LVR6 phrase is not implemented in application code.

## Source files changed

- `IDEA3-AEGIS_Lockdown/aegis_soc/recovery.py` — one-shot R5 guard, R3 incident binding
- `IDEA3-AEGIS_Lockdown/aegis_soc/wizard.py` — register observer last, R5 spent-attempt guard
- `IDEA3-AEGIS_Lockdown/aegis_soc/gui.py` — single Recovery wizard instance
- `IDEA3-AEGIS_Lockdown/tests/test_recovery.py` — R5 one-shot and R3 binding tests
- `IDEA3-AEGIS_Lockdown/tests/test_recovery_wizard_lifecycle.py` — observer lifecycle and single-instance tests

## Verification evidence

- `pytest tests/test_recovery.py tests/test_recovery_wizard_lifecycle.py` before the change — fail: 14 new tests red on the frozen head, as intended
- `pytest tests/test_recovery.py tests/test_recovery_wizard_lifecycle.py tests/test_controller.py tests/test_mqtt_client.py tests/test_protocol_inbound.py tests/test_protocol_store.py tests/test_protocol_ordering.py tests/test_desktop_widget_lifecycle.py tests/test_detector_incident_recording.py tests/test_ip_containment.py` — pass: 319 passed
- `ruff check` on the five touched files — pass
- `git diff --check` — pass
- `node scripts/validate-vault.mjs` — pass: All checks passed
- `pytest tests` (full, two runs of ~13.7 min each) — NOT PASS: 3859 passed, 8 skipped, 1 failed each run, never the same test. Run 1: `test_pr11_phase4_l6a_handler.py::test_l6a_runtime_dns_san_loopback_verification` (subprocess returncode -15/SIGTERM; passes alone). Run 2: `test_pr11_phase4_l6c_capture_gap.py::test_real_end_to_end_capture_then_compare_requires_the_allow_file` (fails alone too; compares real host state and `/opt/aegis-idea3` exists on this workstation). Neither test touches the Recovery modules. The earlier exit 144 (128+16) was an external kill of the over-long run, not a pytest failure.

## Canonical notes updated

- `None` — repository safety guards only; no durable project fact changed. Nothing was run live.

## Shared surfaces touched

- `None` — task stayed inside its selected area

## Integration requests

- None — valid only when no cross-scope/shared path changed

## Known limitations

- Live Recovery, MQTT, nft, RESTORE, CUT and ESP32 were not touched; the guards are proven with fakes only.
- The main-GUI Restore button (PIN only, no R1-R4) is unchanged and remains an operator-controlled path.
- The one-shot guard is per coordinator/incident, in memory. A restarted GUI or a second process has no memory of an earlier RESTORE; the operator LVR6 contract still covers that.
- Wizard R4 still has no PIN attempt lockout; R5 still has no timeout.
