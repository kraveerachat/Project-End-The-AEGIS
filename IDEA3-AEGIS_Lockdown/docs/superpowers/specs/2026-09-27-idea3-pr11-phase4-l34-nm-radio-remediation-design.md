# AEGIS IDEA3 PR11 Phase 4 — L3/L4 Reactivation: Live Attempt 1 Failure and NM Radio Remediation

Date: 2026-09-27 (Asia/Bangkok). Owner: music. Status: **repository remediation only**. Extends
`2026-09-27-idea3-pr11-phase4-l34-post-reboot-reactivation-design.md`.

```text
L34_REACTIVATION_ATTEMPT            = 1
L34_REACTIVATION_RESULT             = FAIL
FAIL_REASON                         = NM_WIFI_RADIO_DISABLED
AUTHORIZATION_CONSUMED              = YES   (permanent; the frozen v1 runner is spent)
RETRY_PERFORMED                     = NO
ROLLBACK_RESULT                     = PASS
PRE_RB_COMPARE / PRESERVATION_S10   = PASS / PASS
L34_RUNTIME_RESTORED                = NO    (runtime is still NOT_APPLIED; only the safe pre-state and safety boundary were restored)
LIVE_REACTIVATION_AUTHORIZED        = NO    (this remediation authorizes nothing)
```

## 1. What happened (evidence `2026-09-27-l34-reactivation-20260927-021304`)

Read-only preflight passed; PRE capture completed; apply performed exactly one mutation, `rfkill unblock 1`, then the bounded
readiness wait printed `L3_NM_TARGET_STATE=unavailable` until it timed out: `L34_APPLY=FAIL reason=NM_WIFI_RADIO_DISABLED`. Rollback
re-blocked exactly rfkill 1 and proved AP inactive, dnsmasq not running, persistent files unchanged, PRE→RB compare PASS, S10 PASS. The
NetworkManager journal for the run shows both transitions: `manager: rfkill: Wi-Fi now enabled by radio killswitch` at the unblock and
`... now disabled by radio killswitch` at the rollback.

## 2. Root cause

NetworkManager reports `nmcli radio wifi` as `enabled` only when **both** the rfkill killswitch permits the radio **and** NetworkManager's own
persisted software flag (`WirelessEnabled` in `/var/lib/NetworkManager/NetworkManager.state`) is on. The journal proves the first condition
was satisfied by the exact unblock ("enabled by radio killswitch") and the readback proves the second was not: the radio stayed `disabled`,
so NetworkManager keeps every Wi-Fi device `unavailable`. The software flag is therefore off after this reboot (the state file is root-only
and could not be read in this session; the one confirming read is `sudo grep -E '^WirelessEnabled' /var/lib/NetworkManager/NetworkManager.state`,
listed as an owner read-only proof, not a precondition of the implementation).

The v1 design assumed that a *soft-blocked* radio was the only reason NetworkManager reported `disabled`. That assumption was wrong, and the
simulator had encoded the same assumption (`radio_flag_follows_rfkill`), which is why the tests could not catch it. The simulator now models
the two independent conditions and its default follows the proven live state; a regression test reproduces the exact live sequence.

## 3. Is there a target-scoped NetworkManager action?

No. NetworkManager has exactly one radio switch for Wi-Fi: `nmcli radio wifi`, the D-Bus `WirelessEnabled` property. Device-level knobs
(`nmcli device set … managed|autoconnect`) do not make an `unavailable` Wi-Fi device available, and `nmcli device connect|up` against an
`unavailable` device fails. There is no per-device radio state to toggle. Enabling the radio is therefore a **global NetworkManager Wi-Fi radio
state change**, and it is a new owner decision boundary.

## 4. New owner decision boundary (OD-L34-RADIO)

The v1 authorization scope explicitly forbade a global command. Nothing here widens it silently:

