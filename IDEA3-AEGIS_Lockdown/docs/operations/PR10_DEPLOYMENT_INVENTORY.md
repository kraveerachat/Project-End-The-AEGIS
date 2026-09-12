# IDEA3 PR10 — Real Deployment Inventory and Architecture Gate (S1)

```text
DOCUMENT_STATE        = S1 deliverable (public-safe edition); D1–D8 owner-accepted; K1–K12 Kla-approved; S1 PASS / CLOSED 2026-09-12
TASK                  = PR10 real Arch Linux Core + server-hosted IDEA3 Web deployment baseline
SESSION               = S1 — real infrastructure inventory + architecture gate
AREA / OWNER          = idea3 / music
BRANCH                = feat/idea3-pr10-real-deployment
BASE_SHA              = 895c79ac8ab9b39f322919fabc9facfdc34ba20b (origin/main, PR #119 merge)
S1_CHECKPOINT         = recorded in the PR10 Session Register (idea3/idea3-status.md)
INVENTORY_DATE        = 2026-09-11 (Asia/Bangkok)
PRODUCTION_MUTATION   = NONE
HARDWARE_TESTING      = NOT RUN
SERVER_ACCESS         = initial S1 attempt: ACCESS_NOT_AVAILABLE; 2026-09-12: AVAILABLE for read-only inventory (§2A)
LIVE_SERVER_INVENTORY = PASS (2026-09-12, read-only) — see §2A
ARCHITECTURE_DECISIONS = D1–D8 DECIDED / OWNER-ACCEPTED (2026-09-12) — see §14; not implemented
S1_STATE              = PASS / CLOSED (2026-09-12) — see §15
KLA_REVIEW_PACKAGE    = K1–K12 APPROVED (Kla integration approval; architecture/integration only) — see §15A
OWNER_CONTINUATION_APPROVAL = APPROVED (2026-09-12)
READY_FOR_PR10_S2     = YES
S2_STARTED            = YES (2026-09-12) — task branch feat/idea3-pr10-s2-server-core-boundary; repository-only, non-Production
PR10_S2               = PASS / CLOSED (2026-09-12) — LOCAL / SIMULATED evidence only; PR #123 merged at d903327e (human merge); no Production change
PR11                  = NOT STARTED / NEXT (read-only preflight first, on the owner's instruction)
PRODUCTION_CHANGE_AUTHORIZED = NONE
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
| **OBSERVED** | Recorded in canonical notes or receipts by an earlier task and carried forward, **except in §2A**, where OBSERVED means seen on the live server during the 2026-09-12 read-only inventory |
| **INFERRED** | Reasoned from PROVEN or OBSERVED facts. Must be confirmed before anyone relies on it. §2A uses **INFERRED / FEASIBLE** for feasibility conclusions |
| **PROPOSED** | Owner-accepted architecture (§14) or a candidate value. Not implemented or deployed |
| **NOT PROVEN** | No evidence was available in S1 |
| **NOT TESTED** | Deliberately not exercised in S1 |

## Summary verdict

- **Feasible; architecture decided.** The target architecture is feasible. The owner accepted decisions D1–D8 on 2026-09-12 (§14). No implementation design exists yet. S1 is PASS / CLOSED (§15) after Kla's integration approval of K1–K12 (§15A); that approval authorizes no Production change.
- **Live server inventory: PASS.** The AEGIS Server was unreachable during the initial S1 attempt (§2). A read-only live inventory on 2026-09-12 (§2A) found D3 feasible and D5 feasible with conditions. `/security/`, mTLS, and preservation of the real Core source address are not deployed or not proven.
- **Arch is a candidate Core host, not a ready one.** It is not yet attached to the final AEGIS network segment, and its hardening is not at a production baseline. D6 makes it a dedicated Core appliance; that work is not implemented.
- **ESP32 network decided, not built.** The recorded ESP32 control-plane history used a temporary lab network outside the AEGIS VLANs. D1 selects a dedicated private access point on the Core host; it is not implemented.
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

## 2. AEGIS Server inventory (initial S1 attempt, 2026-09-11)

> [!note] Superseded for live facts
> This section records the initial S1 attempt, when no approved path existed.
> §2A holds the live read-only inventory of 2026-09-12 and takes precedence for
> every live fact.

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

## 2A. Live AEGIS Server inventory — 2026-09-12 (read-only) — `LIVE_SERVER_INVENTORY = PASS`

The owner restored an approved remote-access path, and the inventory used three
evidence sources:

1. read-only, unprivileged SSH reads over that path with the owner's
   agent-held key;
2. root-only read-only commands (container/network/volume listing, firewall
   listing, `nginx -T`, and a HUB log source-class count), run by the owner in
   their own session and shared only as public-safe classifications;
3. repository reads, including the PR #118 branch.

Nothing was changed on the server: no Docker, NGINX, firewall, or
configuration change, no service restart, no MQTT action, and no hardware
action. Host addresses, software versions, maintenance details, credentials,
key fingerprints, and certificate material are deliberately not recorded
here.

In this section, **OBSERVED** means seen on the live server on 2026-09-12.

| Area | Finding | Label |
|---|---|---|
| Access | Approved read-only access is available. The unprivileged account has no Docker or passwordless-sudo rights, so the owner ran the root-only reads | OBSERVED |
| Platform | Ubuntu Server host with Docker Engine and Docker Compose v2. Host maintenance items were observed and referred to the infrastructure owner; they are outside PR10 | OBSERVED |
| Production services | Six healthy containers: HUB (NGINX), IDEA1 Drive, IDEA2 Monitor, PostgreSQL, the IDEA1 public-share gateway, and the Twingate connector. No MQTT broker, no IDEA3 component, and no IDEA3 path or volume | OBSERVED |
| HUB entry | The HUB is the **single host-published browser entry**: port 80 redirects to HTTPS and 443 serves TLS, both reached through Docker address translation. Every other container exposes internal ports only. The HUB owns TLS and the browser-facing security headers | OBSERVED |
| Active routes | `/drive/` and `/monitor/` exist, and `/monitor/internal` returns 404. **`/security/` does not exist.** No mTLS client-certificate route is deployed. The configuration syntax test passed | OBSERVED |
| Configuration identity | The host runtime NGINX configuration matches the configuration the HUB container loaded at the observed time | OBSERVED |
| Networks | Internal-only bridge networks exist (IDEA1 public-share edge and upstream). The shared application bridge is `internal=false`, as previously documented. The HUB is attached only to the shared application bridge and the HUB↔Drive proxy network | OBSERVED |
| IDEA3 network range | A candidate /29 did not overlap any observed live Docker IPv4 subnet. The final allocation belongs to the Kla/integration owner | OBSERVED (no overlap) · PROPOSED (candidate) |
| Firewall | Backend `nf_tables`; `INPUT DROP`, `FORWARD DROP`, `OUTPUT ACCEPT`. UFW is active, denying incoming and routed traffic by default. Forwarding passes through `DOCKER-USER` before the Docker and UFW forwarding chains | OBSERVED |
| S5.5 firewall chains | `AEGIS-PS-EGRESS` is anchored first in `DOCKER-USER`, and `AEGIS-PS-INPUT` comes before the UFW input chains | OBSERVED |
| S5.5 state | **PARTIALLY PRESENT**: the S5.5 egress network exists (no members) and the `AEGIS-PS-*` chains exist, but the connector is not running and no S5.5 runtime file or systemd unit was observed. S5.5 is neither fully deployed nor fully absent. Whether the chains survive a host reboot is NOT PROVEN | OBSERVED · NOT PROVEN |
| Persistence | Named Docker volumes for the existing stateful services; HUB configuration and certificates as read-only bind mounts; host backups on a dedicated backup mount. One anonymous volume has an unknown owner and must not be touched | OBSERVED |
| Client sources at the HUB | The last 24 h of HUB logs contained only Docker-gateway and loopback source classes, with no VLAN-sourced class | OBSERVED |
| Real Core source address at the HUB | Not established; the future Core → HUB path was not exercised | NOT PROVEN |
| Core → HUB 443 from VLAN 20 | Not tested; the Core host is not yet attached to VLAN 20 | NOT PROVEN (NOT TESTED) |

**Feasibility:**

- **D3 — FEASIBLE** (INFERRED / FEASIBLE). An IDEA3 Web container behind the
  HUB at `/security/` can follow the live hardened-container and internal-network
  pattern. The HUB configuration has no conflicting `/security/` route, and no
  direct public IDEA3 host port is required. Conditions:
  - Kla/integration ownership of the `/security/` change in the runtime HUB
    configuration, plus reconciliation of the existing runtime↔Git drift;
  - a method for attaching the HUB to the dedicated IDEA3 network: recreate the
    HUB container, or attach the network at runtime (Kla decides);
  - final subnet allocation;
  - an IDEA3 Compose overlay;
  - NGINX as the single CSP owner for `/security/`, following the live `/drive/`
    pattern.

  The D3 container, network, and route themselves remain PROPOSED.
- **D5 — FEASIBLE WITH CONDITIONS** (INFERRED / FEASIBLE).
  - **The route exists.** The HUB HTTPS 443 path exists (OBSERVED).
  - **mTLS is the primary machine authentication.** It is PROPOSED and not
    deployed. The running NGINX verifies client certificates per server block,
    so the design must choose between optional verification on 443 with a
    check on the machine path, or a separate server name (Kla decides). The
    client-certificate CA and lifecycle need an owner.
  - **Source allowlisting is defense-in-depth only.** Preservation of the real
    Core source address at the HUB is NOT PROVEN and must be verified on the
    real path at implementation time.
- **Host firewall** (INFERRED): no conflict is expected for D3/D5 as decided,
  since they add no host ports or rules. IDEA3 must never insert host rules
  ahead of the S5.5 anchors.
- **PR #118:** there is no repository-file overlap (OBSERVED), but runtime
  coordination is required (INFERRED). The two share:
  - the Compose project and its overlay stack;
  - anchor-first firewall ordering;
  - the address plan;
  - HUB maintenance windows.

**`DRIFT_FOUND = YES` (all OBSERVED):**

1. The runtime HUB NGINX configuration differs from Git
   `HUB-AEGIS_Entry/nginx.conf`. The runtime adds an extra resolver timeout, and
   its `/monitor/` upstream uses the Docker service name through a variable
   instead of a fixed address.
2. S5.5 is partially present on the server while PR #118 is still an unmerged
   Draft. The S5.4 receipt had recorded the egress network as absent.
3. The server-side repository checkout predates current `main`.
4. No real client source class was observed at the HUB.

The shared application bridge being `internal=false` was already documented and
is not new drift.

```text
LIVE_SERVER_INVENTORY = PASS
PR10_S1               = IN PROGRESS (at inventory time; S1 later closed — see §15)
READY_FOR_PR10_S2     = NO (at inventory time)
S2_STARTED            = NO (at inventory time)
PRODUCTION_MUTATION   = NONE
HARDWARE_TESTING      = NOT RUN
PRODUCTION_DEPLOYED   = NO
```

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
5. The D6 tenancy rules applied (decided 2026-09-12): a dedicated Core appliance
   with no personal desktop use; IDEA2 stays only if separately approved,
   unprivileged, isolated, and kept off the ESP32 AP/control boundary.
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
| Does the current proxy support `/security/`? | **No route exists** in the repository HUB config or in the live NGINX configuration (2026-09-12, §2A) | PROVEN (repo) / OBSERVED (live, §2A) |
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
- **PR #118 sequencing remains relevant.** On 2026-09-12 S5.5 was observed
  PARTIALLY PRESENT on the server (§2A): the egress network and `AEGIS-PS-*`
  firewall chains exist, the connector is not running, and no S5.5 runtime file
  or systemd unit was observed.
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
- **AEGIS Server (live, 2026-09-12, §2A):** only the HUB publishes host ports
  (80/443). The IDEA3 candidate host ports are free, and D3/D5 require no direct
  IDEA3 host port.
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
| ESP32: MQTT, HMAC, nonce, ACK, STATUS, heartbeat, relay | contract proven in the lab; final network decided (D1: Core-host private AP); reflash needed | **DECIDED (D1, D2) — implementation pending** |
| Browser never owns MQTT | true today | **SATISFIED** |
| Broker placement | Core host, AP-only plus loopback, TLS (D2) | **DECIDED (D2) — implementation pending** |

### 13.2 Accepted PR10 topology (owner-accepted D1–D8 — not implemented)

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
- **Web packaging (D3), decided: a hardened container on a dedicated HUB↔IDEA3
  network.** This mirrors the proven IDEA1 proxy pattern and avoids host-firewall
  asymmetry. The HUB and Compose changes still need Kla review before
  implementation.

### 13.3 Server → Core boundary constraints for S2

**A durable, authenticated Server → Core boundary is required.**

Decisions D4, D5, and D7 (§14) resolve the choices this table left open. §14 is
authoritative for them.

| Constraint | Requirement | Basis |
|---|---|---|
| Durable action ID | the server mints an immutable `action_id` at Admin acceptance, stored durably (schema v3) before it is claimable. It is distinct from the incident ID and the firmware nonce | acceptance writes only `containment_decisions` today (PROVEN) |
| Idempotency | one dispatch per accepted decision, enforced by a unique constraint. Core persists every claimed `action_id`, never republishes for a replayed claim, and records `action_id → nonce` | 409 on reversal (PROVEN); Core pending state is in-memory (PROVEN) |
| Freshness / TTL | a server-issued expiry. Expired actions become `EXPIRED`, are never claimable, and are never published late. Core re-checks expiry on its own synchronized clock; the ESP32 still enforces 30 s | firmware contract (PROVEN) |
| Claim semantics | **decided (D7):** atomic `PENDING_DISPATCH → CORE_CLAIMED` only while pending and unexpired; terminal single-shot claims; a claimed action is never re-dispatched automatically; TTL 120 s from acceptance | owner decision |
| Duplicate / concurrent claims | the second claimant receives a conflict. Only one registered, authenticated Core identity may claim. The Core-side instance lock covers one data root, not multiple hosts | PROVEN + INFERRED |
| Restart behaviour | Core reloads its ledger. Claimed-but-unpublished becomes `OUTCOME_UNKNOWN` and is never silently republished; RESTORE is never auto-retried. Server restart keeps pending actions until expiry. No restart path sends `RESTORE_UPLINK` | PROVEN (no-RESTORE-on-shutdown) |
| Authentication | no cross-host channel exists today (PROVEN). Requires a dedicated machine credential over TLS, bound to the Core identity and rotatable. Never the Admin session, HMAC key, broker credential, or IDEA1/IDEA2 tokens | PROVEN + requirement |
| Transport route | **decided (D5):** HUB HTTPS 443 on a dedicated machine path under `/security/`, with an edge guard limited to the Core host and an mTLS client certificate; no new published server port | owner decision |
| Failure behaviour | Core or dispatch unavailability shows `DISPATCH_PENDING`/`UNAVAILABLE` and never "Contained". Failure never publishes and never degrades into auto-RESTORE | fail-secure rule |
| **Post-publish evidence under CUT** | the server is isolated after CUT, so **Core owns ACK/STATUS/relay evidence durably** and reconciles it back to the server, append-only, after connectivity returns | §12.7 |
| **RESTORE authority** | cannot originate from the server Web during LOCKDOWN. **Decided (D4):** an authenticated, audited Core-local CLI only | §12.7 + owner decision |
| Audit ownership | Server: Candidate → Admin Accepted → Pending Dispatch (plus mirrored reconciliation). Core: Claimed → Published → ACK → STATUS. Relay and physical network evidence remain separate evidence classes, never auto-promoted | evidence model |
| Lifecycle vocabulary | `CANDIDATE → ADMIN_ACCEPTED → PENDING_DISPATCH → CORE_CLAIMED → PUBLISHED → ACK → STATUS → RELAY_EVIDENCE → PHYSICAL_NETWORK_EVIDENCE`, plus `EXPIRED`, `REJECTED`, `OUTCOME_UNKNOWN`, `FAILED`. Today's `containmentBoundary()` false fields stay false until the owning side records evidence | PROVEN (`domain/containment.js`) |
| Actions in scope | **decided (D4, D7):** `CUT_UPLINK` dispatch only; RESTORE stays Core-local | owner decision |

## 14. Architecture decisions D1–D8 — DECIDED / OWNER-ACCEPTED (2026-09-12)

The owner accepted this decision set on 2026-09-12. It is architecture only:
nothing here is implemented, installed, configured, deployed, or flashed.
Implementation belongs to later, separately authorized PR10 sessions. Every
decision stays subject to the remaining S1 gates in §15.

| ID | Topic | Accepted decision | Implementation dependencies |
|---|---|---|---|
| **D1** | Final ESP32 network | The Core host runs a dedicated private Wi-Fi access point for the ESP32 only. Nothing is forwarded or routed from that AP. The ESP32 reaches the Core and MQTT directly, and the Core provides the ESP32's local time source. No new AP hardware and no new VLAN. | Core-host AP and time service; ESP32 reflash with new network, broker endpoint, and local time source |
| **D2** | Broker location and hardening | The MQTT broker runs on the Arch Core host. It listens only on the ESP32 AP address plus loopback for local Core access. Separate Core and ESP32 credentials, a per-topic ACL, and no anonymous access. The host firewall blocks MQTT from the wired/uplink side. MQTT runs over TLS, and the ESP32 verifies the broker certificate against a pinned private CA. The ESP32 signs ACK and STATUS, and the Core verifies the signed ACK and STATUS. | broker, CA, and certificate lifecycle with expiry monitoring (an expired certificate would stop heartbeats and trigger a Deadman CUT); firmware signing plus Core verification in the same reflash |
| **D3** | IDEA3 Web packaging and `/security/` topology | IDEA3 Web runs as a hardened container on a dedicated internal network behind HUB/NGINX at `/security/`, with no direct public host port. NGINX is the single owner of browser-facing security headers and CSP, and parity tests verify the intended IDEA3 policy. The full path is forwarded, IDEA3 trusts one pinned proxy, and the session cookie is scoped to `/security`. | IDEA3 container build and trusted-proxy source work; HUB/Compose change needs Kla review |
| **D4** | RESTORE authority during LOCKDOWN | RESTORE is authorized only through an authenticated and audited Core-local CLI (for example `aegisctl restore`), from the console or approved Management-VLAN SSH. It goes through the Core's single command owner, is never automatic, and requires explicit operator confirmation, reason, and incident context. There is no Telegram or Web recovery authority. | new CLI with a strong salted, slow-hash secret replacing the current PIN hash; durable Core audit, reconciled to the server afterwards |
| **D5** | Server↔Core transport and credential | The Core pulls, claims, and reports server dispatch actions through HUB HTTPS 443 on a dedicated machine path under `/security/`. A HUB edge guard restricts the route to the Core host and hides it from normal users, and an mTLS client certificate authenticates the Core to the machine endpoint. No new dedicated published server port. | route ownership needs Kla/infrastructure review before implementation; client-certificate lifecycle (expiry stops dispatch but does not cause a CUT) |
| **D6** | Core host identity, tenancy, and segment | The current Arch laptop becomes a dedicated Core appliance: personal desktop use stops; it gets a dedicated service account and production hardening; sleep, suspend, and lid-suspend are disabled during implementation; the host firewall denies by default; maintenance uses controlled windows because Core downtime can trigger a Deadman CUT. Its wired segment is VLAN 20 via switch port 3, and its Wi-Fi is reserved for the D1 access point. IDEA2 may remain only if separately approved, unprivileged, isolated, and kept off the ESP32 AP/control boundary. | host preparation; Pub approval if IDEA2 remains; Kla awareness for the VLAN 20 attachment |
| **D7** | Claim model | One unique `action_id` per accepted incident, with terminal single-shot claims. The claim is an atomic `PENDING_DISPATCH → CORE_CLAIMED` transition, and a claimed action is never re-dispatched automatically. A CUT action expires 120 s after acceptance; the Core re-checks expiry before publishing, and expired actions are never published. No valid ACK or no correlated STATUS gives `OUTCOME_UNKNOWN`, which requires human review. No automatic retry. Device STATUS remains the physical-state evidence source. Reconciliation is Core → server, append-only and idempotent by `action_id`. | additive Web schema v3 dispatch ledger; durable Core claim ledger |
| **D8** | Server Web session store | Production Web uses a bounded in-memory TTL session store. It keeps the current login, CSRF, and logout semantics and the existing secure cookie policy. The idle timeout is `AEGIS_SESSION_IDLE_MS`, default 30 minutes. The store caps its entries and prunes periodically. No auth session state is persisted to disk, so a container restart invalidates sessions and logs the Admin out. | small IDEA3 session store replacing the default MemoryStore |

## 15. S1 gates (closed 2026-09-12) and S2 prerequisites

Owner architecture decisions D1–D8 are **done** (§14, 2026-09-12). The
authorized read-only live AEGIS Server inventory is **done**
(`LIVE_SERVER_INVENTORY = PASS`, 2026-09-12, §2A).

Until 2026-09-12, S1 stayed IN PROGRESS with `READY_FOR_PR10_S2 = NO` while
one gate remained: **the Kla/integration-owner decision and its reconciliation
for the D3/D5 shared infrastructure.** It covered:

- ownership of the `/security/` location and the D5 machine path in the runtime
  and Git HUB configurations, including the existing runtime↔Git drift;
- the dedicated HUB↔IDEA3 network: final subnet allocation, and whether the HUB
  is recreated or attached at runtime;
- mTLS placement (optional verification on 443 or a separate server name) and
  CA ownership;
- confirmation that IDEA3 adds no host firewall rules ahead of the S5.5
  anchors;
- sequencing relative to PR #118 / S5.5, whose infrastructure is observed as
  partially present.

After Kla decides, the decision is formally reconciled into the S1
architecture gate.

The decision set was prepared as the **K1–K12 review package** (§15A). On
2026-09-12 the owner accepted every K-decision for owner review, and the IDEA3
owner then reported Kla's integration approval of K1–K12 (scope and provenance
in §15A).

- **The S1 gate is closed: `PR10_S1 = PASS / CLOSED`.**
- **The approval is architecture/integration only.** It authorizes no
  Production change. Every PR10 Production change still needs its own
  reviewed, authorized change.
- **S2 readiness.** Until 2026-09-12, `READY_FOR_PR10_S2 = NO` pending the
  owner's continuation approval. The owner approved the continuation model on
  2026-09-12. S2 then started as the new task branch
  `feat/idea3-pr10-s2-server-core-boundary`; it is repository-only and
  non-Production.

Implementation conditions carried by the decisions, for later sessions rather
than S1 gates:

- Pub approval if IDEA2 remains on the Core host (D6).
- The Core host attached to VLAN 20 via port 3, with reachability re-measured
  (D6).
- The S2 session record opened in `idea3/idea3-status.md` before its first
  mutation.

```text
D1_D8 = DECIDED / OWNER-ACCEPTED
LIVE_SERVER_INVENTORY = PASS
KLA_DECISIONS_K1_K12 = APPROVED
KLA_INTEGRATION_APPROVAL = APPROVED (architecture/integration only)
PRODUCTION_CHANGE_AUTHORIZED = NONE
S1 = PASS / CLOSED
OWNER_CONTINUATION_APPROVAL = APPROVED (2026-09-12)
READY_FOR_PR10_S2 = YES
S2_STARTED = YES (2026-09-12; repository-only, non-Production)
PR10_S2 = PASS / CLOSED (2026-09-12; LOCAL / SIMULATED; PR #123 merged at d903327e)
PRODUCTION_MUTATION = NONE
HARDWARE_TESTING = NOT RUN
```

## 15A. Kla / integration-owner review package K1–K12 — APPROVED (2026-09-12)

```text
KLA_DECISIONS_K1_K12 = APPROVED (owner-accepted 2026-09-12; Kla integration approval reported 2026-09-12)
KLA_INTEGRATION_APPROVAL = APPROVED
APPROVAL_SCOPE = ARCHITECTURE / INTEGRATION ONLY
PRODUCTION_CHANGE_AUTHORIZED = NONE
PR10_PRODUCTION_ROLLOUT = BLOCKED (each change needs its own reviewed authorization)
LIVE_SERVER_INVENTORY = PASS
S1 = PASS / CLOSED
OWNER_CONTINUATION_APPROVAL = APPROVED (2026-09-12)
READY_FOR_PR10_S2 = YES
S2_STARTED = YES (2026-09-12; repository-only, non-Production)
PR10_S2 = PASS / CLOSED (2026-09-12; LOCAL / SIMULATED; PR #123 merged at d903327e)
```

This package covers the D3/D5 shared infrastructure. On 2026-09-12 the owner
accepted the recommended direction of every K-decision for owner review; at
that point Kla's approval was pending. **The IDEA3 owner then reported Kla's
integration approval of K1–K12 on 2026-09-12.**

**Provenance:** the approval was relayed by the IDEA3 owner in the working
session. No approval comment or review had been recorded on PR #122 at
closeout. After closeout, Kla's GitHub account submitted an APPROVED review of
PR #122 (2026-09-12T07:58:33Z, no review text) and merged it at `b2f61ebf`.

- **Scope: architecture/integration only.** K1–K12 are the agreed contract for
  later PR10 work.
- **No Production change is authorized.** No NGINX, Compose, network,
  firewall, certificate, router, DNS, VLAN, Twingate, or deployment change is
  authorized, and none has been made.
- **Each future change needs its own approval.** Every future
  shared-infrastructure change still needs its own reviewed, authorized
  change.
- **IDEA3 still does not edit shared surfaces.** It does not edit another
  owner's runtime or shared surface just because K1–K12 are approved.
- **Owner-accepted decisions are unchanged.** D1–D8 (§14) are not reopened.
- **Evidence labels** follow §2A.
- **Public safety:** addresses and names below are placeholders or
  descriptions. The final values belong in Kla's infrastructure records.

| ID | Subject | Accepted direction (for owner review) | Key implementation conditions | Material NOT PROVEN | Status |
|---|---|---|---|---|---|
| **K1** | Ownership of the shared HUB NGINX configuration | **Kla is the single editor and integration owner** of the HUB NGINX configuration in Git and Production. The existing Git↔runtime drift is reconciled first; after that, Git is the source of truth. `/security/` is added only on that baseline. IDEA3 supplies the route contract, the CSP/security policy, and the tests, and never edits the shared HUB runtime itself | the drift reconciliation comes first; the change is a Kla-reviewed infrastructure change | — | APPROVED (architecture/integration only) |
| **K2** | The `/security/` location contract | `/security` redirects to `/security/`. `/security/` proxies to the IDEA3 container over the full path with no prefix rewrite, and IDEA3 has no direct public host port. HUB NGINX owns the browser-facing security headers and CSP, using the single-hop proxy-header contract with the original `Host` preserved for IDEA3's CSRF Origin check. `Cache-Control: no-store` may pass through from IDEA3. The D5 machine sub-path returns **404** on the browser block. Routing tests and CSP/header-parity tests are added | **before claiming single header ownership, enumerate every security-related response header IDEA3/Helmet actually emits, and have the edge suppress or intentionally own each one** (do not assume a fixed list) | UI compatibility with the strict HUB CSP (especially `style-src` without `'unsafe-inline'`); runtime routing; session-cookie and CSRF Origin behaviour through the HUB; refusal of every machine-path case variant | APPROVED (architecture/integration only) |
| **K3** | Sequencing relative to PR #118 / S5.5 | S5.5 reaches a stable, validated state, or is formally rolled back, **before** the PR10 D3/D5 Production rollout. The PR10 rollout is a separate Kla-reviewed change, never in the same maintenance window as any S5.5 step. Each change keeps an independent rollback. PR10 work that doesn't touch Production (source, tests, S2 design once S1 closes) may continue in parallel | the pending host reboot is scheduled outside both windows; K12 confirmation comes before the PR10 rollout | S5.5's final state and timeline; S5.5 chain persistence across reboot; that S5.5's planned bridge table leaves an IDEA3 bridge untouched | APPROVED (architecture/integration only) |
| **K4** | The IDEA3 Docker subnet | Allocate the candidate `/29` that did not overlap the observed live subnets and sits next to the S5.x public-share allocations. Host order: gateway `.1`, HUB `.2` (pinned trusted proxy), IDEA3 Web `.3`, `.4`–`.6` reserved. It is recorded in the infrastructure address plan through Kla's change, and IDEA3 trusts exactly the HUB's pinned address | Kla allocates the final value; re-check it immediately before the network is created | collisions with networks Kla plans but hasn't recorded; still free at rollout | APPROVED (architecture/integration only) |
| **K5** | Dedicated IDEA3 network ownership and membership | `internal: true`, not attachable, **only the HUB and IDEA3 Web** as members. IDEA3 Web joins no other network (not the shared application bridge, the HUB↔Drive proxy network, the VLAN macvlan, or any S5.x network). It is defined in an IDEA3 production Compose overlay. Music owns the IDEA3 service; Kla owns the network, its address plan, and the HUB's membership. Any later cross-network need is a new reviewed decision | isolation is by membership, because same-bridge traffic isn't filtered by iptables on this host (PR #118 repository evidence) | IDEA3 Web's future outbound needs (`internal: true` blocks them); S5.5 bridge-table interaction; runtime behaviour | APPROVED (architecture/integration only) |
| **K6** | Server firewall rules around the S5.5 anchors | PR10 adds **no** server host firewall or UFW rules (none in `INPUT`, `FORWARD`, `DOCKER-USER`, or nftables). It never modifies, reorders, or flushes S5.5's chains, anchors, or planned bridge table. Any future IDEA3 need is a separate Kla-owned change in its own chain, appended after the S5.5 anchors, with its own validation and rollback, and must not trip S5.5's drift checks | — | S5.5's future bridge table and drift checks versus the IDEA3 bridge and HUB 443; chain persistence (K12); the VLAN 20 → 443 path (K8) | APPROVED (architecture/integration only) |
| **K7** | How the HUB joins the IDEA3 network | A **managed Compose recreate**: the network is added to the HUB in a reviewed overlay, and the canonical Compose file order is updated to include that overlay. Validate the rendered model first. Start IDEA3 Web first, then recreate only the HUB, in an announced Kla-run window separate from S5.5 and the reboot. Verify afterwards: HUB health and networks, `/drive/`, `/monitor/`, `/monitor/internal` 404, `/security` redirect and proxy, machine-path 404 on the browser block. Rollback returns to the previous file list and recreates only the HUB. Runtime attach is for emergencies only | every task's `up` must use the same canonical file list | recreate duration and user impact; a clean HUB return on three networks with its bind mounts; the exact overlay syntax until K1; operator procedures using the new list | APPROVED (architecture/integration only) |
| **K8** | The Core → HUB HTTPS 443 machine route | HUB 443 is the **only** machine route, with no new server port. Kla confirms the router allows VLAN 20 → server:443. The machine route is served on its own block (K9). The path runs from the Core (VLAN 20) through the router's inter-VLAN routing and the server's relayed uplink to Docker's 443 translation and the HUB. It is unavailable during a CUT, as designed, and D7 and D4 cover that | implementation-time acceptance test from VLAN 20: TLS handshake succeeds, a valid Core certificate is accepted, a missing or wrong one is rejected, browsers get 404 on the machine path | VLAN 20 → 443 reachability; the router rule; latency and reliability; real-source visibility (K11) | APPROVED (architecture/integration only) |
| **K9** | Server name and mTLS enforcement | A **separate SNI server block** for the machine route with `ssl_verify_client on`. It uses a Kla-chosen internal machine name (placeholder `<idea3-core>.aegis.internal`) with its own server certificate from the internal CA. The browser block stays `server_name _` as `default_server`. The machine block proxies only the D5 path; everything else returns 404. NGINX sets the verified-identity headers itself, overwriting client copies. IDEA3 accepts them only from the HUB's pinned address and requires `SUCCESS` | the Core resolves the machine name via a hosts entry on the Core host (Music) or router DNS (Kla) | name resolution from the Core; coexistence with the `default_server` block; the machine server certificate (not issued); PKI directory contents (not inspected) | APPROVED (architecture/integration only) |
| **K10** | The machine-client CA and its lifecycle | A **dedicated IDEA3 machine-client CA** that issues only `clientAuth` certificates (path length 0), separate from the browser server CA and the D2 MQTT CA. The HUB's machine block trusts only this CA. **Kla holds the CA key offline, not on the AEGIS Server.** The Core generates its own key and CSR, and the key never leaves the Core. Kla signs a certificate valid about 90 days, renewed around day 60 with a brief overlap | expiry is monitored, and it only pauses dispatch, never causing a CUT; revocation uses a Kla-maintained local CRL loaded by the HUB (`ssl_crl`), IDEA3's expected-subject check, and short lifetimes | existing PKI contents; final lifetime and rotation steps; the HUB's CRL reload behaviour; expiry monitoring (not built) | APPROVED (architecture/integration only) |
| **K11** | Source-IP allowlisting | **mTLS is mandatory and primary.** Source allowlisting is optional defence-in-depth only, and never blocks S1 or S2 readiness. It is enabled only when all of these hold: the Core has its fixed VLAN 20 address (D6); a Core-host test shows the HUB's machine-block log recording that address, not the Docker gateway; the result holds after a HUB recreate; the evidence is recorded first. It lives only in NGINX's machine block (`allow <core>/32; deny all;`), never in the host firewall. If the real source isn't preserved: no HUB allowlist, **never allowlist the Docker gateway address**, rely on mTLS on the separate block, and optionally a Kla router rule permitting only VLAN 20 → server:443 | — | real-source preservation on the VLAN 20 → 443 path; whether a router rule is wanted; allowlist behaviour | APPROVED (architecture/integration only) |
| **K12** | Intent and persistence of the partial S5.5 state (owners: Kla + IDEA1) | Kla and IDEA1 confirm in writing whether the partial live S5.5 state is intended, and whether the `AEGIS-PS-*` chains survive a host reboot (no S5.5 systemd unit was observed, so the boot-time re-apply mechanism is unknown). Both answers are recorded before any PR10 Production rollout. The pending reboot is scheduled outside the S5.5 and PR10 windows, with the chains re-checked afterwards. PR10 work that doesn't touch Production may continue | S5.5 truth: egress network present, `AEGIS-PS-*` chains present and anchored, connector not running, no S5.5 runtime file or systemd unit observed; neither fully deployed nor fully absent | that the partial state is intended; chain persistence across reboot; S5.5's final state and timeline; the effect of pending updates | APPROVED (architecture/integration only) |

**Reconciliation:** Kla's approval is recorded here, in §15, and in the
`idea3/idea3-status.md` S1 row, and S1 is closed.

- **S2 readiness** additionally requires the owner's explicit approval of the
  continuation model (S2 runs in a new, explicitly named task/PR). That
  approval was given on 2026-09-12. S2 ran on
  `feat/idea3-pr10-s2-server-core-boundary` and passed and closed on
  2026-09-12. It is repository-only, with LOCAL / SIMULATED evidence, and a
  human reviewer merged it through PR #123 at `d903327e`. No Production change
  was made.
- **External dependencies remain separately owned:**
  - K12 needs Kla + IDEA1 confirmation before any PR10 Production rollout;
  - D6 needs separate Pub/IDEA2 approval for IDEA2 co-residence.
- **Implementation-time checks stay NOT PROVEN** until then: the VLAN 20 → 443
  path, source-address visibility, and CSP compatibility.

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
- **Live AEGIS Server inventory (2026-09-12, §2A), all read-only:**
  - **Unprivileged SSH reads:** platform and runtime versions, storage and mount
    layout, listener bind classes, and systemd unit presence. Also the published
    host ports (from process arguments), a structural parse of the runtime
    Compose files that skipped environment and secret keys, existence checks on
    the S5.5 runtime files, and the repository checkout commit.
  - **HUB configuration comparison:** a comment-stripped comparison of the
    runtime HUB NGINX configuration against Git, made through a temporary local
    scratch copy that was deleted afterwards.
  - **Owner-run root reads:** container-to-network attachments, network internal
    flags, the volume list, UFW status, the iptables backend, policies, and
    chain order, the NAT rules for 80/443, the nft table list, a redacted
    `nginx -T`, the host-to-container configuration hash comparison, and HUB log
    source-class counts.

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
- During the 2026-09-12 live inventory, nothing was changed on the server:
  - no package update or reboot, even though host maintenance items were
    pending;
  - no service restart or reload;
  - no Docker, NGINX, firewall, routing, file, or permission change;
  - no `.env`, secret, private-key, certificate, or container-environment read;
  - no SSH configuration or key-material change; the owner's agent-held key was
    used for signing only.
- No final receipt, and no merge.
