---
title: Task Receipt — IDEA3 Core-mediated evidence-driven Recovery (repository implementation)
date: 2026-09-29T14:00:00+07:00
owner: music
area: idea3
branch: feat/idea3-core-mediated-recovery
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 Core-mediated evidence-driven Recovery (repository implementation)

> [!important] IMPLEMENTED != DEPLOYED
> Repository only. No Production mutation, no MQTT connection, no RESTORE/CUT, no live Recovery, no V6/L4/L6c/L7 change.
> This PR supersedes the desktop-driven PR238/PR249 Recovery wiring for production (neither was modified).
> Going live needs a separate owner-approved post-L7 Core upgrade stage.

> [!note] Post-L7 reconciliation (2026-09-30, same unmerged task; receipt corrected in place)
> Historical sequencing: this task was initially held behind L7 acceptance. That blocker is now satisfied: L7 #7 is **LIVE ACCEPTANCE PROVEN** (`L7_7_RUNNER_RC=0`, authorization consumed, Core remained active/running/enabled).
> The branch was reconciled with post-L7 `main` `5df959055075171ea5734238aa83693371d00d9d` (clean merge, PR scope still exactly these 14 paths).
> Repository implementation remains **NOT DEPLOYED / NOT LIVE ACCEPTED** (`RECOVERY_DEPLOYED=NO`, `RECOVERY_LIVE_ACCEPTANCE=NOT_PROVEN`). The running Production Core still uses the pre-Recovery release.
> Going live still requires a separately governed post-L7 Core upgrade, followed by Recovery authorization and live evidence. LVR remains not proven; L8/ESP32 remains blocked.
> No Production mutation, Core restart, live Recovery, or ESP32/L8 work occurred during reconciliation. PR #255 and #262 are separate stacked follow-ups, not part of this PR.

## What changed

- Model B is implemented: the headless Core is the sole production authority, the desktop is an unprivileged observer.
- R1: the Core binds or creates the single open incident from a validated production attacker alert (`CoreRecoveryService.bind_incident`, called from the supervisor alert path). Idempotent, audited, never contains or cuts. A different alert never rebinds the target. The UI never creates an incident.
- R3: `ISOLATE` has no IP parameter. The Core blocks the IP it bound to the incident through the containment helper, independently reads it back with `contains()`, and audits with the incident id.
- R4/R5: D4 only. `LocalRestoreGate` gained an incident-bound, durable one-shot: any `RESTORE_REQUESTED` audit row for the open incident refuses another attempt (`RESTORE_ATTEMPT_CONSUMED`); the row is written before publication and a best-effort `RESTORE_PUBLISHED` row links the command. The supervisor's production restore-origin restriction is unchanged. The RESTORE evidence ladder was extracted into `restore_evidence_ladder()` and is shared, not duplicated.
- R5 evidence: VERIFIED only for a correlated ACCEPTED ACK plus a correlated STATUS=NORMAL for that command; a lost in-memory physical correlation (Core restart) is not verified.
- R2/R6/R7: probed by the Core against Core state (DB, MQTT, device, uplink, dispatch, web). R8: the Core re-checks R1–R7 (probes re-run, live `contains()`) and closes the incident itself; the UI supplies bounded text only.
- Core-owned AF_UNIX Recovery server (SO_PEERCRED uid allowlist, 4 KB bound, fixed operations, production only, disabled unless `AEGIS_RECOVERY_OPERATOR_UID` is set, no network listener) plus an unprivileged client and a dedicated observer UI (`python -m aegis_soc.recovery_ui`). `server_admin.py` is documented as not the production Recovery entrypoint.

## Source files changed

