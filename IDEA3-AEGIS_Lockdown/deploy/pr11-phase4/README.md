# AEGIS IDEA3 PR11 Phase 4 — T1 / G-15 capture, compare, and stage-gate harness

Repository framework only. **Nothing here has run on the Core or Production.**

```text
T1_SCOPE                       = G-15 repository framework (capture / compare / stage gate / rollback contract)
G15_CLOSED                     = NO — human review and closeout pending
PRODUCTION_MUTATION            = NO (no script in this directory changes host state)
LIVE_STAGE_AUTHORIZED          = NO (the gate always prints NO)
STAGE_ROLLBACK_HANDLERS        = NONE REGISTERED (contract only)
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

## 4. Rollback handler contract (no handler implemented)

A later, separately reviewed task may register a stage under
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
fallback, or touch IDEA1/IDEA2 state. T1 ships no `stages/` directory; the tests
assert that.

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
