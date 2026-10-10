# IDEA3 ESP32 / MQTT / relay hardware acceptance matrix

Status: **offline readiness document; no hardware acceptance performed**
Scope: IDEA3 Protocol v1, MQTT evidence, firmware reports, and the protected
Ethernet path. This matrix prepares a future owner-supervised isolated-lab
acceptance. It grants no authority to connect, flash, publish, switch a relay,
cut/restore a link, or change Production.

## Evidence vocabulary

Keep these stages separate in every record:

```text
request -> authenticated command -> MQTT publish result -> device ACK
        -> correlated STATUS -> relay-state observation
        -> independent protected-path traffic test
```

An earlier stage never proves a later one. `ACCEPTED` ACK is firmware command
acceptance, not proof that the relay moved. STATUS is an authenticated device
report, not a relay sensor. Neither proves Ethernet isolation. Broker
`CONNECTED` proves only the Core's broker connection; it does not prove ESP32
connectivity, command delivery, ACK, relay state, or link isolation.

## Current evidence and acceptance matrix

| Criterion | Existing offline / historical evidence | Acceptance evidence required | Current disposition |
|---|---|---|---|
| Authenticated device identity | Protocol topics bind a configured device ID; messages use separate C2D/D2C keys. H0 includes owner-reported ESP32-D0WD-V3 rev 3.1 and MAC read, but raw identity artifact/hash is absent and provisioning is not established. | On the isolated bench, compare read-only chip/MAC evidence with the owner-controlled device inventory and provisioned ID; retain a redacted, hashed record. Never place keys or full MAC in this repo. | **NOT VERIFIED** as the provisioned AEGIS device. |
| MQTT connectivity | MQTT client and TLS/PKI contract have deterministic tests. User-provided latest observed broker state is `CONNECTED`; current task does not independently probe it. | Capture same-window Core-to-lab-broker TLS connection, hostname/CA validation, and broker-side client identity/ACL evidence. Keep broker state separate from device state. | Broker observation: **CONNECTED (reported)**. ESP32 and uplink: **UNKNOWN**. |
| Command authentication | Protocol v1 golden vectors and firmware/native parity cover canonical bytes, HMAC-SHA256, direction-specific keys, and firmware parser behavior. Offline negative tests reject bad MAC, malformed/schema, stale/future time, and wrong routing. | Lab-only signed command accepted once by the identified device; record command ID/sequence and sanitized verifier outcome. | **OFFLINE CONTRACT COVERED**; physical device acceptance pending. |
| Replay rejection | Offline tests cover repeated command sequence/nonce and replayed valid ACK/STATUS; sequence high-water persistence is modeled and native parity is checked. | Repeat the same authenticated command/evidence in the isolated lab and show rejection/no second actuation, with persistent sequence evidence across a controlled reset. | **OFFLINE CONTRACT COVERED**; hardware behavior pending. |
| ACK / STATUS correlation | Tests distinguish publish, ACK, and STATUS, bind ACK to command ID/sequence, reject stale/foreign/replayed evidence, and leave missing ACK or contradictory STATUS unresolved. | Capture one lab transaction's IDs/sequences at each stage; prove matching ACK and command-correlated STATUS. Include a negative wrong-ID/sequence case. | **OFFLINE CONTRACT COVERED**; no current device exchange. |
| Relay state reporting | Firmware STATUS reports software `output_state` (`NORMAL` / `LOCKDOWN`) and reason; local E2E uses `FirmwareModelDevice`. There is no physical contact/relay sensor. | Independently observe relay/contact state with a safe meter/indicator while recording signed STATUS. Record disagreement as failure; STATUS alone cannot pass this row. | **SOFTWARE REPORT ONLY**; physical relay state **NOT SENSED**. |
| Actual protected Ethernet path isolation | Historical owner-observed PR5 test recorded interruption/recovery on a specific topology with only Ethernet pin 2 switched. H0 and F2/F5 review narrow this claim; single-conductor switching is not universal link isolation. | In isolated lab topology, record both endpoints, link state, and independent IPv4/IPv6 traffic before/during CUT; verify no alternate pair/path bypass; record explicit RESTORE and new traffic recovery. | **NOT PROVEN** as complete protected-path isolation; pin-2 partial-path limitation remains. |
| Authorized restoration and service recovery | Protocol/policy tests refuse unauthorized RESTORE; local E2E fixture tests are simulated. Historical owner evidence records explicit RESTORE recovery on the specific PR5 path, not general acceptance. | Require fresh owner authorization and lab-only recovery authority; show unauthorized RESTORE is rejected, authorized one-shot RESTORE closes the path, and fresh independent sessions/traffic recover. Record services separately. | **NOT ACCEPTANCE-READY**; Production dispatch is disabled per reported status. |
| Relay/control power loss | Source/circuit review: energized relay is CUT, COM-NC is the path; loss of coil/control supply de-energizes relay and closes COM-NC. | A separate owner-approved hazard decision and controlled isolated test would be required to change this disposition. | **FAIL-OPEN BY DESIGN ANALYSIS**; not measured. |
| ESP32/control power loss and reset | Firmware source drives GPIO27 LOW before OUTPUT and starts in lockdown; H0 records model/source evidence. Historical powered reset evidence applies only while relay supply remains present. | In a lab, separately observe reset/brown-out and ESP32 power loss while relay supply remains present; verify contact and traffic state. Do not infer total-power-loss behavior. | **PARTIAL / HISTORICAL**; total control-power-loss behavior unproven. |

