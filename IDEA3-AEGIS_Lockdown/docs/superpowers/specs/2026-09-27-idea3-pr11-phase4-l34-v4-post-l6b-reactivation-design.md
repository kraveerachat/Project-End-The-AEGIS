# AEGIS IDEA3 PR11 Phase 4 — L3/L4 POST-L6b/L6c Runtime Reactivation Design (V4)

Date: 2026-09-28 (Asia/Bangkok). Owner: music. Status: **repository implementation only. Live execution NOT authorized.**

```text
REACTIVATION_EXECUTED        = NO
LIVE_REACTIVATION_AUTHORIZED = NO
PRODUCTION_MUTATION          = NO   (this document and its implementation)
A_L4_CREATED                 = NO
K3_L4_CREATED                = NO
L3_LIVE_ACCEPTANCE           = PROVEN historically (unchanged, not re-claimed)
L4_LIVE_ACCEPTANCE           = PROVEN historically (unchanged, not re-claimed)
L6B_LIVE_ACCEPTANCE          = PROVEN historically (unchanged, not re-claimed, and NEVER mutated by this workflow)
K12_AUTOMATIC_REBOOT_PERSISTENCE = NOT_PROVEN
```

## 1. Why V4, not another V1/V2/V3 baseline

`owner-run/run-l34-reactivation-owner.sh` (V1/V2/V3, `reactivation/l34/`) models two proven PRE-L6b baselines only:
`FRESH` (NM radio disabled, target `unavailable`, no P2P device, wpa_supplicant inactive) and `RESIDUAL` (same but
`country=TH`, the P2P device present as `unavailable`, wpa_supplicant already running) — see
`l34_baseline_classify()` in `p4-l34-reactivation-lib.sh`. Both REQUIRE `NM_RADIO_NOT_DISABLED` to fail, i.e. the
radio must currently be disabled. V3's `apply.sh` also unconditionally performs `systemctl reset-failed` +
`systemctl start` on `aegis-idea3-dnsmasq.service`, and both `apply.sh`/owner-run explicitly gate that
`aegis-idea3-mosquitto.service` (the L6b broker) must be `inactive` — "L6b must not have started".

Now that L6b and L6c are both live-accepted and persistent, a real post-reboot/radio-disable host observation showed:

- NM radio **already enabled** (not disabled) — fails `l34_baseline_classify`'s `NM_RADIO_NOT_DISABLED` check for
  BOTH FRESH and RESIDUAL.
- Target device state **`disconnected`** (not `unavailable`) — fails `TARGET_NOT_UNAVAILABLE` for both.
- P2P inventory **`p2p-dev-wlp0s20f3:wifi-p2p:disconnected`** — matches neither the empty-inventory FRESH case nor
  the exact `:unavailable` RESIDUAL row (`L34_P2P_RESIDUAL_ROW`), so it independently fails `P2P_INVENTORY` too.
- `aegis-idea3-dnsmasq.service` **already `active/running/success`** (not `failed/start-limit-hit`) — V3's
  `l34_service_pre_gate` requires the latter exactly, so V3's own dnsmasq precondition also fails.
- `aegis-idea3-mosquitto.service` (L6b broker) **already `active/running`**, with both `10.77.30.1:8883` and
  `127.0.0.1:8883` bound — V1/V2/V3's own precondition (`ActiveState=inactive`) explicitly refuses this.

This host state is genuinely a THIRD, distinct baseline — neither FRESH nor RESIDUAL — and is incompatible with V1/V2/V3
in **three independent ways** (radio, dnsmasq precondition, broker precondition), not one. V4 is a new, narrowly-scoped
sibling operation, reusing `p4-l34-reactivation-lib.sh`'s stage-independent predicates (persistent-file snapshot, L2
nft/PF-01, no-NAT, forwarding, AP activation proof, device-autoconnect reader, NM status/P2P inventory helpers)
without duplicating any networking logic, and never modifying V1/V2/V3's own files.

## 2. The one supported V4 baseline (`RADIO_READY`)

