---
title: Task Receipt — IDEA3 L8u governed read-only L8 live-acceptance successor (LVR PASS → L8u)
date: 2026-10-07T08:36:59+07:00
owner: music
area: idea3
branch: feat/idea3-l8-governed-live-successor
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 L8u governed read-only L8 live-acceptance successor (LVR PASS → L8u)

## What changed

- Defined what "L8 live acceptance" means after the closed L8p provisioning and implemented it as a NEW governed stage `L8u`, registered between `Recovery` and the historical `L8`: a passive, observation-only check through the Core of the already-provisioned production ESP32 (`L8U_CLAIM=LOGICAL_ACCEPTANCE_ONLY`; no electrical/physical proof, no L9). L8p is read-only history; it is never rerun, nothing reflashes, resets, provisions or publishes to the ESP32, no NTP rerun, no service control.
- Added the missing mechanical `LVR PASS → L8u` gate (`l8u_predecessors.py`, one implementation for the freeze tool and the runner): reads Git objects of the pinned main; requires exactly one canonical LVR PASS closeout whose `LVR_EXECUTION_MAIN` is a strict ancestor (closeout merge moves main) plus the canonical historical L8p closeout; refuses LVR missing / FAIL / duplicate / split / stale / repository-only, a wrong closeout-digest pin and an already-recorded L8/L8u result.
- Added the mechanically verifiable freeze (`l8u_runner_freeze.py` + `l8u_control_snapshot.py`, derived from the Recovery tools): frozen runner = reviewed template (the `EXPECTED_MAIN` Git object) + only 17 allowlisted pins; no runner can be frozen before LVR PASS; root-owned control snapshot; the runner never executes worktree code.
- Added the inert owner runner `run-l8u-owner.sh` + `p4-l8u-run-lib.sh` + the read-only observer `p4-l8u-observe.py` + stage handlers `stages/L8u/*` (empty allow-lists = zero Core-host drift): fresh same-day Authorization/K3 with exact key sets bound to main, the exact runner SHA-256, device MAC, firmware SHA-256 and LVR closeout SHA-256; one attempt total; durable marker; atomic PASS/FAIL closeouts; INT/TERM/HUP/EXIT handling; sudo keepalive stopped on every exit path; no rollback needed (no mutation).
- Wrote the integration contract for the LVR work stream (spec §2): LVR is an owner-runbook ceremony today and has no machine-readable closeout; the accepted receipt shape is defined in one place.
- L8u joins the stage gate's no-extra-field list (stage-mismatch and extra-field cross-stage replay refused in both directions).

