---
title: Task Receipt — Engine Windows named-pipe client dependency
date: 2026-10-03T17:25:36+07:00
owner: pub
area: idea2
branch: fix/idea2-engine-windows-pipe-client-dependency
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — Engine Windows named-pipe client dependency

## What changed

- Added a Windows-only `pywin32==312` Engine dependency and required all five named-pipe client imports in the existing Windows installer preflight. Normal repair continues through that installer. Engine and Agent virtual environments and authority remain separate.
- Owner-provided post-PR #313 Machine A evidence showed Agent pipe availability (400/400) but no fresh physical heartbeat because the installed Engine venv lacked the client modules. This task changes source only; it does not claim an installed-runtime fix.

## Source files changed

- `IDEA2-AEGIS_CCTV-Operator/detection-engine/requirements.txt` — Windows-only named-pipe client dependency.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/install_autostart.ps1` — five-module import preflight.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/README.md` — correct the Windows Engine/Agent dependency boundary and repair behavior.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_windows_autostart.py` — exact dependency marker, installer, repair, and preflight regression.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_identity_agent_client.py` — lazy, fail-soft behavior without pywin32 and no camera-demand side effect.

## Verification evidence

- `python -m unittest discover -s tests -v` — PASS: 239/239 in the established Python 3.12 Engine test venv on the final source tree.
- `python -m unittest tests.test_identity_agent_client tests.test_windows_autostart` — PASS: 29/29 in a fresh disposable Windows Engine venv after installing this requirements file.
- `python -m pip check` — PASS in that disposable venv; `pywin32` version 312 and imports of `pywintypes`, `win32con`, `win32event`, `win32file`, and `win32pipe` all verified.
- PowerShell parser for `windows/install_autostart.ps1` and `windows/repair_autostart.ps1` — PASS: zero parse errors.
- `git diff --check` and changed-content secret scan — PASS: zero errors or secret hits.
- RED evidence: the dependency-flow test failed before implementation because no Engine `pywin32` requirement existed. GREEN: adjacent focused suite 113/113.
- Independent scoped review — Critical 0, Important 0; one non-blocking test-infrastructure observation about pip's vendored requirement parser, retained to avoid adding a new dependency.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md` — source/local dependency result, superseding owner-provided Agent evidence, and pending Machine A heartbeat gate.

## Shared surfaces touched

- None — all changes are within IDEA2 Engine source and IDEA2 canonical knowledge.

## Integration requests

- None — no cross-scope/shared path changed. Owner review and merge are still required before any separately approved Machine A Engine refresh and live heartbeat recheck.

## Known limitations

- Installed Machine A Engine venv and runtime were not mutated or reverified. Live physical heartbeat, browser acceptance, camera demand, and Production deployment remain unproven for this source fix.
- The fresh disposable Engine venv is dependency/import proof, not a full-suite environment; it lacks unrelated test-only packages such as `cryptography`. The full suite was run in the established test venv.
