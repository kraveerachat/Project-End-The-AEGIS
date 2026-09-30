# AEGIS IDEA3 PR11 Phase 4 — L3/L4 POST-L6b/L6c DEGRADED Runtime Reactivation Design (V5)

Date: 2026-09-28 (Asia/Bangkok). Owner: music. Status: **repository implementation only. Live execution NOT
authorized.**

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

## 0. Why this task exists

During staged live Recovery validation of PR #238 (feat/idea3-evidence-driven-recovery), Twingate management
access to the Beelink host (192.168.10.10) was restored (re-authenticated `AEGIS-Beelink-SSH`/`AEGIS-Beelink-
Web` Twingate resources), and read-only diagnostics on the intended AP-broker host found:

```text
wlp0s20f3            DOWN, no 10.77.30.1 address
aegis-idea3-mosquitto.service   activating (auto-restart)   Result=exit-code   ExecMainStatus=1
  journal: "Opening ipv4 listen socket on port 8883" ×2 then "Error: Cannot assign requested address",
           "mosquitto version 2.1.2 terminating", restart_counter=180+
aegis-idea3-dnsmasq.service     failed / failed
```

The owner directed that neither existing governed runner be run live against this state, and asked for the
smallest new governed reactivation path to be designed and implemented (repository only, no live execution),
matching this exact degraded post-reboot baseline.

## 1. Why neither V3 nor V4 applies

```text
V3_SUPPORTED_BASELINE    = owner-run/run-l34-reactivation-owner.sh (reactivation/l34/): NM radio DISABLED,
                            target device `unavailable`, `l34_baseline_classify` FRESH or RESIDUAL only;
                            aegis-idea3-dnsmasq.service PRE-state exactly `failed/failed/start-limit-hit`
                            (l34_service_pre_gate); aegis-idea3-mosquitto.service (L6b broker) PRE-state
                            `ActiveState=inactive` ("L6b must not have started").
V4_SUPPORTED_BASELINE    = owner-run/run-l34-v4-post-l6b-owner.sh (reactivation/l34-v4-post-l6b/): NM radio
                            ENABLED, target device `disconnected`, rfkill already unblocked
                            (l34_v4_baseline_gate / l34_v4_rfkill_ready_gate); aegis-idea3-dnsmasq.service AND
                            aegis-idea3-mosquitto.service BOTH already `active/running/enabled/success` with
                            their expected listeners bound (l34_v4_service_active_gate).
CURRENT_LIVE_BASELINE    = NM radio ENABLED, target device state matches the V4 wifi/rfkill/radio/wpa shape
                            (same `l34_v4_baseline_gate` predicate), BUT aegis-idea3-dnsmasq.service is in the
                            exact V3 PRE-state (`failed/failed/start-limit-hit`) AND aegis-idea3-mosquitto.service
                            is NEITHER inactive (V3's precondition) NOR active/running (V4's precondition) — it is
                            `activating/auto-restart/exit-code/MainPID=0`, systemd already retrying on its own
                            because its AP-facing 8883 listener cannot bind while the AP address is absent.
```

V3 is inapplicable on two independent grounds (radio already enabled, not disabled; the broker being crash-
looped rather than fully `inactive`). V4 is inapplicable on two independent grounds (dnsmasq not already
active/running; the broker not already active/running). This is a genuine third baseline, not a variant of
either.

**No already-merged runner supports `POST_L6B_DEGRADED_REACTIVATION` (AP down/address absent, dnsmasq failed,
L6b broker installed but crash-looping on the missing AP address).** A repository search of
`deploy/pr11-phase4/owner-run/` and `deploy/pr11-phase4/reactivation/` confirms only V1/V2/V3
(`reactivation/l34/`) and V4 (`reactivation/l34-v4-post-l6b/`) exist prior to this task.

## 2. The one supported V5 baseline (`RADIO_READY_DEGRADED`)

```text
wifi/rfkill/radio/wpa topology  = IDENTICAL to V4's RADIO_READY baseline (l34_v4_baseline_gate,
                                    l34_v4_rfkill_ready_gate, l34_v4_autoconnect_pre_gate — reused verbatim,
                                    never duplicated)
aegis-idea3-dnsmasq.service      = LoadState=loaded ActiveState=failed SubState=failed UnitFileState=enabled
                                    Result=start-limit-hit MainPID=0   (l34_service_pre_gate — reused verbatim
                                    from V3)
aegis-idea3-mosquitto.service    = LoadState=loaded ActiveState=activating SubState=auto-restart
                                    UnitFileState=enabled MainPID=0   (l34_v5_broker_crashloop_gate — NEW)
```

Any host that is not exactly FRESH, RESIDUAL (V3), the V4 `RADIO_READY` baseline, or this exact baseline is
unrecognized and refused before any mutation.

## 3. Exact V5 mutation sequence — and nothing else

