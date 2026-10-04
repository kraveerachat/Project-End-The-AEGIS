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
- Finalized repository-only logging instrumentation for `inet aegis_idea3_r1i`, with an INPUT-only hook at priority `-10` (the forward hook was removed after independent review: no detector/R1 contract needs transit traffic and it would feed browsing into the detector), an IPv4-only (`meta nfproto ipv4`) exact initial-SYN match, and bounded `50/second burst 60 packets` logging.
- Review repair: atomic `create table` batch (no check-then-act merge), bounded post-apply failure model (`ROLLED_BACK_EXACT_OWNED_STATE` or `MANUAL_CLEANUP_REQUIRED`, attempt stays consumed), exact-shape `validate-state` (rejects counter/mark/extra rules/chains/trailing content), observed-only `VERIFIED_` output with `EXPECTED_`/`DESIGN_` for intent, and a sanitized committed fixture replacing the machine-local live-dump test dependency.
- Added guarded apply, verify, rollback, owner-run template, stage allow-list surfaces, design specification, focused tests, and fail-closed ownership checks.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/r1i-input-instrumentation/` — stage-owned implementation, nft template, apply, verify, rollback, and owner-run template.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/R1I/` — first-class Phase-4 wrappers and allow-list surfaces.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-r1i-owner.sh` — pinned inert owner-run template.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-lib.sh` — additive R1I registration and stage gap contract.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md` — lifecycle order documentation.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-f1u-owner.sh` — lifecycle order documentation.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-f1u-upgrade.py` — lifecycle order documentation.
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-10-05-idea3-r1i-input-instrumentation-design.md` — finalized R1I design contract.
- `IDEA3-AEGIS_Lockdown/tests/r1i/` — focused R1I tests, real-nft private-namespace tests, and the sanitized FIXTURE-authority L2 hook facts.
- `IDEA3-AEGIS_Lockdown/tests/test_r1_acceptance.py` — R1I registration and R1A non-registration contract.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_f1u_stage.py` — lifecycle order expectation.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_harness.py` — registered handler set expectation.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_dnsmasq_unit_repair_reboot_and_scope.py` — updated shared-library pin for the additive registry change.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-moc.md` — current R1I checkpoint.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — durable R1I repository status.

## Verification evidence

- `git fetch origin && git rev-parse origin/main` — pass: `3cfa72a0557ed13e5e432c1314d7eca5a5918423`; main merged normally (no rebase, no force push) so the already-merged F1u closeout receipt `2026-10-05_041108_music_idea3-f1u-live-closeout.md` is preserved.
- `/usr/bin/python3 -m pytest -q tests/r1i tests/test_r1_acceptance.py tests/test_pr11_phase4_harness.py tests/test_pr11_phase4_f1u_stage.py tests/test_pr11_phase4_dnsmasq_unit_repair_reboot_and_scope.py` (full files) — pass: `809 passed`.
- Mutation checks (apply: flush instead of delete, unvalidated recovery, `add table` instead of `create table`, non-atomic `mv`, dropped recovery call; validator: removed length check) — each is caught by a test after adding trailing-content cases.
- Atomic-create proof: local nft 1.1.7 inside a private `unshare -rn` namespace (never the host): second `create table` fails `File exists` and the ruleset is unchanged. This is local evidence; real Production nft normalization remains a LIVE-preflight proof, not claimed.
- `bash -n` on all R1I shell files and `py_compile` — pass. `git diff --check` — pass.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` — pass with 2 pre-existing canvas owner-data warnings.
- Collaboration policy validator against the real PR event/body — see PR checks.

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
- The repository proves the intended kernel-origin logging design, not a live kernel producer, and has not observed trusted kernel acceptance. `F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN`, `R1_VERIFIED=NOT_CLAIMED`, and `RECOVERY_R1_R8_PROVEN=NO`.
- **Claim boundary (durable):**
  - `R1I_REPOSITORY_IMPLEMENTED=YES`
  - `R1I_LIVE_EXECUTED=NO`
  - `R1I_PRODUCTION_DEPLOYED=NO`
  - `PRODUCTION_NFT_NORMALIZATION=NOT_PROVEN`
  - `F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN`
  - `R1_VERIFIED=NOT_CLAIMED`
  - `RECOVERY_R1_R8_PROVEN=NO`
- Production nft normalization of the installed state remains a LIVE-preflight proof. It has NOT been proven by repository tests or by the private-namespace (`unshare -rn`, local nft 1.1.7) runs, which are local evidence only. Trusted kernel acceptance has not been observed.
