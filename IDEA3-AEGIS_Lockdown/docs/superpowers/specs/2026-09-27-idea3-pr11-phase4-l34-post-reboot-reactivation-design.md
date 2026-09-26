# AEGIS IDEA3 PR11 Phase 4 — L3/L4 Post-Reboot Runtime Reactivation Design

Date: 2026-09-27 (Asia/Bangkok). Owner: music. Status: **repository implementation only**.

```text
REACTIVATION_EXECUTED        = NO
LIVE_REACTIVATION_AUTHORIZED = NO
PRODUCTION_MUTATION          = NO   (this document and its implementation)
L3_LIVE_ACCEPTANCE           = PROVEN historically (unchanged, not re-claimed)
L4_LIVE_ACCEPTANCE           = PROVEN historically (unchanged, not re-claimed)
K12_AUTOMATIC_REBOOT_PERSISTENCE = NOT_PROVEN
```

## 1. Problem and evidence

After the host reboot at 2026-09-26 23:46 +07 the accepted persistent L2/L3/L4 configuration is intact but the L3/L4 **runtime** is not
applied. Fresh read-only evidence (owner, 2026-09-27):

| Item | Observation |
|---|---|
| L2 | `table inet aegis_idea3` present with UDP/67, UDP/53, TCP/53, UDP/123, TCP/8883 permits (AP-scoped), TCP/1883 drop (PF-01), AP catch-all drop, forward drop; no NAT/masquerade/SNAT/DNAT; all forwarding sysctls `0` → **L2 REPROVEN, no reapply** |
| rfkill | id `1` type `wlan`, `SOFT=blocked`, `HARD=unblocked` (id `0` is bluetooth, also blocked) |
| NetworkManager | `nmcli radio wifi` → `disabled`; `wlp0s20f3` DOWN, managed |
| Regulatory | global and phy0 (self-managed) `00`; channel 6 (2437 MHz) present with no disabled / No-IR / passive / radar / indoor flag → M-14 Model B satisfied |
| Profile | `aegis-idea3-ap` intact: `mode=ap ssid=AEGIS-IDEA3 band=bg channel=6 ipv4.method=manual 10.77.30.1/28 never-default`; 0600 root:root |
| dnsmasq | `/etc/aegis-idea3/dnsmasq-ap.conf` passes `dnsmasq --test`; unit byte-identical to `deploy/network/aegis-idea3-dnsmasq.service.example`; unit `enabled`, `ActiveState=failed`, `Result=start-limit-hit`, `NRestarts=5` (it started at boot before the AP address existed) |

This is a runtime failure, not missing configuration. Historical L3/L4 acceptance receipts stay authoritative.

## 2. Binding model: `REACTIVATION_TYPE = RUNTIME_ONLY`

The workflow restores the already accepted persistent configuration to its accepted **active** runtime state. It is **not** an L3 apply,
an L4 apply, a reinstall, a profile rewrite, a dnsmasq configuration rewrite, or a new acceptance claim. Its result is named
`L3_L4_RUNTIME_REACTIVATION`; it never writes `L3_LIVE_ACCEPTANCE` or `L4_LIVE_ACCEPTANCE`.

Success means: `wlp0s20f3` active as AP, SSID `AEGIS-IDEA3`, channel 6, exactly `10.77.30.1/28`, no AP default route, the alternate default
route unchanged, `aegis-idea3-dnsmasq.service` active/running with only the approved listeners, L2 nft/PF-01 unchanged, all forwarding `0`,
legacy Mosquitto and Twingate unchanged.

It proves **manual** post-reboot reactivation only: `K12_AUTOMATIC_REBOOT_PERSISTENCE = NOT_PROVEN` unless a separate unattended reboot test
is later performed.

## 3. Absolute file immutability

