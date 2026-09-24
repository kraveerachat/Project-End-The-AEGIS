# IDEA3 PR11 Phase 4 T5 — Private AP Network Design

DOCUMENT_STATE: OWNER APPROVED (2026-09-18)
TASK: PR11 Phase 4 T5
SCOPE: G-01 G-02 G-03 G-04 G-06 / PF-01 PF-02
BRANCH: feat/idea3-pr11-phase4-t5-ap-network
BASE_MAIN: a68e18927ec4288c6a1cc1761cc167546b7d31b9
PRODUCTION_MUTATION: NO
NETWORK_MUTATION: NO
AP_CREATED: NO
ESP32_REQUIRED_NOW: NO

## 1. Goal

Provide the repository-side design for the Arch Core host to operate a
private 2.4 GHz Wi-Fi network used only by the IDEA3 ESP32 control plane.

T5 closes the repository gaps for AP creation, AP addressing, regulatory
verification, DHCP/Core-local DNS, and AP firewall isolation.

T5 performs no live network mutation.

## 2. Approved owner decisions

- OD-01: NetworkManager AP mode
- OD-02: WPA2-PSK
- OD-03: accept effective self-managed phy state (corrected 2026-09-24: `00`, not `TH`, live-proven; gated by p4-l3-regulatory.sh); channel must pass fresh L0 evidence
- OD-04: manual Core AP IPv4; never NetworkManager shared mode
- OD-05: ESP32 addressing by DHCP
- OD-07: dedicated IDEA3 nftables table loaded separately from the host ruleset
- OD-16: broker hostname resolved by Core-local dnsmasq

SSID, PSK, subnet, Core AP address, broker hostname and final channel remain
owner values and are not committed as live values.

## 3. Target topology

The wired interface enp62s0 is the Core uplink toward VLAN20/HUB.

The wireless interface wlp0s20f3 becomes the dedicated IDEA3 private AP and
provides:

- NetworkManager AP mode on 2.4 GHz
- manual Core AP IPv4 address
- dnsmasq DHCP
- Core-local DNS for the MQTT broker hostname
- dedicated nftables isolation
- no NAT
- no forwarding
- no default route through the AP

Before live L3, wlp0s20f3 must no longer be the only management/uplink path.
An alternate path such as Ethernet or USB tethering must already be proven.

## 4. AP and DHCP contract

The NetworkManager artifact must never use ipv4.method=shared, bridge mode,
NAT, masquerade, or automatic default-route creation.

Channels 1 through 13 were observed available on the self-managed phy (corrected 2026-09-24: its country is `00`, not `TH`).
Channel 14 was disabled. The final channel is selected only from fresh
same-window evidence.

dnsmasq must:

- serve DHCP only for the private AP
- allocate only from the owner-approved AP subnet
- provide the Core AP address as DNS
- resolve the owner-supplied broker hostname to the Core AP address
- provide no Internet gateway/router option to the ESP32
- not intentionally provide DHCP or IDEA3 DNS service on enp62s0

PF-02 requires isolated repository proof that DHCP replies cannot leak to a
non-AP interface.

## 5. Firewall and persistence contract

T5 owns only the dedicated nftables table named:

table inet aegis_idea3

T5 must never flush or replace the host ruleset and must never enable NAT or
masquerading.

The IDEA3 table must permit only the AP-side services required by the design:

- DHCP
- Core-local DNS TCP/UDP 53
- future Core-local NTP UDP/123
- MQTT TLS TCP/8883

It must explicitly DROP AP-originated plaintext MQTT TCP/1883 and DROP
forwarding from the private AP toward any uplink.

PF-01 requires an explicit negative-control test proving TCP/1883 is denied
from the AP side.

The distribution nftables.service is not selected for IDEA3 persistence.
The existing /etc/nftables.conf is a whole-ruleset artifact and must not be
enabled, replaced, flushed, or reused by T5.

A dedicated IDEA3 loader/unit will manage only table inet aegis_idea3.

## 6. Rollback

L2 rollback removes only the IDEA3 table and IDEA3 forwarding-persistence
artifact and proves forwarding remains zero.

L3 rollback deactivates and removes only the IDEA3 AP profile and restores
the pre-stage Wi-Fi state.

L4 rollback stops only the IDEA3 dnsmasq instance, removes the AP addressing
introduced by that stage, and proves DHCP/DNS no longer answers.

Rollback must not restart or alter unrelated IDEA1, IDEA2, HUB, router,
switch, or Twingate services.

## 7. Repository acceptance criteria

T5 repository completion requires proof that:

1. AP mode is rendered without shared mode, NAT, or bridge behavior.
2. AP IPv4 addressing is manual and owner-supplied.
3. regulatory/channel validation rejects unavailable channels.
4. DHCP and Core-local broker DNS are AP-scoped.
5. only the dedicated IDEA3 nftables table is managed.
6. AP-to-TCP/1883 is explicitly denied.
7. isolated dnsmasq tests prove no DHCP leakage to a non-AP interface.
8. forwarding remains disabled.
9. no live secrets or owner values are committed.
10. existing Phase 4 regression tests remain passing.

## 8. Live-stage boundary

Repository completion does not authorize L2, L3, or L4.

Each live stage requires its own fresh baseline, rollback evidence, owner
values, K3 confirmation where applicable, and explicit same-stage
authorization.

T5 does not install chrony, change live Mosquitto, start the IDEA3 Core, open
ESP32 serial, provision NVS, flash the ESP32, perform CUT/RESTORE, or perform
any Production mutation.
