# IDEA3 hardware F2/F5 fail-secure engineering review (H0)

Date: 2026-10-09
Evidence class: repository/source review only
Status: **BLOCKED for fail-secure hardware acceptance**

This review is deliberately narrower than H0 readiness. It evaluates whether
the current relay topology can honestly be called fail-secure under two
hardware faults. It does not authorize a bench test, firmware upload, serial
access, MQTT command, relay actuation, or network interruption.

## Evidence boundary

- `firmware/src/main.cpp` defines `GPIO27 LOW` as the lockdown trigger and
  drives that state before configuring the pin as an output. The firmware also
  starts with `isLockedDown = true` and uses the dead-man and boot-grace
  paths to request lockdown.
- The H0 wiring record describes a high-level-trigger relay with COM/NC in
  Ethernet pin 2 and NO unused. The relay is energized for CUT and released
  for NORMAL.
- The owner-observed PR5 continuity and Ethernet results are valid evidence
  for the powered relay/control circuit only. They do not establish behavior
  after loss of relay power, nor do they prove complete Ethernet isolation.

## F2 — relay/ULN2003 coil supply loss

**Disposition: FAIL-OPEN by design analysis; acceptance blocked.**

If the relay-coil supply, ULN2003 supply, or their shared low-voltage source
is lost while the uplink contact is wired COM/NC, the coil de-energizes and the
mechanical NC contact closes. That restores the switched conductor regardless
of the ESP32 dead-man state. The firmware cannot correct this condition because
the actuator has lost the energy needed to hold CUT.

This is not a failed software test and must not be relabeled as a firmware
dead-man PASS. The current design therefore supports the narrower claim
“fail-secure while relay/control power remains available,” not
“fail-secure under power loss.”

### Required engineering decision before acceptance

The owner must choose and review a hardware path that makes the required
security state safe under the relevant power fault, for example:

1. a separately protected or backed-up actuator supply with an explicit
   low-voltage alarm and bounded ride-through;
2. an actuator/contact arrangement whose de-energized state is the required
   containment state, subject to thermal, fire, and recovery review; or
3. an independently supervised hardware interlock that holds containment when
   the primary control supply fails.

The choice must include a written hazard review for brown-out, cable removal,
fuse/driver failure, and manual recovery. No option is accepted by this
repository-only review.

## F5 — single-conductor Ethernet switching

**Disposition: NOT PROVEN as complete link isolation; acceptance blocked.**

Switching only Ethernet pin 2 can interrupt the observed path in the recorded
lab topology, but it does not establish that every PHY, negotiation mode, or
future wiring arrangement loses connectivity. A remaining conductor path,
PHY behavior, or alternate management path could preserve communication.

The current evidence may therefore state “pin-2 contact interruption observed
in the tested topology.” It must not state “the physical uplink is universally
isolated” or treat pin-2 continuity alone as traffic isolation.

### Required acceptance evidence

Before F5 can be promoted, an owner-authorized isolated-lab test must record
the exact cable and switch topology, then demonstrate from independent lab
hosts that:

- NORMAL has the expected link and traffic;
- CUT prevents new traffic over the protected uplink, including both IPv4 and
  IPv6 where configured;
- no alternate conductor or management path bypasses the cut; and
- RESTORE recovers traffic only after the explicit recovery action.

If the threat model requires full Ethernet isolation rather than interruption
of this one tested path, the hardware design must switch all required pairs or
move containment to a reviewed upstream device. That is an engineering change,
not an inference from the present relay.

## Current acceptance matrix

| Property | Current result | Honest claim | Needed next |
|---|---|---|---|
| ESP32 reset/crash with relay power present | Source/design PASS | GPIO default and firmware path request CUT | Isolated-lab measurement |
| Dead-man timeout | Model/source PASS | Authenticated heartbeat loss requests CUT | Isolated-lab timing and relay observation |
| F2 relay/control power loss | **FAIL-OPEN analysis** | NC contact may restore uplink | Owner hardware decision and fault test |
| F5 pin-2-only interruption | **NOT PROVEN complete** | Tested topology interrupted one conductor | Independent-host link/traffic test and threat-model decision |
| Production fail-secure acceptance | **NO** | Not established by H0 or PR5 | Human owner and integration review |

Until F2 and F5 are resolved, F2/F5 remain physical-security blockers. This
review changes no firmware polarity, relay wiring, recovery authority, or
production state.
