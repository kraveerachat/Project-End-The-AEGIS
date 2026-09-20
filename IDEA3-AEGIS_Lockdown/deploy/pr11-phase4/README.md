# AEGIS IDEA3 PR11 Phase 4 — T1 / G-15 capture, compare, and stage-gate harness

Repository framework only. **Nothing here has run on the Core or Production.**

```text
T1_SCOPE                       = G-15 repository framework (capture / compare / stage gate / rollback contract)
G15_CLOSED                     = YES — repository framework closed; live rollout remains separate
PRODUCTION_MUTATION            = NO (no script in this directory changes host state)
LIVE_STAGE_AUTHORIZED          = NO (the gate always prints NO)
STAGE_ROLLBACK_HANDLERS        = L2, L3, L4, L5, L6a, L6b REGISTERED (repository only; live execution NOT authorized)
PHASE4_LIVE_READINESS          = NOT READY
IDEA2_TUNNEL_HEALTHY           = NO    IDEA2_RUNTIME_HEALTHY = NO   (owner-run, 2026-09-17)
```

Authority: `docs/superpowers/specs/2026-09-17-idea3-pr11-phase4-runtime-prerequisites.md`
(§6 G-15, §9 staged order, §10 preservation checks, §11 stop conditions, §12
fresh authorization). Where this README and that document differ, the document
governs.

| File | Runs on | Mutates | Purpose |
|---|---|---|---|
| `p4-lib.sh` | — | no | stage table, read-only command guard `p4_ro`, record helpers, rollback handler contract |
| `p4-l0-capture.sh` | Core (owner-run) | no — writes a new evidence directory only | L0 read-only capture into normalized, checksummed records |
| `p4-compare.sh` | anywhere | no | deterministic before/after preservation and drift comparison |
| `p4-stage-gate.sh` | anywhere | no | fail-closed same-day authorization + K3 record gate |

Regression tests: `tests/test_pr11_phase4_harness.py` (fake commands and a
fixture filesystem only; no sudo, no host network or service access).

## 1. L0 capture

```bash
sudo EVID_DIR=~/idea3-p4-evidence/<window>/pre CAPTURE_LABEL=pre \
     JOURNAL_SINCE='YYYY-MM-DD HH:MM:SS UTC' bash p4-l0-capture.sh
```

- Every host command goes through `p4_ro`. The full argv must match an
  anchored read-only pattern, or the command is refused (status 126) and never
  runs. No pattern exists for any change verb.
- `EVID_DIR` must be absent or empty; evidence is never overwritten.
- Use one `JOURNAL_SINCE` for the before and after captures of a stage.
- Exit `0` = `L0_CAPTURE=COMPLETE`; `3` = `L0_CAPTURE=PARTIAL` (a required
  read was unavailable, for example a non-root run; the compare then fails
  closed); `1` = STOP.

Output: `meta`, `capabilities`, `network`, `wifi`, `firewall`, `time`, `mqtt`,
`idea2`, `services`, `listeners`, `host` `.tsv` files (one `key<TAB>value`
record per line, sorted, unique keys), non-secret raw command output under
`raw/`, `capture.log`, and `SHA256SUMS`.

| Area | Recorded |
|---|---|
| Network | `ip -br addr/link`, IPv4/IPv6 default routes, route and rule table digests, the four forwarding sysctls, `/etc/sysctl.conf` and `/etc/sysctl.d` digests |
| Wi-Fi / AP prerequisites | rfkill soft/hard per type, global and per-phy regulatory domain, interface type/channel, AP mode listed, NetworkManager state/active connections/devices, connection profiles (metadata only) |
| Firewall | nft table set, per-table and ruleset digests (stateless, counters and handles normalized), `/etc/nftables.conf` and `/etc/nftables.d` digests |
| Time | `timedatectl` NTP/sync state, timesyncd server, chrony leap status when installed, timesyncd/chrony config digests (`chrony.keys` metadata only) |
| MQTT | listener inventory, established 1883/8883 session counts, allowlisted non-secret Mosquitto directives, config tree digests, password-file user names + digest + metadata, key files metadata only |
| IDEA2 (separate) | engine and tunnel `LoadState/ActiveState/SubState/UnitFileState/MainPID/NRestarts/Result/ExecMainStartTimestamp`, `:8077` and `:18002` listener state, journal failure-class counts since `JOURNAL_SINCE`, and three separate verdicts |
| Disk / host | `/`, `/var`, `/opt` usage, host identity, kernel, boot ID, Twingate client status, Twingate and other relevant units, IDEA3 host paths, `/etc/aegis-idea3` metadata only |

