# IDEA3 hardware H0 readiness and local E2E acceptance (2026-10-09)

Evidence class: **H0 = read-only discovery + compile-only build**,
**OFFLINE_FLASH_BACKUP_DIAGNOSTICS**, and **SIMULATED_LOCAL_E2E**
(`tests/test_local_e2e_acceptance.py`). Nothing here is Production,
physical, hardware-actuation or Recovery evidence. The original 2026-10-08
baseline and its test provenance remain historical; this reconciliation is
bound to authoritative merged main `31a68fa222a64c309cb064f32f82ed9faf5d37e0`.

## 0. Owner-reported hardware evidence reconciliation — 2026-10-09

The original 2026-10-08 H0 period deliberately did not open the serial port,
reset the board, read identity, flash, erase, or actuate GPIO. That statement
remains correct for that period; it is not the current owner-observation state.

The owner subsequently reported an ESP32-D0WD-V3 revision 3.1 identity and a
successful MAC read. The MAC address is intentionally not published here, and
the raw identity artifact/hash is not included. This observation identifies
silicon/read activity but does not prove the board is the provisioned AEGIS
device or authorize firmware changes.

The owner also reported a complete read-only ROM/no-stub backup at 115200 baud:

| Check | Result |
|---|---|
| Flash size | `4,194,304` bytes |
| Read mode | ROM / no-stub |
| Baud rate | `115200` |
| SHA-256 verification | PASS |
| Bootloader header | EXPECTED |
| Partition header | EXPECTED |
| Firmware writing | NO |
| Flash erasing | NO |
| Backup restoration tested | NO |

The earlier 460800-baud backup failure remains historical evidence and is not
silently replaced. This is owner-reported hardware evidence, not an independent
hardware run by this documentation task. The raw backup and sensitive identity
material remain outside the repository.

PR #413 is merged into authoritative main by merge commit `f0e4fcfd` (source
commit `7d6e30550b81423400625c03522716969b3402b7`). Its offline validator
consumes owner-declared evidence only and reports
`hardware_behavior_observed=NOT_OBSERVED`; its 198-test owner-host result does
not independently prove backup provenance or restoration. PR #414 is merged by
`31a68fa222a64c309cb064f32f82ed9faf5d37e0` (source commit
`f6b2eac9bd7e4ab289968f4ff151942a62402d64`); its engineering review preserves
F2 **FAIL-OPEN** and F5 **NOT PROVEN**, with no hardware modification or live
test. These are merged source/evidence findings, not hardware acceptance.

Codex 1's companion offline diagnostic is
`IDEA3-AEGIS_Lockdown/docs/operations/idea3-flash-backup-diagnostics.md`, with
validator `deploy/pr11-phase4/flash-backup-diagnostics.py` and focused result
8/8 PASS on synthetic/local evidence. It never opens serial or invokes esptool.
Codex 2's companion review is
`IDEA3-AEGIS_Lockdown/docs/operations/idea3-hardware-f2-f5-fail-secure-review.md`.
It keeps F2 **FAIL-OPEN by design analysis** and F5 **NOT PROVEN as complete
link isolation**.

## 1. Hardware H0 inventory (original 2026-10-08 period; later read-only owner evidence is in §0)

| Item | Observed | What it proves / does not prove |
|---|---|---|
| USB enumeration | `10c4:ea60` Silicon Labs **CP2102** USB-to-UART bridge on bus 3-3 (`CP2102 USB to UART Bridge Controller`) | A CP210x bridge is attached. It does **not** prove an ESP32 is behind it, powered, running, or the provisioned AEGIS device. |
| Serial node | `/dev/ttyUSB0` (`crw-rw---- root:uucp`), `/dev/serial/by-id/usb-Silicon_Labs_CP2102_USB_to_UART_Bridge_Controller_0001-if00-port0` | During the original 2026-10-08 period it was deliberately not opened. A later owner-reported read is recorded in §0. |
| Chip/MAC/flash identity | **Original period NOT READ; later owner observation recorded in §0** | The later ESP32-D0WD-V3 rev 3.1/MAC observation does not publish the MAC, prove provisioning, or authorize a write. |
| Owner-declared flash backup | **OWNER-DECLARED READ-ONLY PASS (validator: `hardware_behavior_observed=NOT_OBSERVED`)** | Owner reported a complete 4 MiB read with SHA-256 and expected bootloader/partition headers; no write or erase. The validator did not observe hardware, and raw dump/restoration evidence are not in the repository. |
| Other USB | a camera, a Bluetooth adapter and two unrelated HID/receiver devices | Not part of the system. |
| Toolchain | PlatformIO core in `~/.platformio`, `espressif32@7.0.1`, `esptool.py v4.11.0` bundled | Compile only. |

## 2. Firmware (`firmware/`, compile-only in a scratch copy; `secrets.h` = the committed placeholder CA, no private material)

`pio run` → SUCCESS (RAM 14.3 %, flash 70.0 %; libraries `PubSubClient@2.8.0`, `ArduinoJson@7.0.4`). sha256 of the artefacts:

| Artefact | Bytes | sha256 |
|---|---:|---|
| `firmware.bin` | 924624 | `d3d244b265febedb4476c27cf1e73fd79c4943048050003428d122b619fce52e` |
| `firmware.elf` | 14339536 | `6988cc555d1c0a91dec18206a2d50e65060738f6f8a6a5d0e1d2848037337114` |
| `partitions.bin` | 3072 | `148b959cbff1c38aa8e1d5c0ba9d612c54997b945e56a63f41223eef650653a1` |
| `bootloader.bin` | 17536 | `3d234a7471f67b013686dabd4dee7c1fa915c9928463616a94bc9297acf1abf8` |

These are **not** the deployed image's digests: the deployed build embeds the dedicated MQTT CA, this one embeds the placeholder. The build proves the source compiles,
not that any flashed device runs it. The native Protocol v1 parity test (`test_firmware_protocol_parity`) passes in the offline acceptance run.

## 3. Pin map, relay logic and failure modes (source: `firmware/src/main.cpp`; circuit: README "Project-sequence PR5 Final Hardware Closure", owner evidence 2026-09-11)

| Signal | GPIO | Rule |
|---|---|---|
| `RELAY_IN` | 27 | `LOW` = LOCKDOWN/CUT (`RELAY_TRIGGER`), `HIGH` = NORMAL (`RELAY_RELEASE`). Driven to `LOW` **before** `pinMode(OUTPUT)` at boot; `isLockedDown` starts `true`. |
| `LED_GREEN` / `LED_RED` | 32 / 33 | Green on = NORMAL, red solid/blinking = LOCKDOWN. |
| Dead-man switch | — | `DEADMAN_TIMEOUT_MS=60000` after the last authenticated heartbeat; `BOOT_GRACE_MS=90000` with no heartbeat. Both drive LOCKDOWN. |

Accepted circuit (owner evidence): 10 kΩ GPIO27 pull-down → ULN2003 IN1 → OUT1 → relay input node with a 10 kΩ pull-up, high-level-trigger relay; Ethernet pin 2 through COM/NC (NO unused).
GPIO LOW → relay energized → COM-NC **open** → CUT. GPIO HIGH → relay released → COM-NC closed → restored.

Failure modes (analysis of the above; **not measured tonight**):

| # | Condition | Result | Assessment |
|---|---|---|---|
| F1 | ESP32 reset / brown-out / firmware crash with the relay supply alive | GPIO27 floats to the 10 kΩ pull-down → LOW → relay stays energized | Fail-secure (CUT held). |
| F2 | **Relay-board / ULN2003 coil supply lost** (shared USB 5 V droop, cable pull, PSU fault) | Coil de-energized → COM-NC **closed** → uplink **restored** | **Fail-OPEN. The firmware dead-man switch cannot help: no software runs without the supply.** Needs a hardware decision (separate/backed-up coil supply, supply-loss sensing, or a different contact arrangement) before any claim that a power fault cannot silently restore the link. |
| F3 | ESP32 loses power, relay supply alive | Pull-down → LOW → CUT held | Fail-secure while the relay supply lives. |
| F4 | Broker/Wi-Fi loss | Heartbeats stop → dead-man LOCKDOWN after 60 s; `RESTORE` still needs an authenticated command | Fail-secure by design (simulated here, see §5). |
| F5 | Only pin 2 of the Ethernet pair is switched | A full link-down is not guaranteed on every PHY/negotiation | Already noted by the owner's SSH/Twingate evidence; re-verify on the lab network. |

## 4. H0 readiness matrix

| Gate | Status | Basis |
|---|---|---|
| USB bridge present | PASS | `lsusb`/sysfs |
| Serial node permissions | PASS (not opened) | group `uucp` |
| ESP32 identity / MAC | OWNER-REPORTED / NOT INDEPENDENTLY VERIFIED | D0WD-V3 rev 3.1 and successful MAC read reported; MAC withheld and raw artifact/hash absent |
| ESP32 flash-size/read backup | OWNER-DECLARED / NOT INDEPENDENTLY OBSERVED | Owner reported 4 MiB no-stub ROM read at 115200; the diagnostic validator checks the declaration and reports `hardware_behavior_observed=NOT_OBSERVED` |
| Flash backup | OWNER-DECLARED READ-ONLY PASS | Owner reported a 4,194,304-byte ROM/no-stub read at 115200; SHA-256 and headers expected; no independent hardware observation |
| Firmware compiles | PASS | `pio run`, digests above |
| Firmware = the deployed image | UNKNOWN | CA placeholder differs; no readback |
| Provisioning state of the board | UNKNOWN | historical L8p PASS is a record, not a current read |
| Pin map / relay logic reviewed | PASS (source) | §3 |
| Relay wiring verified now | BLOCKED | needs the physical bench (§ plan) |
| Relay supply-loss behaviour | **FAIL-OPEN (analysis)** | F2; needs owner decision |
| Isolated lab network | BLOCKED | not established |
| Physical CUT / RESTORE tonight | NOT EXECUTED | by instruction |

Historical hardware evidence (L8p provisioning, 2026-09-11 PR5 closure) is **history**, not current acceptance; L8, L9 and LVR are not executed, and Recovery R2–R8 remains blocked by the immutable CTv `CLOSED_FAIL`.