```text
wifi device inventory = wlp0s20f3 only
rfkill: wlan soft=unblocked hard=unblocked                          (already ready; V4 never mutates rfkill)
NM radio wifi = enabled                                              (already ready; V4 never mutates the radio)
wlp0s20f3: GENERAL.STATE = disconnected, GENERAL.CONNECTION = ""    (no active Wi-Fi connection)
P2P inventory = empty, or exactly "p2p-dev-wlp0s20f3:wifi-p2p:disconnected"
wpa_supplicant: LoadState=loaded ActiveState=active SubState=running UnitFileState=disabled Result=success MainPID>0
aegis-idea3-dnsmasq.service: LoadState=loaded ActiveState=active SubState=running UnitFileState=enabled Result=success MainPID>0
aegis-idea3-mosquitto.service: LoadState=loaded ActiveState=active SubState=running UnitFileState=enabled Result=success MainPID>0
device GENERAL.AUTOCONNECT = yes
aegis-idea3-ap connection.autoconnect = no          (the persisted profile's own value; never written by V4)
```

Any host that is not exactly `FRESH`, `RESIDUAL`, or this baseline is unrecognized and refused before any mutation
(`l34_v4_baseline_gate`, `l34_v4_rfkill_ready_gate`, `l34_v4_autoconnect_pre_gate`,
`l34_v4_service_active_gate <unit>` for both dnsmasq and the broker).

## 3. Exact V4 mutation sequence — and nothing else

Because rfkill, the NM radio, dnsmasq and the L6b broker are ALL already in their target state, V4's entire mutation
is:

1. `nmcli device set wlp0s20f3 autoconnect no` (temporary; the PRE value, always `yes` in the supported baseline, is
   journaled first).
2. Bounded NetworkManager target-device readiness (state observation, not an activation retry), then **exactly one**
   `nmcli connection up aegis-idea3-ap ifname wlp0s20f3`.
3. `nmcli device set wlp0s20f3 autoconnect yes` (restore to the exact PRE value).

No rfkill command, no `nmcli radio wifi on/off`, no `systemctl reset-failed/start/stop/restart` of
`aegis-idea3-dnsmasq.service` or `aegis-idea3-mosquitto.service` appears anywhere in `apply.sh`, `verify.sh` or
`rollback.sh` (enforced by a grep-based regression test). The autoconnect toggle exists solely so no remembered
Wi-Fi profile can race the one deliberate activation; it is not a radio-enable race guard (V4 never transitions the
radio), and it is proven necessary/sufficient by the real host observation that `GENERAL.AUTOCONNECT=yes` with
multiple other remembered profiles also carrying `AUTOCONNECT=yes`.

## 4. Preservation envelope

**dnsmasq and the L6b broker — identical treatment, never mutated, in both success and failure paths:**

- PRE and POST/rollback: `ActiveState=active`, `SubState=running`, `UnitFileState=enabled`, `Result=success`,
  identical `MainPID`, identical `NRestarts` (`l34_v4_identity_snapshot` / `l34_v4_identity_unchanged`).
- Exact expected listeners present both PRE and POST — never created by V4, only verified
  (`l34_v4_dnsmasq_listeners_gate`, `l34_v4_broker_listeners_gate`). A real host observation directly confirmed (not
  assumed) that an already-bound listener on a specific IP is not torn down by the kernel merely because that IP
  later disappears from its interface, so no service restart is expected to be necessary once the AP address
  returns.
- Persistent config/unit files and the NM profile: byte/metadata-identical (`l34_persistent_snapshot` /
  `l34_persistent_verify`), exactly as V1/V2/V3 already require for their own persistent artifacts.

**Also preserved, unchanged from V1/V2/V3's own model:** legacy `mosquitto.service`, `twingate.service`, IDEA2
engine/tunnel identities (MainPID/NRestarts); L2 `nft`/PF-01 table byte-identical; no NAT; all forwarding sysctls
zero; the default route; regulatory country (never transitioned — V4 never enables the radio, so no NM Wi-Fi
initialization side effect occurs at all, unlike V2/V3).