IDEA2 verdicts are never collapsed into one boolean:

- `idea2.verdict.process_active` — `YES` / `NO` / `UNKNOWN` (unit state only);
- `idea2.verdict.tunnel_healthy` — `NO` / `NO_FAILURE_OBSERVED` / `UNKNOWN`
  (never `YES`);
- `idea2.verdict.runtime_healthy` — `NO` / `NOT_PROVEN` / `UNKNOWN`. L0 never
  sends a heartbeat (`idea2.heartbeat.probe=NOT_PROBED_READ_ONLY`), so it can
  never prove a healthy runtime.

### Secret and material safety

- Private keys, `.env` files, PSK/PIN/token/credential/secret-named files,
  `k_c2d`/`k_d2c`, `chrony.keys`, NetworkManager profiles, and everything under
  `/etc/aegis-idea3` are recorded by **metadata only** (mode, owner, size,
  mtime) — never content, never a digest (a digest of a low-entropy PIN or PSK
  could be brute-forced).
- The Mosquitto password file contributes only user names and a digest of its
  salted hashes. Mosquitto configs contribute only allowlisted directives
  (listeners, auth, file paths) and digests; values such as bridge passwords are
  never read out.
- Journal content is reduced to failure-class counts; no journal line is kept.
- `nmcli` is never asked to show secrets; the environment is never dumped.

## 2. Compare

```bash
DISK_THRESHOLD_PCT=<owner threshold> bash p4-compare.sh <pre> <post>
```

- Verifies both `SHA256SUMS`, the schema, and the evidence class (test fixtures
  are never compared with host evidence).
- `DISK_THRESHOLD_PCT` is the owner's S-09 value and is required.
- `ALLOW_KEYS_FILE` / `ALLOW_LISTENERS_FILE` list the exact keys a reviewed
  stage handler may change or add. Forwarding, default routes, IDEA2, host,
  disk, and capability keys can never be approved. A wildcard listener (S-05)
  or a new plaintext 1883 listener (S-12) can never be approved.

| Class | Meaning | Verdict |
|---|---|---|
| `NEW_OR_WORSENED_DRIFT` | unapproved change relative to the before capture | FAIL |
| `BASELINE_UNHEALTHY_BUT_UNCHANGED` | a pre-existing unhealthy condition persisted, or repeated within its existing failure class | FAIL |
| `INCOMPARABLE` | evidence missing, unreadable, partial, or with different journal boundaries | FAIL |
| `APPROVED_CHANGE` | exactly listed in an allow file | pass |
| `INFO` | recorded for review only (free disk bytes, more MQTT sessions) | pass |

Detected drift includes nftables table/rule/persistent-config changes,
forwarding becoming non-zero, default-route, interface, and address changes, the
1883 listener disappearing, an IDEA3-port listener outside the approved scope,
IDEA2 engine MainPID/restart drift, IDEA2 tunnel restart and failure-class
drift, `:8077` disappearing, any `:18002` change, service state and restart
changes, time sync loss, disk threshold worsening, Mosquitto config changes, a
reboot, and a host mismatch.

**§10 is not weakened.** An unhealthy IDEA2 tunnel in the before capture yields
`IDEA2_TUNNEL_BASELINE_UNHEALTHY` even when nothing changed, so
`PRESERVATION_S10=FAIL` and `COMPARE_RESULT=FAIL`, and every live stage stays
blocked. `IDEA2_NARROWED_CRITERION=NOT_ACCEPTED` is fixed; only a written,
IDEA2-owner-accepted criterion merged through review may change that.

## 3. Stage gate

```bash
bash p4-stage-gate.sh --stage L2 --mode simulate --authorization auth.txt --k3 k3.txt
```

Fails closed on: a missing or unknown stage, a mode other than
`simulate`/`live`, a missing, malformed, other-stage, stale, or future-dated
authorization, and — for every stage except L0 — a missing, malformed,
other-stage, or stale K3 confirmation, or any `idea1_window_overlap` other than
`NONE`. "Same day" is the `Asia/Bangkok` calendar date. Record formats are in
the script header; records carry references to the written authorization,
never secrets. No real authorization value exists in this repository; the tests
use `example.invalid` placeholders only.

