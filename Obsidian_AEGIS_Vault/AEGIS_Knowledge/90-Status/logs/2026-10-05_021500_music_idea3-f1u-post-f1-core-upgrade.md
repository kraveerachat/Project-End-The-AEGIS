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
F1U_ROLLBACK_CLASSES=EXACT_PROCESS|EXACT_RELEASE|SAFE_EQUIVALENT
PRODUCTION_MUTATION_PERFORMED=NO
```

## What changed

- **Stage `F1u` registered after `F1`** (`P4_STAGES`, no repository gap, no extra authorization field) with its own handlers, `F1U-ATTEMPT-CONSUMED` marker, receipt gate, rollback contract and an inert owner runner (nine `PIN_` placeholders). `R1A` is NOT registered (no stage id, handler or runner).
- **Owned mutations (future live only):** install ONE new immutable release (reviewed installer, once); atomically switch `current` OLD -> NEW; restart `aegis-idea3-core.service` EXACTLY ONCE with the normal systemd restart; prove the restarted Core runs from the NEW release (working directory, not the pointer).
- **Detector lifecycle, owner amendment OPTION A (supersedes the earlier same-PID preservation requirement):** the detector unit `Requires=` the Core, so the normal restart makes systemd stop D1 and start a NEW D2 from the new release. No `--job-mode` override is used, the unit/`Requires=`/`After=` are untouched, no drop-in. The backend accepts only `systemctl show` of the two units and exactly `systemctl restart aegis-idea3-core.service` (zero explicit detector commands). D2 is proven: `D2 != D1`, newer start timestamp and monotonic start (never before the Core's), changed InvocationID when reported, identical unit bytes and pinned `production_detector.py` bytes, disabled, `Restart=no`, exactly one process, running from the NEW release, stable across reads and unchanged again at verify. `NRestarts` is a sanity value only.
- **Rollback:** before the restart: restore `current`, remove only the owned release (journaled tree digest), D1 untouched. After the restart: restore `current`, then BEFORE any rollback Core restart re-prove the detector authority (loaded unit path, no drop-in, unit digest, disabled, `Restart=no`, one process running the pinned source when active; a foreign state refuses with zero restarts, so the rollback restart can never cycle a foreign detector) and the Core equivalence; only then one more Core restart onto the OLD current release (the detector cycles again, D1 -> D2 -> D3, accepted only with the proofs), then the owned release is removed. An inactive detector is permitted (the restart never starts it, no explicit detector command) and the post-check escalates; no retry.
- **Running-Core runtime (review round 2):** PRE `current` = `c2238375…`, PRE running Core = `55c7d181…`, PRE detector = `c2238375…`. The running release is now recorded explicitly (journal and L0 capture: `host.aegis_idea3.recovery.core.runtime_cwd`, `host.aegis_idea3.alert.detector.runtime_cwd`), never inferred from `current`. The rollback restart lands the Core on `c223…`, which is NOT the PRE running release, so the class is declared honestly: `EXACT_PROCESS` (Core never replaced; the only exact PRE restoration), `EXACT_RELEASE`, or `SAFE_EQUIVALENT` after a MACHINE proof (both releases pass the release guard; same python version, requirements digest, file set and count; every payload digest identical except `RELEASE-MANIFEST.json` and `aegis_soc/production_detector.py`; manifest differs only in `release_id`/`source_git_sha`; no other module references the detector). Preflight refuses when no proof exists and the proof is re-run before the rollback restart. Verified read-only against the real installed `55c7…` and `c223…` releases: exactly those two entries differ. The comparator approves the runtime keys by key only (PRE->RB) and the runner gates prove the exact values; a rollback PASS is never reported as exact PRE restoration unless the Core process was never replaced.
- **Execution boundary (review round 3):** preflight journals the reviewed tree-state digest of the OLD current release and of the PRE running-Core release. Immediately before the ONE forward restart F1u re-proves `current` = NEW, the NEW guard/id/source/detector/Core digests (+ `ALERT_ACCEPTED`) and the journaled NEW tree digest (zero restarts otherwise). Immediately before ANY rollback Core restart, for every class, it re-proves `current` = OLD, the OLD release authority (guard, id, pinned detector digest) and that the OLD and PRE trees equal the baselines; only then the SAFE_EQUIVALENT proof is re-run on those unchanged trees (the proof alone cannot authorize executing the OLD detector). `EXACT_RELEASE` means identical release content, not path equality. A changed or foreign NEW/OLD release or detector can never execute.
- **Predecessor gates (receipt content of the pinned commit):** one canonical F1 attempt #2 closeout receipt and one canonical PR #342 foundation receipt; zero, duplicate, split, malformed or contradictory receipts refuse; F1u is one-shot.
- **Comparator:** `current`, the Core and detector `MainPID`/`ExecMainStartTimestamp` and exactly one new release catalog entry (relational `stage F1u` rule plus runner value gates). The shared L0 capture now also records the detector unit (service state and unit file) so its bytes, `UnitFileState`, state, `Result` and `NRestarts` must stay identical. PRE->RB allows only the same identity keys (Core/detector process identity and running-release identity), with the exact values proven by the runner gates.
- **Release model:** the existing builder/guard/installer; the new release must carry the pinned `recovery_core.py` with `ALERT_ACCEPTED` and a `production_detector.py` byte-identical to `a91bcfc2…` (unchanged by this change); the runner proves every listed `aegis_soc/` file equals the pinned commit's blob.
- **Context only (not implemented):** independent R1A discovery found the `AEGIS_NEWCONN` firewall-log producer is not proven deployed; R1A needs a separate read-only host preflight after F1u and, if absent, a separately governed instrumentation stage.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-f1u-upgrade.py` — new tool (preflight/apply/verify/rollback, restricted backend).
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-f1u-run-lib.sh` — new gate library (marker, receipt gates, source gates, detector/Core gates, transition gates).
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-f1u-owner.sh` — new inert runner template (all pins `PIN_`).
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/F1u/` — `apply.sh`, `verify.sh`, `rollback.sh`, `allow-keys.txt`, `allow-keys-rollback.txt`, `allow-listeners.txt`.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-lib.sh`, `p4-stage-gate.sh`, `p4-compare.sh`, `p4-l0-capture.sh` — shared Phase-4 harness: stage registration, no-extra-field rule, `stage F1u` release label, detector unit capture and running Core/detector release capture.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md` and `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-10-05-idea3-pr11-phase4-f1u-post-f1-core-upgrade.md` — documentation.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_f1u_stage.py` — new hermetic suite (352 tests).
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_harness.py`, `test_pr11_phase4_l7u_stage_governance.py`, `test_pr11_phase4_l8p_provisioning.py`, `test_r1_acceptance.py`, `test_pr11_phase4_dnsmasq_unit_repair_reboot_and_scope.py`, `test_pr11_phase4_l34_v8_scope_contract.py` — stage lists extended with `F1u`, the F1u handler set, and the shared-gate byte pins re-pinned for the four amended shared files (same re-pin precedent as the F1/F1i/F1r stage tasks).
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — canonical status.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-10-05_021500_music_idea3-f1u-post-f1-core-upgrade.md` — this immutable receipt.

