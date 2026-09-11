# IDEA1 Public Share S5.5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task.

## Goal

Translate the owner-approved S5.5-B specification into an exact, test-driven
repository implementation plan for PUBLIC-SHARE-7 / S5.5 across canonical phases
S5.5-C through S5.5-H. S5.5 adds an isolated Cloudflare connector layer on a
dedicated egress bridge network (`172.31.242.0/29`) and edge bridge network
(`172.31.240.0/29`), enforced by task-owned forwarding and host-input firewall
chains, orchestrated by systemd units with active periodic drift enforcement that
guarantees fail-closed isolation, and verifiable through independent rollback
without modifying the accepted S5.4 Gateway/Drive runtime baseline or exposing
the service to the public Internet.

Current checkpoint: S5.5-A, S5.5-B, S5.5-C, and S5.5-D are **CLOSED / PASS**
(S5.5-D repository implementation only). Tasks 1–7 are complete and accepted at
repository commit `3ffbf32b3e45a1ed80a239cc9ada6a659b0f7517`. S5.5-E through
S5.5-H remain **NOT STARTED**. No Production mutation has been performed.

## Canonical Phase Roadmap

| Canonical Phase | Title | Scope | Execution Safety Boundary |
| :--- | :--- | :--- | :--- |
| **S5.5-A** | Audit / Preflight | Repository audit, worktree bootstrap, read-only Production preflight | **CLOSED / PASS** |
| **S5.5-B** | Design / Repository Preparation | Owner-approved specification freezing topology, credential, firewall, lifecycle and rollback | **CLOSED / PASS** |
| **S5.5-C** | Egress / Connector Repository Preparation | Tasks 1–3: Pinned image verification, Compose-model tests FIRST, minimal S5.5 overlay with verified pin | **CLOSED / PASS** |
| **S5.5-D** | Firewall Implementation | Tasks 4–7: Authoritative allowlist verification gate, firewall model tests FIRST, task-owned firewall tooling, host INPUT guard | **CLOSED / PASS — REPOSITORY IMPLEMENTATION ONLY** |
| **S5.5-E** | Cloudflared Connector / Lifecycle | Tasks 8–13: Pre-start validator, systemd units, periodic drift enforcement, rollback tooling, security regressions, runbook | **REPOSITORY ONLY — NO PROD MUTATION** |
| **S5.5-F** | Runtime / Isolation Acceptance | Task 14: Separately authorised Production runtime deployment, positive reachability, and negative isolation probes | **REQUIRES EXPLICIT PROD APPROVAL** |
| **S5.5-G** | Rollback / Persistence | Task 15: Host reboot/daemon restart persistence, drift simulation, and connector-only rollback acceptance | **REQUIRES EXPLICIT PROD APPROVAL** |
| **S5.5-H** | Final Documentation / Closeout | Task 16: Canonical Obsidian reconciliation and exactly one immutable task receipt | **REPOSITORY ONLY — CLOSEOUT GATE** |

## Task-to-Phase Matrix

| Task | Title | Canonical Phase | Status | Primary Outputs |
| :--- | :--- | :--- | :--- | :--- |
| **Task 1** | Pinned `cloudflared` Image Contract | `S5.5-C` | **CLOSED / PASS** | `cloudflared-pin.json`, `verify-cloudflared-image.sh`, `publicShareCloudflaredPin.test.js` |
| **Task 2** | S5.5 Compose-Model Tests FIRST | `S5.5-C` | **CLOSED / PASS** | `publicShareS55RuntimeContract.test.js` |
| **Task 3** | S5.5 Compose Overlay via Verified Pin | `S5.5-C` | **CLOSED / PASS** | `docker-compose.s5-5.yml` |
| **Task 4** | Authoritative Cloudflare Transport Allowlist Gate | `S5.5-D` | **CLOSED / PASS** | `cloudflare-endpoints.json`, `verify-cloudflare-endpoints.sh` (`CLOUDFLARE_TRANSPORT_ALLOWLIST=VERIFIED`) |
| **Task 5** | Firewall Semantic / Model Tests FIRST | `S5.5-D` | **CLOSED / PASS** | `publicShareS55FirewallContract.test.js` |
| **Task 6** | Firewall Apply / Validate / Remove Tooling | `S5.5-D` | **CLOSED / PASS** | `s5-5-firewall.sh` (consumes `cloudflare-endpoints.json`) |
| **Task 7** | Host INPUT Guard & Negative Assertions | `S5.5-D` | **CLOSED / PASS** | Negative assertions in `publicShareS55FirewallContract.test.js` & `s5-5-firewall.sh` |
| **Task 8** | Connector / Topology Pre-Start Validator | `S5.5-E` | NOT STARTED | `s5-5-runtime-check.sh` (`--pre-start`) |
| **Task 9** | systemd Firewall & Connector Lifecycle Units | `S5.5-E` | NOT STARTED | `aegis-public-share-s5-5-firewall.service`, `aegis-public-share-connector.service` |
| **Task 10** | Periodic Drift Fail-Closed Enforcement | `S5.5-E` | NOT STARTED | `aegis-public-share-drift.service`, `aegis-public-share-drift.timer`, `s5-5-runtime-check.sh` (`--enforce-drift`) |
| **Task 11** | Connector-Only Rollback Tooling | `S5.5-E` | NOT STARTED | `rollback-s5-5.sh` |
| **Task 12** | Credential Secrecy & Security Regressions | `S5.5-E` | NOT STARTED | `publicShareSecurityRegression.test.js` |
| **Task 13** | Production Runbook Update | `S5.5-E` | NOT STARTED | `gateway/public-share/production/README.md` |
| **Task 14** | Production Runtime & Isolation Acceptance | `S5.5-F` | NOT STARTED | Production verification evidence (positive + negative probes) |
| **Task 15** | Production Restart & Rollback Acceptance | `S5.5-G` | NOT STARTED | Production persistence and clean rollback evidence |
| **Task 16** | Canonical Obsidian Closeout & Final Receipt | `S5.5-H` | NOT STARTED | Updated canonical notes, exactly one immutable task receipt |

## Architecture

