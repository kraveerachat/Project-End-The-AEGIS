# IDEA3 PR10 — Real Deployment Inventory and Architecture Gate (S1)

```text
DOCUMENT_STATE        = DRAFT — S1 deliverable for owner architecture review (public-safe edition)
TASK                  = PR10 real Arch Linux Core + server-hosted IDEA3 Web deployment baseline
SESSION               = S1 — real infrastructure inventory + architecture gate
AREA / OWNER          = idea3 / music
BRANCH                = feat/idea3-pr10-real-deployment
BASE_SHA              = 895c79ac8ab9b39f322919fabc9facfdc34ba20b (origin/main, PR #119 merge)
S1_CHECKPOINT         = recorded in the PR10 Session Register (idea3/idea3-status.md)
INVENTORY_DATE        = 2026-09-11 (Asia/Bangkok)
PRODUCTION_MUTATION   = NONE
HARDWARE_TESTING      = NOT RUN
SERVER_ACCESS         = ACCESS_NOT_AVAILABLE (no approved network path from the inventory host)
READY_FOR_PR10_S2     = NO
PRODUCTION_DEPLOYED   = NO
IDEA3_PRODUCTION_COMPLETE = NO
```

This document records what S1 measured or read. It is not a design, an
implementation plan, or deployment evidence, and it authorizes no Production
change.

> [!note] Public-safe edition
> The repository is public. This edition keeps the architectural conclusions,
> evidence states, and decisions, and deliberately omits:
> - host and container addresses and subnets;
> - listener bind details and port exposure;
> - host-hardening findings and remote-access specifics;
> - tunnel implementation details and operational file paths.
>
> Addressing for the AEGIS network stays with the infrastructure owner's canonical
> notes. Re-collect host-level specifics in an owner-controlled location when a
> decision needs them.

## Evidence legend

| Label | Meaning in this document |
|---|---|
| **PROVEN** | Verified during S1 by a direct read-only command, or by reading current source at `895c79ac` |
| **OBSERVED** | Recorded in canonical notes or receipts by an earlier task. Carried forward, not re-verified live in S1 |
| **INFERRED** | Reasoned from PROVEN or OBSERVED facts. Must be confirmed before anyone relies on it |
| **NOT PROVEN** | No evidence was available in S1 |
| **NOT TESTED** | Deliberately not exercised in S1 |

## Summary verdict

- **Feasible, blocked on decisions.** The target architecture is feasible, but decisions D1–D4 (§14) block it and no design exists yet.
- **Server not inspected live.** The AEGIS Server is unreachable from the inventory host, so every server fact is carried forward from earlier audited documentation.
- **Arch is a candidate Core host, not a ready one.** It is not yet attached to the final AEGIS network segment, and its hardening is not at a production baseline.
- **ESP32 network undefined.** The recorded ESP32 control-plane history used a temporary lab network outside the AEGIS VLANs, so the final ESP32 network attachment is undefined.
- **The relay isolates the server's uplink.** A server-hosted Web therefore cannot sit inside the CUT → RESTORE control loop. **Core, broker, and RESTORE authority must survive a server-side CUT.**

---

## 1. Git baseline

| Fact | Value | Evidence |
|---|---|---|
| Branch | `feat/idea3-pr10-real-deployment` | PROVEN |
| Base / `origin/main` at S1 start | `895c79ac8ab9b39f322919fabc9facfdc34ba20b` (matches the expected baseline) | PROVEN |
| Working tree at S1 start | clean | PROVEN |
| PR #119 (pre-flight reconciliation) | merged into `main` as `895c79ac` | PROVEN |
| PR9 / GitHub #115 | merged at `2c21cc3e` | PROVEN |
| Open GitHub PRs at S1 | #118 only (Draft, IDEA1 public-share S5.5) | PROVEN |
| Separate worktree with unrelated IDEA3 Web work | not accessed, modified, stashed, or cleaned | PROVEN |

Draft PR #118 plans Production network changes for IDEA1. Any PR10
infrastructure step must be sequenced with it (§7).

## 2. AEGIS Server inventory

