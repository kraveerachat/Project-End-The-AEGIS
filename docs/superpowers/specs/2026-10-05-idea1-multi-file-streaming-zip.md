# IDEA1 — Multi-file Download as One Streaming ZIP (architecture spec)

**Status:** PROPOSED — awaiting Human Owner review. Spec only: `IMPLEMENTATION_AUTHORIZED=NO`, `PRODUCTION_MUTATION_AUTHORIZED=NO`. No runtime source, test, server, dependency, or deployment change accompanies this document. **Area/owner:** `idea1` / `kla`. **Classification:** ARCHITECTURAL. **Base:** `origin/main` `912b18005bb2fc80bb4e8d1fe8aa88803ac27314` (PR #334 merged; PR #323 D-1 and PR #319 Trash preview merged).

## 1. Problem and goal

Selecting several files and pressing **Download** today produces one browser download per file:

- **Normal Files** (`src/screens/Files.jsx:1204-1210`) loops `downloadFile()`, which clicks one `<a href="/api/files/:id/download">` per file. Browsers may prompt "allow multiple downloads" and the user gets N separate files.
- **Private Vault tree** (`src/screens/VaultTreeScreen.jsx:492-535`, `startBulkDownload`) runs `treeDownloadEntry` once per file, and each run opens its own Save picker through `prepareVaultV2Download`. PR #334 records the limitation: "pickers after the first lack user activation".

Goal: **1–3 files keep today's behaviour exactly; 4 or more files are saved as one `.zip`** through one Save picker. Private Vault plaintext and keys stay in the browser, memory stays bounded, and a failed or cancelled archive is never left looking complete.

## 2. Verified current-main facts this spec builds on

All facts below were read from `912b1800`. File paths are relative to `IDEA1-AEGIS_Drive_LC/`.

| Fact | Where | Consequence for ZIP |
|---|---|---|
| `prepareVaultV2Download` opens `showSaveFilePicker` **first**, then `unwrapVaultV2Dek` + `decryptVaultV2MetaWithDek`, then `createWritable()`; returns `{ok, dek, sink}` or `cancelled/picker/too-large-for-memory/wrong-key/destination` | `src/lib/vaultChunkedDownload.js:116` | Cannot be reused per entry (it would open N pickers). The authentication half must be extracted (§11). |
| `downloadVaultV2` fetches one chunk at a time, builds AAD in-browser, AES-GCM-decrypts, checks per-chunk plaintext length against `plaintextRangeFor`, writes to `sink.write`, checks total `bytesWritten === meta.plainSize`, re-checks `signal` before `sink.close()`, and calls `sink.abort()` on every failure | `src/lib/vaultChunkedDownload.js:166-252` | An **entry sub-sink** can wrap the archive. Its `close()`/`abort()` must not close or abort the archive itself (§11). |
| Sink contract `{kind, write, close, abort}`; `createBufferedSink` hard-fails at `MAX_BUFFERED_PLAINTEXT_BYTES = 64 MiB` with `code: 'BUFFER_LIMIT'` | same file `:29-81` | Reused as the archive sink for the no-FSA path (§14). |
| `startBulkDownload` has a `downloadBusyRef` guard that announces `vaultTreeDownloadBusy`, one `AbortController` per file registered via `unlockedState.registerAbort`, `isPurged()` checks between files, Cancel = stop the whole batch | `VaultTreeScreen.jsx:486-535`, `:105` | The busy, lock and cancel semantics carry over; one controller now covers the whole archive. |
| Bulk download filters `n.kind === 'file'`: folders are skipped **silently** | `VaultTreeScreen.jsx:500` | Folder skip stays; a visible count is added (§6). |
| V1 Vault entries are fetched whole via `apiFetchBytes` and decrypted whole via `decryptFileContent` | `VaultTreeScreen.jsx:144-155` | V1 cannot stream (§12). |
| `VaultTransferPanel` labels are chunk-based (`vaultXferDownloading` "part X of N"); `vaultXferReasonNoSpace` says "not enough free space on the **Data Lake**" | `src/components/vault/VaultTransferPanel.jsx`, `src/lib/strings.js:668` | A new archive stage and a **local-disk** reason are needed (§16, §19). |
| Normal Files download: `requireAuth`, owner check (404 for non-owner), `FILE_DOWNLOAD` audit, `Content-Length = file.size`, `application/octet-stream`, stream errors destroy the socket | `server/routes/api.js:658-688` | Reuse unchanged. A truncated body or size mismatch must fail the archive (§10). |
| `apiFetchBytes` buffers the whole body (`res.arrayBuffer()`) with a 120 s total timeout | `src/lib/api.js:142-175` | Must **not** be used for Normal Files entries; a streaming fetch helper is needed (§10). |
| Vault chunk GET audits `VAULT_V2_READ` on chunk index 0 | `server/routes/api.js:1892-1924` | Audit stays one row per entry (§22). |
| CSP `script-src 'self' 'wasm-unsafe-eval'`, `connect-src 'self'` | `server/middleware/securityHeaders.js:25-40` | hash-wasm WASM is allowed; all fetches are same-origin. |
| `hash-wasm@4.12.0` (existing dependency) exports `createCRC32()`; `"123456789"` → `cbf43926` (verified locally against the installed package) | `package.json`, `node_modules/hash-wasm` | CRC-32 needs no new package (§9). |
| No other ZIP/CRC library exists in `dependencies`/`devDependencies` | `package.json` | Writer is hand-written; no package added. |
| Legacy `Vault.jsx` and `VaultTreeRollback` have no multi-select bulk bar | `src/screens/Vault.jsx`, `VaultTreeScreen.jsx:165+` | Out of scope; unchanged. |

## 3. Architecture decision

**Client-side streaming ZIP**, shared by Normal Files and Private Vault:

```
click ─► plan (sync, pure) ─► showSaveFilePicker (first await) ─► pre-flight
      ─► createWritable ─► for each entry: header → stream bytes (CRC + count) → data descriptor
      ─► central directory + EOCD ─► close()            any failure ─► abort()
```

Rejected alternatives:

- **Server-side ZIP:** impossible for the Vault, because the server holds only ciphertext. A server ZIP would either contain useless `.aegisenc` blobs or need plaintext or keys on the server.
- **Hybrid** (server ZIP for Normal Files, client ZIP for the Vault): adds a new authenticated, audited, rate-limited endpoint and a second archive path for one benefit, large Normal-Files archives on browsers without File System Access, which §14 handles with the existing per-file fallback.

No new server route, no server change, no package.

## 4. User-visible behaviour (spec items 1–2)

Selection is first reduced to **files** (folders and unresolvable ids removed, §6). Let `n` be the remaining file count.

| `n` | Behaviour |
|---|---|
| 0 | No download. Announce the folder/unavailable count (§6). Nothing fetched, no picker. |
| 1, 2, 3 | **Unchanged.** Files: one anchor per file. Vault: `treeDownloadEntry` per file (picker-first, progress, cancel from #334). The only addition is the skipped-folder notice when folders were in the selection. |
| 4 … `MAX_ZIP_ENTRIES` (1000) | One ZIP archive with exactly one Save picker (§13), or the no-FSA fallback (§14). |
| > 1000 | Refuse before the picker: "Select at most 1000 files for one archive". Nothing fetched. |

Single-file entry points (tile menu, preview modal `onDownload`) always pass one node and stay on the per-file path.

Busy rule: one bulk operation per screen. A second click while a per-file batch **or** an archive is running announces the busy message (`vaultTreeDownloadBusy` for the Vault, a new equivalent for Files) and does not open a picker. Files gains a `downloadBusyRef` for the archive path; its 1–3 anchor path stays fire-and-forget as today.

Vault archives show a persistent, non-blocking disclosure in the transfer panel from archive start (picker return, or the start of the buffered path) until dismissal: **"This ZIP is not encrypted. Anyone with the file can open it."** (en/th/zh). Normal Files archives show no disclosure, because those files are not end-to-end encrypted.

## 5. Archive naming, duplicate policy and sanitisation (spec items 3–5)

**Archive name** (`suggestedName`), local time:

- Files: `AEGIS-Files-YYYYMMDD-HHmmss.zip`
- Vault: `AEGIS-Vault-export-YYYYMMDD-HHmmss.zip`

The picker passes `types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }]`. The user may rename it. The Blob fallback uses the same name with type `application/zip`.

**Entry names** are a flat list: no directories, because v1 has no folder recursion. Source: Files uses `file.name` from the listing; the Vault uses the **manifest** node name (TS-13), never the envelope `meta.name`. `zipEntryNames.js` applies these steps in order:

1. `String(name).normalize('NFC')`.
2. Replace `/`, `\`, `:`, `*`, `?`, `"`, `<`, `>`, `|` and C0/C1 controls (U+0000–U+001F, U+007F–U+009F) with `_`.
3. Strip leading and trailing whitespace, and strip trailing `.` characters (Windows rule).
4. Reject the path components `.` and `..` (they become `_`). Since step 2 removes separators, no entry can contain a path, so zip-slip is impossible by construction.
5. Windows reserved device names (`CON PRN AUX NUL COM0-9 COM¹²³ LPT0-9 LPT¹²³`, case-insensitive, with or without an extension) get a `_` prefix.
6. An empty result becomes `file`.
7. Truncate to **at most 255 UTF-8 bytes** on a code-point boundary, preserving the final extension (`.ext` ≤ 32 bytes) where possible.

**Duplicates:** the comparison key is `name.toLowerCase()` after sanitisation (case-insensitive, because Windows and macOS default filesystems are). The first occurrence in plan order keeps its name; later ones become `stem (2).ext`, `stem (3).ext`, … with the suffix placed before the last extension. Dotfiles count as having no extension (`.env` → `.env (2)`). The suffixed name is checked again against all taken keys, including original names that already look like `x (2).txt`, and re-truncated to 255 bytes if needed. Plan order is the selection order given to the plan, which makes naming deterministic and testable.

## 6. Folder behaviour (item 6)

- v1 never recurses. A selected folder is **skipped** and counted.
- Files ids missing from the current listing (`files.find` miss) are counted as *unavailable*, not dropped silently as today.
- The threshold uses the file count **after** this filtering.
- When `skippedFolders > 0` or `unavailable > 0`, a visible notice appears in **both** the per-file and archive paths, for example "2 folders were skipped. Folders are not included in downloads." This is a new informational message; download behaviour for 1–3 files is otherwise unchanged.

## 7. ZIP format (items 7–8)

All integers are little-endian. The archive contains only what the table lists.

| Field | Value |
|---|---|
| Compression method | 0 (STORE) for every entry |
| General-purpose flags | `0x0808`: bit 3 (data descriptor) + bit 11 (UTF-8 names) |
| Version needed to extract | 20; **45** for a ZIP64 entry. EOCD64 "version needed" is 45 |
| Version made by | 45, host 0 (MS-DOS) |
| DOS time/date | Archive start time (local), identical for all entries. No per-file mtime in v1, so no extra metadata leaves the Vault |
| Extra fields | Only ZIP64 (`0x0001`) when required. No timestamps (UT/NTFS), no Unicode-path extra (bit 11 already marks UTF-8), no comments, no AEGIS identifiers |
| Internal/external attributes | 0 |
| Local file header (`0x04034b50`) | CRC = 0 and sizes = 0 (bit 3). For a ZIP64 entry, both sizes = `0xFFFFFFFF` plus a ZIP64 extra holding 8-byte zeros for uncompressed and compressed size |
| Data descriptor | **With** signature `0x08074b50`, then CRC-32, compressed size, uncompressed size: 4-byte sizes normally, **8-byte sizes for a ZIP64 entry** |
| Central directory header (`0x02014b50`) | Real CRC and sizes. Any field ≥ `0xFFFFFFFF` is written as `0xFFFFFFFF`, and its real value goes in the ZIP64 extra in APPNOTE order (uncompressed, compressed, local-header offset), listing only the overflowed fields |
| End records | ZIP64 EOCD (`0x06064b50`) + locator (`0x07064b50`) when needed, then the classic EOCD (`0x06054b50`) with overflowed fields set to `0xFFFF`/`0xFFFFFFFF`. Comment length 0 |

**ZIP64 triggers.** `≥` is used so a sentinel value never appears as a real value.

- **Entry ZIP64** iff `size ≥ 0xFFFFFFFF`. This is decided *before* the local header is written, from the authenticated (Vault) or declared and server-confirmed (Files) size. Because compressed size = uncompressed size under STORE, both fields follow the same rule.
- **Offset overflow** iff an entry's local-header offset `≥ 0xFFFFFFFF`. This only adds the offset to that entry's central ZIP64 extra and does not change its local header.
- **Archive ZIP64 end records** iff entry count `≥ 0xFFFF` (unreachable under the 1000 cap but implemented), or central-directory size `≥ 0xFFFFFFFF`, or central-directory start offset `≥ 0xFFFFFFFF`.

Zero-byte entries are valid: header, no data, descriptor with CRC `0x00000000` and sizes 0.

Every size is known before writing because Files sizes come from the listing (confirmed by `Content-Length`) and Vault sizes are authenticated in pre-flight. The **exact archive length** is therefore computable in the plan; tests assert it, and the buffered path uses it for the cap check (§14).

Known reader caveat: some single-pass readers, notably Java `ZipInputStream`, cannot read STORED entries that use data descriptors. Readers that use the central directory (Windows Explorer, macOS Archive Utility, 7-Zip, Info-ZIP `unzip`, Python `zipfile`) are expected to work, but this is **not yet proven** for AEGIS output. It is a mandatory real-browser and real-tool acceptance item (§24). If a required reader fails, the fallback design is to write true CRC and sizes into the local header by seeking back with `FileSystemWritableFileStream.write({ type: 'seek' })` on the FSA path. That change needs Human approval and is not part of v1.

## 8. CRC strategy (item 9)

- Use the existing `hash-wasm` `createCRC32()` (IEEE, reflected polynomial `0xEDB88320`). No new package.
- Create the hasher **after** the picker returns. It is async (WASM init), and nothing async may run before the picker.
- Per entry: `init()`, then `update(bytes)` for every chunk **before** that chunk is written to the archive, then `digest('hex')` → parse into a uint32 → write little-endian.
- A hasher exception counts as a write failure and aborts the archive (§20).
- The CRC protects the archive *after* creation. It does **not** prove the source bytes are correct: source integrity comes from Vault AEAD and exact size checks (§10, §11), and the spec makes no stronger claim.

## 9. Module layout (deviations from the suggested file list)

| Path | Change | Note |
|---|---|---|
| `src/lib/zipStreamWriter.js` | NEW | Pure writer over an injected archive sink: `begin()`, `addEntry({name, size}) → entrySink`, `finish()`, `abort()`. Tracks offsets, ZIP64 decisions, CRC, byte counts and central-directory records. Has no knowledge of Files, the Vault or the DOM. |
| `src/lib/zipEntryNames.js` | NEW | Sanitisation and duplicate numbering (§5). |
| `src/lib/bulkDownloadPlan.js` | NEW | Synchronous, pure: filter, threshold (`ZIP_THRESHOLD = 4`), `MAX_ZIP_ENTRIES = 1000`, V1 refusal (§12), totals, exact archive length, FSA/buffered/per-file decision, feature switch `BULK_ZIP_ENABLED` (§25). |
| `src/lib/bulkZipDownload.js` | **NEW (deviation)** | One orchestrator for the phase machine (picker → pre-flight → writable → entries → finish/abort, progress, cancel, lock) with two **source adapters**: `filesEntrySource` and `vaultV2EntrySource`. This keeps the security-critical ordering in one tested place instead of copying it into two screens. |
| `src/lib/api.js` | **MOD (deviation)** | Add `apiFetchStream(path, { signal, idleTimeoutMs })`. Same `credentials: 'include'`, base URL, and 401/403 handling as `apiFetchBytes`, but returns `{ ok, status, errorKind, contentLength, reader }` without buffering. Uses an **idle** timeout (no bytes for 60 s) instead of a total timeout, so large files are not killed. |
| `src/lib/vaultChunkedDownload.js` | MOD | Extract `authenticateVaultV2Entry({ kek, blob }) → { ok, plainSize } \| { ok:false, reason:'wrong-key' }` from `prepareVaultV2Download`. `prepareVaultV2Download` calls it, a behaviour-preserving refactor, and the #334 tests must stay green. `downloadVaultV2` is unchanged. |
| `src/screens/VaultTreeScreen.jsx` | MOD | `startBulkDownload`: plan; `n ≤ 3` keeps the current loop; `n ≥ 4` calls the orchestrator with the shared busy ref, controller and `registerAbort`. |
| `src/screens/Files.jsx` | MOD | Bulk handler: plan; `n ≤ 3` keeps the current anchors; `n ≥ 4` calls the orchestrator. Adds a busy ref and renders the transfer panel. |
| `src/components/vault/VaultTransferPanel.jsx` | MOD | Add stage `archiving` with vars `{ index, count, name }`, reason `localDiskFull`, and the optional disclosure line. **Not moved**; Files imports it from `components/vault/` to keep the diff minimal. A rename to a neutral path is a later cleanup. |
| `src/lib/strings.js` | MOD | en/th/zh keys: archiving label, folders skipped, unavailable, too many files, V1 not supported in archive, local disk full, unencrypted disclosure, Files busy, Files no-FSA fallback notice. |
| `tests/…`, `tests/fixtures/vaultScreenBackend.js` | NEW/MOD | §23. |
| Obsidian receipt + `idea1/idea1-status.md` | at closeout | Exactly one receipt for the implementation task. |
| `server/**`, `package.json`, lockfile, `Vault.jsx`, `VaultTreeRollback` | **unchanged** | — |

## 10. Normal Files streaming path (item 10)

The adapter `filesEntrySource.open(entry, signal)` works as follows:

1. `apiFetchStream('/api/files/:id/download', { signal })`. Same route, cookie, owner check and audit as today.
2. Any non-2xx, or a network or idle-timeout error, fails as `network`/`server`/`unauthorized`/`forbidden`, mapped to the existing reason keys.
3. If `Content-Length` is present and ≠ planned `file.size`, fail `size-mismatch` *before* writing that entry's data, which covers a file that changed since the listing.
4. Read `reader.read()` in a loop. For each `value`: check `signal` and the running total (exceeding the planned size fails immediately), update the CRC, `await archive.write(value)`, then drop the reference.
5. At end of stream, `bytes === file.size` is required, otherwise `size-mismatch`. This catches a server stream that ends early after a disk error.
6. Cancel or lock → `reader.cancel()` plus the fetch `AbortController` → the archive aborts.

The browser chooses the read size (typically ≤ 1 MiB). Backpressure comes from awaiting each `writable.write`.

## 11. Vault V2 streaming and decryption path (item 11)

**Pre-flight (after the picker, before `createWritable`)**, for each planned entry in order:

- `authenticateVaultV2Entry({ kek, blob })` unwraps the DEK and decrypts metadata with its own AAD.
- `meta.plainSize` must be a safe non-negative integer. If the manifest supplies `node.plainSize`, it must equal `meta.plainSize`, otherwise fail `integrity`.
- The DEK is **not retained** across entries, so no array of keys accumulates.
- `signal`/`isPurged()` is checked between entries.
- After pre-flight: recompute totals, ZIP64 flags and the exact archive length from the **authenticated** sizes. Re-check the buffered cap on the no-FSA path.
- Any failure here means `createWritable()` is never called, so not one byte of any entry reaches the destination. This extends #334's invariant to the whole archive.

**Entry streaming** (after `createWritable`), for each entry:

1. `writer.addEntry({ name, size })` writes the local header and returns an **entry sub-sink**:
   - `write(bytes)`: CRC update, then archive write, then byte count.
   - `close()`: marks the entry as data-complete and does **not** close the archive.
   - `abort()`: no-op on the archive. The orchestrator owns the single archive abort.
2. `downloadVaultV2({ kek, blob, sink: entrySink, signal, onProgress })`. It re-unwraps the DEK and re-authenticates metadata against the **same in-memory `blob` object** used in pre-flight, so there is no server re-fetch in between. It also enforces per-chunk AEAD, per-chunk length, total `size-mismatch`, and the abort check before close. Only authenticated plaintext ever reaches `entrySink.write`.
3. `res.ok === false` → archive abort with reason `res.reason` (`auth-failed`, `chunk-size-mismatch`, `size-mismatch`, `network`, `fetch`, `missing-iv`, `cancelled`, …).
4. `res.bytesWritten` must equal the pre-flight size. The writer then writes the data descriptor and records the central entry.

Memory: one ciphertext chunk plus one plaintext chunk in flight (the V2 chunk is 8 MiB plaintext + 16 B tag), as with a single #334 download.

## 12. Vault V1 behaviour (item 12)

V1 blobs (`blobRef.formatVersion !== 2`) can only be fetched and decrypted as a whole buffer, which breaks the "no whole-file buffering on the FSA path" invariant.

**v1 decision:** if the planned archive contains **any** V1 entry, the plan refuses **before the picker**. `formatVersion` is known synchronously from the manifest. The message is "This selection contains older-format files that can't be added to a ZIP. Download them individually, or select fewer than 4 files." Nothing is fetched.

The 1–3 file path keeps today's V1 behaviour. Including V1 entries as a bounded exception (≤ 64 MiB each, one at a time) is listed as an open decision (§27, D-1).

## 13. File System Access path (item 13)

When `supportsStreamingFileSink()` is true:

1. The click handler computes the plan **synchronously**: O(n) pure work over at most 1000 items, with no crypto and no I/O.
2. The first `await` is `showSaveFilePicker({ suggestedName, types })`, so there is exactly one picker per archive.
3. Picker `AbortError` → silent return (`cancelled`), nothing fetched. Any other picker error → `picker` failure, nothing fetched.
4. CRC hasher init, then pre-flight (Vault only, §11), then `createWritable()`. A failure there is reported as `destination`.
5. Entries are streamed sequentially (`maxInFlight` = 1, one entry at a time), then `finish()` writes the central directory and EOCD, then the final `signal`/`isPurged()` check, then `writable.close()`.

## 14. No-FSA fallback (item 14)

When `showSaveFilePicker` is absent (for example Firefox or Safari):

| Source | Exact archive length ≤ 64 MiB | > 64 MiB |
|---|---|---|
| Files | Buffered ZIP: archive sink = `createBufferedSink({ limitBytes: 64 MiB })`, then `Blob([...], { type: 'application/zip' })`, then an anchor download, then `revokeObjectURL` after 10 s | **Per-file fallback**: today's anchors, one per file, with a visible notice that this browser cannot save large archives. No buffering. |
| Vault | Same buffered ZIP. Object URL registered with `unlockedState.registerObjectUrl` so a lock revokes it | **Refuse** with the existing too-large message. Nothing fetched, no per-file loop. |

- The decision first uses the plan's exact length: Files sizes from the listing, Vault sizes from `node.plainSize` or `estimatedPlainSize(blob)`.
- The Vault re-checks after pre-flight using authenticated sizes.
- The buffered sink's own hard limit is the backstop: any overrun throws `BUFFER_LIMIT`, the archive aborts, and the parts are discarded.
- RAM can never grow beyond 64 MiB plus one chunk.

## 15. Memory bounds (item 15)

| Path | Bound (excluding the browser's own I/O buffers) |
|---|---|
| FSA, Vault | ≤ 1 ciphertext chunk + 1 plaintext chunk (≈ 16 MiB) + central-directory records |
| FSA, Files | ≤ 1 `ReadableStream` read (browser-sized) + central-directory records |
| Central directory | ≤ 1000 × (46 + 255 + 28) B ≈ 330 KB, held until `finish()` |
| No-FSA | ≤ 64 MiB archive (hard) + 1 chunk |

There is no whole-file and no whole-archive buffering on the FSA path. A source-guard test forbids `arrayBuffer()`, `apiFetchBytes` and `new Blob(` in `zipStreamWriter.js`, `bulkZipDownload.js` and the Files adapter, except in the buffered-fallback finaliser, which is explicitly allow-listed.

## 16. Progress semantics (item 16)

- One archive-level state: `{ kind: 'download', stage: 'archiving', index, count, name, transferredBytes, totalBytes, percent, rate }`.
- `totalBytes` is the sum of entry payload sizes, in the same plaintext units the user sees on tiles; ZIP overhead is excluded from the displayed total.
- `transferredBytes` is the payload bytes written so far, across entries.
- `percent = floor(transferred / total × 1000) / 10`, never decreasing, and **capped at 99.9 until `close()` resolves**. Then 100 and the panel clears, as with today's success.
- Total 0 (all zero-byte files) shows 0, then 100 on close.
- `index`/`count`/`name` show "File i of N: name".
- Rate and ETA come from the existing `createRateEstimator` sampled on archive bytes.
- No timer-driven movement (the existing `VaultTransferPanel` rule).
- No progress before the picker returns. During pre-flight the stage is `preparing`.

## 17. Cancel semantics (item 17)

- One `AbortController` per archive, registered via `unlockedState.registerAbort` (Vault), passed to every fetch and to `downloadVaultV2`, and checked between chunks, between entries, and immediately before `close()`.
- The panel's Cancel aborts it. No later entry starts.
- Result: `writable.abort()` exactly once (buffered: parts discarded), stage cleared, "cancelled" rather than "failed".
- Cancel during pre-flight → `createWritable` is never called.
- Picker cancelled → nothing fetched.
- Known limitation, carried from #334 and not re-measured here: Chromium may leave an empty placeholder at the chosen path. It is not auto-deleted, because the user may have chosen to overwrite an existing file.

## 18. Lock semantics (item 18)

- Locking the Vault calls the registered controller's abort, with the same result as Cancel.
- `isPurged()` is also checked between entries and before `close()`, which covers a lock with no signal observer.
- Buffered parts are discarded and any already-created object URL is revoked by the existing `registerObjectUrl` purge.
- No DEK is retained across entries.

## 19. Disk and quota errors (item 19)

- A `QuotaExceededError` (or a `DOMException` named `QuotaExceededError`) from `writable.write` or `writable.close` → archive abort with reason `localDiskFull` and a new message: "There isn't enough free space on this device to save the archive."
- The existing `vaultXferReasonNoSpace` (Data Lake) is **not** reused.
- There is no pre-check: `navigator.storage.estimate()` reports origin quota, not free space on the user's disk.

## 20. Partial-archive and finalisation guarantees (item 20)

`writable.close()` is called **exactly once, and only if all of the following hold**:

- every entry completed with bytes = authenticated or declared size;
- every Vault chunk passed AEAD;
- every CRC was computed;
- the central directory and EOCD were written;
- the signal is not aborted and `isPurged()` is false.

Every other outcome calls `abort()` exactly once, and never `close()`:

- network error, non-2xx, idle timeout, AEAD failure, size mismatch, hasher or write error, quota, lock, Cancel.

An entry failure fails the **whole** archive. There is no skip-and-continue, because a ZIP silently missing a file would look complete. The panel names the failed entry and the reason category.

If `close()` itself rejects (for example quota at swap commit), the result is reported as a failure. The browser then decides what happens to the destination; that behaviour is recorded as a real-browser acceptance item, not claimed.

## 21. Security and privacy model (item 21)

- Vault plaintext and keys never leave the tab. The server sees only the per-chunk ciphertext GETs it already serves.
- AAD is still built in the browser (unchanged `downloadVaultV2`). Envelope authentication covers every entry before any output (§11).
- Entry names come from the manifest (TS-13). No envelope metadata, mtime, owner, id or AEGIS marker is written into the archive.
- The archive is **unencrypted**, the same as today's individual Vault download. It bundles many files, so the disclosure in §4 is mandatory for Vault archives.
- Name sanitisation removes path separators, so zip-slip is impossible on extraction.
- No authorisation or RBAC moves to the client. Normal Files ownership is still enforced per request on the server.
- No token or key touches browser storage. Cookies, CSRF and the CSP are unchanged.

## 22. Audit behaviour (item 22)

Unchanged and truthful:

- Normal Files: one `FILE_DOWNLOAD` row per fetched file, plus `DENIED` rows from the existing route.
- Vault: one `VAULT_V2_READ` row per entry, written at chunk 0.

The server cannot tell an archive download from individual downloads, and that is accepted for v1. If an archive aborts after some entries were fetched, their audit rows remain, because those bytes were sent. No new audit event is added.

## 23. Tests required under strict TDD (item 23)

Each test is written RED first. RED evidence is recorded against base `912b1800`, using Node's built-in runner with real WebCrypto and the existing fixtures. Vault pre-flight reads only the in-memory blob record (`wrappedDekB64`, `wrapIvB64`, `metaB64`, `metaIvB64`), so it performs no network fetch.

**`tests/zipStreamWriter.test.js`** (pure, with an in-test central-directory parser and extractor):

- CRC vector `"123456789"` → `0xCBF43926`; empty → `0`.
- Byte-exact round-trip of entries, including a 0-byte entry.
- Flags `0x0808`, method 0, data-descriptor signature present, local CRC/sizes zero.
- Thai, CJK and emoji names round-trip as UTF-8 with bit 11 set.
- An entry declared at `0xFFFFFFFF` (synthetic generator, never allocated) becomes a ZIP64 entry with 8-byte descriptor sizes and central ZIP64 extra fields; an entry declared at `0xFFFFFFFE` does not.
- Local-header offset ≥ `0xFFFFFFFF` (simulated offset base) → offset only in the central ZIP64 extra.
- Archive ZIP64 EOCD and locator appear exactly at the trigger boundaries.
- Final length equals the plan's exact-length function.
- `write` beyond the declared size throws; `finish()` with an incomplete entry throws.
- On any error, `abort` is called once and `close` never.

**`tests/zipEntryNames.test.js`:**

- `../x`, `a/b\c`, `CON`, `con.txt`, `name.`, `  x  `, controls, `''`.
- A 300-byte Thai name keeps its extension and stays ≤ 255 bytes.
- `A.txt`/`a.txt` → `a (2).txt`; triple duplicates; a pre-existing `x (2).txt` collision; `.env` duplicates; NFC/NFD forms collide.

**`tests/bulkDownloadPlan.test.js`:**

- 1, 2, 3 files → per-file; 4 → ZIP; 1000 → ZIP; 1001 → refused.
- 3 files + 2 folders → per-file with skipped count 2.
- 4 files + 1 folder → ZIP with skipped count 1.
- Unresolvable ids are counted.
- A V1 entry within 4+ → refused before the picker.
- No-FSA: ≤ 64 MiB exact length → buffered; above that, Files → per-file and Vault → too-large.
- `BULK_ZIP_ENABLED=false` → per-file for every `n`.

**`tests/bulkZipVault.test.js`** (orchestrator + `vaultV2EntrySource`, real crypto, `vaultScreenBackend` fixture):

- The picker is called synchronously inside the click, before any await, exactly once for N = 5.
- Picker cancelled → zero fetches.
- A bad envelope on entry 3 → `createWritable` is never called.
- Manifest `plainSize` ≠ `meta.plainSize` → `integrity`, no writable.
- A tampered chunk mid-entry → `abort` once, `close` never, failed name reported.
- Lock during pre-flight, mid-entry, and after the last entry before close → abort.
- Cancel → no later entry fetched.
- Strict fetch/write alternation.
- Progress is monotonic, ≤ 99.9 before close and 100 after.
- `QuotaExceededError` on write → `localDiskFull`.
- Extracted bytes equal the sources (SHA-256).
- Busy: a second click announces and opens no second picker.
- No DEK array retained (spy on unwrap count = 2 × entries).

**`tests/bulkZipFiles.test.js`** (orchestrator + `filesEntrySource` with a stubbed `fetch` `ReadableStream`):

- Streamed with no `arrayBuffer` call.
- Non-2xx, 401, `Content-Length` mismatch, early end of stream, and over-long stream → each aborts.
- Idle timeout → abort.
- 1–3 files → anchors only, unchanged.
- No-FSA > 64 MiB → per-file anchors plus the notice.

**`tests/vaultDownloadPickerFirst.test.js`** (existing #334 suite): stays green after the `authenticateVaultV2Entry` extraction.

**Source guard:** no `arrayBuffer(`/`apiFetchBytes`/`new Blob(` outside the allow-listed fallback finaliser, and no await before `showSaveFilePicker` in the click path.

**i18n:** every new key is present in en/th/zh (existing i18n tests).

**Regression:** run `tests/(vault|preview|i18n|workspace|transfer|files)*.test.js`; the failing-name diff against base must be 0 new. `npx vite build` and `node scripts/validate-vault.mjs` must pass.

## 24. Real-browser acceptance matrix (item 24)

Run against a non-Production instance only. Every cell must record its result; an untested cell stays `NOT RUN`, never `PASS`.

| # | Scenario | Chrome/Edge Win (FSA) | Chrome macOS (FSA) | Firefox (no FSA) | Safari macOS (no FSA) |
|---|---|---|---|---|---|
| A1 | 3 files → 3 per-file downloads, unchanged | ✓ | ✓ | ✓ | ✓ |
| A2 | 4 small files → exactly 1 picker, 1 ZIP | ✓ | ✓ | buffered ZIP | buffered ZIP |
| A3 | 0-byte, Thai/CJK/emoji, duplicate and reserved names | ✓ | ✓ | ✓ | ✓ |
| A4 | Folder in the selection → skipped notice | ✓ | ✓ | ✓ | ✓ |
| A5 | Vault: single entry ≥ 4.1 GiB (ZIP64) plus 3 small | ✓ | ✓ | refused (too large) | refused |
| A6 | Files: total > 4.1 GiB across entries (offset ZIP64) | ✓ | ✓ | per-file fallback | per-file fallback |
| A7 | Cancel mid-entry 2 → no finalised ZIP; record placeholder behaviour | ✓ | ✓ | ✓ | ✓ |
| A8 | Lock Vault mid-archive → abort | ✓ | ✓ | ✓ | ✓ |
| A9 | Disk full (small VHD/USB target) → `localDiskFull`, no finalised ZIP | ✓ | ✓ | — | — |
| A10 | Network drop mid-entry → failure, no finalised ZIP | ✓ | ✓ | ✓ | ✓ |
| A11 | Tab memory: peak growth during a 1 GiB and a 5 GiB entry differs by < 64 MiB (not proportional to size) | ✓ | ✓ | — | — |
| A12 | Unencrypted disclosure visible for the Vault, absent for Files | ✓ | ✓ | ✓ | ✓ |

**Reader matrix** for one A2 archive and one A5/A6 archive: Windows Explorer, macOS Archive Utility, 7-Zip, Info-ZIP `unzip -t`, Python `zipfile.testzip()`. Extracted SHA-256 must equal the sources. Any required reader failing blocks release (see §7 caveat).

## 25. Rollback strategy (item 25)

- Client-only change: no server route, schema, data, Vault format or persisted state changes. Rollback is a revert of the implementation PR.
- In addition, `BULK_ZIP_ENABLED` (an exported constant in `bulkDownloadPlan.js`, default `true` after acceptance) set to `false` restores today's per-file behaviour for every `n` with a one-line change.
- Archives already saved by users stay standard ZIP files; nothing references them.
- The `authenticateVaultV2Entry` extraction is behaviour-preserving and covered by the #334 suite, so it is safe to keep or revert.

## 26. Out of scope (item 26)

Compression (DEFLATE) and its optimisation; parallel or bounded-concurrency tuning; recursive folder ZIP and directory entries; a server-side ZIP endpoint; changes to transfer throughput or chunk size; D-1 Preview; Trash; legacy `Vault.jsx`, `VaultTreeRollback` and share links; encrypted (password) ZIP; per-file mtime preservation; resumable archives; Production deployment.

## 27. Open decisions for the Human Owner

- **D-1:** V1 Vault entries in a ZIP. v1 refuses them (§12). The alternative is a bounded exception: ≤ 64 MiB each, one at a time, which would relax the FSA no-buffering invariant for V1 only.
- **D-2:** `MAX_ZIP_ENTRIES = 1000`. It bounds pre-flight latency (one unwrap + metadata decrypt per Vault entry) and central-directory memory. It should be adjusted only after A2/A5 timings exist.
- **D-3:** whether the Vault disclosure should be a confirm step instead of a non-blocking notice. A confirm button is itself a user activation, so the picker could open from it, but that adds a click for every archive.
- **D-4:** whether a §7 reader failure (data descriptors on STORED entries) should trigger the seek-back local-header patch before release.