```text
Cloudflare edge network (region1 / region2)
         ^
         | TCP/7844 outbound HTTP/2 tunnel
         | (NO UDP/7844, NO TCP/443, NO inbound listener)
         |
+-------------------------------------------------------------------------+
| public-share-connector (official cloudflared tag@sha256)                |
| UID/GID: 65532:65532 | read_only: true | cap_drop: ALL                  |
| no-new-privileges: true | restart: on-failure:5                         |
| Credential: --token-file /run/secrets/cloudflared-token (read-only)     |
+-------------------------------------------------------------------------+
       |                                              |
       | 172.31.240.3                                 | 172.31.242.2
       v                                              v
+-----------------------------+        +----------------------------------+
| aegis_public_share_edge     |        | aegis_public_share_egress        |
| bridge, internal: true      |        | bridge, internal: false          |
| subnet: 172.31.240.0/29     |        | subnet: 172.31.242.0/29          |
| gateway: 172.31.240.1       |        | gateway: 172.31.242.1            |
| mode: isolated              |        | bridge: aegis-ps-eg (masquerade) |
+-----------------------------+        +----------------------------------+
       | 172.31.240.2                                 |
       v                                              | [NAT via host]
+------------------------------------+                |
| public-share-gateway (nginx)       |                |
| UID: 101:101 | read_only: true     |                |
| HTTP cleartext on edge (8080)      |                |
+------------------------------------+                |
       | 172.31.241.2                                 |
       v                                              |
+-----------------------------+                       |
| aegis_public_share_upstream |                       |
| bridge, internal: true      |                       |
| subnet: 172.31.241.0/29     |                       |
| gateway: 172.31.241.1       |                       |
| mode: isolated              |                       |
+-----------------------------+                       |
       | 172.31.241.3                                 |
       v                                              |
+------------------------------------+                |
| drive (AEGIS Drive State B)        |                |
| upstream + 3 private networks      |                |
| NO edge, NO egress attachment      |                |
+------------------------------------+                |
                                                      v
                                        Firewall Enforcement:
                                        1. DOCKER-USER -> AEGIS-PS-EGRESS
                                        2. INPUT -> AEGIS-PS-INPUT
                                        3. Periodic Drift Timer -> Stop on Drift
```

### Exact Network Topology Matrix

| Network | Driver | Internal | Subnet | Gateway | Gateway Mode | Bridge Name | Members & Fixed IPs |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `aegis_public_share_edge` | bridge | `true` | `172.31.240.0/29` | `172.31.240.1` | `isolated` | Docker-assigned | `public-share-gateway`: `.2`<br>`public-share-connector`: `.3` |
| `aegis_public_share_upstream` | bridge | `true` | `172.31.241.0/29` | `172.31.241.1` | `isolated` | Docker-assigned | `public-share-gateway`: `.2`<br>`drive`: `.3` |
| `aegis_public_share_egress` | bridge | `false` | `172.31.242.0/29` | `172.31.242.1` | `nat` (default) | `aegis-ps-eg` | `public-share-connector`: `.2`<br>(Masquerade enabled) |

### Forbidden Network Attachments

- `public-share-connector` MUST NOT attach to: `aegis_public_share_upstream`, `aegis_internal`, `aegis_drive_proxy`, `aegis_vlan10`, `aegis_vlan10_macvlan`, default Docker bridge, Monitor, Twingate, or host network.
- `public-share-gateway` MUST NOT attach to: `aegis_public_share_egress`, `aegis_internal`, `aegis_drive_proxy`, `aegis_vlan10`, default bridge, or host network.
- `drive` MUST NOT attach to: `aegis_public_share_edge`, `aegis_public_share_egress`.

## Tech Stack

- **Container Engine:** Docker Engine 29.7.1+ & Docker Compose v2
- **Connector Runtime:** Official `cloudflare/cloudflared` (pinned immutable tag@sha256, version >= 2026.5.2)
- **Host Firewall:** Linux `iptables-nft` (v1.8.11 / nftables kernel backend) using dedicated chains anchored from `DOCKER-USER` and `INPUT`
- **Host Process Management:** Linux `systemd` (system service units, pre-start checks, and periodic timer-driven drift remediation)
- **Test Harness:** Node.js 20+ built-in test runner (`node:test`, `node:assert/strict`)
- **Automation / Scripting:** POSIX Bash (`set -euo pipefail`)

## Spec Path

`docs/superpowers/specs/2026-09-11-idea1-public-share-s5-5-cloudflared-egress-isolation-design.md`

## Global Constraints

1. **PRODUCTION MUTATION ALLOWED = NO** during repository development phases (S5.5-C, S5.5-D, S5.5-E). No Docker container, network, firewall rule, systemd unit, or DNS record is created or modified on the live Production server until explicit owner authorization for S5.5-F.
2. **S5.4 Overlay Immutability:** `gateway/public-share/production/docker-compose.s5-4.yml` remains byte-for-byte unchanged (SHA-256 `cc36d08c16731f888f64cb2dcd84f1c9a41b11e9b447aa16ad67405bcdc12819`).
3. **Separate Overlay:** S5.5 definitions are created strictly in `gateway/public-share/production/docker-compose.s5-5.yml`.
4. **No Fake Digests / No Placeholders:** Pinned image reference is resolved dynamically and stored in `gateway/public-share/production/cloudflared-pin.json`. Task 3 MUST consume that verified pin; substituting any fabricated digest blocks progress.
5. **Machine-Readable Cloudflare Transport Allowlist:** Firewall rules MUST consume `gateway/public-share/production/cloudflare-endpoints.json` produced only after authoritative verification (`CLOUDFLARE_TRANSPORT_ALLOWLIST=VERIFIED`). Speculative IPs or unrestricted `0.0.0.0/0:7844` are forbidden.
6. **Credential Secrecy vs. Explanatory Documentation:** Real tokens, private keys, and `TUNNEL_TOKEN` environment variables are strictly forbidden. The security regression scan detects actual secret values and unsafe usage patterns, NOT explanatory text or test assertions.
7. **Periodic Drift Fail-Closed:** A systemd timer/service validates topology and firewall state every 60s. On unsafe drift, it stops the connector ONLY, leaves the firewall intact, and NEVER stops Gateway or Drive.
8. **No Public Route / Public DNS:** Public hostname `share.aegistk-pb.com` is configuration-only. Public DNS remains unconfigured, Public Share UI remains OFF (`PUBLIC_SHARE_UI_ENABLED="false"`), and G5 remains OPEN.
9. **Obsidian Receipt:** Exactly one task receipt is created at S5.5-H closeout. No final receipt is created during S5.5-C, D, E, F, or G.

---

## Detailed Task Breakdown

### TASK 1: Pinned cloudflared Image Contract + Isolated Smoke Verification

