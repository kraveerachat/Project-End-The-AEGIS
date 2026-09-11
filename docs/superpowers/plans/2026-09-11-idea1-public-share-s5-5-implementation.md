# IDEA1 Public Share S5.5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task.

## Goal

Translate the owner-approved S5.5-B specification into an exact, test-driven
repository implementation plan for PUBLIC-SHARE-7 / S5.5. S5.5 adds an isolated
Cloudflare connector layer on a dedicated egress bridge network (`172.31.242.0/29`)
and edge bridge network (`172.31.240.0/29`), enforced by task-owned forwarding
and host-input firewall chains, orchestrated by systemd units that guarantee
fail-closed ordering, and verifiable through independent rollback without
modifying the accepted S5.4 Gateway/Drive runtime baseline or exposing the service
to the public Internet.

At this planning stage, **no runtime implementation is written and no Production
mutation is performed**.

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
- **Host Process Management:** Linux `systemd` (system service units with strict startup dependencies, pre-start checks, and drift remediation)
- **Test Harness:** Node.js 20+ built-in test runner (`node:test`, `node:assert/strict`)
- **Automation / Scripting:** POSIX Bash (`set -euo pipefail`)

## Spec Path

`docs/superpowers/specs/2026-09-11-idea1-public-share-s5-5-cloudflared-egress-isolation-design.md`

## Global Constraints

1. **PRODUCTION MUTATION ALLOWED = NO** during repository development. No Docker container, network, firewall rule, systemd unit, or DNS record is created or modified on the live Production server.
2. **S5.4 Overlay Immutability:** `gateway/public-share/production/docker-compose.s5-4.yml` remains byte-for-byte unchanged (SHA-256 `cc36d08c16731f888f64cb2dcd84f1c9a41b11e9b447aa16ad67405bcdc12819`).
3. **Separate Overlay:** S5.5 definitions are created strictly in `gateway/public-share/production/docker-compose.s5-5.yml`.
4. **Credential Secrecy:** Remotely managed tunnel token is delivered exclusively via `--token-file /run/secrets/cloudflared-token` from host path `/opt/aegis/runtime/public-share/secrets/`. No secret token literal, no `TUNNEL_TOKEN` environment variable, and no inline command-line `--token` argument may ever appear in Git, Compose files, test fixtures, logs, shell history, Obsidian notes, or PRs.
5. **No Public Route / Public DNS:** The public hostname `share.aegistk-pb.com` is configuration-only. Public DNS remains unconfigured, Public Share UI remains OFF (`PUBLIC_SHARE_UI_ENABLED="false"`), and G5 remains OPEN.
6. **Fail-Closed Default:** If the firewall is absent, partially installed, or drifted, the connector MUST NOT start, or MUST immediately be stopped.
7. **Obsidian Receipt:** Exactly one task receipt is created at S5.5-H closeout. No final receipt is created during S5.5-C.

---

## Independently Testable Tasks

### TASK 1: Pinned cloudflared Image Contract + Isolated Smoke Verification

- **Goal:** Pin the exact official `cloudflare/cloudflared` image with immutable tag@sha256 digest, verify version floor (>= 2026.5.2), non-root UID/GID `65532:65532`, `--token-file` parameter support, read-only compatibility, and loopback readiness command syntax.
- **Files:**
  - Create: `gateway/public-share/production/verify-cloudflared-image.sh`
  - Create: `IDEA1-AEGIS_Drive_LC/tests/publicShareCloudflaredPin.test.js`
- **Interfaces:**
  - Consumes: Official Cloudflare container image registry metadata / inspect schema.
  - Produces: Hardened, pinned image reference constant and executable image verification validator.
