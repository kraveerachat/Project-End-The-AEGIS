# AEGIS VLAN30 Direct-LAN Central DNS Implementation Plan

## Goal
Implement central LAN DNS resolution for `aegis.internal -> 192.168.10.10` on the MikroTik hEX lite RB750r2 router to enable zero-workaround direct on-site access from VLAN 30 without requiring Twingate ZTNA, external routing, or client-side `hosts` file entries.

## Status
PLANNING RECONCILIATION COMPLETE — PENDING HUMAN OWNER REVIEW & EXECUTION.
This plan defines the step-by-step procedure for the Human Owner.
Agent must NOT execute Production mutations.

---

## Architecture Context & Reconciled Live Truth

- **Router:** MikroTik hEX lite RB750r2 (RouterOS 7.18.2 stable, `ether2` trunk 100 Mbps Full Duplex).
- **Switch:** TP-Link TL-SG105E:
  - Port 1: Trunk to MikroTik `ether2` (`100MF`)
  - Port 2: Access VLAN 10 (Beelink Server, `1000MF`)
  - Port 4: Access VLAN 40 (IDEA3)
  - Port 5: Access VLAN 30 (Management / Test Client, `1000MF`)
- **VLAN 30 Network:**
  - Gateway: `192.168.30.1/24`
  - DHCP Server: `dhcp3` on `VLAN30-Mgmt`
  - DHCP Pool: `dhcp_pool3` (`192.168.30.10 - 192.168.30.99`)
  - Lease Time: `30m`
  - DHCP Option 3 (Gateway): `192.168.30.1` (`NO_CHANGE_REQUIRED`)
  - DHCP Option 6 (DNS Server): `192.168.30.1` (`NO_CHANGE_REQUIRED`)
- **DNS Server State:**
  - `allow-remote-requests=yes` (`NO_CHANGE_REQUIRED`)
  - Upstream DNS: `8.8.8.8` + dynamic WAN DNS (`peer-dns=yes`)
  - Static DNS: `router.lan -> 192.168.88.1` present; `aegis.internal` ABSENT.
- **Firewall & Routing State:**
  - Interface list `LAN = bridge, VLAN30-Mgmt, VLAN10-Server`.
  - Forward chain accepts LAN-to-LAN; routing to `192.168.10.10:443` verified.
  - Input chain permits DNS from LAN.
- **Evaluations:**
  - `VLAN30_DHCP_DNS_POINTS_TO_ROUTER=YES`
  - `VLAN30_CAN_QUERY_ROUTER_DNS_UDP53=YES`
  - `VLAN30_CAN_QUERY_ROUTER_DNS_TCP53=YES`
  - `NEW_SWITCH_CHANGE_REQUIRED=NO`
  - `NEW_DHCP_CHANGE_REQUIRED=NO`
  - `NEW_FIREWALL_CHANGE_REQUIRED=NO`
  - `MINIMUM_PROPOSED_PRODUCTION_MUTATION=/ip dns static add name=aegis.internal address=192.168.10.10 ttl=5m comment="AEGIS HUB Direct-LAN entry"`

---

## User Constraints & Boundaries

- **Production Mutation Gate:** Marked `HUMAN_OWNER_ACTION_REQUIRED=YES`. Agents must not run RouterOS config commands or mutate the router.
- **TLS Trust Boundary:** `ARBITRARY_UNMANAGED_WINDOWS_ZERO_SETUP=NOT_CLAIMED`. Central DNS provides IP resolution only. Trusted browser HTTPS requires the public AEGIS Root CA installed in the client's `Cert:\LocalMachine\Root`. Do not disable TLS. Do not use `-k` as final acceptance evidence.
- **Hosts Workaround Boundary:** Temporary Windows hosts file entry (`192.168.10.10 aegis.internal`) is currently active and must NOT be removed until central DNS is verified active on the router. Existing backup of the hosts file must be preserved. Remove ONLY the `aegis.internal` entry; do not touch unrelated lines.
- **Scope Boundary:** No switch changes, no DHCP changes, no firewall changes, no Docker/Beelink changes, no throughput benchmark re-runs (DNS does not affect throughput). Central DNS scope belongs exclusively to PR #257.

