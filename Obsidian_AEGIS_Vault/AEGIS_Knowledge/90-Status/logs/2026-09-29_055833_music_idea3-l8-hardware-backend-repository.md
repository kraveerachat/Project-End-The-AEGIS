---
title: Task Receipt — IDEA3 L8 real-hardware backend and boot verification (repository only)
date: 2026-09-29T05:58:33+07:00
owner: music
area: idea3
branch: feat/idea3-pr11-l8-hardware-backend
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 L8 real-hardware backend and boot verification (repository only)

## What changed

- Repository L8 capability moved from `HARDWARE_BACKEND_NOT_IMPLEMENTED_IN_REPOSITORY` to
  `HARDWARE_BACKEND_IMPLEMENTED_REPOSITORY` with `LIVE_L8=NOT_AUTHORIZED` and `LIVE_L8_PHYSICAL_PROOF=NOT_PROVEN`.
  This task authorizes nothing live and touched no hardware.
- `p4-l8-device.py` gained `HardwareDevice`: a subprocess adapter over the PlatformIO-pinned `tool-esptoolpy`
  2.41100.0 (esptool 4.11.x; the tool `espressif32@7.0.1` resolves; baud = `platformio.ini` `upload_speed`).
  No pyserial or new flashing dependency was added.
- One injectable `CommandExecutor` seam plus one argv allowlist (`validate_esptool_argv`): only `flash_id`,
  `write_flash <addr> <scratch>` and `read_flash <addr> <size> <scratch>`, prefixed by the bound serial port taken
  only from the validated `device.identity`. Erase, `write_mem`, eFuse, PlatformIO upload, option smuggling,
  unbound offsets, CUT/RESTORE, MQTT and plaintext 1883 are unreachable. `SubprocessExecutor` (the only process
  spawner) is built only after the live gate and re-checks the same shape.
- Identity (MAC, chip, flash size) is parsed strictly from one `flash_id` run before any write; malformed,
  repeated, contradictory or non-classic-ESP32 output fails closed; observed MAC must equal `expected_mac`;
  derived partition geometry must fit the observed flash.
- Writes only at the table-derived NVS and application offsets via private 0600 scratch files removed afterwards;
  NVS readback of exactly the written region, compared privately, PASS/FAIL only; first-write marker precedes the
  first write; any post-write exception is contained as evidence (`DEVICE_WRITE`/`NVS_READBACK`/`BOOT_VERIFICATION`)
  and held `FAIL_SECURE_HOLD_AND_EVIDENCE` with no retry, reflash or restore. Evidence stays the exact 11-field
  write-once 0600 bundle. `rollback.sh` post-write still performs zero device action (file untouched).
- `apply.sh` recognizes `hardware` but requires `AEGIS_L8_LIVE_AUTHORIZED=YES` and `AEGIS_L8_ESPTOOL`, refuses a
  fixture descriptor alongside it, and still refuses a `/dev` path in fixture mode.
- Device-free gates (geometry, build command, CA, firmware SHA, NTP, evidence path) now run before the device is
  observed, so a bad input never causes a needless device reset; the demo/test-key gate stays after identity
  and before the first write. Also added: run-id charset check, image-vs-partition size checks, evidence-path
  pre-check (write-once collision is caught before flashing).
- **Boot verification: IMPLEMENTED_REPOSITORY (second session, same PR, owner-approved contract).** New
  `p4-l8-boot-verify.py`: a subscribe-only signed-BOOT-STATUS verifier with no publish path (no COMMAND,
  HEARTBEAT, CUT or RESTORE reachable). Exact topic `aegis/idea3/v1/<device_id>/status`, TLS 8883 with the pinned
  CA, the staged Core broker credential (`idea3-core`; no new broker user, no ACL change), the real Protocol v1
  `InboundVerifier` over an in-memory store (never the Core replay store). Armed after observed identity and
  before the first write (T0 from the Core trusted clock); collects after the readback `hard_reset` for at most
  180 s. PASS = authenticated, non-retained `BOOT`/`LOCKDOWN`/`SYNCED` frame with empty command correlation,
  `device_seq_hwm` equal to the new NVS's initial `seq_hi`, unseen `msg_id`, skew rule satisfied, and
  `device_time >= T0 - 2`. Authenticated `output_state=NORMAL` = FAIL; everything else = NOT_PROVEN. Both
  record `failure_boundary=BOOT_VERIFICATION` and hold as `FAIL_SECURE_HOLD_AND_EVIDENCE` (no retry, restore
  or reflash). Arm failure aborts before any write. PASS means AUTHENTICATED_FIRMWARE_REPORTED_LOCKDOWN, not
  electrical relay proof. L9 reuses this BOOT event; L8 never reboots the device for a second one.
