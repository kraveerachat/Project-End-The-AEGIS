---
title: Task Receipt — IDEA3 L7u post-L7 Recovery Core upgrade (repository implementation)
date: 2026-10-01T03:59:30+07:00
owner: music
area: idea3
branch: deploy/idea3-post-l7-recovery-core-upgrade
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 L7u post-L7 Recovery Core upgrade (repository implementation)

> Repository implementation only. Developed on pinned `main` `81f201a41bdb2153820c8ead61762d7ffb97ca3c`; the branch was then fast-forward merged to `origin/main` `e3e028626fb07ab34c9964ff1f43ece304944c90` (IDEA1 preview P0 only; no overlap with any path below). The test results below were collected on the pinned base; after the merge only the lightweight checks were rerun. `IMPLEMENTED != DEPLOYED`.
> `L7U_LIVE_ACCEPTANCE = NOT_PROVEN`, `L7U_LIVE_AUTHORIZED = NO`, `L7U_LIVE_EXECUTED = NO`, `PRODUCTION_MUTATION_PERFORMED = NO`, `CORE_RESTARTED = NO`, `RECOVERY_LIVE_EXECUTED = NO`, `ESP32_TOUCHED = NO`, `L8_STARTED = NO`. Recovery R1–R8 and LVR are NOT_PROVEN; F1 and the R5 break-glass decision remain unresolved.

## What changed

- New stage **L7u** (`L7 → L7u → Recovery R1-R8 → LVR → L8`): a journaled, fixture-tested engine (`p4-l7u-upgrade.py`) that installs a new immutable release, creates/adopts the dedicated transport group `aegis-idea3-recovery` (filesystem access only; `SO_PEERCRED` uid stays the authority), adds the operator as a supplementary member, appends exactly three Recovery settings to core.env (every pre-existing byte preserved), installs a systemd drop-in and a tmpfiles rule, pre-provisions `/run/aegis-idea3-recovery` (0750 `aegis-idea3:aegis-idea3-recovery`), switches `current` atomically and performs one governed Core restart. Rollback is journal-driven and refuses unknown state before acting.
- Design finding: the base unit's `ProtectSystem=strict` also requires `ReadWritePaths=/run/aegis-idea3-recovery` in the drop-in, otherwise the Recovery channel silently fails to bind.
- Stage governance: own `A-L7u` + `stage=L7u` K3, own one-attempt marker and receipt gate, PRE capture before the attempt is consumed, no `recovery_authorization`; unpinned owner-runner template.
- Observability: new non-secret capture keys and compare allowances so no L7u mutation is invisible to PRE→POST / PRE→RB.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l7u-upgrade.py` — engine (preflight/apply/verify/rollback/delta).
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l7u-run-lib.sh` — own marker, receipt gate, Core/identity gates, secret scan.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-l7u-owner.sh` — unpinned owner-runner template.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L7u/{apply,verify,rollback}.sh`, `allow-keys.txt`, `allow-listeners.txt`, `allow-keys-rollback.txt` — stage handler.
- `IDEA3-AEGIS_Lockdown/deploy/aegis-idea3-core-recovery.dropin.example`, `IDEA3-AEGIS_Lockdown/deploy/aegis-idea3-recovery.tmpfiles.example` — repository templates.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-lib.sh` — register `L7u` between `L7` and `L8`.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-stage-gate.sh` — reject `d6_notice`/`integration_review`/`recovery_authorization` in an L7u record.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l0-capture.sh` — L7u observability keys (`host.aegis_idea3.recovery.*`, drop-in/tmpfiles records, `host.path` flags).
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-compare.sh` — `host.aegis_idea3.recovery.` allowable key family; `stage L7u` token in `ALLOW_L6C_RELEASE_FILE`.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md` — L7u handler section.
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-10-01-idea3-pr11-phase4-l7u-post-l7-recovery-core-upgrade.md` — operational design/spec.
- `IDEA3-AEGIS_Lockdown/tests/l7u_support.py`, `tests/test_pr11_phase4_l7u_upgrade_engine.py`, `tests/test_pr11_phase4_l7u_stage_governance.py`, `tests/test_pr11_phase4_l7u_recovery_runtime_contract.py` — new tests.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_harness.py` — register L7u in the stage/handler-set expectations.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l34_v6_clock_stabilization.py` — re-pin the sha256 of `p4-compare.sh` and `p4-l0-capture.sh` (intentional, commented).