## 5. Rollback ownership

Rollback undoes **only what `apply.sh` itself journaled**: `NM_DEVICE_AUTOCONNECT_DISABLE` /
`NM_UP`. It forces autoconnect off again before bringing the connection down (so nothing can race in during the down
transition), downs only `aegis-idea3-ap` and only while it is the active connection of `wlp0s20f3`, then restores
autoconnect to the exact PRE value. It never touches rfkill, the NM radio, dnsmasq or the L6b broker (no journal
entry for any of those exists to act on). If, after the connection comes down, a **different** Wi-Fi profile is found
active on the target — autoconnect grabbing something else despite being disabled first — rollback **fails closed and
escalates** (`UNRELATED_WIFI_ACTIVATED_DURING_ROLLBACK=YES:ESCALATE_TO_OWNER`) rather than manipulating that
unrelated profile.

## 6. Authorization model

Reuses `AEGIS_P4_AUTHORIZATION_V1` and fresh K3 (V1 or V2 owner self-attestation) with `stage=L4`, exactly like
V1/V2/V3 — no new record type is invented. The runner additionally requires the A-L4 `scope=` line to equal exactly:

```text
L3_L4_RUNTIME_REACTIVATION_V4_POST_L6B: temp wlp0s20f3 device autoconnect off, activate existing aegis-idea3-ap exactly once, restore device autoconnect, preserve active dnsmasq and already-accepted L6b broker unchanged, no rfkill/radio/persistent rewrite
```

so a V3 A-L4 can never authorize a V4 run and vice versa (proven by a dedicated test). The one-attempt marker is
`L34-V4-REACTIVATION-ATTEMPT-CONSUMED`, distinct from V1/V2/V3's `L34-REACTIVATION-ATTEMPT-CONSUMED`, so the two
operation families can never share or exhaust each other's authorization. **No A-L4/K3 record was created by this
design task.**

## 7. Files

- `deploy/pr11-phase4/p4-l34-reactivation-lib.sh` — extended (never rewritten) with the V4-specific predicates
  (`l34_v4_baseline_gate`, `l34_v4_rfkill_ready_gate`, `l34_v4_service_active_gate`,
  `l34_v4_identity_snapshot`/`_unchanged`, `l34_v4_broker_listeners_gate`, `l34_v4_dnsmasq_listeners_gate`,
  `l34_v4_ap_profile_autoconnect`, `l34_v4_autoconnect_pre_gate`). All existing V1/V2/V3 functions are byte-for-byte
  unchanged.
- `deploy/pr11-phase4/reactivation/l34-v4-post-l6b/{apply,verify,rollback}.sh` — new, narrowly-scoped handlers;
  `reactivation/l34/` (V1/V2/V3) is untouched.
- `deploy/pr11-phase4/owner-run/run-l34-v4-post-l6b-owner.sh` — new unpinned owner-run template, following the same
  freeze convention (`PIN_MAIN_SHA`).
- `tests/l34_sim.py` — extended (backward-compatible) with an `ap_profile_autoconnect` state key, an
  `nmcli -g connection.autoconnect connection show aegis-idea3-ap` query, broker `:8883` listener simulation keyed
  off the existing `identities["aegis-idea3-mosquitto.service"]` entry, and the exact `ss -H -ltn "sport = :8883"`
  filtered-query form used by the real gate. None of these change any V1/V2/V3 test's existing behavior (all default
  to the prior no-op values).
- `tests/test_pr11_phase4_l34_v4_post_l6b.py` — new, 31 tests.

## 8. What this design does NOT do

No A-L4/K3 created. No runner frozen or executed. No Production mutation. No rfkill/radio/dnsmasq/broker command
issued anywhere outside the exact, reviewed V4 mutation sequence above. No historical L3/L4/L6b receipt rewritten. No
L7 or ESP32 reference anywhere in the new handlers or runner.
