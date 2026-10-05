# AEGIS IDEA3 R1A Real Detector Acceptance — Stage Design (repository only)

Status: repository implementation only. `R1A_REPOSITORY_IMPLEMENTED=YES`, `R1A_LIVE_EXECUTED=NO`. Nothing here is deployed, run against Production or authorised.

## Governance (fixed by the owner)

- Final stage id `R1A`, registered after `R1I` and before `L8`. A MUTATING governed stage: a genuine external event may durably create `ALERT_ACCEPTED`, `INCIDENT_BOUND` and an OPEN incident.
- ONE attempt, NO retry. Once `R1A-ATTEMPT-CONSUMED` exists, any failure ends the attempt (`R1A_RESULT=FAIL`, `R1A_RERUN_ALLOWED=NO`).
- The event must be GENUINE and EXTERNAL. No repository script generates traffic, an alert, a journal line, a Core socket write or a database write.
- Genuine evidence is never deleted, closed, edited or rolled back to restore PRE. The rollback handler is evidence-preserving and performs no action.
- `R1I` (`inet aegis_idea3_r1i`, runtime-only) stays installed throughout. Recovery R2-R8 stays blocked until R1A/R1 succeeds.

## Foundation reused (not reimplemented)

`aegis_soc/r1_acceptance.py` is the read-only observer and fail-closed verifier. It already proves: exactly one new OPEN incident against the baseline, the attacker IP, `ALERT_ACCEPTED` (peer uid/pid) and `INCIDENT_BOUND`, the detector's own journal line and PID, strict trusted-source provenance (`_TRANSPORT=kernel` with empty `_SYSTEMD_UNIT` for `AEGIS_NEWCONN`), exact threshold/window reconstruction, and Core/detector service continuity. The existing acceptance predicates and claim boundary are unchanged; the result document is extended only with sanitized informational `evidence_times` used by the separately governed R1A window binding (the file is NOT byte-unchanged). A direct write to the Core alert socket by any other process fails the detector-PID check; a forged journal line fails the trusted-source check. Its automatic result carries `F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN` and `R1_VERIFIED=NOT_CLAIMED` for every outcome.

## Components

- `deploy/pr11-phase4/stages/R1A/` — `apply.sh` (guarded read-only `BASELINE` / `FINAL` steps, each at most once per work dir), `verify.sh` (narrow result re-read), `rollback.sh` (evidence-preserving, no action), `allow-keys.txt` (approves no generic drift), `allow-listeners.txt`.
- `deploy/pr11-phase4/p4-r1a-run-lib.sh` — one-attempt marker, predecessor receipt gates, host gates and `r1a_run_attempt`, the fixed state machine driven by runner-supplied hooks.
- `deploy/pr11-phase4/owner-run/run-r1a-owner.sh` — inert template; refuses while any `PIN_` value remains.

## Review-repair bindings

- **Source IP.** `EXPECTED_SOURCE_IP` is pinned (canonical, external-capable IPv4) and the accepted incident's `attacker_ip` must equal it (`verify.sh`, before `R1A_VERIFY=PASS`).
- **Marker-bounded window.** Window START is sampled strictly AFTER the canonical stage-global marker has been created (if the local marker then fails the attempt stays consumed); END is recorded when the bounded wait completes, before the final capture. The unchanged verifier adds informational `evidence_times`; `verify.sh` requires the completing source event(s), the detector alert, `ALERT_ACCEPTED` and the incident inside the window. The baseline stays before the marker, as approved.
- **Immutable verifier authority.** The verifier root executes is a read-only snapshot of the full local import closure of `r1_acceptance` (built by `r1a_verifier_snapshot.py`, pinned by manifest digest, byte-identical to the pinned-main source, with the deployed detector digest). It is re-proved before BASELINE, before the marker and immediately before FINAL; handlers are re-proved against the pinned-main git objects. Residual: the root-owned interpreter and its stdlib/site packages are host authority (gated as root-owned and not writable), not snapshotted.
- **One attempt TOTAL.** ONE canonical stage-global marker whose location is fixed by the stage contract (`/var/lib/aegis-idea3-governance`, root-owned, readonly constant that overrides any environment value, no per-runner pin; the only mutation R1A governance owns there is the one exclusive creation of the consumption record and, once, the window record), plus the authorization-local marker. It survives the same or a successor runner, any AUTH_DIR, fresh Authorization/K3, a new day and a successor main; nothing removes, resets or relocates it.

