# IDEA3 physical bench test plan (ISOLATED LAB ONLY) — NOT AUTHORIZED, NOT EXECUTED

Nothing below may start without a **fresh, explicit owner authorization for each numbered action**, given after the setup in §A is verified. Nothing in the repository executes any step.
Flashing, electrical switching, live MQTT commands and network disruption are four separate actions. Historical CTv/CTu/L8p evidence is never a substitute for any gate here, and none of this touches Recovery.

## A. Preconditions (all must be true and recorded before action 1)

- [ ] A standalone lab network with **no route** to Production, no Production uplink, no shared-user traffic, its own broker/Core instance and its own lab credentials (never the Production CA, keys or `core.env`).
- [ ] The relay and the Ethernet pair under test are **disconnected from every live Ethernet path** during inspection; the "switched link" is a lab patch between two lab hosts only.
- [ ] Low-voltage, **current-limited** bench supply (set the limit to the relay + ESP32 need with margin); a manual power disconnect within reach; an out-of-band way to regain the lab hosts (console/second NIC), not through the switched link.
- [ ] Wiring checked **unpowered** with a meter against the README circuit: GPIO27 ↔ 10 kΩ pull-down ↔ ULN2003 IN1; OUT1 ↔ relay input node with 10 kΩ pull-up; relay high-level trigger; COM/NC wired to Ethernet pin 2, NO unused; common ground; flyback/diode path present; contact rating well above the lab load.
- [ ] A written, rehearsed rollback: how to return the relay to the connected state by hand (power off the coil = COM-NC closed) and how to reflash a known-good image.
- [ ] Owner decision recorded on **F2** (relay supply loss fails open) and on whether the lab must demonstrate it.
- [ ] A lab-only provisioning bundle (device id, Wi-Fi, broker, `k_c2d`/`k_d2c`, CA) generated for this bench; kept out of the repository, logs and screenshots.

## B. Actions, each separately authorized (record who, when, and the evidence file hashes)

1. **Passive inspection (no power to the ESP32).** Photograph/inventory the board; meter continuity per §A; compare the printed chip marking with an ESP32-WROOM module. *Pass:* wiring equals the circuit; no shorts.
2. **Power-only, relay board disconnected from the contact load.** Confirm LED states: boot = red on (LOCKDOWN), green off. *Pass:* matches `setup()`.
3. **Serial identity read (first time the port is opened).** Open the lab port read-only at 115200 with DTR/RTS low (`monitor_dtr=0`, `monitor_rts=0`); record chip, MAC, flash size, boot log. No reset line toggling beyond what the board does at power-on. *Pass:* identity recorded, no secret in the log.
4. **Flash a known-good, compiled image to the LAB board only** (digests in the H0 document), then verify by readback. Separately authorized from step 3. *Pass:* readback digest equals the built image.
5. **Provision the lab NVS** (lab credentials only) through the repository's reviewed provisioning flow. *Pass:* schema 1, no secret printed.
6. **Heartbeat/dead-man bench.** Lab broker + Core on the lab network; send authenticated heartbeats; stop them; time the lockdown (expect ≈60 s) and the boot grace (≈90 s). *Pass:* relay energizes at the expected time; STATUS `DEADMAN` arrives and is authenticated.
7. **CUT on the bench contact (live MQTT command, lab broker).** Authorized single CUT; verify relay click, LEDs, pin-2 continuity open, ACK then STATUS=LOCKDOWN in the Core ledger, evidence stages PUBLISHED→ACK→STATUS. *Pass:* physical and logical evidence agree. Abort criterion: any unexpected contact state → power off.
8. **Reset/reconnect behaviour.** Power-cycle and reset the ESP32 while locked; confirm it returns LOCKDOWN and does **not** auto-restore on reconnect.
9. **RESTORE on the bench (explicit, lab authorization, fixture policy).** Only the lab Core's own RESTORE gate with lab fixtures; confirm the one-shot is spent. This never uses, advances or tests Production Recovery.
10. **Power-fault drills (owner-approved, optional).** Remove the relay supply with the ESP32 alive; record the contact state (expected: closes = fail-open, F2). Remove the ESP32 supply with the relay alive (expected: CUT held).
11. **Network disruption test (lab hosts only).** With the switched link carrying lab-only traffic, confirm the cut interrupts it and the restore recovers it; record link negotiation behaviour for the pin-2-only switch (F5).

## C. Stop conditions (any → power off, record, do not continue)

An unexpected relay state; any packet leaving the lab network; a smell, heat or current-limit trip; a command accepted without a valid MAC; a restore without the explicit authorization; evidence that contradicts the physical state.

## D. Evidence to keep (no secrets)

Photos of wiring (credentials excluded), meter readings, the serial boot log with secrets redacted, the flashed/readback digests, the Core audit export (hash-chained), the web dispatch audit, and a PASS/FAIL line per step above. A bench PASS is **lab evidence only**: it is not Production acceptance, not LVR/L8/L9 and not Recovery.
