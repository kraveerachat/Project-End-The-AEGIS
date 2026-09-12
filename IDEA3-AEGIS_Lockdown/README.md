# AEGIS IDEA 3 — Cyber-Physical Lockdown

> **Current state (updated 2026-09-13):** IDEA3 PR10, the real deployment baseline, is **IN PROGRESS**. `main` is at `d903327e56a744de3a535f105797a53f0dccebaf`, the GitHub PR #123 merge.
> **PR10 S1:** PASS / CLOSED (GitHub PR #122 at `b2f61ebf`). **PR10 S2:** PASS / CLOSED — the repository-only Server → Core accepted-action boundary, merged through GitHub PR #123 at `d903327e`. Its evidence is LOCAL / SIMULATED only; dispatch is disabled by default and nothing is deployed.
> **PR9:** MERGED (GitHub PR #115 at `2c21cc3e`). It is a historical, completed repository phase; its `PRODUCTION_LIKE_VERIFIED` result is local loopback/dry-run evidence only.
> **Next:** PR11 (live cross-IDEA and authorized E2E) is **NOT STARTED / NEXT**. Its first step is the Phase 0 read-only dependency/preflight gate, and only on the owner's instruction.
> **PR5 gate:** SATISFIED — GitHub PR #117 merged at `58f19f2051170685757627a6baea90b264a877c4`; owner lab evidence is accepted for RJ45 continuity, powered reset-window behavior, and real Ethernet CUT/RESTORE
> **Safety boundary:** `PRODUCTION_CHANGE_AUTHORIZED = NONE`; `PRODUCTION_DEPLOYED = NO`; `IDEA3_PRODUCTION_COMPLETE = NO`. These remain unproven:
> - Production deployment and real Server ↔ Core mTLS;
> - real MQTT TLS and ESP32 signed-evidence E2E;
> - a real CUT through the new Server → Core path;
> - real Telegram delivery;
> - total-control-power-loss fail-secure behavior;
> - final relay-cycle Twingate auto-recovery;
> - deployment-grade prototype mechanics.
>
> **Authoritative status:** `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md`. The dated sections below are historical evidence, recorded as observed at the time.

AEGIS IDEA 3 เป็นระบบ **Cyber-Physical Active Defense** สำหรับตรวจจับภัยคุกคามทางไซเบอร์และตอบโต้ด้วยการตัด Uplink ทางกายภาพผ่าน ESP32 + Relay โดยออกแบบให้ทำงานร่วมกับ AEGIS IDEA 1 และ IDEA 2 ใน Production Integration Phase

```text
Attack / Suspicious Activity
        ↓
Attack Detector
        ↓
MQTT attacker_ip
        ↓
SOC Command Center
        ↓
HMAC + Nonce + Timestamp
        ↓
CUT_UPLINK
        ↓
ESP32 + Relay
        ↓
Physical Lockdown
        ↓
ACK / Audit / Alert
        ↓
Explicit Recovery
```

---

## Current Status

ฟังก์ชันหลักที่ยืนยันจาก source และ automated tests ใน shared-repository track นี้:

- HMAC-SHA256 command authentication
- Nonce Anti-Replay
- Timestamp Window 30 วินาที
- MQTT username/password authentication
- ESP32 firmware contract สำหรับ HMAC, nonce, timestamp, ACK nonce และ correlated STATUS
- Dead Man's Switch 60 วินาที
- Secure Boot Grace Period 90 วินาที
- Explicit Recovery — Heartbeat กลับมาแล้วไม่ Auto-Unlock
- SSH Brute-force Detection
- Port Scan Detection
- SYN Flood / High-rate TCP Detection
- Detector event → Core `issue_command()` พร้อม operational DISARM guard และ dry-run/mocked verification
- Telegram Control / Alert
- Incident Recovery Workflow
- Software Response Latency instrumentation
- Tamper-Evident Audit Hash Chain
- Concurrent Audit Writer race-condition protection
- Runtime validation ของ Active Audit Ledger

หลักฐานฮาร์ดแวร์ที่ owner ยืนยันสำหรับ project-sequence PR5:

- RJ45 cable-tester: RESTORE `1 2 3 4 5 6 7 8` → CUT `1 _ 3 4 5 6 7 8` → RESTORE `1 2 3 4 5 6 7 8`
- Powered EN/reset window: Pin 2 remained absent through hold, reboot, and reconnect; only explicit RESTORE returned Pin 2
- Real Ethernet: ping and SSH worked in RESTORE, failed/froze in CUT, and a new SSH connection succeeded after RESTORE
- Direct-LAN Twingate baseline and connector health after one manual restart passed

สิ่งที่ยังไม่ถือว่าเสร็จใน evidence boundary ปัจจุบัน:

- total-control-power-loss fail-secure behavior; loss of relay power may mechanically reconnect NC
- final relay CUT → RESTORE Twingate automatic recovery without manual restart
- deployment-grade strain relief and secure PCB/interconnect for the breadboard prototype
- Production VLAN Integration
- IDEA 1 / IDEA 2 Integration
- Production MQTT TLS
- systemd/watchdog deployment acceptance
- overall IDEA3 production acceptance

---

## Project-sequence PR5 Final Hardware Closure — owner evidence accepted (2026-09-11)

The firmware semantic contract remains unchanged:

```text
GPIO27 LOW  = LOCKDOWN / CUT
GPIO27 HIGH = NORMAL / RESTORE
```

The accepted external circuit uses a 10 kΩ GPIO27 pull-down, ULN2003 IN1,
ULN2003 OUT1 (continuity-verified as chip pin 16), and a 10 kΩ pull-up on the
relay-input node. The relay is configured for high-level trigger. Ethernet Pin
2 passes through COM and NC; NO is unused.

```text
LOW  → ULN OFF → relay input pulled HIGH → relay active → COM-NC open → Pin 2 CUT
HIGH → ULN ON  → relay input sunk LOW    → relay released → COM-NC closed → Pin 2 restored
```

Observed LEDs: RESTORE/NORMAL has red power ON and green trigger OFF;
CUT/LOCKDOWN has red power ON and green trigger ON.

```text
PHYSICAL_LOCKDOWN_PIN2=PASS
PHYSICAL_RESTORE_PIN2=PASS
RESET_WINDOW_1B=PASS
RECONNECT_DOES_NOT_AUTO_RESTORE=PASS
EXPLICIT_RESTORE_REQUIRED=PASS
REAL_ETHERNET_RESTORE_BASELINE=PASS
REAL_ETHERNET_CUT=PASS
REAL_ETHERNET_RESTORE_RECOVERY=PASS
SSH_CUT_EFFECT=PASS
SSH_POST_RESTORE_RECONNECT=PASS
TWINGATE_DIRECT_BASELINE=PASS
TWINGATE_CONNECTOR_HEALTH_AFTER_MANUAL_RESTART=PASS
TWINGATE_FINAL_RELAY_CYCLE_AUTO_RECOVERY=NOT CLAIMED / NOT CONCLUSIVELY VERIFIED
```

`RESET_WINDOW_1B=PASS` applies only while the relay/control circuit remains
powered. Total-control-power-loss fail-secure behavior is not proven; the
relay's mechanical NC path may reconnect if relay power is lost. Breadboard,
ESP32, and jumper movement caused intermittent bring-up behavior before the
final sequence passed after reseating and stabilization, so strain relief and a
secure PCB/interconnect remain deployment requirements.

The old severed SSH session freezing during CUT is evidence of interruption,
not a valid RESTORE criterion. Recovery was accepted only after ping resumed
and a new SSH session succeeded. Cable-tester continuity alone is not treated
as Ethernet traffic proof.

No firmware, source, configuration, dependency, flash, reset, command, or
hardware mutation is performed by this documentation PR. GitHub PR #115 stays
blocked until this PR5 GitHub PR is merged. IDEA3 is not production-complete.

---

## PR4 Headless Core / Command & Physical Evidence — 2026-09-06

หัวข้อที่ปิดด้วย source inspection และ automated regression:

- Core เป็นเจ้าของ operational mode `ARMED` / `DISARMED`; `DISARMED` ปิดกั้น automatic containment โดยไม่ปิดการรับและ audit detector event
- `AegisSupervisor.issue_command()` เป็น entry point ของ command lifecycle และเก็บ pending action, timestamp และ nonce สำหรับทั้ง manual/Core และ automatic containment
- ACK จาก firmware echo command nonce; ACK ที่ไม่มี nonce หรือ nonce ไม่ตรงถูก ignore แบบ fail-closed
- `ACK != physical evidence`: CUT คาด `LOCKDOWN`, RESTORE คาด `NORMAL`, state ตรงข้ามไม่ confirm
- รองรับทั้ง `ACK → STATUS` และ `STATUS → ACK` โดยไม่ทับหลักฐานที่มาก่อน
- ACK timeout แยกจาก physical-confirmation timeout (`8` วินาที); RESTORE timeout ไม่ซ่อน physical truth ที่ยังเป็น `LOCKDOWN`
- late matching physical evidence ถูกยอมรับ แต่ `physical_timeout_at` เดิมยังคงเป็น history
- Task 2D6 implemented: command-triggered STATUS ใส่ `command_nonce`; Boot/Heartbeat/Deadman/Secure Boot STATUS ไม่ใส่ และ Core ยอมให้ STATUS ทุกตัวอัปเดต device/uplink truth แต่เปลี่ยน active command lifecycle เฉพาะ nonce ที่ตรงและ state ที่คาดไว้

Fresh verification จาก `IDEA3-AEGIS_Lockdown/`:

```text
pytest -p no:cacheprovider -q -> 62 passed
ruff check aegis_soc detector.py sim_auto_detector.py tests --no-cache -> All checks passed
python -m compileall -q aegis_soc detector.py server_admin.py sim_auto_detector.py tests -> PASS
platformio run -d firmware -> SUCCESS; RAM 14.2%, Flash 60.2%
git diff --check -> PASS
```

PlatformIO เป็น compile-only เท่านั้น ผลนี้ไม่พิสูจน์ firmware upload, MQTT E2E,
GPIO/relay actuation หรือการตัด WAN จริง และ protocol-correlated STATUS ยังไม่ใช่
หลักฐานทางไฟฟ้าของ relay

---

## AEGIS Security Center (Web)

Web เป็น operator/control plane หลัก ส่วน Python Supervisor ยังคงทำงาน headless ได้โดยไม่
พึ่ง browser:

```text
Browser → IDEA3 Web API → IDEA3 Core → MQTT → ESP32 → Relay
```

ห้าม browser ต่อ MQTT, ESP32 หรือ GPIO โดยตรง API รุ่นนี้เน้น read-only และจะคืน
`UNKNOWN` เมื่อไม่มีหลักฐานจาก runtime/board จริง คำสั่ง hardware ปิดโดยค่าเริ่มต้นและ
route ทดสอบทำงานผ่าน injected core gateway เท่านั้น ไม่มี raw MQTT implementation ใน Web

รันแบบ local development:

```bash
cd web
npm install
npm run dev:server
npm run dev
```

เปิด `http://127.0.0.1:5176/security/` สำหรับ local Vite development การใช้งาน
production ต้องตั้ง `SESSION_SECRET` ที่ผ่าน production policy และ
`AEGIS_IDEA3_ADMIN_PASSWORD_HASH` เป็น bcrypt cost 12–31 ผ่าน environment; production
จะไม่เปิด development login แม้ตั้ง `AEGIS_ALLOW_DEV_LOGIN=true`

Security Center ใช้ durable SQLite audit repository โดยค่าเริ่มต้นที่
`.aegis-runtime/security-center-audit.sqlite3` และเปลี่ยนได้ด้วย
`AEGIS_IDEA3_AUDIT_DB_PATH` หากเปิดหรือเขียน audit ไม่สำเร็จ ระบบจะ fail closed และไม่คืน
authenticated/action success ปลอม ส่วน session และ durable audit มี lifecycle แยกกัน:
session ไม่ถูกอ้างว่าอยู่รอดข้าม process restart แต่ audit ที่ commit ลง SQLite จะยังอยู่

Adapters ของ IDEA1/IDEA2 เป็น read-only HTTP consumers และปิดเป็น `NOT_CONFIGURED` จนกว่า
owner ของแต่ละระบบจะจัดให้มี sanitized security endpoint ที่ได้รับการ review แล้ว ไม่มีการ
อ่านฐานข้อมูลหรือไฟล์ของอีกระบบโดยตรง

### Demo Mode สำหรับรีวิว UI

ใน environment ที่ไม่ใช่ production ผู้ดูแลสามารถเปิด Demo Mode จากหน้า **การตั้งค่า**
เพื่อดูตัวอย่าง IDEA1 audit, IDEA2 detection, IDEA3 runtime, ESP32 heartbeat/ACK, alerts
และ correlated incident ได้ ข้อมูลตัวอย่างใช้ address ranges สำหรับเอกสารและมีแถบ
`ข้อมูลจำลอง — ไม่ใช่สถานะระบบจริง` แสดงทุกหน้า ค่าเริ่มต้นของแต่ละ session ยังคงปิด
และสามารถปิดความสามารถนี้ใน development ด้วย `AEGIS_DEMO_ALLOWED=false`

Production ปิด Demo Mode แบบบังคับแม้มีการพยายามตั้ง option ให้เปิด และ Demo Mode ไม่เรียก
adapter จริง, MQTT, ESP32, Telegram, command gateway หรือ relay คำสั่ง CUT/RESTORE ยังคง
ปิดตามเดิม

รายละเอียดทั้งหมดดูที่ [`PROGRESS.md`](PROGRESS.md)

---

## Windows Standalone Runtime (PR8)

A one-folder Windows distribution is built from `windows/`: a launcher EXE plus a
pinned Node runtime, the production Express server, and prebuilt React assets.
Writable state (configuration, SQLite audit, logs, runtime status) lives outside
the installed payload under `%LOCALAPPDATA%\AEGIS\IDEA3`, overridable with
`AEGIS_DATA_DIR`.

Operator commands: `configure`, `doctor`, `start`, `status`, `open`, `logs`, `stop`.
Passwords are read from stdin only and stored as a bcrypt cost-12 hash.

Default launch is lab/headless/dry-run with production Web authentication.
Detector, voice, UFW, and the Tk GUI are unavailable in this candidate, and
absent IDEA1/IDEA2 feeds and absent hardware remain `NOT_CONFIGURED`/`UNKNOWN`
rather than reporting healthy.

> `WINDOWS_BUILD_VERIFIED = NO`, `WINDOWS_SMOKE_VERIFIED = NO`. The build and
> smoke scripts have not yet been executed on Windows; Linux source-side tests
> are not acceptance evidence.

See `windows/README.md` for layout, build, smoke, backup, upgrade, and rollback.

## Server Production Runtime (PR9)

`python -m aegis_soc.production_runtime start` owns Python Core and the
Node/Express Security Center as one foreground service. It validates an immutable
payload plus an absolute external `AEGIS_DATA_DIR`, starts Core before Web, stops
Web before Core, fails and cleans the peer when either child exits, and never
sends RESTORE during lifecycle operations. `status`, `stop`, `restart`, and
`doctor` are also available; stop is idempotent and duplicate start is rejected.

The Web endpoints `/security/api/health` and `/security/api/readiness` are
deliberately different: health is process liveness, while readiness requires a
successful schema-v2 audit probe. The service status keeps process, audit, MQTT,
IDEA1, IDEA2, ESP32, and physical evidence states separate.

The hardened unit is an uninstalled example at
[`deploy/aegis-idea3.service.example`](deploy/aegis-idea3.service.example). See
[`docs/operations/production-runtime.md`](docs/operations/production-runtime.md)
for the external layout, configuration, lifecycle, diagnosis, backup/restore,
upgrade, rollback, and secret-rotation procedure. This PR9 phase does not deploy
the unit or access Production/hardware.

## Architecture

องค์ประกอบหลัก:

```text
┌───────────────────────┐
│ Attack Detector       │
│ detector.py           │
└──────────┬────────────┘
           │ aegis/attacker_ip
           ▼
┌───────────────────────┐
│ MQTT Broker           │
│ Mosquitto             │
└──────────┬────────────┘
           │
           ▼
┌───────────────────────┐
│ SOC Command Center    │
│ Python / Tkinter      │
└──────────┬────────────┘
           │ Secure MQTT Command
           ▼
┌───────────────────────┐
│ ESP32                 │
│ HMAC verification     │
│ Dead Man / Boot Grace │
└──────────┬────────────┘
           │ GPIO 27
           ▼
┌───────────────────────┐
│ Relay                 │
│ Physical Lockdown     │
└───────────────────────┘
```

---

## Repository Structure

```text
AEGIS_IDEA3/
├── server_admin.py
├── aegisctl
├── detector.py
├── sim_auto_detector.py
├── PROGRESS.md
├── README.md
├── pytest.ini
├── ruff.toml
├── platformio.ini
│
├── aegis_soc/
│   ├── __init__.py
│   ├── config.py
│   ├── security.py
│   ├── controller.py
│   ├── mqtt_client.py
│   ├── runtime.py
│   ├── supervisor.py
│   ├── cli.py
│   ├── database.py
│   ├── comms.py
│   ├── telegram_control.py
│   ├── gui.py
│   ├── wizard.py
│   └── theme.py
│
├── src/
│   ├── main.cpp
│   ├── secrets.h.example
│   └── secrets.h          # local secret — DO NOT COMMIT
│
└── tests/
    ├── test_core.py
    └── test_detector.py
```

---

## Core MQTT Contract

| Topic | Direction | Purpose |
|---|---|---|
| `aegis/lockdown/cmd` | SOC → ESP32 | Secure CUT / RESTORE command |
| `aegis/lockdown/ack` | ESP32 → SOC | Command acknowledgement |
| `aegis/heartbeat` | SOC → ESP32 | Liveness heartbeat |
| `aegis/status` | ESP32 → SOC | Device / lockdown status |
| `aegis/attacker_ip` | Detector → SOC | Detected attacker IP |

Production Integration ควรรักษา MQTT contract ชุดนี้ไว้เพื่อให้ IDEA 2 สามารถส่ง attacker event เข้า IDEA 3 ได้โดยไม่ต้องเปลี่ยน SOC logic หลัก

---

## Security Model

### Secure Command

คำสั่งที่ส่งไป ESP32 ประกอบด้วย:

```text
action
nonce
timestamp
HMAC-SHA256 signature
```

ESP32 ตรวจตามลำดับ:

```text
JSON
 ↓
Timestamp
 ↓
Nonce
 ↓
HMAC
 ↓
Execute
 ↓
ACK
```

ค่าปัจจุบัน:

```text
MAX_COMMAND_AGE_SEC = 30
NONCE_HISTORY_SIZE  = 20
```

---

## Dead Man's Switch

SOC ส่ง Heartbeat ให้ ESP32 อย่างต่อเนื่อง

```text
Heartbeat received
      ↓
lastHeartbeatMs updated
      ↓
Heartbeat missing > 60s
      ↓
LOCKDOWN
```

ค่า:

```text
DEADMAN_TIMEOUT_MS = 60000
```

MQTT reconnect ฝั่ง ESP32 เป็น non-blocking เพื่อให้ `checkDeadman()` ยังทำงานได้แม้ Broker หลุด

---

## Secure Boot Grace Period

ตั้งแต่ `v1.4-secure-boot`:

```text
ESP32 Boot
    ↓
รอ Heartbeat สูงสุด 90s
    ↓
Heartbeat มา?
 ┌─────────────┐
 YES           NO
 ↓              ↓
NORMAL      LOCKDOWN
```

ค่า:

```text
BOOT_GRACE_MS = 90000
```

Hardware validation:

```text
Heartbeat within Grace Period → PASS
No Heartbeat > 90s            → LOCKDOWN PASS
LED RED                        → PASS
Relay Actuation                → PASS
```

---

## Explicit Recovery

ระบบไม่ปลด Lockdown อัตโนมัติเพียงเพราะ Heartbeat กลับมา

```text
LOCKDOWN
   ↓
Heartbeat returns
   ↓
still LOCKDOWN
   ↓
RESTORE_UPLINK required
   ↓
NORMAL
```

ช่วยป้องกันการกลับ Online โดยไม่มีการยืนยันจากผู้ดูแลหลังเกิดเหตุ

---

## Attack Detector

ไฟล์หลัก:

```text
detector.py
```

### SSH Brute-force

```text
Threshold = 5 failed logins
Window    = 30 seconds
```

### Port Scan

```text
Threshold = 10 unique ports
Window    = 10 seconds
```

Input ใช้ log prefix:

```text
AEGIS_NEWCONN
```

### SYN Flood / High-rate TCP

```text
Threshold = 20 events
Window    = 2 seconds
```

มี automated tests สำหรับทั้ง below-threshold และ trigger-threshold

---

## Automatic Lockdown Flow

```text
Detector detects attacker
        ↓
report_attacker(ip)
        ↓
publish aegis/attacker_ip
        ↓
SOC receives attacker IP
        ↓
ตรวจว่า ARMED
        ↓
send CUT_UPLINK
        ↓
ESP32 validates command
        ↓
Relay Lockdown
        ↓
ACK
```

---

## SOC Command Center

รันผ่าน:

```bash
python3 server_admin.py
```

ฟีเจอร์หลัก:

- ARM / DISARM
- CUT / RESTORE
- Admin PIN
- MQTT Connection State
- ESP32 Liveness
- RSSI / Heap
- Dead Man Countdown
- ACK Tracking
- Incident Lifecycle
- Audit Log
- CSV Export
- UFW Response
- Recovery Wizard
- Telegram
- Attacker IP integration
- Software latency measurement

---

## Telegram

รองรับ:

```text
/status
/cut <PIN>
/restore <PIN>
```

Security:

```text
chat_id
  +
PIN
  +
rate limiting
```

---

## Software Response Latency

ตั้งแต่ `v1.3-ms-latency` ระบบวัดช่วง:

```text
Detector publish attacker_ip
        ↓
MQTT
        ↓
SOC receives event
        ↓
SOC issues CUT_UPLINK
```

ผล runtime 5 รอบ:

```text
1 ms
1 ms
1 ms
2 ms
2 ms
```

สรุป:

```text
Minimum = 1 ms
Maximum = 2 ms
Mean    = 1.4 ms
Median  = 1 ms
```

> **สำคัญ:** ตัวเลขนี้คือ **Software Response Latency** ไม่ใช่ Physical Relay Switching Latency

---

## Tamper-Evident Audit Log

Audit Log ใช้ SHA-256 Hash Chain:

```text
GENESIS
   ↓
Row 1 Hash
   ↓
Row 2 Hash
   ↓
Row 3 Hash
```

Hash คำนวณจาก:

```text
timestamp
level
event_type
details
previous_hash
```

ตรวจด้วย:

```bash
python3 -c "from aegis_soc import database as db; print(db.verify_chain())"
```

---

## Audit Concurrent-Write Race Fix

ระหว่าง Standalone Closure พบ Historical Ledger มี duplicate hash ที่ `DEVICE_STATUS`

Root Cause:

```text
Concurrent writers
→ อ่าน previous hash เดียวกัน
→ คำนวณ next hash จาก parent เดียวกัน
→ เกิด duplicate hash / broken chain
```

ตั้งแต่ `v1.5-audit-race-fix` แก้ด้วย:

```text
threading.Lock
+
SQLite BEGIN IMMEDIATE
```

ทำให้ขั้นตอน:

```text
read previous hash
→ compute
→ insert
→ commit
```

อยู่ใน serialized transaction

เพิ่ม regression test:

```text
test_concurrent_audit_logging_preserves_hash_chain
```

ผล:

```text
14/14 tests PASS
```

Historical DB ถูกเก็บเป็น Evidence โดย **ไม่ rewrite/re-hash ย้อนหลัง**

Active Ledger ใหม่หลัง fix ผ่าน runtime validation:

```text
verify_chain()          = PASS
duplicate hash groups   = 0
DEVICE_STATUS runtime   = PASS
```

---

## Incident Recovery

Lifecycle:

```text
OPEN
 ↓
CONTAINED
 ↓
CLOSED
```

Recovery Wizard:

```text
1. Out-of-band Access
2. Block Attacker IP
3. Restore Physical Uplink
4. Reopen Services
5. Lessons Learned / Close Incident
```

---

## Hardware

ESP32 GPIO:

```text
Relay       GPIO 27
Green LED   GPIO 32
Red LED     GPIO 33
```

Relay logic:

```text
RELAY_RELEASE = HIGH
RELAY_TRIGGER = LOW
```

Firmware build ล่าสุด:

```text
RAM   14.2%  (46572 / 327680 bytes)
Flash 60.2%  (788913 / 1310720 bytes)
```

---

## Requirements

Python environment ต้องมีอย่างน้อย:

```text
paho-mqtt
pytest
ruff
```

PlatformIO ใช้สำหรับ ESP32 firmware

Dependencies หลักของ firmware:

```text
PubSubClient
ArduinoJson
WiFi
```

---

## Configuration

### SOC `.env`

สร้าง `.env` ใน project root

ตัวอย่าง:

```dotenv
AEGIS_BROKER_IP=127.0.0.1
AEGIS_BROKER_PORT=1883

AEGIS_MQTT_USER=aegis
AEGIS_MQTT_PASS=<mqtt-password>

AEGIS_HMAC_SECRET=<shared-hmac-secret>
AEGIS_ADMIN_PIN=<admin-pin>

AEGIS_TG_TOKEN=<telegram-token>
AEGIS_TG_CHAT=<telegram-chat-id>
```

> `.env` เป็น Secret และต้องไม่ Commit

### ESP32 Secrets

ใช้:

```text
src/secrets.h
```

โดยอ้างอิง template:

```text
src/secrets.h.example
```

Secret หลัก:

```text
SECRET_WIFI_SSID
SECRET_WIFI_PASSWORD
SECRET_HMAC_KEY
SECRET_MQTT_USER
SECRET_MQTT_PASS
```

> `src/secrets.h` ต้องไม่ Commit

---

## Autonomous Runtime

The new supervisor provides one-command lifecycle management without bypassing
the existing HMAC, nonce, timestamp, MQTT, ACK, or audit path:

```bash
./aegisctl doctor --profile development --dry-run --headless --no-detector
./aegisctl start --profile development --dry-run --headless --no-detector
./aegisctl status
./aegisctl logs --structured
./aegisctl stop
```

Additional lifecycle commands:

```bash
./aegisctl restart --profile lab --dry-run
./aegisctl test
```

Profiles:

| Profile | Default behavior |
|---|---|
| `development` | dry-run, headless, detector off |
| `lab` | dry-run, GUI and detector requested |
| `production` | live, headless, detector requested; rejects blank/demo HMAC and blank/default Admin PIN |

Important safety behavior:

- `AEGIS_AUTO_CONTAIN=0` is the conservative default. Detector events are logged but do not CUT automatically.
- `AEGIS_DRY_RUN=1` makes relay commands log `WOULD_SEND` and never publish to MQTT.
- Device and uplink state begin as `UNKNOWN`; the runtime does not claim NORMAL before device evidence.
- MQTT/device loss transitions through wait/degraded states without auto-restoring or exiting immediately.
- `RESTORE_UPLINK` requires an explicit recovery-authorized controller call.
- Startup, restart, and shutdown never send `RESTORE_UPLINK`.
- Duplicate supervisors are rejected with a process lock; child crashes use bounded backoff and can become `FAILED` while the supervisor remains alive.

Configuration keys are documented in [`.env.example`](.env.example). Voice is
independently selectable, but preflight currently rejects `--voice` because this
repository has no executable voice adapter yet. The server service example at
[`deploy/aegis-idea3.service.example`](deploy/aegis-idea3.service.example) owns
both Core and Web; review its installation paths and permissions before enabling
it.

The supervisor writes rotating structured events to `logs/aegis-events.jsonl`,
combined child output to `logs/aegis-components.log`, daemon console output to
`logs/aegis-supervisor.log`, and atomic lifecycle status under `.aegis-runtime/`.
These runtime artifacts are ignored by Git.

## Quick Start — Standalone/Lab (Legacy Manual Flow)

### 1. เข้า Project

```bash
cd "/path/to/AEGIS_IDEA3"
```

### 2. เปิด Python environment

```bash
source venv/bin/activate
```

### 3. Start Mosquitto

```bash
sudo systemctl start mosquitto
```

### 4. Start SOC

```bash
python3 server_admin.py
```

จากนั้นกด:

```text
ARM
```

ก่อนทดสอบ Automatic Response

### 5. Start Detector

```bash
sudo python3 detector.py
```

### 6. ESP32

Build:

```bash
pio run
```

Upload:

```bash
pio run -t upload
```

Serial Monitor:

```bash
pio device monitor -b 115200
```

---

## Validation

ก่อน Push ทุกครั้ง:

```bash
pytest -v
ruff check .
pio run
git diff --check
git status
```

Historical standalone baseline (archival; current PR4 evidence is at the top of
this file):

```text
pytest      14/14 PASS
ruff        PASS
pio run     SUCCESS
```

---

## Git Safety

Secret files:

```text
.env
src/secrets.h
```

ต้องไม่ถูก Track

ตรวจ:

```bash
git status
git ls-files .env src/secrets.h
```

ก่อน commit ใช้ explicit staging:

```bash
git add <specific-files>
```

หลีกเลี่ยงการ stage secret หรือ runtime evidence โดยไม่ตรวจสอบก่อน

---

## Historical Standalone Git Milestones

```text
v1.0-standalone
v1.1-pentested
v1.2-syn-flood
v1.3-ms-latency
v1.4-secure-boot
v1.5-audit-race-fix
```

Historical standalone baseline:

```text
main = a6d5630
tag  = v1.5-audit-race-fix
```

---

## Production Integration Plan

Standalone/Lab กับ Production ต้องแยกสถานะกัน

Production Architecture:

```text
VLAN 10 = Server Zone
VLAN 20 = Detector Zone
VLAN 30 = Management Zone
```

งาน Production ที่ยังเหลือ:

- Production MQTT Broker / address validation
- ESP32 network migration
- IDEA 2 → `aegis/attacker_ip`
- IDEA 1 UFW integration
- Physical WAN Relay
- MQTT TLS
- systemd / watchdog
- Dead Man timeout tuning
- Production Cyber-Physical E2E

---

## IDEA 1 / IDEA 2 Integration Contract

### IDEA 2

IDEA 2 ทำหน้าที่ Detection:

```text
IDEA 2
   ↓
detected attacker
   ↓
publish attacker IP
   ↓
aegis/attacker_ip
   ↓
IDEA 3
```

### IDEA 1

IDEA 3 ปกป้อง NAS/Data Layer ของ IDEA 1

Production response:

```text
IDEA 3
   ↓
Physical WAN isolation
   +
UFW threat response
```

Management/LAN recovery path ต้องยังอยู่หลัง Lockdown

---

## Remaining Standalone Work

งาน Standalone ที่ยังเหลือ:

### Power Measurement

รอ USB Power Meter

ต้องวัด:

```text
NORMAL
- Voltage
- Current
- Power

LOCKDOWN
- Voltage
- Current
- Power
```

คำนวณ:

```text
Wh/day = Power (W) × 24
```

> ห้ามใช้ค่าประมาณเป็นผลการทดลองจริง

---

## Historical Standalone Result — archival, not PR4 evidence

ตารางนี้คงไว้เป็นประวัติที่เคยบันทึกใน `v1.5-audit-race-fix` เท่านั้น ไม่ได้ rerun
บน hardware ใน PR4 และห้ามใช้ยืนยัน relay/WAN/production ปัจจุบัน:

```text
Core Protocol Security         PASS
ESP32 Firmware                 HISTORICAL / NOT RERUN IN PR4
Physical Relay Control         HISTORICAL / NOT PROVEN BY PR4
Dead Man's Switch              HISTORICAL / NOT RERUN IN PR4
Explicit Recovery              SOURCE-TESTED; HARDWARE NOT RERUN
Secure Boot Grace Period       HISTORICAL / NOT RERUN IN PR4
SSH Brute-force Detector       PASS
Port Scan Detector             PASS
SYN Flood Detector             PASS
Automatic Lockdown             SOURCE-TESTED; HARDWARE NOT RERUN
MQTT Standalone                HISTORICAL / LIVE E2E NOT RERUN
Telegram Control/Alert         PASS
Incident / Recovery            PASS
Software Response Latency      PASS
Tamper-Evident Audit Fix       PASS
Audit Concurrency Regression   PASS
New Ledger Runtime Integrity   PASS
Automated Tests                HISTORICAL 14/14; PR4 CURRENT 62/62
Ruff                           PASS
Firmware Build                 PR4 COMPILE-ONLY PASS

Power Measurement              PENDING
Production Integration         PENDING
```

---

## Next Steps

```text
USB Power Meter arrives
        ↓
Power Measurement
        ↓
Standalone Documentation Closure
        ↓
Production Integration Readiness
        ↓
MQTT / VLAN Integration
        ↓
IDEA 2 Integration
        ↓
IDEA 1 / UFW Integration
        ↓
Physical WAN Relay
        ↓
MQTT TLS / systemd / watchdog
        ↓
Production Cyber-Physical E2E
```

---

## Safety / Scope

ระบบและเครื่องมือทดสอบของโครงการนี้มีไว้สำหรับ **เครื่องและเครือข่าย Lab ที่ได้รับอนุญาตเท่านั้น**

การทดสอบ Kali / Detector / Network Security ต้องดำเนินการเฉพาะในสภาพแวดล้อมที่ทีมเป็นเจ้าของหรือได้รับอนุญาตให้ทดสอบ

---

## Documentation

เอกสารสถานะละเอียด:

```text
PROGRESS.md
```

Source-of-truth สำหรับสถานะปัจจุบันควรยึด:

1. Current `main`
2. Current milestone tag
3. Automated tests
4. Hardware/runtime evidence
5. `PROGRESS.md`

หากเอกสารเก่าขัดกับผลทดสอบล่าสุด ให้ถือเอกสารเก่าเป็น Historical Context และใช้ Current Verified State เป็นหลัก