- **Granular TDD Steps:**
  1. Write failing test in `IDEA1-AEGIS_Drive_LC/tests/publicShareCloudflaredPin.test.js`:
     - Assert pinned image string conforms to `^cloudflare/cloudflared:(202[6-9]\.[0-9]+\.[0-9]+)@sha256:[a-f0-9]{64}$`.
     - Assert version >= `2026.5.2`.
     - Assert rejection of `latest`, floating tags, or untagged digests.
     - Assert image inspection contract expects `Config.User == "65532:65532"`.
     - Assert entrypoint command flags include `--no-autoupdate`, `--protocol http2`, and `--token-file /run/secrets/cloudflared-token`.
  2. Run exact test command:
     ```bash
     cd IDEA1-AEGIS_Drive_LC
     node --test tests/publicShareCloudflaredPin.test.js
     ```
     Expected failure: `MODULE_NOT_FOUND` or assertion error on missing pin constants.
  3. Write minimal implementation:
     - Define `CLOUDFLARED_PINNED_IMAGE` constant in `gateway/public-share/production/cloudflared-pin.json` or exported module.
     - Implement `gateway/public-share/production/verify-cloudflared-image.sh` with flags `--verify-offline` (model check) and `--verify-inspect <image-inspect-json>`.
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
     `feat(idea1): pin immutable cloudflared image contract`

---

### TASK 2: S5.5 Compose-Model Tests FIRST

- **Goal:** Write a comprehensive, failing static contract suite for the future `docker-compose.s5-5.yml` before creating the file.
- **Files:**
  - Create: `IDEA1-AEGIS_Drive_LC/tests/publicShareS55RuntimeContract.test.js`
- **Interfaces:**
  - Consumes: `gateway/public-share/production/docker-compose.s5-4.yml`, `gateway/public-share/production/docker-compose.s5-5.yml` (future).
  - Produces: Enforced contract asserting overlay immutability, network topology, container hardening, credential boundaries, and rollback semantics.
- **Granular TDD Steps:**
  1. Write failing test in `IDEA1-AEGIS_Drive_LC/tests/publicShareS55RuntimeContract.test.js`:
     - Test `S5.5-OVERLAY-IMMUTABLE`: Reads `docker-compose.s5-4.yml` and verifies its SHA-256 is exactly `cc36d08c16731f888f64cb2dcd84f1c9a41b11e9b447aa16ad67405bcdc12819`.
     - Test `S5.5-COMPOSE-EXISTS`: Asserts `gateway/public-share/production/docker-compose.s5-5.yml` exists.
     - Test `S5.5-SERVICE-CONNECTOR`: Asserts service `public-share-connector` is defined; no `container_name` is set; image matches pinned tag@sha256; `user: "65532:65532"`; `read_only: true`; `cap_drop: [ALL]`; `security_opt: [no-new-privileges:true]`; `restart: on-failure:5`; `ports` block is absent; `expose` has no host mapping; networks are strictly `aegis_public_share_edge` (`ipv4_address: 172.31.240.3`) and `aegis_public_share_egress` (`ipv4_address: 172.31.242.2`).
     - Test `S5.5-NETWORK-EGRESS`: Asserts top-level network `aegis_public_share_egress` has `name: aegis_public_share_egress`, `driver: bridge`, `internal: false`, subnet `172.31.242.0/29`, gateway `172.31.242.1`, `com.docker.network.bridge.name: "aegis-ps-eg"`, `com.docker.network.bridge.enable_ip_masquerade: "true"`.
     - Test `S5.5-CREDENTIAL-BOUNDS`: Asserts command specifies `--token-file /run/secrets/cloudflared-token`; asserts volume mount `/run/secrets/cloudflared-token:ro`; asserts no token literal, `TUNNEL_TOKEN`, or inline secret exists.
     - Test `S5.5-GATEWAY-DRIVE-PRESERVED`: Verifies merged model maintains Gateway and Drive topologies identical to S5.4.
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
     `test(idea1): add s5.5 runtime compose contract tests`

---

### TASK 3: Create docker-compose.s5-5.yml Minimally to Satisfy Model Tests

- **Goal:** Create `gateway/public-share/production/docker-compose.s5-5.yml` with the exact minimal structure required to pass Task 2 tests.
- **Files:**
  - Create: `gateway/public-share/production/docker-compose.s5-5.yml`
- **Interfaces:**
  - Consumes: Task 2 contract specifications.
  - Produces: Valid Compose v2 overlay file for the S5.5 connector and egress network.
