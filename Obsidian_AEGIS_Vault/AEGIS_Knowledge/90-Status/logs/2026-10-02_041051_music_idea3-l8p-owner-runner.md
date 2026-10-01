---
title: Task Receipt — IDEA3 L8p owner runner (inert repository template)
date: 2026-10-02T04:10:51+07:00
owner: music
area: idea3
branch: feat/idea3-l8p-owner-runner
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 L8p owner runner (inert repository template)

## What changed

- Repository-only. Added the missing owner runner for the merged L8p stage (PR #284): `run-l8p-owner.sh` and its gate library `p4-l8p-run-lib.sh`, following the L7u owner-run pattern. **Nothing live: no hardware, serial port, broker, network or Production was touched; Core not restarted; L7u, L8p, Recovery, LVR and L8 not run.** `L8P_LIVE=NOT_AUTHORIZED`, `REAL_ESP32_TOUCHED=NO`, `REAL_SERIAL_ACCESSED=NO`, `L7U_LIVE_FINAL=NOT_PROVEN`, `RECOVERY_LIVE=NOT_RUN`, `L8_LIVE=NOT_RUN`, `ELECTRICAL_RELAY_PROOF=NO`.
- **The committed runner is an inert template**: eighteen `PIN_` values (merged main SHA, frozen operator user and uid, reviewed firmware and partition-table SHA-256, owner input directory, reviewed artifacts, pinned flash tool, MQTT CA and broker credential files, broker address and TLS name, Wi-Fi SSID, NTP, build command) make it refuse. The live values are frozen later, after the FINAL source set is merged; the template is not pinned to the current SHA.
- **Operator identity (review fix):** the runner is bound to a frozen `OPERATOR_USER`/`OPERATOR_UID` through the reused L7u identity gate (current `id -un` and `id -u` must equal the pins and the pinned user must resolve to the same uid; root and malformed pins refuse). The gate runs before `sudo`, the evidence directory, the PRE capture, the attempt marker, any handler and any device access, and the owner input files must be owned by the frozen uid (`l8p_input_gate DIR [UID]`).
- Flow: read-only pre-gates (same-day `stage=L8p` authorization with `physical_recovery_attestation` and without the L8-only `recovery_authorization`; K3; pinned clean main; registered handlers; the reused `p4-stage-gate.sh --stage L8p --mode live` requiring `AUTHORIZATION_RECORD=VALID`, `K3_CONFIRMATION=VALID`, `ROLLBACK_HANDLER=REGISTERED`; the predecessor receipt chain read from the pinned commit **including a PROVEN final L7u**, which does not exist today, so a real run fails closed; Core, service, IDEA2 §10, disk and forwarding gates; the exact owner input directory; frozen artifact digests) -> PRE L0 capture and checksum -> consume one attempt (`L8p-ATTEMPT-CONSUMED`, atomic, never shared with L7u) -> `apply.sh` once -> `verify.sh` -> POST capture -> PRE/POST compare (empty L8p allow files) -> secret scan (generic and secret-value) -> narrow result.
- Failure: after consumption any failure calls the canonical `rollback.sh`, whose output must carry `L8P_DEVICE_ACTION_TAKEN=NONE` and, after the first write, `L8P_ROLLBACK=FAIL_SECURE_HOLD_AND_EVIDENCE`; then a mandatory RB capture and PRE->RB compare, then hold/escalate; hardware zero drift is not claimed after the first write. No retry, reflash, erase, CUT, RESTORE or plaintext 1883; physical recovery stays manual.
- Success claims only `L8P_LIVE_EXECUTED=YES` and `L8P_PROVISIONING=PASS`, retaining `RECOVERY_R1_R8_PROVEN=NO`, `LVR_PROVEN=NO`, `L8_ACCEPTANCE=NO`, `ELECTRICAL_RELAY_PROOF=NO`.
- The runner duplicates no device code: it never touches the flash tool, serial port or `HardwareDevice`; the hardware backend is requested in exactly one place, after the attempt is consumed. OD-L8P-01 is preserved unchanged.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-l8p-owner.sh` — new: inert owner-runner template.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l8p-run-lib.sh` — new: gate library (marker, receipt gate, input/artifact gates, rollback-output gate, secret-value scan).
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l8p_owner_runner.py` — new: 96 hermetic stub-only tests (79 original plus 17 identity tests).
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-10-02-idea3-pr11-phase4-l8p-device-provisioning-only.md` — owner-runner section added.
- No source, stage handler, stage-gate, `p4-lib.sh`, harness or F1 file was changed.

## Verification evidence

- `pytest tests/test_pr11_phase4_l8p_owner_runner.py` — pass: 96 passed (79 + 17 identity tests; after the review fix). `pytest tests/test_pr11_phase4_l8p_provisioning.py` — pass: 96 passed. `pytest tests/test_pr11_phase4_harness.py` — pass: 235 passed. `pytest tests/test_pr11_phase4_l7u_stage_governance.py` — pass: 84 passed.
- Negative controls (temporary breakage, each restored byte-identical): receipt gate removed, post compare removed, secret scan removed, rollback semantics unchecked, RB capture removed, attempt not consumed, marker name shared with L7u, L7u acceptance not required, backend/live flag changed — each failed the targeted tests. The redundant PRE re-check after the capture's own checksum survived (equivalent mutant).
- Owner-run and run-lib regression: `pytest tests/test_pr11_phase4_l7_runner.py` — pass: 124 passed; `tests/test_pr11_phase4_l7_runner_flow.py` — pass: 31 passed; `tests/test_pr11_phase4_l34_v7_owner_run_flow.py` — pass: 30 passed.
- `pytest tests/test_pr11_phase4_*.py` — pass: 3614 passed, 2 skipped, 0 failed (1339 s).
- `bash -n` on the runner and library; `python -m py_compile` and `ruff check` on the new test — pass; `git diff --check`; `node scripts/validate-vault.mjs` (2 existing canvas warnings); collaboration policy validation (simulated Draft and Ready events); changed-content secret scan — pass, no hits.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — L8p owner-runner section: `L8P_OWNER_RUNNER_REPOSITORY_IMPLEMENTED=YES`, `L8P_OWNER_RUNNER_LOCAL_VERIFIED=YES`, `L8P_LIVE=NOT_AUTHORIZED`, `L7U_LIVE_FINAL=NOT_PROVEN`, `RECOVERY_LIVE=NOT_RUN`, `L8_LIVE=NOT_RUN`.

## Shared surfaces touched

- `None` — task stayed inside IDEA3 (`IDEA3-AEGIS_Lockdown/` and the owner-writable IDEA3 status note plus this receipt).

## Integration requests

- None — no cross-scope/shared path changed.

## Known limitations

- PR state: Draft PR #286 exists, is unmerged and was not marked Ready; the branch was pushed normally (`FORCE_PUSH_USED=NO`). The review fixes (operator identity, status reconciliation) are in this same task; the full Phase 4 count below predates them and no shared Phase 4 implementation file changed since.

- Hermetic stand-ins only: the real `p4-l0-capture.sh`, `p4-compare.sh` and the real L8p handlers were not run end-to-end by this runner (they are covered by their own suites). The runner has never been executed against a host or device.
- A real run is impossible today by design: no FINAL L7u live acceptance receipt exists, the template is unpinned, and no authorization or K3 exists. Recovery R1-R8, LVR and L8 remain unproven.
