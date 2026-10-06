---
title: Task Receipt — IDEA3 Recovery R2-R8 repository implementation
date: 2026-10-06T18:00:00+07:00
owner: music
area: idea3
branch: feat/idea3-recovery-r2-r8-stage
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 Recovery R2-R8 repository implementation

## What changed

- Implemented exactly one governed mutating Recovery Phase-4 stage after R1Bv and before L8 (no `L10`), then remediated the independent security/integration review (3 CRITICAL, 7 IMPORTANT, 3 MINOR) in place on this Draft PR.
- **C1** the D4 command now receives a bounded non-secret owner `--reason` that is validated by the production RESTORE-reason validator BEFORE the marker (an empty or invalid reason can no longer burn the attempt after ISOLATE).
- **C2/C3** the runner re-proves the root-owned control snapshot and the pinned-main Git objects (replacement objects disabled) before the first `source`, then the operator identity, the real `p4-stage-gate.sh --stage Recovery --mode live`, the reused R1B/R1Bv predecessor gate, the immutable verifier snapshot, interpreter, R1I, services, clock, IDEA2 S10 and the pinned release CLI; the root handlers prove their own snapshot, interpreter and root work directory before executing anything.
- **I1** ONE canonical durable root-owned attempt marker (parent barrier on every invocation, exclusive create, file then directory fsync, then `chattr +i`), consumed immediately before ISOLATE; the duplicate Python marker is gone.
- **I2** real PRE/POST capture and compare; the only approved change is the Core-derived bound attacker ADDED to `blocked_ipv4`, approved only after a semantic proof bound to the captured hashes (no static or invented allow key).
- **I3** no premature `EXECUTED=YES` and no automatic closed-pass token; `RECOVERY_PROMOTION=NOT_AUTOMATIC`.
- **I4/I5** root-owned work directory with exclusive baseline/FINAL-RAN/result/SHA-256 outputs and a bound `verify.sh`; PASS rests on the Core's own durable evidence and the Core CLOSE record, never on operator step JSON.
- **I6** the RESTORE secret is typed only into the pinned release program (digest-pinned CLI, controlled environment, no PATH/PYTHON redirection); no self-proving confirmation variable.
- **I7** load-bearing behavioural tests replace the string-grep tests, including direct tests of the freeze and snapshot tools.
- **M1-M3** precise D4 exit-code meanings, exit 3 only into read-only reconciliation, and an explicit read-only opener seam on `recovery_evidence.evaluate` (no global monkeypatch).
- Operational note found while fixing: the Core Recovery socket accepts only the configured OPERATOR uid, so the Core operations run as the operator from the immutable snapshot and only captures/verifiers run as root. Durable stores prove the ACCEPTED ack and a correlated status; the physical NORMAL state exists only in the Core's in-memory confirmation, so it is attested by the Core CLOSE record (the earlier verifier required it from a durable store and could never have passed).
- `R1B_RESULT=FAIL_IMMUTABLE`, `R1BV_RESULT=PASS`; `F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN`, `R1_VERIFIED=NOT_CLAIMED`, `LVR_PROVEN=NO`, `L8_ACCEPTANCE=NO`, `L9_PROVEN=NO`. `RECOVERY_REPOSITORY_IMPLEMENTED=YES`, `RECOVERY_LIVE_EXECUTED=NO`, `RECOVERY_R2_R8_EXECUTED=NO`.

## Source files changed

