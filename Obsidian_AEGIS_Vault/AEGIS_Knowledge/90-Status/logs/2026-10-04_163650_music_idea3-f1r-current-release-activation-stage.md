---
title: Task Receipt — IDEA3 F1r current-release activation stage (repository only)
date: 2026-10-04T16:36:50+07:00
owner: music
area: idea3
branch: feat/idea3-f1r-current-release-activation-stage
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 F1r current-release activation stage (repository only)

> [!important] Repository-only (IMPLEMENTED != DEPLOYED). **Nothing was executed on the host.** No L6c run, no release installed, `/opt/aegis-idea3/current` unchanged, Core not restarted, detector not started, no F1r / F1 / L6c Authorization or K3 created, no runner frozen, no F1 attempt 2, no Recovery, no ESP32. The consumed F1 attempt-1 authorization and the older receipts were not touched. The only host interaction in this task was read-only: one release-guard check of the installed current release, a `/proc/<CorePID>/cwd` readability probe, `systemctl show` and `readlink`.

## What changed

- **Owner decision applied:** new Phase-4 stage `F1r` (`F1R_STAGE_ID = F1r`, `F1R_ORDER = AFTER_REPAIRED_RELEASE_INSTALL_BEFORE_F1_ATTEMPT_2`, `F1R_CORE_RESTART_POLICY = NO_RESTART`), registered in `P4_STAGES` after `L8p` and before `F1`: mutating, same-day Authorization + K3, no `d6_notice`, `integration_review`, `recovery_authorization` or `physical_recovery_attestation`, own registered rollback handler. Operational order recorded as `L7 -> L7u -> L8p -> L6c (repair release install) -> F1r -> F1 -> Recovery R1-R8 -> LVR -> L8 -> L9`, the L6c step being a fresh install-only maintenance use of the reviewed mechanism, not a replay.
- **F1r owns only** the atomic switch of `/opt/aegis-idea3/current` from the exact frozen OLD release to the exact frozen, already-installed NEW release: journal OLD → re-read current (exact string equality) → temp symlink + `os.replace` → fsync → exact `readlink`/`realpath` check. Its privileged backend can only `systemctl show` the Core and detector units, so no restart/start/stop/reload exists; the running Core keeps its PID, NRestarts and cwd, and `current` changing does not move it to the new release.
- **Rollback** owns only a journalled switch, refuses before any mutation if `current` is not exactly where this attempt left it, restores the exact OLD target atomically, proves Core unchanged and detector absent, never deletes a release.
- **Owner runner** `run-f1r-owner.sh` (inert template, seven `PIN_` values; refuses to run unpinned): read-only gates → PRE capture → re-prove current/releases/Core → consume `F1R-ATTEMPT-CONSUMED` → switch → verify → POST → exact-transition proof → compare → success; failure after consume → bounded rollback → RB capture → PRE/RB zero drift → no retry.
- **Comparator contract (discovered, not invented):** L0 key `host.symlink./opt/aegis-idea3/current.target` (value = `readlink`). `stages/F1r/allow-keys.txt` approves only that key; the runner's `f1r_current_transition_gate` proves the exact OLD→NEW values from the PRE/POST `host.tsv`; zero listener additions; PRE→RB with no allowances. Proven with the real `p4-compare.sh` on real captured bundles.
- **Future F1 attempt-2 hardening:** the F1 runner template gains `EXPECTED_RUNTIME_RELEASE_ID`, `EXPECTED_RUNTIME_RELEASE_SOURCE_SHA`, `EXPECTED_PRODUCTION_DETECTOR_SHA256` and a read-only `f1_runtime_release_gate` before PRE capture and again before the one-shot consume (via the reviewed `p4-f1r-switch.py check-runtime`: current resolves to exactly the release, release guard at `--expect-owner root`, manifest source SHA, detector digest, detector absent). `UNIT_SHA256` stays a separate pin; no existing F1 gate was weakened.
- **Independent review fixes (same PR, same receipt):** (1) *Root-only reads:* the read-only `check` / `check-runtime` gates (F1r preflight and the future F1 runtime gate) now run through `$SUDO env PYTHONDONTWRITEBYTECODE=1 …`, not as the plain operator user, and the runner's `readlink /opt/aegis-idea3/current` checks use `sudo`; a denied read is a fixed refusal (`HOST_READ_DENIED` / `PROC_READ_DENIED`), a failed elevation fails the gate (`ROOT_READ_UNAVAILABLE`) before the attempt is consumed; no permission was loosened. Observed on this host: `/opt/aegis-idea3` is `755 root:root` today (so earlier read-only checks as a normal user worked), but the code no longer assumes it. (2) *Standalone detector process:* `detector_absent()` now also refuses a bare `python -m aegis_soc.production_detector` process (exact argv-token match over `/proc`, detection only) even when the unit is `not-found`/`inactive`/`MainPID=0`, in preflight/`check`, apply, verify, `check-runtime` and the rollback postcondition; the runner re-proves absence after PRE and right before `F1R-ATTEMPT-CONSUMED` (tool + shell gate). (3) *F1 predecessor:* the future F1 receipt gate requires, from the pinned commit, exactly ONE status-log receipt carrying BOTH whole-line `F1R_LIVE_EXECUTED=YES` and `F1R_CURRENT_SWITCHED=YES` (this PR's receipt records NO and never satisfies it); the runtime pins remain as defense in depth.
- **State kept distinct:** F1 attempt 1 = historical FAIL + rollback PASS; PR #333 = merged repository repair; F1r = repository implementation only; L6c repaired-release install = NOT YET AUTHORIZED; F1r live = NOT YET AUTHORIZED; F1 attempt 2 = NOT AUTHORIZED. `F1R_LIVE_EXECUTED = NO`, `F1R_CURRENT_SWITCHED = NO`.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-lib.sh` — register stage `F1r` (after `L8p`, before `F1`), gaps `none`, order documented
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-stage-gate.sh` — `F1r` carries no extra authorization field
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-f1r-switch.py` — NEW atomic current switch / verify / owned rollback / read-only `check` and `check-runtime`
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-f1r-run-lib.sh` — NEW gates, `F1R-ATTEMPT-CONSUMED`, receipt gate, detector-source gate, exact-transition gate
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-f1r-owner.sh` — NEW inert frozen-runner template
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/F1r/apply.sh`, `verify.sh`, `rollback.sh`, `allow-keys.txt`, `allow-listeners.txt` — NEW stage handlers
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-f1-run-lib.sh`, `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-f1-owner.sh` — runtime-release pins and pre-consume gate (template only)
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md` — §13
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_f1r_stage.py` — NEW hermetic tests (161)
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_f1_governed_stage.py`, `test_pr11_phase4_harness.py`, `test_pr11_phase4_l7u_stage_governance.py`, `test_pr11_phase4_l8p_provisioning.py`, `test_pr11_phase4_dnsmasq_unit_repair_reboot_and_scope.py`, `test_pr11_phase4_l34_v8_scope_contract.py` — stage lists include `F1r`; two scope-contract tests re-pinned for the two changed shared files (comments explain)
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — F1r section
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-10-04_163650_music_idea3-f1r-current-release-activation-stage.md` — this receipt (new)

