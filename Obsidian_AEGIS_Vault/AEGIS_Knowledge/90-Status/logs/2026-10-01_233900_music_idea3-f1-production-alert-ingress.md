---
title: Task Receipt — IDEA3 F1 production alert ingress (Recovery R1 source)
date: 2026-10-01T23:39:00+07:00
owner: music
area: idea3
branch: feat/idea3-recovery-f1-alert-ingress
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 F1 production alert ingress (Recovery R1 source)

## What changed

- **Repository-only F1 implementation. IMPLEMENTED != DEPLOYED.** Base `main` `64f59fbfb0c4d7a731f24e5f0d673a420529c67b` (confirmed unmoved at closeout); F1 source head `42dac1e045ad8b2122578166e89960d4f2372beb`. Nothing was deployed, no host command was run, Production was NOT mutated, the Core was NOT restarted, L7u was NOT run, Recovery R1-R8 was NOT run live, no ESP32, no L8.
- **Main reconciliation (provenance, 2026-10-02):** `CURRENT_MAIN = bf3439ab6c0736a9813fa9020109d3ecd5ad9ce1`; `PR247_MERGED = YES`, `PR247_MERGE_COMMIT = bf3439ab6c0736a9813fa9020109d3ecd5ad9ce1`; `F1_RECONCILED_AFTER_PR247 = YES`, by merging `origin/main` into this branch (merge commit `3fe030aa2fba9d9b4743a7452cfadbd2a7331252`; no force-push, no rebase). Only `idea3-status.md` overlapped; it merged cleanly with PR #247's L8 status section and the F1 section both preserved, and no F1 source file changed (byte-identical to the verified `42dac1e045ad8b2122578166e89960d4f2372beb`). The earlier base `64f59fbf…` named elsewhere in this receipt was `main` when the measurements below were taken; the post-merge re-verification is recorded in its own verification entry. `F1_PRODUCTION_DEPLOYED = NO`, `F1_REAL_DETECTOR_ACCEPTANCE = NO`, `F1_DEPLOYMENT_INCLUDED = NO`, `BREAK_GLASS_IMPLEMENTED = NO`, `R5_READY_FOR_PR = NO`.
- **Problem (F1):** Recovery R1 was unreachable in production. The only caller chain to `CoreRecoveryService.bind_incident` was the legacy MQTT `aegis/attacker_ip` message path, which exists only in `legacy-v0-lab` mode; Protocol v1 (design OD-4) removed that topic from the broker ACL and from every v1 subscription, and the production Core runs `--no-detector`.
- **Solution:** a Core-local AF_UNIX alert ingress, implemented inside the existing runtime module `recovery_core.py` (`AlertIngress`, `AlertServer`, `parse_alert`) so the release runtime closure and module set are unchanged.
  - **Trust boundary (peer first):** the kernel authenticates the sender with `SO_PEERCRED`. The configured uid (`AEGIS_ALERT_SOURCE_UID`, new setting; unset or invalid = channel disabled) is the only accepted peer. A wrong peer is answered `PEER_REFUSED` before a single request byte is read. The socket is `<runtime_dir>/alert.sock`, Core-owned `0600`, and the channel starts only in the production profile.
  - **Exact payload contract:** one JSON line, at most 256 bytes, exactly `{"v":1,"attacker_ip":"x.x.x.x"}`. Exact key set, integer `v == 1` (booleans refused), strict IPv4 through the root helper's own `validate_block_target` rules (unspecified, this-network, loopback, multicast, link-local and reserved refused). No path, command, action, hostname or secret field exists.
  - **Bounds:** 2 s total read deadline; a token bucket (burst 5, 10 per minute); refusal audit rows are capped per window.
  - **Effect limited to `bind_incident`:** a valid alert calls `supervisor.on_production_alert`, which calls `recovery.bind_incident(ip)` and logs. It never calls the legacy `_on_attacker` path, containment, `issue_command`, CUT, RESTORE, or MQTT publish. Same IP gives `EXISTING`; a different IP while an incident is open gives `IGNORED_DIFFERENT_IP`; an audit failure is reported `AUDIT_UNAVAILABLE`, never success.
  - **Inert until deployment:** the supervisor starts the ingress after the Recovery channel and stops it on shutdown; a channel failure is logged and never stops the Core. Merging changes nothing at runtime until a separate governed stage sets `AEGIS_ALERT_SOURCE_UID` in the production `core.env`.
