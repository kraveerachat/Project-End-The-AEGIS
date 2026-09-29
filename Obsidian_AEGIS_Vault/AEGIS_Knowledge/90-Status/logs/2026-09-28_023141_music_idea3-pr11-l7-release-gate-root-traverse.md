---
title: Task Receipt — IDEA3 PR11 Phase 4 L7 release-gate root-traversal fix
date: 2026-09-28T02:31:41+07:00
owner: music
area: idea3
branch: fix/idea3-pr11-l7-release-gate-root-traverse
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 PR11 Phase 4 L7 release-gate root-traversal fix

> [!important] Repository-only remediation. Validation performed read-only filesystem metadata inspection (`lstat`)
> of guarded system paths, including real `/opt/aegis-idea3` paths on this host via the hardened
> `test_system_locations_are_refused_before_any_write` test — no sudo-driven Production mutation, no service/network/
> runtime change, and no L7 live execution occurred. No A-L7/K3 created, no Production mutation.
> Base: main `67c1388916b112c26726f70a149bb51e4494825c`.

## What changed

`l7_release_gate()` in `p4-l7-run-lib.sh` performed the installed-release existence/type check as a bare
unprivileged `[ -d "$host" ] && [ ! -L "$host" ]` **before** invoking the privileged, read-only release guard via
`$SUDO`. The real host's `/opt/aegis-idea3` is root:root mode `0700` (per L6c's live acceptance): an unprivileged
owner-run process cannot traverse into it, so this check would wrongly report
`L7_RELEASE_NOT_INSTALLED_PREREQUISITE` for a release that genuinely exists and was already installed live by L6c.
The identical unprivileged pattern also guarded the `/opt/aegis-idea3/current` pointer check in the same function,
under the same root-owned parent. Fixed: both checks now cross the SAME `$SUDO` privilege boundary as the
release-guard invocation right after them (`$SUDO test -d "$host" && ! $SUDO test -L "$host"`; `$SUDO test -L/-e
"$current"` with `$SUDO readlink`). Fail-closed behavior, the missing-release prerequisite classification, symlink
rejection, read-only semantics, root-ownership validation (unmodified `p4-l7-release-guard.py`), and fixture
support (`SUDO=""` still resolves to a plain unprivileged `test`) are all preserved exactly. No live-only special
case was introduced.

Root cause confirmed directly from source: existing tests never caught this because the fixture harness always runs
with `SUDO=""` against fully-accessible, test-owned temp directories, so the unprivileged check never actually
failed there — the bug only manifests against a real root-owned, mode-restricted parent, which no prior fixture
modeled.

## New regression test

`test_l7_release_gate_can_see_a_root_owned_0700_parent_through_sudo`
(`tests/test_pr11_phase4_l7_runner.py`) models the real permission boundary without requiring actual root: it
`chmod 0`s a test-owned `/opt/aegis-idea3` fixture directory (self-revoking all access, exactly as an unprivileged
process cannot traverse a different-uid `0700` directory), proves the unprivileged case still correctly reports
`L7_RELEASE_NOT_INSTALLED_PREREQUISITE`, then proves a stub `sudo` — emulating real sudo's DAC bypass by temporarily
restoring access for exactly the wrapped command — is required and sufficient for the same release to be found.
Run against the unfixed code first as RED: the un-escalated assertion passed, the sudo-escalated assertion failed
exactly as expected, confirming the reproduction before the fix was applied.

## Pre-existing test hardening discovered during full-suite validation (same task)

Running the full Phase 4 suite against the fix surfaced 6 failures, none caused by the fix itself (all reproduced
identically on clean pinned main `67c1388916b112c26726f70a149bb51e4494825c` with none of this branch's changes
present):

- **5× `test_system_locations_are_refused_before_any_write`** (`tests/test_pr11_phase4_l7_release_builder.py`)
  asserted the global, real-host `assert not Path("/opt/aegis-idea3").exists()` — invalidated by the legitimate,
  already-PROVEN L6c live install. Corrected to a read-only, metadata-based (`lstat`) before/after snapshot of the
  exact target path under test, proving no write occurred without assuming the path was absent beforehand. The
  builder's refusal behavior and production implementation (`p4-l7-build-release.py`) are unchanged.
