# IDEA3 Kali attack-detection lab acceptance contract

**State:** `PREPARATION ONLY — LIVE KALI ACCEPTANCE NOT AUTHORIZED OR EXECUTED`
**Mode:** Offline fixtures now; future authorized, isolated lab only.
**Production mutation:** No. **Network scan or attack traffic:** No.

This contract maps A1–A3 to the current IDEA3 code and tests. Synthetic log
fixtures and fake firewall runners prove deterministic software behavior; they
are not observations from Kali, a live network, Production, or a host firewall.
No command in this document starts the detector, changes nftables, or generates
traffic.

## A1 — NORMAL BASELINE

**Current status: `PARTIAL — SIMULATED/OFFLINE ONLY`.** Existing tests prove
local service/test harness behavior and that simulated authenticated status is
recorded as liveness without generating a command. They do not establish the
future lab's actual service health, IDEA1/IDEA2 visibility, authenticated
ESP32 heartbeat, relay state, or uninterrupted lab traffic. In particular,
`tests/test_local_e2e_acceptance.py::test_s01_a_normal_authenticated_status_is_recorded_as_liveness_only`
uses a firmware-model device, and `tests/test_production_like_acceptance.py`
requires `AEGIS_START_DETECTOR=0`.

**Future lab pass evidence:** identify the lab Core/Web instance and test window;
record health/readiness; record honest IDEA1 and IDEA2 status (including
`UNKNOWN`/absent); verify the named lab device's authenticated heartbeat and
NORMAL state; and verify only the designated lab link carries expected traffic.
Capture timestamps and redacted, hashed evidence. A1 does not require or permit
attack traffic.

## A2 — ATTACK DETECTION

**Current status: `PASS — SIMULATED_OFFLINE DETECTION/INGRESS COMPONENTS`; live
Kali observation is `NOT TESTED`.** `production_detector.ProductionDetector`
consumes journal-format lines, not packets. Existing fixtures cover:

- SSH failures: 5 from one source in 30 seconds;
- `AEGIS_NEWCONN` port scan: 10 distinct destination ports from one source in
  10 seconds; and
- `AEGIS_NEWCONN` SYN flood: 20 events from one non-loopback source in 2
  seconds.

The detector extracts `from <IPv4>` for SSH and `SRC=<IPv4>` for the kernel
events. The sink sends one version-1 `attacker_ip` request over its fixed local
AF_UNIX socket. Core ingress authenticates the peer UID, validates the
address, and binds the accepted source IP to an incident. Expected durable Core
evidence includes `ALERT_ACCEPTED` (peer UID/PID, IP, action) and
`INCIDENT_BOUND` (or an explicitly explained existing/ignored outcome),
followed by a valid audit-chain check. A mismatched source IP, unauthenticated
peer, refused alert, or absent audit evidence is a FAIL. Do not substitute a
client-supplied IP for the detector's observed source.

The detector's tests use synthetic journal lines; the end-to-end fixture hands
the request directly to the ingress with a synthetic peer. Separate F1 tests
exercise the real AF_UNIX server/client on a temporary local socket. Together
these are synthetic/offline evidence, not proof of Kali traffic, host journal
collection, or a live Core service.

## A3 — SOFTWARE CONTAINMENT

**Current status: `PARTIAL — OFFLINE COMPONENTS VERIFIED; INTEGRATED/LIVE
ACCEPTANCE BLOCKED`.** `tests/test_runtime.py` covers armed software blocking,
dry-run/disarmed/refusal behavior, and success/failure audit events with a fake
containment client. `tests/test_ip_containment.py` covers validation,
idempotency, read-back, and exact nft argv with a fake nft runner. These tests
do not change or observe the host firewall or prove that traffic is dropped.

There is a material event-path boundary to resolve before claiming A3:
production F1 alert ingress calls `on_production_alert`, which binds/audits an
incident and is explicitly tested not to call containment or dispatch. The
generic supervisor callback has separate `ARMED` + `AEGIS_AUTO_CONTAIN=1`
software-block logic, but the current tests do not prove the Production F1
alert reaches that callback. Do not claim an automatic detector-to-block path
until the IDEA3 owner reviews and resolves this integration contract. No code
change in this readiness task wires it.

