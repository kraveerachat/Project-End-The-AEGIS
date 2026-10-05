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

## Governed stage result — authoritative

```text
R1A_LIVE_EXECUTED=YES
R1A_ATTEMPT_CONSUMED=YES
R1A_RERUN_ALLOWED=NO
R1A_RESULT=FAIL
R1A_FAILED_STAGE=final
R1A_STAGE_VERIFY=NOT_REACHED
PRESERVATION_S10=FAIL
COMPARE_RESULT=FAIL
F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN
R1_VERIFIED=NOT_CLAIMED
RECOVERY_R1_R8_PROVEN=NO
RECOVERY_R2_R8_EXECUTED=NO
PRODUCTION_MUTATION_PERFORMED_BY_CLOSEOUT=NO
ESP32_TOUCHED_BY_R1A=NO
```

## Preserved evidence observations — non-governed

These are owner-run read-only observations from the preserved attempt evidence. They are **not** a governed R1A stage verdict, are not independently reproducible from committed public evidence, and do not promote any project claim. `R1_EVIDENCE_VERIFIED=YES` below is the `r1_acceptance` FINAL verifier's own result key only; `r1a_hook_verify` was never reached.

```text
R1_ACCEPTANCE_VERIFIER_RESULT=PASS
REAL_DETECTOR_CHAIN_EVIDENCE=PASS
FORENSIC_CHAIN_BINDING=PASS
EXPECTED_SOURCE_IP_BOUND=PASS
SOURCE_EVENTS_IN_MARKER_WINDOW=PASS
DETECTOR_ALERT_IN_MARKER_WINDOW=PASS
AUDIT_CAUSAL_WINDOW=PASS
R1_EVIDENCE_VERIFIED=YES
```

## What changed

- The owner-authorized R1A LIVE attempt executed once under the frozen successor runner at authoritative main `b05dd9efa703198a880df4dd3913c7649b496460`. The canonical stage-global marker was created and the 180-second observation window opened only after the PRE capture and immutable R1 baseline completed.
- One genuine external TCP port-scan event was produced from the separately pinned external source after the marker-bounded window opened. The R1A handler itself generated no event.
- The read-only `r1_acceptance` FINAL verifier returned `result=PASS`, `reason=OK`, reconstructed the `port_scan` rule, and reported the real chain evidence: trusted source event, detector delivery to Core, validated detector UID/PID, one OPEN incident, `ALERT_ACCEPTED`, and `INCIDENT_BOUND`.
- An owner-run read-only post-attempt forensic readout (not a governed stage output and not reproducible from the committed public receipt alone) bound the preserved PASS result to the pinned source and the canonical marker window: expected source IP PASS, trusted source completion time(s) in-window PASS, detector alert in-window PASS, audit causal/window checks PASS, therefore `FORENSIC_CHAIN_BINDING=PASS`.
- The governed R1A stage nevertheless failed in `final` before `r1a_hook_verify` because the generic PRE→POST preservation comparator failed. Consequently `R1A_VERIFY=PASS` was never emitted and no acceptance claim is promoted from this attempt.

## Preservation failure

The comparator recorded exactly one new/worsened runtime drift plus one incomparable evidence key:

1. `listen.tcp.127.0.0.1:6463`: absent in PRE and present in POST. Read-only forensic inspection identified the listener as an unrelated owner desktop-application renderer launched after PRE and during the R1A observation window. It is unrelated to the AEGIS detector chain, but the R1A contract permits no such generic PRE→POST drift, so it remains a valid stage-level preservation failure.
2. `time.trustedclock.state`: `UNAVAILABLE -> UNAVAILABLE`, classified `INCOMPARABLE / EVIDENCE_UNAVAILABLE`. Read-only forensic reproduction showed the frozen control-snapshot `p4-l5-clock.py` cannot import `aegis_soc` in that flattened control-snapshot layout (`ModuleNotFoundError`). A separate read-only invocation with the verifier snapshot on `PYTHONPATH`, performed only after the failed attempt, returned `state=SYNCED reason=OK`; it does not prove TrustedClock state during the R1A window. The PRE capture was already `UNAVAILABLE`, so the comparator's zero-incomparable requirement was already impossible to satisfy for this attempt without changing the frozen contract.