## Deterministic offline coverage reviewed

Existing regression coverage is reused; this task adds no duplicate or
simulated-hardware test:

- `tests/test_protocol_v1.py` and `tests/test_protocol_v1_vectors.py`: schema,
  canonical signing input, HMAC/key handling, and fixed vectors.
- `tests/test_firmware_protocol_parity.py` plus
  `firmware/test/native/protocol_parity_main.cpp`: host-compiled firmware
  Protocol v1 parity; this is not ESP32 execution.
- `tests/test_offline_core_acceptance.py`: authenticated command flow, nonce /
  sequence replay, timestamp/skew, device identity, ACK/STATUS correlation,
  and evidence-stage behavior.
- `tests/test_mqtt_client.py`, `tests/test_protocol_inbound.py`, and
  `tests/test_protocol_ordering.py`: inbound MQTT evidence, replay/staleness,
  publish-vs-ACK-vs-STATUS ordering, and no auto-RESTORE.
- `tests/test_local_e2e_acceptance.py`: loopback service flow with simulated
  broker/device/relay; explicit negative cases and evidence labeling.

The currently observed task facts are broker `CONNECTED`, ESP32 `UNKNOWN`,
uplink `UNKNOWN`, dispatch `DISABLED`, and physical isolation
`NOT_PROVEN`. The offline suite cannot update any of those hardware states.

## Minimal future human-supervised checklist — not executed

1. Obtain fresh owner authorization for each planned action. Use an isolated
   lab with no Production route/uplink, lab broker/credentials only, and an
   independent recovery path. Confirm the separate F2 power-loss and F5
   single-conductor risk decisions are documented.
2. With power removed, inspect/record exact cable, pin/pair wiring, COM/NC/NO,
   common ground, supply, current limit, and manual stop/recovery method. Do
   not connect the protected cable to a live or shared network.
3. If separately authorized, capture read-only device identity and match it to
   the lab provisioning record. Do not flash or provision as part of identity
   acceptance; that is a separate authorization and task.
4. Establish NORMAL baseline using independent lab hosts. Record broker TLS
   identity, device identity, link state, and IPv4/IPv6 reachability separately.
5. Execute only a separately authorized lab CUT. Record command authentication,
   publish result, ACK, correlated STATUS, observed relay/contact state, then
   independent path traffic as distinct evidence.
6. Exercise only the pre-agreed authentication/replay negative cases and
   verify no additional actuation. Do not try commands against Production.
7. Require a separately authorized one-shot lab RESTORE. Verify fresh traffic
   and service reconnection from independent hosts; do not treat a resumed old
   session as recovery proof.
8. Stop after the agreed matrix. Leave power-fault testing out unless its
   separate hazard approval explicitly covers it; expected F2 behavior is
   fail-open under the current COM/NC circuit.

### Stop immediately if

- any cable, route, packet, broker, or credential reaches Production or a
  shared network;
- observed contact/relay state disagrees with STATUS or the pre-test wiring
  record;
- a command is accepted without the expected authenticated identity, nonce,
  timestamp, sequence, and authorization;
- RESTORE occurs without its explicit one-shot authorization;
- the independent recovery path is lost, the link behaves unexpectedly, or
  any electrical heating, smell, short, or current-limit trip occurs.

On stop: remove bench power using the rehearsed safe method, do not continue to
RESTORE or further testing, preserve sanitized evidence, and have the owner
review the discrepancy. This checklist does not authorize the test.

## Acceptance boundary

`PHYSICAL_ISOLATION_PROVEN=NO`. Firmware protocol parity and simulated local
E2E prove repository contracts only. They do not prove flashed firmware,
physical relay state, complete Ethernet isolation, fail-secure behavior during
power loss, or Production readiness.