- The global command exists only behind the exact environment value `AEGIS_L34_NM_RADIO_ENABLE=YES` (any other value, including `yes`, `1`,
  `true`, empty or `YES ` with a space, keeps the old fail-closed behaviour and is tested).
- The owner runner passes that flag only after it has verified an A-L4 whose `scope=` line is exactly the **V2 scope**:

```text
L3_L4_RUNTIME_REACTIVATION_V2: rfkill 1 unblock, temp wlp0s20f3 autoconnect off, NM radio on, activate aegis-idea3-ap, reset-failed+start dnsmasq, no persistent rewrite
```

  (168 characters; it names each runtime mutation — the exact rfkill unblock, the **temporary** `wlp0s20f3` autoconnect-off, the global NM radio
  enable — so a v1 authorization cannot authorize it and the V2 authorization cannot be mistaken for a plain L4 apply. The sole-Wi-Fi-device
  condition is enforced by the preflight, not by the scope text.) A fresh same-day K3 is required as before; nothing is created by this work.

## 5. Why the global scope is acceptable on this machine (and refused where it is not)

Enabling the global flag can only affect other devices/profiles if they exist. Read-only evidence (2026-09-27): NetworkManager manages
exactly one Wi-Fi device (`wlp0s20f3`), one `phy80211` interface exists in sysfs, one `wlan` rfkill (`phy0`, id 1; id 0 is bluetooth, never
touched), no Wi-Fi connection is active. **However 12 saved Wi-Fi profiles have `autoconnect=yes`** (for example `iPhone Music`, `Kittipat`,
`MAYA FIWI`, `SUT-Wifi`). The moment the radio turns on, NetworkManager would try to autoconnect one of them on `wlp0s20f3` if its SSID is in
range, racing the one bound AP activation and possibly bringing up a client connection with DHCP and a second default route. Rewriting those
profiles is forbidden (persistent-config rewrite), so the guard is a **runtime, non-persistent, target-scoped** device property:
`nmcli device set wlp0s20f3 autoconnect no` (NetworkManager `Device.Autoconnect`; reset by an NM restart or reboot).

Preflight (read-only, before any change; failure stops with nothing changed) when the radio is `disabled` and the flag is `YES`:

| Check | Reason on failure |
|---|---|
| NetworkManager lists exactly one `wifi` device and it is `wlp0s20f3` | `L34_WIFI_TOPOLOGY_NOT_SOLE_DEVICE` |
| sysfs exposes exactly one `phy80211` interface | `L34_WIFI_TOPOLOGY_NOT_SOLE_DEVICE` |
| exactly one `wlan` rfkill row | `L34_WIFI_TOPOLOGY_RFKILL_WLAN_COUNT` |
| no active Wi-Fi connection (checked for every radio state) | `L34_WIFI_ACTIVE_CONNECTION_PRESENT` |
| the device's runtime autoconnect value is readable (`yes`/`no`), recorded as the PRE value | `L34_DEVICE_AUTOCONNECT_UNREADABLE` |

If a second Wi-Fi device, second wlan rfkill or any active Wi-Fi connection ever exists, the global scope is no longer the target only and the
run refuses; that is a new owner decision, not a workaround.

## 6. Remediation sequence (apply.sh, journaled before each change)

1. read-only preflight (above) → PRE capture (runner) → `PRODUCTION_MUTATION_PERFORMED=YES`
2. `RFKILL_UNBLOCK 1` — exact-ID unblock (unchanged)
3. read `nmcli radio wifi`. If it is now `enabled` (software flag was already on) the workflow continues exactly as v1 with **no global command**.
   If still `disabled` and the owner flag is `YES`:
   1. journal `NM_DEVICE_AUTOCONNECT_DISABLE <prior>`; `nmcli device set wlp0s20f3 autoconnect no`
   2. journal `NM_WIFI_RADIO_ENABLE disabled`; **`nmcli radio wifi on`** (issued at most once)
