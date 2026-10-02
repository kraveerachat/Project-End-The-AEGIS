---
title: Task Receipt — IDEA3 L7u first live attempt incident and delta privilege-boundary fix
date: 2026-10-02T20:55:00+07:00
owner: music
area: idea3
branch: fix/idea3-l7u-delta-privilege-boundary
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 L7u first live attempt incident and delta privilege-boundary fix

## What changed

- Incident record: the owner-run L7u attempt (main `9d04b797`, evidence `/home/kittipat/Workspace/idea3-p4-evidence/2026-10-02-l7u-20261002-201221`, consumed `2026-10-02T13:12:28Z`) applied and verified (Core restarted once forward), passed PRE->POST compare, then failed `L7U_DELTA=FAIL reason=UNEXPECTED:PermissionError`; the automatic rollback passed (Core restarted once more), PRE->RB compare passed, old release `f2a5cd75…` restored. Production WAS mutated by the attempt. The authorization is consumed and not reusable. `L7U_LIVE_ACCEPTANCE=NOT_PROVEN`; Recovery R1-R8 NO; LVR NO; L8 not authorized; F1 detector not started; ESP32 not touched.
- Root cause (proven): the runner invoked `p4-l7u-upgrade.py delta` as the normal user, and `read_records` opens `host.tsv`/`services.tsv` in the root-owned 0700 `pre-root`/`post-root` captures. A read-only check showed the owner user cannot open them.
- Fix: the runner runs `delta` through the existing sudo boundary (same form as `preflight`, no widening); an unreadable capture is now the explicit refusal `DELTA_CAPTURE_UNREADABLE_ROOT_REQUIRED`. Capture permissions, apply, verify, rollback and the exact-value proof are unchanged.
- This task performed no Production mutation, no retry, no Core restart, no Auth/K3 creation.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-l7u-owner.sh` — `delta` runs under `sudo "$PY"`; explanatory comment.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l7u-upgrade.py` — `read_records` refuses an unreadable capture explicitly.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l7u_delta_privilege.py` — new regression tests (runner line, no sudo widening, ordering and rollback, read-only, no restart/detector/Recovery/device action, unreadable-capture CLI).
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-10-01-idea3-pr11-phase4-l7u-post-l7-recovery-core-upgrade.md` — new §12.

## Verification evidence

- RED first: `pytest tests/test_pr11_phase4_l7u_delta_privilege.py` against unchanged code — fail: 2 failed, 5 passed (runner lacks sudo; CLI printed `UNEXPECTED:PermissionError`, reproducing the live error).
- GREEN: same file after the fix — pass; with the four existing L7u test files: 240 passed.
- `~/.venvs/aegis-idea3-core/bin/python -m pytest -q tests` (from `IDEA3-AEGIS_Lockdown/`) — pass: 5681 passed, 11 skipped, 0 failed (27m53s).
- `bash -n IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-l7u-owner.sh` — pass. `git diff --check` — pass.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` — pass (2 existing canvas warnings). `node scripts/validate-collaboration-policy.mjs` against the PR body and changed files — pass.
- Read-only host check after the attempt — pass: `current` is the old release, new release/groups/dirs/drop-ins/tmpfiles absent, `core.env` unchanged, Core active/running/enabled with NRestarts 0, IDEA2/Twingate/legacy mosquitto/broker/dnsmasq active, forwarding 0.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — added the L7u failed-attempt / auto-rollback / fix section.

## Shared surfaces touched

- `None` — task stayed inside its selected area

## Integration requests

- None — valid only when no cross-scope/shared path changed

## Known limitations

- `delta` had never run against a real host before this attempt; the fix is simulator/CLI-tested only, so a further live-only defect behind it is possible.
- I could not demonstrate that root can read the captures (sudo needs a password here); that follows from root ownership.
- A new attempt needs a new frozen runner at the post-merge main, fresh qualification, and fresh same-day A-L7u + K3 in a new AUTH_DIR.
