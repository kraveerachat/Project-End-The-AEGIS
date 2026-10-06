---
title: Task Receipt — IDEA3 R1B successor governed stage (repository closeout)
date: 2026-10-06T01:05:00+07:00
owner: music
area: idea3
branch: feat/idea3-r1b-successor-governed-stage
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 R1B successor governed stage (repository closeout)

## What changed

- Continued the existing R1B branch (no reset, no history rewrite). Reproduced and fixed a confirmed defect: `p4-r1b-run-lib.sh` called `_r1b_only_receipt` while only `_r1a_only_receipt` was defined, so the R1A immutable-failure predecessor gate could never complete (`line 162: _r1b_only_receipt: command not found`). The helper is now `_r1b_only_receipt` everywhere in the R1B library, with the predecessor contract unchanged.
- Found and repaired a second committed defect by source review: the frozen R1B owner runner template had a corrupted `r1b_hook_baseline` (a patch had spliced the remainder of the file into a `grep -q` call, duplicating hooks and leaving the pre-consume TrustedClock checks without a pattern). The two pre-consume captures now require an exact `time.trustedclock.state` = `SYNCED` record (tab-separated, exact match) before the marker; the runner's delta against the R1A runner is now exactly the intended PRECHECK/PRE/compare additions.
- Added first-class hermetic tests under `IDEA3-AEGIS_Lockdown/tests/r1b/` (stage/state machine/runner/freeze/snapshot clones adapted to R1B, predecessor gate, successor contract: attempt isolation from the consumed R1A marker, TrustedClock from the immutable snapshot, pre-consume ordering and exact `SYNCED`, claim boundary).
- README section 18 documents R1B; R1B stage handler comments corrected; shared registry/pin tests updated for the registered R1B stage.

## Result and boundary

- `R1A_RESULT=FAIL_IMMUTABLE`, `R1A_ATTEMPT_CONSUMED=YES`, `R1A_RERUN_ALLOWED=NO`
- `R1B_IS_SUCCESSOR_GOVERNED_STAGE=YES`, `R1B_IS_R1A_RETRY=NO`
- `R1B_GOVERNANCE_CLASS=MUTATING`, `R1B_ONE_ATTEMPT=YES`, `R1B_NO_RETRY=YES`
- `R1B_GENUINE_EXTERNAL_EVENT_REQUIRED=YES`, `R1B_SYNTHETIC_EVENT_ALLOWED=NO`
- `R1I_MUST_REMAIN_INSTALLED=YES`, `RECOVERY_R2_R8_BLOCKED_UNTIL_R1B_PASS=YES`
- `R1B_REPOSITORY_IMPLEMENTED=YES`
- `R1B_LIVE_EXECUTED=NO`
- `R1B_ATTEMPT_CONSUMED=NO`
- `F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN`
- `R1_VERIFIED=NOT_CLAIMED`
- `RECOVERY_R1_R8_PROVEN=NO`
- `RECOVERY_R2_R8_EXECUTED=NO`
- `PRODUCTION_MUTATION_PERFORMED=NO`

## Verification evidence

- `/usr/bin/python3 -m pytest -q tests/r1b tests/r1a tests/test_r1_acceptance.py tests/r1i` — pass: see PR body for the exact final counts (tests/r1b: 210 collected, tests/r1a: 315 collected).
- Negative controls — pass: renaming the helper back, removing the R1A failure gate, using the R1A marker name, removing the canonical parent barrier, removing the `CLOSED_PASS` contradiction check, removing the explicit snapshot `PYTHONPATH`, removing either pre-consume TrustedClock check, removing the PRECHECK→PRE comparison, removing the R1I presence gate and enabling Git replacement objects each failed the relevant test and passed again after restore.
- Full `tests` run: the remaining failures and errors are pre-existing on `origin/main` (no `pip` module for the release-builder tests and unrelated shared-pin/handler tests); no branch-only failures remain in files touched by this task.
- `git diff --check`, secret scan of the added lines and vault validation — see PR body.
- No Production command was run; tests never touched `/var/lib/aegis-idea3-governance` or any host path.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-r1b-run-lib.sh`, `owner-run/run-r1b-owner.sh`, `stages/R1B/allow-*.txt`, `README.md` (section 18).
- `IDEA3-AEGIS_Lockdown/tests/r1b/` (new), and registry/pin updates in `tests/r1a`, `tests/r1i` and the shared Phase-4 harness tests.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` and this receipt.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — R1B successor stage implemented in the repository, not executed.

## Shared surfaces touched

- None — all paths are inside the IDEA3/Music-owned boundary.

## Integration requests

- Independent review of the R1B stage. R1B LIVE needs a separate owner decision, a fresh root-owned exact-main authority, frozen runner and owner-created Authorization/K3; none exists.

## Known limitations

- Design is not live proof: nothing was frozen or run on a host, the durability barriers have never run against the real canonical path, and the TrustedClock probe was exercised only through the repository code path.
- Test seams cannot induce post-open inode races or a genuinely different-uid file owner.
- The release-builder test files need `pip` and fail in this environment on `main` as well.
- No raw Production evidence, secret, runner or authorization content was committed.
