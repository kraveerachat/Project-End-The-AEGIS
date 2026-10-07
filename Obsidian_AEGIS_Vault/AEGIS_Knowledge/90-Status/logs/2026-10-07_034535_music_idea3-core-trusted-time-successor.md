---
title: Task Receipt — IDEA3 Core TrustedClock sandbox repair & CTu Blocker Resolution
date: 2026-10-07T03:45:35+07:00
owner: music
area: idea3
branch: fix/idea3-core-trusted-time-successor
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 Core TrustedClock sandbox repair & CTu Blocker Resolution

## What changed

- Repaired the reviewed Core unit's TrustedClock sandbox boundary by changing only `ProtectClock=true` to `ProtectClock=false`, allowing the required read-only `adjtimex(2)` probe.
- Preserved non-root execution (`User=aegis-idea3`), `NoNewPrivileges=true`, empty capability bounding/ambient sets, and unrelated Core hardening.
- Fully resolved all 12 reviewer blockers for CTu:
  1. Blocker 1: Runner PRE capture order enforced strictly before marker consumption.
  2. Blocker 2: Dual-case lockdown episode handling supporting Case A (correlated new episode) and Case B (pre-existing open episode + fresh post-restart STATUS).
  3. Blocker 3: Detector single implicit lifecycle proof (`Requires=aegis-idea3-core.service` dependency only; PRE != POST_APPLY, VERIFY == POST_APPLY, process_count == 1).
  4. Blocker 4: Signal-safe rollback with `IN_POST_FAIL=1` guard and `trap '' INT TERM HUP EXIT` during rollback execution.
  5. Blocker 5: Atomic terminal closeout via temporary file → `fsync` → `mv -n` → `fsync` directory; immutable; refuses if FAIL closeout exists.
  6. Blocker 6: CTu → Recovery descendant history binding via `GIT_NO_REPLACE_OBJECTS=1 git merge-base --is-ancestor`.
  7. Blocker 7: Real CTu freeze (`ctu-acceptance/ctu_runner_freeze.py`) and verifier snapshot (`ctu-acceptance/ctu_verifier_snapshot.py`) with trust closure.
  8. Blocker 8: Authorization and K3 V2 binding (`expected_main`, `runner_sha256`, `unit_sha256`, `operator_user`, `operator_uid`), no extra fields allowed.
  9. Blocker 9: Pre-consume gates and non-interactive sudo keepalive (`sudo -v` before consume, strictly `sudo -n` post-consume).
  10. Blocker 10: Manual reconciliation tooling (`reconciliation/reconcile-ctu.py`) and procedure for SIGKILL, host crash, and power loss.
  11. Blocker 11: Restored security intent in Recovery freeze trust seam tests (`_initial_user_namespace()` protection).
  12. Blocker 12: Recovery CTu negative test matrix covering missing closeout, wrong main, non-ancestor, conflicting closeouts, wrong unit SHA, unhardened unit, Recovery already consumed.
