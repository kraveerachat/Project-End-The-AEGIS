# AEGIS IDEA3 H0 Hardware and Network/Security Evidence Package

**Prepared:** 2026-10-09

**Reviewed HEAD:** `31a68fa222a64c309cb064f32f82ed9faf5d37e0`

**Merged evidence state:** PR #413 is merged by `f0e4fcfd` from source commit
`7d6e30550b81423400625c03522716969b3402b7`; PR #414 is merged by
`31a68fa222a64c309cb064f32f82ed9faf5d37e0` from source commit
`f6b2eac9bd7e4ab289968f4ff151942a62402d64`. Their source and test findings
below are current-main evidence, still bounded as offline/engineering evidence.

**Evidence boundary:** offline repository evidence, owner-provided read-only hardware evidence, source analysis, and simulated local E2E only.

This package separates source/design, simulated acceptance, owner observation,
physical validation, and Production acceptance. It does not authorize or claim
serial, flashing, relay, MQTT, network, Production, or Recovery activity.

## 1. Shared infrastructure

IDEA3 contains the Detector → Core policy → Protocol v1 → device and web audit
paths. The repository proves source contracts and a loopback test path. The
local E2E simulates the broker, ESP32/relay, HUB mTLS terminator, attacks, and
containment; it is not evidence of a live broker, isolated lab, packet capture,
or Production network.

**Maturity:** source/design plus simulated local verification; physical and
Production acceptance remain open.

## 2. IDEA3 individual contribution

- H0 inventory and compile-only firmware evidence.
- Read-only flash-backup evidence reconciliation.
- Source review of relay polarity, dead-man behavior, F2 power-loss behavior,
  and F5 pin-2-only containment.
- Offline/simulated detector-to-audit path and web/Core projection evidence.
- Isolated-lab bench plan retained as a plan, not an authorization or result.

## 3. Contributions from other AEGIS areas

Other IDEA1, IDEA2, infrastructure, CTu/CTv, and Recovery claims remain owned
by their own canonical notes and immutable receipts. This package does not
promote them into IDEA3 physical or Production acceptance. PR #405 is merged
by main merge `9065a094`; its source/evidence package followed PR HEAD
`4b0574e24ab39b99c30d45f5647549c8a98acea5`. Its B1 evidence
is offline/fixture evidence only: 33 passed and 1 strict expected xfail, with
no live L8/L9/LVR, hardware, Production MQTT, or Recovery execution.

PR #413 merged findings: its read-only flash-backup diagnostic validator does
not open serial or invoke esptool; it validates owner-declared evidence and
explicitly reports `hardware_behavior_observed=NOT_OBSERVED`. Its owner-host
focused/adjacent result was 198 passed. The later owner-declared 115200-baud
backup is therefore not an independent hardware observation by the validator.
Neither result independently establishes backup provenance, restoration, device
identity, or fail-secure behavior.

PR #414 merged findings: F2 is **FAIL-OPEN by design analysis** when the
relay/ULN2003 coil supply is lost; F5 is **NOT PROVEN** as complete Ethernet
link isolation with pin-2-only switching. No hardware modification or live
test occurred in that PR.

## 4. Implemented and simulated features

| Feature | Classification | Evidence boundary |
|---|---|---|
| Synthetic attack → Detector → Core → Web → Protocol v1 → firmware model → ACK/STATUS → audit | `SIMULATED_LOCAL_E2E` | Loopback HTTP and disposable SQLite; no physical device or broker. |
| HMAC, timestamp, nonce/message ID, and sequence checks | Implemented/simulated | Source and offline tests; no live MQTT/TLS/ACL. |
| Web dispatch audit projection | Implemented/simulated | Local web/Core adapters; physical relay state remains unavailable. |
| Core-local RESTORE authorization boundary | Source-tested | Fixture-only local evidence; not Production Recovery approval. |
| Firmware compile artifacts | Compile-only | Placeholder CA build; not proof of the flashed image. |

The honest end-to-end label is:

`synthetic attack → Detector → Core → Web → Protocol v1 → firmware model → ACK/STATUS → audit`

It must not be rewritten as physical relay operation, Ethernet isolation, or
Production acceptance.

## 5. Security controls

