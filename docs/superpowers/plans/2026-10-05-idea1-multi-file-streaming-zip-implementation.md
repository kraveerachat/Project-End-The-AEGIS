# IDEA1 — Multi-file Streaming ZIP: Implementation Plan

**Status:** PROPOSED. Plan only. Codex plan review is pending, and Human plan approval is required before any implementation starts.

- `IMPLEMENTATION_AUTHORIZED=NO`
- `PRODUCTION_MUTATION_AUTHORIZED=NO`
- Runtime implementation: **NOT STARTED**
- Reader acceptance and memory acceptance: **NOT RUN**. This plan task does not execute them.

**Area/owner:** `idea1` / `kla`.

**Spec:** `docs/superpowers/specs/2026-10-05-idea1-multi-file-streaming-zip.md`, Human-approved and merged by PR #346.

- Approved spec commit: `ae04ec191ca31efb1fe2f0dee2a7928cfa8a16e6`
- Approved spec blob: `1482ec41ebd383e8a672ab7f950fae0d7c975bba`

This plan does not edit the spec. Where it clarifies something, the clarification applies to this plan only.

**Plan base:** `origin/main` `09d519c46f1fb72a5ec1fefa2801b859b9ab98ec`, the PR #346 merge commit.

- The source was inspected at `3cfa72a0`.
- Nothing under `IDEA1-AEGIS_Drive_LC/` changed between the spec base `912b1800`, `3cfa72a0`, and `09d519c4`. Only the spec and Obsidian notes changed, so every `file:line` reference in the spec and in this plan is still valid.

> **For agentic workers:** execute task by task with strict TDD (RED → GREEN → commit), and only after Human approval of this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

---

## Goal

Implement the approved spec exactly.

- **1–3 files:** keep today's download behaviour.
- **4–1000 files:** save as one STORE ZIP through exactly one Save picker, for both Normal Files and Private Vault V2.
- Vault plaintext and keys never leave the browser.
- AEGIS never reports a failed or cancelled archive as successful.

## Architecture

Everything runs client-side. There is no server, gateway, package or lockfile change.

| Unit | Kind | Role |
|---|---|---|
| `src/lib/zipEntryNames.js` | NEW | Sanitisation and duplicate numbering (spec §5) |
| `src/lib/bulkDownloadPlan.js` | NEW | Synchronous pure plan step plus the exact-length formula (spec §4, §6, §7.3, §12, §14) |
| `src/lib/zipStreamWriter.js` | NEW | Pure ZIP writer over an injected sink (spec §7, §8) |
| `src/lib/bulkZipDownload.js` | NEW | One orchestrator (phase machine) plus `filesEntrySource` and `vaultV2EntrySource` (spec §10, §11, §13, §14, §16–§20) |
| `src/lib/api.js` | MOD | `apiFetchStream` (spec §9) |
| `src/lib/vaultChunkedDownload.js` | MOD | Extract `authenticateVaultV2Entry` (behaviour-preserving) |
| `src/screens/VaultTreeScreen.jsx`, `src/screens/Files.jsx` | MOD | Wiring |
| `src/components/vault/VaultDialogs.jsx`, `VaultTransferPanel.jsx` | MOD | Confirmation dialog, panel stages and reasons |
| `src/lib/strings.js` | MOD | en/th/zh keys |

**Tech:** React 19, Node 24 `node:test` (with `mock.timers`), jsdom plus the Vite SSR harness, real WebCrypto, and the existing `hash-wasm` `createCRC32()`.

## Facts verified while preparing the plan

These were read from source and the installed packages; nothing was assumed.

- **CRC:** `hash-wasm` `createCRC32()` returns `cbf43926` for `"123456789"` and `00000000` for empty input. `digest()` resets the hasher, and calling `digest()` again without `init()` throws. The writer must therefore call `init()` for every entry.
- **Test harness stubbing:** `tests/helpers/vaultScreenHarness.js` swaps these specifiers for `tests/fixtures/vaultScreenBackend.js`: `'../lib/vaultChunkedDownload.js'`, `'../lib/api.js'`, `'./api.js'`, `'./vaultChunkCrypto.js'`. It does **not** swap `'./vaultChunkedDownload.js'`. A new `src/lib/` module importing `./vaultChunkedDownload.js` would load the real module, while that module's own crypto import is swapped for the fake one. Task 18 fixes this.
- **Fixture download behaviour:** the fixture `downloadVaultV2` writes `[1,2,3,4]` per chunk unless `respondBytes` or `downloadImpl` is set. Screen tests must drive entry bytes explicitly.
- **Files has no notice area:** `Files.jsx` has no aria-live notice region, and its `actionError` only renders inside the Rename/Move dialogs.
- **Validation script location:** `validate-vault.mjs` is at the repository root, `scripts/validate-vault.mjs`. CI also runs `scripts/validate-collaboration-policy.mjs`.

## Conventions

