---
title: Task Receipt — L6c/L7 release-directory permission fix under hostile umask
date: 2026-09-28T23:50:23+07:00
owner: music
area: idea3
branch: fix/idea3-l6c-release-directory-permissions
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — L6c/L7 release-directory permission fix under hostile umask

## What changed

- Live evidence (owner-run `sudo namei -l` against the installed release
  `/opt/aegis-idea3/releases/1de1b4eaaa1506a8ec411f822be731994a7c1ca9`) showed every directory
  `p4-l7-install-release.py` itself creates (`/opt/aegis-idea3`, `releases/`, the release root, `venv/`, `venv/bin/`)
  came out mode `0700` instead of the reviewed `0755`, blocking `sudo -u aegis-idea3 ... venv/bin/python --version`.
- Root cause proved with a RED regression: `stages/L6c/apply.sh` sets `umask 077` before invoking the installer as a
  subprocess; `Path.mkdir(mode=0o755)` ANDs the requested mode with the inherited umask, silently narrowing every
  directory this tool creates to `0700`. Files were unaffected because they already get an explicit `os.chmod()`.
- Fix: after each `Path.mkdir(mode=...)` call this installer performs (parent-directory creation and the recursive
  release-tree copy), added an explicit `os.chmod()` to the exact reviewed mode, independent of process umask. No
  pre-existing ancestor directory is ever touched (unchanged contract, still test-proven).
- This is a repository-only fix. No live host was mutated by this task. A separate, NOT-executed one-time live
  remediation script and a corrected (not executed) broker-rotation plan were prepared in the same session but are
  out of scope for this receipt's source-file list.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l7-install-release.py` — normalize `_ensure_parent_dirs` and
  `_copy_tree` directory modes with an explicit `os.chmod()` after `mkdir()`, so an inherited restrictive umask can
  never narrow a newly created directory below its reviewed mode.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l6c_umask_directory_permission_fix.py` — new RED→GREEN regression
  suite: reproduces the live failure under `umask 077` via a real subprocess invocation, proves every installer-owned
  directory is `0755` and every file mode is unaffected, proves the `venv/bin/python` ancestor chain has the "other
  execute" bit set (deterministic traversal proof, standing in for a real non-root service-identity check), and
  proves pre-existing parents/symlink/writable-parent refusals are unaffected by the fix.

## Verification evidence

- `pytest tests/test_pr11_phase4_l6c_umask_directory_permission_fix.py -q` on pre-fix `main` — fail: 2 of 7 failed (RED confirmed, matching the live symptom).
- `pytest tests/test_pr11_phase4_l6c_umask_directory_permission_fix.py -q` after the fix — pass: 7 passed.
- `pytest tests/test_pr11_phase4_l6c_umask_directory_permission_fix.py tests/test_pr11_phase4_l7_release_installer_helper.py tests/test_pr11_phase4_l6c_runner.py tests/test_pr11_phase4_l6c_runner_flow.py tests/test_pr11_phase4_l6c_handler.py -q` — pass: 174 passed.
- `pytest tests/test_pr11_phase4_l6c_capture_gap.py::test_real_end_to_end_capture_then_compare_requires_the_allow_file` — fail: intermittent both with and without this fix (re-ran 3x each way); pre-existing host-network-listener-snapshot flakiness on this dev machine, unrelated to this change, excluded from the pass/fail claims above.
- `bash -n deploy/pr11-phase4/stages/L6c/apply.sh` — pass (file unmodified by this task).
- `ruff check deploy/pr11-phase4/p4-l7-install-release.py tests/test_pr11_phase4_l6c_umask_directory_permission_fix.py` — pass: all checks passed.
- `python -m compileall -q deploy/pr11-phase4/p4-l7-install-release.py tests/test_pr11_phase4_l6c_umask_directory_permission_fix.py` — pass.
- `git diff --check` — pass: no whitespace errors.
- `node scripts/validate-vault.mjs` — pass: 2 pre-existing owner-data warnings on unrelated canvas files, no new warnings from this task.

## Canonical notes updated

- `None` — this is a scoped bug-fix task; no durable idea3 architecture/status fact changed beyond the fix itself,
  which is captured in this receipt and the PR description.

## Shared surfaces touched

- `None` — task stayed inside `IDEA3-AEGIS_Lockdown/`.

## Integration requests

- None — valid only when no cross-scope/shared path changed. This PR is idea3-only and does not require Kla review
  under the current approve-only-package convention (any of the three CODEOWNERS satisfies review).

## Known limitations

- The live one-time permission remediation for the already-installed release
  (`/opt/aegis-idea3/releases/1de1b4eaaa1506a8ec411f822be731994a7c1ca9`) was prepared but NOT executed in this task;
  it is tracked separately and requires explicit owner authorization before it touches the live host.
- The L7 traversability proof in the new test suite is filesystem-mode-based (the "other execute" bit on every
  ancestor directory), not a literal `sudo -u aegis-idea3` process check, per this task's own instruction that a real
  service UID is inappropriate inside unit tests.