## Final hardening

- **Immutable control plane.** `control-snapshot` copies the whole `deploy/pr11-phase4` tree (a deliberate superset) into a read-only manifested directory; the frozen runner pins its directory and manifest digest. Control snapshot integrity AND pinned-main byte equality are proven inline in the frozen runner before any control-snapshot shell is sourced (boot order: `control_gate`, then `control_git_gate`, then the first `source`); both are re-run later by `authority_gates` and the integrity gate again before every root execution. Tampering with the R1A library, a transitive library, a stage handler, the stage gate, capture or compare, or adding an extra, symlinked or writable file, fails closed.
- **Mandatory window record.** Created exclusively after the wait; a failure is a consumed `R1A_RESULT=FAIL` with evidence preserved and no final capture or verifier run. An existing or orphan record fails closed.
- **Audit-row granularity.** Whole-second Core audit times cannot prove an exact `[start, end]` predicate and none is claimed. Source event(s) and the detector alert are exact; the incident and `ALERT_ACCEPTED` rows are bound causally (the Core writes them before the detector logs its alert line, and the verifier requires one alert line, one row and one incident for the detector's PID) and must satisfy `floor(start) <= stored <= end` with no post-deadline grace.

## Round 5 repairs

- **Root-owned snapshots.** The control and verifier snapshots must be owned by uid 0 with trusted (root-owned, non-group/world-writable, symlink-free) ancestors up to `/`; enforced inline by the runner, by the snapshot tool's production defaults, by the library gate and by `apply.sh` before root starts the verifier. The freeze tool's `--root-owned` mode (root only) installs the snapshot `root:root` and refuses an untrusted parent.
- **Replace refs.** Git authority reads run with replacement objects disabled on every call and name the pinned commit (`EXPECTED_MAIN:path`), never `HEAD:path`; the pinned commit is validated as a commit object and HEAD must equal it.
- **Audit causality.** The Core writes its rows before it replies and the detector logs its alert line after the reply, so the verifier now requires every stored audit second (incident, `INCIDENT_BOUND`, `ALERT_ACCEPTED`) to be not later than the detector's alert line time (`AUDIT_ROW_AFTER_DETECTOR_ALERT`).

## Attempt ordering

Pre-auth gates (exact main, source integrity, runner integrity, fresh Authorization and K3, predecessor receipts, disk, operator, R1I present in the exact owned shape, Core and detector healthy, detector source/unit authority, current release, trusted journal access, no R1A success recorded, marker absent) → immutable R1 baseline (refuses a pre-existing open incident) → re-gate → exclusive marker → observation window opens → bounded observation (no event generated) → final capture and the ONE verifier run → generic POST compare (no approved drift) → result.

## Predecessor gates

Pinned-commit receipt content, never PR numbers: the F1 closeout, the R1 foundation, the F1u closeout (naming the pinned release as installed and activated), and the R1I LIVE closeout (`R1I_LIVE=CLOSED_PASS`, executed, deployed, attempt consumed, rerun not allowed, `PRODUCTION_NFT_NORMALIZATION=PASS_OBSERVED_LIVE`, claims still unproven). Exactly one canonical receipt each; contradictory, duplicate or already-recorded R1A state refuses.

## Drift and preservation

Core and detector lifecycle, `current`, the L2 table (including `blocked_ipv4`), the R1I table, listeners and all other captured keys must be identical PRE → POST; there is no approved generic drift. The audit-DB evidence is checked by the dedicated verifier, not by widening generic allow-lists.

## Claim boundary

A future successful run may print `R1_EVIDENCE_VERIFIED=YES` and `REAL_DETECTOR_CHAIN_VERIFIED=YES`, but automatic code never promotes `F1_REAL_DETECTOR_ACCEPTANCE` or `R1_VERIFIED`; that needs a separately reviewed LIVE closeout after independent inspection. `RECOVERY_R1_R8_PROVEN=NO`.
