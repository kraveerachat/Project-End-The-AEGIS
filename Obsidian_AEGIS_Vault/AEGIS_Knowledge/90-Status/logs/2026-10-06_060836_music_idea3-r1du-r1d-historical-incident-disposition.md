---
title: Task Receipt — IDEA3 R1Du + R1D historical R1A incident disposition (repository)
date: 2026-10-06T06:08:36+07:00
owner: music
area: idea3
branch: feat/idea3-r1du-r1d-historical-incident-disposition
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 R1Du + R1D historical R1A incident disposition (repository)

## What changed

- Resolved, in the repository only, a governed pre-live blocker for R1B: the immutable failed R1A attempt left incident #1 `OPEN`, R1B's baseline refuses any open incident (`PREEXISTING_OPEN_INCIDENT`) and the Core returns `EXISTING` / `IGNORED_DIFFERENT_IP` while one is open, so R1B could not create a NEW incident with `CREATED` semantics. No reviewed path could close it (Recovery R8 needs R1-R7; the desktop wizard writes SQLite directly).
- Core authority `aegis_soc/historical_disposition.py` plus `database.dispose_historical_incident_atomic`: a dedicated Core-private, root-only (`SO_PEERCRED` uid 0), inert-by-default channel; the Core derives the target itself and confirms an `R1D_BINDING_V1` digest it reconstructs; ONE atomic transaction (one `INCIDENT_DISPOSED_HISTORICAL` audit row + `OPEN -> CLOSED`, rolled back together on any failure); one-shot unique index; the server is dead after one success and after any restart once the row exists. Not Recovery R8; `recovery_core.py`, `recovery_protocol.py`, `recovery_evidence.py`, `r1_acceptance.py` are byte-unchanged.
- R1Du (F1u-style Core upgrade carrying the authority; arms the channel with one exact core.env line, removed exactly by rollback) and R1D (frozen-runner, marker-bounded one-shot disposition with a read-only observer from an immutable snapshot) stages, registered in order `R1A -> R1Du -> R1D -> R1B`.
- R1B's predecessor gate additionally recognises the unique R1Du closeout and the new current release and REQUIRES the unique R1D LIVE PASS closeout (`R1D_LIVE=CLOSED_PASS`, `R1D_RESULT=PASS`, `PREEXISTING_OPEN_INCIDENT_COUNT=0`, `R1B_PRECONDITION_HISTORICAL_INCIDENT_CLEARED=YES`, `R1B_ATTEMPT_CONSUMED=NO`, ...); the zero-open-incident baseline, NEW-incident requirement, `CREATED` semantics, genuine event, source-IP/window binding and one-attempt/no-retry are unchanged.
- **Declared R1D mutation set (and nothing else):** one Core attempt row (`R1D_DISPOSITION_ATTEMPT_RECORDED`), one `INCIDENT_DISPOSED_HISTORICAL` audit row, the incident `OPEN -> CLOSED`, the audit hash-chain advance, and ONE persistent SQLite partial unique index `ux_audit_historical_disposition` (the database-level one-shot). The read-only observer requires exactly that set and the exact index definition.
- **One attempt at the Core boundary:** the Core records the attempt row when the first authorized peer connects and the channel is unavailable afterwards whatever the outcome; startup refuses when the attempt row, the disposition row or a visible governed marker exists.

## Result and boundary

