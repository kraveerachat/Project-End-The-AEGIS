---
title: Task Receipt — IDEA3 PR11 Phase 4 L6b live preparation (stage-owned broker)
date: 2026-09-27T01:45:00+07:00
owner: music
area: idea3
branch: feat/idea3-pr11-l6b-live-preparation
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 PR11 Phase 4 L6b live preparation (stage-owned broker)

> [!important] Repository preparation only
> **L6b was NOT executed, NOT authorized, and no Production or host state was changed.** The IDEA3 broker was not started, nothing was written under `/etc`, and no authorization records were created. The L6b runner is committed as an unpinned template that refuses to run.

## What changed

- Records owner decisions OD-L6B-01…09 in a new L6b operational design.
- L6b `apply.sh` now owns installing `/etc/aegis-idea3/mqtt` (six root-owned files, hashed passwd only) and the broker unit from a private `AEGIS_L6B_INPUT_DIR`; plaintext passwords are used transiently and never installed; every created path is journaled first.
- `rollback.sh` removes exactly the journaled stage-owned paths (failure path only; success is persistent).
- `verify.sh` adds exact-material checks and a live TLS/auth/ACL/negative probe on loopback and the AP address through the new `p4-broker-validate.py validate-live` subcommand.
- The capture records the mqtt directory and the IDEA3 broker unit; L6b allow keys are exact (no wildcard); PRE→RB uses no allow files.
- New `p4-l6b-run-lib.sh` gates and the unpinned `owner-run/run-l6b-owner.sh` template (one-attempt marker, receipt gate bound to the pinned commit, fresh runtime gates, uplink freeze, secret scan).
- Live state observed read-only: AP `wlp0s20f3` is down without `10.77.30.1`, `aegis-idea3-dnsmasq` failed, `chronyd` inactive; TrustedClock `SYNCED`. `PREDECESSOR_RUNTIME = NOT_READY`.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L6b/apply.sh` — stage-owned install, journal, transient password handling.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L6b/rollback.sh` — journal-driven exact rollback.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L6b/verify.sh` — material checks and live probe.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L6b/allow-keys.txt` — exact approved PRE→POST keys.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-broker-validate.py` — `validate-live` subcommand.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l0-capture.sh` — records mqtt directory and IDEA3 broker unit file.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l6b-run-lib.sh` — runner gate library (new).
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-l6b-owner.sh` — unpinned owner runner template (new).
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md` — L6b preparation section.
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-27-idea3-pr11-phase4-l6b-operational-design.md` — design (new).
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l6b_handler.py`, `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l6b_runner.py` — tests (new).
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — new L6b preparation section.

## Verification evidence

- `pytest tests/test_pr11_phase4_l6b_handler.py tests/test_pr11_phase4_l6b_runner.py` — pass: all tests passed, including live probes against throwaway loopback Mosquitto brokers.
- `pytest tests -k "pr11_phase4 or broker or mqtt"` — pass: 1375 passed, 2 skipped, 0 failed.
- `bash -n` on L6b apply.sh, verify.sh, rollback.sh, p4-l0-capture.sh, p4-l6b-run-lib.sh and run-l6b-owner.sh — pass.
- `bash run-l6b-owner.sh <dir>` on the committed template — pass: refuses with exit 2 (not pinned).
- `git diff --check` — pass.
- `node scripts/validate-vault.mjs` — see PR checks; run before commit.
- `nft list table inet aegis_idea3` and `/etc/aegis-idea3/pki` metadata — not run: sudo unavailable (`HUMAN_ACTION_REQUIRED=ARCH_SUDO_READONLY_PROOF`).

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — records L6b as reconciled/prepared, not run, not authorized; predecessor runtime not ready.

## Shared surfaces touched

- None — the task stayed inside IDEA3.

## Integration requests

- None — no cross-scope or shared path changed.

## Known limitations

- No live proof: L2 nft/PF-01 and PKI directory metadata need a sudo-authenticated read-only inventory.
- Root-owned material versus Mosquitto privilege drop (host Mosquitto 2.1.2) cannot be proven offline; the live verify is the proof (design §13).
- L3/L4 runtime must be reactivated by their own authorized workflows before any L6b run.
- The runner is a template: the owner freeze workflow must pin the merged main SHA and freeze it outside the repository.
