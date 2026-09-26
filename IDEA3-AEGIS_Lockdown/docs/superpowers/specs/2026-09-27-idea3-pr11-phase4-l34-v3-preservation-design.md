# AEGIS IDEA3 PR11 Phase 4 — L3/L4 Reactivation: Live Attempt 2 and the V3 Preservation Model

Date: 2026-09-27 (Asia/Bangkok). Owner: music. Status: **repository remediation only**. Extends the V1 design
(`…l34-post-reboot-reactivation-design.md`) and the V2 remediation design (`…l34-nm-radio-remediation-design.md`).

```text
L34_REACTIVATION_ATTEMPT          = 2
AUTHORIZATION_CONSUMED            = YES   (V2 authorization and frozen V2 runner are spent; RETRY_PERFORMED = NO)
L34_APPLY / L34_VERIFY            = PASS / PASS
NM_RADIO_REMEDIATION              = PASS  (the V2 fix for NM_WIFI_RADIO_DISABLED worked)
PRE_POST_COMPARE / PRESERVATION_S10 = FAIL / FAIL
L34_ROLLBACK_HANDLER              = PASS
PRE_RB_COMPARE                    = FAIL
SAFE_NETWORK_BOUNDARY_RESTORED    = YES
EXACT_PRESTATE_RESTORED           = NO    (rollback is NOT claimed exact)
FINAL_ACCEPTANCE                  = NOT_PROVEN
L6B_REMAINS_BLOCKED               = YES
LIVE_REACTIVATION_AUTHORIZED      = NO    (this remediation authorizes nothing)
```

## 1. Attempt 2 (evidence `2026-09-27-l34-reactivation-20260927-032057`)

V2 reactivated the runtime: preflight PASS, PRE capture, `L3_NM_TARGET_STATE` `unavailable` → `disconnected`, `L34_APPLY=PASS`
(`NM_WIFI_RADIO_ENABLED_BY_RUN=YES`), `L34_VERIFY=PASS` (AP active, SSID `AEGIS-IDEA3`, channel 6, `10.77.30.1/28`, dnsmasq active/running,
persistent files unchanged, no unrelated Wi-Fi, L2/forwarding/legacy/Twingate/IDEA2 unchanged, PSK scan 0 hits). It failed only at PRE→POST
preservation, and the rollback handler passed but PRE→RB failed. The classification is therefore
`RUNTIME_REACTIVATION_PATH=PASS`, `VERIFY=PASS`, `PRESERVATION_MODEL=INCOMPLETE`, `ROLLBACK_HANDLER=PASS`, `ROLLBACK_EXACT_PRESTATE=NOT_ACHIEVED`.

### Proven side effects (all caused by NetworkManager initializing Wi-Fi, none issued by the workflow)

| Side effect | PRE | POST | after rollback |
|---|---|---|---|
| p2p pseudo-device `p2p-dev-wlp0s20f3` (type `wifi-p2p`; active connection `none`) | absent | `disconnected` | `unavailable` (remains) |
| `wpa_supplicant.service` (`UnitFileState=disabled`, `NRestarts=0`, `Result=success`) | inactive/dead/MainPID 0/empty start | active/running/MainPID>0 | same PID, still running |
| target phy regulatory state | `00` | `TH` (already approved by the L4 window) | `TH` (remains) |
| raw `wifi.phy.sha256` | `c4830a27…` | `88370484…` | same as POST |

`wifi.phy.sha256` changed because `iw phy` annotates each **frequency entry** with regulatory state (channel 14 `22 dBm` → `disabled`; 5 GHz
channels gain `no IR` / `radar detection`). The residuals were stable for more than two minutes; they are not settling effects. The current
host state after rollback is the network-safe residual: rfkill 1 soft-blocked, radio `disabled`, `wlp0s20f3` `unavailable`/DOWN/managed, no Wi-Fi
connection, dnsmasq inactive, AP not active. Repository remediation does not touch it.

## 2. Principle

The goal is **not** to hide drift. Every newly accepted side effect is exact, operation-specific, target-specific, value-constrained and
relationally tied to the authorized NM radio transition. There is no generic `wifi.phy.sha256` key, no generic `wpa_supplicant` service key and
no wildcard device allowance; `allow-keys*.txt` contain none of them (tested).

## 3. Comparator model (`p4-compare.sh`, opt-in, off by default)

