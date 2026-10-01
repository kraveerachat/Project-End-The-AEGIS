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
  and held `FAIL_SECURE_HOLD_AND_EVIDENCE` with no retry, reflash or restore. Evidence was the exact 11-field
  write-once 0600 bundle (now 12 fields after the owner-approved 2026-10-01 amendment; see Session 3). `rollback.sh` post-write still performs zero device action (file untouched).
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
  before the first write (T0 from the Core trusted clock); collects after the single terminal reset (Session 3; originally the NVS readback `hard_reset`) for at most
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
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L8/rollback.sh` — NOT modified. (`verify.sh` was modified in Session 3, see below.)

## Verification evidence

- Session 1 RED: `pytest tests/test_pr11_phase4_l8_hardware_backend.py -q -p no:cacheprovider` before implementation — fail: 74 failed / 6 passed.
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
- Sessions 1-2: the concurrent L7 remediation branch was not touched; `origin/main` had not advanced at that fetch (`ec12cf38`). Session 3 reconciled onto current main (see below).

## Session 3 — current-main reconciliation, firmware readback, single terminal reset, OD-L8-09 amendment (2026-10-01)

Same task and same unmerged PR (#247); this section amends this one receipt as repository policy allows for an unmerged task (the receipt is not in the PR base `main`), instead of adding a second receipt, which the collaboration policy check rejects. Nothing live: no Production mutation, no ESP32, no real serial port, no real broker or network, no live L8, Recovery R1-R8 not run, L7u not run.

- **Provenance.** Authoritative main `64f59fbfb0c4d7a731f24e5f0d673a420529c67b`. The remote PR head is still `946bf968b0cb78e051ce57b62284794bc7a5ee07` (merge base `ec12cf38a3e0b8d011a62a7bf9390a7dd78f82a9`, 189 commits behind main, 3 ahead). Its three commits were reconciled onto current main in a local branch (`a76272d3`, `1ec98c60`, `31d6c860`); the only conflict was the canonical status note (both sides appended sections; governance-only; both kept). Source hardening commit `f87614770f9f357c8886010a0459e15d1b1f16d0`. Nothing was pushed and the remote PR branch was not altered.
- **Firmware readback.** After the writes the NVS region is read back (exact offset and length) and compared in memory, then the application region (exact offset and exact image length) is read back and compared in memory; only booleans are recorded (`nvs_readback_match`, `firmware_readback_match`). A mismatch or tool failure stops everything with `failure_boundary` `NVS_READBACK` / `FIRMWARE_READBACK` and `FAIL_SECURE_HOLD_AND_EVIDENCE`: no further read, no reset, no retry, no reflash, no restore, no legacy or plaintext fallback. Anything not proven equal is recorded `FAIL`.
- **Single terminal reset.** Reads always use `--after no_reset`. `reset_into_new_image()` is the only reset: it runs the existing read-only `flash_id` verb with `--after hard_reset` (no new tool verb), once, and only after both regions were written, read back and compared equal; a second reset or any later device access is refused, and boot verification before the reset is `NOT_PROVEN`. Sequence: `flash_id(no_reset)`, arm verifier, write NVS, write firmware, read NVS, compare, read firmware, compare, `flash_id(hard_reset)`, verify signed BOOT STATUS. No extra reboot reaches the L9 hand-off.
- **OD-L8-09 amendment (OWNER APPROVED 2026-10-01).** The evidence bundle is now exactly 12 fields: the original eleven plus `firmware_readback_match` (`PASS`/`FAIL`). Raw firmware bytes, raw NVS bytes and secrets in evidence remain forbidden. This does not change `LIVE_L8` (NOT_AUTHORIZED), the physical-proof status (NOT_PROVEN), Recovery, LVR, D4 policy or secret handling. `verify.sh` now requires `firmware_readback_match=PASS`.
- **Boot verification limit (unchanged).** `BOOT_VERIFICATION_IS_FIRMWARE_REPORTED=YES`: PASS is an authenticated firmware-reported LOCKDOWN. `ELECTRICAL_RELAY_PROOF=NO`.
- **Separate work.** The L8p provisioning-only stage (local branch `feat/idea3-device-provisioning-stage`, commit `f626776c`) is separate, unmerged and untouched here; its planned reuse of this backend is not part of this task.

Session 3 source files changed:

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l8-device.py` — firmware readback, `read_region` never resets, `reset_into_new_image()`, 12-field evidence.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L8/verify.sh` — 12-field allowlist and `firmware_readback_match=PASS`.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l8_firmware_readback.py` — new: 21 tests (fake executor only).
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l8_hardware_backend.py`, `test_pr11_phase4_l8_boot_verify.py`, `test_pr11_phase4_l8_handler.py` — expectations moved deliberately to the new sequence, read count and 12-field set.
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-21-idea3-pr11-phase4-l8-operational-design.md` — OD-L8-09 amendment recorded; readback and terminal-reset sequencing documented.

Session 3 verification evidence (all pass; local, `~/.venvs/aegis-idea3-core/bin/python`):

- RED first: `pytest tests/test_pr11_phase4_l8_firmware_readback.py -q -p no:cacheprovider` before the change — fail: 19 failed / 2 passed.
- Negative controls (temporary source breakage, restored byte-identical): reads resetting again, skipped firmware compare, reset without readback, boot verify before reset — each failed the targeted tests; a second-reset-allowed mutation was equivalent because a lower guard also blocks it.
- `pytest tests/test_pr11_phase4_l8_hardware_backend.py` — pass: 80 passed. `pytest tests/test_pr11_phase4_l8_boot_verify.py` — pass: 69 passed. `pytest tests/test_pr11_phase4_l8_handler.py` — pass: 77 passed. `pytest tests/test_pr11_phase4_l8_firmware_readback.py` — pass: 21 passed.
- `pytest tests/test_pr11_phase4_l7_*.py tests/test_pr11_phase4_l7u_*.py` — pass: 893 passed. `pytest tests/test_pr11_phase4_l9_handler.py` — pass: 154 passed. `pytest tests/test_pr11_phase4_nvs_provision.py tests/test_firmware_contract.py tests/test_firmware_protocol_parity.py` — pass: 30 passed. Protocol tests (`tests/test_protocol_*.py` six modules) — pass: 149 passed.
- `pytest tests/test_pr11_phase4_*.py` — pass: 3437 passed, 2 skipped, 0 failed (1425 s), run after all source changes; the later closeout touched documentation only.
- `bash -n` on the L8 handlers, `python -m py_compile` on `p4-l8-device.py` and `p4-l8-boot-verify.py`, `git diff --check`, `node scripts/validate-vault.mjs` (2 existing canvas warnings) — pass. Changed-content secret scan — no hits.

Session 3 limitations: still nothing was run against real hardware, a real serial port, a real broker or network; the esptool output format is asserted from documented behavior and fakes. Live execution needs a future owner authorization (the same-day A-L8 gate, D4 live, OV-12 values). The signed BOOT STATUS is not independent electrical relay proof. The remote PR branch is unchanged and 189 commits behind main until the owner chooses how to update PR #247.
