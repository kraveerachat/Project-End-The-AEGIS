# AEGIS Gigabit Inter-VLAN Remediation — Implementation Plan

Date: 2026-09-30 · Area: infrastructure · Owner: kla
Design: `docs/superpowers/specs/2026-09-30-aegis-gigabit-intervlan-remediation-design.md` (Option A)
Status: **PLAN ONLY — NOT EXECUTED.** Every step that touches a device is performed by the Human Owner, in order, after design approval. No agent runs a router, switch, DNS, DHCP, Twingate, Docker, or cable action.

## Global constraints

- Steps 1–3 are read-only. Step 4 writes only to the **new** router while it is disconnected from Production. Steps 6 and 10 are the only Production-changing steps. Both are physical cable moves.
- Never paste passwords, PPP/Wi-Fi secrets, certificates, private keys, or Twingate/cloudflared tokens into the repository, the vault, PR comments, or chat. Exports are taken with `show-sensitive=no` (RouterOS v7 hides sensitive values by default; still verify) and stored **outside** the repository.
- The RB750r2 is never reset, reconfigured, or re-flashed during this plan. It is the rollback.
- Any step that fails its check stops the plan. Roll back (step 10) if the cutover has already happened.

---

### Step 1 — Read-only live inventory / preflight

Status: **EXECUTED (2026-09-30)** by Human Owner.

