---
title: Task Receipt — IDEA3 CTv incident disposition Option B (prepared)
date: 2026-10-08T09:17:11+07:00
owner: music
area: idea3
branch: fix/idea3-ctv-incident-disposition-option-b
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 CTv incident disposition Option B (prepared)

## What changed

Source-only preparation of the CTv consumed-attempt incident disposition, Option B (retain the installed target Core unit, no additional restart), from merged main `d34b535fbad130e7423b37c2bece8812c4ea6e51`. Nothing was authorized or executed; no closeout was written.

- a read-only verifier that does not use the broken `ctv_host_runtime_verify` or the historical S10 comparison;
- a separately governed disposition action that can record one truthful append-only `CTV-GLOBAL-CLOSEOUT-FAIL` (rollback incomplete, target unit retained, S10 FAIL not promoted, no Recovery authority);
- a shared Production guard; hermetic tests; the exact Production action proposal in `CTV-INCIDENT-DISPOSITION.md`.

Correction pass (2026-10-08T10:08:23+07:00) after Claude #2 REQUEST_CHANGES (finding summaries B1-B4, I1 as provided by the Human Owner; no review text was posted on GitHub):

- B1: `--hermetic` and every test seam now require `CTV_OPTION_B_TEST_ONLY=YES`, a safe canonical `CTV_OPTION_B_TEST_ROOT`, and paths confined to it; the real canonical directory and system paths are refused; Production mode requires the exact production canonical directory and fixed unit/core.env paths.
- B2: historical compare must be a genuine report with `PRESERVATION_S10=FAIL` and `COMPARE_RESULT=FAIL` exactly once each; PRE/POST `SHA256SUMS` and compare-output digests are bound into the authorization; the PRE detector baseline is read from the integrity-verified PRE capture.
- B3: complete `aegis_soc` import closure and the guard are proven against exact main; repo ancestors, executed files, work dir and python must be root-trusted in Production; `CTV_SUDO` pinned; unit must be `0:0` and not group/world writable; `#!/bin/bash -p` plus `env -i` re-exec neutralize `BASH_ENV`/`ENV`/`PYTHON*`; python runs `-I -B -X pycache_prefix`.
- B4: a crash between closeout creation and sidecar creation is completed idempotently by creating only the sidecar after a byte-exact regeneration check; the closeout is never rewritten; tampered closeout, mismatching sidecar and orphan sidecar are refused.
- I1: the whole verifier is re-run immediately before the commit and must produce the identical state digest, otherwise the action refuses.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/ctv-incident/ctv-option-b-guard.sh` — new shared Production guard.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/ctv-incident/ctv-option-b-verify.sh` — new read-only verifier.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/ctv-incident/ctv-incident-disposition.sh` — new governed action (prepared, not authorized).
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/CTV-INCIDENT-DISPOSITION.md` — Option B design, protections and the exact Production action proposal.
- `IDEA3-AEGIS_Lockdown/tests/test_ctv_incident_option_b.py` — 85 hermetic tests.

## Verification evidence

- `pytest -q IDEA3-AEGIS_Lockdown/tests/test_ctv_incident_option_b.py` — PASS: 85 passed
- Negative controls: 8 targeted mutations of the protections (test-only env check, positive S10 check, pre-commit drift check, sidecar completion, closure entry, production canon check, python hardening, BASH_ENV refusal) each made the matching test fail; files restored afterwards.
- `pytest -q` on test_ctv_incident_option_b, test_ctv_successor, test_ctu_blockers, test_pr11_phase4_harness, test_recovery_stage — 487 passed, 1 failed: `test_only_reviewed_stage_handlers_are_registered` (identical on unmodified main; unrelated)
- `bash -n` on the three scripts — PASS; `git diff --check` — PASS
- Local `validate-collaboration-policy.mjs` and `validate-vault.mjs` — PASS (2 existing canvas warnings)
- Independent check: the pinned unit sha256 `82446332…1627c` equals `aegis-idea3-core.service.example` at merged main.

## Canonical notes updated

None — preparation only; no durable project fact changed.

## Shared surfaces touched

None — IDEA3-owned paths only.

## Integration requests

Independent security/governance review (Claude #2) of the exact PR head. Human merge only. Executing the action requires a separate explicit Human Owner authorization and the thirteen-line authorization file described in the PR; Production execution also needs a root-owned exact-main tree.

## Known limitations

The full IDEA3 suite was not run (an earlier attempt was abandoned as too slow); only the suites listed above ran. The owner evidence (pre-image sha, journal phase, drop-ins, clock, detector, evidence integrity, S10 FAIL) could not be read by this session (root-only) and is encoded as pins/gates, not independently confirmed; only the unit pin was independently proven. Tests are hermetic (stub systemctl/pgrep, temp dirs, non-root); root-ownership checks (uid 0) and the Production branch of the guard are exercised only through their refusal paths, never against a real root-owned tree. The verifier and action have never run against the real host. A sub-millisecond window between the last pre-commit proof and the `ln` cannot be removed by a userspace script (bounded by the exclusive lock and append-only `ln`). `ctv_host_runtime_verify`'s single-operand `diff -u` defect is left unfixed (out of scope). Packaging for a real run (root-owned exact-main tree) is not done. CTv remains CONSUMED, NO RETRY; no marker, unit, service, CTu/Recovery state or evidence was touched.