**`SERVER_ACCESS = ACCESS_NOT_AVAILABLE`.** The AEGIS Server is unreachable from
the inventory host, and no approved remote-access path was active. S1 attempted
no authentication and created, changed, or borrowed no credential. A credential
belonging to another owner's service was present on the host and was
deliberately **not** used.

Everything below is **OBSERVED** carry-forward from the Phase B Formal
Production Audit (2026-08-15/16) and the IDEA1 S5.4 receipt (2026-09-11).
Addresses and paths are left to those infrastructure notes.

| Item | Recorded state | Evidence |
|---|---|---|
| Host | AEGIS Server, headless Ubuntu Server on the Beelink Mini S, VLAN 10 Server Zone | OBSERVED; current OS version NOT PROVEN |
| Workloads | PostgreSQL, IDEA1 Drive, IDEA2 Monitor, HUB/NGINX, Twingate connector, and the IDEA1 public-share Gateway, all as Docker Production workloads with restart policies | OBSERVED |
| Networking | Docker bridge networks plus a VLAN 10 macvlan for Drive and Monitor. A dedicated HUB↔Drive proxy network and IDEA1 public-share edge/upstream networks also exist | OBSERVED |
| Persistence | named volumes for PostgreSQL and Drive; one volume of unknown ownership that **must not be deleted**; runtime-only bind mounts for Monitor clips, HUB NGINX config, and TLS material | OBSERVED |
| Orchestration | runtime-only Production Compose, not Git-tracked, separate from the repository's dev Compose | OBSERVED |
| Production `.env` | exists with restrictive permissions; variable names **not inspected in S1** | OBSERVED / NOT PROVEN |
| CURRENT_IDEA1_RUNTIME | healthy at the last audit; S5.4 network state applied; public-share UI off | OBSERVED |
| CURRENT_IDEA2_RUNTIME | healthy; image rollback/provenance gap recorded (**do not recreate or rebuild**) | OBSERVED |
| CURRENT_HUB_RUNTIME | NGINX with TLS; routes `/`, `/drive/`, `/monitor/`; routing-only | OBSERVED |
| CURRENT_REVERSE_PROXY | HUB container NGINX; the live config is runtime-only, and its drift from Git `HUB-AEGIS_Entry/nginx.conf` is unaudited | OBSERVED / NOT PROVEN |
| CURRENT_PUBLIC/INTERNAL ROUTES | internal HTTPS entry through Twingate; **no `/security/` route** | OBSERVED (repo HUB config) |
| CURRENT_TWINGATE_STATE | connector healthy at the last audit; SSH and Web resources configured | OBSERVED |
| Host firewall | a default-deny host policy was recorded at the last audit | OBSERVED |
| IDEA3 on the server | none deployed | OBSERVED; live NOT PROVEN |
| Host Node.js / Python for a non-container Web | unknown | NOT PROVEN |
| Live listeners, routes, and ports | not measurable | **NOT PROVEN** |

## 3. Arch Linux inventory (candidate Core host)

**PROVEN** by read-only commands. Personal, workstation, and home-network
details are omitted.

| Item | Summary |
|---|---|
| ARCH_HOSTNAME | a distribution-default hostname, not an AEGIS host identity |
| Host type | Arch Linux on a laptop; current kernel |
| ARCH_NETWORK_SUMMARY | attached to a non-AEGIS network; **not yet on the final AEGIS network segment**; a wired interface exists but is not connected |
| ARCH_DEFAULT_ROUTE | via the non-AEGIS network; no AEGIS route |
| ARCH_PYTHON | Python 3.14 is available. The system `paho-mqtt` is older than the project pin (`paho-mqtt==2.1.0`), and a non-project interpreter is first on `PATH`. A dedicated project venv is required. No project venv exists in this worktree |
| Node.js | a version satisfying Web `engines >= 22.13.0` is available (not needed if Web is server-only) |
| ARCH_SYSTEMD | systemd present; system state `running` |
| Time | NTP synchronized |
| ARCH_EXISTING_AEGIS_SERVICES | an MQTT broker service and two IDEA2-owned services (Detection Engine and its connectivity helper). **No IDEA3 unit, Core process, or IDEA3 systemd file exists** |
| Other AEGIS processes | a local IDEA3 Web development instance from a separate worktree; not touched |
| Remote-access client | installed, not running |
| Host hardening | **not at a production baseline** for a Core host (power management, host firewall, service account, service exposure). Specifics withheld |

