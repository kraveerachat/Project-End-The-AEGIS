# IDEA3 live status transport — design decision (REVIEW READY, NOT IMPLEMENTED, NOT DEPLOYED)

Task: IDEA3 LIVE READ-ONLY STATUS INTEGRATION READINESS (branch `feat/idea3-live-status-readonly-integration`).
Status: `PRODUCTION_STATUS_TRANSPORT_DESIGN=REVIEW_READY`. Nothing in this document is deployed; no Production connectivity was created or tested.

Labels: **VERIFIED** = read from source/tests in this repository or from a read-only inspection recorded in a receipt; **HYPOTHESIS** = reasoned but not verified; **UNKNOWN** = no evidence.

## 1. Facts this design rests on

VERIFIED (repository):
- The Core writes one private file, `status.json`, in its runtime directory (`aegis_soc/runtime.py`, `RuntimeStatus.write`). Production's directory is `0700 aegis-idea3` (systemd `RuntimeDirectoryMode=0700`).
- `safe_status_projection` is the Core's allowlisted, versioned (`schemaVersion: 1`) projection for the Web; `normalizeRuntimeStatus` consumes it and re-evaluates freshness from `generatedAt` (default 120 s window, 5 s future skew).
- The Web's only runtime feed is an HTTP GET to `AEGIS_IDEA3_RUNTIME_STATUS_URL` (`liveProvider.js`); the production compose files do **not** set it, so the Production Web reports IDEA3 Runtime as UNKNOWN (`NOT_CONFIGURED`). The LAB bridge/observer are refused in production (`config.js`).
- The accepted Core↔HUB channel is Phase 2B: the Core is the **client**; the HUB `idea3-core.aegis.internal` server block requires an mTLS client certificate (dedicated client CA + CRL), forwards only `location /security/api/machine/v1/` to the IDEA3 Web machine listener (`172.31.243.3:8004`, body limit 8k, cookies/Origin/forwarding headers stripped). The Web trusts the identity headers only from the pinned HUB peer and requires the single CN `idea3-core` (`createMachineIdentityGuard`).
- The machine app exists only when `dispatch.enabled` is true (`createMachineApp`), and today serves only `GET /dispatch/pending`, `POST /dispatch/:id/claim`, `POST /dispatch/:id/evidence`. Nothing carries status.
- The accepted network model is "wired VLAN 20 → HUB 443" (Core initiates). No HUB→Core inbound path is documented.

VERIFIED (read-only inspection, STEP 38.1/38.2, recorded not re-run here): the Core host had no route to HUB `192.168.10.10`; the Core's AP/broker/dnsmasq units were failing because the Wi-Fi interface was not in AP mode.
UNKNOWN: current Web container image/flags on the HUB; whether Phase 2B was ever executed; whether HUB and Core clocks are NTP-disciplined.

## 2. Options

### A. Web-side authenticated pull (HUB → Core)
The Web would fetch a status document from a listener on the Core.
- Needs a **new Core listener** (TLS server certificate for the Core, client authentication of the Web, firewall rule HUB→Core, a new credential lifecycle) — all new Production authority and exposure on the host that controls the physical lockdown.
- Reverses the accepted initiation direction; the Core host currently has no route to the HUB at all.
- Fits the existing adapter (`fetchJsonDocument` + token), but the adapter only supports a bearer token; mTLS client auth is not implemented there.

### B. Core-side authenticated push (Core → HUB over the existing mTLS machine channel) — **recommended**
The Core process (or a sibling unit running as the same user) periodically sends one small, allowlisted envelope.
- **Least new authority:** reuses the accepted initiation direction, the dedicated client CA/CRL, the pinned HUB peer, the CN check and the 8 KiB body limit. No new Core listener, no inbound firewall rule, no new certificate type.
- **No new nginx location is needed** for `POST /security/api/machine/v1/status`: the existing prefix already forwards it (HYPOTHESIS: to be confirmed by the infrastructure owner against the installed config; the repository file is a candidate, not proof of what is installed).
- The Core reads its own private file as its own user, so no permission on the Core runtime directory changes.
- Cost: needs a Core-side client (Core release), a Web route plus an in-memory store, and a way to enable the machine listener **without** enabling dispatch (see §6). Compatible with the existing adapter contract because the stored record is exactly a `safe_status_projection`.

Recommendation: **B**. Unresolved dependencies are listed in §8.

## 3. Trust boundaries and data flow

