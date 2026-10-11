# Third governed Recovery successor — contract and offline readiness verifier

Status: **SOURCE-ONLY. NOT AN AUTHORIZATION. NOT A STAGE. NOT WIRED INTO RECOVERY.** Nothing here changes, replaces or reinterprets the CTv/CTu history or the existing Recovery
predecessor gate.

## Why Recovery is blocked today (separate causes)

| Cause | Kind | Source |
|---|---|---|
| CTu `FAIL_IMMUTABLE`, attempt consumed, no rerun | Immutable history | `recovery_ctv_successor_gate` requires CTu FAIL (`APPLY`) |
| CTv `CLOSED_FAIL` (historical S10 FAIL), attempt consumed, no rerun | Immutable history | the gate requires `CTV_RESULT=CLOSED_PASS`; a FAIL closeout is `RECOVERY_CTV_FAIL_CLOSEOUT_PRESENT` |
| No reviewed third-successor authority, pins file or Authorization | **Missing evidence / governance** | not in the repository |
| Release/CLI/detector/release-sums pins | Missing evidence | PR #406 (open) derives release identity; sums and detector pins need the Human Owner |
| Fresh runtime, R1I/R1B/R1Bv, TrustedClock | Missing fresh evidence | PR #402 attestation (live, read-only) |
| Restore/CUT restrictions of a successor | **Undefined** | no reviewed source defines them (REQUIREMENT_RESTORE_CUT_RESTRICTIONS stays UNKNOWN) |

New successor feasibility is not Recovery permission: the existing gate keeps refusing until a *separately reviewed and authorized* change defines a third predecessor path.

## Contract (what any third successor must satisfy; each is reported by the verifier)

1. Original CTv immutable failure (closeout schema exact: `FAIL_IMMUTABLE`, `CLOSED_FAIL`, S10 `FAIL`, not promoted, no rerun).
2. Exact canonical closeout digest (pin from a reviewed Git blob; sidecar must agree).
3. Consumed-attempt markers (CTv, CTu consumed; no `RECOVERY-*` entry; exactly one marker, one FAIL closeout, one sidecar).
4. Historical S10 failure preserved.
5. Root trust boundaries (evidence files: regular, single link, root/operator owned, not group/world writable, symlink-free path chain).
6. Current runtime identity (fresh live attestation; an offline transcript is a claim, capped at PARTIAL).
7. Release and restore-CLI pins (PR #406 proof bound to the same main, and a reviewed release-sums pin).
8. Detector identity (reviewed `DETECTOR_UNIT_SHA256` pin).
9. Fresh R1I and R1B/R1Bv predecessor facts.
10. TrustedClock and event provenance.
11. Single-attempt semantics (no `RECOVERY-*` entry; the authorization declares `AUTH_SINGLE_ATTEMPT=YES`).
12. Non-retry constraints (`AUTH_IS_CTV_RETRY=NO`, `AUTH_INHERITS_PREVIOUS_AUTHORIZATION=NO`).
13. Restore/CUT restrictions — **undefined; needs a governance decision**.
14. Same-day owner Authorization and K3 (structure and binding checked offline; authenticity and K3 are live-gate checks).
15. Independently reviewed successor authority (`THIRD_SUCCESSOR_AUTHORITY_ID` pin in the exact-main `third-successor-pins.kv`).

An attestation `BINDING_SHA256` / `READINESS_SHA256` is an integrity digest, never an authorization token; the verifier rejects it as one.

## The verifier — `recovery_third_successor_readiness.py`

`python3 -I -B recovery_third_successor_readiness.py --repo <worktree at exact main> --main <sha> [--canon DIR] [--attestation FILE] [--release-proof FILE] [--authorization FILE]`

Prints `HISTORICAL_EVIDENCE`, `CURRENT_RUNTIME`, `RELEASE_CLI`, `OWNER_AUTHORIZATION`, `READINESS` and the 15 `REQUIREMENT_*` statuses, then
`RECOVERY_AUTHORIZED=NO`, `RECOVERY_EXECUTED=NO`, `PRODUCTION_MUTATION=NO`, and a `REPORT_SHA256`. Exit: 1 FAIL, 2 BLOCKED, 3 PARTIAL, 4 AWAITING_APPROVAL — **never 0**.
Pins come only from the reviewed blob `third-successor-pins.kv` at the pinned main (absent today ⇒ everything pin-dependent is UNKNOWN); no flag can supply one.
A HERMETIC_TEST world is capped below AWAITING_APPROVAL. More generally, `CURRENT_RUNTIME=PARTIAL` is never promoted to `READINESS=AWAITING_APPROVAL`; transcript-backed or hermetic evidence remains explicitly partial and exits 3. The verifier writes nothing, creates no marker, and issues no restore, CUT, restart, firmware or MQTT action.
The canonical CTu consumed-attempt marker is evidence, not a filename-only signal. It must be read through the trusted-file boundary (regular single-link file, root/operator ownership, non-writable mode, symlink-free path chain and `O_NOFOLLOW`) and contain the exact governed key set: `CTU_ATTEMPT_CONSUMED=YES`, `CTU_RERUN_ALLOWED=NO`, a valid device id, valid pinned runner and bundle-manifest SHA-256 values, a positive consumed epoch, the absolute work path, and the five non-negative pre-boundary counters with the open-episode invariant. Missing, malformed, symlinked, hard-linked, writable, unknown-key or mismatched marker evidence blocks the report. CTv marker evidence is subject to the same strict key/value and pinned runner requirements.
Dependencies on unmerged work are consumed as printed transcripts (data), never imported: PR #402 (attestation; merged into main as d9bda3ab) and PR #406 (release proof; still open at preparation time, so its transcript may be absent). PR #403 (rehearsal; merged) is not required.

## Owner authorization candidate (`recovery-third-successor-authorization-v1`)

Exact keys: `AUTH_SCHEMA AUTH_ID AUTH_DATE_UTC AUTH_MAIN AUTH_CTV_CLOSEOUT_SHA256 AUTH_STAGE AUTH_IS_CTV_RETRY AUTH_INHERITS_PREVIOUS_AUTHORIZATION AUTH_SINGLE_ATTEMPT AUTH_K3_BINDING_SHA256 AUTH_REVIEWED_SUCCESSOR_AUTHORITY_ID`.
`PRESENT_NOT_EXECUTED` means "well-formed and bound", nothing more.

## Proposed operational change — DOCUMENTED ONLY, NOT ACTIVATED

A third predecessor path (`recovery_ctv_fail_successor_gate`) alongside the CTu-PASS and CTv-PASS paths would have to: require this verifier's inputs from a *live* attestation, bind to the reviewed pins file and authority id, keep `RECOVERY_ALREADY_CONSUMED` semantics, and never read CTv as PASS.
Risks: widening the only-ever-one-attempt rule; trusting a transcript instead of a live check; the undefined Restore/CUT scope. Migration: a new reviewed gate function, a re-frozen runner template and digests, new stage-order tests, and a fresh frozen runner. Required before activation: a written Human Owner decision naming the exact change, independent review, and a separate Authorization/K3. Not done here.
