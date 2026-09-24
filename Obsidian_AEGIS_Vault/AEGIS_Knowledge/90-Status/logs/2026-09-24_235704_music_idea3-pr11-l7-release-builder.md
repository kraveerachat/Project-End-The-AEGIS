---
title: Task Receipt — IDEA3 PR11 Phase 4 L7 release builder and verifier
date: 2026-09-24T23:57:04+07:00
owner: music
area: idea3
branch: feat/idea3-pr11-l7-release-builder
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 PR11 Phase 4 L7 release builder and verifier

## What changed

- New repository tooling `p4-l7-build-release.py` (`build` / `verify`) that produces, in a user-owned staging directory, the release layout the L7 release guard expects: `venv/bin/python`, the exact `aegis_soc` runtime closure of the headless production entrypoint (21 modules plus `__init__`, computed by AST from source), `requirements.txt`, `RELEASE-MANIFEST.json` (exact 8-field allowlist) and `RELEASE-SHA256SUMS`.
- Refuses: dirty source, existing/symlinked destination or staging root, staging aliasing the source or in a system location, non-regular source files, unmapped or unpinned third-party imports, and any symlink, FIFO, socket, device, `.git`, `__pycache__`, credential-like file, private-key material or group/world-writable path in a release. The verifier is read-only and deterministic and supports `--expect-owner self|root|any`.
- Dependencies install only from a local wheelhouse (`pip --no-index --isolated --only-binary=:all:`); venv creation, pip and the import smoke test are bounded by timeouts; no proxy variables reach subprocesses.
- Builder output was checked against a verbatim copy of the PR #202 release-guard predicate in a fixture root. PR #202 is unchanged.
- Repository-only: no sudo, no `/opt` write, no systemd, no Production mutation, no live L7. `L7_RELEASE_BUILDER=IMPLEMENTED_REPOSITORY`, `L7_RELEASE_INSTALL=NOT_RUN`, `L7_PRODUCTION_RELEASE=NOT_INSTALLED`, `L7_LIVE_ACCEPTANCE=NOT_PROVEN`.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l7-build-release.py` — new builder/verifier
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l7_release_builder.py` — new tests (86)
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md` — documents the builder boundary

## Verification evidence

- RED first: `pytest tests/test_pr11_phase4_l7_release_builder.py` before the tool existed — 5 failed, 80 errors
- `pytest tests/test_pr11_phase4_l7_release_builder.py` — pass: 86 passed
- `pytest tests/test_pr11_phase4_l7_*.py` — pass: 114 passed
- `pytest tests/test_pr11_phase4_*.py tests/test_pr11_k10_server_ca.py` — pass: 1174 passed
- `pytest tests` (IDEA3 full, sequential) — pass: 2225 passed, 6 skipped
- `python -m py_compile` on the tool, `git diff --check`, `node scripts/validate-vault.mjs`, `scripts/validate-collaboration-policy.mjs`, staged-diff secret scan — see PR

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — added the L7 release builder section (builder IMPLEMENTED_REPOSITORY; install NOT_RUN)

## Shared surfaces touched

- `None` — task stayed inside its selected area

## Integration requests

- None — valid only when no cross-scope/shared path changed

## Known limitations

- No real wheelhouse was used: tests use a locally built stub wheel named like the pinned dependency. A real build needs the owner's wheelhouse containing `paho-mqtt==2.1.0`.
- The venv still resolves the standard library from the base Python in `pyvenv.cfg` (`home`); the release is bound to that system Python version.
- Root ownership, the `/opt` install, the atomic `current` switch and rollback-before-start are a separate owner-run future step and are not implemented here.
- The complete `core.env` renderer and the MQTT hostname/TLS SAN reconciliation remain open L7 blockers (owner decision needed for the hostname).
- Dynamic imports (`importlib`) are not traced; the only one in the closure loads stdlib modules.
