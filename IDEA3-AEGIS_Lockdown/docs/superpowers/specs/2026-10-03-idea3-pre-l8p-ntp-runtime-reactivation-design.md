# IDEA3 — PRE-L8p NTP runtime reactivation (governed successor, repository only)

Date: 2026-10-03 · Owner: music · Status: **repository implementation only — nothing executed live**
Task identity: `PRE_L8P_NTP_RUNTIME_REACTIVATION` · Package: `deploy/pr11-phase4/reactivation/pre-l8p-ntp-runtime-reactivation/`

## 1. Why the host is where it is (not a regression)

Historical **L5 LIVE acceptance is `PROVEN` and stays unchanged** (receipt `2026-09-25_214900_music_idea3-pr11-l5-live-acceptance.md`, Attempt #4). L5 deliberately mutated
**runtime `ActiveState` only** — `systemctl stop systemd-timesyncd.service` then `systemctl start chronyd.service` — and deliberately did **not** enable/disable either unit
(`stages/L5/allow-keys.txt` protects `UnitFileState`). A reboot therefore returns the host to the unit-file defaults:

| | observed after reboot | consistent with L5 design |
| --- | --- | --- |
| `chronyd.service` | loaded / inactive / dead / **disabled** / success | yes — never enabled |
| `systemd-timesyncd.service` | loaded / active / running / **enabled** | yes — never disabled |
| UDP/123 | no listener | yes — only chronyd serves the AP |
| `/etc/chrony.conf` | still the rendered L5 config (`server 2.arch.pool.ntp.org iburst`, `bindaddress 10.77.30.1`, `allow 10.77.30.0/28`, `rtcsync`) | yes — files persist |

This is exactly the `K12_AUTOMATIC_REBOOT_PERSISTENCE=NOT_PROVEN` shape. It is **expected**, not a fault, and nothing here claims otherwise.

## 2. Scope (the smallest governed successor)

Restore the already-approved L5 *runtime* NTP-serving state before L8p, nothing more:

```
PRE   timesyncd active/running/enabled · chronyd inactive/dead/disabled/success · AP wlp0s20f3 == 10.77.30.1/28 only ·
      /etc/chrony.conf == approved L5 bytes (SHA-256 20e283e4…35fe, 640 root:root, 4 approved directives) · no alternate chronyd config path ·
      no UDP/TCP 123 listener · TrustedClock SYNCED within the L5 bound (shared p4-l5-clock.py predicate)
APPLY systemctl stop systemd-timesyncd.service ; systemctl start chronyd.service      (nothing else)
POST  chronyd active/running · timesyncd inactive · exactly udp 10.77.30.1:123 (no wildcard, no TCP) · 323 loopback only · TrustedClock SYNCED, maxerror <= 1,000,000 µs ·
      /etc/chrony.conf SHA-256 and metadata PRE == POST · UnitFileState unchanged (chronyd disabled, timesyncd enabled)
```

Not in scope: a new L5 acceptance or rerun, K12 proof, persistent enablement (`enable`/`disable`), any config rewrite, network/AP/dnsmasq/broker/Core change, L8p, Recovery, LVR, L8,
serial/esptool/ESP32, MQTT publish, CUT/RESTORE, relay/uplink wiring.

## 3. Governance (fresh, one attempt, no reuse)

* The task has no `p4-stage-gate.sh` stage name, so Authorization/K3 carry `stage=L5` (the NTP stage; the stage gate and registered L5 rollback handler apply) and the **exact scope string**
  `NTPREACT_EXPECTED_SCOPE` (≤ 200 chars, starts `PRE_L8P_NTP_RUNTIME_REACTIVATION:`) is what binds an Authorization to this task. Same-day (Asia/Bangkok), `authorizer=music`, K3 as the stage gate defines.
* The historical L5 authorization reference (PR #215 comment `5833985188`) is refused; historical L5 records are also stale by date and carry a different scope.
* Dedicated marker `PRE-L8P-NTP-RUNTIME-REACTIVATION-ATTEMPT-CONSUMED`, created atomically (noclobber) **after** handler preflight, PRE capture and the pre-consume S10 stability guard, **immediately before** the first mutation. Any other `*ATTEMPT-CONSUMED*` marker (L5, dnsmasq, L34, L8p …) in the AUTH_DIR refuses. One live attempt; no automatic retry; a consumed attempt is never replayed.
* The owner-run runner is an inert template (`PIN_MAIN_SHA`, `PIN_OPERATOR_USER`, `PIN_OPERATOR_UID`). The owner freeze workflow copies it **outside** the repository (refused if the runner lives under the worktree), pins the merged main SHA and operator identity, records the runner SHA-256 (written to `frozen-inputs.txt`), and only then authorizes one run. HEAD must equal the pin, the worktree must be clean and `origin/main` must still equal the pin (no silent re-pinning).
* The pinned commit must contain a receipt with `L5_LIVE_ACCEPTANCE = PROVEN` (history only; the runtime is gated separately).
* **This repository change creates no Authorization, K3, marker, frozen runner or evidence directory.**

## 4. Failure handling

Any failure after the marker is consumed runs `rollback.sh` once: stop chronyd, start systemd-timesyncd if needed, require the TrustedClock predicate again, then **prove** (never repair) that both
`UnitFileState` values and the config SHA-256 are unchanged and no port-123 listener remains. A fresh capture is compared PRE→RB. Rollback failure ⇒ `ROLLBACK_FAILED_ESCALATE`, exit 3, no retry.
`allow-keys.txt` is a strict subset of the historical L5 catalog: it omits every `/etc/chrony.conf` key and `UnitFileState`, so any such change is drift.

## 5. Claims on success (and only these)

```
PRE_L8P_NTP_RUNTIME_REACTIVATION=PASS   NTP_RUNTIME_READY_FOR_L8P=YES   NTP_LISTENER_ADDRESS=10.77.30.1:123
L5_LIVE_ACCEPTANCE=HISTORICAL_PROVEN_UNCHANGED   K12_AUTOMATIC_REBOOT_PERSISTENCE=NOT_PROVEN
L8P_LIVE_EXECUTED=NO  ESP32_FLASH_PERFORMED=NO  RECOVERY_EXECUTED=NO  LVR_EXECUTED=NO  L8_ACCEPTANCE=NO
```

Runtime readiness is perishable: the next reboot returns the host to timesyncd. L8p still needs its own fresh authorization.

## 6. Tests

`tests/test_pr11_phase4_pre_l8p_ntp_reactivation.py` (lib + handlers on a stateful stubbed host, static scope scans) and
`tests/test_pr11_phase4_pre_l8p_ntp_reactivation_owner_run_flow.py` (real runner, stubbed host commands and capture/compare). Simulated-host proof only.

## 7. Post-live forensic addendum (2026-10-03)

The one live attempt was consumed: APPLY and the pre-POST VERIFY passed, then the POST `p4-l0-capture.sh` ran `timedatectl show-timesync`, which activated `systemd-timesyncd` and (through `Conflicts=`) stopped `chronyd`, so readiness after all evidence capture was invalidated and never proven. The recorded evidence is history and is not rewritten; the attempt is never reusable. The successor changes: the capture queries timesyncd only while it is already running (stable sentinel otherwise); the runner's PASS now requires a FINAL read-only runtime verification after the POST capture and compare (`ntpreact_runtime_ready_gate`: chronyd active/running + disabled, timesyncd inactive/dead + enabled, exactly `udp 10.77.30.1:123` and no wildcard, TrustedClock SYNCED within the bound, approved config, no alternate config path); and the L8p owner runner requires the same gate before the PRE capture and again before consuming its attempt. `NTP_RUNTIME_READY_FOR_L8P` is perishable and is never inferred from a historical receipt.
