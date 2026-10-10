---
title: Task Receipt — IDEA3 Core-local manual CUT channel (repository only, disabled by default)
date: 2026-10-10T06:49:28+07:00
owner: music
area: idea3
branch: feat/idea3-core-local-manual-cut
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 Core-local manual CUT channel (repository only, disabled by default)

> Stacked on PR #422 (`feat/idea3-purple-desktop-final`, unmerged Draft). Base of this PR is that branch, not `main`.

## What changed

- Added an optional Core-owned AF_UNIX channel through which a Desktop operator account can request one manual `CUT_UPLINK`.
  It is INERT unless `AEGIS_LOCAL_CUT_ENABLED` is exactly `YES` and an absolute `AEGIS_LOCAL_CUT_SOCKET`, a non-root
  `AEGIS_LOCAL_CUT_OPERATOR_UID` are configured. Nothing in this change sets any of them.
- Authorization is the SO_PEERCRED uid of ONE configured operator account (not the Core uid, never root). The Core unit runs as
  `aegis-idea3` with `RuntimeDirectoryMode=0700`/`UMask=0077`, so the channel must use a dedicated, pre-provisioned, Core-owned
  directory like Recovery; the server never creates that directory and refuses a group/world-writable one. The client refuses a
  server that is not the Core account.
- Every accepted request needs a durable strict audit row BEFORE dispatch (`AUDIT_UNAVAILABLE` refusal otherwise), then goes only
  through `Supervisor.issue_command` (single command boundary: pending-ACK, Protocol v1 signing, sequence commit). No direct MQTT,
  relay or GPIO path. Requests while a command awaits ACK are refused (`COMMAND_PENDING`); 8 concurrent requests publish exactly one.
- Added a `CUT_EVIDENCE` operation (protocol evidence ladder, never physical evidence) via a backward-compatible `action`
  parameter on the shared `restore_evidence_ladder` (default unchanged: RESTORE).
- `LocalCutController` is a drop-in `command_controller` for the existing Desktop: CUT goes to the Core socket; RESTORE is refused
  locally and the channel cannot carry RESTORE; it never sends heartbeats. `controller_from_environment()` returns `None` (CUT
  disabled) unless explicitly enabled and configured. The accepted purple UI and live observer were NOT modified; Live CUT stays disabled.

## Source files changed

- `IDEA3-AEGIS_Lockdown/aegis_soc/local_cut.py` — new gate, server, client, controller (no publish path).
- `IDEA3-AEGIS_Lockdown/aegis_soc/supervisor.py` — `start_local_cut`/`stop_local_cut`, wired with `db.log_event_strict`.
- `IDEA3-AEGIS_Lockdown/aegis_soc/config.py` — four disabled-by-default settings.
- `IDEA3-AEGIS_Lockdown/aegis_soc/local_restore.py` — `restore_evidence_ladder(..., *, action=RESTORE_UPLINK)`; RESTORE behavior unchanged.
- `IDEA3-AEGIS_Lockdown/tests/test_local_cut.py` — 57 hermetic positive/negative security tests.

## Verification evidence

- `~/.venvs/aegis-idea3-core/bin/python -m pytest tests/test_local_cut.py ...` — pass: 57 passed.
- Focused set (local_cut, local_restore, core_restore_policy, core_break_glass, core_recovery, core_recovery_security,
  recovery_evidence, controller, dispatch_boundary, dispatch_client, core_service, supervisor_broker_status_convergence,
  desktop_auth/pages/widget_lifecycle, preview_purple_desktop) — pass: 685 passed.
- `tests/test_live_purple_observer.py` — pass: 11 passed.
- `python -m compileall -q aegis_soc tools tests/test_local_cut.py` — pass. `git diff --check` — pass.
- Order-dependent failure `test_core_recovery_security::test_no_production_alert_source_reaches_the_incident_binding` when run
  AFTER `tests/test_live_purple_observer.py`: reproduced on unmodified PR #422 HEAD `dbbcd3a4`; passes alone and in the set above.
  Cause: that PR #422 test deletes `aegis_soc*` from `sys.modules` (lines ~130/155), so `inspect.getsource(recovery_core.RecoveryServer)`
  raises "is a built-in class" for classes imported earlier. Recovery governance files were not touched; fix belongs to the PR #422 test.
- Full test suite was not run.

## Canonical notes updated

- `None` — no durable implemented/deployed fact changed: the channel is disabled by default and not deployed.

## Shared surfaces touched

- `None` — task stayed inside `IDEA3-AEGIS_Lockdown/`.

## Integration requests

- Kla (temporary IDEA3 reviewer) and an independent security reviewer: confirm the operator-boundary design. A future, separately
  approved deployment contract is REQUIRED before enabling: a tmpfiles rule for a dedicated Core-owned socket directory, a transport
  group, a Core drop-in with `SupplementaryGroups`/`ReadWritePaths`, and the operator uid. No deploy file is part of this PR.
- The legacy production GUI path (`server_admin.py` → `aegis_soc.gui.main`, started by the supervisor with `--gui`) builds its own
  `MQTTManager` and `AegisCommandController`. A Desktop launcher that uses `LocalCutController` instead is still needed and needs
  review of the accepted purple UI wiring. This PR does not change it.

## Known limitations

- Not deployed, not enabled, never exercised against a live Core, broker, ESP32 or relay; hardware behavior is NOT PROVEN.
- Peer authorization is the operator uid only; there is no second factor (a CUT is the fail-secure direction). Auto CUT is not implemented.
- ACK timeout and physical-state confirmation remain the supervisor's existing lifecycle; the channel reports protocol evidence only.
- RESTORE, CTu/CTv incident disposition and Recovery successor authority are unchanged and still blocked.