- `R1DU_STAGE_ID=R1Du`
- `R1D_STAGE_ID=R1D`
- `R1D_ONE_ATTEMPT=YES`
- `R1D_NO_RETRY=YES`
- `R1A_RESULT=FAIL_IMMUTABLE`
- `R1A_ATTEMPT_CONSUMED=YES`
- `R1A_RERUN_ALLOWED=NO`
- `R1B_IS_R1A_RETRY=NO`
- `R1B_NEW_INCIDENT_CREATED_SEMANTICS_UNCHANGED=YES`
- `R1I_MUST_REMAIN_INSTALLED=YES`
- `RECOVERY_R2_R8_BLOCKED_UNTIL_R1B_PASS=YES`
- `R1DU_REPOSITORY_IMPLEMENTED=YES`
- `R1D_REPOSITORY_IMPLEMENTED=YES`
- `R1DU_LIVE_EXECUTED=NO`
- `R1D_LIVE_EXECUTED=NO`
- `R1D_ATTEMPT_CONSUMED=NO`
- `R1B_ATTEMPT_CONSUMED=NO`
- `F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN`
- `R1_VERIFIED=NOT_CLAIMED`
- `RECOVERY_R1_R8_PROVEN=NO`
- `RECOVERY_R2_R8_EXECUTED=NO`
- `PRODUCTION_MUTATION_PERFORMED=NO`
- `CORE_RESTARTED=NO`
- `INCIDENT_MUTATED=NO`
- `FULL_REGRESSION=INCOMPLETE_TIME_BUDGET`

## Verification evidence

- `/usr/bin/python3 -m pytest -q tests/r1d tests/r1b tests/test_historical_disposition.py` — pass; see the PR body for the final counts (review round 1 re-ran only the focused suites).
- `/usr/bin/python3 -m pytest -q tests/test_historical_disposition.py tests/test_core_recovery.py tests/test_core_alert_ingress.py tests/test_core_service.py tests/test_local_restore.py tests/test_pr11_phase4_r1du_stage.py` — pass: 728 passed.
- Negative controls — pass: 49 deliberate breakages (36 + 13 for the review corrections: one-attempt stop, attempt record, startup checks, unauthorized peer, unknown outcome, index set/definition, attempt-row check, baseline index, R1B's R1D requirement) (digest comparison, single-open, open-state, detector uid, recovery-evidence, peer uid, request keys, already-disposed, IP agreement, one-shot index, transaction rollback, server self-close, restart-dead, socket mode, supervisor flag and root-only uid; R1Du arming/unarming/already-armed/authority/socket/flag/suffix/journal/content; R1D history/receipt/marker/parent-barrier/ordering/socket-literal/binding-pin; R1B amendment fields/suffix) each failed a test and passed after restore.
- Full IDEA3 regression was started and terminated at the owner's instruction: `FULL_REGRESSION=INCOMPLETE_TIME_BUDGET` (about 81% complete, no completed result is claimed; earlier runs showed environment failures such as the missing `pip` module on `main`).
- `git diff --check`, bash -n, python compile and a secret scan of the added lines — pass. No Production command was run.

## Source files changed

- `IDEA3-AEGIS_Lockdown/aegis_soc/{historical_disposition,database,config,supervisor}.py`; `deploy/pr11-phase4/` R1Du and R1D stage files, `p4-lib.sh`, `p4-stage-gate.sh`, `p4-compare.sh`, `p4-r1b-run-lib.sh`, README section 19; tests and the design spec.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md`, `idea3-moc.md` and this receipt.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` and `idea3-moc.md` — R1Du/R1D repository implementation, not executed.

## Shared surfaces touched

- None outside the IDEA3/Music-owned boundary (shared Phase-4 scripts and pin tests are IDEA3-owned).

## Integration requests

- Independent review. Live execution needs separate owner decisions for R1Du, R1D and then R1B (fresh authority, frozen runners, Authorization/K3); none exists.

## Known limitations

- Repository proof only: nothing was built, deployed, restarted or run on a host.
- R1Du, like F1u, runs the reviewed upgrade tool as root from the pinned worktree (the immutable-snapshot model is applied to R1D, not R1Du), and it edits core.env by one exact line (owner decision recorded in the design).
- A past read-only R2/R6/R7 probe leaves no durable row and is not claimed absent; a privileged direct SQLite writer is detected by the hash chain and digest, not prevented.
- The full IDEA3 regression did not complete.
