---
title: Task Receipt — IDEA3 PR9 Production Runtime / Deployment Preparation
date: 2026-09-11T04:08:39+07:00
owner: music
area: idea3
branch: feat/idea3-production-runtime-pr9
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 PR9 Production Runtime / Deployment Preparation

## What changed

- Added one composite server service owner,
  `python -m aegis_soc.production_runtime start|stop|restart|status|doctor`. It
  validates an immutable payload plus an absolute external `AEGIS_DATA_DIR`,
  starts Core before Web, stops Web before Core, fails and cleans the peer when
  either child exits, and never sends `RESTORE_UPLINK`.
- Production Web rejects malformed numerics and a relative audit DB path, and
  exposes `/security/api/readiness` (schema-v2 audit probe) separately from
  liveness.
- `runtime/service-status.json` keeps process health, readiness, audit, MQTT,
  IDEA1, IDEA2, ESP32, and physical evidence separate. Configured-but-unprobed
  IDEA1/IDEA2 read `UNKNOWN`. Service MQTT preserves Core evidence without a
  probe or second connection: not configured → `NOT_CONFIGURED`; configured +
  Core `UNKNOWN` → `UNKNOWN`; Core `DISCONNECTED` → `UNAVAILABLE`; Core
  `CONNECTED` → `CONNECTED`.
- Optional Telegram notification is outbound-only: one alert per observed
  `LOCKDOWN` transition and one restore alert per observed `NORMAL` transition;
  repeated unchanged state is suppressed; blank token/chat makes no request;
  delivery is fail-soft on a daemon thread with fixed secret-safe wording.
  Production Core stays `--headless`, so no Telegram listener or inbound
  `/cut`/`/restore` runs.
- Added the uninstalled composite systemd example, the server runbook, a
  measured isolated production-like acceptance driver, and a reproducible
  13-case loopback-only negative-control driver.
- S7: after PR5 merged, `origin/main` was merged normally (no rebase or
  force-push); both PR5 hardware truth and PR9 runtime truth were preserved and
  the full gate was rerun on the merged tree. S8: canonical records reconciled
  and this one receipt added.

```text
TASK = IDEA3 PR9 Production Runtime / Deployment Preparation
BRANCH = feat/idea3-production-runtime-pr9
PR = #115
BASE_SHA = 50ce6e1638c6bcdb2a378a3cee660050b9cb41d8
PRE_SYNC_HEAD = c7a1a7af7bc346b86a96f2f9bcb8a6f9ffce29aa
PR5 = GitHub PR #117 MERGED at 58f19f2051170685757627a6baea90b264a877c4 (head d416d1ecea338e38247510e7b547f63d42447e11)
PR9_PR115_PR5_GATE = SATISFIED
MAIN_SYNC_COMMIT = e5863fc664e239b78f37dd4ce663bc1186f22744
FINAL_IMPLEMENTATION_EVIDENCE_CHECKPOINT = e5863fc664e239b78f37dd4ce663bc1186f22744
RECEIPT_COMMIT = recorded in PR #115 after Git assigns it
SESSIONS = S1-S8 CLOSED
PRODUCTION_MUTATION = NO
PRODUCTION_DEPLOYED = NO
REAL_TELEGRAM_API_CALLED = NO
PRODUCTION_TELEGRAM_LISTENER_STARTED = NO
PRODUCTION_REMOTE_CUT_ENABLED = NO
PRODUCTION_REMOTE_RESTORE_ENABLED = NO
IDEA3_PRODUCTION_COMPLETE = NO
```

The main-sync merge `e5863fc6` was created locally by an earlier session before
the S7 verification run and was audited before use: its tree differs from a
plain auto-merge only in the three conflicted IDEA3-owned documents, with no
conflict marker and no source, firmware, IDEA1/IDEA2, shared, or receipt edit.

## Source files changed

- `IDEA3-AEGIS_Lockdown/aegis_soc/production_runtime.py` — composite settings,
  lifecycle, status projection, CLI, MQTT truth mapping (added).
- `IDEA3-AEGIS_Lockdown/aegis_soc/windows_launcher.py` — shared lifecycle fails
  on child exit, cleans the peer, leaves a duplicate start untouched.