### ARCH_RELEVANT_LISTENERS

Summarized, not itemized:
- The existing MQTT broker is the only broker found (§8).
- The IDEA3 default Web port is occupied locally by a development instance. That is irrelevant if Web is not targeted at this host.
- The IDEA3 default control port is free.
- IDEA2-owned listeners exist and are not IDEA3 dependencies.

### ARCH_HOST_STATUS

**CANDIDATE — NOT READY.** It can run the Python Core (systemd, Python ≥ 3.10,
NTP, a wired NIC). Before acting as the Core host it needs:

1. Attachment to the chosen AEGIS segment over a path **independent of the
   relayed server uplink** (§4).
2. Uninterrupted availability: sleep/suspend inhibited and a stable network.
   Core heartbeat loss makes the ESP32 isolate the whole server within 60 s by
   design (§12).
3. A dedicated unprivileged service account and a project venv with pinned
   dependencies.
4. Host and broker hardening to a production baseline (D2, D6).
5. A decision on sharing the host with IDEA2 services and workstation use (D6).
6. A deliberate host identity.

Python 3.14 against the IDEA3 suite: **NOT TESTED**.

## 4. Network inventory

| Segment / element | State | Evidence |
|---|---|---|
| VLAN 10 Server Zone | AEGIS Server and Production workloads | OBSERVED |
| VLAN 20 Detector Zone | detector segment; detection-host addressing not confirmed by infrastructure | OBSERVED |
| VLAN 30 Management Zone | on-site management path validated earlier | OBSERVED |
| Router / switch | MikroTik RB750r2 gateways plus a TP-Link TL-SG105E managed switch | OBSERVED |
| Router Wi-Fi | the RB750r2 has no wireless radio | INFERRED (hardware model) |
| Relay placement | inline on the AEGIS Server's Ethernet uplink between switch and server; CUT opens it | OBSERVED (PR5 owner evidence) |
| Effect of CUT | server traffic stops; recovery only after RESTORE | OBSERVED (PR5) |
| Scope of CUT | the server's only recorded uplink, so CUT isolates HUB, IDEA1, IDEA2, any server-hosted IDEA3 Web, **and the server-hosted remote-access connector** | INFERRED from OBSERVED topology |
| Historical ESP32 control plane | all recorded ESP32 ↔ broker sessions ran over a **temporary lab network outside the AEGIS VLANs** (log span 2026-08-18 → 2026-09-11) | PROVEN (broker log on the candidate host) |
| Arch current attachment | non-AEGIS network | PROVEN |
| Arch → AEGIS Server | unreachable | PROVEN |

## 5. Existing services

**Server (§2, OBSERVED).** All Production workloads belong to infrastructure
(Kla), IDEA1 (Kla), or IDEA2 (Pub). PR10 must not restart, recreate, prune, or
bring any of them down without separate explicit authorization.

**Arch candidate host (PROVEN, summarized):**

| Service class | Owner | Relevance |
|---|---|---|
| MQTT broker | host / IDEA3 lab use | the only broker; candidate final broker (D2), requires hardening |
| IDEA2 Detection Engine and its connectivity helper | IDEA2 (Pub) | co-tenants; must remain unaffected. The helper currently retries because the server is unreachable (reported to the IDEA2 owner; not touched) |
| Remote-access client, container runtime | host | installed, not active |

## 6. Reverse proxy state