## Verification evidence

- Review-fix TDD — 22 new/updated tests were red before the fixes (sudo read path, denied reads, standalone process, F1r predecessor), then `pytest tests/test_pr11_phase4_f1r_stage.py tests/test_pr11_phase4_f1_governed_stage.py` — pass: 300 passed (161 + 139).
- Review-fix negative controls (each mutation turned tests red, then restored): standalone-process detection removed (5 failed), denied read swallowed as absent (1), unreadable /proc entry swallowed (1), process match loosened to substring (1), F1r preflight run without sudo (3), F1 runtime gate run without sudo (3), failed root read not named (1), runner reads current as plain user (1), runner drops the shell detector re-proof after PRE (1), F1r predecessor check removed (6), F1r uniqueness dropped (1); the earlier controls (detector digest 3, rollback ownership guard 2, backend allows restart 2) were re-run and still fail. One mutation of mine was ineffective (it left the real check in place) and was redone correctly.
- Review-fix broader overlap (one run; F1r, F1 stage, F1 detector repair, F1 sink/source, core alert ingress, core recovery(+security), phase4 harness, L7u governance, L8p provisioning + owner runner, scope contracts, L6c handler/runner/runner-flow, L7 release guard/installer/runner-flow) — pass: 1779 passed in 370.41s. Full suite NOT run. The earlier 1724-test run stands as prior evidence.
- TDD — `pytest tests/test_pr11_phase4_f1r_stage.py` before the implementation: 33 failed (missing stage/lib/runner), 108 passed (the tool); after: 141 passed, then 142 with the added abort-on-failure test.
- Negative controls (each mutation turned tests red, then restored): loose current-target comparison (1 failed), no re-read before mutation (1), Core PID/restarts ignored in verify (2), rollback ownership guard removed (2), detector digest not compared (3), source SHA not compared (2), dirty tree not refused (3), detector absence not required (11), backend allows restart (2), runtime gate ignores which release current resolves (1), non-atomic unlink+symlink switch (6), transition gate accepts any post value (1), extra allowed key (2). One mutation was NOT caught at first (F1 runner re-check turned into `|| true`); the test was strengthened and then caught it (1 failed).
- Affected Phase-4 suites (F1r, F1 governed stage, L7u stage governance, L8p provisioning, dnsmasq scope, L3/L4 V8 scope contract) — pass: 645 passed in 198s.
- One broader overlap (F1r, F1 stage, F1 detector repair, F1 sink/source, core alert ingress, core recovery(+security), phase4 harness, L7u governance, L8p provisioning, scope contracts, L6c capture-gap/handler/runner/runner-flow/umask, L7 release builder/guard/installer/runner-flow, L7u release builder) — pass: 1724 passed in 362.36s. The full suite was NOT run.
- `bash -n` on every new/changed shell file and `python3 -m py_compile` on the new tool and test — pass. `git diff --check`, `node scripts/validate-vault.mjs` and the collaboration-policy check — see the PR body for the final results.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — new "IDEA3 F1r current-release activation stage (OD-F1R-01) — repository only" section (repository-only; nothing deployed).

## Shared surfaces touched

- `None` — all code is under `IDEA3-AEGIS_Lockdown/`; Obsidian paths are the IDEA3 owner's canonical note and this receipt.

## Integration requests

- None — valid only when no cross-scope/shared path changed

## Known limitations

- Hermetic proof only: real `/opt`, systemd, the real release guard on real releases (other than the read-only guard check of the current release during design), the Core and the capture host were not exercised; F1r, L6c and F1 attempt 2 were not run.
- `/proc/<CorePID>/cwd` is root-only on this host, so the Core cwd proof applies only when readable and is otherwise recorded as `UNREADABLE`; PID and NRestarts equality are always required.
- After a live F1r the running Core is still the old process on the old working directory; the new release reaches the Core only after a separately authorized restart. The zero-tolerance compare would roll the switch back on any unforeseen captured record that changes with `current`.
- The L6c repaired-release install needs its own fresh same-day authorization, a frozen runner for the new release id and the builder output under `l6c-owner-source/<id>`; its pre-gates assume the legacy pre-L7 broker state (still true on the host when last read). F1r requires that install to have happened first.
- F1r live and F1 attempt 2 each need a new owner decision, fresh same-day records and a runner frozen to the then-current main.