The workflow never writes `/etc/NetworkManager/system-connections/aegis-idea3-ap.nmconnection`, `/etc/aegis-idea3/dnsmasq-ap.conf`,
`/etc/systemd/system/aegis-idea3-dnsmasq.service`, `/etc/aegis-idea3/aegis-idea3.nft` or any other persistent accepted artifact. The
handlers contain no write, copy, move, install or delete of those paths (enforced by tests). Before mutation they record a snapshot
(mode:uid:gid:size:mtime:ctime plus sha256); verify and rollback fail closed on any difference, including a content-preserving rewrite.
The profile holds the Wi-Fi PSK, so its digest covers only its non-secret lines, its content is never printed, and the runner's
`l34_psk_leak_scan` (through sudo) fails the run if the PSK value or any `psk=` line appears in the evidence.

## 4. Handlers (`deploy/pr11-phase4/reactivation/l34/`)

Not under `stages/`: they are not L3/L4 stage handlers and `stages/L3`, `stages/L4` are never invoked.

### 4.1 `apply.sh` — read-only preflight, then three journaled runtime changes

Preflight (any failure stops **before** any change; `PRODUCTION_MUTATION_PERFORMED=YES` is printed only afterwards):

1. **Persistent configuration** — profile: mode 0600, owner root, `mode=ap`, `ssid`, `band=bg`, `channel=6`, `[ipv4] method=manual`, exactly one
   `address1=10.77.30.1/28`, `never-default=true`, no shared mode, interface binding if present; plus the values NetworkManager itself reports
   (`nmcli -g … connection show`, no `-s`). dnsmasq config: **exactly** the accepted directive set, each once — `interface=wlp0s20f3`,
   `bind-interfaces`, `except-interface=lo`, `dhcp-range=10.77.30.2,10.77.30.14,255.255.255.240`, `dhcp-option=option:router`,
   `dhcp-option=option:dns-server,10.77.30.1`, `no-resolv`, `no-hosts`, `address=/mqtt.aegis.home.arpa/10.77.30.1` — and no other active line.
   Bare directives are verified by exact whole-line match (a grep that requires `=` would miss them). Unit byte-identical to the repository
   example. `dnsmasq --test` passes.
2. **L2 (fresh, never mutated)** — table and every required rule above, AP scoping to `10.77.30.0/28`, catch-all drop in `input`, drop in
   `forward`, no NAT anywhere in the ruleset, exactly one `inet aegis_idea3` table, all seven forwarding sysctls `0`. Failure prints
   `L2_RUNTIME_NOT_READY=YES`.
3. **AP/rfkill/regulatory** — target interface exists, is not already an active AP, has no IPv4 and no default route, an alternate default
   route exists; M-14 Model B gate (`p4-l3-regulatory.sh`: phy country `TH` or `00` and channel 6 unrestricted); rfkill id resolved from sysfs for
   `wlp0s20f3` and required to equal `1` (never merely hard-coded), type `wlan`, `HARD != blocked`.
4. **dnsmasq PRE state** — exactly loaded / enabled / `failed` / `start-limit-hit` / `MainPID=0`. Active or inactive is an unexpected input and
   fails (nothing to reactivate, or a different condition the owner must look at).
5. Baselines written to the work directory: nft table text, all rfkill rows, listeners, default route, legacy/Twingate/IDEA2 `MainPID/NRestarts`.

Runtime changes, each journaled **before** it is made (`journal.tsv`):

1. `RFKILL_UNBLOCK <id>` — only if the target was soft-blocked: `l3_rfkill_prepare` from the merged `p4-l3-rfkill.sh` unblocks exactly that
   id. Never `rfkill unblock all`, never `iw reg set`, and never the global radio in v1 (v1 scope; superseded by the owner-authorized V2 radio enable in the remediation design). Non-target rfkill rows must be unchanged.
