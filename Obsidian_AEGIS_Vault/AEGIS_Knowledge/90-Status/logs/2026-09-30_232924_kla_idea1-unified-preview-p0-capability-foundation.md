---
title: Task Receipt — IDEA1 Unified Preview P0 Capability Foundation
date: 2026-09-30T23:29:24+07:00
owner: kla
area: idea1
branch: feat/idea1-preview-p0-capability-foundation
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA1 Unified Preview P0 Capability Foundation

## What changed

- Implemented P0 of the approved Unified Preview plan (`docs/superpowers/plans/2026-09-30-idea1-unified-preview-p0-capability-foundation.md`), started from `origin/main` `c1dc3c90`, then reconciled with current `main` by normal merges (`fe162c30` ← `ff644719`, `edbe465e` ← `81f201a4`; both IDEA3-only, no conflicts, no rebase). Human code review items fixed; not deployed; no Production mutation. This receipt was corrected in place for the review-fix pass (PR #270 unmerged).

```
TASK=IDEA1_UNIFIED_PREVIEW_P0_CAPABILITY_FOUNDATION
P0_FORMAT_DETECTION=PASS
P0_SIGNATURE_SNIFFING=PASS
P0_PROVIDER_REGISTRY=PASS
P0_FILES_WIRING=PASS
P0_VAULT_CAPABILITY=PASS
P0_SHARED_MODAL=PASS
VAULT_DOWNLOAD_OCTET_STREAM=PASS
VAULT_DOWNLOAD_BYTE_EXACT=PASS
VAULT_DETECTED_TYPE_LABEL=PASS
PREVIEW_TIMEOUT_REOPEN=PASS
ARBITRARY_UPLOAD_REGRESSION=PASS
ARBITRARY_DOWNLOAD_REGRESSION=PASS
ACCOUNT_NEUTRALITY=PASS
NORMAL_FILES_MEDIA_REGRESSION=PASS
VAULT_PREVIEW_REGRESSION=PASS
FULL_TEST_SUITE=BASELINE_MATCH (0 new failure names)
GROUP_B_REOPENED=NO
DEPENDENCIES_INSTALLED=NO
PRODUCTION_MUTATION_PERFORMED=NO
PRODUCTION_DEPLOYED=NO
P1_STARTED=NO
P2A_STARTED=NO
```

- Shared preview core: signature-first format detection (case-insensitive extensions; client MIME never chooses a format), a pure account-free provider registry and `FileCapability` resolver (Download always `true`), a throw-free browser capability snapshot, and one `PreviewModalShell` for Files and the Vault tree (truthful loading/failed/unsupported/too-large states, loading fail-safe that resets on close, Download always present).
- Normal Files: `previewKindFor` uses the shared resolver with the previewable set unchanged (= server `/preview` allowlist); unsupported types show the stable fallback. `server/media/**`, `server/routes/media.js`, `src/lib/mediaApi.js`, `src/lib/mediaTile.js`, `src/components/MediaThumb.jsx` untouched.
- Vault tree: capability from the decrypted content signature (derived facts only, page memory, sealed and cleared on lock) recorded inside `readNodeBytes` from bytes already decrypted for display — no extra fetch — else from the normalised extension with confirmation; the modal passes decrypted bytes through a render gate; render MIME from the confirmed/extension format, never the hint; the preview header shows the detected format (confirmed name, explicit "not yet verified" for name-only decisions, "Unknown type" otherwise).
- Human review fixes: (1) current-main reconciliation; (2) Vault buffered V1/V2 downloads always save as `application/octet-stream` with exact bytes and the manifest filename (`42789aae`); (3) detected type label from the signature result (`4ee3e59c`): `photo.JPG`+JPEG → JPEG, `fake.png`+PDF → PDF (fallback, not PNG), `movie.bin`+MP4 → MP4, unknown bytes + misleading extension → "Unknown type"; (4) preview loading timeout episode resets on close so a reopened preview starts loading again while the fail-safe still fires (`a72b7fee`).
- Hang incident: the first post-fix `npm test` stalled for over an hour in `tests/vaultChunkedUploadClient.test.js` (last printed test: the V2 DELETE cancel test; the next, `concurrency 2 · …`, never finished). Root cause (test fixture, pre-existing, file untouched by P0): `gatedServer.releaseAll()` returned when it saw no pending gate, but under full-suite load WebCrypto reached the next PUT afterwards; that late PUT was never released, so `await running` never settled. Reproduced 1/6 under 6-way parallel load; fixed test-only with `releaseAll(running)` releasing until the upload settles (`ab9cea6b`); 12/12 clean under the same load; deterministic regression test added. No runtime change.
- Rulings (spec-conformant plan deviations, Human-accepted): existing mp4/webm/ogg not newly gated on `canPlayType`; Files provider also requires the server allowlist extension; capability cache cleared via the screen's unlocked-state disposer; `PreviewUnsupported` merged into the shell; Task 6 committed before Task 5; streamed large V2 video verified by the media decoder; legacy flat-vault screen unchanged.

## Source files changed

- `IDEA1-AEGIS_Drive_LC/src/lib/preview/formats.js` — format detection (new).
- `IDEA1-AEGIS_Drive_LC/src/lib/preview/registry.js` — provider registry + capability resolver (new).
- `IDEA1-AEGIS_Drive_LC/src/lib/preview/env.js` — browser capability snapshot (new).
- `IDEA1-AEGIS_Drive_LC/src/lib/preview/vaultCapability.js` — Vault capability, session cache, render gate, detected type/label (new).
- `IDEA1-AEGIS_Drive_LC/src/components/preview/PreviewModalShell.jsx` — shared preview modal (new).
- `IDEA1-AEGIS_Drive_LC/src/lib/filesView.js` — Files preview kind via resolver.
- `IDEA1-AEGIS_Drive_LC/src/lib/useVaultTree.js` — injectable `previewKindOf`.
- `IDEA1-AEGIS_Drive_LC/src/screens/Files.jsx` — preview modal on the shared shell.
- `IDEA1-AEGIS_Drive_LC/src/screens/VaultTreeScreen.jsx` — content-verified capability, render gate, detected label, shell with Download, octet-stream downloads.
- `IDEA1-AEGIS_Drive_LC/src/lib/strings.js` — `previewUnsupported`, `previewTooLarge`, `previewTypeUnknown`, `previewTypeUnverified` (EN/TH/ZH).
- Tests (new, under `IDEA1-AEGIS_Drive_LC/`): `tests/previewFormats.test.js`, `tests/previewRegistry.test.js`, `tests/previewFilesWiring.test.js`, `tests/previewModalShell.test.js`, `tests/previewVaultCapability.test.js`, `tests/vaultDownloadMime.test.js`, `tests/arbitraryTransferRegression.test.js`, `tests/previewAccountNeutrality.test.js`, `tests/helpers/accountClasses.mjs`.
- Tests (modified): `IDEA1-AEGIS_Drive_LC/tests/vaultTreeScreen.test.js` (VIDEO-POSTER fixture serves a real MP4 `ftyp` header), `IDEA1-AEGIS_Drive_LC/tests/vaultFilesUx.test.js` (MEDIA-05 pins the resolver instead of the removed client-MIME gate), `IDEA1-AEGIS_Drive_LC/tests/vaultChunkedUploadClient.test.js` (late-gate release; hang fix).
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — P0 current-task entry.

## Verification evidence

- Baseline `npm test` on untouched `c1dc3c90` (from `IDEA1-AEGIS_Drive_LC/`) — 2390 tests, 2125 pass, 103 fail (pre-existing; names saved before the first RED).
- Focused review-fix tests `node --test --test-concurrency=1 tests/vaultDownloadMime.test.js tests/previewVaultCapability.test.js tests/previewModalShell.test.js` — pass: 22/22 (download octet-stream V1/V2 + bytes + filename; detected label A–D; timeout reopen).
- Hang: `timeout 300 node --test tests/vaultChunkedUploadClient.test.js` alone — pass 20/20 in 6.7 s (did not reproduce in isolation); 6-way parallel load — 1/6 hung to the 120 s watchdog (reproduced); after `ab9cea6b` — 12/12 exit 0, 0 fail; file 21/21; with `tests/vaultTreeUploadClient.test.js` 28/28.
- Final full suite `timeout --kill-after=30 5400 node --test --test-concurrency=1 "tests/**/*.test.js"` (02:27–03:08 +07, returned normally) — pass: 2469 tests, 2207 pass, 100 fail, 0 cancelled, 162 skipped; failing-name diff vs baseline: 0 new failures.
- PostgreSQL (disposable local container, `drive_app` non-superuser; earlier in the task): `arbitraryTransferRegression` 3/3, `previewAccountNeutrality` 3/3, `filesPreviewRoute` 5/5, `fileObjectAuthorization` 8/8 — pass (postgres mode); container, volume and network removed.
- Protected Core Entry guards (31/31) and root `tests/coreEntryGovernanceR4.test.mjs` (2/2) — pass (earlier in the task; the screens they cover are unchanged since).
- `npm run build` — pass; tracked `dist/` restored with `git checkout -- dist` (no `dist/` change).
- `git diff --check origin/main...HEAD` — pass.
- `node --test --test-concurrency=1 tests/collaborationPolicy.test.mjs tests/vaultStructure.test.mjs tests/vaultMultiWriter.test.mjs` — pass: 50/50.
- `node scripts/validate-vault.mjs` — pass: 0 errors, 2 pre-existing owner-canvas warnings.
- `node scripts/validate-collaboration-policy.mjs --event <Draft PR event built from the final PR body> --changed-files <git diff --name-status origin/main...HEAD>` — pass.
- Added-line secret scan over the branch diff — pass: 0 hits.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — "Current Task — IDEA1-UNIFIED-PREVIEW-P0" reflects the review-fix state; other entries unchanged.

## Shared surfaces touched

None

## Integration requests

None

## Known limitations

- Not deployed; no Production or on-device browser acceptance in P0 (not required by the plan).
- Extensionless Vault files whose only type evidence is the client MIME no longer offer Preview until their signature is confirmed (spec §5.4 behaviour change).
- Legacy flat-vault screen (`src/screens/Vault.jsx`) unchanged.
- Streamed large V2 video is verified by the media decoder rather than a pre-render sniff.
- ~100 pre-existing full-suite failures remain; none introduced by P0.
- P1 and P2a not started; GROUP B throughput remains deferred.