- `IDEA3-AEGIS_Lockdown/aegis_soc/recovery_protocol.py` — new pure wire contract (ops allowlist, gates, validators).
- `IDEA3-AEGIS_Lockdown/aegis_soc/recovery_client.py` — new stdlib-only client with Core-uid server check.
- `IDEA3-AEGIS_Lockdown/aegis_soc/recovery_core.py` — new Core service (R1–R8) and AF_UNIX server.
- `IDEA3-AEGIS_Lockdown/aegis_soc/recovery_ui.py` — new observer UI entrypoint.
- `IDEA3-AEGIS_Lockdown/aegis_soc/local_restore.py` — shared evidence ladder; incident-bound durable one-shot hooks; published-link audit row.
- `IDEA3-AEGIS_Lockdown/aegis_soc/supervisor.py` — Recovery service, alert-path incident binding, channel start/stop, gate wiring.
- `IDEA3-AEGIS_Lockdown/aegis_soc/database.py` — read-only `ping`, `restore_attempt_exists`, `fetch_incident_events`.
- `IDEA3-AEGIS_Lockdown/aegis_soc/config.py` — Recovery probe targets and optional operator uid/socket settings.
- `IDEA3-AEGIS_Lockdown/tests/test_core_recovery.py` — 73 new hermetic tests.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l7_release_builder.py` — updated pinned runtime closure (adds `recovery_core`, `recovery_protocol`; `recovery_client`, `recovery_ui` are not shipped).
- `IDEA3-AEGIS_Lockdown/README.md` — Core-mediated Recovery section with the IMPLEMENTED != DEPLOYED boundary.
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-29-idea3-core-mediated-recovery-design.md` — design and deployment boundary.

## Verification evidence

- `pytest tests/test_core_recovery.py` — pass: 73 passed.
- `pytest tests/test_local_restore.py tests/test_runtime.py tests/test_cli_ip_containment.py` — pass: 229 passed (D4, supervisor and CLI unchanged behavior).
- `pytest tests/test_pr11_phase4_l7_release_builder.py` — pass: 86 passed (after updating the pinned closure; it failed before, proving the closure change).
- `pytest tests` (full, two known unrelated tests deselected) — pass: 3917 passed, 8 skipped, 2 deselected. Deselected: `test_pr11_phase4_harness.py::test_only_reviewed_stage_handlers_are_registered` (fails on unmodified main; fixed by separate PR #251) and the host-coupled flaky `test_pr11_phase4_l6c_capture_gap.py::test_real_end_to_end_capture_then_compare_requires_the_allow_file`.
- Post-L7 reconciliation re-run on HEAD `3863b995` (merged with `main` `5df95905`), no deselection: `pytest tests` — 4150 passed, 8 skipped, **1 failed**: `test_pr11_phase4_l7_runner.py::test_l7_receipt_gate_passes_against_the_real_repository_history` (`L7_ALREADY_ACCEPTED`). Classification: current-main / pre-existing, not introduced by this PR — the identical single failure reproduces on a clean detached `origin/main` (123 passed, 1 failed) because the test expects L7 to be unproven and `main` now records L7 #7 as proven. Not fixed here (out of PR #252 scope); needs a separate fix. The earlier two deselected tests passed in this run. Focused Recovery/local-restore/runtime/CLI/release-builder suites (73/229/86) passed.
- `ruff check` on every new/changed source file and `tests/test_core_recovery.py` — pass. Two pre-existing `PLW1510` findings remain in `test_pr11_phase4_l7_release_builder.py` lines this task did not touch.
- `python -m compileall -q aegis_soc tests/test_core_recovery.py` — pass.
- `git diff --check` — pass.
- `node scripts/validate-vault.mjs` — pass: 2 pre-existing canvas warnings.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — added the dated Core-mediated Recovery section (implemented, not deployed).

## Shared surfaces touched

- `None` — task stayed inside `IDEA3-AEGIS_Lockdown/` and the idea3 Obsidian area.

## Integration requests

- None — no cross-scope path changed. Historical owner sequencing (hold behind L7) is satisfied by L7 #7; a separate post-L7 Core upgrade stage is still required before live Recovery.

## Known limitations

- Repository/simulator proof only: no live evidence, no real containment helper, no broker, no device.
- The Core runtime closure changed (23 modules); a release built after merge differs from the currently installed L7-accepted release, and the running production Core has none of this.
- The D4 gate does not itself require R1–R3 before a terminal `aegisctl restore`; Recovery reports R5/R8 accordingly and R8 refuses closure without them.
- The operator uid reaching the socket needs a provisioned directory/group and the operator uid setting in the deployment stage; the L7 `core.env` renderer was not changed.
- R7 web readiness depends on the Core's TLS trust for the readiness URL (`AEGIS_CORE_DISPATCH_CA_FILE` is used when set) and was not proven live.
- The Tk window body (`_run_window`) is not unit-tested (needs a display); the request/response logic is tested through `run_once`.
- LVR-6 and LVR9 remain owner-runbook ceremonies and are not implemented in application code.
