# AEGIS IDEA3 R1A Real Detector Acceptance — Stage Design (repository only)

Status: repository implementation only. `R1A_REPOSITORY_IMPLEMENTED=YES`, `R1A_LIVE_EXECUTED=NO`. Nothing here is deployed, run against Production or authorised.

## Governance (fixed by the owner)

- Final stage id `R1A`, registered after `R1I` and before `L8`. A MUTATING governed stage: a genuine external event may durably create `ALERT_ACCEPTED`, `INCIDENT_BOUND` and an OPEN incident.
- ONE attempt, NO retry. Once `R1A-ATTEMPT-CONSUMED` exists, any failure ends the attempt (`R1A_RESULT=FAIL`, `R1A_RERUN_ALLOWED=NO`).
- The event must be GENUINE and EXTERNAL. No repository script generates traffic, an alert, a journal line, a Core socket write or a database write.
- Genuine evidence is never deleted, closed, edited or rolled back to restore PRE. The rollback handler is evidence-preserving and performs no action.
- `R1I` (`inet aegis_idea3_r1i`, runtime-only) stays installed throughout. Recovery R2-R8 stays blocked until R1A/R1 succeeds.

## Foundation reused (not reimplemented)

`aegis_soc/r1_acceptance.py` is the read-only observer and fail-closed verifier. It already proves: exactly one new OPEN incident against the baseline, the attacker IP, `ALERT_ACCEPTED` (peer uid/pid) and `INCIDENT_BOUND`, the detector's own journal line and PID, strict trusted-source provenance (`_TRANSPORT=kernel` with empty `_SYSTEMD_UNIT` for `AEGIS_NEWCONN`), exact threshold/window reconstruction, and Core/detector service continuity. It is unchanged. A direct write to the Core alert socket by any other process fails the detector-PID check; a forged journal line fails the trusted-source check. Its automatic result carries `F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN` and `R1_VERIFIED=NOT_CLAIMED` for every outcome.

## Components

- `deploy/pr11-phase4/stages/R1A/` — `apply.sh` (guarded read-only `BASELINE` / `FINAL` steps, each at most once per work dir), `verify.sh` (narrow result re-read), `rollback.sh` (evidence-preserving, no action), `allow-keys.txt` (approves no generic drift), `allow-listeners.txt`.
- `deploy/pr11-phase4/p4-r1a-run-lib.sh` — one-attempt marker, predecessor receipt gates, host gates and `r1a_run_attempt`, the fixed state machine driven by runner-supplied hooks.
- `deploy/pr11-phase4/owner-run/run-r1a-owner.sh` — inert template; refuses while any `PIN_` value remains.

## Attempt ordering

Pre-auth gates (exact main, source integrity, runner integrity, fresh Authorization and K3, predecessor receipts, disk, operator, R1I present in the exact owned shape, Core and detector healthy, detector source/unit authority, current release, trusted journal access, no R1A success recorded, marker absent) → immutable R1 baseline (refuses a pre-existing open incident) → re-gate → exclusive marker → observation window opens → bounded observation (no event generated) → final capture and the ONE verifier run → generic POST compare (no approved drift) → result.

## Predecessor gates

Pinned-commit receipt content, never PR numbers: the F1 closeout, the R1 foundation, the F1u closeout (naming the pinned release as installed and activated), and the R1I LIVE closeout (`R1I_LIVE=CLOSED_PASS`, executed, deployed, attempt consumed, rerun not allowed, `PRODUCTION_NFT_NORMALIZATION=PASS_OBSERVED_LIVE`, claims still unproven). Exactly one canonical receipt each; contradictory, duplicate or already-recorded R1A state refuses.

## Drift and preservation

Core and detector lifecycle, `current`, the L2 table (including `blocked_ipv4`), the R1I table, listeners and all other captured keys must be identical PRE → POST; there is no approved generic drift. The audit-DB evidence is checked by the dedicated verifier, not by widening generic allow-lists.

## Claim boundary

A future successful run may print `R1_EVIDENCE_VERIFIED=YES` and `REAL_DETECTOR_CHAIN_VERIFIED=YES`, but automatic code never promotes `F1_REAL_DETECTOR_ACCEPTANCE` or `R1_VERIFIED`; that needs a separately reviewed LIVE closeout after independent inspection. `RECOVERY_R1_R8_PROVEN=NO`.