- `IDEA3-AEGIS_Lockdown/aegis_soc/comms.py` — fail-soft daemon-thread Telegram
  dispatch with secret-safe wording.
- `IDEA3-AEGIS_Lockdown/aegis_soc/mqtt_client.py` — one outbound alert per
  observed `LOCKDOWN`/`NORMAL` transition; unchanged state suppressed.
- `IDEA3-AEGIS_Lockdown/web/server/config.js` — strict production numerics and
  absolute audit DB path.
- `IDEA3-AEGIS_Lockdown/web/server/createApp.js` — readiness route.
- `IDEA3-AEGIS_Lockdown/.env.example` — server payload keys; blank audit DB
  default.
- `IDEA3-AEGIS_Lockdown/deploy/aegis-idea3.service.example` — composite hardened
  unit example (added, not installed).
- `IDEA3-AEGIS_Lockdown/deploy/aegis-supervisor.service.example` — Core-only
  example removed (deleted).
- `IDEA3-AEGIS_Lockdown/deploy/production-like-acceptance.py` — isolated
  acceptance driver (added).
- `IDEA3-AEGIS_Lockdown/deploy/production-like-negative-controls.py` — 13-case
  negative-control driver (added).
- `IDEA3-AEGIS_Lockdown/tests/test_production_runtime.py` (added),
  `IDEA3-AEGIS_Lockdown/tests/test_production_like_acceptance.py` (added),
  `IDEA3-AEGIS_Lockdown/tests/test_production_like_negative_controls.py`
  (added), `IDEA3-AEGIS_Lockdown/tests/test_comms.py` (added),
  `IDEA3-AEGIS_Lockdown/tests/test_mqtt_client.py`,
  `IDEA3-AEGIS_Lockdown/tests/test_windows_launcher.py`,
  `IDEA3-AEGIS_Lockdown/web/tests/server/config.test.js`,
  `IDEA3-AEGIS_Lockdown/web/tests/server/productionRuntime.test.js` —
  regression and contract tests.
