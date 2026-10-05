---
title: Task Receipt — IDEA3 R1A LIVE failure closeout
date: 2026-10-05T23:28:27+07:00
owner: music
area: idea3
branch: docs/idea3-r1a-live-failure-closeout
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 R1A LIVE failure closeout

> [!important] Documentation / adjudication only. This closeout records the already-consumed owner-run R1A LIVE attempt. It performs no new Production mutation, no retry, no cleanup of genuine evidence, no incident closure, no R1I removal, no service restart, and no ESP32 action.

## Authoritative result fields

```text
R1A_LIVE_EXECUTED=YES
R1A_ATTEMPT_CONSUMED=YES
R1A_RERUN_ALLOWED=NO
R1A_RESULT=FAIL
R1A_FAILED_STAGE=final
R1A_STAGE_VERIFY=NOT_REACHED
R1_ACCEPTANCE_VERIFIER_RESULT=PASS
REAL_DETECTOR_CHAIN_EVIDENCE=PASS
FORENSIC_CHAIN_BINDING=PASS
EXPECTED_SOURCE_IP_BOUND=PASS
SOURCE_EVENTS_IN_MARKER_WINDOW=PASS
DETECTOR_ALERT_IN_MARKER_WINDOW=PASS
AUDIT_CAUSAL_WINDOW=PASS
R1_EVIDENCE_VERIFIED=YES
F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN
R1_VERIFIED=NOT_CLAIMED
RECOVERY_R1_R8_PROVEN=NO
RECOVERY_R2_R8_EXECUTED=NO
PRESERVATION_S10=FAIL
COMPARE_RESULT=FAIL
PRODUCTION_MUTATION_PERFORMED_BY_CLOSEOUT=NO
ESP32_TOUCHED_BY_R1A=NO
```

## What happened

- The owner-authorized R1A LIVE attempt executed once under the frozen successor runner at authoritative main `b05dd9efa703198a880df4dd3913c7649b496460`. The canonical stage-global marker was created and the 180-second observation window opened only after the PRE capture and immutable R1 baseline completed.
- One genuine external TCP port-scan event was produced from the separately pinned external source after the marker-bounded window opened. The R1A handler itself generated no event.
- The read-only `r1_acceptance` FINAL verifier returned `result=PASS`, `reason=OK`, reconstructed the `port_scan` rule, and reported the real chain evidence: trusted source event, detector delivery to Core, validated detector UID/PID, one OPEN incident, `ALERT_ACCEPTED`, and `INCIDENT_BOUND`.
- Post-attempt forensic readout independently bound the preserved PASS result to the pinned source and the canonical marker window: expected source IP PASS, trusted source completion time(s) in-window PASS, detector alert in-window PASS, audit causal/window checks PASS, therefore `FORENSIC_CHAIN_BINDING=PASS`.
- The governed R1A stage nevertheless failed in `final` before `r1a_hook_verify` because the generic PRE→POST preservation comparator failed. Consequently `R1A_VERIFY=PASS` was never emitted and no acceptance claim is promoted from this attempt.

## Preservation failure

The comparator recorded exactly one new/worsened runtime drift plus one incomparable evidence key:

1. `listen.tcp.127.0.0.1:6463`: absent in PRE and present in POST. Read-only forensic inspection identified the listener as the owner's Discord renderer process, launched after PRE and during the R1A observation window. It is unrelated to the AEGIS detector chain, but the R1A contract permits no such generic PRE→POST drift, so it remains a valid stage-level preservation failure.
2. `time.trustedclock.state`: `UNAVAILABLE -> UNAVAILABLE`, classified `INCOMPARABLE / EVIDENCE_UNAVAILABLE`. Read-only forensic reproduction showed the frozen control-snapshot `p4-l5-clock.py` cannot import `aegis_soc` in that flattened control-snapshot layout (`ModuleNotFoundError`). A separate read-only invocation with the verifier snapshot on `PYTHONPATH` returned `state=SYNCED reason=OK`; therefore the captured `UNAVAILABLE` does not establish that the host clock was unsynchronized.

The observed comparator result remains authoritative:

```text
FINDINGS_NEW_OR_WORSENED_DRIFT=1
FINDINGS_INCOMPARABLE=1
FINDINGS_APPROVED_CHANGE=0
PRESERVATION_S10=FAIL
COMPARE_RESULT=FAIL
R1A_RESULT=FAIL
R1A_ATTEMPT_CONSUMED=YES
R1A_RERUN_ALLOWED=NO
```

## Governance decision / claim boundary

- The historical R1A result is immutable: FAIL, consumed, no retry. The canonical marker/window and genuine evidence must not be removed or rewritten.
- The preserved evidence proves a genuine real detector chain occurred and was forensically bound to the authorized source/window, but it does **not** convert the failed governed R1A stage into PASS.
- `F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN` and `R1_VERIFIED=NOT_CLAIMED` remain unchanged because automatic verifier success cannot promote those claims and the governed stage did not reach its verify hook.
- Recovery R2–R8 remains blocked. Any future path forward requires a separately reviewed owner decision: either a narrowly defined post-attempt adjudication contract that can consume preserved evidence without rerunning R1A, or a new successor governed stage ID. R1A itself must never be replayed.
- R1I remains installed during this closeout. No removal/rollback is authorized by this receipt.

## Evidence boundary

- Complete raw Production evidence, authorization/K3 records, frozen runner, canonical marker/window, process identifiers, local paths, and the private source address remain in the owner's local archive and are not committed.
- This public receipt records only the minimum redacted facts necessary to explain the immutable result and the preserved claim boundary.
- The closeout is based on owner-provided LIVE output plus read-only post-failure forensic output. No Production mutation was performed while preparing this receipt.

## Source files changed

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-10-05_232827_music_idea3-r1a-live-failure-closeout.md` — this immutable redacted R1A LIVE failure closeout.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — records R1A as executed once, consumed, failed at preservation final, with real-chain evidence PASS but no claim promotion.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-moc.md` — updates the current checkpoint and keeps Recovery R2–R8 blocked.

## Shared surfaces touched

None — documentation stays inside the IDEA3/Music-owned canonical knowledge boundary.

## Integration requests

- Independent reviewers: verify the distinction between (a) the PASS real-detector evidence / forensic window binding and (b) the FAIL governed R1A result caused by the preservation comparator.
- Reviewers must confirm that this closeout does not authorize a retry, does not promote `F1_REAL_DETECTOR_ACCEPTANCE` or `R1_VERIFIED`, does not start Recovery R2–R8, and does not authorize removing R1I.
- A separate task/PR is required for any code remediation or successor/adjudication-stage design.

## Known limitations

- `r1a_hook_verify` did not execute because `compare()` failed inside `r1a_hook_final`; therefore this receipt deliberately does not claim `R1A_VERIFY=PASS`.
- The Discord listener was unrelated to the detector chain, but no post-hoc allowlist is applied; the recorded preservation failure stands.
- The TrustedClock import-path defect explains the `UNAVAILABLE` capture evidence, but repairing it later cannot retroactively change this consumed attempt.
- No raw Production evidence or secrets are committed.
