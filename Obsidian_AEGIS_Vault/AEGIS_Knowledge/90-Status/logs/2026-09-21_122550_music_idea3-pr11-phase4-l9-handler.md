---
title: Task Receipt — IDEA3 PR11 Phase 4 L9 authentication without actuation handler
date: 2026-09-21T12:25:50+07:00
owner: music
area: idea3
branch: feat/idea3-pr11-phase4-l9-handler
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 PR11 Phase 4 L9 authentication without actuation handler

> Repository-only. No live broker contacted, no ESP32 hardware accessed, no serial port
> opened, no command/cut/restore issued, no relay actuated, and no live L9 stage authorized or run.

## What changed

Stage **L9** (authentication without actuation) is now a registered Phase 4 stage
handler: `p4_stage_handler_status L9` reports `REGISTERED`. The stage is implemented
against a **fixture backend only**; selecting the live backend fails closed at two
independent layers (`apply.sh` and `p4-l9-auth.py`), because no live probe mechanism
is authorized or implemented in this repository.

A formal operational design (`OD-L9-01` … `OD-L9-09`) reconciles previously scattered
L9 fragments:
- **Zero COMMAND issued**: previous design notes describing L9 as "command roundtrips"
  or "CUT testing" are withdrawn; L9 issues no COMMAND, CUT, or RESTORE.
- **Fail-secure hold rollback**: live rollback is an owner-run stop of the Core service
  with the device holding fail-secure CUT via dead-man timeout (S-11 hold), not a restoration.
- **Shared harness fixture moved L9 → L1**: `P4_STAGES` ends at L9; L1 (package
  installation) is the last remaining unregistered mutating stage.

Security controls implemented and verified:
- Authenticated HEARTBEAT (Core → device) accepted with dead-man reset only; no output change.
- Authenticated BOOT and PERIODIC STATUS (device → Core) accepted by the Core's real `InboundVerifier`
  and durable `ProtocolStore`; liveness begins only after the first authenticated status.
- Rejection of all negative probes (replay, wrong key foreign/cross-direction, tampered MAC/field,
  zero MAC, stale/future skew, device/topic mismatch, untrusted time, malformed/legacy v0) with
  zero liveness, zero replay rows, and zero audit rows for pre-AUTH rejections.
- Zero COMMAND, zero CUT, zero RESTORE, zero relay actuation (`relay_actuation=NONE`), and zero
  command rows in the fixture protocol store.
- Static source scanning proves complete absence of 18 actuation, network, and key generation tokens.
- Private write-once evidence bundle (`l9-auth-evidence.json`, mode 0600) with strict 19-field allowlist;
  zero key material, MAC, or `msg_id` emitted.
- Zero host drift: `allow-keys.txt` and `allow-listeners.txt` carry zero active entries.
- Rollback removes stage-local fixture store (`fixture-protocol.sqlite3*`) and preserves evidence.

## Source files changed

- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-21-idea3-pr11-phase4-l9-operational-design.md` — formal L9 operational design (OD-L9-01..OD-L9-09) and probe matrix
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L9/apply.sh` — stage apply handler: environment, backend, input permissions, and syntax gates, delegating to the authentication helper
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L9/verify.sh` — read-only post-stage verification of evidence bundle privacy, allowlist, and zero drift
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L9/rollback.sh` — stage rollback handler: removes fixture store and preserves evidence; documents S-11 fail-secure hold
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L9/allow-keys.txt` — zero active keys by contract (L9 is observational)
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L9/allow-listeners.txt` — zero active listeners by contract
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l9-auth.py` — authentication helper: probe generation, device heartbeat model, recording transport, real Core verifier/store integration, evidence writer and verifier
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md` — updated handler registration status table and L8/L9 handler summary sections
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l9_handler.py` — acceptance test suite (154 tests)
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_harness.py` — reviewed-handler allowlist extended to include L9; live-gate fixture moved L9 → L1 with assertion that L1 is unregistered

`p4-lib.sh` required **no change**: `L9` was already present in `P4_STAGES`, `p4_stage_gaps L9 = none`,
and `p4_stage_auth_extra L9 = none`.

## Verification evidence

