---
title: Task Receipt — IDEA3 PR252 Recovery security remediation (F1–F4, R5 ordering)
date: 2026-09-29T19:00:00+07:00
owner: music
area: idea3
branch: fix/idea3-recovery-security-f1-f4
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 PR252 Recovery security remediation (F1–F4, R5 ordering)

> [!important] IMPLEMENTED != DEPLOYED
> Repository only. IMPLEMENTED / repository-only; NOT DEPLOYED, NOT LIVE ACCEPTED, NOT MERGED TO MAIN. Stacked on the
> reconciled PR #252 parent (`feat/idea3-core-mediated-recovery`, reconciled post-L7 with current `main`, parent HEAD
> `ba5caa3cbf042a00133fcc662c5f1800fd3a8edc`). No production mutation, Core restart, release build/install, MQTT connection,
> RESTORE/CUT, authorization/K3, or ESP32 access. The historical PR252 receipt is untouched.

> [!note] Post-L7 / post-PR252 reconciliation (current state, supersedes the original hold wording)
> - **Historical:** when this receipt was first written, PR #255 was held behind L7 (PR #252 "must not merge before L7 #3").
>   That pre-L7 hold is historical and is now satisfied: L7 #7 live acceptance is PROVEN, the L7 closeout PR #267 and the L7
>   post-acceptance test fix PR #269 are merged, and PR #252 was reconciled with current `main` and pushed at `ba5caa3c`.
> - PR #255 remains IMPLEMENTED / repository-only and NOT DEPLOYED. Recovery live acceptance is NOT PROVEN. Production Core has
>   not been upgraded or restarted for Recovery. PR #262 remains a separate stacked follow-up and is not part of this change.
> - F1 is still BLOCKED_BY_MISSING_PRODUCTION_ALERT_SOURCE (not solved) and the R5 production precondition / break-glass
>   (`BREAK_GLASS_OWNER_DECISION_REQUIRED=YES`) is still unsolved; both stay pinned by guard tests and the strict `xfail`.
>   LVR remains not proven; L8/ESP32 remains blocked.
> - No Production mutation, Core restart, Recovery live execution, Recovery authorization, or ESP32 access happened during
>   this reconciliation; only repository files were reconciled and repository-only verification was re-run.

## What changed

- **F1 — BLOCKED_BY_MISSING_PRODUCTION_ALERT_SOURCE (no code).** Audit: `bind_incident` is reached only via
  `supervisor._on_attacker` ← `mqtt.attacker_callback` ← the legacy-v0-lab message path. Production refuses legacy mode,
  Protocol v1 has only COMMAND/HEARTBEAT/ACK/STATUS kinds and the Core subscribes to ACK/STATUS only, and `detector.py`
  publishes an unsigned plaintext IP to the legacy `aegis/attacker_ip` topic. No approved detector→Core contract exists, so
  nothing was wired and R1 remains unreachable in production. Guard test pins this. Smallest interface required (owner to
  approve, then a separate task): an authenticated detector→Core alert — either a Protocol v1 `ALERT` kind (signed with its own
  key, strict IPv4 field, replay-protected, separate ACL topic; this is a Protocol v1 + firmware-adjacent change) or a
  Core-owned AF_UNIX/root-owned socket fed by the detector on the same host — carrying only `attacker_ip` and a monotonic
  `alert_id`, with an end-to-end production-path test that reaches `bind_incident` without calling `_on_attacker`.
- **F2 — policy-neutral DB one-shot.** `init_db` adds a partial UNIQUE index
  `ux_audit_restore_requested_incident (incident_id) WHERE event_type='RESTORE_REQUESTED' AND incident_id IS NOT NULL`.
  History is preserved, NULL-incident rows neither collide nor consume, a second writer/process fails with
  `sqlite3.IntegrityError`, and `LocalRestoreGate` maps it to the existing safe refusal `RESTORE_ATTEMPT_CONSUMED` (nothing
  published). If old data already holds duplicates the index cannot be built: startup does not fail, rows are kept, and the
  read guard `restore_attempt_exists` still applies. Incident binding authority is unchanged.
