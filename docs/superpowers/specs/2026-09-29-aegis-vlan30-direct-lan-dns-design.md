# AEGIS VLAN30 Direct-LAN DNS Access Contract — Design

## Status
DRAFT ARCHITECTURE SPECIFICATION — PENDING HUMAN OWNER REVIEW.
No router, switch, DNS, DHCP, Twingate, Docker, or application source change authorized until review and approval.

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
- **PR #216:** Discovered and proved that while IP routing works, name resolution (`aegis.internal`) on VLAN 30 does not function out-of-the-box without client `hosts` edits.

---

## 3. Current Topology

```text
+-------------------------------------------------------------------------+
|                        CURRENT TOPOLOGY (DISCOVERED GAP)                |
|                                                                         |
|  [VLAN 30 Windows Client]                                               |
|       |                                                                 |
|       | (Untagged switch port, PVID 30)                                 |
|       v                                                                 |
|  [TP-Link TL-SG105E Switch]                                             |
|       | (802.1Q Trunk)                                                  |
|       v                                                                 |
|  [MikroTik RB750r2 Router]                                              |
|       |                                                                 |
|       +--> DHCP Server: Hands out IP=192.168.30.x, GW=192.168.30.1     |
|       |                 DNS=Upstream/External or missing local record   |
|       |                                                                 |
|       +--> Inter-VLAN Routing: 192.168.30.x -> 192.168.10.10:443 (PASS) |
|       |                                                                 |
|       v                                                                 |
|  [Local DNS Query for aegis.internal] -> NXDOMAIN / DOES NOT EXIST      |
|                                                                         |
|  * WORKAROUND REQUIRED: Client C:\Windows\System32\drivers\etc\hosts    |
|    "192.168.10.10 aegis.internal"                                      |
+-------------------------------------------------------------------------+
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

1. **Physical Port Assignment:**
   - Dedicated access ports on the managed switch (TP-Link TL-SG105E) are assigned to VLAN 30.
   - Example baseline: Port 5 configured as Access / Untagged member of VLAN 30 with PVID 30.
2. **Frame Handling:**
   - Ingress untagged frames received from the client workstation are tagged with VLAN 30 VID internally by the switch.
   - Egress frames destined for the client workstation are stripped of 802.1Q tags before delivery.
3. **Client Configuration:**
   - Zero client-side 802.1Q tagging configuration required. Standard standard NIC settings (untagged/default).

---

## 7. DHCP Contract

1. **DHCP Server Host:** MikroTik RB750r2 (interface `vlan30`).
2. **Subnet Scope:** `192.168.30.0/24`.
3. **IP Pool Range:** Dynamic allocation pool (e.g. `192.168.30.10` - `192.168.30.50`), with reservations allowed for known management devices.
4. **DHCP Options:**
   - Subnet Mask (Option 1): `255.255.255.0`
   - Default Router / Gateway (Option 3): `192.168.30.1`
   - Domain Name Server (Option 6): Points to internal LAN resolver (e.g., `192.168.30.1` if MikroTik acts as DNS cache/forwarder, or dedicated internal DNS IP).
   - Domain Search List / Domain Name (Option 15): `internal` (optional, for unqualified lookups).
5. **Lease Time:** Standard 8 to 24 hours.

---

## 8. Central DNS Contract

1. **Authoritative Record:**
   - Domain Name: `aegis.internal`
   - Record Type: `A`
   - Target IPv4 Address: `192.168.10.10`
   - TTL: 300 seconds (short TTL during active operations/testing, 3600 seconds standard).
2. **Resolver Behavior:**
   - When a VLAN 30 client queries the DHCP-provided DNS server for `aegis.internal`, the resolver must return `192.168.10.10` directly without forwarding upstream.
   - For all other non-AEGIS domain queries, the resolver forwards recursively to approved upstream DNS servers (e.g. Cloudflare `1.1.1.1`, Google `8.8.8.8`).
3. **Location of Central Record:**
   - MikroTik RB750r2 Static DNS (`/ip dns static add name="aegis.internal" address=192.168.10.10 ttl=5m`).
   - Router DNS settings must have `allow-remote-requests=yes` enabled for VLAN 30 interface, protected by firewall input filters restricting DNS access to internal subnets only (preventing WAN DNS amplification).
4. **Workaround Elimination:**
   - Once central DNS is active, all client-side `hosts` entries (`192.168.10.10 aegis.internal`) MUST be removed.

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
   - Since VLAN 30 has direct routing to the server management IP (`192.168.10.10:443` and `:22`), access to physical switch ports tagged/PVID'd to VLAN 30 must be physically restricted to authorized administrative personnel.
2. **Inter-VLAN Firewall Rules:**
   - The MikroTik router firewall must enforce strict forwarding boundaries:
     - VLAN 30 -> VLAN 10: Allow TCP 443 (HTTPS Web), TCP 22 (SSH).
     - Drop all unauthorized inter-VLAN forwarding from other untrusted VLANs.
3. **DNS Service Hardening:**
   - If MikroTik RB750r2 acts as the DNS resolver (`allow-remote-requests=yes`):
     - Firewall input filter MUST block UDP/TCP port 53 on the WAN interface (`ether1`).
     - Port 53 must be accessible ONLY from authorized internal VLANs (VLAN 10, VLAN 20, VLAN 30).
4. **Independent Identity & Authentication:**
   - Reaching `https://aegis.internal/` via Direct-LAN does NOT grant access to application data.
   - All AEGIS applications (HUB, Drive, Monitor) require independent authentication and enforce role-based access control (RBAC).

