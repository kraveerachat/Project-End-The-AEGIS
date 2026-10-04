---
title: Task Receipt — IDEA3 Real Detector Acceptance / R1 repository evidence package
date: 2026-10-05T10:00:00+07:00
owner: music
area: idea3
branch: feat/idea3-r1-real-detector-acceptance
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 Real Detector Acceptance / R1 repository evidence package

> [!important] Repository work only. R1 repository implementation != live acceptance. No sudo, no Production mutation, no detector/Core start/stop/restart, no alert injection, no `alert.sock` write, no ESP32/device action, no authorization/K3, no stage registered, no owner runner.

## Authoritative result fields

```text
F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN
R1_VERIFIED=NOT_CLAIMED
RECOVERY_R1_R8_PROVEN=NO
RECOVERY_R2_R8_EXECUTED=NO
LVR_PROVEN=NO
L8_ACCEPTANCE=NO
L9_PROVEN=NO
R1_EVIDENCE_VERIFIER_IMPLEMENTED=YES
R1_OWNER_RUNNER_TEMPLATE=NOT_CREATED
STAGE_ID_OWNER_APPROVED=NO
STAGE_MUTATION_CLASS_OWNER_APPROVED=NO
PRODUCTION_DETECTOR_DIFF_FROM_MAIN=EMPTY
PRODUCTION_MUTATION_PERFORMED=NO
CORE_RESTARTED=NO
DETECTOR_RESTARTED=NO
ESP32_TOUCHED=NO
```

## What changed

- `aegis_soc/recovery_core.py`: `AlertIngress` durably writes `ALERT_ACCEPTED uid pid attacker_ip action` (SO_PEERCRED values) per alert that reached binding. Best-effort; never changes the response. Only the Core needs this deployed.
- `aegis_soc/r1_acceptance.py` (new): read-only baseline/final capture and fail-closed evidence verifier; reuses `recovery_evidence` (`_open_ro`, `_AuditStore`, `_r1`) unmodified. It cannot emit a positive acceptance claim.
- `production_detector.py` is unchanged (byte-identical to main); the deployed digest pin stays valid.
- Tests: `tests/test_r1_acceptance.py`, two cases in `tests/test_core_alert_ingress.py`.

## Provenance

- **Delivery:** Core-recorded peer pid == detector baseline MainPID == journald `_PID` of the detector's `alert result=SENT_BOUND` line; a direct socket write from another process fails.
- **Source event:** the detector matches message text, so forged journal text could trigger a real alert. The verifier reconstructs the detector rule (imported thresholds/regexes) from journald-trusted metadata and fails closed on any rule-matching line from another source. Raw journal text is never persisted (only address, port and trusted metadata of rule-relevant lines).
- **Residual:** root, or code inside the detector/sshd, can still forge. Not claimed otherwise.
- **Claims:** verifier output is `R1_EVIDENCE_VERIFIED` / `REAL_DETECTOR_CHAIN_VERIFIED` only; acceptance stays NOT_PROVEN. No mode flag exists.

## Owner decisions required (no silent choice)

Stage id (`R1A` is only a proposal); whether governance classifies the stage as mutating because the real event makes the Production Core durably create an OPEN incident, `INCIDENT_BOUND` and `ALERT_ACCEPTED`; one-attempt boundary; failure/no-retry behaviour; rollback policy (a real incident must NOT be deleted or undone to restore PRE state); predecessor F1 closeout receipt gate. Deploying the Core change is its own governed step.

## Verification evidence

- `python -m pytest tests/test_r1_acceptance.py tests/test_core_alert_ingress.py tests/test_f1_alert_sink.py tests/test_f1_detector_journal_source_repair.py tests/test_recovery_evidence.py tests/test_core_recovery.py tests/test_core_restore_policy.py -q` — pass: 520 passed (final head).
- `python -m pytest tests/test_pr11_phase4_f1r_stage.py tests/test_pr11_phase4_f1_governed_stage.py -q` — 298 passed, 2 failed; the digest-pin test `test_the_repo_detector_digest_gate_ties_the_pin_to_the_reviewed_source` passes. The 2 failures (`test_the_shell_detector_gate_also_detects_a_standalone_process_while_the_unit_is_not_found`, `test_the_detector_absent_gate_refuses_a_present_or_loaded_unit_via_stubbed_systemctl`) fail identically on a pristine detached `origin/main` (0e7797bc) on this host: PRE_EXISTING_ENVIRONMENT_DEPENDENT (F1 LIVE installed the detector unit). Not modified, not counted as a regression.
- `ruff check` on changed Python/test files — pass.
- `git diff origin/main -- IDEA3-AEGIS_Lockdown/aegis_soc/production_detector.py` — pass: empty.
- `node scripts/validate-vault.mjs` — pass (two pre-existing owner-data Canvas warnings).
- `node scripts/validate-collaboration-policy.mjs` with the main-to-head changed-file set — pass.
- `git diff --check` — pass.

## Source files changed

See the PR file list; notes: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` and this receipt.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md`

## Shared surfaces touched

None outside IDEA3 and its status note.

## Integration requests

None.

## Known limitations

Nothing live was observed. The environment-dependent F1/F1r detector-absence tests may fail on this host because F1 LIVE installed the detector unit.