- **Canonical Phase:** `S5.5-C`
- **Goal:** Resolve and verify the exact official `cloudflare/cloudflared` image with immutable tag@sha256 digest, verify version floor (>= 2026.5.2), non-root UID/GID `65532:65532`, `--token-file` parameter support, read-only compatibility, and loopback readiness syntax. Record the verified reference in `gateway/public-share/production/cloudflared-pin.json`.
- **Files:**
  - Create: `gateway/public-share/production/cloudflared-pin.json`
  - Create: `gateway/public-share/production/verify-cloudflared-image.sh`
  - Create: `IDEA1-AEGIS_Drive_LC/tests/publicShareCloudflaredPin.test.js`
- **Interfaces:**
  - Consumes: Official Cloudflare container image registry metadata / inspect schema.
  - Produces: Machine-readable `cloudflared-pin.json` containing `image`, `version`, `digest`, `user`, and `entrypointFlags`.
- **Granular TDD Steps:**
  1. Write failing test in `IDEA1-AEGIS_Drive_LC/tests/publicShareCloudflaredPin.test.js`:
     - Assert `cloudflared-pin.json` exists and parses as valid JSON.
     - Assert `image` property matches `^cloudflare/cloudflared:(202[6-9]\.[0-9]+\.[0-9]+)@sha256:[a-f0-9]{64}$`.
     - Assert `version` >= `2026.5.2`.
     - Assert `digest` matches `^[a-f0-9]{64}$`.
     - Assert rejection of `latest`, untagged digests, or floating tags.
     - Assert `user` is `"65532:65532"`.
     - Assert `verify-cloudflared-image.sh` passes `--verify-pin` against `cloudflared-pin.json`.
  2. Run exact test command:
     ```bash
     cd IDEA1-AEGIS_Drive_LC
     node --test tests/publicShareCloudflaredPin.test.js
     ```
     Expected failure: `ENOENT: no such file or directory, open '.../cloudflared-pin.json'`.
  3. Write minimal implementation:
     - Query official registry for latest tested release >= 2026.5.2 and resolve its immutable sha256 digest.
     - Write `gateway/public-share/production/cloudflared-pin.json` with verified fields.
     - Implement `gateway/public-share/production/verify-cloudflared-image.sh` supporting `--verify-pin` and `--verify-inspect <json>`.
  4. Run test and verify PASS:
     ```bash
     cd IDEA1-AEGIS_Drive_LC
     node --test tests/publicShareCloudflaredPin.test.js
     ```
     Expected output: `pass 1, fail 0`.
  5. Run focused regression:
     ```bash
     node --test tests/publicShareConfig.test.js
     ```
  6. Verify clean diff:
     ```bash
     git diff --check
     ```
  7. Checkpoint commit:
     `feat(idea1): pin immutable cloudflared image contract in s5.5-c`

---

### TASK 2: S5.5 Compose-Model Tests FIRST

- **Canonical Phase:** `S5.5-C`
- **Goal:** Write a comprehensive, failing static contract suite for the future `docker-compose.s5-5.yml` before creating the file.
- **Files:**
  - Create: `IDEA1-AEGIS_Drive_LC/tests/publicShareS55RuntimeContract.test.js`
- **Interfaces:**
  - Consumes: `gateway/public-share/production/docker-compose.s5-4.yml`, `gateway/public-share/production/cloudflared-pin.json` (from Task 1).
  - Produces: Enforced contract asserting overlay immutability, network topology, container hardening, dynamic image pin resolution, and rollback semantics.
- **Granular TDD Steps:**
  1. Write failing test in `IDEA1-AEGIS_Drive_LC/tests/publicShareS55RuntimeContract.test.js`:
     - Test `S5.5-OVERLAY-IMMUTABLE`: Verifies `docker-compose.s5-4.yml` SHA-256 is exactly `cc36d08c16731f888f64cb2dcd84f1c9a41b11e9b447aa16ad67405bcdc12819`.
     - Test `S5.5-COMPOSE-EXISTS`: Asserts `docker-compose.s5-5.yml` exists.
     - Test `S5.5-IMAGE-PIN-CONSUMPTION`: Asserts `public-share-connector` image in `docker-compose.s5-5.yml` matches the verified image reference in `cloudflared-pin.json`.
     - Test `S5.5-SERVICE-CONNECTOR`: Asserts service `public-share-connector` is defined; no `container_name` is set; `user: "65532:65532"`; `read_only: true`; `cap_drop: [ALL]`; `security_opt: [no-new-privileges:true]`; `restart: on-failure:5`; `ports` block is absent; networks are strictly `aegis_public_share_edge` (`172.31.240.3`) and `aegis_public_share_egress` (`172.31.242.2`).
     - Test `S5.5-NETWORK-EGRESS`: Asserts network `aegis_public_share_egress` has `name: aegis_public_share_egress`, `driver: bridge`, `internal: false`, subnet `172.31.242.0/29`, gateway `172.31.242.1`, `com.docker.network.bridge.name: "aegis-ps-eg"`, `com.docker.network.bridge.enable_ip_masquerade: "true"`.
     - Test `S5.5-CREDENTIAL-BOUNDS`: Asserts command specifies `--token-file /run/secrets/cloudflared-token`; asserts volume mount `/run/secrets/cloudflared-token:ro`; asserts no token literal or `TUNNEL_TOKEN` environment variable exists.
     - Test `S5.5-GATEWAY-DRIVE-PRESERVED`: Verifies Gateway and Drive topologies in merged model remain identical to S5.4.
  2. Run exact test command:
     ```bash
     cd IDEA1-AEGIS_Drive_LC
     node --test tests/publicShareS55RuntimeContract.test.js
     ```
     Expected failure: `ENOENT: no such file or directory, open '.../docker-compose.s5-5.yml'`.
  3. Verify diff check:
     ```bash
     git diff --check
     ```
  4. Checkpoint commit:
     `test(idea1): add s5.5 compose contract tests in s5.5-c`

---

### TASK 3: Create docker-compose.s5-5.yml Minimally via Verified Pin

- **Canonical Phase:** `S5.5-C`
- **Goal:** Create `gateway/public-share/production/docker-compose.s5-5.yml` using the exact image reference verified in Task 1 (`cloudflared-pin.json`).
- **Files:**
  - Create: `gateway/public-share/production/docker-compose.s5-5.yml`
