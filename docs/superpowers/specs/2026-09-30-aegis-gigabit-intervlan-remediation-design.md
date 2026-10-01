# AEGIS Gigabit Inter-VLAN Throughput Remediation — Design

Date: 2026-09-30
Area: infrastructure · Owner: kla · Status: **OPTIONAL FUTURE REFERENCE — Production hardware remains RB750r2 + TL-SG105E**
Implementation plan: `docs/superpowers/plans/2026-09-30-aegis-gigabit-intervlan-remediation.md`

This document is design and reference only. Current production hardware is frozen at MikroTik hEX lite RB750r2 and TP-Link TL-SG105E (`CURRENT_PRODUCTION_ARCHITECTURE=RB750r2_PLUS_TL-SG105E`). Hardware replacement, procurement, router model selection, and cutover are NOT authorized (`HARDWARE_REPLACEMENT_AUTHORIZED=NO`, `PROCUREMENT_AUTHORIZED=NO`, `PRODUCTION_CUTOVER_AUTHORIZED=NO`, `ROUTER_MODEL_SELECTION_REQUIRED=NO`). It authorizes no Production, router, switch, cable, DNS, DHCP, Twingate, Docker, or application change.

## 1. Problem

PR #216 measured a shared throughput ceiling on the P1 Direct-LAN path (client on VLAN 30 → HUB on VLAN 10):

| Probe (P1 Direct LAN, Twingate OFF) | Single stream | Dual-stream aggregate | R |
|---|---:|---:|---:|
| U2 upload (Normal Files, 16 MiB chunk PUTs) | 10.692 MB/s | 10.098 MB/s | 0.944 |
| D1 authenticated download | 11.115 MB/s | 11.032 MB/s | 0.993 |

D1 time-to-first-byte share is 0.0008, so auth, metadata, and audit work are ruled out as the throughput limiter. The client's physical NIC negotiated **1 Gbps**. The PR #216 source trace found no application buffer, rate limit, compression, or delay that explains the ceiling, and **no safe application fix is proven** (Task 2 upload concurrency skipped).

The largest possible TCP goodput on 100BASE-TX with a 1500 B MTU is about 11.77 MB/s (1,448 B of payload per 1,538 B of wire time × 12.5 MB/s). D1 reaches about 94% of that and U2 about 91%. One stream fills the ceiling and two streams share it. That is the signature of a 100 Mbps link on the path.

## 2. Current topology (live verified 2026-09-30)

~~~text
Internet (ISP)
  └── Home ISP router            (team has no admin rights; no 802.1Q; double NAT)
        └── MikroTik hEX lite RB750r2 (rev r3, RouterOS 7.18.2)
              ether1 = WAN (100 Mbps full-duplex link-ok, NAT, firewall)
              ether2 = single 802.1Q trunk (100 Mbps full-duplex link-ok)
              VLAN gateways:
                192.168.10.1/24 (VLAN10-Server)
                192.168.20.1/24 (VLAN20-IOT)
                192.168.30.1/24 (VLAN30-Mgmt)
                192.168.40.1/24 (VLAN40-IDEA3)
              DHCP servers active on VLAN 10, VLAN 20, VLAN 30, VLAN 40
              DNS: allow-remote-requests=yes (static: router.lan; aegis.internal not yet implemented)
              Interface-list: WAN=ether1, LAN=bridge,VLAN30-Mgmt,VLAN10-Server (VLAN20/40 not in LAN)
                └── TP-Link TL-SG105E (hw 5.0, mgmt 192.168.30.2 on VLAN 30)
                      Port 1 trunk (tagged 10/20/30/40, untagged 1, PVID 1) — 100MF
                      Port 2 access VLAN 10 (untagged, PVID 10) — 1000MF → Beelink Mini S 192.168.10.10 (enp1s0 1 Gbps Full)
                      Port 3 access VLAN 20 (untagged, PVID 20) — Link Down → Detection laptop
                      Port 4 access VLAN 40 (untagged, PVID 40) — Link Down → IDEA3 Cyber-Physical Lockdown
                      Port 5 access VLAN 30 (untagged, PVID 30) — 1000MF → Admin / test laptop (Realtek GbE 1 Gbps)
~~~

Sources: Live preflight on RB750r2, Beelink `enp1s0`, and TL-SG105E (2026-09-30); reconciled with `Obsidian_AEGIS_Vault/AEGIS_Knowledge/infrastructure/network/MikroTik-Config.md`, `Switch-VLAN-Config.md`, `VLAN-IP-Plan.md`, `Hardware-Inventory.md`, and PR #257.

