# IDEA3 PR11 Phase 4 L8p — ESP32 device provisioning ONLY (on the canonical L8 hardware backend)

Date: 2026-10-02. Owner: music. Status: **REPOSITORY IMPLEMENTATION (fixture / fake executor only)**. `L8P_LIVE = NOT_AUTHORIZED`, `REAL_ESP32_PROOF = NOT_PROVEN`,
`ELECTRICAL_RELAY_PROOF = NO`, `L8_ACCEPTANCE = NOT_CLAIMED`, `RECOVERY_ACCEPTANCE = NOT_CLAIMED`.

```
ORDER = L7 -> L7u -> L8p -> Recovery R1-R8 -> LVR -> L8
```

## 1. Why, and the owner decision

Recovery R4/R5 need a live Protocol-v1 device; L8 provisions it but requires D4 live before flashing, and D4 live needs the device. Owner decision
**OD-L8P-01** (recorded in the L8 operational design, 2026-10-02): for L8p only, `D4_LIVE_REQUIRED_BEFORE_L8P_FLASH = NO`; an owner-attested **physical recovery
procedure** satisfies the pre-write recovery prerequisite. L8 is unchanged (`D4_ONLY`, `INTERIM_RECOVERY_PROCEDURE=NOT_APPROVED`, D4 live required).

L8p claims only that the ESP32 was provisioned with the pinned NVS and firmware, both read back equal, and a signed BOOT STATUS reported LOCKDOWN. It does
**not** claim Recovery R1-R8, LVR, L8 live acceptance, L9 or the electrical relay, never sends CUT or RESTORE, and never restores the uplink.

## 2. Architecture: governance on top of ONE canonical flow