- **Interfaces:**
  - Consumes: Verified image reference from `gateway/public-share/production/cloudflared-pin.json`.
  - Produces: Valid Compose v2 overlay file for the S5.5 connector and egress network.
- **Fail-Closed Gate:** If `cloudflared-pin.json` is missing or invalid, Task 3 is **BLOCKED**. No fabricated digest may be substituted.
- **Granular TDD Steps:**
  1. Confirm Task 2 tests fail on missing file.
  2. Read verified image reference from `gateway/public-share/production/cloudflared-pin.json`.
  3. Create `gateway/public-share/production/docker-compose.s5-5.yml` referencing the exact verified image string.
     - Set `services.public-share-connector.command`:
       - `tunnel`
       - `--no-autoupdate`
       - `--metrics`
       - `127.0.0.1:20241`
       - `--protocol`
       - `http2`
       - `run`
       - `--token-file`
       - `/run/secrets/cloudflared-token`
     - Set security opts, user `65532:65532`, `read_only: true`, `cap_drop: [ALL]`, `restart: on-failure:5`.
     - Set networks to edge `.3` and egress `.2`.
     - Set `networks.aegis_public_share_egress` with bridge `aegis-ps-eg`, masquerade enabled, internal false, subnet `172.31.242.0/29`, gateway `172.31.242.1`.
  4. Run exact test command:
     ```bash
     cd IDEA1-AEGIS_Drive_LC
     node --test tests/publicShareS55RuntimeContract.test.js
     ```
     Expected output: ALL tests in `publicShareS55RuntimeContract.test.js` PASS.
  5. Run regression gate:
     ```bash
     cd IDEA1-AEGIS_Drive_LC
     node --test tests/publicShareS54RuntimeContract.test.js
     node --test tests/publicShareGatewayStructure.test.js
     ```
     Expected output: ALL S5.4 and gateway structural tests PASS.
  6. Verify clean diff:
     ```bash
     git diff --check
     ```
  7. Checkpoint commit:
     `feat(idea1): create s5.5 compose overlay with verified image pin in s5.5-c`

---

### TASK 4: Authoritative Cloudflare Transport Allowlist Verification Gate

- **Canonical Phase:** `S5.5-D`
- **Goal:** Verify and snapshot the authoritative Cloudflare Argo Tunnel TCP/7844 destination endpoints into a machine-readable artifact `gateway/public-share/production/cloudflare-endpoints.json` before firewall source is written.
- **Files:**
  - Create: `gateway/public-share/production/cloudflare-endpoints.json`
  - Create: `gateway/public-share/production/verify-cloudflare-endpoints.sh`
  - Create: `IDEA1-AEGIS_Drive_LC/tests/publicShareCloudflareEndpoints.test.js`
- **Interfaces:**
  - Consumes: Official Cloudflare documentation and resolved endpoint verification of `region1.v2.argotunnel.com` and `region2.v2.argotunnel.com`.
  - Produces: Machine-readable allowlist artifact `cloudflare-endpoints.json` and verification gate `CLOUDFLARE_TRANSPORT_ALLOWLIST=VERIFIED`.
- **Implementation Gate:**
  `CLOUDFLARE_TRANSPORT_ALLOWLIST=VERIFIED`
  Firewall implementation (Task 6) is BLOCKED until this gate passes. Speculative or copied lists are prohibited.
- **Granular TDD Steps:**
  1. Write failing test in `IDEA1-AEGIS_Drive_LC/tests/publicShareCloudflareEndpoints.test.js`:
     - Assert `cloudflare-endpoints.json` exists and is valid JSON.
     - Assert `cloudflare-endpoints.json` contains `endpoints` array of valid IPv4 addresses.
     - Assert each IP is a valid `/32` host address (no broad CIDRs, no `0.0.0.0/0`).
     - Assert port is strictly `7844`; assert `protocols` contains only `tcp` (no `udp`, no `443`).
     - Assert `verify-cloudflare-endpoints.sh --check-schema` exits 0.
  2. Run test and verify failure:
     ```bash
     cd IDEA1-AEGIS_Drive_LC
     node --test tests/publicShareCloudflareEndpoints.test.js
     ```
     Expected failure: `ENOENT: missing cloudflare-endpoints.json`.
  3. Resolve authoritative endpoints snapshot and generate `gateway/public-share/production/cloudflare-endpoints.json`.
  4. Implement `gateway/public-share/production/verify-cloudflare-endpoints.sh`.
  5. Run test and verify PASS:
     ```bash
     cd IDEA1-AEGIS_Drive_LC
     node --test tests/publicShareCloudflareEndpoints.test.js
     ```
  6. Run diff check:
     ```bash
     git diff --check
     ```
  7. Checkpoint commit:
     `feat(idea1): verify authoritative cloudflare transport allowlist artifact in s5.5-d`

---

### TASK 5: Firewall Semantic / Model Tests FIRST

- **Canonical Phase:** `S5.5-D`
- **Goal:** Write unit and contract tests in `IDEA1-AEGIS_Drive_LC/tests/publicShareS55FirewallContract.test.js` to define exact iptables rule ordering, chain names, anchor points, allowlist consumption from Task 4, and negative deny rules.
- **Files:**
  - Create: `IDEA1-AEGIS_Drive_LC/tests/publicShareS55FirewallContract.test.js`
- **Interfaces:**
  - Consumes: `gateway/public-share/production/cloudflare-endpoints.json` (from Task 4).
  - Produces: Formal test suite asserting firewall script rule ordering, idempotency, allowlist fidelity, and fail-closed validation.
- **Granular TDD Steps:**
  1. Write failing test in `IDEA1-AEGIS_Drive_LC/tests/publicShareS55FirewallContract.test.js`:
     - Test `FIREWALL-CHAIN-NAMES`: Asserts custom chain names are `AEGIS-PS-EGRESS` and `AEGIS-PS-INPUT`.
     - Test `FIREWALL-ANCHOR-JUMPS`: Asserts `DOCKER-USER` jumps to `AEGIS-PS-EGRESS`; `INPUT` jumps to `AEGIS-PS-INPUT`.
     - Test `FIREWALL-ALLOWLIST-CONSUMPTION`: Asserts rules in `AEGIS-PS-EGRESS` match the exact endpoints from `cloudflare-endpoints.json`; fails if any IP is missing or unauthorized.
     - Test `FIREWALL-ORDERING`:
       1. `-m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT`
       2. `-s 172.31.240.3 -d 172.31.240.2 -p tcp --dport 8080 -j ACCEPT`
       3. Allow rules for reviewed Cloudflare endpoints on TCP/7844 only
       4. DNS path: default deny (or strict measured resolver destination if validated)
       5. Terminal drop: `-s 172.31.240.3 -j DROP` and `-s 172.31.242.2 -j DROP`
     - Test `FIREWALL-SUBCOMMANDS`: Asserts script supports `apply`, `validate`, `remove`.
  2. Run test command:
     ```bash
     cd IDEA1-AEGIS_Drive_LC
     node --test tests/publicShareS55FirewallContract.test.js
     ```
     Expected failure: missing `s5-5-firewall.sh`.
  3. Verify clean diff:
     ```bash
     git diff --check
     ```
  4. Checkpoint commit:
     `test(idea1): add s5.5 firewall contract tests in s5.5-d`

