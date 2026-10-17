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

## Source files changed

- `IDEA3-AEGIS_Lockdown/web/server/config.js`, `createMachineApp.js`, `createApp.js`, `runtime.js`, `index.js`, `routes/machineRoutes.js`, `security/machineIdentity.js`, `domain/statusIngest.js`, `providers/liveProvider.js`; `tools/status_push_client.py` (new).
- Tests/fixtures: `web/tests/server/statusIngestRoute.test.js`, `statusTransportE2E.test.js`, `tests/test_status_push_client.py`, `tests/fixtures/status_push_driver.py`.
- Docs/deploy templates: `doc/Content/09_…` (updated), `doc/Content/11_STATUS_TRANSPORT_RUNBOOK.md`, `deploy/aegis-idea3-status-push.env.example`, `deploy/aegis-idea3-status-push.service.example`.

## Verification evidence

- `npx vitest run` (IDEA3-AEGIS_Lockdown/web) — 48 files, 905/905 passed (849 before this task); `npm run build` — passed. The Web package has no lint script.
- `pytest tests/test_status_push_client.py tests/test_observer.py tests/test_status_projection_publisher.py tests/test_live_status_consistency.py tests/test_local_core_web_desktop_integration.py tests/test_local_status_bridge.py tests/test_live_purple_observer.py tests/test_preview_purple_desktop.py tests/test_live_purple_desktop.py tests/test_graceful_exit.py tests/test_local_e2e_acceptance.py tests/test_dispatch_client.py tests/test_dispatch_boundary.py` — 264 passed.
- `ruff check` on the new Python files — passed (pre-existing findings in untouched `tools/preview_purple_desktop.py` and `purple_ui_source` remain).
- Offline end-to-end (14 tests) ran the real Python client against a real mTLS front and the real machine app on loopback; no HUB, Core broker, MQTT or ESP32 was contacted.
- Not run: the full Python suite (135 inherited failures; not green), any Production, HUB, network, MQTT, hardware or manual GUI check.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — new section "IDEA3 live status transport implementation — offline source — 2026-10-17".

## Shared surfaces touched

- None changed. The HUB nginx block, certificates, Compose and network are infrastructure-owned and were only read; the runbook records what the infrastructure owner must confirm.

## Integration requests

- None — valid only when no cross-scope/shared path changed

## Inherited task receipts

- `2026-10-17_212200_music_idea3-live-status-readonly-integration.md` — receipt of Draft PR #443, on which this successor branch is stacked; it is not a receipt of this task.

## Known limitations

- Not Production live: no Production, HUB, network, MQTT, ESP32, CUT/RESTORE or hardware activity occurred; the Core release installed on the host does not contain the push client; nothing is installed or enabled.
- Stacked successor: this branch depends on PR #443 (not yet in `main`). Its mergeable Draft PR must wait until #443 reaches `main`; AI review is not Human Approval.
- Per-process in-memory store; a still-fresh replay is acceptable once after a Web restart (requires the Core mTLS key); a compromised key can push false but well-formed evidence; relay/ACK/heartbeat stay UNKNOWN.
- Infrastructure issues from STEP 38.1/38.2 (AP down, broker restart loop, dnsmasq failed, plaintext 1883, no Core→HUB route) are untouched. 135 inherited Python failures, no functional CI.
