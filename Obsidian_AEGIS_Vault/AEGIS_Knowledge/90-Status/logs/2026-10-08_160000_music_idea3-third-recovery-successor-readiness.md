---
title: Task Receipt — IDEA3 third Recovery successor contract and offline readiness verifier (tooling only)
date: 2026-10-08T16:00:00+07:00
owner: music
area: idea3
branch: detached HEAD d34d3eb9a07e0e2aa3de98b536518f28b8babb89 (PR #407 recovery sandbox)
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 third Recovery successor contract and offline readiness verifier (tooling only)

## What changed

- Reconciled PR #407 at starting HEAD `d34d3eb9a07e0e2aa3de98b536518f28b8babb89` with a source-only, non-consuming, fail-closed verifier correction. The CTv and CTu consumed-attempt markers are now validated for exact strict key/value schemas, trusted-file boundaries, marker invariants, and pinned runner/bundle evidence; marker filename/existence alone is insufficient. A production transcript with `CURRENT_RUNTIME=PARTIAL` now remains `READINESS=PARTIAL` and exits 3, never an approval-ready result.
- Pins are read only from a reviewed `third-successor-pins.kv` blob at the pinned main (absent today, so everything pin-dependent is UNKNOWN); no flag supplies a pin. PR #402 (attestation, now on main) and PR #406 (release proof, open) are consumed as printed transcripts, never imported or copied. A transcript is a claim: `CURRENT_RUNTIME` never exceeds PARTIAL offline, and a HERMETIC_TEST world is capped below AWAITING_APPROVAL. An attestation binding/readiness digest is rejected as an authorization.
- The existing Recovery predecessor gate, runner template, freeze tool, CTv/CTu scripts, markers and evidence are untouched; the verifier is not registered as a stage or wired into the runner. The proposed third predecessor gate is documented only (risks, migration, required authorization).

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/recovery-acceptance/recovery_third_successor_readiness.py` — verifier.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/recovery-acceptance/THIRD-SUCCESSOR-CONTRACT.md` — blockers, 15-point contract, authorization candidate schema, un-activated gate proposal.
- `IDEA3-AEGIS_Lockdown/tests/recovery/test_recovery_third_successor_readiness.py` — 154 hermetic tests, including absent/malformed/unknown-key, symlinked, hard-linked, writable and incorrect CTu marker evidence, plus the PARTIAL readiness barrier.

## Verification evidence

- `/usr/bin/python3 -m pytest -q tests/recovery/test_recovery_third_successor_readiness.py` — 154 passed. Includes the real `recovery_ctv_successor_gate` refusing a CTv FAIL history (`RECOVERY_CTV_FAIL_CLOSEOUT_PRESENT`) without creating a marker.
- `/usr/bin/python3 -m py_compile deploy/pr11-phase4/recovery-acceptance/recovery_third_successor_readiness.py tests/recovery/test_recovery_third_successor_readiness.py` — pass.
- `/usr/bin/python3 -m pytest -q tests/recovery` — 805 passed, 4 failed. Remaining failures are pre-existing environment/test-seam mismatches outside this task: `tests/recovery/test_recovery_d4_readiness.py::test_the_rehearsal_stops_before_the_recovery_request_boundary_no_secret_no_socket_no_marker` (`EPERM` binding UNIX socket), `tests/recovery/test_recovery_runner_authority.py::test_the_correct_root_owned_production_shape_passes_the_control_and_snapshot_gates`, `tests/recovery/test_recovery_runner_freeze.py::test_the_test_seam_is_refused_in_the_real_root_namespace`, and `tests/recovery/test_recovery_snapshot_freeze.py::test_the_test_seam_is_refused_in_the_real_root_namespace` (expected test-seam refusal text is pre-empted by `/tmp` ownership validation).
- `git diff --check` — pass. No live Recovery, attempt consumption, marker mutation, Production, credentials, hardware, staging, commit, push, merge, or main merge was performed.
- `pytest tests/recovery tests/rru tests/r1bv tests/test_recovery_stage.py tests/test_pr11_phase4_harness.py` — 1353 passed, 3 failed (before merging main; 1108 passed, 3 failed on the impacted subset after it) (the known stale stage-order tests, identical on unchanged main).
- Release-builder, guard/installer, l7u, CTv and CTu suites — 5 failed, 56 errors (`No module named pip`), identical to a worktree at exact main 6ed42345 reproduced earlier in this session.
- `git diff --check` and vault validation — see the PR.

## Canonical notes updated

- Existing PR407 receipt reconciled in place; no new receipt created.

## Shared surfaces touched

- `None` — IDEA3-owned paths only

## Integration requests

- None — valid only when no cross-scope/shared path changed

## Known limitations

- Not run against Production. The full repository suites remain outside this correction's claim boundary and were not represented as PASS. Still required from the Human Owner or a separate governance decision: the reviewed pins file (CTv closeout/marker/unit, detector unit, release sums, successor authority id), a live attestation at approval time, Restore/CUT restrictions (undefined in any reviewed source), same-day Authorization and K3, and independent review of the successor authority.
- Dependencies: PR #402 and #403 merged into main during this task (main 2cb731ae, merged into this branch); PR #406 (release proof) is still open and is consumed only as a transcript.
