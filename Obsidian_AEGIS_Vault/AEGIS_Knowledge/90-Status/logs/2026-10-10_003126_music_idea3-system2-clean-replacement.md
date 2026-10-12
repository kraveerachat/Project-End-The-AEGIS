---
title: Task Receipt — IDEA3 SYSTEM-2 clean replacement
date: 2026-10-10T00:31:26+07:00
owner: music
area: idea3
branch: feat/idea3-system2-clean-replacement
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 SYSTEM-2 clean replacement

## What changed

- Created the owner-authorized clean replacement source branch from current `origin/main` `712fa9691bc9b3f0ec21ec2593971c6aec270c4a`.
- Transferred only the 17 intentional source/test changes from PR #420 authoritative reviewed HEAD `5789de07177e9bc82a0ec2f72e94a718f228ffdc` by scoped three-way application.
- Preserved the accepted Core evidence truth model: global audit latest timestamp is not attributed to each event type; requested relay state is distinct from authenticated observed uplink state; physical relay evidence remains `NOT_VERIFIED`; incident identity and OPEN/CLOSED state are preserved; IDEA1/IDEA2 feeds and Demo/Live isolation remain intact.
- Preserved the dedicated `X-AEGIS-Evidence-Token` boundary and authenticated localhost Python HTTP ↔ Node integration; it remains separate from Control/Stop credentials.
- This replacement exists because PR #420 contains two immutable same-branch task receipts and therefore cannot satisfy the one-final-receipt governance rule. The two historical receipts remain untouched and are not imported here.

## Source files changed