- **F3 — dedicated incident lock.** `CoreRecoveryService._bind_lock` guards incident bookkeeping; `bind_incident` takes only
  it, never the operator `_lock` held across PROBE/ISOLATE network probes. `close()` re-checks the same incident and target
  under `_bind_lock` for its final audit+close. Lock order is `_lock` → `_bind_lock`; `bind_incident` adds no containment.
- **F4 — AF_UNIX hardening.** `SO_PEERCRED` is read immediately after accept and an unauthorized uid is refused before any
  request byte is read; one monotonic total request deadline (`RecoveryServer.request_deadline`, default 5 s) bounds the whole
  read and is not reset per recv; 4096-byte cap, one response per connection, fail-closed timeout, and no request content in
  logs are preserved.
- **R5 ordering — inert helpers + tests only.** `LocalRestoreGate(precondition_lookup=…)` (default `None`; the production
  supervisor does NOT wire it): runs after credential/confirmation/reason/origin and before the command guard; a refusal
  returns `RECOVERY_PRECONDITION_UNMET` and never consumes the one-shot; a raising lookup fails closed.
  `CoreRecoveryService.restore_precondition_unmet` (R1 VERIFIED, durable R3 VERIFIED, one fresh single-target R2 probe) and
  `r3_precedes_restore` (R8 audit-id ordering) exist but are not wired.
- **Import graph.** Dynamic `sys.modules` subprocess test: `recovery_ui` imports only `recovery_client` + `recovery_protocol`
  (no paho/MQTT client, controller, Telegram, config/credentials, database, local_restore, supervisor, ssl, sqlite3).

## Still blocked on an owner decision (nothing invented)

- Production enforcement of R3-before-RESTORE (`supervisor.start_local_restore` wiring `precondition_lookup`) and the R8
  ordering check: would lock the owner out when the isolation path is impossible. Needs an approved break-glass mechanism
  (authority, confirmation string, audit shape). `BREAK_GLASS_OWNER_DECISION_REQUIRED=YES`. Pinned by a strict `xfail`
  (`test_production_supervisor_enforces_r3_before_restore`), which fails loudly the day it is wired.
- Dead end characterized, not changed: a first bound protected/gateway/management IP (helper answers `PROTECTED_ADDRESS`)
  leaves R3 FAILED and a later different IP is `IGNORED_DIFFERENT_IP`; an unsent attempt still spends the one-shot.
- Audit-failure after incident creation returns `audited:false`; the incident stays bound (R1 verified) without an
  `INCIDENT_BOUND` row.
- Applying the new unique index to the live audit DB happens at the next Core `init_db` after deployment (schema change).

## Source files changed

- `IDEA3-AEGIS_Lockdown/aegis_soc/database.py` — partial unique index for the durable RESTORE one-shot.
- `IDEA3-AEGIS_Lockdown/aegis_soc/local_restore.py` — IntegrityError → `RESTORE_ATTEMPT_CONSUMED`; inert `precondition_lookup`.
- `IDEA3-AEGIS_Lockdown/aegis_soc/recovery_core.py` — `_bind_lock`, close re-check, R5 helpers, server peer-first + total deadline.
- `IDEA3-AEGIS_Lockdown/tests/test_core_recovery_security.py` — new focused security tests (37 incl. 1 strict xfail).

## Verification evidence

- RED first (before implementation): `pytest tests/test_core_recovery_security.py` — 16 failed / 20 passed / 1 xfailed. Reasons:
  `DID NOT RAISE IntegrityError` (DB one-shot ×4), second RESTORE published on a stale lookup, alert path waited behind PROBE,
  unauthorized peer not refused before read, deadline reset per recv (10.8 s > 2 s), no monotonic deadline, missing
  `restore_precondition_unmet`/`r3_precedes_restore`, precondition ordering/`RECOVERY_PRECONDITION_UNMET` absent.