---

## Step-by-Step Implementation Runbook

### Step 1: Read-Only Pre-Mutation Verification
*Actor: Human Owner / Technician*
*Action Type: Read-Only Verification (`HUMAN_OWNER_ACTION_REQUIRED=NO`)*

1. On MikroTik Router:
   ```routeros
   /ip dns print
   ```
   *Expected:* `allow-remote-requests: yes`, upstream servers present.

2. Verify DHCP Network DNS setting:
   ```routeros
   /ip dhcp-server network print where address="192.168.30.0/24"
   ```
   *Expected:* `gateway: 192.168.30.1`, `dns-server: 192.168.30.1`.

3. Verify `aegis.internal` is currently absent:
   ```routeros
   /ip dns static print where name="aegis.internal"
   ```
   *Expected:* Empty (0 items).

4. On Windows Client (Port 5 / VLAN 30, Twingate DISCONNECTED):
   ```powershell
   ipconfig /all
   ```
   *Expected:* IPv4 Address in `192.168.30.x/24`, Default Gateway `192.168.30.1`, DNS Servers `192.168.30.1`.

5. Query existing router static record via router DNS:
   ```powershell
   Resolve-DnsName -Server 192.168.30.1 -Name router.lan
   ```
   *Expected:* IPAddress `192.168.88.1`. Proves client can query router DNS over UDP/TCP 53.

6. Confirm client `hosts` file backup exists:
   ```powershell
   Test-Path C:\Windows\System32\drivers\etc\hosts.bak
   ```
   *If false, create backup:*
   ```powershell
   Copy-Item C:\Windows\System32\drivers\etc\hosts C:\Windows\System32\drivers\etc\hosts.bak
   ```

---

### Step 2: Capture Current MikroTik DNS/DHCP State
*Actor: Human Owner*
*Action Type: Read-Only Capture / Export (`HUMAN_OWNER_ACTION_REQUIRED=YES`)*

Capture a text export snapshot of the current DNS and DHCP configuration before mutation:
```routeros
/ip dns export
/ip dhcp-server export
```
Record the output locally for exact state matching and audit traceability.

---

### Step 3: Apply Minimum Authorized DNS Mutation
*Actor: Human Owner ONLY*
*Action Type: Production Mutation (`HUMAN_OWNER_ACTION_REQUIRED=YES`)*

Apply the single static DNS record on MikroTik:
```routeros
/ip dns static add name=aegis.internal address=192.168.10.10 ttl=5m comment="AEGIS HUB Direct-LAN entry"
```

*Note:* No switch, DHCP pool, DHCP option, or firewall filter mutations are authorized.

---

### Step 4: Router-Side Verification
*Actor: Human Owner*
*Action Type: Read-Only Verification (`HUMAN_OWNER_ACTION_REQUIRED=YES`)*

1. Verify static record exists with exact parameters:
   ```routeros
   /ip dns static print detail where name="aegis.internal"
   ```
   *Expected:*
   ```text
   name="aegis.internal" address=192.168.10.10 ttl=5m comment="AEGIS HUB Direct-LAN entry"
   ```

2. Verify router local resolver responds:
   ```routeros
   :put [:resolve aegis.internal]
   ```
   *Expected:* `192.168.10.10`.

---

### Step 5: Remove Temporary Windows Hosts Workaround
*Actor: Human Owner / Administrator*
*Action Type: Client Endpoint Mutation (`HUMAN_OWNER_ACTION_REQUIRED=YES`)*

1. Open `C:\Windows\System32\drivers\etc\hosts` in Administrator text editor.
2. Locate the line:
   ```text
   192.168.10.10 aegis.internal
   ```
3. Delete ONLY that specific line.
4. Preserve all localhost and unrelated entries.
5. Save the file.

---

### Step 6: Renew / Flush Client DNS
*Actor: Human Owner / Technician*
*Action Type: Client Command (`HUMAN_OWNER_ACTION_REQUIRED=YES`)*

Flush the Windows DNS client resolver cache:
```powershell
ipconfig /flushdns
```
*Expected:* `Successfully flushed the DNS Resolver Cache.`