`ALLOW_DYNAMIC_TRANSITIONS_FILE` gains four operations, each with its own closed, hard-coded catalog of (key, exact before, exact after). Value classes
are limited to `<absent>`, `<empty>`, `<nonempty>`, `<positive>` (integer ≥ 1) and `<sha256>`; everything else is an exact literal. The v1/v2
operations are unchanged.

| Operation | Catalog (besides the dnsmasq `failed`→`active/running`/`inactive/dead` and `nm.general#WIFI` rules already defined) |
|---|---|
| `L34_V3_POST_FRESH` | p2p: `nm.active.device.p2p-dev-wlp0s20f3 <absent>→none`, `….type <absent>→wifi-p2p`, `….state <absent>→disconnected`; wpa: `ActiveState inactive→active`, `SubState dead→running`, `MainPID 0→<positive>`, `ExecMainStartTimestamp <empty>→<nonempty>`; `wifi.phy.sha256 <sha256>→<sha256>` |
| `L34_V3_POST_RESIDUAL` | p2p: `….state unavailable→disconnected` only |
| `L34_V3_ROLLBACK_FRESH` | p2p with `….state <absent>→unavailable`; the same wpa and phy rules |
| `L34_V3_ROLLBACK_RESIDUAL` | dnsmasq rules only (rollback must equal PRE) |

### 3.1 wpa_supplicant — relational (`wpa_gate`)

The four wpa rules approve only when **all** hold in the two bundles. POST: PRE inactive/dead/PID 0 and POST active/running/PID>0 with a start
time; unit `LoadState=loaded`, `UnitFileState=disabled` (both), `NRestarts=0` (both), `Result=success` (both); NM radio changed exactly `disabled→enabled`
with STATE/CONNECTIVITY/WIFI-HW equal; the target's active connection is exactly `aegis-idea3-ap:802-11-wireless`; no other device has an active Wi-Fi/
p2p connection. ROLLBACK: the same lifecycle and unit facts; radio `disabled` in both; target rfkill `blocked` in both; **no** Wi-Fi/p2p connection active;
the target device state equals PRE. Any other combination stays `SERVICE_STATE_DRIFT` / `SERVICE_RESTART_DRIFT`. **`systemctl stop wpa_supplicant`
is not introduced** (it would be a new Production mutation needing its own owner decision).

### 3.2 Regulatory + `iw phy` digest — relational (`phy_gate`)

The existing approved window is unchanged and not broadened: `ALLOW_TRANSITIONS_FILE` (`stage L4`) accepts only the target phy `00→00`, `TH→TH`,
`00→TH`. `wifi.phy.sha256` is accounted for only when: the approved target transition is exactly `00→TH`; nothing else regulatory changed
(`wifi.reg.global` `00` in both, no other phy); the target phy mapping is unchanged; `wifi.phy.ap_mode` is `supported` in both;
**`wifi.phy.regnorm_sha256` is present and equal in both bundles**; and `wifi.phy.channel6_permitted` is `YES` after. The capture now records:

- `wifi.phy.regnorm_sha256` — sha256 of `iw phy` with only the regulatory annotations of the frequency entries removed (`p4-iw-phy-regnorm.awk`:
  `* 5180.0 MHz [36] (22.0 dBm) (no IR)` → `* 5180.0 MHz [36]`, and any deeper attribute lines of that entry such as `No IR`, `DFS state`);
- `wifi.phy.channel6_permitted` — `YES|NO|MISSING`, read from the channel-6 entry (`disabled`, `no IR`, `radar detection`, `passive scan`, `indoor only` ⇒ `NO`).

Capabilities, supported commands, interface modes, interface combinations, scan limits, phy identity or the set of channels still change the
normalized digest and therefore still fail (tested). The raw `wifi.phy.sha256` continues to be recorded unchanged.

### 3.3 Rollback safe-equivalent regulatory state

`TH` may remain after rollback because the merged Model B gate already accepts target-phy `TH` or `00` and this workflow never issues `iw reg set`.
For the fresh baseline the rollback comparison therefore carries the existing `00→TH` window; for the residual baseline the state is already TH.

## 4. Baselines (`apply.sh` preflight, `AEGIS_L34_PRESERVATION=V3`)

