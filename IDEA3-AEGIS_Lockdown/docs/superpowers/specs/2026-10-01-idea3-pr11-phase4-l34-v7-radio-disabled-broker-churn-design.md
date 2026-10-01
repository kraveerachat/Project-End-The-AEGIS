# AEGIS IDEA3 PR11 Phase 4 — L3/L4 RADIO-DISABLED + BROKER-CHURN Runtime Reactivation Design (V7)

Date: 2026-10-01 (Asia/Bangkok). Owner: music. Status: **repository implementation only. Live execution NOT authorized.**

```text
V7_STAGE_NAME                = l34-v7-radio-disabled-broker-churn
V7_BASELINE_ID               = RADIO_DISABLED_BROKER_CHURN
BASE_MAIN                    = 07633c939ae1edfe5a340e081b0be36af418e78b
REACTIVATION_EXECUTED        = NO
LIVE_REACTIVATION_AUTHORIZED = NO
PRODUCTION_MUTATION          = NO   (this document and its implementation; the 2026-10-01 owner attempt in §0 is a separate, earlier event)
A_L4_CREATED                 = NO
K3_L4_CREATED                = NO
CORE_RESTARTED               = NO
RECOVERY_R1_R8_PROVEN        = NO
L8_AUTHORIZED                = NO
ESP32 / L7 / L8              = NOT TOUCHED
L3_LIVE_ACCEPTANCE           = PROVEN historically (unchanged, not re-claimed)
L4_LIVE_ACCEPTANCE           = PROVEN historically (unchanged, not re-claimed)
L6B_LIVE_ACCEPTANCE          = PROVEN historically (unchanged, not re-claimed, and NEVER mutated by this workflow)
K12_AUTOMATIC_REBOOT_PERSISTENCE = NOT_PROVEN
```

## 0. Why this task exists

After L7u post-merge verification passed, Recovery was repository-ready but runtime-BLOCKED: the private AP (`aegis-idea3-ap` on `wlp0s20f3`,
`10.77.30.1/28`) was down. The host baseline was:

```text
phy0 (rfkill 1)          soft blocked, NOT hard blocked
NetworkManager Wi-Fi     radio disabled
wlp0s20f3                unavailable; aegis-idea3-ap inactive; no 10.77.30.1/28
aegis-idea3-dnsmasq      failed / start-limit-hit
aegis-idea3-mosquitto    crash-looping every ~5 s (Restart=on-failure): "Error: Cannot assign requested address" — its config has
                         `listener 8883 127.0.0.1` and `listener 8883 10.77.30.1`; the second cannot bind while the AP address is absent
Core                     active, MainPID 883, NRestarts 0
```

No accepted handler supports exactly that combination:

```text
V1–V3   own the rfkill/radio head, BUT their owner runner gates on "L6b broker is not inactive" and "an 8883 listener exists" (broker must NOT have started).
V4      radio must be ENABLED, rfkill unblocked; dnsmasq AND broker already healthy.
V5      radio must be ENABLED, rfkill unblocked; dnsmasq failed; broker crash-looping.
V6      radio must be ENABLED, rfkill unblocked; dnsmasq clean inactive; broker stable with the stale pair.
```

### 0.1 Previous temporary owner mutation (2026-10-01, ~05:38–05:40 Asia/Bangkok) — recorded truthfully

The owner ran, by hand: `rfkill unblock wifi`, `nmcli radio wifi on`, `nmcli connection up aegis-idea3-ap`, then a rollback
(`systemctl stop aegis-idea3-dnsmasq`, `nmcli connection down aegis-idea3-ap`, `nmcli radio wifi off`, `rfkill block wifi`).
**PRODUCTION_MUTATION_PERFORMED=YES for that event.** Read-only diagnosis afterwards established:

- The activation failed with `No suitable device found for this connection (device enp62s0 not available because profile is not compatible with device
  (mismatching interface name))`. The NetworkManager journal shows the radio enabled at :39.1468, the activation refused at :39.1748, and the
  device moving `unavailable -> disconnected` (reason `supplicant-available`) at :39.1907. **The activation raced NetworkManager's readiness transition**
  (and was apparently not bound with `ifname`, so NetworkManager reported the only available device, `enp62s0`). The profile itself is compatible
  (`connection.interface-name=wlp0s20f3`, mode ap, band bg, channel 6, no MAC restriction).
- dnsmasq then failed (`unknown interface wlp0s20f3`) and the broker kept churning: both are downstream of the missing AP address.
- The rollback was **safe-equivalent**: radio disabled, phy0 soft-blocked again, AP inactive, no IPv4 on `wlp0s20f3`, dnsmasq stopped/failed, broker
  untouched, Core untouched. Residuals: `wpa_supplicant` running (PID 824020), `p2p-dev-wlp0s20f3` unavailable, phy country TH — the accepted V3
  RESIDUAL set. **The exact original pre-state was NOT proven** (no pre-attempt snapshot of wpa_supplicant / p2p / country).
- Core was never restarted (`MainPID 883`, `NRestarts 0`). Recovery R1–R8 and L8 were not executed. ESP32 was not touched.

