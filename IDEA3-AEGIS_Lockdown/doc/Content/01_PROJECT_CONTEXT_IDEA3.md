# AEGIS IDEA3 — Compact Project Context

## Project role
AEGIS IDEA3 is the Cyber-Physical Lockdown component of the larger AEGIS system.

Core concept:

Detection / SOC decision -> authenticated MQTT command -> ESP32 -> relay -> physical WAN containment -> ACK / audit / alert -> explicit recovery.

Design principle: **Contain Before Notify**, with fail-safe behavior and recovery controls.

## Canonical standalone architecture

- Python SOC / command center
- Detection engine
- MQTT communication
- ESP32 firmware
- Relay controlling physical uplink
- Status LEDs
- Audit database / tamper-evident logging
- Telegram alert/control support in historical/current code depending on repository revision

Typical data path:

```text
Detector / Human operator
        |
        v
Command Controller / SOC
        |
HMAC + nonce + timestamp
        |
        v
      MQTT
        |
        v
      ESP32
        |
        v
      Relay
        |
Physical WAN containment
```

## Security controls that have existed in verified IDEA3 work

- HMAC-SHA256 command authentication
- nonce anti-replay
- command timestamp age validation
- ACK tracking
- Dead Man's Switch / heartbeat logic
- secure boot grace behavior
- explicit recovery rather than casual auto-restore
- ARM / DISARM workflow
- Admin PIN for human-sensitive actions
- tamper-evident audit hash chain
- incident / attacker-IP handling

Do not remove or silently weaken these controls.

## Historical standalone milestone
The standalone line reached a `v1.5-audit-race-fix` milestone in prior work, including an audit hash-chain race-condition fix and regression validation. Treat this as historical context; verify the current repo before relying on tag names or test counts.

## Production network integration state reached in prior work
The following production network preparation was completed and documented before the current autonomous-runtime task:

- Beelink production host audited read-only.
- MikroTik hEX lite trunk path identified: MikroTik `ether2` <-> TP-Link Port 1.
- Existing zones preserved:
  - VLAN10 Server
  - VLAN20 IDEA2 / detector zone
  - VLAN30 Management
- Dedicated IDEA3 VLAN40 was created on MikroTik.
- VLAN40 gateway configured as `192.168.40.1/24`.
- VLAN40 DHCP pool configured as `192.168.40.100-192.168.40.199`.
- VLAN40 DNS offered as `192.168.40.1`.
- IDEA3 firewall policy was created with allow-list behavior.
- TP-Link VLAN40 was added tagged on Port 1.
- TP-Link Port 4 was configured as untagged VLAN40 with PVID 40.
- ZTE F6107A was validated standalone as a LAN<->Wi-Fi bridge/AP.
- SSID was configured as `AEGIS-IOT` with WPA2-PSK-AES and SSID isolation off.
- ZTE DHCP was intentionally kept OFF so MikroTik remains the DHCP authority.

Important historical stop point: the physical production step `ZTE LAN1 -> TP-Link Port 4`, DHCP end-to-end validation on VLAN40, ESP32 production onboarding, production MQTT broker `.13`, and WAN relay HIL testing were still pending at the documented checkpoint. Re-check the current repository/docs before assuming this is still the exact stop point.

## Expected production addressing concept

```text
VLAN10 Server       192.168.10.0/24
VLAN20 IDEA2        192.168.20.0/24
VLAN30 Management   192.168.30.0/24
VLAN40 IDEA3 IoT    192.168.40.0/24
```

Historically reserved MQTT production target: `192.168.10.13`.

## IDEA3 VLAN40 security intent

Expected policy concept:

- DHCP/DNS to MikroTik as needed
- MQTT to the dedicated broker only
- NTP as required
- deny general access from IDEA3 to Server/IDEA2/Management zones except explicit rules
- no broad management-plane access from IDEA3

Never change this production policy automatically from a coding task.

## Voice-control prototype context
A separate voice-control prototype was prepared to route Thai/English wake-word commands into the existing IDEA3 command path rather than bypassing security.

Examples:

- `เอจิส อาร์ม`
- `เอจิส ดิสอาร์ม`
- `เอจิส ตัดเน็ต`
- `เอจิส คืนเน็ต`

Voice control is optional and must not become a parallel insecure MQTT implementation.

## Current software objective
The active requested software direction is an **Autonomous Runtime / Supervisor** so IDEA3 can be launched and supervised with one command instead of many terminals.

The target is conceptually:

```text
./aegisctl start --profile production
```

with health monitoring, process supervision, MQTT/device state, optional GUI/voice, detector integration, logging, dry-run tests, and clean shutdown.

Read `02_AUTONOMOUS_RUNTIME_TASK.md` for the implementation requirements.
