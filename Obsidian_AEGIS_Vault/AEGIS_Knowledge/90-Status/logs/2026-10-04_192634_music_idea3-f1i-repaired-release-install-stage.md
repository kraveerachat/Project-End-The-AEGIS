---
title: Task Receipt — IDEA3 F1i post-L7 repaired-release install stage (repository only)
date: 2026-10-04T19:26:34+07:00
owner: music
area: idea3
branch: feat/idea3-f1i-repaired-release-install-stage
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 F1i post-L7 repaired-release install stage (repository only)

> [!important] Repository-only (IMPLEMENTED != DEPLOYED). **Nothing was executed on the host.** No F1i, L6c, F1r or F1 run; no release installed; `/opt/aegis-idea3/current` unchanged; Core not restarted; detector not started; no F1i/F1r/F1 Authorization or K3 created; no live runner frozen; the consumed L6c maintenance authorization directory was not touched. Host interaction in this task was read-only (reading the historical L6c evidence, `systemctl show`, `readlink`, `ls`).

## What changed

- **Owner decision applied:** new Phase-4 stage `F1i` = governed POST-L7 install of ONE already-built, reviewed immutable release, registered after `L8p` and before `F1r`: `L7 -> L7u -> L8p -> F1i -> F1r -> F1 -> Recovery R1-R8 -> LVR -> L8 -> L9`. Mutating; fresh same-day Authorization + K3 (`stage=F1i`, no `d6_notice`/`integration_review`/`recovery_authorization`/`physical_recovery_attestation`); own rollback handler; own marker `F1I-ATTEMPT-CONSUMED`. L6c ordering and meaning are untouched.
- **Historical L6c maintenance failure recorded truthfully (verified read-only against `…/2026-10-04-l6c-20261004-185831`):** `L6C_MAINTENANCE_ATTEMPT_LIVE_EXECUTED = YES`, `L6C_MAINTENANCE_ATTEMPT_RESULT = FAIL`, `L6C_MAINTENANCE_ATTEMPT_FAIL_REASON = L7_MATERIAL_PRESENT:/etc/aegis-idea3/credentials`, `L6C_MAINTENANCE_ATTEMPT_ROLLBACK = PASS`, `L6C_MAINTENANCE_ATTEMPT_PRE_RB_COMPARE = PASS`, `L6C_MAINTENANCE_ATTEMPT_AUTH_CONSUMED = YES`, `L6C_MAINTENANCE_ATTEMPT_RETRY = FORBIDDEN`, `RELEASE_INSTALLED = NO`. The installer succeeded; the L6c verifier, which is intentionally PRE-L7, failed closed. **L6c remains historically correct for a pre-L7 install; F1i exists because current Production is post-L7; F1i repository implementation is not live execution; no F1i Authorization exists; no release from the failed attempt is installed.**
- **F1i owns only** the creation of `/opt/aegis-idea3/releases/<frozen release id>` by the reviewed `p4-l7-install-release.py`, called exactly once (the new `p4-f1i-install.py` journals the exact prestate first and re-proves target absent, current exact and the Core snapshot immediately before the call). It never creates `/opt/aegis-idea3` or `releases`, never touches `current`, an old release, credentials, `core.env`, units, the Core, the detector, broker, Recovery, IDEA1/IDEA2 or the ESP32; its privileged backend can only `systemctl show` two units plus that one fixed installer argv.
- **Post-L7 preservation (verify), explicitly NOT the L6c absence predicates:** credentials, `core.env` and a loaded/running Core unit are accepted and preserved. Metadata unchanged (type, mode, uid, gid, size, mtime, ctime, inode); content compared in memory inside apply only (never persisted, hashed or printed); `current` byte-identical; Core same MainPID/NRestarts; new release a real directory passing the guard root-owned with exact id/source SHA/clean tree/`production_detector.py` digest and an unchanged tree digest; detector absent (unit and standalone process); read-only `check` runs through `sudo` (root read authority), a denied read is a fixed refusal.
- **Comparator contract (discovered, not guessed):** key `host.aegis_idea3.release_catalog`. `stages/F1i/allow-keys.txt` has ZERO keys (parents exist post-L7). The existing RELATIONAL one-release rule is reused with the single new label `stage F1i` in `p4-compare.sh` (behavior unchanged: every existing release stays byte-identical, exactly the named id may be added); the runner additionally proves the added entry carries the journaled tree digest. Proven with the real `p4-compare.sh` on real captured bundles: exact one addition passes; two additions, a wrong id, a mutated or removed old release, an addition without the allowance, current-target drift, listener drift, and material/Core PID/NRestarts drift all fail. Disk free space stays INFO under the existing semantics.
- **Owned rollback:** nothing owned if the installer never completed; otherwise it first proves `current` is the exact pre-attempt target, the target is a real directory passing the guard with the exact id/source SHA/detector digest and unchanged tree digest, then removes exactly that directory (tree pre-scanned: a symlink/special file refuses before any deletion; only a direct child of the releases directory is ever removable). Postconditions: target absent, parents and old release intact, current/Core/detector/material unchanged; unknown state fails closed.
- **Owner runner** `run-f1i-owner.sh` (inert template; seven `PIN_` values; refuses to run unpinned): read-only gates → PRE capture → re-prove target absent / current exact / Core snapshot / detector absent → consume marker → apply once → verify → POST → catalog transition proof → comparator → success; failure after consume → bounded rollback → RB capture → PRE/RB zero drift → no retry.
- **F1r now requires the F1i receipt (Part H):** from the pinned commit exactly ONE status-log receipt carrying whole-line `F1I_LIVE_EXECUTED=YES`, `F1I_RELEASE_INSTALLED=YES` and `F1I_RELEASE_ID=<its NEW_RELEASE_ID>` (none, only one field, split fields, duplicates, a different/missing release id all refuse; this task's receipt records NO and never satisfies it). F1r's docs, runner header, tool docstring and handlers no longer name L6c as the predecessor. F1 is semantically unchanged: F1i receipt → F1r receipt → F1 runtime pins → F1 attempt.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-lib.sh` — register `F1i` (after `L8p`, before `F1r`), gaps `none`, order and L6c rationale documented
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-stage-gate.sh` — `F1i` carries no extra authorization field
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-compare.sh` — label `stage F1i` on the existing relational release-catalog allowance (no behavior change)
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-f1i-install.py` — NEW install / verify / owned rollback tool (reuses the F1r read primitives and the reviewed installer/guard/tree-digest)
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-f1i-run-lib.sh` — NEW gates, `F1I-ATTEMPT-CONSUMED`, receipt gate, sudo preflight gate, catalog transition gate
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-f1i-owner.sh` — NEW inert frozen-runner template
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/F1i/apply.sh`, `verify.sh`, `rollback.sh`, `allow-keys.txt`, `allow-listeners.txt` — NEW stage handlers (allow files have zero active entries)
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-f1r-run-lib.sh`, `owner-run/run-f1r-owner.sh`, `p4-f1r-switch.py`, `stages/F1r/apply.sh`, `stages/F1r/rollback.sh` — F1r receipt gate requires the F1i receipt bound to the release id; L6c no longer named as predecessor
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md` — §13 wording and new §14
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-10-04-idea3-pr11-phase4-f1i-post-l7-release-install.md` — NEW design note
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_f1i_stage.py` — NEW hermetic tests (145)
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_f1r_stage.py`, `test_pr11_phase4_f1_governed_stage.py`, `test_pr11_phase4_harness.py`, `test_pr11_phase4_l7u_stage_governance.py`, `test_pr11_phase4_l8p_provisioning.py`, `test_pr11_phase4_dnsmasq_unit_repair_reboot_and_scope.py`, `test_pr11_phase4_l34_v8_scope_contract.py` — stage lists include `F1i`; F1r receipt-gate test requires the F1i receipt; two scope-contract tests re-pinned for the three changed shared files (comments explain)
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — F1i section (old F1r order wording marked superseded)
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-10-04_192634_music_idea3-f1i-repaired-release-install-stage.md` — this receipt (new)

## Verification evidence

- TDD — the F1i test file was written first (red: the tool did not exist), then the implementation: `pytest tests/test_pr11_phase4_f1i_stage.py` — pass: 145 passed.
- Negative controls (each mutation turned tests red, then restored). The ten requested: remove the current re-check (1 failed), ignore Core PID (1), ignore Core restart count (1), permit credentials drift (6), permit core.env drift (5), skip detector digest (2), broaden comparator — unapproved catalog addition tolerated (3), allow service restart in the reused backend allow-list (1), weaken rollback ownership — tree digest not compared (1), remove the F1i predecessor from F1r (5). Extra: target-absent check removed (3), parents check removed (2), installer may run twice (1), in-memory content comparison removed (2), rollback ignores current change (1), rollback skips release guard (3), removal helper accepts any path (1), removal skips the symlink pre-scan (1), catalog gate ignores the digest (1), runner swallows the post-PRE preflight failure (1). One control (service restart) first targeted the wrong file and showed a meaningless pass; it was redone against the reused backend and then failed 1 test.
- Affected suites (F1r, F1 governed stage, F1i, L7u stage governance, L8p provisioning, dnsmasq scope, L3/L4 V8 scope contract) — pass: 818 passed in 216s.
- One broader overlap (F1i, F1r, F1 governed stage, F1 detector repair, F1 sink/source, core alert ingress, core recovery(+security), phase4 harness, L7u stage governance, L8p provisioning + owner runner, scope contracts, L6c handler/runner/runner-flow/capture-gap, L7 release guard/installer/builder/runner-flow, L7u release builder) — pass: 2062 passed in 426.47s. The full suite was NOT run.
- `bash -n` on every new/changed shell file and `python3 -m py_compile` on the new tool and tests, `git diff --check`, `node scripts/validate-vault.mjs` and the collaboration-policy check — see the PR body for the final results.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — new "IDEA3 F1i post-L7 repaired-release install stage (OD-F1I-01) — repository only" section recording the historical L6c maintenance failure, the repository-only F1i implementation and what is NOT authorized.

## Shared surfaces touched

- `None` — all code is under `IDEA3-AEGIS_Lockdown/`; Obsidian paths are the IDEA3 owner's canonical note and this receipt.

## Integration requests

- None — valid only when no cross-scope/shared path changed

## Known limitations

- Hermetic proof only: real `/opt`, `/etc`, systemd, the real installer on a real release, the capture host and the Core were not exercised; F1i, F1r, L6c and F1 attempt 2 were not run.
- Secret-material drift is detected in verify through metadata including ctime/inode (no content or digest is persisted by contract); apply additionally compares content in memory across the single installer call.
- The zero-tolerance comparator would fail (and roll back) on any unforeseen captured record that changes when a release directory is added; the L0 catalog already records the new release as the one approved key.
- F1i needs, before any live use: a new owner decision, fresh same-day `authorization-F1i.txt` and `k3-F1i.txt`, a runner frozen to the then-current main, the release built by the reviewed builder into `f1i-owner-source/<id>` (the previously staged `l6c-owner-source` build can be copied there), and a clean pinned `…-F1ILIVE` worktree. F1r then needs its own F1i closeout receipt merged.
- F1i live, F1r live and F1 attempt 2 are each NOT AUTHORIZED.
