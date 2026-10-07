# IDEA3 PR11 Phase 4 L8u — governed READ-ONLY L8 live acceptance (LVR PASS → L8u)

Date: 2026-10-07. Owner: music. Status: **REPOSITORY IMPLEMENTATION (hermetic tests only)**. Branch `feat/idea3-l8-governed-live-successor`, STACKED on PR #375 head
`74b3295909e2c679f763c87d1680d6d0bf29d2dc`. `L8U_LIVE = NOT_AUTHORIZED`, `L8U_LIVE_EXECUTED = NO`, `L8P_EXECUTED = NO`, `ESP32_TOUCHED = NO`, `PRODUCTION_MUTATION = NO`.

```
ORDER = L7 -> L7u -> L8p -> F1i -> F1r -> F1 -> F1u -> R1I -> R1A -> R1Du -> R1D -> R1Dv -> R1B -> R1Bv -> RRu -> CTu -> Recovery R2-R8 -> LVR -> L8u -> (L8: historical, superseded) -> L9
```

## 1. What L8 means after L8p (contract discovery)

| | Stage | What it is | State |
|---|---|---|---|
| **L8p** | historical provisioning | flash + NVS + signed boot verification of the production ESP32 (`p4-l8-device.py` canonical flow) | CLOSED / PASS (`L8P_LIVE_EXECUTED=YES`, `L8P_PROVISIONING=PASS`, canonical receipt `2026-10-04_075127_…l8p-attempt2-reconciliation-closeout.md`). **Never rerun. Never reflash.** |
| **L8** (registered, handler `stages/L8`) | the ORIGINAL combined inspection / NVS provisioning / flash stage (OD-L8-01..09) | **mutating hardware stage** (flashes the device; D4-only recovery) | **Superseded for the provisioned device.** It stays registered and tested but must never be run live after L8p. Nothing in L8u calls it. |
| **L8u** (this stage) | live ACCEPTANCE after LVR | read-only observation of the already-provisioned device through the Core | NEW; repository only |

The L8/L8p design says "L8 live acceptance" is separate from provisioning (`L8_ACCEPTANCE=NOT_CLAIMED` in every L8p artefact) but never defines it. L8u defines it, conservatively, as **logical acceptance**.

```
L8_ACCEPTANCE_PURPOSE   = after LVR PASS, prove from OBSERVED Core runtime + durable Protocol-v1 evidence that the already-provisioned production ESP32 is alive, authenticated, in the pinned
                          fail-secure state and that nothing actuated during the observation; bind that to the historical L8p identity evidence
L8_REQUIRED_DEVICE_STATE   = the pinned device id publishes AUTHENTICATED Protocol-v1 STATUS after the attempt, in the pinned state (LOCKDOWN or NORMAL, an owner pin); historical L8p bundle matches the pinned MAC + firmware SHA-256
L8_REQUIRED_NETWORK_STATE  = broker CONNECTED, device ONLINE, the persistent L6b broker healthy/stable on loopback + AP 8883, preserved services and IDEA2 §10 units active (read-only gates)
L8_REQUIRED_CORE_STATE     = Core active/running, NRestarts=0, the SAME process before and after (no restart), installed Core unit == pinned CTu unit (no drop-in, ProtectClock off), time_trust SYNCED, detector healthy
L8_MUTATION_REQUIRED       = NO (device: none; Core host: none — allow-keys/allow-listeners are EMPTY, PRE→POST must show zero drift). The only governed writes are the root-owned one-attempt marker and the PASS/FAIL closeout.
```

`L8U_CLAIM = LOGICAL_ACCEPTANCE_ONLY`. It does **not** prove the electrical relay, physical isolation, firmware provenance beyond the historical L8p evidence, or L9 (`ELECTRICAL_RELAY_PROOF=NO`, `PHYSICAL_PROOF=NO`, `L9_PROVEN=NO`).

Explicit non-goals (each enforced by tests, see §8): no L8p/provisioning rerun, no flash, no esptool, no serial open, no ESP32 reset, no MQTT publish (so no CUT/RESTORE and no "wake the device"), no NTP/chrony action, no service start/stop/restart/reload, no `daemon-reload`, no SQLite write.

## 2. LVR → L8u mechanical gate (`l8u-acceptance/l8u_predecessors.py`)

ONE implementation, used by the freeze tool AND by the frozen runner. It reads the Git OBJECTS of the exact pinned main (replacement objects disabled, scrubbed `GIT_*`), never a working-tree or host file.

