---
title: Task Receipt — IDEA3 live status transport implementation (offline)
date: 2026-10-17T23:55:00+07:00
owner: music
area: idea3
branch: feat/idea3-live-status-transport
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 live status transport implementation (offline)

## What changed

- Web config: new independent flag `AEGIS_IDEA3_STATUS_INGEST_ENABLED` (default false) and a shared `config.machine` listener setting. The machine listener starts only when dispatch or status ingest is enabled; the existing `config.dispatch` shape and behaviour are unchanged. Enabling status ingest never enables dispatch; combining it with a polled/LAB runtime URL is refused at load.
- Machine app: `createMachineApp` mounts dispatch and status route groups independently; a group that is off answers 404. Status pushes do not count as dispatch machine contact.
- New route `POST /api/machine/v1/status` (`createStatusRouter`): exact schema, 8 KiB, strict increasing order, bounded in-memory store, production accepts only `profile: production`; responses 200/400/403/409/413/422.
- `statusIngest.js`: documentation reference corrected (`09_…`, not `05_…`), optional `allowedProfiles`, new refusal `STATUS_PUSH_PROFILE`.
- Web live provider: with the flag on, the accepted projection is the only runtime source; missing/expired/rejected evidence is UNKNOWN with no URL fallback. Without the flag the provider is unchanged.
- New `tools/status_push_client.py`: optional Core-initiated mTLS pusher (disabled by default, no listener, no queue or replay, bounded backoff, no redirects, bounded response, no credentials on the command line). Not part of the Supervisor.
- Offline end-to-end harness with disposable certificates over real TLS; deployment templates (not installed) and a Production runbook.
- Hardening pass (STEP 38.5): the runbook's unsafe "stop the Core status writer" acceptance step was replaced by synthetic/offline, push-client-only and passive checks; a test proves accepting status touches no repository; `doc/Content/12_PRODUCTION_PREDEPLOYMENT_READINESS.md` adds the Core release compatibility report (installed `954ce1c1`), a read-only HUB command package and the readiness matrix.
- Packaging closure (STEP 38.6): the Core release contract is unchanged. The status publisher, pusher and observer ship in a separate stdlib-only, manifest- and SHA-256-verified status sidecar package (`deploy/status-sidecar/build-status-sidecar.py`, six-file allowlist, no Core/MQTT/restore/CUT module, strict verifier). `aegis_soc/status_projection.py` mirrors `runtime.safe_status_projection` (runtime.py not changed) and is pinned by a parity test; the publisher imports the mirror. Unit templates now run from the sidecar. No installer exists and nothing was installed. Option A (extend the Core builder) is documented as a proposal needing owner approval (`doc/Content/13_STATUS_SIDECAR_PACKAGING.md`).
- Installer readiness (STEP 38.7): `deploy/status-sidecar/install-status-sidecar.py` (`plan`/`install`/`activate`/`rollback`/`status`) implemented and tested on disposable roots only; inert unless an owner runs it; live use needs root; touches only `/opt/aegis-idea3-status`; no systemd/Docker/network/device action. Manifest gained `python_requires_min` and runtime checks (floor 3.11, tested minor, CPython/POSIX). Both unit templates hardened and the publisher's `[Install]` removed. The offline Node E2E now runs the pusher from a freshly built sidecar (17 tests incl. an authenticated UI snapshot and pusher-failure containment). Owner package: `doc/Content/14_STATUS_SIDECAR_DEPLOYMENT_READINESS.md`.
- Installer hardening (STEP 38.8): fixture-root aliasing fixed (`--host-root /` previously resolved to the real `/opt/aegis-idea3-status` with the ownership check disabled; reproduced by constructing the layout only) with a canonical-path, system-location, production-overlap and approval-marker contract; `source_tree_dirty: true` is now refused for install/plan/activate/rollback outside a validated fixture. Added unit-umask, no-leak, symlink-substitution and CUT/RESTORE-identifier tests.
- Consolidation (STEP 38.9): this branch is the single integration candidate, opened as Draft PR #444 against `main` containing PR #443's 7 commits unchanged as ancestors plus this task's 7 commits (14 total). #443 was closed without merging, its branch left in place, and its receipt is declared under Inherited task receipts. Added `doc/Content/15_PRODUCTION_ACTIVATION_RUNBOOK.md` (owner-only procedure, read-only host observations). Source frozen at `77d9ccac`; later commits touch documentation and this receipt only.

## Source files changed