- **Granular TDD Steps:**
  1. Check previous test status: Ensure Task 2 tests are failing on missing file.
  2. Create `gateway/public-share/production/docker-compose.s5-5.yml`:
     ```yaml
     # PUBLIC-SHARE-7 S5.5 Production overlay contract.
     #
     # Layers after docker-compose.production.yml, drive-s5-3.yml, and drive-gateway-s5-4.yml.
     # S5.5 introduces the isolated egress network and pinned cloudflared connector.
     # Public route, DNS, and UI activation remain strictly absent.

     services:
       public-share-connector:
         image: cloudflare/cloudflared:2026.5.2@sha256:7c9e0d1b4a6f8e2d3c5b7a9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a # placeholder replaced by Task 1 pin
         command:
           - tunnel
           - --no-autoupdate
           - --metrics
           - 127.0.0.1:20241
           - --protocol
           - http2
           - run
           - --token-file
           - /run/secrets/cloudflared-token
         user: "65532:65532"
         read_only: true
         cap_drop:
           - ALL
         security_opt:
           - no-new-privileges:true
         restart: on-failure:5
         volumes:
           - /opt/aegis/runtime/public-share/secrets/cloudflared-token:/run/secrets/cloudflared-token:ro
         networks:
           aegis_public_share_edge:
             ipv4_address: 172.31.240.3
           aegis_public_share_egress:
             ipv4_address: 172.31.242.2

     networks:
       aegis_public_share_edge:
         external: true
       aegis_public_share_egress:
         name: aegis_public_share_egress
         driver: bridge
         internal: false
         driver_opts:
           com.docker.network.bridge.name: "aegis-ps-eg"
           com.docker.network.bridge.enable_ip_masquerade: "true"
         ipam:
           config:
             - subnet: 172.31.242.0/29
               gateway: 172.31.242.1
     ```
  3. Run exact test command:
     ```bash
     cd IDEA1-AEGIS_Drive_LC
     node --test tests/publicShareS55RuntimeContract.test.js
     ```
     Expected output: ALL tests in `publicShareS55RuntimeContract.test.js` PASS.
  4. Run regression gate:
     ```bash
     cd IDEA1-AEGIS_Drive_LC
     node --test tests/publicShareS54RuntimeContract.test.js
     node --test tests/publicShareGatewayStructure.test.js
     ```
     Expected output: all S5.4 and gateway structural tests PASS.
  5. Verify clean diff:
     ```bash
     git diff --check
     ```
  6. Checkpoint commit:
     `feat(idea1): define s5.5 connector and egress compose overlay`

---

### TASK 4: Firewall Semantic / Model Tests FIRST

- **Goal:** Write unit and contract tests in `IDEA1-AEGIS_Drive_LC/tests/publicShareS55FirewallContract.test.js` to define exact iptables rule ordering, chain names, anchor points, allowlists, and negative deny rules.
- **Files:**
  - Create: `IDEA1-AEGIS_Drive_LC/tests/publicShareS55FirewallContract.test.js`
- **Interfaces:**
  - Consumes: S5.5-B design spec section 8.
  - Produces: Formal test suite for firewall script command generation, rule ordering, idempotency, and syntax validation.
