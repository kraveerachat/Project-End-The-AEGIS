# IDEA3 R1Bv — read-only successor validation of the existing failed R1B evidence (design)

Status: repository design and implementation, 2026-10-06. IMPLEMENTED != LIVE EXECUTED != PASS. Nothing here has run live; no Authorization exists.

## 1. Why this exists

R1B ran once under the frozen runner, consumed its attempt, observed a genuine external event and then closed `R1B_RESULT=FAIL_IMMUTABLE` at `windowrecord`: after the bounded observation the durable `R1B-ATTEMPT-WINDOW` could not be written because sudo authentication had expired. The final capture and verifier were never reached. R1B is never rerun and never rewritten.

R1Bv (owner-authorized) is a NEW governed stage that validates the EXISTING evidence read-only. It is not an R1B retry, a replay, a new window, a new event, or a repair of the missing record.

## 2. Governance class

NON-MUTATING (`p4_stage_mutates R1Bv` is false; same model as R1Dv): fresh same-day Authorization, no K3, no Production attempt marker, no rollback handler. It creates no R1B marker or window record, opens no mutation socket, writes no SQLite, alters no incident, appends no audit row, restarts nothing, changes no nftables state, generates no traffic or alert, touches no ESP32. Stage evidence captures and a root-private work directory are normal stage output.

## 3. Authority model

Root executes only reviewed code from immutable, root-owned, manifested snapshots built from a root-owned exact-main authority (Git replacement objects disabled; trust chain to `/`; frozen runner = reviewed template + the exact allowlisted pins). The verifier snapshot closure is the union of every executed entry point: `r1bv_validation` and `trusted_time` plus transitive local imports (which include `r1_acceptance`, `production_detector`, `recovery_evidence`, `ip_containment`). No mutable worktree Python runs as root during LIVE. The runner pins carry no repository constant for any private detail: the expected source IPv4, the R1B evidence directory and the R1B authorization directory are LIVE pins, as are the audit DB path, the detector uid and the digests.

## 4. Historical time authority (no window record, no widening)

There is NO durable `R1B-ATTEMPT-WINDOW` and R1Bv never creates, reconstructs or names one. The validation bound is a derived R1Bv value only:

- PRIMARY lower bound `L`: the root-owned canonical marker `/var/lib/aegis-idea3-governance/R1B-GLOBAL-ATTEMPT-CONSUMED`, read by the observer itself as root with `lstat`/`O_NOFOLLOW`: regular file, single link, owned by uid 0, not group/world writable, every ancestor up to `/` a real directory owned by uid 0 and not group/world writable, content exactly `consumed_at=<UTC second>`, and the content second agrees with the file's modification time. `L` is the file's `st_mtime_ns` (the durable creation time, which precedes the R1B window start).
- Deadline `D = L + 600` (the pinned observation duration; a constant, any other value is refused). No grace, no skew widening.
- CORROBORATION ONLY (never authority): the authorization-local marker `consumed_epoch` and the preserved runner output `R1B_WINDOW_START_EPOCH`. Each must exist, parse, and lie within 2.0 s of `L`; a missing, malformed or materially disagreeing record FAILS CLOSED. They can neither set nor move the bound.
- Every evidence time must lie inside `[L, D]` (audit rows are whole-second values, i.e. rounded down, so a row second must be `>= floor(L)` and `<= D`; journal and source events must be `>= L` and `<= D`). The existing `r1_acceptance` verifier tolerates a 2 s skew; R1Bv feeds it only evidence pre-filtered to `[L, D]` and then re-checks every chain time strictly, so the skew can never admit post-bound or pre-marker evidence.

## 5. Evidence validation (existing evidence only, no weaker parallel interpretation)

R1Bv reuses the fail-closed `r1_acceptance.verify` (unchanged) over the PRESERVED R1B baseline `r1-baseline.json` (root-owned, in the root-private R1B work directory; absent/unreadable/malformed/inconsistent fails closed; it is never invented) and a final record built from the journal and Core database now:

