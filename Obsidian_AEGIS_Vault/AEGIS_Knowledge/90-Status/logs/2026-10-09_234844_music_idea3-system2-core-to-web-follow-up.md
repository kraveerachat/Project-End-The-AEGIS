---
title: Task Receipt — IDEA3 SYSTEM-2 Core-to-Web follow-up
date: 2026-10-09T23:48:44+07:00
owner: music
area: idea3
branch: feat/idea3-system2-a1
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 SYSTEM-2 Core-to-Web follow-up

## What changed

- Reconciled the read-only localhost Core evidence protocol around the dedicated `X-AEGIS-Evidence-Token`; the Control/Stop token is rejected and is never reused.
- Added a genuine Python HTTP server to Node HTTP client integration test covering success, missing, incorrect, and Control-token credentials.
- Made evidence timestamps, freshness, device identity, authenticated STATUS provenance, and relay verification truthful when source evidence is insufficient.
- Exposed the allowlisted Core audit aggregate in the existing Audit page without replacing the Web audit ledger or redesigning the UI.
- Kept the production cross-host delivery explicitly blocked because the approved D5 mTLS Core→HUB path is architectural evidence only; no deployed, authorized read-only evidence route was proven.

## Source files changed

- `IDEA3-AEGIS_Lockdown/aegis_soc/mqtt_client.py` — record authenticated status provenance only after accepted Protocol-v1 messages.
- `IDEA3-AEGIS_Lockdown/aegis_soc/runtime.py` — authoritative identity, timestamp, freshness, audit, and relay-verification projection.
- `IDEA3-AEGIS_Lockdown/aegis_soc/windows_launcher.py` — dedicated evidence-token HTTP contract and separate token generation.
- `IDEA3-AEGIS_Lockdown/tests/test_runtime.py` — evidence truthfulness and identity/provenance tests.
- `IDEA3-AEGIS_Lockdown/tests/test_windows_launcher.py` — real Python-server/Node-client authentication integration test and fail-closed cases.
- `IDEA3-AEGIS_Lockdown/web/server/domain/normalize.js` — nullable/UNKNOWN evidence normalization.
- `IDEA3-AEGIS_Lockdown/web/server/providers/httpJsonClient.js` — narrowly scoped header selection while preserving existing adapters.
- `IDEA3-AEGIS_Lockdown/web/server/providers/liveProvider.js` — dedicated Core evidence header.
- `IDEA3-AEGIS_Lockdown/web/src/pages/AuditPage.jsx` — existing-component Core audit aggregate display.
- `IDEA3-AEGIS_Lockdown/web/tests/client/evidencePages.test.jsx` — genuine Core incident/device/audit aggregate rendering coverage.
- `IDEA3-AEGIS_Lockdown/web/tests/server/liveIntegrationProvider.test.js` — evidence-header contract coverage.

## Verification evidence

- `pytest -q IDEA3-AEGIS_Lockdown/tests/test_runtime.py IDEA3-AEGIS_Lockdown/tests/test_windows_launcher.py` — pass: 159 passed, 6 skipped; includes the real Python HTTP server↔Node client test.
- `TMPDIR="$PWD/.tmp" npx vitest run --maxWorkers=1 --minWorkers=1 tests/server/liveIntegrationProvider.test.js tests/server/integrationAdapters.test.js tests/server/normalize.test.js tests/client/evidencePages.test.jsx` — pass: 4 files, 95 tests.
- `TMPDIR="$PWD/.tmp" npm run build` — pass: Vite production build.
- `TMPDIR="$PWD/.tmp" npm test -- --maxWorkers=1 --minWorkers=1` — partial: 35 files passed, 607 tests passed; 3 `productionRuntime.test.js` static `sendFile` tests failed with environment-specific temporary-path `NotFoundError`/HTTP 500 behavior. No affected evidence/auth/UI test failed.
- `pytest -q` from `IDEA3-AEGIS_Lockdown/` — not a completion gate: broad legacy suite produced unrelated failures/errors across unrelated modules and was interrupted at 27%; affected focused tests above are the authoritative result for this change.
- `python -m py_compile aegis_soc/mqtt_client.py aegis_soc/runtime.py aegis_soc/windows_launcher.py && node --check web/server/providers/httpJsonClient.js && node --check web/server/providers/liveProvider.js && node --check web/server/domain/normalize.js` — pass.
- `git diff --check` — pass.
- `git ls-remote https://github.com/kraveerachat/Project-End-The-AEGIS.git refs/pull/258/head` — pass: exact PR #258 head `1d981aee241b772eea196b6259a4b8d63dbcffda` inspected in disposable worktree.
- PR #258 disposable worktree `npm ci`, `TMPDIR="$PWD/.tmp" npm run build`, and `TMPDIR="$PWD/.tmp" npx vitest run --maxWorkers=1 --minWorkers=1 tests/client` — pass: build and 143 client tests; PR #258 was not modified.

## Canonical notes updated

- `None` — the existing immutable receipt was not edited and the functional-owner IDEA3 status note was not rewritten. Proposed durable fact for owner/integration review: localhost Core/Web bridge passes, Production cross-host delivery remains blocked, and insufficient evidence remains UNKNOWN/NOT_VERIFIED.

## Shared surfaces touched

- `IDEA3-AEGIS_Lockdown/aegis_soc/windows_launcher.py` — authenticated machine transport contract requires integration-owner review before any cross-host deployment.
- `IDEA3-AEGIS_Lockdown/aegis_soc/runtime.py` — evidence provenance and device-state semantics affect Security Center trust decisions.
- `IDEA3-AEGIS_Lockdown/web/server/providers/httpJsonClient.js` — shared client transport behavior; existing IDEA1/IDEA2 Authorization behavior must remain unchanged.
- `IDEA3-AEGIS_Lockdown/web/server/providers/liveProvider.js` — Core/Web adapter boundary.
- `IDEA3-AEGIS_Lockdown/web/src/pages/AuditPage.jsx` — existing UI route; this is the sole overlapping path with PR #258 and requires integration reconciliation after PR #258.

## Integration requests

- Kla/integration owner: review and authorize the minimal read-only evidence route over the existing D5 HTTPS 443 mTLS Core→HUB machine path, or explicitly approve an alternative. Until route, CA/certificate, network path, and acceptance evidence exist, keep production delivery blocked; rollback is to retain the loopback-only endpoint.
- IDEA3 functional owner: reconcile the proposed durable status facts into `idea3/idea3-status.md`; no canonical owner note was rewritten by this session.
- UI/integration reviewer: reconcile the sole `AuditPage.jsx` overlap with PR #258 at exact head `1d981aee241b772eea196b6259a4b8d63dbcffda`; do not overwrite PR #258 changes.
- CODEX-4: independently review the pushed exact head, submit the GitHub review comment, and check only reviewer checklist items supported by evidence.

## Known limitations

- Production Core-to-Web delivery is BLOCKED; no ingress, firewall, TLS bypass, service restart, or production mutation was performed.
- Timezone-naive SQLite timestamps are not converted or suffixed with `Z`; the Web receives UNKNOWN/null timestamp and freshness where provenance cannot be established.
- Device identity is the configured valid allowlisted identity or UNKNOWN; no hardcoded device identity remains.
- Device-reported status is distinct from independently verified relay-contact state; relay state remains NOT_VERIFIED without hardware evidence.
- The full Web suite has three environment-specific static runtime failures described above and is not claimed clean.