- **`test_real_capture_unchanged_existing_release_plus_one_new_release_passes`**
  (`tests/test_pr11_phase4_l6c_capture_gap.py`) asserted `FINDINGS_NEW_OR_WORSENED_DRIFT=0` over the WHOLE real-host
  comparison; a real, transient ephemeral-UDP-listener churn on the host's own Ethernet interface
  (`LISTENER_REMOVED listen.udp.0.0.0.0%enp62s0:...`) between two live captures taken moments apart made this flaky.
  The release-catalog behavior itself was always correct (`APPROVED_CHANGE`/`L6C_RELEASE_INSTALLED` for rel-b, no
  drift for rel-a). Narrowed the test to assert only the release-catalog-specific property it exists to prove
  (parsing the `FINDING` lines for the `host.aegis_idea3.release_catalog` key only), matching the established
  release-catalog-specific assertion pattern already used elsewhere in the same module. `p4-compare.sh`'s drift
  detection semantics are completely unchanged — no ephemeral-port ignore rule, no retry logic, no weakened
  assertion was added to the comparator itself.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l7-run-lib.sh` — the fix.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l7_runner.py` — new regression test; `release_gate()` helper extended
  to accept an optional `sudo`/`path_prefix` override.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l7_release_builder.py` — 5 pre-existing environment-sensitive
  `test_system_locations_are_refused_before_any_write` cases corrected to a stat-snapshot assertion.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l6c_capture_gap.py` — the pre-existing real-host capture flake in
  `test_real_capture_unchanged_existing_release_plus_one_new_release_passes` narrowed to its intended
  release-catalog property.
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-21-idea3-pr11-phase4-l7-operational-design.md` — new §9
  documenting the bug and fix.
- this receipt.

## Verification evidence

- `pytest tests/test_pr11_phase4_l7_runner.py -k release_gate` — pass: 7 passed (6 existing + 1 new).
- Focused remediation tests (release-gate ×7, `test_system_locations_are_refused_before_any_write` ×5,
  `test_real_capture_unchanged_existing_release_plus_one_new_release_passes` ×1) — pass: 13 passed.
- `pytest tests/test_pr11_phase4_l7_runner.py tests/test_pr11_phase4_l7_handler.py tests/test_pr11_phase4_l7_runner_flow.py` — pass: 334 passed (333 + 1 new; no regression).
- `pytest tests/test_pr11_phase4_l6c_handler.py tests/test_pr11_phase4_l6c_runner.py tests/test_pr11_phase4_l6c_runner_flow.py` — pass: 118 passed (L6c reuses this same gate library; no regression).
- `pytest tests -k phase4` — pass: 2501 passed, 2 skipped, 1108 deselected, 0 failures.
- `bash -n` on the changed shell library — pass.
- `git diff --check` — pass.
- `node scripts/validate-vault.mjs` — pass (2 pre-existing canvas warnings, unrelated).
- `node scripts/validate-collaboration-policy.mjs` — pass (this PR body/diff).
- Secret scan of this diff — no hit.
- `p4-compare.sh` unchanged: confirmed (not in this diff). Release-builder production implementation
  (`p4-l7-build-release.py`) unchanged: confirmed (not in this diff).

## Canonical notes updated

- None — a code-only correctness fix with a design-doc amendment; no status file was touched.

## Shared surfaces touched

- None — the task stayed inside IDEA3.

## Integration requests

- None.

## Known limitations

- Validated with a fixture-modeled permission boundary (self-revoked access via `chmod 0`), not a real
  root-owned-by-a-different-uid directory, since no real root privilege is available in this environment. The model
  is faithful to the real DAC semantics involved (traversal requires execute permission from the calling uid), but a
  live L7 attempt remains the first real-root proof.