Each of the two findings was independently fatal under the frozen comparator contract: PASS requires both zero new/worsened drift and zero incomparable findings. No post-hoc repair or allowlist changes that historical result.

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
- The preserved evidence supports that a genuine real detector chain occurred and the owner-run forensic readout bound it to the authorized source/window, but it does **not** convert the failed governed R1A stage into PASS. Because TrustedClock capture was unavailable during PRE and POST, the forensic timestamp binding does not independently prove clock synchronization during the window; it compares same-host timestamps and would be vulnerable to an unproven in-window clock step.
- `F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN` and `R1_VERIFIED=NOT_CLAIMED` remain unchanged because automatic verifier success cannot promote those claims and the governed stage did not reach its verify hook.
- Recovery R2–R8 remains blocked. Any future path forward requires a separately reviewed owner decision under a **new stage ID**. A post-attempt adjudication mechanism may inspect preserved evidence, but it may not alter `R1A_RESULT=FAIL`, may not satisfy or bypass any R1A receipt gate, and may not create `R1A_LIVE=CLOSED_PASS`. Any future claim promotion must come from that new stage's own reviewed LIVE closeout. R1A itself must never be replayed.
- R1I remains installed during this closeout. No removal/rollback is authorized by this receipt.

## Verification evidence

- `git diff --name-status b05dd9efa703198a880df4dd3913c7649b496460 e417f464b8ef62b778f419131a1aa482a5a80c09` — **PASS** by GitHub compare: the closeout branch was 3 commits ahead / 0 behind and changed exactly the receipt, IDEA3 status, and IDEA3 MOC.
- `node scripts/validate-collaboration-policy.mjs --event "$GITHUB_EVENT_PATH" --changed-files "$RUNNER_TEMP/aegis-changed-files.txt"` — **FAIL** on the initial PR #356 head `e417f464…`: the new receipt lacked the required `What changed`, `Verification evidence`, and `Canonical notes updated` sections. This follow-up commit adds those required sections; the CI rerun is expected to re-evaluate the repaired receipt.
- `node scripts/validate-collaboration-policy.mjs --event "$GITHUB_EVENT_PATH" --changed-files "$RUNNER_TEMP/aegis-changed-files.txt"` plus `node scripts/validate-vault.mjs` — **PASS** on repaired head `7aed730b…` in Collaboration guardrails run #1818; both policy validation and Obsidian ownership/link validation completed successfully. This final receipt amendment records that already-completed validation result.
- No repository-local Production command, live runner, service mutation, incident mutation, R1I mutation, or ESP32 action was executed for this documentation repair.

## Evidence boundary

- Complete raw Production evidence, authorization/K3 records, frozen runner, canonical marker/window, process identifiers, local paths, and the private source address remain in the owner's local archive and are not committed.
- This public receipt records only the minimum redacted facts necessary to explain the immutable result and the preserved claim boundary.
- The closeout is based on owner-provided LIVE output plus read-only post-failure forensic output. No Production mutation was performed while preparing this receipt.

## Source files changed

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-10-05_232827_music_idea3-r1a-live-failure-closeout.md` — this immutable redacted R1A LIVE failure closeout.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — records R1A as executed once, consumed, failed at preservation final, with real-chain evidence PASS but no claim promotion.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-moc.md` — updates the current checkpoint and keeps Recovery R2–R8 blocked.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — records the immutable consumed R1A FAIL result while preserving the separate PASS detector-chain evidence boundary.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-moc.md` — advances the current checkpoint to the consumed R1A failure and keeps Recovery R2–R8 blocked.

## Shared surfaces touched

None — documentation stays inside the IDEA3/Music-owned canonical knowledge boundary.

## Integration requests

- Independent reviewers: verify the distinction between (a) the PASS real-detector evidence / forensic window binding and (b) the FAIL governed R1A result caused by the preservation comparator.
- Reviewers must confirm that this closeout does not authorize a retry, does not promote `F1_REAL_DETECTOR_ACCEPTANCE` or `R1_VERIFIED`, does not start Recovery R2–R8, and does not authorize removing R1I.
- A separate task/PR is required for any code remediation or successor/adjudication-stage design.

## Known limitations

- `r1a_hook_verify` did not execute because `compare()` failed inside `r1a_hook_final`; therefore this receipt deliberately does not claim `R1A_VERIFY=PASS`.
- The unrelated desktop-application loopback listener was unrelated to the detector chain, but no post-hoc allowlist is applied; the recorded preservation failure stands.
- The TrustedClock import-path defect explains the `UNAVAILABLE` capture evidence, but the later `SYNCED/OK` probe occurred after the failed attempt and cannot prove the clock state during the window or retroactively change this consumed attempt.
- No raw Production evidence or secrets are committed.