Output always includes `LIVE_STAGE_AUTHORIZED=NO` and
`PRODUCTION_MUTATION_PERFORMED=NO`. The gate cannot verify that the stage's
repository gaps are merged (`REPOSITORY_GAP_MERGE_STATE=NOT_VERIFIED_BY_GATE`) or
that the IDEA2 caveat is resolved (`S10_IDEA2_CAVEAT=OPEN`). In `live` mode, a
mutating stage fails with `ROLLBACK_HANDLER_NOT_REGISTERED` until a reviewed
handler exists. L0 needs a same-day authorization but no K3
(`STAGE_GATE=PASS_READ_ONLY`).

## 4. Rollback handler contract and registered handlers

T1 defined the handler contract. A separately reviewed task may register a stage under
`stages/<STAGE>/` with `apply.sh`, `verify.sh`, `rollback.sh`,
`allow-keys.txt`, and `allow-listeners.txt`. A stage runner must then:

1. pass `p4-stage-gate.sh --mode live`;
2. capture `PRE` (read-only);
3. run `apply.sh`;
4. capture `POST` and compare `PRE`→`POST` with the stage allow files;
5. on any FAIL, run `rollback.sh`, capture `RB`, and require
   `PRE`→`RB` to PASS with **no** allow files; otherwise hold (S-11) and
   escalate.

`rollback.sh` must be idempotent and undo only its own stage. It must never
remove a whole firewall ruleset, send RESTORE, reopen plaintext MQTT as a
fallback, or touch IDEA1/IDEA2 state. T1 originally shipped no `stages/`
directory. T4 registered the separately reviewed L6b handler under
`stages/L6b/`. Separately reviewed repository tasks registered L2 under
`stages/L2/`, L3 under `stages/L3/`, L4 under `stages/L4/`, L5 under `stages/L5/`,
and L6a under `stages/L6a/`. All six stage handlers (L2, L3, L4, L5, L6a, L6b)
are now registered in the repository framework.

### L2 handler (firewall & forwarding persistence)

- L2 owns only dedicated IDEA3 firewall and forwarding persistence: table `inet aegis_idea3`, `/etc/aegis-idea3/aegis-idea3.nft`, `aegis-idea3-nftables-load.service`, and `/etc/sysctl.d/90-aegis-idea3-forwarding.conf`.
- Forwarding target remains strictly zero (`= 0`) across all interfaces.
- Zero NAT (no masquerade, SNAT, or DNAT), zero bridge creation, and zero listener additions (`allow-listeners.txt` has no active entries).
- Live mode requires explicit `AEGIS_L2_LIVE_AUTHORIZED=YES` and root.
- `/etc/aegis-idea3` must already exist as a non-symlink directory in live mode (`IDEA3_PARENT_DIR_REQUIRED`).
- Fixture mode (`AEGIS_P4_FS_ROOT`) never performs live host mutation.
- L2 has NOT been run live; live execution is NOT authorized.

### L3 handler (AP radio runtime)

- L3 owns only AP-radio state on dedicated interface `wlp0s20f3`: NetworkManager AP profile materialization (`aegis-idea3-ap.nmconnection`), 2.4 GHz AP mode, WPA2-PSK security, regulatory domain verification, and target-specific rfkill soft unblock.
- AP addressing, DHCP, and DNS service are NOT part of L3 (these belong to L4).
- Zero NAT, zero masquerade, zero bridge creation, zero forwarding enable, zero nftables mutation, zero sysctl mutation, zero Mosquitto/NTP mutation, and zero listener additions (`allow-listeners.txt` has 0 active entries).
- Management-path fail-closed checks prevent isolation of host control paths; hard-rfkill and regulatory drift fail closed and cannot be approved.
- PSK accepted only from private regular file (mode 0600/0400; never from CLI argument); no secret or PSK committed.
- Live mode requires explicit `AEGIS_L3_LIVE_AUTHORIZED=YES` and root. Live target interface is strictly `wlp0s20f3`.
- Fixture mode (`AEGIS_P4_FS_ROOT`) never performs live host mutation.
- L3 is repository-registered only; live execution is NOT authorized and L3 has NOT been run live.