---

### TASK 6: Implement Task-Owned Firewall Tooling (s5-5-firewall.sh)

- **Canonical Phase:** `S5.5-D`
- **Goal:** Implement `gateway/public-share/production/s5-5-firewall.sh` supporting idempotent `apply`, strict `validate`, and clean `remove` without altering unrelated UFW or Docker firewall rules.
- **S5.5-D Measured Production Preflight Baseline (Read-Only Evidence):**
  - `aegis_public_share_edge` network ID: `c76a975802719cac673e9c4a9ed6d39eb1cd5820d90dcee8e4dfca590a40db50` -> Observed Linux bridge: `br-c76a97580271`
  - `aegis_public_share_upstream` network ID: `a96e511142c99f2deb413db8f3c6373927fc716f41f979bf38c8496e28ffe383` -> Observed Linux bridge: `br-a96e511142c9`
  - Edge members: `aegis-prod-public-share-gateway-1` = `172.31.240.2/29`
  - Upstream members: `aegis-prod-public-share-gateway-1` = `172.31.241.2/29`, `aegis-prod-drive-1` = `172.31.241.3/29`
  - Firewall policies: `INPUT` policy DROP, `FORWARD` policy DROP; `FORWARD` traversal: `DOCKER-USER` -> `DOCKER-FORWARD` -> UFW forwarding chains; `DOCKER-USER` currently exists and is empty; `aegis_public_share_egress` absent; connector absent.
- **Critical Design Reconciliation — Dynamic Edge Linux Bridge Resolution:**
  - The Docker network name `aegis_public_share_edge` is NOT a Linux network interface name.
  - Do NOT hard-code `-i aegis_public_share_edge` or `-i br-c76a97580271` (the bridge suffix derives from the Docker network ID and may change if the network is recreated).
  - Tooling in `s5-5-firewall.sh` must resolve the current edge bridge interface dynamically at runtime from `docker network inspect aegis_public_share_edge` (extracting `com.docker.network.bridge.name` option if configured, or deriving `br-${ID:0:12}` from the inspect JSON ID) and validate that the Linux interface exists before applying rules to `AEGIS-PS-INPUT`.
  - The egress bridge uses explicitly configured `com.docker.network.bridge.name: "aegis-ps-eg"`, so `-i aegis-ps-eg` is stable and valid.
- **Files:**
  - Create: `gateway/public-share/production/s5-5-firewall.sh`
- **Interfaces:**
  - Consumes: Linux `iptables` CLI, `gateway/public-share/production/cloudflare-endpoints.json`, `docker network inspect aegis_public_share_edge`.
  - Produces: Executable Bash script managing only `AEGIS-PS-EGRESS` and `AEGIS-PS-INPUT`.
- **Granular TDD Steps:**
  1. Confirm Task 5 tests fail on missing script.
  2. Implement `gateway/public-share/production/s5-5-firewall.sh`:
     - Header: `#!/usr/bin/env bash`, `set -euo pipefail`.
     - Dynamically parse endpoint IPs from `cloudflare-endpoints.json` (do NOT hard-code a speculative list).
     - Dynamically resolve the Linux bridge interface for `aegis_public_share_edge` via `docker network inspect`.
     - Subcommand `apply`:
       - Creates chains `AEGIS-PS-EGRESS` and `AEGIS-PS-INPUT`.
       - Flushes custom chains.
       - Adds established/related accept, connector->gateway TCP/8080 accept, verified Cloudflare TCP/7844 accepts, and terminal drops.
       - Adds interface and IP drops to `AEGIS-PS-INPUT` using dynamically resolved edge bridge and stable egress bridge `aegis-ps-eg`.
       - Inserts jump rules into `DOCKER-USER` and `INPUT` idempotently.
     - Subcommand `validate`:
       - Verifies chains, anchor jumps, rule ordering, interface bindings, and counter availability.
       - Exits 0 on complete valid state; exits 1 on partial, drifted, or missing rules.
     - Subcommand `remove`:
       - Removes jump anchors, flushes custom chains, and deletes chains.
  3. Run test command:
     ```bash
     cd IDEA1-AEGIS_Drive_LC
     node --test tests/publicShareS55FirewallContract.test.js
     ```
     Expected output: ALL tests PASS.
  4. Run diff check:
     ```bash
     git diff --check
     ```
  5. Checkpoint commit:
     `feat(idea1): implement task-owned s5.5 firewall tooling in s5.5-d`

---

### TASK 7: Host INPUT Guard Implementation + Negative Tests

- **Canonical Phase:** `S5.5-D`
- **Status:** **CLOSED / PASS** (repository implementation only; S5.5-D CLOSED / PASS)
- **Goal:** Deepen validation of the host `INPUT` guard `AEGIS-PS-INPUT` to guarantee no packet from connector sources (`172.31.240.3` or `172.31.242.2`) can reach host administration services, bridge addresses, SSH, PostgreSQL, or local resolvers without explicit authorization.
- **Enforcement Principle vs. Acceptance Evidence:**
  - **Enforcement mechanism:** Generic connector-source deny rules in `AEGIS-PS-INPUT` (matching source IPs and ingress interfaces) drop all traffic originating from the connector namespace regardless of destination port or IP.
  - **Acceptance evidence:** The measured host listener inventory provides concrete positive/negative acceptance targets, but is acceptance evidence only, not the firewall filter mechanism.
  - **Host surface topology distinction:**
    - `172.31.240.1` is NOT a measured current Production host-local IPv4 address: the measured edge bridge carries no IPv4 host address (`internal=true`, `gateway_mode_ipv4=isolated`).
    - `172.31.242.1` is DESIGNED FUTURE / MODEL-ONLY because the Production egress network is currently absent.
    - Measured real host acceptance examples observed listening on Production by read-only preflight:
      - `192.168.10.10:22` (host SSH)
      - `192.168.10.10:80` (host HTTP)
      - `192.168.10.10:443` (host HTTPS)
      - `172.18.0.1:18077` (host service on default docker bridge)
      - `127.0.0.53:53` (host systemd-resolved stub)
      - `127.0.0.54:53` (host systemd-resolved stub secondary)
    - TCP `2375` / `2376` are evaluated strictly as SYNTHETIC / MODEL-ONLY forbidden-port semantics (asserting generic source denial holds even if unencrypted/TLS daemon ports were probed); this does NOT claim the Docker API is absent generally.
