---
title: Task Receipt — IDEA3 F1 production deployment package (repository only)
date: 2026-10-02T05:05:00+07:00
owner: music
area: idea3
branch: feat/idea3-f1-production-deployment-package
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 F1 production deployment package (repository only)

## What changed

- **Repository-only. IMPLEMENTED != DEPLOYED.** Nothing was installed, enabled or started; no host command, no useradd/groupadd/systemctl, Production NOT mutated, Core NOT restarted, L7u NOT run, Recovery NOT run, no ESP32, no L8p/L8. `F1_PRODUCTION_DEPLOYED = NO`, `F1_REAL_DETECTOR_ACCEPTANCE = NO`, `CORE_RESTARTED = NO`, `L7U_LIVE_FINAL = NOT_PROVEN`, `RECOVERY_LIVE = NOT_RUN`, `L8P_LIVE = NOT_AUTHORIZED`, `L8_LIVE = NOT_RUN`. No merged receipt (#282, #286, #287) was edited.
- **Chronology (this single unmerged-PR receipt was amended in place; no second receipt exists):**
  1. Original package implementation on `main` `bfbe1dc6` (commits `b83d559a`, `9186fe99`, `78ffb390`): production sink, detector, unit template, `p4-f1-alert-source.py`, optional `AEGIS_ALERT_SOURCE_UID`. At that point the source identity was `OWNER_INPUT_REQUIRED` and L7u was untouched.
  2. **OD-F1-DEPLOY-01 owner approval:** dedicated non-root account `aegis-idea3-detector`, transport group `aegis-idea3-alert`, dedicated runtime `/run/aegis-idea3-alert`, no `CAP_DAC_OVERRIDE`, `SO_PEERCRED` exact-uid authorization.
  3. **Phase A (interrupted, then completed locally):** L7u Core-side ownership of the frozen uid, the alert group, the Core supplementary-group drop-in, the alert tmpfiles/runtime directory and the alert-socket verification, with journaled rollback; final detector unit; local commit `1888e7ed`. The Core hook was deliberately left `CORE_ALERT_SOCKET_HOOK_IMPLEMENTED = NO` because PR #287 (R5 + break-glass) had not merged.
  4. **Main moved:** PR #287 (`8a41a854`), PR #289 (`812eabee`, `AGENTS.md` + collaboration-policy validator) and PR #264 (IDEA2, `858c26fa`) merged. Reconciled with `git merge --no-ff origin/main` (no rebase, no force): the only path changed on both sides was `idea3-status.md`, merged without conflict (`MAIN_RECONCILIATION = PASS`, merge commit `1c1c96ea`). The new `AGENTS.md` was re-read in full.
  5. **Phase B (this change):** the Core alert socket hook on the merged R5/break-glass source, final verification and the final scratch release.
- **Core alert socket hook (Phase B):** `AlertServer` (and `RecoveryServer.socket_group_mode`, a class constant that keeps Recovery at `0660`) now serves the F1 ingress only through the dedicated surface. `config.ALERT_RUNTIME_DIR/ALERT_SOCKET_PATH/ALERT_GROUP` are fixed constants (`/run/aegis-idea3-alert`, `/run/aegis-idea3-alert/alert.sock`, `aegis-idea3-alert`; no environment override). The supervisor resolves the group gid and passes `socket_gid`; the server then requires the directory to already exist as Core-owned, group = alert gid, mode exactly `2750` (it is never created or widened by the Core) and makes the socket Core:`aegis-idea3-alert` `0620` (connect reachability only, no world bits). A missing/mis-moded/mis-grouped directory fails closed (`RecoveryChannelError`, logged, ingress disabled, Core unaffected). A root or Core-uid `AEGIS_ALERT_SOURCE_UID`, or an unresolvable group, keeps the ingress disabled. Authorization is unchanged and still the first thing the server does: `SO_PEERCRED` uid == `AEGIS_ALERT_SOURCE_UID`, evaluated before any request byte is read, so a member of `aegis-idea3-alert` with any other uid is refused. `/run/aegis-idea3/alert.sock` is no longer used anywhere in Production code; fixture tests pass their own socket paths without a group (0600).
- **Preserved, not weakened:** normal R5 (R1 VERIFIED -> R3 VERIFIED -> live containment read-back -> fresh R2 VERIFIED -> D4 -> RESTORE) and break-glass (authenticated v1 LOCKDOWN -> durable episode -> fresh current-process LOCKDOWN proof -> Case A/B only -> fresh R2 -> D4 -> dual typed confirmation -> one durable claim per episode -> RESTORE; `BREAK_GLASS_COUNTS_AS_R4 = NO`, `BREAK_GLASS_COUNTS_AS_R5 = NO`). The normal Recovery channel, `local-restore.sock`, the Recovery runtime directory, containment and MQTT Protocol-v1 authority are untouched; none is exposed to `aegis-idea3-alert`. In the release, `recovery_core.py`, `supervisor.py`, `database.py`, `mqtt_client.py` are byte-identical to source in the final scratch release.
- **L7u (final) and rollback audit:** the engine's ordered apply is release installed -> account/uid verified -> alert group verified/created -> Core alert-group drop-in -> alert tmpfiles/runtime -> `core.env` -> current switched -> exactly ONE Core restart -> Core health -> dedicated alert socket verified -> Recovery runtime verified -> detector NOT started (`L7U_CORE_RESTART_COUNT = ONE`, `L7U_STARTS_DETECTOR = NO`). Audited `rollback()` against that engine: every mutation (alert group, membership, both drop-ins, both tmpfiles, both runtime directories, `core.env` bytes/mode/owner/mtime, release pointer, Core restart) is journaled before it happens; pre-existing alert drop-in/tmpfiles/runtime directory are refused at plan time rather than adopted; rollback only removes what the attempt created and proved unchanged, restores the old release, and only ever runs `systemctl stop/start/reset-failed` of the Core, `daemon-reload`, `gpasswd`/`groupdel`; it never starts the detector, sends CUT or RESTORE, touches ESP32 or containment, and refuses (does not auto-retry) on any unknown state. No rollback gap was found, so no engine change was needed.
- **Detector unit (final):** `User=aegis-idea3-detector`, `SupplementaryGroups=aegis-idea3-alert systemd-journal`, `CapabilityBoundingSet=` and `AmbientCapabilities=` empty (no `CAP_DAC_OVERRIDE`), `NoNewPrivileges=true`, `RestrictAddressFamilies=AF_UNIX`, `Restart=no`, `ExecStartPre` bounded check of the final Core alert socket; started only by the F1 package after a successful future L7u.
- **Final scratch release:** `f1-phase-b-fbce492b` built from the clean tree at `fbce492b` (the code commit; later commits change only the receipt) with the real owner offline wheelhouse; contains R5/break-glass, the durable lockdown-episode model, `AlertIngress` with the dedicated-path constants, `production_detector`, `alert_sink`, the four Recovery runtime files, and `requirements.txt` = `paho-mqtt==2.1.0` only.

## Source files changed

- `IDEA3-AEGIS_Lockdown/aegis_soc/alert_sink.py` — NEW production sink and socket check.
- `IDEA3-AEGIS_Lockdown/aegis_soc/production_detector.py` — NEW production detector.
- `IDEA3-AEGIS_Lockdown/aegis_soc/config.py`, `aegis_soc/recovery_core.py`, `aegis_soc/supervisor.py` — Phase B Core alert socket hook (dedicated constants, `AlertServer` group/mode/directory contract, supervisor wiring).
- `IDEA3-AEGIS_Lockdown/deploy/aegis-idea3-detector.service.example` — NEW final unit template.
- `IDEA3-AEGIS_Lockdown/deploy/aegis-idea3-core-alert.dropin.example`, `deploy/aegis-idea3-alert.tmpfiles.example` — NEW Core alert-group drop-in and dedicated runtime-directory tmpfiles templates.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-f1-alert-source.py` — NEW render/verify/ordered start/bounded stop tool.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l7-core-env.py`, `deploy/aegis-idea3-core.env.example` — `AEGIS_ALERT_SOURCE_UID` contract and `--alert-source-uid`.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l7-build-release.py` — third release entrypoint.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l7u-upgrade.py`, `p4-l7u-run-lib.sh`, `p4-l0-capture.sh`, `p4-compare.sh`, `owner-run/run-l7u-owner.sh`, `stages/L7u/{allow-keys.txt,apply.sh,rollback.sh,verify.sh}` — Phase A L7u ownership of the F1 alert surface, verification and journaled rollback.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l34_v6_clock_stabilization.py` — re-pinned `p4-compare.sh`/`p4-l0-capture.sh` sha256 for the additive F1 observability.
- `IDEA3-AEGIS_Lockdown/tests/test_core_alert_ingress.py` — Phase B hook tests (dedicated path/modes, wrong-uid-with-group refusal, exact uid accepted, root/Core source refused, directory contract, Recovery policy unchanged); `tests/test_f1_alert_sink.py`, `tests/test_f1_alert_source_package.py`, `tests/l7u_support.py`, `tests/test_pr11_phase4_l7_release_builder.py`, `tests/test_pr11_phase4_l7u_release_builder_recovery_runtime.py`, `tests/test_pr11_phase4_l7u_stage_governance.py`, `tests/test_pr11_phase4_l7u_upgrade_engine.py` — F1/L7u tests and pins.
- `IDEA3-AEGIS_Lockdown/README.md` — F1 paragraphs updated to the dedicated alert path.

## Verification evidence

- Reconciliation: `git fetch origin`; HEAD `1888e7ed`, `origin/main` `858c26fa`, tree clean; `8a41a854` (#287), `812eabee` (#289) and the #264 merge `858c26fa` proven ancestors of `origin/main`; `git merge --no-ff origin/main` — pass: clean, no conflict.
- F1 targeted `pytest tests/test_core_alert_ingress.py tests/test_f1_alert_sink.py tests/test_f1_alert_source_package.py tests/test_detector.py -q` — pass: `311 passed`.
- R5: `pytest tests/test_core_break_glass.py tests/test_core_restore_policy.py tests/test_restore_authority.py -q` — pass: `118 passed`.
- Recovery/runtime: `pytest tests/test_local_restore.py tests/test_core_recovery.py tests/test_core_recovery_security.py tests/test_mqtt_client.py tests/test_production_runtime.py tests/test_supervisor_broker_status_convergence.py -q` — pass: `320 passed`.
- L7 (`test_pr11_phase4_l7_*.py`) — pass: `660 passed`. L7u (`test_pr11_phase4_l7u_*.py`) — pass: `233 passed`. L8p (`test_pr11_phase4_l8p_*.py`) — pass: `192 passed`. Project env `~/.venvs/aegis-idea3-core` with `paho-mqtt==2.1.0`.
- Full IDEA3 suite once on the final reconciled tree (`pytest tests`): `5376 passed, 8 skipped, 0 xfailed, 1 failed` in 22m26s (the R5 strict xfail marker no longer exists after #287). The single failure, `test_pr11_phase4_l34_v6_clock_stabilization.py::test_comparator_l5_predicate_and_l0_capture_are_unchanged`, was caused by this branch (Phase A's additive F1 alert observability in `p4-compare.sh`/`p4-l0-capture.sh`; the test passes on `origin/main`, whose files match the old pins). It was fixed by re-pinning the two sha256 values with a recorded reason, following the existing L7u precedent (the L5 predicate pin is unchanged); that file was then re-run: `21 passed`. The whole suite was not re-run after this test-only pin change.
- Real scratch release build `p4-l7-build-release.py build --source-root . ... --release-id f1-phase-b-fbce492b --wheelhouse /home/kittipat/Workspace/idea3-p4-evidence/l7u-wheelhouse` — pass: `L7_RELEASE_BUILD=PASS`, `SOURCE_GIT_SHA=fbce492ba79d2f79e6b02a8957a3465430b28a8b`, `SOURCE_TREE_DIRTY=NO`, 52 files; no network, no stub wheelhouse. `verify --expect-owner self` — pass: `L7_RELEASE_VERIFY=PASS`; `sha256sum -c RELEASE-SHA256SUMS` clean.
- Actual canonical `p4-l7u-upgrade.py` `load_guard().check(...)` against the final release plus the engine's Recovery runtime-file presence check (fixture/non-Production, not pytest) — pass: `L7U_PREFLIGHT_GUARD=PASS`; L7u was not run.
- `ruff check` on every changed Python file — pass, except 17 findings in `test_pr11_phase4_l34_v6_clock_stabilization.py` that are identical on `origin/main` (same count, not introduced here; the file was touched only for the pin comment and two hashes). `bash -n` on every changed shell file — pass. `systemd-analyze verify --man=no` on the rendered detector unit — pass (rc 0; systemd 261; the Core drop-in is an override fragment covered by the L7u engine template tests). `git diff --check` — pass.
- `node scripts/validate-vault.mjs` — @VAULT@. `node scripts/validate-collaboration-policy.mjs --event <final PR event> --changed-files <git diff --name-status origin/main HEAD>` (the PR #289 invocation read from `AGENTS.md`/the script and the workflow) — @POLICY@. Changed-content secret scan — @SECRET@.
- Scope of all evidence: local and simulated only (fake hosts/backends, temporary AF_UNIX sockets; no host, broker, Core or device).

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — F1 deployment-package section rewritten to current truth (`PR287_MERGED = YES`, `R5_REPOSITORY_MERGED = YES`, `BREAK_GLASS_IMPLEMENTED = YES`, `OD_R5_BG_01 = APPROVED`, `OD_F1_DEPLOY_01 = APPROVED`, dedicated non-root identity, `CORE_ALERT_SOCKET_HOOK_IMPLEMENTED = YES`, `L7U_F1_INTEGRATION_IMPLEMENTED = YES`) with all live flags still NO/NOT_PROVEN/NOT_RUN; R5 section header reconciled to the merged state.

## Shared surfaces touched

- `None` — task stayed inside its selected area

## Integration requests

- None — valid only when no cross-scope/shared path changed

## Known limitations

- Not deployed and never run live: no detector has sent an alert to a real Core socket; `F1_REAL_DETECTOR_ACCEPTANCE = NO`; the Core alert socket hook has only run in hermetic tests with temporary directories (a real Core with the real group/runtime directory is unproven).
- L7u apply/rollback were exercised only against fixtures and fake backends; `L7U_LIVE_FINAL = NOT_PROVEN`. Provisioning the `aegis-idea3-detector` account and freezing its uid remain owner steps.
- The scratch release proves repository source and dependencies only; its source SHA `fbce492b` precedes the receipt/status commits, which change documentation only.
- Detection input is the system journal read through a constant `journalctl` argv as the detector account (membership in `systemd-journal`).
- The unit is never installed or enabled by this change; `start-detector`/`stop-detector` act only with `AEGIS_F1_LIVE_AUTHORIZED=YES` and root and have only run against fakes.
- The first protected/gateway attacker address R3 dead end is unchanged and still deferred.
