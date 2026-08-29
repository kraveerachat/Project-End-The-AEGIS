---
title: Task Receipt — IDEA1 LFT-V2-C nginx chunk tuning
date: 2026-08-29T15:48:21+07:00
owner: kla
area: idea1
branch: infra/idea1-lft-v2-c-nginx-chunk-tuning
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA1 LFT-V2-C nginx chunk tuning

## What changed

- Added route-specific HUB and development-gateway edge profiles for Normal Files and Private Vault V2 chunk upload, commit and streaming download operations.
- Normal chunks are capped at `64m`; Vault ciphertext chunks use `65m` for a 64 MiB plaintext chunk plus the 16-byte AES-GCM tag. Chunk request buffering is off with 120-second inactivity/upstream windows, commit read timeout is 600 seconds, and V2 download response buffering is off.
- Preserved the parent `/drive/` `512m` request allowance and 60-second read timeout for legacy `POST /api/files/upload` clients.
- Kept forwarding-header sanitization, CSP/security headers, HTTP version and connect timeout inherited from the parent. Disposable real-nginx smoke proved routing and inheritance instead of relying on syntax checks alone.
- This is source and edge-config verification only. Nothing was deployed or changed in production; `LFT-V2-D` remains pending.

## Source files changed

- `HUB-AEGIS_Entry/nginx.conf` — add production HUB route-specific LFT-V2-C edge profiles.
- `gateway/nginx.conf` — keep the development gateway's LFT-V2-C behavior equivalent to the HUB.
- `HUB-AEGIS_Entry/tests/helpers/nginxConfig.mjs` — share the quote/comment/brace-aware nginx parser used by structural tests.
- `HUB-AEGIS_Entry/tests/driveCspParity.test.mjs` — reuse the shared parser without changing the existing CSP contract.
- `HUB-AEGIS_Entry/tests/driveTransferEdge.test.mjs` — pin exact route boundaries, limits, timeouts, buffering, header inheritance, V1 compatibility and HUB/gateway parity.
- `HUB-AEGIS_Entry/tests/nginxRoutingSmoke.mjs` — run disposable real-nginx syntax and functional routing/header smoke for both edge configs.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/concepts/Large_File_Transfer_V2.md` — replace the stale Stage C not-started state with source-complete/edge-verified and not-deployed status.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — record the durable LFT-V2-C contract and keep LFT-V2-D open.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/summaries/08_Outstanding_Items_Consolidated.md` — reconcile the shared backlog with the Stage C source result while preserving the production limitation.

## Verification evidence

- `node --test tests/driveCspParity.test.mjs tests/driveTransferEdge.test.mjs` from `HUB-AEGIS_Entry/` — pass: 21/21, zero failures or skips.
- `node tests/nginxRoutingSmoke.mjs` from `HUB-AEGIS_Entry/` — pass: both configs passed `nginx -t`; 12 functional cases proved exact upstream routes, sanitized forwarding headers, HUB CSP/security-header inheritance, legacy V1 routing and the Monitor internal-route block.
- `npm test` from `IDEA1-AEGIS_Drive_LC/` — pass: 519/586, zero failures; 67 PostgreSQL-gated tests honestly skipped because `TEST_DATABASE_URL` was not set.
- `node --test --test-concurrency=1 "tests/**/*.test.mjs"` from repository root — pass: 56/56, zero failures or skips.
- `npm run build` from `HUB-AEGIS_Entry/` — pass.
- `npm run build` from `IDEA1-AEGIS_Drive_LC/` — pass; existing tracked build output was restored and is not part of this task.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` — pass with the two unchanged owner-review Canvas warnings.
- `node --test tests/vaultStructure.test.mjs tests/vaultMultiWriter.test.mjs` from repository root — pass: 25/25, zero failures or skips.
- `node --test --test-concurrency=1 "tests/**/*.test.mjs"` from repository root — pass: collaboration/governance guardrails 56/56, zero failures or skips.
- `node scripts/validate-collaboration-policy.mjs --event .codex-temp/pr-event.json --changed-files .codex-temp/changed-files.txt` — pass: the planned PR declares all eight shared paths, IDEA1/Kla ownership, integration review and exactly one new receipt.
- `git diff --cached --check` — pass; ten intentional paths only, with no whitespace errors, conflict markers, Formal Report changes or historical-receipt edits.
- Targeted high-confidence scan of staged added lines — pass: no private-key material, credentialed URL, access token, API key, password or session-secret value was introduced.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/concepts/Large_File_Transfer_V2.md` — Stage C is source complete and edge-config verified, not deployed or production accepted.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — records exact Stage C edge semantics and makes Stage D the next gate.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/summaries/08_Outstanding_Items_Consolidated.md` — shared backlog no longer describes Stage C as not started.

## Shared surfaces touched

- `HUB-AEGIS_Entry/nginx.conf` — production edge contract requires infrastructure/code-owner review before later deployment.
- `HUB-AEGIS_Entry/tests/driveCspParity.test.mjs` — shared HUB security regression coverage was refactored to the common parser.
- `HUB-AEGIS_Entry/tests/driveTransferEdge.test.mjs` — new shared HUB/gateway edge-contract coverage requires integration review.
- `HUB-AEGIS_Entry/tests/helpers/nginxConfig.mjs` — shared nginx test parser requires integration review.
- `HUB-AEGIS_Entry/tests/nginxRoutingSmoke.mjs` — Docker-based shared edge routing smoke requires integration review.
- `gateway/nginx.conf` — shared development edge contract is kept in parity with the HUB.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/concepts/Large_File_Transfer_V2.md` — shared architecture status is reconciled with this implementation.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/summaries/08_Outstanding_Items_Consolidated.md` — shared consolidated backlog is reconciled with the Stage C result.

## Integration requests

- Kla/infrastructure and code-owner review: confirm the six route boundaries, duplicated child-location execution trio required by nginx, parent header/CSP inheritance, 64m/65m limits, 120-second chunk windows, 600-second commit response timeout, download streaming, and preserved V1/Monitor behavior. Accept the HUB and gateway as a parity pair. Rollback is to revert this task's route profiles and tests before any deployment; rollout remains a separate `LFT-V2-D` production change with `nginx -t`, functional routing checks and the production acceptance matrix.

## Known limitations

- No production nginx file, container or traffic was changed; the source result does not prove production deployment or large-file acceptance.
- The full IDEA1 in-memory run skipped 67 tests that require an explicitly configured PostgreSQL integration environment; those are not reported as passed in this task.
- `LFT-V2-D` production deployment and real large-file acceptance remain open.