| Control | Status | Evidence boundary |
|---|---|---|
| Network architecture | PARTIAL | Core/device/MQTT and switched-link design exists; no current isolated-lab topology or packet capture. |
| Security architecture | IMPLEMENTED/SIMULATED | Core policy, signed protocol, and bounded web evidence are source-tested. |
| Authentication/authorization | IMPLEMENTED/SIMULATED | Login/CSRF and identity checks are offline-tested; no live Production identity acceptance. |
| MQTT security | PARTIAL | Firmware selects TLS port 8883 and CA verification; broker TLS, ACL, and certificate negotiation were not run. |
| Device identity | OBSERVED/PARTIAL | Owner reported ESP32-D0WD-V3 rev 3.1, 40 MHz crystal, 4 MB flash, and successful MAC read; raw identity artifact/hash is not in the repository. |
| Cryptography/replay | IMPLEMENTED/SIMULATED | HMAC-SHA256, timestamps, nonce/message ID, and sequence checks are source-tested. |
| Audit logging | IMPLEMENTED/SIMULATED | Core hash-chain and web dispatch audit are exercised offline; no Production export. |
| Detection-to-response | IMPLEMENTED/SIMULATED | Synthetic attack reaches the full model path and remains explicitly simulated. |
| Physical containment | NOT TESTED | Historical conductor observation is not proof of traffic isolation. |
| Fail-secure behavior | PARTIAL | F1/F3/F4 are source/model evidence; F2 is fail-open when relay coil supply is lost. |
| Recovery governance | SOURCE/DESIGN ONLY | CTu/CTv and Recovery gates remain governing blockers; no Recovery execution. |

## 6. H0 hardware evidence

### Current owner-provided evidence

| Item | Classification | Result and limitation |
|---|---|---|
| ESP32 flash backup | OWNER-DECLARED READ-ONLY PASS; `hardware_behavior_observed=NOT_OBSERVED` | Owner reported ROM/no-stub at 115200 baud; `4,194,304` bytes; SHA-256 verification PASS; bootloader and partition headers EXPECTED. The validator did not observe hardware. |
| ESP32 identity | OWNER-REPORTED / NOT INDEPENDENTLY VERIFIED | ESP32-D0WD-V3 revision 3.1 and successful MAC read reported; MAC intentionally withheld and raw identity artifact/hash absent. |
| Firmware write | NOT PERFORMED | No firmware was written. |
| Flash erase | NOT PERFORMED | No flash was erased. |
| Backup restoration | NOT TESTED | Restore/readback from the backup has not been exercised. |
| Historical 460800-baud attempt | HISTORICAL FAILURE | Earlier read stalled/timed out; retained and superseded only as the current backup result by the later 115200-baud read. |

The original 2026-10-08 PR408 baseline remains valid for that period: serial was
not opened and identity was not read. The later owner report is a separate
evidence layer, not a rewrite of that baseline. The backup result is owner-
provided evidence, not an independent hardware run by this task. The raw dump,
complete MAC, credentials, and other sensitive material remain outside the
repository.

Codex 1 companion: `IDEA3-AEGIS_Lockdown/docs/operations/idea3-flash-backup-diagnostics.md`
and `deploy/pr11-phase4/flash-backup-diagnostics.py`; its focused synthetic/local
diagnostic result is 8/8 PASS and the validator never opens serial or invokes
esptool. Codex 2 companion:
`IDEA3-AEGIS_Lockdown/docs/operations/idea3-hardware-f2-f5-fail-secure-review.md`;
it preserves F2 **FAIL-OPEN** and F5 **NOT PROVEN as complete link isolation**.

### H0 acceptance mapping

| Step | Status | Boundary or blocker |
|---:|---|---|
| 1. Unpowered continuity/wiring | NOT TESTED | No current meter record or hash. |
| 2. Power-only indicators | OBSERVED | Owner observation; no contact-state proof. |
| 3/3B. Serial identity | OWNER-REPORTED/PARTIAL | ESP32-D0WD-V3 rev 3.1 and successful MAC read reported; raw redacted artifact/hash absent. |
| 4A. Flash backup | OWNER-DECLARED PASS; NOT INDEPENDENTLY OBSERVED | Owner reported a complete 4 MiB read at 115200; restoration still open and the validator did not observe hardware. |
| 5. Lab provisioning | NOT TESTED | Requires isolated lab credentials and authorization. |
| 6. Dead-man/boot grace | NOT TESTED physically | Model tests only. |
| 7. Lab CUT | NOT TESTED | No relay/contact/MQTT action. |
| 8. Reset/reconnect | NOT TESTED physically | No reset or device action. |
| 9. Lab RESTORE | NOT TESTED | Fixture RESTORE is not Production authority. |
| 10. Power-fault drill | NOT TESTED; F2 FAIL-OPEN analysis | Owner decision and optional lab drill remain required. |
| 11. Lab network disruption | NOT TESTED; F5 open | Pin-2-only switching may not isolate every PHY path. |