---

## 11. Failure Modes & Mitigations

| Failure Mode | Root Cause | Observable Symptom | Mitigation / Triage |
| :--- | :--- | :--- | :--- |
| **FM-1: DNS Resolution Fails (NXDOMAIN)** | Static DNS entry missing on router or client querying external DNS directly | `Resolve-DnsName aegis.internal` fails; browser shows `DNS_PROBE_FINISHED_NXDOMAIN` | Verify DHCP Option 6 points to router IP; verify `/ip dns static` entry exists on MikroTik. |
| **FM-2: Upstream DNS Failure** | Router DNS forwarders unreachable or `allow-remote-requests` disabled | `aegis.internal` resolves, but external internet names fail on client | Verify upstream DNS servers (`1.1.1.1`, `8.8.8.8`) in router DNS settings; check router WAN connectivity. |
| **FM-3: TCP 443 Connection Timeout** | Inter-VLAN firewall rule missing or disabled on MikroTik | DNS resolves to `192.168.10.10`, but `Test-NetConnection -Port 443` fails | Inspect MikroTik `/ip firewall filter` forward chain; ensure accept rule for VLAN 30 to VLAN 10 exists. |
| **FM-4: TLS Untrusted Root Warning** | AEGIS Root CA not installed in client `LocalMachine\Root` | Browser displays `NET::ERR_CERT_AUTHORITY_INVALID` | Expected on unmanaged endpoints. Run X1 onboarding script or manually import public `aegis-root-ca.crt`. |
| **FM-5: Stale Client Hosts Override** | Old manual `hosts` entry pointing to stale IP | Traffic routes to wrong IP if server IP changes | Audit `C:\Windows\System32\drivers\etc\hosts`; verify it is empty of `aegis.internal` entries. |

---

## 12. Rollback Plan

If router or switch configuration changes cause network instability or regressions:
1. **Router DNS Rollback:**
   - Remove the static DNS entry: `/ip dns static remove [find name="aegis.internal"]`.
   - If `allow-remote-requests` was changed, revert to prior state.
2. **DHCP Option Rollback:**
   - Revert DHCP network DNS server settings on VLAN 30 to previous upstream resolver IP (e.g. `1.1.1.1`).
3. **Switch Port Rollback:**
   - Revert port PVID / VLAN membership on TP-Link TL-SG105E via web management interface or management utility.
4. **Zero-Blast Radius:**
   - Production Docker containers, PostgreSQL, persistent volumes, and Twingate Connector remain completely unaffected by router/switch DNS adjustments.

---

## 13. Verification Plan

When the implementation gate opens, verification on a clean Windows client connected to VLAN 30 must follow this sequence:

### Step 1: Pre-requisite Audit
1. Confirm Twingate client is disconnected or stopped.
2. Inspect `C:\Windows\System32\drivers\etc\hosts` to ensure NO entry for `aegis.internal` exists.

### Step 2: DHCP Lease Verification
```powershell
ipconfig /renew
ipconfig /all
```
- Verify IPv4 is in `192.168.30.0/24`.
- Verify Default Gateway is `192.168.30.1`.
- Verify DNS Server includes `192.168.30.1` (or designated internal DNS IP).

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

## 14. Implementation Gate

- **CURRENT STATUS:** SPECIFICATION ONLY.
- **AUTHORIZATION LEVEL:** REQUIRES HUMAN OWNER (KLA) REVIEW AND EXPLICIT APPROVAL.
- **RESTRICTIONS:**
  - DO NOT run router commands against MikroTik RB750r2.
  - DO NOT modify TP-Link switch VLAN configurations.
  - DO NOT modify DNS or DHCP services.
  - DO NOT touch production Beelink host runtime, Docker containers, or applications.
- **PR STATUS:** This specification will be submitted as an open Draft Pull Request (`area: infrastructure`, `owner: kla`, `integration-review: yes`).

---

## 15. Related PR & Repository History

| PR / Artifact | Title / Description | Relevance to Direct-LAN DNS |
| :--- | :--- | :--- |
| **PR #15** | Edge Gateway NGINX Reverse Proxy & TLS Configuration | Established edge gateway on Beelink, reverse proxy routing, and TLS certificate with `aegis.internal` SAN. |
| **PR #17** | X1 AEGIS Endpoint Onboarding Automation | Implemented Windows onboarding package (`AEGIS-Client-Setup.ps1`), Root CA trust installation, and Twingate deployment. |
| **PR #18** | docs(superpowers): reconcile X1 endpoint onboarding spec and Windows acceptance | Reconciled X1 specification with live Windows acceptance results and private PKI boundaries. |
| **PR #83** | docs(infrastructure): record production network verification and VLAN 30 access | Recorded initial VLAN 30 physical on-site testing (`192.168.30.99` reaching `192.168.10.10` via IP). |
| **PR #216** | test(idea2): on-site direct-LAN U2/D1 acceptance verification | Discovered the missing LAN DNS gap: VLAN 30 routing works to `192.168.10.10:443`, but `aegis.internal` resolution failed without a temporary `hosts` file entry. |
| **THIS PR** | docs(infrastructure): define VLAN30 direct-LAN DNS access contract | Defines formal architecture contract for central LAN DNS, DHCP, switch access port, and trust boundaries on VLAN 30. |