- **Working directory:** commands run from `IDEA1-AEGIS_Drive_LC/` unless noted. `T` means `node --test --test-concurrency=1`.
- **Branch:** one implementation branch, `feat/idea1-multi-file-streaming-zip`, created from `main` after this plan is approved. One Pull Request, and exactly one final receipt at closeout.
- **RED evidence base:** spec §23 says RED evidence is recorded against `912b1800`. IDEA1 is byte-identical between `912b1800` and the implementation base, so RED is recorded against the real implementation base. Both SHAs and the "no IDEA1 drift" fact go in the receipt.
- **Commit trailer:** `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

## Mandatory clarifications (plan-only; the spec text is unchanged)

### C-1: `startOffset` is a test-only virtual logical position

1. `startOffset` (writer option, default `0`) and the matching `startOffset` parameter of `zipLayout()` are **unit-test seams only**.
2. With `startOffset = S`, the writer's logical position starts at `S`. Every offset it computes or emits is an **absolute logical position that already includes `S`**. That covers each local-header offset `oᵢ`, `cdStart`, the ZIP64 EOCD record offset in the locator, and the ZIP64 decisions `offZ64ᵢ = oᵢ ≥ 0xFFFFFFFF` and `cdStart ≥ 0xFFFFFFFF`.
3. The spec §7.3 formula is evaluated with `o₀ = S`, so `total` is the logical end position. The counting sink physically receives `total − S` bytes.
4. Every simulated-offset test asserts `S + countingSink.count === zipLayout(entries, { startOffset: S }).total`.
5. **Production ZIP output always starts at logical offset 0.**
6. **No production caller may pass `startOffset`.**
   - `bulkZipDownload.js` never forwards it.
   - `bulkDownloadPlan.js` always calls `zipLayout(entries)` with the default.
   - The Task 21 source guard enforces this: in `src/`, the identifier appears only as the parameter declarations in `zipStreamWriter.js` and `bulkDownloadPlan.js`.

### C-2: Acceptance is not executed by this plan task

- **Reader acceptance** (spec §24 reader gate R1–R3, and the A1–A12 browser matrix) is **NOT executed** in this plan task. The implementation PR builds tooling for it only (Task 23). Execution is a separate, later acceptance task.
- **Memory acceptance** (spec §24 A11, and section L below) is **NOT executed** in this plan task. Task 23 writes down the procedure only.

### C-3: Production deployment is a separate later task

- Neither this plan PR nor the implementation PR deploys or mutates Production.
- Trash #319, Download UX #334 and the future ZIP implementation will later deploy together in **one Drive release**.
- That deployment and its Production acceptance are separate tasks with their own authorization.

---

## Plan review items (open; this plan does not decide them)

Codex reviews these independently, and the Human decides. Each task that depends on one names it.

**PR-1: `BULK_ZIP_ENABLED` landing and default policy.** Spec §25 says "default `true` after acceptance". The implementation PR lands before acceptance.

- **Option A:** land `true`. Section N already blocks Production until acceptance passes, and §25 describes `false` as the rollback action. The screen tests use the default.
- **Option B:** land `false`, and flip it in the acceptance task. The screens then need a test-only `bulkZipEnabled` prop, about one line each, so the ZIP path can be exercised. Non-Production acceptance builds would flip the constant locally.
- **Decision:** PENDING. Task 4 is written so that either option needs only the constant value and, for Option B, the prop.

**PR-2: Acceptance tooling location.** The spec §9 file list does not include acceptance tooling.

- **Option A:** `IDEA1-AEGIS_Drive_LC/scripts/zip-acceptance/`, inside the owned IDEA1 path.
- **Option B:** a separate later acceptance task or PR, outside the implementation PR.
- **Option C:** inside the tests tree only.
- **Decision:** PENDING. Task 23 is written for Option A and can be dropped from the implementation PR or moved without affecting Tasks 1–22.

**PR-3: Cost of the 4 GiB tests.** Spec §23 Case A requires an entry of exactly `0xFFFFFFFF` bytes with a real CRC over the streamed bytes. The plan already uses the spec's synthetic seams: a counting sink plus one reused zero-filled buffer of at most 1 MiB, so memory stays at about 1 MiB. What remains expensive is CPU time for CRC-32 over about 4 GiB, run twice (the `0xFFFFFFFF` case and the `0xFFFFFFFE` boundary).

- **Option A:** keep both full-length streams as the spec literally states, with a per-test timeout of 120 s each.
- **Option B:** keep one full-length stream for Case A. Prove the `0xFFFFFFFE` boundary with `zipLayout` and an injected test-only hasher that is not real CRC. That needs Codex and Human confirmation that it satisfies §23.
- **Option C:** put the 4 GiB cases behind an opt-in env flag (`ZIP_SLOW=1`) that runs in the closeout regression but not in every task loop.
- **Decision:** PENDING. Task 6 is written for Option A.

**PR-4: Task and commit granularity.** The plan has 25 tasks (Task 0 plus Tasks 1–24) and about 24 commits.

- **Option A:** keep fine-grained commits, one per TDD task.
- **Option B:** consolidate to about 14 commits by merging Tasks 1+2 (names), 3+4 (plan), 5+6+7 (writer), 11+12+13 (Files adapter), 16+17 (strings, panel, dialog) and 21 into 22. RED evidence per sub-step is still recorded in the receipt.
- **Decision:** PENDING. TDD order is the same either way.

---

## Task 0: Baseline (no commit)

- [ ] On the implementation branch before any change, run and save the output:

```
T "tests/vault*.test.js" "tests/preview*.test.js" "tests/i18n*.test.js" "tests/workspace*.test.js" \
  "tests/transfer*.test.js" "tests/files*.test.js" "tests/trash*.test.js" "tests/protectedTrash*.test.js" \
  2>&1 | tee "$SCRATCH/baseline.txt"
```

- [ ] Save the names of failing and skipped tests (the Postgres suites skip without a PG environment). This is the zero-new-failures reference that Task 22 compares against.

---

## B. ZIP filename handling

### Task 1: Sanitise entry names

- **Files:** create `src/lib/zipEntryNames.js`.
- **Test first:** create `tests/zipEntryNames.test.js`.
- **RED tests:** `sanitizeZipEntryName`:
  - `../x` → `.._x`, and `..` alone → `_` (no separators survive).
  - `a/b\c` → `a_b_c`; `:*?"<>|` each → `_`.
  - C0/C1 controls (U+0000–1F, U+007F–9F) → `_`.
  - `  x  ` → `x`; `name.` and `name...` → `name`.
  - `.` → `_`.
  - `CON`, `con.txt`, `COM¹`, `LPT0.log` → `_`-prefixed; `CONSOLE.txt` unchanged.
  - `''`, `'   '`, `'...'` → `file`.
  - The NFD form of `é` comes out as NFC.
  - Thai, CJK and emoji names round-trip unchanged.
  - A 300-byte Thai name with `.pdf` → at most 255 UTF-8 bytes, ends in `.pdf`, and is cut on a code-point boundary (a `TextDecoder` with `fatal: true` does not throw).
  - An extension over 32 bytes is not preserved and is simply truncated.
  - A non-string input (`null`, a number) is converted with `String()`.
- **RED command:** `T tests/zipEntryNames.test.js`
- **Expected RED:** `ERR_MODULE_NOT_FOUND` for `src/lib/zipEntryNames.js`.
- **Minimal implementation:** apply spec §5 steps 1–7 in order:
  1. `normalize('NFC')`.
  2. Replace the forbidden characters and controls.
  3. Trim whitespace, then strip trailing dots.
  4. `.` and `..` → `_`.
  5. Reserved-name regex `/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i` → prefix `_`.
  6. Empty → `file`.
  7. `truncateUtf8(name, 255)` by iterating code points, preserving the extension when it is at most 32 bytes.
- **GREEN command:** same. **Expected:** all pass.
- **Regression:** `T tests/i18nCopyAudit.test.js`.
- **Commit:** `feat(idea1): sanitize ZIP entry names for safe extraction`

### Task 2: Duplicate numbering

- **Files:** modify `src/lib/zipEntryNames.js`.
- **Test first:** extend `tests/zipEntryNames.test.js`.
- **RED tests:** `assignZipEntryNames(names[])`:
  - `['A.txt','a.txt']` → `['A.txt','a (2).txt']`.
  - Three copies of the same name → `(2)`, `(3)`.
  - `['x.txt','x (2).txt','x.txt']` → the third becomes `x (3).txt`.
  - `.env` twice → `.env (2)` (dotfiles have no extension).
  - `archive.tar.gz` → `archive.tar (2).gz` (suffix goes before the last extension).
  - NFC and NFD forms of the same name collide.
  - A 255-byte name plus a suffix is re-truncated to at most 255 bytes and stays unique.
  - Output is deterministic and in plan order.
- **RED command:** `T tests/zipEntryNames.test.js`
- **Expected RED:** `assignZipEntryNames is not a function`.
- **Minimal implementation:** sanitise each name, then keep a `taken` Set of `toLowerCase()` keys. On a collision, loop `k = 2…` and build `stem (k).ext`, re-truncating the stem so the whole name stays at most 255 bytes. Check every candidate against `taken`.
- **GREEN/Regression:** same as Task 1.
- **Commit:** `feat(idea1): number duplicate ZIP entry names deterministically`

---

## A. Bulk download planning, plus the exact-length formula

### Task 3: Exact archive length (spec §7.3)