| Question | Finding | Evidence |
|---|---|---|
| Does the current proxy support `/security/`? | **No route exists** in the repository HUB config; live config NOT PROVEN | PROVEN (repo) / NOT PROVEN (live) |
| Is the Vite base compatible? | **Yes**: `base: '/security/'` | PROVEN |
| Is Express routing compatible? | **Yes, but it differs from Drive/Monitor.** Production Express mounts API and SPA under `/security` itself, so the proxy must **forward the full path without stripping the prefix**, plus a `/security` → `/security/` redirect | PROVEN (source) |
| Can the HUB reach IDEA3 Web? | **Not as currently built.** Production Web and the PR9 runtime assume **loopback-only access**, and a containerized HUB cannot reach a host-loopback service | PROVEN (source) + INFERRED |
| Do auth, session, and throttling work behind a proxy? | **Source changes are required.** Secure-cookie handling and client identification for login throttling and audit currently assume loopback-only access. Proxied deployment needs a narrowly scoped trusted-proxy design (a single pinned proxy identity) that preserves `Secure`, HttpOnly, SameSite=Strict, and CSRF | PROVEN (source) + INFERRED |
| CSRF / Origin | compatible if the proxy forwards the original `Host`, as existing HUB routes do | PROVEN + INFERRED |
| CSP | the HUB and IDEA3 each set a policy; a single CSP owner must be chosen (Drive precedent: NGINX owns it) | PROVEN (config) + INFERRED |
| Cookie scoping | the IDEA3 session cookie's scope on the shared HUB origin must be designed | INFERRED |
| Can the HUB later route without shared authentication? | **Yes.** The HUB is routing-only; IDEA3 keeps its own Admin identity, session, and SQLite. The HUB Security card waits until the route is proven | PROVEN (source) |
| Twingate change? | probably none needed if served through the existing HUB entry | INFERRED |

**Conclusion: `/security/` reverse-proxy integration requires design and review (D3).**

## 7. IDEA1 / IDEA2 / HUB coexistence constraints

- **Do not touch** IDEA1, IDEA2, HUB, PostgreSQL, the public-share Gateway, or
  the remote-access connector. That covers containers, images, volumes,
  networks, `.env`, runtime Compose, and the NGINX runtime config.
  `docker compose down`, prunes, and a Monitor recreate are prohibited.
- IDEA3 stays out of the IDEA1/IDEA2 PostgreSQL cluster (SQLite only), which
  preserves Identity Decoupling.
- Do not reuse the HUB↔Drive proxy trust network. A HUB↔IDEA3 path needs its
  own boundary and a non-overlapping address range, coordinated with the
  infrastructure owner and with Draft PR #118.
- A `/security/` route changes shared surfaces: `HUB-AEGIS_Entry/nginx.conf`,
  the runtime HUB config, and possibly Compose. That requires Kla integration
  review, a declaration in the PR, a rollback, and deliberate reconciliation of
  the Git and runtime copies.
- **PR #118 sequencing remains relevant.**
- The IDEA3 Core must not depend on IDEA2 services. PR9 already starts Core
  with `--no-detector`.
- Adding the HUB Security card is a later step, after `/security/` is proven.

## 8. MQTT inventory

| Field | Result | Evidence |
|---|---|---|
| **MQTT_BROKER_HOST** | **PROVEN (current):** an existing broker on the Arch candidate host is the only broker found. **Final PR10 broker host: NOT PROVEN / undecided (D2).** No server broker is recorded, and none could be checked | PROVEN / NOT PROVEN |
| **MQTT_BROKER_PORT** | **PROVEN:** the standard MQTT port, consistent with the repository defaults | PROVEN |
| **MQTT_AUTH_MODE** | **PROVEN:** authentication required; an anonymous CONNECT was refused | PROVEN |
| **MQTT_TLS** | **PROVEN:** the current baseline does **not** meet the PR10 transport-security requirement | PROVEN |
| **MQTT_REACHABILITY** | **TESTED locally only** (authentication refusal). Authenticated connect NOT TESTED; ESP32 ↔ broker NOT TESTED | TESTED / NOT TESTED |
| Delivery semantics | Core uses QoS 0 (at-most-once); durable command lifecycle must live in Core and Server ledgers, not in the broker | PROVEN (source) |
| Current sessions | no ESP32 session was active at inspection | PROVEN |
| Historical users | Core/tooling on the candidate host and the ESP32 over the temporary lab network | PROVEN (log, identities redacted) |