> [!NOTE]
> Historical documentation describing Port 4 as Technician/Native VLAN 1 is stale and superseded. Current live switch configuration assigns Port 4 to Access VLAN 40 (IDEA3) with PVID 40, and Port 5 to Access VLAN 30 (Management) with PVID 30. Switch web management is reached via `192.168.30.2` on VLAN 30.

### 2.1 P1 packet path

Client `192.168.30.10/24` (gateway `192.168.30.1`) → switch Port 5 (1000MF) → Port 1 (100MF) → RB750r2 `ether2` (100 Mbps full-duplex, tag 30 in) → routed and filtered → RB750r2 `ether2` (100 Mbps full-duplex, tag 10 out) → switch Port 1 (100MF) → Port 2 (1000MF) → Beelink `enp1s0` (1 Gbps full-duplex). Client and HUB are on different subnets, so every P1 packet is routed. The only gateway is the RB750r2, which has a single trunk port (router-on-a-stick). Upload and download each cross `ether2` once in each direction. Every segment on this path negotiates 1 Gbps full duplex except the switch Port 1 ↔ RB750r2 `ether2` trunk, which is locked at 100 Mbps in hardware.

### 2.2 Link capability register

| Link / port | Capability | Evidence class |
|---|---|---|
| Client NIC ↔ switch Port 5 | **1 Gbps** (1000MF) | **Measured live** (Human, 2026-09-30: Realtek PCIe GbE LinkSpeed 1 Gbps; Switch Port 5 = 1000MF) |
| Switch Port 1 ↔ RB750r2 `ether2` | **100 Mbps Full Duplex** (100MF) | **Measured live** (Human, 2026-09-30: RB750r2 `/interface ethernet monitor ether2 once` rate=100Mbps full-duplex=yes; TL-SG105E Port 1 = 100MF) |
| RB750r2 `ether1` ↔ home ISP router | **100 Mbps Full Duplex** | **Measured live** (Human, 2026-09-30: RB750r2 `/interface ethernet monitor ether1 once` rate=100Mbps full-duplex=yes status=link-ok) |
| Switch Port 2 ↔ Beelink NIC | **1 Gbps Full Duplex** (1000MF) | **Measured live** (Human, 2026-09-30: Beelink `enp1s0` ethtool speed=1000Mb/s duplex=Full; TL-SG105E Port 2 = 1000MF) |
| Switch Port 3 ↔ Detection Laptop | Link Down (Gigabit capable) | Measured live: TL-SG105E Port 3 = Link Down (Access VLAN 20, PVID 20) |
| Switch Port 4 ↔ IDEA3 Controller | Link Down (Gigabit capable) | Measured live: TL-SG105E Port 4 = Link Down (Access VLAN 40, PVID 40; historical VLAN 1 role superseded) |
| TL-SG105E switching fabric | Gigabit-class (hw 5.0) | Measured live: Ports 2 and 5 operate at 1000MF |

~~~text
RB750R2_IDENTITY_LIVE_VERIFIED=YES
RB750R2_ETHER2_LINK=100MBPS_FULL_DUPLEX
TP_LINK_PORT1_TRUNK=100MF
BEELINK_LINK=1_GBPS_FULL
ADMIN_CLIENT_LINK=1_GBPS
TP_LINK_PORT2=1000MF
TP_LINK_PORT5=1000MF
P1_ROUTER_TRUNK_100MBPS_CEILING=PROVEN_LIVE
~~~

The residual hypothesis that the Beelink link was negotiated at 100 Mbps is **disproven** (`BEELINK_LINK=1_GBPS_FULL`). The 100 Mbps inter-VLAN trunk bottleneck on RB750r2 `ether2` is **proven live**.

### 2.3 Other services that depend on the router

Any replacement must carry every one of these, not only the VLAN gateways:

