---
title: Task Receipt — IDEA2 Identity Agent sc.exe config argument hotfix
date: 2026-10-02T07:34:24+07:00
owner: pub
area: idea2
branch: fix/idea2-identity-agent-sc-config-argv
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — IDEA2 Identity Agent sc.exe config argument hotfix

## What changed

- Reproduced the exact one-argument `binPath= <command>` shape used by three temporary service-command scripts, matching the observed Machine A `sc.exe` exit 1639 before DPAPI evidence was produced.
- Corrected temporary and original-path restoration calls to pass `binPath=` and the full command value separately. Restoration is attempted even if temporary configuration or stopping fails. The shared helper preserves embedded quotes for Windows PowerShell 5.1, rejects packed/missing config arguments, and continues to fail on a nonzero `sc.exe` exit.
- Removed a stale test assertion that demanded the old one-string `start= auto` spelling; the executable-argument test still verifies the installer's separate option/value behavior.
- No service, installed runtime, key, camera, tunnel, Production system, or Production database was modified.

## Source files changed

- `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/identity-agent/identity_agent_safety.ps1` — enforce correct config argument shape and native quote forwarding.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/identity-agent/invoke_dpapi_preflight.ps1` — separate temporary and restore `binPath` arguments.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/identity-agent/provision_identity_key.ps1` — separate temporary and restore `binPath` arguments.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/identity-agent/invoke_acl_validation.ps1` — separate temporary and restore `binPath` arguments.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_windows_identity_agent_lifecycle.py` — RED/GREEN argument-shape, stop-failure restoration, quote, start/stop and nonzero-exit regression coverage.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_agent_windows_service.py` — remove the obsolete combined-option spelling assertion.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md` — record source-only state and required reviewed rollout.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-10-02_073424_pub_idea2-identity-agent-sc-config-argv.md` — this immutable task receipt.

## Verification evidence

- `C:\Users\puppu\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe -m unittest tests.test_windows_identity_agent_lifecycle tests.test_agent_key_store tests.test_agent_windows_service -q` — PASS: 60/60 after the restoration review fix.
- The argument-shape test failed for all three scripts before the fix. The stop-failure restoration test also failed for all three scripts before the nested-`finally` correction; all three now pass.
- `C:\Users\puppu\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe -m unittest tests.test_agent_session tests.test_agent_protocol tests.test_agent_pipe_protocol tests.test_identity_agent_browser_protocol tests.test_identity_agent_browser_server tests.test_identity_agent_client tests.test_windows_autostart -q` — PASS: 71 tests, 2 environment skips.
- PowerShell AST parse of `identity_agent_safety.ps1`, `invoke_dpapi_preflight.ps1`, `provision_identity_key.ps1`, `invoke_acl_validation.ps1`, and `install_identity_agent.ps1` — PASS: 5/5.
- `git diff --check` — PASS before receipt; final cached/commit checks are required before publication.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md` — adds the source-only hotfix and explicitly keeps Machine A/Production acceptance open.

## Shared surfaces touched

- None — source, tests, canonical status and receipt all remain inside IDEA2 ownership.

## Integration requests

- Pub/human reviewer: review and merge the hotfix PR before any separately approved refresh of the installed Machine A scripts or DPAPI preflight rerun. If rollback is needed, revert the source commit; this task did not mutate installed runtime state.

## Known limitations

- Live `sc.exe`, DPAPI evidence, key generation, and installed Machine A service behavior were not rerun or claimed; service-state safety evidence remains the owner's pre-hotfix observation.
- A broader CA-bundle test invocation had 3 local dependency errors because the bundled Python lacks `requests`; no CA-bundle source was changed and that suite is not claimed green.
- No push, PR, merge, deployment, or runtime acceptance is asserted by the receipt itself; publication state must be verified separately.
