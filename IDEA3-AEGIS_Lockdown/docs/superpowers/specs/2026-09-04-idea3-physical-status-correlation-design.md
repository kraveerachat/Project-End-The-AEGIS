# AEGIS IDEA3 — Physical STATUS Correlation Design

Date: 2026-09-04
Branch: `feat/idea3-headless-core`
Scope: Task 2D6 — Correlated Physical Evidence

## 1. Problem

AEGIS Core already correlates command ACK messages using the command nonce.

Command:

~~~json
{
  "cmd": "CUT_UPLINK",
  "nonce": "ABC123"
}
~~~

ACK:

~~~json
{
  "ack": "OK",
  "detail": "uplink cut",
  "nonce": "ABC123"
}
~~~

This proves that the ACK belongs to the command being tracked.

Physical STATUS currently has no command correlation:

~~~json
{
  "state": "LOCKDOWN",
  "reason": "verified",
  "rssi": -48,
  "heap": 200000
}
~~~

This is insufficient because STATUS can be produced by:

- CUT_UPLINK
- RESTORE_UPLINK
- Deadman's Switch
- Secure Boot fail-safe
- MQTT reconnect / boot
- periodic status heartbeat

Therefore:

~~~text
STATUS.state == expected_state
~~~

alone must not complete a command lifecycle.

## 2. Design Decision

Use `command_nonce` only for STATUS messages directly produced by an
accepted CUT_UPLINK or RESTORE_UPLINK command.

`command_nonce` is intentionally distinct from the generic `nonce`
field in signed commands and ACK messages.

## 3. Command-Triggered STATUS

For:

~~~text
CUT_UPLINK nonce=ABC123
~~~

ESP32 publishes:

~~~json
{
  "state": "LOCKDOWN",
  "reason": "verified",
  "rssi": -48,
  "heap": 200000,
  "command_nonce": "ABC123"
}
~~~

RESTORE uses the same contract:

~~~json
{
  "state": "NORMAL",
  "reason": "verified",
  "rssi": -47,
  "heap": 199000,
  "command_nonce": "XYZ789"
}
~~~

## 4. Non-Command STATUS

Boot, periodic heartbeat, Deadman and Secure Boot STATUS messages do
not include `command_nonce`.

Example:

~~~json
{
  "state": "LOCKDOWN",
  "reason": "DEAD MAN'S SWITCH - heartbeat timeout",
  "rssi": -48,
  "heap": 200000
}
~~~

These messages remain authoritative for the current device state, but
they are not evidence that a particular command completed.

## 5. Core Semantics

Python Core keeps two concepts separate.

### Device physical truth

Any valid STATUS may update:

~~~text
status.device
status.uplink
~~~

An uncorrelated Deadman STATUS=LOCKDOWN must therefore still cause the
runtime to report LOCKDOWN.

### Command physical evidence

STATUS may update the active command lifecycle only when:

~~~text
awaiting_physical_confirmation exists
AND
STATUS.command_nonce == awaiting_physical_confirmation.nonce
~~~

Then Core may update:

~~~text
observed_state
physical_confirmed_at
~~~

Physical confirmation additionally requires:

~~~text
STATUS.state == expected_state
~~~

## 6. Missing or Mismatched Correlation

If `command_nonce` is missing:

~~~text
device/uplink truth = update
command lifecycle   = unchanged
~~~

If `command_nonce` does not match the active command:

~~~text
device/uplink truth = update
command lifecycle   = unchanged
~~~

Neither case may set `physical_confirmed_at`.

Ignored command evidence should be auditable where appropriate.

## 7. Order Independence

ACK and STATUS remain independent evidence channels.

Both orders are valid:

~~~text
STATUS(command_nonce=A) → ACK(nonce=A)
ACK(nonce=A) → STATUS(command_nonce=A)
~~~

MQTT delivery order must not determine command completion.

## 8. Firmware Changes

`publishStatus()` accepts optional command correlation.

Conceptually:

~~~text
publishStatus(state, reason, commandNonce)
~~~

`setLockdown()` also accepts optional command correlation.

Command path:

~~~text
CUT_UPLINK nonce=A
→ setLockdown(true, "verified", A)
→ publishStatus("LOCKDOWN", "verified", A)
~~~

RESTORE follows the same pattern.

Boot, heartbeat and fail-safe paths do not supply a command nonce.

## 9. MQTTManager Changes

STATUS parsing reads:

~~~python
command_nonce = data.get("command_nonce", "")
~~~

STATUS callback becomes conceptually:

~~~python
status_callback(state, rssi, heap, command_nonce)
~~~

Legacy Desktop GUI compatibility must be updated for the callback
signature.

## 10. Supervisor Changes

Supervisor receives optional command correlation.

All valid STATUS messages continue updating generic device truth.

Command lifecycle evidence is accepted only when
`command_nonce` matches the active physical confirmation tracker.

Missing or mismatched correlation must never falsely confirm the
current command.

## 11. Required Tests

Implementation is test-first.

Required coverage:

1. Firmware command STATUS contains `command_nonce`.
2. Boot STATUS does not claim command correlation.
3. Periodic heartbeat STATUS does not claim command correlation.
4. Deadman STATUS does not claim command correlation.
5. MQTTManager forwards `command_nonce`.
6. Matching `command_nonce` confirms CUT_UPLINK.
7. Matching `command_nonce` confirms RESTORE_UPLINK.
8. Missing `command_nonce` cannot confirm an active command.
9. Mismatched `command_nonce` cannot confirm an active command.
10. Uncorrelated STATUS still updates device/uplink truth.
11. STATUS-before-ACK remains valid.
12. ACK-before-STATUS remains valid.
13. ACK timeout remains valid.
14. Physical confirmation timeout remains valid.
15. Full Python regression passes.
16. Ruff passes.
17. `git diff --check` passes.
18. ESP32 firmware compiles with PlatformIO without upload.

## 12. Security Boundary

`command_nonce` is a correlation identifier, not cryptographic
attestation and not direct electrical proof of relay state.

Actual physical relay behavior will be verified later during the
hardware E2E milestone.

## 13. Hardware Milestone

Do not flash ESP32 during Task 2D6 implementation.

After:

~~~text
2D6 implementation
→ Python regression
→ Ruff
→ firmware contract tests
→ PlatformIO compile
→ protocol checkpoint commit
~~~

the next milestone is:

~~~text
ESP32 flash
→ MQTT E2E
→ CUT_UPLINK
→ ACK nonce verification
→ correlated LOCKDOWN STATUS
→ physical relay observation
→ RESTORE_UPLINK
→ correlated NORMAL STATUS
→ Deadman test
→ recovery test
~~~

No firmware upload occurs before the protocol checkpoint is green.
