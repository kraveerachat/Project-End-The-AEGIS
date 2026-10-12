---
title: Task Receipt — IDEA3 ICu restart evidence integration
date: 2026-10-11T02:56:38+07:00
owner: music
area: idea3
branch: feat/idea3-icu-evidence-review
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 ICu restart evidence integration

Final implementation/evidence checkpoint: `e38de8e6` (following `801c0a31`).
Base: merged PR #431 at `52afbf16a4094b81ed03a0c8847d7e038af9bb3e`.

## What changed

- The existing ICu executor verifies exact archived installed-unit observation bytes, Core PID transition, inactive Detector, unchanged release/shared services, and installed-unit digest before marker consumption. It pins the observation digest in the frozen runner, Authorization/K3, and journal, then rechecks before the marker and a rollback restart.
- The freeze and executor derive the exact current main from the clean executing checkout with PR #431 ancestry. There is no caller-selected revision override.
- The supplied four-file archive lacks the PRE/POST unit captures and restart result needed to pass the new gate. It remains `PASS_LOCAL` as reported, but cannot independently unlock LIVE.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/icu_runner_freeze.py` — derive exact main and pin verified archive digest.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/inactive-core-successor/inactive_core_successor_contract.py` — validate the structured local observation claim.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-icu-owner.sh` — verify archive and authority pins before one-attempt marker.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-icu-upgrade.py` — check archived bytes, provenance, preflight, and journal pins.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-lib.sh` — add ICu observation authority field.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-stage-gate.sh` — validate matching ICu Authorization/K3 observation digest.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/ICu/rollback.sh` — recheck pinned observation and unit digest before rollback restart.
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-10-10-idea3-inactive-core-successor-design.md` — reflect the implemented archive gate and evidence limit.
- `IDEA3-AEGIS_Lockdown/tests/test_icu_readiness_contract.py` — focused observation contract regressions.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_icu_executor.py` — focused freeze, archive, authority, journal, and rollback regressions.
- `IDEA3-AEGIS_Lockdown/tests/fixtures/icu-restart-observation/detector-lifecycle-window.log` — exact bounded Detector log fixture.
- `IDEA3-AEGIS_Lockdown/tests/fixtures/icu-restart-observation/systemd-manager-events.log` — exact bounded manager log fixture.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — current task and partial evidence state.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-10-11_025638_music_idea3-icu-restart-evidence.md` — this immutable partial task receipt.

## Verification evidence

- `PYTHONDONTWRITEBYTECODE=1 /home/kittipat/.venvs/aegis-idea3-core/bin/python -m pytest -p no:cacheprovider -q tests/test_pr11_phase4_icu_executor.py tests/test_icu_readiness_contract.py` (from `IDEA3-AEGIS_Lockdown/`) — pass: 29 focused offline tests.
- `bash -n IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-icu-owner.sh IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-lib.sh IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-stage-gate.sh IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/ICu/rollback.sh` — pass.
- `/home/kittipat/.venvs/aegis-idea3-core/bin/python -m ruff check --select I,F IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/icu_runner_freeze.py IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-icu-upgrade.py IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/inactive-core-successor/inactive_core_successor_contract.py IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_icu_executor.py IDEA3-AEGIS_Lockdown/tests/test_icu_readiness_contract.py` — pass.
- `python3 IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-icu-upgrade.py check-restart-observation --path /home/kittipat/Workspace/idea3-p4-evidence/icu-restart-observation-EpXVDDsV --unit-snapshot-sha256 <64-b> --expected-observation-sha256 <64-e>` — expected refusal: exit 1, `ICU_RESTART_OBSERVATION_INCOMPLETE` before digest use.
- `git diff --cached --check` and `git diff --check` — pass on implementation paths; final scope check pending PR review.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — PR #431 merged baseline, ICu-S4 partial archive state, exact checkpoint, and LIVE blocker.

## Shared surfaces touched

None — all changed paths belong to IDEA3 code, tests, design, or task status/receipt.

## Integration requests

- Independent Security/Governance and functional reviewers must inspect the scoped PR and tick its GitHub Reviewer Checklist. The owner must decide whether a complete, authentic archived capture exists. A later LIVE attempt needs separate Core-upgrade Authorization/K3 and fresh host preflight; rollback remains limited to the exact OLD release and one Core restart. No merge or LIVE action is authorized by this receipt.

## Known limitations

- The supplied directory has only four files; archived PRE/POST Core and Detector `systemctl show`, restart exit status, and historical installed-unit snapshot are absent. No second Production restart or repeated host test was performed. Freeze and executor correctly refuse the incomplete archive.
- PR and CI review are pending. `READY_FOR_HUMAN_MERGE=NO`; `READY_FOR_LIVE=NO`.