- **Files:** create `src/lib/bulkDownloadPlan.js`.
- **Test first:** create `tests/bulkDownloadPlan.test.js`.
- **RED tests:** `zipLayout(entries /* {nameBytes,size} */, { startOffset = 0 } = {})` returns `{ entries:[{offset,sizeZ64,offZ64,L,D,C}], cdStart, cdSize, z64End, total }`.
  - **One entry,** `n=5`, `s=3`, `startOffset 0`: `total = (30+5+3+16)+(46+5)+22 = 127`.
  - **Zero-byte entry:** `L=30+n`, `D=16`.
  - **`s=0xFFFFFFFF`:** `sizeZ64`, `L=50+n`, `D=24`, `k=2`, `C=46+n+20`, `z64End=1`, plus 76 bytes for the ZIP64 end records.
  - **`s=0xFFFFFFFE`:** not `sizeZ64`. `z64End` follows the computed `cdStart` (here `cdStart ≥ 0xFFFFFFFF`, so it is 1); the test computes and asserts it.
  - **Offset-only:** with `startOffset`, entry *i*'s local header lands at `0xFFFFFFFF`, giving `offZ64`, `k=1`, `C=46+n+12`. At `0xFFFFFFFE` it is classic.
  - **`N ≥ 0xFFFF`:** 65,535 synthetic tiny entries (pure, no I/O).
  - **`cdStart` boundary:** `0xFFFFFFFE` vs `0xFFFFFFFF`.
  - **C-1 invariant:** for a given `S`, every reported offset already includes `S`.
- **RED command:** `T tests/bulkDownloadPlan.test.js`
- **Expected RED:** `ERR_MODULE_NOT_FOUND`.
- **Minimal implementation:** one forward pass of §7.3 with `o₀ = startOffset`. Use `Number` arithmetic and assert `Number.isSafeInteger` on every input. The JSDoc marks `startOffset` as a test-only seam (C-1).
- **GREEN/Regression:** same.
- **Commit:** `feat(idea1): compute exact streaming ZIP length including ZIP64 records`

### Task 4: Plan rules: filtering, thresholds, V1 refusal, no-FSA decision, skipped-folder counts, archive name

- **Files:** modify `src/lib/bulkDownloadPlan.js`.
- **Test first:** extend `tests/bulkDownloadPlan.test.js`.
- **RED tests:** `planBulkDownload({ source:'files'|'vault', items, resolve, fsa, enabled = BULK_ZIP_ENABLED, now })`:
  - **Counts:** 0 files → `mode:'none'`; 1, 2, 3 → `'per-file'`; 4 and 1000 → `'zip'`; 1001 → `refused/'too-many'`.
  - **Folders:** 3 files + 2 folders → per-file with `skippedFolders:2`. 4 files + 1 folder → zip with `skippedFolders:1`.
  - **Unavailable ids:** an unresolvable Files id is counted as `unavailable`, and the threshold uses the filtered count.
  - **D-1:** 4 Vault entries including one V1 → `refused/'v1-in-zip'`; 3 including V1 → per-file.
  - **No-FSA:** `zipLayout().total ≤ 64 MiB` → `transport:'buffered'`. Above that: Files → `per-file` with `fallbackNotice:'no-fsa-large'`, Vault → `refused/'too-large'`. The boundary is exactly `64 MiB` vs `64 MiB + 1`.
  - **FSA:** `transport:'fsa'`.
  - **Feature flag:** `enabled:false` → per-file for every `n`.
  - **Archive name:** `suggestedName` is `AEGIS-Files-YYYYMMDD-HHmmss.zip` or `AEGIS-Vault-export-YYYYMMDD-HHmmss.zip`, in local time from an injected `now`.
  - **Immutable snapshot:** entries are deep-frozen.
  - **Vault sizes:** `node.plainSize ?? estimatedPlainSize(blob)`.
  - **Constants:** `ZIP_THRESHOLD === 4`, `MAX_ZIP_ENTRIES === 1000`.
- **RED command:** `T tests/bulkDownloadPlan.test.js`
- **Expected RED:** `planBulkDownload is not a function`.
- **Minimal implementation:** a synchronous pure function. It filters and counts, refuses before any async work, assigns names (Task 2), runs `zipLayout` (default offset, per C-1), makes the transport decision, and deep-freezes the result.
- **`BULK_ZIP_ENABLED` value:** set according to **PR-1** once decided. This task does not choose it.
- **GREEN/Regression:** same.
- **Commit:** `feat(idea1): plan bulk downloads with ZIP threshold, caps and fallbacks`

---

## C. ZIP writer

### Task 5: Core records: STORE, CRC-32, local header, data descriptor, central directory, EOCD, zero-byte, UTF-8, exact length

- **Files:** create `src/lib/zipStreamWriter.js`.
- **Test first:** create `tests/zipStreamWriter.test.js`, which includes:
  - an in-test parser and extractor for the central directory, EOCD and ZIP64 records;
  - a **counting sink** that counts every byte and keeps only the regions the test asks for;
  - a **synthetic source** that yields one reused zero-filled buffer of at most 1 MiB.
- **RED tests:**
  - CRC: `"123456789"` → `0xCBF43926`; empty → `0`.
  - Round trip: 3 entries, one of them 0 bytes, parsed back:
    - signatures `0x04034b50`, `0x08074b50`, `0x02014b50`, `0x06054b50`;
    - flags `0x0808`, method 0, version made by 45 with host 0, version needed 20;
    - local CRC and sizes are 0;
    - each descriptor is 16 bytes with the real values;
    - the zero-byte entry has CRC 0, sizes 0 and a 16-byte descriptor;
    - DOS time and date are identical across entries (injected `now`);
    - no extra fields, no comment, attributes 0;
    - the bytes extract exactly.
  - Thai, CJK and emoji names are UTF-8 with bit 11 set.
  - The physical length equals `zipLayout().total` (with `startOffset` 0).
  - Python cross-check: if `python` exists, `zipfile.ZipFile(p).testzip()` returns `None`. The test is skipped, and says so, when Python is absent.
- **RED command:** `T tests/zipStreamWriter.test.js`
- **Expected RED:** `ERR_MODULE_NOT_FOUND`.
- **Minimal implementation:** `createZipStreamWriter({ sink, createHasher, now, startOffset = 0 })` (`startOffset` is test-only, per C-1).
  - `begin()` awaits `createHasher()`.
  - `addEntry({name,size})` writes the local header and returns an entry sub-sink:
    - `write(bytes)`: overflow check first, then `hasher.update`, then `sink.write` (skipped when the length is 0), then count.
    - `close()`: require `count === size`, write the descriptor, record the central entry.
    - `abort()`: no-op.
  - `finish()`: write the central directory and the end records.
  - Only one entry can be open at a time. Little-endian via `DataView`. `hasher.init()` runs per entry.
- **GREEN/Regression:** same, plus `T tests/bulkDownloadPlan.test.js`.
- **Commit:** `feat(idea1): stream STORE ZIP entries with data descriptors and CRC-32`

### Task 6: ZIP64 size case (spec §23 Case A)

- **Files:** modify `src/lib/zipStreamWriter.js`.
- **Test first:** extend `tests/zipStreamWriter.test.js`.
- **RED tests:** stream an entry of exactly `0xFFFFFFFF` bytes through the counting sink and the synthetic source, with a real CRC.
  - The local header has both size fields `0xFFFFFFFF`, a 20-byte local ZIP64 extra (zeros), and version needed 45.
  - The descriptor is 24 bytes with 8-byte sizes.
  - The central header has size fields `0xFFFFFFFF`, an extra containing uncompressed then compressed size, and version needed 45.
  - The ZIP64 EOCD (56 bytes, record size 44, versions 45/45) and locator (20 bytes) are present, and the classic EOCD offset is `0xFFFFFFFF`.
  - The length equals the formula.
  - **Boundary:** `0xFFFFFFFE` gives a classic entry (16-byte descriptor, version 20), and the end records follow the computed trigger.
  - **Cost:** about 1 MiB of memory, with about 4 GiB of CRC CPU work per case. How these run is review item **PR-3**. As written (PR-3 Option A), each case has a per-test timeout of 120 s.
