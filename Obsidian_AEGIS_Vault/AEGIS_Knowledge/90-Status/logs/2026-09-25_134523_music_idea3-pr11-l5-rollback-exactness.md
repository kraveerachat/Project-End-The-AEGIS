---
title: Task Receipt — IDEA3 PR11 L5 rollback exactness hardening
date: 2026-09-25T13:45:23+07:00
owner: music
area: idea3
branch: fix/idea3-pr11-l5-rollback-exactness
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 PR11 L5 rollback exactness hardening

> [!important] Repository-only. No Production mutation, no live stage, L5 NOT run and NOT authorized.

## What changed

Pre-live audit of the merged L5 handler (main `69bb261c`) found rollback could report PASS without proving it restored `/etc/chrony.conf`:

- `apply.sh` did not check its snapshot (`cp -p`, `stat`) and recorded no hash.
- `rollback.sh` silently skipped the restore when the snapshot file was missing, ignored `chmod`/`chown` failures, never compared the result, and defaulted an unknown pre-state to "file absent", which would delete `/etc/chrony.conf`.

Fix: apply fails closed (`CHRONY_CONF_SNAPSHOT_FAILED`) and records the original SHA-256; rollback fails closed on unknown pre-state, missing snapshot, failed restore, byte/mode/uid:gid mismatch, or chronyd still active. README also documents that the chronyd sync wait is a stricter 30 s fail-closed bound than the 300 s HOLDOVER limit (audit class: documentation mismatch, not a defect). Listener allow-list and comparator allow-keys are unchanged.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L5/apply.sh`
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L5/rollback.sh`
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l5_handler.py`
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md`

## Verification evidence

- `pytest tests/test_pr11_phase4_l5_handler.py -k "original_mode or snapshot_missing or restored_bytes"` before the fix — RED: 3 failed
- `pytest tests/test_pr11_phase4_l5_handler.py tests/test_pr11_phase4_l5_trustedclock_path.py` — pass: 58 passed
- `pytest tests -k phase4` — fail (pre-existing only): 7 failed, 1090 passed; same 7 failures as base (broker_validate ×3, l6a_handler ×4)
- `pytest tests` — fail (same pre-existing only): 7 failed, 2176 passed, 7 skipped
- `bash -n` on L5 apply.sh and rollback.sh — pass
- `git diff --check` — pass
- `node scripts/validate-vault.mjs` — pass

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — L5 pre-live hardening section (conservative status).

## Shared surfaces touched

- None outside the IDEA3 boundary.

## Integration requests

- Human review and merge of this PR before any L5 live preparation is frozen (the owner-runner pins the merged main).

## Known limitations

- The fix is proven by fixture tests only; it has not run live.
- L4 AP runtime state currently diverges from the accepted state (owner reconnected Pboo_5G); restoration needs owner approval and is not part of this PR.
- Live `nft` state was not inspected (needs root).
- `L5_LIVE_ACCEPTANCE = NOT_PROVEN`, `L5_STARTED = NO`, `PHASE4_RUNTIME_COMPLETE = NO`, `PR11_COMPLETE = NO`.
