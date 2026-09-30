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

- Implemented P0 of the approved Unified Preview plan (`docs/superpowers/plans/2026-09-30-idea1-unified-preview-p0-capability-foundation.md`) from `origin/main` `c1dc3c90`. Not deployed; no Production mutation.

```
TASK=IDEA1_UNIFIED_PREVIEW_P0_CAPABILITY_FOUNDATION
P0_FORMAT_DETECTION=PASS
P0_SIGNATURE_SNIFFING=PASS
P0_PROVIDER_REGISTRY=PASS
P0_FILES_WIRING=PASS
P0_VAULT_CAPABILITY=PASS
P0_SHARED_MODAL=PASS
ARBITRARY_UPLOAD_REGRESSION=PASS
ARBITRARY_DOWNLOAD_REGRESSION=PASS
ACCOUNT_NEUTRALITY=PASS
NORMAL_FILES_MEDIA_REGRESSION=PASS
VAULT_PREVIEW_REGRESSION=PASS
FULL_TEST_SUITE=BASELINE_MATCH
GROUP_B_REOPENED=NO
DEPENDENCIES_INSTALLED=NO
PRODUCTION_MUTATION_PERFORMED=NO
PRODUCTION_DEPLOYED=NO
P1_STARTED=NO
P2A_STARTED=NO
```

- Shared preview core: signature-first format detection (case-insensitive extensions; client MIME never chooses a format), a pure account-free provider registry and `FileCapability` resolver (Download always `true`), a throw-free browser capability snapshot, and one `PreviewModalShell` for Files and the Vault tree (truthful loading/failed/unsupported/too-large states, loading timeout, Download always present).
- Normal Files: `previewKindFor` now uses the shared resolver with the previewable set unchanged (= server `/preview` allowlist); unsupported types show the stable fallback. `server/media/**`, `server/routes/media.js`, `src/lib/mediaApi.js`, `src/lib/mediaTile.js`, `src/components/MediaThumb.jsx` untouched.
- Vault tree: capability from the decrypted content signature recorded (derived facts only, page memory, sealed and cleared on lock) from bytes the thumbnail/preview paths already decrypt — no extra fetch — else from the normalised extension with confirmation; the modal passes decrypted bytes through a render gate; content types come from the confirmed/extension format, never the hint. `.JPG` with an empty browser MIME now previews; `scan.bin` claiming `image/png` does not; PDF bytes behind `.png` never reach `<img>`.
- Rulings recorded during execution (plan deviations, all spec-conformant): baseline formats not gated on `canPlayType` (jsdom returns '' and the product previews them today); Files provider also requires the server allowlist extension; capability cache cleared via the screen's unlocked-state disposer (no `vaultUnlockedState.js` change); `PreviewUnsupported` merged into the shell; Task 6 committed before Task 5; streamed large V2 video is verified by the media decoder (cannot be sniffed before playback without a full chunk fetch); systematic-debugging fixes for UTF-16 BOM read as MP3, C0 control bytes read as text, V2 buffered sink part arrays, and an OOM caused by asserting on jsdom elements.

## Source files changed

- `IDEA1-AEGIS_Drive_LC/src/lib/preview/formats.js` — format detection (new).
- `IDEA1-AEGIS_Drive_LC/src/lib/preview/registry.js` — provider registry + capability resolver (new).
- `IDEA1-AEGIS_Drive_LC/src/lib/preview/env.js` — browser capability snapshot (new).
- `IDEA1-AEGIS_Drive_LC/src/lib/preview/vaultCapability.js` — Vault capability, session cache, render gate (new).
- `IDEA1-AEGIS_Drive_LC/src/components/preview/PreviewModalShell.jsx` — shared preview modal (new).
- `IDEA1-AEGIS_Drive_LC/src/lib/filesView.js` — Files preview kind via resolver.
- `IDEA1-AEGIS_Drive_LC/src/lib/useVaultTree.js` — injectable `previewKindOf` for capabilities.
- `IDEA1-AEGIS_Drive_LC/src/screens/Files.jsx` — preview modal on the shared shell.
- `IDEA1-AEGIS_Drive_LC/src/screens/VaultTreeScreen.jsx` — content-verified capability, render gate, shared shell with Download.
- `IDEA1-AEGIS_Drive_LC/src/lib/strings.js` — `previewUnsupported`, `previewTooLarge`, `previewTypeUnknown` (EN/TH/ZH).
- Tests (new): `tests/previewFormats.test.js`, `tests/previewRegistry.test.js`, `tests/previewFilesWiring.test.js`, `tests/previewModalShell.test.js`, `tests/previewVaultCapability.test.js`, `tests/arbitraryTransferRegression.test.js`, `tests/previewAccountNeutrality.test.js`, `tests/helpers/accountClasses.mjs` (all under `IDEA1-AEGIS_Drive_LC/`).
- Tests (modified): `IDEA1-AEGIS_Drive_LC/tests/vaultTreeScreen.test.js` (VIDEO-POSTER fixture serves a real MP4 `ftyp` header), `IDEA1-AEGIS_Drive_LC/tests/vaultFilesUx.test.js` (MEDIA-05 pins the resolver instead of the removed client-MIME gate).
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — P0 current-task entry.