- Added comprehensive regression test suite `IDEA3-AEGIS_Lockdown/tests/test_ctu_blockers.py` covering all 12 blockers.
- Updated documentation in `deploy/pr11-phase4/README.md`, `idea3-moc.md`, and `idea3-status.md`.
- Required governed sequence established: `... -> RRu PASS -> NTP successor PASS / consumed -> CTu -> CTu closeout -> fresh Recovery authority/freeze -> Recovery -> LVR -> L8 -> L9`.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/aegis-idea3-core.service.example` — least-privilege TrustedClock unit exception (`ProtectClock=false`); no `CAP_SYS_TIME`.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-ctu-owner.sh` — governed owner freeze template with strict runner pre-capture order, pre-consume gates, non-interactive `sudo -n` keepalive, and signal-safe rollback.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-recovery-owner.sh` — Recovery owner runner wired with CTu descendant history gating.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-ctu-run-lib.sh` — CTu support library with atomic closeout (`CTU-GLOBAL-CLOSEOUT-PASS`), failure closeout, fsync, bundle preparation, and sudo keepalive.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-ctu-runtime-verify.py` — runtime verifier with dual-case lockdown episode handling and detector single implicit lifecycle proof.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l7u-run-lib.sh` — stage helper functions.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-lib.sh` — CTu stage registration and Authorization/K3 required/allowed field bindings.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-recovery-run-lib.sh` — `recovery_ctu_successor_gate` enforcing real Git object ancestry and unit hardening verification.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-stage-gate.sh` — CTu same-day authorization, K3 V2 binding, and no-extra-fields enforcement.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/ctu-acceptance/ctu_runner_freeze.py` — mechanical CTu runner freeze tool.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/ctu-acceptance/ctu_verifier_snapshot.py` — trusted root-owned control snapshot builder and trust closure verifier.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/reconciliation/reconcile-ctu.py` — read-only inspection tooling for SIGKILL, host crash, and power loss.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/recovery-acceptance/recovery_runner_freeze.py` — Recovery runner freeze tool updated with CTu bindings.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/CTu/allow-keys-rollback.txt` — rollback key allowlist.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/CTu/allow-keys.txt` — narrow unit and restart identity allowance, including detector `Requires=` identity consequence.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/CTu/allow-listeners.txt` — empty listener allowance.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/CTu/apply.sh` — unit-only apply, conditional daemon reload, one Core restart, and post-apply detector identity capture.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/CTu/rollback.sh` — exact unit preimage restore and governed Core restart only.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/CTu/verify.sh` — read-only unit, process, TrustedClock, time-trust, authenticated STATUS, device, and uplink proof.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md` — Section 26 documenting CTu contract and manual reconciliation.
- `IDEA3-AEGIS_Lockdown/tests/test_ctu_blockers.py` — dedicated regression suite verifying all 12 reviewer blockers.
- `IDEA3-AEGIS_Lockdown/tests/test_core_trusted_time_repair.py` — unit security, CTu registration, scope, allow-catalog, and marker-order regressions.
- `IDEA3-AEGIS_Lockdown/tests/recovery/test_recovery_runner_freeze.py` — test suite for Recovery runner freeze with restored security intent.
- `IDEA3-AEGIS_Lockdown/tests/r1b/test_r1b_live_failure_closeout.py` — registry expectation re-pinned for CTu insertion.
- `IDEA3-AEGIS_Lockdown/tests/r1bv/test_r1bv_contract.py` — registry order expectation re-pinned for CTu insertion.
- `IDEA3-AEGIS_Lockdown/tests/r1i/test_r1i_input_instrumentation.py` — registry expectation re-pinned for CTu insertion.
- `IDEA3-AEGIS_Lockdown/tests/rru/test_rru_stage.py` — RRu successor order expectation re-pinned for CTu insertion.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_dnsmasq_unit_repair_reboot_and_scope.py` — registry expectation re-pinned for CTu insertion.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_f1u_stage.py` — registry expectation re-pinned for CTu insertion.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_harness.py` — handler directory expectation includes CTu.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l34_v8_scope_contract.py` — registry expectation re-pinned for CTu insertion.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l7u_stage_governance.py` — registry order expectation re-pinned for CTu insertion.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_r1du_stage.py` — registry uniqueness/order expectation re-pinned for CTu insertion.
- `IDEA3-AEGIS_Lockdown/tests/test_r1_acceptance.py` — registry expectation re-pinned for CTu insertion.
- `IDEA3-AEGIS_Lockdown/tests/test_recovery_stage.py` — Recovery predecessor order expectation re-pinned for CTu insertion.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-moc.md` — MOC updated with CTu repair and Recovery sequence facts.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — canonical status updated with CTu repair and session register.

## Verification evidence

- `pytest -v IDEA3-AEGIS_Lockdown/tests/test_ctu_blockers.py` — 12/12 PASS:
  - `RUNNER_PRE_CAPTURE_ORDER=PASS`
  - `ALREADY_OPEN_LOCKDOWN_CASE=PASS`
  - `DETECTOR_SINGLE_CYCLE_PROOF=PASS`
  - `SIGNAL_SAFE_ROLLBACK=PASS`
  - `ATOMIC_CLOSEOUT=PASS`
  - `CTU_PASS_SURVIVES_ROLLBACK=NO`
  - `CTU_RECOVERY_DESCENDANT_BINDING=PASS`
  - `CTU_FREEZE_IMPLEMENTATION_EXISTS=YES`
  - `CTU_FREEZE_VERIFIER_EXISTS=YES`
  - `CTU_TRUST_CLOSURE=PASS`
  - `CTU_AUTH_BINDING=PASS`
  - `CTU_K3_BINDING=PASS`
  - `CTU_EXTRA_FIELDS_REFUSED=YES`
  - `POST_CONSUME_SUDO_PROMPT_POSSIBLE=NO`
  - `CTU_MANUAL_RECONCILIATION_READY=YES`
  - `TRUST_SEAM_TEST_WEAKENED=NO`
  - `RECOVERY_CTU_GATE_NEGATIVE_TESTS=PASS`
- `pytest -v IDEA3-AEGIS_Lockdown/tests/test_core_trusted_time_repair.py` — 24/24 PASS.
- `pytest -v IDEA3-AEGIS_Lockdown/tests/recovery/test_recovery_runner_freeze.py` — 74/74 PASS.
- `pytest -v IDEA3-AEGIS_Lockdown/tests/rru/test_rru_stage.py` — 30/30 PASS.
- `pytest -v IDEA3-AEGIS_Lockdown/tests/test_recovery_stage.py` — 28/28 PASS.
- `pytest -v IDEA3-AEGIS_Lockdown/tests/test_r1_acceptance.py` — 200/200 PASS.
- Full core suite run: 368/368 PASS in 18.57s.
- `node scripts/validate-vault.mjs` — pass with only the two existing Canvas owner-review warnings.
- `node --test tests/coreEntryGovernanceR4.test.mjs` — pass (2 tests, 0 fails).
- `git diff --check` — pass (no whitespace or conflict marker errors).
- LIVE execution — not performed; no Core restart, Detector command, ESP32 touch, NTP reactivation rerun, or Recovery attempt occurred.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — session register updated (CTu-S2 closed), all 12 blockers recorded, exact sequence documented.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-moc.md` — current repair state and CTu sequence updated.

## Shared surfaces touched

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-lib.sh` — shared Phase-4 stage registry and authorization/K3 field contracts.
- Phase-4 registry expectation tests listed above — downstream governance contract re-pins for the new stage ordering.

## Integration requests

- Kla/integration reviewer: review CTu's insertion after RRu and before Recovery, its fresh Authorization/K3/one-shot boundary, and the exact allow-catalog before any future LIVE authority is created. Rollback is limited to the CTu unit preimage and Core restart; no existing Recovery authority may be reused after merge.

## Known limitations

- CTu LIVE deployment, real service-sandbox TrustedClock SYNCED proof, authenticated ESP32 STATUS, and post-restart device/uplink evidence remain intentionally unexecuted and are not claimed by this repository task.
- The repository-only test environment cannot prove actual systemd kernel capability behavior; the security contract is encoded in the reviewed unit and must be re-proven during a future governed LIVE preflight.
