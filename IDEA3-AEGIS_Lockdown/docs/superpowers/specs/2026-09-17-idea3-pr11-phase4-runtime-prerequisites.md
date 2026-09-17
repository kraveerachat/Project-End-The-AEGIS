# AEGIS IDEA3 PR11 Phase 4 — Live Runtime Prerequisite Reconciliation

> **Status:** current execution document, repository-only. It is **not** a
> task receipt, and it authorizes no live action. It reconciles the Phase 4
> Protocol v1 repository package with the owner-run read-only Core evidence
> P4-E1 to P4-E3. It then states:
>
> - what is proven;
> - which owner values and decisions are missing;
> - which repository gaps block a safe rollout;
> - the staged, rollback-safe order for a later, separately authorized live
>   rollout.
>
> Area / owner: `idea3` / `music`
>
> Branch: `feat/idea3-pr11-phase4-runtime-prereqs`, created from `origin/main`
> `232759cf4e44094c61f15e3d041c09eb1478b42c`
>
> Authorities:
>
> - `2026-09-15-idea3-pr11-phase4-protocol-v1-design.md` (the "design"), and
>   its plan;
> - `docs/operations/production-runtime.md`;
> - `deploy/mosquitto/*`, `deploy/network/*`, `deploy/chrony/*`;
> - `deploy/aegis-idea3-core.env.example` and
>   `deploy/aegis-idea3-core.service.example`;
> - `tests/test_private_ap_contract.py`, `tests/test_broker_config.py`, and
>   `tests/test_broker_loopback.py`;
> - `firmware/src/main.cpp`;
> - the IDEA3 canonical status note.
>
> Where this document and the design differ, the design governs.

```text
P4_PREREQ_RECONCILIATION        = COMPLETE — T0 closed (repository-only; this document)
P4_PREREQ_CONTENT_REVIEW        = PASS (PR #151 Human Content Review, 2026-09-17)
PHASE4_REPOSITORY_PACKAGE       = MERGED (PR #135, f0a87ee1)
PHASE4_LIVE_READINESS           = NOT READY — owner values, owner decisions, and repository gaps outstanding
LIVE_MUTATION_AUTHORIZED        = NO
PRODUCTION_MUTATION_AUTHORIZED  = NO
PRODUCTION_MUTATION (this task) = NO
K3                              = OWNER_CONFIRMATION_REQUIRED before any Phase 4 Production mutation (§8)
PHASE3_DEPENDENCY               = YES for the Core-install stage only — PR #149 (Draft, unmerged) (§7)
PHASE2_RUNTIME_COMPLETE         = YES (unchanged)
PHASE3_RUNTIME_COMPLETE         = NO
PHASE4_RUNTIME_COMPLETE         = NO
D4_LIVE_VERIFIED                = NO
K12                             = NOT_PROVEN
IDEA2_PROCESS_ACTIVE            = YES (engine and tunnel units report active; OWNER-RUN)
IDEA2_TUNNEL_HEALTHY            = NO  (tunnel flapping, NRestarts > 1450; §2.3)
IDEA2_RUNTIME_HEALTHY           = NO  (Detection Engine heartbeat fails; §2.3) — not an IDEA3 claim or fix
IDEA2_PRESERVATION_BASELINE     = CAVEATED — §10 IDEA2 check cannot pass as written (§2.3, §10)
OWNER_DECISIONS                 = OD-01..OD-17 (OD-15 optional hardening; OD-16, OD-17 added) — none chosen
TASK_SPLIT                      = T0..T9 recorded (§14); T0 COMPLETE; T1 REPOSITORY CLOSEOUT COMPLETE; T2..T9 NOT STARTED
T1_G15_FRAMEWORK                = CLOSED — repository boundary only; implementation/evidence checkpoint 9c82e4a0; PR #152 human review PASS; live rollout NOT RUN; human merge pending
FINAL_RECEIPT                   = Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-09-17_043011_music_idea3-pr11-phase4-runtime-prereqs-t0.md
```

`PROCESS_ACTIVE != TUNNEL_HEALTHY != IDEA2_RUNTIME_HEALTHY`. A systemd unit in
`ActiveState=active` proves only that a process is running at that moment. It
is not evidence of a healthy tunnel, and neither is evidence of a healthy IDEA2
runtime.

## 1. Rules this document obeys

- **Design §16 values stay deferred.** This document records no invented SSID,
  PSK, AP subnet, gateway, channel, broker hostname, SAN, `device_id`, MAC,
  serial port, password, PIN, HMAC key, certificate, or key-file location.
  Every such value is an **owner value** (§5). Historical SSIDs, IPs, VLAN40,
  and broker addresses are not authority for Phase 4 and are not reused.
- **Undetermined choices go to the owner.** Where the binding architecture
  does not choose between two implementations (for example NetworkManager AP
  mode or hostapd, DHCP or static addressing), the choice is recorded as
  `OWNER_DECISION_REQUIRED`. Nothing is selected silently.
- **Evidence classes.**
  - `OWNER-RUN`: the owner ran a read-only command on the Core and reported its
    output. The agent did not observe the Core directly.
  - `REPO`: the agent verified the fact against source at `232759cf`.
  - `GITHUB`: the agent read the fact from GitHub during this session
    (2026-09-17).

## 2. Current read-only evidence

### 2.1 Owner-run Core evidence (P4-E1, P4-E2, P4-E3)

| # | Fact | Class |
|---|---|---|
| E-01 | Wi-Fi interface `wlp0s20f3`, driver `iwlwifi` | OWNER-RUN |
| E-02 | The adapter supports the `AP` and `AP/VLAN` interface modes; a valid interface combination includes one AP | OWNER-RUN |
| E-03 | Wi-Fi is rfkill **soft**-blocked; hard block = NO | OWNER-RUN |
| E-04 | The phy regulatory domain is `TH` (self-managed); the global regulatory domain is still `00` | OWNER-RUN |
| E-05 | NetworkManager is active/running | OWNER-RUN |
| E-06 | Physical Core interface `enp62s0` = `192.168.20.254/24` (VLAN20) | OWNER-RUN |
| E-07 | Physical route to the AEGIS Server: `192.168.10.10 via 192.168.20.1 dev enp62s0` (Twingate stopped for this evidence) | OWNER-RUN |
| E-08 | ESP32 USB/serial device: NOT PRESENT | OWNER-RUN |
| E-09 | Mosquitto 2.1.2. Current broker: `listener 1883` wildcard IPv4/IPv6, `allow_anonymous false`, `password_file /etc/mosquitto/passwd` | OWNER-RUN |
| E-10 | The only existing broker username is `aegis` | OWNER-RUN |
| E-11 | Established MQTT 1883 clients at snapshot time: NONE | OWNER-RUN |
| E-12 | No `listener 8883` | OWNER-RUN |
| E-13 | IDEA2 `aegis-detection-engine` and `aegis-detection-tunnel` reported `ActiveState=active`, before and after. This is **unit/process state only**; it did not measure restarts, tunnel forwards, or heartbeat, and is not a health or preservation claim (superseded in scope by §2.3) | OWNER-RUN |
| E-14 | `hostapd` package ABSENT; `chrony` package ABSENT | OWNER-RUN |
| E-15 | `dnsmasq` 2.93 installed, service inactive | OWNER-RUN |
| E-16 | `nftables` 1.1.7 installed, service inactive; no nftables tables present; no `table inet aegis_idea3` | OWNER-RUN |
| E-17 | IPv4 forwarding = 0; IPv6 forwarding = 0 | OWNER-RUN |
| E-18 | Core system clock synchronized; `systemd-timesyncd` has an active upstream NTP server | OWNER-RUN |
| E-19 | No AP IPv4 address exists; the only visible live local subnet is `192.168.20.0/24` via `enp62s0` | OWNER-RUN |

These facts come from the P3 Core preflight on PR #149 (2026-09-17). They are
recorded here because they affect Phase 4:

| # | Fact | Class |
|---|---|---|
| E-20 | Arch Linux, systemd 261.2 | OWNER-RUN (PR #149) |
| E-21 | Root filesystem 59 G, 53 G used, 3.8 G available (94 %) | OWNER-RUN (PR #149) |
| E-22 | The `aegis-idea3` user and group exist. `/etc/aegis-idea3` and `/etc/aegis-idea3/pki` exist. `/opt/aegis-idea3/current`, `/var/lib/aegis-idea3`, `/run/aegis-idea3`, and `/var/log/aegis-idea3` do not exist | OWNER-RUN (PR #149) |
| E-23 | These files are absent: `/etc/aegis-idea3/pki/mqtt-ca.crt`, `/run/credentials/aegis-idea3-core.service/k_c2d` and `k_d2c`, and `/etc/aegis-idea3/credentials/restore.credential` | OWNER-RUN (PR #149) |
| E-24 | `aegis-idea3-core.service` is not installed | OWNER-RUN (PR #149) |

### 2.2 Repository facts (REPO, `232759cf`)

| # | Fact | Source |
|---|---|---|
| R-01 | The sysctl template disables IPv4/IPv6 forwarding, including on `<AEGIS_AP_INTERFACE>` | `deploy/network/aegis-idea3-sysctl.conf.example` |
| R-02 | The nftables template is `table inet aegis_idea3`. Its input chain has policy **accept**. On `<AEGIS_AP_INTERFACE>` it accepts only UDP/123 and TCP/8883 from `ip saddr <AEGIS_AP_SUBNET>` and drops everything else. The forward chain has policy drop. There is no NAT | `deploy/network/aegis-idea3-nftables.conf.example` |
| R-03 | The chrony template has `bindaddress <AEGIS_AP_ADDRESS>` and `allow <AEGIS_AP_SUBNET>`. It deliberately does not define upstream time | `deploy/chrony/aegis-idea3-chrony.conf.example` |
| R-04 | The broker template is a full standalone config: global `per_listener_settings false`, `persistence false`, `retain_available false`, one `password_file`/`acl_file`, and exactly two TLS 1.2 listeners on 8883 (`127.0.0.1` and `<AEGIS_AP_ADDRESS>`). There is no 1883 listener | `deploy/mosquitto/aegis-idea3-mosquitto.conf.example` |
| R-05 | The ACL is the exact two-identity matrix for `idea3-core` / `idea3-dev-<device_id>`, with the placeholder `device-id` | `deploy/mosquitto/aegis-idea3-mosquitto.acl.example` |
| R-06 | The Core env example has `AEGIS_BROKER_IP=` (blank), port 8883, TLS on, CA `/etc/aegis-idea3/pki/mqtt-ca.crt`, user `idea3-core`, `AEGIS_MQTT_PASS=` (an inline value), and key files at `/run/credentials/aegis-idea3-core.service/k_c2d` / `k_d2c`. It also sets `AEGIS_ADMIN_PIN=` (an inline value) and `AEGIS_RESTORE_CREDENTIAL_FILE` | `deploy/aegis-idea3-core.env.example` |
| R-07 | The Core unit has `EnvironmentFile=/etc/aegis-idea3/core.env` and `ReadOnlyPaths=/etc/aegis-idea3`. It has **no** `LoadCredential=`, `LoadCredentialEncrypted=`, or `SetCredential=` directive | `deploy/aegis-idea3-core.service.example` |
| R-08 | Production preflight refuses: MQTT without TLS, port 1883, a missing or unreadable CA, an empty Core username or password, a Core username beginning `idea3-dev-`, an invalid `device_id`, missing or unsafe key files, a v1 store under `/run`, the default Admin PIN `1234`, and an unsafe D4 credential when one is configured | `aegis_soc/runtime.py`, `aegis_soc/protocol_runtime.py` |
| R-09 | The Core TLS client uses `check_hostname=True` and `CERT_REQUIRED` against `AEGIS_BROKER_IP`. The broker certificate must therefore carry a SAN that matches exactly the host string the Core uses | `aegis_soc/mqtt_client.py` |
| R-10 | Key loading refuses a key file that is not exactly 64 lowercase hex characters, is all zeros, is a test/demo digest, or has `C2D == D2C`. It does **not** check file owner or mode | `aegis_soc/protocol_v1.py` |
| R-11 | The Admin PIN is read only from the `AEGIS_ADMIN_PIN` environment value, hashed in memory with unsalted SHA-256. There is no PIN-file option | `aegis_soc/config.py` |
| R-12 | Firmware (`board = esp32dev`) reads NVS namespace `aegis-p1`, `schema == 1`: `device_id`, `wifi_ssid`, `wifi_psk`, `broker`, `mqtt_user`, `mqtt_pass`, `ntp`, `k_c2d`, `k_d2c`, `seq_hi`. The repository has **no** tool or procedure that writes this NVS | `firmware/src/main.cpp` |
| R-13 | Firmware Wi-Fi is `WIFI_STA` + `WiFi.begin(ssid, psk)` with no `WiFi.config(...)`, so it can only obtain its address by **DHCP**. In `setup()` it blocks in `while (WiFi.status() != WL_CONNECTED) delay(500)` while the relay holds its boot CUT output | `firmware/src/main.cpp` |
| R-14 | Firmware TLS uses `WiFiClientSecure::setCACert(SECRET_MQTT_CA_CERT)`. The CA is compiled in from git-ignored `secrets.h`, not read from NVS. It connects to the NVS `broker` string on port 8883 | `firmware/src/main.cpp`, `firmware/src/secrets.h.example` |
| R-15 | The isolated broker test uses only throwaway `tmp_path` certificates and passwords on loopback | `tests/test_broker_loopback.py` |
| R-16 | Design rollback (§14) covers only the Core: stop the Core, and the device fails secure through the dead-man switch. The repository has no per-stage AP/NTP/firewall/broker rollback | design §14, `production-runtime.md` |
| R-17 | Design/source drift: merged design §4.6 says the firmware reads its keys from the git-ignored `secrets.h`. Current firmware reads `k_c2d`/`k_d2c` from NVS namespace `aegis-p1` (R-12); `secrets.h` holds only the public MQTT CA and an NTP bootstrap placeholder. The **source** is the current implementation; the merged design is not rewritten (§6.1 PF-04) | design §4.6, `firmware/src/main.cpp`, `firmware/src/secrets.h.example` |
| R-18 | The IDEA2 Linux tunnel unit generated by the installer uses `Restart=always`, `RestartSec=5`, `ExitOnForwardFailure=yes`, a local forward `127.0.0.1:18002 → 172.18.0.2:8002`, and a reverse forward to local Engine `:8077`. It sets no start-rate limit and no SSH `ConnectTimeout` | `IDEA2-AEGIS_CCTV-Operator/detection-engine/linux/install_systemd.sh` (read only; not modified) |

### 2.3 IDEA2 preservation caveat (OWNER-RUN, 2026-09-17)

New owner-run read-only evidence from the Core host. The Core host is also the
IDEA2 Detector B edge host.

| # | Fact | Class |
|---|---|---|
| E-25 | `aegis-detection-engine.service` process is running, `NRestarts=0` | OWNER-RUN |
| E-26 | `aegis-detection-tunnel.service` is `active` but unhealthy: it is flapping under `Restart=always` / `RestartSec=5s` | OWNER-RUN |
| E-27 | `aegis-detection-tunnel.service` `NRestarts` observed > 1450 | OWNER-RUN |
| E-28 | Physical VLAN20 ICMP to `192.168.10.10` passes | OWNER-RUN |
| E-29 | SSH to `192.168.10.10:22` times out | OWNER-RUN |
| E-30 | `127.0.0.1:18002` (the local Monitor forward) is absent | OWNER-RUN |
| E-31 | Local Engine `:8077` is listening | OWNER-RUN |
| E-32 | The Detection Engine heartbeat therefore fails with connection refused | OWNER-RUN |

```text
IDEA2_PROCESS_ACTIVE   = YES (engine running, NRestarts=0; tunnel unit active)
IDEA2_TUNNEL_HEALTHY   = NO  (flapping; SSH :22 timeout; :18002 absent)
IDEA2_RUNTIME_HEALTHY  = NO  (heartbeat connection refused)
ROOT_CAUSE             = NOT DIAGNOSED — no Server-side evidence yet (§15)
```

Consequences for this document:

- E-13 and M-10 prove only process/unit state. They are not a healthy or
  preserved IDEA2 runtime baseline.
- The §10 IDEA2 preservation check ("same MainPID, no restart") cannot pass
  for the tunnel while it flaps. Every Phase 4 live stage would stop under
  S-03 (§10).
- The regression is outside IDEA3 ownership and is **not** diagnosed or fixed
  by this task or any Phase 4 branch (§15).

## 3. Readiness matrix

The classes are:

- `DISCOVERED_AND_PROVEN`: owner-run read-only evidence exists and needs no
  further owner value.
- `OWNER_VALUE_REQUIRED`: a secret or deployment value the owner supplies; it
  is never generated or guessed by an agent.
- `OWNER_DECISION_REQUIRED`: the architecture leaves two or more valid
  implementations, and the owner chooses.
- `REPOSITORY_GAP`: a missing or incorrect repository template, procedure,
  source, or test. It must be closed by a reviewed PR before the dependent live
  stage.
- `LIVE_MUTATION_REQUIRED`: a Core host change that needs fresh explicit
  authorization.
- `BLOCKED_BY_LATER_GATE`: it cannot start until an earlier stage, hardware,
  D4, Phase 3, or K12 gate closes.

An item may carry more than one class. The **primary** class is listed first.

| ID | Item | Primary class | Also | Basis |
|---|---|---|---|---|
| M-01 | Wi-Fi adapter AP capability | DISCOVERED_AND_PROVEN | — | E-01, E-02 |
| M-02 | No hardware rfkill block | DISCOVERED_AND_PROVEN | — | E-03 |
| M-03 | Soft rfkill unblock | LIVE_MUTATION_REQUIRED | — | E-03 |
| M-04 | NetworkManager present and active | DISCOVERED_AND_PROVEN | — | E-05 |
| M-05 | VLAN20 address and physical route to the Server | DISCOVERED_AND_PROVEN | preservation baseline §10 | E-06, E-07 |
| M-06 | Forwarding disabled at runtime | DISCOVERED_AND_PROVEN | persistence is LIVE_MUTATION_REQUIRED | E-17, R-01 |
| M-07 | No existing nftables ruleset or IDEA3 table | DISCOVERED_AND_PROVEN | — | E-16 |
| M-08 | Core clock synchronized | DISCOVERED_AND_PROVEN | — | E-18 |
| M-09 | Existing plaintext broker state (1883, `aegis`, no clients at snapshot) | DISCOVERED_AND_PROVEN | preservation baseline §10 | E-09 to E-12 |
| M-10 | IDEA2 unit/process state (`ActiveState=active`) — process state only, **not** tunnel or runtime health | DISCOVERED_AND_PROVEN (process state only) | preservation baseline §10 is CAVEATED (§2.3) | E-13, E-25, E-26 |
| M-39 | IDEA2 Detector B tunnel and heartbeat health | BLOCKED_BY_LATER_GATE (outside IDEA3 ownership; IDEA2/infrastructure) | blocks a passing §10 IDEA2 check for every live stage | E-26 to E-32 |
| M-11 | Mosquitto 2.1.2 and dnsmasq 2.93 binaries present | DISCOVERED_AND_PROVEN | — | E-09, E-15 |
| M-12 | AP implementation (NetworkManager AP mode or hostapd) | OWNER_DECISION_REQUIRED | REPOSITORY_GAP G-01; LIVE_MUTATION_REQUIRED | E-05, E-14 |
| M-13 | AP SSID and PSK, and security mode | OWNER_VALUE_REQUIRED | OWNER_DECISION_REQUIRED (security mode) | design §16 |
| M-14 | Regulatory domain, band, and channel | OWNER_DECISION_REQUIRED | REPOSITORY_GAP G-03; more read-only evidence (§9 L0) | E-04 |
| M-15 | AP subnet and Core AP address (also NTP and broker address) | OWNER_VALUE_REQUIRED | REPOSITORY_GAP G-02 | design §16, E-19 |
| M-16 | ESP32 address model (DHCP or static) | OWNER_DECISION_REQUIRED | REPOSITORY_GAP G-04 (both options) | R-13 |
| M-17 | Local NTP serving (implementation, upstream, timesyncd handoff) | OWNER_DECISION_REQUIRED | REPOSITORY_GAP G-05; LIVE_MUTATION_REQUIRED (chrony absent) | E-14, E-18, R-03 |
| M-18 | AP firewall isolation | REPOSITORY_GAP | OWNER_DECISION_REQUIRED (persistence); LIVE_MUTATION_REQUIRED | R-02, G-06 |
| M-19 | TLS Mosquitto 8883 on the live broker | REPOSITORY_GAP | OWNER_DECISION_REQUIRED (1883 coexistence); LIVE_MUTATION_REQUIRED | R-04, E-09, G-07 |
| M-20 | Dedicated MQTT CA lifecycle | REPOSITORY_GAP | OWNER_DECISION_REQUIRED (custody); OWNER_VALUE_REQUIRED | design §8.1, G-08 |
| M-21 | Broker hostname or IP literal, and SANs | OWNER_DECISION_REQUIRED | OWNER_VALUE_REQUIRED; validation gap G-09 | R-09, R-14 |
| M-22 | Core and device broker identities, passwords, and ACL | OWNER_VALUE_REQUIRED | REPOSITORY_GAP G-10 | R-05, R-06 |
| M-23 | `device_id` | OWNER_VALUE_REQUIRED | BLOCKED_BY_LATER_GATE (device not present) | E-08 |
| M-24 | Protocol v1 keys `K_C2D` / `K_D2C` | OWNER_VALUE_REQUIRED | REPOSITORY_GAP G-11 (generation and dual provisioning) | design §4.6, R-10, R-12 |
| M-25 | Core runtime credential delivery | REPOSITORY_GAP | OWNER_DECISION_REQUIRED (locations and permissions) | R-06, R-07, G-12 |
| M-26 | Non-default Admin PIN | OWNER_VALUE_REQUIRED | repository support present, with limitation G-13 | R-08, R-11 |
| M-27 | D4 RESTORE credential for first Core start | OWNER_DECISION_REQUIRED | LIVE_MUTATION_REQUIRED | R-06, R-08, E-23 |
| M-28 | Isolated live-material broker validation | REPOSITORY_GAP | LIVE_MUTATION_REQUIRED (temporary process) | R-15, G-14 |
| M-29 | Per-stage rollback | REPOSITORY_GAP | this document supplies plan-level rollback (§9) | R-16, G-15 |
| M-30 | Disk headroom for packages and release | OWNER_DECISION_REQUIRED | STOP condition S-09 | E-21 |
| M-31 | Phase 3 Core unit correction (PR #149) | BLOCKED_BY_LATER_GATE | §7 | GITHUB |
| M-32 | K3 IDEA1 non-overlap | OWNER_VALUE_REQUIRED (fresh confirmation) | §8 | GITHUB |
| M-33 | ESP32 passive inspection, NVS provisioning, flash | BLOCKED_BY_LATER_GATE | REPOSITORY_GAP G-11/G-16; OWNER_VALUE_REQUIRED (serial port, MAC) | E-08, R-12 |
| M-34 | Maintenance window and relay CUT impact of flashing | OWNER_VALUE_REQUIRED | BLOCKED_BY_LATER_GATE (D4) | design §10, §16 |
| M-35 | CUT test | BLOCKED_BY_LATER_GATE | fresh separate authorization | design §12 |
| M-36 | RESTORE (D4 `aegisctl restore`) live | BLOCKED_BY_LATER_GATE | D4 credential provisioning | design §9 |
| M-37 | Removal of the plaintext 1883 listener | BLOCKED_BY_LATER_GATE | OWNER_DECISION_REQUIRED (consumers of `aegis`) | production-runtime.md cutover order |
| M-38 | K12 reboot persistence | BLOCKED_BY_LATER_GATE | — | design §16 |

## 4. Repository support determination

`COMPLETE` means the repository alone determines a safe, reviewable live
artifact once owner values are known. `PARTIAL` means a template or code
exists, but a known defect or missing procedure would make a live stage unsafe
or unverifiable. `ABSENT` means no repository artifact exists.

| Capability | Repository support | Determination |
|---|---|---|
| AP creation | **ABSENT** | There is no NetworkManager connection profile, `hostapd.conf` template, or procedure. hostapd is not installed (E-14). The architecture (D1) requires a Core-hosted AP but does not choose the implementation → OD-01. **Constraint for either choice:** NetworkManager `ipv4.method=shared` enables IPv4 forwarding and NAT for the AP. That contradicts R-01/R-02 and must not be used. |
| AP address assignment | **ABSENT** | The templates use `<AEGIS_AP_ADDRESS>`/`<AEGIS_AP_SUBNET>` placeholders only. There is no address-assignment artifact → G-02, OD-04. |
| DHCP vs static ESP32 addressing | **PARTIAL (DHCP-only firmware; no server artifact)** | The firmware can only use DHCP (R-13). DHCP needs a DHCP server artifact that does not exist, and a firewall amendment: R-02 drops UDP/67, and a DHCP DISCOVER from `0.0.0.0` does not match `ip saddr <AEGIS_AP_SUBNET>` anyway. Static addressing needs a firmware change plus a new NVS field. Either way is a repository gap → OD-05, G-04. |
| Regulatory/channel configuration | **ABSENT** | There is no regulatory, country, band, or channel artifact. The phy is self-managed `TH` while global is `00` (E-04), and the effective AP channel flags are not yet read → L0 evidence, OD-03. The `esp32dev` target is a 2.4 GHz-only radio, so the AP must offer 2.4 GHz; the channel stays an owner decision. |
| Local NTP serving | **PARTIAL** | The chrony AP-binding template exists (R-03). There is no upstream-source configuration, no timesyncd→chrony handoff procedure, and no check that the Core `TrustedClock` stays `SYNCED` across the handoff. chrony is absent (E-14). The upstream design (D1) does not bind the server implementation → OD-06, G-05. |
| AP firewall isolation | **PARTIAL** | The template is correct for NTP/MQTT isolation and no forwarding (R-02), but: (a) it blocks DHCP (and DNS, if a hostname is chosen); (b) there is no persistence or load procedure; (c) enabling a distribution `nftables.service` loads `/etc/nftables.conf` as a whole ruleset, and that file's contents on the Core are not yet read (L0) → G-06, OD-07. |
| TLS Mosquitto 8883 | **PARTIAL** | The standalone TLS template exists and is tested statically and on isolated loopback. There is no procedure to add it to the **live** broker, which serves plaintext 1883 with user `aegis` (E-09). With `per_listener_settings false`, one global `acl_file` applies to both listeners. An exact-topic ACL that does not list `aegis` would deny that user every topic on 1883, and global `persistence false`/`retain_available false` would also change 1883 behavior → G-07, OD-08. |
| Dedicated MQTT CA lifecycle | **ABSENT** | The design requires a dedicated MQTT CA, separate from the K10 machine-client CA and the HUB browser CA (§8.1). There is no generation, custody, validity, SAN, rotation, or revocation procedure. Only test throwaway PKI exists → G-08, OD-09. |
| Core/device broker identities + ACL | **PARTIAL** | Identity names, preflight, and the ACL matrix exist (R-05, R-08). There is no rendering procedure for `device-id` → `<device_id>`, and no password-file creation procedure that avoids passwords in shell history or process arguments → G-10. |
| Protocol v1 keys | **PARTIAL** | The Core loader and its refusal rules exist (R-10), and the firmware NVS reader exists (R-12). There is no procedure to generate two independent 32-byte keys once and deliver identical bytes to both the Core key files and ESP32 NVS, and no NVS provisioning tool → G-11. |
| Core runtime credential delivery | **INCORRECT / ABSENT** | The env example points both key files at `/run/credentials/aegis-idea3-core.service/` (R-06), but the unit has no `LoadCredential=` (R-07). systemd would never create those files, so a production live start fails preflight. The MQTT password and Admin PIN are inline environment values in `core.env`. There is no file- or credential-based option → G-12, OD-10. |
| Non-default Admin PIN | **COMPLETE (with limitation)** | Preflight refuses the default PIN (R-08). The value is an owner secret delivered inline in `core.env`, hashed in memory with unsalted SHA-256 (R-11) → G-13 (LOW), OD-11. |
| Isolated broker validation | **PARTIAL** | The throwaway loopback test exists (R-15). There is no procedure to validate the **rendered** live config and live material in an isolated Mosquitto process: a non-production loopback port, no touch to `mosquitto.service`, no residue → G-14. |
| Rollback | **PARTIAL** | Only the Core-stop rollback exists (R-16). §9 of this document gives plan-level rollback per stage. There are no reviewed rollback scripts or capture/restore harness → G-15. |

## 5. Owner values and owner decisions required

No value below is proposed. Each is supplied or chosen by the owner, recorded
outside Git when it is secret, and confirmed in writing before its stage.

### 5.1 Owner values (never generated, guessed, or committed by an agent)

| ID | Value | Needed by stage |
|---|---|---|
| OV-01 | AP SSID | L3 |
| OV-02 | AP PSK (secret) | L3 |
| OV-03 | AP subnet and Core AP address (must not overlap VLAN20 `192.168.20.0/24`, the Server path, the IDEA3 Docker `/29`, or any Twingate-assigned range) | L2, L4 |
| OV-04 | Channel and country (after L0 evidence) | L3 |
| OV-05 | Broker hostname or IP literal, and the broker certificate SAN list | L6 |
| OV-06 | MQTT CA subject, validity, and key custody location | L6 |
| OV-07 | Core broker password and device broker password (secrets) | L6 |
| OV-08 | `device_id` (must match `[a-z0-9][a-z0-9-]{1,30}[a-z0-9]`) | L6, L8 |
| OV-09 | `K_C2D` and `K_D2C` (secrets, generated once on an owner-controlled host) | L7, L8 |
| OV-10 | Key-file, password-file, and credential host locations and permissions | L6, L7 |
| OV-11 | Admin PIN (secret) | L7 |
| OV-12 | ESP32 MAC and serial port | L8 |
| OV-13 | Maintenance window(s) and announcement | every live stage |
| OV-14 | Fresh K3 non-overlap confirmation | every Production mutation stage |

### 5.2 Owner decisions (architecture does not determine them)

| ID | Decision | Options visible from evidence (none selected) |
|---|---|---|
| OD-01 | AP implementation | NetworkManager AP mode, or hostapd (package absent). If NetworkManager is chosen, `ipv4.method=shared` is excluded (§4). |
| OD-02 | AP security mode | Must be supported by the ESP32 Arduino-ESP32 2.0.17 station. Any mode other than WPA2-PSK needs compile and device validation before use. |
| OD-03 | Regulatory handling | Accept the self-managed phy `TH`, or reconcile the global domain. The channel is chosen only after reading the effective channel flags (L0). |
| OD-04 | AP address assignment mechanism | Tied to OD-01. |
| OD-05 | ESP32 addressing | DHCP (the current firmware; needs a DHCP server artifact and a firewall amendment) or static (needs a firmware change and an NVS field). |
| OD-06 | Core-local NTP server and upstream | chrony per the template (replaces the timesyncd upstream role), or another server that can serve NTP. The upstream source for the Core must stay trusted. |
| OD-07 | nftables persistence | Load the dedicated table from a reviewed file under a dedicated unit, or enable the distribution service after reviewing `/etc/nftables.conf`. Flushing the whole ruleset is never allowed. |
| OD-08 | Broker topology and the 1883 listener | Keep 1883 alongside 8883 during migration (the global ACL must then list `aegis` explicitly, or 1883 must move to a separate instance), or run a separate TLS-only broker instance. The later fate of 1883 and user `aegis` needs a consumer inventory. |
| OD-09 | MQTT CA custody | Where the CA key is generated and held; validity; rotation and revocation. It is distinct from K10 and the HUB CA. |
| OD-10 | Core credential delivery form | systemd `LoadCredential=` from root-owned files, or `LoadCredentialEncrypted=`, for the keys, and whether the MQTT password moves out of `core.env`. Repository work (G-12) follows the decision. |
| OD-11 | Admin PIN delivery | Accept the inline `core.env` value, or require a file-based option (G-13). |
| OD-12 | D4 credential at first Core start | Provision the D4 credential before the first start, or leave `AEGIS_RESTORE_CREDENTIAL_FILE` blank. A blank value means no RESTORE path exists while the device holds CUT. |
| OD-13 | Disk headroom | Remediation before any package or release install (E-21). |
| OD-14 | Flash and interim recovery procedure | Needs the D4 dependency, or a separately authorized interim procedure (design §10). |
| OD-15 | ESP32 flash/NVS encryption | **OPTIONAL HARDENING / OWNER DECISION — NOT A PHASE 4 BLOCKER.** NVS is not protected by an IDEA3 NVS-encryption requirement in the current PR11 design. Physical extraction risk therefore remains an optional hardening concern. No current PR11 acceptance criterion makes NVS encryption mandatory (searched: Phase 4 design, plan, and firmware docs, 2026-09-17). It affects the T8 provisioning behavior only if chosen. |
| OD-16 | Broker addressing/name profile | Links, as one decision: ESP32 addressing (OD-05, DHCP or static); DNS availability on the AP (the ESP32 has no hosts file, so a broker hostname needs a DNS answer on the AP, which also changes G-04/G-06); the Core hostname verification string (R-09); the broker certificate SAN (G-08); and the ESP32 NVS `broker` value (R-12, R-14). An IP-literal choice additionally requires G-09 proof on a physical ESP32. Options visible, none selected: a hostname served by Core-local DNS on the AP, or an IP literal with an IP SAN. It supersedes nothing in M-21/OV-05; it records that they cannot be chosen independently. |
| OD-17 | PR #149 / G-12 integration strategy | PR #149 and the G-12 fix both change `deploy/aegis-idea3-core.service.example`. PR #149 targets Phase 3 live runtime, while a production live Core start needs the MQTT CA, broker password, and key files that Phase 4 provides (R-08), so the two cannot finish independently. Options visible, none selected: merge a repository-only slice of PR #149 first and base G-12 on `main`; or an explicitly authorized stacked G-12 PR on the PR #149 branch; or a combined reconciliation. Stacked PRs are not created without explicit authorization. |

## 6. Repository gaps

A gap marked **BLOCKING** must be closed by a reviewed, merged PR before its
stage. The PR is inside `IDEA3-AEGIS_Lockdown/**` unless stated otherwise, and
it must not contain a live value.

| ID | Gap | Severity | Blocks | Depends on |
|---|---|---|---|---|
| G-01 | No AP creation artifact (NetworkManager profile template or `hostapd.conf` template) and no contract test that forbids `shared` / NAT / bridge | BLOCKING | L3 | OD-01, OD-02, OD-03 |
| G-02 | No AP address-assignment artifact | BLOCKING | L4 | OD-01, OD-04 |
| G-03 | No regulatory/channel artifact or read-only verification step | BLOCKING | L3 | OD-03 |
| G-04 | DHCP: no DHCP server template bound only to the AP, and the firewall template drops UDP/67. Static: firmware has no `WiFi.config` and no NVS address fields | BLOCKING | L4, L8 | OD-05 |
| G-05 | NTP: no upstream/handoff procedure; no check that the Core `TrustedClock` stays `SYNCED` during the timesyncd→server change | BLOCKING | L5 | OD-06 |
| G-06 | Firewall: DHCP/DNS rules absent where OD-05/OV-05 require them; no persistence/load procedure; no guard against loading a whole-ruleset `/etc/nftables.conf` | BLOCKING | L2 | OD-05, OD-07 |
| G-07 | No live-broker migration procedure for an existing 1883 broker under a global ACL/persistence/retain policy | BLOCKING | L6 | OD-08 |
| G-08 | No dedicated MQTT CA lifecycle procedure (generation, custody, SAN, validity, rotation, revocation, CRL/expiry monitoring) | BLOCKING | L6 | OD-09 |
| G-09 | Not proven: ESP32 `WiFiClientSecure` hostname verification when `broker` is an IP literal (mbedTLS name check against IP SANs). Must be proven in isolation before OV-05 is fixed | BLOCKING for an IP-literal choice | L6, L8 | OV-05 |
| G-10 | No password-file / ACL rendering procedure that keeps secrets out of argv and history and renders `device-id` exactly | BLOCKING | L6 | OV-07, OV-08 |
| G-11 | No key generation + dual delivery procedure (Core files and ESP32 NVS), and no NVS provisioning tool for namespace `aegis-p1` schema 1 | BLOCKING | L7, L8 | OV-09, OD-10 |
| G-12 | The Core unit lacks `LoadCredential=` for the `/run/credentials/aegis-idea3-core.service/k_c2d`/`k_d2c` paths the env example uses. The MQTT password is inline only | BLOCKING | L7 | OD-10 |
| G-13 | Admin PIN: inline environment value only; unsalted SHA-256 in memory | LOW (non-blocking unless OD-11 requires a file) | L7 | OD-11 |
| G-14 | No isolated live-material broker validation procedure (a separate process on a loopback non-production port, no `mosquitto.service` change, residue proof) | BLOCKING | L6 | G-07, G-08, G-10 |
| G-15 | No reviewed per-stage capture/rollback harness for AP/NTP/firewall/broker (plan-level rollback only, §9). T1 IN PROGRESS: repository capture/compare/stage-gate framework and rollback-handler contract in `deploy/pr11-phase4/` (Draft PR #152, not merged, no stage handler); gap stays OPEN | BLOCKING | L2 to L6 | — |
| G-16 | Firmware `setup()` Wi-Fi join is blocking (R-13), while design §10 says "non-blocking". It is fail-secure because the relay holds CUT, but the design and source disagree | LOW (record; decide before L8) | L8 | — |

### 6.1 Planning findings (recorded 2026-09-17; OPEN — none closed)

These refine the gaps above. They are planning findings only. No repository
artifact, test, or live check closes any of them yet.

| ID | Gap | Finding | Required future control (not implemented) |
|---|---|---|---|
| PF-01 | G-07 (and G-06) | The live broker's `listener 1883` binds every address (E-09). Once L4 assigns an AP address, the plaintext 1883 listener would also accept connections on the AP interface unless the AP firewall explicitly denies it. The current template's final `iifname <AP> drop` would deny it, but no test proves that and no rule names 1883. | An **explicit negative control**: from an AP-subnet source, TCP/1883 must be dropped (isolated network-namespace test in the repository; re-checked at L4/L6b live verification). A broker topology that preserves 1883 (OD-08) must not rely on an unstated catch-all. |
| PF-02 | G-04 / G-06 | If DHCP is chosen, the DHCP server's listener/socket behavior is not yet known in evidence. For example, dnsmasq may hold a wildcard UDP/67 socket even when restricted to one interface. S-05 as written ("any AP-side service binds to wildcard") cannot correctly classify that socket in either direction. | DHCP listener/socket behavior must be validated in **isolated repository tests** (T5). Any classification of a DHCP UDP/67 socket as acceptable needs an **explicit, reviewed exception** backed by that evidence and by interface-only reply checks. Until such an exception is merged, S-05 applies as written and an L4 stage with DHCP cannot pass. |
| PF-03 | G-08 | The ESP32 trust anchor is compiled into the firmware (`SECRET_MQTT_CA_CERT` in `secrets.h`, R-14). Rotating the broker leaf certificate under the **same** MQTT CA does not require a reflash. Replacing or revoking the MQTT CA trust anchor **does** require firmware reprovision/reflash under the current design, with the relay holding CUT during that window (L8 impact). The ESP32 has no CRL path. | The CA lifecycle procedure (G-08, OD-09) must state leaf rotation and CA replacement separately, with CA replacement treated as an L8-class device window. |
| PF-04 | G-11 | Design/source drift R-17: merged design §4.6 describes firmware key material as coming from `secrets.h`; the current implementation reads the keys from NVS `aegis-p1`. The merged design is historical and is not rewritten. | This document is the reconciliation record: G-11 provisioning targets the **NVS implementation** (R-12). Any future design amendment happens through a reviewed PR, not by editing merged history. |
| PF-05 | §10 | The IDEA2 preservation check cannot pass while the tunnel flaps (§2.3). | See §10 caveat. |

## 7. Phase 3 dependency (PR #149)

GITHUB, 2026-09-17: PR #149 `feat/idea3-pr11-phase3-runtime-completion`,
head `14061fca`, is **OPEN / Draft**, base `main`. It removes `CPUAccounting=`
from `deploy/aegis-idea3-core.service.example` (owner-run on systemd 261.2:
removed and ignored), updates the P3-C8 test, and amends
`production-runtime.md` and the Phase 3 design. It also edits
`Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md`.

Determination:

- **Phase 4 host stages L0–L6 (AP, firewall, NTP, isolated and live broker
  TLS) do not depend on PR #149.** They do not install or start the Core unit.
- **Stage L7 (Core install/start) depends on PR #149.** The Core unit is
  installed only from a merged candidate that `systemd-analyze verify` accepts
  on systemd 261.2, apart from the expected pre-release ExecStart warning.
  L7 is also the Phase 3 runtime gate (P3-L1 in PR #149). Phase 4 device
  stages L8–L9 need a running Core, so they depend on it too.
- The G-12 credential-delivery fix edits the same unit file. It must be based
  on, or reconciled with, PR #149 after that PR merges. It must not copy the
  PR #149 change into this branch. The integration strategy is owner decision
  **OD-17** (§5.2): a production live Core start needs Phase 4 material
  (R-08), so PR #149's Phase 3 live completion and G-12 cannot finish
  independently.
- **Merge-order note:** this branch and PR #149 both insert a new section at
  the top of `idea3-status.md`. Whichever merges second must reconcile the
  status note by hand (AGENTS.md §9) and never take one side blindly.

This task did not merge, cherry-pick, or copy any PR #149 change.

```text
PHASE3_DEPENDENCY = YES for L7–L9 (Core unit candidate in PR #149, Draft, unmerged); NO for L0–L6
```

## 8. K3 reconciliation

GITHUB, 2026-09-17: two IDEA1 PRs by `kraveerachat` are **OPEN / Draft**:

- PR #148 `feat/idea1-files-upload-ux-refresh` (Files upload UX). Last updated
  2026-09-16T18:15:27Z. Changed files: IDEA1 frontend source/tests and
  `idea1-status.md`.
- PR #150 `feat/idea1-files-management-ux` (Files management: rename, move,
  real folder hierarchy). Last updated 2026-09-16T21:07:43Z. Changed files: all
  under `IDEA1-AEGIS_Drive_LC/`, including server, database migration, and
  frontend source.

Factual rule:

- The open IDEA1 Draft PRs #148 and #150 prove **neither** an active
  Production mutation/verification window **nor** a closed one.
- Production activity is not inferred from PR state in either direction.
- The PR #146 K3 confirmation by `kraveerachat` covered only the Phase 2 T4
  window. It is consumed and does not carry over to Phase 4.
- The Phase 2 local preflight heuristic flags any open IDEA1 PR. That is a
  conservative signal, not proof.

```text
K3_CURRENT_STATE = OWNER_CONFIRMATION_REQUIRED — not claimed CLEAR
```

Before **each** Phase 4 Production mutation stage (L1–L10), a fresh written
confirmation is required, dated the same day as the stage. It must state that
no IDEA1 Production mutation/verification window overlaps. It comes from the
IDEA1 owner side (`kraveerachat`). If the answer is missing, stale, or
conflicting, that stage stops (S-01).

## 9. Staged execution order (future; NOT authorized; NOT RUN)

Every stage below is **NOT RUN** and **NOT AUTHORIZED** by this document. It
lists intent, preconditions, verification, rollback, and stop conditions
without live values, commands with values, or secrets. Each live stage needs
its own fresh authorization (§12) and ends with the §10 preservation checks.
Stages run strictly in order. A failed stage rolls back before anything else
happens.

The ordering principle is **fail-closed first**. Forwarding policy and the
firewall exist before any AP radio, address, or AP-side service exists. No
AP-side listener exists before the firewall.

### L0 — Fresh read-only baseline (owner-run, read-only)

- **Purpose:** re-capture §2.1 on the day of the window and close the
  read-only evidence gaps.
- **Adds:**
  - `iw reg get` and the phy channel list with flags;
  - the `nmcli` connection and device lists;
  - the contents or hash of `/etc/nftables.conf`, if present;
  - timesyncd status and configured servers;
  - the full Mosquitto config tree including include directories;
  - `ss` listeners and established 1883/8883 sessions;
  - `df`;
  - the Twingate-assigned address ranges;
  - the IDEA2 unit states, `NRestarts`, the `:8077`/`:18002` listeners, and
    the heartbeat result, recorded as separate process, tunnel, and runtime
    verdicts (§2.3, §10).
- **Rollback:** none (read-only).
- **Stop if:** any fact differs from §2.1 without an explanation, or a
  read-only command needed a write.

### L1 — Package installation (only as OD-01/OD-06 require)

- **Preconditions:** OD-01, OD-06, OD-13 decided; disk headroom sufficient;
  G-15 capture harness merged; K3 fresh.
- **Action:** install only the selected packages. Do not enable or start any
  service.
- **Verify:** packages present, units disabled/inactive, no new listener, §10
  preservation checks.
- **Rollback:** remove the installed packages; verify no leftover enabled
  units or listeners.
- **Stop if:** installation pulls in, enables, or starts a service; the
  package manager wants to upgrade unrelated packages (for example the kernel,
  systemd, NetworkManager, or Mosquitto); disk headroom falls below the owner
  threshold.

### L2 — Forwarding persistence and AP firewall table

- **Preconditions:** G-06 merged with OD-05/OD-07; OV-03 known; K3 fresh.
- **Action:**
  - install the rendered sysctl drop-in (values already 0 at runtime);
  - load **only** `table inet aegis_idea3` from the rendered file;
  - make the table persist as OD-07 decides.
  - Never run `flush ruleset`.
- **Verify:** forwarding is still 0/0; `nft list tables` shows only the
  expected additions; VLAN20 SSH/path, Core→Server path, IDEA2, and broker
  1883 are unchanged.
- **Rollback:** `nft delete table inet aegis_idea3`; remove the sysctl drop-in
  and persistence hook; verify the ruleset equals the L0 capture.
- **Stop if:**
  - any non-AP traffic is dropped;
  - loading would replace another ruleset;
  - forwarding becomes non-zero;
  - IDEA2 changes state.

### L3 — AP radio (no addressing, no clients)

- **Preconditions:**
  - G-01 and G-03 merged;
  - OD-01, OD-02, OD-03 decided;
  - OV-01, OV-02, OV-04 supplied out of band;
  - L2 PASS;
  - K3 fresh.
- **Action:** soft-unblock Wi-Fi; create the AP using the selected mechanism
  with the rendered artifact; bring it up without any IPv4 method that shares,
  routes, or NATs.
- **Verify:**
  - the AP interface is in AP mode on the approved channel and country;
  - no default route or other route via the AP;
  - forwarding 0/0;
  - `enp62s0` address and route unchanged;
  - no new NAT rule;
  - §10.
- **Rollback:** bring the AP down and delete its profile/config; restore
  rfkill soft-block; verify `iw dev`, routes, and nftables equal L2 PASS.
- **Stop if:**
  - the regulatory or channel state differs from the approved state;
  - NetworkManager or the AP daemon changes `enp62s0`, DNS, or routes;
  - forwarding or NAT appears;
  - the AP broadcasts an unapproved SSID or security mode.

### L4 — AP addressing (and DHCP if selected)

- **Preconditions:** G-02 and G-04 merged; OD-04 and OD-05 decided; OV-03
  supplied; L3 PASS; K3 fresh.
- **Action:** assign the Core AP address. If DHCP is selected, start the
  rendered DHCP service bound only to the AP interface, with no router or DNS
  option unless separately justified.
- **Verify:**
  - the address is present only on the AP interface;
  - the DHCP listener is on the AP interface only;
  - no listener on `enp62s0` or wildcard;
  - firewall counters show that non-permitted AP input drops;
  - VLAN20 is unchanged;
  - §10.
- **Rollback:** stop and disable the DHCP service; remove the AP address;
  verify it equals L3 PASS.
- **Stop if:** any service binds to wildcard or `enp62s0`; a route via the AP
  appears; DHCP answers on a non-AP interface.

### L5 — Core-local NTP serving on the AP

- **Preconditions:** G-05 merged; OD-06 decided; L4 PASS; K3 fresh.
- **Action:** configure the NTP server with the upstream decided in OD-06 and
  the rendered AP binding; perform the timesyncd handoff as specified.
- **Verify:**
  - the Core clock stays synchronized throughout (the `adjtimex` state stays
    SYNCED; the `maxerror` bound holds);
  - NTP listens only on the AP address, plus the loopback control port if
    applicable;
  - an AP-side NTP query is accepted and a non-AP query is not served;
  - §10.
- **Rollback:** stop and disable the NTP server; restore timesyncd to its L0
  state; verify it is synchronized again.
- **Stop if:** the Core clock loses sync longer than the 300 s holdover (R7
  would stop heartbeats); NTP binds to wildcard or `enp62s0`.

### L6 — MQTT CA, broker TLS, identities, ACL

This stage has two parts. Each part is separately authorized.

**L6a — isolated validation.**

- **Preconditions:**
  - G-07, G-08, G-09, G-10, G-14 merged;
  - OD-08 and OD-09 decided;
  - OV-05 to OV-08 and OV-10 supplied;
  - L5 PASS;
  - K3 fresh.
- **Action:**
  - the owner creates the dedicated MQTT CA, broker leaf, and password file
    under the decided custody;
  - render the config and ACL;
  - run a **separate, temporary** Mosquitto process on loopback on a
    non-production port;
  - `mosquitto.service` is not touched.
- **Verify:**
  - TLS 1.2+ with CA and hostname verification from the Core-identity client;
  - anonymous refused;
  - wrong password refused;
  - each identity limited to its exact ACL topics;
  - retained publishes refused;
  - 1883 absent in that process.
- **Rollback:** stop the temporary process; remove its runtime files; the
  owner keeps or destroys the material per OD-09.
- **Stop if:** any negative check passes unexpectedly; any secret appears in
  argv, logs, or the terminal transcript.

**L6b — live broker change.**

- **Preconditions:** L6a PASS; OD-08 migration procedure merged; the
  consumers of 1883/`aegis` confirmed; K3 fresh.
- **Action:** back up the live Mosquitto config tree and password file; apply
  the OD-08 topology; restart only the broker, in the window.
- **Verify:**
  - 8883 listens only on `127.0.0.1` and the AP address;
  - the 1883 behavior matches OD-08 exactly;
  - the §10 broker preservation checks pass;
  - no wildcard 8883.
- **Rollback:** restore the backed-up config tree and password file; restart
  the broker; verify the listeners and user set equal L0; remove the IDEA3
  broker files per OD-09.
- **Stop if:** the broker fails to start; 1883 behavior changes beyond OD-08;
  8883 binds to wildcard or `enp62s0`.

### L7 — Core runtime credentials and Core start (Phase 3 gate)

- **Preconditions:**
  - PR #149 (or its successor) merged;
  - G-11, G-12 merged (G-13 per OD-11);
  - OD-10, OD-11, OD-12 decided;
  - OV-08 to OV-11 supplied;
  - L6b PASS;
  - disk headroom;
  - separate Phase 3 Core install authorization;
  - K3 fresh.
- **Action:**
  - the owner generates `K_C2D`/`K_D2C` once on an owner-controlled host;
  - install the key files, MQTT password, CA, and PIN per OD-10/OD-11;
  - stage an immutable release;
  - install, verify, and start `aegis-idea3-core.service` (Phase 3 procedure).
- **Verify:**
  - production preflight PASS;
  - Core connects to 8883 with hostname verification;
  - subscriptions not refused;
  - time dimension SYNCED;
  - status `WAIT_DEVICE`/`DEGRADED`, never a containment claim;
  - dispatch stays disabled unless separately authorized;
  - §10.
- **Rollback:** stop and disable only `aegis-idea3-core.service`; preserve the
  durable data, keys, and certificates needed to classify outcomes (design
  §14); never send RESTORE.
- **Stop if:**
  - preflight fails;
  - any secret is logged;
  - the Core uses a plaintext or insecure TLS path;
  - IDEA2 is affected.

### L8 — ESP32 passive inspection, NVS provisioning, flash (hardware gate)

- **Preconditions:**
  - device present (currently NOT PRESENT, E-08);
  - OV-12 and OV-13 supplied;
  - OD-14 decided;
  - G-04 (if static), G-11, G-16 decision merged;
  - D4 live or a separately authorized interim recovery;
  - L7 PASS;
  - K3 fresh.
- **Impact:** after flashing, the relay holds its boot CUT output until a D4
  RESTORE (no automatic RESTORE). The protected uplink is cut for the whole
  window. The window must be planned for that.
- **Rollback:** the device stays fail-secure CUT. Recovery is D4 only. Never
  reflash v0 or reopen plaintext MQTT as rollback.
- **Stop if:** the serial identity or MAC does not match OV-12; NVS write
  verification fails; the build contains a placeholder CA or a test key.

### L9 — Authenticate without actuation

- **Preconditions:** L8 PASS; separate authorization.
- **Verify:**
  - signed HEARTBEAT reaches the device;
  - signed BOOT/PERIODIC STATUS is accepted by the Core after AUTH;
  - replay and a wrong-key message are rejected with no effect;
  - no COMMAND issued.
- **Rollback:** stop the Core; the device fails secure (it is already CUT).
- **Stop if:** any unauthenticated message produces liveness or state.

### L10 and later — separately authorized, outside this document

- Removal of plaintext 1883 (OD-08).
- The CUT test.
- D4 RESTORE.
- K12 reboot persistence.
- Resource quotas (D6 measurement).
- CRL/certificate renewal scheduling.

Each needs its own gate. None is implied by L0–L9 PASS.

## 10. Preservation checks (before and after every live stage)

A stage passes only when every applicable check equals the L0 baseline, or the
difference is exactly the approved change.

- **IDEA2:**
  - `aegis-detection-engine.service` and `aegis-detection-tunnel.service`: same
    ActiveState/SubState, same MainPID (no restart), no new failures in their
    journal since stage start;
  - record `NRestarts`, the local `:8077` and `:18002` listeners, and the
    heartbeat result, and keep process, tunnel, and runtime health as three
    separate verdicts (`PROCESS_ACTIVE != TUNNEL_HEALTHY !=
    IDEA2_RUNTIME_HEALTHY`);
  - no IDEA2 file, unit, or configuration touched.
  - **Caveat (2026-09-17, §2.3):** the tunnel is flapping (NRestarts > 1450),
    so "same MainPID, no restart" cannot pass for it, and the L0 baseline is
    not a healthy IDEA2 runtime. While this holds, every live stage stops
    under S-03, unless one of these exists first:
    - the IDEA2 tunnel is restored by its owners (outside this task), or
    - a written, IDEA2-owner-accepted narrowed criterion for that stage
      (for example: the engine MainPID and NRestarts unchanged, and the tunnel
      failure class unchanged with no new failure class).

    This document does not select or accept a narrowed criterion.
- **VLAN20 / Core network:**
  - `enp62s0` still `192.168.20.254/24`;
  - the route to `192.168.10.10` via `192.168.20.1 dev enp62s0` unchanged;
  - the authenticated Core→HUB check still HTTP 200 where Phase 2 dispatch
    evidence is in scope;
  - no new default route, NAT rule, or bridge;
  - IPv4/IPv6 forwarding 0/0;
  - Twingate state restored to its pre-stage state.
- **Existing broker:**
  - the Mosquitto config tree and `/etc/mosquitto/passwd` hash equal L0, until
    L6b; after L6b they match the OD-08 target exactly;
  - the 1883 listener set and `allow_anonymous false` unchanged unless OD-08
    says otherwise;
  - user `aegis` present unless OD-08 says otherwise;
  - established-client snapshot compared with L0.
- **Firewall/time:**
  - no ruleset outside `table inet aegis_idea3` changed;
  - the Core clock stays synchronized.
- **Evidence hygiene:**
  - no secret in terminal transcripts, argv, logs, receipts, or Git;
  - evidence bundles checksummed.

## 11. Explicit stop conditions (any stage)

| ID | Stop when |
|---|---|
| S-01 | K3 confirmation is missing, stale, or reports an overlapping IDEA1 window |
| S-02 | The stage's written authorization is missing, older than the window, or does not name the stage |
| S-03 | Any §10 preservation check fails |
| S-04 | Forwarding becomes non-zero, or any NAT, bridge, or route through the AP appears |
| S-05 | Any AP-side service binds to wildcard or `enp62s0`, or any IDEA3 listener appears outside loopback + the AP address. A DHCP server UDP/67 socket is classified only by an explicit reviewed exception backed by isolated repository tests (PF-02); none exists yet |
| S-06 | Any owner value would have to be guessed, reused from history, or generated by an agent |
| S-07 | Any secret appears in argv, shell history, logs, terminal output, or Git |
| S-08 | The Core clock loses trusted sync beyond holdover |
| S-09 | Disk headroom falls below the owner threshold |
| S-10 | A required repository gap for the stage is not merged, or its PR changed after review |
| S-11 | A rollback step fails. Hold in the safest state (device fail-secure CUT; Core stopped) and escalate; never improvise |
| S-12 | Any step would send RESTORE, disable certificate validation, reopen plaintext as a fallback, or run v0 in Production |

## 12. Fresh authorization gates

Each gate is a separate, written, same-day owner authorization naming the
stage. An earlier approval, a merged PR, a PASS on an earlier stage, or this
document does not authorize a later stage.

| Gate | Authorizes | Authorizer |
|---|---|---|
| A-L0 | Read-only baseline | Music (owner-run) |
| A-L1 | Package installation | Music; D6 notice to Pub for co-residence |
| A-L2 | Forwarding persistence + AP firewall table | Music; Kla integration review for the host network |
| A-L3 | AP radio | Music |
| A-L4 | AP addressing / DHCP | Music |
| A-L5 | NTP serving / timesyncd handoff | Music |
| A-L6a | Isolated broker validation with live material | Music |
| A-L6b | Live broker change | Music; Pub if a 1883 consumer is IDEA2-related |
| A-L7 | Core credentials + Core install/start | Music (Phase 3 gate); Pub D6 notice |
| A-L8 | ESP32 inspection, provisioning, flash, relay CUT window | Music; D4 or interim recovery authorization |
| A-L9 | Authentication without actuation | Music |
| A-CUT / A-RESTORE / A-K12 / A-1883-removal | Out of scope here | separate gates |

Every Production mutation gate also needs K3 (§8).

## 13. What this document does not do

- It performs no live mutation and runs no command on the Core.
- It creates no certificate, password, PSK, HMAC key, or other secret.
- It chooses no AP implementation, address model, channel, subnet, hostname,
  or SSID.
- It does not mark Phase 3 or Phase 4 runtime complete.
- It is not the task's final receipt.
- It does not merge, cherry-pick, or copy PR #149, and does not modify PR #147.
- It does not touch IDEA1 or IDEA2 source.
- It does not diagnose, fix, or claim health for the IDEA2 Detector B tunnel.
- It does not start T1–T9 (§14).

## 14. Repository task split and dependency summary (planning; T1 IN PROGRESS, T2–T9 NOT STARTED)

Accepted as the working basis at plan review (2026-09-17), with the review
corrections applied. This section records planning only; no task below has a
branch, and none closes a gap.

| Task | Gaps | Gating before implementation | Repository-ready now? | Waits for PR #149 | Physical ESP32 | Live stage served |
|---|---|---|---|---|---|---|
| T0 | none closed; records §2.3, §6.1, OD-15..OD-17, this split | — | this PR #151 | no | no | — |
| T1 | G-15 capture/compare/rollback framework | none | IN PROGRESS — Draft PR #152 (`deploy/pr11-phase4/`), human review pending | no | no | L0–L6 |
| T2 | G-10, G-14 | none | yes, after #151 merges | no | no | L6a |
| T3 | G-08 (G-09 SAN side only) | OD-09, OD-16 | no | no | CA replacement impacts L8 (PF-03) | L6 |
| T4 | G-07 (PF-01 control) | OD-08, L0 1883/`aegis` consumer inventory; T1, T2, T3 | no | no | no | L6b |
| T5 | G-01, G-02, G-03, G-04 (Core side), G-06 (PF-01, PF-02) | OD-01..OD-05, OD-07, OD-16, L0 regulatory evidence; T1 | no | no | DHCP/DNS join proof at L8 | L2–L4 |
| T6 | G-05 | OD-06; T5 | no | no | no | L5 |
| T7 | G-16 (+ G-04 static branch only if OD-05/OD-16 choose it) | none for G-16; OD-05/OD-16 for static | G-16 yes, after #151 merges | no | verification at L8 | L8 |
| T8 | G-11 | OD-10, OD-16 (schema), OD-15 (optional); T7 if the schema changes | **partial:** the schema/parity/tool skeleton may be repository-ready; Production delivery paths, credential locations, encryption policy, and final provisioning behavior stay gated by owner decisions | Core-side delivery ties to T9 | flash at L8 | L7, L8 |
| T9 | G-12, G-13 | OD-10, OD-11, OD-17; PR #149 | no | **yes** | no | L7 |

Execution ordering:

1. Finish T0 on PR #151 and stop for human review. PR #151 is the
   prerequisite/task-split authority.
2. After a human merges PR #151: T1, T2, and T7 (G-16), each on its own
   independent branch from the updated `main`.
3. T8 follows only after its required owner decisions.
4. T3–T6 follow their owner decisions; T4 merges after T1, T2, and T3; T6
   after T5.
5. T9 follows OD-17 and PR #149.
6. No stacked or overlapping PRs unless explicitly authorized later. PR #149
   (Phase 3, Draft) and PR #147 (PR12) stay separate and unmodified by this
   work.
7. Every live stage still needs its own same-day authorization plus K3 (§8,
   §12) and faces the §10 IDEA2 caveat.

## 15. IDEA2 Detector B tunnel regression — ownership and later read-only diagnostic plan (NOT RUN)

**Scope:** the regression is not diagnosed, fixed, or retried by IDEA3 or by
any Phase 4 branch.

**Ownership classification (likely; not a root-cause claim):**

- IDEA2 (`pub`): the edge Detection Engine and tunnel units, including the
  restart policy (R-18).
- Infrastructure (`kla`): the probable root-cause area is the Server/network
  path to `192.168.10.10:22`. ICMP passes while TCP/22 times out, which
  indicates silent filtering or a non-listening service behind a drop policy.
  Candidates: Core-side routing through a Twingate client, a Server
  firewall/ban, an inter-VLAN filter, or sshd state.
- IDEA3 (`music`): not the owner. It is affected as a co-resident host and by
  the §10 baseline. The repository Phase 2 scripts contain no sshd or Server
  firewall commands. IDEA3 is not excluded as a timeline factor until the
  regression's onset is compared with the 2026-09-16 Phase 2 windows.

**Later read-only plan.** It needs separate owner scheduling. Server steps run
through Twingate administration by the infrastructure owner.

- Core (owner-run, local console):
  - unit properties: `ActiveState`, `SubState`, `MainPID`, `NRestarts`,
    `ExecMainStartTimestamp`, `Result`;
  - the oldest retained tunnel journal lines, with hourly counts per failure
    class (timeout, authentication, host key, forward failure);
  - `ip route get 192.168.10.10`, `ip rule`, the Twingate client state;
  - `:8077` and `:18002` listeners;
  - **one** TCP probe each to ports 22 and 443. Probes are not repeated, in
    case a ban is extended.
- Server (read-only):
  - sshd status and the effective port, listen, forwarding, and
    `PermitListen` settings;
  - listeners on `:22` and on the reverse endpoints (a stale bind);
  - sshd journal entries for `192.168.20.254` with hourly counts;
  - UFW/nft counters for port 22;
  - fail2ban, sshguard, and crowdsec state and ban lists;
  - modification times of the sshd and UFW configuration;
  - the Docker bridge gateway address;
  - a bounded, header-only packet capture on port 22 (with explicit
    approval);
  - inter-VLAN filter counters on the router (infrastructure owner).
- How to read the results:
  - no SYN reaches the Server → Core route/Twingate or inter-VLAN filter;
  - SYN arrives but no SYN-ACK → Server firewall or ban;
  - SYN-ACK sent but not received → return path;
  - TCP succeeds but authentication or forward errors appear → key,
    `PermitListen`, or stale session.
- Forbidden during diagnosis: unban, sshd or tunnel restart, firewall or sshd
  configuration edits, killing sessions, and toggling Twingate without owner
  approval. Output shows key fingerprints only, never `.env` or key contents.
- Delivery: an IDEA2- or infrastructure-owned issue or task. It is not an
  IDEA3 branch, and it does not edit the IDEA2 or infrastructure canonical
  notes.
