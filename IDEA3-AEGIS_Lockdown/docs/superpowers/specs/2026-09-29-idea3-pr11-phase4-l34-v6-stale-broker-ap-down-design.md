# AEGIS IDEA3 PR11 Phase 4 — L3/L4 STALE-BROKER / AP-DOWN Runtime Reactivation Design (V6)

Date: 2026-09-29 (Asia/Bangkok). Owner: music. Status: **repository implementation only. Live execution NOT authorized.**

```text
V6_STAGE_NAME                = l34-v6-stale-broker-ap-down
V6_BASELINE_ID               = STALE_BROKER_AP_DOWN
BASE_MAIN                    = a888457e1ae415d9ec5d70b88bc4bb34514516f6 (PR #250 and PR #251 in ancestry)
REACTIVATION_EXECUTED        = NO
LIVE_REACTIVATION_AUTHORIZED = NO
PRODUCTION_MUTATION          = NO   (this document and its implementation)
A_L4_CREATED                 = NO
K3_L4_CREATED                = NO
L4_EXECUTED / L6C / L7 / ESP32 = NOT TOUCHED
L3_LIVE_ACCEPTANCE           = PROVEN historically (unchanged, not re-claimed)
L4_LIVE_ACCEPTANCE           = PROVEN historically (unchanged, not re-claimed)
L6B_LIVE_ACCEPTANCE          = PROVEN historically (unchanged, not re-claimed, and NEVER mutated by this workflow)
K12_AUTOMATIC_REBOOT_PERSISTENCE = NOT_PROVEN
```

## 0. Why this task exists

