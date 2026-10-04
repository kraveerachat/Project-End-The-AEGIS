---
title: Task Receipt — IDEA3 F1u post-F1 Core upgrade stage (repository only)
date: 2026-10-05T02:15:00+07:00
owner: music
area: idea3
branch: feat/idea3-f1u-post-f1-core-upgrade
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 F1u post-F1 Core upgrade stage (repository only)

> [!important] Repository implementation only. No Production mutation, no sudo, no Core restart, no detector action, no release built or installed, no authorization/K3 record, no frozen runner, no alert, no ESP32 action. F1u is a NEW governed successor stage; L8p, the F1i LIVE attempt, the F1r LIVE attempt and F1 attempt #2 are consumed and MUST NOT be rerun.

## Authoritative result fields

```text
F1U_STAGE_ID_OWNER_APPROVED=YES
R1A_STAGE_ID_OWNER_APPROVED=YES
F1U_DETECTOR_LIFECYCLE_AMENDMENT=OPTION_A
F1U_DETECTOR_DEPENDENCY_CYCLE_OWNER_APPROVED=YES
F1U_REPOSITORY_IMPLEMENTED=YES
F1U_LIVE_EXECUTED=NO
F1U_PRODUCTION_DEPLOYED=NO
R1A_REPOSITORY_IMPLEMENTED=NO
R1A_LIVE_EXECUTED=NO
F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN
R1_VERIFIED=NOT_CLAIMED
RECOVERY_R1_R8_PROVEN=NO
IGNORE_DEPENDENCIES_USED=NO
PRODUCTION_MUTATION_PERFORMED=NO
```

## What changed

