---
title: Task Receipt — IDEA3 Real Detector Acceptance / R1 repository evidence package
date: 2026-10-05T00:54:44+07:00
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

- `aegis_soc/recovery_core.py`: `AlertIngress` durably writes `ALERT_ACCEPTED uid pid attacker_ip action` (SO_PEERCRED values) per alert that reached binding. Best-effort; never changes the response. Only the Core needs this deployed (a NEW release; see below).
- `aegis_soc/r1_acceptance.py` (new): read-only baseline/final capture and fail-closed evidence verifier; reuses `recovery_evidence` (`_AuditStore`, `_r1`) unmodified while using its own in-memory WAL-aware audit view. It cannot emit a positive acceptance claim.
- `production_detector.py` is unchanged (byte-identical to main); the deployed digest pin stays valid.
- Tests: `tests/test_r1_acceptance.py`, two cases in `tests/test_core_alert_ingress.py`.

## Provenance

- **Delivery:** Core-recorded peer pid == detector baseline MainPID == journald `_PID` of the detector's `alert result=SENT_BOUND` line; a direct socket write from another process fails.
- **Source event:** the detector matches message text, so forged journal text could trigger a real alert. The verifier reconstructs the detector rule (imported thresholds/regexes) from journald-trusted metadata using the detector's EXACT windows (no skew widening) and strict causality: only trusted events at or before the detector's alert line count, and the alert must follow completion within 10 s. Any rule-matching line from another source fails closed. Raw journal text is never persisted.
- **Evidence boundary:** the audit store is opened `mode=ro` and copied by the SQLite online backup into an in-memory database; no raw audit copy exists on disk, there is no `--snapshot` option, and only sanitized derived evidence is written (never overwriting).
- **Residual:** root, or code inside the detector/sshd, can still forge. Not claimed otherwise.
- **Claims:** verifier output is `R1_EVIDENCE_VERIFIED` / `REAL_DETECTOR_CHAIN_VERIFIED` only; acceptance stays NOT_PROVEN. No mode flag exists.

## Running Core release truth

At the merged F1r/F1 evidence boundary, `/opt/aegis-idea3/current` points to `c2238375de14678f2a67c039282d9aeff6d553e5`, while the already-running Core remained on the pre-switch OLD release `55c7d18135142293267e8d1ea943d3639358d634` because no Core restart occurred (F1r and F1 did not restart it). Neither the deployed running Core nor the existing c223 release contains PR #342's `ALERT_ACCEPTED` change; restarting the existing c223 release is NOT sufficient.

Future prerequisite chain (a successor governed Core-deployment task/stage decision is still required): merge PR #342; build a NEW immutable release from a commit containing it; governed install and activation of that new release; one separately authorized Core restart; preserve the already-running detector; verify alert and recovery surfaces after restart. L8p, the F1i LIVE attempt, the F1r LIVE attempt and F1 attempt #2 are consumed and MUST NOT be rerun or replayed. Detector source is unchanged, so PR #342 alone requires no detector restart.

## Owner decisions required (no silent choice)

Stage id (`R1A` is only a proposal); whether governance classifies the stage as mutating because the real event makes the Production Core durably create an OPEN incident, `INCIDENT_BOUND` and `ALERT_ACCEPTED`; one-attempt boundary; failure/no-retry behaviour; rollback policy (a real incident must NOT be deleted or undone to restore PRE state); predecessor F1 closeout receipt gate. Deploying a new Core release containing this change is its own successor governed step.

## Main reconciliation

- Original implementation base: `0e7797bc3860b7ad8d85b8a57858e05e2123b220`.
- Final reconciled main: `c010995afddb7e52ce06cd20db3cbdd67bac60fc`, by a normal merge of `origin/main` (owner-authorized). No rebase, no squash, no force push; the local fix commit `ccaaabd3` remains in ancestry.
- The new main changes are IDEA1/IDEA2 only and have no overlap with the PR #342 IDEA3 files. No LIVE claim changed.

## Verification evidence

- `python -m pytest tests/test_r1_acceptance.py tests/test_core_alert_ingress.py tests/test_f1_alert_sink.py tests/test_f1_detector_journal_source_repair.py tests/test_recovery_evidence.py tests/test_core_recovery.py tests/test_core_restore_policy.py -q` — pass: 529 passed (post-merge final head).
- `python -m pytest tests/test_pr11_phase4_f1r_stage.py tests/test_pr11_phase4_f1_governed_stage.py -q` — 298 passed, 2 failed; the digest-pin test `test_the_repo_detector_digest_gate_ties_the_pin_to_the_reviewed_source` passes. The 2 failures (`test_the_shell_detector_gate_also_detects_a_standalone_process_while_the_unit_is_not_found`, `test_the_detector_absent_gate_refuses_a_present_or_loaded_unit_via_stubbed_systemctl`) fail identically on pristine detached `origin/main` on this host (re-run on current origin/main c010995a): PRE_EXISTING_ENVIRONMENT_DEPENDENT (F1 LIVE installed the detector unit). Historical tests not modified.
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