The governed L34 handler already contains every safety behavior the manual commands lacked (exact-ID rfkill, device autoconnect guard, bounded wait for
`disconnected`, `ifname`-bound activation). V7 reuses those primitives verbatim under a stricter, narrower baseline contract; the original L34 runner is
**not** weakened.

## 1. Frozen decisions

1. **New stage, new files only.** `reactivation/l34-v7-radio-disabled-broker-churn/{apply,verify,rollback}.sh`, three allow files,
   `owner-run/run-l34-v7-radio-disabled-broker-churn-owner.sh`, and an appended `l34_v7_*` section in `p4-l34-reactivation-lib.sh`. No V1–V6 file changes
   (pinned byte-for-byte by `test_pr11_phase4_l34_v7_scope_contract.py`); the library is append-only.
2. **Baseline = the proven radio-disabled baseline (V3 classifier, verbatim) + strict broker/Core contract.** `l34_baseline_classify` reports FRESH or
   RESIDUAL (the host is RESIDUAL now; FRESH is the post-reboot shape). Anything mixed/unrecognized is refused.
3. **The readiness wait is load-bearing.** Activation is attempted only after `l3_nm_wait_ready` (bounded, state based) has seen `wlp0s20f3 == disconnected`,
   and only as exactly ONE `nmcli connection up aegis-idea3-ap ifname wlp0s20f3`. There is no activation retry.
4. **No broker or Core command, ever** (apply, verify, rollback, runner). The broker recovers through its own `Restart=on-failure` once 10.77.30.1 exists.
5. **Rollback is safe-equivalent and ownership based** (V3 model): only journaled mutations are undone; the broker is not manipulated to restore its pre-state.

## 2. Exact baseline gate (fail-closed; every item must hold)

```text
interface             wlp0s20f3 only (AEGIS_AP_INTERFACE must equal it); sole NM Wi-Fi device and sole wlan rfkill (l34_wifi_topology_gate)
rfkill                exact id 1 bound to wlp0s20f3 via sysfs; soft-blocked; NOT hard-blocked
NM Wi-Fi radio        disabled; wlp0s20f3 unavailable; no active Wi-Fi connection; target has no default route; an alternate default route exists (management path)
AP profile            persisted file 0600 root: mode ap, SSID AEGIS-IDEA3, band bg, channel 6, manual 10.77.30.1/28, never-default, interface-name wlp0s20f3;
                      NM-effective values identical; profile autoconnect=no; device autoconnect=yes
AP address            10.77.30.1 on NO interface; no route on wlp0s20f3; no AP DNS/DHCP listener
dnsmasq               loaded/enabled, failed/start-limit-hit, MainPID 0 (l34_service_pre_gate); persisted conf/unit byte-identical to the accepted authority
broker                see §3
Core                  aegis-idea3-core.service active/running/success with a real PID; (MainPID, NRestarts, InvocationID) recorded as the PRE tuple
L2 / forwarding       nft table inet aegis_idea3 accepted shape, no NAT, forwarding zero
regulatory            target phy TH or 00, channel 6 permitted
```

## 3. Broker-churn contract (security-sensitive; churn is NOT a bypass)

systemd state alone cannot distinguish "crash-looping because 10.77.30.1 is absent" from any other crash loop (bad certificate, ACL/passwd permission,
malformed config) — they share the same state tuple. `l34_v7_broker_churn_gate` therefore requires ALL of:

```text
unit            LoadState=loaded, UnitFileState=enabled
restart policy  Restart=on-failure and RestartUSec=5s (the expected unit policy)
state           ActiveState=activating, SubState=auto-restart, MainPID=0 (between automatic restarts)
last exit       Result=exit-code and ExecMainStatus=1 (plain non-zero exit: not a signal, OOM, timeout or start-limit-hit); NRestarts numeric
journal         the broker's own bind-failure signature "Error: Cannot assign requested address" is present in the bounded tail (journalctl -n 30)
                AND no other "Error:" line is present (a second, unrelated failure signature refuses the baseline)
config          the broker config (only ever READ) has exactly the active listeners `listener 8883 127.0.0.1` and `listener 8883 10.77.30.1`,
                no other listener, no global port/bind_address; persisted and re-verified byte/metadata-identical after the run (l34_persistent_verify)
listeners       NO 8883 listener of any kind exists (ss sport = :8883 is empty)
AP absence      10.77.30.1 is on no interface (the cause the signature points at is actually present)
```

The config identity is additionally pinned because a widened or removed listener would change what "recovered" means; V7 never edits, relaxes or removes the
AP listener and never changes the broker configuration merely to make it start.

## 4. Sequence (apply.sh) — every mutation journaled BEFORE it is made