- **Granular TDD Steps:**
  1. Write failing test in `IDEA1-AEGIS_Drive_LC/tests/publicShareS55FirewallContract.test.js`:
     - Test `FIREWALL-CHAIN-NAMES`: Asserts custom chain names are exactly `AEGIS-PS-EGRESS` (forwarding) and `AEGIS-PS-INPUT` (host input guard).
     - Test `FIREWALL-ANCHOR-JUMPS`: Asserts `DOCKER-USER` jumps to `AEGIS-PS-EGRESS`; `INPUT` jumps to `AEGIS-PS-INPUT`.
     - Test `FIREWALL-EGRESS-ORDER`: Asserts the exact rule sequence in `AEGIS-PS-EGRESS`:
       1. `-m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT`
       2. `-s 172.31.240.3 -d 172.31.240.2 -p tcp --dport 8080 -j ACCEPT` (connector to Gateway)
       3. Iterates over reviewed Cloudflare region1/region2 IPs: `-s 172.31.242.2 -d <cf-ip> -p tcp --dport 7844 -j ACCEPT`
       4. DNS path: default deny (or strict measured resolver IP port 53 if enabled; no 0.0.0.0/0:53)
       5. Terminal drop: `-s 172.31.240.3 -j DROP` and `-s 172.31.242.2 -j DROP` (fail closed)
     - Test `FIREWALL-INPUT-ORDER`: Asserts `AEGIS-PS-INPUT` drops any packet from source `172.31.240.3` or `172.31.242.2` targeting host listeners (port 22, 5432, 8001, Docker socket).
     - Test `FIREWALL-SUBCOMMANDS`: Asserts firewall script supports `apply`, `validate`, `remove`.
     - Test `FIREWALL-NEGATIVE-MATRIX`: Asserts rule generation denies:
       - connector -> Drive `172.31.241.3:8001`
       - connector -> upstream network `172.31.241.0/29`
       - connector -> Postgres `5432`
       - connector -> host bridge `.1`
       - connector -> UDP/7844
       - connector -> TCP/443
       - connector -> arbitrary external IP (e.g. `8.8.8.8:7844` or `1.1.1.1:80`)
  2. Run exact test command:
     ```bash
     cd IDEA1-AEGIS_Drive_LC
     node --test tests/publicShareS55FirewallContract.test.js
     ```
     Expected failure: `ENOENT: no such file or directory, open '.../s5-5-firewall.sh'`.
  3. Verify diff check:
     ```bash
     git diff --check
     ```
  4. Checkpoint commit:
     `test(idea1): add s5.5 firewall contract and negative matrix tests`

---

### TASK 5: Implement Task-Owned Firewall Tooling (s5-5-firewall.sh)

- **Goal:** Implement `gateway/public-share/production/s5-5-firewall.sh` supporting idempotent `apply`, strict `validate`, and clean `remove` without altering unrelated UFW or Docker firewall rules.
- **Files:**
  - Create: `gateway/public-share/production/s5-5-firewall.sh`
- **Interfaces:**
  - Consumes: Linux `iptables` CLI, reviewed Cloudflare IP endpoint list.
  - Produces: Executable Bash script managing only `AEGIS-PS-EGRESS` and `AEGIS-PS-INPUT`.
- **Granular TDD Steps:**
  1. Check previous test status: Confirm Task 4 tests fail on missing script.
  2. Implement `gateway/public-share/production/s5-5-firewall.sh`:
     - Header: `#!/usr/bin/env bash`, `set -euo pipefail`.
     - Define constants:
       - `CONNECTOR_EDGE_IP="172.31.240.3"`
       - `GATEWAY_EDGE_IP="172.31.240.2"`
       - `CONNECTOR_EGRESS_IP="172.31.242.2"`
       - `EGRESS_BRIDGE="aegis-ps-eg"`
       - `CF_ENDPOINTS=( "198.41.192.67" "198.41.192.77" "198.41.192.107" "198.41.192.167" "198.41.192.27" "198.41.200.13" "198.41.200.23" "198.41.200.33" "198.41.200.43" "198.41.200.53" "198.41.200.63" "198.41.200.73" "198.41.200.83" "198.41.200.93" "198.41.200.103" "198.41.200.113" )`
     - Subcommand `apply`:
       - Create chains `AEGIS-PS-EGRESS` and `AEGIS-PS-INPUT` if not present.
       - Flush chains to avoid stale/duplicate rules.
       - Insert rules in exact order:
         - `AEGIS-PS-EGRESS`:
           1. `-A AEGIS-PS-EGRESS -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT`
           2. `-A AEGIS-PS-EGRESS -s 172.31.240.3 -d 172.31.240.2 -p tcp --dport 8080 -j ACCEPT`
           3. Loop through `CF_ENDPOINTS`: `-A AEGIS-PS-EGRESS -s 172.31.242.2 -d "$ip" -p tcp --dport 7844 -j ACCEPT`
           4. `-A AEGIS-PS-EGRESS -s 172.31.240.3 -j DROP`
           5. `-A AEGIS-PS-EGRESS -s 172.31.242.2 -j DROP`
         - `AEGIS-PS-INPUT`:
           1. `-A AEGIS-PS-INPUT -s 172.31.240.3 -j DROP`
           2. `-A AEGIS-PS-INPUT -s 172.31.242.2 -j DROP`
       - Ensure anchors in calling chains:
         - If `iptables -C DOCKER-USER -j AEGIS-PS-EGRESS` fails, insert at top: `iptables -I DOCKER-USER 1 -j AEGIS-PS-EGRESS`
         - If `iptables -C INPUT -j AEGIS-PS-INPUT` fails, insert at top: `iptables -I INPUT 1 -j AEGIS-PS-INPUT`
     - Subcommand `validate`:
       - Check chains exist (`iptables -L AEGIS-PS-EGRESS -n`, `iptables -L AEGIS-PS-INPUT -n`).
       - Check jump rules exist in `DOCKER-USER` and `INPUT`.
       - Verify rule count and ordering.
       - Exit 0 if completely valid; exit 1 if missing or partial.
     - Subcommand `remove`:
       - Delete jump rules from `DOCKER-USER` and `INPUT`.
       - Flush `AEGIS-PS-EGRESS` and `AEGIS-PS-INPUT`.
       - Delete `AEGIS-PS-EGRESS` and `AEGIS-PS-INPUT` chains.
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
     `feat(idea1): implement s5.5 task-owned firewall tooling`