```text
1. nmcli device set wlp0s20f3 autoconnect no        (temporary; PRE value journaled first)
2. bounded NetworkManager target-device readiness, then exactly ONE
   nmcli connection up aegis-idea3-ap ifname wlp0s20f3
3. nmcli device set wlp0s20f3 autoconnect yes        (restore to exact PRE value)          [V4's exact sequence]
4. systemctl reset-failed aegis-idea3-dnsmasq.service
5. systemctl start aegis-idea3-dnsmasq.service       (bind succeeds: the AP address now exists) [V3's exact
                                                       dnsmasq pattern, reused verbatim, no enable/disable]
6. a BOUNDED, READ-ONLY wait (default 30 attempts × 2s = 60s, AEGIS_L34_V5_BROKER_TRIES/_INTERVAL) polling
   `systemctl show` for aegis-idea3-mosquitto.service to reach active/running on its own, through its own
   already-configured systemd auto-restart. NO start/stop/restart/reset-failed command is ever issued against
   it — a grep-based regression test (`test_v5_never_issues_a_broker_start_stop_restart_reset_failed`) enforces
   this statically across apply.sh, verify.sh, rollback.sh and the owner-run script.
   Amendment 2026-09-29 (V5 attempt 1 forensic): the broker unit is Type=simple, so "active/running" precedes
   the 8883 bind by ~20 ms. After that wait the exact-set listener gate (unchanged) is itself polled, read-only and
   bounded (default 15 attempts × 1s, AEGIS_L34_V5_LISTEN_TRIES/_INTERVAL); on final failure the observed 8883 set is
   written to `broker-listeners-observed.txt`. Wrong or extra listeners still fail after the bound.
```

No rfkill command, no `nmcli radio wifi on/off`, no `systemctl start/stop/restart/reset-failed` of
`aegis-idea3-mosquitto.service` appears anywhere in `apply.sh`, `verify.sh` or `rollback.sh`.

## 4. Preservation envelope

- **AP/autoconnect**: identical to V4 §4 (persisted profile never rewritten, autoconnect restored to exact PRE
  value, default route/radio state unchanged).
- **dnsmasq**: identical to V3's own preservation model for the unit it starts — config/unit file byte-
  identical (`l34_dnsmasq_conf_gate`, `l34_dnsmasq_unit_gate`, `l34_persistent_verify`), never enabled/disabled,
  restarted at most once (this run's own single `reset-failed`+`start`).
- **L6b broker**: config file (`/etc/aegis-idea3/mqtt/aegis-idea3-mosquitto.conf`) is added to the
  `l34_persistent_snapshot`/`l34_persistent_verify` set exactly like the AP profile and dnsmasq conf — proven
  byte/metadata-identical PRE→POST even though the *process* is expected to (and does) restart via its own
  auto-restart. The broker's identity (MainPID/NRestarts/ActiveState/SubState) is **not** required to stay
  unchanged (unlike V4): recovery is the entire point of this operation. This is why V5 does **not** reuse V4's
  `l34_v4_identity_unchanged` for the broker.
- **Comparator wiring**: rather than adding a new relational transition class to the shared, already-complex
  `p4-compare.sh` (which currently only special-cases the V3 dnsmasq transition via
  `DYN_CATALOG_L34_RUNTIME_REACTIVATION` and friends), V5 uses the simpler, already-proven `ALLOW_KEYS_FILE` /
  `ALLOW_LISTENERS_FILE` mechanism (the same one V4 uses for its own net./nm./wifi. runtime keys) to approve the
  dnsmasq and broker `svc.*` identity keys and the five newly-bound listeners as **unconstrained** drift. This
  is safe because V5's own domain-specific gates (`l34_service_active_gate`, `l34_v4_service_active_gate`,
  `l34_v4_dnsmasq_listeners_gate`, `l34_v4_broker_listeners_gate`) already prove the *exact* required end-state
  before the comparator ever runs — the comparator's remaining job is only to prove nothing *else* moved. This
  choice deliberately avoids editing `p4-compare.sh`'s shared logic at all, keeping this task's regression
  footprint to appended-only lib functions and a new handler/runner/test tree.
- **Also preserved, unchanged from V3/V4's own model**: legacy `mosquitto.service`, `twingate.service`, IDEA2
  engine/tunnel identities; L2 `nft`/PF-01 table byte-identical; no NAT; all forwarding sysctls zero; the
  default route; regulatory country (radio is never transitioned by V5, exactly as V4).

## 5. Rollback ownership

