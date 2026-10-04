---
title: Task Receipt — IDEA3 R1I input instrumentation
date: 2026-10-05T04:45:41+07:00
owner: music
area: idea3
branch: feat/idea3-r1a-input-instrumentation-prep
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 R1I input instrumentation

## What changed

- Registered the owner-approved `R1I` Phase-4 stage after `F1u` and before the still-unregistered `R1A` stage.
- Finalized repository-only logging instrumentation for `inet aegis_idea3_r1i`, with input and forward hooks at priority `-10`, exact initial-SYN matching, and bounded `50/second burst 60 packets` logging.
- Added guarded apply, verify, rollback, owner-run template, stage allow-list surfaces, design specification, focused tests, and fail-closed ownership checks.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/r1i-input-instrumentation/` — stage-owned implementation, nft template, apply, verify, rollback, and owner-run template.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/R1I/` — first-class Phase-4 wrappers and allow-list surfaces.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-r1i-owner.sh` — pinned inert owner-run template.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-lib.sh` — additive R1I registration and stage gap contract.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md` — lifecycle order documentation.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-f1u-owner.sh` — lifecycle order documentation.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-f1u-upgrade.py` — lifecycle order documentation.
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-10-05-idea3-r1a-input-instrumentation-design.md` — finalized R1I design contract.
- `IDEA3-AEGIS_Lockdown/tests/r1i/test_r1i_input_instrumentation.py` — focused R1I and mutation-safety tests.
- `IDEA3-AEGIS_Lockdown/tests/test_r1_acceptance.py` — R1I registration and R1A non-registration contract.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_f1u_stage.py` — lifecycle order expectation.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_harness.py` — registered handler set expectation.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_dnsmasq_unit_repair_reboot_and_scope.py` — updated shared-library pin for the additive registry change.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-moc.md` — current R1I checkpoint.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — durable R1I repository status.

## Verification evidence

- `git fetch origin && git rev-parse origin/main` — pass: `3cfa72a0557ed13e5e432c1314d7eca5a5918423`; the main delta from the prep base had no R1I path overlap.
- `/usr/bin/python3 -m pytest -q tests/r1i/test_r1i_input_instrumentation.py tests/test_r1_acceptance.py tests/test_pr11_phase4_harness.py::test_only_reviewed_stage_handlers_are_registered tests/test_pr11_phase4_f1u_stage.py::test_f1u_is_registered_exactly_once_after_f1_and_r1a_is_not_registered tests/test_pr11_phase4_dnsmasq_unit_repair_reboot_and_scope.py::test_reused_shared_files_and_the_v8_handlers_are_byte_identical` — pass: `107 passed`.
- `bash -n` on all R1I implementation, registered wrapper, and owner-run shell files — pass.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` — pass with 2 pre-existing canvas owner-data warnings.
- `git diff --check` — pass.
- Broad selected Phase-4 aggregate — partial: R1I/R1/harness tests passed; inherited L7 fixture tests failed in this sandbox at `os.chown` with `EINVAL`, and are unrelated to R1I.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-moc.md` — added the current R1I registration and repository-only checkpoint.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — added the implemented/not-live/not-deployed R1I status and limitations.

## Shared surfaces touched

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-lib.sh` — shared Phase-4 registry now exposes the owner-approved R1I stage.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_harness.py` — shared harness registration contract includes R1I.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_dnsmasq_unit_repair_reboot_and_scope.py` — shared-path integrity pin reflects the additive registry change.
- `IDEA3-AEGIS_Lockdown/tests/test_r1_acceptance.py` — merged R1 acceptance contract records R1I registered and R1A unregistered.

## Integration requests

- Kla/integration reviewer: review the additive `p4-lib.sh` stage registry and shared R1 acceptance contract; confirm R1I remains between F1u and future R1A, with no Recovery or containment ownership change. Rollback is removal of only the R1I commit and, when later operated, the exact stage-owned nft table.

## Known limitations

- `R1I_LIVE_EXECUTED=NO` and `R1I_PRODUCTION_DEPLOYED=NO`; no live nft mutation, traffic generation, alert, incident, Core/detector restart, Recovery, or ESP32 action occurred.
- The repository proves the intended kernel-origin logging design, not a live kernel producer. `F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN`, `R1_VERIFIED=NOT_CLAIMED`, and `RECOVERY_R1_R8_PROVEN=NO`.
- The broad aggregate includes inherited sandbox-sensitive L7 setup errors; no R1I test failed in the focused rerun.