---

### TASK 6: Host INPUT Guard Implementation + Negative Tests

- **Goal:** Deepen validation of the host `INPUT` guard `AEGIS-PS-INPUT` to guarantee no packet from `172.31.240.3` or `172.31.242.2` can reach host administration services, Docker bridge IPs, SSH, PostgreSQL, or local resolvers without explicit authorization.
- **Files:**
  - Modify: `gateway/public-share/production/s5-5-firewall.sh`
  - Modify: `IDEA1-AEGIS_Drive_LC/tests/publicShareS55FirewallContract.test.js`
- **Interfaces:**
  - Consumes: Host interface configuration, input packet filtering rules.
  - Produces: Verified host-input protection layer with automated negative assertions.
- **Granular TDD Steps:**
  1. Add negative test cases to `IDEA1-AEGIS_Drive_LC/tests/publicShareS55FirewallContract.test.js`:
     - Assert that any packet from connector edge (`172.31.240.3`) arriving on bridge `aegis_public_share_edge` addressed to gateway IP `172.31.240.1` is dropped.
     - Assert that any packet from connector egress (`172.31.242.2`) arriving on bridge `aegis-ps-eg` addressed to host IP `172.31.242.1` or host physical IP is dropped.
     - Assert that DNS queries to host `127.0.0.1` or `172.31.242.1:53` are denied unless exact measured resolver path is explicitly approved.
  2. Run test and verify failure:
     ```bash
     cd IDEA1-AEGIS_Drive_LC
     node --test tests/publicShareS55FirewallContract.test.js
     ```
     Expected failure on any missing input guard assertion.
  3. Update `s5-5-firewall.sh` to enforce interface-level source matching (`-i aegis-ps-eg -s 172.31.242.2 -j DROP`, etc.).
  4. Run test and verify PASS:
     ```bash
     cd IDEA1-AEGIS_Drive_LC
     node --test tests/publicShareS55FirewallContract.test.js
     ```
  5. Run diff check:
     ```bash
     git diff --check
     ```
  6. Checkpoint commit:
     `feat(idea1): harden host input guard and negative firewall rules`

---

### TASK 7: Connector / Topology Pre-Start Validator

- **Goal:** Implement `gateway/public-share/production/s5-5-runtime-check.sh` with `--pre-start` mode to inspect topology, firewall validation, and secret file existence/permissions before the connector container is started.
- **Files:**
  - Create: `gateway/public-share/production/s5-5-runtime-check.sh`
  - Modify: `IDEA1-AEGIS_Drive_LC/tests/publicShareS55RuntimeContract.test.js`
- **Interfaces:**
  - Consumes: Docker network inspect, `s5-5-firewall.sh validate`, host filesystem permissions.
  - Produces: Executable pre-start gate returning 0 only when safe, non-zero on any safety violation.
