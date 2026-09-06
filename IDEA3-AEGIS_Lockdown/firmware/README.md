# AEGIS Lockdown · Firmware

**Target: ESP32 + Relay. Firmware source migrated from the verified IDEA3 standalone core.**

Physical lockdown actuator. Receives commands over the network and drives a relay.

## Security model
- **Transport:** MQTT.
- **Authenticity:** every command is signed with **HMAC-SHA256** — the device rejects any
  message whose MAC does not verify against the shared key.
- **Replay protection:** each command carries a **nonce** (single-use); the device refuses a
  nonce it has already seen.
- **Dead Man's Switch:** if the device stops receiving valid heartbeats within the timeout, it
  fails to its **safe state** on its own — no command needed to trigger the safe outcome.

`src/main.cpp` preserves timestamp validation, nonce replay protection, HMAC verification,
ACK/status publication, secure boot grace, explicit RESTORE handling, and the Dead Man's
Switch. `src/secrets.h` is deliberately absent and ignored; create it locally from
`src/secrets.h.example` without committing its values.

## Do NOT put here
- Camera / detection logic → **IDEA 2 (AEGIS Monitor)**.
- Dashboard / Web UI → `../web/`; the browser never talks to this firmware directly.
