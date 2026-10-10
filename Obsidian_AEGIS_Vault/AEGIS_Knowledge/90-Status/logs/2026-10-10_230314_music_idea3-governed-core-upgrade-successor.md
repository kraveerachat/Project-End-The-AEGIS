---
title: Task Receipt — IDEA3 governed inactive-detector Core upgrade successor
date: 2026-10-10T23:03:14+07:00
owner: music
area: idea3
branch: feat/idea3-governed-core-upgrade-successor
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 governed inactive-detector Core upgrade successor

## What changed

- Recorded the owner’s approval of OLD release `954ce1c191885e9e90198a6f54a3d990bcf144fc` as an `EXACT_RELEASE` rollback target for design only. Rollback execution and Core upgrade authorization remain **NO**.
- Bound the current OLD/NEW evidence pins in the pure offline checker and identified `ICu` as a proposed unique successor stage. `ICu` is not registered and has no live executor.
- Specified read-only preflight, exact release pins, inactive Detector PRE/POST, one-attempt marker and write-ahead journal, exact-release rollback, Core-only mutation allowlist, service preservation, and separate Security/Governance and human execution approval.
- Unknown systemd restart effects fail closed before release installation or pointer switch. CTu/CTv and Recovery authority remain unchanged.

## Source files changed

- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-10-10-idea3-inactive-core-successor-design.md` — updated exact owner-approved design pins and remaining ICu contract/blockers.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/inactive-core-successor/inactive_core_successor_contract.py` — added a pure pinned-evidence assessment and explicit proposed-stage contract; the executor remains blocked.
- `IDEA3-AEGIS_Lockdown/tests/test_inactive_core_successor_pinned_evidence.py` — new focused tests for owner-design-only approval, release pin mismatches, inactive Detector preservation, unknown systemd effect, Recovery separation, and forbidden effects.
- `IDEA3-AEGIS_Lockdown/tests/test_inactive_core_successor_contract.py` — updated stale blocker expectation for newly supplied owner-attested OLD release evidence.
- `IDEA3-AEGIS_Lockdown/doc/Content/04_SESSION_HANDOFF.md` — active task, evidence boundary, and live blocker.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — current task register and outcome.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-10-10_230314_music_idea3-governed-core-upgrade-successor.md` — this immutable task receipt.

All changed paths are within IDEA3 code or IDEA3 canonical knowledge. Shared surfaces touched: **None**. No IDEA1, IDEA2, Production configuration, F1u/R1Du authority, frozen runner, CTu/CTv record/marker, or Recovery gate was changed.

## Evidence assessment

- OLD release ID, verifier PASS, count 54, sums digest `9b2faeb4f44225bcf38ba6df5b5403e014998c7310e7c04a77c30c03f2d177df`, and manifest digest `732d6af5afb0451e51655078abd8c6dc04a72ed258fb04e79c806210f2002a18` are owner-attested. The release guard defines sums as a sorted, complete content index; this digest is the design’s content-index/tree pin. The OLD artifact itself is absent from this repository/workspace, so it was not independently re-inspected here. A fresh read-only installed-path guard remains a live preflight requirement.
- NEW release ID `idea3-core-728c2d9b-20261010`, source main `728c2d9b56d2d8b0b5933202ca20f45e6687602b`, count 55, and owner-reported verifier/runtime closure PASS are recorded. The existing candidate was not rebuilt. Local `sha256sum` of its existing `RELEASE-SHA256SUMS` and `RELEASE-MANIFEST.json` matched the supplied digests; the manifest identifies the source main and count. Full release verification was not repeated.
- Supplied systemd evidence records Detector `Requires=Core` and `After=Core`. Actual effect of a plain Core restart on an inactive Detector is **NOT PROVEN**. The installed unit/drop-in hashes and a safe effect contract are required before any executor can be implemented.

## Verification evidence

- From `IDEA3-AEGIS_Lockdown/`: `PYTHONDONTWRITEBYTECODE=1 /home/kittipat/.venvs/aegis-idea3-core/bin/python -m pytest -p no:cacheprovider -q tests/test_inactive_core_successor_pinned_evidence.py tests/test_inactive_core_successor_contract.py` — pass: **40 passed**. The earlier checker tests were included because this change updates their stale blocker result.
- From `IDEA3-AEGIS_Lockdown/`: `ruff check deploy/pr11-phase4/inactive-core-successor/inactive_core_successor_contract.py tests/test_inactive_core_successor_pinned_evidence.py --no-cache` — pass.
- From `IDEA3-AEGIS_Lockdown/`: Python `ast.parse` of the checker — pass.
- Targeted read-only `sha256sum` of existing NEW candidate `RELEASE-SHA256SUMS` and `RELEASE-MANIFEST.json` — pass; both matched owner-supplied digests. `wc -l` reports 56 checksum entries; manifest file_count is 55.
- `git diff --check` — pass.
- From repository root: `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` — pass with two pre-existing canvas owner-data warnings.
- Final Draft PR policy and CI checks — pending remote PR.
- No release rebuild, Production/Core/Detector action, marker change, Recovery action, network change, MQTT publish, CUT, RESTORE, or ISOLATE was performed.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — owner-attested design approval and current blockers.
- `IDEA3-AEGIS_Lockdown/doc/Content/04_SESSION_HANDOFF.md` — current task continuation.

## Shared surfaces touched

- None — task stayed inside the selected IDEA3 area.

## Integration requests

- Request independent Security/Governance review and IDEA3 functional review of the exact Draft PR HEAD, including the distinction between design approval and live authority, the release-index pin semantics, and the fail-closed systemd dependency behavior.
- Human owner handles any merge and any later live authorization. Recovery authority remains separate and ungranted.

## Known limitations

- OLD release artifact was not available for independent local reinspection; its `PASS` and digest values are owner-attested. The NEW candidate’s exact sums/manifest files were hashed, but its owner-reported full release verifier/runtime closure was not rerun.
- Actual behavior of systemd restart with the Detector inactive remains not proven. This is a hard blocker: no live-capable executor, stage registration, pointer switch, or restart may proceed while unknown.
- Fresh host PRE/POST evidence, installed unit/drop-in digests, new ICu attempt authority and journal implementation, exact-head independent review, and human execution authorization remain outstanding.
- CTu/CTv remain `FAIL_IMMUTABLE_CONSUMED`; Recovery remains unauthorized; physical containment is not proven.
