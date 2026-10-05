# IDEA3 R1Du + R1D — historical R1A incident disposition before R1B (final design)

Status: repository design + implementation only. Nothing here executes on a host, restarts the Core, mutates an incident, runs Recovery R2-R8, consumes an R1B marker or touches ESP32.
Authoritative main at design time: `6bb21976d5e8323a4863910445dd6b6eba6e9a85`.

## 1. Problem and governed order

The immutable failed R1A attempt left incident #1 `OPEN`. `r1_acceptance.capture_baseline()` refuses any open incident (`PREEXISTING_OPEN_INCIDENT`) and the Core returns `EXISTING` / `IGNORED_DIFFERENT_IP` while an incident is open, so R1B (which requires a NEW incident with `CREATED` semantics) cannot pass. No already-reviewed path closes it (Core `CLOSE` = R8 needs R1-R7 VERIFIED; the desktop wizard writes SQLite directly).

Owner-approved order: `R1A (immutable FAIL) -> R1Du -> R1D -> R1B -> Recovery R2-R8 -> LVR -> L8 -> L9`.

* **R1Du** (F1u-style, MUTATING, one attempt, no retry): installs the new immutable release that carries the R1D disposition authority, switches `current`, restarts the Core exactly once; the detector lifecycle is the same owner-approved consequence as F1u. It never touches an incident, never runs R1D.
* **R1D** (MUTATING, one attempt, no retry): one Core-mediated, atomic, evidence-preserving disposition of the historical incident.
* **R1B** is unchanged (NEW incident, `CREATED`, genuine external event, source-IP/window binding, one attempt). Only its predecessor gate additionally recognises the R1Du closeout and the new current release/Core digest; the zero-open-incident baseline is NOT weakened.

Fixed claims: `R1A_RESULT=FAIL_IMMUTABLE`, `R1A_RERUN_ALLOWED=NO`, `R1B_IS_R1A_RETRY=NO`, `R1I_MUST_REMAIN_INSTALLED=YES`, `RECOVERY_R2_R8_BLOCKED_UNTIL_R1B_PASS=YES`, `F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN`, `R1_VERIFIED=NOT_CLAIMED`, `RECOVERY_R1_R8_PROVEN=NO`.

## 2. Core authority (`aegis_soc/historical_disposition.py`)

* Dedicated local AF_UNIX channel `historical-disposition.sock` in the Core-owned runtime directory, mode 0600, **peer uid must be 0** (kernel `SO_PEERCRED`), no network listener, no operation on the normal Recovery protocol. UID 1000 (the Recovery operator) can neither connect nor be accepted. The stage-only caller is a tiny stdlib script run by the frozen runner through `sudo`.
* **Inert by default:** the server starts only when ALL hold: production profile, `AEGIS_R1D_DISPOSITION_ENABLED=YES` (exact), `AEGIS_ALERT_SOURCE_UID` configured, and no `INCIDENT_DISPOSED_HISTORICAL` audit row exists. After a successful disposition the server closes its listener and unlinks the socket; after any later Core restart the existing audit row keeps it from starting.
* Request body is exactly `{"v":1,"op":"DISPOSE_HISTORICAL","binding_sha256":"<64 hex>"}`; any other key, type or size is refused. The caller can never supply an incident id or an IP.

### Eligibility (re-evaluated inside the write transaction)

1. production profile; 2. exactly ONE incident with `state != 'CLOSED'`, and its state is exactly `OPEN`; 3. a valid external-capable IPv4 `attacker_ip`; 4. exactly one `INCIDENT_BOUND ... attacker_ip=<ip> source=detector_alert action=CREATED` and exactly one `ALERT_ACCEPTED uid=<u> pid=<p> attacker_ip=<ip> action=CREATED` row, both on that incident; IPs agree; the `ALERT_ACCEPTED` uid equals the configured detector authority (`AEGIS_ALERT_SOURCE_UID`); 5. no durable R3/R4/R5/R8 evidence: no `RECOVERY_R3_REQUESTED`, `RECOVERY_R3_RESULT`, `RESTORE_REQUESTED`, `RESTORE_BREAK_GLASS_CLAIM`, `RECOVERY_R8_CLOSE`, `INCIDENT_CLOSED` or `RECOVERY_STEP` row for the incident, and no NULL-incident `RESTORE_REQUESTED`/`RESTORE_BREAK_GLASS_CLAIM` row after the incident's alert; 6. no prior `INCIDENT_DISPOSED_HISTORICAL` row; 7. the caller's `binding_sha256` equals the digest the Core reconstructs (constant-time compare).