- GREEN: `pytest tests/test_core_recovery_security.py` — 36 passed, 1 xfailed (stable over 3 runs).
- `pytest tests/test_core_recovery.py tests/test_core_recovery_security.py tests/test_local_restore.py tests/test_core_service.py tests/test_pr11_phase4_l7_release_builder.py tests/test_mqtt_client.py tests/test_ip_containment.py` — 464 passed, 1 xfailed.
- Release closure (`tests/test_pr11_phase4_l7_release_builder.py`): pass; runtime closure unchanged (no new module): 23 modules plus `__init__`
  — includes `recovery_core`, `recovery_protocol`; `recovery_client` and `recovery_ui` are not in it.
- `ruff check` on changed Python (`database.py`, `local_restore.py`, `recovery_core.py`, the new test) — pass. A pre-existing UP035 in
  untouched `ip_containment.py` remains.
- `git diff --check` — pass.
- Full IDEA3 suite (`pytest tests -q`): 1 failed, 3954 passed, 8 skipped, 1 xfailed in 932 s. The single failure,
  `tests/test_pr11_phase4_harness.py::test_only_reviewed_stage_handlers_are_registered`, fails identically on the unmodified start HEAD `0796c1c6` (unrelated `l7-listener-lib.sh`), verified in a clean worktree.

### Post-L7 / post-PR252 reconciliation verification (HEAD `1d1e6ee3`, parent `ba5caa3c`)

- `pytest tests/test_core_recovery_security.py` — 36 passed, 1 xfailed. The xfail is
  `test_production_supervisor_enforces_r3_before_restore`, `strict=True`, reason `BLOCKED_ON_OWNER_DECISION` (break-glass); unchanged.
- `pytest tests/test_core_recovery.py tests/test_core_recovery_security.py tests/test_local_restore.py tests/test_core_service.py tests/test_mqtt_client.py tests/test_ip_containment.py` — 378 passed, 1 xfailed.
- `pytest tests/test_pr11_phase4_l7_release_builder.py` — 86 passed.
- `ruff check` on the four changed Python/test files — pass; `compileall` — pass; `git diff --check` against the parent — pass;
  `node scripts/validate-vault.mjs` — pass (2 pre-existing canvas warnings); changed-path set against the parent is exactly 5 stack-local paths.
- Full IDEA3 suite (`pytest tests -q`, nothing deselected): 1 failed, 4186 passed, 8 skipped, 1 xfailed in 1202 s. The single failure,
  `tests/test_pr11_phase4_l6c_capture_gap.py::test_real_end_to_end_capture_then_compare_requires_the_allow_file`, fails
  identically on the unmodified parent `ba5caa3c` (run in a temporary detached worktree), so it is not caused by this change and is
  NOT fixed here. The earlier `test_only_reviewed_stage_handlers_are_registered` failure no longer occurs.

## Canonical notes updated

- `None` — repository-only remediation stacked on a Draft PR; no durable project maturity fact changed and the owner's status note
  is not rewritten by this task.

## Shared surfaces touched

- `None` — task stayed inside `IDEA3-AEGIS_Lockdown/` and its receipt. (The audit-DB schema index is IDEA3 Core-owned SQLite.)

## Integration requests

- None — valid: no cross-scope/shared path changed. Owner decisions requested (not integration): F1 alert-source contract and the
  R5 break-glass mechanism, before PR252 may leave Draft.

## Known limitations

- Local, hermetic, simulated evidence only; the AF_UNIX server, Core restart, and real containment helper were never exercised live.
- F1 is unresolved: production R1 remains unreachable until an approved alert source exists.
- R5 ordering is not enforced in production; only its semantics are tested.
- The server is still single-threaded; the deadline bounds one slow client to 5 s rather than removing head-of-line blocking.
