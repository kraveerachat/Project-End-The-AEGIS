---
title: Task Receipt — IDEA3 L8p device provisioning stage on the canonical L8 hardware backend
date: 2026-10-02T02:32:47+07:00
owner: music
area: idea3
branch: feat/idea3-l8p-canonical-provisioning-stage
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 L8p device provisioning stage on the canonical L8 hardware backend

## What changed

- Repository-only. New stage **L8p** (`L7 -> L7u -> L8p -> Recovery R1-R8 -> LVR -> L8`) provisions the Protocol-v1 ESP32 before Recovery. **Nothing live: no hardware, serial port, broker, network or Production was touched; Core not restarted; L7u, Recovery, LVR and L8 not run.** `L8P_LIVE=NOT_AUTHORIZED`, `REAL_ESP32_TOUCHED=NO`, `ELECTRICAL_RELAY_PROOF=NO`.
- Owner decision **OD-L8P-01 (APPROVED)** is recorded in the L8 operational design: for L8p only `D4_LIVE_REQUIRED_BEFORE_L8P_FLASH=NO`; an owner-attested physical recovery procedure satisfies the pre-write recovery prerequisite. L8 is unchanged (`D4_ONLY`, `INTERIM_RECOVERY_PROCEDURE=NOT_APPROVED`, D4 live required).
- **One canonical flow, no second backend.** The earlier local L8p (`f626776c`, written before PR #247) was NOT ported; L8p reuses the merged L8 `HardwareDevice`, `SubprocessExecutor`, `validate_esptool_argv`, pinned esptool resolver, scratch handling, NVS and firmware readback, single terminal reset, signed BOOT STATUS verifier and the 12-field evidence. The canonical `p4-l8-device.py` gained only a small fail-closed `StageProfile` hook (mandatory recovery gate, optional pre-device and NVS gates, evidence prefix); the default profile is L8 with the D4 attestation, so L8 behaves as before (all 247 L8 tests unchanged). `p4-l8p-device.py` defines no class, starts no process and carries no esptool verb.
- L8p-specific governance kept: stage registration/order, gate field `physical_recovery_attestation`, `provisioning.pins` (firmware and partition-table SHA-256, geometry, NVS schema), alignment/overlap checks, exact NVS-CSV schema check, PRE-evidence gate, FIRST_WRITE rules, handlers, tests. Physical recovery attestation (strict key set; stage L8p; MAC, firmware and partition SHA bound; procedure must be manual/out-of-band, capable of power cycle, ROM/download mode, serial reflash and interrupted-write recovery, and independent of Production, MQTT, network, automatic rollback, legacy firmware, plaintext 1883 and remote recovery; acknowledges NOT D4 and no Recovery, LVR, L8 or relay claim).
- After the first write: no retry, reflash, rollback write or RESTORE; `rollback.sh` performs zero device action; any failure is `FAIL_SECURE_HOLD_AND_EVIDENCE`. Evidence is the canonical OD-L8-09 12-field bundle (no 13th field), named `l8p-<run_id>.json`.
- F1 (PR #282) is preserved: no `aegis_soc/` file, `recovery_core.py`, `supervisor.py`, `config.py` or F1 receipt was touched.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l8-device.py` — `StageProfile` hook, default L8 profile (D4), fail-closed hooks, evidence prefix.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l8p-device.py` — new: thin L8p governance (attestation, pins, NVS schema, profile).
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L8p/{apply,verify,rollback}.sh`, `allow-keys.txt`, `allow-listeners.txt` — new handlers (no device logic).
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-lib.sh`, `p4-stage-gate.sh` — minimal stage registration, gaps and the L8p-only authorization field with guards.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l8p_provisioning.py` — new: 96 tests (fixture backend and fake executor only).
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_harness.py`, `test_pr11_phase4_l7u_stage_governance.py` — stage lists and the L7u-then-L8p-then-L8 order assertion.
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-21-idea3-pr11-phase4-l8-operational-design.md` — OD-L8P-01 recorded.
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-10-02-idea3-pr11-phase4-l8p-device-provisioning-only.md` — new L8p spec.

## Verification evidence

- Negative controls (temporary source breakage, each restored byte-identical; each failed the targeted tests): attestation firmware SHA unchecked, MAC unbound, independence not enforced, stage not checked, evidence name not `l8p`, hooks failing open, recovery gate optional, L8 default D4 dropped, geometry pin unchecked.
- `pytest tests/test_pr11_phase4_l8p_provisioning.py` — pass: 96 passed. `pytest tests/test_pr11_phase4_l8_hardware_backend.py` — pass: 80 passed. `pytest tests/test_pr11_phase4_l8_boot_verify.py` — pass: 69 passed. `pytest tests/test_pr11_phase4_l8_firmware_readback.py` — pass: 21 passed. `pytest tests/test_pr11_phase4_l8_handler.py` — pass: 77 passed.
- `pytest tests/test_pr11_phase4_l7_*.py tests/test_pr11_phase4_l7u_*.py` — pass: 893 passed. `pytest tests/test_pr11_phase4_l9_handler.py` — pass: 154 passed. `pytest tests/test_pr11_phase4_harness.py` — pass: 235 passed. `pytest tests/test_core_alert_ingress.py` (F1) — pass: 60 passed.
- `pytest tests/test_pr11_phase4_*.py` — pass: 3535 passed, 2 skipped, 0 failed (1363 s); the docs/status/receipt edits that followed were re-checked by the 15 doc-reading Phase 4 modules (1245 passed).
- `bash -n` on the L8p handlers, `p4-lib.sh`, `p4-stage-gate.sh`; `python -m py_compile` on the changed Python; `ruff check` on the changed Python — pass, no new finding (one pre-existing UP035 in `p4-l8-device.py` and one in the harness test are untouched lines); `git diff --check`; `node scripts/validate-vault.mjs` (2 existing canvas warnings); collaboration policy validation (simulated Draft and Ready events); changed-content secret scan — pass, no hits.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — L8p section: `OD_L8P_01=APPROVED`, `L8P_REPOSITORY_IMPLEMENTED=YES`, `L8P_LOCAL_VERIFIED=YES`, `L8P_LIVE=NOT_AUTHORIZED`, `RECOVERY_LIVE=NOT_RUN`, `LVR=NOT_RUN`, `L8_LIVE=NOT_RUN`, `ELECTRICAL_RELAY_PROOF=NO`; the L8 hardware backend stays `IMPLEMENTED_REPOSITORY / MERGED`.

## Shared surfaces touched

- `None` — task stayed inside IDEA3 (`IDEA3-AEGIS_Lockdown/` and the owner-writable IDEA3 status note plus this receipt). The Phase 4 harness files above are IDEA3-owned.

## Integration requests

- None — no cross-scope/shared path changed. Kla integration review of the Phase 4 harness edits is advisable but is not a cross-scope path.

## Known limitations

- Nothing was exercised against real hardware, a real serial port, a real broker or network; esptool output is asserted from documented behavior and fakes. Boot PASS stays AUTHENTICATED_FIRMWARE_REPORTED_LOCKDOWN, not electrical relay proof.
- Still required before any live L8p: the stage owner runner (not part of this change), reviewed firmware, partition table and pins, the written physical recovery procedure, a same-day authorization plus K3, and an explicit owner live authorization. Recovery R1-R8, LVR and L8 remain unproven.
- Local only: not pushed and no PR was opened.
