---
title: Task Receipt — IDEA1 Private Vault Save-picker-first download and truthful progress
date: 2026-10-04T15:55:58+07:00
owner: kla
area: idea1
branch: fix/idea1-vault-download-picker-first
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA1 Private Vault Save-picker-first download and truthful progress

Final implementation/evidence checkpoint: `c973e825` on base `origin/main`
`e8efe3bb09d12ab8383bacdb77a9d2b7ccb139d8`. Separate from D-1 Phase J / PR #323
(not touched). No Production connection, mutation, or deployment.

## What changed

- Proven root causes for "Download appears to do nothing" on a large V2 file in
  the TREE_V1 screen: (1) `treeDownloadEntry` awaited DEK unwrap + metadata
  AES-GCM decrypt **before** `showSaveFilePicker` (size-independent work, but it
  moved the picker out of the click's synchronous turn, queued it behind other
  WebCrypto work, and spent transient user activation); (2) no progress surface
  after the destination was chosen (`downloadVaultV2` called without
  `onProgress`); (3) a second click while a download was active was silently
  dropped by the busy guard.
- New order for every Private Vault V2 entry point (tile menu, preview modal,
  bulk bar, rollback list, legacy screen): click → `showSaveFilePicker` (first
  await, synchronous in the click turn, manifest name as `suggestedName`) →
  DEK unwrap + metadata AEAD authentication → `createWritable()` → sequential
  per-chunk fetch / AAD-bound decrypt / write → `close()` only after complete
  authenticated success; any failure → `abort()`, never `close()`.
- Tree screen now shows `VaultTransferPanel` fed only by `downloadVaultV2`
  `onProgress` (bytes, percent, chunk X of N, measured rate), with Cancel
  (aborts the destination) and an announced busy state.
- `downloadVaultV2` gained optional `onTiming` marks (`DOWNLOAD_CLICK_TS` …
  `DOWNLOAD_COMPLETE_TS`) delivered by callback only — no production logging.
- V1 download behaviour unchanged. No concurrency added.

## Source files changed

- `IDEA1-AEGIS_Drive_LC/src/lib/vaultChunkedDownload.js` — `prepareVaultV2Download`, `VAULT_DOWNLOAD_TIMING`, optional `onTiming` in `downloadVaultV2`
- `IDEA1-AEGIS_Drive_LC/src/screens/VaultTreeScreen.jsx` — picker-first `treeDownloadEntry`, progress state/panel, Cancel, busy announcement, lock purge of the panel
- `IDEA1-AEGIS_Drive_LC/src/screens/Vault.jsx` — legacy `downloadV2` uses the shared helper (metadata authenticated before `createWritable`); panel import
- `IDEA1-AEGIS_Drive_LC/src/components/vault/VaultTransferPanel.jsx` — panel moved out of `Vault.jsx` for reuse (unchanged markup)
- `IDEA1-AEGIS_Drive_LC/src/lib/strings.js` — `vaultTreeDownloadBusy` (en/th/zh)
- `IDEA1-AEGIS_Drive_LC/tests/fixtures/vaultScreenBackend.js` — faithful stub of the helper + event log
- `IDEA1-AEGIS_Drive_LC/tests/vaultDownloadPickerFirst.test.js` — new, real crypto (PF-1…PF-12)
- `IDEA1-AEGIS_Drive_LC/tests/vaultTreeDownloadProgress.test.js` — new, tree screen wiring (TD-1…TD-5)
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — task block

## Verification evidence

- `node --test tests/vaultDownloadPickerFirst.test.js` — pass 14/14 (includes a 1.1 GiB logical file streamed at the 16 MiB production chunk size, sink holds ≤ 1 chunk, ArrayBuffer growth < 8 chunks, `maxInFlight` = 1)
- `node --test --test-force-exit tests/vaultTreeDownloadProgress.test.js` — pass 4/4
- RED: the same 4 tree tests against base `VaultTreeScreen.jsx` — fail 4/4 (picker not requested in the click turn; metadata work before the picker; no failure/progress panel)
- `node --test --test-concurrency=1 tests/vaultChunkedDownloadClient.test.js tests/vaultDownloadMime.test.js` — pass 29/29
- `node --test --test-concurrency=1 <every tests/(vault|preview|i18n|workspace|transfer)*.test.js>` — head 1,410 tests / 1,189 pass / 90 fail / 131 skipped; base `e8efe3bb` same file set 1,392 / 1,171 / 90 / 131. Failing-name diff: 0 head-only, 0 base-only → `NEW_FAILURES=0` (literal FAIL by count; the 90 are pre-existing: legacy-screen suites whose DOM no longer mounts, i18n `vaultKeyConfirmLabel` parity, `PIO-2` CRLF source slice, `vaultDerivativeRead` file-level)
- `npx vite build` — pass; tracked `dist/` restored, not committed

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — new `IDEA1-VAULT-LARGE-DOWNLOAD-UX-1` task block (root causes, new order, not-measured items)

## Shared surfaces touched

- None — task stayed inside its selected area

## Integration requests

- None

## Known limitations

- No real-browser measurement: click-to-picker latency, WebCrypto queue contention, and Chromium's `.crswap` finalisation/Safe Browsing time on `close()` are NOT MEASURED; evidence is jsdom/Node only. The `onTiming` marks exist for a later real-Chrome probe.
- Chromium may leave the empty placeholder file the picker creates when metadata authentication or the transfer then fails; it is never written or closed as complete. It is not deleted automatically, because `remove()` could delete a file the user chose to overwrite.
- Bulk download of several V2 files still opens one picker per file in sequence; pickers after the first have no user activation and are reported as failures (unchanged from before).
- The rollback (read-only) list gets the picker-first order but no progress panel.
- Download stays strictly sequential; a bounded-concurrency pipeline needs separate throughput measurement and design.
