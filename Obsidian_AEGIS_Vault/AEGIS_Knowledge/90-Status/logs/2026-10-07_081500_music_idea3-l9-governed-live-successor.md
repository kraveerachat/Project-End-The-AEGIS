---
title: Task Receipt — IDEA3 L9 live-capable governed successor
date: 2026-10-07T08:15:00+07:00
owner: music
area: idea3
branch: feat/idea3-l9-governed-live-successor
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 L9 live-capable governed successor

## What changed

- Implemented the repository side of a live-capable L9 (authentication without actuation): a **read-only** observation of the running Core's own authenticated evidence, behind a canonical L8 PASS gate, an exact frozen runner, an exactly bound Authorization/K3, a one-shot marker and a unique final closeout contract.
- Resolved the open question of OD-L9-01 in favour of Core-side observation and amended OD-L9-01/OD-L9-08 (live backend reachable only under a conjunction of controls; live rollback is a no-op because nothing is mutated).
- Nothing was executed: L8 and L9 LIVE not run, no marker consumed, no Production mutation, no Core/Detector restart, no ESP32/NTP touch, PR #375 not modified, no merge.
- Stacked on PR #375 (head `74b3295909e2c679f763c87d1680d6d0bf29d2dc`) -> LVR work -> L8 work -> this L9 work. DO NOT MERGE until the stack merges.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l9-gates.py` — L8 -> L9 predecessor gate and final L9 closeout gate (Git objects of the pinned main, ancestry-bound).
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l9-live-observe.py` — the live backend: boundary capture, bounded read-only observation, evidence writer and verifier.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l9-freeze.py` — frozen-runner derivation/verification (template + seven pins; L8 predecessor in production mode).
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l9-run-lib.sh` — one-shot marker, exact Authorization binding, byte-exact bundle, unique host closeout.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-l9-owner.sh` — unpinned owner runner template (refuses to run as committed).
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/templates/l9-live-closeout-receipt.template.md` — template (NOT a receipt) for the final closeout receipt.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L9/apply.sh` — live branch (authorization, no fixture inputs, canonical marker); fixture path unchanged.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L9/verify.sh` — live bundle verification; the fixture bundle and the live bundle cannot impersonate each other.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L9/rollback.sh` — live no-op markers; comments updated.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md` — section 26 describing the live-capable successor.
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-10-07-idea3-pr11-phase4-l9-live-successor-design.md` — design, L8 closeout contract for the L8 work, limits.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l9_live_successor.py` — 152 new tests.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l9_handler.py` — `test_l9_live_backend_is_refused_by_apply` updated to the amended contract (still refused with the fixture environment; reasons `LIVE_L9_NOT_AUTHORIZED` / `LIVE_L9_FIXTURE_INPUT_COMBINATION_REFUSED`). No other assertion changed.

## Verification evidence

- `pytest tests/test_pr11_phase4_l9_live_successor.py` — pass: 152 passed.
- `pytest tests/test_pr11_phase4_l9_handler.py tests/test_pr11_phase4_l9_live_successor.py` — pass: 306 passed.
- Regression batch (L8 boot/firmware/handler/hardware, L8p runner/provisioning, L9 handler + successor, Phase-4 harness, `tests/rru`, `tests/r1bv`, `test_core_trusted_time_repair.py`, `test_recovery_runner_freeze.py`, `test_recovery_stage.py`) — 1723 passed, 1 failed. The one failure, `test_pr11_phase4_l8p_provisioning.py::test_stage_id_is_registered_between_l7u_and_l8_and_l7u_is_intact`, fails identically at the stack base `74b32959` (pre-existing stage-order debt), so it is not introduced here.
- `node scripts/validate-vault.mjs` — pass; only the two existing Canvas owner-review warnings.
- `node --test tests/collaborationPolicy.test.mjs` — pass: 33 passed.
- `git diff --check`, `bash -n` on every new/changed shell script, Python `compile()` on every new Python tool — pass.
- Secret scan of the delta (private-key markers; no credential, key, token or address material added) — pass.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — added the repository-only L9 live-capable successor section and current task block (LIVE NOT EXECUTED; stacked).

## Shared surfaces touched

- None — task stayed inside `IDEA3-AEGIS_Lockdown/` and the IDEA3 canonical note; `p4-lib.sh`, `p4-stage-gate.sh` and `p4-compare.sh` are unchanged.

## Integration requests

- None — valid only when no cross-scope/shared path changed. Recommended review (not policy-required): Kla/integration reviewer to confirm the OD-L9-01/OD-L9-08 amendments and that the L8 work emits the L8 closeout contract of the design (section 2) before this branch is retargeted at `main`.

## Known limitations

- L8 and L9 LIVE were not executed; the live path is proven only against synthetic Core sources. Real systemd/sqlite/status.json behaviour, the `DEVICE_STATUS` audit wording on the production Core and the 120 s default window are untested live.
- Negative probes are not injected live (`REPOSITORY_FIXTURE_ONLY`) and the device-side heartbeat effect is evidenced only indirectly (`NO_DEADMAN_OVER_WINDOW`); wider live injection needs a separate owner decision.
- The L8 closeout field names are a contract defined here; the parallel L8 work must emit exactly them or the gate will (correctly) refuse.
- One pre-existing base failure remains in the L8p provisioning stage-order test (see Verification).
