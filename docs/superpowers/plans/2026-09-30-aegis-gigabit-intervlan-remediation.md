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

| ID | Check (read-only) | Where | Record |
|---|---|---|---|
| P-1 | `/system routerboard print`, `/system resource print` | RB750r2 (Winbox terminal / SSH from VLAN 30) | Model, RouterOS version, CPU |
| P-2 | `/interface ethernet monitor ether1,ether2 once` | RB750r2 | Negotiated rate/duplex. Expected `100Mbps full-duplex` on `ether2` |
| P-3 | `cat /sys/class/net/<iface>/speed` and `ethtool <iface>` (no settings changed) | Beelink (Human SSH) | Beelink link speed. **If 100 → stop and fix that link first** (design §2.2) |
| P-4 | Switch web UI → Port Setting page (view only) | TL-SG105E via Port 4 | Negotiated speed per port 1/2/5 |
| P-5 | `Get-NetAdapter` on the test client | Admin laptop | 1 Gbps link reconfirmed |
| P-6 | `/interface print`, `/interface vlan print`, `/interface bridge print`, `/interface bridge vlan print`, `/interface bridge port print` | RB750r2 | Exact interface/VLAN model in use |
| P-7 | `/ip address print`, `/ip route print`, `/ip dhcp-server print`, `/ip dhcp-server network print`, `/ip dns print`, `/ip dns static print` | RB750r2 | Gateways, DHCP scopes, DNS role (PR #257 dependency) |
| P-8 | `/ip firewall filter print`, `/ip firewall nat print`, `/ip firewall mangle print`, `/ip firewall address-list print` | RB750r2 | Rule list **with order** |
| P-9 | `/ip service print`, `/user print` (names only), `/tool mac-server print` | RB750r2 | Management exposure baseline |

Exit: every item recorded. P-2 confirms `ether2` at 100 Mbps, and P-3 confirms the Beelink link is 1 Gbps.

### Step 2 — Current MikroTik config export / backup

1. `/export show-sensitive=no file=aegis-rb750r2-pre-gigabit` (plain text) and `/system backup save name=aegis-rb750r2-pre-gigabit encryption=aes-sha256 password=<BACKUP_PASSWORD>` (binary, same-model restore only).
2. Download both files to Human-controlled storage outside the repository and record their SHA-256 values.
3. Grep the text export for `password=`, `secret=`, `private-key`, and `passphrase`. None may appear. If one does, handle the file as a secret and never commit it.
4. Record in the vault **only** the checksum, date, and storage location class, never the content.

This also closes the long-standing `MikroTik-Config.md` item "Export Config Backup ⏳".

### Step 3 — VLAN / gateway / firewall equivalence checklist

Build a table from the step 2 export. The new router must match every row, in the same order where order matters:

| Row | Item | Old (RB750r2) | New | Match |
|---|---|---|---|---|
| E-1 | VLAN 10/20/30 IDs on the trunk interface | from export | | |
| E-2 | Gateway IPs `192.168.10.1/24`, `192.168.20.1/24`, `192.168.30.1/24` | | | |
| E-3 | WAN addressing on `ether1` (DHCP client or static) | | | |
| E-4 | NAT masquerade rule(s) | | | |
| E-5 | Filter rules, **input** chain, in order | | | |
| E-6 | Filter rules, **forward** chain, in order (LAN-to-LAN accept above drop) | | | |
| E-7 | FastTrack rule present / absent (unchanged unless the Human Owner decides otherwise) | | | |
| E-8 | DHCP servers, pools, networks (gateway, DNS option) per VLAN | | | |
| E-9 | DNS settings (`allow-remote-requests`, static entries) | | | |
| E-10 | `/ip service` enabled set and `address=` restrictions | | | |
| E-11 | Users/groups (names only) | | | |
| E-12 | NTP / clock, identity | | | |

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
   - a laptop on VLAN 20 cannot reach whatever the old rules deny.
4. Record the vendor's published routing-throughput figures for the model with firewall rules, with their source URL (design §5, criterion 3).

Exit: checklist complete, and the Human Owner signs off on the diff.

### Step 6 — Human-controlled cable cutover (Production)

Window: announced. All zones and Remote/Twingate are briefly offline.

1. Photograph the current cabling. Label the cables `WAN` and `TRUNK`.
2. Move the `WAN` cable from RB750r2 `ether1` to the new router's WAN port.
3. Move the `TRUNK` cable from RB750r2 `ether2` (switch Port 1) to the new router's trunk port.
4. Leave the RB750r2 powered **off** and configured. Do not reset it.
5. Start a 60-minute observation timer. Rollback (step 10) is allowed any time within it without further discussion.

### Step 7 — VLAN 10/20/30 reachability verification

| ID | Check | Pass |
|---|---|---|
| R-1 | New router `/interface ethernet monitor <trunk> once` | `1Gbps full-duplex` |
| R-2 | Admin laptop (VLAN 30) renews its DHCP lease | `192.168.30.x/24`, gateway `192.168.30.1` |
| R-3 | `ping 192.168.30.1`, `ping 192.168.10.10` | 0% loss |
| R-4 | `Test-NetConnection 192.168.10.10 -Port 443` | True |
| R-5 | Beelink → `ping 192.168.10.1`, and outbound HTTPS works | OK |
| R-6 | VLAN 20 detection laptop: same reachability as before the cutover, and denied where it was denied before | Matches step 3 |
| R-7 | Negative check: every path the old forward chain dropped is still dropped (from the E-6 list) | Matches |

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

- [ ] Design approved (Option A) and model chosen.
- [ ] Steps 1–3 recorded, and step 2 artifacts stored outside the repo.
- [ ] Steps 4–5 checklist fully matched and signed off.
- [ ] Step 6 cutover, steps 7–9 all pass, **or** step 10 rollback completed and recorded.
- [ ] Step 11 quick probe recorded.
- [ ] Vault updated: `Hardware-Inventory.md` (new model and port speed), `MikroTik-Config.md` (backup done, new device), plus one final task receipt.
