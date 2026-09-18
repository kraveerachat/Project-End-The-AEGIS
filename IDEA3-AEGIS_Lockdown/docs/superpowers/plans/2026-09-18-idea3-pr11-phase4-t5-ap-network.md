# IDEA3 PR11 Phase 4 T5 AP Network Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close Phase 4 repository gaps G-01, G-02, G-03, G-04 and G-06, including PF-01 and PF-02, without changing the live Core network.

**Architecture:** Render and validate a NetworkManager private-AP profile, AP-scoped dnsmasq DHCP/Core-local DNS configuration, forwarding-disabled sysctl material, and a dedicated `table inet aegis_idea3`. All repository tests run without touching the host Wi-Fi, host firewall, NetworkManager service, dnsmasq service, ESP32, or Production.

**Tech Stack:** Python 3, pytest, NetworkManager keyfile format, dnsmasq, nftables, systemd templates, Linux user/network namespaces for isolated PF-02 validation where supported.

**Spec:** `docs/superpowers/specs/2026-09-18-idea3-pr11-phase4-t5-ap-network-design.md`

## Global Constraints

- Repository-only: no live network or service mutation.
- AP implementation is NetworkManager AP mode.
- Never use `ipv4.method=shared`.
- Never enable NAT, masquerade, bridging, or forwarding.
- ESP32 addressing is DHCP.
- MQTT broker addressing is hostname through Core-local dnsmasq.
- Firewall ownership is only `table inet aegis_idea3`.
- Never load, flush, replace, or enable `/etc/nftables.conf`.
- TCP/1883 from the AP must be explicitly denied.
- Live SSID, PSK, subnet, Core address, broker hostname and channel are not committed.
- `wlp0s20f3` is not changed during repository implementation.
- `.agents/skills/obsidian/` and `.agents/skills/vibe_coding_obsidian_sync/` remain untouched.

---

## File map

Create:

- `deploy/pr11-phase4/p4-ap-network.py`
  - validates owner-supplied non-secret network values;
  - renders repository-safe AP/DHCP/DNS/firewall/sysctl artifacts;
  - writes only to an explicitly supplied output directory;
  - never calls `nmcli`, `nft`, `systemctl`, `ip`, or `dnsmasq`.

- `deploy/network/aegis-idea3-ap.nmconnection.example`
  - canonical NetworkManager AP keyfile template.

- `deploy/network/aegis-idea3-dnsmasq.conf.example`
  - canonical AP-scoped DHCP/Core-local DNS template.

- `deploy/network/aegis-idea3-nftables-load.service.example`
  - dedicated loader contract for only `table inet aegis_idea3`.

- `deploy/network/aegis-idea3-dnsmasq.service.example`
  - dedicated dnsmasq instance contract.

- `tests/test_pr11_phase4_ap_network.py`
  - static/rendering/security tests for G-01/G-02/G-03/G-04/G-06 and PF-01.

- `tests/p4_pf02_dnsmasq_netns.py`
  - isolated namespace probe for PF-02; never operates on host interfaces.

Modify:

- `deploy/network/aegis-idea3-nftables.conf.example`
  - add DHCP/DNS allowances and explicit TCP/1883 deny while retaining no-NAT/no-forward semantics.

- `deploy/network/aegis-idea3-sysctl.conf.example`
  - retain explicit forwarding-zero contract.

- `deploy/pr11-phase4/README.md`
  - document T5 repository artifacts, renderer, namespace probe and live boundary.

No file in T5 may contain a Production SSID, PSK, live AP subnet, live broker hostname, or credential.

---

### Task 1: Lock the renderer interface with RED tests

**Files:**
- Create: `tests/test_pr11_phase4_ap_network.py`
- Create later in this task: `deploy/pr11-phase4/p4-ap-network.py`

**Interface produced:**

`p4-ap-network.py render` accepts:

- `--interface`
- `--ssid-label`
- `--channel`
- `--country`
- `--ap-address`
- `--ap-subnet`
- `--dhcp-start`
- `--dhcp-end`
- `--broker-hostname`
- `--output-dir`

The renderer must not accept the Wi-Fi PSK on argv. The AP template keeps
`<AEGIS_AP_PSK>` unresolved for the later owner-controlled live rendering step.

- [ ] Write RED tests that require:
  - rejection of channel 14 and values outside 1..13;
  - country exactly `TH` for the approved profile;
  - valid IPv4 network/address membership;
  - DHCP start/end inside the AP subnet and excluding the Core address;
  - broker hostname validation;
  - rejection of `ipv4.method=shared`, NAT, bridge and masquerade in output;
  - refusal to overwrite a non-empty output directory.