1. VLAN 10/20/30/40 gateway addresses (`192.168.10.1/24`, `192.168.20.1/24`, `192.168.30.1/24`, `192.168.40.1/24`) and the 802.1Q trunk.
2. VLAN 40 (IDEA3) preservation: gateway `192.168.40.1/24`, DHCP server and pool, DNS behavior, firewall policy, MQTT/NTP allowances, and default deny behavior.
3. Interface lists: RouterOS currently defines WAN=`ether1` and LAN=`bridge,VLAN30-Mgmt,VLAN10-Server`. Note that VLAN 20 and VLAN 40 are **not** members of the LAN interface-list. Migration must preserve this current behavior first without unreviewed alterations.
4. Forward-chain firewall: the ordered LAN-to-LAN accept rule above the drop rule (`MikroTik-Config.md`). The full rule set was exported in Step 2 (`aegis-rb750r2-pre-gigabit.rsc`) and captured in Step 3 equivalence baseline.
5. WAN NAT (masquerade) on `ether1`, and the input-chain firewall protecting the router. Three active masquerade rules are captured and preserved.
6. DHCP on VLAN 10, VLAN 20, VLAN 30, and VLAN 40 (all verified active live).
7. DNS: `allow-remote-requests=yes`. Static entries currently contain only `router.lan`. The `aegis.internal → 192.168.10.10` static entry is NOT yet implemented live; PR #257 remains the owner of that change (`PR257_DNS_SCOPE_PRESERVED=YES`).
8. The egress path for the Twingate Connector (outbound only, container `twingate-aegis-connector-02` on the Beelink) and for `cloudflared` (Public Share).
9. Router management access (Winbox/SSH/API). The Step 2 export revealed that management services run without IP restrictions and `defconf input drop !LAN` is disabled. This is recorded as `SECURITY_HARDENING_FOLLOWUP_REQUIRED=YES` to be addressed in a separate hardening change, not during cutover.

## 3. Requirements

