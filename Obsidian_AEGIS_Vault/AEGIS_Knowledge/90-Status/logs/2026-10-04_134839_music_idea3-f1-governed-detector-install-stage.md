---
title: Task Receipt — IDEA3 F1 governed detector unit install/start stage (repository only)
date: 2026-10-04T13:48:39+07:00
owner: music
area: idea3
branch: feat/idea3-f1-governed-detector-install-stage
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 F1 governed detector unit install/start stage (repository only)

> [!important] Repository-only (IMPLEMENTED != DEPLOYED). **F1 was not executed.** No unit was installed, no service started/enabled/restarted (the Core included), no alert injected, no R1 incident created, no Recovery R1-R8, no ESP32/serial, no Authorization/K3 record or marker created. Production was not mutated.

## What changed

- **Owner decision applied:** a dedicated Phase-4 stage `F1` is registered in `P4_STAGES` after `L8p` and before `L8` (operational order `L7 → L7u → L8p → F1 → Recovery R1-R8 → LVR → L8 → L9`). Not `F1b`; no private authorization path; same-day `authorization-F1.txt` + `k3-F1.txt` with `stage=F1` and no extra field.
- **Gap closed:** `p4-f1-alert-source.py` already owned the ordered START gate but nothing governed unit installation, `daemon-reload` or an owned rollback. New `p4-f1-deploy.py` installs the exact pinned unit (`/etc/systemd/system/aegis-idea3-detector.service`, `root:root 0644`, `O_EXCL` temp + no-overwrite `link`), runs `daemon-reload`, then reuses the reviewed `start_detector` (one `systemctl start`), observes a bounded settle window and verifies. Rollback acts only on a journal written before each mutation, re-proves the installed bytes/owner/mode/inode, and refuses otherwise.
- **Governance:** `p4-f1-run-lib.sh` (marker `F1-ATTEMPT-CONSUMED`; receipt gate requires the canonical L8p closeout result and makes F1 one-shot) and an inert exact-main `owner-run/run-f1-owner.sh` template with five `PIN_` values (main SHA, operator user/uid, alert source uid, unit SHA-256). The pinned unit candidate is `748a4c5bd3d6c30a23324819609ad89bcb4e8c4710cb775ab2c0d789a211772a`.
- **Read-only live preflight that preceded this task (owner root check, main `e8efe3bb`):** alert uid 948 in `core.env` and in the RUNNING Core; operator uid 1000; Recovery socket and gid 947; R2/R6/R7 probe settings present; alert directory `2750` and `alert.sock` `0620` owned `aegis-idea3:aegis-idea3-alert`; detector account uid 948; detector unit not installed.
- **Claims boundary:** a future successful F1 run proves only `F1_PRODUCTION_DEPLOYED` and `F1_DETECTOR_STARTED`. Here: `F1_PRODUCTION_DEPLOYED = NO`, `F1_DETECTOR_STARTED = NO`, `F1_REAL_DETECTOR_ACCEPTANCE = NOT_PROVEN`, `RECOVERY_R1_R8_PROVEN = NO`, `R1_VERIFIED = NOT_CLAIMED`. The stage does NOT claim `RECOVERY_LIVE_EXECUTED = NO`: the detector follows NEW journal lines once started, so a naturally occurring REAL validated alert during the window is an external production event that F1 neither injects, fabricates, accepts nor rolls back.
- **Re-pins (shared harness, mechanical):** `p4-lib.sh` and `p4-stage-gate.sh` changed, so their byte-digest pins in two existing scope-contract tests were updated with explanatory comments; stage-list assertions in four existing tests now include `F1`.