- **Scope split:** the R5 normal-path RESTORE enforcement and the break-glass plan were deliberately NOT included. They are preserved locally (`feat/idea3-recovery-r5-preserved` at `0c17319a7b1d558935e8ebd7298156f3fae69325`; combined work at `wip/idea3-f1-r5-preserved` `ae811cf3f99b287a729d56805094503dbf38fa4e`) and are not part of this task. `local_restore.py` and `database.py` are byte-identical to `origin/main`, so F1 changes no RESTORE behavior and `F1_MERGE_ALONE_CREATES_RESTORE_LOCKOUT = NO`.
- **Not included (separate governed deployment stage):** the detector sink that feeds the socket, the detector systemd unit, `AEGIS_ALERT_SOURCE_UID` in the production `core.env`, and a governed Core restart. `F1_DEPLOYMENT_INCLUDED = NO`.

## Source files changed

- `IDEA3-AEGIS_Lockdown/aegis_soc/recovery_core.py` — `AlertIngress`, `AlertServer`, `parse_alert`, alert constants; `RecoveryServer` gained `max_message_bytes` and `thread_name` class attributes (no behavior change for Recovery); `validate_block_target` import. The R5 precondition helper is untouched.
- `IDEA3-AEGIS_Lockdown/aegis_soc/supervisor.py` — `alert_server`, `on_production_alert`, `start_alert_ingress`, `stop_alert_ingress`; started after the Recovery channel in `run()` and stopped in its `finally`.
- `IDEA3-AEGIS_Lockdown/aegis_soc/config.py` — `ALERT_SOURCE_UID = _optional_int("AEGIS_ALERT_SOURCE_UID")`.
- `IDEA3-AEGIS_Lockdown/tests/test_core_alert_ingress.py` — NEW, 60 tests.
- `IDEA3-AEGIS_Lockdown/tests/test_core_recovery_security.py` — docstring and comment text only: F1 is now served by the ingress; the assertions are unchanged.
- `IDEA3-AEGIS_Lockdown/README.md` — R1 paragraph: the production alert source and its inert-until-deployed status.

## Verification evidence