- **Files:**
  - Modify: `gateway/public-share/production/s5-5-firewall.sh`
  - Modify: `IDEA1-AEGIS_Drive_LC/tests/publicShareS55FirewallContract.test.js`
- **Interfaces:**
  - Consumes: Host interface configuration, dynamic edge bridge resolution, input packet filtering rules.
  - Produces: Verified host-input protection layer with automated negative assertions.
- **Granular TDD Steps:**
  1. Add negative test cases in `publicShareS55FirewallContract.test.js`:
     - Assert generic connector-source drop across measured real host listeners (`192.168.10.10:22`, `192.168.10.10:80`, `192.168.10.10:443`, `172.18.0.1:18077`, `127.0.0.53:53`, `127.0.0.54:53`).
     - Assert generic connector-source drop across synthetic/model-only forbidden ports (TCP `2375`, `2376`, `9090`, loopback `8080`) without claiming Docker API is absent generally.
     - Assert drop of connector -> designed future egress gateway `172.31.242.1` (model-only; egress absent in Prod) and designed edge address `172.31.240.1` (model-only; edge bridge has no IPv4 host address in Prod).
     - Assert drop of connector -> Drive `172.31.241.3:8001`, PostgreSQL `5432`, upstream subnet `172.31.241.0/29`.
     - Assert drop of connector -> UDP/7844, TCP/443, and non-allowlisted Internet.
  2. Update `s5-5-firewall.sh` to enforce explicit bridge interface filtering using stable egress bridge `-i aegis-ps-eg` and dynamically resolved edge Linux bridge (e.g. `br-${ID:0:12}` derived from `docker network inspect aegis_public_share_edge`, NEVER hard-coding `-i aegis_public_share_edge` or a static bridge name), while ensuring S5.4 Gateway (`172.31.240.2`) behavior is preserved.
  3. Run test and verify PASS:
     ```bash
     cd IDEA1-AEGIS_Drive_LC
     node --test tests/publicShareS55FirewallContract.test.js
     ```
  4. Run diff check:
     ```bash
     git diff --check
     ```
  5. Checkpoint commit:
     `feat(idea1): enforce host input guard and negative firewall rules in s5.5-d`

---

### TASK 8: Connector / Topology Pre-Start Validator

- **Canonical Phase:** `S5.5-E`
- **Goal:** Implement `gateway/public-share/production/s5-5-runtime-check.sh` with `--pre-start` mode to inspect topology, firewall validation, and secret file existence/permissions before the connector container is started.
- **Files:**
  - Create: `gateway/public-share/production/s5-5-runtime-check.sh`
  - Modify: `IDEA1-AEGIS_Drive_LC/tests/publicShareS55RuntimeContract.test.js`
- **Interfaces:**
  - Consumes: Docker network inspect, `s5-5-firewall.sh validate`, host filesystem permissions.
  - Produces: Executable pre-start gate returning 0 only when safe, non-zero on any safety violation.
- **Granular TDD Steps:**
  1. Add test cases in `publicShareS55RuntimeContract.test.js`:
     - Asserts `--pre-start` verifies edge network (Gateway at `.2`), upstream network (Gateway at `.2`, Drive at `.3`), and egress network (`172.31.242.0/29`).
     - Asserts invocation of `s5-5-firewall.sh validate` and halts on failure.
     - Asserts verification that `/opt/aegis/runtime/public-share/secrets/cloudflared-token` exists with permissions `0440` and ownership `root:65532` without echoing contents.
     - Asserts refusal if connector is attached to any forbidden network.
  2. Implement `gateway/public-share/production/s5-5-runtime-check.sh`.
  3. Run test and verify PASS:
     ```bash
     cd IDEA1-AEGIS_Drive_LC
     node --test tests/publicShareS55RuntimeContract.test.js
     ```
  4. Run diff check:
     ```bash
     git diff --check
     ```
  5. Checkpoint commit:
     `feat(idea1): implement s5.5 pre-start topology validator in s5.5-e`

---

### TASK 9: systemd Firewall and Connector Lifecycle Units

- **Canonical Phase:** `S5.5-E`
- **Goal:** Create systemd units `aegis-public-share-s5-5-firewall.service` and `aegis-public-share-connector.service` to enforce persistent startup ordering, firewall reconciliation, and fail-closed shutdown.
- **Files:**
  - Create: `gateway/public-share/production/systemd/aegis-public-share-s5-5-firewall.service`
  - Create: `gateway/public-share/production/systemd/aegis-public-share-connector.service`
  - Modify: `IDEA1-AEGIS_Drive_LC/tests/publicShareS55FirewallContract.test.js`
- **Interfaces:**
  - Consumes: Systemd unit semantics, `s5-5-firewall.sh`, `s5-5-runtime-check.sh`, Docker Compose CLI.
  - Produces: Declarative service definitions enforcing: Docker/UFW ready -> firewall apply -> firewall validate -> pre-start check -> connector start.
- **Granular TDD Steps:**
  1. Add unit contract tests in `publicShareS55FirewallContract.test.js`:
     - Assert `aegis-public-share-s5-5-firewall.service`:
       - `Type=oneshot`, `RemainAfterExit=yes`
       - `After=docker.service ufw.service`
       - `ExecStart=/opt/aegis/runtime/public-share/s5-5-firewall.sh apply`
       - `ExecStop=/opt/aegis/runtime/public-share/s5-5-firewall.sh remove`
     - Assert `aegis-public-share-connector.service`:
       - `Requires=aegis-public-share-s5-5-firewall.service`
       - `After=aegis-public-share-s5-5-firewall.service docker.service`
       - `ExecStartPre=/opt/aegis/runtime/public-share/s5-5-runtime-check.sh --pre-start`
       - `ExecStart` starts only `public-share-connector`
       - `ExecStop` stops `public-share-connector`
       - `Restart=on-failure`, `RestartSec=5s`
       - `StartLimitBurst=5`, `StartLimitIntervalSec=60s`
  2. Create unit files in `gateway/public-share/production/systemd/`.
  3. Run test and verify PASS:
     ```bash
     cd IDEA1-AEGIS_Drive_LC
     node --test tests/publicShareS55FirewallContract.test.js
     ```
  4. Run diff check:
     ```bash
     git diff --check
     ```
  5. Checkpoint commit:
     `feat(idea1): define s5.5 systemd firewall and connector units in s5.5-e`

