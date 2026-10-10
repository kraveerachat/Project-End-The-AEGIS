---
title: Task Receipt — IDEA3 ICu offline readiness contract
date: 2026-10-11T00:00:26+07:00
owner: music
area: idea3
branch: feat/idea3-icu-governed-core-upgrade
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 ICu offline readiness contract

## What changed

- Continued from merged main `ca7f66f56626b6ab396566ce891baef7b1e60cdc` in a new isolated worktree at `/tmp/aegis-idea3-icu-governed-core-upgrade`.
- Added an offline-only ICu readiness evaluator. It checks the exact OLD/NEW release IDs and digests, installed Core/Detector unit and drop-in evidence, the inactive/dead/disabled/PID 0 Detector baseline, separate authority fields, an unused one-attempt marker/journal declaration, the design-approved exact-release rollback target, full PRE/POST preservation snapshots, and prohibited effects.
- Synthetic systemd restart PASS is not accepted as proof of installed-unit behavior. Even evidence labelled as an actual installed-unit observation remains unauthenticated input. The evaluator always returns `LIVE_EXECUTOR=BLOCKED`, `attempt_marker_may_be_consumed=false`, and `production_mutation_allowed=false`.
- ICu remains unregistered. No persistent marker or journal writer, frozen runner, authorization parser, host executor, or Recovery gate was added. This is partial readiness implementation; it is not a live-capable ICu stage.
- No release was rebuilt. No Production, systemd, Core, Detector, firewall, network, MQTT, relay, hardware, CTu/CTv marker, Recovery, CUT, RESTORE, or ISOLATE action occurred.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/inactive-core-successor/inactive_core_successor_contract.py` — offline ICu readiness evidence validator.
- `IDEA3-AEGIS_Lockdown/tests/test_icu_readiness_contract.py` — tests for synthetic restart rejection, installed unit and Detector evidence shape, authority/attempt gates, exact rollback, preservation, and fail-closed drift.
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-10-10-idea3-inactive-core-successor-design.md` — reconciled scope and limits with the offline validator; operational runner and marker/journal remain unimplemented.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — updated current task, branch, evidence, and remaining blockers.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-10-10_235941_music_idea3-icu-readiness-contract.md` — this immutable receipt.

All paths are inside the IDEA3 boundary. Shared surfaces touched: **None**.

## Verification evidence

- From `IDEA3-AEGIS_Lockdown/`: `PYTHONDONTWRITEBYTECODE=1 /home/kittipat/.venvs/aegis-idea3-core/bin/python -m pytest -p no:cacheprovider -q tests/test_icu_readiness_contract.py tests/test_inactive_core_successor_pinned_evidence.py tests/test_inactive_core_successor_contract.py` — **PASS, 43 passed**.
- From `IDEA3-AEGIS_Lockdown/`: `ruff check deploy/pr11-phase4/inactive-core-successor/inactive_core_successor_contract.py tests/test_icu_readiness_contract.py --no-cache` — **PASS**.
- Python `ast.parse` on the evaluator and new test — **PASS**.
- From repository root: `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` — **PASS with two pre-existing canvas owner-data warnings**.
- `git diff --check` — **PASS**.
- The existing candidate was not rebuilt; supplied sums/manifest pins were previously locally hashed and matched in PR #429. Full release guard/runtime closure remains owner-reported, not rerun here.
- No full IDEA3 suite or Production/systemd check was run. This worktree has no Production host evidence; no service lifecycle command was invoked.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md`.
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-10-10-idea3-inactive-core-successor-design.md`.

## Shared surfaces touched

- None — all changes remain within IDEA3.

## Integration requests

- Request independent GitHub Security/Governance and IDEA3 functional review of the exact new PR head. Review exact release pins, unit/drop-in evidence, authority separation, one-shot/journal contract, rollback limits, service preservation, synthetic-versus-installed systemd evidence, and the permanent refusal behavior.
- Human owner must decide any merge. Future live work needs fresh read-only host evidence, a separately reviewed persistent one-attempt marker/journal and frozen runner, proof of the installed-unit inactive-Detector restart consequence, and separate live upgrade/rollback authority. Recovery remains separately unauthorized.
- Before merging, complete the repository PR reviewer checklist; no merge or Ready transition is requested in this task handoff.

## Known limitations

- Actual effect of plain `systemctl restart aegis-idea3-core.service` on the installed inactive Detector is **NOT PROVEN**. The synthetic user-systemd restart-preservation result does not prove Production behavior. LIVE remains **BLOCKED**.
- The OLD rollback release verifier/count/digests are owner-attested and the artifact was unavailable for independent local reinspection. The NEW candidate was not rebuilt; full verifier/runtime-closure PASS is owner-reported.
- This offline evaluator does not implement a durable global marker or journal, exact-main frozen runner, authority parser, live apply/verify/rollback, or closeout. `ICu` is not registered. `READY_FOR_LIVE=NO`.
- CTu and CTv remain immutable consumed FAIL; Recovery remains separately blocked and unauthorized.
- Purple Desktop Manual CUT remains disabled/unconfigured. A separate deployment task requires a dedicated pre-provisioned Core-owned socket directory (tmpfiles rule), a transport group, a Core systemd drop-in with `SupplementaryGroups` and `ReadWritePaths`, the configured non-root operator UID, and a reviewed Purple Desktop launcher that uses `LocalCutController` instead of the legacy GUI's direct MQTT controller. No dependency above is delivered or enabled by this task.