- **Granular TDD Steps:**
  1. Add test cases in `IDEA1-AEGIS_Drive_LC/tests/publicShareS55RuntimeContract.test.js`:
     - Test `VALIDATOR-PRE-START-CONTRACT`: Asserts script checks:
       1. `aegis_public_share_edge` exists and contains Gateway `172.31.240.2`.
       2. `aegis_public_share_upstream` exists and contains Gateway `172.31.241.2` and Drive `172.31.241.3`.
       3. `aegis_public_share_egress` exists with subnet `172.31.242.0/29`.
       4. Runs `s5-5-firewall.sh validate` and halts if non-zero.
       5. Verifies secret token file `/opt/aegis/runtime/public-share/secrets/cloudflared-token` exists, is owned `root:65532` (or root-readable), mode `0440`, and non-empty (without echoing contents).
       6. Verifies connector is NOT attached to any forbidden network.
  2. Run test and verify failure:
     ```bash
     cd IDEA1-AEGIS_Drive_LC
     node --test tests/publicShareS55RuntimeContract.test.js
     ```
     Expected failure: missing `s5-5-runtime-check.sh`.
  3. Implement `gateway/public-share/production/s5-5-runtime-check.sh`:
     - Provide flags: `--pre-start`, `--runtime`, `--firewall-only`.
     - Implement fail-closed exit: `exit 1` on any missing check with clear human-readable error.
     - Never print secret content or token values.
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
     `feat(idea1): implement s5.5 pre-start topology and safety validator`

---

### TASK 8: systemd Firewall and Connector Lifecycle Units

- **Goal:** Create systemd units `aegis-public-share-s5-5-firewall.service` and `aegis-public-share-connector.service` to enforce persistent startup ordering, firewall reconciliation, and fail-closed shutdown on drift.
- **Files:**
  - Create: `gateway/public-share/production/systemd/aegis-public-share-s5-5-firewall.service`
  - Create: `gateway/public-share/production/systemd/aegis-public-share-connector.service`
  - Modify: `IDEA1-AEGIS_Drive_LC/tests/publicShareS55FirewallContract.test.js`
- **Interfaces:**
  - Consumes: Systemd unit semantics, `s5-5-firewall.sh`, `s5-5-runtime-check.sh`, Docker Compose CLI.
  - Produces: Declarative service definitions enforcing: Docker/UFW ready -> firewall apply -> firewall validate -> pre-start check -> connector start.
- **Granular TDD Steps:**
  1. Add unit contract tests in `IDEA1-AEGIS_Drive_LC/tests/publicShareS55FirewallContract.test.js`:
     - Assert `aegis-public-share-s5-5-firewall.service`:
       - `Type=oneshot`, `RemainAfterExit=yes`
       - `After=docker.service ufw.service`
       - `ExecStart=/opt/aegis/runtime/public-share/s5-5-firewall.sh apply`
       - `ExecStop=/opt/aegis/runtime/public-share/s5-5-firewall.sh remove`
     - Assert `aegis-public-share-connector.service`:
       - `Requires=aegis-public-share-s5-5-firewall.service`
       - `After=aegis-public-share-s5-5-firewall.service docker.service`
       - `ExecStartPre=/opt/aegis/runtime/public-share/s5-5-runtime-check.sh --pre-start`
       - `ExecStart` invokes `docker compose` up for `public-share-connector` only
       - `ExecStop` stops `public-share-connector`
       - `Restart=on-failure`, `RestartSec=5s`
       - `StartLimitBurst=5`, `StartLimitIntervalSec=60s`
  2. Run test and verify failure:
     ```bash
     cd IDEA1-AEGIS_Drive_LC
     node --test tests/publicShareS55FirewallContract.test.js
     ```
     Expected failure: missing unit files.
  3. Create `aegis-public-share-s5-5-firewall.service` and `aegis-public-share-connector.service` under `gateway/public-share/production/systemd/`.
  4. Run test and verify PASS:
     ```bash
     cd IDEA1-AEGIS_Drive_LC
     node --test tests/publicShareS55FirewallContract.test.js
     ```
  5. Run diff check:
     ```bash
     git diff --check
     ```
  6. Checkpoint commit:
     `feat(idea1): define systemd lifecycle units for s5.5 firewall and connector`

---

### TASK 9: Rollback Tooling and Independent Verification

- **Goal:** Implement and test automated rollback logic ensuring S5.5 objects can be cleanly removed while preserving S5.4 Gateway, Drive State B, database, and internal sharing.
- **Files:**
  - Create: `gateway/public-share/production/rollback-s5-5.sh`
  - Modify: `IDEA1-AEGIS_Drive_LC/tests/publicShareS55RuntimeContract.test.js`