---

### TASK 10: Periodic Drift Fail-Closed Enforcement Timer & Service

- **Canonical Phase:** `S5.5-E`
- **Goal:** Implement persistent, automated drift enforcement that periodically verifies firewall integrity and connector network attachments, immediately stopping the connector if drift occurs while keeping Gateway and Drive operational.
- **Files:**
  - Create: `gateway/public-share/production/systemd/aegis-public-share-drift.service`
  - Create: `gateway/public-share/production/systemd/aegis-public-share-drift.timer`
  - Modify: `gateway/public-share/production/s5-5-runtime-check.sh`
  - Modify: `IDEA1-AEGIS_Drive_LC/tests/publicShareS55RuntimeContract.test.js`
- **Interfaces:**
  - Consumes: Systemd timer/service framework, `s5-5-runtime-check.sh --enforce-drift`.
  - Produces: Periodic fail-closed watchdog stopping `public-share-connector` on any unauthorized attachment or missing firewall rule.
- **Granular TDD Steps:**
  1. Add tests in `publicShareS55RuntimeContract.test.js`:
     - Assert `aegis-public-share-drift.timer`:
       - `OnBootSec=1min`
       - `OnUnitActiveSec=60s`
       - `AccuracySec=15s`
       - `Unit=aegis-public-share-drift.service`
     - Assert `aegis-public-share-drift.service`:
       - `Type=oneshot`
       - `ExecStart=/opt/aegis/runtime/public-share/s5-5-runtime-check.sh --enforce-drift`
     - Test Drift Simulation:
       - On detected drift (missing rule, unauthorized network attachment): asserts script issues `systemctl stop aegis-public-share-connector.service` (or `docker compose stop public-share-connector`).
       - Asserts Gateway and Drive containers are NEVER targeted for stopping.
       - Asserts firewall rules are NOT automatically weakened.
  2. Implement `aegis-public-share-drift.service` and `aegis-public-share-drift.timer`.
  3. Implement `--enforce-drift` in `s5-5-runtime-check.sh`.
  4. Run test and verify PASS:
     ```bash
     cd IDEA1-AEGIS_Drive_LC
     node --test tests/publicShareS55RuntimeContract.test.js
     ```
  5. Run diff check:
     ```bash
     git diff --check
     ```
  6. Checkpoint commit:
     `feat(idea1): implement periodic drift fail-closed enforcement in s5.5-e`

---

### TASK 11: Connector-Only Rollback Tooling

- **Canonical Phase:** `S5.5-E`
- **Goal:** Implement and test automated rollback logic ensuring S5.5 objects can be cleanly removed while preserving S5.4 Gateway, Drive State B, database, and internal sharing.
- **Files:**
  - Create: `gateway/public-share/production/rollback-s5-5.sh`
  - Modify: `IDEA1-AEGIS_Drive_LC/tests/publicShareS55RuntimeContract.test.js`
- **Interfaces:**
  - Consumes: Docker CLI, `s5-5-firewall.sh remove`.
  - Produces: Validated rollback script removing only S5.5 components in reverse order.
- **Granular TDD Steps:**
  1. Add rollback contract tests in `publicShareS55RuntimeContract.test.js`:
     - Assert rollback steps:
       1. Stop and disable `aegis-public-share-drift.timer` and `aegis-public-share-connector.service`.
       2. Stop and remove container `public-share-connector`.
       3. Run `s5-5-firewall.sh remove`.
       4. Verify network `aegis_public_share_egress` has zero endpoints; refuse removal if endpoints remain.
       5. Remove network `aegis_public_share_egress`.
       6. Verify `drive` and `public-share-gateway` are untouched.
       7. Forbid `docker compose down`, `prune`, or volume removal.
  2. Implement `gateway/public-share/production/rollback-s5-5.sh`.
  3. Run test and verify PASS:
     ```bash
     cd IDEA1-AEGIS_Drive_LC
     node --test tests/publicShareS55RuntimeContract.test.js
     ```
  4. Run diff check:
     ```bash
     git diff --check
     ```
  5. Checkpoint commit:
     `feat(idea1): implement s5.5 connector-only rollback tooling in s5.5-e`

---

### TASK 12: Credential Secrecy and Security Regression Matrix

- **Canonical Phase:** `S5.5-E`
- **Goal:** Build automated security regression tests scanning repository files and commit diffs for actual credential values and unsafe runtime patterns without false-positive failures on legitimate documentation terminology.
- **Files:**
  - Modify: `IDEA1-AEGIS_Drive_LC/tests/publicShareSecurityRegression.test.js`
- **Interfaces:**
  - Consumes: Repository trees, staged diffs, configuration files.
  - Produces: Precise secret-leakage detection and protocol enforcement.
- **Pattern Discrimination Specification:**
  - Forbidden runtime patterns:
    - Environment assignment: `/(TUNNEL_TOKEN\s*=\s*\S+|TUNNEL_TOKEN:\s*\S+)/i`
    - Inline token passing: `/--token\s+(?!file)[A-Za-z0-9_-]{20,}/`
    - Token/JWT literal payload: `/eyJh[A-Za-z0-9_-]{15,}/`
    - Private key blocks: `/-----BEGIN (?:RSA|EC|OPENSSH|PRIVATE) KEY-----/`
    - Any tracked file under secret paths: `gateway/public-share/production/secrets/` or `/opt/aegis/runtime/public-share/secrets/`
  - Permitted documentation patterns:
    - Explanatory text discussing `TUNNEL_TOKEN` or `--token-file` without credential values
    - Test assertions verifying rejection of `TUNNEL_TOKEN`