## 7. Network and security report coverage

- **Architecture:** designed Core/device/MQTT and switched-link path; no lab
  topology or traffic capture.
- **Authentication and authorization:** offline login/CSRF, identity, and
  Core-policy tests; no live Production authorization result.
- **MQTT:** TLS/CA configuration exists in source; broker TLS/ACL/client
  identity negotiation is untested.
- **Cryptography and replay:** signed Protocol v1, HMAC-SHA256, timestamp,
  nonce/message ID, and sequence checks are source/simulation evidence.
- **Audit:** hash-chain and dispatch ladder are offline-tested; physical relay
  state and Production audit export are unavailable.
- **Containment:** source polarity and historical conductor observation do not
  prove physical Ethernet isolation; F5 remains open.
- **Fail-secure:** F2 coil-supply loss de-energizes the relay and closes COM-NC
  by circuit analysis; it remains a physical security blocker.
- **Testing:** the completed host-offline suite
  (`test_offline_core_acceptance.py`, `test_protocol_v1.py`, and
  `test_local_e2e_acceptance.py`) recorded **199 passed, 10 skipped** in
  `/home/kittipat/Workspace/IDEA3-Cyber-Last/h0-implementation-6lOG3I7e/host-offline.log`.
  Host governance verification recorded **33 passed, 0 failed**. These are
  offline repository/governance results only; physical hardware acceptance is
  absent. Prior PR413 validator and local-E2E results remain separate
  provenance layers and are not summed into this total. None of these results
  are broker, network, Production, or Recovery acceptance.

The evidence classes are intentionally separate: source/design review;
simulated local E2E; offline host/validator tests; owner-reported ESP32
identity and backup; isolated hardware acceptance; and Production acceptance.
Only the first three and the owner report are represented here. Isolated
hardware acceptance and Production acceptance are **UNVERIFIED/NOT ACCEPTED**.

## 8. Remaining blockers and required human gates

CTu remains `FAIL_IMMUTABLE`; CTv remains `CLOSED_FAIL`; Recovery remains
blocked. These governance outcomes are preserved and are not rewritten by this
H0 evidence reconciliation.

1. Obtain hashed unpowered continuity/wiring evidence and redacted identity
   evidence.
2. Resolve or explicitly accept F2 before any fail-secure physical claim.
3. Complete separately authorized isolated-lab Steps 5–11, if the owner decides
   they are required.
4. Do not label the historical 460800 failure as current; do not claim backup
   restoration because it remains untested.
5. Keep the merged PR #413 and PR #414 findings bounded as offline/engineering
   evidence; do not treat them as physical or Production acceptance.
6. Obtain independent human review before merge or report submission.

## 9. Seven-item PR reviewer checklist

1. **Scope and policy metadata:** PENDING PR review; changed paths are listed in
   the task receipt.
2. **Reproducible tests/results:** PARTIAL; passing results and sandbox/wrapper/
   dependency failures are recorded honestly, and physical claims remain bounded.
3. **Draft/receipt truthfulness:** PASS for this task's `partial` receipt.
4. **Ready/non-Draft receipt count:** NOT APPLICABLE until a human changes PR
   state; one current receipt is present on this branch.
5. **Shared changes:** PASS — no cross-scope/shared path; IDEA3 owner notes are
   owner-maintained canonical updates.
6. **Secret boundary:** PASS — no dump, credentials, token, `.env`, private key,
   recording, or generated dependency is included.
7. **Updated from current main:** PASS — reviewed against merged `origin/main`
   `31a68fa222a64c309cb064f32f82ed9faf5d37e0`.

This checklist is a self-review only. Independent human review is required.