- **Interfaces:**
  - Consumes: Docker CLI, `s5-5-firewall.sh remove`.
  - Produces: Validated, safe rollback script removing only S5.5 components in reverse order.
- **Granular TDD Steps:**
  1. Add rollback contract tests in `IDEA1-AEGIS_Drive_LC/tests/publicShareS55RuntimeContract.test.js`:
     - Assert rollback steps:
       1. Stop and disable `aegis-public-share-connector.service`.
       2. Stop and remove container `public-share-connector`.
       3. Run `s5-5-firewall.sh remove` (removes `AEGIS-PS-EGRESS` and `AEGIS-PS-INPUT`).
       4. Verify network `aegis_public_share_egress` has zero endpoints; fail if endpoints remain.
       5. Remove network `aegis_public_share_egress`.
       6. Verify `docker-compose.s5-4.yml` services (`drive`, `public-share-gateway`) are NOT stopped or removed.
       7. Forbid `docker compose down`, `prune`, or volume removal.
  2. Run test and verify failure:
     ```bash
     cd IDEA1-AEGIS_Drive_LC
     node --test tests/publicShareS55RuntimeContract.test.js
     ```
     Expected failure: missing rollback script or contract assertions.
  3. Implement `gateway/public-share/production/rollback-s5-5.sh`:
     - Implements exact step-by-step removal with strict checks.
     - Protects against accidental network removal if containers are attached.
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
     `feat(idea1): implement s5.5 connector-only rollback tooling`

---

### TASK 10: Repository Security Regression and Credential Leakage Checks

- **Goal:** Build an automated security regression test scanning all repository files and staged diffs for secret literals, unapproved ports, and protocol drift.
- **Files:**
  - Modify: `IDEA1-AEGIS_Drive_LC/tests/publicShareSecurityRegression.test.js`
- **Interfaces:**
  - Consumes: Entire `gateway/public-share/production/` tree and repository commit diffs.
  - Produces: Automated leakage detection and security invariant verification.
- **Granular TDD Steps:**
  1. Add checks to `IDEA1-AEGIS_Drive_LC/tests/publicShareSecurityRegression.test.js`:
     - Test `SECRET-LITERAL-SCAN`: Regex search across all files in `gateway/public-share/production/` and `docs/superpowers/` for JWT patterns (`eyJ[A-Za-z0-9_-]{10,}`), token placeholders used as real values, `TUNNEL_TOKEN`, `--token [A-Za-z0-9]`, and private keys.
     - Test `NO-PUBLISHED-PORTS`: Parse all YAML files in `gateway/public-share/production/` and verify no `ports:` key exists.
     - Test `NO-UDP-7844`: Scan Compose and firewall scripts to assert UDP/7844 is not permitted.
     - Test `NO-TCP-443`: Scan Compose and firewall scripts to assert TCP/443 is not permitted.
     - Test `TOKEN-FILE-ONLY`: Verify only `--token-file /run/secrets/cloudflared-token` is referenced.
  2. Run test command:
     ```bash
     cd IDEA1-AEGIS_Drive_LC
     node --test tests/publicShareSecurityRegression.test.js
     ```
     Expected output: ALL tests PASS.
  3. Run full security suite:
     ```bash
     cd IDEA1-AEGIS_Drive_LC
     npm test
     ```
  4. Run diff check:
     ```bash
     git diff --check
     ```
  5. Checkpoint commit:
     `test(idea1): enforce credential secrecy and protocol security regression gates`

---

### TASK 11: Production Runbook Update

- **Goal:** Update `gateway/public-share/production/README.md` to document the 4-file Compose layering order, secret setup procedure, firewall installation, systemd activation, and independent rollback instructions.
- **Files:**
  - Modify: `gateway/public-share/production/README.md`
- **Interfaces:**
  - Consumes: Tasks 1–10 completed artifacts and interfaces.
  - Produces: Complete, human- and agent-verifiable operational documentation.
