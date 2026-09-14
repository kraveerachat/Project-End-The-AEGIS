# AEGIS IDEA1 Public Share S5.6 Cloudflare Public Activation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL:
> Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task.

## Goal

Activate the single approved Cloudflare named-tunnel hostname route (`share.aegistk-pb.com`)
and public DNS record, and verify public TLS / HTTPS termination under strict fail-closed
isolation gates. This establishes the authorized public transport path for Public Share
redemption while keeping the Public Share UI completely disabled (`PUBLIC_SHARE_UI_ENABLED=false`),
preserving the accepted S5.4 Gateway and Drive State B runtime baseline, keeping GLOBAL
PUBLIC SHARE G6 **OPEN**, and never exposing private surfaces, database, or management planes.

Current checkpoint: S5.6-A through S5.6-H are **CLOSED / PASS** (completed and verified by fresh Human Owner evidence across Production, Cloudflare Control Plane, Public DNS, TLS termination, and Public Edge smoke).
The Human Owner has approved **GLOBAL PUBLIC SHARE G5 = APPROVED** following the verified
merge of S5.5 (PR #118). S5.5 technical implementation is closed and verified, and its
connector runtime has been restored and verified under strict isolation gates in S5.6-B/C.

## Architecture

```text
External Public Client (Internet)
       │
       ▼ [HTTPS TCP/443 (TLS 1.2/1.3)]
Cloudflare Edge Network (share.aegistk-pb.com)
       │
       ▼ [Outbound-only HTTP/2 over TCP/7844 tunnel]
isolated cloudflared connector (172.31.240.3 on edge, 172.31.242.2 on egress)
       │ (Egress filtered by native bridge + iptables host firewall chains)
       │
       ▼ [HTTP reverse-proxy stream]
Public Share Gateway (172.31.240.2 on edge, 172.31.241.2 on upstream)
       │ (Hardened non-root 101:101, zero host-published ports, strips CF headers)
       │
       ▼ [Private upstream HTTP]
AEGIS Drive State B (172.31.241.3 on upstream, /32 trust only)
       │
       ▼
Local File Storage / Database (Internal only)
```

## Tech Stack

- **Edge Provider**: Cloudflare Managed Tunnel (Argo Tunnel v2)
- **Connector**: `cloudflare/cloudflared:2026.9.0@sha256:b7a6db450ae2e2f773d4fbe9ffb48e7b5fc451e17329daab1b4dda5a2487e2cc` pinned OCI image
- **Reverse Proxy Gateway**: `aegis-public-share-gateway:public-share-50ce6e1638` (Nginx, non-root `101:101`, read-only rootfs)
- **Application Core**: AEGIS Drive State B (`aegis-prod-drive:public-share-50ce6e1638`, Node.js ESM, PostgreSQL 15)
- **Firewall & Isolation**: Linux bridge netfilter + iptables-nft chains (`AEGIS-PS-EGRESS`, `AEGIS-PS-INPUT` anchored to `DOCKER-USER` and `INPUT`)
- **Lifecycle & Drift Control**: systemd units (`aegis-public-share-s5-5-firewall.service`, `aegis-public-share-connector.service`, `aegis-public-share-drift.timer` with 60s periodic check)
- **Verification & Probes**: Node.js test runner, `curl`, OpenSSL s_client, dig/Resolve-DnsName

## Spec

Authoritative specifications governing S5.6:
- `docs/superpowers/specs/2026-09-11-idea1-public-share-s5-5-cloudflared-egress-isolation-design.md` — Connector & Egress Isolation Architecture
- `docs/superpowers/specs/2026-09-12-idea1-public-share-s5-5-edge-bridge-firewall-design.md` — Edge Bridge Firewall Design
- `gateway/public-share/production/README.md` — Four-layer Production Runbook & Compose Overlay Topology
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-public-share-architecture.md` — Canonical Public Share Architecture

## Global Constraints

1. **Task umbrella**: `PUBLIC-SHARE-7 — External Deployment & Acceptance`
2. **Current phase**: `S5.6 — Activate named-tunnel hostname route and DNS; verify public TLS`
3. **Target hostname**: `share.aegistk-pb.com`
4. **Target public URL form**: `https://share.aegistk-pb.com/s/[REDACTED]` (never print or commit real token strings)
5. **G5 Gate status**: `APPROVED` by Human Owner
6. **G6 Gate status**: `OPEN` (authorizes final UI activation and completion; cannot be bypassed)
7. **Public Share UI status**: `OFF` (`PUBLIC_SHARE_UI_ENABLED="false"`; UI enablement is reserved for S5.11 after G6)
8. **Current Production baseline**: accepted S5.4 Gateway + Drive State B (cleanly restored after S5.5 rollback verification)
9. **S5.5 Runtime Restoration**: Because S5.5 concluded with a clean rollback test, S5.6 must safely re-establish the S5.5 connector, egress network, firewall, and systemd drift watchdog on Production before activating the public hostname route.
10. **Absolute Prohibition on Private Surface Exposure**:
    - Never expose Drive directly to the Internet or to any non-Gateway network.
    - Never publish host ports on Gateway (`ports:` directive is forbidden; only `expose: 8080` internally).
    - Never expose PostgreSQL (`5432`), HUB, Monitor, host SSH (`22`), Twingate, private APIs, internal Docker networks, or management VLANs.
11. **Single Authorized Path**:
    `Internet -> Cloudflare Edge -> named Managed Tunnel -> isolated cloudflared connector -> Public Share Gateway -> Drive`
12. **Drive Trust Invariant**: Drive proxy trust must remain strictly `172.19.255.2/32,172.31.241.2/32` (HUB proxy and Public Share Gateway). Never add Cloudflare CIDRs, broad subnets, or connector addresses to Drive proxy trust.
13. **Secrecy Contract**: Tunnel tokens, token file contents, credential JSONs, private keys, and session secrets must never be printed in command outputs, recorded in tickets/PRs/receipts, or committed to the repository.

## Starting State

- Git Branch: `feat/idea1-public-share-s5-6-cloudflare-public-activation`
- PR: `#126` (Draft)
- Current Main SHA: `99a6f916f5b4aa20da2a1c2ee68e75162f7e23b7`

**EXPECTED / CARRIED-FORWARD ACCEPTED BASELINE:**

- S5.4 Gateway + Drive State B healthy at the accepted S5.5 final rollback.
- Connector absent.
- Egress network absent.
- S5.5 firewall additions removed.
- Task-owned activation inactive/disabled.
- Public DNS/TLS route absent.
- Internet exposure `NONE`.
- Public Share UI `OFF`.

**S5.6 CURRENT VERIFICATION:** `CLOSED / PASS` across all phases S5.6-A through S5.6-H (proven by fresh Human Owner evidence; public hostname route active on Cloudflare for `share.aegistk-pb.com`; public DNS active with Cloudflare proxy addresses; TLS 1.2/1.3 enforced with minimum TLS 1.2; hostname-scoped HTTP -> HTTPS 308 active; public default-deny validated; zero cross-boundary leaks; connector runtime active/isolated; tunnel healthy with 1 active replica, 1 route; Public Share UI remains OFF; G6 remains OPEN; rollback script verified executable; Public Internet Share not yet externally accepted).

## G5/G6 Gate Contract

- **GLOBAL PUBLIC SHARE G5**: **APPROVED** by Human Owner on 2026-09-13 following S5.5 PR #118 merge. This authorises the controlled deployment of the connector runtime and activation of the single approved public hostname route on Cloudflare.
- **GLOBAL PUBLIC SHARE G6**: **OPEN**. It remains open throughout S5.6, S5.7, S5.8, S5.9, and S5.10. It will be evaluated only after full external resilience, 64 MiB stream, interrupt, and rollback acceptance.
- Under G5, only the single approved hostname `share.aegistk-pb.com` pointing to the named tunnel connector is authorized. Wildcards, root domain routes, additional origins, or alternate hostnames are strictly prohibited.

## Secret Handling

- The Cloudflare Tunnel token is supplied exclusively at the host path `/opt/aegis/runtime/public-share/secrets/cloudflared-token` with this exact accepted S5.5 metadata contract:
  - Type: regular file, never a directory, never a symlink.
  - UID: `0` (`root`).
  - GID: `65532`.
  - Mode: exactly `0440`.
- The secret file is bind-mounted read-only into the connector container at `/run/secrets/cloudflared-token:ro`.
- The validator checks metadata only. It must never read, print, or hash token contents.
- In all reports, receipts, and plans, public URLs must use `https://share.aegistk-pb.com/s/[REDACTED]`.

## Evidence Classes

All acceptance claims in S5.6 must be classified under the following rigorous evidence taxonomy:

1. `SOURCE_IMPLEMENTED`: Code, configuration, or unit tests written and committed in the repository. (Does not prove runtime behavior).
2. `LOCAL_VERIFIED`: Unit, contract, or simulation tests passing in the local development/CI environment. (Does not prove host network isolation or real Cloudflare edge routing).
3. `OWNER_SUPPLIED_PRODUCTION_EVIDENCE`: Raw terminal outputs, exit codes, and timestamps captured on the live host by the Human Owner and provided for analysis.
4. `PRODUCTION_DEPLOYED`: Real containers, networks, systemd units, and firewall chains active on the physical Production server.
5. `CLOUDFLARE_CONTROL_PLANE_VERIFIED`: Non-secret Dashboard or API read-only evidence demonstrating tunnel state, zone status, and route targets.
6. `PUBLIC_DNS_VERIFIED`: Query results from public resolvers (`1.1.1.1`, `8.8.8.8`) proving global record propagation.
7. `PUBLIC_TLS_VERIFIED`: Cryptographic handshake evidence from public network vantage points validating edge certificates, TLS versions, and cipher suites.
8. `REAL_EXTERNAL_ACCEPTANCE`: End-to-end traffic passing from an external cellular or non-management network over the public edge.

*Rule: Repository source alone is NEVER a Production PASS. Historical evidence from previous phases is NEVER valid as a new S5.6 PASS.*

## Mutation Boundaries

| Domain | S5.6-A | S5.6-B | S5.6-C | S5.6-D | S5.6-E..G | S5.6-H |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Repository Source** | Docs only | Frozen | Frozen | Frozen | Frozen | Docs/Receipt only |
| **Production Runtime** | NO | YES (Gated) | Test traffic | NO | Test traffic | Gated closeout |
| **Cloudflare Dashboard**| NO (Read-only) | NO | NO | YES (Gated) | NO | NO |
| **Public DNS** | NO (Read-only) | NO | NO | Automatic | Query only | NO |
| **Public Share UI** | OFF | OFF | OFF | OFF | OFF | OFF |

## Fail-Closed Rules

1. **Absent Network Pre-start Failure**: The connector systemd unit must fail closed immediately if `aegis-ps-eg` bridge is not present.
2. **Missing Token Pre-start Failure**: Pre-start checks must fail if `/run/secrets/cloudflared-token` is absent or a directory.
3. **Firewall Staging Atomicity**: The firewall script rebuilds chains in temporary staging before atomic swap; if any rule fails, the active chain remains untouched.
4. **Drift Enforcement**: The systemd drift timer enforces firewall rules and container attachment every 60 seconds; any undetected attachment or rule flush triggers immediate fail-closed termination.
5. **DNS/Route Drift**: If any unexpected DNS records, unmapped hostnames, or unexpected endpoints appear during preflight or activation, execution immediately stops and rolls back.

## Rollback Principles

- **Connector-Only Isolation**: Rollback of S5.6 public exposure must be decoupled from the core application. Disabling the Cloudflare route or stopping the connector must immediately return the system to a clean private S5.4 baseline without restarting Drive or dropping database connections.
- **Reverse-Order Teardown**:
  1. Remove/disable Cloudflare Public Hostname route (`share.aegistk-pb.com`).
  2. Verify public DNS/HTTP resolution terminates with error or NXDOMAIN.
  3. Stop and disable connector service (`systemctl stop aegis-public-share-connector`).
  4. Remove S5.5 firewall additions via `rollback-s5-5.sh`.
  5. Remove egress network `aegis_public_share_egress`.
  6. Verify S5.4 Gateway and Drive State B remain healthy.

---

## Canonical Phases

### S5.6-A — Read-Only Preflight & Baseline Inventory

- **Objective**: Establish and prove the untouched, clean baseline across Repository, Cloudflare Control Plane, Production host, and Public DNS prior to any mutation.
- **Execution Role**:
  - ChatGPT: Governance and evidence verification gate.
  - Human Owner: Executes read-only checks on Production host and Cloudflare Dashboard.
  - Agent: Maintains repository branch, plans, and canonical documentation.
- **Mutation Allowed**: `NO` (Strictly read-only).
- **Prerequisites**: S5.5 PR #118 merged; G5 owner approval recorded.
- **Execution Steps**:
  1. *Repository Preflight*: Verify clean branch `feat/idea1-public-share-s5-6-cloudflare-public-activation` from `99a6f916`, PR #126 Draft, CI passing.
  2. *Cloudflare Control Plane Preflight*:
     - Verify zone `aegistk-pb.com` exists and status is `Active`.
     - Confirm target hostname is `share.aegistk-pb.com`.
     - Confirm NO existing public DNS record for `share.aegistk-pb.com`.
     - Confirm NO existing Public Hostname route configured in Zero Trust for `share.aegistk-pb.com`.
     - Inspect Managed Tunnel inventory: record display name, tunnel ID, status, and connector count. Ensure NO secret tokens or credentials are printed.
  3. *Production Read-Only Preflight*:
     - Verify running containers: Drive, Gateway, PostgreSQL, Monitor, HUB, Twingate healthy.
     - Verify protected volumes: `aegis_drive_storage`, `aegis_postgres_data`.
     - Verify networks: S5.4 `aegis_public_share_edge` and `aegis_public_share_upstream` present.
     - Verify S5.5 residuals: connector container ABSENT, egress network ABSENT, S5.5 firewall additions ABSENT, task-owned systemd activation INACTIVE/DISABLED.
     - Verify Drive environment: `PUBLIC_SHARE_UI_ENABLED="false"`, `PUBLIC_SHARE_BASE_URL="https://share.aegistk-pb.com"`.
  4. *Public DNS Preflight*:
     - Query `share.aegistk-pb.com` using Cloudflare resolver (`1.1.1.1`) and Google resolver (`8.8.8.8`).
     - Prove that no active public route exists (NXDOMAIN or empty answer).
- **Pass Criteria**: All expected baseline states proven; zero unexpected public exposure; zero secrets exposed.
- **Stop / Fail Criteria**: Any active public DNS record, unexpected route, degraded production service, or repository divergence.

---

### S5.6-B — Restore Accepted S5.5 Runtime

- **Objective**: Re-establish the approved, isolated S5.5 connector runtime, egress network, host firewall, and drift enforcement on Production *without* creating any public hostname route on Cloudflare.
- **Execution Role**: Human Owner executes commands; ChatGPT issues explicit mutation gate.
- **Mutation Allowed**: `YES` (Production host only; Cloudflare control plane remains strictly `NO`).
- **Prerequisites**: S5.6-A PASS.
- **Execution Steps**:
  1. Verify Production checkout and overlay files match reviewed repository HEAD.
  2. Validate the token secret host path as a regular non-symlink file with exact UID `0`, GID `65532`, and mode `0440`; inspect metadata only and never read, print, or hash its contents.
  3. Execute create-before-start sequence via Compose overlay `docker-compose.s5-5.yml`:
     - Create only `public-share-connector` in stopped state through the reviewed four-layer Compose command from the Production runbook (materialises `aegis-ps-eg` bridge).
     - Prove the container has the exact accepted Compose identity, remains stopped, and is joined only to edge (`172.31.240.3`) and egress (`172.31.242.2`).
  4. Apply S5.5 firewall additions via `s5-5-firewall.sh apply`:
     - Creates `AEGIS-PS-EGRESS` and `AEGIS-PS-INPUT` chains.
     - Enforces TCP/7844 outbound-only allowlist to the 20 reviewed Cloudflare `/32` endpoints.
     - Terminal deny on all other egress; denies host-local physical destinations.
  5. Validate firewall configuration via `s5-5-firewall.sh validate`.
  6. Execute pre-start validation check: `s5-5-runtime-check.sh --pre-start`.
  7. Start the already-created connector only through `sudo systemctl start aegis-public-share-connector.service`. The unit executes `s5-5-runtime-check.sh --pre-start` again, then runs the reviewed four-layer `docker compose ... start public-share-connector` command.
  8. Enable and start drift timer: `systemctl enable --now aegis-public-share-drift.timer`.
- **Forbidden Connector Activation Paths**: Never use `docker start`, `docker compose up`, `docker compose run`, or `--force-recreate` for connector activation.
- **Pass Criteria**: Connector running and healthy; establishes outbound HTTP/2 tunnel to Cloudflare over TCP/7844; firewall chains intact; drift timer active; public DNS/hostname remains unconfigured.
- **Stop / Fail Criteria**: Any failure during apply/validate, connector crash-loop, or egress reachability outside the allowlist. Trigger immediate `rollback-s5-5.sh`.

---

### S5.6-C — Pre-Exposure Isolation Re-Verification

- **Objective**: Re-verify all positive reachability and negative isolation invariants on Production before exposing the tunnel to public incoming traffic.
- **Execution Role**: Human Owner executes test probes; ChatGPT reviews probe outputs.
- **Mutation Allowed**: `NO` (Test network traffic only; no configuration changes).
- **Prerequisites**: S5.6-B PASS.
- **Execution Steps**:
  1. *Positive Probes*:
     - Verify connector loopback metrics endpoint (`http://127.0.0.1:20241/ready` or metrics port).
     - Probe Gateway from connector: `172.31.240.2:8080` responds with expected Gateway response.
     - Probe Drive from Gateway: `172.31.241.3:8001` responds with expected Drive API response.
  2. *Negative Probes (Host Isolation)*:
     - Probe Drive directly from connector (`172.31.241.3:8001` -> timeout/refused).
     - Probe PostgreSQL from connector (`5432` -> timeout/refused).
     - Probe host physical interface SSH (`192.168.10.10:22` -> host INPUT drop).
     - Probe non-allowlisted public IP from connector (e.g., `1.1.1.1:7844` or `8.8.8.8:53` -> drop/timeout).
     - Probe unapproved outbound ports from connector (`tcp/443`, `tcp/80`, `udp/7844` -> drop).
  3. *Gateway & Drive Trust Invariants*:
     - Verify Gateway only trusts connector IP `172.31.240.3`.
     - Verify Drive only trusts HUB and Gateway upstream IPs (`172.31.241.2/32`).
- **Pass Criteria**: 100% of positive probes pass; 100% of negative security probes confirm drop/refusal.
- **Stop / Fail Criteria**: Any cross-boundary leak or unexpected reachability. Immediately stop and initiate rollback.

---

### S5.6-D — Public Hostname Route Activation

- **Objective**: Configure the single approved public hostname route on Cloudflare Zero Trust, routing incoming HTTPS traffic from `share.aegistk-pb.com` through the named tunnel to the Public Share Gateway.
- **Execution Role**: Human Owner in Cloudflare Dashboard; ChatGPT issues mutation gate.
- **Mutation Allowed**: `YES` (Cloudflare Zero Trust control plane only).
- **Prerequisites**: S5.6-A, S5.6-B, and S5.6-C all PASS.
- **Execution Steps**:
  1. In Cloudflare Zero Trust Dashboard -> Networks -> Tunnels -> select named AEGIS tunnel.
  2. Add Public Hostname (Published application):
     - Route type: Published application
     - Subdomain: `share`
     - Domain: `aegistk-pb.com` (hostname `share.aegistk-pb.com`)
     - Path: blank (root route for this hostname only)
     - Service Type: `HTTP`
     - URL: `http://172.31.240.2:8080`
  3. Additional Application Settings:
     - Using defaults (internal hop is plain HTTP; No TLS Verify was not configured).
  4. Save Hostname.
  5. Record non-secret metadata: Tunnel ID, hostname `share.aegistk-pb.com`, target URL, timestamp.
- **Pass Criteria**: Hostname entry active in Cloudflare; tunnel status HEALTHY with 1 active replica, 1 route; Cloudflare proxies traffic via Anycast edge.
- **Execution Outcome**: CLOSED / PASS. Cloudflare Zero Trust Published application route created; 0 wildcards, 0 root-domain routes, 0 alternate hostnames.
- **Stop / Fail Criteria**: Misconfiguration, attempt to add wildcard, or tunnel connection drop. Immediate rollback: delete Public Hostname route.

---

### S5.6-E — Public DNS Verification

- **Objective**: Verify that public DNS resolvers resolve `share.aegistk-pb.com` to the expected Cloudflare Anycast edge proxies without leaking origin IPs or private records.
- **Execution Role**: Human Owner / External client.
- **Mutation Allowed**: `NO` (Read-only queries).
- **Prerequisites**: S5.6-D PASS.
- **Execution Steps**:
  1. Query via Cloudflare DNS (`1.1.1.1`):
     - `dig @1.1.1.1 share.aegistk-pb.com A` (or `Resolve-DnsName`)
  2. Query via Google DNS (`8.8.8.8`):
     - `dig @8.8.8.8 share.aegistk-pb.com A`
  3. Verify responses:
     - Returns Cloudflare Anycast IPv4/IPv6 addresses (e.g., `104.21.x.x`, `172.67.x.x`).
     - Zero private addresses (`10.x`, `172.16-31.x`, `192.168.x`) in answers.
     - No unexpected CNAME chains or dangling records.
- **Pass Criteria**: Both resolvers return consistent Cloudflare proxy records; no private address leakage.
- **Stop / Fail Criteria**: Resolution failure after propagation window, or resolution returning unexpected IP ranges.

---

### S5.6-F — Public TLS / HTTPS Verification

- **Objective**: Validate end-to-end TLS termination, cipher negotiation, certificate validity, and HTTP redirect policies over public Internet transport.
- **Execution Role**: Human Owner / External client.
- **Mutation Allowed**: `NO` (Read-only network probes).
- **Prerequisites**: S5.6-E PASS.
- **Execution Steps**:
  1. *Certificate Chain Inspection*:
     - `openssl s_client -connect share.aegistk-pb.com:443 -servername share.aegistk-pb.com`
     - Verify CN/SAN covers `share.aegistk-pb.com` or `*.aegistk-pb.com`.
     - Verify certificate issuer is trusted (Cloudflare Inc / Google Trust Services / Let's Encrypt).
     - Verify certificate validity dates.
  2. *Protocol Version Validation*:
     - Test TLS 1.2 handshake: MUST succeed.
     - Test TLS 1.3 handshake: MUST succeed.
     - Test TLS 1.0 / 1.1: MUST be rejected.
  3. *Plaintext HTTP Behavior*:
     - Send plaintext request to `http://share.aegistk-pb.com/`.
     - Confirm HTTP 301 / 308 redirect to `https://share.aegistk-pb.com/` (ensuring bearer tokens are never transmitted in plaintext).
- **Pass Criteria**: Trusted certificate with valid SAN; TLS 1.2+ enforced; automatic HTTPS redirect active.
- **Stop / Fail Criteria**: Untrusted cert, TLS handshake error, or plaintext HTTP serving application content.

> [!important] Execution Deviation & Owner Hardening Mutations in S5.6-F
> The plan originally assumed S5.6-F would be purely read-only verification.
> However, initial verification revealed two security-hardening gaps:
> 1. Plaintext HTTP (`http://share.aegistk-pb.com/`) returned HTTP 404 without redirecting to HTTPS (`Always Use HTTPS = OFF`).
> 2. Minimum TLS Version was configured to default `TLS 1.0`, accepting deprecated TLS 1.0 and 1.1 handshakes.
>
> Following explicit scoped ChatGPT mutation gates, the Human Owner applied two authorized Cloudflare mutations:
> 1. **Hostname-scoped Single Redirect Rule** (`AEGIS Share HTTP to HTTPS`): wildcard `http://share.aegistk-pb.com/*` -> `https://share.aegistk-pb.com/${1}` with `308 Permanent Redirect` and query string preservation.
> 2. **Zone-level Minimum TLS Version**: elevated from `TLS 1.0` to `TLS 1.2`.
>
> Post-remediation verification confirmed:
> - Plaintext HTTP requests return `308 Permanent Redirect` to HTTPS (preserving path and query parameters).
> - TLS 1.0 and TLS 1.1 connections are strictly rejected (`curl exit=35`).
> - TLS 1.2 and TLS 1.3 handshakes pass cleanly (`curl exit=0`).
> - Certificate SAN covers `share.aegistk-pb.com` and `*.aegistk-pb.com` (Let's Encrypt, valid 2026-09-10 to 2026-12-09).
> - Standard `curl` verification succeeds without `-k`. (Note: SslStream callback during metadata inspection accepted the cert for inspection purposes only; real trust chain validated via normal curl).
> Outcome: S5.6-F CLOSED / PASS.

---

### S5.6-G — Immediate Public Default-Deny Smoke

- **Objective**: Perform immediate black-box smoke testing against the public edge to confirm strict default-deny enforcement on unapproved paths and methods.
- **Execution Role**: External client across public Internet (e.g., mobile hotspot/4G).
- **Mutation Allowed**: `NO` (External HTTP probes).
- **Prerequisites**: S5.6-F PASS.
- **Execution Steps**:
  1. *Negative Route Smoke (Must Deny / 404 / 403)*:
     - `GET https://share.aegistk-pb.com/` -> Expect 404 Not Found (or Gateway custom error; never Drive UI).
     - `GET https://share.aegistk-pb.com/drive/` -> Expect 404.
     - `GET https://share.aegistk-pb.com/api/` -> Expect 404.
     - `GET https://share.aegistk-pb.com/healthz` -> Expect 404 (Gateway does not expose internal healthz to edge).
     - `GET https://share.aegistk-pb.com/monitor/` -> Expect 404.
     - `GET https://share.aegistk-pb.com/internal/` -> Expect 404.
  2. *Host Header Validation*:
     - `curl -H "Host: evil.com" https://share.aegistk-pb.com/` -> Rejected by Gateway / Cloudflare.
  3. *Method Restriction*:
     - `PUT`, `DELETE`, `PATCH` to public routes -> Rejected (405 Method Not Allowed).
  4. *Approved Route Shape Probe*:
     - Probe nonexistent share redemption path: `GET https://share.aegistk-pb.com/s/invalid-token-probe` -> Expect clean Gateway/Drive 404 response without leaking stack trace or server tokens.
- **Pass Criteria**: All unapproved paths return 404/403/405; zero private services or administrative endpoints exposed; no server headers or internal IP leakage.
- **Stop / Fail Criteria**: Any private interface leakage, internal path response, or server information disclosure.
- **Execution Outcome**: CLOSED / PASS. Unapproved paths (`/`, `/drive/`, `/api/`, `/healthz`, `/monitor/`, `/internal/`) returned 404; invalid Host returned 403; forbidden methods (PUT/DELETE/PATCH) returned 405; nonexistent share token returned safe 404 'Link unavailable'; zero internal IPs or infrastructure tokens leaked. Server header `cloudflare` is expected public-edge metadata.
- **Evidence Limitation**: REAL_EXTERNAL_ACCEPTANCE=NOT_YET_FULLY_PROVEN (no real bearer share token was used in smoke; Twingate-OFF Wi-Fi and 4G/5G external client acceptance deferred to future S5.8).

---

### S5.6-H — Evidence Reconciliation, Closeout & Rollback Readiness

- **Objective**: Reconcile all S5.6 evidence, prove emergency rollback readiness, update canonical Obsidian documentation, create the single immutable S5.6 receipt, and prepare PR #126 for review.
- **Execution Role**: Agent + Human Owner review.
- **Mutation Allowed**: Docs and test evidence only.
- **Prerequisites**: S5.6-A through S5.6-G all PASS.
- **Execution Steps**:
  1. *Rollback Verification Check*:
     - Confirm exact emergency rollback runbook steps are validated and executable in under 2 minutes.
     - Confirm running Production state is documented accurately.
  2. *Canonical Status Updates*:
     - Update `idea1-status.md`: S5.6 marked CLOSED / PASS; record active hostname and TLS parameters; S5.6 Session Register completed.
     - Update `idea1-moc.md`: record S5.6 closure; update remaining open queue.
     - Update `idea1-public-share-architecture.md`: update PUBLIC-SHARE-7 matrix.
  3. *Receipt Creation*:
     - Create exactly ONE immutable task receipt:
       `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/YYYY-MM-DD_HHMMSS_kla_public-share-s5-6-cloudflare-public-activation.md`
     - Record all commands, exit codes, evidence classes, and limitations.
  4. *PR Closeout*:
     - Update PR #126 body to match receipt evidence.
     - Run full vault and collaboration policy validation.
     - Mark PR #126 Ready for Human Review.
- **Pass Criteria**: Single immutable receipt added; canonical notes reconciled; policy and guardrail tests pass.
- **Execution Outcome**: CLOSED / PASS. Single immutable receipt added: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-09-14_020000_kla_public-share-s5-6-cloudflare-public-activation.md`.
- **Rollback Readiness & Claim Boundary**: Fresh evidence confirms rollback artifact executable at `/opt/aegis/runtime/public-share/rollback-s5-5.sh` (SHA256: `a8c5be430b6c97d1b9e891eb4ad1a930a0580d2165b89ae44fdb200dc30923a7`). However, S5.6 did NOT destructively re-run the rollback after public activation. Therefore: `S5_6_ROLLBACK_REHEARSAL=NOT_RUN`, `ROLLBACK_UNDER_2_MINUTES=NOT_REPROVEN`. Historical S5.5 clean rollback serves as design background only.

---

## Final Verification

Before final handoff and receipt generation, run:
```bash
node scripts/validate-vault.mjs
node --test tests/collaborationPolicy.test.mjs
git diff --check
git diff --name-status origin/main...HEAD
```
Verify that:
- Zero runtime application code or test contracts were modified.
- Only documentation and the single approved task receipt were added.
- All evidence classes are cited accurately without conflating repository tests with live Production results.

## Final Receipt / Merge Governance

- **Receipt Policy**: Exactly one final immutable receipt under `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/` owned by `kla`.
- **Review Requirement**: Functional owner review (`kla` / `kraveerachat`) and integration review.
- **Merge Prohibition**: Agent NEVER merges PR #126. Merge is performed exclusively by the Human Owner after all checks and approvals pass.
