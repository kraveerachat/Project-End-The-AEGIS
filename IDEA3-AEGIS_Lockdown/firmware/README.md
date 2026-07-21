# AEGIS Lockdown · Firmware

**Target: ESP32 + Relay. Scaffold only — no code yet.**

Physical lockdown actuator. Receives commands over the network and drives a relay.

## Security model (to implement)
- **Transport:** MQTT.
- **Authenticity:** every command is signed with **HMAC-SHA256** — the device rejects any
  message whose MAC does not verify against the shared key.
- **Replay protection:** each command carries a **nonce** (single-use); the device refuses a
  nonce it has already seen.
- **Dead Man's Switch:** if the device stops receiving valid heartbeats within the timeout, it
  fails to its **safe state** on its own — no command needed to trigger the safe outcome.

## Do NOT put here
- Camera / detection logic → **IDEA 2 (AEGIS Monitor)**.
- Dashboards / web UI → the relevant web app, not the firmware.