```
 ┌──────────────── Core host (private) ────────────────┐        ┌──── HUB 192.168.10.10 ────┐        ┌─ IDEA3 Web (container) ─┐
 │ aegis-idea3-core.service (user aegis-idea3)         │        │ nginx idea3-core.aegis.   │        │ browser app :8003       │
 │   status.json  (0700 dir, private)                  │        │   internal :443           │        │ machine app :8004       │
 │        │ read as owner                              │  mTLS  │  verify client cert (CA,  │ http   │  identity guard (CN,    │
 │  status pusher ──► build envelope ───────────────────┼───────►│  CRL), strip Cookie/XFF,  ├───────►│  pinned HUB peer)       │
 │        │ (allowlisted projection, sentAtMs)         │ POST   │  8k body, only machine/v1 │        │  statusIngest.validate  │
 │        ▼                                            │ /status│                           │        │  in-memory store        │
 │  status projection publisher ──► group-readable      │        └───────────────────────────┘        │  liveProvider ► Admin   │
 │  file (owner-approved dir) ──► Purple Desktop (same host, read-only, no sudo)                       │  session+CSRF+audit     │
 └──────────────────────────────────────────────────────┘                                              └─────────────────────────┘
 Browsers talk only to the browser app through the HUB (Twingate/HTTPS); they never reach :8004 or the Core.
```

Desktop and Web are **independent consumers** of the same Core evidence: the Desktop reads a same-host projection file; the Web receives a pushed envelope. Neither reads the other, and no Desktop-to-Web API is introduced.

## 4. Authenticated read-only API contract (Core → Web)

`POST /security/api/machine/v1/status` — machine app only; mTLS identity guard first; no cookie, no Origin; `Content-Type: application/json`; body ≤ 8 KiB.

