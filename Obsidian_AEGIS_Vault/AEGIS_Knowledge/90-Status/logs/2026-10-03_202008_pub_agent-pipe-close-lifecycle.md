---
title: Task Receipt — M2-E3 successful Agent pipe-close lifecycle
date: 2026-10-03T20:20:08+07:00
owner: pub
area: idea2
branch: fix/idea2-agent-pipe-close-lifecycle
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — M2-E3 successful Agent pipe-close lifecycle

## What changed

- Base `d5e4072525bc213bba29e6ae491aac8dfc0de009`; final implementation/test checkpoint `11cfd3214b6058b5780dbd457a87615c201b5747`.
- Only after a complete Agent response write, the one-shot Windows pipe server now treats Win32 232 (pipe being closed) as a normal client close alongside existing Win32 109. Immediate `ReadFile`, pending `GetOverlappedResult`, and immediate `GetOverlappedResult` paths use the same narrow classification. The service can then immediately publish another first pipe instance without retry backoff.
- Win32 233 and unrelated errors, incomplete/failed response writes, ordinary close timeout, and trailing protocol data still fail. The 5-second local Engine pipe budget and separate 30-second Agent-response budget, signed wire protocol, SID/DACL, key/session authority, Agent HTTPS settings, Engine retry policy, and camera lifecycle are unchanged.
- Owner-provided live evidence following the preceding timeout change: Agent auth challenge/verify and 22 automatic heartbeat HTTP requests returned 200 at the HUB, with DB heartbeat updates, yet Engine reported `AGENT_UNAVAILABLE` and gaps of about 10–60 seconds. This is diagnostic context, not proof that this fix has recovered Machine A. Machine A was safely rolled back before this repository-only task.

## Source files changed

- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/pipe_server.py` — narrow post-response Win32 232 peer-close classification.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_agent_pipe_protocol.py` — RED/GREEN close-path matrix, response-write/timeout/233/trailing-data negatives, no-backoff/handle cleanup, and native sequential same-name republish regression.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md` — current source/local and pending live Machine A truth.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-10-03_202008_pub_agent-pipe-close-lifecycle.md` — this single final partial task receipt.

## Verification evidence

- RED before production edit: `python -B -m unittest tests.test_agent_pipe_protocol.PipeProtocolTests.test_post_response_peer_close_accepts_only_broken_or_closing_pipe -v` — four Win32 232 subtests errored in the immediate `ReadFile` exception/result and pending/immediate completion-result paths; 109 controls passed.
- RED before production edit: `python -B -m unittest tests.test_agent_pipe_protocol.PipeProtocolTests.test_successful_close_republishes_same_first_instance_without_service_backoff -v` — failed: only one pipe was created, because Win32 232 escaped after a complete HTTP 200 response and the service entered backoff.
- GREEN on local Windows Python 3.12/pywin32 test venv: `python -B -m unittest tests.test_agent_pipe_protocol tests.test_identity_agent_client` — 43/43 passed, zero skips. The native pywin32 test completed three sequential authorized one-shot round trips on a uniquely named disposable local pipe.
- `python -B -m unittest tests.test_agent_ca_bundle tests.test_agent_key_store tests.test_agent_pipe_protocol tests.test_agent_protocol tests.test_agent_session tests.test_agent_windows_service tests.test_identity_agent_browser_protocol tests.test_identity_agent_browser_server tests.test_identity_agent_client tests.test_windows_identity_agent_lifecycle` — 154/154 passed, zero skips.
- `python -B -m unittest discover -s tests` — full Detection Engine/Agent suite 252/252 passed, zero skips. Expected negative-test logs do not represent suite failures.
- Python AST parse and imports for Agent pipe server, service, Engine client, and their focused tests — PASS. PowerShell parser for Identity Agent install/repair and Engine install/repair scripts — four files, zero errors; scripts not changed.
- `node --test tests/collaborationPolicy.test.mjs tests/vaultStructure.test.mjs tests/vaultMultiWriter.test.mjs tests/coreEntryGovernanceR4.test.mjs` — 61/61 passed.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` — PASS with two pre-existing Canvas owner-review warnings.
- `git diff --check` and changed-content secret scan — PASS; zero whitespace errors and zero secret hits. Exact two-file source checkpoint staged and reviewed before commit.
- Independent read-only scoped review — Critical 0, Important 0. Optional timeout-drain and trailing-data test cases were added before final full-suite verification.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md` — distinguish owner-provided live evidence, locally verified source behavior, and still-pending installed Machine A acceptance.

## Shared surfaces touched

- None — all paths are IDEA2-owned Engine/Agent source, tests, and Pub-owned IDEA2 knowledge.

## Integration requests

- Pub owner review and human merge through this task PR. After merge, a separately approved, bounded Machine A source refresh and live automatic-heartbeat check must establish whether the installed runtime recovers; retain rollback capability. No agent merge or deployment is authorized by this receipt.

## Known limitations

- This task performed no installed Machine A, Agent service/runtime, Production, Production DB, camera, private key, tunnel, Browser Association, or PR #293 mutation. Live Machine A heartbeat recovery remains NOT VERIFIED.
- Controlled Win32-module tests and native disposable local-pipe tests prove the source lifecycle at those boundaries, not the owner’s Production HUB/installed-service behavior after deployment.