- **Granular TDD Steps:**
  1. Add precise regex patterns to `publicShareSecurityRegression.test.js`.
  2. Verify test PASSES against current design and spec documentation (no false positives).
  3. Verify test FAILS when synthetic secret values or env keys are introduced into test fixtures.
  4. Run test suite:
     ```bash
     cd IDEA1-AEGIS_Drive_LC
     node --test tests/publicShareSecurityRegression.test.js
     ```
     Expected output: ALL tests PASS.
  5. Run diff check:
     ```bash
     git diff --check
     ```
  6. Checkpoint commit:
     `test(idea1): implement precise secret scan and security regression matrix in s5.5-e`

---

### TASK 13: Production Runbook Update

- **Canonical Phase:** `S5.5-E`
- **Goal:** Update `gateway/public-share/production/README.md` to document the 4-file Compose layering order, secret setup procedure, firewall installation, drift management, and independent rollback.
- **Files:**
  - Modify: `gateway/public-share/production/README.md`
- **Interfaces:**
  - Consumes: Completed S5.5-C, D, E artifacts.
  - Produces: Operational documentation with explicit warnings that Production mutation requires separate authorization.
- **Granular TDD Steps:**
  1. Add documentation assertions in `publicShareS55RuntimeContract.test.js`:
     - Verifies 4-file Compose order:
       1. `docker-compose.production.yml`
       2. `drive-s5-3.yml`
       3. `drive-gateway-s5-4.yml`
       4. `connector-s5-5.yml` (copied byte-for-byte from `docker-compose.s5-5.yml`)
     - Verifies secret token path `/opt/aegis/runtime/public-share/secrets/cloudflared-token` with permissions `0440` and owner `root:65532`.
     - Verifies systemd unit installation, drift timer setup, and rollback instructions.
  2. Update `gateway/public-share/production/README.md`.
  3. Run test and verify PASS:
     ```bash
     cd IDEA1-AEGIS_Drive_LC
     node --test tests/publicShareS55RuntimeContract.test.js
     ```
  4. Run diff check:
     ```bash
     git diff --check
     ```
  5. Checkpoint commit:
     `docs(idea1): update production runbook for s5.5 lifecycle and drift guard in s5.5-e`

---

### TASK 14: Production Runtime & Isolation Acceptance (PRODUCTION GATED)

- **Canonical Phase:** `S5.5-F`
- **Execution Condition:** REQUIRES SEPARATE OWNER AUTHORIZATION. MUST NOT BE EXECUTED DURING REPOSITORY PHASES.
- **Goal:** Execute owner-authorized Production deployment of the S5.5 connector on `aegis-system` and capture positive and negative isolation evidence.
- **Verification Evidence Required:**
  - Connector running on edge `172.31.240.3` and egress `172.31.242.2` only.
  - Local readiness check (`cloudflared tunnel ready`) passing against `127.0.0.1:20241`.
  - Gateway reachability (`172.31.240.2:8080`) from connector.
  - Negative probes from connector namespace confirming refusal to Drive direct, PostgreSQL, upstream subnet, host bridge IPs, UDP/7844, and TCP/443.
  - Rule counter increments on `AEGIS-PS-EGRESS` and `AEGIS-PS-INPUT`.
- **Checkpoint Commit:**
  `docs(idea1): record s5.5-f production runtime acceptance evidence`

---

### TASK 15: Production Restart & Rollback Acceptance (PRODUCTION GATED)

- **Canonical Phase:** `S5.5-G`
- **Execution Condition:** REQUIRES SEPARATE OWNER AUTHORIZATION.
- **Goal:** Validate restart persistence (host reboot, Docker restart, UFW reload) and execute connector-only rollback to prove S5.4 Gateway and Drive State B remain fully functional.
- **Verification Evidence Required:**
  - Docker daemon restart maintains fail-closed firewall ordering.
  - Systemd drift timer halts connector when an intentional drift is introduced.
  - Clean execution of `rollback-s5-5.sh` removes only S5.5 objects and restores pristine S5.4 state.
- **Checkpoint Commit:**
  `docs(idea1): record s5.5-g restart and rollback acceptance evidence`

---

### TASK 16: Canonical Obsidian Closeout & Final Receipt

- **Canonical Phase:** `S5.5-H`
- **Goal:** Perform final canonical Obsidian vault reconciliation across all completed evidence and generate exactly ONE immutable task receipt under `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/`.
- **Files:**
  - Create: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/YYYY-MM-DD_HHMMSS_kla_public-share-s5-5-cloudflared-egress-isolation.md`
  - Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md`
  - Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-public-share-architecture.md`
  - Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-moc.md`
- **Receipt Rule:** Exactly one final receipt is created in S5.5-H. No receipt is created in S5.5-C, D, E, F, or G.
- **Checkpoint Commit:**
  `docs(idea1): close public share s5.5 connector isolation with final receipt`

---

## Complete Verification Plan

### Automated Test Gates

```bash
# 1. Vault integrity and link validation
node scripts/validate-vault.mjs

# 2. Collaboration policy and PR governance
node --test tests/collaborationPolicy.test.mjs

# 3. S5.4 baseline regression (overlay immutability)
cd IDEA1-AEGIS_Drive_LC
node --test tests/publicShareS54RuntimeContract.test.js

# 4. Pinned image contract test
node --test tests/publicShareCloudflaredPin.test.js

# 5. Authoritative transport allowlist schema test
node --test tests/publicShareCloudflareEndpoints.test.js

# 6. S5.5 runtime & topology contract tests
node --test tests/publicShareS55RuntimeContract.test.js

# 7. S5.5 firewall & systemd contract tests
node --test tests/publicShareS55FirewallContract.test.js

# 8. Public share security regression matrix (precise regex)
node --test tests/publicShareSecurityRegression.test.js

# 9. Gateway structural tests
node --test tests/publicShareGatewayStructure.test.js

# 10. Full IDEA1 test suite and build
npm test
npm run build
```

### Manual / Structural Inspection Gates

1. Verify `git diff origin/main...HEAD -- gateway/public-share/production/docker-compose.s5-4.yml` produces NO diff.
2. Verify `cloudflared-pin.json` contains no fabricated placeholder digests.
3. Verify `cloudflare-endpoints.json` is verified and authoritative before firewall code is committed (`CLOUDFLARE_TRANSPORT_ALLOWLIST=VERIFIED`).
4. Verify security scan does not reject explanatory documentation.
5. Verify periodic drift timer and service are tested for fail-closed behavior.
6. Verify no Production commands are run during repository phases C, D, E.
