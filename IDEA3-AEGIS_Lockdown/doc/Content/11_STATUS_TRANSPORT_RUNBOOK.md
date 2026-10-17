# 11 — Core → Web status transport: Production runbook (NOT EXECUTED)

Status: repository source and offline tests only. **Nothing in this document has been run on a Production host.** Every command is an owner action that needs a written maintenance window. This runbook does not claim Production LIVE.

## 1. What exists

| Part | Where | Default |
|---|---|---|
| Status-ingest flag | Web env `AEGIS_IDEA3_STATUS_INGEST_ENABLED` | `false` |
| Status route `POST /security/api/machine/v1/status` | `createStatusRouter`, mounted by `createMachineApp` | not mounted |
| In-memory store | `createStatusIngestStore` (one record, never durable) | not created |
| Web live provider | reads the store as the only runtime source when the flag is on | polled `AEGIS_IDEA3_RUNTIME_STATUS_URL` path unchanged when off |
| Core push client | `tools/status_push_client.py` | disabled unless `AEGIS_CORE_STATUS_PUSH_ENABLED=1` |
| Templates | `deploy/aegis-idea3-status-push.env.example`, `.service.example` | not installed, no `[Install]` |

Flag truth table (machine listener = dispatch OR status):

| DISPATCH_ENABLED | STATUS_INGEST_ENABLED | Machine listener | Routes |
|---|---|---|---|
| false | false | not started | none |
| true | false | started | dispatch only (status → 404) |
| false | true | started | status only (every dispatch route → 404) |
| true | true | started | both, independent |

Status ingest never enables dispatch, MQTT, CUT or RESTORE. The flag cannot be combined with `AEGIS_IDEA3_RUNTIME_STATUS_URL` or LAB runtime status (config refuses to load), so there is no silent fallback to a polled or LAB endpoint.

## 2. Prerequisites (all owned by the infrastructure owner)

1. The existing Phase 2B machine channel: nginx block `idea3-core.aegis.internal`, dedicated client CA and CRL, `ssl_verify_client on`, location `/security/api/machine/v1/` with `client_max_body_size 8k`, proxy to the IDEA3 machine listener, headers `X-Aegis-Client-Verify` / `X-Aegis-Client-Dn` overwritten and cookies/Origin/forwarded headers blanked. No nginx change is required by this code (the status path is under the existing prefix); the owner confirms this.
2. Web env (on the HUB-side IDEA3 container): `AEGIS_IDEA3_DISPATCH_HOST`, `_PORT`, `_TRUSTED_PROXY` (must equal `AEGIS_WEB_TRUSTED_PROXY`), `_EXPECTED_SUBJECT=idea3-core` — the same variables dispatch uses; plus `AEGIS_IDEA3_STATUS_INGEST_ENABLED=true`. The machine port stays application-internal and is never host-published.
3. Core → HUB route and name resolution for `idea3-core.aegis.internal` (observed missing from the Core host in STEP 38.1/38.2; infrastructure item).
4. Certificates: Core client certificate signed by the machine client CA with CN `idea3-core`; server CA file on the Core; CRL current. Certificates must be valid for both hosts' clocks.
5. Clocks: both hosts within a few seconds (NTP/chrony). Evidence freshness is 120 s and a 5 s future skew is tolerated; a skewed Core is refused (`STATUS_PUSH_FUTURE`/`STALE`) and the Web shows UNKNOWN.
6. Production profile: with `NODE_ENV=production` the Web accepts only `profile: production` Core evidence (LAB/development evidence is refused with `STATUS_PUSH_PROFILE`).

## 3. Trust boundaries

- Source: the Core's private `status.json` (0700 runtime dir). The push client reads it through the Desktop's fail-closed gate (regular file, ≤ 64 KiB, no symlink, fresh, not future, not contradictory). It needs read access as the Core user or an explicitly granted group — an owner decision; this task changed no permission.
- Transport: Core-initiated HTTPS only, TLS ≥ 1.2, certificate and hostname verified, mTLS client certificate, no redirects followed, 5 s timeout, response ≤ 16 KiB. No insecure fallback; credentials are only file paths in the environment.
- Destination: the machine app trusts only the pinned HUB socket peer plus a `SUCCESS` verify header plus exactly one CN equal to the expected subject. Browsers (cookie/Origin) are refused; unauthenticated callers receive no status data.
- Storage: one in-memory record per Web process. Nothing durable, no raw Core configuration, no secrets.

## 4. Expected failure behavior

| Event | Web | Core client |
|---|---|---|
| Push client never started / flag off | UNKNOWN (no projection) | n/a |
| Core status missing/stale/future/contradictory | last record ages out → UNKNOWN | sends nothing, logs a category |
| Network/TLS/hostname failure | UNKNOWN once the record ages out | RETRY, bounded backoff (≤ 60 s), no queue |
| Wrong identity (403) | unchanged | CREDENTIAL, backoff |
| Replay/reorder (409), stale/future/profile (422), invalid (400) | unchanged state | DROPPED; next cycle sends fresh evidence |
| Web restart | UNKNOWN until the next push | continues |
| Core restart | ages to UNKNOWN, then recovers | new process, newer timestamps |
| Broker disconnected / device offline / LOCKDOWN / dry-run | FAILED/DEGRADED/not HEALTHY | n/a |