### L4 handler (AP addressing & DHCP/Core-local DNS)

- Registered the reviewed L4 stage handler (`stages/L4/`) with the T1 stage framework (`apply.sh`, `verify.sh`, `rollback.sh`, `allow-keys.txt`, `allow-listeners.txt`).
- L4 transitions the L3 NetworkManager AP connection profile (`aegis-idea3-ap.nmconnection`) from `ipv4.method=disabled` to `ipv4.method=manual` with `never-default=true`. AP IPv4 addressing is applied without creating default gateways, NAT/masquerade, or routing bridges.
- L4 deploys a dedicated `dnsmasq` instance (`/etc/aegis-idea3/dnsmasq-ap.conf`, `aegis-idea3-dnsmasq.service`) serving the AP DHCP pool and Core-local DNS mapping the owner-supplied broker hostname to the Core AP address on `wlp0s20f3` using the merged T5 template.
- Read-only L2 firewall preconditions: `apply.sh` and `verify.sh` verify dedicated table `inet aegis_idea3`, UDP/67 permitted, UDP/53 permitted, TCP/53 permitted, explicit TCP/1883 drop rule present, forward policy `drop`, zero NAT/masquerade, and zero forwarding sysctls (`net.ipv4.ip_forward=0`), with comment lines stripped before parsing.
- Hardening against listener drift (PF-02): on real/host evidence, the wildcard listener exception strictly permits only `udp/67` on `0.0.0.0%wlp0s20f3`. Synthetic interfaces are rejected unless running under `TEST_FIXTURE`.
- Hardening against route drift: `net.route[46].unscoped` captures unscoped routes; unauthorized unscoped routes cause `UNSCOPED_ROUTE_DRIFT` and reject `ROUTE_TABLE_DRIFT` approval.
- Rollback: `stages/L4/rollback.sh` is idempotent. It removes only L4-owned addressing/DHCP/DNS state and restores the L3 IPv4-disabled AP profile (`method=disabled`) without deleting the L3 AP profile or invoking L3 rollback. Specifically, it stops and disables `aegis-idea3-dnsmasq.service`, deletes `/etc/aegis-idea3/dnsmasq-ap.conf` and its service unit, reloads and reconnects the NetworkManager connection profile in disabled-IPv4 mode (`nmcli connection reload && nmcli connection up`), verifies zero remaining IPv4 address on `wlp0s20f3`, and preserves existing firewall rules and L3 AP radio state.
- Fixture mode (`AEGIS_P4_FS_ROOT`) operates cleanly without live host mutation.
- Live gates required: L4 is repository-registered only. Live execution has NOT run and live readiness remains `NOT READY`. Live execution requires L2 and L3 live PASS, fresh same-day A-L4 authorization, fresh K3 key, primary owner network value OV-03 (AP subnet and Core AP address, required by L2 and L4) plus owner-supplied runtime values (DHCP pool and broker hostname under the implemented T5 contract), management-path proof, and §10 preservation PASS.
- L5 and L6a are repository-registered; the IDEA2 §10 caveat remains open and blocking; `PHASE4_LIVE_READINESS` remains `NOT READY`.

### L5 handler (Core-local trusted NTP runtime handler)

