# IDEA3 Recovery R1-R8 read-only evidence foundation (task-local design)

Status: repository foundation only. Not deployed, not run against Production, no Phase-4 stage registered, no owner
runner, no Authorization/K3. IMPLEMENTED != DEPLOYED.

## Purpose

`aegis_soc/recovery_evidence.py` inspects stored state and emits deterministic, machine-readable evidence for the Core
Recovery gates R1-R8 (`recovery_protocol.GATES`). Each gate is exactly one of `VERIFIED`, `BLOCKED`, `NOT_PROVEN`.
It is the checker a later, separately reviewed owner runner may call; this task adds no runner and no stage.

## Inputs (all explicit; there are no defaults and no config reads)

| Input | Use | Opened as |
|---|---|---|
| `--audit-db` | incidents + audit rows (R1, R3, R4, R5 linkage, R8) | SQLite `mode=ro&immutable=1`, `PRAGMA query_only` |
| `--protocol-db` | RESTORE command row and ACK/STATUS correlation (R5) | same |
| `--observations` | R2/R6/R7 probe results, live containment read-back, device status | strict allow-listed JSON, 64 KiB cap |
| `--incident-id` | subject incident (needed to inspect a CLOSED one) | integer |
| `--now`, `--max-age-sec` | evaluation clock and freshness window (default 300 s) | numbers |

The checker never probes. A probe result is only evidence if an observation says so, is bound to the same incident id,
and is neither stale nor from the future. `immutable=1` never creates `-wal`/`-shm`/`-journal` files and works in a
read-only directory; `immutable=1` ignores a hot rollback journal and an un-checkpointed WAL, so any non-empty `-wal` or `-journal` sidecar makes the store refused as `NOT_PROVEN` (`*_STORE_WAL_PENDING` / `*_STORE_JOURNAL_PENDING`) before SQLite is opened; the store must be quiesced or copied consistently. Zero-byte sidecars are allowed.

## Verdict rules

* Missing store/observation file -> `NOT_PROVEN`; present but unusable (malformed, wrong schema, unknown keys) -> `BLOCKED`.
* A gate whose prerequisite is not `VERIFIED` is `BLOCKED` (`PREREQUISITE_NOT_VERIFIED`). Prerequisites: R2,R3,R4 need R1;
  R5 needs R4; R6 needs R5; R7 needs R6; R8 needs R1-R7 (`recovery_protocol.CLOSURE_REQUIRED`).
* Absent/stale/unbound/unconfigured evidence -> `NOT_PROVEN`; negative or conflicting evidence -> `BLOCKED`.
* R1: exactly one unambiguous incident; `ip_containment.validate_block_target` rules for the address. The detector-alert
  relationship (`INCIDENT_BOUND ... source=detector_alert`) is reported separately in `evidence.detector_alert`
  (`VERIFIED` / `NOT_PROVEN` / `BLOCKED` on a different address) and is never fabricated; a missing row does not fail
  R1 because the Core's own R1 does not require it.
* R3: newest `RECOVERY_R3_RESULT` row via the Core's `_R3_RE`; the live read-back is an observation and, when it says the
  IP is absent from an open incident, makes R3 `BLOCKED`.
* R4: exactly one durable `RESTORE_REQUESTED` row bound to the incident, preceded by a `VERIFIED` R3 row. Only `id` and
  `timestamp` are selected; the details column (D4 material) is never read, so it cannot be emitted.
* R5: `RESTORE_PUBLISHED` row (Core `_PUBLISHED_RE`) -> protocol-store command -> the Core's own
  `local_restore.restore_evidence_ladder`, fed by a read-only shim. The Core keeps "STATUS=NORMAL observed for this
  exact command" in memory; offline that fact is only available as a fresh `device` observation correlated to the same
  msg id. ACK without it is `NOT_PROVEN`.
* R6/R7: observations only (R7 needs all of core_db, mqtt, device, uplink_normal, dispatch, web). Target names/addresses
  are never emitted, only counts and OK/FAIL/NOT_CONFIGURED.
* R8: R1-R7 `VERIFIED`, incident `CLOSED`, a Core `RECOVERY_R8_CLOSE` row after the RESTORE request. R1-R7 verified on
  an OPEN incident yields `NOT_PROVEN` (`INCIDENT_NOT_CLOSED`), never `VERIFIED`.

## Output

Deterministic JSON (`sort_keys`, fixed vocabulary, explicit `evaluated_at`). `overall` is `VERIFIED` only when all eight
gates are. `claims` always states `physical_evidence=NOT_PROVEN`, `production=NOT_PROVEN`, `scope=STORED_STATE_ONLY`.
`render` refuses to emit credential-shaped text. CLI exit codes: 0 VERIFIED, 2 BLOCKED, 3 NOT_PROVEN, 4 refused.

## Guarantees and how they are tested (`tests/test_recovery_evidence.py`)

* zero DB writes: file hashes/mtimes and the directory listing are unchanged; connections reject INSERT/UPDATE/DELETE/CREATE;
  works from read-only files in a read-only directory; a missing store is never created;
* zero network / subprocess / MQTT publish+connect / containment (nft helper) / protocol-store reserve calls: tripwires;
* no serial stack loaded; an AST scan pins the module's imports and forbids write/publish/subprocess/containment names and
  write-shaped SQL literals; importing the module creates no log file (the Core log handler is pointed at the null device);
* a parity test shows the checker never verifies R1/R3/R4/R5 where the Core's own gate functions do not.

## Out of scope / known limits

No live Core read, no real probe, no stage registration, no owner runner, no edits to `p4-*.sh`, F1/F1i/F1r or Phase-4
docs (merge-separable from PR #336). A store with a non-empty WAL or rollback journal must be quiesced or copied consistently before analysis. R2/R6/R7/device evidence
is only as trustworthy as whoever produced the observation snapshot; binding that producer is the later runner's job.
