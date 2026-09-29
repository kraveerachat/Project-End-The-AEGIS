# AEGIS VLAN30 Direct-LAN DNS Access Contract — Design

## Status
RECONCILED ARCHITECTURE SPECIFICATION — PENDING HUMAN OWNER REVIEW & EXECUTION.
Reconciled against merged live evidence from PR #259 and PR #216.
No router, switch, DNS, DHCP, Twingate, Docker, or application source change authorized until Human Owner execution of the implementation plan.

---

## 1. Purpose

Define the architecture contract for direct on-site LAN access to AEGIS services from VLAN 30 (Management Zone) without requiring Twingate ZTNA, external routing, or client-side `hosts` file workarounds.

During on-site acceptance testing on 2026-09-29 (PR #216 U2/D1), direct Layer 3 routing and TCP port 443 reachability to the AEGIS HUB at `192.168.10.10` were verified from VLAN 30. However, central domain name resolution for `aegis.internal` on the local LAN was absent. A manual client-side `hosts` entry (`192.168.10.10 aegis.internal`) was required to enable browser and HTTPS access.

This specification formalizes:
1. The separation between Remote (Twingate ZTNA) and Direct (on-site VLAN 30) access paths.
2. The switch access port / PVID 30 configuration contract.
3. The DHCP server lease contract (IP, gateway, subnet mask, DNS resolver).
4. The central LAN DNS resolution contract for `aegis.internal` pointing to `192.168.10.10`.
5. The strict trust boundary separating network connectivity/resolution from client TLS Root CA trust.

---

## 2. Historical & Current Evidence

### 2.1 On-site Direct-LAN Test (2026-09-29, PR #216 U2/D1)
During on-site validation of IDEA2 Monitor direct live stream (PR #216):
- **Test Client OS:** Windows 11.
- **Physical Connection:** Connected to switch access port assigned to VLAN 30.
- **Client IP Configuration (DHCP):**
  - IPv4 Address: `192.168.30.10`
  - Subnet Mask: `255.255.255.0` (`/24`)
  - Default Gateway: `192.168.30.1` (MikroTik RB750r2)
- **Twingate Client Status:** DISCONNECTED (explicitly verified off to test direct LAN path).
- **Direct Transport Layer Reachability:**
  ```powershell
  Test-NetConnection 192.168.10.10 -Port 443
  # Result: TcpTestSucceeded=True, SourceAddress=192.168.30.10
  ```
- **Direct HTTPS Service Reachability:**
  ```bash
  curl -k https://192.168.10.10/healthz
  # Result: HTTP/1.1 200 OK
  # Body: {"service":"aegis-entry","ok":true,"role":"routing-only"}
  ```
- **LAN DNS Resolution Before Workaround:**
  ```powershell
  Resolve-DnsName aegis.internal
  # Result: Resolve-DnsName : aegis.internal : DNS name does not exist
  ping aegis.internal
  # Result: Ping request could not find host aegis.internal.
  ```
- **Temporary Workaround Applied:**
  Local `hosts` file entry added on test client:
  ```text
  192.168.10.10    aegis.internal
  ```
- **HTTPS & Ping Verification After Workaround:**
  ```powershell
  ping aegis.internal
  # Result: Reply from 192.168.10.10: bytes=32 time<1ms TTL=63
  curl -k https://aegis.internal/healthz
  # Result: HTTP/1.1 200 OK
  # Body: {"service":"aegis-entry","ok":true,"role":"routing-only"}
  ```

### 2.2 Historical Baseline
- **PR #15 / PR #17 / PR #18:** Established edge gateway TLS with `aegis.internal` SAN and X1 Windows onboarding automation for Remote Twingate access.
- **PR #83:** Documented VLAN 30 on-site client `192.168.30.99` IP ping reachability to `192.168.10.10` (`4/4, 0% loss`).
- **PR #216 (MERGED at `1ea2efbf`):** Proved that while IP routing works, name resolution (`aegis.internal`) on VLAN 30 does not function out-of-the-box without client `hosts` edits.
- **PR #259 (MERGED at `92d47967`):** Authoritative live network truth established: RB750r2 router identity, link rates, DHCP pools, DNS relay setting (`allow-remote-requests=yes`), and switch port mappings verified onsite.

---

## 3. Current Topology (Reconciled with Merged PR #259 & PR #216)

```text
+---------------------------------------------------------------------------------------------+
|               CURRENT AUTHORITATIVE LIVE TOPOLOGY (DISCOVERED GAP)                         |
|                                                                                             |
|  [VLAN 30 Windows Client] (Physical 1 Gbps Link)                                            |
|       |                                                                                     |
|       | (Untagged switch port, Port 5 = Access VLAN 30, PVID 30, 1000MF)                   |
|       v                                                                                     |
|  [TP-Link TL-SG105E Switch] (Port 1 = Trunk 100MF, Port 2 = VLAN 10 1000MF)                |
|       | (802.1Q Trunk on ether2, 100 Mbps Full Duplex)                                      |
|       v                                                                                     |
|  [MikroTik hEX lite RB750r2 Router]                                                         |
|       |                                                                                     |
|       +--> DHCP Server `dhcp3` on `VLAN30-Mgmt`:                                            |
|       |      - IP Pool: `dhcp_pool3` (192.168.30.10 - 192.168.30.99)                       |
|       |      - Gateway (Option 3): 192.168.30.1 (ALREADY CONFIGURED)                        |
|       |      - DNS Server (Option 6): 192.168.30.1 (ALREADY CONFIGURED)                     |
|       |      - Lease Time: 30m                                                              |
|       |                                                                                     |
|       +--> Router DNS Relay (`allow-remote-requests=yes`):                                  |
|       |      - Upstream: 8.8.8.8 + Dynamic WAN DNS                                          |
|       |      - Static DNS: router.lan -> 192.168.88.1                                       |
|       |      - Static DNS: aegis.internal -> ABSENT (DISCOVERED GAP)                        |
|       |                                                                                     |
|       +--> Inter-VLAN Forwarding: 192.168.30.x -> 192.168.10.10:443 (TCP ALLOW / PASS)     |
|       |                                                                                     |
|       v                                                                                     |
|  [Local DNS Query for aegis.internal] -> NXDOMAIN / DOES NOT EXIST                          |
|                                                                                             |
|  * TEMPORARY WORKAROUND ACTIVE: Client C:\Windows\System32\drivers\etc\hosts                |
|    "192.168.10.10 aegis.internal" (PRESERVED until central DNS is applied)                 |
+---------------------------------------------------------------------------------------------+
```

---

## 4. Target Direct-LAN Topology

```text
Managed Switch Access Port / PVID 30
        ↓
VLAN30 Client (e.g. 192.168.30.10)
        ↓
DHCP (MikroTik RB750r2)
  IP      = 192.168.30.x/24
  Gateway = 192.168.30.1
  DNS     = 192.168.30.1 (or Designated Internal DNS Server)
        ↓
Central DNS (MikroTik Static DNS / Internal DNS Resolver)
  aegis.internal → 192.168.10.10
        ↓
Inter-VLAN Routing / Firewall Filter
  192.168.30.0/24 -> 192.168.10.10:443 (TCP ALLOW)
        ↓
192.168.10.10:443 (Beelink Host / Gateway NGINX)
        ↓
AEGIS HUB
        ↓
Drive (172.18.0.5) / Monitor (172.18.0.4)
```

Target end-to-end pipeline:
```text
Client → Access VLAN30 → DHCP/Gateway/DNS → aegis.internal → 192.168.10.10:443 → HUB → Drive / Monitor
```

---

## 5. Remote vs. Direct Path Separation

Direct-LAN and Remote ZTNA access are completely independent network pathways. They must not be conflated in design, configuration, or operational troubleshooting.

| Architectural Dimension | Direct-LAN Path (On-Site) | Remote ZTNA Path (Off-Site / Untrusted) |
| :--- | :--- | :--- |
| **Physical Location** | On-site wired connection to AEGIS switch | Anywhere with Internet connectivity |
| **Network Layer** | Layer 2 switch access port (VLAN 30) | Layer 3/Virtual overlay (Twingate virtual TAP/TUN) |
| **Ingress Point** | Switch physical port (PVID 30) | Twingate Relay via outbound-only Connector |
| **IP Assignment** | Local DHCP: `192.168.30.x/24` | Local physical network IP + Twingate virtual adapter |
| **Gateway** | `192.168.30.1` (MikroTik) | Local network gateway + Twingate encrypted tunnel |
| **DNS Resolution** | Central LAN DNS resolver on router / internal DNS | Twingate client internal DNS interceptor |
| **Access Control** | Physical port access + Inter-VLAN firewall rules | Twingate IDP authentication + Resource/Group policy |
| **Application Reach** | `192.168.10.10:443` (HUB Gateway) | `AEGIS-Beelink-Web` (`192.168.10.10:80,443`) |
| **Host File Editing** | **Strictly prohibited** in target state | Not required |
| **Root CA Trust** | **Required** in client trust store for trusted TLS | **Required** in client trust store for trusted TLS |

---

## 6. Switch Access VLAN 30 / PVID Contract

1. **Authoritative Live Switch State (PR #259 Step 1/3 Verified):**
   - Switch hardware: TP-Link TL-SG105E.
   - Port 1: 802.1Q Trunk to MikroTik `ether2`, Link speed `100MF`.
   - Port 2: Access VLAN 10 (Beelink Server), PVID 10, Link speed `1000MF`.
   - Port 4: Access VLAN 40 (IDEA3), PVID 40.
   - Port 5: Access VLAN 30 (Management / Test Client), PVID 30, Link speed `1000MF`.
   - Switch port configuration is ALREADY complete and operating correctly.
2. **Switch Change Requirement Evaluation:**
   - `NEW_SWITCH_CHANGE_REQUIRED=NO` (`NO_CHANGE_REQUIRED`).
   - No port reassignment, VLAN membership modification, or PVID adjustment is required on the switch.
3. **Frame Handling:**
   - Ingress untagged frames received from the client workstation on Port 5 are tagged with VLAN 30 VID internally by the switch.
   - Egress frames destined for the client workstation on Port 5 are stripped of 802.1Q tags before delivery.
4. **Client Configuration:**
   - Zero client-side 802.1Q tagging configuration required. Standard untagged NIC settings (automatic).

---

## 7. DHCP Contract

1. **Authoritative Live DHCP State (PR #259 Step 3 Verified):**
   - DHCP Server Host: MikroTik hEX lite RB750r2 (`dhcp3` on interface `VLAN30-Mgmt`).
   - Subnet Scope: `192.168.30.0/24`.
   - IP Pool: `dhcp_pool3` = `192.168.30.10` - `192.168.30.99`.
   - Lease Time: `30m` (live RouterOS configuration).
   - DHCP Options on Network `192.168.30.0/24`:
     - Subnet Mask: `/24` (`255.255.255.0`)
     - Default Gateway (Option 3): `192.168.30.1` (ALREADY CONFIGURED)
     - Domain Name Server (Option 6): `192.168.30.1` (ALREADY CONFIGURED)
2. **DHCP Change Requirement Evaluation:**
   - `VLAN30_DHCP_DNS_POINTS_TO_ROUTER=YES`.
   - `NEW_DHCP_CHANGE_REQUIRED=NO` (`NO_CHANGE_REQUIRED`).
   - Live DHCP server already hands out `192.168.30.1` as the primary DNS resolver to all VLAN 30 clients. No pool expansion, option modification, or lease-time adjustment is needed.

---

## 8. Central DNS Contract

1. **Authoritative Target Record:**
   - Domain Name: `aegis.internal`
   - Record Type: `A`
   - Target IPv4 Address: `192.168.10.10`
   - TTL: `300s` (`5m`)
   - Comment: `AEGIS HUB Direct-LAN entry`
2. **Live Router DNS State (PR #259 Step 3 Verified):**
   - DNS Relay Setting: `allow-remote-requests=yes` (ALREADY ACTIVE on MikroTik).
   - Upstream Forwarders: Static `8.8.8.8` plus dynamic WAN DNS servers (`peer-dns=yes` on `ether1`).
   - Existing Static Records: `router.lan -> 192.168.88.1`.
   - Current Status for `aegis.internal`: ABSENT (`AEGIS_INTERNAL_CURRENT_STATE=ABSENT`).
3. **Firewall & Routing Reachability Evaluation:**
   - Router Interface Lists: `LAN = bridge, VLAN30-Mgmt, VLAN10-Server`. `VLAN30-Mgmt` is an authoritative member of the `LAN` list.
   - Input Filter: Allows DNS requests from `LAN` interfaces; default input drop rule `defconf input drop !LAN` is currently disabled.
   - Port 53 Access:
     - `VLAN30_CAN_QUERY_ROUTER_DNS_UDP53=YES`
     - `VLAN30_CAN_QUERY_ROUTER_DNS_TCP53=YES`
   - Forward Filter: LAN-to-LAN accept rule is ordered above drop rules; TCP 443 reachability from VLAN 30 to `192.168.10.10` is proven live (`TcpTestSucceeded=True`).
   - Firewall Change Requirement: `NEW_FIREWALL_CHANGE_REQUIRED=NO` (`NO_CHANGE_REQUIRED`).
4. **Minimum Proposed Production Mutation:**
   - The ONLY required Production mutation to achieve central name resolution across VLAN 30 is:
     ```routeros
     /ip dns static add name=aegis.internal address=192.168.10.10 ttl=5m comment="AEGIS HUB Direct-LAN entry"
     ```
   - Execution authorization: `HUMAN_OWNER_ACTION_REQUIRED=YES`. Agents must not apply this change directly.
5. **Temporary Workaround Elimination Sequence:**
   - The Windows client temporary `hosts` entry (`192.168.10.10 aegis.internal`) remains PRESERVED during design reconciliation (`HOSTS_WORKAROUND_PRESERVED_FOR_NOW=YES`).
   - It will only be removed during Step 5 of the implementation plan after the static record is verified active on the router.

---

## 9. TLS Root CA Trust Boundary

### Explicit Trust Claim
`ARBITRARY_UNMANAGED_WINDOWS_ZERO_SETUP=NOT_CLAIMED`

1. **Network vs. Cryptographic Trust Separation:**
   - The Direct-LAN DNS contract guarantees **Network Zero-Touch**: a clean client plugging into an access port automatically receives an IP, default route, and working resolution for `https://aegis.internal/`.
   - The Direct-LAN DNS contract does **NOT** guarantee cryptographic trust on arbitrary, unmanaged client machines.
2. **Client Root CA Requirement:**
   - AEGIS uses a private internal Public Key Infrastructure (PKI). The edge gateway certificate for `aegis.internal` is signed by the **AEGIS Internal Root CA**.
   - Browsers and operating systems do not inherently trust private Root CAs.
   - For a browser to access `https://aegis.internal/` without a certificate warning (`SEC_ERROR_UNKNOWN_ISSUER` or `NET::ERR_CERT_AUTHORITY_INVALID`), the public AEGIS Root CA certificate must be imported into the operating system trust store (e.g., Windows `Cert:\LocalMachine\Root`).
3. **Onboarding Integration:**
   - Managed clients receive this trust anchor via the X1 endpoint onboarding package (`scripts/endpoint-onboarding/AEGIS-Client-Setup.ps1`), group policy, or MDM/Intune.
   - Unmanaged guest or technician machines connecting directly to VLAN 30 will resolve `aegis.internal` and establish a TLS connection, but will observe the standard private CA certificate warning unless the public Root CA certificate is installed.
   - Under no circumstances will AEGIS disable TLS, emit plain HTTP credentials, or bypass certificate validation on the server side.

---

## 10. Security & Trust-Boundary Implications

1. **Physical Port Security:**
   - Since VLAN 30 has direct routing to the server management IP (`192.168.10.10:443` and `:22`), access to physical switch ports tagged/PVID'd to VLAN 30 (Port 5) must be physically restricted to authorized administrative personnel.
2. **Inter-VLAN Firewall Rules:**
   - The MikroTik router firewall forward chain enforces that LAN-to-LAN accept rules precede drop rules.
   - Forwarding from VLAN 30 to VLAN 10 (TCP 443 HTTPS, TCP 22 SSH) is active and verified.
3. **DNS Service Hardening & Interface Lists:**
   - RouterOS DNS Relay (`allow-remote-requests=yes`) listens on router IP addresses.
   - Interface Lists: `WAN = ether1`, `LAN = bridge, VLAN30-Mgmt, VLAN10-Server`.
   - `VLAN30-Mgmt` is an authoritative member of `LAN`.
   - Management service exposure and `defconf input drop !LAN` disabled state are flagged as pre-existing findings for separate follow-up (`SECURITY_HARDENING_FOLLOWUP_REQUIRED=YES`). They are NOT modified during PR #257 DNS implementation to maintain strict operational equivalence.
4. **Independent Identity & Authentication:**
   - Reaching `https://aegis.internal/` via Direct-LAN does NOT grant access to application data.
   - All AEGIS applications (HUB, Drive, Monitor) require independent authentication and enforce role-based access control (RBAC).

---

## 11. Failure Modes & Mitigations

| Failure Mode | Root Cause | Observable Symptom | Mitigation / Triage |
| :--- | :--- | :--- | :--- |
| **FM-1: DNS Resolution Fails (NXDOMAIN)** | Static DNS entry missing on router or client querying external DNS directly | `Resolve-DnsName aegis.internal` fails; browser shows `DNS_PROBE_FINISHED_NXDOMAIN` | Verify DHCP Option 6 points to router IP (`192.168.30.1`); verify `/ip dns static` entry exists on MikroTik. |
| **FM-2: Upstream DNS Failure** | Router DNS forwarders unreachable or `allow-remote-requests` disabled | `aegis.internal` resolves, but external internet names fail on client | Verify upstream DNS servers (`8.8.8.8`, WAN dynamic) in router DNS settings; check router WAN connectivity. |
| **FM-3: TCP 443 Connection Timeout** | Inter-VLAN firewall rule missing or disabled on MikroTik | DNS resolves to `192.168.10.10`, but `Test-NetConnection -Port 443` fails | Inspect MikroTik `/ip firewall filter` forward chain; ensure accept rule for VLAN 30 to VLAN 10 exists. |
| **FM-4: TLS Untrusted Root Warning** | AEGIS Root CA not installed in client `LocalMachine\Root` | Browser displays `NET::ERR_CERT_AUTHORITY_INVALID` | Expected on unmanaged endpoints (`ARBITRARY_UNMANAGED_WINDOWS_ZERO_SETUP=NOT_CLAIMED`). Run X1 onboarding script or manually import public `aegis-root-ca.crt`. |
| **FM-5: Stale Client Hosts Override** | Old manual `hosts` entry pointing to stale IP | Traffic routes to wrong IP if server IP changes | Audit `C:\Windows\System32\drivers\etc\hosts`; verify it is empty of `aegis.internal` entries after central DNS is active. |

---

## 12. Rollback Plan

Since the proposed implementation is strictly a single static DNS record on MikroTik, rollback is isolated, immediate, and zero-risk:
1. **Router Static DNS Rollback:**
   ```routeros
   /ip dns static remove [find name="aegis.internal"]
   ```
2. **Workaround Restoration (If Needed for Emergency Access):**
   - If central DNS is rolled back, re-add the temporary `hosts` file entry on administrative test machines:
     `192.168.10.10 aegis.internal`
3. **Zero-Blast Radius & Restrictions:**
   - Do NOT reset router.
   - Do NOT restore full binary `.backup` file unless catastrophic recovery is independently authorized.
   - Do NOT modify switch or DHCP server settings.
   - Production Docker containers, database, edge gateway, and Twingate remain completely untouched.

---

## 13. Verification Plan

When the implementation gate opens, verification on a clean Windows client connected to VLAN 30 must follow this sequence:

### Step 1: Pre-requisite Audit
1. Confirm Twingate client is disconnected or stopped.
2. Inspect `C:\Windows\System32\drivers\etc\hosts` to ensure the backup exists before editing.

### Step 2: DHCP Lease Verification
```powershell
ipconfig /renew
ipconfig /all
```
- Verify IPv4 is in `192.168.30.0/24`.
- Verify Default Gateway is `192.168.30.1`.
- Verify DNS Server is `192.168.30.1`.

### Step 3: DNS Name Resolution
```powershell
Resolve-DnsName aegis.internal
```
- Verify returned IP address is strictly `192.168.10.10`.
- Verify query status is `Success` without fallback.

### Step 4: Transport Layer Connectivity
```powershell
Test-NetConnection aegis.internal -Port 443
```
- Verify `TcpTestSucceeded=True`.

### Step 5: HTTPS Application Reachability
```powershell
curl.exe -I https://aegis.internal/healthz
```
- On a managed client with AEGIS Root CA installed: HTTP 200 OK, zero certificate warnings.
- On an unmanaged client: HTTP 200 OK with `--ssl-revoke-best-effort` or browser prompt confirming expected private CA warning (no network error).

---

## 14. Implementation Gate & Execution Boundaries

- **CURRENT STATUS:** DESIGN + IMPLEMENTATION PLAN RECONCILIATION COMPLETE.
- **AUTHORIZATION LEVEL:** REQUIRES HUMAN OWNER (KLA) REVIEW AND EXPLICIT EXECUTION.
- **RESTRICTIONS:**
  - Agent must NOT execute Production router mutations (`HUMAN_OWNER_ACTION_REQUIRED=YES`).
  - Production router changes are restricted to the single authorized static DNS command.
  - Switch, DHCP, firewall, Docker, and application source code MUST NOT be modified (`PRODUCTION_MUTATED=NO`, `NETWORK_CONFIGURATION_CHANGED=NO`, `APPLICATION_SOURCE_CHANGED=NO`).
- **IMPLEMENTATION PLAN:** Detailed 9-step execution runbook is maintained at:
  `docs/superpowers/plans/2026-09-30-aegis-vlan30-direct-lan-dns-implementation.md`.

---

## 15. Related PR & Repository History

| PR / Artifact | Title / Description | Relevance to Direct-LAN DNS |
| :--- | :--- | :--- |
| **PR #15** | Edge Gateway NGINX Reverse Proxy & TLS Configuration | Established edge gateway on Beelink, reverse proxy routing, and TLS certificate with `aegis.internal` SAN. |
| **PR #17** | X1 AEGIS Endpoint Onboarding Automation | Implemented Windows onboarding package (`AEGIS-Client-Setup.ps1`), Root CA trust installation, and Twingate deployment. |
| **PR #18** | docs(superpowers): reconcile X1 endpoint onboarding spec and Windows acceptance | Reconciled X1 specification with live Windows acceptance results and private PKI boundaries. |
| **PR #83** | docs(infrastructure): record production network verification and VLAN 30 access | Recorded initial VLAN 30 physical on-site testing (`192.168.30.99` reaching `192.168.10.10` via IP). |
| **PR #216** | docs(idea1): establish transfer and media performance study (MERGED @ `1ea2efbf`) | Discovered the missing LAN DNS gap: VLAN 30 routing works to `192.168.10.10:443`, but `aegis.internal` resolution failed without a temporary `hosts` file entry. |
| **PR #259** | docs(infrastructure): document inter-VLAN capacity boundary and optional remediation (MERGED @ `92d47967`) | Authoritative live network truth established: RB750r2 router identity, link rates, DHCP pools, DNS relay setting (`allow-remote-requests=yes`), and switch port mappings verified onsite. |
| **THIS PR (#257)** | docs(infrastructure): define VLAN30 direct-LAN DNS access contract | Defines formal architecture contract for central LAN DNS, DHCP, switch access port, and trust boundaries on VLAN 30. |
