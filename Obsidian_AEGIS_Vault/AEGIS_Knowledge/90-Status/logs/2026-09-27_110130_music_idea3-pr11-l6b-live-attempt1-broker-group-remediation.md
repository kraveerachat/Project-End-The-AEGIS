---
title: Task Receipt — IDEA3 PR11 Phase 4 L6b live attempt 1 failure and broker-group / rollback-reset remediation
date: 2026-09-27T11:01:30+07:00
owner: music
area: idea3
branch: fix/idea3-pr11-l6b-mosquitto-group-and-rollback-reset
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 PR11 Phase 4 L6b live attempt 1 failure and broker-group / rollback-reset remediation

> [!important] Two different things are recorded here
> **The first owner-run live L6b attempt FAILED and was rolled back; L6b is NOT accepted.** Evidence: `/home/kittipat/Workspace/idea3-p4-evidence/2026-09-27-l6b-20260927-100548`. `L6B_APPLY=PASS`, `L6B_VERIFY=FAIL reason=IDEA3_SERVICE_NOT_ACTIVE`. That authorization is **CONSUMED and must never be reused**.
> **This remediation is repository-only:** no Production mutation, no live L6b run, no host `systemctl` action, no authorization created or consumed, legacy Mosquitto untouched.

## What happened live

- Mosquitto 2.1.2 loaded the config, dropped privileges to `mosquitto` (uid/gid 958), then failed `password-file: Error: Unable to open pwfile "/etc/aegis-idea3/mqtt/passwd"` (exit 13). Installed `passwd` and `broker.key` were `root:root 0600`, so the dropped-privilege process could not open them.
- Rollback removed all L6b-owned files and listeners; legacy `mosquitto.service` and `:1883` were unchanged.
- PRE→RB failed only because systemd kept `LoadState=not-found ActiveState=failed SubState=failed Result=exit-code` for `aegis-idea3-mosquitto.service`.

## What changed

- Ownership model (root ownership preserved; group read only for `mosquitto`; nothing group/world-writable): mqtt dir, `aegis-idea3-mosquitto.conf`, `acl`, `passwd`, `broker.key` are `root:mosquitto` (dir `0750`, files `0640`); `ca.crt`, `broker.crt` `root:root 0644`; unit `root:root 0644`. Live pre-state requires the `mosquitto` group and user to exist and the user's primary GID to equal the group's GID; supplementary groups are not judged and no account/group is modified. `apply.sh` writes a non-secret `ownership-plan.tsv`; `verify.sh` enforces the same modes and owner:group.
- Rollback lifecycle: stop (if active) → disable (if enabled) → remove unit → `daemon-reload` → `systemctl reset-failed aegis-idea3-mosquitto.service` (that unit only) → prove `LoadState=not-found ActiveState=inactive SubState=dead Result=success` (`IDEA3_SERVICE_RUNTIME_STATE_RESIDUE` otherwise). Only when the journal records `SERVICE`. Idempotent; a non-zero `reset-failed` is tolerated only because the proven end state decides.
- Tests: a stateful fake `systemctl` models the dropped-privilege broker, failed-metadata retention after unit removal, and a bare `reset-failed` clearing every failed unit. Live-only ordering was not probed on the host; it is modeled from the observed live behavior.
- Runner: `l6b_broker_prestate_gate` requires the exact clean broker prestate (`not-found/inactive/dead/success`, `MainPID=0`, `NRestarts=0`, no unit file, no mqtt dir, no 8883) before the authorization is consumed; residue fails with `L6B_RESIDUAL_FAILED_STATE_CLEANUP_REQUIRED=YES`. The runner never runs `reset-failed`; a separately authorized cleanup follows this PR.
- Plaintext `core.pass`/`device.pass` remain JIT-only and are never installed; `ca.key` remains forbidden. The PRE→RB comparator is unchanged and strict.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L6b/apply.sh` — group model, ownership plan, fixture-gated service lifecycle.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L6b/verify.sh` — exact modes and owner:group; service checks via the same seam.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L6b/rollback.sh` — reset-failed step and runtime-state proof.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l6b-run-lib.sh`, `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-l6b-owner.sh`, `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l6b_runner.py` — clean-prestate gate before consumption.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l6b_handler.py` — new RED/GREEN tests and fake `systemctl`.
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-27-idea3-pr11-phase4-l6b-operational-design.md`, `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md` — reconciled with the live finding.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — failure and remediation section.

## Verification evidence

- `pytest tests/test_pr11_phase4_l6b_handler.py` — pass: 115 passed
- `pytest tests/test_pr11_phase4_l6b_runner.py` — pass: 83 passed
- `pytest tests -k phase4` — pass: 1814 passed, 2 skipped
- `pytest tests` (full IDEA3 suite) — pass: 2901 passed, 8 skipped
- `node scripts/validate-vault.mjs` — pass (2 pre-existing canvas warnings); `git diff --check` — pass
- `bash -n` on the three handlers — pass

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md`

## Shared surfaces touched

- None — the task stayed inside IDEA3.

## Integration requests

- None — no cross-scope or shared path changed.

## Known limitations

- That the real Mosquitto 2.1.2 process reads the `root:mosquitto` files after its privilege drop, and the real systemd `reset-failed`/`daemon-reload` semantics, can be proven only by a new live attempt under a NEW authorization (not created).
- Live-only lines (`getent`/`id` group checks, real `chown` to `root:mosquitto`) are covered by static tests and fixture ownership plans, not executed as root.