- Registered the reviewed L5 stage handler (`stages/L5/`) under the G-15 handler framework (`apply.sh`, `verify.sh`, `rollback.sh`, `allow-keys.txt`, `allow-listeners.txt`).
- L5 transitions time serving from `systemd-timesyncd.service` to `chronyd.service` on dedicated AP interface `wlp0s20f3` (`/etc/chrony.conf`, `root:root`, mode `0640`).
- Runtime-only service mutation: L5 mutates `ActiveState` only (`systemctl stop systemd-timesyncd`, `systemctl start chronyd`). `UnitFileState` is strictly untouched and protected for both services. Zero `systemctl enable` or `systemctl disable`.
- Atomic configuration placement: creates temporary regular file in same directory (`mktemp ${target_conf}.tmp.XXXXXX`), validates rendered content before activation, syncs, and atomically renames (`mv -f`).
- Read-only chronyd unit inspection: verifies effective ExecStart relies on default `/etc/chrony.conf`; fails closed on non-default `-f <path>` or unexpected drop-in overrides with `CONFIG_PATH_AUTHORITY_MISMATCH`.
- Time synchronization contract: requires pre-handoff `systemd-timesyncd.service` active and running with `TrustedClock = SYNCED` and `maxerror <= 1,000,000 us`. Enforces bounded holdover <= 300 s during handoff. Post-apply verification requires final `TrustedClock = SYNCED` and `maxerror <= 1,000,000 us`; final `HOLDOVER`, `UNTRUSTED`, or `UNKNOWN` is strictly rejected.
- Strict listener contract: requires `udp <AEGIS_AP_ADDRESS>:123`, permits loopback-only `udp 127.0.0.1:323` and `udp [::1]:323` if observed; wildcard (`0.0.0.0`, `[::]`), non-AP NTP, non-loopback 323, and TCP/123 are strictly rejected.
- Rollback: `stages/L5/rollback.sh` is idempotent. It stops `chronyd.service`, restores captured pre-L5 `/etc/chrony.conf` bytes, uid, gid, and mode (or removes `/etc/chrony.conf` if absent pre-L5), restores captured pre-L5 `systemd-timesyncd.service` runtime `ActiveState` without altering `UnitFileState`, and verifies `TrustedClock = SYNCED`.
- Preserves L4 AP addressing/DHCP/DNS, L2 firewall rules, zero forwarding (`net.ipv4.ip_forward=0`), zero NAT/masquerade, and existing network routes.
- Fixture mode operates strictly beneath `AEGIS_P4_FS_ROOT` without host mutation.
- Provenance disclosure: `RED_FIRST_PROVEN = NO`. There is no retained evidence proving L5 focused tests were observed failing before candidate handler files were created. The candidate was treated as untrusted existing work, independently audited, corrected for deterministic regression assertions, hardened, and verified.
- Live gates required: L5 is repository-registered only. Live execution has NOT run and live readiness remains `NOT READY`. Live execution requires L2, L3, and L4 live PASS, fresh same-day A-L5 authorization, fresh K3 key, owner-supplied trusted upstream value, external AP/non-AP query evidence, and §10 preservation PASS.
- L6a is repository-registered; the IDEA2 §10 caveat remains open and blocking; `PHASE4_LIVE_READINESS` remains `NOT READY`.

### L6a handler (isolated TLS / PKI validation)

- Registered the reviewed L6a stage handler (`stages/L6a/`) under the G-15 handler framework (`apply.sh`, `verify.sh`, `rollback.sh`, `allow-keys.txt`, `allow-listeners.txt`) conforming to approved operational design OD-L6A-01 through OD-L6A-07.
- Operates strictly under **Option B (temporary test broker)**: launches an ephemeral Mosquitto instance on loopback for isolated TLS/PKI validation, verifies the contract, and terminates the temporary broker before `apply.sh` returns. POST capture expects zero listener or configuration drift.
- All five required stage handler files are present; `allow-keys.txt` and `allow-listeners.txt` contain **zero active entries**.
- Input contracts: `AEGIS_L6A_INPUT_DIR`, `AEGIS_L6A_WORK_DIR`, and `AEGIS_L6A_PORT` are required with no defaults.
- Port authority: strictly unprivileged integer range `1025..65535`. Standard ports `1883` and `8883` are strictly forbidden.
- Security & process boundaries: binds strictly to loopback (`127.0.0.1`), validates canonical TLS hostname `mqtt.aegis.home.arpa`, enforces exact DNS-only SAN profile, proves negotiated TLS version >= 1.2, validates Core and device authentication, proves rejection of wrong Core password, wrong device password, anonymous access, and retained publish, and enforces exact T2 ACL matrix.
- Secret & material handling: `p4-broker-material.py` creates a private temporary plaintext password file (mode 0600), then executes `mosquitto_passwd -U <temporary-file-path>`; the password itself is NOT present in argv. No secrets are emitted in outputs by construction (`NO SECRET OUTPUT BY CONSTRUCTION`). Temporary plaintext and runtime configuration material is unlinked/removed on completion (unlink does not claim forensic secure erase).
- Process ownership & rollback: records detailed process metadata (PID, start-time ticks from `/proc/<pid>/stat` field 22, boot ID, canonical config path, executable path) to prevent PID reuse kills. Rollback verifies process identity before signaling and enters `S-11 HOLD` on mismatch; zero generic kill commands (`pkill`, `killall`, `pgrep`). Non-secret validation evidence (`validation-evidence.tsv`) is retained.
- Preserves all existing services: zero mutation to the legacy Mosquitto service (`mosquitto.service`), plaintext 1883 listener, `/etc/mosquitto`, or L6b production-candidate configuration.
- Fixture mode operates cleanly beneath test fixtures without host mutation.
- Live gates required: L6a is repository-registered only (`RED_FIRST_PROVEN = YES`). Live execution has NOT run and live readiness remains `NOT READY`. Live execution requires L2, L3, L4, and L5 live PASS, fresh same-day A-L6a authorization, fresh K3 key, resolution of the open IDEA2 §10 preservation caveat, and all authoritative prerequisites.
- All stage handlers (L2, L3, L4, L5, L6a, L6b) are now registered in the repository; the IDEA2 §10 caveat remains open and blocking; `PHASE4_LIVE_READINESS` remains `NOT READY`.

