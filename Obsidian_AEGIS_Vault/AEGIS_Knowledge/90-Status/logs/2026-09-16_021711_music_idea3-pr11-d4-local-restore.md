---
title: Task Receipt — IDEA3 PR11 D4 Core-local RESTORE repository implementation
date: 2026-09-16T02:17:11+07:00
owner: music
area: idea3
branch: feat/idea3-pr11-d4-local-restore
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 PR11 D4 Core-local RESTORE repository implementation

## What changed

- Implemented the D4 Core-local RESTORE authority in the repository and verified it locally.
  - RESTORE is reachable only through `aegisctl restore`, over a private `AF_UNIX` socket owned by the Core UID.
  - Every request needs a scrypt operator credential, the exact typed confirmation `RESTORE UPLINK`, a bounded printable reason, and the approved local origin.
  - The Core must have observed `LOCKDOWN`.
  - A strict durable audit row must commit before the single publication.
- `aegisctl restore-credential` provisions the private hash interactively. It never overwrites an existing file.
- Every Core command source is serialized through the supervisor command guard.
  - A CUT outranks an unpublished RESTORE.
  - A CUT that arrives after RESTORE publication queues behind it.
  - Dispatch rechecks the single command owner before it claims an action.
- Evidence and failure reporting:
  - An unexpected post-publication failure reports `OUTCOME_UNKNOWN`.
  - Protocol ACK/STATUS is never labelled relay or physical evidence.
- None of these holds RESTORE authority: Web, browser, dispatch, Telegram, reconnect, restart, recovery, heartbeat, ACK/STATUS receipt, and shutdown/startup.
- Task: IDEA3 PR11 D4.
- Base SHA: `1dc786353dd4dcea0a5959a926667470dd394ffe`, then a normal merge of `a6acfde547417aa0c2c1c5dd948e5209ffc4dd84`, which contains PR #137 at `7a80596392520050acbe1d00c778959b002cda6b`.
- Implementation checkpoint: `d3d195fbe3102288e845584663cf4ff03fad0b67`.
- Final implementation/evidence checkpoint, the verified merge tree: `f4adb4291d56862b871757411cb207841791091e`.
- State at handoff:
  - `D4_SOURCE_IMPLEMENTED=YES`; `D4_CLI_IMPLEMENTED=YES`; `D4_AUDIT_FAIL_CLOSED=YES`;
  - `D4_REPOSITORY_IMPLEMENTATION=COMPLETE`; `D4_LOCAL_VERIFICATION=PASS`; `D4_LIVE_VERIFIED=NO`;
  - `WEB_RESTORE_AVAILABLE=NO`; `TELEGRAM_RESTORE_AVAILABLE=NO`; `AUTOMATIC_RESTORE_AVAILABLE=NO`;
  - `LIVE_RESTORE_EXECUTED=NO`; `GPIO_ACTUATED=NO`; `PRODUCTION_MUTATION=NONE`;
  - `K1_OWNER_DECISION=PENDING_KLA`; `K3_OWNER_DECISION=PENDING_KLA`; `K7_OWNER_DECISION=PENDING_KLA`;
  - `PHASE2_RUNTIME_COMPLETE=NO`; `PHASE3_RUNTIME_COMPLETE=NO`; `PHASE4_RUNTIME_COMPLETE=NO`; `PR11_COMPLETE=NO`.
- K1/K3/K7 are not transcribed. PR #137 merged with a `kraveerachat` APPROVED review whose body is empty. Under that record's §3 rule, an approval with no decision line leaves each value `PENDING_KLA`.

## Source files changed

- `IDEA3-AEGIS_Lockdown/aegis_soc/local_restore.py` — new module containing:
  - the credential;
  - reason validation;
  - the gate;
  - the `AF_UNIX` server and client;
  - the evidence query.
- `IDEA3-AEGIS_Lockdown/aegis_soc/cli.py` — adds the `restore` and `restore-credential` commands.
- `IDEA3-AEGIS_Lockdown/aegis_soc/supervisor.py` — changes:
  - adds the command guard;
  - adds the CUT-priority and deferred-CUT logic;
  - wires the D4 origin and the channel lifecycle.