- **RED command:** `T tests/zipStreamWriter.test.js`
- **Expected RED:** assertion failures on the size fields, extra and descriptor length.
- **Minimal implementation:**
  - `sizeZ64` is decided from the declared size at `addEntry`.
  - Emit the local extra, the 24-byte descriptor, and the central extra in APPNOTE order.
  - End-record trigger: `N ≥ 0xFFFF || cdSize ≥ 0xFFFFFFFF || cdStart ≥ 0xFFFFFFFF`.
  - Classic EOCD sentinels are set only on the fields that overflowed.
- **GREEN/Regression:** same.
- **Commit:** `feat(idea1): encode size-ZIP64 entries and ZIP64 end records`

### Task 7: ZIP64 offset-only (spec §23 Case B), archive-level trigger boundaries, misuse guards

- **Files:** modify `src/lib/zipStreamWriter.js`.
- **Test first:** extend `tests/zipStreamWriter.test.js`.
- **RED tests:**
  - **Case B:** a 5-byte entry with `startOffset` chosen (per C-1) so its local header is at logical offset `0xFFFFFFFF`.
    - Sizes are real 32-bit values; the local header has no extra and version 45.
    - The descriptor is 16 bytes.
    - The central offset field is `0xFFFFFFFF`, and the central extra has data size 8 and contains only the 64-bit offset, which equals the true logical offset including `S`.
    - Central version 45, ZIP64 end records present.
    - `S + count === zipLayout(…,{startOffset:S}).total`.
    - At `0xFFFFFFFE` the entry is classic: no extra, version 20.
  - **Trigger boundaries:** `cdStart` at `0xFFFFFFFE` vs `0xFFFFFFFF` using `startOffset`. `N ≥ 0xFFFF` uses 65,535 zero-byte entries into the counting sink.
  - **Misuse:**
    - writing beyond the declared size throws, and none of those bytes are written;
    - `finish()` with an open entry throws;
    - a second `addEntry` while one is open throws;
    - a hasher throw propagates;
    - the writer never calls `sink.close` or `sink.abort` (spy).
  - **No test asserts a ZIP64 entry without ZIP64 end records** (spec §7.2).
- **RED command:** `T tests/zipStreamWriter.test.js`
- **Expected RED:** offset-only assertions fail.
- **Minimal implementation:** `offZ64 = pos ≥ 0xFFFFFFFF` at `addEntry`. Version needed is 45 iff the entry is ZIP64 in either way. Central extra count `k = 2·sizeZ64 + offZ64`.
- **GREEN/Regression:** same, plus `T tests/bulkDownloadPlan.test.js`.
- **Commit:** `feat(idea1): encode offset-only ZIP64 entries and guard writer misuse`

---

## Transport primitives

### Task 8: `apiFetchStream`

- **Files:** modify `src/lib/api.js`.
- **Test first:** create `tests/apiFetchStream.test.js`. It stubs `globalThis.fetch` with Node `Response` and `ReadableStream`.
- **RED tests:**
  - Returns `{ok:true,status,errorKind:null,headers,body}` without reading the body (`arrayBuffer`, `text` and `getReader` are not called).
  - `credentials:'include'` and the `withBase` path.
  - The caller's signal is passed through, and an abort maps to `errorKind:'network'`.
  - 401 → `'unauthorized'` and calls the registered handler.
  - 403 → `'forbidden'`; 500 → `'server'`; a thrown fetch → `'network'`.
  - No internal timeout (fake timers advanced 10 minutes, no abort).
  - A `null` body is returned as-is.
- **RED command:** `T tests/apiFetchStream.test.js`
- **Expected RED:** `apiFetchStream is not a function`.
- **Minimal implementation:** mirror `apiFetchBytes` (`src/lib/api.js:142-172`) without the timer and without `arrayBuffer`.
- **GREEN command:** same.
- **Regression:** `T tests/apiFetchStream.test.js "tests/files*.test.js" tests/i18nCopyAudit.test.js`.
- **Commit:** `feat(idea1): add apiFetchStream for unbuffered same-origin downloads`

### Task 9: Extract `authenticateVaultV2Entry` (behaviour-preserving)

- **Files:** modify `src/lib/vaultChunkedDownload.js`.
- **Test first:** create `tests/vaultAuthenticateEntry.test.js` (real WebCrypto, the `lazyV2` pattern from `vaultDownloadPickerFirst.test.js`).
- **RED tests:**
  - A valid blob → `{ok:true, plainSize}` with no `dek` field.
  - The wrong KEK or a tampered `metaB64` → `{ok:false, reason:'wrong-key'}`.
  - No fetch is made.
  - A non-safe or negative `meta.plainSize` → `{ok:false, reason:'integrity'}`.
- **RED command:** `T tests/vaultAuthenticateEntry.test.js`
- **Expected RED:** `authenticateVaultV2Entry is not a function`.
- **Minimal implementation:** factor an internal `unwrapAndAuthenticate` out of `prepareVaultV2Download`.
  - `authenticateVaultV2Entry` returns only `plainSize`, so the DEK is not retained.
  - `prepareVaultV2Download` keeps its order and reasons.
  - `downloadVaultV2` is unchanged.