- `IDEA3-AEGIS_Lockdown/aegis_soc/mqtt_client.py` — authenticated STATUS provenance.
- `IDEA3-AEGIS_Lockdown/aegis_soc/production_runtime.py` — production runtime evidence-token environment contract.
- `IDEA3-AEGIS_Lockdown/aegis_soc/runtime.py` — bounded read-only SQLite evidence projection and truthful Core evidence semantics.
- `IDEA3-AEGIS_Lockdown/aegis_soc/windows_launcher.py` — dedicated authenticated evidence route, token boundary, and child wiring.
- `IDEA3-AEGIS_Lockdown/tests/test_runtime.py` — Core projection, identity, timestamp, freshness, audit, and relay truthfulness coverage.
- `IDEA3-AEGIS_Lockdown/tests/test_windows_launcher.py` — launcher auth and real Python HTTP ↔ Node client integration coverage.
- `IDEA3-AEGIS_Lockdown/web/server/config.js` — evidence producer configuration.
- `IDEA3-AEGIS_Lockdown/web/server/domain/normalize.js` — strict evidence normalization and requested/observed/physical separation.
- `IDEA3-AEGIS_Lockdown/web/server/providers/httpJsonClient.js` — authenticated evidence-header transport.
- `IDEA3-AEGIS_Lockdown/web/server/providers/liveProvider.js` — Core evidence ingestion and snapshot merge.
- `IDEA3-AEGIS_Lockdown/web/src/lib/i18n.js` — existing evidence labels.
- `IDEA3-AEGIS_Lockdown/web/src/pages/AuditPage.jsx` — existing Core audit aggregate presentation with one global latest timestamp.
- `IDEA3-AEGIS_Lockdown/web/src/pages/DashboardPage.jsx` — existing observed-uplink presentation.
- `IDEA3-AEGIS_Lockdown/web/src/pages/DevicesPage.jsx` — existing requested/observed/physical evidence presentation.
- `IDEA3-AEGIS_Lockdown/web/tests/client/evidencePages.test.jsx` — incident/device/audit evidence rendering regressions.
- `IDEA3-AEGIS_Lockdown/web/tests/client/systemPages.test.jsx` — system-page evidence regressions.
- `IDEA3-AEGIS_Lockdown/web/tests/server/liveIntegrationProvider.test.js` — evidence transport and source-merge regressions.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-10-10_003126_music_idea3-system2-clean-replacement.md` — this single replacement receipt.

## Verification evidence

- `git diff --no-ext-diff --binary 712fa9691bc9b3f0ec21ec2593971c6aec270c4a 5789de07177e9bc82a0ec2f72e94a718f228ffdc -- <17 source/test paths> | sha256sum` compared with the staged replacement patch — PASS; exact patch SHA-256 `154ac1ad1d08284546ff6689296f3130999bb6d325c0b93c78fd25c7722c490c`.
- `PYTHONDONTWRITEBYTECODE=1 TMPDIR=.pytest-remediation-tmp pytest -q tests/test_windows_launcher.py::test_real_python_server_and_node_client_use_evidence_header tests/test_runtime.py tests/test_windows_launcher.py` — PASS: 159 passed, 6 skipped.
- `TMPDIR="$PWD/.tmp" npx vitest run --maxWorkers=1 --minWorkers=1 tests/server/liveIntegrationProvider.test.js tests/server/normalize.test.js tests/client/evidencePages.test.jsx tests/client/systemPages.test.jsx tests/client/auditTruthfulness.test.jsx` — PASS: 5 files, 70 tests.
- `TMPDIR="$PWD/.tmp" npm run build` — PASS: Vite build, 1,677 modules transformed.
- Disposable PR #258 exact-head combined preview at `1d981aee241b772eea196b6259a4b8d63dbcffda` with source semantics reconciled and PR #258 itself untouched — PASS: build and 13 client files, 146 tests.
- `TMPDIR="$PWD/.tmp-full" npm test -- --maxWorkers=1 --minWorkers=1` — PARTIAL: 35 files, 609 passed, 3 reproducible `tests/server/productionRuntime.test.js` static-route failures returning HTTP 500.
- Controlled clean `origin/main` full suite at `712fa9691bc9b3f0ec21ec2593971c6aec270c4a` — PARTIAL: 35 files, 604 passed, the same 3 `productionRuntime.test.js` static-route failures returning HTTP 500; failures are pre-existing baseline behavior, not introduced by this replacement.
- `git diff --check` and source/test path audit — PASS before receipt creation; no secret, `.env`, dependency, build output, recording, or generated artifact is included.
- Collaboration Policy Validator and Vault Validator — pending final Draft PR body/receipt validation before push/PR creation.

## Canonical notes updated

- `None` — receipt-only replacement; the IDEA3 owner-maintained canonical status note was not rewritten by the integrator.

## Shared surfaces touched

- `IDEA3-AEGIS_Lockdown/aegis_soc/runtime.py` — Core/Web evidence contract and bounded SQLite trust boundary require integration review.
- `IDEA3-AEGIS_Lockdown/aegis_soc/windows_launcher.py` — authenticated machine transport and token separation require integration review.
- `IDEA3-AEGIS_Lockdown/aegis_soc/production_runtime.py` — runtime environment contract carries the evidence credential.
- `IDEA3-AEGIS_Lockdown/web/server/config.js` — Web producer-authentication configuration.
- `IDEA3-AEGIS_Lockdown/web/server/domain/normalize.js` — shared incident/device evidence semantics.
- `IDEA3-AEGIS_Lockdown/web/server/providers/httpJsonClient.js` and `IDEA3-AEGIS_Lockdown/web/server/providers/liveProvider.js` — shared adapter transport and source merge; existing IDEA1/IDEA2 behavior must remain unchanged.
- `IDEA3-AEGIS_Lockdown/web/src/pages/AuditPage.jsx`, `IDEA3-AEGIS_Lockdown/web/src/pages/DashboardPage.jsx`, and `IDEA3-AEGIS_Lockdown/web/src/pages/DevicesPage.jsx` — existing UI consumers; PR #258 overlap was reconciled only in the disposable preview.

## Integration requests

- Kla/integration owner: review the Core-to-Web trust boundary, bounded read-only projection, token lifecycle/separation, allowlist, source-IP exposure, freshness behavior, rollback to the previous runtime-only adapter, and the production deployment contract.
- Music functional owner: reconcile the durable IDEA3 status note after review; this receipt records local implementation and localhost evidence only.
- UI/integration reviewer: review the disposable PR #258 reconciliation at exact head `1d981aee241b772eea196b6259a4b8d63dbcffda`; PR #258 remains untouched and no merge is implied.
- Production owner: separately approve and implement an authenticated cross-host Core→Web transport; current Production delivery remains blocked and must roll back to loopback-only if transport acceptance fails.
- Independent reviewer: re-review the new exact replacement head and confirm source parity, security truthfulness, one-receipt governance, and the known full-suite baseline limitation.

## Known limitations

- `FULL_WEB_SUITE=PARTIAL`: the three reproducible static-route failures are pre-existing on current `origin/main`; no tests were weakened or changed to hide them.
- PR #258 remains OPEN/DRAFT and untouched; the combined preview is disposable compatibility evidence only.
- PR #420 remains OPEN/DRAFT at authoritative HEAD `5789de07177e9bc82a0ec2f72e94a718f228ffdc`; its two historical receipts remain immutable in that PR/history and are not inherited by this replacement branch.
- `PR #258` is an open dependency for UI review only; no merge, rebase, or source import from its branch is performed here.
- `PRODUCTION_DEPLOY=FORBIDDEN`, `MQTT_PUBLISH=FORBIDDEN`, `RELAY_CUT_RESTORE=FORBIDDEN`, `RECOVERY_MUTATION=FORBIDDEN`, `ESP32_FLASH=FORBIDDEN`, `NETWORK_FIREWALL_CHANGE=FORBIDDEN`, and `UI_REDESIGN=FORBIDDEN` were all respected.
- Production Core-to-Web cross-host delivery is `BLOCKED`; localhost integration is not Production acceptance evidence. No Production deployment, restart, ingress, firewall, MQTT, hardware, or recovery action occurred.
