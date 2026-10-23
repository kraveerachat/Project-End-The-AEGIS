# 18 — IDEA3 Live Lab Acceptance Summary (sanitized)

Date of the run: 2026-10-23 (UTC+7), one Linux laptop, one ESP32 controller, one relay module.
Source: GitHub `main` `cc096de89285d3efacf090e28b53ebfa2506d81b` (PR #445), unmodified, plus the commits on
`feat/idea3-graduated-response`: graduated response / control Desktop (`01f247c`) and Telegram delivery fix (`a639337`).
Owner-observed readings are the physical proof; protocol ACKs alone never count. This file contains no secrets, addresses
of private hosts, device identifiers or credentials.

## Firmware

| Item | Value |
|---|---|
| Build | `pio run -e esp32dev` from the same commit, lab CA compiled in from a gitignored `secrets.h` |
| `firmware.bin` sha256 | `6054b965e9539b1d583b0f6a3cca5d122d975a431d856f5673d9b7341f890f8e` (925152 bytes) |
| Layout | bootloader `0x1000`, partitions `0x8000`, `boot_app0` `0xe000`, application `0x10000`, NVS `0x9000` (`0x5000`) |
| Flash | attempt 1 at 115200 after the relay supply was removed; write-time hash verified; verify OK except NVS (runtime additions, namespace `aegis-p1` intact) |

## Gates

| Gate | Result | Time (+07) | Notes |
|---|---|---|---|
| G0 version gate | DONE | 17:09 | the older local project differs from `main`; `main` used, local copy not used |
| G1 tests and firmware build | DONE | 17:15–17:18 | 1059 pass / 4 fail (governance tests unrelated to CUT/RESTORE/protocol, inherited); firmware built |
| G2 lab network | DONE | 18:45 | AP up (ch 1, /28), default route and DNS unchanged, TLS verifies against the lab CA, chrony kernel-synced |
| G3 Core | DONE | 18:47 | transient unit, TLS MQTT connected, credentials passed as systemd credentials |
| G4 backup and flash | DONE | 19:44 | full 4 MB read failed twice; partial backup (`0x0–0x10000`) and previous application image kept; first flash failed until the relay supply was removed and the cable changed |
| G5 device on the lab | DONE | 19:48 | DHCP lease, NTP exchange captured, TLS client connected as the device user; Core: device ONLINE, LOCKDOWN, time SYNCED |
| G6 CUT / RESTORE with physical proof | DONE | 21:11 | see below |
| G7 detector to Core alert | NOT SUPPORTED on `main` | 21:11 | detector uses plaintext MQTT; the Core has no matching ingress on `main` (addressed only by the graduated-response branch, not run live) |
| Telegram | DONE | 21:44 | bot reachable; Core restarted with the settings loaded |
| Phase B control Desktop | PASS | 23:51 | see below |

## G6 physical results (multimeter across the protected conductor, owner-observed)

| Step | Protocol | Reading |
|---|---|---|
| Boot | device ONLINE, LOCKDOWN | open (expected) |
| RESTORE | ACK OK, `STATUS NORMAL` | CLOSED |
| CUT (base Desktop) | ACK 21:04:42, `STATUS LOCKDOWN`, nonce matched | OPEN |
| RESTORE | ACK 21:10:59, `STATUS NORMAL` | CLOSED |

Deviations: the relay module is energized in NORMAL, so the working contact is COM–NO instead of the documented COM–NC
(no firmware change). Early readings on a mis-wired circuit were marked INVALID and repeated on the corrected circuit. A
cable tester through a home-made breakout was inconclusive (suspected short to a neighbouring pin) and is not used as proof.
A `RESTORE_ALREADY_PENDING` block after a controller power cycle was cleared by restarting the Core; no RESTORE was issued
by the restart.

## Phase B: control Desktop and Telegram (2026-10-23 23:12–23:51)

| Time | Event |
|---|---|
| 23:12:23 | CUT from the control Desktop: ACK OK, `STATUS LOCKDOWN`; Telegram LOCKDOWN received |
| 23:13:39 | RESTORE from the control Desktop: ACK OK, `STATUS NORMAL`; meter closed; **Telegram RESTORED not received** (old 3 s delivery limit, tether answered in about 1.7 s) |
| 23:48:34 | Core restarted with the delivery fix (10 s, one retry, secret-free failure reason); graduated flags OFF |
| 23:49:03 | post-restart state report (LOCKDOWN) received |
| 23:49:50 | CUT while already in LOCKDOWN: reported, no transition, no Telegram (expected) |
| 23:51:40 | RESTORE: ACK OK, `STATUS NORMAL`, meter closed, **Telegram RESTORED received** |

No `delivery failed (attempt n/2, ...)` line appeared after the restart. Not recorded: the meter reading after the 23:49:50 CUT
(the device was already open).

## Not covered by this run

- Graduated-response scenarios 1–5 (`16_GRADUATED_RESPONSE.md`): not run on hardware; the feature was OFF during the run.
- Production deployment: none. Existing production and staging stacks were stopped for the run (never disabled) and are not part of
  this evidence.