**Conclusion: the current MQTT baseline requires production hardening before
PR10 deployment.** At minimum that means transport security, topic-level
authorization, and restricting which network interfaces the broker listens on.
Specifics are withheld. No `CUT_UPLINK` or `RESTORE_UPLINK` was published, AEGIS
topics were not subscribed, and broker configuration was not changed.

## 9. ESP32 / hardware status

```text
HARDWARE_TESTING = NOT RUN
```

**Carried-forward PR5 owner lab evidence (OBSERVED, not re-run):**
- Firmware contract: `GPIO27 LOW = LOCKDOWN/CUT`, `GPIO27 HIGH = NORMAL/RESTORE`.
- PASS: physical CUT/RESTORE, the powered reset window, no auto-restore on reconnect, explicit authenticated RESTORE, and real Ethernet CUT/RESTORE.
- `TOTAL_CONTROL_POWER_LOSS_FAIL_SECURE = NOT PROVEN`.
- `TWINGATE_FINAL_RELAY_CYCLE_AUTO_RECOVERY = NOT CLAIMED`.
- Breadboard mechanical stability remains a prototype limitation.

**New S1 evidence (PROVEN, passive only):**

- The firmware's Wi-Fi credentials and broker endpoint are **compile-time**
  values. Secrets come from an untracked header, and the template lists names
  only. Timing contract: 30 s command age, 60 s Deadman, 90 s boot grace,
  20-entry nonce history.
- Recorded ESP32 sessions used only the temporary lab network. The currently
  flashed broker endpoint is **NOT PROVEN**.
- No ESP32 session was active during inspection.

**Implication:** a final ESP32 network or broker means a reflash, which is a
firmware/hardware action outside S1 and needs a separately approved PR10 step
(D1).

## 10. Available / occupied ports

- **IDEA3 defaults (public source):** Web `8003` and launcher control `8103`,
  both loopback.
- **Arch candidate host (PROVEN):** the default Web port is occupied by a local
  development instance (irrelevant unless Web is placed on this host); the
  control port is free; the broker port is in use by the existing broker.
- **AEGIS Server:** **`SERVER_AVAILABLE_PORTS` is NOT PROVEN.** A live read-only
  listener and firewall inventory is an S2 prerequisite.
- **Firewall asymmetry:** host-level services and Docker-published services
  interact with the server's host firewall differently (INFERRED). D3 must
  account for this.

## 11. Persistent data requirements

| Host | Data | Current contract | Evidence |
|---|---|---|---|
| Server | Web audit SQLite, schema v2, WAL | absolute external path in production; audit, acknowledgement, notes, settings, operational errors, integration lifecycle, correlated incidents, containment decisions | PROVEN (source) |
| Server | accepted-action / dispatch ledger | **does not exist.** Would be an additive schema v3 | PROVEN (absence) |
| Server | Web sessions | default in-memory store: lost on restart (D8) | PROVEN (source) + INFERRED |
| Server | configuration secrets | external, restrictive permissions, outside the payload | PROVEN (runbook) |
| Server | static React build | immutable, per release | PROVEN (runbook) |
| Arch | Core SQLite, runtime status, logs, control token | external data root (PR9 layout) | PROVEN (source) |
| Arch | Core pending-command / ACK correlation | **in memory only**, lost on restart | PROVEN (source) |
| Arch | claimed-action ledger (idempotency, action↔nonce, post-CUT evidence) | **does not exist** | PROVEN (absence) |
| Both | backups | PR9 runbook: stop, then copy the whole data root; no IDEA3 inclusion in existing server backups | PROVEN / OBSERVED |

## 12. Security constraints

1. **Server-side authorization.** Admin + same-origin + CSRF stay on Express.
   **The browser must not own MQTT actuation** and receives no MQTT, HMAC,
   broker, or relay capability (PROVEN: no such path in `web/`).
2. **Single command owner.** Only the Python Core issues commands; no shutdown
   path sends `RESTORE_UPLINK` (PROVEN). Server Web records *intent* only.