- [ ] Run:

`python -m pytest -q tests/test_pr11_phase4_ap_network.py`

Expected: FAIL because `p4-ap-network.py` does not exist.

- [ ] Implement only enough argument parsing, validation and deterministic file rendering to make these interface tests pass.

- [ ] Re-run the focused test and require PASS.

- [ ] Commit:

`git commit -m "feat(idea3): add T5 AP network renderer"`

---

### Task 2: G-01/G-02/G-03 NetworkManager AP artifact

**Files:**
- Create: `deploy/network/aegis-idea3-ap.nmconnection.example`
- Modify: `tests/test_pr11_phase4_ap_network.py`

The template contract is:

- `[connection]` type `wifi`;
- interface name supplied at render time;
- `[wifi]` mode `ap`;
- band `bg`;
- owner-selected 2.4 GHz channel;
- WPA2-PSK security;
- IPv4 method `manual`;
- never `shared`;
- never bridge/slave mode;
- never create a default route;
- IPv6 disabled for the private AP unless a later reviewed design changes it.

- [ ] Add RED tests asserting all of the above and asserting channels not
present in the approved set are rejected.

- [ ] Run focused tests and confirm RED.

- [ ] Add the template and renderer support.

- [ ] Run focused tests and require PASS.

- [ ] Commit:

`git commit -m "feat(idea3): add private AP profile contract"`

### Task 3: G-04 dnsmasq DHCP and Core-local DNS

**Files:**
- Create: `deploy/network/aegis-idea3-dnsmasq.conf.example`
- Create: `deploy/network/aegis-idea3-dnsmasq.service.example`
- Modify: `deploy/pr11-phase4/p4-ap-network.py`
- Modify: `tests/test_pr11_phase4_ap_network.py`

The generated dnsmasq configuration must:

- scope service to the AP interface;
- use the owner-approved DHCP lease range only;
- publish the Core AP address as DNS;
- resolve exactly the approved broker hostname to the Core AP address;
- not advertise an Internet router/default gateway;
- avoid upstream DNS dependency for the broker name;
- never target `enp62s0`;
- run as a dedicated IDEA3 dnsmasq instance rather than taking ownership of the distribution-wide dnsmasq service.

- [ ] Write RED tests for interface scoping, DHCP range, local broker mapping,
absence of router option, and absence of `enp62s0`.

- [ ] Run focused tests and confirm RED.

- [ ] Implement the template, dedicated-unit template and renderer support.

- [ ] Run focused tests and require PASS.

- [ ] Commit:

`git commit -m "feat(idea3): add AP DHCP and local DNS contract"`

---

### Task 4: G-06 firewall and persistence

**Files:**
- Modify: `deploy/network/aegis-idea3-nftables.conf.example`
- Create: `deploy/network/aegis-idea3-nftables-load.service.example`
- Modify: `deploy/network/aegis-idea3-sysctl.conf.example`
- Modify: `deploy/pr11-phase4/p4-ap-network.py`
- Modify: `tests/test_pr11_phase4_ap_network.py`

The rendered firewall must manage only:

`table inet aegis_idea3`

AP-side input contract:

- DHCP required traffic is accepted;
- DNS TCP/UDP 53 is accepted;
- NTP UDP/123 is reserved/accepted for T6;
- MQTT TLS TCP/8883 is accepted;
- MQTT plaintext TCP/1883 has an explicit DROP rule;
- remaining AP-originated Core input is dropped.

Forward contract:

- traffic entering from the AP is dropped;
- no NAT table;
- no masquerade;
- no forwarding enablement.

Persistence contract:

- dedicated systemd loader invokes only the IDEA3 nftables fragment;
- no `flush ruleset`;
- no `destroy table inet filter`;
- no reference that enables `/etc/nftables.conf`;
- rollback can remove only `table inet aegis_idea3`.

- [ ] Write RED tests for every firewall and persistence condition above.

- [ ] Run focused tests and confirm RED.

- [ ] Implement minimal template/renderer changes.

- [ ] Run focused tests and require PASS.

- [ ] Commit:

`git commit -m "feat(idea3): isolate T5 AP firewall persistence"`

---

### Task 5: PF-01 explicit plaintext MQTT negative control

**Files:**
- Modify: `tests/test_pr11_phase4_ap_network.py`

PF-01 is closed only when the repository test proves that the rendered rule
set contains a specific AP-interface TCP/1883 drop before the AP catch-all and
contains no competing AP-side accept for 1883.

