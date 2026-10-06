---
title: Task Receipt — IDEA3 Core TrustedClock sandbox repair
date: 2026-10-07T03:45:35+07:00
owner: music
area: idea3
branch: fix/idea3-core-trusted-time-successor
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 Core TrustedClock sandbox repair

## What changed

- Repaired the reviewed Core unit's TrustedClock sandbox boundary by changing only `ProtectClock=true` to `ProtectClock=false`, allowing the required read-only `adjtimex(2)` probe.
- Preserved non-root execution, `NoNewPrivileges=true`, empty capability bounding/ambient sets, and unrelated Core hardening.
- Added the new CTu governed successor package for a future, separately authorized unit install, conditional daemon reload, one Core restart, PRE/POST comparison, authenticated runtime proof, and fail-closed rollback. CTu has not run LIVE.
- Application release deployment is not required: CTu changes only the reviewed systemd unit bytes.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/aegis-idea3-core.service.example` — least-privilege TrustedClock unit exception; no CAP_SYS_TIME.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-lib.sh` — register the new CTu successor after RRu and before Recovery.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/CTu/apply.sh` — unit-only apply, conditional daemon reload, one Core restart.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/CTu/verify.sh` — read-only unit, process, TrustedClock, time-trust, authenticated STATUS, device, and uplink proof.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/CTu/rollback.sh` — exact unit preimage restore and governed Core restart only.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/CTu/allow-keys.txt` — narrow unit and restart identity allowance, including only the detector `Requires=` identity consequence.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/CTu/allow-listeners.txt` — empty listener allowance.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-ctu-owner.sh` — unpinned post-merge owner freeze template; refuses to run as committed.
- `IDEA3-AEGIS_Lockdown/tests/test_core_trusted_time_repair.py` — unit security, CTu registration, scope, allow-catalog, and marker-order regressions.
- `IDEA3-AEGIS_Lockdown/tests/r1b/test_r1b_live_failure_closeout.py` — registry expectation re-pinned for CTu insertion.
- `IDEA3-AEGIS_Lockdown/tests/r1bv/test_r1bv_contract.py` — registry order expectation re-pinned for CTu insertion.
- `IDEA3-AEGIS_Lockdown/tests/r1i/test_r1i_input_instrumentation.py` — registry expectation re-pinned for CTu insertion.
- `IDEA3-AEGIS_Lockdown/tests/rru/test_rru_stage.py` — RRu successor order expectation re-pinned for CTu insertion.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_dnsmasq_unit_repair_reboot_and_scope.py` — registry expectation re-pinned for CTu insertion.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_f1u_stage.py` — registry expectation re-pinned for CTu insertion.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_harness.py` — handler directory expectation includes CTu.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l7u_stage_governance.py` — registry order expectation re-pinned for CTu insertion.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_r1du_stage.py` — registry uniqueness/order expectation re-pinned for CTu insertion.
- `IDEA3-AEGIS_Lockdown/tests/test_r1_acceptance.py` — registry expectation re-pinned for CTu insertion.
- `IDEA3-AEGIS_Lockdown/tests/test_recovery_stage.py` — Recovery predecessor order expectation re-pinned for CTu insertion.

## Verification evidence

- `git diff --check` — pass.
- `PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 -m pytest -q -p no:cacheprovider tests/test_core_trusted_time_repair.py` — pass after the intentional RED phase; environment `python` alias lacked pytest, so `/usr/bin/python3` was used.
- Focused registry suites (`test_pr11_phase4_l7u_stage_governance.py`, `rru/test_rru_stage.py`, `r1bv/test_r1bv_contract.py`) — pass: 84, 119, and 156 tests respectively.
- `node scripts/validate-vault.mjs` — pass with only the two existing Canvas owner-review warnings.
- `git diff --name-status 54157353aaea0e4e1c03de49b00544f174013630...HEAD` — reviewed; no Production evidence, Recovery authority, marker, secret, or runtime artifact added.
- LIVE execution — not performed; no Core restart, Detector command, ESP32 touch, NTP reactivation rerun, or Recovery attempt occurred.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — current task/session register now records CTu repository preparation, LIVE NOT EXECUTED, and the stale-after-merge Recovery-authority boundary.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-moc.md` — current repair state and CTu boundary added.

## Shared surfaces touched

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-lib.sh` — shared Phase-4 stage registry; integration review is required so Recovery sequencing and stage-gate admission remain exact.
- Phase-4 registry expectation tests listed above — downstream governance contract re-pins for the new stage ordering.

## Integration requests

- Kla/integration reviewer: review CTu's insertion after RRu and before Recovery, its fresh Authorization/K3/one-shot boundary, and the exact allow-catalog before any future LIVE authority is created. Rollback is limited to the CTu unit preimage and Core restart; no existing Recovery authority may be reused after merge.

## Known limitations

- CTu LIVE deployment, real service-sandbox TrustedClock SYNCED proof, authenticated ESP32 STATUS, and post-restart device/uplink evidence remain intentionally unexecuted and are not claimed by this repository task.
- The repository-only test environment cannot prove actual systemd kernel capability behavior; the security contract is encoded in the reviewed unit and must be re-proven during a future governed LIVE preflight.