- IDEA3-AEGIS_Lockdown/aegis_soc/recovery_stage.py — operator-side ladder, D4 recording, root-side baseline/final/verify-result/containment-delta, trusted-path helpers; no marker, no observation authority.
- IDEA3-AEGIS_Lockdown/aegis_soc/recovery_evidence.py — one explicit optional read-only `opener` seam on `evaluate()` (default unchanged).
- IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-recovery-run-lib.sh — canonical marker, gates, operator/root wrappers, D4 boundary, capture/compare wiring, attempt state machine.
- IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-recovery-owner.sh — hardened frozen-runner template (22 pins, no secret).
- IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/recovery-acceptance/recovery_runner_freeze.py — Recovery pin set updated (22 pins).
- IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/Recovery/ (apply.sh, verify.sh, rollback.sh, allow-keys.txt, allow-listeners.txt) — verified-snapshot root handlers; no static allowance.
- IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-lib.sh and p4-stage-gate.sh — registration and K3 recognition only (shared surfaces, unchanged since the first push of this PR).
- IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md — section 24 describes the corrected design.
- IDEA3-AEGIS_Lockdown/tests/test_recovery_stage.py, tests/test_recovery_final_verify.py and tests/recovery/ — new behavioural tests; tests/r1b, tests/test_historical_disposition.py, tests/test_pr11_phase4_l34_v8_scope_contract.py and the other registry-order tests — stale registry/pin expectations re-pinned for the Recovery registration and the `opener` seam.
- Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md and idea3-moc.md — durable current state.

## Verification evidence

- `python -m pytest tests/test_recovery_stage.py tests/test_recovery_final_verify.py tests/recovery/test_recovery_attempt.py tests/recovery/test_recovery_runner_authority.py tests/recovery/test_recovery_preservation.py` (run per suite) — pass: 50 + 58 + 62 + 114 + 47 = 331 passed.
- `python -m pytest tests/recovery/test_recovery_runner_freeze.py tests/recovery/test_recovery_snapshot_freeze.py tests/recovery/test_recovery_bootstrap_authority.py` — pass: 73 + 41 + 28 = 142 passed (direct tests of the privileged freeze and snapshot tools).
- `python -m pytest tests/test_recovery_evidence.py tests/test_core_recovery.py tests/test_core_recovery_security.py tests/test_core_restore_policy.py tests/test_core_break_glass.py` — pass: 131 + 73 + 37 + 50 + 63 = 354 passed.
- `python -m pytest` on the harness, F1u, R1Du, R1 acceptance, R1I, dnsmasq-scope, R1Bv contract and historical-disposition suites — pass: 243 + 352 + 367 + 89 + 33 + 99 + 156 + 70 = 1,409 passed.
- `python -m pytest tests` (full suite, before re-pinning) — 14 failed, 10011 passed, 11 skipped: 8 failures also fail on the untouched base `c6885cb1` (host-dependent F1/F1r systemctl stubs, a pinned `p4-compare.sh` digest, three `historical_disposition` closure expectations, two stale L7u/L8p registry assertions); 1 (`test_local_restore` supervisor channel) passed in isolation; 5 were caused by this PR and are fixed and re-run green (two stale R1B registry assertions, two shared-gate digest pins in the V8 scope contract, the `recovery_evidence.py` digest pin).
- `node --test tests/collaborationPolicy.test.mjs` — pass: 33 passed.
- `node scripts/validate-vault.mjs` — pass with 2 existing canvas owner-review warnings.
- `bash -n`, `python -m py_compile` on all 22 changed shell/Python files, and `git diff --check` — pass.
- No Production, Recovery LIVE, ISOLATE, RESTORE, CLOSE, R1B/R1Bv rerun or ESP32 operation was performed; every test is hermetic and stubbed.

## Canonical notes updated

- Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md — Recovery repository implementation is complete; LIVE remains NO.
- Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-moc.md — current Recovery state and superseded historical wording.
- IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md — Phase-4 Recovery sequence and safety boundary.

## Shared surfaces touched

- IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-lib.sh — shared Phase-4 stage registry now includes Recovery.
- IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-stage-gate.sh — shared Authorization/K3 gate recognizes Recovery as mutating.

## Integration requests

- Music functional owner review and Kla integration review of p4-lib.sh and p4-stage-gate.sh, the governed stage registration, K3/Authorization boundary, Core Recovery reuse, and preservation allowlist before any future LIVE authorization. Human owner must review and merge the Draft PR; no agent merge.

## Known limitations

- Recovery LIVE is intentionally not executed by this implementation PR; no Production result or Recovery PASS is claimed.
- The two vault canvas warnings are pre-existing owner-review warnings.
- The tests were run with the project virtualenv Python (the default PlatformIO Python lacks pytest).
- The 8 base failures listed above are pre-existing and out of scope for this PR.
- The untracked .impeccable/hook.cache.json was observed as unrelated worktree state and is not included.