Must preserve: VLAN 10 Server, VLAN 20 Detector, VLAN 30 Management, and VLAN 40 IDEA3 as separate L2 domains; current subnets and gateway addresses; stateful firewall enforcement between zones at the gateway (including VLAN 40 MQTT/NTP rules and default deny); Direct-LAN behavior (PR #257 contract); Twingate Remote access; HUB address `192.168.10.10:443`; the existing security boundaries (server-side auth/RBAC is unaffected by network work); and a rollback that restores today's state in minutes.

Rejected for any option: bridging VLAN 30 into VLAN 10; bypassing or weakening firewall/ACL enforcement; removing VLAN isolation for benchmark speed; exposing AEGIS services more broadly; relying on application changes to hide the hardware ceiling.

## 4. Options

### Option A — Replace RB750r2 with a Gigabit RouterOS router, same architecture (OPTIONAL FUTURE REFERENCE)

> [!NOTE]
> Option A is an uncommitted, optional future remediation path preserved for reference if the Human Owner later chooses to exceed the physical 100 Mbps ceiling. It is NOT authorized for current implementation (`HARDWARE_REPLACEMENT_AUTHORIZED=NO`, `PROCUREMENT_AUTHORIZED=NO`, `PRODUCTION_CUTOVER_AUTHORIZED=NO`, `REPLACEMENT_WORK_STATE=DEFERRED_OPTIONAL_FUTURE_WORK`). Production hardware remains RB750r2 + TL-SG105E (`CURRENT_PRODUCTION_ARCHITECTURE=RB750r2_PLUS_TL-SG105E`).

Swap the router for a MikroTik device with all-Gigabit Ethernet ports running RouterOS v7. Examples in the product line are hEX RB750Gr3 and hEX refresh (E50UG). If the Human Owner ever decides to pursue hardware replacement in the future, the model selection would be an owner procurement decision. Import the exported RB750r2 configuration with only interface-name and switch-chip edits. The switch, cabling layout, subnets, gateway IPs, DHCP, DNS, NAT, and firewall rules stay identical.

Note: `Hardware-Inventory.md` and `90-Status/Document-Conflicts.md` record `RB750Gr3` as a **wrong** model name found in old documents. If a replacement is ever performed in the future, the inventory must record the newly installed model explicitly so the old conflict note is not misread.

### Option B — Move inter-VLAN routing to another existing Gigabit device

Candidates in the repository:

- **TL-SG105E**: an Easy Smart Layer 2 switch. It holds no VLAN gateway, cannot route between VLANs, and has no stateful firewall. **Not capable.**
- **Home ISP router**: the team has no admin rights and it cannot handle 802.1Q (`entities/MikroTik_hEX_lite.md`). **Not capable.**
- **Beelink (Linux, VLAN sub-interfaces + nftables)**: technically able to route, but it would make the Server-zone host the gateway and firewall for the Management and Detector zones. A compromise of any container host or HUB would then own inter-zone policy. That collapses the zone boundary. **Rejected on security.**

~~~text
OPTION_B=REJECTED — no existing device in repository evidence can safely assume the role
~~~

### Option C — Alternatives that avoid the router bottleneck

- **C1. Layer 3 switch replaces TL-SG105E and routes inter-VLAN; RB750r2 keeps WAN only.** This removes the 100 Mbps inter-VLAN ceiling, but it moves zone enforcement from the stateful RouterOS forward chain to switch ACLs, which are usually stateless and less expressive. It changes two devices, and the whole zone policy must be rewritten in a new syntax. WAN and Remote traffic would still cross a 10/100 router, which does not matter today because Remote runs at about 3 MB/s. It is viable, but its security equivalence is weaker and harder to prove. **Not recommended.**
- **C2. Second NIC on the Beelink placed in VLAN 30.** VLAN 30 clients would reach the HUB on-link without routing. That makes the server dual-homed across zones and bypasses the gateway firewall for Management → Server. **Rejected** (it bypasses firewall enforcement).
- **C3. Put the admin client in VLAN 10 for transfers.** **Rejected** (removes isolation).
- **C4. Keep the RB750r2 and use a separate port per VLAN.** Every RB750r2 port is 10/100, so there is no gain. **Rejected.**

### 4.1 Comparison

| Criterion | A — Gigabit RouterOS router | B — existing device | C1 — L3 switch + router WAN-only |
|---|---|---|---|
| Wire ceiling on P1 | 1 Gbps per direction on the trunk (≈117 MB/s TCP goodput cap). Realized rate is bounded by routed+filtered CPU throughput and the next limiter. **Must be measured** | N/A (no capable device) | 1 Gbps line rate in switch hardware, if the model routes in hardware |
| Security impact | None by design: same firewall engine and same rules, ordering preserved. FastTrack (if enabled) only accelerates connections that already passed the filter; enabling it is a separate reviewed decision | Beelink option collapses zones | Stateful → stateless ACL; equivalence hard to prove |
| Migration complexity | Low–medium: export → edit interface names → import → verify | — | High: two devices, policy rewrite |
| Rollback complexity | Low: move two cables back to the untouched RB750r2 | — | Medium–high |
| Hardware dependency | One new Gigabit MikroTik router | None | New L3 switch |
| Downtime | One cable cutover window (minutes); all zones and Remote/Twingate briefly offline | — | Longer; two devices |
| Config surfaces changed | New router only (same config). Switch unchanged. DHCP/DNS/NAT move with the config | — | Switch VLAN/ACL, router, possibly DHCP relay |
| Evidence before Production | Complete RB750r2 export; offline config diff; vendor routing-throughput figures for the chosen model with firewall rules; Beelink link speed; equivalence checklist signed off | — | ACL equivalence proof; L3 switch spec |

## 5. Optional future remediation design (Option A)

~~~text
REMEDIATION_REFERENCE_DESIGN=OPTION_A — replace RB750r2 with an all-Gigabit RouterOS v7 MikroTik router, importing the unchanged RB750r2 configuration (interface names adapted only)
CURRENT_PRODUCTION_ARCHITECTURE=RB750r2_PLUS_TL-SG105E
HARDWARE_REPLACEMENT_AUTHORIZED=NO
PROCUREMENT_AUTHORIZED=NO
PRODUCTION_CUTOVER_AUTHORIZED=NO
REPLACEMENT_WORK_STATE=DEFERRED_OPTIONAL_FUTURE_WORK
~~~

Reasons Option A is preserved as the reference design: it is the smallest change that removes the 10/100 port; it keeps the same firewall engine, rule order, NAT, DHCP, and DNS semantics; the switch and the Beelink stay untouched; and rollback is physical and immediate because the RB750r2 stays configured and unused on the shelf.

Deferred procurement acceptance criteria (for future reference only if procurement is ever authorized):

1. Every Ethernet port is 10/100/1000.
2. It runs RouterOS v7, the same major version family as the RB750r2 export, or the export has been adapted and reviewed.
3. The vendor's published routing test figures for the model **with firewall filter rules** (not only the FastTrack / bridging figures) are recorded in the plan, with their source.
4. VLAN interfaces on a single trunk port (or a bridge with VLAN filtering) are supported, as today.

### 5.1 Expected P1 ceiling after remediation (reference only)

~~~text
EXPECTED_P1_WIRE_CEILING_AFTER=1 Gbps (≈117 MB/s TCP goodput) — a ~10× higher cap
EXPECTED_P1_REALIZED_THROUGHPUT_AFTER=NOT_PREDICTED — set by the next limiter
~~~

Once the 100 Mbps link is gone, the next limiter is unknown. Candidates are routed+filtered CPU throughput of the chosen router, the Beelink N5095 (TLS in HUB nginx, the Node stream), storage write/read, browser client behavior, and the application's serial one-chunk-in-flight upload. PR #216 U1/U2 showed that concurrency was irrelevant **under** the 100 Mbps cap. It must be re-evaluated above it. The PR #216 U2/D1 quick probe (plan step 11) and the later full POST-FIX P1 matrix (plan step 12) establish the real number. No throughput figure may be claimed before those runs.

Remote (P2/Twingate ≈3.0 MB/s upload, R = 1.158) is **not** expected to improve. It runs far below 100 Mbps, and its limiter is still open (PR #216 `REMOTE_RESIDUAL_LIMITER=OPEN`).

## 6. Security boundary statement

Option A preserves every boundary listed in §3:

- The same four VLANs (VLAN 10, 20, 30, 40), subnets, gateway addresses, and trunk tagging. The switch is unchanged.
- The same stateful forward-chain policy, ported rule by rule in the same order (including VLAN 40 MQTT/NTP allowances and default deny behavior).
- Interface-list membership preserved as-is: `LAN=bridge,VLAN30-Mgmt,VLAN10-Server` (VLAN 20 and VLAN 40 remain outside LAN unless separately reviewed).
- No new exposure. The router's management services must be restricted to at least today's scope, and the plan records `/ip service` before and after.
- Twingate stays outbound-only through NAT, and no inbound port is opened.
- No application or authentication change.

Pre-existing gaps are carried forward and **not** claimed as fixed: unreviewed firewall rules, management services running without IP restrictions (`SECURITY_HARDENING_FOLLOWUP_REQUIRED=YES`), and unconfirmed switch "Not Member" isolation. The Step 2 migration export gives the first reliable view of the firewall and service configurations. Hardening must occur in a separate reviewed change, not during the cutover.

## 7. Related work

| PR | Relation |
|---|---|
| #15 | Recorded server infrastructure production readiness (vault sync), the baseline for the network notes |
| #17 | X1 Windows endpoint onboarding: endpoint-side network assumptions |
| #18 | X1 post-merge infrastructure reconciliation |
| #83 | IDEA1 acceptance evidence reconciliation (P1/P2 access paths) |
| #216 | Performance diagnosis: U2/D1 evidence, 100 Mbps ceiling, no app fix proven. Stays diagnosis-only |
| #257 | VLAN 30 Direct-LAN DNS contract (`docs(infrastructure): define VLAN30 direct-LAN DNS access contract`). Central DNS implementation remains owned by PR #257 (`PR257_DNS_SCOPE_PRESERVED=YES`) |

This PR carries no content from #216 or #257. It only cross-references them.

## 8. Current status and scope boundary

1. **Hardware replacement NOT authorized**: Current production architecture is frozen at RB750r2 + TL-SG105E (`CURRENT_PRODUCTION_ARCHITECTURE=RB750r2_PLUS_TL-SG105E`). No router replacement, switch replacement, hardware procurement, model selection, or cutover is authorized (`HARDWARE_REPLACEMENT_AUTHORIZED=NO`, `PROCUREMENT_AUTHORIZED=NO`, `PRODUCTION_CUTOVER_AUTHORIZED=NO`, `ROUTER_MODEL_SELECTION_REQUIRED=NO`). Stale action `HUMAN_OWNER_REVIEW_PR259_DESIGN_AND_SELECT_GIGABIT_MIKROTIK_MODEL` is removed.
2. **Current purpose of PR #259 fulfilled**:
   - Live physical/network topology documented and verified (`STEP1_LIVE_PREFLIGHT=PASS`).
   - 100 Mbps inter-VLAN trunk bottleneck proven live on `ether2` / Port 1 (`P1_ROUTER_TRUNK_100MBPS_CEILING=PROVEN_LIVE`).
   - Router configuration exported and backed up off-router (`STEP2_EXPORT_BACKUP=PASS`).
   - Live equivalence baseline captured across all VLANs, DHCP, DNS, firewall, NAT, and services (`STEP3_EQUIVALENCE_BASELINE=PASS`).
   - Remediation design preserved as optional future reference (`REPLACEMENT_WORK_STATE=DEFERRED_OPTIONAL_FUTURE_WORK`).
3. **PR #216 reconciliation complete**: PR #216 performance diagnosis reconciled with proven live 100 Mbps hardware path limit at commit `50f94e9a0c64c2cfb973415f8b5c4b577be6e19f` (`PR216_LIVE_HARDWARE_RECONCILIATION=COMPLETE`). PR #259 current-scope work is complete (`PR259_CURRENT_SCOPE_WORK=COMPLETE`). Steps 4–12 remain deferred optional future reference.