Rollback undoes **only what `apply.sh` itself journaled**: `NM_DEVICE_AUTOCONNECT_DISABLE`/`NM_UP` (V4's exact
AP-teardown sequence) and `DNSMASQ_RESET_FAILED`/`DNSMASQ_START` (V3's exact dnsmasq-stop sequence — never
recreates the stale start-limit-hit artifact). It **never** touches the L6b broker: no journal entry exists for
it (apply.sh never issued a mutating command against it), so rollback makes no claim about — and takes no
action on — its state either way. If the broker never recovered (apply.sh's bounded wait times out), rollback
still only tears down the AP/dnsmasq mutation it owns; the broker is left exactly as systemd's own auto-restart
left it, which is an explicit, accepted scope boundary (`L6B_BROKER_TOUCHED=NO`), not a defect. As with V4, if
a **different** Wi-Fi profile is found active during the AP teardown, rollback fails closed and escalates
(`UNRELATED_WIFI_ACTIVATED_DURING_ROLLBACK=YES:ESCALATE_TO_OWNER`).

## 6. Authorization model

Reuses `AEGIS_P4_AUTHORIZATION_V1` and fresh K3 (V1 or V2 owner self-attestation) with `stage=L4`, exactly like
V1/V2/V3/V4 — no new record type is invented. To comply with the repository-wide `p4-stage-gate.sh` contract
(`SCOPE_RE='^[\ -~]{1,200}$'`, maximum 200 printable ASCII characters), the V5 authorization scope is <=200 characters.
The runner additionally requires the A-L4 `scope=` line to equal exactly:

```text
L3_L4_RUNTIME_REACTIVATION_V5_POST_L6B_DEGRADED: activate aegis-idea3-ap once, recover dnsmasq, bounded broker auto-restart wait, no broker control, no persistent rewrite, no L7/ESP32/MQTT action
```

so neither a V3 nor a V4 A-L4 can ever authorize a V5 run and vice versa (proven by
`test_v5_scope_string_is_distinct_from_v3_and_v4`). The one-attempt marker is
`L34-V5-REACTIVATION-ATTEMPT-CONSUMED`, distinct from both V3's and V4's own markers, so the three operation
families can never share or exhaust each other's authorization.

**As committed, `run-l34-v5-post-l6b-degraded-owner.sh` ships with `EXPECTED_MAIN=PIN_MAIN_SHA` and refuses to
run** until the owner freeze workflow (copy outside the repo, pin the merged main SHA, record the frozen file's
SHA-256) and a fresh, same-day, exact-scope A-L4/K3 pair are supplied — identical governance shape to V3/V4. No
A-L4/K3 record was created by this task; none of the freeze/authorize steps were performed.

## 7. Files

- `deploy/pr11-phase4/p4-l34-reactivation-lib.sh` — extended (never rewritten) with `L34_V5_BROKER_CONF` and
  `l34_v5_broker_crashloop_gate`. All existing V1/V2/V3/V4 functions are byte-for-byte unchanged.
- `deploy/pr11-phase4/reactivation/l34-v5-post-l6b-degraded/{apply,verify,rollback}.sh` — new, narrowly-scoped
  handlers; `reactivation/l34/` (V1/V2/V3) and `reactivation/l34-v4-post-l6b/` are untouched.
- `deploy/pr11-phase4/reactivation/l34-v5-post-l6b-degraded/{allow-keys,allow-listeners}.txt` — new comparator
  approval lists (unconstrained-key mechanism, §4 above); no `p4-compare.sh` edit.
- `deploy/pr11-phase4/owner-run/run-l34-v5-post-l6b-degraded-owner.sh` — new unpinned owner-run template,
  following the same freeze convention (`PIN_MAIN_SHA`) as V3/V4.
- `tests/l34_sim.py` — extended (backward-compatible: default `broker_mode="identity"` preserves every existing
  V1/V2/V3/V4 test's behavior unchanged, confirmed by the full existing 222-test regression still passing after
  this change) with a `broker_mode="crashloop_until_ap"` state machine
  (`_broker_props`/`_broker_crashloop_recovered`) driven purely by the existing `ap_active` flag — no new stub
  command, no change to any existing stub's dispatch for the default mode.
- `tests/test_pr11_phase4_l34_v5_post_l6b_degraded.py` — new, 29 tests covering: static contract, baseline
  accept/refuse against all three neighboring baselines (V3, V4, and radio-disabled), persistent-file rewrite
  detection, exact mutation ordering, broker-never-recovers failure path, POST verification, rollback ownership
  and escalation, and comparator allow-list hygiene.

## 8. What this design does NOT do

No A-L4/K3 created. No runner frozen or executed. No Production mutation. No rfkill/radio/broker
start/stop/restart/reset-failed command issued anywhere outside the exact, reviewed V5 sequence above. No
historical L3/L4/L6b receipt rewritten. No L7, ESP32, or MQTT command reference anywhere in the new handlers or
runner. No edit to `p4-compare.sh`, `p4-l0-capture.sh`, `p4-l3-nm.sh`, `p4-stage-gate.sh`, or any V1/V2/V3/V4
file.

## 9. Simplification the live host observation did not itself prove

The live diagnostics in this session confirmed dnsmasq (`failed/failed`) and the broker
(`activating/auto-restart`) directly, and confirmed the wifi/radio topology indirectly (Twingate/SSH path was
verified, not `nmcli radio wifi`/rfkill state on the AP host itself). V5's own `l34_v4_baseline_gate`/
`l34_v4_rfkill_ready_gate` calls are the actual, independent, read-only proof of that part of the baseline at
run time — exactly as V3/V4 already rely on their own gates rather than a narrative description. If the live
radio/rfkill topology turns out not to match the V4 shape when the runner is eventually frozen and authorized,
V5 will refuse cleanly before any mutation, the same as it does for every other unrecognized-baseline case
exercised in the test suite.
