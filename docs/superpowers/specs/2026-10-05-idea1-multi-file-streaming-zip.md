# IDEA1 — Multi-file Download as One Streaming ZIP (architecture spec)

**Status:** REVISED after Codex re-review (revision 3). Human design decisions D-1 to D-4 are applied (§27). Awaiting final Codex re-review, then Human approval of the written spec. Spec only: `IMPLEMENTATION_AUTHORIZED=NO`, `PRODUCTION_MUTATION_AUTHORIZED=NO`. No runtime source, test, server, dependency, or deployment change accompanies this document. **Area/owner:** `idea1` / `kla`. **Classification:** ARCHITECTURAL. **Base:** `origin/main` `912b18005bb2fc80bb4e8d1fe8aa88803ac27314` (PR #334 merged; PR #323 D-1 and PR #319 Trash preview merged).

## 1. Problem and goal

Selecting several files and pressing **Download** today produces one browser download per file:

- **Normal Files** (`src/screens/Files.jsx:1204-1210`) loops `downloadFile()`, which clicks one `<a href="/api/files/:id/download">` per file. Browsers may prompt "allow multiple downloads" and the user gets N separate files.
- **Private Vault tree** (`src/screens/VaultTreeScreen.jsx:492-535`, `startBulkDownload`) runs `treeDownloadEntry` once per file, and each run opens its own Save picker through `prepareVaultV2Download`. PR #334 records the limitation: "pickers after the first lack user activation".

Goal: **1–3 files keep today's behaviour exactly; 4 or more files are saved as one `.zip`** through one Save picker. Private Vault plaintext and keys stay in the browser, memory stays O(chunk), and AEGIS never reports a failed or cancelled archive as successful.

## 2. Verified current-main facts this spec builds on

All facts below were read from `912b1800`. File paths are relative to `IDEA1-AEGIS_Drive_LC/` unless they start with `gateway/`.

| Fact | Where | Consequence for ZIP |
|---|---|---|
| `prepareVaultV2Download` opens `showSaveFilePicker` **first**, then `unwrapVaultV2Dek` + `decryptVaultV2MetaWithDek`, then `createWritable()`; returns `{ok, dek, sink}` or `cancelled/picker/too-large-for-memory/wrong-key/destination` | `src/lib/vaultChunkedDownload.js:116` | Cannot be reused per entry (it would open N pickers). The authentication half must be extracted (§11). |
| `downloadVaultV2` fetches one chunk at a time, builds AAD in-browser, AES-GCM-decrypts, checks per-chunk plaintext length against `plaintextRangeFor`, writes to `sink.write`, checks total `bytesWritten === meta.plainSize`, re-checks `signal` before `sink.close()`, and calls `sink.abort()` on every failure | `src/lib/vaultChunkedDownload.js:166-252` | An **entry sub-sink** can wrap the archive. Its `close()`/`abort()` must not close or abort the archive itself (§11). |
| Sink contract `{kind, write, close, abort}`; `createBufferedSink` hard-fails at `MAX_BUFFERED_PLAINTEXT_BYTES = 64 MiB` with `code: 'BUFFER_LIMIT'` | same file `:29-81` | Reused as the archive sink for the no-FSA path (§14). |
| V2 plaintext chunk size: **default 32 MiB**, accepted range **8–64 MiB** (deployment-configurable); each blob records its own `chunkSize` (plaintext + 16 B tag) when it is uploaded | `server/config/vaultTransferLimits.js:22-40`, `src/lib/vaultChunkCrypto.js:162-174` | Peak transient memory per entry follows **that blob's** chunk size, up to 64 MiB plaintext (§15). |
| A 0-byte V2 file has **1** chunk (a 16-byte tag-only AEAD message), never 0 | `src/lib/vaultChunkCrypto.js:155-166` (`planVaultChunks`) | A zero-byte Vault entry is still authenticated (§11, §23). |
| `startBulkDownload` has a `downloadBusyRef` guard that announces `vaultTreeDownloadBusy`, one `AbortController` per file registered via `unlockedState.registerAbort`, `isPurged()` checks between files, Cancel = stop the whole batch | `VaultTreeScreen.jsx:486-535`, `:105` | The busy, lock and cancel semantics carry over; one controller now covers the whole archive. |
| Bulk download filters `n.kind === 'file'`: folders are skipped **silently** | `VaultTreeScreen.jsx:500` | Folder skip stays; a visible count is added (§6). |
| V1 Vault entries are fetched whole via `apiFetchBytes` and decrypted whole via `decryptFileContent` | `VaultTreeScreen.jsx:144-155` | V1 cannot stream, so it is out of the ZIP (§12, D-1). |
| `VaultTransferPanel` labels are chunk-based (`vaultXferDownloading` "part X of N"); `vaultXferReasonNoSpace` says "not enough free space on the **Data Lake**" | `src/components/vault/VaultTransferPanel.jsx`, `src/lib/strings.js:668` | A new archive stage and a **local-disk** reason are needed (§16, §19). |
| Normal Files download: `requireAuth`, owner check (404 for non-owner), `FILE_DOWNLOAD` audit, **`Content-Length = file.size` always set**, `application/octet-stream`, stream errors destroy the socket | `server/routes/api.js:658-688` | Reused unchanged. `Content-Length` is mandatory for ZIP entries (§10). |
| The repository gateway and server apply no response compression: no `gzip` in `gateway/nginx.conf`, no compression middleware in `server/`; the API location uses `proxy_buffering off` | `gateway/nginx.conf:123,130` | `Content-Length` reaches the browser unchanged in the repository configuration. A missing header means an unexpected intermediary, so the entry fails closed (§10). |
| `apiFetchBytes` buffers the whole body (`res.arrayBuffer()`) with a 120 s total timeout | `src/lib/api.js:142-175` | Must **not** be used for Normal Files entries; a streaming fetch helper is needed (§10). |
| Vault chunk GET audits `VAULT_V2_READ` on chunk index 0 | `server/routes/api.js:1892-1924` | Audit stays one row per entry (§22). |
| CSP `script-src 'self' 'wasm-unsafe-eval'`, `connect-src 'self'` | `server/middleware/securityHeaders.js:25-40` | hash-wasm WASM is allowed; all fetches are same-origin. |
| `hash-wasm@4.12.0` (existing dependency) exports `createCRC32()`; `"123456789"` → `cbf43926` (verified locally against the installed package) | `package.json`, `node_modules/hash-wasm` | CRC-32 needs no new package (§8). |
| No other ZIP/CRC library exists in `dependencies`/`devDependencies` | `package.json` | The writer is hand-written; no package is added. |
| Vault dialogs already exist as a component module | `src/components/vault/VaultDialogs.jsx` | Home for the plaintext-export confirmation (§4, D-3). |
| Legacy `Vault.jsx` and `VaultTreeRollback` have no multi-select bulk bar | `src/screens/Vault.jsx`, `VaultTreeScreen.jsx:165+` | Out of scope; unchanged. |

## 3. Architecture decision

**Client-side streaming ZIP**, shared by Normal Files and Private Vault:

```
click ─► plan (sync, pure) ─► [Vault only: plaintext-export confirm; Confirm click ─►]
      showSaveFilePicker (first await) ─► pre-flight ─► createWritable
      ─► for each entry: local header → stream bytes (CRC + count) → data descriptor
      ─► central directory + end records ─► close()
any failure before close() begins ─► one abort() attempt, never close()
```

Rejected alternatives:

- **Server-side ZIP:** impossible for the Vault, because the server holds only ciphertext. A server ZIP would either contain useless `.aegisenc` blobs or need plaintext or keys on the server.
- **Hybrid** (server ZIP for Normal Files, client ZIP for the Vault): adds a new authenticated, audited, rate-limited endpoint and a second archive path for one benefit, large Normal-Files archives on browsers without File System Access, which §14 handles with the existing per-file fallback.

No new server route, no server change, no package.

## 4. User-visible behaviour (spec items 1–2)

Selection is first reduced to **files** (folders and unresolvable ids removed, §6). Let `n` be the remaining file count. All refusals below happen **before** any picker, confirmation, or fetch.

| `n` | Behaviour |
|---|---|
| 0 | No download. Announce the folder/unavailable count (§6). |
| 1, 2, 3 | **Unchanged.** Files: one anchor per file. Vault: `treeDownloadEntry` per file (picker-first, progress, cancel from #334), including V1 entries exactly as today. The only addition is the skipped-folder notice when folders were in the selection. |
| 4 … 1000 | Normal Files: one ZIP through exactly one Save picker (§13) or the no-FSA fallback (§14). Vault: refuse if any entry is V1 (§12); otherwise show the plaintext-export confirmation, then one ZIP. |
| > 1000 | Refuse: "Select at most 1000 files for one archive." (`MAX_ZIP_ENTRIES = 1000`, D-2.) |

Single-file entry points (tile menu, preview modal `onDownload`) always pass one node and stay on the per-file path.

**Vault plaintext-export confirmation (D-3).** Vault ZIP only; Normal Files get no confirmation.

- A modal in `VaultDialogs.jsx` says: "This ZIP will **not** be encrypted. Anyone who gets the file can open every file inside it." It also shows the file count and total size. Buttons: **Save unencrypted ZIP** and **Cancel**. Text in en/th/zh.
- The plan is computed when the dialog opens and is held as an immutable snapshot (nodes, blob records, names, sizes). Changing the selection while the dialog is open does not alter what Confirm saves.
- **The Confirm button's `onClick` calls the orchestrator, whose first statement that awaits is `showSaveFilePicker()`.** No `await`, promise chain, state round-trip or effect may sit between the Confirm click and the picker call. Only synchronous checks are allowed first: busy ref, `isPurged()`, signal. This keeps the picker inside the Confirm click's user activation.
- On no-FSA browsers, Confirm starts the buffered path (§14), because the export is still plaintext.
- Cancel or Escape closes the dialog; nothing is fetched. A Vault lock while the dialog is open closes it, and Confirm becomes a no-op because `isPurged()` is checked synchronously.

**Busy rule.** One bulk operation per screen.

- Vault: the busy ref is set synchronously by Confirm, or by the 1–3 per-file loop. While the dialog is open, a second Download click does not open a second dialog.
- Files: gains a `downloadBusyRef`, set synchronously by the archive click. Its 1–3 anchor path stays fire-and-forget as today.
- A click while busy announces the busy message (`vaultTreeDownloadBusy`, or a new Files equivalent) and opens no picker.

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

All integers are little-endian. The archive contains only the records listed here, in this order: for each entry *(local header, payload, data descriptor)*, then all central-directory headers, then *(ZIP64 EOCD record, ZIP64 EOCD locator)* when required, then the classic EOCD.

### 7.1 Record fields

| Field | Value |
|---|---|
| Compression method | 0 (STORE) for every entry |
| General-purpose flags | `0x0808`: bit 3 (data descriptor) + bit 11 (UTF-8 names) |
| Version made by | 45, host 0 (MS-DOS) |
| Version needed to extract | **45** for every *ZIP64 entry* (§7.2), in **both** its local header and its central header, so the two never disagree. **20** for every other entry. The ZIP64 EOCD record's "version needed" is 45 |
| DOS time/date | Archive start time (local), identical for all entries. No per-file mtime in v1, so no extra metadata leaves the Vault |
| Extra fields | Only ZIP64 (`0x0001`) when required. No timestamps (UT/NTFS), no Unicode-path extra (bit 11 already marks UTF-8), no comments, no AEGIS identifiers |
| Internal/external attributes | 0 |
| Local file header (`0x04034b50`, 30 B + name + extra) | CRC = 0 and sizes = 0 (bit 3). For a **size-ZIP64** entry: both size fields = `0xFFFFFFFF` plus a local ZIP64 extra (4 B header + 8 B uncompressed + 8 B compressed, both zero). An **offset-only** ZIP64 entry has no local extra, because the local header has no offset field |
| Data descriptor | **Signed**: `0x08074b50`, CRC-32, compressed size, uncompressed size. 4-byte sizes (16 B total) normally; **8-byte sizes (24 B total) for a size-ZIP64 entry**. Offset-only entries use 4-byte sizes |
| Central directory header (`0x02014b50`, 46 B + name + extra) | Real CRC. Each of uncompressed size, compressed size and local-header offset that is `≥ 0xFFFFFFFF` is written as `0xFFFFFFFF`, and its real 64-bit value goes in the central ZIP64 extra in APPNOTE order (uncompressed, compressed, offset), **only for the fields that overflowed** |
| ZIP64 EOCD record (`0x06064b50`, 56 B) | Size-of-record field = 44, versions 45/45, disk numbers 0, entry counts (8 B), CD size (8 B), CD start offset (8 B), no extensible data |
| ZIP64 EOCD locator (`0x07064b50`, 20 B) | Disk 0, offset of the ZIP64 EOCD record (8 B), total disks 1 |
| Classic EOCD (`0x06054b50`, 22 B) | Entry counts, CD size and CD offset; each field that overflowed is set to its sentinel (`0xFFFF` for counts, `0xFFFFFFFF` for size/offset). Comment length 0 |

### 7.2 ZIP64 rules

`≥` is used everywhere so a sentinel value never appears as a real value. Every input is known **before** the entry's local header is written: sizes are authenticated (Vault, §11) or declared and checked against `Content-Length` (Files, §10), and offsets follow from the sizes.

For entry *i* with payload size `sᵢ` and local-header offset `oᵢ`:

- `sizeZ64ᵢ = sᵢ ≥ 0xFFFFFFFF`. Compressed size = uncompressed size under STORE, so both fields overflow together.
- `offZ64ᵢ = oᵢ ≥ 0xFFFFFFFF`.
- **Entry *i* is a ZIP64 entry iff `sizeZ64ᵢ OR offZ64ᵢ`.** A ZIP64 entry always has version-needed 45 (local and central) and a central ZIP64 extra.
- **Offset-only case** (`offZ64ᵢ` and not `sizeZ64ᵢ`): central offset field = `0xFFFFFFFF`, central ZIP64 extra = the 64-bit offset only (4 + 8 B), size fields hold real 32-bit values, data descriptor uses 4-byte sizes, version-needed 45.
- **ZIP64 end records** (EOCD record + locator) are written **iff** `N ≥ 0xFFFF` (unreachable under the 1000 cap, implemented anyway) **or** `cdSize ≥ 0xFFFFFFFF` **or** `cdStart ≥ 0xFFFFFFFF`. This is the only trigger.
- **Consequence:** any ZIP64 entry forces the ZIP64 end records. A size-ZIP64 entry places at least `0xFFFFFFFF` payload bytes before the central directory. An offset-only entry starts at or beyond `0xFFFFFFFF`. Either way `cdStart ≥ 0xFFFFFFFF`. A valid archive that contains a ZIP64 entry but no ZIP64 end records therefore cannot exist, and no test may require one. Whether every required reader accepts these layouts is part of the reader gate (§24).

Zero-byte entries are valid: local header, no payload, descriptor with CRC `0x00000000` and sizes 0.

### 7.3 Exact archive length

Let `nᵢ` be the UTF-8 byte length of entry *i*'s sanitised name and `[x]` = 1 if *x* is true, else 0.

```
o₀        = 0
Lᵢ        = 30 + nᵢ + 20·[sizeZ64ᵢ]                     local header + local ZIP64 extra
Dᵢ        = 16 + 8·[sizeZ64ᵢ]                           signed data descriptor
oᵢ₊₁      = oᵢ + Lᵢ + sᵢ + Dᵢ
kᵢ        = 2·[sizeZ64ᵢ] + [offZ64ᵢ]                    number of 8-byte central ZIP64 fields
Cᵢ        = 46 + nᵢ + (kᵢ > 0 ? 4 + 8·kᵢ : 0)           central header + central ZIP64 extra
cdStart   = o_N
cdSize    = Σ Cᵢ
z64End    = [N ≥ 0xFFFF  OR  cdSize ≥ 0xFFFFFFFF  OR  cdStart ≥ 0xFFFFFFFF]
total     = cdStart + cdSize + 76·z64End + 22             (76 = 56 ZIP64 EOCD + 20 locator)
```

`offZ64ᵢ` depends on `oᵢ`, which depends only on earlier entries, so the formula is computed in one forward pass. `bulkDownloadPlan.js` implements it; tests assert that `zipStreamWriter.js` output length equals it; §14 uses it for the buffered cap.

### 7.4 Reader compatibility (D-4)

AEGIS does **not** claim that any reader accepts this layout until §24 has been run. Single-pass readers (for example Java `ZipInputStream`) are known to have trouble with STORED entries that use data descriptors. v1 does **not** specify a seek-back or header-only patch fallback, because rewriting local headers alone is not assumed to fix STORED + descriptor incompatibility. If a required reader rejects the archive, implementation acceptance is BLOCKED and the record sequence and flags are redesigned as a separate compatibility correction with its own review (§24).

## 8. CRC strategy (item 9)

- Use the existing `hash-wasm` `createCRC32()` (IEEE, reflected polynomial `0xEDB88320`). No new package.
- Create the hasher **after** the picker returns. It is async (WASM init), and nothing async may run before the picker.
- Per entry: `init()`, then `update(bytes)` for every chunk **before** that chunk is written to the archive, then `digest('hex')` → parse into a uint32 → write little-endian. A zero-length `update` is allowed and leaves the CRC unchanged.
- A hasher exception counts as a write failure (§20).
- The CRC protects the archive *after* creation. It does **not** prove the source bytes are correct: source integrity comes from Vault AEAD and exact size checks (§10, §11), and the spec makes no stronger claim.

## 9. Module layout (deviations from the suggested file list)

| Path | Change | Note |
|---|---|---|
| `src/lib/zipStreamWriter.js` | NEW | Pure writer over an injected archive sink: `begin()`, `addEntry({name, size}) → entrySink`, `finish()`. Tracks offsets, ZIP64 decisions, CRC, byte counts and central-directory records. Has no knowledge of Files, the Vault or the DOM, and never calls the sink's `close`/`abort` itself; the orchestrator owns finalisation. Option `startOffset` (default 0) exists only as a unit-test seam (§23); production callers never pass it. |
| `src/lib/zipEntryNames.js` | NEW | Sanitisation and duplicate numbering (§5). |
| `src/lib/bulkDownloadPlan.js` | NEW | Synchronous, pure: filter, threshold (`ZIP_THRESHOLD = 4`), `MAX_ZIP_ENTRIES = 1000`, V1 refusal (§12), totals, exact archive length (§7.3), FSA/buffered/per-file decision, feature switch `BULK_ZIP_ENABLED` (§25). |
| `src/lib/bulkZipDownload.js` | **NEW (deviation)** | One orchestrator for the phase machine (picker → pre-flight → writable → entries → finish → close, or abort), progress, cancel, lock, with two **source adapters**: `filesEntrySource` and `vaultV2EntrySource`. This keeps the security-critical ordering in one tested place instead of copying it into two screens. |
| `src/lib/api.js` | **MOD (deviation)** | Add `apiFetchStream(path, { signal })`. Same `credentials: 'include'`, base URL, and 401/403 handling as `apiFetchBytes`, but returns `{ ok, status, errorKind, headers, body }` without reading the body. Timeout and cleanup are owned by the Files adapter (§10). |
| `src/lib/vaultChunkedDownload.js` | MOD | Extract `authenticateVaultV2Entry({ kek, blob }) → { ok:true, plainSize } \| { ok:false, reason:'wrong-key' }` from `prepareVaultV2Download`. `prepareVaultV2Download` calls it, a behaviour-preserving refactor, and the #334 tests must stay green. `downloadVaultV2` is unchanged. |
| `src/screens/VaultTreeScreen.jsx` | MOD | `startBulkDownload`: plan; `n ≤ 3` keeps the current loop; `n ≥ 4` opens the confirmation, whose Confirm calls the orchestrator with the shared busy ref, controller and `registerAbort`. |
| `src/components/vault/VaultDialogs.jsx` | MOD | Plaintext-export confirmation dialog (D-3). |
| `src/screens/Files.jsx` | MOD | Bulk handler: plan; `n ≤ 3` keeps the current anchors; `n ≥ 4` calls the orchestrator directly from the click. Adds a busy ref and renders the transfer panel. |
| `src/components/vault/VaultTransferPanel.jsx` | MOD | Add stages `archiving` (vars `{ index, count, name }`) and `finalizing`, and reasons `localDiskFull`, `finalizeFailed`. **Not moved**; Files imports it from `components/vault/` to keep the diff minimal. A rename to a neutral path is a later cleanup. |
| `src/lib/strings.js` | MOD | en/th/zh keys: archiving and finalizing labels, folders skipped, unavailable, too many files, V1 not supported in bulk ZIP, plaintext-export confirmation text and buttons, local disk full, finalize failed, Files busy, Files no-FSA fallback notice. |
| `tests/…`, `tests/fixtures/vaultScreenBackend.js` | NEW/MOD | §23. |
| Obsidian receipt + `idea1/idea1-status.md` | at closeout | Exactly one receipt for the implementation task. |
| `server/**`, `gateway/**`, `package.json`, lockfile, `Vault.jsx`, `VaultTreeRollback` | **unchanged** | — |

## 10. Normal Files streaming path (item 10)

The adapter `filesEntrySource.open(entry, archiveSignal)` creates a **per-entry `AbortController`** (`fetchCtrl`) linked to the archive signal, then works as follows.

**Single cleanup routine.** `cleanup(reason)` is idempotent and is the **only** exit for every Files-entry failure. It runs **synchronously up to step 4** and never awaits `reader.cancel()`:

1. If **this entry's** cleanup has already run, return; this is the only early return and makes the routine idempotent. Otherwise mark the entry failed and mark the archive failed. Marking the archive is a no-op if it is already failed, for example when Cancel or lock reached the orchestrator first, and **never** skips steps 2–4. From this point the orchestrator cannot start another entry, call `close()`, or report success, whatever happens in steps 4–5.
2. Clear the source-idle timer.
3. `fetchCtrl.abort(reason)` **immediately**. This is a no-op if the fetch already settled. The fetch abort never waits for, or depends on, the reader.
4. If a reader exists: call `reader.cancel(reason)` as **best-effort** cleanup, **without awaiting it**. A rejection is swallowed with `.catch(() => {})`. A never-settling `cancel()` has no effect on the outcome.
5. Return the failure to the orchestrator, which runs the pre-close abort rule (§20). The orchestrator never awaits the `reader.cancel()` promise.

`cleanup` runs on every one of these: explicit Cancel, Vault lock (not applicable to Normal Files, but the shared orchestrator path is the same), idle timeout, network error, non-2xx, `body === null`, invalid or mismatched `Content-Length`, early EOF, overlong stream, archive write failure, hasher failure, and any other archive failure raised while this entry is open.

**Steps:**

1. **Arm the source-idle timer (60 s)**, then await `apiFetchStream('/api/files/:id/download', { signal: fetchCtrl.signal })`. Same route, cookie, owner check and audit as today. When the response (headers) arrives, **clear** the timer. If it fires first, `cleanup('timeout')`, which aborts the fetch.
2. Network error → `network`; 401 → `unauthorized` (existing session handling); 403 → `forbidden`; any other non-2xx → `server`. Each calls `cleanup`.
3. `response.body === null` → `stream-missing`, `cleanup`.
4. **Content-Length policy (one rule, no exceptions):** the header is **required**.
   - Missing → `invalid-length`.
   - Present but not matching `/^[0-9]+$/` after trimming, or `Number(value)` not a safe integer, or negative → `invalid-length`.
   - Valid but ≠ the planned `file.size` from the listing → `size-mismatch` (the file changed after the listing).
   - All three are checked **before** `writer.addEntry`, so the failing entry's local header is never written. Each calls `cleanup`.
   - Rationale: the route always sets it (§2), and the repository gateway/server apply no compression. Its absence means an unexpected intermediary, so the entry fails closed.
5. `writer.addEntry({ name, size: file.size })` writes the local header. Acquire `reader = body.getReader()`.
6. **Stream loop.** Each iteration:
   1. **Arm** the source-idle timer if it is not already armed (see the zero-length rule below), then `await reader.read()`.
   2. `done === true` → clear the timer, then go to step 7.
   3. `value.length === 0` (not done) → this is **not** payload progress. Leave the timer armed with its **existing deadline**, neither reset nor extended, and loop back to 6.1. A source that keeps returning empty reads therefore still times out 60 s after its last positive payload.
   4. `value.length > 0` → **immediately**, before any archive work:
      - record payload progress: `received += value.length`;
      - **clear** the source-idle timer.
   5. If `received > file.size` → `overlong`, `cleanup`. None of that `value` is written.
   6. CRC update, then `await entrySink.write(value)`, then drop the reference. **No source-idle timer is running during this write**, so a slow disk or slow sink never spends the network idle budget. A write that fails or stalls is handled by the archive failure rules (§19, §20) and by Cancel.
   7. Check the archive signal, then loop back to 6.1, which arms a **fresh** 60 s window for the next read.
7. On `done`: `received === file.size` is required, otherwise `early-eof`, `cleanup`. On success, release the reader; the writer emits the data descriptor.

**Source-idle timeout policy:** **60 seconds without incoming payload progress from the source.** It measures source/fetch idleness only, never destination write time.

- The timer runs only while AEGIS is waiting on the network: for the response headers (step 1) and for each `reader.read()` (step 6.1).
- It is cleared as soon as a positive-length chunk arrives (step 6.4), **before** the sink write, and re-armed fresh only after that write completes.
- Zero-length non-done reads keep the existing deadline (step 6.3).
- On expiry, `cleanup('timeout')` aborts the fetch immediately and best-effort cancels the reader. The entry and archive fail as `timeout`, and no next entry starts.
- There is **no total-transfer-duration timeout**, so large files on slow links are not killed while payload is arriving.

The browser chooses the read size. Backpressure comes from awaiting each `writable.write`.

## 11. Vault V2 streaming and decryption path (item 11)

**Pre-flight (after the picker, before `createWritable`)**, for each planned entry in order:

- `authenticateVaultV2Entry({ kek, blob })` unwraps the DEK and decrypts metadata with its own AAD. It reads only the in-memory blob record (`wrappedDekB64`, `wrapIvB64`, `metaB64`, `metaIvB64`), so pre-flight performs no network fetch.
- `meta.plainSize` must be a safe non-negative integer. If the manifest supplies `node.plainSize`, it must equal `meta.plainSize`, otherwise fail `integrity`.
- The DEK is **not retained** across entries, so no array of keys accumulates.
- `signal`/`isPurged()` is checked between entries.
- After pre-flight: recompute totals, ZIP64 flags and the exact archive length (§7.3) from the **authenticated** sizes. Re-check the buffered cap on the no-FSA path.
- Any failure here means `createWritable()` is never called, so not one byte of any entry reaches the writable. This extends #334's invariant to the whole archive.

**Entry streaming** (after `createWritable`), for each entry:

1. `writer.addEntry({ name, size })` writes the local header and returns an **entry sub-sink**:
   - `write(bytes)`: CRC update, then archive write, then byte count. Zero-length writes are accepted (CRC unchanged, nothing written).
   - `close()`: marks the entry as data-complete and does **not** close the archive.
   - `abort()`: no-op on the archive. The orchestrator owns the single archive abort attempt (§20).
2. `downloadVaultV2({ kek, blob, sink: entrySink, signal, onProgress })`. It re-unwraps the DEK and re-authenticates metadata against the **same in-memory `blob` object** used in pre-flight, so there is no server re-fetch in between. It also enforces per-chunk AEAD, per-chunk length, total `size-mismatch`, and the abort check before close. Only authenticated plaintext ever reaches `entrySink.write`.
3. `res.ok === false` → archive failure with reason `res.reason` (`auth-failed`, `chunk-size-mismatch`, `size-mismatch`, `network`, `fetch`, `missing-iv`, `cancelled`, …). No later entry starts.
4. `res.bytesWritten` must equal the pre-flight size. The writer then writes the data descriptor and records the central entry.

**Zero-byte V2 entry:** the blob has exactly one chunk, a 16-byte tag-only AES-GCM message (`planVaultChunks`). `downloadVaultV2` still fetches and **authenticates** that chunk, gets 0 bytes of plaintext (matching `plaintextRangeFor(0, 0, …)`), and calls `entrySink.write` with an empty array. The ZIP entry has payload 0, CRC `0x00000000` and sizes 0.

## 12. Vault V1 behaviour (item 12, D-1)

V1 blobs (`blobRef.formatVersion !== 2`) can only be fetched and decrypted as a whole buffer, which breaks the "no whole-file buffering on the FSA path" invariant.

**Decision D-1: V1 is out of ZIP v1.** If a 4+ Vault selection contains **any** V1 entry, the plan refuses **before the confirmation and the picker**. `formatVersion` is known synchronously from the manifest. The message is "Older-format Vault files can't be included in a bulk ZIP. Download them individually (up to 3 at a time), or remove them from the selection." Nothing is fetched.

The 1–3 file path keeps today's V1 individual download behaviour unchanged.

## 13. File System Access path (item 13)

When `supportsStreamingFileSink()` is true:

1. The click handler (Files) or Confirm handler (Vault, §4) computes or reuses the plan **synchronously**: O(n) pure work over at most 1000 items, with no crypto and no I/O.
2. The first `await` is `showSaveFilePicker({ suggestedName, types })`, so there is exactly one picker per archive.
3. Picker `AbortError` → silent return (`cancelled`), nothing fetched. Any other picker error → `picker` failure, nothing fetched.
4. CRC hasher init, then pre-flight (Vault only, §11), then `createWritable()`. A failure there is reported as `destination`.
5. Entries are streamed sequentially (`maxInFlight` = 1, one entry at a time), then `finish()` writes the central directory and end records, then the final `signal`/`isPurged()` check, then `writable.close()` (§20).

## 14. No-FSA fallback (item 14)

When `showSaveFilePicker` is absent (for example Firefox or Safari):

| Source | Exact archive length (§7.3) ≤ 64 MiB | > 64 MiB |
|---|---|---|
| Files | Buffered ZIP: archive sink = `createBufferedSink({ limitBytes: 64 MiB })`, then `Blob([...], { type: 'application/zip' })`, then an anchor download, then `revokeObjectURL` after 10 s | **Per-file fallback**: today's anchors, one per file, with a visible notice that this browser cannot save large archives. No buffering. |
| Vault | After the confirmation: same buffered ZIP. Object URL registered with `unlockedState.registerObjectUrl` so a lock revokes it | **Refuse** with the existing too-large message. Nothing fetched, no per-file loop. |

- The decision first uses the plan's exact length: Files sizes from the listing, Vault sizes from `node.plainSize` or `estimatedPlainSize(blob)`.
- The Vault re-checks after pre-flight using authenticated sizes.
- The buffered sink's own hard limit is the backstop: any overrun throws `BUFFER_LIMIT`, the archive fails, and the parts are discarded.
- **64 MiB is an archive-size / buffer-policy cap.** It is **not** a guarantee that browser process memory stays under 64 MiB. The buffered parts, the in-flight chunk (Vault: ciphertext + plaintext + WebCrypto copies), and the `Blob` construction (which may copy) can coexist briefly. See §15.

## 15. Memory model (item 15)

AEGIS bounds what **its own code** retains. Exact process peak RAM is browser-dependent, and this spec publishes no exact peak-RAM guarantee.

| Path | What AEGIS code holds at most | Transient extras outside AEGIS control |
|---|---|---|
| FSA, Vault | One entry in flight. For that entry: one ciphertext chunk (fetched whole via `apiFetchBytes`) and its plaintext (WebCrypto output). The chunk size is that blob's own recorded size: **default 32 MiB plaintext, up to 64 MiB** where configured. The ciphertext reference is dropped after decrypt and the plaintext after the write | WebCrypto input/output copies, fetch/network buffers, and the writable's internal queue. A 64 MiB chunk may therefore briefly need **materially more than 64 MiB**, plausibly more than 128 MiB |
| FSA, Files | One `ReadableStream` read (browser-chosen size) | Network and stream buffers, writable queue |
| Central directory (both) | ≤ 1000 × (46 + 255 + 28) B ≈ 330 KB of records, held until `finish()`, bounded separately from payload memory by `MAX_ZIP_ENTRIES` | — |
| No-FSA | Buffered archive ≤ 64 MiB (policy cap) plus one in-flight chunk | `Blob` construction copies, WebCrypto copies |

The guarantee is structural. On the FSA path, memory is **O(chunk)**, independent of file size and archive size, and there is no whole-file or whole-archive buffering. A source-guard test forbids `arrayBuffer()`, `apiFetchBytes` and `new Blob(` in `zipStreamWriter.js`, `bulkZipDownload.js` and the Files adapter, except in the buffered-fallback finaliser, which is explicitly allow-listed. The Vault adapter reaches `apiFetchBytes` only through `downloadVaultV2`, one chunk at a time. Acceptance item A11 (§24) measures that peak growth does not scale with file size; it does not certify an absolute number.

## 16. Progress semantics (item 16)

- One archive-level state: `{ kind: 'download', stage, index, count, name, transferredBytes, totalBytes, percent, rate }`, with `stage` ∈ `preparing` → `archiving` → `finalizing`.
- `totalBytes` is the sum of entry payload sizes, in the same plaintext units the user sees on tiles; ZIP overhead is excluded from the displayed total.
- `transferredBytes` is the payload bytes written so far, across entries.
- `percent = floor(transferred / total × 1000) / 10`, never decreasing, and **capped at 99.9 until `close()` resolves**. Then 100 and the panel clears, as with today's success.
- Total 0 (all zero-byte files) shows 0, then 100 on a successful close.
- `index`/`count`/`name` show "File i of N: name".
- Rate and ETA come from the existing `createRateEstimator` sampled on archive bytes.
- No timer-driven movement (the existing `VaultTransferPanel` rule).
- No progress before the picker returns. During pre-flight the stage is `preparing`; while `close()` is pending it is `finalizing` (§20).

## 17. Cancel semantics (item 17)

- One `AbortController` per archive, registered via `unlockedState.registerAbort` (Vault), linked to every entry fetch controller, passed to `downloadVaultV2`, and checked between chunks, between entries, and immediately before `close()`.
- **Before `close()` begins:** the panel's Cancel aborts it. The current entry's cleanup runs (§10 for Files, `downloadVaultV2`'s own abort for the Vault), no later entry starts, one `writable.abort()` attempt is made (buffered: parts discarded), and the result is "cancelled" rather than "failed".
- **Once `close()` has begun** (stage `finalizing`): the Cancel button is disabled, because cancellation can no longer be guaranteed to stop the browser from committing the file. See §20.
- Cancel during pre-flight → `createWritable` is never called.
- Picker cancelled, or the Vault confirmation cancelled → nothing fetched.

## 18. Lock semantics (item 18)

- **Before `close()` begins:** locking the Vault calls the registered controller's abort, with the same result as Cancel. `isPurged()` is also checked between entries and before `close()`, which covers a lock with no signal observer.
- **While `close()` is pending:** the lock still purges keys and in-memory state immediately, but AEGIS cannot guarantee the browser won't commit the already-written plaintext archive. The outcome is reported as whatever `close()` returns, under §20's commit caveat.
- Buffered parts are discarded and any already-created object URL is revoked by the existing `registerObjectUrl` purge.
- No DEK is retained across entries.

## 19. Disk and quota errors (item 19)

- A `QuotaExceededError` (a `DOMException` with that name) from `writable.write` → archive failure with reason `localDiskFull` and a new message: "There isn't enough free space on this device to save the archive." The same error from `writable.close()` also maps to `localDiskFull`, under §20's close-rejection rule.
- The existing `vaultXferReasonNoSpace` (Data Lake) is **not** reused.
- There is no pre-check: `navigator.storage.estimate()` reports origin quota, not free space on the user's disk.

## 20. Finalisation and failure guarantees (item 20)

AEGIS guarantees **logical** archive success and keeps it separate from what the filesystem does.

- **LOGICAL_ARCHIVE_SUCCESS** (guaranteed by AEGIS): reported **only** when all of the following hold:
  - every entry completed with bytes = authenticated or declared size;
  - every Vault chunk passed AEAD;
  - every CRC was computed;
  - the central directory and end records were written;
  - the signal was not aborted and `isPurged()` was false immediately before `close()`;
  - `writable.close()` **resolved**.

  Buffered path: logical success means the `Blob` was built and the anchor download was triggered. Whether the browser then saves it is outside AEGIS.
- **FILESYSTEM_COMMIT_GUARANTEE** (**not** provided by AEGIS): whether the destination ends up absent, empty, or partially or fully committed after a failure is decided by the browser and OS. The picker may create an empty placeholder at the chosen path. Chromium writes through a swap file that `abort()` is expected to discard, but this spec does not claim it; it is recorded in the acceptance matrix. AEGIS never auto-deletes the destination, because the user may have chosen to overwrite an existing file.

**Phase rules:**

1. **Before `close()` begins:** any failure or Cancel/lock leads to **one** `writable.abort()` attempt, with any rejection swallowed, and `close()` is **never** called. Failures in this phase: network, non-2xx, `stream-missing`, `invalid-length`, `size-mismatch`, `early-eof`, `overlong`, idle timeout, AEAD/`auth-failed`, `chunk-size-mismatch`, `integrity`, hasher or write error, `localDiskFull`, lock, Cancel.
2. **Once `close()` has begun:** cancellation and lock cannot be guaranteed to prevent completion or commit. Cancel is disabled (§17).
3. **If `close()` rejects:** make **at most one** best-effort `abort()` attempt, only if no abort was attempted before and the writable still allows it, with any rejection swallowed. Report failure (`localDiskFull` for quota, otherwise `finalizeFailed`) with the message "The archive could not be completed. The file at the destination may be missing, empty, or incomplete. Don't use it." AEGIS does **not** claim the destination was rolled back.
4. An entry failure fails the **whole** archive. There is no skip-and-continue, because a ZIP silently missing a file would look complete. The panel names the failed entry and the reason category.

## 21. Security and privacy model (item 21)

- Vault plaintext and keys never leave the tab. The server sees only the per-chunk ciphertext GETs it already serves.
- AAD is still built in the browser (unchanged `downloadVaultV2`). Envelope authentication covers every entry before any output (§11), including zero-byte entries.
- Entry names come from the manifest (TS-13). No envelope metadata, mtime, owner, id or AEGIS marker is written into the archive.
- The archive is **unencrypted**, the same as today's individual Vault download. It bundles many files, so Vault ZIP requires the **explicit plaintext-export confirmation** (§4, D-3).
- Name sanitisation removes path separators, so zip-slip is impossible on extraction.
- No authorisation or RBAC moves to the client. Normal Files ownership is still enforced per request on the server.
- No token or key touches browser storage. Cookies, CSRF and the CSP are unchanged.

## 22. Audit behaviour (item 22)

Unchanged and truthful:

- Normal Files: one `FILE_DOWNLOAD` row per fetched file, plus `DENIED` rows from the existing route.
- Vault: one `VAULT_V2_READ` row per entry, written at chunk 0.

The server cannot tell an archive download from individual downloads, and that is accepted for v1. If an archive fails after some entries were fetched, their audit rows remain, because those bytes were sent. No new audit event is added.

## 23. Tests required under strict TDD (item 23)

Each test is written RED first. RED evidence is recorded against base `912b1800`, using Node's built-in runner with real WebCrypto and the existing fixtures.

**`tests/zipStreamWriter.test.js`** (pure, with an in-test central-directory parser and extractor):

- CRC vector `"123456789"` → `0xCBF43926`; empty → `0`.
- Byte-exact round-trip of entries, including a 0-byte entry (CRC 0, sizes 0, 16-byte descriptor).
- Flags `0x0808`, method 0, signed data descriptor present, local CRC/sizes zero, version-needed 20 for ordinary entries.
- Thai, CJK and emoji names round-trip as UTF-8 with bit 11 set.
**Test seams (unit tests only, never used by production callers):**

- A **counting sink** records the byte count and only the bytes the test asks to keep. Typically that means the regions from each local header up to the start of its payload, and from the central directory onwards. Payload bytes are counted and discarded.
- A **synthetic payload source** yields one reused zero-filled buffer of ≤ 1 MiB until the declared size is reached.
- A writer option **`startOffset`** (default 0) sets the logical position of the first byte. A test can then place a small entry's local header at or beyond `0xFFFFFFFF` without writing 4 GiB.

Together these validate the encoding rules without allocating or storing more than about 1 MiB. Real-size layouts are proven by A5/A6 (§24).

- **Case A, size-ZIP64:** an entry whose declared and streamed size is exactly `0xFFFFFFFF` (counting sink + synthetic source; real CRC over the streamed bytes):
  - its local header has both size fields `0xFFFFFFFF`, a local ZIP64 extra, and version-needed 45;
  - its data descriptor is 24 bytes with 8-byte sizes;
  - its central header has size fields `0xFFFFFFFF`, a central ZIP64 extra with uncompressed and compressed size, and version-needed 45;
  - because `cdStart ≥ 0xFFFFFFFF` follows necessarily (§7.2), the ZIP64 EOCD record + locator **are present** and the classic EOCD offset field is `0xFFFFFFFF`.

  The same test with size `0xFFFFFFFE` yields a non-ZIP64 entry (classic fields, 16-byte descriptor, version-needed 20). Its ZIP64 end records are present or absent strictly according to the §7.2 trigger evaluated on the resulting `cdStart`/`cdSize`, which the test computes and asserts.
- **Case B, offset-only ZIP64:** a **small** entry (for example 5 bytes) written with `startOffset` chosen so its local-header offset is `≥ 0xFFFFFFFF`:
  - its compressed and uncompressed sizes are real classic 32-bit values;
  - its local header has no ZIP64 extra and has version-needed 45;
  - its data descriptor is 16 bytes with 4-byte sizes;
  - its central offset field is `0xFFFFFFFF`, and its central ZIP64 extra contains **only** the 64-bit local-header offset, equal to the true offset;
  - its central version-needed is 45;
  - the archive-level ZIP64 EOCD + locator are present (forced by `cdStart`, §7.2), which is valid and asserted.

  The same small entry at `startOffset = 0xFFFFFFFE − (bytes before it)` (local header at offset `0xFFFFFFFE`) is not ZIP64: classic offset, no central extra, version-needed 20.
- **Archive-level trigger:** ZIP64 EOCD record + locator are present iff `N ≥ 0xFFFF`, `cdSize ≥ 0xFFFFFFFF` or `cdStart ≥ 0xFFFFFFFF`, each checked at its boundary (`0xFFFFFFFE` vs `0xFFFFFFFF`) with `startOffset`. Classic EOCD sentinels are set only for the fields that overflowed. **No test requires a ZIP64 entry without ZIP64 end records**, because that layout is impossible (§7.2).
- Output length (logical, from the counting sink) equals §7.3's formula for: ordinary entries, a 0-byte entry, Case A, Case B, and a `cdStart`-triggered case.
- `write` beyond the declared size throws; `finish()` with an incomplete entry throws; the writer never calls the sink's `close`/`abort`.

**`tests/zipEntryNames.test.js`:**

- `../x`, `a/b\c`, `CON`, `con.txt`, `name.`, `  x  `, controls, `''`.
- A 300-byte Thai name keeps its extension and stays ≤ 255 bytes.
- `A.txt`/`a.txt` → `a (2).txt`; triple duplicates; a pre-existing `x (2).txt` collision; `.env` duplicates; NFC/NFD forms collide.

**`tests/bulkDownloadPlan.test.js`:**

- 1, 2, 3 files → per-file; 4 → ZIP; 1000 → ZIP; 1001 → refused before the picker.
- 3 files + 2 folders → per-file with skipped count 2.
- 4 files + 1 folder → ZIP with skipped count 1.
- Unresolvable ids are counted.
- **D-1:** 4+ Vault entries including one V1 → refused (V1 bulk ZIP not supported). 3 entries including V1 → per-file, unchanged.
- No-FSA: exact length ≤ 64 MiB → buffered; above that, Files → per-file and Vault → too-large.
- Exact-length function matches §7.3 on fixed vectors.
- `BULK_ZIP_ENABLED=false` → per-file for every `n`.

**`tests/bulkZipVault.test.js`** (orchestrator + `vaultV2EntrySource`, real crypto, `vaultScreenBackend` fixture):

- **D-3:**
  - The confirmation opens for 4+ Vault files.
  - Confirm's `onClick` reaches `showSaveFilePicker` with **no intervening await or microtask**: the picker spy is called synchronously within the Confirm handler, exactly once for N = 5.
  - Cancelling the dialog → zero fetches, no picker.
  - Lock while the dialog is open → Confirm is a no-op.
  - Normal Files show no dialog.
- Picker cancelled → zero fetches.
- A bad envelope on entry 3 → `createWritable` is never called.
- Manifest `plainSize` ≠ `meta.plainSize` → `integrity`, no writable.
- **Zero-byte V2 entry:**
  - metadata authenticates;
  - its single tag-only chunk is fetched and AEAD-verified, and a tampered tag makes the archive fail;
  - the extracted entry is exactly 0 bytes with CRC `0x00000000`;
  - the archive parses as valid.
- A tampered chunk mid-entry → one abort attempt, `close` never, failed name reported, next entry not fetched.
- Lock during pre-flight, mid-entry, and after the last entry before close → abort, no close.
- Cancel → no later entry fetched; Cancel disabled once `close()` has begun.
- `close()` rejects → at most one abort attempt, `finalizeFailed` reported, no success state.
- `close()` rejects with `QuotaExceededError` → `localDiskFull`.
- `QuotaExceededError` on write → `localDiskFull`, abort, no close.
- Strict fetch/write alternation.
- Progress is monotonic, ≤ 99.9 before close and 100 only after close resolves.
- Extracted bytes equal the sources (SHA-256).
- Busy: a second click announces and opens no second dialog or picker.
- No DEK array retained (spy on unwrap count = 2 × entries).

**`tests/bulkZipFiles.test.js`** (orchestrator + `filesEntrySource` with a stubbed `fetch` `ReadableStream` and fake timers):

- Streamed with no `arrayBuffer` call.
- **SOURCE-IDLE-TIMEOUT:**
  - (a) No response headers for 60 s.
  - (b) Headers arrive, then `reader.read()` produces no positive payload for 60 s.
  - (c) The reader returns only zero-length non-done reads for 60 s after its last positive chunk; these must not extend the deadline.

  Each case requires: `fetchCtrl.signal.aborted === true`, `reader.cancel` invoked when a reader exists, one archive abort attempt, no `close`, a `timeout` failure, and the next entry's fetch **never issued**. A control case, 59 s → 1 byte → 59 s, does **not** time out.
- **SLOW-SINK-TIMEOUT:**
  - The source delivers a positive chunk 30 s into its idle window.
  - The archive sink's `write` for that chunk is held for 90 s.
  - The source-idle timeout **does not fire** during the held write.
  - After the write resolves, the next `reader.read()` gets a **fresh** 60 s window: a next chunk at +59 s succeeds, and in a variant no chunk within 60 s triggers `timeout`.
- **STALLED-READER-CANCEL (cleanup order):**
  - `reader.cancel()` returns a never-settling promise (and, in a variant, a delayed rejection).
  - On any failure (for example `overlong`), `fetchCtrl.signal.aborted` is `true` **synchronously** within `cleanup`, before `reader.cancel` is even called, verified by call-order spies.
  - The archive is marked failed, one abort attempt is made, `close` is never called, the next entry's fetch is never issued, and no success state is reported, even though `cancel()` never settles.
- Each of the following ends in `fetchCtrl.abort` called (before `reader.cancel`), `reader.cancel` called when a reader exists, one archive abort attempt, no `close`, and the next entry's fetch **never issued**:
  - Cancel;
  - network error;
  - non-2xx;
  - 401;
  - `body === null`;
  - `Content-Length` missing;
  - `Content-Length` non-numeric (`"12a"`, `""`), negative (`"-1"`), or unsafe (`"9007199254740993"`);
  - `Content-Length` ≠ planned size (and the failing entry's local header is not written);
  - early EOF;
  - overlong stream (the excess bytes are not written);
  - archive write failure;
  - hasher failure.
- 1–3 files → anchors only, unchanged.
- No-FSA > 64 MiB → per-file anchors plus the notice.

**`tests/vaultDownloadPickerFirst.test.js`** (existing #334 suite): stays green after the `authenticateVaultV2Entry` extraction.

**Source guard:** no `arrayBuffer(`/`apiFetchBytes`/`new Blob(` outside the allow-listed fallback finaliser; no await before `showSaveFilePicker` in the Files click path or the Vault Confirm path.

**i18n:** every new key is present in en/th/zh (existing i18n tests).

**Regression:** run `tests/(vault|preview|i18n|workspace|transfer|files)*.test.js`; the failing-name diff against base must be 0 new. `npx vite build` and `node scripts/validate-vault.mjs` must pass.

## 24. Real-browser and reader acceptance (item 24)

Run against a non-Production instance only. Every cell must record its result; an untested cell stays `NOT RUN`, never `PASS`.

| # | Scenario | Chrome/Edge Win (FSA) | Chrome macOS (FSA) | Firefox (no FSA) | Safari macOS (no FSA) |
|---|---|---|---|---|---|
| A1 | 3 files (incl. a V1 Vault file) → 3 per-file downloads, unchanged | ✓ | ✓ | ✓ | ✓ |
| A2 | 4 small files → exactly 1 picker, 1 ZIP (Vault: confirmation first, picker opens from Confirm) | ✓ | ✓ | buffered ZIP | buffered ZIP |
| A3 | 0-byte (Files and Vault), Thai/CJK/emoji, duplicate and reserved names | ✓ | ✓ | ✓ | ✓ |
| A4 | Folder in the selection → skipped notice | ✓ | ✓ | ✓ | ✓ |
| A5 | Vault: single entry ≥ 4.1 GiB (size-ZIP64) plus 3 small | ✓ | ✓ | refused (too large) | refused |
| A6 | Files, **offset-only ZIP64 fixture** (defined below): large preceding entries, then a small final entry whose local header starts at ≥ `0xFFFFFFFF` | ✓ | ✓ | per-file fallback | per-file fallback |
| A7 | Cancel mid-entry 2 → no success reported; record destination state | ✓ | ✓ | ✓ | ✓ |
| A8 | Lock Vault mid-archive → abort; record destination state | ✓ | ✓ | ✓ | ✓ |
| A9 | Disk full (small VHD/USB target) → `localDiskFull`, no success; record destination state | ✓ | ✓ | — | — |
| A10 | Network drop mid-entry → failure, next entry not started | ✓ | ✓ | ✓ | ✓ |
| A11 | Tab memory: peak growth during a 1 GiB and a 5 GiB entry differs by < 64 MiB (not proportional to size), recorded with the blob's chunk size | ✓ | ✓ | — | — |
| A12 | V1 in a 4+ Vault selection → refused before the confirmation | ✓ | ✓ | ✓ | ✓ |

**A6 offset-only ZIP64 fixture.** A real archive produced by the app, with:

1. Preceding Normal Files entries, each individually `< 0xFFFFFFFF` bytes so none is size-ZIP64, whose total advances the writer position **beyond `0xFFFFFFFF`**. For example, four files of about 1.1 GiB each, so the fourth entry ends past 4 GiB.
2. **Then** a small final file (for example 1 KiB) whose **local header begins at an offset ≥ `0xFFFFFFFF`**.

A6 passes only if inspection of **that specific small entry** proves all of the following. Inspect it with Python `zipfile` (`ZipInfo.header_offset`, `ZipInfo.extra`) plus a raw byte dump of its central record:

- its local-header offset is `≥ 0xFFFFFFFF`;
- its compressed and uncompressed sizes are `< 0xFFFFFFFF`, and its central size fields hold those real values;
- its central relative-offset field is `0xFFFFFFFF`, and its central ZIP64 extra (`0x0001`) contains **only** the 64-bit offset (data size 8);
- its version-needed is 45;
- it extracts byte-exact (SHA-256) in every required reader.

Total archive size above 4.1 GiB on its own is **not** accepted as proof of offset-only ZIP64.

### Reader compatibility gate (BLOCKING for release)

Test archives:

- (R1) the A2 archive including a 0-byte entry;
- (R2) the A5 size-ZIP64 archive;
- (R3) the A6 offset-only ZIP64 fixture, after its small final entry passes the inspection above.

| Reader | Status | Pass criterion |
|---|---|---|
| Windows Explorer (Windows 11 built-in extract) | **REQUIRED** | R1–R3 extract without error; SHA-256 of every extracted file equals the source |
| macOS Archive Utility | **REQUIRED** | Same |
| Python `zipfile` (`testzip()` returns `None`, then `extractall`) | **REQUIRED** | Same |
| 7-Zip | Optional, recorded | Same |

AEGIS makes **no** compatibility claim before this gate is run. If **any required reader** rejects or mis-extracts any of R1–R3, then **IMPLEMENTATION ACCEPTANCE = BLOCKED** until the ZIP record layout (sequence and flags) is redesigned and re-reviewed as a separate compatibility correction (D-4). No seek-back or header-only patch is pre-approved.

## 25. Rollback strategy (item 25)

- Client-only change: no server route, schema, data, Vault format or persisted state changes. Rollback is a revert of the implementation PR.
- In addition, `BULK_ZIP_ENABLED` (an exported constant in `bulkDownloadPlan.js`, default `true` after acceptance) set to `false` restores today's per-file behaviour for every `n` with a one-line change.
- Archives already saved by users stay standard ZIP files; nothing references them.
- The `authenticateVaultV2Entry` extraction is behaviour-preserving and covered by the #334 suite, so it is safe to keep or revert.

## 26. Out of scope (item 26)

Compression (DEFLATE) and its optimisation; parallel or bounded-concurrency tuning; recursive folder ZIP and directory entries; a server-side ZIP endpoint; changes to transfer throughput or chunk size; V1 entries in bulk ZIP; seek-back or header-patch ZIP variants; D-1 Preview; Trash; legacy `Vault.jsx`, `VaultTreeRollback` and share links; encrypted (password) ZIP; per-file mtime preservation; resumable archives; Production deployment.

## 27. Human decisions (resolved)

| ID | Decision (Human Owner) | Applied in |
|---|---|---|
| **D-1** | **V1 out of ZIP v1.** A 4+ selection containing any V1 Vault entry is refused before the confirmation/picker with an explanation; 1–3 V1 individual download is unchanged | §4, §12, §23, §24 A1/A12 |
| **D-2** | **Keep `MAX_ZIP_ENTRIES = 1000`.** More than 1000 is refused before the picker. This is a safety and capacity bound, revisited only after real pre-flight and benchmark evidence | §4, §9, §15, §23 |
| **D-3** | **Explicit Vault plaintext-export confirmation.** Vault ZIP only; Confirm's click directly calls `showSaveFilePicker()` with no await in between; Normal Files have no such confirmation | §4, §13, §21, §23, §24 A2 |
| **D-4** | **No seek-back fallback in the v1 design.** Reader compatibility is a blocking acceptance gate; a required-reader failure stops acceptance and triggers a separate record-layout redesign and re-review | §7.4, §24, §26 |

No open Human decisions remain in this spec.

## 28. Revision log

- **Revision 1** (`59c19560`): initial proposal.
- **Revision 2:** applied D-1 to D-4, and Codex corrections:
  1. ZIP64 offset-only rule and version-needed 45 for every ZIP64 entry, with a test;
  2. Vault chunk facts corrected (default 32 MiB, up to 64 MiB) and the memory model restated without a peak-RAM guarantee;
  3. single Files cleanup routine, mandatory `Content-Length` policy, 60 s idle-timeout policy;
  4. finalisation model separates LOGICAL_ARCHIVE_SUCCESS from FILESYSTEM_COMMIT_GUARANTEE, with close-rejection semantics;
  5. exact archive-length formula and explicit ZIP64 end-record trigger;
  6. zero-byte Vault V2 test;
  7. blocking reader gate (Windows Explorer, macOS Archive Utility, Python `zipfile`; 7-Zip optional).
- **Revision 3** (final Codex blocker correction; no new Human decision):
  1. Removed the impossible test that expected a size-ZIP64 entry without ZIP64 end records. §7.2 now states that any ZIP64 entry forces `cdStart ≥ 0xFFFFFFFF` and therefore the ZIP64 end records. The size-ZIP64 (Case A) and offset-only (Case B) tests are separate, with `startOffset`/counting-sink test seams (§23).
  2. A6 now requires a real offset-only fixture: large preceding entries, then a small final entry whose local header starts at ≥ `0xFFFFFFFF`. Acceptance inspects that entry's central record (§24).
  3. The 60 s timer now measures source idleness only. It is armed while awaiting headers or `reader.read()`, cleared on positive payload **before** the sink write, and re-armed fresh after the write. Zero-length reads keep the existing deadline (§10). Added SLOW-SINK-TIMEOUT and SOURCE-IDLE-TIMEOUT tests.
  4. Cleanup order: mark failed, clear timer, `fetchCtrl.abort()` immediately, then best-effort un-awaited `reader.cancel()`. Added the STALLED-READER-CANCEL test (§10, §23).