4. bounded `l3_nm_wait_ready` until `wlp0s20f3` is `disconnected`
5. journal `NM_UP`; exactly one `nmcli connection up aegis-idea3-ap ifname wlp0s20f3`; AP/SSID/channel/address/regulatory/default-route gates
6. `nmcli device set wlp0s20f3 autoconnect <prior>` (PRE value restored while the AP is active); journal `NM_DEVICE_AUTOCONNECT_RESTORED <prior>`
7. `DNSMASQ_RESET_FAILED`, `DNSMASQ_START` (unchanged)

`verify.sh` additionally requires: exactly one active Wi-Fi connection and it is the approved profile on the target
(`L34_UNRELATED_WIFI_ACTIVE`); if this run enabled the radio, `nmcli radio wifi` is `enabled`; the device autoconnect equals the PRE value
(`L34_DEVICE_AUTOCONNECT_NOT_RESTORED`).

## 7. Rollback (failure/abort only) and exactness

In this order, only for journaled changes, idempotently: stop `aegis-idea3-dnsmasq.service` → `nmcli connection down aegis-idea3-ap` →
**if this run enabled the radio and it is currently `enabled`**: `nmcli device set wlp0s20f3 autoconnect no` (nothing may autoconnect between the
AP going down and the radio going off), `nmcli radio wifi off` → restore the PRE device autoconnect value → re-block exactly rfkill id 1 if it
was soft-blocked. It never disables a radio this run did not enable (a failed or skipped enable produces no `radio wifi off`). Proofs: radio
`disabled` again, autoconnect equals PRE, no Wi-Fi connection active, AP not active, dnsmasq not running, persistent files, nft, forwarding and
identities unchanged. Journal entries are validated against fixed values (`NM_WIFI_RADIO_ENABLE disabled`, autoconnect `yes|no`); anything else is
refused.

## 8. Comparator

No comparator change is needed and none is widened: the v1 catalog already approves exactly `nm.general#WIFI disabled → enabled` (only the WIFI
field; STATE/CONNECTIVITY/WIFI-HW must stay equal) for PRE→POST, and the rollback catalog contains **no** radio rule, so PRE→RB must return
`nm.general` to its PRE value exactly. The comparator judges changes only; that the radio really became enabled is proven by `verify.sh`
(tested).

## 9. Runner defect (found live, real, fixed)

`compare()` contained `local kind=${4:-post} rc=0 local -a env_allow` on one line: bash reported `local: `-a': not a valid identifier` at run time,
`bash -n` accepted it, and the function continued only by accident (the array became global). The declaration is now two valid statements. The
regression tests **execute** the runner's own `compare` function (extracted from the file, with a `sudo` stub) for both the post and rollback
paths and fail on any stderr output; a further test proves the harness detects the original defect while `bash -n` does not, and a static scan
rejects a second `local` on the same line in the runner, handlers and library.

## 10. One-attempt semantics, authority and next steps

- The consumed marker of authorization 1 stays; the frozen v1 runner and its A-L4/K3 are spent and are **not** reused.
- The runner template is updated (V2 scope, flag pass-through, `compare()` fix). It remains an unpinned template; after merge the owner freezes
  a new copy at the new main SHA, writes fresh same-day A-L4 (V2 scope) and K3, and runs it once. No record, marker or run is created here.
- Still unproven and carried to the owner: the exact persisted `WirelessEnabled` value (one sudo read); that `nmcli device set … autoconnect no`
  is accepted while the device is `unavailable` (if not, apply fails after the unblock and rollback restores the pre-state); real
  NetworkManager timing after the radio is enabled (bounded by `AEGIS_L34_NM_TRIES`/`AEGIS_L34_NM_INTERVAL`, default 20 × 0.5 s); and the
  phy possibly still reporting AP mode after a failed run's rollback (design 1, section 9).
- `K12_AUTOMATIC_REBOOT_PERSISTENCE = NOT_PROVEN`; L6b live remains blocked until L3/L4 runtime is applied or freshly re-proven.