- genuine kernel-origin source event reconstructed with the detector's own rule from journald-trusted metadata; detector alert line `SENT_BOUND` from the detector PID of the baseline; Core `ALERT_ACCEPTED uid=<detector uid> pid=<detector pid> ... action=CREATED`; exactly one NEW incident (`id` above the baseline maximum) that is OPEN with exactly one `INCIDENT_BOUND ... source=detector_alert action=CREATED`; causal order source -> detector -> Core rows; no unrelated alert rows; the Recovery evidence `R1` gate VERIFIED (that gate verifies the detector relationship/provenance of the incident; it does NOT verify the audit hash chain); Core and detector identity unchanged since the baseline.
- R1Bv adds an EXPLICIT, separate audit hash-chain integrity check (`R1BV_AUDIT_INTEGRITY`): the repository's existing `historical_disposition._chain_valid` (over `database._compute_hash`) on one read-only, consistent in-memory view of `audit_logs`; a broken chain fails closed (`AUDIT_CHAIN_BROKEN`). Chain integrity is NOT conflated with the semantic provenance predicates (`R1BV_AUDIT_PROVENANCE`).
- R1Bv adds: the incident `attacker_ip` equals the LIVE-pinned expected source (externally capable IPv4 only); the preserved baseline identity (`release_id`, `detector_sha256`, `detector_uid`) must EQUAL the frozen runner pins (passed through the immutable handler environment; the baseline is never rewritten to match, and every identity pin is load-bearing) and the immutable snapshot's `production_detector.py` must equal the pinned deployed-detector digest; the baseline precedes `L` closely (it is the pre-consume baseline); every chain time is strictly inside `[L, D]`.
- Rejected by construction: direct alert-socket injection, synthetic journal lines, self-connect, an unrelated or second new incident, `EXISTING` instead of `CREATED`, a source mismatch, post-bound or pre-marker evidence.

## 6. Preservation and sequencing

pregates -> PRE capture -> TrustedClock PRE available -> observer BASELINE (full validation + a no-mutation fingerprint) -> POST capture -> TrustedClock POST available -> PRE->POST comparison (no allowed drift) -> fresh authority/lifecycle/R1I gates -> observer FINAL (full re-validation; the fingerprint must be unchanged: audit maximum id, incident set, canonical marker identity and mtime, no `R1B-ATTEMPT-WINDOW`, Core/detector identity) -> immediate verify. Current TrustedClock evidence (`SYNCED`/`HOLDOVER`/`UNTRUSTED` only; `UNKNOWN`/`UNAVAILABLE`/`NOT_RECORDED` refused) proves the R1Bv environment only and is NEVER presented as the historical R1B clock state. R1I must remain installed (the exact table). There is no observation sleep.

## 7. Sudo credential handling

R1Bv has no long wait, so a sudo password prompt cannot expire mid-stage. The runner authenticates ONCE (`sudo -v`, the single interactive boundary) and sets the libraries' `$SUDO` to `sudo -n` BEFORE sourcing them; every later privileged command is itself `sudo -n` (captures, capture checksum verification, work-directory creation, ownership hand-back, handlers and every library gate), and a `sudo -n true` check still precedes every privileged phase so a lapsed credential refuses the phase with an explicit reason BEFORE any work. The failure path invokes NO privileged command (R1Bv owns nothing to roll back, so the rollback handler is never called): it cannot prompt either. Tests simulate an expired credential with a stub `sudo` and prove every invocation is `-n`, no prompt-capable `sudo` runs, nothing is created and the failure path makes zero sudo calls. Root authority is not weakened.

## 8. Result and claim boundary