- Hardware now requires `AEGIS_L8_BROKER_ADDRESS`, `AEGIS_L8_BROKER_TLS_NAME`, `AEGIS_L8_MQTT_CA_FILE` and
  `AEGIS_L8_BROKER_CREDENTIAL_FILE` (shell and helper); without them it refuses before any device access with
  `BOOT_VERIFICATION_NOT_CONFIGURED` (this replaces the earlier `BOOT_VERIFICATION_NOT_IMPLEMENTED` refusal).
  No firmware change was needed or made.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l8-device.py` — hardware backend, executor, allowlist, provision reorder/containment; boot-verifier construction, arming, close and CLI inputs.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l8-boot-verify.py` — new: subscribe-only signed BOOT STATUS verifier.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l8_boot_verify.py` — new: 69 tests, fake MQTT client/executor/clock; autouse guards against any device, tool or network.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L8/apply.sh` — hardware branch behind the live gate; passes `--esptool`/`--live-authorized`; requires and forwards the four broker inputs.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l8_hardware_backend.py` — new: 80 tests, fake executor only, autouse guard against any real device/tool; two boot-gap tests moved to the new contract.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l8_handler.py` — two stale "hardware refused/not implemented" tests rewritten to the new contract.
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-21-idea3-pr11-phase4-l8-operational-design.md` — stale capability statements reconciled; new §8 including §8.4 boot verification. OD-L8 policy not rewritten.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md` — L8 backend line reconciled.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L8/verify.sh`, `rollback.sh` — NOT modified.

## Verification evidence

- Session 1 RED: hardware suite before implementation — 74 failed / 6 passed.
- Session 2 RED: `pytest tests/test_pr11_phase4_l8_boot_verify.py -q` before implementation — fail: 68 failed / 1 passed (module `p4-l8-boot-verify.py` and the new provision inputs did not exist).
- `pytest tests/test_pr11_phase4_l8_boot_verify.py tests/test_pr11_phase4_l8_hardware_backend.py tests/test_pr11_phase4_l8_handler.py tests/test_pr11_phase4_harness.py -q` — pass: 448 passed (boot 69, hardware 80, handler 77, harness 222).
- `pytest tests/test_pr11_phase4_nvs_provision.py tests/test_firmware_contract.py tests/test_firmware_protocol_parity.py tests/test_platform_lock.py tests/test_pr11_phase4_g15_host_artifacts.py tests/test_pr11_phase4_l9_handler.py tests/test_pr11_phase4_l7_handler.py tests/test_protocol_inbound.py tests/test_protocol_v1.py -q` — pass: 623 passed.
- `bash -n` on L8 `apply.sh`, `verify.sh`, `rollback.sh`; `python -m py_compile` on `p4-l8-device.py` and `p4-l8-boot-verify.py` — pass.
- `git diff --check` — pass. Secret-pattern scan of added lines and new untracked files (PEM private headers, AWS-style ids, 64-hex) — no hits. The one embedded PEM is a public throwaway TEST CA certificate whose private key was never stored.
- Python used: `~/.venvs/aegis-idea3-core/bin/python` (pytest 9.1.1).

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — top section for the L8 hardware backend and boot verification, one line added to the L8 state block, `updated` date.

## Shared surfaces touched

- `None` — task stayed inside IDEA3 (`IDEA3-AEGIS_Lockdown/` and the owner-writable IDEA3 status note plus this receipt)

## Integration requests

- None — no cross-scope/shared path changed. The boot-verification owner decisions were received and implemented; no further integration request.

## Known limitations

- Nothing was exercised against real hardware, a real broker or a real network; the esptool output format and the paho TLS/subscribe behavior are asserted from documented behavior and fakes only. `LIVE_L8_PHYSICAL_PROOF=NOT_PROVEN`, `LIVE_L8=NOT_AUTHORIZED`.
- Boot PASS is AUTHENTICATED_FIRMWARE_REPORTED_LOCKDOWN: it does not prove the relay contact is physically open, nor which firmware image signed the frame. Electrical proof is outside the verifier.
- Live boot proof depends on the AP, NTP, PKI, broker and Core-clock stages being healthy inside the 180 s window; a network fault yields NOT_PROVEN and a fail-secure hold, never a false PASS. The Core's own service will also accept the same BOOT frame (L9 reuses that event).
- The verifier's default clock is the Core `TrustedClock` (adjtimex-based); it was exercised with a fake clock only.
- D4 live, OV-12 values and the A-L8 authorization are unchanged and unproven; `AEGIS_L8_LIVE_AUTHORIZED=YES` is a handler flag and the same-day A-L8 gate is enforced outside this task.
- The concurrent L7 remediation branch was not touched; `origin/main` had not advanced at the last fetch (`ec12cf38`), so no merge was needed.
