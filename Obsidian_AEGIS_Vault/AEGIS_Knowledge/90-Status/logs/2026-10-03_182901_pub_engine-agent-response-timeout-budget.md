---
title: Task Receipt — Engine to Agent response timeout budget
date: 2026-10-03T18:29:01+07:00
owner: pub
area: idea2
branch: fix/idea2-engine-agent-response-timeout-budget
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — Engine to Agent response timeout budget

## What changed

- Separated the Engine's existing five-second local named-pipe availability/connect/request-write budget from a bounded Agent response budget, default 30 seconds. The latter begins only after a completed request write, allowing Agent-owned HTTPS work to finish without extending the unavailable-pipe wait.
- Owner-provided live evidence motivating this change: the Engine had all five pywin32 modules; local Engine→Agent control succeeded 5/5; idle automatic heartbeats still logged `AGENT_UNAVAILABLE` while the Production HUB observed an automatic heartbeat HTTP 200. This is consistent with timeout-budget inversion, not proof of live recovery after this source fix.

## Source files changed

- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/config.py` — bounded response timeout default, environment binding, and validation.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/engine.py` — pass both budgets to the Agent client in strict mode.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/identity_agent_client.py` — distinct local and post-write response deadlines without wire-protocol or authority changes.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/.env.example` — document both distinct budgets and the new 30-second default.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_identity_agent_client.py` — delayed response, local missing-pipe bound, config/wiring, malformed/unauthorized, and zero camera-demand regressions.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_agent_pipe_protocol.py` — preserve native cancellation proof with an explicit short response budget.

## Verification evidence

- `C:\Users\puppu\AppData\Local\Temp\aegis-idea2-engine-gen-venv\Scripts\python.exe -B -m unittest discover -s tests` — PASS: 245/245 on the final source tree; no failures or skips.
- `C:\Users\puppu\AppData\Local\Temp\aegis-idea2-engine-gen-venv\Scripts\python.exe -B -m unittest tests.test_identity_agent_client tests.test_agent_pipe_protocol tests.test_config tests.test_engine_lifecycle` — PASS: 48/48.
- RED: `tests.test_identity_agent_client.IdentityAgentClientTests.test_native_connector_accepts_agent_response_after_local_five_second_window` failed before implementation with `TimeoutError: named-pipe operation timed out`; separate config/client/Engine wiring tests failed because the response budget did not yet exist. GREEN: the focused and full counts above.
- Native short-response cancellation test initially failed because it assumed the obsolete shared deadline; after explicitly supplying a 0.1-second response budget it passed, and the full suite passed.
- `node --test tests/collaborationPolicy.test.mjs tests/vaultStructure.test.mjs tests/vaultMultiWriter.test.mjs tests/coreEntryGovernanceR4.test.mjs` — PASS: 61/61.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` — PASS with two existing canvas owner-review warnings.
- PowerShell parser on `windows/install_autostart.ps1` and `windows/repair_autostart.ps1` — PASS: zero errors; neither script changed.
- `git diff --check` and changed-content secret scan — PASS: zero whitespace errors or secret hits.
- Independent read-only scoped review — Critical 0, Important 0; its one minor non-default Win32-budget test gap was addressed before final focused/full reruns.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md` — distinguish owner-provided live evidence, local source verification, and pending Machine A heartbeat recovery.

## Shared surfaces touched

- None — all paths are IDEA2 Engine source/tests/configuration or Pub-owned IDEA2 knowledge.

## Integration requests

- None — no cross-scope path changed. Pub owner review/merge and separately approved Machine A Engine refresh/live heartbeat acceptance remain required; the prior installed Engine source should be retained as rollback until that gate passes.

## Known limitations

- No installed Machine A runtime, Identity Agent, Production, camera, private key, tunnel, or PR #293 mutation was performed. No live heartbeat recovery, browser acceptance, or deployment is claimed.
- The source-side timing regression uses controlled named-pipe modules and a clock; the existing native Windows cancellation test remains green, but a real post-install automatic heartbeat still requires owner-run acceptance.