**Future lab pass evidence, after the event-path blocker is resolved:** bind
the expected Kali test-client IPv4 to the detector event and same incident;
verify the protected-CIDR configuration excludes management, Core, and control
addresses; record the Core `software_containment_success` event and the
helper's matching `BLOCKED` result; independently read the IDEA3 nftables
`blocked_ipv4` set and verify the exact source entry; from the authorized Kali
host, verify only the intended lab path is blocked while management access
remains; then use the documented authorized lab `aegisctl unblock-ip <IPv4>`
recovery, verify the entry is absent and expected lab connectivity returns,
and record the unblock evidence. Software unblock is not physical `RESTORE`.
No real containment or unblock is part of this task.

## Minimum isolated Kali lab plan — future, separately authorized

1. **Scope and authority:** written owner authorization naming this test,
   operator, date/window, allowed source and destination addresses, and exact
   A1/A2/A3 actions. Use only project-owned lab hosts. Do not use Production,
   shared user networks, public targets, or routable external systems.
2. **Target identity:** record the isolated Core/Web host's owner, asset ID,
   OS/release, NIC/MAC, fixed lab IP, and expected service/listener; record the
   Kali host's owner, asset ID, image/version, NIC/MAC, and fixed source IP.
   Independently verify both identities before connecting the lab segment.
3. **Network separation:** use a dedicated physical switch or verified
   host-only segment with no Production uplink, bridge, shared Wi-Fi, default
   route, or forwarding path. Prove separation from both hosts and document
   topology. Keep an out-of-band management path. Do not scan to discover
   targets; address only the predeclared target.
4. **Pre-run capture and backup:** save a read-only baseline of service status,
   Core audit-chain verification, IDEA3 nftables table/set, routes/interfaces,
   and relevant configuration digests. Back up the lab config, audit DB, and
   lab nftables configuration/state using the owner-approved procedure. Store
   backups and evidence outside the repository, with access controls and hashes.
   Confirm a tested restoration path and a console/second-NIC recovery path.
5. **Observation:** record UTC timestamps, exact authorized inputs, detector
   event type, source-IP equality, incident ID, peer UID/PID, audit event IDs,
   nft read-back, and connectivity observations. Label outputs `LIVE_ISOLATED_LAB`
   only after they are measured there. Keep credentials and secrets out of
   logs, screenshots, receipts, and this repository.
6. **Stop conditions:** immediately stop the test and isolate/power down the
   lab segment if any packet leaves it; target identity or source IP differs;
   Production/shared routing is detected; management access is lost; unexpected
   hosts/services are affected; the detector or Core behaves outside the
   reviewed path; block state differs from the requested source; audit
   verification fails; or any equipment/network fault occurs. Do not improvise
   retries or widen scope.
7. **Recovery and closeout:** restore the exact saved lab rules/configuration,
   remove only the test source block through the authorized lab recovery path,
   verify management and expected lab connectivity, service state, no residual
   test block, and audit integrity. Preserve raw evidence securely; publish
   only redacted summaries and hashes. Record every failed/aborted step as such.

## Prerequisites before any live Kali test

All must pass and be recorded before authorization to generate test traffic:

- Independent IDEA3 owner and integration review accepts this scope and the
  event-path decision; the production detector-to-Core-to-containment path is
  demonstrated on an isolated lab instance, or A3 is explicitly narrowed to a
  separately authorized manual block exercise.
- Focused offline detector, ingress, audit, runtime-policy, and containment
  tests pass on the reviewed commit; evidence is labeled synthetic/offline.
- The isolated lab is uniquely identified and exclusively project-owned; a
  second person verifies target IP/MAC and topology; no path to Production or
  external/shared networks is measured.
- Lab-only credentials, protected CIDRs, `ARMED`/dry-run/auto-containment
  settings, detector source, journal inputs, and firewall table are reviewed;
  Production credentials/configuration are absent.
- A1 baseline, read-only firewall/audit capture, backups, rollback steps,
  out-of-band access, stop conditions, and evidence handling are rehearsed.
- Separate owner authorization covers each live action, including any lab
  detector start, controlled test traffic, software block, and software
  unblock. No authorization here applies to Production.

Until these gates are met: `A1=PARTIAL`, `A2=SIMULATED_ONLY`,
`A3=BLOCKED_FOR_LIVE_ACCEPTANCE`; no Kali attack has been executed.
