---
title: Task Receipt — IDEA3 offline Core pipeline acceptance
date: 2026-10-08T10:46:06+07:00
owner: music
area: idea3
branch: feat/idea3-offline-core-acceptance
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 offline Core pipeline acceptance

## What changed

Added integrated, deterministic OFFLINE acceptance of the existing Core control pipeline (detection event -> Core validation/policy -> authenticated command -> MQTT transport contract -> simulated device ACK/STATUS -> correlation -> audit/incident evidence) from main `c96e1c80dbeac16dffe0983b7e2e052f7bb9b911`. **Tests and tooling only: no change to `aegis_soc/**`, no web, CTv/CTu, Recovery gate, unit-file, network or firmware change.** The existing Core path was already correct: no genuine software defect was found, so none was "repaired".

Evidence class is SIMULATED_OFFLINE. No broker, Production host, ESP32, relay, cut or RESTORE was involved; no Recovery was executed.

## Source files changed

- `IDEA3-AEGIS_Lockdown/tests/offline_device_sim.py` — simulated relay device mirroring `firmware/src/main.cpp` command/heartbeat rules, using only the Core's own codec.
- `IDEA3-AEGIS_Lockdown/tests/test_offline_core_acceptance.py` — 31 integrated scenarios and negative controls on a real supervisor/controller/Protocol v1 store+verifier/MQTT adapter/dispatch worker+ledger/alert ingress/hash-chained audit DB.
- `IDEA3-AEGIS_Lockdown/tests/offline_acceptance.py` — deterministic runner producing machine-readable results.
- `IDEA3-AEGIS_Lockdown/tests/test_offline_acceptance_runner.py` — 7 tests: mapping cannot rot, fail-closed, deterministic, fixed non-physical truth flags.
- `IDEA3-AEGIS_Lockdown/tests/OFFLINE_ACCEPTANCE.md` — command, scope and limits.

## Verification evidence

- `python3 tests/offline_acceptance.py --json OUT` (clean tree at `f11da36611b952f3fa3c8a2ebafcc53c51ea13e8`, `git_tree_dirty=false`) — PASS: 486 tests, all 8 requirements PASS (OFFLINE_CORE_PIPELINE 3, HMAC_NONCE_TIMESTAMP 247, REPLAY_REJECTION 4, ACK_STATUS_CORRELATION 7, AUDIT_EVIDENCE 5, DETECTOR_CANNOT_BYPASS_CORE_POLICY 3, RESTORE_GUARD 60, SIMULATED_EVIDENCE_IS_NOT_PHYSICAL 14); two consecutive runs produced byte-identical JSON.
- `pytest -q tests/test_offline_core_acceptance.py tests/test_offline_acceptance_runner.py` — PASS: 38 passed
- Adjacent regressions: all `tests/test_*.py` except test_pr11_*, test_ctu*, test_ctv*, test_r1*, test_recovery_stage — PASS: 2061 passed, 7 skipped (1 requires paho-mqtt 2.x, 6 require PowerShell 7; none in the mapped requirements)
- Negative controls on the Core itself (source temporarily mutated, then restored; `git status` shows no `aegis_soc` change): bypassing the inbound MAC check, removing replay protection, removing the production RESTORE chokepoint, forcing status correlation true, removing the skew check, and making the alert path publish a CUT each made the new tests fail (2, 1, 6, 2, 2, 2 failures respectively).
- `git diff --check` — PASS

## Canonical notes updated

None — test/tooling task; no durable implemented/deployed fact changed beyond what the PR states.

## Shared surfaces touched

None — IDEA3-owned test paths only.

## Integration requests

Independent review of the exact PR head. Human merge only. The offline result must not be cited as Production, hardware or physical acceptance.

## Known limitations

Simulated only. The device model mirrors `firmware/src/main.cpp` and is pinned to it by a source-order test, but it is not the firmware and proves nothing about the ESP32, relay, GPIO, WiFi, NTP or MQTT broker. The Core's "physical confirmation" is an authenticated device STATUS correlated to a command; it is not independent relay sensing. The full suite including test_pr11_*, test_ctu*, test_ctv*, test_r1* and the web package was not run in this task (the web is owned by Claude #2; Recovery/CTv/CTu code was not touched). Recovery R2-R8 live execution remains deferred and CTv remains CLOSED_FAIL; nothing here unblocks them.