Request body (exact keys, unknown keys refused):
```json
{ "schema": "aegis.idea3.status-push", "version": 1, "sentAtMs": 1700000100000,
  "projection": { "schemaVersion": 1, "generatedAt": "2023-11-14T22:14:55.000Z", "status": "HEALTHY",
                  "dispatch": "DISABLED", "components": {"broker": "CONNECTED", "device": "ONLINE", "uplink": "NORMAL", "detector": "RUNNING"},
                  "modes": {"profile": "production", "dryRun": false, "autoContain": false, "armed": "MONITOR_ONLY"},
                  "issues": [], "evidenceSource": "RUNTIME_STATUS_FILE" } }
```
Responses (verified against the existing machine-route contract, which answers JSON with `{error:{code}}` and uses 200/201 for success, 403 for identity, 409 for conflicts and the shared 400/413 parse handler): `200 {"status":"ACCEPTED"}` accepted (the design's earlier `204` was replaced by `200` + JSON so the existing Core client, which parses JSON bodies, needs no special case); `400 STATUS_PUSH_INVALID|STATUS_PUSH_UNSUPPORTED`; `403 MACHINE_IDENTITY_INVALID`; `409 STATUS_PUSH_REPLAY`; `422 STATUS_PUSH_STALE|STATUS_PUSH_FUTURE|STATUS_PUSH_PROFILE`; `413 REQUEST_TOO_LARGE`; `404` when the route group is not enabled. A refusal never changes stored state and writes no evidence. A `200` means the envelope was well formed and newer; it is **not** evidence that the Core or any hardware is healthy.

Implementation (successor task `feat/idea3-live-status-transport`, stacked on PR #443): the contract is `web/server/domain/statusIngest.js`; the route is `createStatusRouter` in `web/server/routes/machineRoutes.js`; it is mounted by `createMachineApp` only when `AEGIS_IDEA3_STATUS_INGEST_ENABLED=true` (independent of `AEGIS_IDEA3_DISPATCH_ENABLED`). The Core side is the optional, disabled-by-default `tools/status_push_client.py`. See `doc/Content/11_STATUS_TRANSPORT_RUNBOOK.md`.

Schema and freshness rules:
- `generatedAt` is the Core's own timestamp (never replaced). Evidence outside the freshness window (120 s) or more than 5 s in the future is refused. The Web still re-evaluates freshness on every read through `normalizeRuntimeStatus`, so a silent Core ages into STALE → UNKNOWN without any new message.
- `sentAtMs` must be strictly greater than the previous accepted envelope and within the same window; `generatedAt` must not move backwards. A replay or reorder is refused.
- A Core restart restarts the process: the pusher derives `sentAtMs` from wall-clock milliseconds, so it stays monotonic across restarts unless the clock steps backwards (then pushes are refused until time catches up, failing closed to UNKNOWN).
- `evidenceSource` must be `RUNTIME_STATUS_FILE`; LAB sources can never be accepted.
- No relay/ACK/heartbeat/physical field exists in the schema, so none can be promoted.

## 5. Failure-mode matrix

| Failure | Web shows | Desktop shows | Notes |
|---|---|---|---|
| Core stopped / pusher stopped | ages to UNKNOWN (STALE) | publisher output ages to UNKNOWN | no stale HEALTHY |
| Core ↔ HUB unreachable | UNKNOWN after ≤120 s | unaffected (same host) | consumers diverge honestly |
| Invalid/expired client cert, revoked CRL | UNKNOWN; 403 at HUB | unaffected | no fallback to a shared token |
| Replay of a captured envelope | refused 409 | n/a | needs the mTLS key to even send |
| Clock skew > window | refused STALE/FUTURE → UNKNOWN | local clock, unaffected | NTP on HUB/Core is a dependency |
| Malformed/oversized/unknown-key body | 400/413, store unchanged | n/a | |
| Contradictory Core state | publisher refuses; Web adapter never HEALTHY | UNKNOWN (CONTRADICTORY) | see consistency matrix S13 |
| Web restarted | UNKNOWN until next push (≤ interval) | unaffected | store is in memory only |
| Dispatch disabled | status route still works only if the status listener is enabled independently | n/a | §6 |

## 6. Source and infrastructure changes still required

IDEA3-owned (repository, reviewable PRs):
1. Web: mount `POST …/machine/v1/status` using `statusIngest` + store, feed `liveProvider` from the store instead of `AEGIS_IDEA3_RUNTIME_STATUS_URL`, audit accepted/refused counts without storing evidence. Add an independent enable flag (for example `AEGIS_IDEA3_STATUS_INGEST_ENABLED`, default false, required in production) so status ingest does not require `dispatch.enabled`.
2. Core: a pusher (in-process or sibling unit) using the Core's existing client certificate; requires a **Core release**. Today's installed Core (`954ce1c1`) predates main by 13 `aegis_soc` files; compatibility with the projection shape must be re-verified against the installed release before any rollout.
3. Desktop: no transport change; consumes the publisher file via `AEGIS_CORE_STATUS_FILE`.

Cross-scope / owner approval (not done, not prepared as commands to run unattended):
- Compose/overlay: expose the machine listener and set the new flag (`HUB`/infrastructure, Kla).
- Confirmation that the installed nginx forwards `machine/v1/status` (or an owner-reviewed one-line location).
- Core-side unit/user/group for the publisher and the pusher (systemd, Kla/infrastructure).
- HUB↔Core reachability and clock discipline (network owner).

## 7. Threat analysis (summary)

| Threat | Mitigation in this design | Residual |
|---|---|---|
| Forged status from the LAN | mTLS client cert + CRL at HUB; pinned HUB peer and CN at the Web; Cookie/Origin refused | compromise of the Core client key |
| Replay | strictly increasing `sentAtMs`, monotonic `generatedAt`, 120 s window, TLS | key theft |
| False HEALTHY | schema carries only Core vocabulary; adapter downgrades contradictions; stale/future → UNKNOWN | a lying Core is still trusted (same as today) |
| Data smuggling in free text | exact-key allowlist, enumerated vocabularies, 8 KiB limit | none |
| Pivot from Web to Core | none: push direction only, no inbound path, no command in the schema | HUB compromise cannot call the Core |
| Dispatch coupling | independent enable flag required | until implemented, enabling the machine app also enables dispatch endpoints |
| Information disclosure to browsers | only Admin session reads the stored projection; no secret in schema | |

## 8. Offline verification strategy and rollout/rollback

Offline (done in this task): pure contract tests, Python↔JS fixture equality, Web/Desktop consistency matrix, production-guard tests. **Not done:** any networked or cross-host test, any mTLS handshake, any HUB check.

Rollout (owner-run, later): (1) HUB read-only inventory; (2) Web image from `main` with the flag off; (3) enable the listener; (4) Core release with the pusher disabled; (5) enable the pusher; (6) verify UNKNOWN→HEALTHY transitions and fail-closed behaviour by stopping the pusher. Rollback: disable the pusher (Web returns to UNKNOWN within the window), disable the Web flag, restore the previous image/compose, point `current` back to the previous Core release.
