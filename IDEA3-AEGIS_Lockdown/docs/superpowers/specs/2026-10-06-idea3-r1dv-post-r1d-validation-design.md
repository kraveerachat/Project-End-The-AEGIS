# IDEA3 R1Dv — read-only validation of the committed R1D disposition (design)

Status: repository design, 2026-10-06. Nothing here has run live. R1Dv is NOT an R1D retry.

## 1. Why this exists

R1D ran once (frozen runner SHA-256 `59645af9076940eaa8cce785a8d8c062cba9820af25ec7f173ee20061417807e`, original binding
`fcf69e5cab8ea27dbb1cb89ea0fed58c2cfeed60d36a688ac79b84e521367e66`). Two facts are true at the same time and must never be merged:

- **A. The disposition COMMITTED** (`R1D_CORE_DISPOSITION_CALL=ONCE`, `R1D_DISPOSITION=DISPOSED`, incident #1 `CLOSED`, one attempt row, one
  `INCIDENT_DISPOSED_HISTORICAL` row, no `RECOVERY_R8_CLOSE` row, the one-shot index present).
- **B. The governed stage FAILED immutably** (`R1D_RESULT=FAIL`, `R1D_FAILED_STAGE=final`): the final PRE/POST comparison reported
  `INCOMPARABLE EVIDENCE_UNAVAILABLE time.trustedclock.state` and `PRESERVATION_S10=FAIL`.

`R1D_RESULT=FAIL_IMMUTABLE`, `R1D_ATTEMPT_CONSUMED=YES`, `R1D_RERUN_ALLOWED=NO`, `R1D_DISPOSITION_COMMITTED=YES`. R1D is never rewritten to PASS.

## 2. Root cause (evidence unavailable; clock drift is NOT proven)

`p4-l0-capture.sh` runs `p4-l5-clock.py state` under the immutable verifier snapshot `PYTHONPATH`; that script imports
`aegis_soc.trusted_time`. The R1D snapshot closure was rooted only in `historical_disposition`, which does not import `trusted_time`, so the snapshot
lacked it and the capture recorded `UNAVAILABLE`. Repair: the snapshot closure is the union of every entry point (`ENTRIES = (historical_disposition,
trusted_time)`) and their transitive local imports. There is no mutable fallback, the comparator is not weakened and `UNAVAILABLE` is not allowlisted.

## 3. R1Dv

- Governed stage registered once: `... R1Du R1D R1Dv R1B L8 L9`; `p4_stage_mutates R1Dv` is false (read-only; no K3, one fresh Authorization).
- No marker, no socket, no `r1d_dispose_call.py`, no DISPOSE, no SQLite write, no restart, no `core.env` change, no Recovery.
- Observer `aegis_soc.historical_validation` (read-only SQLite URI `mode=ro`), fail closed. It checks: the R1D marker is present; exactly one attempt row;
  exactly one disposition row (after the attempt, same root peer, details bound to the incident); the disposition row carries the ORIGINAL R1D
  binding; incident #1 is the only historical incident and is `CLOSED` with the disposition summary; zero open incidents; zero `RECOVERY_R8_CLOSE` /
  `INCIDENT_CLOSED` rows; exactly the expected one-shot index definition; audit hash-chain integrity (existing `_chain_valid` semantics); a PRE→POST
  comparison proving no mutation (identical historical state, no new incident, no forbidden audit event appended).
- Honest limitation: the binding digest cannot be recomputed from the post-disposition state (the incident is no longer `OPEN`); the observer checks the
  original binding as pinned, requires the disposition row to carry it, and reports `R1DV_BINDING_RECOMPUTE=NOT_RECOMPUTABLE_FROM_CURRENT_STATE`.
- The runner takes PRE and POST captures, requires TrustedClock evidence AVAILABLE (not `UNAVAILABLE`/`NOT_RECORDED`) in both, compares with no allowed
  drift, then verifies the result document (claims stay unpromoted).
- Authority: root-owned exact-main authority, control + verifier snapshots with manifests, frozen runner with the strict 18-pin allowlist.

## 4. Future R1Dv LIVE PASS closeout (contract only; not created)

File `<ts>_music_idea3-r1dv-live-closeout.md`, whole-line fields: `R1DV_LIVE=CLOSED_PASS`, `R1DV_LIVE_EXECUTED=YES`, `R1DV_RESULT=PASS`,
`R1DV_IS_R1D_RETRY=NO`, `R1DV_READ_ONLY_VALIDATION_ONLY=YES`, `R1DV_R1D_SOCKET_CONNECTED=NO`, `R1DV_INCIDENT_MUTATED=NO`, `R1DV_DISPOSITION_CREATED=NO`,
`R1DV_R1D_ATTEMPT_AUDIT_COUNT=1`, `R1DV_R1D_DISPOSITION_AUDIT_COUNT=1`, `R1DV_RECOVERY_R8_CLOSE_COUNT=0`, `R1DV_HISTORICAL_INCIDENT_STATE=CLOSED`,
`PREEXISTING_OPEN_INCIDENT_COUNT=0`, `R1B_PRECONDITION_HISTORICAL_INCIDENT_CLEARED=YES`, `R1DV_ONE_SHOT_INDEX=PASS`, `R1DV_AUDIT_INTEGRITY=PASS`,
`R1DV_TRUSTEDCLOCK_EVIDENCE_AVAILABLE=YES`, `R1DV_PRESERVATION_S10=PASS`, `R1DV_COMPARE_RESULT=PASS`, `R1B_ATTEMPT_CONSUMED=NO`,
`F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN`, `R1_VERIFIED=NOT_CLAIMED`, `RECOVERY_R1_R8_PROVEN=NO`, `RECOVERY_R2_R8_EXECUTED=NO`.

## 5. R1B predecessor gate

Exactly one of: **Path A** — the unique legacy R1D LIVE PASS closeout (no R1D failure, no R1Dv receipt); **Path B** — the unique immutable R1D FAILURE
closeout (exact fields) plus the unique R1Dv LIVE PASS closeout. Everything else fails closed: failure alone, R1Dv alone, FAIL+FAIL, duplicates, PASS+FAIL
contradiction, any R1Dv mutation/socket/disposition/retry claim, missing S10/compare/audit-integrity evidence. R1B acceptance semantics are unchanged.