- **Pre-ready review fixes (same PR, same receipt):** (1) `core.env` is secret-metadata-only: apply holds its bytes in memory only, compares them byte-for-byte after the start and discards them; only `core_env_preserved` / `CORE_ENV_PRESERVED=YES` is persisted (no bytes, no digest; the later `verify` re-runs only the existing non-secret `verify_env` uid predicate). (2) After `daemon-reload` and again immediately before the single start (backend hook) the unit must be exactly `LoadState=loaded`, `ActiveState=inactive`, `SubState=dead`, `MainPID=0`, `NRestarts=0`, `Result=success`, `UnitFileState=disabled`, `Restart=no`, `FragmentPath` exact; a concurrently started detector is refused before our start and never adopted. (3) `UnitFileState` must be exactly `disabled` (enabled, enabled-runtime, linked, masked, … refused). (4) The unconditional `RECOVERY_LIVE_EXECUTED=NO` success claim was removed from the runner.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-lib.sh` — register stage `F1` (after `L8p`, before `L8`), repository gaps `none`
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-stage-gate.sh` — `F1` carries no extra authorization field (same rule as L7u/L8p)
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-f1-deploy.py` — NEW install / daemon-reload / one start / verify / owned rollback tool (reuses `p4-f1-alert-source.py` unchanged)
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-f1-run-lib.sh` — NEW gates, one-attempt marker, receipt gate
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-f1-owner.sh` — NEW inert frozen-runner template
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/F1/apply.sh`, `verify.sh`, `rollback.sh`, `allow-keys.txt`, `allow-listeners.txt` — NEW stage handlers (allow files have zero active entries)
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md` — section 12
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_f1_governed_stage.py` — NEW hermetic tests
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_harness.py`, `test_pr11_phase4_l7u_stage_governance.py`, `test_pr11_phase4_l8p_provisioning.py`, `test_pr11_phase4_dnsmasq_unit_repair_reboot_and_scope.py` — stage list includes `F1`
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l34_v8_scope_contract.py` (and the dnsmasq scope test above) — re-pinned `p4-lib.sh` / `p4-stage-gate.sh` digests
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — new F1 stage section
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-10-04_134839_music_idea3-f1-governed-detector-install-stage.md` — this receipt (new)

## Verification evidence

- `pytest tests/test_pr11_phase4_f1_governed_stage.py` (core venv) — pass: 89 passed (hermetic; fake host + fake systemd through the real allow-list and start counter). The first run caught a real bug (pin regex `$` accepted a trailing newline); fixed with `fullmatch` and re-run.
- `pytest` F1 sink + F1 alert-source package + core recovery + core recovery security + phase4 harness + g15 host artifacts + L7u (delta privilege, recovery runtime contract, release builder, stage governance, upgrade engine) + L8p (owner runner, provisioning, attempt-2 reconciliation) + dnsmasq reboot/scope + L3/L4 V8 scope contract — pass: 1486 passed in 344.00s. The full suite was NOT run (no shared-runtime semantic change).
- `bash -n` on `p4-lib.sh`, `p4-stage-gate.sh`, `p4-f1-run-lib.sh`, `run-f1-owner.sh`, `stages/F1/{apply,verify,rollback}.sh`; `python3 -m py_compile` on `p4-f1-deploy.py` and the new test — pass.
- `git diff --check origin/main...HEAD` — pass. Main sync: `origin/main` stayed `e8efe3bb09d12ab8383bacdb77a9d2b7ccb139d8` (no merge needed).
- `node scripts/validate-vault.mjs` and the collaboration-policy check — see the PR body for the final results.
- Pre-ready review fixes — `pytest tests/test_pr11_phase4_f1_governed_stage.py` — pass: 111 passed (22 new/changed cases: no `core.env` digest/bytes persisted, in-memory preservation pass/refuse, injected concurrent-start race, exact `UnitFileState` incl. enabled/enabled-runtime/linked/masked, claim-boundary). Mutation check: removing the pre-start backend hook or loosening `UnitFileState` to "not enabled" makes the new tests fail (1 and 5 failures), then restored.
- Pre-ready review fixes — `pytest` F1 stage + F1 alert sink + F1 alert-source package + core alert ingress + core recovery + core recovery security + phase4 harness + L7u stage governance + L8p provisioning + dnsmasq scope + L3/L4 V8 scope contract — pass: 1136 passed in 296.32s. The earlier 1486 focused-overlap result stands as prior evidence (the fixes touch only F1 files and tests); full suite NOT run.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — new "IDEA3 F1 governed detector unit install/start stage — repository only" section (repository-only; nothing deployed).

## Shared surfaces touched

- `None` — all code is under `IDEA3-AEGIS_Lockdown/`; Obsidian paths are the IDEA3 owner's canonical note and the new receipt.

## Integration requests

- None — valid only when no cross-scope/shared path changed

## Known limitations

- Repository-level, hermetic proof only: the real systemd, `/etc/systemd/system`, the live Core and the alert socket were never exercised, and F1 was not run.
- The shared L0 capture does not record the detector unit file or its runtime state, so the PRE→POST compare (empty allow files) covers only other captured Core-host records; the unit is proven by the stage's own checks. Extending the capture is out of this task's smallest scope.
- Live use still needs the owner freeze workflow: frozen runner copy, fresh same-day `authorization-F1.txt` and `k3-F1.txt`, pinned main, pinned unit digest, and a clean pinned execution worktree (`Project-End-The-AEGIS-F1LIVE`).
- A naturally occurring REAL validated detector alert during the F1 window is an external production event: it is not accepted or proven by F1 and F1 never rolls back an incident. Between `daemon-reload` and the start the pre-start gate narrows, but cannot eliminate, a race with another actor; a refusal there fails closed.
- The detector is started but not enabled; persistence across reboot is not claimed. `F1_REAL_DETECTOR_ACCEPTANCE`, Recovery R1-R8, LVR, L8 and L9 remain unproven.
