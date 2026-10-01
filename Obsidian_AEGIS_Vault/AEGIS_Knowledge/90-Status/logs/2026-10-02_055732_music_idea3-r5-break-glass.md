---
title: Task Receipt — IDEA3 R5 normal-path RESTORE + OD-R5-BG-01 break-glass (repository only)
date: 2026-10-02T05:57:32+07:00
owner: music
area: idea3
branch: feat/idea3-recovery-r5-normal-path-rebuild
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 R5 normal-path RESTORE + OD-R5-BG-01 break-glass (repository only)

## What changed

- Repository/local only. **No Production mutation, Core restart, L7u, Recovery, ESP32, L8p or L8 execution.**
- **R5 normal RESTORE:** R1 VERIFIED -> R3 VERIFIED -> live containment read-back -> fresh R2 VERIFIED -> D4 -> normal RESTORE. Missing live containment after a VERIFIED R3 is NOT convertible to break-glass.
- **Break-glass (OD-R5-BG-01, owner-approved; design record kept in the Recovery design spec):** emergency operational recovery only. Requires an authenticated v1 LOCKDOWN, a durable lockdown episode, fresh current-process LOCKDOWN proof, fresh R2 VERIFIED, D4, `RESTORE UPLINK`, `BREAK GLASS RESTORE UPLINK`, a reason and explicit `break_glass=true`. One durable claim per episode, spent before publish; the normal path takes priority; Case A (no incident) and Case B (latest durable R3 result FAILED) only. Dedicated break-glass basis/audit.
- **Acceptance boundary:** `BREAK_GLASS_COUNTS_AS_R4=NO`, `BREAK_GLASS_COUNTS_AS_R5=NO`. Break-glass is not Recovery acceptance credit.
- **Post-PR #286 reconciliation:** `origin/main` `bfbe1dc6` merged normally (no rebase, no force). PR #286 (L8p owner runner) touched no R5/break-glass source and no file this branch changes; it merged with no conflicts and its files are untouched.

## Source files changed

- `IDEA3-AEGIS_Lockdown/aegis_soc/{cli,database,local_restore,mqtt_client,recovery_core,supervisor}.py` — R5 chokepoint, lockdown episodes, break-glass gate, authenticated status callback (previous commits on this branch).
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-29-idea3-core-mediated-recovery-design.md` — OD-R5-BG-01 design record.
- `IDEA3-AEGIS_Lockdown/tests/{test_core_break_glass,test_core_restore_policy,test_core_recovery,test_core_recovery_security}.py` — R5 and break-glass tests.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — truthful repository-only status.

## Verification evidence

- Post-merge `pytest` (venv `aegis-idea3-core`): break-glass 63 passed; restore-policy 50 passed; core_recovery + core_recovery_security + mqtt_client + supervisor convergence 145 passed; local_restore 150 passed; alert_ingress (F1) 60 passed; L7u stage governance 84, L8p provisioning 96, L8p owner runner 96 passed; L7/L7u release builder, guard helper and runtime contract 153 passed.
- **Chronology:** the earlier source-verification run was `FULL_TESTS=5132 passed, 8 skipped, 0 failed` plus the targeted post-merge runs above. The final review-fix commit changes documentation/provenance only (no source or test change), so that run is retained as the source verification and the full suite was not rerun; after the fixes only the targeted sanity suites were rerun.
- **Superseded evidence:** the earlier scratch release used the test-suite STUB wheelhouse (source `502eefdd`); it is not final evidence.
- **Final release (REAL owner offline wheelhouse):** `p4-l7-build-release.py build --source-root <this worktree> --release-id r5-bg-final-36d34083 --wheelhouse /home/kittipat/Workspace/idea3-p4-evidence/l7u-wheelhouse` (the same wheelhouse PR #288's release verification used; `paho_mqtt-2.1.0` only, no network, interpreter `~/.venvs/aegis-idea3-core`). `L7_RELEASE_BUILD=PASS`, `SOURCE_GIT_SHA=36d3408385ca1a1faa45ec8fdac6ebaa10f07c7d`, `SOURCE_TREE_DIRTY=NO`, `FILE_COUNT=50`; scratch path `/home/kittipat/Workspace/idea3-p4-evidence/2026-10-02-r5-final-build-055755/r5-bg-final-36d34083`. `verify --expect-owner self`: `L7_RELEASE_VERIFY=PASS`. Source SHA `36d34083` is the final source tree; the review-fix commit that follows touches only vault documents.
- Release runtime files `recovery_core.py`, `recovery_protocol.py`, `recovery_client.py`, `recovery_ui.py`, `local_restore.py`, `database.py`, `supervisor.py` are byte-identical to source (`cmp`). Present in the release: R5 chokepoint (`RecoveryCore._restore_gate` / `restore_precondition_unmet`), lockdown episode model (`database.get_open_lockdown_episode` / `fetch_lockdown_episodes`), break-glass gate (`break_glass_unmet`, `break_glass_claim_for_episode`), authenticated status callback (`Supervisor._on_authenticated_status`), F1 alert ingress (`recovery_core.AlertIngress`, `Supervisor.start_alert_ingress`). Not installed to Production.
- **Actual L7u guard invocation (fixture / non-Production, not a pytest):** `p4-l7u-upgrade.py`'s own `load_guard()` -> `guard.check("<RELEASES>/r5-bg-final-36d34083", <scratch release>, "self")` returned `("r5-bg-final-36d34083", "36d3408385ca1a1faa45ec8fdac6ebaa10f07c7d")`, plus the engine's `RECOVERY_RUNTIME_FILES` presence check (none missing). `L7U_PREFLIGHT_GUARD=PASS`. L7u was not run live.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — new R5 + break-glass section.

## Shared surfaces touched

- None — task stayed inside IDEA3.

## Integration requests

- None — no cross-scope/shared path changed.

## Known limitations

- `R5_PRODUCTION_DEPLOYED=NO`, `RECOVERY_LIVE=NOT_RUN`, `L7U_LIVE_FINAL=NOT_PROVEN`, `L8P_LIVE=NOT_AUTHORIZED`, `L8_LIVE=NOT_RUN`. Merging R5 alone requires a governed deployment stage; nothing here is live-proven.
