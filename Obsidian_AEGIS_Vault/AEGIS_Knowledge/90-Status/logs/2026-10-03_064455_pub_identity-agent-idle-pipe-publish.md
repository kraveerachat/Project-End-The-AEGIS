---
title: Task Receipt — Identity Agent idle pipe publication
date: 2026-10-03T06:44:55+07:00
owner: pub
area: idea2
branch: fix/idea2-identity-agent-idle-pipe-publish
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — Identity Agent idle pipe publication

## What changed

- Source checkpoint `534db82408df97817496cfb809c7ac96958932aa` fixes the M2-E3 idle named-pipe accept path: after a bounded cancellation/drain, no-client timeout ends one `serve_once` normally, letting the service immediately publish its next instance without retry backoff.
- Unexpected cancellation-drain failures still propagate. Connected read/write timeout, SID, DACL, first-instance, and zero-camera-demand boundaries remain fail-closed or unchanged.
- Owner-provided Machine A evidence before this fix was 200 pipe-absent observations in about 20 seconds despite a running Agent service; an isolated pywin32 diagnostic pipe succeeded. The local fix does not itself prove recovery on the installed Machine A runtime.

## Source files changed

- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/pipe_server.py` — classify only a cancelled idle accept as normal and propagate unexpected drain errors.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_agent_pipe_protocol.py` — RED/GREEN idle, backoff, cancellation, connected-timeout, and native Windows republish/authorized heartbeat coverage.

## Verification evidence

- `C:\Users\puppu\AppData\Local\Temp\aegis-idea2-engine-gen-venv\Scripts\python.exe -B -m unittest tests.test_agent_pipe_protocol.PipeProtocolTests.test_unexpected_accept_drain_failure_is_not_classified_as_idle` — FAIL as expected RED before drain-error fix: unexpected error was swallowed.
- `C:\Users\puppu\AppData\Local\Temp\aegis-idea2-engine-gen-venv\Scripts\python.exe -B -m unittest tests.test_agent_pipe_protocol tests.test_agent_windows_service tests.test_identity_agent_client` — PASS: 42 tests, zero failures or skips.
- `C:\Users\puppu\AppData\Local\Temp\aegis-idea2-engine-gen-venv\Scripts\python.exe -B -m unittest discover -s tests` — PASS: 237 tests, zero failures.
- `C:\Users\puppu\AppData\Local\Temp\aegis-idea2-engine-gen-venv\Scripts\python.exe -B -m unittest tests.test_agent_pipe_protocol.PipeProtocolTests.test_native_idle_accept_republishes_for_real_engine_authorized_client` — PASS, repeated three times using a disposable uniquely named local pipe; no installed Agent service or camera used.
- `git diff --check` and `git diff --cached --check` — PASS before source checkpoint; exact two-file source/test scope verified.
- Independent scoped review — Critical=0, Important=0, Minor=0 after the unexpected-drain-error regression and correction.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md` — recorded source/local verification and pending Machine A acceptance without claiming deployment.

## Shared surfaces touched

- None — all changed paths are within IDEA2 source, tests, canonical status, and task receipt ownership.

## Integration requests

- Pub/owner: review and merge this PR before any Machine A rollout. Separately authorize a bounded Agent source refresh preserving the existing version-2 private key and configuration; prove continuous pipe publication and automatic heartbeat recovery with Production read-only before/after evidence. If acceptance fails, restore the previous installed Agent source without regenerating or exporting the key.

## Known limitations

- Installed Machine A runtime, its live pipe publication, and M2-E3 heartbeat recovery have not been tested after this source fix. Browser Association remains out of scope.
- No Production, Machine A runtime/service/key, camera, tunnel, or PR #293 mutation occurred.