2. `NM_UP aegis-idea3-ap` — `l3_nm_wait_ready` (bounded, state based: target device must reach `disconnected`; polling is not a second
   attempt), then **one** `nmcli connection up aegis-idea3-ap ifname wlp0s20f3` via `l3_nm_activate`. Then, bounded: type AP, SSID exactly
   `AEGIS-IDEA3`, channel exactly 6, exactly the single IPv4 `10.77.30.1/28`, no global IPv6, no AP default route, Model B still PASS,
   default route table unchanged.
3. `DNSMASQ_RESET_FAILED`, `DNSMASQ_START` — `systemctl reset-failed aegis-idea3-dnsmasq.service` (after the PRE capture and recorded in the
   journal) then `systemctl start aegis-idea3-dnsmasq.service`; bounded wait for `active`/`running`, `Result=success`, `UnitFileState` still
   `enabled`. No enable/disable, no daemon-reload, no generic `dnsmasq.service`.

`AEGIS_L34_PREFLIGHT_ONLY=YES` runs the preflight only and exits before any change (used by the runner ahead of the PRE capture; the full
preflight runs again inside the mutating apply, immediately before the first change).

### 4.2 `verify.sh` — read-only

Persistent snapshot identical; AP type/SSID/channel/address; default route unchanged; active NetworkManager connection of the target is the
approved profile; target rfkill unblocked and every other rfkill row unchanged; dnsmasq active/running with the persistent identity unchanged;
the **listener delta** for ports 53/67 is exactly `tcp 10.77.30.1:53`, `udp 10.77.30.1:53`, `udp 0.0.0.0%wlp0s20f3:67` (no wildcard, no
loopback, no `enp62s0`); legacy 1883 listeners unchanged; nft table text byte-identical to PRE; L2 gates again; no NAT; forwarding `0`; legacy
Mosquitto, Twingate, IDEA2 engine/tunnel `MainPID/NRestarts` unchanged.

### 4.3 `rollback.sh` — failure/abort path only

Undoes exactly what the journal says, in reverse order, idempotently, accepting only fixed journal entries:

| Journal | Undo |
|---|---|
| `DNSMASQ_START` | `systemctl stop aegis-idea3-dnsmasq.service` (exact unit) |
| `NM_UP` | `nmcli connection down aegis-idea3-ap`, only while that profile is the active connection of `wlp0s20f3` |
| `RFKILL_UNBLOCK` | `l3_rfkill_restore`: re-block exactly the recorded id, only if it was soft-blocked before |
| `DNSMASQ_RESET_FAILED` | **nothing**: rollback does not manufacture a fake `start-limit-hit`; the unit is left in a safe non-running state |

It never deletes or rewrites the profile, dnsmasq config/unit or nft file, never touches nftables, forwarding, regulatory state,
`enp62s0`, legacy Mosquitto or Twingate (v1: never the global Wi-Fi radio; under V2 only the journaled, owner-authorized enable is undone). Proofs afterwards: AP not active, no AP IPv4, dnsmasq not running and `UnitFileState` unchanged,
exact rfkill pre-state restored, other rfkill rows unchanged, persistent files identical, nft table identical, forwarding `0`, identities
unchanged.

## 5. Systemd failed-state reconciliation — the exact design gap and its narrow answer

**Gap.** `p4-compare.sh` is key-based: `ALLOW_KEYS_FILE` approves *any* change of a key, and the only value-level mechanism is the
regulatory `ALLOW_TRANSITIONS_FILE`. Two things legitimately change in this operation and cannot be expressed safely with allow keys:

1. the dnsmasq unit's `ActiveState/SubState/Result` (`failed/failed/start-limit-hit` → `active/running/success`; on rollback →
   `inactive/dead/success`) — an allow key would also approve `active → failed`, `enabled → disabled`-style drift on the same unit;
2. `nm.general` (`STATE:CONNECTIVITY:WIFI-HW:WIFI`): after the exact rfkill unblock NetworkManager flips its radio flag `WIFI` from `disabled`
   to `enabled` (observed baseline `connected:full:enabled:disabled`). `nm.general` is in `PROTECTED`, so it cannot be approved by keys at all —
   without a mechanism the PRE→POST comparison can never pass.