## Inherited task receipts

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-10-07_034535_music_idea3-core-trusted-time-successor.md` — introduced by the stacked-on PR #375 (CTu) history; evidence for that branch only, unchanged here.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/l8u-acceptance/l8u_predecessors.py` — the LVR/L8p predecessor authority (new).
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/l8u-acceptance/l8u_runner_freeze.py` — mechanical freeze/verify tool (new).
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/l8u-acceptance/l8u_control_snapshot.py` — root-owned control snapshot tool (new).
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-l8u-owner.sh` — inert pin template / frozen runner source (new).
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l8u-run-lib.sh` — marker, closeouts, records, host gates (new).
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l8u-observe.py` — read-only passive observer (new).
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L8u/{apply,verify,rollback}.sh`, `allow-keys.txt`, `allow-listeners.txt` — observe-only handlers, empty allow-lists (new).
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-lib.sh` — register `L8u` between `Recovery` and `L8` (no gap, no auth extra).
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-stage-gate.sh` — `L8u` added to the no-extra-field list.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md` — §26 L8u.
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-10-07-idea3-pr11-phase4-l8u-governed-live-acceptance.md` — design + LVR integration contract (new).
- `IDEA3-AEGIS_Lockdown/tests/l8u/*` — 215 hermetic tests (new).
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_harness.py`, `tests/test_pr11_phase4_l7u_stage_governance.py`, `tests/test_recovery_stage.py`, `tests/r1bv/test_r1bv_contract.py`, `tests/r1b/test_r1b_live_failure_closeout.py`, `tests/r1i/test_r1i_input_instrumentation.py`, `tests/test_pr11_phase4_dnsmasq_unit_repair_reboot_and_scope.py`, `tests/test_pr11_phase4_f1u_stage.py`, `tests/test_pr11_phase4_r1du_stage.py`, `tests/test_r1_acceptance.py` — registry/handler-set/pin expectations re-pinned for the new stage (strings and the two shared-file hashes only).

## Verification evidence

- `pytest tests/l8u` — pass: 215 (predecessors 33, freeze 37, governance 65, observer 40, stage boundary 19, end-to-end runner flow 21 in a root-less sandbox incl. no-leftover-process assertion).
- Affected governance batch (L8/L8p/L8 boot-verify/firmware-readback/hardware-backend/L8p owner-runner/esptool-interpreter/attempt-2 reconciliation/pre-L8p NTP, L7u/F1/F1i/F1r/F1u/R1Du/R1I/R1Bv/Recovery/RRu/CTu/r1_acceptance/dnsmasq registries) — first run 2519 passed, 11 failed; after re-pinning the registry assertions: all stack-introduced failures fixed. `tests/test_pr11_phase4_harness.py r1a r1d r1dv rru recovery` — 1095 passed; the re-pinned registry set — 560 passed.
- Remaining failures are PRE-EXISTING at the stack base `74b32959` (verified by running the same tests on a clean export of that commit): `test_the_detector_absent_gate_refuses_a_present_or_loaded_unit_via_stubbed_systemctl` (F1), `test_the_shell_detector_gate_also_detects_a_standalone_process_while_the_unit_is_not_found` (F1r), `p4-compare.sh` byte-identity pin (dnsmasq), `test_r1b_is_registered_exactly_once_after_the_historical_r1a_and_before_l8` (R1B, stale order assertion), `test_stage_id_is_registered_between_l7u_and_l8_and_l7u_is_intact` (L8p). Not caused or touched by this task.
- Full IDEA3 pytest suite end-to-end was NOT run (it exceeds the available session/disk quota); the affected suites above were.
- `node scripts/validate-vault.mjs` — pass (the two existing Canvas owner-review warnings only); `node --test tests/collaborationPolicy.test.mjs tests/vaultMultiWriter.test.mjs tests/vaultStructure.test.mjs` — 59 passed.
- `git diff --check` — pass; `bash -n` on every new shell script and `py_compile` of every new Python file — pass.
- LIVE — not performed: no L8u/L8/L8p/Recovery/LVR run, no Production mutation, no service restart, no ESP32/serial/NTP/broker touch, no marker/Authorization/K3 created.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — L8u repository-only state, LVR→L8u gate, claim boundary and the LVR integration point.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-moc.md` — stacked L8u state line.

## Shared surfaces touched

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-lib.sh` — shared Phase-4 stage registry; integration review so Recovery → LVR → L8u → L8 sequencing stays exact.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-stage-gate.sh` — shared stage gate; L8u joins the no-extra-field list (cross-stage replay boundary).
- Phase-4 registry/pin expectation tests listed above — downstream governance contract re-pins for the new stage ordering and the two shared-file hashes.

## Integration requests

- Kla/integration reviewer: review the L8u insertion between `Recovery` and `L8` and the stage-gate rule change. Merge order is #375 → LVR work → this stack (it is STACKED on #375 head `74b32959` and must be rebased onto the reconciled main; #375's own CTu stage-gate fix at `p4-stage-gate.sh` is not duplicated here).
- LVR work stream owner: either emit the LVR closeout receipt defined in the L8u spec §2 or change `LVR_REQUIRED` / `LVR_CLOSEOUT_SUFFIX` in `l8u_predecessors.py` (the only place) together with the tests that pin them.
- Rollout: none (inert template). Rollback: revert this branch; no host, device or Production state exists.

## Known limitations

- Nothing ran live. The observer's real DB/status-path behaviour, `verify.sh` against a real Core and the real systemd/sudo behaviour of the runner are exercised only through hermetic fixtures and a root-less sandbox with stubs; production constants (`/var/lib/aegis-idea3*`, `/etc/systemd/system/...`, the root trust chain) are covered by static and unit tests, not an end-to-end live run.
- LVR has no machine-readable closeout in this repository; the L8u gate will refuse until the LVR work stream produces the contract receipt.
- L8u is LOGICAL acceptance only: `ELECTRICAL_RELAY_PROOF=NO`, `PHYSICAL_PROOF=NO`, `L9_PROVEN=NO`; the historical L8p bundle is checked by pinned bytes, not re-derived.
- A signal between the PASS closeout and the terminal flag can leave PASS and FAIL closeouts side by side; downstream consumers must treat that as NOT a pass (the PASS closeout is valid only alone).
- SIGKILL / host power loss leave the durable marker and no closeout by construction (uncatchable); the attempt stays consumed and is never rerun.
