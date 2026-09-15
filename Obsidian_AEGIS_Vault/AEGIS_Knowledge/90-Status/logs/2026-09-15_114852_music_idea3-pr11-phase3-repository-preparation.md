---
title: Task Receipt — IDEA3 PR11 Phase 3 repository preparation
date: 2026-09-15T11:48:52+07:00
owner: music
area: idea3
branch: feat/idea3-pr11-phase3-core-live
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 PR11 Phase 3 repository preparation

## What changed

- Approved Architecture A is represented by a dedicated Core-only systemd
  example that starts the existing headless supervisor directly. It cannot
  start IDEA3 Web, the GUI, or the detector; PR #132's container remains the
  sole Production Web owner.
- The repository contract separates ephemeral runtime state from durable Core
  data, the dispatch ledger, logs, configuration, and certificate material.
  Dispatch remains disabled by default and Production resource quotas remain
  unset.
- Runtime status now exposes only an allowlisted dispatch state and degrades
  honestly when enabled dispatch is credential-paused or unavailable, without
  claiming physical containment.
- An exact expired-certificate regression proves the current transport chain
  maps the verification error to `CREDENTIAL` and `PAUSED_CREDENTIAL` with no
  claim or CUT call. Historical PR9 composite artifacts remain unchanged.
- The future owner-run read-only inventory, rollout prerequisites, and rollback
  procedure are prepared in documentation only. No live command was run.

## Source files changed

- `IDEA3-AEGIS_Lockdown/README.md` — distinguish the historical PR9 composite from the Phase 3 Core-only candidate.
- `IDEA3-AEGIS_Lockdown/aegis_soc/paths.py` — resolve explicit absolute runtime, log, and configuration roots while preserving existing defaults.
- `IDEA3-AEGIS_Lockdown/aegis_soc/runtime.py` — add the allowlisted dispatch status projection and paused issue.
- `IDEA3-AEGIS_Lockdown/aegis_soc/supervisor.py` — propagate worker dispatch status and degrade on paused/unavailable dispatch.
- `IDEA3-AEGIS_Lockdown/deploy/aegis-idea3-core.env.example` — define the non-secret Core-only environment and exact separated roots.
- `IDEA3-AEGIS_Lockdown/deploy/aegis-idea3-core.service.example` — define the uninstalled Core-only systemd service, hardening, and accounting contract.
- `IDEA3-AEGIS_Lockdown/docs/operations/production-runtime.md` — document current ownership, future read-only evidence, lifecycle, prerequisites, and rollback.
- `IDEA3-AEGIS_Lockdown/docs/superpowers/plans/2026-09-15-idea3-pr11-phase3-core-live.md` — record and track the TDD implementation plan.
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-15-idea3-pr11-phase3-core-live-design.md` — record the approved source-backed Architecture A design.
- `IDEA3-AEGIS_Lockdown/tests/test_core_service.py` — verify the real unit/parser/settings and external-path contracts.
- `IDEA3-AEGIS_Lockdown/tests/test_dispatch_boundary.py` — verify paused/unavailable supervisor state and expired-certificate no-CUT behavior.
- `IDEA3-AEGIS_Lockdown/tests/test_dispatch_client.py` — verify exact certificate classification and TLS verification invariants.
- `IDEA3-AEGIS_Lockdown/tests/test_paths.py` — verify explicit external roots and durable dispatch-ledger placement.
- `IDEA3-AEGIS_Lockdown/tests/test_runtime.py` — verify allowlisted degraded/paused projection without physical claims.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-moc.md` — replace the entry-point summary with the current Phase 3 repository state.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — add the Phase 3 current task, session register, evidence, and unchanged live gates.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-09-15_114852_music_idea3-pr11-phase3-repository-preparation.md` — this one immutable repository-preparation receipt.

## Verification evidence

- `git fetch origin; git status --short; git branch --show-current; git rev-parse HEAD; git rev-parse origin/main; git worktree list` — pass: clean start on `feat/idea3-pr11-phase3-core-live`; HEAD and `origin/main` were both `509723680207b6fb8cbbe409d19ac7ad7dd9cc8a`.
- `/usr/bin/python3 -m pytest -p no:cacheprovider -q tests/test_core_service.py tests/test_paths.py` — expected RED: 5 failed, 20 passed before the Core artifacts/path support existed.
- `/usr/bin/python3 -m pytest -p no:cacheprovider -q tests/test_runtime.py tests/test_dispatch_boundary.py` — expected RED: 5 failed, 89 passed before dispatch status propagation existed.
- `/usr/bin/python3 -m pytest -p no:cacheprovider -q tests/test_core_service.py tests/test_paths.py tests/test_runtime.py tests/test_production_runtime.py tests/test_dispatch_boundary.py tests/test_dispatch_client.py` — pass: 177 passed.
- `ruff check aegis_soc tests --no-cache` — pass: all checks passed.
- `python -m compileall -q aegis_soc tests` — pass.
- `PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 -m pytest -p no:cacheprovider -q` — baseline-matched: 8 failed, 340 passed, 6 skipped; all eight failures remain in `tests/test_mqtt_client.py` because system paho-mqtt 1.6.1 lacks `CallbackAPIVersion`; baseline was 8 failed, 326 passed, 6 skipped.
- `rg -n "aegis-idea3\\.service|aegis-idea3-core\\.service|production_runtime" IDEA3-AEGIS_Lockdown --glob '!**/__pycache__/**'` — pass: current Phase 3 operations use the Core unit; PR9 specs, plan, unit, handoff, and acceptance drivers retain truthful historical composite references.
- `git diff --check` — pass.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` — pass.
- `node --test tests/collaborationPolicy.test.mjs` — pass: 24 passed outside the restricted sandbox; the restricted attempt returned empty child-validator output because of its subprocess constraints.
- Repository scope/secret/binary/receipt audit — pass: only IDEA3-owned source/docs and Music-owned canonical/receipt paths changed; no private key, certificate, secret, binary, historical receipt, IDEA1, IDEA2, HUB, shared, infrastructure-canonical, or PR129 path changed.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — record Architecture A and locally verified repository preparation while preserving every live gate as incomplete/unproven.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-moc.md` — route readers to the current Phase 3 repository-preparation truth.

## Shared surfaces touched

- None — the task stayed inside IDEA3-owned code/documentation and Music-owned canonical/receipt paths.

## Integration requests

- Kla: perform the normal human review of the Phase 3 IDEA3 repository package; approval does not authorize Production mutation.
- Pub: perform the normal human review of the D6 IDEA2/Core co-residence boundary before any live Phase 3; no IDEA2 path was changed.

## Known limitations

- `PHASE2_RUNTIME_COMPLETE=NO`; the Production Server/Core route is not available or proven by this work.
- K8 wired VLAN20 path, K9 DNS/certificate evidence, K10 certificate issuance, K12 reboot persistence, and Pub's D6 review remain unproven or not recorded.
- The full Python suite retains the eight pre-existing environment-specific paho-mqtt failures; no new Python regression was observed.
- The new unit/environment are repository examples only. No live user, directory, unit, certificate, network route, listener, quota, or service behavior was inspected or changed.
- `PHASE3_RUNTIME_COMPLETE=NO`, `PRODUCTION_MUTATION_AUTHORIZED=NO`, and `IDEA3_PRODUCTION_DEPLOYED=NO`.