There is one device flow: `p4-l8-device.py` (merged in PR #247 and hardened) with `p4-l8-boot-verify.py`. L8p adds NO backend. The canonical `provision()` accepts an
explicit `StageProfile` (a `NamedTuple`): a mandatory `recovery_gate`, an optional `pre_device_gate`, an optional `nvs_gate` and an `evidence_prefix`. The default
profile is L8 with the D4 attestation as its recovery gate, so L8 behaves exactly as before. Hooks are fail-closed: any exception, not only an `L8Error`, aborts
before the first write, and a profile without a callable recovery gate is refused.

`p4-l8p-device.py` is thin: it defines no class, starts no process and contains no esptool verb. It supplies the L8p profile (attestation, pins, NVS schema check,
evidence prefix `l8p`) and calls the canonical flow. `HardwareDevice`, `SubprocessExecutor`, `validate_esptool_argv`, the pinned-esptool resolver, scratch handling,
NVS and firmware readback, the single terminal reset (`reset_into_new_image()`), the signed BOOT verifier and the 12-field evidence all come from the canonical code.
The hardware backend is unreachable without `AEGIS_L8P_LIVE_AUTHORIZED=YES`, and the serial port comes only from the validated `device.identity`.

## 3. Contract

* **Authorization** `AEGIS_P4_AUTHORIZATION_V1`, same day (Asia/Bangkok), plus the required `physical_recovery_attestation=<ref>` (placeholder-refused); K3 (V1 or V2)
  required; `recovery_authorization`, `d6_notice` and `integration_review` are refused on L8p and `physical_recovery_attestation` is refused on every other stage.
* **Inputs** (owner-only 0600/0400): `device.identity` (exact `expected_mac`, exact `/dev/ttyUSBn|ttyACMn`), `provisioning.pins` (`firmware_sha256`, `partition_table_sha256`,
  `nvs_offset/size`, `app_offset/size`, `nvs_namespace=aegis-p1`, `nvs_schema=1`), `physical-recovery.attestation`, `k_c2d`, `k_d2c`, `wifi.psk`, `mqtt.pass`, and a COMPLETE,
  checksummed PRE capture directory that must exist before the first write. There is deliberately no `d4.attestation`.
* **Physical recovery attestation** (`AEGIS_P4_L8P_PHYSICAL_RECOVERY_ATTESTATION_V1`, strict key set, constrained values, no secret can be carried): `stage=L8p`; `expected_mac`
  equal to the `device.identity` binding; `procedure_id` (reference token, placeholder-refused); `procedure_class=MANUAL_OUT_OF_BAND`; `firmware_sha256` and
  `partition_table_sha256` equal to the actual artifacts; `approved_on` (a real date, not in the future). The procedure must be capable of (all `YES`) physical serial recovery,
  ROM bootloader recovery, power disconnect/reconnect, entering download mode, owner-reviewed serial access, reflashing the owner-pinned firmware and NVS, and recovering
  an interrupted write; it must NOT depend on (all `NO`) Production, MQTT, network connectivity, automatic rollback, legacy firmware fallback, plaintext 1883 or remote recovery.
  Explicit acknowledgements (all `YES`): manual/out-of-band, NOT D4, and that L8p proves neither Recovery, LVR, final L8 acceptance nor the electrical relay state.
* **Gates before the first write**: attestation, MAC binding, pins (partition-table digest, derived geometry equals pinned geometry, alignment and non-overlap, firmware digest),
  the canonical gates (MQTT CA trust anchor, compile-only build command, NTP, demo/test keys), the exact rendered NVS schema (the eleven approved fields, no address field),
  observed identity equal to the binding, the boot verifier armed. Then the **FIRST_WRITE** marker.
* **After the first write**: no automatic retry, reflash, rollback write, RESTORE or fallback; any failure is `FAIL_SECURE_HOLD_AND_EVIDENCE`; `rollback.sh` performs zero device action
  (it starts no process other than coreutils). The physical recovery is a manual owner action outside the automated rollback.
* **Evidence**: the canonical OD-L8-09 12-field bundle, unchanged (no stage field), write-once 0600, named `l8p-<run_id>.json`; `verify.sh` checks the 12 fields and the name.
* **Handlers**: `stages/L8p/{apply,verify,rollback}.sh` and empty `allow-keys.txt` / `allow-listeners.txt` (zero Core-host drift). The stage id fits the existing suffix convention
  and is registered between `L7u` and `L8` (`p4-lib.sh`, `p4-stage-gate.sh`).

## 4. Owner runner (repository template; inert)

`deploy/pr11-phase4/owner-run/run-l8p-owner.sh` with its gate library `p4-l8p-run-lib.sh` follow the L7u owner-run pattern. The committed copy is an **inert template**: nineteen `PIN_`
values (the merged main SHA, the frozen operator user and uid, the reviewed firmware and partition-table SHA-256, the owner input directory, the reviewed artifacts, the pinned flash tool and its own frozen Python interpreter (`ESPTOOL_PYTHON`), the MQTT CA and broker
credential files, the broker address and TLS name, the Wi-Fi SSID, the NTP server, the compile-only build command) make it refuse until the owner freeze workflow copies it outside the
repository and pins them after the FINAL source set is merged. It holds no device logic: every device operation is the canonical L8p handler set.

The runner is bound to the frozen operator identity by the reused L7u identity gate (current `id -un`/`id -u` equal the frozen `OPERATOR_USER`/`OPERATOR_UID`, which
must resolve to the same account, uid non-root) BEFORE `sudo`, the evidence directory, the PRE capture, the attempt marker, any handler and any device access; the owner input
files must be owned by that frozen uid.

Sequence: read-only pre-gates (same-day `stage=L8p` authorization with `physical_recovery_attestation` and no `recovery_authorization`, K3, pinned clean main, registered handlers, the
reused `p4-stage-gate.sh --stage L8p --mode live`, the predecessor receipt chain read from the pinned commit **including a PROVEN final L7u**, Core/service/IDEA2/disk/forwarding runtime
gates, the exact owner input directory, the frozen artifact digests) -> PRE L0 capture and checksum -> consume the single attempt (`L8p-ATTEMPT-CONSUMED`) -> `apply.sh` once ->
`verify.sh` -> POST capture -> PRE/POST compare (empty L8p allow files) -> secret scan -> narrow result. The hardware backend is requested in exactly one place, after the attempt is
consumed. Any failure after consumption calls the canonical `rollback.sh` (it must report `L8P_DEVICE_ACTION_TAKEN=NONE` and, after the first write,
`L8P_ROLLBACK=FAIL_SECURE_HOLD_AND_EVIDENCE`), then a mandatory RB capture and PRE->RB compare, and holds/escalates; hardware zero drift is not claimed after the first write. The runner never
retries, reflashes, erases, sends CUT or RESTORE, opens plaintext 1883 or performs the physical recovery (manual, out-of-band).

A successful run may claim only `L8P_LIVE_EXECUTED=YES` and `L8P_PROVISIONING=PASS`, and states `RECOVERY_R1_R8_PROVEN=NO`, `LVR_PROVEN=NO`, `L8_ACCEPTANCE=NO`,
`ELECTRICAL_RELAY_PROOF=NO`. Today a real run fails closed: no FINAL L7u live acceptance receipt exists.

## 5. Not done / owner actions

Nothing here is live. Still needed: freezing the runner (after the final source set is merged), the exact reviewed firmware image, partition table and pins, the real MQTT CA header, the NVS
generator, OV-12, the written physical recovery procedure, a same-day authorization and K3, and Kla integration review of the shared edits (`p4-lib.sh`, `p4-stage-gate.sh`,
`tests/test_pr11_phase4_harness.py`, the L7u governance order assertion, and the small profile extension in `p4-l8-device.py`). Recovery R1-R8, LVR and L8 remain unproven.

## 6. Addendum (2026-10-04): the esptool interpreter is a separate frozen pin

The L8p final preflight found that the orchestration interpreter (`PY` / `AEGIS_PYTHON_BIN`, used to run `p4-l8p-device.py`) was also the implicit esptool launcher (`[sys.executable, esptool.py, ...]`).
That interpreter cannot import the pinned esptool's dependencies, so a live run would have failed after the one-shot attempt was consumed. The runner now has a nineteenth pin, `ESPTOOL_PYTHON`
(an absolute interpreter path, never committed), passed to the handler as `AEGIS_L8P_ESPTOOL_PYTHON` and to `p4-l8p-device.py` as `--esptool-python`; `AEGIS_PYTHON_BIN` is untouched. The canonical flow
builds the `SubprocessExecutor` and the `HardwareDevice` from that one interpreter and refuses a mismatch; the L8p stage profile makes the explicit interpreter mandatory in hardware mode (no `sys.executable`
or `python3` fallback), while L8 keeps its legacy behaviour. A read-only pre-gate (`l8p_esptool_python_gate`) runs in the runner's pre-gates, before the PRE capture and the attempt marker: it executes the
pinned `esptool.py --help` under the frozen interpreter in a scrubbed environment (no serial open, no flash command, no installation), so a missing dependency fails the run with no attempt consumed and the device untouched.

## 7. Addendum (2026-10-04): live attempt 1 findings (two repository defects, both pre-first-write)

The first owner-run attempt consumed its one-shot authorization and stopped before any device action: `apply.sh` refused the PRE evidence, then the rollback's PRE->RB comparison failed on usage. (1) The PRE completeness check
required the whole `capture.log` line to equal `L0_CAPTURE=COMPLETE`, but the canonical `p4-l0-capture.sh` log is `p4_log` output (`<TIMESTAMP> L0_CAPTURE=COMPLETE evidence=<path>`); the check now accepts the field as a distinct
whitespace-delimited token (and refuses `INCOMPLETE`, `NOT_L0_CAPTURE=COMPLETE`, `COMPLETED` and embedded substrings) and the mandatory `SHA256SUMS` verification is unchanged. (2) The owner runner passed the report path to
`p4-compare.sh` as a third positional argument; the comparator takes exactly `<BEFORE_DIR> <AFTER_DIR>`, so the report path is now only the runner's redirection target. The first attempt's records and evidence stay immutable; a successor
attempt needs a new freeze, a fresh same-day Authorization/K3 and explicit owner authorization.