"Oldest incident / no later incident rows" is deliberately NOT a requirement (the preserved DB's other rows are unknown); identity comes from provenance + binding.

**Not claimed (owner correction B):** the system cannot prove a read-only R2/R6/R7 PROBE was never invoked in the past (probe results are process-local and leave no durable R2 row). R1D proves only the mechanically provable absence of durable R3/R4/R5/R8 evidence, absence of a prior disposition and (by the runner) absence of the R1B marker and of Recovery success closeouts. This does not authorise PROBE.

### Binding `R1D_BINDING_V1`

SHA-256 over the canonical UTF-8 bytes of `{"v":"R1D_BINDING_V1","incident":{id,opened_at,closed_at,state,attacker_ip,summary},"incident_bound":{id,timestamp,level,event_type,details,incident_id,hash},"alert_accepted":{...same...}}` serialised with sorted keys, compact separators, ASCII-escaped, `null` for SQL NULL. The Core always reconstructs the bytes itself; the caller's digest is confirmation only and never selects an incident or address. The owner computes the expected value read-only (`read_binding`) from the preserved rows and pins it in the Authorization scope.

### Atomic transaction (owner correction A)

A dedicated helper in `database.py`, modelled on `claim_break_glass`, never `log_event_strict` followed by `close_incident`:

```
with _AUDIT_WRITE_LOCK:
    BEGIN IMMEDIATE
    plan = re-read and re-check the full eligibility predicate and the digest
    CREATE UNIQUE INDEX IF NOT EXISTS ux_audit_historical_disposition ON audit_logs(event_type) WHERE event_type='INCIDENT_DISPOSED_HISTORICAL'
    INSERT the INCIDENT_DISPOSED_HISTORICAL audit row (previous hash from the same transaction)
    UPDATE incidents SET state='CLOSED', closed_at, bounded summary WHERE id=? AND state != 'CLOSED'   -- rowcount must be 1
    COMMIT      (any failure: ROLLBACK of the whole transaction)
notification/log emission only AFTER the durable commit; it never rolls back or repeats the disposition
```

The unique index is created inside the transaction (not at Core startup), so the R1Du restart performs no database mutation. The terminal state is `CLOSED` because every verifier treats `state != 'CLOSED'` as open.

### Audit semantics

`INCIDENT_DISPOSED_HISTORICAL incident=<id> class=R1A_HISTORICAL_FAIL source=R1A_FAIL_IMMUTABLE successor=R1B recovery_r8=NO claims_promoted=NO binding=<64 hex> peer_uid=0 peer_pid=<pid>` (INFO, incident-linked). It is never `RECOVERY_R8_CLOSE` or `INCIDENT_CLOSED`, so `recovery_evidence._r8` reports `BLOCKED NO_CORE_CLOSE_RECORD` for the disposed incident (CLOSED_BY_HISTORICAL_DISPOSITION != R8). Normal `CoreRecoveryService.close()` and R1-R7 gating are unchanged.

## 3. R1D stage (mirrors the proven R1A/R1B pattern)

pregates -> read-only baseline -> regate -> one-shot canonical marker `R1D-GLOBAL-ATTEMPT-CONSUMED` (+ window record) -> ONE Core call -> final proof -> verify -> immutable closeout. A failure before the marker leaves `R1D_ATTEMPT_CONSUMED=NO`; after the marker it is a consumed FAIL with no retry, no cleanup, no reset. Fresh same-day `authorization-R1D.txt` / `k3-R1D.txt` (owner self-attestation K3, exact-main and frozen-runner SHA-256 bound; the Authorization scope names the pinned `binding_sha256`).

Runner pre-gates (root-readable facts the Core cannot see): exact pinned main with replacement objects disabled; unique canonical R1A failure receipt; R1A canonical marker/window present and consistent and the `ALERT_ACCEPTED`/`INCIDENT_BOUND` times inside the R1A window; R1D marker absent; R1B marker/window absent; no R1B success and no Recovery R2-R8 success closeout; exact R1I table; the R1Du closeout and the expected post-R1Du current release; Core/detector identity; the read-only binding equals the owner-authorized value.

Preservation: only one `incidents` row `OPEN -> CLOSED`, one disposition audit row and the hash-chain advance; R1A/R1B markers, the R1I table, `blocked_ipv4`, services, Core and detector identity, release, ESP32, MQTT and physical state are unchanged. Postcondition: `PREEXISTING_OPEN_INCIDENT_COUNT=0`, `R1B_PRECONDITION_HISTORICAL_INCIDENT_CLEARED=YES`, `R1B_ATTEMPT_CONSUMED=NO`, no acceptance promotion.

## 4. R1Du stage

Cloned from the reviewed F1u governed upgrade: immutable release built from the pinned main, controlled `current` switch, ONE governed Core restart (the detector's `Requires=` cycle is the existing owner-approved F1u consequence, handled explicitly and never commanded), narrow rollback authority, no alert, no incident mutation, no R1D execution. Predecessors from the pinned main: F1u closeout, R1I closeout, the unique R1A failure closeout; no R1B/R1D/R1Du success already recorded.

## 5. Threat model (summary)

Arbitrary closure / hiding a later incident: target derived by Core + digest + exact provenance + one-shot index + eligibility requires exactly one open incident that matches the pinned binding. Caller-chosen id/IP: not in the schema. Replay/duplicate: unique index, marker, listener death. Direct protocol access: separate socket, uid 0 only, not on the Recovery protocol. Forged receipt/altered main/stale authorization: pinned-main reads with replacement objects disabled, frozen runner, fresh same-day records. DB tampering: hash-chained audit plus digest (a privileged DB writer is not defended against by any design). Use after R1B/Recovery began: runner requires R1B marker absent and no Recovery success closeout; Core requires no durable R3/R4/R5/R8 evidence.

## 6. R1Du arming and implementation notes (as implemented)

* **Arming.** The channel is inert unless the Core environment carries exactly `AEGIS_R1D_DISPOSITION_ENABLED=YES`. R1Du appends that ONE line to core.env (journaled first; atomic same-directory replace preserving owner/group/mode; every other byte byte-identical in memory-only comparison; core.env content is never printed, hashed or journaled) immediately before its single governed Core restart, and rollback removes exactly the owned suffix before any rollback restart (length derived from the journaled PRE size; a foreign tail refuses). This is the one deliberate deviation from F1u's "never edits core.env" and is an owner decision recorded here.
* **No database mutation by R1Du.** The one-shot unique index is created inside the R1D transaction, not at Core start-up, so the R1Du restart changes no incident or audit row.
* **Socket location.** `<runtime_dir>/historical-disposition.sock` (production: `/run/aegis-idea3/historical-disposition.sock`, the Core's `RuntimeDirectory`, mode 0600, Core-owned). R1Du proves its metadata and that the restarted Core process holds it, without connecting.
* **Observer.** `python -m aegis_soc.historical_disposition {binding,baseline,window-check,final}` is read-only (`mode=ro`); the frozen R1D runner runs it from the immutable verifier snapshot (closure of `historical_disposition`), with the module logger sent to `/dev/null`.
* **Known limitation (R1Du).** Like F1u, R1Du runs the reviewed upgrade tool as root from the pinned worktree; the R1A/R1B immutable-snapshot bootstrap model is not applied to it (R1D does use that model).
* **Not provable and not claimed:** that a read-only R2/R6/R7 probe was never invoked; that no operator ever edited SQLite directly (the hash-chained audit and the digest detect, they do not prevent, a privileged DB writer).