3. **Identity decoupling.** IDEA3 keeps its own Admin identity, session, and
   SQLite, shared with no other domain.
4. **Token storage.** HttpOnly, SameSite=Strict, Secure cookies; no tokens in
   browser storage. PR10 must not weaken `Secure` to make proxying work.
5. **Fail-secure truth model.** `Requested ≠ Published ≠ ACK ≠ Executed ≠ Relay
   Confirmation ≠ Physical Evidence`. Unknown stays `UNKNOWN`.
6. **Availability coupling (architecture).** Core heartbeat loss makes the ESP32
   CUT the server by design. The Core host and the Core↔ESP32 network therefore
   become availability dependencies for every AEGIS service.
7. **CUT isolates the server.** During LOCKDOWN the server-hosted Web and
   server-hosted remote access are unreachable. **Core-side connectivity,
   broker, and RESTORE authority must remain available independently of the
   relayed server uplink.**
8. **Broker and Core hosts** must reach a production hardening baseline before
   PR10 deployment (D2, D6).
9. **Clock integrity.** ESP32 command freshness is 30 s, so the Core host (NTP
   PROVEN) and any Server↔Core TTL (server NTP NOT PROVEN) need synchronized
   clocks.
10. **Narrow proxy trust.** Any trusted-proxy mode must be pinned to one proxy
    identity on a dedicated network, and throttling and audit must use the real
    client identity only from that trusted source.
11. **Secrets.** Never commit or print environment files, firmware secrets,
    broker credentials, HMAC or session secrets, connector tokens, or TLS keys.
    Server↔Core machine credentials must be new and dedicated.

## 13. PR10 target topology

### 13.1 Feasibility of the owner's preferred target

| Target element | Reality check | Verdict |
|---|---|---|
| Server: React + Express + SQLite + adapters + correlation + accepted-action state | source ready except the dispatch ledger; proxied hosting needs source and HUB/infra changes | **FEASIBLE after changes (D3)** |
| Arch: Python Core, Supervisor, Controller, MQTT ownership, heartbeat | Core source ready; the PR9 owner always starts Core **and** Web, so a Core-only owner and unit are needed; host preparation required | **FEASIBLE after Core-only runtime work and host preparation** |
| ESP32: MQTT, HMAC, nonce, ACK, STATUS, heartbeat, relay | contract proven in the lab; final network undefined; reflash needed | **BLOCKED ON D1** |
| Browser never owns MQTT | true today | **SATISFIED** |
| Broker placement | not specified by the target | **DECISION D2** |

### 13.2 Recommended PR10 topology (for owner review — not implemented)

```text
                AEGIS Server (VLAN 10) — behind the relayed uplink: CUT isolates all of it
  Browser ─approved access─▶ HUB NGINX (routing only) ──/security/ (full path)──▶ IDEA3 Web
  (operator only)                                        dedicated HUB↔IDEA3 path     Express + React
                                                          single trusted proxy         SQLite + dispatch ledger
                                                                                       Admin acceptance; no MQTT
                                        ▲
                                        │ Core-initiated authenticated TLS pull/claim/report
                                        │ (dedicated machine credential; never the Admin session)
  Core host (wired AEGIS segment, independent of the relayed server uplink)
    Python Core (Core-only systemd owner): Supervisor, Controller, heartbeat
    MQTT broker, hardened
    local Core ledger (claims, action↔nonce, ACK/STATUS evidence) + local RESTORE authority
                                        │ MQTT (HMAC, nonce, 30 s freshness)
                                        ▼
  ESP32 + driver + relay ── network path to the Core host that does NOT traverse the relayed uplink
```

- **Broker on the Core side, not the server.** A server-hosted broker would be
  cut with the server: RESTORE would become impossible and the Deadman could
  never be satisfied (INFERRED from §4).
- **Core pulls; the server never calls into the Core host.** The Core host
  exposes no inbound HTTP listener, the server's atomic SQLite update
  implements "Core Claimed", and a server outage does not stop heartbeats.