- `IDEA3-AEGIS_Lockdown/aegis_soc/dispatch_worker.py` — dispatch rechecks the command owner before it claims; a `COMMAND_PENDING` reason is recorded truthfully.
- `IDEA3-AEGIS_Lockdown/aegis_soc/database.py` — adds `log_event_strict` for the fail-closed audit.
- `IDEA3-AEGIS_Lockdown/aegis_soc/runtime.py` — changes:
  - adds the D4 credential preflight;
  - preserves the store-path preflight for an injected Protocol v1 context.
- `IDEA3-AEGIS_Lockdown/aegis_soc/config.py` — adds `AEGIS_RESTORE_CREDENTIAL_FILE`.
- `IDEA3-AEGIS_Lockdown/tests/test_local_restore.py` — new D4 suite.
- `IDEA3-AEGIS_Lockdown/tests/test_dispatch_contract.py` — adds the contention and owner-recheck regressions.
- `IDEA3-AEGIS_Lockdown/.env.example` — documents the credential-file variable; it holds no value.
- `IDEA3-AEGIS_Lockdown/deploy/aegis-idea3-core.env.example` — adds an example credential path; it holds no secret.
- `IDEA3-AEGIS_Lockdown/deploy/aegis-idea3-core.service.example` — adds a comment on the read-only `/etc` credential.
- `IDEA3-AEGIS_Lockdown/docs/operations/production-runtime.md` — adds the D4 provisioning and use procedure, marked NOT RUN.
- `IDEA3-AEGIS_Lockdown/README.md` — documents D4 usage and the Telegram `/restore` refusal.

## Verification evidence

- `git merge --no-edit origin/main` — pass: clean normal merge. It changed no D4 file, and PR #137 and `origin/main` are both ancestors of HEAD.
- Environment: this workstation, Linux; the pinned `~/.venvs/aegis-idea3-core` (Python 3.14.7, paho 2.1.0, pytest 9.1.1); Node 24.16.0. Every run below was on `f4adb429`.
- `PYTHONDONTWRITEBYTECODE=1 ~/.venvs/aegis-idea3-core/bin/python -m pytest -p no:cacheprovider -q tests/test_local_restore.py` — pass: 150 passed.
- The same runner on the `test_dispatch_contract`, `test_dispatch_boundary`, `test_dispatch_client`, `test_dispatch_ledger`, `test_controller`, `test_core`, `test_core_service`, `test_restore_authority`, `test_runtime`, and `test_production_runtime` files — pass: 221 passed.
- The same runner on the `test_protocol_v1`, `test_protocol_v1_vectors`, `test_protocol_inbound`, `test_protocol_mode`, `test_protocol_ordering`, `test_protocol_preflight`, `test_protocol_runtime`, `test_protocol_store`, `test_firmware_protocol_parity`, `test_mqtt_client`, and `test_trusted_time` files — pass: 353 passed.
- `PYTHONDONTWRITEBYTECODE=1 ~/.venvs/aegis-idea3-core/bin/python -m pytest -p no:cacheprovider -q` — pass: 886 passed, 6 skipped, 0 failed.
- `~/.venvs/aegis-idea3-core/bin/ruff check aegis_soc tests --no-cache` (ruff 0.16.3) — pass.
- `PYTHONPYCACHEPREFIX=<temporary> ~/.venvs/aegis-idea3-core/bin/python -m compileall -q aegis_soc tests` — pass.
- `node --test --test-reporter=tap tests/collaborationPolicy.test.mjs tests/dockerBootstrap.test.mjs tests/endpointOnboarding.test.mjs tests/vaultMultiWriter.test.mjs tests/vaultStructure.test.mjs` — pass: 63 passed, 0 failed.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` — pass, with the two pre-existing canvas owner-data warnings.
- `node scripts/validate-collaboration-policy.mjs --event <synthetic event with this PR body> --changed-files <git diff --name-status origin/main>` — pass, for both a Draft and a Ready event.
- D4 negative controls NC-D4-01 to NC-D4-16 — pass: 16/16 detected.
  - Method: each control ran on a disposable copy of `IDEA3-AEGIS_Lockdown/`. Its targeted tests passed at baseline, one invariant was mutated, and the tests then failed with pytest exit 1. The source was restored, the tests passed again, and the file was byte-identical to the worktree. The copy was removed, and the worktree stayed unchanged.
  - Controls:
    - fail-closed audit;
    - authentication;
    - typed confirmation;
    - reason;
    - local origin;
    - peer UID;
    - no non-D4 origin authority;
    - CUT priority;
    - no physical-evidence promotion;
    - `--wait` never resends;
    - handler error reports `OUTCOME_UNKNOWN`;
    - credential mode `0600`;
    - runtime-directory permissions;
    - the client authenticates the server UID;
    - dispatch owner recheck;
    - Telegram static isolation.
  - The first NC-D4-15 attempt was invalid. That was a harness defect: the anchor matched twice. After the anchor was narrowed, NC-D4-15 was detected.
- `deploy/production-like-negative-controls.py --data-root <temporary>` — fail (precondition only, not executed): it stopped at `Web build missing` because `IDEA3-AEGIS_Lockdown/web/dist/index.html` is absent in this worktree. Classification: ENVIRONMENTAL. D4 changed no Web file. The pytest module `tests/test_production_like_negative_controls.py` passed inside the full suite. The temporary data root was removed with no residue.
- Secret scan of every added line in `git diff origin/main...HEAD`, covering private-key, certificate, cloud/GitHub/Slack/Telegram token, scrypt-hash, and password/token assignment patterns — pass: 0 matches.
- Binary/artifact scan of `git diff --numstat` and changed paths (`__pycache__`, `.pyc`, `.log`, SQLite, `.env`, key/cert, `.credential`, archives) — pass: 0 binary files, 0 artifact paths.
- `git diff --check origin/main...HEAD` and `git diff --check` — pass.
- `gh pr view 137 --json state,mergeCommit,reviews` — pass:
  - MERGED at `7a805963` (2026-09-15T18:43:26Z);
  - `kraveerachat` APPROVED at 18:43:19Z with an empty body.
- Receipt count under `90-Status/logs/` against `origin/main` — pass: exactly 1 added receipt (this file), 0 modified. The PR #137, #136, and #135 receipts are unchanged.
- Not run:
  - system-Python suite;
  - IDEA3 Web vitest (no Web file changed);
  - PlatformIO (no firmware file changed).

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — changes:
  - adds the 2026-09-16 D4 section as the current entry point. It contains the state block, Current Task, the implemented contract, the D4 Session Register (D4-R1 `d3d195fb`, D4-C `f4adb429`, D4-L1 BLOCKED), local evidence, and limitations;
  - demotes the PR #137 section to a note and records its merge with an empty-body Kla approval, so K1/K3/K7 stay `PENDING_KLA`;
  - updates the lead paragraph;
  - replaces the stale PR11 line "Architecture only, not implemented: the Core-local RESTORE CLI (D4)".
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-moc.md` — the entry point now routes readers to the D4 locally verified, never-live state and to the `PENDING_KLA` K1/K3/K7 values.

