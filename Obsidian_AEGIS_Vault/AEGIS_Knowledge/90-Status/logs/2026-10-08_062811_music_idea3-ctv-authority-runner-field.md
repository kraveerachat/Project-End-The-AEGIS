---
owner: music
area: idea3
branch: fix/idea3-ctv-authority-runner-field
status: complete
edit_policy: append-by-new-file
---

## What changed

Canonicalized the CTv Authorization/K3 frozen-runner binding to `frozen_runner_sha256`, matching the existing strict CTv stage-gate schema.

CTu continues using `runner_sha256` unchanged.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-ctv-owner.sh`
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-ctv-run-lib.sh`
- `IDEA3-AEGIS_Lockdown/tests/test_ctv_successor.py`

## Verification evidence

- `pytest -q IDEA3-AEGIS_Lockdown/tests/test_ctv_successor.py` — PASS: 72 passed
- focused CTv stage-gate authority regression — PASS: 1 passed
- `bash -n IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-ctv-owner.sh IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-ctv-run-lib.sh` — PASS
- `git diff --check` — PASS

## Canonical notes updated

None — narrow PRE-LIVE authority-field consistency hotfix only.

## Shared surfaces touched

None — IDEA3-owned CTv paths only.

## Integration requests

Review the exact-head CTv authority-field canonicalization before CTv LIVE.

## Known limitations

No authority was created, no Production rehearsal occurred, CTv remains unconsumed, Recovery remains unconsumed, and no Production mutation or LIVE execution occurred.
