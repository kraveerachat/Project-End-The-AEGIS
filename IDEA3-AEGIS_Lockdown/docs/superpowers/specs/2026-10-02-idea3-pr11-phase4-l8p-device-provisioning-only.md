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

## 4. Not done / owner actions

Nothing here is live. Still needed: the stage owner runner (not part of this change), the exact reviewed firmware image, partition table and pins, the real MQTT CA header, the NVS
generator, OV-12, the written physical recovery procedure, a same-day authorization and K3, and Kla integration review of the shared edits (`p4-lib.sh`, `p4-stage-gate.sh`,
`tests/test_pr11_phase4_harness.py`, the L7u governance order assertion, and the small profile extension in `p4-l8-device.py`). Recovery R1-R8, LVR and L8 remain unproven.