## Verification evidence

- `pytest tests/test_pr11_phase4_l7u_*.py` (RED run, before the engine existed) — fail as required: 195 failed, 16 passed (the 16 were contracts the existing Recovery code already met).
- `pytest tests/test_pr11_phase4_l7u_upgrade_engine.py tests/test_pr11_phase4_l7u_stage_governance.py tests/test_pr11_phase4_l7u_recovery_runtime_contract.py` — pass: all L7u tests green (217 at the GREEN checkpoint; governance later grew to 84 tests, all passing).
- `pytest tests/test_pr11_phase4_harness.py tests/test_pr11_phase4_l6b_handler.py tests/test_pr11_phase4_l7_handler.py tests/test_pr11_phase4_l34_v6_clock_stabilization.py tests/test_pr11_phase4_l7u_stage_governance.py` — pass after two regressions found by this run were fixed (bare-fixture capture compatibility; the V6 sha256 tripwire re-pin): 679 + 220 passed across the two reruns.
- `/home/kittipat/.venvs/aegis-idea3-core/bin/python -m pytest tests` (full IDEA3 suite, no `-x`, nothing deselected, no xdist) — fail (1 pre-existing flake): 4405 passed, 8 skipped, 1 xfailed, 1 failed (`test_pr11_phase4_l6c_capture_gap.py::test_real_end_to_end_capture_then_compare_requires_the_allow_file`). It passes alone and fails intermittently on the untouched pinned main too (7/25 runs on main, 3/25 here) because this workstation's real `aegis-idea3-mosquitto.service` restarts every few seconds (NRestarts above 5000) and drifts between two real captures. Not caused by this task.
- `ruff check` on the new files — pass (repository-wide ruff has 300+ pre-existing findings, none in new files).
- `python -m compileall` and `bash -n` on every touched shell file, `git diff --check` — pass.
- `node scripts/validate-vault.mjs` — pass (2 pre-existing canvas warnings).
- secret-pattern scan of all changed and new files — pass: no real secret; two hits are synthetic scanner-test payloads (one already present on main).

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — added the L7u section (repository-only, not proven live).

## Shared surfaces touched

- `None` — every changed path is inside the IDEA3 boundary. The Phase 4 harness files (`p4-lib.sh`, `p4-stage-gate.sh`, `p4-l0-capture.sh`, `p4-compare.sh`) are shared by all stages, so a second-reviewer look is recommended.

## Integration requests

- Kla/Pub (GitHub reviewers for IDEA3): review the additive changes to the shared Phase 4 comparator/capture/gate; rollback is reverting those files (no runtime depends on them until a live L7u run is frozen and authorized).
- Owner decisions before any live run: freeze/pin the runner, same-day A-L7u and K3 for `stage=L7u`, clean pinned execution worktree, builder wheelhouse.

## Known limitations

- Nothing is live-proven: the fake backend models systemd/groupadd/gpasswd/tmpfiles from documented behaviour; real systemd acceptance of the drop-in, tmpfiles-at-boot, the builder output layout assumed by the runner (`<staging>/<release-id>`), and operator-session pickup of the new group (new logins only) are untested.
- The full-suite run has one pre-existing flaky failure (above). The workstation running these tests appears to host a live `aegis-idea3-core.service` and a crash-looping `aegis-idea3-mosquitto.service`; tests use fixtures and a guard against starting real processes, and only read-only `systemctl show` ran against the host.
- `/etc/gshadow` is deliberately not captured.
