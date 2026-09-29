# AEGIS Gigabit Inter-VLAN Throughput Remediation — Design

Date: 2026-09-30
Area: infrastructure · Owner: kla · Status: **DESIGN — Human Owner review required**
Implementation plan: `docs/superpowers/plans/2026-09-30-aegis-gigabit-intervlan-remediation.md`

This document is design only. It authorizes no Production, router, switch, cable, DNS, DHCP, Twingate, Docker, or application change.

## 1. Problem

PR #216 measured a shared throughput ceiling on the P1 Direct-LAN path (client on VLAN 30 → HUB on VLAN 10):

| Probe (P1 Direct LAN, Twingate OFF) | Single stream | Dual-stream aggregate | R |
|---|---:|---:|---:|
| U2 upload (Normal Files, 16 MiB chunk PUTs) | 10.692 MB/s | 10.098 MB/s | 0.944 |
| D1 authenticated download | 11.115 MB/s | 11.032 MB/s | 0.993 |

D1 time-to-first-byte share is 0.0008, so auth, metadata, and audit work are ruled out as the throughput limiter. The client's physical NIC negotiated **1 Gbps**. The PR #216 source trace found no application buffer, rate limit, compression, or delay that explains the ceiling, and **no safe application fix is proven** (Task 2 upload concurrency skipped).

The largest possible TCP goodput on 100BASE-TX with a 1500 B MTU is about 11.77 MB/s (1,448 B of payload per 1,538 B of wire time × 12.5 MB/s). D1 reaches about 94% of that and U2 about 91%. One stream fills the ceiling and two streams share it. That is the signature of a 100 Mbps link on the path.

## 2. Current topology (repository facts, verified 2026-09-30 against `origin/main` `6317d88d`)

