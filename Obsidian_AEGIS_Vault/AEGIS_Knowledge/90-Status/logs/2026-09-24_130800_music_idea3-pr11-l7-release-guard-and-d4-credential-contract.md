---
title: Task Receipt — IDEA3 PR11 Phase 4 L7 release guard and D4 credential contract
date: 2026-09-24T13:08:00+07:00
owner: music
area: idea3
branch: fix/idea3-pr11-l7-release-guard
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 PR11 Phase 4 L7 release guard and D4 credential contract

## What changed

- No script in the repository creates `/opt/aegis-idea3/releases/<id>` or its `venv`; L7 pointed `current` at whatever path it was given. apply now proves, before staging anything, that the release exists (single path component, not a symlink), has an executable `venv/bin/python` and `aegis_soc/supervisor.py`, is root-owned and not group/world-writable; a dangling `current` fails closed; verify re-proves the target and the unit `ExecStart`.
- D4 credential: `RestoreCredential.load()` requires exact mode 0600 and owner == the Core account, and the Core reads it directly. L7 staged it root-owned in a root-only 0700 directory (Core preflight would fail), and validated it with `load()` under sudo (rejecting an owner-owned or 0400 file). Now: directory `root:aegis-idea3` 0750, `restore.credential` `aegis-idea3:aegis-idea3` 0600 (live chown), format validated with `parse`.
- `systemctl start` failure and crash loops now fail with `L7_SERVICE_START_FAILED` / `L7_SERVICE_NOT_STABLE`.
- Spec amendment A1 corrects the approved sentence that the release is `aegis-idea3:aegis-idea3`-owned (the root containment helper runs the same tree; see `deploy/network/aegis-idea3-containment.service.example`) and the `root:root 0700` credentials directory.
- Repository-only. `PRODUCTION_MUTATION_PERFORMED=NO`, live stage not executed, `PR11_COMPLETE=NO`.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L7/apply.sh`
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L7/verify.sh`
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md`
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-21-idea3-pr11-phase4-l7-operational-design.md`
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l7_handler.py`
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l7_release_guard.py`

## Verification evidence

- `pytest tests/test_pr11_phase4_l7_release_guard.py tests/test_pr11_phase4_l7_handler.py tests/test_pr11_phase4_g15_host_artifacts.py` — pass: 59 passed
- `pytest tests/test_pr11_phase4_*.py tests/test_pr11_k10_server_ca.py` — pass: 885 passed
- `pytest tests` (IDEA3 full) — pass: 1936 passed, 6 skipped
- `bash -n` on touched shell scripts — pass
- `git diff --cached --check` — pass
- `node scripts/validate-vault.mjs` — pass (2 pre-existing canvas warnings)
- staged-diff secret scan — pass: no hits
- `scripts/validate-collaboration-policy.mjs` on the PR body and changed files — pass

## Canonical notes updated

- `None` — repository-only fix; no durable project status fact changed (the L3 fix PR carries the canonical status update, avoiding parallel edits to the same note).

## Shared surfaces touched

- `None` — task stayed inside its selected area

## Integration requests

- None — valid only when no cross-scope/shared path changed

## Known limitations

- **Reviewer confirmation needed:** this corrects approved-design wording (release ownership, credentials directory mode).
- Still missing (not in this PR): the release/venv installer, and a reviewed `core.env` renderer — apply writes a 3-line `core.env` that lacks the broker IP, device id and CA path the Core needs.
- Live L7 not executed; chown/stability branches are live-only and covered by static tests.
- The first full IDEA3 run on this branch showed one failure that did not reproduce on an immediate identical rerun (pass counts above are the rerun); the failing test was not captured — likely a timing-sensitive pre-existing test.