## 5. Repository-safe ESP32 NVS provisioning material

`p4-nvs-provision.py` renders an Espressif NVS CSV for the Phase 4 device profile.
It does not flash a device, open a serial port, generate Production credentials,
or write ESP32 NVS.

Pinned profile: namespace `aegis-p1`, schema `1`, device `aegis-relay-01`,
broker `mqtt.aegis.home.arpa`, MQTT user `idea3-dev-aegis-relay-01`, and
initial `seq_hi=0`.

Wi-Fi PSK, MQTT password, `k_c2d`, and `k_d2c` are accepted only from private
regular files. Group/world-readable secret files are refused. Protocol keys must
be independent, non-zero 32-byte lowercase-hex values and must not use public
golden-vector or legacy demo-derived material.

The generated CSV is created mode `0600` and existing output files are refused.
The CSV contains plaintext provisioning secrets. Do not commit or log it, and
remove it after an explicitly authorized provisioning operation.

This repository task proves schema/profile parity and safe material rendering
only. It does not prove live G-11 provisioning, ESP32 flashing, physical relay
behavior, NVS encryption, D4 recovery, or Production readiness.

## 6. T5 private AP network — repository implementation

T5 is repository-only work for G-01, G-02, G-03, G-04, and G-06.
No live AP, host-network, nftables, DHCP/DNS, ESP32 flash, or ESP32 NVS mutation occurred.

```text
T5_REPOSITORY_IMPLEMENTED      = YES
PRODUCTION_MUTATION          = NO
NETWORK_MUTATION             = NO
AP_CREATED                   = NO
ESP32_FLASH                  = NO
ESP32_NVS_WRITE              = NO
PHASE4_RUNTIME_COMPLETE      = NO
L2_L3_L4                     = NOT RUN
```

### T5 repository artifacts

- `p4-ap-network.py` renders repository-only AP network material.
- NetworkManager AP, dnsmasq DHCP/DNS, nftables, and forwarding-disabled templates are repository contracts only.
- `tests/test_pr11_phase4_ap_network.py` covers T5 regression behavior.
- `tests/p4_pf02_dnsmasq_netns.py` performs the isolated PF-02 namespace proof.

### Evidence boundary

PF-01 proves the repository firewall contract denies AP-side plaintext MQTT TCP/1883 and rejects unsafe accept/NAT variants. It does not prove live nftables state.

PF-02 uses only synthetic interfaces inside a fresh user/network namespace. It proved AP-side DNS/DHCP service behavior, uplink-side NO_REPLY, no real-interface use, and cleanup PASS.

PF-02 does not prove a live Wi-Fi AP, live DHCP/DNS, real ESP32 association, or live firewall state.

### Live boundary

L2 firewall/forwarding, L3 AP activation, and L4 AP addressing/DHCP remain separate live stages requiring fresh authorization and preservation evidence.

## 7. T6 local trusted NTP — repository implementation

T6 provides the repository contract for G-05 local trusted NTP.
It remains repository-only work and does not execute the future L5 live stage.

`p4-ntp.py` provides repository-safe `render` and `validate` commands.
`render` requires the AP IPv4 address, AP subnet, owner-supplied trusted
upstream, and output directory. `validate` fail-closes unless the rendered
chrony configuration and T6 contract match the AP-only serving policy.