~~~text
Internet (ISP)
  └── Home ISP router            (team has no admin rights; no 802.1Q; double NAT)
        └── MikroTik hEX lite RB750r2  ether1 = WAN (NAT, firewall)
              ether2 = single 802.1Q trunk, VLAN 10 / 20 / 30
              VLAN gateways 192.168.10.1 / 192.168.20.1 / 192.168.30.1
              DHCP server on VLAN 30 (PR #257 contract)
                └── TP-Link TL-SG105E  Port 1 trunk (tagged 10/20/30)
                      Port 2 access VLAN 10 → Beelink Mini S 192.168.10.10 (HUB :443, Twingate Connector container)
                      Port 3 access VLAN 20 → Detection laptop
                      Port 4 access VLAN 1  → technician port (switch management)
                      Port 5 access VLAN 30 → Admin / test laptop
~~~

Sources: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/infrastructure/network/MikroTik-Config.md`, `Switch-VLAN-Config.md`, `VLAN-IP-Plan.md`, `Hardware-Inventory.md`, `entities/MikroTik_hEX_lite.md`, `entities/TP-Link_TL-SG105E.md`, `infrastructure/remote-access/Twingate-Setup.md`, and the PR #257 spec `docs/superpowers/specs/2026-09-29-aegis-vlan30-direct-lan-dns-design.md`.

### 2.1 P1 packet path

Client `192.168.30.10/24` (gateway `192.168.30.1`) → switch Port 5 → Port 1 → RB750r2 `ether2` (tag 30 in) → routed and filtered → RB750r2 `ether2` (tag 10 out) → Port 1 → Port 2 → Beelink. Client and HUB are on different subnets, so every P1 packet is routed. The only documented gateway is the RB750r2, which has a single trunk port (router-on-a-stick). Upload and download each cross `ether2` once in each direction.

### 2.2 Link capability register

| Link / port | Capability | Evidence class |
|---|---|---|
| Client NIC ↔ switch Port 5 | 1 Gbps negotiated | **Measured** (Human, 2026-09-30: Realtek PCIe GbE, LinkSpeed 1 Gbps) |
| Switch Port 1 ↔ RB750r2 `ether2` | **≤ 100 Mbps**: RB750r2 has 5 × 10/100 Ethernet (vendor spec supplied by the Human Owner) | Vendor spec + repo model identity. Live negotiated rate NOT re-read from the device |
| RB750r2 `ether1` ↔ home ISP router | ≤ 100 Mbps (same device) | Vendor spec |
| Switch Port 2 ↔ Beelink NIC | NOT_MEASURED. Neither the Beelink NIC speed nor the port negotiation is recorded in the repo | Unknown. Preflight must read it |
| TL-SG105E switching fabric | Gigabit-class ports per the product line. Not recorded in the repo | Vendor claim. Preflight confirms negotiated rates |

~~~text
BOTTLENECK_LOCATION=RB750r2 ether2 (router-on-a-stick inter-VLAN trunk), 10/100 port
CLASSIFICATION=STRONGLY_SUPPORTED_NOT_LIVE_DEVICE_REVERIFIED
RESIDUAL_ALTERNATIVE=Beelink NIC / switch Port 2 negotiated at 100 Mbps (NOT_MEASURED; preflight P-3 settles it)
~~~

If preflight finds the Beelink link at 100 Mbps, fix that link first. It is a cable or NIC matter, not a router matter. This design still applies afterwards, because `ether2` is 10/100 in hardware regardless.

### 2.3 Other services that depend on the router

Any replacement must carry every one of these, not only the VLAN gateways:

1. VLAN 10/20/30 gateway addresses and the 802.1Q trunk.
2. Forward-chain firewall: the ordered LAN-to-LAN accept rule above the drop rule (`MikroTik-Config.md`). The full rule set has **not been reviewed** and has **never been exported**. The repo records `/export` backup as "⏳ not done".
3. WAN NAT (masquerade) on `ether1`, and the input-chain firewall protecting the router.
4. DHCP on VLAN 30 (and on any other VLAN where it runs; unknown until export).
5. DNS: the PR #257 design proposes a router static entry `aegis.internal → 192.168.10.10`. Whether the router serves DNS today is unknown until export.
6. The egress path for the Twingate Connector (outbound only, container `twingate-aegis-connector-02` on the Beelink) and for `cloudflared` (Public Share).
7. Router management access (Winbox/SSH/API). Restricting it to VLAN 30 is still "⏳ not confirmed".

## 3. Requirements

Must preserve: VLAN 10 Server, VLAN 20 Detector, and VLAN 30 Management as separate L2 domains; current subnets and gateway addresses; stateful firewall enforcement between zones at the gateway; Direct-LAN behavior (PR #257 contract); Twingate Remote access; HUB address `192.168.10.10:443`; the existing security boundaries (server-side auth/RBAC is unaffected by network work); and a rollback that restores today's state in minutes.

Rejected for any option: bridging VLAN 30 into VLAN 10; bypassing or weakening firewall/ACL enforcement; removing VLAN isolation for benchmark speed; exposing AEGIS services more broadly; relying on application changes to hide the hardware ceiling.

## 4. Options

### Option A — Replace RB750r2 with a Gigabit RouterOS router, same architecture (RECOMMENDED)

Swap the router for a MikroTik device with all-Gigabit Ethernet ports running RouterOS v7. Examples in the product line are hEX RB750Gr3 and hEX refresh (E50UG). The exact model is a Human Owner procurement decision. Import the exported RB750r2 configuration with only interface-name and switch-chip edits. The switch, cabling layout, subnets, gateway IPs, DHCP, DNS, NAT, and firewall rules stay identical.

Note: `Hardware-Inventory.md` and `90-Status/Document-Conflicts.md` record `RB750Gr3` as a **wrong** model name found in old documents. After any replacement, the inventory must record the newly installed model explicitly so the old conflict note is not misread.

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

## 5. Recommendation

~~~text
RECOMMENDED_REMEDIATION=OPTION_A — replace RB750r2 with an all-Gigabit RouterOS v7 MikroTik router, importing the unchanged RB750r2 configuration (interface names adapted only)
~~~

Reasons: it is the smallest change that removes the 10/100 port; it keeps the same firewall engine, rule order, NAT, DHCP, and DNS semantics; the switch and the Beelink stay untouched; and rollback is physical and immediate because the RB750r2 stays configured and unused on the shelf.

Procurement acceptance criteria (verified before purchase or before cutover):

1. Every Ethernet port is 10/100/1000.
2. It runs RouterOS v7, the same major version family as the RB750r2 export, or the export has been adapted and reviewed.
3. The vendor's published routing test figures for the model **with firewall filter rules** (not only the FastTrack / bridging figures) are recorded in the plan, with their source.
4. VLAN interfaces on a single trunk port (or a bridge with VLAN filtering) are supported, as today.

### 5.1 Expected P1 ceiling after remediation

~~~text
EXPECTED_P1_WIRE_CEILING_AFTER=1 Gbps (≈117 MB/s TCP goodput) — a ~10× higher cap
EXPECTED_P1_REALIZED_THROUGHPUT_AFTER=NOT_PREDICTED — set by the next limiter
~~~

Once the 100 Mbps link is gone, the next limiter is unknown. Candidates are routed+filtered CPU throughput of the chosen router, the Beelink N5095 (TLS in HUB nginx, the Node stream), storage write/read, browser client behavior, and the application's serial one-chunk-in-flight upload. PR #216 U1/U2 showed that concurrency was irrelevant **under** the 100 Mbps cap. It must be re-evaluated above it. The PR #216 U2/D1 quick probe (plan step 11) and the later full POST-FIX P1 matrix (plan step 12) establish the real number. No throughput figure may be claimed before those runs.

Remote (P2/Twingate ≈3.0 MB/s upload, R = 1.158) is **not** expected to improve. It runs far below 100 Mbps, and its limiter is still open (PR #216 `REMOTE_RESIDUAL_LIMITER=OPEN`).

## 6. Security boundary statement

Option A preserves every boundary listed in §3:

- The same three VLANs, subnets, gateway addresses, and trunk tagging. The switch is unchanged.
- The same stateful forward-chain policy, ported rule by rule in the same order. The equivalence checklist in the plan (step 3) compares exported rules line by line.
- No new exposure. The router's management services must be restricted to at least today's scope, and the plan records `/ip service` before and after.
- Twingate stays outbound-only through NAT, and no inbound port is opened.
- No application or authentication change.

Pre-existing gaps are carried forward and **not** claimed as fixed: the unreviewed firewall rule set, the unconfirmed management restriction to VLAN 30, and the unconfirmed switch "Not Member" isolation. The migration export gives the first reliable view of the firewall rules. Any hardening it reveals goes in a separate reviewed change, not in the cutover.

## 7. Related work

| PR | Relation |
|---|---|
| #15 | Recorded server infrastructure production readiness (vault sync), the baseline for the network notes |
| #17 | X1 Windows endpoint onboarding: endpoint-side network assumptions |
| #18 | X1 post-merge infrastructure reconciliation |
| #83 | IDEA1 acceptance evidence reconciliation (P1/P2 access paths) |
| #216 | Performance diagnosis: U2/D1 evidence, 100 Mbps ceiling, no app fix proven. Stays diagnosis-only |
| #257 | VLAN 30 Direct-LAN DNS contract. Router DHCP/DNS duties must move with the config |

This PR carries no content from #216 or #257. It only cross-references them.

## 8. Open questions for the Human Owner

1. Approve Option A and choose the replacement model (procurement).
2. Approve a read-only preflight session on the RB750r2 and the Beelink (plan steps 1–2).
3. Decide whether FastTrack is allowed on the new router (a throughput/visibility trade-off). The default is to keep today's setting unchanged.
4. Pick a cutover window. All zones and Remote access are briefly offline.