---

### Step 7: Onsite LAN Acceptance Test
*Actor: Human Owner / Technician*
*Action Type: Verification (`HUMAN_OWNER_ACTION_REQUIRED=YES`)*

Execute the comprehensive acceptance test suite on the Windows test client:

1. **Physical Link & Network Verification:**
   - Client attached to TP-Link switch Port 5 (Access VLAN 30, PVID 30).
   - Twingate client DISCONNECTED.
   - Physical Ethernet link rate: `1 Gbps` (`1000MF`).
   ```powershell
   ipconfig /all
   ```
   *Expected:*
   - IPv4 Address: `192.168.30.x` (from pool `192.168.30.10-99`)
   - Subnet Mask: `255.255.255.0`
   - Default Gateway: `192.168.30.1`
   - DNS Servers: `192.168.30.1`

2. **Central DNS Resolution Verification (Without Hosts File):**
   ```powershell
   Resolve-DnsName aegis.internal
   ```
   *Expected:*
   - `Name: aegis.internal`
   - `IPAddress: 192.168.10.10`
   - `QueryStatus: Success`

3. **External DNS Forwarding Verification:**
   ```powershell
   Resolve-DnsName google.com
   ```
   *Expected:* QueryStatus `Success` (proves recursive upstream forwarders through router function normally).

4. **Layer 4 Transport Connectivity Verification:**
   ```powershell
   Test-NetConnection aegis.internal -Port 443
   ```
   *Expected:*
   - `TcpTestSucceeded: True`
   - `RemoteAddress: 192.168.10.10`

5. **Application HTTPS Health Check (WITHOUT -k):**
   ```powershell
   curl.exe -I https://aegis.internal/healthz
   ```
   *Expected:*
   - `HTTP/1.1 200 OK`
   - Zero certificate validation errors when public AEGIS Root CA is installed.
   *(Note: `-k` is strictly forbidden as final acceptance evidence).*

6. **Browser Acceptance (Direct-LAN End-User Experience):**
   Open Chrome/Edge/Firefox and navigate to:
   - `https://aegis.internal/` (AEGIS HUB portal)
   - `https://aegis.internal/drive` (AEGIS Drive UI)
   - `https://aegis.internal/monitor` (AEGIS Monitor UI)
   *Expected:* All web surfaces load cleanly over Direct LAN with valid lock icon (trusted TLS).

---

### Step 8: Rollback Procedure
*Actor: Human Owner ONLY*
*Action Type: Contingency Rollback (`HUMAN_OWNER_ACTION_REQUIRED=YES`)*

If central DNS causes any unforeseen regressions or resolution issues:

1. Remove the static DNS record on MikroTik:
   ```routeros
   /ip dns static remove [find name="aegis.internal"]
   ```

2. Confirm removal:
   ```routeros
   /ip dns static print where name="aegis.internal"
   ```
   *Expected:* Empty (0 items).

3. Restore client hosts entry if temporary emergency access is needed:
   ```text
   192.168.10.10 aegis.internal
   ```

4. Flush client resolver:
   ```powershell
   ipconfig /flushdns
   ```

*Safety Invariant:* Do NOT reset the router. Do NOT reload full binary backup. Do NOT alter switch or DHCP configs.

---

### Step 9: Documentation, Task Receipt & Closeout
*Actor: Agent / Human Owner*
*Action Type: Documentation & Governance Checkpoint*

1. Record execution timestamps, observable outputs, and pass/fail results into canonical notes:
   - `Obsidian_AEGIS_Vault/AEGIS_Knowledge/infrastructure/network/MikroTik-Config.md`
   - `Obsidian_AEGIS_Vault/AEGIS_Knowledge/infrastructure/network/VLAN-IP-Plan.md`
2. Create exactly one immutable final task receipt:
   `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/YYYY-MM-DD_HHMMSS_kla_infrastructure-vlan30-direct-lan-dns.md`
3. Update PR #257 body with truth tokens and link to final receipt.
4. Transition PR #257 from Draft to Ready for Review.
5. Human Owner performs final PR merge.
