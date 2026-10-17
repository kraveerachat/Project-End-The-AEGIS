---
title: Task Receipt — IDEA3 LAB MQTT read-only observer
date: 2026-10-17T12:59:00+07:00
owner: music
area: idea3
branch: fix/idea3-lab-mqtt-observer
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 LAB MQTT read-only observer

## What changed

- Strictly opt-in (`AEGIS_IDEA3_LAB_MQTT_OBSERVER=true`, refused in production) subscribe-only observer for `aegis/status` on the fixed loopback LAB broker `127.0.0.1:1883`. It runs one `mosquitto_sub` child using the owner-only credential options file (`-o`); no password is placed on a command line, read, logged or returned.
- One Admin-only, GET-only route `GET /api/security/lab-mqtt`, separate from the Core snapshot. A Demo session and a disabled feature both receive a disabled view; DEMO never becomes LIVE.
- One compact "LAB MQTT Observation" panel on the Lockdown page, shown only when the server reports the observer enabled. It shows ESP32-reported state, RSSI, free heap, profile, time_ok, last local reception time, freshness and read-only provenance; stale, missing or disconnected evidence shows UNKNOWN.
- Retained, malformed, oversized, extra-key and out-of-range payloads are rejected and counted. Freshness uses the local reception time and `AEGIS_MAX_EVIDENCE_AGE_MS` (default 120 s). The Core normalizer is unchanged. Core, physical relay, ACK, signed heartbeat and LAN isolation are never marked healthy from MQTT.

## Source files changed

- `IDEA3-AEGIS_Lockdown/web/server/providers/labMqttObserver.js` — new observer (parser, lifecycle, options-file permission check).
- `IDEA3-AEGIS_Lockdown/web/server/config.js` — `labMqtt` opt-in config, production rejection.
- `IDEA3-AEGIS_Lockdown/web/server/createApp.js` — observer start/stop wiring.
- `IDEA3-AEGIS_Lockdown/web/server/routes/securityRoutes.js` — read-only `GET /lab-mqtt`.
- `IDEA3-AEGIS_Lockdown/web/src/components/LabMqttObservation.jsx` — panel and polling section.
- `IDEA3-AEGIS_Lockdown/web/src/pages/LockdownPage.jsx` — mounts the section.
- `IDEA3-AEGIS_Lockdown/web/tests/server/labMqttObserver.test.js` — 38 server tests.
- `IDEA3-AEGIS_Lockdown/web/tests/client/labMqttPanel.test.jsx` — 2 client tests.

## Verification evidence

- `npx vitest run tests/server/labMqttObserver.test.js tests/client/labMqttPanel.test.jsx` — pass: 40/40.
- `npx vitest run` (full) — 9 failed / 739 passed. The same 9 fail on the PR #436 baseline (missing `deploy/docker-compose.pr11-*.yml`, `dispatchContract`, `liveContract.acceptance`); no new failure.
- `npm run build` — pass.
- Local smoke (loopback port 18193, development mode, no sudo, no publish): unauthenticated request 401; authenticated Admin read returned `OBSERVED`/`FRESH`, state LOCKDOWN, rssi -10, heap 250196, profile 0, time_ok true, from a real non-retained ESP32 `aegis/status` message.

## Canonical notes updated

- `None` — durable facts will be reconciled by the owner after review.

## Shared surfaces touched

- `None` — task stayed inside `IDEA3-AEGIS_Lockdown/`.

## Integration requests

- None — valid only when no cross-scope/shared path changed

## Inherited task receipts

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-10-17_095900_music_idea3-lab-evidence-contract.md` — PR #436, unmodified; this PR is stacked on it.

## Known limitations

- The retained-message rejection and stale/disconnect paths are proven by automated tests, not by a live capture.
- ESP32 state vocabulary is shape-validated, not enumerated, because the firmware vocabulary is not recorded in this repository.
- `mosquitto_sub` does not report CONNACK, so "connected" is inferred from process liveness plus message freshness.
- The PR #436 Core status-semantics gap (Core HEALTHY with uplink LOCKDOWN → overall HEALTHY) remains open and untouched.
- 9 pre-existing full-suite failures. Production Core, TLS 8883, dnsmasq, relay firmware and networking are out of scope and untouched.