**Answer (opt-in, additive, closed catalog).** `ALLOW_DYNAMIC_TRANSITIONS_FILE` (default off; every existing comparison is unchanged and
tested) activates one operation: `operation L34_RUNTIME_REACTIVATION` (PRE→POST) or `operation L34_RUNTIME_REACTIVATION_ROLLBACK` (PRE→RB).
Every other active line must be **one exact member of that operation's hard-coded catalog** (key, exact before value, exact after value),
single-space separated, each at most once, no CR:

```text
L34_RUNTIME_REACTIVATION
  svc.aegis-idea3-dnsmasq.service.ActiveState  failed         active
  svc.aegis-idea3-dnsmasq.service.SubState     failed         running
  svc.aegis-idea3-dnsmasq.service.Result       start-limit-hit success
  nm.general#WIFI                               disabled       enabled     (only the WIFI field; STATE/CONNECTIVITY/WIFI-HW must stay equal)
L34_RUNTIME_REACTIVATION_ROLLBACK
  svc.aegis-idea3-dnsmasq.service.ActiveState  failed         inactive
  svc.aegis-idea3-dnsmasq.service.SubState     failed         dead
  svc.aegis-idea3-dnsmasq.service.Result       start-limit-hit success
```

A rule approves a change only when the key changed from exactly that before value to exactly that after value (`APPROVED_CHANGE
DYNAMIC_TRANSITION_APPROVED`). Wildcards, other keys/values, the other operation's rules, protected classes, duplicates and malformed files stop
the comparison (`exit 2`). `LoadState`, `UnitFileState`, the profile, the dnsmasq config/sha256 and the nft file are **not** in any catalog:
their drift still fails. Pure bookkeeping keys whose values are runtime-generated (`MainPID`, `NRestarts`, `ExecMainStartTimestamp`) use ordinary
allow keys, exactly as the L4/L5/L6b precedents do: `allow-keys.txt` (POST: the three dnsmasq bookkeeping keys plus the target-interface
runtime keys) and `allow-keys-rollback.txt` (PRE→RB: **only** `NRestarts` and `ExecMainStartTimestamp`, because reset-failed + start + stop
legitimately leaves `NRestarts=0` and a new start timestamp). The regulatory window reuses the existing `ALLOW_TRANSITIONS_FILE`
(`stage L4`, target phy `00→00/TH→TH/00→TH`, no `iw reg set`). Listeners approved: exactly the three above.

If the rollback occurs before anything changed the unit stays `failed` and no transition is needed.

## 6. Authorization model

Reuses `AEGIS_P4_AUTHORIZATION_V1` and fresh K3 (V1 independent, or V2 owner self-attestation) with **`stage=L4`**; no new parser is
introduced. `p4-stage-gate.sh --stage L4 --mode live` validates the records (no L4 extra fields). Because the gate cannot see the operation,
the runner additionally requires the A-L4 `scope=` line to equal exactly:

```text
L3_L4_RUNTIME_REACTIVATION: exact rfkill unblock, activate existing aegis-idea3-ap on wlp0s20f3, reset-failed+start aegis-idea3-dnsmasq, no persistent config rewrite
```

so an ordinary A-L4 for a fresh L4 apply cannot authorize this run and vice versa. The scope covers: the exact target rfkill unblock/restore,
activation of the already accepted persisted profile, reset of the stale dnsmasq failure bookkeeping, start of the already accepted service,
and **no** persistent configuration rewrite. The K3 is fresh (same-day) because Production runtime changes occur. Records are files
`authorization-L4.txt` and `k3-L4.txt` in an `AUTH_DIR`; none are created by this repository work.

## 7. One bounded attempt