* **L8p (read-only history):** exactly one receipt carries `L8P_LIVE_EXECUTED=YES` + `L8P_PROVISIONING=PASS` and it is the canonical closeout path. Absent / duplicate / non-canonical ⇒ refuse. It is never an instruction to rerun L8p.
* **LVR PASS:** exactly one receipt is an LVR result (any receipt carrying `LVR_PROVEN=YES`, `LVR_LIVE=CLOSED_PASS`, `LVR_RESULT=PASS` or `LVR_LIVE_EXECUTED=YES`); its name ends `_music_idea3-lvr-live-closeout.md`; it carries every field below exactly once with the exact value; **no** receipt records an LVR failure (`LVR_RESULT=FAIL|FAIL_IMMUTABLE`, `LVR_LIVE=CLOSED_FAIL`, `LVR_PROVEN=FAIL`); **no** receipt already records `L8_ACCEPTANCE=YES` or an L8u result.
* **Descendant rule (the closeout merge moves main):** `LVR_EXECUTION_MAIN` is a real commit, a **strict ancestor** of the L8u `EXPECTED_MAIN`; the LVR closeout receipt did **not** exist at that execution main (it was added by a later commit — so the closeout is in the descendant) and the canonical L8p closeout **did** exist there.
* **Digest pin:** `LVR_CLOSEOUT_SHA256` (frozen) equals the closeout bytes at `EXPECTED_MAIN`.

| Refused | Reason code |
|---|---|
| no LVR closeout | `LVR_PASS_CLOSEOUT_MISSING` |
| LVR FAIL anywhere | `LVR_FAILURE_RECORDED` |
| duplicate / split LVR evidence | `LVR_EVIDENCE_DUPLICATE_OR_SPLIT` |
| wrong receipt name | `LVR_RESULT_NOT_IN_THE_CANONICAL_CLOSEOUT_RECEIPT` |
| missing / wrong field (repository-only receipt: `LVR_LIVE_EXECUTED=NO`, `LVR_RERUN_ALLOWED=YES`, …) | `LVR_FIELD_MISSING_OR_DUPLICATE:*`, `LVR_FIELD_VALUE_INVALID:*` |
| stale-main LVR (execution main not an ancestor / equal to main / closeout already at execution main) | `LVR_EXECUTION_MAIN_NOT_AN_ANCESTOR_OF_L8U_MAIN`, `…_IS_NOT_A_STRICT_ANCESTOR`, `LVR_CLOSEOUT_ALREADY_EXISTED_AT_EXECUTION_MAIN` |
| L8p closeout absent / not in the LVR history | `L8P_HISTORICAL_CLOSEOUT_MISSING_OR_NOT_CANONICAL`, `L8P_CLOSEOUT_NOT_IN_LVR_EXECUTION_HISTORY` |
| L8 / L8u already recorded | `L8_OR_L8U_ALREADY_RECORDED` |
| wrong digest pin | `LVR_CLOSEOUT_SHA256_PIN_MISMATCH` |

### INTEGRATION POINT with the LVR work stream

**LVR is an owner-runbook ceremony today** (`README.md` §986: "LVR-6 and LVR9 remain owner-runbook ceremonies") and has **no** machine-readable closeout in this repository. This stage therefore DEFINES what it will accept and nothing else; the LVR work stream must either produce this exact receipt or change `LVR_REQUIRED` / `LVR_CLOSEOUT_SUFFIX` in `l8u_predecessors.py` (and only there; tests pin it):

```
file name:  Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/<date>_music_idea3-lvr-live-closeout.md
whole-line fields, each exactly once:
  LVR_LIVE=CLOSED_PASS  LVR_LIVE_EXECUTED=YES  LVR_RESULT=PASS  LVR_PROVEN=YES  LVR_ATTEMPT_CONSUMED=YES  LVR_RERUN_ALLOWED=NO
  RECOVERY_R2_R8_EXECUTED=YES  RECOVERY_RESULT=PASS  L8_ACCEPTANCE=NO  L9_PROVEN=NO
  LVR_EXECUTION_MAIN=<40-hex main the LVR LIVE ran at; a STRICT ancestor of the L8u main>
```

## 3. Governed owner runner (`owner-run/run-l8u-owner.sh`, inert template)

Modelled on the Recovery runner (control snapshot, byte-equality with the pinned main, env refusals, sudo keepalive) and the CTu trust findings (no mutable-worktree code, atomic PASS/FAIL closeouts, signal/EXIT handling).

