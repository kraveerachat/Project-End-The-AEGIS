---
title: Task Receipt — IDEA3 F1 attempt-1 failure repair (repository only)
date: 2026-10-04T15:47:30+07:00
owner: music
area: idea3
branch: fix/idea3-f1-detector-journalctl-proc-and-fail-closed
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 F1 attempt-1 failure repair (repository only)

> [!important] Repository-only (IMPLEMENTED != DEPLOYED). **No new live attempt was performed or authorized.** F1 attempt 1's authorization is consumed and was only read; its marker was not touched. No Authorization/K3 was created, no future runner was frozen, nothing was installed/started/enabled/restarted on the host, no alert, Recovery, CUT/RESTORE or ESP32 action. The only host-adjacent action was a throwaway unprivileged user+mount namespace reproduction (no unit, no service, no host mutation).

## What changed

- **Attempt 1 (historical, not rewritten):** `F1_ATTEMPT_1_LIVE_EXECUTED = YES`, `F1_ATTEMPT_1_RESULT = FAIL` (`F1_APPLY=FAIL reason=DETECTOR_NOT_RUNNING`), `F1_ATTEMPT_1_ROLLBACK = PASS`, `F1_ATTEMPT_1_PRE_RB_COMPARE = PASS`, `F1_PRODUCTION_DEPLOYED = NO`, `F1_DETECTOR_STARTED = NO`. The PR #332 receipt `2026-10-04_134839_music_idea3-f1-governed-detector-install-stage.md` is immutable and unchanged. Evidence facts come from the readable `owner-run.log` and the owner's report; the root-owned attempt journal was not read by this agent.
- **Root cause confirmed in source and reproduced locally:** (A) `journalctl -f` reads `/proc/sys/kernel/random/boot_id` (`libsystemd-shared`), which `ProcSubset=pid` hides: in a throwaway namespace `journalctl -f -n 0 -o cat` under `proc subset=pid` exits 1 with `Failed to get boot ID: No such file or directory`, while the same command with a full `/proc` keeps following. (B) `production_detector.run()` returned 0 at journal EOF and `main()` never checked the follower's status.
- **Repair:** the detector unit drops `ProcSubset=pid` (new SHA-256 `da40399ef57b1e29cf30dc63792f67ded15333faacd8a3e04feb1c8e60d419b9`, old `748a4c5b…211772a`; every other active line pinned unchanged); `verify-unit` refuses any `ProcSubset=`; `production_detector` exits `EXIT_JOURNAL_SOURCE_UNAVAILABLE = 3` (never 0) on follower EOF/nonzero exit/start failure with the fixed log `reason=JOURNAL_SOURCE_UNAVAILABLE journal_exit=<n>`; `EXIT_TRANSPORT_UNAVAILABLE = 2` and detection/rate-limit/cooldown/socket behavior unchanged. Core and containment units (which also use `ProcSubset=pid`) are untouched.
- **Review of the verify path (unchanged, now pinned):** `ActiveState=active`, `SubState=running`, `MainPID>0`, `Result=success`, `NRestarts=0`, `UnitFileState=disabled`, `Restart=no`; attempt 1's exact failure shape is refused and rolled back.
- **Distinction kept:** attempt-1 failure (historical live fact) vs repository repair (this task) vs attempt 2 (**not authorized**).

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/aegis-idea3-detector.service.example` — remove `ProcSubset=pid` (explanatory comment added)
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-f1-alert-source.py` — `verify_unit` refuses `ProcSubset=`
- `IDEA3-AEGIS_Lockdown/aegis_soc/production_detector.py` — fail-closed journal source loss, new exit code 3, bounded start failure
- `IDEA3-AEGIS_Lockdown/tests/test_f1_detector_journal_source_repair.py` — NEW regression tests (41)
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_f1_governed_stage.py` — new unit digest; verify-path pins; attempt-1 replay
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md` — §12.1
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — attempt-1 truth + successor repair section
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-10-04_154730_music_idea3-f1-attempt1-failure-repair.md` — this receipt (new)

## Verification evidence

- TDD red run — `pytest tests/test_f1_detector_journal_source_repair.py` before the fix — fail: 19 failed, 22 passed (each failure for the intended reason).
- After the fix — same file — pass: 41 passed.
- Negative controls (each mutation turned tests red, then restored): re-adding `ProcSubset=pid` — 6 failed; dropping `ProtectProc=invisible` — 5 failed; EOF returning 0 again — 12 failed; no start-failure handling — 1 failed; verifier without the `ProcSubset` refusal — 1 failed.
- `pytest` F1 stage + F1 alert sink + F1 alert-source package + new regression — pass: 405 passed.
- Broader overlap (one run): F1 stage, new regression, F1 sink/source, core alert ingress, core recovery (+security), L7 and L7u release builders, phase4 harness, L7u stage governance, L8p provisioning, dnsmasq scope, L3/L4 V8 scope contract — pass: 1299 passed in 302.11s. The full suite was NOT run.
- Local reproduction (no host mutation): `unshare -Urmpf` + `mount -t proc -o subset=pid,hidepid=invisible proc /proc` + `journalctl -f -n 0 -o cat` — exit 1 `Failed to get boot ID: No such file or directory`; control with full `/proc` — keeps following (timeout rc 124).
- `python3 -m py_compile`, `git diff --check`, `node scripts/validate-vault.mjs`, collaboration-policy check — see the PR body for the final results.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — new section recording attempt-1 live truth, root cause, repair and the deployment caveat; the PR #332 stage section is marked superseded in part.

## Shared surfaces touched

- `None` — all code is under `IDEA3-AEGIS_Lockdown/`; Obsidian paths are the IDEA3 owner's canonical note and this receipt.

## Integration requests

- None — valid only when no cross-scope/shared path changed

## Known limitations

- Repository tests prove repository behavior only; no live systemd PASS is claimed. Whether another sandbox directive would also stop the real `journalctl` under systemd is unproven until a governed attempt-2.
- **Deployment caveat:** the detector unit executes the INSTALLED release's `production_detector.py`. The unit fix is deliverable by a future F1 attempt; the exit-code-3 behavior reaches Production only via a new immutable release install (not part of F1; a separate owner decision).
- The old frozen runner and attempt-1 authorization are pinned to the failed digest/consumed marker and must never be reused; a future attempt needs a new owner decision, a fresh AUTH_DIR with fresh same-day records and a runner frozen to the then-current main and the new unit digest.