The preflight classifies the host read-only and prints `L34_BASELINE=FRESH|RESIDUAL`; the runner requires exactly one recognized value and selects
its catalogs from it. Mixed or unrecognized states fail with `L34_BASELINE_MIXED_OR_UNRECOGNIZED` before any mutation.

| | FRESH (post-reboot) | RESIDUAL (proven after attempt 2) |
|---|---|---|
| target phy country | `00` | `TH` |
| `p2p-dev-wlp0s20f3` | absent | present, type `wifi-p2p`, state `unavailable` |
| `wpa_supplicant.service` | inactive/dead, PID 0 | active/running, PID>0 |
| both | NM radio `disabled`; target `unavailable`; unit `disabled`, `NRestarts=0`, `Result=success`; no active Wi-Fi | same |

V3 additionally requires `AEGIS_L34_NM_RADIO_ENABLE=YES` (`L34_V3_REQUIRES_NM_RADIO_ENABLE`): the baselines both have the radio disabled, so
V3 always relies on the owner-authorized V2 radio enable.

## 5. Handler changes (no new host mutation)

- `verify.sh` (V3): the only new NM device compared to PRE is exactly `p2p-dev-wlp0s20f3:wifi-p2p` with state `disconnected`
  (`L34_V3_UNEXPECTED_NM_DEVICE`, `L34_V3_P2P_DEVICE_STATE`); wpa_supplicant active/running with the unit facts intact
  (`L34_V3_WPA_SUPPLICANT_*`); prints `L34_V3_SIDE_EFFECTS=WITHIN_ENVELOPE`.
- `rollback.sh` (V3): proves the safe boundary — radio `disabled`, target `type managed`, no AP default route, target rfkill restored, p2p device
  absent or exactly `unavailable`, no other new NM device, wpa_supplicant unit facts intact, target regulatory state `TH` or `00` — and reports
  `SAFE_NETWORK_BOUNDARY_RESTORED=YES` separately from `EXACT_PRESTATE_RESTORED=YES|NO` (exact only when the p2p device, wpa_supplicant and the
  country all equal PRE). It never stops wpa_supplicant, removes the p2p device, sets the regulatory domain or restarts NetworkManager.
- The runner's rollback flow additionally re-checks that the L6b broker is inactive and no `:8883` listener exists.

## 6. Rollback acceptance boundary

Rollback cannot always recreate the byte-for-byte PRE runtime once NetworkManager has initialized Wi-Fi. The V3 boundary contains **only** the proven
residuals — the exact unavailable p2p pseudo-device, the exact safe wpa_supplicant residual, target phy `00→TH` with its regulatory-derived iw-phy
state, and dnsmasq `failed/start-limit-hit`→`inactive/dead/success` — and everything else must equal PRE or satisfy an already approved narrow
transition. Invariants proven every time: NM radio disabled, target rfkill restored, no active Wi-Fi, target managed/down with no IPv4 and no AP default
route, dnsmasq not running, persistent files unchanged, nft unchanged, no NAT, forwarding zero, legacy Mosquitto/Twingate/IDEA2 unchanged, L6b broker
inactive, no `:8883`.

## 7. Authorization and the runner

The runner template is V3: `EXPECTED_SCOPE` is
`L3_L4_RUNTIME_REACTIVATION_V3: rfkill 1 unblock, temp wlp0s20f3 autoconnect off, NM radio on, activate aegis-idea3-ap, reset-failed+start dnsmasq, no persistent rewrite`
(168 characters). The mutations are identical to V2 (the side effects are NetworkManager's, not ours); the version bump exists so a V2 record
cannot authorize V3 and vice versa (the V2 scope is rejected by the exact scope match, tested). One attempt per authorization is unchanged
(`L34-REACTIVATION-ATTEMPT-CONSUMED`); nothing is created, frozen or run by this work; the template still refuses to run unpinned.

## 8. Open items carried to the owner

- A fresh authorization, a newly frozen runner and one more bounded attempt are required; no state from attempts 1–2 is reusable.
- The current host is in the RESIDUAL baseline (read-only observation 2026-09-27 03:23): V3 preflight is designed to accept it.
- Still unproven live: that the V3 comparator boundaries match a real run end-to-end, and the p2p device / wpa_supplicant lifecycle under a residual-baseline run.
- `K12_AUTOMATIC_REBOOT_PERSISTENCE = NOT_PROVEN`; `L6B` remains blocked until L3/L4 runtime is applied and freshly re-proven.