- `IDEA3-AEGIS_Lockdown/docs/operations/production-runtime.md` — server runbook
  including the outbound-only Telegram boundary (added).
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-10-idea3-pr9-production-runtime-design.md`,
  `IDEA3-AEGIS_Lockdown/docs/superpowers/plans/2026-09-10-idea3-pr9-production-runtime.md`
  — design and TDD plan (added).
- `IDEA3-AEGIS_Lockdown/README.md` — PR9 operator routing and current
  PR5-gate/PR9 state.
- `IDEA3-AEGIS_Lockdown/PROGRESS.md` — current track header and PR5 gate
  sentence reconciled after PR #117 merged.
- `IDEA3-AEGIS_Lockdown/doc/Content/04_SESSION_HANDOFF.md` — PR9 sections 39-43
  and 45; inherited PR5 section renumbered 44.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md`,
  `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-moc.md` — canonical notes.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-09-11_040839_music_idea3-pr9-production-runtime.md`
  — this one final task receipt.

## Verification evidence

- `python -m pytest -p no:cacheprovider -q` (full Python at `e5863fc6`) — pass: 245 passed, 6 Windows-only skipped.
- `python -m pytest -p no:cacheprovider -q tests/test_comms.py tests/test_mqtt_client.py tests/test_production_runtime.py tests/test_production_like_acceptance.py tests/test_production_like_negative_controls.py tests/test_windows_launcher.py tests/test_runtime.py tests/test_controller.py tests/test_core.py tests/test_paths.py`
  — pass: 224 passed, 6 Windows-only skipped. Telegram subset of
  `tests/test_comms.py` + `tests/test_mqtt_client.py` — pass: 8 passed.
- `npx vitest run` — pass: 309 passed across 24 files.
- `npx vite build` — pass: 1,677 modules.
- `ruff check --no-cache aegis_soc tests windows deploy detector.py sim_auto_detector.py server_admin.py`
  — pass.
- `python -m compileall -q aegis_soc deploy windows detector.py server_admin.py sim_auto_detector.py tests`
  — pass (pycache redirected outside the tree).
- `npm audit --omit=dev --offline` — pass: 0 vulnerabilities.
- `node --test --test-concurrency=1 tests/*.test.mjs` — pass: 63 passed, 0
  failed.
- `python deploy/production-like-acceptance.py --data-root <empty disposable path containing spaces>`
  — pass: `PRODUCTION_LIKE_VERIFIED`; 2 generations; Web `READY`; audit
  `PERSISTED_ACROSS_RESTART`; IDEA1/IDEA2/MQTT `NOT_CONFIGURED`;
  ESP32/physicalEvidence `UNKNOWN`; 3 owned processes per generation, 0
  surviving; control token absent; owner-only permissions; final `STOPPED`.
- `python deploy/production-like-negative-controls.py --data-root <empty disposable path containing spaces>`
  — pass: 13/13; configured-but-unprobed MQTT reads Core `UNKNOWN` / service
  `UNKNOWN`; every case ends with no token, surviving process, listener, secret
  leak, or physical-evidence claim.
- Residue check after both drivers — pass: 0 surviving processes, 0 loopback
  listeners; disposable roots removed.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge`
  — pass with the two known owner-data canvas warnings (S7 tree and final
  closeout tree).
- `node scripts/validate-collaboration-policy.mjs --event <PR #115 event> --changed-files <origin/main..HEAD>`
  — pass against the live Draft body in S7, and against the final body with
  this receipt before Ready.
- `git diff --check origin/main...HEAD` — pass.
- Secret and generated/runtime artifact scans of the PR diff — pass: 0
  findings; every changed path is IDEA3-owned.
- Every automated Telegram, MQTT, IDEA1/IDEA2, ESP32, and relay boundary was
  absent, injected, or faked. No real Telegram API call was made.

All results above are post-main-sync S7 results at
`e5863fc664e239b78f37dd4ce663bc1186f22744` (Arch Linux; task-local venv Python
3.14.7 with the `requirements-dev.txt` pins; Node v24.16.0). Earlier PR9 counts
remain historical in the canonical note.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — PR9 Current
  Task, Session Register S1-S8 CLOSED, dashboard, Git/file reconciliation,
  Telegram pre-gate record, post-PR5 S7 evidence, PR8 current truth, and
  handoff; PR5 gate recorded as SATISFIED; merge-mislabelled PR9 headings
  corrected.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-moc.md` — stale "PR #115
  blocked until PR5 merges" entry statement replaced with the merged PR5 gate
  and PR9 review state.

## Shared surfaces touched

- None — every changed path is inside `IDEA3-AEGIS_Lockdown/` or the IDEA3
  canonical knowledge boundary.

## Integration requests

- None — no cross-scope/shared path changed. Kla remains the temporary GitHub
  reviewer for IDEA3; the human reviewer decides whether to merge PR #115.

## Known limitations

- `PRODUCTION_LIKE_VERIFIED` is local loopback, lab/headless/dry-run evidence.
  `PRODUCTION_DEPLOYED = NO`; the systemd example was not installed; no
  Production host was changed.
- `REAL_TELEGRAM_PRODUCTION_DELIVERY = NOT VERIFIED`; Telegram tests fake the
  network boundary.
- `LIVE_IDEA1_SERVICE_EVENT_FEED = OPEN`, `LIVE_IDEA2_SERVICE_EVENT_FEED = OPEN`,
  `SHARED_CORRELATION_KEY = OPEN`, `LIVE_CROSS_IDEA_EXERCISE = OPEN`.
- `TOTAL_CONTROL_POWER_LOSS_FAIL_SECURE = NOT PROVEN`;
  `TWINGATE_FINAL_RELAY_CYCLE_AUTO_RECOVERY = NOT CLAIMED / NOT CONCLUSIVELY VERIFIED`;
  `MECHANICAL_BREADBOARD_STABILITY = PROTOTYPE LIMITATION`. PR9 adds no
  physical evidence; the PR5 results are owner-observed lab evidence.
- Backup/restore, upgrade/rollback, and secret rotation are documented only.
- Both acceptance drivers are Linux-only (`/proc`); Windows acceptance remains
  the PR8 `windows/smoke.ps1` path. PR8 final Windows acceptance at
  `25fb442d15cdf2037817c9e63add4d7e96bcd568`, including the extracted-ZIP 25/25
  smoke, is owner-reported; its build/ZIP-digest/transcript artifacts are not
  recorded in canonical documentation.
- `IDEA3_PRODUCTION_COMPLETE = NO`. An agent does not merge PR #115.
