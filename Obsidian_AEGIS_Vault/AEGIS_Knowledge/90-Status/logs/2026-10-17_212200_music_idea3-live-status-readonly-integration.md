---
title: Task Receipt — IDEA3 live read-only status integration readiness
date: 2026-10-17T21:22:00+07:00
owner: music
area: idea3
branch: feat/idea3-live-status-readonly-integration
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 live read-only status integration readiness

## What changed

- Desktop status reader (`aegis_soc/observer.py`): the inherited `sudo -n cat` fallback and the `subprocess` import are removed. The reader opens only the configured file (symlink refused, regular file only, non-blocking, 64 KiB bound, portable to platforms without `O_NOFOLLOW`). Permission denied is UNAVAILABLE; missing, malformed, oversized, FIFO/directory, symlinked, stale, future-dated and contradictory evidence are UNKNOWN. A shared `load_status_document` gate is exposed.
- New `tools/status_projection_publisher.py`: a nonprivileged, read-only publisher that re-emits an allowlisted, versioned projection, keeps the Core's own `updated_at`, publishes nothing for unusable sources, replaces its output atomically, and refuses non-owner-controlled, writable, world/group-accessible (without an explicit flag), symlinked or protected destinations. No listener, subprocess, chmod or chown. It was exercised only against disposable directories and is not installed anywhere.
- Web: a pure, non-networked `server/domain/statusIngest.js` contract (not mounted) for a future Core→Web push, with a Python-built cross-language fixture.
- Tests: Desktop reads the published projection and fails closed without a subprocess; a 17-scenario Web/Desktop consistency matrix; production refuses every LAB feed; unauthenticated reads get no status evidence.
- Documentation: transport design decision (`doc/Content/09_…`), operator readiness package (`doc/Content/10_…`), a reference systemd unit marked NOT INSTALLED, README and canonical status.

## Source files changed

- `IDEA3-AEGIS_Lockdown/aegis_soc/observer.py`, `tools/live_purple_desktop.py` (comment/docstring only), `tools/status_projection_publisher.py` (new), `web/server/domain/statusIngest.js` (new, not wired).
- Tests/fixtures: `tests/test_observer.py`, `tests/test_status_projection_publisher.py`, `tests/test_live_status_consistency.py`, `tests/test_live_purple_desktop.py`, `web/tests/server/statusIngest.test.js`, `statusConsistency.test.js`, `liveStatusProductionGuards.test.js`, `web/tests/fixtures/core-status-push.json`, `status-consistency-matrix.json`.
- Docs/deploy template: `README.md`, `doc/Content/09_LIVE_STATUS_TRANSPORT_DESIGN.md`, `doc/Content/10_PRODUCTION_READINESS_PACKAGE.md`, `deploy/aegis-idea3-status-publisher.service.example`.

## Verification evidence

- `npx vitest run` (IDEA3-AEGIS_Lockdown/web) — 46 files, 849/849 passed; `npm run build` — passed.
- `pytest tests/test_observer.py tests/test_status_projection_publisher.py tests/test_live_status_consistency.py tests/test_local_core_web_desktop_integration.py tests/test_local_status_bridge.py tests/test_live_purple_observer.py tests/test_preview_purple_desktop.py tests/test_live_purple_desktop.py tests/test_graceful_exit.py tests/test_local_e2e_acceptance.py` — 161 passed.
- 21 further status/runtime/supervisor/desktop test files were run one by one: all passed except `test_pr11_phase4_l7u_release_builder_recovery_runtime.py` (2 failures, identical on the pre-change `main` code at `def963cd`); `test_pr11_phase4_f1_governed_stage.py` shows the same 1 failure on both trees. These are part of the 135 inherited failures; no new failure was introduced by this task.
- `ruff check` on the changed Python files — passed; `git diff --check` — passed; `node scripts/validate-vault.mjs` — passed with the 2 existing canvas warnings.
- RED→GREEN: the old reader imported `subprocess` and called `sudo -n cat`, and blocked on a FIFO path (the first run of the new FIFO test hung against it); the new tests pass against the new reader.
- Not run: the full Python suite (135 inherited failures remain; it is not green), any networked, mTLS, HUB, MQTT, hardware or Production check, GUI manual acceptance with a real Core status.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — new section "IDEA3 live read-only status integration readiness — repository-only — 2026-10-17".

## Shared surfaces touched

- None — all changes are inside `IDEA3-AEGIS_Lockdown/` and the IDEA3 canonical note/receipt. The design records, but does not change, HUB/NGINX/Compose/network items owned by infrastructure.

## Integration requests

- None — valid only when no cross-scope/shared path changed

## Known limitations

- Not Production live: no Production, HUB, network, MQTT, ESP32, CUT/RESTORE or hardware activity occurred; the installed Core release `954ce1c1` is behind `main`; the publisher is not installed; the Core→Web push is a reviewed design with an unmounted contract, not a working transport.
- Infrastructure issues observed earlier (AP down, `aegis-idea3-mosquitto` restart loop, `dnsmasq` failed, plaintext `1883`, no Core→HUB route) are classified separately and were not touched.
- Web and Desktop differ for a contradictory document (Desktop UNKNOWN, Web DEGRADED, never HEALTHY); documented in the consistency matrix.
- 135 inherited Python failures, no functional CI, badge clipping (VISUAL_MINOR), human-reported 390px result, no hardware E2E; ACK, relay and heartbeat never prove physical isolation. AI review is not Human Approval.