Boot (nothing is sourced, created or touched before step 3): 1) pins checked, `PATH`/`IFS`/`LC_ALL` fixed, `SUDO`, `PYTHON*`, `LD_PRELOAD`, `BASH_ENV`, `SHELLOPTS`, `GIT_*`, device-backend switches (`AEGIS_L8_BACKEND`, `AEGIS_L8_LIVE_AUTHORIZED`, `AEGIS_L8_ESPTOOL`, `AEGIS_L8P_LIVE_AUTHORIZED`) and every test seam refused; `AUTH_DIR` canonical, non-symlink, operator-owned, not group/world writable. 2) `control_gate` (immutable root-owned snapshot of `deploy/pr11-phase4`: manifest digest, every file, exact file set, no symlink, nothing writable, trusted root-owned ancestors). 3) `control_git_gate` (every snapshot file byte-equal to its `EXPECTED_MAIN` Git object). 4) library sourced **from the snapshot**; operator identity; ONE `sudo -v`, then `sudo -n` + bounded keepalive, stopped on every exit path.

Pre-attempt gates (all read-only; none consumes the attempt): HEAD == pinned main, clean tree (ignored files included), `origin/main` == pinned main; **predecessor gate (§2)**; Authorization + K3 (§5); the real stage gate from the snapshot (`AUTHORIZATION_RECORD=VALID`, `K3_CONFIRMATION=VALID`, `ROLLBACK_HANDLER=REGISTERED`); L8u marker/closeouts absent; Recovery marker present; sudo healthy; disk ≥ 20% free; preserved services; persistent broker; IDEA2 §10; Core + detector healthy; **installed Core unit == pinned CTu unit**; **runtime already `SYNCED`/`CONNECTED`/`ONLINE` in the pinned state** (so L8u never needs an NTP or device action); historical L8p evidence bundle matches the pinned MAC + firmware.

Attempt: PRE capture → re-gate (unit, Core/detector, runtime, marker) → **marker** (root, `noclobber`, durable, `chattr +i`; carries the protocol/audit/command high-water marks) → `apply.sh` (observe-only no-op) → POST capture → PRE→POST compare (**empty allow-lists: zero host drift**) → evidence secret scan → `verify.sh` (passive observer, bounded poll) → durable `terminal-result` → atomic `L8U-GLOBAL-CLOSEOUT-PASS` → success line. Success is printed only after the closeout is durable.

## 4. Observer (`p4-l8u-observe.py`, read-only)

`verify.sh` requires: Core MainPID unchanged and equal to the pre-attempt PID, active/running, `NRestarts=0`, unit == pin; historical L8p bundle (pinned SHA-256, 0600 regular file, exactly the twelve OD-L8-09 fields, `device_mac`/`firmware_sha256` == pins, `nvs_readback_match`/`firmware_readback_match`/`flash_result`/`boot_verification_result` == `PASS`, `failure_boundary` == `NONE`); then the bounded poll (`OBSERVE_SECONDS`, 10..3600): status document (via `/proc/<core pid>/root`) fresher than the marker with `time_trust=SYNCED`, `broker=CONNECTED`, `device=ONLINE`, `state=uplink=<pinned>`; at least one **authenticated Protocol-v1 STATUS** (`protocol_seen_d2c`, `kind=STATUS`, pinned device, `rowid` > marker boundary, `received_at` > marker time); the matching `DEVICE_STATUS` audit rows; **zero** `protocol_commands` rows and **zero** actuation events (`COMMAND_*`, `ACK_RECEIVED`, `RECOVERY_*`, `MODE_CHANGE`, `INCIDENT_CLOSED`) after the boundary. SQLite is opened `mode=ro`; the observer has no write, subprocess or network primitive (AST-checked).

## 5. Freeze, Authorization, K3