- `IDEA3-AEGIS_Lockdown/web/server/config.js`, `createMachineApp.js`, `createApp.js`, `runtime.js`, `index.js`, `routes/machineRoutes.js`, `security/machineIdentity.js`, `domain/statusIngest.js`, `providers/liveProvider.js`; `tools/status_push_client.py` (new).
- Tests/fixtures: `tests/test_status_sidecar_installer.py` (83), `tests/test_status_sidecar_units.py`, `tests/test_status_sidecar_integration.py` (34), `tests/fixtures/build_sidecar_fixture.py`, driver sidecar mode, `tests/test_status_sidecar_release.py` (50), `tests/test_status_projection_mirror.py` (208 incl. 6240-case vocabulary product), `web/tests/server/statusIngestRoute.test.js`, `statusTransportE2E.test.js`, `tests/test_status_push_client.py`, `tests/fixtures/status_push_driver.py`.
- Docs/deploy templates: `doc/Content/09_…` (updated), `doc/Content/11_STATUS_TRANSPORT_RUNBOOK.md`, `doc/Content/12_PRODUCTION_PREDEPLOYMENT_READINESS.md`, `doc/Content/13_STATUS_SIDECAR_PACKAGING.md`, `deploy/status-sidecar/build-status-sidecar.py`, `deploy/status-sidecar/install-status-sidecar.py`, `doc/Content/14_STATUS_SIDECAR_DEPLOYMENT_READINESS.md`, both status unit templates, `aegis_soc/status_projection.py`, `tools/status_projection_publisher.py` (import only), `deploy/aegis-idea3-status-push.env.example`, `deploy/aegis-idea3-status-push.service.example`.

## Verification evidence

- `npx vitest run` (IDEA3-AEGIS_Lockdown/web) — 48 files, 906/906 passed (849 before this task); `npm run build` — passed. The Web package has no lint script.
- `pytest tests/test_status_push_client.py tests/test_observer.py tests/test_status_projection_publisher.py tests/test_live_status_consistency.py tests/test_local_core_web_desktop_integration.py tests/test_local_status_bridge.py tests/test_live_purple_observer.py tests/test_preview_purple_desktop.py tests/test_live_purple_desktop.py tests/test_graceful_exit.py tests/test_local_e2e_acceptance.py tests/test_dispatch_client.py tests/test_dispatch_boundary.py` — 264 passed.
- `ruff check` on the new Python files — passed (pre-existing findings in untouched `tools/preview_purple_desktop.py` and `purple_ui_source` remain).
- Offline end-to-end (14 tests) ran the real Python client against a real mTLS front and the real machine app on loopback; no HUB, Core broker, MQTT or ESP32 was contacted.
- STEP 38.6: `pytest tests/test_status_sidecar_release.py tests/test_status_projection_mirror.py` — 258 passed. Real offline sidecar build/verify from a disposable git repo PASSED (6 files). The Core `verify` refuses the sidecar (`UNEXPECTED_TOP_LEVEL`). Four closure tests (`test_runtime_closure_is_exact`, `test_closure_is_computed_from_source_not_hard_coded`, and two in the L7u recovery-runtime file) fail identically on `origin/main` (stale `local_cut` pin); not caused by this task.
- STEP 38.7: focused Python set (release builder/guard/installer, L7u, F1u, R1Du, status, installer, units, integration, observer, runtime, dispatch, Core/Web/Desktop, Recovery) — 1900 passed, 6 failed; all 6 fail identically on `origin/main` (4 stale `local_cut` closure pins + 2 `test_pr11_phase4_l7u_stage_governance` fixture tests), none introduced here. Web Vitest 48 files 909/909, `npm run build` passed. `systemd-analyze verify` on both units (non-mutating): only the intentional group placeholder note. Read-only host inspection: Python 3.14.7 x86_64, `aegis-idea3` uid 952 present, no status group, NTP synchronized, 1883 listening on all interfaces, no 8883 listener.
- STEP 38.8: same focused Python set — 1944 passed, 6 failed (the same 6 that fail on `origin/main`; none new). Web Vitest 48 files 909/909, `npm run build` passed. `ruff` clean on the sidecar files and tests. Real `/opt/aegis-idea3-status` never created or written.
- Not run: the full Python suite (135 inherited failures; not green), any Production, HUB, network, MQTT, hardware or manual GUI check.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — new section "IDEA3 live status transport implementation — offline source — 2026-10-17".

## Shared surfaces touched

- None changed. The HUB nginx block, certificates, Compose and network are infrastructure-owned and were only read; the runbook records what the infrastructure owner must confirm.

## Integration requests

- None — valid only when no cross-scope/shared path changed

## Inherited task receipts

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-10-17_212200_music_idea3-live-status-readonly-integration.md` — receipt of Draft PR #443, on which this successor branch is stacked; it is not a receipt of this task.

## Known limitations

- Not Production live: no Production, HUB, network, MQTT, ESP32, CUT/RESTORE or hardware activity occurred; the Core release installed on the host does not contain the push client and no owner-run sidecar installer exists; nothing is installed or enabled.
- Stacked successor: this branch depends on PR #443 (not yet in `main`). Its mergeable Draft PR must wait until #443 reaches `main`; AI review is not Human Approval.
- Per-process in-memory store; a still-fresh replay is acceptable once after a Web restart (requires the Core mTLS key); a compromised key can push false but well-formed evidence; relay/ACK/heartbeat stay UNKNOWN.
- Infrastructure issues from STEP 38.1/38.2 (AP down, broker restart loop, dnsmasq failed, plaintext 1883, no Core→HUB route) are untouched. 135 inherited Python failures, no functional CI.
