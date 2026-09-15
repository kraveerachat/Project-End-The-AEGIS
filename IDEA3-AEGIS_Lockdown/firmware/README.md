# AEGIS Lockdown · Firmware

**Target: ESP32 + Relay. Firmware source migrated from the verified IDEA3 standalone core.**

Physical lockdown actuator. Receives Protocol v1 commands over an isolated
private AP and drives a relay. This repository implementation is compile-verified
only; it has not been flashed or exercised against real hardware.

## Security model
- **Transport:** MQTT 3.1.1 over CA-verified TLS on port 8883, QoS 0, clean
  sessions, and non-retained messages.
- **Authenticity:** independently provisioned 256-bit C2D and D2C keys sign the
  deterministic length-prefixed Protocol v1 fields with HMAC-SHA256.
- **Replay protection:** each command carries a per-device monotonic sequence.
  The accepted sequence is committed to NVS before GPIO actuation; a failed NVS
  write rejects the command without actuation.
- **Trusted time:** only the provisioned Core-local AP NTP endpoint is used.
  Commands and heartbeats stop after the bounded five-minute holdover expires.
- **Dead Man's Switch:** if the device stops receiving valid heartbeats within the timeout, it
  fails to its **safe state** on its own — no command needed to trigger the safe outcome.

`src/main.cpp` fails secure at boot and validates schema, identity, local time,
HMAC, authenticated timestamp, replay state, and durable sequence state before
actuation. Reconnect, restart, time recovery, and heartbeat recovery never issue
RESTORE. `src/secrets.h.example` contains only public CA/NTP placeholders; Wi-Fi,
broker credentials, both HMAC keys, identity, and sequence state are provisioned
into versioned NVS and must never be committed.

## Do NOT put here
- Camera / detection logic → **IDEA 2 (AEGIS Monitor)**.
- Dashboard / Web UI → `../web/`; the browser never talks to this firmware directly.
