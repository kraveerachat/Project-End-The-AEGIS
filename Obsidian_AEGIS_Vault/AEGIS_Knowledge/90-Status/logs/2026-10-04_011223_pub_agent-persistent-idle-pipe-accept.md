---
title: Task Receipt — Agent persistent idle pipe accept
date: 2026-10-04T01:12:23+07:00
owner: pub
area: idea2
branch: fix/idea2-agent-persistent-idle-pipe-accept
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — Agent persistent idle pipe accept

## What changed

- The first-instance Windows Identity Agent pipe remains published through an idle overlapped `ConnectNamedPipe`; the five-second connected-operation timeout no longer cancels an idle accept.
- Shutdown cancels and drains the idle accept, clears the active handle, and closes it once. Win32 995 is accepted only for intentional idle-accept shutdown; connected failures remain fail-closed.
- Source and local Windows tests are verified. M2-E3 is not closed: installed Machine A heartbeat recovery requires human-reviewed merge and separate live acceptance.

## Source files changed

- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/pipe_server.py` — persistent idle accept and bounded shutdown cancellation/drain.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_agent_pipe_protocol.py` — RED/GREEN unit and native Windows connector/shutdown/cadence regression coverage.

## Verification evidence

- `python -m unittest tests.test_agent_pipe_protocol.PipeProtocolTests.test_idle_accept_remains_published_past_read_timeout_until_shutdown tests.test_agent_pipe_protocol.PipeProtocolTests.test_idle_accept_shutdown_does_not_trigger_service_retry_backoff -q` — FAIL as intended (RED): two failures on the previous idle-cancel behavior.
- `python -m unittest tests.test_agent_pipe_protocol.PipeProtocolTests.test_connect_abort_995_is_normal_only_for_intentional_shutdown -q` — RED before the shutdown-race guard; GREEN after it.
- `python -m unittest tests.test_agent_pipe_protocol -q` — PASS, 41 tests, including native Windows idle >12 seconds, requests around five seconds, pending-idle shutdown, and 50/100 no-prepoll stress.
- `python -m unittest discover -s tests -q` — PASS, 273 tests on Windows with pywin32 available; no skips reported.
- `node --test tests/collaborationPolicy.test.mjs tests/vaultStructure.test.mjs tests/vaultMultiWriter.test.mjs` — PASS, 59 tests.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` — PASS with two pre-existing owner-data Canvas warnings.
- `git diff --check` — PASS.
- Independent read-only review — Critical 0, Important 0; test-proof suggestions incorporated.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md` — records the source-verified idle-accept fix and explicitly preserves the Machine A acceptance gate.

## Shared surfaces touched

- None — task stayed inside IDEA2-owned source, tests, and knowledge.

## Integration requests

- IDEA2 owner: review and merge the PR before authorizing a separate Machine A runtime refresh and live heartbeat acceptance; rollback is to the previously installed Agent artifact if the live gate fails. Do not infer recovery from local tests.

## Known limitations

- Installed Machine A heartbeat recovery, Production deployment, and post-merge Machine A acceptance were not performed. `M2_E3=NOT_CLOSED_PENDING_POST_MERGE_MACHINE_A_ACCEPTANCE`.