A future success is `R1BV_RESULT=PASS` with `R1BV_IS_R1B_RETRY=NO` and `R1BV_READ_ONLY_VALIDATION_ONLY=YES`. It never writes `R1B_RESULT=PASS` or `R1B_LIVE=CLOSED_PASS`; R1B stays `R1B_RESULT=FAIL_IMMUTABLE` (`R1B_RESULT_REWRITTEN=NO`). Repository implementation alone keeps `R1BV_LIVE_EXECUTED=NO`, `RECOVERY_R2_R8_EXECUTED=NO`, `F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN`, `R1_VERIFIED=NOT_CLAIMED`, `RECOVERY_R1_R8_PROVEN=NO`. Governed (mechanically validated) fields are kept apart from owner-reported observations; the closeout receipt must label owner-reported facts as such and must not use `PROVEN` for an observation the stage did not itself validate.

## 9. Future R1Bv LIVE PASS closeout contract (not created here)

Unique `<timestamp>_music_idea3-r1bv-live-closeout.md`, whole-line fields: `R1BV_LIVE=CLOSED_PASS`, `R1BV_LIVE_EXECUTED=YES`, `R1BV_RESULT=PASS`, `R1BV_VERIFY=PASS`, `R1BV_IS_R1B_RETRY=NO`, `R1BV_READ_ONLY_VALIDATION_ONLY=YES`, `R1BV_NEW_EXTERNAL_EVENT_GENERATED=NO`, `R1BV_EXISTING_R1B_EVIDENCE_ONLY=YES`, `R1BV_INCIDENT_MUTATED=NO`, `R1BV_R1B_MARKER_MUTATED=NO`, `R1BV_WINDOW_RECORD_CREATED=NO`, `R1BV_WINDOW_RECORD_RECONSTRUCTED=NO`, `R1BV_CANONICAL_MARKER_TIME_AUTHORITY=PASS`, `R1BV_HISTORICAL_BOUND=PASS`, `R1BV_EXPECTED_SOURCE_BOUND=PASS`, `R1BV_REAL_DETECTOR_CHAIN=PASS`, `R1BV_NEW_INCIDENT_CREATED_SEMANTICS=PASS`, `R1BV_AUDIT_PROVENANCE=PASS`, `R1BV_AUDIT_INTEGRITY=PASS`, `R1BV_R1I_STATE=PASS`, `R1BV_TRUSTEDCLOCK_EVIDENCE_AVAILABLE=YES`, `R1BV_PRESERVATION_S10=PASS`, `R1BV_COMPARE_RESULT=PASS`, `R1B_RESULT=FAIL_IMMUTABLE`, `R1B_RESULT_REWRITTEN=NO`, `RECOVERY_R2_R8_EXECUTED=NO`, `F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN`, `R1_VERIFIED=NOT_CLAIMED`, `RECOVERY_R1_R8_PROVEN=NO`.

## 10. Recovery predecessor reconciliation

No Recovery R2-R8 stage handler exists in this repository yet, so there is no existing Recovery predecessor gate to edit. R1Bv ships the reusable fail-closed gate `r1bv_recovery_predecessor_gate` (library `p4-r1bv-run-lib.sh`) that any future Recovery stage must call. Under the owner-approved history R1B is permanently `FAIL_IMMUTABLE`, so there is exactly ONE accepted successor history: the unique truthful R1B immutable FAILURE closeout PLUS the unique R1Bv LIVE PASS closeout. There is no legacy R1B PASS path and none is added.

It rejects: an R1B failure alone, R1Bv implementation alone, an R1Bv FAIL, duplicate or ambiguous closeouts, contradictory PASS and FAIL histories, any R1Bv mutation / retry / window-record / new-event claim, any R1B PASS or rewrite claim. Every positive R1Bv live-result claim (`R1BV_LIVE=CLOSED_PASS`, `R1BV_LIVE_EXECUTED=YES`, `R1BV_RESULT=PASS`, `R1BV_VERIFY=PASS` and the mechanically proven `R1BV_*=PASS` checks) must resolve to the SAME single canonical `*_music_idea3-r1bv-live-closeout.md`; an extra, misnamed, bare or split-field receipt is ambiguity. It is one predecessor, not the whole Recovery gate (the other prerequisites stay).
