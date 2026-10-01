---
title: Task Receipt — IDEA3 L7u release-builder Recovery runtime fix
date: 2026-10-01T20:35:00+07:00
owner: music
area: idea3
branch: fix/idea3-l7u-release-builder-recovery-closure
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 L7u release-builder Recovery runtime fix

## What changed

- Repository-only fix after the owner's first L7u live attempt (2026-10-01 ~20:11 +07, frozen runner sha256 `f2d8203a1f08dad351d8995f0b3b67309d123c34520eb9db972bbae474fc8834`, main `7cabf28a4e9421d951788d2971ad82a32de3510c`) stopped in the engine preflight with `reason=NEW_RELEASE_LACKS_RECOVERY_RUNTIME`. **L7u was NOT run by this task; the failed attempt stopped before PRE capture and before `L7u-ATTEMPT-CONSUMED`; no production mutation; Core NOT restarted; no Recovery R1-R8; no ESP32; no L8.**
- Read-only incident verification: no `L7u-ATTEMPT-CONSUMED` in `l7u-auth-20261001-194525`; no L7u evidence directory (no PRE/POST capture, no mutation marker); `/opt/aegis-idea3/current` still `f2a5cd75…`; Core active/running/enabled, `Result=success`, `NRestarts=0`. The failed attempt's scratch build (`2026-10-01-l7u-build-20261001-201149`) was used only as diagnostic evidence: its `aegis_soc` holds 24 modules, including `recovery_core.py` and `recovery_protocol.py` but NOT `recovery_client.py` or `recovery_ui.py`. All four exist in the repository.
- Root cause `RELEASE_BUILDER_CLOSURE_OMITS_RECOVERY_OBSERVER`: `p4-l7-build-release.py` computed the AST runtime closure of `supervisor` only. The Core imports `recovery_core` and `recovery_protocol`; the Recovery observer entrypoint `python -m aegis_soc.recovery_ui` (README "Core-mediated Recovery") and its `recovery_client` are not imported by the Core. The existing L7 builder test even listed both as `NOT_RUNTIME`, and the L7u tests used hand-made releases, so neither layer saw it. The pre-live repository verification of the previous task also did not exercise a real build against the L7u preflight.
- Fix: the builder's release closure (build and verify) is now the union of the closures of exactly two entrypoints, `ENTRYPOINTS = ("supervisor", "recovery_ui")`. The package stays exactly that closure (the observer adds only `recovery_client`; `recovery_protocol` was already present; all stdlib, no new third-party import). `NEW_RELEASE_LACKS_RECOVERY_RUNTIME` is unchanged. Offline pip behaviour is unchanged. Files stay covered by `RELEASE-MANIFEST.json`/`RELEASE-SHA256SUMS`; nothing is copied after a build.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l7-build-release.py` — `ENTRYPOINTS`, `runtime_closure` accepts one or several entrypoints and defaults to both; docstring.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l7_release_builder.py` — `CLOSURE`/`NOT_RUNTIME` now include `recovery_client`/`recovery_ui` as runtime.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l7u_release_builder_recovery_runtime.py` — NEW: real build contains all four files; manifest/checksums cover them; canonical verify passes; the package is exactly the two-entrypoint closure; real builder output passes the real L7u engine preflight; removing any required file is refused by verify and by the preflight; a source tree missing a Recovery entrypoint module is refused by the builder.
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-10-01-idea3-pr11-phase4-l7u-post-l7-recovery-core-upgrade.md` — new section 11.

## Verification evidence

- RED first: with the unfixed builder, the new module plus the existing builder tests — `13 failed, 89 passed`.
- After the fix: new module + `test_pr11_phase4_l7_release_builder.py` — `102 passed`.
- L7 + L7u modules (`tests/test_pr11_phase4_l7_*.py tests/test_pr11_phase4_l7u_*.py`) — `893 passed`.
- Full Phase 4 (`pytest tests/test_pr11_phase4_*.py`) — `3267 passed, 2 skipped, 0 failed` (1310 s), run after the doc edits.
- `bash -n` on the L7u runner, run lib and stage handlers — pass; `py_compile` of the builder — pass; `git diff --check` — pass.
- `node scripts/validate-vault.mjs` — pass: `Vault validation passed with 2 warning(s)` (pre-existing canvas owner-review warnings).

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — added the L7u release-builder fix section; repository-only; marks the `f2d8203a…` frozen runner DO_NOT_RETRY.

## Shared surfaces touched

- `None` — task stayed inside its selected area

## Integration requests

- None — valid only when no cross-scope/shared path changed

## Known limitations

- Simulator/fixture-tested; real `sudo`, systemd and the live L7u run remain unproven. A real offline build against the owner's `l7u-wheelhouse` is validated only after merge by a rebuild at the new main.
- The frozen runner `f2d8203a…`, execution worktree `…L7U-EXEC-7cabf28a` and authorization `l7u-auth-20261001-194525` embed the unfixed main and must not be reused. After human merge: new execution worktree, NEW frozen runner (new `EXPECTED_MAIN`/`NEW_RELEASE_ID`), fresh same-day `stage=L7u` authorization and K3, and explicit owner live authorization.
