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
be deployed by merging alone. (Historical sequencing: this branch was initially held behind L7 acceptance. L7 #7 is now
live-acceptance proven, so that merge blocker is satisfied, and the branch was reconciled with post-L7 `main`
`5df959055075171ea5734238aa83693371d00d9d`. Recovery remains IMPLEMENTED != DEPLOYED and not live accepted.)

## OD-R5-BG-01 — break-glass RESTORE (owner approved; local implementation, not deployed)

Break-glass is an **emergency operational recovery path only**. It never satisfies or claims Recovery R4, R5, R8, final
Recovery acceptance, LVR or L8 acceptance. The normal path stays the default and is unchanged:
R1 VERIFIED → R3 VERIFIED + live containment read-back → fresh R2 VERIFIED → D4 credential → RESTORE, with an incident-bound
`RESTORE_REQUESTED`, the database one-shot, and production NULL-incident normal RESTORE prohibited.

* **Authority.** Only the Core-local terminal D4 authority (peer uid, D4 credential, `RESTORE UPLINK`, mandatory reason) plus
  `break_glass=true` and the second exact confirmation `BREAK GLASS RESTORE UPLINK`. No Web, Recovery-UI, MQTT or remote
  authority; the strict request schema refuses unknown keys. `aegisctl restore --break-glass` is the only client.
* **Authenticated lockdown only.** Eligibility needs an authenticated Protocol-v1 `STATUS=LOCKDOWN` through the existing
  reviewed inbound verifier (no second parser; legacy, plaintext or unauthenticated status never qualifies).
* **Durable episode model.** `lockdown_episodes` opens on an authenticated LOCKDOWN and closes on a later authenticated
  NORMAL; at most one open episode per device (partial unique index); history is never deleted or rewritten; unsafe
  historical data fails `init_db` closed.
* **Fresh proof.** The durable episode is replay/audit identity. Live eligibility additionally needs a process-local fresh
  authenticated LOCKDOWN observation, which a Core restart clears and which is never rebuilt from the database.
* **Eligibility.** Only when the normal RESTORE is not valid, and exactly one case: **A** no Core-bound open incident, or
  **B** an open incident whose R3 was actually attempted and whose latest durable result is `FAILED` for the bound address.
  Never because R3 was never attempted, is pending, containment was skipped, or the normal path passes (that is refused
  `BREAK_GLASS_NOT_REQUIRED`). A fresh R2 probe is mandatory every time (no bypass, no cache). The gate never fabricates R1/R3,
  creates an incident, binds an IP, issues CUT or mutates containment.
* **One claim per episode.** `restore_break_glass_claims.episode_id` is UNIQUE (database level), written with the dedicated
  `RESTORE_BREAK_GLASS_CLAIM` audit row (NULL `incident_id`, so it is never a `RESTORE_REQUESTED` or an R5 publication row) in
  one transaction BEFORE any command reservation or publication. An unknown publication outcome leaves the episode spent; a
  new authenticated NORMAL→LOCKDOWN episode is eligible again. No time cooldown, no automatic retry.
* **Basis.** The supervisor's production RESTORE chokepoint accepts exactly `NORMAL_R5_BASIS` (`R3_VERIFIED`) or a
  `BreakGlassBasis` that must name a real, spent, not-yet-dispatched claim of the fresh episode and is consumed once.
* **Reporting.** R4/R5/R8 ignore it; `RESTORE_STATUS` reports `break_glass_restore = OPERATIONAL_RECOVERY_ONLY` separately.
  The ops notification follows the durable claim; its failure neither unspends nor retries.

Status: IMPLEMENTED locally with tests; **not** pushed, not deployed, not live-proven.