- **Web packaging (D3), recommended: a container on a dedicated HUB↔IDEA3
  network.** This mirrors the proven IDEA1 proxy pattern and avoids host-firewall
  asymmetry. It is pending Kla review.

### 13.3 Server → Core boundary constraints for S2

**A durable, authenticated Server → Core boundary is required.**

| Constraint | Requirement | Basis |
|---|---|---|
| Durable action ID | the server mints an immutable `action_id` at Admin acceptance, stored durably (schema v3) before it is claimable. It is distinct from the incident ID and the firmware nonce | acceptance writes only `containment_decisions` today (PROVEN) |
| Idempotency | one dispatch per accepted decision, enforced by a unique constraint. Core persists every claimed `action_id`, never republishes for a replayed claim, and records `action_id → nonce` | 409 on reversal (PROVEN); Core pending state is in-memory (PROVEN) |
| Freshness / TTL | a server-issued expiry. Expired actions become `EXPIRED`, are never claimable, and are never published late. Core re-checks expiry on its own synchronized clock; the ESP32 still enforces 30 s | firmware contract (PROVEN) |
| Claim semantics | atomic compare-and-set `PENDING_DISPATCH → CLAIMED` if still pending and unexpired. Recommend **terminal** claims: no auto re-dispatch after an unknown publish outcome | INFERRED |
| Duplicate / concurrent claims | the second claimant receives a conflict. Only one registered, authenticated Core identity may claim. The Core-side instance lock covers one data root, not multiple hosts | PROVEN + INFERRED |
| Restart behaviour | Core reloads its ledger. Claimed-but-unpublished becomes `OUTCOME_UNKNOWN` and is never silently republished; RESTORE is never auto-retried. Server restart keeps pending actions until expiry. No restart path sends `RESTORE_UPLINK` | PROVEN (no-RESTORE-on-shutdown) |
| Authentication | no cross-host channel exists today (PROVEN). Requires a dedicated machine credential over TLS, bound to the Core identity and rotatable. Never the Admin session, HMAC key, broker credential, or IDEA1/IDEA2 tokens | PROVEN + requirement |
| Transport route | via the HUB with an edge guard, or a dedicated server endpoint (D5) | INFERRED |
| Failure behaviour | Core or dispatch unavailability shows `DISPATCH_PENDING`/`UNAVAILABLE` and never "Contained". Failure never publishes and never degrades into auto-RESTORE | fail-secure rule |
| **Post-publish evidence under CUT** | the server is isolated after CUT, so **Core owns ACK/STATUS/relay evidence durably** and reconciles it back to the server, append-only, after connectivity returns | §12.7 |
| **RESTORE authority** | cannot originate from the server Web during LOCKDOWN. It must be Core-local or out-of-band (D4) | §12.7 |
| Audit ownership | Server: Candidate → Admin Accepted → Pending Dispatch (plus mirrored reconciliation). Core: Claimed → Published → ACK → STATUS. Relay and physical network evidence remain separate evidence classes, never auto-promoted | evidence model |
| Lifecycle vocabulary | `CANDIDATE → ADMIN_ACCEPTED → PENDING_DISPATCH → CORE_CLAIMED → PUBLISHED → ACK → STATUS → RELAY_EVIDENCE → PHYSICAL_NETWORK_EVIDENCE`, plus `EXPIRED`, `REJECTED`, `OUTCOME_UNKNOWN`, `FAILED`. Today's `containmentBoundary()` false fields stay false until the owning side records evidence | PROVEN (`domain/containment.js`) |
| Actions in scope | recommend `CUT_UPLINK` dispatch only; RESTORE stays Core-local (D4) | INFERRED |

## 14. Unresolved architecture decisions