- **GREEN command:** same.
- **Regression (mandatory, #334):** `T tests/vaultDownloadPickerFirst.test.js tests/vaultTreeDownloadProgress.test.js tests/vaultLegacyV2DownloadBusy.test.js tests/vaultTreeBulkDownloadCancel.test.js`, all green.
- **Commit:** `refactor(idea1): extract Vault V2 envelope authentication for bulk pre-flight`

---

## D. Generic ZIP orchestrator

### Task 10: Phase machine, one picker, writable ordering, abort and finalization, progress, busy, cancel

- **Files:** create `src/lib/bulkZipDownload.js`.
- **Test first:** create `tests/bulkZipOrchestrator.test.js`. It uses a fake entry source and a fake `scope.showSaveFilePicker` and writable that log every call to one event list (the #334 `fakeScope` style).
- **RED tests:**
  - **Picker:** exactly one `showSaveFilePicker` per archive, called synchronously; the spy has recorded the call before `runBulkZip` returns its promise. It receives `{suggestedName, types:[{description:'ZIP archive',accept:{'application/zip':['.zip']}}]}`.
  - **Ordering:** `picker → hasher → preflight* → createWritable → writes* → finish → close`.
  - **Picker failures:** `AbortError` → `cancelled`, with zero source opens and no `createWritable`. Another error → `picker`. A `createWritable` throw → `destination`.
  - **State machine** `picking → preparing → opening → archiving → finishing → finalizing → done|failed|cancelled`:
    - Any failure before close leads to exactly one `abort()` and never `close()`.
    - Cancel before close reports `cancelled`.
    - `isPurged()` true between entries or immediately before close leads to an abort.
    - A `close()` rejection leads to at most one abort and `finalizeFailed`.
    - A `close()` rejection with `QuotaExceededError` leads to `localDiskFull`.
    - `QuotaExceededError` on a write leads to `localDiskFull`, an abort and no close. This also holds when the source swallowed the error (a guarded archive sink records the first write error).
    - A rejection from `abort()` is swallowed.
  - **Final-write race (#334 lineage):** a signal abort after the last descriptor but before `close` leads to an abort, never a close.
  - **Progress:**
    - stage `preparing` during pre-flight, `archiving` with `{index,count,name}`, `finalizing` while `close` is pending;
    - `totalBytes` is the payload sum;
    - `percent = floor(t/T·1000)/10`, never decreasing, at most 99.9 until `close` resolves, then 100;
    - a total of 0 shows 0 and then 100;
    - nothing fires before the picker returns;
    - rate comes from an injected `createRateEstimator`.
  - **Cancel:** unavailable once `close()` begins, and a Cancel in `finalizing` is a no-op.
  - **Busy:** `busyRef.current === true` returns `{status:'busy'}` synchronously with no picker. Otherwise the ref is set synchronously and cleared in `finally`.
  - **Entry failure:** the result carries `{failedEntry:{index,name}, reason}`.
- **RED command:** `T tests/bulkZipOrchestrator.test.js`
- **Expected RED:** `ERR_MODULE_NOT_FOUND`.
- **Minimal implementation:** `runBulkZip({ plan, source, scope, busyRef, signal, isPurged, onProgress, createHasher, createRateEstimator, sinks })`.
  - Synchronous prologue: busy check, `isPurged` check, signal check, then `scope.showSaveFilePicker` as the first await.
  - Guarded archive sink and an `abortOnce` flag.
  - **Never passes `startOffset`** (C-1).
- **GREEN command:** same.
- **Regression:** `T tests/zipStreamWriter.test.js tests/bulkDownloadPlan.test.js`.
- **Commit:** `feat(idea1): orchestrate one-picker streaming ZIP with fail-closed finalization`

---

## E. Normal Files streaming adapter

### Task 11: `filesEntrySource`: happy path, Content-Length policy, null body, HTTP errors

- **Files:** modify `src/lib/bulkZipDownload.js` (add `createFilesEntrySource({ fetchStream = apiFetchStream, idleMs = 60_000 })`).
- **Test first:** create `tests/bulkZipFiles.test.js`. It has a scripted fake reader (controllable `read()` promises, plus `cancel` and `releaseLock` spies) and an injected `fetchStream`.
- **RED tests:**
  - **Happy path:** 5 entries stream with `arrayBuffer` never called. Extracted SHA-256 equals the source. Each path is `/api/files/:id/download`.
  - **Content-Length:**
    - missing, `"12a"`, `""` and `"-1"` → `invalid-length`;
    - `"9007199254740993"` → `invalid-length`;
    - surrounding whitespace is trimmed and accepted;
    - a value different from the planned size → `size-mismatch`, with that entry's local header not written.
  - **Body:** `body === null` → `stream-missing`.
  - **HTTP:** network → `network`; 401 → `unauthorized`; 403 → `forbidden`; 500 → `server`.
  - **Every failure:** `fetchCtrl.signal.aborted`, `reader.cancel` called when a reader exists, one archive abort, no close, and the next entry's fetch is never issued.
- **RED command:** `T tests/bulkZipFiles.test.js`
- **Expected RED:** `createFilesEntrySource is not a function`.
- **Minimal implementation:** spec §10 steps 1–5 and 7, with the idempotent `cleanup(reason)`:
  1. Mark the entry and archive failed.
  2. Clear the timer.
  3. `fetchCtrl.abort()`.
  4. `reader?.cancel(reason).catch(()=>{})`, not awaited.

  `fetchCtrl` is linked to the archive signal, and the listener is removed on exit.
- **GREEN command:** same.
- **Regression:** `T tests/bulkZipOrchestrator.test.js tests/apiFetchStream.test.js`.
- **Commit:** `feat(idea1): stream Normal Files entries with mandatory Content-Length`

### Task 12: Source-idle timer and slow sink

- **Files:** modify `src/lib/bulkZipDownload.js`.
- **Test first:** extend `tests/bulkZipFiles.test.js`, using `t.mock.timers.enable({ apis:['setTimeout'] })` and a `flush()` helper that drains microtasks between ticks.
- **RED tests:**
  - **SOURCE-IDLE (a):** no headers for 60 s → `timeout`.
  - **SOURCE-IDLE (b):** headers arrive, then no positive payload from `read()` for 60 s → `timeout`.
  - **SOURCE-IDLE (c):** after the last positive chunk, only zero-length non-done reads for 60 s → `timeout`. Zero-length reads do not extend the deadline.
  - **Each SOURCE-IDLE case also requires:** `fetchCtrl` aborted, `reader.cancel` called when a reader exists, one abort, no close, and no next fetch.
  - **Control:** 59 s, then 1 byte, then 59 s → no timeout.
  - **SLOW-SINK:**
    - a chunk arrives at +30 s;
    - the archive `write` is held for 90 s, and no timeout fires;
    - after the write, the next chunk at +59 s succeeds;
    - in a variant, no chunk arrives within 60 s after the write → `timeout`.
- **RED command:** `T tests/bulkZipFiles.test.js`
- **Expected RED:** the timer never fires, or fires during the held write.
- **Minimal implementation:**
  - Arm the timer only around `await fetchStream` and `await reader.read()`.
  - On a positive read: `received += len`, then clear the timer, then check overlong, then CRC, then await the write.
  - Re-arm a fresh timer at the next read.
  - On a zero-length read: keep the existing deadline.
- **GREEN/Regression:** same as Task 11.
- **Commit:** `feat(idea1): time out Files ZIP entries on source idleness only`

### Task 13: Fetch abort before `reader.cancel`, stalled `reader.cancel`, overlong, early EOF, write and hasher failure

- **Files:** modify `src/lib/bulkZipDownload.js`.
- **Test first:** extend `tests/bulkZipFiles.test.js`.
- **RED tests:**
  - **STALLED-READER-CANCEL:**
    - `reader.cancel` returns a never-settling promise (variant: a rejection delayed 5 s).
    - Triggered by `overlong`.
    - A call-order spy shows `fetchCtrl.abort` before `reader.cancel`, and `signal.aborted` is true synchronously inside cleanup.
    - The archive is failed, aborted once, never closed, no next fetch, no success, and `runBulkZip` resolves even though `cancel` never settles.
  - **Overlong:** the excess is not written.
  - **Early EOF:** `early-eof`.
  - **Archive write throws:** `write`, and a quota error maps to `localDiskFull`.
  - **Hasher throws:** `write`.
  - **Explicit Cancel mid-entry:** `cancelled`, with the same cleanup assertions.
  - **Idempotent cleanup:** a second trigger does not call abort again.
- **RED command:** `T tests/bulkZipFiles.test.js`
- **Expected RED:** order assertions fail, or the promise hangs (each test has a 5 s timeout).
- **Minimal implementation:** cleanup never awaits `cancel`. The orchestrator returns the failure without depending on `cancel` settling.
- **GREEN/Regression:** same as Task 11.
- **Commit:** `fix(idea1): abort Files fetch before best-effort reader cancel`

---

## F. Vault V2 adapter

### Task 14: `vaultV2EntrySource`: pre-flight before `createWritable`, keys not retained, AEAD before the sink, zero-byte, lock and cancel

- **Files:** modify `src/lib/bulkZipDownload.js` (add `createVaultV2EntrySource({ kek, authenticate = authenticateVaultV2Entry, download = downloadVaultV2, isPurged })`).
- **Test first:** create `tests/bulkZipVault.test.js`. This is the module level: real crypto, `lazyV2` with an injected `fetchBytes`. The D-3 screen tests are in Task 19.
- **RED tests:**
  - **Pre-flight:**
    - every envelope is authenticated before `createWritable`;
    - a bad envelope on entry 3 means no `createWritable` and zero chunk fetches;
    - manifest `plainSize` different from `meta.plainSize` → `integrity`, with no writable;
    - pre-flight makes no network fetch.
  - **Keys not retained:** an `unwrapVaultV2Dek` spy counts exactly `2 × entries`, and pre-flight holds no `CryptoKey`.
  - **AEAD before sink:** a tampered chunk in entry 2 leads to one abort, no close, failed name = entry 2, and entry 3 is never fetched. With strict fetch/write alternation, every write follows a successful decrypt.
  - **Zero-byte V2 entry:**
    - one tag-only chunk is fetched and AEAD-verified;
    - a tampered tag makes the archive fail;
    - on success, the extracted entry is 0 bytes with CRC 0 and the archive parses.
  - **Lock and cancel:**
    - lock during pre-flight → no writable;
    - lock mid-entry → abort, no close;
    - lock after the last entry but before close → abort, no close;
    - Cancel → no later entry fetched.
  - **Bytes:** SHA-256 per entry equals the source, and `bytesWritten` equals the pre-flight size.
  - **Memory proxy:** `writable.maxHeld` is at most one chunk.
- **RED command:** `T tests/bulkZipVault.test.js`
- **Expected RED:** `createVaultV2EntrySource is not a function`.
- **Minimal implementation:**
  - `preflight(plan, signal)` authenticates sequentially, compares sizes, checks signal and `isPurged` between entries, and returns the authenticated sizes. The orchestrator recomputes `zipLayout` and re-checks the buffered cap.
  - `stream(entry, entrySink, signal)` calls `download({ kek, blob, sink: entrySink, signal, onProgress })` and maps a non-ok result to that result's reason.
- **GREEN command:** same.
- **Regression:** `T tests/bulkZipOrchestrator.test.js tests/vaultDownloadPickerFirst.test.js tests/vaultAuthenticateEntry.test.js`.
- **Commit:** `feat(idea1): stream authenticated Vault V2 entries into one ZIP`

---

## H. No-FSA path

### Task 15: Buffered ZIP up to 64 MiB, per-file fallback for large Files, safe failure for large Vault exports

- **Files:** modify `src/lib/bulkZipDownload.js` (buffered finaliser).
- **Test first:** create `tests/bulkZipNoFsa.test.js`.
- **RED tests:**
  - **Files, `total ≤ 64 MiB`:** `createBufferedSink({limitBytes: 64 MiB})` is used. The result is a `Blob` of type `application/zip` with the plan's name. The anchor is clicked once, `revokeObjectURL` runs after 10 s (fake timers), and the ZIP parses.
  - **Files above 64 MiB:** the orchestrator is not invoked. The plan returns per-file with `fallbackNotice`, and there is no buffering.
  - **Vault, `total ≤ 64 MiB`:** buffered, and the object URL is passed to `registerObjectUrl`.
  - **Vault re-check:** the plan is within the cap but the authenticated total is above it → `too-large` after pre-flight, with zero chunk fetches.
  - **Vault above 64 MiB at plan time:** refused, nothing fetched.
  - **Backstop:** a `BUFFER_LIMIT` overrun leads to a failed archive and discarded parts.
  - **No picker** is called on this path.
  - **Code comment check:** the module comment states that **64 MiB is a buffer and archive-size policy cap, not a browser peak-RAM guarantee** (`readFileSync` assertion).
- **RED command:** `T tests/bulkZipNoFsa.test.js`
- **Expected RED:** missing buffered transport.
- **Minimal implementation:** `transport:'buffered'` skips the picker and uses the buffered sink. On success: `new Blob(parts,{type:'application/zip'})`, then the anchor, then the delayed revoke. This finaliser is the only place `new Blob(` is allow-listed, marked with the comment `// allow-list: buffered-fallback finaliser`.
- **GREEN/Regression:** same as Task 14.
- **Commit:** `feat(idea1): bounded buffered ZIP fallback for browsers without FSA`

---

## I. UI integration

### Task 16: Strings (en/th/zh) and transfer panel stages and reasons

- **Files:** modify `src/lib/strings.js` and `src/components/vault/VaultTransferPanel.jsx`.
- **Test first:** create `tests/bulkZipPanelStrings.test.js` (static markup render).
- **RED tests:**
  - New keys exist in en, th and zh and pass the `i18nCopyAudit` parity check:
    - `zipArchiving` ("File {index} of {count}: {name}")
    - `zipFinalizing`
    - `zipFoldersSkipped` {n}
    - `zipUnavailable` {n}
    - `zipTooManyFiles`
    - `zipV1NotSupported`
    - `vaultZipExportTitle`, `vaultZipExportBody` {count} {size}, `vaultZipExportConfirm` ("Save unencrypted ZIP")
    - `xferReasonLocalDiskFull`
    - `xferReasonFinalizeFailed`
    - `filesDownloadBusy`
    - `filesZipLargeFallback`
  - Stage `archiving` renders `zipArchiving`.
  - Stage `finalizing` renders `zipFinalizing`, with no Cancel button and no rate row.
  - Reasons `localDiskFull` and `finalizeFailed` render the new keys, and the Data Lake `noSpace` key is not reused for them.
  - Existing stages render unchanged.
- **RED command:** `T tests/bulkZipPanelStrings.test.js tests/i18nCopyAudit.test.js`
- **Expected RED:** missing keys, and the stage falls through to `vaultXferFailed`.
- **Minimal implementation:** add the keys and the panel branches. `active` includes `archiving`; Cancel is hidden when `stage === 'finalizing'`.
- **GREEN command:** same.
- **Regression:** `T tests/vaultTreeDownloadProgress.test.js tests/vaultLegacyV2DownloadBusy.test.js "tests/i18n*.test.js"`.
- **Commit:** `feat(idea1): add archive progress stages and local-disk wording (en/th/zh)`

### Task 17: Plaintext-export confirmation dialog (D-3)

- **Files:** modify `src/components/vault/VaultDialogs.jsx` (add `PlaintextExportDialog`).
- **Test first:** create `tests/vaultPlaintextExportDialog.test.js` (jsdom through the harness `load`).
- **RED tests:**
  - Shows the not-encrypted warning, the count and `fmtBytes(total)`.
  - Buttons are Confirm (`data-testid="vault-zip-export-confirm"`) and Cancel.
  - `onConfirm` runs synchronously inside the click.
  - Escape and Cancel call `onClose` only.
  - A lock closes it, through `usePurgeAwareDialog`.
- **RED command:** `T tests/vaultPlaintextExportDialog.test.js`
- **Expected RED:** missing export.
- **Minimal implementation:** follow the `TrashConfirmDialog` pattern: `onClick={() => { onConfirm(); onClose() }}`.
- **GREEN/Regression:** same, plus `T tests/vaultTreeBulkDownloadCancel.test.js`.
- **Commit:** `feat(idea1): confirm plaintext export before Vault ZIP`

### Task 18: Screen-harness stub alignment

- **Files:** modify `tests/helpers/vaultScreenHarness.js` (add `'./vaultChunkedDownload.js'` to `STUBBED`) and `tests/fixtures/vaultScreenBackend.js` (add `authenticateVaultV2Entry`, which honours `metaAuthFails`, and an inert `apiFetchStream`).
- **Test first:** create `tests/vaultScreenHarnessStubs.test.js`.
- **RED tests:**
  - Through the harness, `/src/lib/bulkZipDownload.js`'s `./vaultChunkedDownload.js` resolves to the same fixture instance the screen uses (identity check).
  - The fixture exports `authenticateVaultV2Entry`.
- **RED command:** `T tests/vaultScreenHarnessStubs.test.js`
- **Expected RED:** the identity assertion fails because the real module is loaded.
- **Minimal implementation:** the one-line `STUBBED` addition plus the two fixture exports. Additive only.
- **GREEN command:** same.
- **Regression:** `T tests/vaultTreeDownloadProgress.test.js tests/vaultTreeBulkDownloadCancel.test.js tests/vaultLegacyV2DownloadBusy.test.js "tests/vault*Ui*.test.js"`.
- **Commit:** `test(idea1): route bulk ZIP Vault imports through the screen fixture`

### Task 19: VaultTreeScreen integration

- **Files:** modify `src/screens/VaultTreeScreen.jsx`. Only the `startBulkDownload` block (`:486-535`), the dialog render block and the panel props change.
- **Test first:** create `tests/vaultTreeBulkZip.test.js` (harness, `vaultTreeBackend`, `createFakeTreeServer`, fixture `downloadImpl`).
- **RED tests:**
  - **Per-file path:** 1–3 files still use `treeDownloadEntry` per file, unchanged from #334 (picker count = n).
  - **D-3:** 4+ files open the confirmation with no picker or fetch on open.
  - **D-3 synchronous picker:** Confirm calls `showSaveFilePicker` synchronously, exactly once for N = 5.
  - **D-3 cancel:** cancelling the dialog causes zero fetches and no picker.
  - **D-3 lock:** a lock while the dialog is open closes it, and a stale Confirm is a no-op.
  - **Snapshot:** changing the selection while the dialog is open does not change the saved plan.
  - **V1:** a V1 entry in a 4+ selection → `zipV1NotSupported`, with no dialog or picker.
  - **Cap:** 1001 files → `zipTooManyFiles`.
  - **Folders:** 4 files + 1 folder → ZIP plus `zipFoldersSkipped`. 2 files + 1 folder → per-file plus the notice.
  - **Busy:** a second Download while the dialog is open or the archive runs announces `vaultTreeDownloadBusy` and opens no second dialog or picker.
  - **Panel:** shows `archiving` "File i of N: name"; Cancel aborts with no later entry; Cancel is hidden in `finalizing`; `localDiskFull` and `finalizeFailed` render.
  - **Single-file entry points:** the tile menu and preview `onDownload` stay per-file.
- **RED command:** `T tests/vaultTreeBulkZip.test.js`
- **Expected RED:** 4+ files still loop pickers, and no dialog exists.
- **Minimal implementation:**
  - `startBulkDownload` runs `planBulkDownload` synchronously.
  - `per-file` keeps the existing loop verbatim, plus the notice. `refused` announces.
  - `zip` sets `setDialog({kind:'zipExport', plan})` with the busy ref set synchronously.
  - Confirm runs `registerAbort(ctrl)`, then calls `runBulkZip({ plan, source: createVaultV2EntrySource(...), busyRef: downloadBusyRef, signal: ctrl.signal, isPurged, … })` directly.
- **GREEN command:** same.
- **Regression:** `T tests/vaultTreeDownloadProgress.test.js tests/vaultTreeBulkDownloadCancel.test.js tests/vaultLegacyV2DownloadBusy.test.js tests/vaultDownloadPickerFirst.test.js "tests/previewIndex*.test.js" tests/vaultTreeSourceScan.test.js`.
- **Commit:** `feat(idea1): save 4+ Vault files as one confirmed streaming ZIP`

### Task 20: Files.jsx integration

- **Files:** modify `src/screens/Files.jsx`: the bulk Download handler (`:1203-1210`), a new `downloadBusyRef`, a `files-bulk-notice` status region, and a `VaultTransferPanel` import from `components/vault/` (not moved).
- **Test first:** create `tests/filesBulkZip.test.js` (jsdom plus Vite SSR, as in `filesInteractionPolish.test.js`; stubbed `fetch` returns stream `Response` objects with `Content-Length`).
- **RED tests:**
  - **Per-file path:** 1–3 files click anchors only, unchanged, with no picker.
  - **ZIP path:**
    - 4+ files → `showSaveFilePicker` called synchronously within the click, exactly once, with no confirmation dialog;
    - the panel progresses to 100 and then clears;
    - a missing id is counted (`zipUnavailable`);
    - folders give `zipFoldersSkipped`.
  - **Busy:** a second click announces `filesDownloadBusy`.
  - **Cancel:** Cancel aborts the archive.
  - **No FSA:** above 64 MiB → per-file anchors plus `filesZipLargeFallback`; at or below 64 MiB → one Blob ZIP anchor.
  - **Single-file entry points:** the tile menu and preview `onDownload` stay per-file.
- **RED command:** `T tests/filesBulkZip.test.js`
- **Expected RED:** N anchors, and no picker.
- **Minimal implementation:**
  - `planBulkDownload({ source:'files', …, fsa: supportsStreamingFileSink() })`, then dispatch.
  - The zip path calls `runBulkZip` synchronously from the click with `createFilesEntrySource()`.
  - Add notice and transfer state, and render the panel above the selection bar.
- **GREEN command:** same.
- **Regression:** `T "tests/files*.test.js" "tests/trash*.test.js" tests/previewFilesWiring.test.js tests/allScreensEmptyState.test.js`.
- **Commit:** `feat(idea1): save 4+ Files as one streaming ZIP with a single picker`

---

## J. Guards and regressions

### Task 21: Source guards

- **Test first:** create `tests/bulkZipSourceGuard.test.js`.
- **RED tests:**
  - **Buffering primitives:** `zipStreamWriter.js`, `bulkZipDownload.js` and `bulkDownloadPlan.js` contain no `arrayBuffer(` or `apiFetchBytes`. `new Blob(` appears only under the `// allow-list: buffered-fallback finaliser` marker.
  - **No await before the picker:** from the start of the Files click handler and the Vault Confirm handler to `showSaveFilePicker`, the source text contains no `await` or `.then(`.
  - **C-1:** in `src/`, `startOffset` appears only as the parameter declarations in `zipStreamWriter.js` and `bulkDownloadPlan.js`. No caller passes it.
  - **No browser storage:** none of the new modules use `localStorage`, `sessionStorage`, `indexedDB`, `caches` or `console.`.
  - **No dependency change:** `package.json` `dependencies` and `devDependencies` key sets are unchanged (pinned list).
  - **No out-of-scope edits:** `server/**`, `Vault.jsx` and `VaultTreeRollback` are unchanged (checked with `git diff --name-only origin/main...HEAD` when git is available; otherwise skipped with a message).
- **RED command:** `T tests/bulkZipSourceGuard.test.js`, written before the Task 15 marker exists.
- **Expected RED:** the allow-list marker is missing, so the `new Blob(` guard fails.
- **Minimal implementation:** add the marker comment.
- **GREEN/Regression:** `T tests/vaultTreeSourceScan.test.js tests/bulkZipSourceGuard.test.js`.
- **Commit:** `test(idea1): guard streaming ZIP against buffering and pre-picker awaits`

### Task 22: Regression sweep (verification only; commit only if a fix is needed)

Compare each run against the Task 0 baseline:

- **#334 picker-first, final-write abort race, batch cancel, legacy V2 busy guard:** `T tests/vaultDownloadPickerFirst.test.js tests/vaultTreeDownloadProgress.test.js tests/vaultTreeBulkDownloadCancel.test.js tests/vaultLegacyV2DownloadBusy.test.js`
- **Trash #319:** `T tests/trashPreviewRoute.test.js tests/trashPreviewUi.test.js tests/trashDestructiveReauthUi.test.js "tests/protectedTrash*.test.js"`
- **D-1 preview index untouched:** first `git diff --name-only origin/main...HEAD | grep -E "vaultPreviewIndex|vaultDerivative|previewIndex|server/"` must print nothing; then `T "tests/previewIndex*.test.js"`.
- **Full spec regression set:** the Task 0 command. The failing-name diff against the baseline must show 0 new failures.

---

## K. Reader acceptance tooling (built only, NOT executed; location is review item PR-2)

### Task 23: Acceptance tooling

- **Files (PR-2 Option A):**
  - `IDEA1-AEGIS_Drive_LC/scripts/zip-acceptance/make-sources.mjs`
  - `IDEA1-AEGIS_Drive_LC/scripts/zip-acceptance/verify_zip.py`
  - `IDEA1-AEGIS_Drive_LC/scripts/zip-acceptance/README.md`
- **Test first:** create `tests/zipAcceptanceTooling.test.js`.
- **RED tests:**
  - `make-sources.mjs --set R1 --out <tmp>` writes deterministic pattern files (including a 0-byte file and Thai, CJK, emoji, duplicate and reserved names) plus `manifest.json` (name, size, SHA-256). Large sets are streamed, never held in memory.
  - `--set R2 --dry-run` prints one file of at least 4.1 GiB plus 3 small files.
  - `--set R3 --dry-run` prints 4 files of about 1.1 GiB each (each below `0xFFFFFFFF`), then a final 1 KiB file. Using `zipLayout`, it asserts that the final entry's local-header offset is at least `0xFFFFFFFF` for the generated names.
  - When Python is present, `verify_zip.py` is run on a small writer-made archive:
    - `testzip()` returns `None`;
    - `extractall` succeeds and the SHA-256 values equal the manifest;
    - `--inspect-offset-only NAME` exits non-zero on a non-ZIP64 entry.
- **RED command:** `T tests/zipAcceptanceTooling.test.js`
- **Expected RED:** scripts missing.
- **Minimal implementation:**
  - `verify_zip.py <zip> <manifest> [--inspect-offset-only NAME]` uses `zipfile` (`ZipInfo.header_offset`, `ZipInfo.extra`) plus a raw scan of the central record. For R3 it asserts:
    - offset ≥ `0xFFFFFFFF`;
    - sizes < `0xFFFFFFFF`, with real values in the central size fields;
    - central offset field = `0xFFFFFFFF`;
    - the `0x0001` extra has data size 8 and contains only the offset;
    - version needed = 45;
    - the SHA-256 matches.
  - `verify_zip.py --extracted <dir> <manifest>` checks folders extracted by Windows Explorer and macOS Archive Utility.
  - The README holds the R1–R3 and A1–A12 matrix with every cell set to `NOT RUN`. The required readers are Windows Explorer, macOS Archive Utility and Python `zipfile`; 7-Zip is optional. If any required reader fails, implementation acceptance is BLOCKED (D-4).
- **GREEN command:** same.
- **Commit:** `test(idea1): add ZIP reader-acceptance fixtures and inspector`

**Not done here:** producing R1–R3 through the real app on a non-Production instance, and running the readers. That is a separate later acceptance task (C-2).

## L. Memory acceptance (procedure only, NOT executed)

Documented in `scripts/zip-acceptance/README.md` (or wherever PR-2 decides):

- **Setup:** Chrome or Edge on the FSA path, a non-Production instance. Vault and Files are tested separately. Record the blob's `chunkSize`.
- **Measure:** sample the tab's memory footprint every second (browser Task Manager, `performance.measureUserAgentSpecificMemory()` where available, or a DevTools heap timeline). Do this while archiving one 1 GiB entry and, separately, one 5 GiB entry.
- **Pass criterion:** peak growth over the idle baseline differs by less than 64 MiB between the two runs, so growth does not scale with file size.
- **What it does not certify:** no exact process-RAM ceiling is promised. The 64 MiB no-FSA figure is a buffer and archive-size policy, not a peak-RAM bound.
- **Unit-level proxies already in the plan:** Task 14 `maxHeld` is at most one chunk, and Task 6 holds about 1 MiB while streaming 4 GiB.

---

## M. Final integration, regression, build and governance

### Task 24: Closeout of the implementation PR

1. `npm test`: record pass, fail and skip counts against the Task 0 baseline.
2. `npx vite build`, then from the repository root `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge`.
3. `git diff --check`; `git diff --name-status origin/main...HEAD`. Declare every changed path.
4. Create exactly one receipt, `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/YYYY-MM-DD_HHMMSS_kla_idea1-multi-file-streaming-zip.md`, from `_template.md`. It must include:
   - exact commands and pass/fail results;
   - both base SHAs and the "no IDEA1 drift" fact;
   - reader and memory acceptance marked `NOT RUN`;
   - the PR-1 decision applied.
5. Update the "Current Task" section of `idea1/idea1-status.md` (owner kla).
6. Run `scripts/validate-collaboration-policy.mjs` with a local event file.
7. Open a Draft PR with area `idea1`, owner `kla`. Set `integration-review` according to the actual changed paths: `yes` if any path outside `IDEA1-AEGIS_Drive_LC/` or the idea1 Obsidian notes changes.
8. **Commit:** `docs(idea1): record multi-file streaming ZIP implementation receipt`

## N. Rollout boundary

- **No deploy:** the implementation PR does **not** deploy and does **not** mutate Production.
- **One Drive release:** Trash #319, Download UX #334 and the ZIP implementation deploy to Production together, later, as **one Drive release**.
- **Separate acceptance:** Production acceptance is a separate task. It requires, on a non-Production instance:
  - the reader gate R1–R3 (Windows Explorer, macOS Archive Utility and Python `zipfile` required; 7-Zip optional);
  - the A1–A12 browser matrix;
  - the memory procedure (L).

  A required-reader failure blocks implementation acceptance and triggers a separate record-layout redesign under D-4.
- **Rollback:** revert the implementation PR, or set `BULK_ZIP_ENABLED = false` (a one-line change).

---

## Overlap and risk summary

- **Files shared with #334:**
  - `src/lib/vaultChunkedDownload.js`
  - `src/screens/VaultTreeScreen.jsx`
  - `src/components/vault/VaultTransferPanel.jsx`
  - `src/lib/strings.js`
  - `tests/helpers/vaultScreenHarness.js`
  - `tests/fixtures/vaultScreenBackend.js`
  - `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md`

  The #334 test suites are run, not edited.
- **Files shared with Trash #319:**
  - `src/screens/Files.jsx`
  - `src/lib/strings.js`
  - `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md`
- **D-1 preview index:** no `vaultPreviewIndex*`, `vaultDerivative*` or server file is touched. `VaultTreeScreen.jsx` also contains D-1 wiring, but only its download block is edited, and the Task 22 grep guard enforces this.
- **Estimated size:** 25 tasks (Task 0 plus Tasks 1–24) and about 24 commits under PR-4 Option A.
