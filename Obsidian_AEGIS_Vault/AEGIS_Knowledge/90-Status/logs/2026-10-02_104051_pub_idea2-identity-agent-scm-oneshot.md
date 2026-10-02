---
title: Task Receipt — IDEA2 Identity Agent SCM-compatible one-shot maintenance
date: 2026-10-02T10:40:51+07:00
owner: pub
area: idea2
branch: fix/idea2-identity-agent-scm-oneshot
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — IDEA2 Identity Agent SCM-compatible one-shot maintenance

## What changed

- Reproduced the SCM lifecycle defect behind Machine A error 1053: the three
  service-identity maintenance modes ran and exited before entering
  `StartServiceCtrlDispatcher`.
- Kept each temporary service command in `--service` mode and deferred exactly
  one bounded maintenance callback to `SvcDoRun`. Maintenance construction does
  not construct the normal browser listener, named-pipe host, Monitor transport,
  heartbeat, Engine, or camera surfaces.
- Preserved pywin32 ownership of final service state: a successful callback
  returns and a failed callback propagates so the native host reports the
  service-specific failure. The PowerShell wrappers query fresh final service
  state and reject nonzero Win32 or service-specific exit codes before accepting
  current evidence.
- Preserved checked `sc.exe` invocation and nested restoration of the original
  `PathName`, DPAPI CurrentUser scope, service-only private-key ownership,
  resumable/non-rotating provisioning, and read-only ACL attestation.
- No installed service, Machine A runtime, key, evidence, listener, camera,
  tunnel, Production system, or Production database was modified.

## Source files changed

- `IDEA2-AEGIS_CCTV-Operator/detection-engine/run_identity_agent.py` — require service dispatch for maintenance and defer the selected bounded action.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/windows_service.py` — execute one optional maintenance action without constructing normal Agent surfaces; leave final status to pywin32.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/identity-agent/identity_agent_safety.ps1` — fail closed on nonzero final maintenance-service exit status.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/identity-agent/invoke_dpapi_preflight.ps1` — use dispatcher-backed maintenance and verify clean service completion before DPAPI evidence.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/identity-agent/provision_identity_key.ps1` — use dispatcher-backed maintenance and verify clean service completion before provisioning evidence.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/identity-agent/invoke_acl_validation.ps1` — use dispatcher-backed maintenance and verify clean service completion before ACL evidence.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_agent_windows_service.py` — dispatcher, exact-one-action, no-normal-host, failure propagation, normal-service, and legacy direct-shape regressions.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_windows_identity_agent_lifecycle.py` — actual temporary command-shape, final service exit-code, checked transition, and restoration coverage.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md` — record source/local verification and remaining live gate.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-10-02_104051_pub_idea2-identity-agent-scm-oneshot.md` — this immutable task receipt.

## Verification evidence

- RED: `python -m unittest tests.test_agent_windows_service tests.test_windows_identity_agent_lifecycle.WindowsIdentityAgentLifecycleTests.test_temporary_service_commands_pass_binpath_option_and_value_separately -v` — failed because service+maintenance was rejected, direct maintenance was accepted, and the service builder had no one-shot action.
- Review-fix RED: the focused status tests failed because `SvcDoRun` emitted `SERVICE_STOPPED` directly and wrappers did not inspect final service exit codes.
- `python -m unittest tests.test_windows_identity_agent_lifecycle tests.test_agent_key_store tests.test_agent_windows_service -q` — PASS: 67/67.
- `python -m unittest tests.test_agent_session tests.test_agent_protocol tests.test_agent_pipe_protocol tests.test_identity_agent_browser_protocol tests.test_identity_agent_browser_server tests.test_identity_agent_client tests.test_windows_autostart -v` — PASS: 69 passed, 2 native-pywin32 environment skips.
- `python -m unittest tests.test_agent_ca_bundle -v` — PARTIAL ENVIRONMENT LIMITATION: 8 passed, 3 errors because the bundled verification Python lacks `requests`; no CA source changed.
- PowerShell AST parsing of the shared safety helper, three maintenance wrappers, and installer — PASS: 5/5.
- `node --test tests/collaborationPolicy.test.mjs tests/vaultStructure.test.mjs` — PASS: 58/58.
- `node scripts/validate-vault.mjs` — PASS with two pre-existing owner-data Canvas warnings.
- Python syntax compilation, `git diff --check`, and changed-content secret scan — PASS.
- Independent scoped review after corrections — Critical=0, Important=0, Minor=0.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md` — records dispatcher-backed maintenance, final service-status validation, local evidence, and the still-open Machine A gate.

## Shared surfaces touched

- None — task stayed inside the selected IDEA2 source, tests, and knowledge boundary.

## Integration requests

- Pub/human owner: review and merge the task PR before any separately approved
  installed-runtime refresh or live Machine A DPAPI/provisioning/ACL attempt.
  Roll back by reverting this task commit; no live state was changed here.

## Known limitations

- Real Machine A SCM behavior has not been rerun with this corrected source;
  error 1053 is source-reproduced and locally regression-tested, not yet live accepted.
- The local CA-bundle suite has 3 dependency errors because `requests` is absent;
  its 8 dependency-independent tests pass and CA behavior was not modified.
- No PR, merge, deployment, runtime refresh, key creation, or Production action
  is claimed by this receipt. Human review and merge remain required.