| ID | Check (read-only) | Where | Result / Evidence |
|---|---|---|---|
| P-1 | `/system routerboard print`, `/system resource print` | RB750r2 | `board-name=hEX lite`, `model=RB750r2`, `revision=r3`, `RouterOS=7.18.2 stable`. `RB750R2_IDENTITY_LIVE_VERIFIED=YES` |
| P-2 | `/interface ethernet monitor ether1,ether2 once` | RB750r2 | `ether1` rate=100Mbps full-duplex=yes status=link-ok; `ether2` rate=100Mbps full-duplex=yes status=link-ok. `RB750R2_ETHER2_LINK=100MBPS_FULL_DUPLEX` |
| P-3 | `cat /sys/class/net/<iface>/speed` and `ethtool <iface>` | Beelink | `enp1s0` Speed: 1000Mb/s, Duplex: Full, Link detected: yes. `BEELINK_LINK=1_GBPS_FULL` (disproves 100 Mbps server link hypothesis) |
| P-4 | Switch web UI → Port Setting / 802.1Q | TL-SG105E (192.168.30.2, hw 5.0) | Port 1 = 100MF (Trunk, Tagged 10,20,30,40; Untagged 1, PVID 1)<br>Port 2 = 1000MF (Access VLAN 10, PVID 10)<br>Port 3 = Link Down (Access VLAN 20, PVID 20)<br>Port 4 = Link Down (Access VLAN 40 / IDEA3, PVID 40)<br>Port 5 = 1000MF (Access VLAN 30 / Admin, PVID 30)<br>*(Reconciliation: Port 4 is Access VLAN 40, Port 5 is Access VLAN 30. Historical VLAN 1 technician port role is superseded)* |
| P-5 | `Get-NetAdapter` on test client | Admin laptop | Realtek PCIe GbE LinkSpeed 1 Gbps reconfirmed (`ADMIN_CLIENT_LINK=1_GBPS`) |
| P-6 | `/interface print`, `/interface vlan print`, interface lists | RB750r2 | `ether2` trunk carries VLAN 10 (VLAN10-Server), VLAN 20 (VLAN20-IOT), VLAN 30 (VLAN30-Mgmt), VLAN 40 (VLAN40-IDEA3).<br>Interface lists: `WAN=ether1`, `LAN=bridge,VLAN30-Mgmt,VLAN10-Server`. *(VLAN 20 and VLAN 40 are NOT members of LAN interface-list)* |
| P-7 | `/ip address print`, `/ip dhcp-server print`, `/ip dns print` | RB750r2 | Gateways: `192.168.10.1/24`, `192.168.20.1/24`, `192.168.30.1/24`, `192.168.40.1/24`.<br>DHCP servers exist on VLAN 10, VLAN 20, VLAN 30, VLAN 40.<br>DNS: `allow-remote-requests=yes`, static `router.lan`. `aegis.internal` static DNS record NOT yet implemented live (PR #257 owns). |
| P-8 | `/ip firewall filter print`, `/ip firewall nat print` | RB750r2 | Rule ordering and full tables to be exported in Step 2. |
| P-9 | `/ip service print`, `/user print` | RB750r2 | Baseline management exposure to be recorded from Step 2 export. |

Preflight classification:
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

Exit: All preflight items recorded. P-2 and P-4 confirm `ether2` and switch Port 1 trunk at 100 Mbps. P-3 and P-4 confirm Beelink `enp1s0` and switch Port 2 are 1 Gbps full duplex. Next action is Step 2 export.

### Step 2 — Current MikroTik config export / backup

Status: **EXECUTED (2026-09-30) / PASS** by Human Owner (`STEP2_RESULT=PASS`).

1. Plain-text export created:
   - File: `aegis-rb750r2-pre-gigabit.rsc`
   - Type: RouterOS script
   - Size: 9.6 KiB
2. Encrypted binary backup created:
   - File: `aegis-rb750r2-pre-gigabit.backup`
   - Type: RouterOS backup (AES-SHA256)
   - Size: 43.9 KiB
   - Password: Kept private to Human Owner (`<BACKUP_PASSWORD>`, not recorded in repo)
3. Off-router storage & verification:
   - Both files downloaded from MikroTik to Human Owner controlled off-router storage outside the repository.
   - SHA-256 calculated locally for both files in off-router storage.
   - Secret scan audit: Grep for secret patterns (`password=`, `secret=`, `private-key`, `passphrase`) completed with 0 matches (`SECRET_PATTERN_HIT_COUNT=0`).
   - `STEP2_RESULT=PASS`.

This closes the long-standing `MikroTik-Config.md` item "Export Config Backup ⏳".

### Step 3 — VLAN / gateway / firewall equivalence checklist

Status: **EXECUTED (2026-09-30) / BASELINE CAPTURED** by Human Owner from Step 2 export (`STEP3_RESULT=PASS`).

The new router must match every row of this baseline, in the same order where order matters:

| Row | Item | Old (RB750r2 Live Baseline) | New | Match |
|---|---|---|---|---|
| E-1 | VLAN IDs on trunk interface | `ether2` carrying VLAN 10 (VLAN10-Server), VLAN 20 (VLAN20-IOT), VLAN 30 (VLAN30-Mgmt), VLAN 40 (VLAN40-IDEA3) | | |
| E-2 | Gateway IPs | `192.168.10.1/24` (VLAN10), `192.168.20.1/24` (VLAN20), `192.168.30.1/24` (VLAN30), `192.168.40.1/24` (VLAN40) | | |
| E-3 | WAN addressing & default route | `ether1`: DHCP client bound, IP `192.168.1.100/24`, gateway `192.168.1.1`, distance 1, peer-dns=yes, peer-ntp=yes. Default route: dynamic `0.0.0.0/0` via `192.168.1.1%ether1` | | |
| E-4 | NAT masquerade rules on WAN | 3 active masquerade rules: Rule 0 (`out-interface-list=WAN ipsec-policy=out,none`), Rules 1 & 2 (`out-interface=ether1`). Preserve exact order and rules during initial migration (no deduplication in PR #259) | | |
| E-5 | Filter rules, **input** chain, in order | Input rules from export. OpenVPN input allow rule: `input accept TCP ether1 dst-port 1194` preserved as-is. Note: `defconf input drop !LAN` is currently DISABLED. | | |
| E-6 | Filter rules, **forward** chain, in order | Ordered rules: LAN-to-LAN accept above drop rule (`MikroTik-Config.md`); VLAN20 → VLAN30 drop; VLAN40 rules (allow DHCP, allow DNS to 192.168.40.1, drop other router access, allow MQTT to 192.168.10.13:1883/8883, allow NTP to WAN UDP/123, drop other VLAN10, drop VLAN20, drop VLAN30, default deny forward) | | |
| E-7 | FastTrack rule | `enabled`, `hw-offload=yes` | | |
| E-8 | DHCP pools, servers & networks | Pools: `default-dhcp` (192.168.88.10-254), `dhcp_pool1` (VLAN20, .20.2-254), `dhcp_pool2` (VLAN10, .10.100-254), `dhcp_pool3` (VLAN30, .30.10-99), `vpn-pool` (VPN, .30.100-200), `dhcp_pool4` (VLAN40, .40.100-199). Servers: `dhcp1` (VLAN20), `dhcp2` (VLAN10), `dhcp3` (VLAN30), `dhcp4` (VLAN40), lease-time=30m. Networks: 10.0/24 (gw .10.1), 20.0/24 (gw .20.1), 30.0/24 (gw .30.1), 40.0/24 (gw .40.1), 88.0/24 (gw .88.1) | | |
| E-9 | DNS settings | `allow-remote-requests=yes`, static DNS server `8.8.8.8`, dynamic servers `115.178.58.10, 115.178.58.26`. Static entry: `router.lan → 192.168.88.1`. Note: `aegis.internal` is ABSENT (PR #257 owns implementation) | | |
| E-10 | Interface-list membership | `WAN=ether1`, `LAN=bridge,VLAN30-Mgmt,VLAN10-Server`. *(VLAN 20 and VLAN 40 are NOT members of LAN; do not normalize during migration)* | | |
| E-11 | `/ip service` enabled set & restrictions | Enabled: telnet (23), ftp (21), www (80), ssh (22), api (8728), winbox (8291), api-ssl (8729). Disabled: www-ssl (443). Address restrictions empty (`SECURITY_HARDENING_FOLLOWUP_REQUIRED=YES`, deferred) | | |
| E-12 | OpenVPN server state | `name=ovpn-server DISABLED=YES` (port 1194 TCP, mode=ip, profile=ovpn-profiles, cert=aegis-ca, redirect-gateway=disabled). Must preserve DISABLED state during initial migration | | |
| E-13 | NTP client state | `enabled=no`, `status=stopped` | | |
| E-14 | Identity & users | `name=MikroTik`, users/groups (names only) | | |

VLAN 40 specific requirements:
- Gateway `192.168.40.1/24` on trunk sub-interface
- DHCP server (`dhcp4`), pool (`dhcp_pool4`: 192.168.40.100–199), and network options preserved
- DNS relay behavior preserved (UDP/TCP to 192.168.40.1 allowed)
- Firewall policy preserved: MQTT allowances to broker (`192.168.10.13:1883,8883`), NTP allowances to WAN UDP/123, drop other router access, drop VLAN10/20/30, default deny forward
- Interface list: must NOT be added to `LAN` interface-list during migration (preserve existing isolation)

Security boundary notes:
- `SECURITY_HARDENING_FOLLOWUP_REQUIRED=YES`: Management services (telnet, ftp, www, api, winbox) currently run without address restrictions and `defconf input drop !LAN` is disabled. This is a pre-existing finding. Do NOT attempt to harden management exposure or modify rules during PR #259 initial migration; initial cutover must achieve exact operational equivalence first.
- `PR257_DNS_SCOPE_PRESERVED=YES`: Central `aegis.internal` DNS record remains absent from live router and is owned exclusively by PR #257.

Mismatches are allowed **only** for physical interface names and switch-chip / bridge syntax, and each one must be written down.

### Step 4 — New Gigabit router preparation (offline)

1. Unbox the router. Keep it **off** the Production network: power it and connect only the Admin laptop directly.
2. Upgrade RouterOS and RouterBOOT to the stable v7 release that the step 2 export can be adapted to. Record the versions.
3. `/system reset-configuration no-defaults=yes skip-backup=yes` on the **new** device only.
4. Adapt the export: rename interfaces (`ether2` trunk → the chosen trunk port on the new model), and convert switch-chip VLAN syntax to bridge VLAN filtering if the models differ. Diff the adapted file against the original and keep the diff for review.
5. Import the adapted file with `/import file-name=… verbose=yes` and fix only syntax errors. Policy edits are forbidden in this step.
6. Set a new management credential (placeholder `<ROUTER_ADMIN_PASSWORD>` in all documentation).

### Step 5 — Isolated / offline validation

With the new router still off Production:

1. `/export` the new router and diff it against the adapted file from step 4. Differences must be expected only.
2. Fill the "New" column of the step 3 checklist. Every row must match.
3. Bench test with a spare switch or a trunk from the laptop if available, otherwise with a laptop on each access port:
   - the VLAN 30 laptop gets a DHCP lease on `192.168.30.0/24` with gateway `.1`;
   - VLAN 30 → `192.168.10.1` answers ping if the rules allow it, and forward-chain behavior matches the Old column;
   - a laptop on VLAN 20 cannot reach whatever the old rules deny;
   - a device on VLAN 40 gets DHCP on `192.168.40.0/24`, reaches broker if rules allow, and is denied other subnets.
4. Record the vendor's published routing-throughput figures for the model with firewall rules, with their source URL (design §5, criterion 3).

Exit: checklist complete, and the Human Owner signs off on the diff.

### Step 6 — Human-controlled cable cutover (Production)

Window: announced. All zones and Remote/Twingate are briefly offline.

1. Photograph the current cabling. Label the cables `WAN` and `TRUNK`.
2. Move the `WAN` cable from RB750r2 `ether1` to the new router's WAN port.
3. Move the `TRUNK` cable from RB750r2 `ether2` (switch Port 1) to the new router's trunk port.
4. Leave the RB750r2 powered **off** and configured. Do not reset it.
5. Start a 60-minute observation timer. Rollback (step 10) is allowed any time within it without further discussion.

### Step 7 — VLAN 10/20/30/40 reachability verification

| ID | Check | Pass |
|---|---|---|
| R-1 | New router `/interface ethernet monitor <trunk> once` | `1Gbps full-duplex` |
| R-2 | Admin laptop (VLAN 30) renews its DHCP lease | `192.168.30.x/24`, gateway `192.168.30.1` |
| R-3 | `ping 192.168.30.1`, `ping 192.168.10.10` | 0% loss |
| R-4 | `Test-NetConnection 192.168.10.10 -Port 443` | True |
| R-5 | Beelink → `ping 192.168.10.1`, and outbound HTTPS works | OK |
| R-6 | VLAN 20 detection laptop: same reachability as before the cutover, and denied where it was denied before | Matches step 3 |
| R-7 | VLAN 40 IDEA3 controller: renews DHCP on `192.168.40.x/24`, gateway `.1`, MQTT reachability to broker if configured, denied access to unauthorized zones | Matches step 3 |
| R-8 | Negative check: every path the old forward chain dropped is still dropped (from the E-6 list) | Matches |

### Step 8 — aegis.internal / HUB verification

1. If the RB750r2 served DNS for `aegis.internal` (P-7), run `Resolve-DnsName aegis.internal` from the VLAN 30 client and expect `192.168.10.10`. If DNS was not on the router, there is nothing new to check here. PR #257 stays the owner of that contract.
2. Browser: `https://aegis.internal/` (or the address in use) → HUB → Drive login page and Monitor login page load. The certificate warning behavior is unchanged.
3. Owner login to Drive and list files. Nothing is uploaded yet.

### Step 9 — Twingate verification

1. Beelink: `docker ps` shows `twingate-aegis-connector-02` running and not restarting (read-only).
2. Twingate Admin Console: Connector `aegis-connector-02` shows Connected.
3. From an off-site client with Twingate ON, reach the `AEGIS-Beelink-SSH` and `AEGIS-Beelink-Web` resources and open the Drive login page.
4. Public Share / cloudflared: the tunnel reports healthy, and one Share page loads (no download benchmark needed).

### Step 10 — Rollback procedure

Trigger: any R-, HUB-, or Twingate check fails and is not fixed within the observation window, or the Human Owner calls it.

1. Power off the new router.
2. Move `WAN` back to RB750r2 `ether1` and `TRUNK` back to RB750r2 `ether2`, matching the step 6 photo.
3. Power on the RB750r2 (its configuration was never changed).
4. Re-run R-2, R-3, R-4, step 8.2, and step 9.2.
5. Record the rollback reason. Before another attempt, fix the new router offline (steps 4–5) only.

If the RB750r2 itself fails to come back, restore its `.backup` from step 2 (same model), or import the step 2 text export.

### Step 11 — U2 / D1 POST-remediation quick probe

Run the PR #216 probes **unchanged** on P1 Direct LAN with Twingate OFF, using the same client if possible:

- U2: measurement plan §21.1 (the §20.1 tracer, single `U2-a` then dual `U2-b` + `U2-c`, 300,000,000 B each).
- D1: measurement plan §20.2 script.

Record: single and dual MB/s, R, `medBodyMs`/`medTailMs`/`sumGapMs`, `ttfbShareA`. Interpretation:

| Result | Meaning |
|---|---|
| Single ≫ 11 MB/s | 100 Mbps ceiling removed. The new value is the next limiter's ceiling |
| Single ≈ 11 MB/s | Ceiling not removed. Re-check P-3 / R-1 negotiated rates before anything else |
| R ≥ 1.50 above the old cap | Per-stream limiter now visible. It becomes new PR #216 evidence for its Task 2 / Task 5 gates, decided by the Human Owner |

No application change follows from this probe alone.

### Step 12 — Full PR #216 POST-FIX P1 matrix (later, separately authorized)

Run the PR #216 measurement plan's P1 Direct-LAN matrix (upload and download, 100 MB / 300 MB / 1 GB, n = 3) as the POST-FIX network-remediation baseline. Compare it against the recorded PRE-FIX values without rewriting them. Record Remote/P2 separately. It is not expected to change (design §5.1).

---

## Completion gate

- [x] Step 1 live preflight EXECUTED (2026-09-30): verified RB750r2 `ether2` 100 Mbps, Beelink 1 Gbps, Switch Port 1 100MF, Switch Ports 2/5 1000MF, VLAN 10/20/30/40 topology.
- [x] Step 2 config export and backup EXECUTED (2026-09-30): `.rsc` (9.6 KiB) and `.backup` (43.9 KiB) saved off-router, SHA-256 available, secrets scan 0 hits.
- [x] Step 3 equivalence checklist baseline EXECUTED (2026-09-30): live baseline captured across all checklist rows from export (`STEP3_RESULT=PASS`).
- [ ] Design approved (Option A) and Gigabit MikroTik model chosen by Human Owner.
- [ ] Steps 4–5 preparation and checklist fully matched and signed off.
- [ ] Step 6 cutover, steps 7–9 all pass, **or** step 10 rollback completed and recorded.
- [ ] Step 11 quick probe recorded.
- [ ] Vault updated: `Hardware-Inventory.md` (new model and port speed), `MikroTik-Config.md` (backup done, new device), plus one final task receipt.
