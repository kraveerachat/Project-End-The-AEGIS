---
title: Task Receipt — IDEA3 L7 #6 STATUS_CONTAINMENT_INVALID verifier remediation
date: 2026-09-30T17:10:00+07:00
owner: music
area: idea3
branch: fix/idea3-l7-status-containment-contract
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 L7 #6 STATUS_CONTAINMENT_INVALID verifier remediation

> [!important] Repository remediation only
> No Production mutation, no service start/stop, no `/etc`/`/opt`/systemd/network change, no owner JIT input touched, no authorization created, no L7 live run, no ESP32, no L8. `L7_LIVE_ACCEPTANCE = NOT_PROVEN`.

## What changed

- **L7 #6 live result (base main `f2a5cd758ff3abe0e5cfb933f63af1960318dad0`):** `L7_APPLY=PASS`; `L7_VERIFY=FAIL reason=STATUS_CONTAINMENT_INVALID`; `L7_ROLLBACK=PASS`; `L7_MATERIAL_RESIDUE=NO`; `PRE_RB_COMPARE=PASS`; `ROLLBACK_RESULT=PASS`; `PRESERVATION_S10=PASS`; `L7_LIVE_ACCEPTANCE=NOT_PROVEN`. Rolled back cleanly (`/opt/aegis-idea3/current` absent; Core not-found/inactive/dead/success). The installed immutable release `f2a5…` remains installed and valid.
- **A-L7 #6 is CONSUMED and MUST NOT be reused.** `L7_7_AUTHORIZATION = NOT_CREATED`.
- **Direct live diagnosis:** the production supervisor starts `armed=ARMED` (`RuntimeStatus(..., armed="ARMED")`), while the old `verify.sh` required `armed == "MONITOR_ONLY"`.
- **Root cause:** verifier and test fixture conflated the operational ARMED/DISARMED gate with containment. `tests/test_runtime.py::test_supervisor_operational_mode_defaults_to_armed` establishes that the Core intentionally starts ARMED even with `AEGIS_AUTO_CONTAIN=0`; the fake Core wrote `MONITOR_ONLY` and masked the mismatch.
- **Implementation:** `stages/L7/verify.sh` now accepts `armed` in {`ARMED`, `MONITOR_ONLY`} for the no-device state. All real gates are unchanged: `auto_contain=false`, uplink not `LOCKDOWN`, device not `ONLINE`, `profile=production`, `dry_run=false`, state `WAIT_DEVICE`/`DEGRADED`, broker `CONNECTED`, empty `protocol_commands`, no `CUT_UPLINK`/`RESTORE_UPLINK` audit evidence, journal, broker-connection, LoadCredential/process-env/secret, listener and predecessor-preservation checks. Any other/empty `armed` value still fails `STATUS_CONTAINMENT_INVALID`. The fake Core now defaults to the real production status.
- **Release decision (independently confirmed by owner):** `verify.sh` is not in the release payload (`p4-l7-build-release.py` packages only the `aegis_soc` closure, `requirements.txt`, venv, manifest and sums); `l7_release_gate` accepts an installed release whose `source_git_sha` is an ancestor of the new main. `RUNTIME_PRODUCTION_PAYLOAD_CHANGED=NO`, `NEW_IMMUTABLE_RELEASE_REQUIRED=NO`, `L6C_RERUN_REQUIRED=NO`.
- Other facts: `PRODUCTION_MUTATION_DURING_REMEDIATION=NO`, `ESP32_TOUCHED=NO`, `L8_STARTED=NO`.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L7/verify.sh` — accept ARMED/MONITOR_ONLY; comment that ARMED is not containment.
- `IDEA3-AEGIS_Lockdown/tests/l7_support.py` — fake Core writes real production status; env overrides for armed/auto_contain/device/uplink.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l7_handler.py` — live-failure regression, negative containment-bypass tests, armed-value acceptance.
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-21-idea3-pr11-phase4-l7-operational-design.md` — A8 row: "no containment" no longer implies MONITOR_ONLY.

## Verification evidence

- `pytest tests/test_pr11_phase4_l7_handler.py tests/test_pr11_phase4_l7_runner.py tests/test_pr11_phase4_l7_runner_flow.py tests/test_runtime.py tests/test_production_runtime.py -q` (from `IDEA3-AEGIS_Lockdown`) — pass: 481 passed.
- `git diff --check` — pass.
- `node scripts/validate-vault.mjs` — pass (2 pre-existing canvas owner-data warnings). `scripts/validate-collaboration-policy.mjs` needs a PR event payload and was not run locally; it runs in CI.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — new dated section: L7 #6 FAILED / clean rollback; remediation implemented/tested; live acceptance NOT_PROVEN.

## Shared surfaces touched

- None — task stayed inside its selected area

## Integration requests

- None — valid only when no cross-scope/shared path changed

## Known limitations

- Fixture-tested only; the fix is not live-proven. L7 #7 requires a fresh authorization/K3 and owner inputs after this merges.
- The accepted `armed` set is a verifier decision; runtime behavior is unchanged.
