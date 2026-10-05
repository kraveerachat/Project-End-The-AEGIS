# AEGIS IDEA3 PR11 Phase 4 — T1 / G-15 capture, compare, and stage-gate harness

Repository framework only. **Nothing here has run on the Core or Production.**

```text
T1_SCOPE                       = G-15 repository framework (capture / compare / stage gate / rollback contract)
G15_CLOSED                     = YES — repository framework closed; live rollout remains separate
PRODUCTION_MUTATION            = NO (no script in this directory changes host state)
LIVE_STAGE_AUTHORIZED          = NO (the gate always prints NO)
STAGE_ROLLBACK_HANDLERS        = L1, L2, L3, L4, L5, L6a, L6b, L7, L8, L9 REGISTERED (repository only; live execution NOT authorized)
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
- `ALLOW_TRANSITIONS_FILE` (stage L3 or stage L4; each stage ships its own file
  `stages/<L>/allow-transitions.txt`) activates one exact semantic regulatory
  window: the phy behind `AEGIS_AP_INTERFACE` (`wlp0s20f3`) may stay `00` (proven
  live: the self-managed phy stays `00` through the exact rfkill unblock), stay
  `TH`, or go `00 -> TH` (tolerated, never required). The file must contain
  exactly one of `stage L3` / `stage L4` and `wifi.reg.<AEGIS_AP_PHY> 00 TH`; anything else stops the
  run. The phy comes from the capture key `wifi.iface.<if>.phy` in both bundles.
  Every other `wifi.reg.*` change (global, other phys, `TH -> 00`, other
  countries, a changed rule table without the approved transition) stays
  protected drift and can never be approved through `ALLOW_KEYS_FILE`.

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

**§10 fail-closed behavior is preserved.** An unhealthy IDEA2 tunnel in the before
capture (inactive, `:18002` absent, or a journal failure class) yields
`IDEA2_TUNNEL_BASELINE_UNHEALTHY` even when nothing changed, so
`PRESERVATION_S10=FAIL` and `COMPARE_RESULT=FAIL`, and every live stage stays
blocked.

**Accepted narrowed criterion (window delta).** A historical absolute
`idea2.tunnel.NRestarts > 0` that arose before the preservation window is recorded
in evidence but is not by itself a current-health failure. Within the window,
`NRestarts` and `MainPID` must be unchanged; any increase or PID change, a new
failure class, or loss of `:8077`/`:18002` still fails. The compare summary prints
`IDEA2_NARROWED_CRITERION=WINDOW_DELTA_ACCEPTED_BY_IDEA2_OWNER`.

Post-merge status: `PR189=MERGED` (`PR189_MERGE_SHA=9f6a0f4167d814cd090c47916d12d7b10397cb0e`),
`IDEA2_OWNER_ACCEPTANCE=APPROVED` (Pub, `pubpup2006p-design`),
`IDEA2_S10_WINDOW_DELTA_CRITERION=ACCEPTED`. Acceptance covers the criterion only;
fresh BEFORE/AFTER preservation evidence is still needed per stage
(`S10_STAGE_PRESERVATION_EVIDENCE=REQUIRED_PER_STAGE`).
Last fresh evidence (owner-run): `FRESH_DISK_USE=88%`,
`LAST_FRESH_IDEA2_OBSERVATION_SECONDS=821`, `ENGINE_NRESTARTS=0->0`,
`TUNNEL_NRESTARTS=15->15`. `L1_LIVE_EXECUTION=NOT_RUN`, `A_L1=NOT_ISSUED`,
`FRESH_K3_L1=NOT_ISSUED`, `PRODUCTION_MUTATION=NO`.

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
that fresh stage-local IDEA2 preservation evidence exists
(`S10_CRITERION_OWNER_ACCEPTANCE=APPROVED`, `S10_PRESERVATION_EVIDENCE=REQUIRED_PER_STAGE`). In `live` mode, a
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
and L6a under `stages/L6a/`. Separately reviewed task registers L7 under
`stages/L7/`. All seven stage handlers (L2, L3, L4, L5, L6a, L6b, L7) are now
registered in the repository framework.

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

- Registered the reviewed L4 stage handler (`stages/L4/`) with the T1 stage framework (`apply.sh`, `verify.sh`, `rollback.sh`, `allow-keys.txt`, `allow-listeners.txt`, `allow-transitions.txt`; live helper `p4-l4-live.sh`).
- L4 transitions the L3 NetworkManager AP connection profile (`aegis-idea3-ap.nmconnection`) from `ipv4.method=disabled` to `ipv4.method=manual` with `never-default=true`. AP IPv4 addressing is applied without creating default gateways, NAT/masquerade, or routing bridges.
- L4 deploys a dedicated `dnsmasq` instance (`/etc/aegis-idea3/dnsmasq-ap.conf`, `aegis-idea3-dnsmasq.service`) serving the AP DHCP pool and Core-local DNS mapping the owner-supplied broker hostname to the Core AP address on `wlp0s20f3` using the merged T5 template.
- L4 live starts only from the already-applied L3 AP (AP type, SSID `AEGIS-IDEA3`, channel 6, no IPv4, no global IPv6, no AP default route, alternate default route) and runs the M-14 regulatory/channel gate read-only before the profile changes. Reactivation is `nmcli connection up "$CONN_ID" ifname "$AP_IF"` (never NetworkManager device selection); afterwards `l3_reg_verify_active` re-checks AP type, exact channel 6, target-phy country TH-or-00 and an unrestricted channel before dnsmasq starts. The L4 comparator accepts only target-phy `00 -> 00`, `00 -> TH`, `TH -> TH`; `TH -> 00` and any other regulatory drift fail. L4 never runs `iw reg set`, `nmcli radio wifi on` or rfkill; the M-15 Wi-Fi baseline stays outside L4.
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
- Time synchronization contract: requires pre-handoff `systemd-timesyncd.service` active and running with `TrustedClock = SYNCED` and `maxerror <= 1,000,000 us`. Enforces bounded holdover <= 300 s during handoff. Remediated after the failed live attempt l5-20260925-174630 (apply passed on `Leap status : Normal`, verify then failed the kernel-based TrustedClock check ~0.8 s later): apply now waits, bounded (default 60 s, `AEGIS_L5_READINESS_TIMEOUT_SEC`, well inside the 300 s HOLDOVER limit), until chronyd reports `Leap status : Normal` AND the same predicate verify uses holds (adjtimex probe readable, kernel synced, `maxerror <= 1,000,000 us`, TrustedClock `SYNCED`), implemented once in `p4-l5-clock.py`. Failures name the reason (`PROBE_UNAVAILABLE`, `KERNEL_UNSYNCED`, `MAXERROR_EXCEEDED`, `TRUSTEDCLOCK_NOT_SYNCED`, `CHRONY_LEAP_NOT_NORMAL`) as `TRUSTEDCLOCK_READINESS_TIMEOUT:<reason>` / `FINAL_TRUSTED_CLOCK_NOT_SYNCED:<reason>`; apply writes `readiness.log` plus `chronyc-tracking.txt` / `chronyc-sources.txt` into the work directory. On timeout apply fails and the L5 rollback restores `systemd-timesyncd`. Post-apply verification requires final `TrustedClock = SYNCED` and `maxerror <= 1,000,000 us`; final `HOLDOVER`, `UNTRUSTED`, or `UNKNOWN` is strictly rejected.
- Strict listener contract: requires `udp <AEGIS_AP_ADDRESS>:123`, permits loopback-only `udp 127.0.0.1:323` and `udp [::1]:323` if observed; wildcard (`0.0.0.0`, `[::]`), non-AP NTP, non-loopback 323, and TCP/123 are strictly rejected.
- Rollback: `stages/L5/rollback.sh` is idempotent. It stops `chronyd.service`, restores captured pre-L5 `/etc/chrony.conf` bytes, uid, gid, and mode (or removes `/etc/chrony.conf` if absent pre-L5), restores captured pre-L5 `systemd-timesyncd.service` runtime `ActiveState` without altering `UnitFileState`, and verifies `TrustedClock = SYNCED`. Rollback fails closed (`ROLLBACK_PRE_STATE_UNKNOWN`, `ROLLBACK_ORIGINAL_SNAPSHOT_MISSING`, `ROLLBACK_RESTORE_MISMATCH`, `ROLLBACK_CHRONYD_STILL_ACTIVE`) instead of silently passing: apply records the SHA-256 of the original `/etc/chrony.conf`, and rollback verifies restored bytes, size, mode, mtime (restored exactly with `touch -m -d @<snapshot mtime>`; the compared metadata includes mtime) and (live) uid/gid against it.
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

### L7 handler (Core credential delivery & service startup)

- Registered the reviewed L7 stage handler (`stages/L7/`) under the G-15 handler framework (`apply.sh`, `verify.sh`, `rollback.sh`, `allow-keys.txt`, `allow-listeners.txt`) conforming to approved operational design OD-L7-01 through OD-L7-08.
- Owner-supplied Production credentials: `k_c2d`, `k_d2c`, `mqtt-core.pass`, `admin.pin`, `restore.credential` are ingested exclusively from a private input directory (`AEGIS_L7_INPUT_DIR`, mode 0600 or 0400, regular files only, no symlinks).
- Zero repository Production key generator: production keys are generated owner-controlled offline. The repository contains only fixture keys and protocol validators proving byte-for-byte parity with ESP32 NVS provisioning (`p4-nvs-provision.py`).
- D4 local restore prerequisite: `restore.credential` must be present and pass cryptographic format validation before the first Core service start.
- File staging & permissions: stages `/etc/aegis-idea3/credentials/` (directory mode 0700, secret files mode 0600), `/etc/aegis-idea3/core.env` (mode 0600), `/etc/systemd/system/aegis-idea3-core.service` (mode 0644), and immutable release pointer `/opt/aegis-idea3/current` symlink.
- Shared G-15 capture & compare amendment: implements Option A narrow exact host-file exception (`^host\.(aegis_idea3\.file\.|path\.|symlink\.|unit_file\.)`) permitting approved stage file changes while maintaining default-deny on host identity, kernel, boot ID, and twingate; captures `/opt/aegis-idea3/current` symlink target and `/etc/systemd/system/aegis-idea3-core.service` unit content sha256/metadata.
- L6b regression compatibility: L6b `allow-keys.txt` is validated regression-free under the Option A amendment.
- Listener contract: `allow-listeners.txt` has zero active entries (`L7_ALLOW_LISTENERS_EMPTY = YES`). Core daemon opens no listening sockets.
- Safety & boundary verification: zero relay actuation (`CUT_UPLINK`, `RESTORE_UPLINK`) in `core-audit.sqlite3`. Fails closed if audit SQLite DB is corrupt or unreadable.
- Rollback: `stages/L7/rollback.sh` is idempotent. Restores pre-state captured in `prestate.manifest` (unit file, core.env, credentials, symlink). Strictly preserves durable SQLite databases (`/var/lib/aegis-idea3/data/core-audit.sqlite3`) and logs.
- Provenance: `RED_FIRST_PROVEN = YES` (28 expected failing tests before implementation).
- Live execution: `L7_LIVE_AUTHORIZED = NO`, `LIVE_L7 = NOT_RUN`. Predecessor live stages remain NOT RUN. IDEA2 §10 blocker remains open.
- All stage handlers (L2, L3, L4, L5, L6a, L6b, L7) are now registered in the repository; the IDEA2 §10 caveat remains open and blocking; `PHASE4_LIVE_READINESS` remains `NOT READY`.

### L7 live preparation (2026-09-27, repository only — supersedes the L7 handler description above where they differ)

Design amendments: `docs/superpowers/specs/2026-09-21-idea3-pr11-phase4-l7-operational-design.md` §7. `L7_LIVE_EXECUTED = NO`, `L7_LIVE_AUTHORIZED = NO`, `L7_RUNNER = TEMPLATE_UNPINNED`.

- `stages/L7/apply.sh|verify.sh|rollback.sh` were rewritten to the L6b standard: journal-before-create, exact ownership plan, exact clean prestate, immutable-release guard, verified unit, `enable --now`, journal-driven rollback with `reset-failed <Core unit only>` and a proven `not-found/inactive/dead/success` end state. Ownership: credentials dir `root:aegis-idea3 0750`; `k_c2d`/`k_d2c`/`mqtt-core.pass`/`admin.pin` `root:root 0600`; `restore.credential` `aegis-idea3:aegis-idea3 0600`; `core.env` `root:aegis-idea3 0640` (rendered, no secret); Core CA copy `/etc/aegis-idea3/pki/mqtt-ca.crt` and the unit `root:root 0644`.
- New tools: `p4-l7-release-guard.py` (existence + provenance of an ALREADY INSTALLED release), `p4-l7-core-env.py` (render/validate core.env), `p4-l7-broker-probe.py` (credential-free TLS-hostname handshake), `p4-l7-run-lib.sh` (read-only gates) and the unpinned `owner-run/run-l7-owner.sh` (refuses to run until frozen outside the repository with the merged main SHA and the installed release id).
- Core change: `AEGIS_MQTT_TLS_SERVER_NAME` — the L6 broker certificate is DNS-only (`mqtt.aegis.home.arpa`, no IP SAN) while the Core connects to the AP IP, so verification against the IP failed; the Core now verifies the configured DNS name (verification stays fully on).
- Prerequisites the L7 runner cannot satisfy: an installed release under `/opt/aegis-idea3/releases/<id>` (not present on the host as of 2026-09-27), owner input (`l7-owner-input`), fresh same-day A-L7 (with `d6_notice=pub`) and K3. See "L7 release builder / verifier" and "L7 release installer" below for the 2026-09-28 update to the release-install gap itself.

### L7 release builder / verifier (repository tooling; no install) — **PR #208 MERGED into main, 2026-09-27**

- `p4-l7-build-release.py build --source-root <git repo> --staging-root <user dir> --release-id <id> --wheelhouse <dir>` builds `<staging>/<id>/` (`venv/bin/python`, the exact `aegis_soc` runtime closure of `python -m aegis_soc.supervisor --profile production --live --headless --no-detector --no-voice` computed from source by AST, `requirements.txt`, `RELEASE-MANIFEST.json`, `RELEASE-SHA256SUMS`). `verify <release-dir> [--expect-owner self|root|any]` is read-only and deterministic.
- Never writes `/opt` or any system location, never uses sudo/chown/systemd/NetworkManager/rfkill/iw, installs only from the local wheelhouse (`pip --no-index --isolated --only-binary=:all:`), bounds venv/pip/smoke by timeouts, and refuses a dirty source tree, an existing or symlinked destination, staging that aliases the source, non-regular source files, unmapped third-party imports and any symlink, `.git`, `__pycache__`, credential-like file or private-key material in the payload.
- Manifest fields (exact allowlist): `schema_version`, `release_id`, `source_git_sha`, `source_tree_dirty`, `python_version`, `requirements_sha256`, `file_count`, `created_by_tool_version`. No username, hostname, environment or secret path.
- The interpreter is a copy, but the venv still resolves the standard library from the base Python named in `pyvenv.cfg` (`home`); the release is therefore bound to that system Python version (`python_version`).
- `p4-l7-build-release.py` is now canonical `main` tooling (merged via PR #208). A real release built by it was independently validated, in a separate process, against this branch's `p4-l7-release-guard.py`: `L7_RELEASE_GUARD=PASS`, exact schema/layout match, no mismatch — this is no longer a cross-branch compatibility claim, both tools are combined in this branch.
- Installing a built, guarded release into `/opt/aegis-idea3/releases/<id>` is now implemented — see "L7 release installer" below.

### L7 release installer (repository tooling; closes the release-install gap) — NEW 2026-09-27

- `p4-l7-install-release.py install --release-id <id> --source <builder output dir> --logical-path /opt/aegis-idea3/releases/<id> [--host-root <fixture root>] [--evidence <file>]` copies a COMPLETED `p4-l7-build-release.py` output into `/opt/aegis-idea3/releases/<id>/`. It is the missing link between the builder (produces a release in a user-owned staging directory) and `p4-l7-release-guard.py` (proves an already-installed release's contract) — no prior tool in the repository copied a built release into place.
- **Ownership contract (corrected 2026-09-27):** the source builder output is always validated with the REAL `p4-l7-release-guard.py` (imported directly, never a copied predicate) at `--expect-owner any` — it is always user-owned and the installer never demands the caller chown it first. The staged copy and the FINAL installed release are re-validated at `--expect-owner root` **by default**; that default is never weakened by a general CLI switch. `--fixture-dest-owner-any` is the one narrowly named exception, and it is refused outright unless `--host-root` (a fixture filesystem root) is also given, so it can never silently apply to a live install.
- Refuses to overwrite an existing release, never recurses into `/opt/aegis-idea3`, refuses a symlinked destination or ancestor, stages through a sibling `.install-tmp-<id>-<random>` directory (0700) and places the release with one atomic `os.rename`. Fails closed with no retry; a failure before the rename removes only its own temp staging; an already-placed release is never later removed or altered. Never reads, writes, or names a credential file, and issues no systemd/sudo/subprocess call.
- **Never touches `/opt/aegis-idea3/current`.** `stages/L7/apply.sh` remains the sole owner of that symlink (creates it only if absent, refuses to move it); the installer and L7 apply can never race or double-own the same mutation.
- Evidence (`--evidence`) records only `release_id`, `source_git_sha` and the logical destination path — no host username, no absolute source/staging path, no secret.
- Proven end to end: a release built by the merged PR #208 tool, installed by this tool into a fixture root, passes `p4-l7-release-guard.py check` unchanged.

> [!IMPORTANT] Governance gap (not repository-fixable; owner decision required before ANY live use)
> This tool is repository-only and fixture-tested; it has **no owner-run wrapper and is not wired into any live workflow**. `deploy/pr11-phase4/p4-lib.sh` fixes the known stage set (`P4_STAGES = "L0 L1 L2 L3 L4 L5 L6a L6b L7 L8 L9"`) and `p4-stage-gate.sh` authorizes only those stage names; there is no existing stage id, authorization-record field, or K3 contract for a pre-L7 release-install mutation, and none is invented here. Design §6 item 5 and §7 already flag "an owner decision on the release installer" as open (2026-09-21 / 2026-09-27). Before any live release install, the owner must decide: (a) register it as its own G-15 stage (e.g. an `L6c`-style slot, with its own `stages/<id>/apply.sh` etc. and `A-<id>`/K3), or (b) fold it into `A-L7` with an explicit extra authorization field recognized by `p4-stage-gate.sh`. Until that decision is made and implemented, this tool exists only as a tested repository capability.

### L6c handler (Immutable Release Install) — NEW 2026-09-27

Design: `docs/superpowers/specs/2026-09-27-idea3-pr11-phase4-l6c-release-install-governance.md`. `L6C_STAGE = IMPLEMENTED_REPOSITORY`, `L6C_RELEASE_INSTALL = PROVEN`, `L6C_LIVE_ACCEPTANCE = PROVEN`, `L6C_COMPLETE = YES`, `L7_STARTED = NO` (2026-09-28 live acceptance; see design §12).

- Owner decision approved: a separate G-15 stage, `L6c` / "Immutable Release Install", between L6b and L7 in `P4_STAGES`. `A-L6c` / a fresh `stage=L6c` K3; no `d6_notice`; `p4_stage_gaps L6c = none` (it installs code only, never a protocol key or a Core credential).
- `stages/L6c/apply.sh|verify.sh|rollback.sh` call the already-merged `p4-l7-install-release.py` and `p4-l7-release-guard.py` exactly, without duplicating their predicates. Mutation boundary: `/opt/aegis-idea3/releases/<release-id>` plus only the parent directories this stage itself creates. It never touches `/opt/aegis-idea3/current` (stages/L7/apply.sh remains its sole owner), credentials, `core.env`, systemd, the Core service, the network, the L6b broker, NTP, Twingate, IDEA1/IDEA2, ESP32 or L8.
- G-15 fix: `p4-l0-capture.sh` now records `host.path./opt/aegis-idea3`, `host.path./opt/aegis-idea3/releases`, and a new deterministic `host.aegis_idea3.release_catalog` fingerprint: `<id>:<tree-state sha256>` pairs, sorted, comma-joined. The tree-state digest (`p4-l6c-tree-digest.py`) is computed over each release's ACTUAL current filesystem entries — relative path, type, uid, gid, permission bits, and (for regular files) real byte content — never merely over that release's own `RELEASE-SHA256SUMS` claim about itself, so a payload edit, a chmod/chown, a directory-mode change, an added/removed entry, or a planted symlink/special file are all detected even when `RELEASE-SHA256SUMS` itself is untouched. Regular payloads are opened with `O_NOFOLLOW`, their opened inode/metadata must match the preceding `lstat` and stay stable through the read, and the whole tree is rescanned before returning a digest. An observed race fails closed as `UNREADABLE`; without filesystem snapshot support a sufficiently privileged ABA mutation entirely between checks cannot be excluded, so the live contract also requires the root-owned immutable tree to be quiescent during capture. Never file contents, never an individual path, are recorded — only the one final digest per release id. A new opt-in `ALLOW_L6C_RELEASE_FILE` in `p4-compare.sh` approves the addition of exactly one named new release id and can never approve a mutation or removal of an existing one.
- `p4-l6c-run-lib.sh` + `owner-run/run-l6c-owner.sh`: unpinned template (main SHA, release id, and expected source SHA all pinned when frozen), one attempt per `A-L6c` (`L6C-ATTEMPT-CONSUMED`). Every read-only gate — including the PRE evidence capture and its SHA256 validation — completes before the one-shot authorization is consumed; a failed PRE capture leaves the attempt marker absent, performs no mutation, and preserves evidence. Bounded rollback with zero-drift PRE→RB on any failure after the first mutation; no automatic retry.
- `p4-l7-install-release.py` never repairs a pre-existing parent directory (`/opt/aegis-idea3`, `/opt/aegis-idea3/releases`): every existing ancestor is validated before mutation (real directory, never a symlink, never group/other-writable), and its uid/gid/mode are preserved; adding a legitimate child may naturally advance the parent's mtime. A parent directory this attempt creates gets the exact reviewed mode (`0o755`).
- `stages/L6c/rollback.sh` derives its release-guard ownership expectation the same way `verify.sh` does (`any` under a fixture root, `root` by live default) rather than a hard-coded `any`, so a live rollback can never delete a tree whose ownership has drifted away from root.
- `L6C_RELEASE_INSTALL = PROVEN` is a prerequisite FACT for L7, never an authorization: L7's own `l7_release_gate` independently re-runs the release guard read-only before consuming `A-L7`. L6c PASS does not authorize L7; a fresh `A-L7` and L7 K3 are still required, and neither record can be reused across L6c/L6b/L7 (`p4-stage-gate.sh`'s `stage=` match).

### L7u handler (Post-L7 Recovery Core Upgrade) — NEW 2026-10-01, repository only, NOT live

Stage order: `L7 → L7u → Recovery R1-R8 → LVR → L8`. L7u moves the running Core onto a NEW immutable release that contains the merged Core-mediated
Recovery runtime and provisions its transport surface. It does **not** prove Recovery R1-R8, does **not** prove LVR and does **not** authorize L8 (and
carries no `recovery_authorization`; that stays L8-only). Design/spec:
`docs/superpowers/specs/2026-10-01-idea3-pr11-phase4-l7u-post-l7-recovery-core-upgrade.md`.

- `p4-l7u-upgrade.py` — the engine (`preflight|apply|verify|rollback|delta`). Every mutation is journaled before it happens; rollback refuses unknown or
  mismatched state before changing anything. The CLI always acts on the real host and has no host-root option; only the Python API (fixture tests) takes a
  fixture `Host`/`Backend`. Backend argv is fixed: one owned group (`aegis-idea3-recovery`), `gpasswd -a|-d`, one tmpfiles rule file, and
  `systemctl daemon-reload|restart|stop|start|reset-failed|show` on `aegis-idea3-core.service` only.
- `stages/L7u/{apply,verify,rollback}.sh` — thin root-only wrappers (refuse without `AEGIS_L7U_LIVE_AUTHORIZED=YES`); `allow-keys.txt` (exact approved
  PRE→POST keys), `allow-listeners.txt` (empty: the channel is an AF_UNIX socket), `allow-keys-rollback.txt` (only the old Core's restart-volatile `MainPID`
  and `ExecMainStartTimestamp`; every other key must equal PRE).
- `../aegis-idea3-core-recovery.dropin.example` (`SupplementaryGroups=aegis-idea3-recovery`, `ReadWritePaths=/run/aegis-idea3-recovery` — the base unit's
  `ProtectSystem=strict` makes `/run` read-only) and `../aegis-idea3-recovery.tmpfiles.example` (`d /run/aegis-idea3-recovery 0750 aegis-idea3
  aegis-idea3-recovery -`): the directory is pre-provisioned because the Core's `UMask=0077` would make the application's own `mkdir` 0700.
- `p4-l7u-run-lib.sh` — own one-attempt marker, receipt gate (current L7 acceptance required; refuses if L7u is already recorded), exact running-Core baseline
  gate, exact operator-identity gate, evidence secret scan. `owner-run/run-l7u-owner.sh` — unpinned template (three `PIN_` values; refuses to run as
  committed): gates → build the release with `p4-l7-build-release.py` → engine preflight → **PRE capture** → consume the one attempt → apply (once) → verify → POST capture
  → PRE→POST compare + exact-value delta + secret scan → persistent on success; bounded rollback + PRE→RB zero-drift compare on failure; no retry.
- Observability: `p4-l0-capture.sh` records the `host.aegis_idea3.recovery.*` group/runtime-dir/socket/Core-property keys, the drop-in and tmpfiles files, and the
  relevant `host.path.*` flags; `p4-compare.sh` accepts the `host.aegis_idea3.recovery.` key family and the single stage line `stage L7u` in `ALLOW_L6C_RELEASE_FILE`.
- Live boundary: nothing here has run on a host. The owner freeze workflow must pin the runner; Kla/Pub integration review applies to the shared harness files.

### L8 handler (ESP32 inspection / NVS provisioning / firmware flash)

- Registered the reviewed L8 stage handler (`stages/L8/`) under the G-15 handler framework (`apply.sh`, `verify.sh`, `rollback.sh`, `allow-keys.txt`, `allow-listeners.txt`) conforming to operational design OD-L8-01 through OD-L8-09.
- Device backends: `fixture` (file-backed, no serial code path) and `hardware` (`HARDWARE_BACKEND_IMPLEMENTED_REPOSITORY`): a subprocess adapter over the PlatformIO-pinned `tool-esptoolpy` 2.41100.0 (esptool 4.11.x). It is reachable only with `AEGIS_L8_BACKEND=hardware` AND `AEGIS_L8_LIVE_AUTHORIZED=YES` plus `AEGIS_L8_ESPTOOL` (absolute path to the pinned `esptool.py`); the serial port comes only from `device.identity`. Every command passes one injectable executor and a strict argv allowlist (`flash_id`, `write_flash`, `read_flash` only, on the two derived partition regions). Boot verification is a passive, subscribe-only signed BOOT STATUS check (`p4-l8-boot-verify.py`: TLS 8883, the staged Core broker credential, real Protocol v1 verifier over ephemeral state, 180 s deadline, PASS = authenticated firmware-reported LOCKDOWN, not electrical proof); hardware also needs `AEGIS_L8_BROKER_ADDRESS`, `AEGIS_L8_BROKER_TLS_NAME`, `AEGIS_L8_MQTT_CA_FILE`, `AEGIS_L8_BROKER_CREDENTIAL_FILE`, and refuses before any device access without them (`BOOT_VERIFICATION_NOT_CONFIGURED`). Live hardware was never exercised: `LIVE_L8=NOT_AUTHORIZED`, `LIVE_L8_PHYSICAL_PROOF=NOT_PROVEN`.
- Input contracts: `device.identity`, `d4.attestation`, `k_c2d`, `k_d2c`, `wifi.psk`, `mqtt.pass` from private owner-only files (mode 0600 or 0400).
- Zero host drift: `allow-keys.txt` and `allow-listeners.txt` carry zero active entries.
- Rollback: splits at first hardware write; holds fail-secure (`D4_ONLY`).

### L9 handler (authentication without actuation)

- Registered the reviewed L9 stage handler (`stages/L9/`) under the G-15 handler framework (`apply.sh`, `verify.sh`, `rollback.sh`, `allow-keys.txt`, `allow-listeners.txt`) conforming to operational design OD-L9-01 through OD-L9-09.
- Backend: fixture backend only (`LIVE_L9=NOT_AUTHORIZED`); live backend refused at two independent layers (`apply.sh` and `p4-l9-auth.py`).
- Inbound & outbound contracts: verified authenticated HEARTBEAT (Core -> device) with dead-man reset only; verified authenticated BOOT and PERIODIC STATUS (device -> Core) with liveness beginning only after first authenticated status.
- Fail-closed rejections: negative probes (replay, wrong key foreign/cross-direction, tampered MAC/field, zero MAC, stale/future skew, device/topic mismatch, untrusted time, malformed/legacy v0) rejected with no liveness and no replay row.
- Zero actuation: zero COMMAND, CUT, or RESTORE issued; zero relay actuation (`relay_actuation=NONE`); zero command rows in store.
- Zero host drift: `allow-keys.txt` and `allow-listeners.txt` carry zero active entries (`HOST_PRE_TO_RB_ZERO_DRIFT=YES`).
- Evidence: private write-once bundle (`l9-auth-evidence.json`, mode 0600) with strict 19-field allowlist; zero key material, MAC, or `msg_id` emitted.
- Rollback: removes stage-local fixture store (`fixture-protocol.sqlite3*`) and preserves evidence; takes no Core or device action (idempotent).
- Live execution: `L9_LIVE_AUTHORIZED=NO`, `LIVE_L9=NOT_RUN`. Predecessor live stages remain NOT RUN.
- All stage handlers (L2, L3, L4, L5, L6a, L6b, L7, L8, L9) are now registered in the repository; L1 remains the unregistered mutating stage fixture; `PHASE4_LIVE_READINESS` remains `NOT READY`.

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
rtcsync
```