- **Stage `F1u` registered after `F1`** (`P4_STAGES`, no repository gap, no extra authorization field) with its own handlers, `F1U-ATTEMPT-CONSUMED` marker, receipt gate, rollback contract and an inert owner runner (nine `PIN_` placeholders). `R1A` is NOT registered (no stage id, handler or runner).
- **Owned mutations (future live only):** install ONE new immutable release (reviewed installer, once); atomically switch `current` OLD -> NEW; restart `aegis-idea3-core.service` EXACTLY ONCE with the normal systemd restart; prove the restarted Core runs from the NEW release (working directory, not the pointer).
- **Detector lifecycle, owner amendment OPTION A (supersedes the earlier same-PID preservation requirement):** the detector unit `Requires=` the Core, so the normal restart makes systemd stop D1 and start a NEW D2 from the new release. No `--job-mode` override is used, the unit/`Requires=`/`After=` are untouched, no drop-in. The backend accepts only `systemctl show` of the two units and exactly `systemctl restart aegis-idea3-core.service` (zero explicit detector commands). D2 is proven: `D2 != D1`, newer start timestamp and monotonic start (never before the Core's), changed InvocationID when reported, identical unit bytes and pinned `production_detector.py` bytes, disabled, `Restart=no`, exactly one process, running from the NEW release, stable across reads and unchanged again at verify. `NRestarts` is a sanity value only.
- **Rollback:** before the restart: restore `current`, remove only the owned release (journaled tree digest), D1 untouched. After the restart: restore `current`, one more Core restart onto the OLD current release, the detector cycles again (D1 -> D2 -> D3) and is accepted only with the proofs, then the owned release is removed; unknown or foreign state escalates; no retry. The rolled-back Core runs the OLD current release, not necessarily the pre-F1u process image.
- **Predecessor gates (receipt content of the pinned commit):** one canonical F1 attempt #2 closeout receipt and one canonical PR #342 foundation receipt; zero, duplicate, split, malformed or contradictory receipts refuse; F1u is one-shot.
- **Comparator:** `current`, the Core and detector `MainPID`/`ExecMainStartTimestamp` and exactly one new release catalog entry (relational `stage F1u` rule plus runner value gates). The shared L0 capture now also records the detector unit (service state and unit file) so its bytes, `UnitFileState`, state, `Result` and `NRestarts` must stay identical. PRE->RB allows only the same four identity keys.
- **Release model:** the existing builder/guard/installer; the new release must carry the pinned `recovery_core.py` with `ALERT_ACCEPTED` and a `production_detector.py` byte-identical to `a91bcfc2…` (unchanged by this change); the runner proves every listed `aegis_soc/` file equals the pinned commit's blob.
- **Context only (not implemented):** independent R1A discovery found the `AEGIS_NEWCONN` firewall-log producer is not proven deployed; R1A needs a separate read-only host preflight after F1u and, if absent, a separately governed instrumentation stage.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-f1u-upgrade.py` — new tool (preflight/apply/verify/rollback, restricted backend).
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-f1u-run-lib.sh` — new gate library (marker, receipt gates, source gates, detector/Core gates, transition gates).
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-f1u-owner.sh` — new inert runner template (all pins `PIN_`).
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/F1u/` — `apply.sh`, `verify.sh`, `rollback.sh`, `allow-keys.txt`, `allow-keys-rollback.txt`, `allow-listeners.txt`.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-lib.sh`, `p4-stage-gate.sh`, `p4-compare.sh`, `p4-l0-capture.sh` — stage registration, no-extra-field rule, `stage F1u` release label, detector unit capture.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md` and `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-10-05-idea3-pr11-phase4-f1u-post-f1-core-upgrade.md` — documentation.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_f1u_stage.py` — new hermetic suite (288 tests).
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_harness.py`, `test_pr11_phase4_l7u_stage_governance.py`, `test_pr11_phase4_l8p_provisioning.py`, `test_r1_acceptance.py`, `test_pr11_phase4_dnsmasq_unit_repair_reboot_and_scope.py`, `test_pr11_phase4_l34_v8_scope_contract.py` — stage lists extended with `F1u`, the F1u handler set, and the shared-gate byte pins re-pinned for the four amended shared files (same re-pin precedent as the F1/F1i/F1r stage tasks).
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — canonical status.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-10-05_021500_music_idea3-f1u-post-f1-core-upgrade.md` — this immutable receipt.

## Verification evidence

- `pytest tests/test_pr11_phase4_f1u_stage.py` — pass: 288 passed (hermetic fake host and systemd model; the real backend allow-list stays in force).
- Source-mutation run against the F1u tool and library (44 mutations, including Option A lifecycle mutations: detector PID/start/InvocationID/runtime/unit/source/duplicate/stability checks, rollback cycle proofs, the job-mode override, allow-list widening, marker clobbering, receipt-gate weakening) — pass: 44 of 44 killed, 0 survivors.
- Overlap run (harness, L7u/L8p/R1/dnsmasq/F1/F1i/F1r/L6c/L34 V8 scope, release builder, F1u): 1561 passed; 8 failures were the shared-gate byte pins and are fixed by the re-pin (re-run: 446 passed in those three files); 2 failures are environmental (`test_the_detector_absent_gate_refuses_a_present_or_loaded_unit_via_stubbed_systemctl`, `test_the_shell_detector_gate_also_detects_a_standalone_process_while_the_unit_is_not_found`): this workstation is the real Core and `/etc/systemd/system/aegis-idea3-detector.service` exists on the host, so tests that assert host-level absence fail; they do not exercise any changed code.
- `ruff check` on the new tool and test — pass.
- `git diff origin/main` of `aegis_soc/production_detector.py`, `deploy/aegis-idea3-detector.service.example` and `deploy/aegis-idea3-core.service.example` — empty.
- `node scripts/validate-vault.mjs` — pass (two pre-existing owner-data Canvas warnings).
- `node scripts/validate-collaboration-policy.mjs --event <draft PR event> --changed-files <name-status of the 24 changed paths>` — pass.
- `git diff --check` — pass.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — F1u repository stage, owner amendment, claims boundary.

## Shared surfaces touched

- None outside the IDEA3 area. The four shared stage-gate files (`p4-lib.sh`, `p4-stage-gate.sh`, `p4-compare.sh`, `p4-l0-capture.sh`) are inside `IDEA3-AEGIS_Lockdown/` and their change is additive (registration, a stage label, one captured unit); owner review remains required.

## Integration requests

- None — no cross-scope or shared path changed; independent review of the F1u Draft PR is required before any F1u live authorization.

## Known limitations

- Documented-semantics model only: the detector restart propagation through `Requires=` is modelled from the systemd documentation and was NOT exercised on a live host; the live run proves it through the PRE/POST lifecycle checks and fails closed otherwise.
- A detector that does not come back after the Core restart (or after a rollback restart) is not started by F1u (no explicit detector command, and a `try-restart` never starts an inactive unit): the stage fails closed and escalates; the owner must decide a separate governed action.
- During the restart window the detector is stopped with the Core; alerts during that window are lost by design.
- Rollback restores the OLD current release for the Core, which has never run as the Core process image before; it cannot recreate the pre-F1u process image.
- Nothing was built, installed, authorized or run live; `F1U_LIVE_EXECUTED=NO`.