- `pytest tests/test_core_alert_ingress.py -q` — pass (all evidence here is local and simulated; the AF_UNIX server ran against a temporary supervisor and audit database, never a real detector or the live Core): `60 passed` (RED first: the module did not exist; GREEN after implementation). Covers: valid alert binds and writes `INCIDENT_BOUND`; no containment, CUT, RESTORE, MQTT publish or `_on_attacker`; wrong uid refused before any read (zero-byte client); malformed, oversized, extra-key, boolean-version and bad-address payloads refused; duplicate semantics; token-bucket and bounded audit; read deadline; non-production and unset-uid disabled; `0600` socket in the runtime directory; channel failure never stops the Core; no TCP/UDP primitive; v1 does not subscribe to the legacy topic; the alert path source contains no process, service, filesystem or network primitive; the alert path cannot reach `issue_command`, the controller, `LocalRestoreGate.handle` or MQTT publish.
- `pytest tests/test_core_recovery.py tests/test_core_recovery_security.py -q` — pass: `109 passed, 1 xfailed` (the xfail is the pre-existing strict R5 production-wiring marker, intentionally still present because R5 is not part of this change).
- 22-file regression group (D4, Core, dispatch, containment, MQTT, runtime, L7 builder/guard/installer/core-env/handler/runner, L7u governance/engine/runtime-contract/builder-runtime) — `1308 passed, 1 failed` on the first run; the one failure is the baseline close-channel flake documented below. The 12-file D4/runtime subset of that group — pass: `436 passed`, twice on F1 and twice on unmodified `origin/main`.
- `pytest tests -q` (full IDEA3 suite, run alone on the F1 head) — pass: `4654 passed, 8 skipped, 1 xfailed, 0 failed` in 1325 s.
- Post-PR #247 reconciliation on the merged tree `3fe030aa` — pass: `pytest tests/test_core_alert_ingress.py -q` `60 passed`; `pytest tests/test_core_recovery.py tests/test_core_recovery_security.py -q` `109 passed, 1 xfailed`; the 23-file L7/L7u/D4/runtime regression group `1309 passed`; real scratch build of the merged tree (`f1-post247-3fe030aa`), canonical `verify --expect-owner self` and the L7u engine preflight guard all pass, with `recovery_core.py`, `recovery_protocol.py`, `recovery_client.py` and `recovery_ui.py` present, the F1 code present, no R5 identifier, the same 25-module set and unchanged `requirements.txt` (`paho-mqtt==2.1.0`); `ruff check` on the F1 Python files pass. The full IDEA3 suite was not rerun because no F1 source file changed.
- Real scratch release build, `python deploy/pr11-phase4/p4-l7-build-release.py build --source-root <F1 worktree> --release-id f1-alert-ingress-42dac1e0` against the owner's offline `l7u-wheelhouse` — pass: `L7_RELEASE_BUILD=PASS`, 50 files, tree clean, `SOURCE_GIT_SHA=42dac1e0…`. Nothing was installed.
- `p4-l7-build-release.py verify <release> --expect-owner self` — pass: `L7_RELEASE_VERIFY=PASS`; `RELEASE-SHA256SUMS` checks pass.
- L7u engine preflight guard on the built release (`load_guard().check(...)` and the four-file check from `p4-l7u-upgrade.py`) — pass: guard check pass, `recovery_core.py`, `recovery_protocol.py`, `recovery_client.py` and `recovery_ui.py` all present.
- Built release content check — pass: `AlertIngress`, `AlertServer`, `on_production_alert`, `start_alert_ingress` and `ALERT_SOURCE_UID` are in the release; no R5 identifier is; module set identical to the PR #277 closure (25 modules plus `__init__`); `requirements.txt` unchanged (`paho-mqtt==2.1.0`, same hash), so no new dependency and no module sweep.
- `ruff check` on the changed Python files — pass. (`ruff check aegis_soc` reports one pre-existing UP035 in untouched `ip_containment.py`.)
- `git diff --check` — pass. `node scripts/validate-vault.mjs` — pass: `Vault validation passed with 2 warning(s)` (the two pre-existing canvas owner-review warnings). Local run of `node scripts/validate-collaboration-policy.mjs` against the prepared Draft PR body and the exact changed-file list — pass: `Collaboration policy passed.` Changed-content secret scan (private-key, cloud-key, GitHub-token and JWT patterns over the F1 source diff, the receipt and the status note) — pass: 0 hits.
- Baseline close-channel flake — **recorded, not caused by F1.** `tests/test_local_restore.py::test_closing_the_channel_cancels_an_incomplete_client_before_returning` (a 1-second wait) failed once in an earlier combined F1+R5 full run and once in a 22-file group run. `local_restore.py` is identical to `origin/main`. On F1 idle: exact test `15 passed` of 15, its module `5 passed` of 5. Under six concurrent disk-sync writers on the same host, alternating: unmodified `origin/main` failed 1 of 26 runs, F1 failed 1 of 26 runs. Classified `BASELINE_HOST_STATE_FLAKE`; the test and its timeout were not modified. The F2 receipt (`2026-09-30_035700_music_idea3-recovery-f2-fail-closed.md`) recorded the same test failing once in a full-suite run on its own branch while passing on the unmodified parent.
- Baseline L6c capture-gap test — `tests/test_pr11_phase4_l6c_capture_gap.py::test_real_end_to_end_capture_then_compare_requires_the_allow_file` failed once in an earlier F1+R5 full run (and 2 of 6 times on unmodified `origin/main`, 6 of 6 under UDP socket churn): the fixture sets `AEGIS_P4_FS_ROOT`, so the ephemeral-UDP filter cannot read `/proc` while `ss` still reads the real host. It passed in the final full run. It was not modified.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — added a narrow F1 section at the top: `F1_REPOSITORY_IMPLEMENTED`, `F1_LOCAL_VERIFIED`, `F1_PRODUCTION_DEPLOYED = NO`, `F1_REAL_DETECTOR_ACCEPTANCE = NO`, `R5_REPOSITORY_MERGED = NO`, `BREAK_GLASS_IMPLEMENTED = NO`, `R5_READY_FOR_PR = NO`, `F1_MERGE_ALONE_CREATES_RESTORE_LOCKOUT = NO`. No other section was edited.

## Shared surfaces touched

- `None` — task stayed inside its selected area

## Integration requests

- None — valid only when no cross-scope/shared path changed

## Known limitations

- Repository implementation only. No live detector integration: no detector has ever sent an alert to this socket, and the AF_UNIX server was not exercised against the live Core.
- The detector source uid is still an operational and deployment choice (root, or a dedicated account that can read the auth log or journal and traverse `/run/aegis-idea3`). It is not decided here.
- No production `core.env` change, no detector systemd unit, no detector sink in `detector.py`, and no Core restart. F1 stays inert until a separate governed deployment stage supplies them. Setting the new uid in the L7 `core.env` contract helper is not part of this change.
- The first protected or gateway attacker address leaves R3 FAILED and a later different address is `IGNORED_DIFFERENT_IP` (the protected first-IP dead end). That is an R5 and break-glass issue, deferred with R5; F1 does not change it.
- F1 alone does not change RESTORE behavior. R5 normal-path enforcement and break-glass are unmerged and not ready for a PR (`BREAK_GLASS_OWNER_DECISION_REQUIRED = YES`); the R5 enforcement must not merge without break-glass because it would make production RESTORE unavailable.
- Two unrelated baseline tests are known to be flaky on this host (the L7 close-channel 1-second wait and the L6c capture test under UDP churn). Neither is changed here.