* **Freeze (`l8u-acceptance/l8u_runner_freeze.py`, `l8u_control_snapshot.py`).** FROZEN RUNNER = EXACT REVIEWED TEMPLATE (the `EXPECTED_MAIN` Git object) + ONLY the 17 allowlisted pin substitutions (`EXPECTED_MAIN`, `OPERATOR_USER`, `OPERATOR_UID`, `CONTROL_SNAPSHOT_DIR`, `CONTROL_MANIFEST_SHA256`, `CORE_UNIT_SHA256`, `DEVICE_ID`, `DEVICE_MAC`, `FIRMWARE_SHA256`, `L8P_EVIDENCE_FILE`, `L8P_EVIDENCE_SHA256`, `LVR_CLOSEOUT_SHA256`, `EXPECTED_STATE`, `OBSERVE_SECONDS`, `REPO`, `PY`, `EVIDENCE_ROOT`); strict grammars; `verify` restores each placeholder and requires byte equality with the template; `--root-owned` (root only, trust root literally `/`) chowns root:root under a proven root-owned ancestor chain; **the predecessor gate runs on every `freeze` and every production `verify`: no frozen L8u runner exists before LVR PASS** and the LVR closeout digest pin must equal the receipt bytes. Control-snapshot and freeze are derived from the Recovery tools (same `--root-owned` / trust-root / TOCTOU model; control-plane half only).
* **Authorization** `authorization-L8u.txt`: exact key set `stage date authorizer scope reference` (any other field — `recovery_authorization`, `d6_notice`, `integration_review`, `physical_recovery_attestation` — is `AUTHORIZATION_MALFORMED`; L8u is on the stage gate's no-extra-field list), same-day (Asia/Bangkok), and it **names**: the pinned main and this exact runner SHA-256 (in `scope`, ≤ 200 chars) and the device MAC, firmware SHA-256 and LVR closeout SHA-256 (in `reference`, ≤ 199 chars of `[A-Za-z0-9._:/#?=&%+-]`).
* **K3** `k3-L8u.txt`: V2 self-attestation exact key set, same-day, names the pinned main. K3 is required because L8u is classified as a mutating stage by the gate (it consumes a host governance marker and runs live captures).
* **Cross-stage replay:** a stage-mismatch is refused in both directions (tested for Recovery, CTu, RRu, L8, L8p, L9, R1Bv, F1u). Records carry no stage-agnostic content that another runner would accept: the runner greps `stage=L8u` and the SHA-256 of the frozen bytes.

## 6. One-shot / failure model (no retry is invented)

L8 and L8p are one-attempt governed stages with consumed authorizations; L8u follows: **ONE attempt TOTAL**. Any existing `L8U-GLOBAL-ATTEMPT-CONSUMED`, `L8U-GLOBAL-CLOSEOUT-PASS` or `L8U-GLOBAL-CLOSEOUT-FAIL` refuses a new run.

| Boundary | Marker | Host / device | Result |
|---|---|---|---|
| any pre-attempt gate, PRE capture, re-gate, signal before the marker | absent | untouched | `REFUSED_BEFORE_ATTEMPT` (a new run needs a fresh authorization) |
| marker created but not durable | present | untouched | `FAIL_IMMUTABLE`, FAIL closeout |
| apply / POST capture / compare / secret scan / verify failure | present | untouched (observation only) | `FAIL_IMMUTABLE`, FAIL closeout, evidence preserved + scanned, **no rollback needed** (`rollback.sh` = `NOT_REQUIRED`, zero action) |
| SIGINT / SIGTERM / SIGHUP after the marker | present | untouched | same as above (`SIGNAL_*`), once (traps are cleared on entry), terminal result written durable BEFORE any print |
| SIGKILL / power loss / host crash | present (durable) | untouched | **uncatchable**: marker present, no closeout; ruled `FAIL_IMMUTABLE/UNKNOWN` by the next human reading of the evidence; never rerun |
| signal between the PASS closeout and `TERMINAL=1` | present | untouched | a FAIL closeout may be written next to the PASS closeout → Recovery/L9 gates must treat `PASS + FAIL` as **not** a pass (the PASS closeout is only valid alone) |

There is no L8p retry, no reflash and no historical-provisioning mutation anywhere in this stage.

## 7. Registration

`p4-lib.sh`: `L8u` registered between `Recovery` and `L8` (gaps `none`, no auth extra); `p4-stage-gate.sh`: `L8u` joins the no-extra-field list. `stages/L8u/{apply,verify,rollback}.sh` + empty `allow-keys.txt` / `allow-listeners.txt`. Existing tests asserting the exact `P4_STAGES` string were updated. PR #375's own gate fix for CTu is deliberately not duplicated here (stacked).

## 8. Tests (`tests/l8u/`, 214+ hermetic)

`test_l8u_predecessors.py` (LVR missing/FAIL/stale/duplicate/split/repository-only/descendant PASS/L8p absent/digest pin/Git-env immunity), `test_l8u_freeze.py` (mechanical derivation from the Git object, pin grammar, tamper detection, no freeze before LVR PASS, runner refuses env overrides and dies before sourcing, control snapshot), `test_l8u_governance.py` (marker/closeout semantics, records binding, real stage gate incl. cross-stage replay, env gate, host gates), `test_l8u_observer.py` (valid fixture PASS; every status/evidence mismatch FAIL; L8p bundle), `test_l8u_stage_boundary.py` (no flash/reset/provision/serial/publish/service-control token in any L8u file; handlers observe-only; runner order; no worktree code), `test_l8u_runner_flow.py` (the REAL frozen runner end to end in a root-less sandbox: PASS flow + closeout, no second attempt, immutable failures, signals, pre-attempt refusals, no leftover processes).

## 9. Not claimed / not authorized

`L8U_LIVE = NOT_AUTHORIZED`; no Authorization/K3 exists; no runner is frozen; `LVR` itself is not implemented here; `L8_ACCEPTANCE = NO`, `L9_PROVEN = NO`, `ELECTRICAL_RELAY_PROOF = NO`. Merge order: #375 → LVR work → this stack.
