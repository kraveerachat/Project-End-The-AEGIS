---
title: Task Receipt — IDEA3 Recovery release / restore-CLI trusted proof verifier (tooling only)
date: 2026-10-08T14:00:00+07:00
owner: music
area: idea3
branch: feat/idea3-recovery-release-cli-proof
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 Recovery release / restore-CLI trusted proof verifier (tooling only)

## What changed

- Added `recovery_release_proof.py`, a non-mutating, repository-only verifier on main `6ed423457e3b886b9cecdfc25b9a0eca7a2c2671`. It derives the deployed Recovery release identity from the reviewed RRu LIVE closeout receipt (a 40-hex commit), checks that the closeout's aegis_soc files equal the git blobs at that commit, and derives the restore CLI, Recovery Core and production-detector digests from those blobs. With `--host` it re-checks the release tree, `current` link, owner and trusted path chain through the reviewed validators (`p4-l7-release-guard.py check`, `recovery_verifier_snapshot.py`). With `--frozen-runner` it compares the runner's pins to the derived values. The host-proof boundary now converts undecodable/unreadable guard input and malformed checksum parsing into deterministic exit-1 refusals with no traceback; existing security checks remain fail-closed.
- Verdicts: PASS (exit 0) means release and restore-CLI identity only; PARTIAL (exit 3) lists every UNKNOWN input; FAIL (exit 1) rejects missing, ambiguous, modified or untrusted authority and fake or self-invented pins. Output is deterministic and ends with `PROOF_SHA256`. Every other claim is `NOT_PROVEN_BY_THIS_TOOL`. It never authorizes Recovery.
- Tool files are hashed against the exact-main git blobs before they are loaded. No frozen runner, Recovery gate, closeout, Production marker or CTv/CTu authority was edited. PR #402 and #403 branches were not touched.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/recovery-acceptance/recovery_release_proof.py` — verifier.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/recovery-acceptance/RECOVERY-RELEASE-PROOF.md` — usage, derived versus owner-supplied inputs, limits.
- `IDEA3-AEGIS_Lockdown/tests/recovery/test_recovery_release_proof.py` — 71 focused hermetic tests, including the original 9 mutation tests and 3 added malformed-checksum regressions.

## Verification evidence

- `pytest -q tests/recovery/test_recovery_release_proof.py` — 71 passed (the original positive/negative, authority, seam, no-mutation, agreement, history and mutation coverage plus 3 malformed/undecodable `RELEASE-SHA256SUMS` regressions; all assert no traceback and exit-1 refusal).
- Smoke on real history: `VERDICT=PARTIAL`, `RELEASE_ID=954ce1c191885e9e90198a6f54a3d990bcf144fc`, `UNKNOWN_INPUTS=HOST_RELEASE_AND_CLI_STATE,RELEASE_SUMS_SHA256`.
- Regression batch 1 (`tests/recovery`, `tests/rru`, `tests/r1bv`, `test_recovery_stage`, harness): 1279 passed, 3 failed. The 3 are the known stale stage-order/registration tests: two R1Bv tests still require `CTu` to be immediately followed by `Recovery`, while the current tree has `CTv` in between; the harness test still rejects the existing `CTv` directory. These are outside the four PR406 paths and unrelated to this correction.
- Regression batch 2 (release builder, guard and installer helpers, l7u release-builder recovery runtime, CTv/CTu suites): 5 failed, 56 errors on this branch and on a worktree at exact main 6ed42345 (`No module named pip` in the builder tests; environmental). One further transient failure in `test_ctv_incident_option_b.py` appeared once in a batch run (`CTU_CORE_ENV_MISSING_OR_SYMLINK`) and did not reproduce: that file passes 85/85 in 3 isolated runs on both trees.
- `git diff --check`, vault validation — see the PR.

## Canonical notes updated

- `None` — no durable project fact changed.

## Shared surfaces touched

- `None` — IDEA3-owned paths only

## Integration requests

- None — valid only when no cross-scope/shared path changed

## Known limitations

- Not run against a Production host. `RELEASE_SUMS_SHA256` and the venv content cannot be derived from the repository and need an owner-supplied pin checked on the host. `DETECTOR_UNIT_SHA256` and the other Recovery pins, a real frozen runner, snapshots and the same-day Authorization/K3 are still required from the Human Owner.
- Hermetic fixtures are synthetic and prove the verifier logic, not Recovery readiness.
- Source-only correction: no Recovery stage was executed, no attempt was consumed, no Production host was accessed, and no frozen CTu/CTv evidence or real host proof file was changed.