- **Granular TDD Steps:**
  1. Write failing documentation test in `IDEA1-AEGIS_Drive_LC/tests/publicShareS55RuntimeContract.test.js`:
     - Asserts `gateway/public-share/production/README.md` documents:
       - Exact 4-file Compose order:
         1. `/opt/aegis/runtime/docker-compose.production.yml`
         2. `/opt/aegis/runtime/public-share/drive-s5-3.yml`
         3. `/opt/aegis/runtime/public-share/drive-gateway-s5-4.yml`
         4. `/opt/aegis/runtime/public-share/connector-s5-5.yml`
       - Secret storage path `/opt/aegis/runtime/public-share/secrets/cloudflared-token` with permissions `0440` and ownership `root:65532`.
       - Explicit warning that Production mutation requires separate owner authorization.
       - Exact command sequence for firewall `apply`, `validate`, `remove`.
       - Exact command sequence for S5.5 rollback.
  2. Run test and verify failure:
     ```bash
     cd IDEA1-AEGIS_Drive_LC
     node --test tests/publicShareS55RuntimeContract.test.js
     ```
     Expected failure on README assertions.
  3. Update `gateway/public-share/production/README.md` to add S5.5 operational sections.
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
     `docs(idea1): update production runbook for s5.5 connector and firewall lifecycle`

---

### TASK 12: Canonical Obsidian S5.5-C Checkpoint

- **Goal:** Reconcile canonical Obsidian vault notes (`idea1-status.md`, `idea1-public-share-architecture.md`, `idea1-moc.md`) to record the completion of the S5.5-C implementation plan, affirm zero Production mutation, and maintain G5 as OPEN.
- **Files:**
  - Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md`
  - Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-public-share-architecture.md`
  - Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-moc.md`
- **Interfaces:**
  - Consumes: Completed plan specification.
  - Produces: Updated canonical vault state adhering to ownership and collaboration rules.
- **Granular Steps:**
  1. Update `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md`:
     - Record S5.5-C state as `IN PROGRESS (PLAN COMPLETE)`.
     - Update S5.5 Session Register to mark S5.5-C plan closed/pass, awaiting implementation approval.
     - Reaffirm that `docker-compose.s5-4.yml` is untouched.
     - Reaffirm that no Production mutation occurred.
     - Reaffirm G5 remains OPEN, Public Share UI remains OFF, public DNS is unconfigured, and Internet exposure is NONE.
  2. Update `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-public-share-architecture.md` and `idea1-moc.md` to link to the new plan file.
  3. Run vault validation:
     ```bash
     node scripts/validate-vault.mjs
     ```
     Expected output: `Vault validation passed with 2 warning(s)` (pre-existing canvas warnings).
  4. Run collaboration policy suite:
     ```bash
     node --test tests/collaborationPolicy.test.mjs
     ```
     Expected output: 24 tests passed, 0 failed.
  5. Run diff check:
     ```bash
     git diff --check
     ```
  6. Checkpoint commit:
     `docs(idea1): update canonical obsidian notes for s5.5 implementation plan`

---

## Verification Plan

### Automated Test Gates

Execute from repository root:

```bash
# 1. Vault integrity and link validation
node scripts/validate-vault.mjs

# 2. Collaboration policy and PR governance
node --test tests/collaborationPolicy.test.mjs

# 3. S5.4 baseline regression (overlay immutability)
cd IDEA1-AEGIS_Drive_LC
node --test tests/publicShareS54RuntimeContract.test.js

# 4. S5.5 runtime contract tests
node --test tests/publicShareS55RuntimeContract.test.js

# 5. S5.5 firewall and systemd contract tests
node --test tests/publicShareS55FirewallContract.test.js

# 6. Public share security regression matrix
node --test tests/publicShareSecurityRegression.test.js

# 7. Gateway structural tests
node --test tests/publicShareGatewayStructure.test.js

# 8. Full IDEA1 test suite and build
npm test
npm run build
```

### Manual / Structural Inspection Gates

1. Verify `git diff origin/main...HEAD -- gateway/public-share/production/docker-compose.s5-4.yml` produces no diff.
2. Verify no file contains token-like strings (`grep -rn "eyJ" gateway/ docs/`).
3. Verify no task executes any remote Docker, SSH, or Cloudflare commands during S5.5-C.
4. Verify Draft PR #118 is updated with honest progress report.