Relay, ACK and heartbeat stay UNKNOWN: the Core projection carries no per-message or physical evidence for them.

## 5. Rollback

1. Set `AEGIS_CORE_STATUS_PUSH_ENABLED=0` (or stop the push unit) — the Web falls to UNKNOWN within 120 s.
2. Set `AEGIS_IDEA3_STATUS_INGEST_ENABLED=false` and restart the Web container — the status route disappears; dispatch is unaffected.
3. Remove the unit/env files. Nothing else was changed by the feature (no database, no nginx, no firewall).

## 6. Manual Production acceptance (owner, with a maintenance window)

1. `curl` is **not** used with `-k`. From the Core host, with the Core client certificate: `GET` any non-status machine path must be 404 in status-only mode; an unauthenticated request must fail the TLS handshake.
2. Start the Web with the flag; confirm the Admin snapshot is UNKNOWN (no projection).
3. Run `python -m tools.status_push_client --once` with the enabled env: expect `ACCEPTED`; Admin snapshot shows the Core's own `generatedAt`, status not HEALTHY unless the Core says so; relay/ACK/heartbeat UNKNOWN.
4. Prove the Web cannot keep showing fresh evidence after updates cease **without touching the Core**. The Core, its status writer and its supervisor are never stopped, restarted or paused for this test. Choose one:
   - **Offline (already automated, synthetic):** `web/tests/server/statusIngestRoute.test.js` ("an expired projection becomes UNKNOWN") and `statusTransportE2E.test.js` ("missing, stale, future and contradictory sources send nothing"). This proves the code path in a disposable environment only; it is **not** Production acceptance.
   - **Production, push-client-only interruption (separate maintenance window, owner-authorized):** stop or disable only the optional push unit (`AEGIS_CORE_STATUS_PUSH_ENABLED=0` / stop `aegis-idea3-status-push`), leaving `aegis-idea3-core.service` running. Observe the Admin snapshot: it keeps the Core's last `generatedAt`; after the 120 s freshness window the runtime status must become UNKNOWN/STALE and must never show HEALTHY with a fresh age. Then re-enable the push unit and confirm recovery.
   - **Production, passive check:** do not interrupt anything; read `generatedAt` and `evidenceAgeMs` over several minutes and confirm they advance only while pushes arrive (a frozen `generatedAt` must age into STALE).
5. Replay the same envelope with the Core key: 409.
6. Confirm no MQTT publish, no relay/CUT/RESTORE occurred and the audit database gained no row.

## 6a. Offline verification versus Production acceptance

Offline tests use synthetic Core status, test-only certificates and ephemeral loopback ports; they prove the code's fail-closed behavior. They do **not** prove the HUB nginx block, the real certificates, DNS/routing from the Core host, the real Core status schema on the installed release, clocks, or any physical state. Production acceptance (section 6) is a separate, owner-run, human-observed step and is not performed by this repository work.

## 6b. Release packaging (STEP 38.5 found the gap; STEP 38.6 closes it in source)

The Core release builder (`deploy/pr11-phase4/p4-l7-build-release.py`) ships only the `aegis_soc` module closure of four entrypoints, and the release guard, the installer and the F1u/R1Du/RRu upgrade engines pin that exact layout. `tools/` and `aegis_soc/observer.py` are not in it, so the push client and publisher can never run from an installed Core release. The Core release contract is deliberately **unchanged**.

Instead the status components ship in a separate, immutable, stdlib-only **status sidecar** package built by `deploy/status-sidecar/build-status-sidecar.py` (explicit six-file allowlist, `SIDECAR-MANIFEST.json`, `SIDECAR-SHA256SUMS`, no venv, no Core module). Units run `/usr/bin/python3 -E -s -B -m tools.<module>` from `/opt/aegis-idea3-status/current` (templates only). The installed Core release stays byte-identical. **Still open:** an owner-run, root-owned installer for `/opt/aegis-idea3-status/releases/<id>` and its `current` switch does not exist and is not authorized; nothing was installed. See `doc/Content/13_STATUS_SIDECAR_PACKAGING.md`.

## 7. Known limitations

- Multi-process Web: the store is per process; run one Web process or accept that each process only knows what was pushed to it.
- After a Web restart, a captured still-fresh envelope could be accepted once more (replay protection is in-memory); the window is the 120 s freshness and an attacker needs the Core's mTLS key.
- A compromised Core key can push false but well-formed evidence; physical state is never proven by this channel.
- The Web has no lint script, there is no functional CI, and the full Python suite is not green (inherited).