## Shared surfaces touched

- None — every changed path is Music-owned: `IDEA3-AEGIS_Lockdown/**`, the IDEA3 canonical notes, or this Music receipt. These are unchanged:
  - IDEA1, IDEA2, `HUB-AEGIS_Entry/**`, `infrastructure/**`, `shared/**`, and `.github/**`;
  - every historical receipt, including those of PR #137, #136, and #135.

## Integration requests

- None — no cross-scope or shared path changed. Kla (`kraveerachat`) remains the temporary GitHub reviewer for IDEA3 under repository policy.
- Not requested here:
  - K1, K3, and K7 remain `PENDING_KLA`, and their decision lines are still owed on the PR #137 record;
  - live D4 credential provisioning and use (D4-L1) need Phase 3 runtime, a Core host, and a separately authorized maintenance window.

## Known limitations

- `D4_LIVE_VERIFIED=NO`. The following were not provisioned or run: credential, Core service, broker, board, relay, GPIO, CUT, RESTORE, service restart, network change, or reboot. The provisioning and use procedure in `docs/operations/production-runtime.md` is marked NOT RUN.
- Incident context is carried only in the free-text reason. There is no structured incident identifier.
- One shared operator secret authenticates, and the operator runs as the Core UID. The audit records the peer UID and PID, not a distinct human identity.
- The D4 code does not enforce the console-or-Management-VLAN-SSH access rule. It depends on host and network controls that are not yet proven live.
- Relay confirmation stays `NOT_AVAILABLE`, and physical evidence stays `NOT_PROVEN`. A live RESTORE still needs independent physical verification.
- The inherited production-like negative controls were not executed in this environment because the Web build is absent.
