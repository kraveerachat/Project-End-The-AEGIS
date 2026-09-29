---
title: Task Receipt — PR238 recovery runtime config wiring into the L7 core.env path
date: 2026-09-29T12:00:00+07:00
owner: music
area: idea3
branch: fix/idea3-pr238-recovery-runtime-config
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — PR238 recovery runtime config wiring

## What changed

Repository-only stacked fix (base: PR246 branch). RecoveryCoordinator (PR238) needs three mandatory non-secret values that the
L7 core.env example/renderer did not carry, so a successful L7 install could leave R6/R7 NOT_CONFIGURED. They now flow through
the reviewed L7 path with exact-value validation:

- `AEGIS_RECOVERY_MANAGEMENT_PROBE_TARGET=192.168.10.10:22`
- `AEGIS_RECOVERY_NETWORK_PROBE_TARGETS=192.168.1.1:53,192.168.10.10:22`
- `AEGIS_RECOVERY_WEB_READINESS_URL=https://aegis.internal/security/`

`p4-l7-core-env.py` adds them to the exact-value (`FIXED`) set: missing → REQUIRED_KEY_MISSING; any altered host/port/list/URL
(non-HTTPS, embedded credentials, query string, other host) → VALUE_INVALID. No parameterized authority exists, so none was invented.
Optional IDEA1/IDEA2 recovery URLs were not added and remain UNKNOWN_KEY.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/aegis-idea3-core.env.example`
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l7-core-env.py`
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l7_core_env_helper.py`

## Verification evidence

- GREEN: `pytest tests/test_pr11_phase4_l7_core_env_helper.py` — pass: 75 passed.
- RED: new tests before implementation — fail: 20 failed, 55 passed.
- `pytest tests/test_pr11_phase4_l7_*.py tests/test_core_service.py tests/test_broker_config.py tests/test_systemd_credentials.py` — pass: 632 passed.
- `git diff --check` — pass.
- `ruff check` — 1 pre-existing unused `import os` in the test file (not introduced here).

## Canonical notes updated

- `None`.

## Shared surfaces touched

- `None`.

## Integration requests

- None.

## Known limitations

- PR238 `aegis_soc/config.py` is not in this base, but the key names were verified cross-branch by an independent read-only review of PR238 HEAD `af4ba1d49546878b992f70324c93339bfb53621d`: it defines exactly `AEGIS_RECOVERY_MANAGEMENT_PROBE_TARGET`, `AEGIS_RECOVERY_NETWORK_PROBE_TARGETS`, and `AEGIS_RECOVERY_WEB_READINESS_URL`. That verification was read-only; PR238 was not modified and its source is not part of this branch, so the check must be repeated if PR238 HEAD moves.
- Stacked on PR246; retarget to `main` and rerun tests after PR246 merges.
- Nothing executed: no L7 run, no Recovery R3–R8, no LVR6, no RESTORE, no ESP32, no production mutation, PR238 untouched.
