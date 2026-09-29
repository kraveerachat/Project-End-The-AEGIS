# IDEA3 Core-mediated Recovery — design and deployment boundary (repository only)

Date: 2026-09-29. Owner: music. Status: repository implementation. **IMPLEMENTED != DEPLOYED.**

## Decision (owner-frozen)

`PRODUCTION_RECOVERY_MODEL = CORE_MEDIATED`. The desktop never owns the Core MQTT identity, holds protocol keys or broker
credentials, publishes a command, opens the protocol store as a producer, reaches the root containment helper, or verifies
an admin PIN. The Core is the sole production authority. RESTORE remains the Core-local D4 gate only.

## Gate authority

| Gate | Authority | Evidence |
|---|---|---|
| R1 | Core (mutating, alert path only) | `incidents` row + `INCIDENT_BOUND` audit row |
| R2, R6, R7 | Core (read-only probes) | probes run in the Core against Core state |
| R3 | Core (mutating) | `RECOVERY_R3_REQUESTED/RESULT` audit rows with `incident_id`; block + independent `contains()` |
| R4 | Owner-local D4 action, Core-verified | durable `RESTORE_REQUESTED` row bound to the incident |
| R5 | Core via D4 | `RESTORE_PUBLISHED` link + the D4 evidence ladder (`restore_evidence_ladder`) |
| R8 | Core (mutating) | re-check of R1–R7, then `RECOVERY_R8_CLOSE` audit row, `close_incident`, `INCIDENT_CLOSED` |

## One-shot rule

Any durable `RESTORE_REQUESTED` audit row bound to the incident consumes the attempt (including a definitively unsent one).
It is never cleared and survives UI and Core restarts. A Core restart that loses the in-memory physical correlation leaves R5
not verified. There is no automatic retry; a spent attempt needs owner review and a fresh authorization or a new incident.

## Transport

Core-owned AF_UNIX socket, `SO_PEERCRED` uid allowlist (`AEGIS_RECOVERY_OPERATOR_UID`), 4 KB bound, fixed operations
(`STATUS`, `ISOLATE`, `PROBE`, `RESTORE_STATUS`, `CLOSE`), no operation carrying an IP/path/command/secret, production profile
only, no network listener. The existing D4 socket permissions are unchanged. The client refuses a server that is not the Core
account.

## Deployment boundary

This change alters the headless runtime closure and Core source. A running production Core does not have it. Going live needs a
separate owner-approved, post-L7 Core upgrade stage (new immutable release install, governed restart, a socket directory the
operator uid can reach, and the operator uid setting). That stage is not defined or executed here, and this branch must not
merge before L7 #3 is accepted.