| ID | Decision | Why it blocks | Owner |
|---|---|---|---|
| **D1** | Final ESP32 network: Wi-Fi attachment and segment, a path to the Core independent of the relayed uplink, and reflash scope | no AEGIS Wi-Fi is inventoried; history is on a temporary lab network | Music + Kla |
| **D2** | Broker host and production hardening (recommended: Core side) | the broker must survive a server CUT, and the current baseline is not production-hardened | Music (+ Kla) |
| **D3** | IDEA3 Web packaging and `/security/` reverse-proxy topology (container on a dedicated network recommended), CSP owner, cookie scope, trusted-proxy identity | the current Web assumes loopback-only access | Music (source) + Kla (HUB/infra) |
| **D4** | RESTORE authority during LOCKDOWN (Core-local vs out-of-band) | the server is unreachable during CUT | Music |
| **D5** | Server↔Core transport (via the HUB with an edge guard, or a dedicated endpoint) and credential type | no cross-host channel exists | Music + Kla |
| **D6** | Core host identity, tenancy (IDEA2 co-residence, workstation use), hardening, and segment | the Core host becomes a whole-server availability dependency | Music (+ Pub, + Kla) |
| **D7** | Claim-model details: TTL, terminal vs lease, `OUTCOME_UNKNOWN`, reconciliation | defines schema v3 and the Core ledger | Music |
| **D8** | Server Web session store (in-memory vs durable) | restart logs Admins out | Music |

## 15. S2 prerequisites

1. Owner architecture review of this document and decisions D1–D8 (at minimum D1–D5).
2. **A live, read-only AEGIS Server inventory** by an authorized operator on an
   approved path, covering host identity, interfaces and routes, listeners,
   container/network/volume names and states, host-firewall status, `.env`
   variable **names** relevant to HUB/Compose, the live-vs-Git HUB NGINX drift,
   and host runtime availability. Record it in an owner-controlled location,
   print no values, and publish only conclusions.
3. Kla integration agreement on `/security/` route ownership, the dedicated
   network, firewall impact, and sequencing with Draft PR #118.
4. Pub acknowledgement if the Core shares a host with IDEA2 services (D6).
5. Core host attached to the chosen AEGIS segment; reachability re-measured.
6. The S2 session record opened in `idea3/idea3-status.md` before its first mutation.

## 16. Commands executed (all read-only)

- **Repository/Git:** fetch, status, branch, rev-parse, log, worktree list,
  `git ls-files`/`git grep`, and an open-PR listing. File reads of governance
  notes, IDEA3 source, deploy files, runbooks, specs, receipts, and
  infrastructure notes.
- **Candidate host:** identity, kernel, interface, route, and listener listings;
  systemd version, state, and unit listings; runtime version checks;
  package-presence queries; time-sync and power-policy reads; firewall status
  reads; secret-filtered reads of the broker configuration and the broker's
  connection log (identities redacted); and remote-access client status. The
  owners of two local development listeners were identified without being
  signalled.
- **Reachability toward the AEGIS Server:** unauthenticated ICMP and TCP connect
  probes only. All failed.
- **MQTT, passive:** one unauthenticated connection attempt to the local broker,
  which was refused. No publish and no AEGIS topic subscription.
- **Validation:** `git diff --check`, vault validation, and collaboration-policy
  tests (results in the task record).

## 17. Explicit non-actions

- No IDEA3 deployment. No systemd unit was created, installed, enabled,
  started, or stopped. The Core, the Supervisor, and the PR9 runtime were not
  started.
- No package install, upgrade, or removal; no venv or `npm ci`.
- No login to the AEGIS Server, and no credential created, changed, copied, or
  borrowed. No remote-access client or connector started or touched.
- No Docker command on any host; nothing restarted, recreated, pruned, or
  brought down.
- No firewall, reverse-proxy, HUB, router, or switch change.
- No MQTT publish of any kind (`CUT_UPLINK` and `RESTORE_UPLINK` not sent), no
  broker configuration change, and no AEGIS topic subscription.
- No ESP32 flash, reset, reboot, or power action; no relay, cable, or Ethernet
  change. `HARDWARE_TESTING = NOT RUN`.
- No IDEA1, IDEA2, HUB, firmware, or shared source modified. The separate
  worktree, the local development instance, IDEA2 services, and the broker were
  not signalled.
- No environment file, firmware secret, credential file, token, or key content
  read or printed.
- No final receipt, and no merge.