## Verification evidence

- Baseline `npm test` on untouched `c1dc3c90` (from `IDEA1-AEGIS_Drive_LC/`) — 2390 tests, 2125 pass, 103 fail (pre-existing; names saved before the first RED).
- Final `npm test` — 2462 tests, 2198 pass, 102 fail; compared by failing-test name: two new source-shape failures (MEDIA-05, MEDIA-HIGHRES-1) were fixed in `f60d61ba` and re-verified; affected suites re-run afterwards (`vaultFilesUx`, `filesVaultPresentation`, `previewVaultCapability`, `vaultTreeScreen`, `vaultMediaPreview`, `vaultThumbScheduler`, `vaultUnlockedState`, `vaultTreeReducer`) — 121 tests, 26 fail, all 26 in the baseline list: pass (no new failures).
- `node --test --test-concurrency=1` over the seven new P0 test files — pass: 42/42.
- Normal Files: `filesMediaTiles`, `filesPreviewRoute`, `mediaRoutes`, `filesInteractionPolish`, `filesVisualHierarchy` — pass (130/133 run then 117/117 after shell wiring; 0 fail).
- PostgreSQL (disposable local container via `sh scripts/pg-integration-env.sh up`, `drive_app` non-superuser, port 55750; torn down with `down`): `arbitraryTransferRegression` 3/3, `previewAccountNeutrality` 3/3, `filesPreviewRoute` 5/5, `fileObjectAuthorization` 8/8 — pass (postgres mode).
- Falsifiability of the arbitrary-upload pin: a temporary, uncommitted extension gate in `POST /api/files/upload` made AT-1 fail; reverted (`git status` clean).
- Protected Core Entry guards `node --test --test-concurrency=1 tests/authBackBoundaryR4.test.js tests/shellThemeR4.test.js tests/loginExperienceR3.test.js tests/themeAuthTransition.test.js` — pass: 31/31; root `node --test tests/coreEntryGovernanceR4.test.mjs` — pass: 2/2.
- `npm run build` — pass; tracked `dist/` restored with `git checkout -- dist` (no `dist/` change committed).
- `git diff --check origin/main...HEAD` — pass.
- `node scripts/validate-vault.mjs` — pass: 0 errors, 2 pre-existing owner-canvas warnings.
- `node --test --test-concurrency=1 tests/collaborationPolicy.test.mjs tests/vaultStructure.test.mjs tests/vaultMultiWriter.test.mjs` — pass: 50/50.
- `node scripts/validate-collaboration-policy.mjs --event <Draft PR event built from the PR body> --changed-files <git diff --name-status origin/main...HEAD>` — pass.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — added "Current Task — IDEA1-UNIFIED-PREVIEW-P0" (scope, verification state, behaviour change, follow-ups); other entries unchanged.

## Shared surfaces touched

None

## Integration requests

None

## Known limitations

- Not deployed; no Production or browser-on-device acceptance in P0 (not required by the plan).
- Extensionless Vault files whose only type evidence is the client MIME no longer offer Preview until their signature is confirmed (spec §5.4 behaviour change).
- Vault download still labels the saved Blob with the node `mediaType` (spec §3.2 asks for octet-stream) — outside the P0 task list; follow-up.
- Legacy flat-vault screen (`src/screens/Vault.jsx`) unchanged.
- Pre-existing full-suite failures (~102) remain; none introduced by P0.
- Docker Desktop was started locally only to run the disposable PostgreSQL container.
