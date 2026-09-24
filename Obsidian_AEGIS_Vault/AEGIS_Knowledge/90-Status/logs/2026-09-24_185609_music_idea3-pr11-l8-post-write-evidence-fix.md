---
title: Task Receipt — IDEA3 PR11 Phase 4 L8 post-write fail-secure evidence fix
date: 2026-09-24T18:56:09+07:00
owner: music
area: idea3
branch: fix/idea3-pr11-l8-post-write-evidence
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 PR11 Phase 4 L8 post-write fail-secure evidence fix

## What changed

- Repository-only, fixture-only fix of the gap found by the future-stage readiness audit: in `p4-l8-device.py` `provision()`, the NVS readback ran outside the protected path after the first-write marker, so a readback error or comparison error could escape before the evidence bundle was written (OD-L8-07 requires `FAIL_SECURE_HOLD_AND_EVIDENCE`), and a wrong-length readback was only treated as a mismatch.
- One post-first-write boundary now converges every failure (write completion, readback, length validation, comparison, post-write verification) on: non-zero result, first-write marker kept, `L8_POST_FIRST_WRITE=FAIL_SECURE_HOLD_AND_EVIDENCE`, exactly one write-once evidence bundle with `flash_result=FAIL` and a stable `failure_boundary` (`DEVICE_WRITE`, `NVS_READBACK`, `NVS_READBACK_ERROR`, `NVS_READBACK_LENGTH`, `POST_WRITE_VERIFICATION`). A same-length mismatch keeps `nvs_readback_match=FAIL` / `NVS_READBACK`. Exception text is never recorded.
- Unchanged: the exact G-15 evidence field set, backend authorization (hardware still refused), pre-write behaviour, no automatic recovery / RESTORE / previous-firmware reflash / legacy v0 / plaintext 1883. PR #200 (`p4-l8-hardware.py`) is untouched and remains Draft/HOLD. Boot verification and hardware wiring remain separate.
- `L8_POST_WRITE_EVIDENCE_GAP=FIXED_REPOSITORY`, `L8_HARDWARE_BACKEND=NOT_WIRED`, `L8_LIVE=NOT_RUN`, `L8_LIVE_ACCEPTANCE=NOT_PROVEN`, `PRODUCTION_MUTATION=NO`, `REAL_HARDWARE_ACCESSED=NO`.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l8-device.py` — single post-first-write exception boundary and stable failure boundaries.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l8_post_write_evidence.py` — new, 18 fixture-only tests with a device-call spy.

## Verification evidence

- New tests against the original helper (RED) — fail: 13 failed, 5 passed.
- `pytest tests/test_pr11_phase4_l8_post_write_evidence.py tests/test_pr11_phase4_l8_handler.py` — pass: 95 passed.
- `pytest tests -k phase4` — pass: 953 passed, 1093 deselected.
- `pytest tests` (full IDEA3, sequential) — pass: 2040 passed, 6 skipped; no flake observed.
- `bash -n stages/L8/*.sh`, `git diff --check`, `node scripts/validate-vault.mjs` (2 pre-existing canvas warnings), diff secret scan — pass.
- No serial device opened, no esptool invoked; a test enforces that this module imports no serial or flashing library.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — new L8 post-write evidence section.

## Shared surfaces touched

- None — task stayed inside `idea3`.

## Integration requests

- None — valid: no cross-scope path changed.

## Known limitations

- Fixture only: the hardware backend is not wired, so real esptool/readback behaviour, real boot verification and the live L8 stage are unproven (`L8_LIVE_ACCEPTANCE=NOT_PROVEN`).
- A hardware backend that fails in `identity()` or before the marker is unchanged (pre-write failures raise as before).