`l34_consume_attempt` atomically creates `AUTH_DIR/L34-REACTIVATION-ATTEMPT-CONSUMED` after all pre-gates and before the first evidence
write; a second invocation for the same `AUTH_DIR` is refused even after a failure. Bounded NetworkManager/systemd polling is state
observation, not a second activation attempt (`nmcli connection up` is issued at most once).

## 8. Owner runner (`owner-run/run-l34-reactivation-owner.sh`)

An **unpinned template** (`EXPECTED_MAIN=PIN_MAIN_SHA`, refuses to run as committed), following the L6a/L6b freeze convention: after merge the
owner creates a clean pinned worktree, copies the template outside the repository with the pin replaced, records its SHA-256, writes fresh
same-day A-L4/K3, and runs it once as the normal user.

Sequence: normal user only → `sudo -v` → same-day `stage=L4` records + exact scope → not-consumed check → pinned main / clean worktree /
`origin/main` → stage gate (live mode) → L3/L4 acceptance receipts read from the pinned commit → tools, disk, engine/tunnel/Twingate/legacy
Mosquitto running, **L6b broker inactive and no 8883 listener** → consume the attempt → evidence dir → read-only preflight through the handler
(root, writes only into the evidence dir) → **PRE capture (before rfkill / NetworkManager / reset-failed / dnsmasq)** → apply (once) → verify →
PSK leak scan → POST capture → PRE→POST compare with the exact windows → identity check → closeout. Success leaves the reactivated runtime in
place. Any failure after the first change runs rollback, RB capture and PRE→RB compare (rollback allowances only) and stops without retry; a
failure before the first change (no mutation marker) runs no rollback handler and proves zero drift instead. It never runs L3/L4 `apply.sh`, L6b,
L7 or any ESP32 action, never touches Twingate or legacy Mosquitto, and never edits persistent files.

## 9. Live risks carried to the owner (not provable offline)

- **AP mode after rollback.** After `nmcli connection down` and the rfkill re-block, the phy may still report `type AP` until it is reconfigured;
  the rollback proof `AP_STILL_ACTIVE` and the PRE→RB comparison (`wifi.iface.wlp0s20f3.type`) would then fail closed and escalate. The workflow
  does not run `iw dev … set type managed` (not authorized). This only matters on a failed run.
- **NM activation latency.** Readiness and activation polling are bounded by `AEGIS_L34_NM_TRIES`/`AEGIS_L34_NM_INTERVAL` (default 20 × 0.5 s).
- **dnsmasq start ordering** is by design: the AP address must exist before `systemctl start`, which is why activation precedes it.

## 10. Test map (`tests/test_pr11_phase4_l34_reactivation.py`, simulator `tests/l34_sim.py`)

Exact command set and order; no global Wi-Fi/regulatory/enable commands; PSK never in output/work; rfkill exact-ID binding (soft/hard/ambiguous/
mismatch/missing; unblock only the target; bluetooth untouched); bounded NM readiness; ifname-bound single activation; wrong SSID/channel/
address/default route; regulatory Model B (00/TH accepted, others and every restriction flag rejected); persistent profile/dnsmasq/unit/nft
preflight (every directive incl. bare ones, unexpected/duplicate directives, effective NM values); L2 (every rule, NAT, forwarding); dnsmasq
pre/post state; verify drift matrix (content-preserving rewrite, nft, forwarding, global rfkill, legacy/Twingate/IDEA2 identity); rollback
exactness/idempotence/partial/tampered journal/no deletion/no recreated start-limit-hit; comparator windows (exact, closed catalog,
opt-in, rollback window); runner (unpinned refusal, ordering, one attempt, governance scope, no forbidden actions, no L6b/ESP32).

## 11. Boundary

This design and its implementation authorize nothing. `LIVE_REACTIVATION = NOT_AUTHORIZED` until the owner freezes the runner and writes fresh
same-day A-L4 (exact scope) and K3. It does not change the L6b decision record: L6b live still requires this reactivation (or an equivalent
fresh proof that L3/L4 runtime is applied) first.