- [ ] Add a RED test that parses the rendered nftables artifact and fails if:
  - TCP/1883 is absent;
  - TCP/1883 is accepted;
  - the explicit drop appears after an unconditional AP drop in a way that makes the intended control unobservable;
  - a NAT/masquerade rule exists.

- [ ] Run the focused test and confirm RED against the pre-task artifact.

- [ ] Make the smallest rule-order correction needed.

- [ ] Run the test and require PASS.

- [ ] Commit:

`git commit -m "test(idea3): prove AP plaintext MQTT denial"`

---

### Task 6: PF-02 isolated dnsmasq namespace proof

**Files:**
- Create: `tests/p4_pf02_dnsmasq_netns.py`
- Modify: `tests/test_pr11_phase4_ap_network.py`

The PF-02 probe must never use a real host interface.

It runs only inside a fresh Linux user+network namespace and creates two
synthetic interfaces:

- `ap-test0`
- `uplink-test0`

The probe starts a temporary dnsmasq process using a temporary rendered
configuration restricted to `ap-test0`.

The probe must prove:

- dnsmasq configuration validation passes;
- DHCP service is available on `ap-test0`;
- no DHCP reply is produced through `uplink-test0`;
- broker-name DNS resolves through the AP side only;
- all namespace processes and temporary files are removed.

If the host cannot create an unprivileged user/network namespace, the pytest
wrapper must report `PF02_ENVIRONMENT_UNAVAILABLE` and must not claim PF-02
PASS. A skipped/unavailable probe is not evidence that closes PF-02.

- [ ] Write the pytest wrapper first and require it to fail because the probe
does not yet exist.

- [ ] Add the namespace probe using only temporary namespace interfaces and
temporary files.

- [ ] Run:

`python -m pytest -q tests/test_pr11_phase4_ap_network.py -k pf02`

Expected on a capable Arch host: PASS with actual isolated proof.

Expected on an incapable environment: explicit environment-unavailable result;
do not convert that result into PASS.

- [ ] Commit only after a real PASS on the owner Arch host:

`git commit -m "test(idea3): prove DHCP isolation in network namespace"`

### Task 7: Documentation, regression and repository closeout

**Files:**
- Modify: `deploy/pr11-phase4/README.md`
- Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md`
- Create at final closeout only:
  `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/<timestamp>_music_idea3-pr11-phase4-t5-ap-network.md`

Do not create the final receipt until all repository acceptance tests have
passed. Exactly one immutable final receipt is allowed.

- [ ] Update the Phase 4 README with:
  - T5 artifacts;
  - repository-only renderer behavior;
  - PF-01 and PF-02 evidence boundaries;
  - explicit statement that no AP/network mutation occurred.

- [ ] Update canonical IDEA3 status so historical prerequisite text is not
rewritten; append the current T5 state instead.

- [ ] Run focused T5 tests:

`python -m pytest -q tests/test_pr11_phase4_ap_network.py`

- [ ] Run existing Phase 4 tests:

`python -m pytest -q tests/test_pr11_phase4_harness.py tests/test_pr11_phase4_broker_material.py tests/test_pr11_phase4_broker_validate.py tests/test_pr11_phase4_mqtt_pki.py tests/test_pr11_phase4_nvs_provision.py`

- [ ] Run the full IDEA3 suite:

`python -m pytest -q`

- [ ] Run syntax/static checks applicable to changed scripts:

`python -m compileall -q deploy/pr11-phase4 tests`

- [ ] Run repository hygiene:

`git diff --check`

- [ ] Verify no owner live values or secrets were committed by inspecting the
T5 diff and generated test fixtures.

- [ ] Record exactly one T5 final receipt containing:
  - base SHA;
  - implementation commits;
  - focused/full test counts;
  - PF-01 verdict;
  - PF-02 verdict;
  - `PRODUCTION_MUTATION=NO`;
  - `NETWORK_MUTATION=NO`;
  - `AP_CREATED=NO`;
  - `ESP32_FLASH=NO`;
  - `ESP32_NVS_WRITE=NO`;
  - remaining live gates L2/L3/L4.

- [ ] Commit repository closeout:

`git commit -m "docs(idea3): close PR11 Phase4 T5 repository work"`

- [ ] Stop for human review. Do not merge and do not start L2/L3/L4.

---

## Execution boundary

Completion of this plan means only:

`T5_REPOSITORY_IMPLEMENTED = YES`

It does not mean:

- AP is live;
- DHCP/DNS is live;
- nftables is applied;
- L2/L3/L4 passed;
- ESP32 joined;
- Phase 4 runtime is complete.

Every live stage retains its separate same-day authorization and rollback gate.