Validation rejects unresolved placeholders, wildcard or broad AP scope,
`allow all`, additional upstreams, additional active directives, `rtcfile`,
a missing `rtcsync`, and `local` / `local stratum` fallback behavior. The
contract carries `CHRONY_RTCSYNC=REQUIRED`.

`rtcsync` is a fourth ACTIVE CONFIG DIRECTIVE, not a comparator allowance. It is required because chronyd 4.8 on
Linux clears the kernel `STA_UNSYNC` flag only when `rtcsync` is enabled (`sys_timex.c` `set_sync_status()`: "On Linux clear
the UNSYNC flag only if rtcsync is enabled"), and the Core TrustedClock (and `p4-l5-clock.py`) is kernel/adjtimex based.
Without it the L5 contract is unsatisfiable (live attempt `l5-20260925-191827`: chronyd `^*`, Leap Normal, maxerror far below
1,000,000 µs, yet `KERNEL_UNSYNCED` for the whole readiness window). Owner-accepted side effect: while the kernel considers
the clock synchronised, system time may be copied to the hardware RTC about every 11 minutes; that RTC write is not
rollback-reversible. `rtcfile` must never be configured with it. The 60 s readiness bound and the TrustedClock predicate are unchanged.

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

### L3/L4 post-reboot runtime reactivation (repository implementation, 2026-09-27)

Design: `docs/superpowers/specs/2026-09-27-idea3-pr11-phase4-l34-post-reboot-reactivation-design.md`. `REACTIVATION_TYPE = RUNTIME_ONLY`:
restores the already accepted persistent L3/L4 configuration to its accepted active runtime state after a reboot. It is **not** an L3/L4
apply, never rewrites any persistent file, and claims **no** new `L3_LIVE_ACCEPTANCE` / `L4_LIVE_ACCEPTANCE`. `LIVE_REACTIVATION = NOT_AUTHORIZED`;
`K12_AUTOMATIC_REBOOT_PERSISTENCE = NOT_PROVEN`.

- `reactivation/l34/{apply,verify,rollback}.sh` (+ allow files): exact-ID rfkill unblock (`p4-l3-rfkill.sh`), bounded NM readiness and one
  `ifname`-bound activation (`p4-l3-nm.sh`), Model B regulatory gate (`p4-l3-regulatory.sh`), `reset-failed` + `start` of only
  `aegis-idea3-dnsmasq.service`. Every change is journaled first; rollback undoes exactly the journal and never recreates the stale
  `start-limit-hit`. Fresh L2/PF-01/no-NAT/forwarding proof and persistent-file snapshots; nothing in `/etc` is written.
- `p4-l34-reactivation-lib.sh`: static and runtime gates, one-bounded-attempt marker, receipt gate at the pinned commit, PSK leak scan.
- `p4-compare.sh` gains the opt-in `ALLOW_DYNAMIC_TRANSITIONS_FILE`: a closed catalog of exact value transitions (dnsmasq
  `failed/failed/start-limit-hit` -> `active/running/success`, rollback -> `inactive/dead/success`, and the `WIFI` field of `nm.general`).
  It is off by default, cannot approve anything outside the catalog, and every existing comparison is unchanged.
- Authorization reuses `AEGIS_P4_AUTHORIZATION_V1` + fresh K3 with `stage=L4` and an exact `L3_L4_RUNTIME_REACTIVATION` scope line.
- `owner-run/run-l34-reactivation-owner.sh` is an **unpinned template** that refuses to run until the owner freeze workflow pins the merged main.

#### L3/L4 reactivation — live attempt 2 and the V3 preservation model (2026-09-27)

Design: `docs/superpowers/specs/2026-09-27-idea3-pr11-phase4-l34-v3-preservation-design.md`. Attempt 2 proved the V2 radio path (apply PASS, verify PASS, AP and
dnsmasq active) and failed only at preservation: NetworkManager Wi-Fi initialization added the p2p pseudo-device, started `wpa_supplicant`, and moved the
target phy `00 -> TH` (changing `wifi.phy.sha256`); rollback was safe but not byte-exact. Authorization consumed, no retry.

- `p4-compare.sh` `ALLOW_DYNAMIC_TRANSITIONS_FILE` gains four V3 operations (`L34_V3_POST_FRESH|POST_RESIDUAL|ROLLBACK_FRESH|ROLLBACK_RESIDUAL`) with closed
  catalogs and value classes (`<absent> <empty> <nonempty> <positive> <sha256>`). wpa_supplicant and the phy digest rules are **relational** (radio transition,
  active AP, no unrelated Wi-Fi, unit facts, regulatory transition, `wifi.phy.regnorm_sha256` equality, channel 6 permitted). No generic allow key.
- The capture adds `wifi.phy.regnorm_sha256` and `wifi.phy.channel6_permitted` via `p4-iw-phy-regnorm.awk` (removes only the regulatory annotations of the
  frequency entries; capabilities, modes, commands and identity still change the digest).
- `apply.sh` (`AEGIS_L34_PRESERVATION=V3`) classifies the FRESH or RESIDUAL baseline and rejects mixed states; `verify.sh` proves the exact envelope;
  `rollback.sh` reports `SAFE_NETWORK_BOUNDARY_RESTORED` separately from `EXACT_PRESTATE_RESTORED`. It never stops wpa_supplicant, removes the p2p device,
  sets the regulatory domain or restarts NetworkManager.
- The runner template carries the V3 scope (168 chars) and picks its catalogs from the reported baseline; still an unpinned template.

#### L3/L4 reactivation — live attempt 1 failure and NM radio remediation (2026-09-27)

Design: `docs/superpowers/specs/2026-09-27-idea3-pr11-phase4-l34-nm-radio-remediation-design.md`. The first live attempt failed closed with
`NM_WIFI_RADIO_DISABLED` (authorization consumed, rollback PASS, PRE->RB PASS, no retry): the exact rfkill unblock made NetworkManager report
"Wi-Fi now enabled by radio killswitch" but its own software radio flag stayed off, so the target stayed `unavailable`. No target-scoped NM action
exists; enabling the radio is a global NM change and a **new owner decision boundary**.

- The global `nmcli radio wifi on` exists only behind `AEGIS_L34_NM_RADIO_ENABLE=YES`, which the runner sets only after verifying the exact V2 scope
  (`L3_L4_RUNTIME_REACTIVATION_V2: rfkill 1 unblock, temp wlp0s20f3 autoconnect off, NM radio on, activate aegis-idea3-ap, reset-failed+start dnsmasq, no persistent rewrite`, 168 chars). Preflight requires wlp0s20f3 to be the sole Wi-Fi device/wlan
  rfkill with no active Wi-Fi connection; a runtime `nmcli device set wlp0s20f3 autoconnect no` guard precedes the enable (12 saved Wi-Fi
  profiles have autoconnect); the PRE autoconnect value is restored; rollback turns the radio off only if this run enabled it.
- The comparator is unchanged (the exact `nm.general#WIFI disabled -> enabled` rule already exists; the rollback catalog has none).
- Runner defect fixed: `compare()` had `local ... rc=0 local -a env_allow` (`not a valid identifier` at run time, invisible to `bash -n`); tests now
  execute the function.

### L6b stage-owned live preparation (owner decisions 2026-09-27)

Design: `docs/superpowers/specs/2026-09-27-idea3-pr11-phase4-l6b-operational-design.md`. Repository preparation only;
`L6B_LIVE_EXECUTED = NO`, `L6B_LIVE_AUTHORIZED = NO`, `PHASE4_LIVE_READINESS` remains `NOT READY`.

- `stages/L6b/apply.sh` now **owns** installing `/etc/aegis-idea3/mqtt` (six files, root-owned; the files the privilege-dropped broker reads are `root:mosquitto 0640`, certificates `root:root 0644`; hashed passwd only) and the
  `aegis-idea3-mosquitto.service` unit from a private `AEGIS_L6B_INPUT_DIR` (`ca.crt broker.crt broker.key core.pass device.pass`,
  no `ca.key`). Plaintext passwords are used transiently by `p4-broker-material.py` and never installed. Every created path is
  journaled first; pre-state must be absent.
- `stages/L6b/rollback.sh` removes exactly the journaled stage-owned paths (failure/abort path only; success is **persistent**), then clears failed runtime metadata for `aegis-idea3-mosquitto.service` only (`reset-failed`, after removal + `daemon-reload`) and proves `not-found/inactive/dead/success`.
- `stages/L6b/verify.sh` adds exact-material checks and a live TLS/auth/ACL/negative probe on `127.0.0.1:8883` and the AP address via
  `p4-broker-validate.py validate-live` (never starts a broker, never prints secrets).
- `p4-l0-capture.sh` additionally records `host.path./etc/aegis-idea3/mqtt` and the IDEA3 broker unit file; `stages/L6b/allow-keys.txt`
  approves exactly those plus the material and service keys (no wildcard). PRE -> RB is compared with no allow files.
- `p4-l6b-run-lib.sh` (gates: one-attempt marker, receipt gate bound to the pinned commit, uplink resolution, fresh AP/nft/TrustedClock
  proof, input gate, secret scan) and `owner-run/run-l6b-owner.sh` (an **unpinned template** that refuses to run until the owner freeze
  workflow pins the merged main SHA and copies it outside the repository).
- Predecessor L2/L3/L4 runtime is proven fresh and never reactivated by L6b (`PREDECESSOR_RUNTIME_REACTIVATION_REQUIRED=YES`).

## 9. Stage L1 package installation handler — repository implementation

Stage L1 implements package installation required by OD-01 and OD-06.

Reconciled package requirements:
- OD-01: NetworkManager AP mode (`hostapd` excluded).
- OD-05 / OD-16: DHCP and broker DNS via `dnsmasq` (already installed on host, E-15).
- OD-06: Local NTP server `chrony` (absent on host, E-14). Single stage-owned package target is `chrony`.
- OD-07: Dedicated nftables table (`nftables` already installed on host, E-16).

Repository artifacts:
- `p4-l1-packages.py` provides disk-headroom verification, fixture package simulation, read-only verification, and idempotent rollback.
- `stages/L1/` registers the L1 `apply.sh`, read-only `verify.sh`, idempotent `rollback.sh`, and exact `allow-keys.txt` / `allow-listeners.txt` contracts.
- Two-layer backend guard: `fixture` backend mutates only isolated `AEGIS_P4_FS_ROOT`; `live` backend is refused fail-closed (`LIVE_L1=NOT_AUTHORIZED`).
- Refuses unrelated upgrades (kernel, systemd, NetworkManager, Mosquitto).
- Refuses automatic service activation or enablement (`chronyd.service` remains disabled and inactive).
- `allow-listeners.txt` carries zero active entries.
- Rollback removes strictly stage-owned package delta (`chrony`), preserving pre-existing packages (`dnsmasq`, `nftables`).

```text
L1_REPOSITORY_IMPLEMENTED = YES
L1_FINAL_VALIDATION       = PASS
L1_HANDLER                = REGISTERED (fixture backend only)
L1_LIVE                   = NOT RUN
LIVE_L1_AUTHORIZED        = NO
PRODUCTION_MUTATION       = NO
PHASE4_RUNTIME_COMPLETE   = NO
PHASE4_LIVE_READINESS     = NOT READY
```


### L5 comparator: constrained informational `time.timesyncd.ServerName` (owner decision 2026-09-25)

Restarting `systemd-timesyncd` (the L5 rollback) legitimately reselects one of its configured `FallbackNTPServers`, so `time.timesyncd.ServerName` can differ between PRE and RB. The comparator (`p4-compare.sh`) classifies that single key as `INFO` (`TIMESYNCD_SERVER_RESELECTED_CONFIGURED`) only when ALL hold: `systemd-timesyncd` is `active`/`running` in the AFTER capture, `time.trustedclock.state` is `SYNCED`, `time.timesyncd.FallbackNTPServers` was captured and is identical in both bundles, and the new name is a member of that set. Otherwise it stays `NEW_OR_WORSENED_DRIFT`. It is not an allowance key: the three rollback-only allowance keys (`svc.systemd-timesyncd.service.MainPID`, `svc.systemd-timesyncd.service.ExecMainStartTimestamp`, `svc.chronyd.service.ExecMainStartTimestamp`) are unchanged, and every other time-state key is judged independently. The capture records `time.timesyncd.FallbackNTPServers` and `time.trustedclock.state` (live via the read-only `p4-l5-clock.py state`, the only python helper the read-only guard allows).

## 8. L5 attempt #2 remediation (rtcsync, raw kernel evidence, mutation accounting)

- **Raw kernel evidence.** `p4-l5-clock.py` appends `adjtimex_ret=<n> status=0x<hex> sta_unsync=<0|1> time_error=<0|1>` to `state`/`probe`
  output and to every `readiness.log` poll line (one adjtimex read per poll, shared by the evidence and the predicate decision);
  `p4-l5-clock.py raw` prints the fields alone. The synchronized decision itself is unchanged (`aegis_soc.trusted_time`).
- **Whole-run mutation marker.** `apply.sh` records `PRODUCTION_MUTATION_PERFORMED=YES` (`FIXTURE_ONLY` under a fixture root) on stdout and in
  `$WORK/production_mutation_performed` BEFORE its first write to `/etc` (the temporary config file), so a later readiness failure cannot
  erase it. `p4-compare.sh` keeps its comparison-local `PRODUCTION_MUTATION_PERFORMED=NO`; the owner runner relabels it
  (`COMPARE_LOCAL_…`) via `p4-l5-run-lib.sh` and reports `RUN_PRODUCTION_MUTATION_PERFORMED` from the apply marker only.
- **Owner-readable evidence.** `p4-l5-run-lib.sh` `l5_copy_work_diagnostics` streams the root-owned `l5-work` files into a 0700 copy with a
  `SHA256SUMS` manifest; originals are never modified.
- Unchanged: exact chrony.conf mtime rollback, constrained `time.timesyncd.ServerName` INFO policy, S10 fail-closed comparison, the three
  rollback-only allowance keys, one attempt per authorization, no automatic retry.

## 10. Governed dnsmasq unit boot-order repair (`dnsmasq-unit-boot-order-repair`) — repository implementation

> **IMPLEMENTED != DEPLOYED.** Nothing in this section has been run on the host. Design: `docs/superpowers/specs/2026-10-03-idea3-dnsmasq-unit-boot-order-governed-repair-design.md`.

- **What it is for.** PR #305 fixed the canonical `deploy/network/aegis-idea3-dnsmasq.service.example` in the repository, and the corrected L34 authority now refuses the OLD pre-PR305 unit that is still
  installed on the host, so every L34/V5–V8 reactivation is blocked until the repaired unit is installed and qualified. This task-specific package does ONLY that — it is not an L-stage, invents no L-number
  and replays no V-stage.
- **Files.** `p4-dnsmasq-repair-lib.sh`; `reactivation/dnsmasq-unit-boot-order-repair/{apply,verify,rollback,reboot-verify}.sh` plus its allow files; `owner-run/run-dnsmasq-unit-boot-order-repair-owner.sh`
  (frozen, one attempt, inert as committed); `owner-run/verify-dnsmasq-boot-order-after-reboot.sh` (separate, read-only, never reboots).
- **Mutation scope.** Render the canonical template with the fixed approved values, atomically install the unit, `daemon-reload`, then `reset-failed` + `start` (failed/start-limit-hit baseline) or `restart`
  (running baseline) of `aegis-idea3-dnsmasq.service` only. No AP, NetworkManager, nftables, forwarding, broker, Twingate, Core, Recovery, F1, L8p or ESP32 action.
- **Governance.** Fresh same-day `stage=L4` authorization with the exact repair scope + K3, exact-main frozen runner, marker `DNSMASQ-UNIT-REPAIR-ATTEMPT-CONSUMED` consumed after preflight + PRE capture, PRE → APPLY → VERIFY →
  POST → exact comparator → journal-owned rollback, terminal verdict `PASS | ROLLED_BACK | ROLLBACK_FAILED_ESCALATE | NOT_STARTED_NO_MUTATION`, no automatic retry.
- **K12.** The repair run claims no reboot persistence. The separate reboot verification records `K12_PERSISTENCE_OBSERVED` and, independently, `K12_FORMALLY_PROVEN=NO`; `K12_AUTOMATIC_REBOOT_PERSISTENCE`
  stays `NOT_PROVEN` until the owner/integration reviewer records an acceptance decision.

### 10.1 Governed successor (SAFE_STOPPED + pre-consume S10 guard) — repository only

The first live attempt of this package was consumed and ended `ROLLBACK_FAILED_ESCALATE` at S10 (IDEA2 already unhealthy); it is never replayed (`OLD_ATTEMPT_RETRY_ALLOWED=NO`, historical AUTH_DIR on a denylist, brand-new AUTH_DIR required). The package now also accepts the exact `SAFE_STOPPED` baseline (`daemon-reload` → `start`, no `reset-failed`/`restart`; comparator operation `DNSMASQ_SAFE_STOPPED_POST` via `allow-dynamic-transitions-safe-stopped-post.txt`) and the owner runner takes a read-only PRE→S10 stability capture/compare **before** the attempt marker is consumed. See `docs/superpowers/specs/2026-10-03-idea3-dnsmasq-safe-stopped-governed-successor-design.md`. Nothing was executed live.

## 11. Governed PRE-L8p NTP runtime reactivation (`pre-l8p-ntp-runtime-reactivation`) — repository only

After a reboot the host is back at `systemd-timesyncd` active/enabled, `chronyd` inactive/disabled and no UDP/123 listener: historical L5 (LIVE-PROVEN, unchanged) mutated runtime `ActiveState` only and never enabled/disabled a unit, so `K12_AUTOMATIC_REBOOT_PERSISTENCE=NOT_PROVEN` predicts exactly this. This package is the smallest governed successor that restores the approved runtime handoff before L8p — `systemctl stop systemd-timesyncd.service` then `systemctl start chronyd.service`, nothing else (no enable/disable, no `/etc/chrony.conf` write, no network/AP/dnsmasq/broker/Core change). It is **not** an L5 rerun, L5 acceptance, K12 proof or L8p. Read-only PRE gates (exact units and `UnitFileState`, AP `10.77.30.1/28`, approved config SHA-256, no alternate chronyd config path, no port-123 listener, shared L5 TrustedClock predicate), a fresh same-day `stage=L5` Authorization/K3 with the exact `PRE_L8P_NTP_RUNTIME_REACTIVATION` scope, a dedicated one-attempt marker, a pre-consume S10 stability guard, a frozen operator identity and an inert pinned runner template (`owner-run/run-pre-l8p-ntp-runtime-reactivation-owner.sh`); failure rolls back runtime state only. See `docs/superpowers/specs/2026-10-03-idea3-pre-l8p-ntp-runtime-reactivation-design.md`. Nothing was executed live.

### 11.1 Post-live forensic fix (2026-10-03) — repository only

The first live attempt of section 11 was **consumed** and is never rerun or reused (marker `PRE-L8P-NTP-RUNTIME-REACTIVATION-ATTEMPT-CONSUMED`, evidence `2026-10-03-pre-l8p-ntp-reactivation-20261003-171818` kept as recorded). `NTPREACT_APPLY=PASS` and the pre-POST `NTPREACT_VERIFY=PASS` are true history; the runner then printed `PRE_L8P_NTP_RUNTIME_REACTIVATION=PASS` / `NTP_RUNTIME_READY_FOR_L8P=YES` from that stale VERIFY output. Final readiness after the POST capture was **not proven and was invalidated**: the host ended `systemd-timesyncd` active / `chronyd` inactive / no UDP :123 without a reboot.

Root cause (confirmed from code, journal timing consistent; not reproduced live): `p4-l0-capture.sh` issued `timedatectl show-timesync`, which asks systemd-timesyncd and **activates** it when stopped; `chronyd.service` has `Conflicts=systemd-timesyncd.service`, so the POST capture stopped chronyd (journal: chronyd exit 17:19:00.476, timesyncd start .478, during the POST capture). `p4-lib.sh` classifies `show-timesync` as read-only inspection, which is true only while timesyncd is already running.

Successor repair (all fail-closed): (A) the capture queries the timesyncd-specific properties only while timesyncd is `active`/`running`, otherwise records the sentinel `TIMESYNCD_INACTIVE_NOT_QUERIED` for `time.timesyncd.{ServerName,SystemNTPServers,FallbackNTPServers}` and issues no timesync command (`time.timesyncd.FallbackNTPServers` joins the package allow list; config FILE keys stay protected); (B) regression tests with a stateful fake `show-timesync` that models the activation; (C) the NTP runner derives its PASS verdict from a FINAL read-only `ntpreact_runtime_ready_gate` run after the POST capture and compare, rolling back on failure; (D) the L8p runner proves the same gate in its pre-gates and again after the PRE capture, before the attempt marker. A new NTP attempt needs a new exact-main frozen runner, a brand-new same-day AUTH_DIR/Authorization/K3 and explicit owner authorization; none exists.

## 12. Stage F1 — governed F1 detector unit install + ONE start (OD-F1-STAGE-01) — repository only

Operational order: `L7 → L7u → L8p → F1 → Recovery R1-R8 → LVR → L8 → L9`. `F1` is registered in `P4_STAGES` after `L8p` and before `L8` (no gap, no extra authorization field; never `F1b`). It closes only the deployment gap left by `p4-f1-alert-source.py`: that tool already owned the ordered START gate, but nothing governed installing the unit, `daemon-reload` or an owned rollback.

- **Scope.** Install the exact pinned unit (`deploy/aegis-idea3-detector.service.example`, rendered SHA-256 pinned by the frozen runner) to `/etc/systemd/system/aegis-idea3-detector.service` (`root:root 0644`, temp file `O_EXCL` + no-overwrite `link`), `systemctl daemon-reload`, start the detector **exactly once** by calling the reviewed `p4-f1-alert-source.py` `start_detector` (account uid, `core.env` uid, RUNNING Core uid + group, alert socket modes are re-proved there, not duplicated), observe for a bounded settle window, verify, and on failure roll back **only what this attempt journalled**.
- **Files.** `p4-f1-deploy.py` (tool; `F1Backend` allow-list = `show` of Core/detector, `daemon-reload`, one `start`, `stop` of the detector unit only; a second `start` in a process is refused), `p4-f1-run-lib.sh` (gates, `F1-ATTEMPT-CONSUMED`, receipt gate), `owner-run/run-f1-owner.sh` (inert exact-main template, five `PIN_` values), `stages/F1/{apply,verify,rollback}.sh` + empty `allow-keys.txt`/`allow-listeners.txt`.
- **Governance.** Same-day `authorization-F1.txt` + `k3-F1.txt` (`stage=F1`), exact-main frozen runner, marker `F1-ATTEMPT-CONSUMED` consumed after preflight + PRE capture, own receipt gate (the canonical L8p closeout receipt must carry `L8P_LIVE_EXECUTED=YES` and `L8P_PROVISIONING=PASS`; an F1 receipt carrying `F1_PRODUCTION_DEPLOYED=YES` and `F1_DETECTOR_STARTED=YES` makes F1 one-shot), no automatic retry.
- **Preflight (before any mutation).** exact main + clean worktree, L8p closed, Core running baseline, preserved services, IDEA2 §10, headroom, detector account exact uid, `core.env` alert uid, running Core carries the uid, alert directory `2750` / socket `0620` owner+group, R2/R6/R7 probe settings present, unit pin matches, detector unit/process ABSENT everywhere systemd looks.
- **Never.** Restart the Core, edit `core.env`/users/groups, enable the unit, inject an alert, fabricate R1, run Recovery R1-R8, send CUT/RESTORE, touch the ESP32 or serial, or retry. A pre-existing unit is never replaced or removed; a changed or unidentifiable installed unit makes rollback refuse (owner decision).
- **Claims.** Success proves only `F1_PRODUCTION_DEPLOYED=YES` and `F1_DETECTOR_STARTED=YES`. `F1_REAL_DETECTOR_ACCEPTANCE` stays `NOT_PROVEN`, `RECOVERY_R1_R8_PROVEN=NO`, `R1_VERIFIED=NOT_CLAIMED`. The detector follows NEW journal lines once started, so a naturally occurring REAL validated alert during the F1 window is an external production event: the stage neither injects, fabricates, accepts nor rolls back such an alert or incident, and it does NOT claim `RECOVERY_LIVE_EXECUTED=NO` (it cannot prove that). A real alert is accepted only by a separate governed step.
- **Pre-start ownership.** After `daemon-reload`, and again immediately before the single start (a hook inside the backend), the unit must still be exactly `LoadState=loaded`, `ActiveState=inactive`, `SubState=dead`, `MainPID=0`, `NRestarts=0`, `Result=success`, `UnitFileState=disabled`, `Restart=no`, `FragmentPath` = the installed path; otherwise the stage refuses BEFORE issuing the start and never adopts a concurrently started process. `UnitFileState` must be exactly `disabled` after the start too (enabled, enabled-runtime, linked, masked, static… are refused).
- **Rollback fail-closed ordering.** If the journal says this attempt did NOT issue the start, rollback first reads the detector state (read-only) and requires `ActiveState` inactive|failed and `MainPID=0`; an active/PID-bearing detector is another actor's process, so it refuses `ROLLBACK_EXTERNAL_DETECTOR_ACTIVE` before any stop, unlink or `daemon-reload` (owner decision; our exact unit stays). The bounded stop applies only when this attempt issued the start.
- **`core.env` is secret-metadata-only.** Apply holds its bytes in memory only, compares them byte-for-byte after the start and discards them; only `CORE_ENV_PRESERVED=YES` is persisted. No `core.env` bytes or digest reach the journal or evidence; the later `verify` re-runs only the existing non-secret `verify_env` predicate.
- **Limitation.** The shared L0 capture does not record the detector unit file or its runtime state, so the PRE→POST compare (empty allow files) proves only that no OTHER captured Core-host record drifted; the unit itself is proven by the stage's own exact checks (SHA-256, owner/mode, inode, `LoadState`/`ActiveState`/`SubState`/`MainPID`, Core PID/`NRestarts`/`core.env` bytes unchanged).

### 12.1 Attempt-1 failure and the successor repair (2026-10-04) — repository only

Live attempt 1 of stage F1 failed closed (`DETECTOR_NOT_RUNNING`), rolled back (`F1_ROLLBACK=PASS`, `PRE_RB_COMPARE=PASS`) and its authorization is **consumed**. Cause: `ProcSubset=pid` hides `/proc/sys/kernel/random/boot_id`, so the detector's own `journalctl -f` exited (`Failed to get boot ID: No such file or directory`), and `production_detector` then returned exit 0 on the journal EOF. Repair: the unit no longer sets `ProcSubset=pid` (new SHA-256 `da40399ef57b1e29cf30dc63792f67ded15333faacd8a3e04feb1c8e60d419b9`; `verify-unit` refuses any `ProcSubset=` line; all other hardening kept), and `production_detector` exits `3` (`JOURNAL_SOURCE_UNAVAILABLE`) instead of `0` when its follower ends or cannot start. The stage's verify path is unchanged (`ActiveState=active`, `SubState=running`, `MainPID>0`, `Result=success`, `NRestarts=0`, `UnitFileState=disabled`, `Restart=no`). The detector runs from the INSTALLED release, so the exit-code change needs a new release install; the unit fix does not. Any new attempt needs a new owner decision, fresh records and a runner frozen to the new digest; nothing here authorizes it.

## 13. Stage F1r — governed current-release activation, NO Core restart (OD-F1R-01) — repository only

Operational order: `L7 -> L7u -> L8p -> F1i -> F1r -> F1 -> Recovery R1-R8 -> LVR -> L8 -> L9` (F1i = the governed post-L7 repaired-release install, §14; the earlier idea of reusing L6c for it was rejected because L6c is a pre-L7 stage). F1r requires the F1i closeout receipt (exactly one receipt with `F1I_LIVE_EXECUTED=YES`, `F1I_RELEASE_INSTALLED=YES` and `F1I_RELEASE_ID=<NEW_RELEASE_ID>`). `F1r` is registered after `L8p` and before `F1` (no repository gap, no extra authorization field).

- **Scope.** F1r owns ONLY the atomic switch of `/opt/aegis-idea3/current` from the exact frozen OLD release to the exact frozen, **already-installed** NEW release. It installs nothing, and `CORE_RESTART_POLICY=NO_RESTART`: the privileged backend of `p4-f1r-switch.py` can only `systemctl show` the Core and detector units, so no restart/start/stop/reload exists. The running Core keeps its MainPID, NRestarts and working directory; changing `current` does **not** move the running Core to the new release (it runs the new release only after a separately authorized restart, which F1r never performs).
- **Files.** `p4-f1r-switch.py` (tool), `p4-f1r-run-lib.sh` (gates, `F1R-ATTEMPT-CONSUMED`, receipt gate, exact-transition gate), `owner-run/run-f1r-owner.sh` (inert exact-main template, seven `PIN_` values), `stages/F1r/{apply,verify,rollback}.sh` + `allow-keys.txt` (exactly one key) + `allow-listeners.txt` (empty).
- **Preflight (before any mutation).** exact main + clean worktree; fresh same-day `authorization-F1r.txt` + `k3-F1r.txt` (`stage=F1r`); marker unconsumed; L8p closeout receipt; the frozen detector digest equals the reviewed source at the pinned main; `current` is exactly the OLD target (string equality) and OLD and NEW pass the existing release guard at `--expect-owner root`; NEW manifest release id and source SHA exact, `source_tree_dirty=false`, `aegis_soc/production_detector.py` bytes equal the frozen digest; detector unit/process absent; Core active/running (PID, NRestarts and, if readable, cwd snapshotted); IDEA2 §10, preserved services, disk headroom.
- **Apply.** Journal the exact OLD target, re-read `current` immediately before the mutation (refuse unless still exactly OLD), journal, create a temp symlink and `os.replace` it over `current` (atomic: `current` is never absent), fsync the directory, journal `switched`, then verify `readlink` and `realpath` equal the exact NEW target. Neither release directory is opened for writing, chmod'ed, chown'ed or deleted.
- **Verify.** exact NEW target; NEW release guard + id + source SHA + detector digest; OLD release intact; Core MainPID/NRestarts unchanged (and cwd if readable); detector absent. The comparator covers listeners and every other captured record.
- **Rollback.** Owns only a switch this attempt journalled. No switch → `NOTHING_OWNED`. Switched → prove `current` is still exactly the NEW target (anything else fails closed before any mutation), atomically restore the exact OLD target, then prove Core unchanged and detector absent. Never deletes a release, never restarts the Core, never starts/stops the detector.
- **Comparator contract.** The L0 capture records `current` as `host.symlink./opt/aegis-idea3/current.target` (value = `readlink`). `stages/F1r/allow-keys.txt` approves exactly that key (key approval only, like L7u); the exact OLD→NEW values are proven by the tool and by the runner's `f1r_current_transition_gate` against the PRE/POST `host.tsv`. Zero listener additions; the PRE→RB comparison uses no allowances; any other captured drift (including the Core MainPID) fails.
- **Root read authority.** `/opt/aegis-idea3` and its releases may be root-only and `/proc` must show every process, so the read-only `check` / `check-runtime` gates run through `$SUDO` (`sudo env PYTHONDONTWRITEBYTECODE=1 <python> <tool> check …`), never as the plain operator user; `sudo -v` alone only authenticates. A denied read is a fixed refusal (`HOST_READ_DENIED` / `PROC_READ_DENIED`), never read as "absent", and a failed elevation fails the gate (`ROOT_READ_UNAVAILABLE`) before the attempt is consumed. The runner's `readlink /opt/aegis-idea3/current` checks also use `sudo`. Permissions are never loosened to make the gates pass.
- **Complete detector absence.** The tool proves BOTH surfaces: the systemd unit (no unit file anywhere, `LoadState=not-found`, inactive, `MainPID=0`) AND no standalone `aegis_soc.production_detector` process (exact argv-token match over `/proc`, detection only; nothing is ever stopped or signalled). The same check runs in preflight/`check`, apply, verify, `check-runtime` and the rollback postcondition, and the runner re-proves absence again after PRE capture and immediately before `F1R-ATTEMPT-CONSUMED` (tool + the shell `f1_detector_absent_gate`).
- **Future F1 attempt 2 hardening.** The F1 runner template gains three runtime pins (`EXPECTED_RUNTIME_RELEASE_ID`, `EXPECTED_RUNTIME_RELEASE_SOURCE_SHA`, `EXPECTED_PRODUCTION_DETECTOR_SHA256`) and a read-only `f1_runtime_release_gate` (via `p4-f1r-switch.py check-runtime`) run before PRE capture and again before the one-shot consume, so F1 cannot consume its attempt while Production still resolves the old detector. `UNIT_SHA256` stays a separate pin; no existing F1 gate is weakened. The F1 receipt gate additionally requires the F1r predecessor: from the pinned commit, exactly ONE status-log receipt carrying BOTH whole-line `F1R_LIVE_EXECUTED=YES` and `F1R_CURRENT_SWITCHED=YES` (split fields, duplicates, a missing receipt, or a repository-only record that says NO all refuse); the runtime pins stay as defense in depth (they prove what is installed, the receipt proves it went through F1r).
- **Not authorized / not run.** The L6c repaired-release install, F1r live and F1 attempt 2 are all NOT YET AUTHORIZED; no authorization/K3 records were created and no runner was frozen.
- **Limitations.** Repository tests prove repository behavior only. `/proc/<CorePID>/cwd` is root-only on this host, so the cwd proof applies when readable and is otherwise recorded as `UNREADABLE`. The shared capture/compare set is zero-tolerance, so an unforeseen captured record that changes with `current` would fail the comparison and roll the switch back.

## 14. Stage F1i — governed POST-L7 install of one repaired immutable release (OD-F1I-01) — repository only

Operational order: `L7 -> L7u -> L8p -> F1i -> F1r -> F1 -> Recovery R1-R8 -> LVR -> L8 -> L9`. Design: `docs/superpowers/specs/2026-10-04-idea3-pr11-phase4-f1i-post-l7-release-install.md`.

- **Why not L6c.** The L6c verifier is intentionally PRE-L7 (credentials and `core.env` absent, Core unit `not-found`), false by design on the post-L7 host. A maintenance reuse of L6c on 2026-10-04 ran its installer, **failed its own verifier closed** (`L7_MATERIAL_PRESENT:/etc/aegis-idea3/credentials`), rolled back (`L6C_ROLLBACK=PASS`, `L6C_MATERIAL_RESIDUE=NO`, `PRE_RB_COMPARE=PASS`, `PRESERVATION_S10=PASS`), `L6C_LIVE_ACCEPTANCE=NOT_PROVEN`, no release installed; its authorization is **consumed and never reused**. L6c is unchanged and stays correct for a pre-L7 install.
- **Files.** `p4-f1i-install.py` (tool), `p4-f1i-run-lib.sh`, `owner-run/run-f1i-owner.sh` (inert template, seven `PIN_` values), `stages/F1i/{apply,verify,rollback}.sh` + `allow-keys.txt` (zero keys) + `allow-listeners.txt` (empty). `p4-compare.sh` gains only the label `stage F1i` on the existing relational catalog rule.
- **Mutation boundary.** Only `/opt/aegis-idea3/releases/<RELEASE_ID>`, created by the reviewed `p4-l7-install-release.py` exactly once. Never `/opt/aegis-idea3` or `releases` themselves, `current`, an old release, credentials, `core.env`, units, the Core, the detector, broker, Recovery, IDEA1/IDEA2 or the ESP32. Privileged backend = `systemctl show` of two units + that one fixed argv.
- **Post-L7 preservation.** credentials, `core.env` and a loaded/running Core unit are PRESERVED state, never required absent: metadata unchanged (content compared in memory inside apply only, never persisted or hashed), `current` byte-identical, Core same MainPID/NRestarts, new release guarded root-owned with exact id/source SHA/clean tree/detector digest and unchanged tree digest, detector absent (unit AND standalone process).
- **Comparator.** Captured key `host.aegis_idea3.release_catalog`; allow-keys has zero keys; the relational rule (`stage F1i` + `release_id`) permits exactly one added id while every existing release stays byte-identical; the runner also proves the added entry carries the journaled tree digest. Current, listener and material/Core drift fail; PRE→RB uses no allowance.
- **Rollback.** Ownership is a STRICT journal-state boundary, never "a valid release exists": `installing` (INSTALL OUTCOME UNKNOWN) and `installer_failed` (the installer's fixed parsed verdict is persisted BEFORE raising) are NEVER deletion authority — target absent → `NOTHING_OWNED`; target present → fail closed (`INSTALL_OUTCOME_UNKNOWN` / `FOREIGN_OR_UNPROVEN_TARGET`) and untouched, even when the installer said `RELEASE_ALREADY_INSTALLED` and the foreign release is fully valid. Only `installed`/`applied` WITH a journaled `release_tree_digest` (written in the same durable write as `installed`) own the release; a missing digest is `JOURNAL_OWNERSHIP_UNPROVEN`. Then it proves current unchanged, no temp residue, root guard, exact id/source SHA/detector digest and the exact tree digest, removes exactly that directory (tree pre-scanned for symlinks/specials), and proves target absent, current/Core/detector/material unchanged. Unknown phases or state fail closed; leaving possible residue and escalating is preferred over deleting a release this attempt did not install.
- **Runner.** read-only gates (root reads through `$SUDO`) → PRE capture → re-prove target absent, current exact, Core snapshot, detector absent → `F1I-ATTEMPT-CONSUMED` → apply once → verify → POST → catalog transition proof → comparator → success; failure after consume → one bounded rollback → RB capture → PRE/RB zero drift → no retry. Source: `f1i-owner-source/<RELEASE_ID>` (builder output, `--expect-owner any`).
- **Claims.** Success proves only the install (`F1I_LIVE_EXECUTED`, `F1I_RELEASE_INSTALLED`, `F1I_RELEASE_ID`); never the switch (F1r), the detector (F1), Recovery, LVR, L8 or L9. **Not authorized / not run:** F1i live, F1r live, F1 attempt 2.

## 15. Stage F1u — governed post-F1 Core upgrade (owner amendment OPTION A) — repository only

Operational order: `L7 -> L7u -> L8p -> F1i -> F1r -> F1 -> F1u -> R1I -> [R1A: owner-approved stage model, NOT registered here] -> Recovery R2-R8 -> LVR -> L8 -> L9`. Design: `docs/superpowers/specs/2026-10-05-idea3-pr11-phase4-f1u-post-f1-core-upgrade.md`. `F1U_STAGE_ID_OWNER_APPROVED=YES`, `R1I_STAGE_ID_OWNER_APPROVED=YES`, `R1A_STAGE_ID_OWNER_APPROVED=YES` (R1A gets its own task, branch and PR). F1u is a NEW governed successor, never a retry or replay of L8p, the F1i/F1r live attempts or F1 attempt #2 (all consumed).

- **Why.** PR #342 is new Core runtime code (`ALERT_ACCEPTED`). The running Core is an older process and `current` points at `c223…`, which predates #342. F1u installs ONE new immutable release, switches `current` OLD -> NEW, restarts the Core EXACTLY ONCE, and proves the restarted Core runs from the NEW release (its working directory, never merely the pointer).
- **Detector lifecycle (`F1U_DETECTOR_LIFECYCLE_AMENDMENT=OPTION_A`, `F1U_DETECTOR_DEPENDENCY_CYCLE_OWNER_APPROVED=YES`).** `aegis-idea3-detector.service` has `Requires=`/`After=aegis-idea3-core.service`, so the normal `systemctl restart aegis-idea3-core.service` makes SYSTEMD stop the running detector D1 and start a NEW D2 from the new release. That cycle is an owner-approved, F1u-owned consequence of the one Core restart: not an F1 replay, not a detector deployment, not a hidden repair. `IGNORE_DEPENDENCIES_USED=NO`; the unit files and `Requires=` are not edited, no drop-in is added. The privileged backend accepts `systemctl show` of the two units and EXACTLY `systemctl restart aegis-idea3-core.service`; every detector action, other verb or option is refused (`EXPLICIT_DETECTOR_SYSTEMCTL_MUTATIONS=0`).
- **Detector proof.** PRE: D1 loaded/active/running, `MainPID>0`, disabled, `Restart=no`, no drop-in, exactly one process, the reviewed unit digest, the pinned `production_detector.py` digest, runs from the OLD release. POST: D2 active/running, `D2 != D1`, newer start (timestamp and monotonic, never before the Core's own start), a changed `InvocationID` when systemd reports one, the SAME unit bytes and source bytes, disabled, `Restart=no`, exactly one process, running from the NEW release, stable across two reads and unchanged again at `verify`. `NRestarts` is only a sanity value (`Restart=no`), never lifecycle evidence. Anything else (detector absent, wrong bytes, duplicate process, unchanged identity) fails closed and is never repaired by F1u.
- **Files.** `p4-f1u-upgrade.py`, `p4-f1u-run-lib.sh`, `owner-run/run-f1u-owner.sh` (inert, nine `PIN_` values), `stages/F1u/{apply,verify,rollback}.sh`, `allow-keys.txt`, `allow-keys-rollback.txt`, `allow-listeners.txt` (empty). `p4-l0-capture.sh` additionally records the detector unit (service state and unit file) and the running Core/detector release identity so the comparator can prove the lifecycle and the runtime; `p4-compare.sh` accepts the label `stage F1u` for the relational one-release catalog allowance.
- **Predecessor gates (receipt CONTENT of the pinned commit, never the PR number).** exactly ONE canonical receipt carrying `F1_LIVE_RESULT=PASS`, `F1_PRODUCTION_DEPLOYED=YES`, `F1_DETECTOR_STARTED=YES`; exactly ONE canonical receipt carrying `R1_EVIDENCE_VERIFIER_IMPLEMENTED=YES`, `F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN`, `R1_VERIFIED=NOT_CLAIMED`; no contradictory live claim anywhere; F1u not already recorded. Zero, duplicate, split or malformed receipts refuse.
- **Apply.** read-only gates and PRE capture -> re-prove -> `F1U-ATTEMPT-CONSUMED` (atomic, one-shot) -> install the release once -> switch once (`journal` before each step) -> Core restart once -> proofs (Core P2 != P1, `NRestarts` 0, cwd = NEW release, Recovery/alert sockets exact owner/group/mode AND held by the Core process via `/proc`, `AEGIS_ALERT_SOURCE_UID` contract, detector lifecycle, `core.env`/credentials unchanged) -> POST capture -> comparator -> secret scan. No alert is sent and no socket is connected to, so no audit row exists.
- **Comparator.** Allowed PRE->POST: `current` target, the Core `MainPID`/`ExecMainStartTimestamp`, the detector `MainPID`/`ExecMainStartTimestamp`, and exactly one new release catalog entry (relational rule; the runner also proves the value). Every other captured field — detector unit bytes, `UnitFileState`, state, `Result`, `NRestarts`, `core.env`, sockets, groups, units, listeners — must be identical. PRE->RB: only the same four identity keys may differ.
- **Rollback.** Journal-owned. Before the restart was issued: restore `current`, remove ONLY the owned release (journaled tree digest re-proved), detector D1 untouched. After the restart: restore `current`, then BEFORE any rollback Core restart re-prove (a) the detector authority — loaded unit path, no drop-in, unit digest, disabled, `Restart=no`, exactly one process running the pinned source when active, no process without an active unit — so a foreign detector is never cycled by the rollback's own restart (it refuses with `DETECTOR_AUTHORITY_FOREIGN:*` and zero restarts), and (b) the Core equivalence below; only then ONE more Core restart (same argv) onto the OLD current release; the detector cycles AGAIN as the dependency consequence (D1 -> D2 -> D3, acceptable only because each cycle is explained by an owned Core restart and the code/unit proofs hold), then the owned release is removed. A detector that is inactive (the failed apply restart did not bring it back) is permitted: the rollback restart never starts it and the post-check escalates; F1u issues no detector command. Unknown or foreign state, or an unexplained detector, escalates; no retry.
- **Running-Core runtime identity and rollback class (review round 2).** `current` is NOT the running Core: PRE `current` = `c223…`, the PRE running Core = `55c7…`, the PRE detector = `c223…`. The PRE running-Core release (its cwd) is recorded in the journal and in every L0 capture (`host.aegis_idea3.recovery.core.runtime_cwd`, `host.aegis_idea3.alert.detector.runtime_cwd`, via the read-only command guard), so a Core runtime change can never be invisible. A rollback restart lands the Core on the OLD current release (`c223…`), which is NOT the PRE running release, so the class is declared honestly: `EXACT_PROCESS` (Core never restarted: the only exact PRE restoration), `EXACT_RELEASE` (restarted onto the same release; new process) or `SAFE_EQUIVALENT` (a different release MACHINE-PROVEN Core-equivalent: both pass the release guard; schema/python version/requirements digest/file count identical; identical file set; every payload digest identical (venv, interpreter, every `aegis_soc` module, requirements) EXCEPT `RELEASE-MANIFEST.json` and `aegis_soc/production_detector.py`; the manifest differs only in `release_id`/`source_git_sha`; no other module references the detector). Preflight REFUSES (`ROLLBACK_TARGET_NOT_SAFE_EQUIVALENT:*`, nothing mutated) when no such proof exists and the proof is re-run before the rollback restart. Verified read-only on the real `55c7…` vs `c223…` releases: only the two allowed entries differ. The comparator approves the runtime-cwd keys by key only (PRE->RB), and the runner gates `f1u_core_runtime_gate` / `f1u_rollback_class` / `f1u_runtime_transition_gate` prove the exact values and that an exact class cannot hide a changed runtime. `F1U_ROLLBACK_EXACT_PRE_RESTORATION=YES` only for `EXACT_PROCESS`.
- **Execution boundary (review round 3).** A release that is about to become executable authority is re-proved IMMEDIATELY before the restart that executes it. Forward, before the restart is journaled: `current` is still exactly NEW; the NEW release passes the guard with the pinned id/source SHA/`production_detector.py` digest/`recovery_core.py` digest + `ALERT_ACCEPTED`; its tree digest equals the one journaled at install (`NEW_RELEASE_CHANGED_BEFORE_RESTART:*`, zero Core restarts). Rollback, for EVERY class: `current` is exactly OLD; the OLD release passes the full authority checks (guard, id, pinned detector digest); the OLD tree digest and the PRE running-Core release tree digest equal the baselines journaled at PREFLIGHT (reviewed L6c catalog digest helper; `ROLLBACK_OLD_RELEASE_TREE_CHANGED` / `ROLLBACK_PRE_RELEASE_TREE_CHANGED`); only then, for `SAFE_EQUIVALENT`, the equivalence proof is re-run, so it compares the exact PRE-proven immutable trees and never two drifted ones. The equivalence proof alone cannot authorize executing the OLD detector (it lets that file differ), hence the baselines. `EXACT_RELEASE` means the same release CONTENT as PRE, not path equality; a changed tree fails closed instead of declaring it. Any failure refuses before the restart (zero rollback restarts), so a changed NEW or OLD release or detector is never started.
- **Shared IDEA3 Phase-4 harness surfaces touched** (additive, inside `IDEA3-AEGIS_Lockdown/`): `p4-lib.sh` (stage registration), `p4-stage-gate.sh` (F1u no-extra-field rule), `p4-compare.sh` (the `stage F1u` release label), `p4-l0-capture.sh` (detector unit and the running Core/detector release identity), plus the shared stage-list tests and the shared-gate byte-pin tests (re-pinned).
- **Claims.** `F1U_REPOSITORY_IMPLEMENTED=YES`, `F1U_LIVE_EXECUTED=NO`, `F1U_PRODUCTION_DEPLOYED=NO`. F1u proves deployment only: `F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN`, `R1_VERIFIED=NOT_CLAIMED`, `RECOVERY_R1_R8_PROVEN=NO`. Not authorized, not run: no authorization or K3 record, no frozen runner, no release built, no Core restart.
- **Known future finding (documentation only, not implemented here).** The `AEGIS_NEWCONN` firewall-log producer is NOT proven deployed; R1A will need a separate read-only host preflight after F1u and, if absent, a separately governed instrumentation stage.
