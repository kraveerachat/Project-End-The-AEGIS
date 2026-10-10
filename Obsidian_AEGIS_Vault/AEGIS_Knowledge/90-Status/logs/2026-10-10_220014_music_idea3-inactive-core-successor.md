---
title: Task Receipt — IDEA3 inactive-detector Core upgrade successor
date: 2026-10-10T22:00:14+07:00
owner: music
area: idea3
branch: feat/idea3-inactive-core-successor-contract
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 inactive-detector Core upgrade successor

## What changed

- Added an IDEA3-only successor design, pure in-memory contract checker, and focused deterministic tests.
- Added no live-capable executor, runner, marker, journal, authorization parser, Recovery wiring, or production command.
- Checker outputs remain `LIVE_EXECUTOR=BLOCKED`, `PRODUCTION_READINESS=NOT_ASSESSED`, `AUTHORIZATION=NONE`, and `PHYSICAL_CONTAINMENT=NOT_PROVEN`.
- Kept Core-upgrade authority separate from Recovery authority and preserved F1u/R1Du and CTu/CTv history. CTu/CTv remain consumed immutable FAIL and non-retryable; only supplied consistency claims are checked.
- Specified exact inactive PRE/POST observations, distinct OLD/NEW identities, complete NEW release closure, exact-release rollback requirements, service-preservation comparison, and future one-attempt/journal semantics without implementing live actions.

## Source files changed

- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-10-10-idea3-inactive-core-successor-design.md` — design, authority boundaries, evidence contracts, ordering, and explicit blockers.
- `IDEA3-AEGIS_Lockdown/docs/superpowers/plans/2026-10-10-idea3-inactive-core-successor-plan.md` — scoped implementation and review plan.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/inactive-core-successor/inactive_core_successor_contract.py` — pure offline checker.
- `IDEA3-AEGIS_Lockdown/tests/test_inactive_core_successor_contract.py` — deterministic negative and invariant tests.
- `IDEA3-AEGIS_Lockdown/doc/Content/04_SESSION_HANDOFF.md` — task continuation and blockers.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — owner-maintained task status/session register.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-10-10_220014_music_idea3-inactive-core-successor.md` — this immutable task receipt.

All paths are IDEA3-owned. No IDEA1/IDEA2, production configuration, frozen runner, historical incident, marker, or unrelated UI path changed.

## Verification evidence

- From `IDEA3-AEGIS_Lockdown/`: `PYTHONDONTWRITEBYTECODE=1 /home/kittipat/.venvs/aegis-idea3-core/bin/python -m pytest -p no:cacheprovider -q tests/test_inactive_core_successor_contract.py` — pass: 21 passed.
- From `IDEA3-AEGIS_Lockdown/`: `ruff check deploy/pr11-phase4/inactive-core-successor/inactive_core_successor_contract.py tests/test_inactive_core_successor_contract.py --no-cache` — pass.
- From `IDEA3-AEGIS_Lockdown/`: Python `ast.parse` of the checker — pass.
- From repository root: `git diff --check` — pass after receipt metadata/format correction.
- From repository root: `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` — pending rerun after this receipt was aligned to the required template.
- Initial pytest under default Python failed because pytest was unavailable there; the project virtual environment produced the result above.
- No Production or hardware verification was attempted or claimed.

Independent review found that OLD and NEW identity inequality was not enforced and the payload inventory could validate against itself. Both were corrected with an explicit inequality check, parsed sums content, a separately supplied builder/guard inventory, and regression tests; exact-head independent review is pending.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — task state, local verification evidence, and remaining review/authority blockers.
- `IDEA3-AEGIS_Lockdown/doc/Content/04_SESSION_HANDOFF.md` — current task and repository-only boundary.

## Shared surfaces touched

- None — task stayed inside its selected IDEA3 area.

## Integration requests

- Request independent Security/Governance review of the exact Draft PR HEAD and IDEA3 functional review by the designated reviewer. Review must keep Core-upgrade authority separate from Recovery and preserve all named history and effects prohibitions.
- Human owner performs any merge. No Recovery approval is inferred from this Core-upgrade design.

## Known limitations

- Live upgrade remains blocked by the missing owner-verified OLD release-tree digest and rollback approval; unreviewed NEW release digest/content closure; unverified installed Core/Detector unit files and systemd dependency behavior; absent fresh host evidence and separately approved Core-upgrade stage/one-attempt authority; pending independent review; and separate Recovery authority.
- The supplied detector-inactive baseline is not independently refreshed by this repository task. The checker compares supplied claims and does not authenticate inputs or inspect host state.
- Physical containment remains not proven.