- `pytest tests/test_pr11_phase4_l9_handler.py` (before implementation) — **RED: 148 failed, 6 passed**, zero `ImportError`/`SyntaxError`/`NameError`
- `pytest tests/test_pr11_phase4_l9_handler.py` — pass: **154 passed**
- `pytest tests/test_pr11_phase4_harness.py` — pass: **160 passed**
- `pytest tests/test_pr11_phase4_*.py` — pass: **696 passed** (delta from L8 baseline of 542 is exactly +154)
- `pytest tests/` (full IDEA3 suite) — pass: **1676 passed, 6 skipped** (delta from baseline on `f08d003b` of 1522 / 6 is exactly +154 new L9 tests)
- `bash -n` on all Phase 4 shell scripts — pass: all PASS
- `bash -c '. p4-lib.sh && p4_stage_handler_status L9'` — pass: `REGISTERED`
- `git diff --check` — pass
- Secret scan over every new file — pass: no matches
- Static token scan on all L9 sources — pass: 0 occurrences of 18 prohibited tokens
- Negative controls, each restored and verified byte-identical, none committed:
  - NC-1: evidence allowlist extra-field refusal disabled → expected test FAILED
  - NC-2: transport topic guard disabled → 3 expected tests FAILED
  - NC-3: live backend refusal removed from `apply.sh` only → test PASS (defense in depth verified: Python layer catches it)
  - NC-3b: live backend refusal removed from both layers → 3 expected tests FAILED
  - NC-4: monotonic heartbeat check disabled → expected test FAILED

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — added L9 task section: `L9_HANDLER = REGISTERED`, `GREEN_HARDENING_PROVEN = YES`, test counts (154 focused, 696 Phase 4, 1676 full IDEA3), task map completed, negative control table, and closeout evidence. Live state remains separate: `L2..L9 = NOT RUN`, `LIVE_L9 = NOT AUTHORIZED`, `PHASE4_RUNTIME_COMPLETE = NO`, `PHASE4_LIVE_READINESS = NOT READY`.

## Shared surfaces touched

- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_harness.py` — the shared Phase 4 / G-15 harness carries an explicit allowlist of reviewed stage handlers (`test_only_reviewed_stage_handlers_are_registered`) and uses one unregistered mutating stage as its live-gate fixture (`test_gate_live_mode_for_mutating_stage_fails_without_registered_handler`). Registering L9 requires adding L9 to the allowlist and moving the fixture from L9 to L1, the last unregistered mutating stage in `P4_STAGES`. This repeats the precedent of PR #164 (L7→L8) and PR #165 (L8→L9).

## Integration requests

- **Kla (integration owner, temporary GitHub reviewer for IDEA3)** — review the
  single shared-harness edit to `tests/test_pr11_phase4_harness.py`. Decision
  required: confirm that L9 belongs in the reviewed-handler allowlist and that
  moving the unregistered-mutating-stage fixture to L1 is the intended
  continuation of the precedent. Also note: L1 is the last unregistered mutating
  stage in `P4_STAGES`, so registering L1 in a future task will require a
  synthetic harness fixture mechanism. Downstream effect: the guardrail prevents
  unreviewed stage directories from being treated as registered handlers, and
  the live-gate fixture proves `ROLLBACK_HANDLER_NOT_REGISTERED` fires.
  Rollback: revert the harness change and delete `stages/L9/`, returning
  `p4_stage_handler_status L9` to `NOT_REGISTERED`. No runtime, deployment, or
  migration effect.

## Known limitations

- **Live L9 is NOT AUTHORIZED and NOT RUN.** `L2..L9` are all `NOT RUN`.
  Repository completion is not live acceptance. `LIVE_L9_PROOF_REQUIRED = YES`;
  that proof does not exist.
- **No live broker or physical device was contacted.** Every test runs against
  the fixture backend.
- **FIND-L9-01 remains open for owner decision:** `firmware/src/main.cpp`
  implements heartbeat replay via a 20-slot `msg_id` ring rather than the
  strictly increasing `issued_at` rule in design §6.1. Firmware was not changed
  in this task to preserve the L8-flashed image contract.
- **The §10 IDEA2 preservation caveat remains open and blocking** for any live
  Phase 4 stage.
- Live L9 additionally requires: live L2..L8 PASS, a running authorized Core (L7),
  a flashed device (L8), a separate same-day A-L9, fresh K3, fresh §10 preservation,
  and a reviewed live probe mechanism (none exists). None of these is satisfied here.