The Production trusted upstream is supplied by the owner at render/live time.
No real Production upstream value is committed to this repository.

Rendered chrony policy:

```text
server <OWNER_SUPPLIED_TRUSTED_UPSTREAM> iburst
bindaddress <RENDERED_AP_ADDRESS>
allow <RENDERED_AP_SUBNET>
```

Validation rejects unresolved placeholders, wildcard or broad AP scope,
`allow all`, additional upstreams, additional active directives, and
`local` / `local stratum` fallback behavior.

### T6 trusted-time handoff contract

The repository contract preserves the existing TrustedClock limits:

```text
TRUSTEDCLOCK_PRE_HANDOFF         = SYNCED
TRUSTEDCLOCK_POST_HANDOFF        = SYNCED
TRUSTEDCLOCK_MAX_ERROR_US        = 1000000
TRUSTEDCLOCK_HOLDOVER_SEC        = 300
TRUSTEDCLOCK_FINAL_HOLDOVER_PASS = NO
ROLLBACK_TIME_OWNER              = systemd-timesyncd
```

HOLDOVER may preserve protocol safety temporarily, but it is not a
successful final L5 state. Future L5 acceptance must finish in `SYNCED`
within the existing max-error bound. Failure requires rollback to
`systemd-timesyncd` and re-proving `SYNCED`.

The T5 firewall contract already permits AP-side UDP/123 while preserving
forwarding isolation and no-NAT behavior. T6 does not modify T5 nftables.

### T6 live boundary

No chrony package installation, chronyd activation, systemd-timesyncd
handoff, live NTP query, host-network mutation, Production mutation,
AP activation, or ESP32 mutation was performed by this repository task.

```text
PRODUCTION_MUTATION       = NO
NETWORK_MUTATION          = NO
NTP_SERVER_LIVE           = NO
CHRONY_INSTALLED_LIVE     = NO
TIMESYNCD_HANDOFF_LIVE    = NO
L5                        = NOT RUN
PHASE4_RUNTIME_COMPLETE   = NO
PHASE4_LIVE_READINESS     = NOT READY
```

L5 remains a separate future live stage requiring fresh authorization,
fresh preservation evidence, required predecessor stages, and
owner-supplied live values.

## 8. T4 / G-07 separate broker migration — repository implementation

T4 implements OD-08 as a separate TLS-only Mosquitto instance for IDEA3.
It does not replace or modify the legacy `mosquitto.service`, its plaintext
1883 listener, or the legacy `aegis` user.

Repository artifacts:

- `p4-broker-migration.py` deterministically renders and validates the separate
  IDEA3 broker configuration.
- `../mosquitto/aegis-idea3-mosquitto.service.example` directly launches the
  separate IDEA3 broker instance.
- `stages/L6b/` registers the L6b `apply`, read-only `verify`, idempotent
  `rollback`, and exact allow-key/listener contracts with the T1 framework.
- L0 capture includes `aegis-idea3-mosquitto.service`.
- the compare harness resolves `<AEGIS_AP_ADDRESS>` at run time and permits
  only loopback:8883 plus the approved AP-address:8883 listener additions.

The repository contract forbids 1883 in the IDEA3 instance, wildcard 8883,
8883 on the uplink address, reuse of `/etc/mosquitto/passwd`, legacy `aegis`
as an IDEA3 identity, unresolved placeholders, anonymous access, retained
message availability, and commands that mutate the legacy Mosquitto service.

The future L6b verification also requires the explicit PF-01 AP-side TCP/1883
drop already defined by the T5 firewall contract. Repository registration does
not authorize or execute L6b.

```text
T4_REPOSITORY_IMPLEMENTED = YES
T4_FINAL_VALIDATION = PASS — 242 focused/regression tests
T4_REPOSITORY_CLOSEOUT = COMPLETE / ACCEPTANCE PASS
G07_REPOSITORY_CONTRACT = CLOSED
L6B_HANDLER = REGISTERED

L6A = NOT RUN
L6B = NOT RUN
PRODUCTION_MUTATION = NO
PHASE4_RUNTIME_COMPLETE = NO
PHASE4_LIVE_READINESS = NOT READY
```
