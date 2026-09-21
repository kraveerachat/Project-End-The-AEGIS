---
title: Task Receipt — IDEA3 PR11 Phase 4 L1 package installation handler
date: 2026-09-21T15:55:00+07:00
owner: music
area: idea3
branch: feat/idea3-pr11-phase4-l1-handler
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 PR11 Phase 4 L1 package installation handler

> Repository-only. No live package manager contacted, no packages installed/removed/updated on host,
> no host services enabled/started/stopped, no `/etc` or `/opt` modified on host,
> and no live L1 stage authorized or run.

## What changed

Stage **L1** (package installation) is now a registered Phase 4 stage
handler: `p4_stage_handler_status L1` reports `REGISTERED`. With L1 registered,
all stages in Phase 4 (`L1` through `L9`) are now registered handlers. The stage
is implemented against a **fixture backend only**; selecting the live backend
fails closed at two independent layers (`apply.sh` and `p4-l1-packages.py`),
because live execution on the physical host is not authorized.

A formal operational design (`OD-L1-01` … `OD-L1-10`) reconciles the stage
requirements:
- **Package scope reconciled**: under merged OD-01 (NetworkManager AP mode) and
  OD-06 (chrony), `hostapd` is excluded, `dnsmasq 2.93` and `nftables 1.1.7`
  are confirmed pre-existing on host (E-15, E-16), and `chrony` (E-14 absent) is
  the strictly sole stage-owned target package.
- **Disk headroom gate**: requires minimum 5% free headroom before installation
  simulation; rejects if disk usage >= 95% (or configurable threshold).
- **Passive service state**: packages installed remain disabled and inactive; any
  attempt to enable/start services in L1 is strictly forbidden (services are handled
  in L6A/L6B/L7).
- **Shared harness fixture resolution**: registering L1 leaves no unregistered
  mutating stage in `P4_STAGES`. Resolved by adding `AEGIS_P4_HANDLER_DIR` test-only
  override to `p4-lib.sh`, allowing harness tests to verify fail-closed
  `ROLLBACK_HANDLER_NOT_REGISTERED` against an isolated synthetic directory without
  inventing an artificial stage.
- **Passive keys**: exact 6 passive unit/file keys in `allow-keys.txt`; 0 listeners
  in `allow-listeners.txt`.
- **Idempotent rollback**: removes only stage-owned chrony artifacts, preserving
  pre-existing host packages (`dnsmasq`, `nftables`).

## Source files changed

- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-21-idea3-pr11-phase4-l1-operational-design.md` — formal L1 operational design (OD-L1-01..OD-L1-10) and package matrix
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L1/apply.sh` — stage apply handler: environment, backend, input permissions, disk headroom gate, package simulation, inactive service check
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L1/verify.sh` — read-only post-stage verification of package presence, disabled/inactive unit, and zero listeners
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L1/rollback.sh` — stage rollback handler: removes stage-owned chrony artifacts, preserves pre-existing packages, cleans up fixture state
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L1/allow-keys.txt` — exact 6 passive unit/file keys by contract
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L1/allow-listeners.txt` — zero active listeners by contract
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l1-packages.py` — package helper: headroom check, simulated install, verify, rollback, live backend refusal
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-lib.sh` — added `P4_HANDLER_DIR="${AEGIS_P4_HANDLER_DIR:-$P4_HERE/stages}"` override for test isolation
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md` — updated handler registration status table and L1 handler summary section
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l1_handler.py` — acceptance test suite (28 tests)
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_harness.py` — reviewed-handler allowlist extended to include L1; updated gate tests to use synthetic missing handler fixture
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l9_handler.py` — reconciled test to assert L1 is registered and synthetic missing handler triggers guard

## Verification evidence

- `pytest tests/test_pr11_phase4_l1_handler.py` (before implementation) — RED contract verified (28 tests fail/pass accurately)
- `pytest tests/test_pr11_phase4_l1_handler.py` — pass: **28 passed** in 2.87s
- `pytest tests/test_pr11_phase4_harness.py` — pass: **161 passed** in 61.53s
- `pytest tests/test_pr11_phase4_*.py` — pass: **725 passed** in 139.50s (delta from L9 baseline of 696 is exactly +29)
- `pytest tests/` (full IDEA3 suite) — pass: **1705 passed, 6 skipped** in 123.50s (delta from L9 baseline of 1676 / 6 is exactly +29 new tests)
- `bash -n` on all Phase 4 shell scripts — pass: all PASS
- `bash -c '. p4-lib.sh && p4_stage_handler_status L1'` — pass: `REGISTERED`
- All stages `p4_stage_handler_status L1` through `L9` are `REGISTERED`
- `git diff --check` — pass
- Secret scan over every new file — pass: no matches

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — added Stage L1 section, updated Phase 4 handler matrix (`L1_HANDLER = REGISTERED`), test counts (28 focused, 725 Phase 4, 1705 IDEA3), completed 11-step task map. Live state remains separate: `L1..L9 = NOT RUN`, `LIVE_L1 = NOT AUTHORIZED`, `PHASE4_RUNTIME_COMPLETE = NO`, `PHASE4_LIVE_READINESS = NOT READY`.

## Shared surfaces touched

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-lib.sh` — added `readonly P4_HANDLER_DIR="${AEGIS_P4_HANDLER_DIR:-$P4_HERE/stages}"` to allow synthetic handler directory overriding for test fixtures.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_harness.py` — the shared Phase 4 / G-15 harness carries an explicit allowlist of reviewed stage handlers (`test_only_reviewed_stage_handlers_are_registered`) and tested fail-closed gating against unregistered mutating stages. With L1 registered, all stages in `P4_STAGES` are registered handlers. The test was updated to use an isolated synthetic directory via `AEGIS_P4_HANDLER_DIR` to prove `ROLLBACK_HANDLER_NOT_REGISTERED` fires without altering the production stage list or inventing artificial stages.

## Integration requests

- **Kla (integration owner, temporary GitHub reviewer for IDEA3)** — review the
  shared library change in `deploy/pr11-phase4/p4-lib.sh` and the harness update
  in `tests/test_pr11_phase4_harness.py`. Decision required: confirm the
  `AEGIS_P4_HANDLER_DIR` test-only override pattern as the clean design to preserve
  fail-closed live gate testing without mutating the production stage list `P4_STAGES`
  or inventing an artificial stage. Downstream effect: test isolation without
  impacting normal operation where `P4_HANDLER_DIR` defaults to `$P4_HERE/stages`.
  Rollback: revert `p4-lib.sh` and `test_pr11_phase4_harness.py`, delete `stages/L1/`,
  returning `p4_stage_handler_status L1` to `NOT_REGISTERED`. No runtime,
  deployment, or migration effect.

## Known limitations

- **Live L1 is NOT AUTHORIZED and NOT RUN.** `L1..L9` are all `NOT RUN`.
  Repository completion is not live acceptance. `LIVE_L1_PROOF_REQUIRED = YES`;
  that proof does not exist.
- **Host root filesystem usage is 97%.** Live L1 execution on the physical host
  would fail the disk headroom gate (OD-L1-07) until host disk cleanup is performed.
- **FIND-L9-01 remains open for owner decision:** `firmware/src/main.cpp`
  implements heartbeat replay via a 20-slot `msg_id` ring rather than the
  strictly increasing `issued_at` rule in design §6.1. Firmware was untouched
  in this task.
- **The §10 IDEA2 preservation caveat remains open and blocking** for any live
  Phase 4 stage.
- Live L1 additionally requires: host disk cleanup (freeing >5%), live authorization,
  fresh §10 preservation, and live package manager execution (none exists in repository tests).