```text
 1  RFKILL_UNBLOCK <id>                 l3_rfkill_prepare: exact id 1 only (never `unblock all`); only the target row changes
 2  NM_DEVICE_AUTOCONNECT_DISABLE <pre> nmcli device set wlp0s20f3 autoconnect no (no remembered Wi-Fi profile may grab the device)
 3  NM_WIFI_RADIO_ENABLE disabled       nmcli radio wifi on — EXACTLY ONCE, only if still disabled after the exact unblock
 4  (bounded wait)                      l3_nm_wait_ready: wlp0s20f3 == disconnected   <-- the 2026-10-01 race control
 5  NM_UP aegis-idea3-ap                ONE `nmcli connection up aegis-idea3-ap ifname wlp0s20f3`; AP mode/SSID/channel/address, no default-route drift, regulatory
 6  NM_DEVICE_AUTOCONNECT_RESTORED      autoconnect back to its PRE value
 7  DNSMASQ_RESET_FAILED / DNSMASQ_START  systemctl reset-failed + start aegis-idea3-dnsmasq.service ONLY; bounded active + exact listeners
 8  (read-only bounded wait)            broker active/running on its own; exact pair 127.0.0.1:8883 + 10.77.30.1:8883 (polled); NRestarts strictly above PRE
 9  (one probe)                         handshake-only TLS probe via the unchanged p4-l7-broker-probe.py to 10.77.30.1:8883 (chain + hostname + TLS>=1.2)
10  (read-only stability sample)        4 reads x 5 s of (MainPID, NRestarts, InvocationID) must be identical and well-formed — the counter must stabilize
11  (read-only proofs)                  Core tuple == PRE; persistent files, nft table, forwarding, legacy mosquitto/Twingate/IDEA2 identities unchanged
```

Live timings are frozen in the handler; only fixture (stubbed) runs may shorten them. verify.sh is read-only and re-proves the end state including a fresh
stability sample and the Core tuple.

## 5. Rollback model (rollback.sh; failure/abort path only) — SAFE_EQUIVALENT

Only journal-proven mutations are undone, in reverse order: stop dnsmasq (only if this run started it) → autoconnect off while the AP comes down →
`nmcli connection down aegis-idea3-ap` (only while it is the active connection of the target) → escalate (fail closed, no radio/rfkill touch) if a
DIFFERENT Wi-Fi profile is active → `nmcli radio wifi off` (only if this run enabled it and it is enabled) → restore autoconnect → re-block exactly the
recorded rfkill id (only if it was soft-blocked before). Unknown or foreign journal entries (`JOURNAL_ENTRY_UNKNOWN` / `JOURNAL_ENTRY_NOT_OWNED`) fail
closed. The boundary tolerates only the V3 residuals (p2p pseudo-device exactly unavailable, wpa_supplicant running with its unit facts intact, phy country
TH/00); nothing is stopped or reset to remove them.

**Honest limitation:** because no broker command is permitted, rollback cannot force the broker back to "crash-looping". After the AP address is removed the
broker either crash-loops again or keeps a stale `10.77.30.1:8883` socket (the V6 baseline, which V6 covers). The runner's PRE->RB comparison therefore
allows the broker's runtime fields and the approved listener set, and records `L34_V7_REACTIVATION=NOT_RESTORED`.

## 6. Owner runner

`run-l34-v7-radio-disabled-broker-churn-owner.sh` is a separate runner. As committed, `EXPECTED_MAIN=PIN_MAIN_SHA` makes it refuse to run; the owner freeze
workflow pins it. It requires a same-day `stage=L4` authorization whose `scope=` equals the exact V7 scope (<=200 printable ASCII), a valid K3 record
through the unchanged `p4-stage-gate.sh --mode live`, a clean worktree at the pinned main (= origin/main), the historical L3/L4 acceptance receipts, a
non-root invoking user with `sudo`, and the exact V7 host baseline (dnsmasq pre-state, broker-churn contract, no 8883 listener, healthy Core, healthy
legacy/IDEA2 units). One bounded attempt per authorization (atomic `noclobber` marker), no retry. It prints `RECOVERY_R1_R8_PROVEN=NO` and
`L8_AUTHORIZED=NO`. The PRE->POST comparison reuses the exact V3 catalogs of the baseline the preflight reported (FRESH|RESIDUAL); no catalog is widened.

## 7. Non-goals (enforced by static regression tests)

No broker configuration change, AP-listener removal, broker start/stop/restart/reset-failed/kill, Core restart, L7u change, Recovery R1–R8, ESP32, L8,
firewall/NAT/forwarding change, NetworkManager profile rewrite, F1/R5 policy change, or weakening of L6c/L7/L8/L9 gates. The original L34 runner
(`run-l34-reactivation-owner.sh`) and its broker-inactive gate are byte-identical.

## 8. Evidence and status

Repository tests (simulated host only): `test_pr11_phase4_l34_v7_radio_disabled_broker_churn.py` (handlers), `..._v7_owner_run_flow.py` (runner control
flow), `..._v7_scope_contract.py` (scope/stage-gate/pins). **Nothing here is live evidence.** `READY_FOR_LIVE_REACTIVATION=NO`: live use requires a merged
PR, an owner-frozen runner, a fresh same-day authorization and K3 record, and the real-host behavior of `p4-compare.sh` against the reused V3 catalogs plus
the V7 allow files has not been exercised (the V7 allow files are new and unproven against a real capture).