## Verification evidence

- `pytest tests/test_pr11_phase4_f1u_stage.py` — pass: 352 passed (hermetic fake host and systemd model; the real backend allow-list stays in force). Includes the new safe-equivalence, rollback-class, running-runtime and pre-restart foreign-detector tests (tampered unit, new drop-in, wrong `Restart=`, duplicate detector, wrong source digest, enabled unit, unloaded unit: each blocks the rollback Core restart with zero restarts).
- Source-mutation run against the F1u tool and library (79 mutations, including the Option A lifecycle checks, the equivalence proof, the pre-restart detector authority, the rollback class, the runtime gates and the final NEW/OLD release re-proofs and tree baselines) — pass: 79 of 79 killed, 0 survivors.
- Read-only audit of the real installed releases `55c7d181…` and `c2238375…` through the new proof: pass — only `RELEASE-MANIFEST.json` and `aegis_soc/production_detector.py` differ; the other installed releases are refused.
- Overlap run (harness, L7u/L8p/R1/dnsmasq/F1/F1i/F1r/L6c/L34 V8 scope, release builder, F1u): 1633 passed, 2 failed. The 2 failures (`test_the_detector_absent_gate_refuses_a_present_or_loaded_unit_via_stubbed_systemctl`, `test_the_shell_detector_gate_also_detects_a_standalone_process_while_the_unit_is_not_found`) reproduce identically on pristine `origin/main` `9cebd2a0` (re-run in a temporary detached worktree: same 2 failed, 298 passed): this workstation is the real Core and the detector unit is installed on the host. The shared-gate byte pins are re-pinned for the amended `p4-l0-capture.sh`.
- `ruff check` on the new tool and test — pass.
- `git diff origin/main` of `aegis_soc/production_detector.py`, `deploy/aegis-idea3-detector.service.example` and `deploy/aegis-idea3-core.service.example` — empty.
- `node scripts/validate-vault.mjs` — pass (two pre-existing owner-data Canvas warnings).
- `node scripts/validate-collaboration-policy.mjs --event <draft PR event> --changed-files <name-status of the 24 changed paths>` — pass.
- `git diff --check` — pass.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — F1u repository stage, owner amendment, claims boundary.

## Shared surfaces touched

- Shared IDEA3 Phase-4 harness surfaces (additive; every stage uses them; they sit inside `IDEA3-AEGIS_Lockdown/`, so no other area's files changed): `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-lib.sh` (stage registration), `p4-stage-gate.sh` (F1u no-extra-field rule), `p4-compare.sh` (`stage F1u` release label), `p4-l0-capture.sh` (detector unit and running Core/detector release identity), and the shared stage-list tests and shared-gate byte-pin tests (`test_pr11_phase4_harness.py`, `test_pr11_phase4_l7u_stage_governance.py`, `test_pr11_phase4_l8p_provisioning.py`, `test_r1_acceptance.py`, `test_pr11_phase4_dnsmasq_unit_repair_reboot_and_scope.py`, `test_pr11_phase4_l34_v8_scope_contract.py`, re-pinned). Functional-owner and independent review required.

## Integration requests

- None outside the IDEA3 area; independent review of the shared Phase-4 harness changes and of the F1u Draft PR is required before any F1u live authorization.

## Known limitations

- Documented-semantics model only: the detector restart propagation through `Requires=` is modelled from the systemd documentation and was NOT exercised on a live host; the live run proves it through the PRE/POST lifecycle checks and fails closed otherwise.
- A detector that does not come back after the Core restart (or after a rollback restart) is not started by F1u (no explicit detector command, and a `try-restart` never starts an inactive unit): the stage fails closed and escalates; the owner must decide a separate governed action.
- During the restart window the detector is stopped with the Core; alerts during that window are lost by design.
- A rollback after the restart cannot recreate the pre-F1u process image: the Core is restarted onto the OLD current release (`c223…`), never the PRE running release (`55c7…`). It is accepted only as `SAFE_EQUIVALENT` after the machine proof and is never reported as exact restoration; `c223…` has never run as the Core in Production (the proof covers its code, interpreter and requirements, not runtime behavior).
- Nothing was built, installed, authorized or run live; `F1U_LIVE_EXECUTED=NO`.
