---
title: Task Receipt — IDEA3 L8 real-hardware backend (repository only)
date: 2026-09-29T05:58:33+07:00
owner: music
area: idea3
branch: feat/idea3-pr11-l8-hardware-backend
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 L8 real-hardware backend (repository only)

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
- **Boot verification: BLOCKED_DESIGN_GAP.** The backend boundary exists (`boot_verifier`, results limited to
  PASS/FAIL/NOT_PROVEN, exceptions map to NOT_PROVEN) but no trustworthy signal is defined (firmware prints
  nothing at boot, relay GPIO is invisible to esptool, `publishStatus` is L9 scope). The CLI supplies no verifier,
  so the hardware path refuses before any device access with `BOOT_VERIFICATION_NOT_IMPLEMENTED`. This is a
  deliberate judgment call: refusing pre-write is stricter than flashing a device whose result could never be
  accepted. Live L8 must not be claimed ready.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l8-device.py` — hardware backend, executor, allowlist, provision reorder/containment.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L8/apply.sh` — hardware branch behind the live gate; passes `--esptool`/`--live-authorized`.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l8_hardware_backend.py` — new: 80 tests, fake executor only, autouse guard against any real device/tool.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l8_handler.py` — two stale "hardware refused/not implemented" tests rewritten to the new contract.
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-21-idea3-pr11-phase4-l8-operational-design.md` — stale capability statements reconciled; new §8. OD-L8 policy not rewritten.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md` — L8 backend line reconciled.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L8/verify.sh`, `rollback.sh` — NOT modified.

## Verification evidence

- RED first: `pytest tests/test_pr11_phase4_l8_hardware_backend.py -q` before implementation — fail: 74 failed / 6 passed (missing hardware surface; the 6 were negative/static guards).
- `pytest tests/test_pr11_phase4_l8_hardware_backend.py -q` — pass: 80 passed.
- `pytest tests/test_pr11_phase4_l8_handler.py -q` — pass: 77 passed (fixture regression intact).
- `pytest tests/test_pr11_phase4_l8_handler.py tests/test_pr11_phase4_harness.py -q` — pass: 299 passed.
- `pytest tests/test_pr11_phase4_nvs_provision.py tests/test_firmware_contract.py tests/test_firmware_protocol_parity.py tests/test_platform_lock.py tests/test_pr11_phase4_g15_host_artifacts.py tests/test_pr11_phase4_l9_handler.py tests/test_pr11_phase4_l7_handler.py -q` — pass: 398 passed.
- `bash -n` on L8 `apply.sh`, `verify.sh`, `rollback.sh`; `python -m py_compile deploy/pr11-phase4/p4-l8-device.py` — pass.
- `git diff --check` — pass. Secret-pattern scan of added lines (PEM headers, AWS-style ids, quoted credentials, 64-hex) — no hits.
- Python used: `~/.venvs/aegis-idea3-core/bin/python` (pytest 9.1.1).

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — new top section for the L8 hardware backend, one line added to the L8 state block, `updated` date.

## Shared surfaces touched

- `None` — task stayed inside IDEA3 (`IDEA3-AEGIS_Lockdown/` and the owner-writable IDEA3 status note plus this receipt)

## Integration requests

- None — no cross-scope/shared path changed. Owner decision needed later (not an integration request): approve one boot-verification signal for L8.

## Known limitations

- Nothing was exercised against real hardware; the pinned `esptool` output format is asserted from esptool 4.11 behavior and the fake, not observed on a device. `LIVE_L8_PHYSICAL_PROOF=NOT_PROVEN`.
- Boot verification is BLOCKED_DESIGN_GAP; Live L8 is not ready and remains NOT_AUTHORIZED. D4 live, OV-12 values and the A-L8 authorization are unchanged and unproven.
- `AEGIS_L8_LIVE_AUTHORIZED=YES` is a handler flag, as for other stages; same-day A-L8 authorization is still enforced by the stage gate outside this task.
- The concurrent L7 remediation branch was not touched; `origin/main` had not advanced at the last fetch (`ec12cf38`), so no merge was needed.