V5 (PR #250) recovers a host whose L6b broker is *crash-looping* because its AP-facing listener cannot bind. The next observed
host state is different: the broker is **healthy and stable**, already listening on the exact stale pair
`127.0.0.1:8883` and `10.77.30.1:8883` (the second socket was bound before the AP address went away and survives its removal), while
the AP address is absent, the AP is down and `aegis-idea3-dnsmasq.service` is *cleanly* `inactive/dead` (not `failed`). None of
V1–V5 accepts it:

```text
V1–V3   NM radio must be DISABLED; dnsmasq must be failed/start-limit-hit; broker must be inactive.
V4      dnsmasq AND broker must already be active/running (AP already up).
V5      dnsmasq must be failed/start-limit-hit; broker must be crash-looping (activating/auto-restart, bind-failure journal line).
V6      radio ENABLED (V4 topology); dnsmasq clean inactive/dead/success; broker active/running/stable with the stale pair; AP down.
```

## 1. Frozen decisions (authoritative; V5 semantics are not weakened; no V1–V5 file is modified)

1. **TLS probe.** `openssl s_client` is NOT implemented. The unchanged `deploy/pr11-phase4/p4-l7-broker-probe.py` is reused, once, after
   the AP and dnsmasq are established, as
   `tls --address 10.77.30.1 --port 8883 --server-name mqtt.aegis.home.arpa --ca-file /etc/aegis-idea3/mqtt/ca.crt`
   plus `--repo-root <IDEA3-AEGIS_Lockdown>` (the unchanged probe declares `--repo-root` required to import the Core TLS context;
   it is the repository path, not a behaviour change). It validates the chain and hostname, requires TLS >= 1.2, sends no MQTT bytes and
   reads no MQTT credential/PSK. 127.0.0.1 is never probed. It is wrapped in `timeout 20`; only the exact line
   `L7_BROKER_TLS_PROBE=PASS tls=TLSv1.2|TLSv1.3` with exit 0 passes. It is captured once: a failure reason is read from that single
   run, the probe is never repeated.
2. **Soak.** 6 samples, 5 s apart, fixed in the live handler (no live knob). Each sample re-checks the AP gate (type/SSID/channel/exact
   address/no global IPv6/no AP default route), the default-route table equals PRE, dnsmasq active + exact three listeners, the exact broker
   listener pair, and broker `MainPID`/`NRestarts`/`InvocationID` equal to PRE. Preflight stability sampling is 3 reads about 5 s apart.
   Only stubbed fixture runs (non-empty `AEGIS_P4_FS_ROOT` with stub commands) may shorten these intervals.
3. **dnsmasq.** Normal apply: one plain `systemctl start aegis-idea3-dnsmasq.service`; NO `reset-failed`. Journal kinds are exactly
   `NM_DEVICE_AUTOCONNECT_DISABLE`, `NM_UP`, `NM_DEVICE_AUTOCONNECT_RESTORED`, `DNSMASQ_START`; there is no `DNSMASQ_RESET_FAILED` kind.
   Rollback: if and only if `DNSMASQ_START` was journaled and this exact unit is `failed` after the attempted start, rollback stops it as
   needed and issues ONE exact-unit `reset-failed` to restore PRE `loaded/inactive/dead/Result=success/MainPID=0/enabled`. Generic
   `dnsmasq.service` is never touched.
4. **Broker rollback proof.** Neither apply, verify, rollback nor the runner ever issues start/stop/restart/reload/reset-failed/kill/
   try-restart/enable/disable/mask against the broker. Rollback (and verify, and every soak sample) PROVES: active/running/success/enabled,
   `MainPID == NRestarts == InvocationID == PRE`, exact stale pair present. Any tuple change is fail-closed: `S11_HOLD_ESCALATE`, never a repair.
5. **Legacy :1883.** A legacy mosquitto `:1883` listener may exist at PRE. Its `<state> <backlog> <address>` rows are snapshotted and must be
   byte-identical through apply, verify, POST and rollback. A new plaintext `:1883` (in particular on the AP address) fails. V6 never controls
   legacy mosquitto.

## 2. PRE contract (read-only; nothing mutates until `PRODUCTION_MUTATION_PERFORMED=YES`)

`wlp0s20f3` is the only Wi-Fi device and the only wlan rfkill; radio enabled; target `disconnected`; rfkill unblocked; no Wi-Fi active;
`10.77.30.1` on no interface; no route or default route bound to the AP; AP profile and dnsmasq config/unit gates plus `dnsmasq --test`;
device autoconnect `yes`, profile autoconnect `no`; dnsmasq exactly `loaded/enabled/inactive/dead/success/MainPID=0`; no DNS/DHCP listener on the
AP (or any :67); broker active/running/success/enabled with a well-formed tuple (numeric PID, restart count, 32-hex InvocationID) identical
across 3 samples; exactly the stale pair; nft/PF-01 unchanged, no NAT, all seven forwarding sysctls 0; IDEA1/IDEA2/Twingate/legacy
mosquitto identities; legacy :1883 snapshot. The fresh V6 authorization/K3 contract (exact 188-character ASCII scope:
`L3_L4_RUNTIME_REACTIVATION_V6_STALE_BROKER_AP_DOWN: one AP up, one dnsmasq start, one TLS handshake probe; no broker control, no nft/forwarding, no IDEA1/IDEA2 change, no MQTT/ESP32/L6c/L7`)
lives only in the owner runner; no live authorization is created by this task.

## 3. Consume order (owner runner)

```text
runner pre-gates (auth/K3/scope/unconsumed/pinned main/clean/receipts/services/dnsmasq+broker unit gates)
→ handler apply.sh PREFLIGHT_ONLY = PASS
→ PRE capture + SHA256 verify
→ final broker tuple equality against the preflight tuple
→ atomically consume L34-V6-REACTIVATION-ATTEMPT-CONSUMED (noclobber)
→ handler apply.sh runs the full preflight again
→ production-mutation marker written and confirmed
→ first mutation
```

A failure at any step before the marker (including PRE capture) changes nothing and does NOT consume the attempt. After consumption every failure
is STOP / rollback / evidence and the authorization is never reused (a second run is refused at gate time). Exactly one apply invocation exists.

## 4. Mutation (apply.sh) and verification

1 journal autoconnect disable · 2 device autoconnect no · 3 bounded NM ready · 4 journal NM_UP · 5 one `nmcli connection up aegis-idea3-ap ifname
wlp0s20f3` · 6 AP/default-route/radio proof · 7 journal autoconnect restore · 8 restore PRE autoconnect · 9 prove the AP address ·
10 journal DNSMASQ_START · 11 one `systemctl start aegis-idea3-dnsmasq.service` · 12 bounded dnsmasq active/listener polls · 13 bounded exact
broker-pair poll · 14 one TLS probe · 15 broker tuple == PRE · 16 persistent/nft/forwarding/preservation gates · 17 `verify.sh` · 18 soak 6×5 s ·
19 POST capture + hash · 20 PRE→POST compare · 21 final identity equality (legacy mosquitto, Twingate, IDEA2, broker tuple).

Success requires `PRESERVATION_S10=PASS`, `COMPARE_RESULT=PASS`, zero new/worsened drift and zero incomparable. `allow-keys.txt` approves only
dnsmasq's `ActiveState/SubState/MainPID/ExecMainStartTimestamp` and the target-interface runtime keys — **no broker key** — and
`allow-listeners.txt` approves only dnsmasq's three AP listeners (the stale pair is already present at PRE and must not change).

## 5. Rollback (rollback.sh) — failure path only

Reverse of the journal: stop dnsmasq (exact unit) and, conditionally, one exact-unit `reset-failed`; autoconnect off; `nmcli connection down aegis-idea3-ap`
only while it is the active connection; autoconnect restored to PRE. An unrelated Wi-Fi profile active afterwards ESCALATES. Proofs: AP down and
address gone, dnsmasq back to its exact PRE tuple with no AP listeners, persistent files byte-identical, nft table identical, forwarding 0, identities
and legacy :1883 identical, and the broker-preservation proof of §1.4. Rollback is idempotent.

## 6. Tests

`test_pr11_phase4_l34_v6_stale_broker_ap_down.py` (handler matrix on the `tests/l34_sim.py` host simulator: baseline PASS, V3/V4/V5 rejection,
unstable PID/NRestarts/InvocationID, stale pair missing/extra, dnsmasq exact PRE, listener presence, static broker/openssl bans, apply ordering,
TLS pass/fail/timeout via a test-only probe fixture, dnsmasq start-failure and conditional reset-failed rollback, broker-change HOLD without repair,
rollback twice, unrelated Wi-Fi escalation, exact legacy :1883, allow files, soak), `test_pr11_phase4_l34_v6_owner_run_flow.py` (the real runner
against sandbox stubs: consume ordering, PRE-capture failure does not consume, second use rejected, rollback/HOLD exits) and
`test_pr11_phase4_l34_v6_scope_contract.py` (scope ≤200, real stage-gate parse, byte-identity pins for every V1–V5 file and the pre-V6 library).
The additive simulator changes (`tests/l34_sim.py`) default to V1–V5 behaviour.

## 7. Non-goals

No Production mutation, no service command against the real host, no live authorization, no L4/L6c/L7 execution, no ESP32, no change to
V1–V5, PR #238/#249/#252 or the Phase 4 reviewed-handler registry (PR #251 stays green).

## 8. Addendum — TrustedClock stabilization gate (post failed live attempt `2026-09-29-l34-v6-20260929-170043`)

**Observed:** the first live attempt passed apply, verify and the soak, then failed PRE→POST and PRE→RB ONLY on `time.trustedclock.state SYNCED -> UNTRUSTED`.
Later read-only probes were `SYNCED / OK` on every sample (maxerror 50000 → 75500 µs, `adjtimex_ret=0`, `status=0x2001`, `sta_unsync=0`, `time_error=0`),
`systemd-timesyncd` had never restarted and `chronyd` was inactive. The exact transient subreason at POST/RB was NOT recorded and is NOT proven; a persistent
time-service failure was not observed. The comparator is correct and is not weakened. The consumed authorization `2026-09-29-l34-v6-auth-20260929-165848` is never reused.

**Remediation (owner runner only):** `clock_gate POST|RB` runs the existing read-only `p4-l5-clock.py state` (the acceptance predicate: adjtimex readable, STA_UNSYNC clear,
maxerror ≤ 1,000,000 µs, TrustedClock SYNCED) after the verify + soak and BEFORE the POST capture, and after the rollback handler and BEFORE the RB capture.
It succeeds only on exactly `state=SYNCED reason=OK …`. HOLDOVER, UNTRUSTED and UNKNOWN are never accepted; no allowlist entry is added.

**Bound:** 60 s, polled every 1 s — the reviewed L5 readiness bound (`stages/L5/apply.sh` `AEGIS_L5_READINESS_TIMEOUT_SEC:-60` / `_INTERVAL_SEC:-1`; the L5 contract
in `README.md` states the 60 s bound and the predicate are unchanged). Not reused: `TRUSTEDCLOCK_HOLDOVER_SEC=300` (it bounds how long an already-synced clock may
keep being trusted as HOLDOVER, and `TRUSTEDCLOCK_FINAL_HOLDOVER_PASS=NO` forbids HOLDOVER as a final state). `p4-l5-clock.py wait` is not usable either: it also
requires chronyd's Leap status, and chronyd is inactive on the V6 host. The recovery seen after the failed attempt shows that recovery happens, not how long it may take.

**Failure semantics:** an unreadable, crashing or malformed probe fails closed at once; a well-formed non-OK verdict is retried until the bound and then fails closed. A POST gate
failure takes the existing rollback path (the POST capture is never taken). A RB gate failure is an S-11 HOLD, exit 3, with no RB capture. After a successful gate the POST/RB
capture and `p4-compare.sh` run unchanged and must independently return `PRESERVATION_S10=PASS` and `COMPARE_RESULT=PASS`.

**Evidence:** `clock-stabilization-post.log` / `clock-stabilization-rb.log` in the run's evidence directory hold every sample with the full, unmodified predicate output
(`state= reason= maxerror_us= adjtimex_ret= status= sta_unsync= time_error=`), the sample index, elapsed seconds and the final `CLOCK_STABILIZATION_<gate>=PASS|FAIL` line.
The global L0 evidence format is not changed.

**Not changed:** `p4-compare.sh`, `p4-l5-clock.py`, `p4-l0-capture.sh` (hash-pinned by `test_pr11_phase4_l34_v6_clock_stabilization.py`), the V6 handlers and allow files,
the 188-character authorization scope, V1–V5, and the release payload (`aegis_soc/**`, `requirements.txt`; staged release `3c8dae69ca17fae2c7949ceb4bbca8f20239ba1b` stays a reuse candidate).
The gate runs no service command, no `timedatectl`, no `chronyc`, no clock set/step/slew and touches no NTP configuration. Any live retry needs a fresh, re-frozen runner,
a new same-day authorization and K3.