## 5. Local E2E: the 20 scenarios (`pytest tests/test_local_e2e_acceptance.py`, 29 tests)

Real: production detector, alert ingress, supervisor, controller, Protocol v1, dispatch worker/ledger, `DispatchClient`, the Node web app + machine app over loopback HTTP with a disposable SQLite database, login/session/CSRF.
Simulated: broker (no TLS/ACL), the ESP32/relay (`FirmwareModelDevice`, pinned to `main.cpp`), the HUB mTLS terminator, every attack (synthetic log lines), containment.

| # | Scenario | Result | Test |
|---|---|---|---|
| 1 | Normal authenticated STATUS | PASS (sim) | `test_s01_*` |
| 2–4 | SSH brute-force / port-scan / SYN → alert → incident, no command | PASS (sim) | `test_s02_s04_*` ×3 |
| 5 | Valid authenticated CUT, detector→web→Core→device→ACK/STATUS→web audit | PASS (sim) | `test_s05_s15_s18_*` |
| 6 | Incorrect HMAC | PASS | `test_s06_*` |
| 7 | Stale timestamp | PASS | `test_s07_*` |
| 8 | Replay nonce | PASS | `test_s08_s09_*` |
| 9 | Duplicate/behind sequence, no re-dispatch | PASS | `test_s09_*` |
| 10 | Wrong device identity / forged foreign evidence | PASS | `test_s10_*` |
| 11 | Missing ACK → `OUTCOME_UNKNOWN`, reported to web, never retried | PASS | `test_s11_*` |
| 12 | Signed STATUS contradicting the CUT | PASS (recorded verbatim, never correlated, ends unknown) | `test_s12_*` |
| 13 | Dead-man switch + boot grace | PASS (model) | `test_s13_*` |
| 14 | Fail-secure persistence (reboot → LOCKDOWN, `seq_hi` persists, persist failure) | PASS (model) | `test_s14_*` |
| 15 | CUT requested/acknowledged in simulation | PASS (sim) | scenario 5 |
| 16 | RESTORE refused without authorization | PASS | `test_s16_*` |
| 17 | Explicit simulated RESTORE with **fixture** authorization, one-shot | PASS (sim; fixture credential and fixture containment, no Production authority) | `test_s17_*` |
| 18 | Audit and UI consistency | PASS for the dispatch ladder; **GAP** for incident/device (below) | `test_s18_*`, `test_phase_d_*` |
| 19 | Logout/login, demo isolation | PASS | `test_s19_*` |
| 20 | Recovery blocked under CTv `CLOSED_FAIL` | PASS (the real gate refuses; history byte-identical, no marker) | `test_s20_*` |

## 6. Genuine integration gaps (reported, not papered over)

1. **Web ↔ Core status contract (fixed here).** The Core's `safe_status_projection` (`CONNECTED/ONLINE/NORMAL/LOCKDOWN`, string `armed`, bare issue codes) was not understood by the web normalizer: with a healthy Core every component displayed `UNKNOWN` and `modes.armed` was always false. Fail-safe, but the web could never show a device as online. Fixed in `web/server/domain/normalize.js` (documented values only; relay/heartbeat/ACK stay `UNKNOWN`; canonical values still win) with 5 vitest test blocks (8 cases) and 4 Python→Node tests. A **delivery path** for that document to the web (`AEGIS_IDEA3_RUNTIME_STATUS_URL`) is still not part of the Linux Core deployment; the bridge serves it only in tests.
2. **Web incidents come only from IDEA1/IDEA2 feeds.** The IDEA3 detector's incident exists in the Core; the web snapshot shows `incidents: []`, `devices: []` for it. Only the dispatch ledger (`ACTION_MINTED/CLAIMED/EVIDENCE_RECORDED`) crosses. No live ESP32 device record or Core incident reaches the web.
3. **Physical relay state is never available to the web** (`physicalRelayState` NOT_VERIFIED by design); no sensor exists.
4. **No broker, TLS, ACL or HUB mTLS in this E2E**; those remain covered only by their own unit/contract tests and by historical evidence.
5. **F2 above** (relay supply loss fails open) is a hardware design finding, not a software one.

## 7. What the Demo is (Phase D)

Existing Demo Mode and `demo:local` were exercised on loopback only (599 baseline web tests + the new ones pass). Demo records are session-scoped, labelled simulated, and are never mixed into live audit (`test_s19_*`).
No page can dispatch to Production: the web can mint only `CUT_UPLINK`; `RESTORE` is Core-local (D4).

### Current verification reconciliation

The completed host-offline suite (`test_offline_core_acceptance.py`,
`test_protocol_v1.py`, and `test_local_e2e_acceptance.py`) is recorded as
**199 passed, 10 skipped** in
`/home/kittipat/Workspace/IDEA3-Cyber-Last/h0-implementation-6lOG3I7e/host-offline.log`.
This is offline evidence, not a live hardware, broker, isolated-network,
Production, or Recovery result. Earlier PR413 validator and local-E2E results
remain separately scoped and are not added to this suite total.
