# IDEA1 — Multi-file Streaming ZIP: Implementation Plan

**Status:** PROPOSED, revision 3. Revision 2 applied the Codex plan review (blockers I-1 to I-5, minor items M-1 to M-8). Revision 3 applies the focused Codex review (Fix A to Fix F: the authenticated `plainSize` is not coerced, strict pre-flight size validation, an explicit effective Vault plan, effective size used everywhere downstream, `dispose` after a post-`open` failure, and the Windows baseline shell named). Plan only. A final Codex re-review is pending, and Human plan approval is required before any implementation starts.

- `IMPLEMENTATION_AUTHORIZED=NO`
- `PRODUCTION_MUTATION_AUTHORIZED=NO`
- Runtime implementation: **NOT STARTED**
- Reader acceptance and memory acceptance: **NOT RUN**. This plan task does not execute them.

**Area/owner:** `idea1` / `kla`.

**Spec:** `docs/superpowers/specs/2026-10-05-idea1-multi-file-streaming-zip.md`, Human-approved and merged by PR #346.

- Approved spec commit: `ae04ec191ca31efb1fe2f0dee2a7928cfa8a16e6`
- Approved spec blob: `1482ec41ebd383e8a672ab7f950fae0d7c975bba`

This plan does not edit the spec. Where it clarifies or chooses an internal mechanism, that choice applies to this plan only and stays inside what the spec requires.

**Plan base:** `origin/main` `09d519c46f1fb72a5ec1fefa2801b859b9ab98ec`, the PR #346 merge commit.

- The source was inspected at `3cfa72a0`.
- Nothing under `IDEA1-AEGIS_Drive_LC/` changed between `912b1800` (the spec base), `3cfa72a0` and `09d519c4`, so every `file:line` reference is still valid.

> **For agentic workers:** execute task by task with strict TDD (RED → GREEN → commit), and only after Human approval of this plan. Each task keeps its RED/GREEN substeps and evidence even where tasks were consolidated.

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
| `src/lib/zipStreamWriter.js` | NEW | Pure ZIP writer; also exports the pure predicate `needsZip64End` (spec §7, §8) |
| `src/lib/bulkDownloadPlan.js` | NEW | Synchronous pure plan step, plus `zipLayout`, the exact-length formula, which uses the writer's `needsZip64End` (spec §4, §6, §7.3, §12, §14) |
| `src/lib/bulkZipDownload.js` | NEW | One orchestrator (phase machine) plus two **two-phase** sources, `filesEntrySource` and `vaultV2EntrySource` (spec §10, §11, §13, §14, §16–§20) |
| `src/lib/api.js` | MOD | `apiFetchStream` |
| `src/lib/vaultChunkedDownload.js` | MOD | Extract `authenticateVaultV2Entry` (behaviour-preserving) |
| `src/screens/VaultTreeScreen.jsx`, `src/screens/Files.jsx` | MOD | Wiring |
| `src/components/vault/VaultDialogs.jsx`, `VaultTransferPanel.jsx` | MOD | Confirmation dialog, panel stages and reasons |
| `src/lib/strings.js` | MOD | en/th/zh keys |
| `scripts/zip-acceptance/**` (IDEA1) | NEW | Acceptance tooling only, per PR-2. Not executed. |

**Tech:** React 19, Node 24 `node:test` (with `mock.timers` and `t.mock.method`), jsdom plus the Vite SSR harness, real WebCrypto, and the existing `hash-wasm` `createCRC32()`.

## Facts verified while preparing the plan

These were read from source and the installed packages; nothing was assumed.

- **CRC behaviour:** `hash-wasm` `createCRC32()` returns `cbf43926` for `"123456789"` and `00000000` for empty input. `digest()` resets the hasher, and calling `digest()` again without `init()` throws, so the writer calls `init()` for every entry.
- **CRC of all-zero data is zero at this exact length.** The CRC-32 of exactly `0xFFFFFFFF` zero bytes is `0x00000000`. This was verified with Python `zlib.crc32`; for comparison, `0xFFFFFFFE` zero bytes give `0x0F6A7026`, and 1 zero byte gives `0xD202EF8D`. A zero-filled synthetic source would therefore hide a writer that never calls `update()` in Case A. I-1 removes this blind spot.
- **Reference CRCs for the non-zero pattern** `byte(p) = (p * 167 + 13) & 0xFF`:
  - The pattern has period 256, which divides 1 MiB, so one reused 1 MiB buffer reproduces it exactly, and a final partial chunk is `buffer.subarray(0, k)`.
  - The values were derived independently and agree across three implementations:

    | Length (bytes) | CRC-32 |
    |---|---|
    | `0xFFFFFFFF` | `0xBA5A5BB3` |
    | `0xFFFFFFFE` | `0x8507C66D` |
    | `256` | `0xD20B5F2B` (cheap sanity vector for the pattern generator) |

  - Primary derivation: Python 3.11.9 standard-library `zlib.crc32` (IEEE, reflected `0xEDB88320`), streamed in 1 MiB slices:

    ```python
    import zlib
    MiB = 1 << 20
    buf = bytes(((p * 167 + 13) & 0xFF) for p in range(MiB))
    def crc_of(n):
        c, left = 0, n
        while left:
            k = min(MiB, left); c = zlib.crc32(buf if k == MiB else buf[:k], c); left -= k
        return c & 0xFFFFFFFF
    print(hex(crc_of(0xFFFFFFFF)), hex(crc_of(0xFFFFFFFE)), hex(crc_of(256)))
    # 0xba5a5bb3 0x8507c66d 0xd20b5f2b
    ```

  - Cross-checks: Node 24.14.0 `zlib.crc32` and `hash-wasm` 4.12.0 `createCRC32()` give identical values.
  - Speed: `hash-wasm` hashed each 4 GiB stream in about 1.8 s on the development machine (2026-10-05).
- **Key imports are countable without ESM spies.** `unwrapVaultV2Dek` imports each data key through `subtle.importKey('raw', …, {name:'AES-GCM'}, …)`, where `subtle` is `globalThis.crypto.subtle`, a mockable object (`src/lib/vaultChunkCrypto.js:78,148-150,296-308`). Chunk and metadata decryption call `subtle.decrypt`, never `importKey`.
- **Test harness stubbing:** `tests/helpers/vaultScreenHarness.js` swaps these specifiers for the fixture: `'../lib/vaultChunkedDownload.js'`, `'../lib/api.js'`, `'./api.js'`, `'./vaultChunkCrypto.js'`. It does **not** swap `'./vaultChunkedDownload.js'`. Task 11 fixes this.
- **Fixture download behaviour:** the fixture `downloadVaultV2` writes `[1,2,3,4]` per chunk unless `respondBytes` or `downloadImpl` is set, and it calls `sink.close()` itself, as the real module does.
- **Files has no notice area:** `Files.jsx` has no aria-live notice region, and its `actionError` only renders inside the Rename/Move dialogs.
- **Validation scripts:** `validate-vault.mjs` and `validate-collaboration-policy.mjs` are in the repository-root `scripts/`.

## Conventions

- **Working directory:** commands run from `IDEA1-AEGIS_Drive_LC/` unless noted. `T` means `node --test --test-concurrency=1`.
- **Branch:** one implementation branch, `feat/idea1-multi-file-streaming-zip`, created from `main` after this plan is approved. One Pull Request, and exactly one final receipt at closeout (Task 14).
- **RED evidence base:** spec §23 says RED evidence is recorded against `912b1800`. IDEA1 is byte-identical between `912b1800` and the implementation base, so RED is recorded against the actual implementation base. Both SHAs and the "no IDEA1 drift" fact go in the receipt.
- **Commit trailer:** `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

## Mandatory clarifications (plan-only; the spec text is unchanged)

### C-1: `startOffset` is a test-only virtual logical position

1. `startOffset` (writer option, default `0`) and the matching parameter of `zipLayout()` are **unit-test seams only**.
2. With `startOffset = S`, the writer's logical position starts at `S`. Every offset it computes or emits is an **absolute logical position that already includes `S`**. That covers each local-header offset `oᵢ`, `cdStart`, the ZIP64 EOCD record offset in the locator, and the ZIP64 decisions `offZ64ᵢ = oᵢ ≥ 0xFFFFFFFF` and `cdStart ≥ 0xFFFFFFFF`.
3. The spec §7.3 formula is evaluated with `o₀ = S`, so `total` is the logical end position. The counting sink physically receives `total − S` bytes. Every simulated-offset test asserts `S + countingSink.count === zipLayout(entries, { startOffset: S }).total`.
4. **Production ZIP output always starts at logical offset 0.**
5. **No production caller may pass `startOffset`.** This is proven **behaviourally**, not by text scans (Task 6):
   - the production orchestrator path is run with a spy `createWriter`, and its options contain no `startOffset` key;
   - the first local-header signature is at physical byte 0;
   - the physical output size equals `zipLayout(entries).total`.

### C-2: Acceptance is not executed by this plan task

- **Reader acceptance** (spec §24 reader gate R1–R3, and the A1–A12 matrix) is **NOT executed**. The implementation PR only builds the tooling (Task 14), and running it is a separate later task.
- **Memory acceptance** (spec §24 A11, section L) is **NOT executed**. Task 14 documents the procedure only.
- Real archives larger than 4 GiB are produced only in that later acceptance task: R2/A5 (size-ZIP64) and R3/A6 (offset-only ZIP64), through the real app and the required readers.

### C-3: Production deployment is a separate later task

- Neither this plan PR nor the implementation PR deploys or mutates Production.
- Trash #319, Download UX #334 and the future ZIP implementation will later deploy together in **one Drive release**.
- That deployment and its Production acceptance are separate tasks with their own authorization.

---

## Plan review items PR-1 to PR-4: recommendations recorded, final Human approval pending

These recommendations follow Codex's review. They are **not** implementation authorization. The Human Owner approves or changes them when approving this plan.

| Item | Recommendation | Consequence in this plan |
|---|---|---|
| **PR-1** `BULK_ZIP_ENABLED` landing and default | **`false` on implementation landing.** Spec §25 makes `true` the default only *after* acceptance. The implementation can merge safely disabled. The later acceptance task flips it to `true` on the candidate build and runs reader and memory acceptance there; the accepted build is the one deployed. | `BULK_ZIP_ENABLED = false` (Task 2). Both screens take a test-injectable prop `bulkZipEnabled = BULK_ZIP_ENABLED` (Tasks 11 and 12). Screen tests inject `true`, and one test per screen pins the default-off behaviour. |
| **PR-2** Acceptance tooling location | **Option A:** `IDEA1-AEGIS_Drive_LC/scripts/zip-acceptance/`, inside IDEA1-owned tooling scope. | Task 14. The implementation PR stays inside IDEA1. This plan PR itself is `integration-review: yes` because the plan file lives under the shared `docs/superpowers/plans/` (M-8). |
| **PR-3** 4 GiB test strategy | **Option A with bounded physical memory.** Logical full-length synthetic streaming for the size boundaries; one reused ≤ 1 MiB **non-zero** pattern buffer; a real CRC against hard-coded independent constants; a 30 s targeted timeout; no 4 GiB allocation. Other unit tests stay synthetic or counting where equivalent. | Task 3 (I-1). Real >4 GiB archive files are produced only later, for acceptance (C-2). |
| **PR-4** Task and commit granularity | **15 execution tasks including the baseline; 14 intended commits**, using the Codex grouping. RED/GREEN substeps and evidence are preserved inside each task. | This document's structure. |

---

## Shared contracts (decided by this revision; referenced by tasks)

### SC-1: Two-phase entry source (I-3)

```
source.preflight?(plan, signal)            // Vault only; absent for Files (see SC-4)
  -> { ok:true, effectivePlan } | { ok:false, reason, index }

source.open(entry /* an EFFECTIVE entry, SC-4 */, signal)
  -> { ok:false, reason }
   | { ok:true, size, pump(entrySink, signal) -> { ok:true } | { ok:false, reason },
       dispose(reason) }                    // idempotent; aborts fetch / releases reader
```

The orchestrator's order for each entry is fixed. `entry` is always an entry of the **effective plan** (SC-4), and `entry.size` is always the **effective, authoritative** size. No comparison is ever made against a stale provisional size.

1. `opened = await source.open(entry, signal)`. A failure means the archive fails, no local header is written, and the next entry is never opened.
2. Check `opened.size === entry.size`, the effective size. A mismatch leads to `opened.dispose('size-mismatch')` and an archive failure, still with no local header.
3. `entrySink = writer.addEntry({ name: entry.name, size: entry.size })`. **This is the first byte of this entry's local header.**
4. `res = await opened.pump(entrySink, signal)`.
5. `await entrySink.close()`.

**Ownership of an opened handle (Fix E).** Once `source.open()` returns `{ ok:true }`, the orchestrator owns the handle until that entry completes, meaning `entrySink.close()` has resolved. Any failure in between causes the orchestrator to call **`opened.dispose(reason)` exactly once**, before the archive abort path runs:

| Failure after a successful `open()` | `dispose` reason | Then |
|---|---|---|
| `opened.size !== entry.size` | `'size-mismatch'` | No `addEntry`, archive abort, no next entry, no close |
| `writer.addEntry()` throws | the mapped archive reason: `'localDiskFull'` for `QuotaExceededError`, otherwise `'write'` | **No `pump`**, archive abort, no next entry, no close, no success |
| Cancel, lock or `isPurged()` observed between `open` and `pump` | `'cancelled'` | No `addEntry` or `pump`, archive abort |
| `pump` returns `{ ok:false }` or throws | `res.reason` (or `'write'` / `'failed'`) | Archive abort. The source has usually cleaned itself up already; `dispose` is idempotent. |
| `entrySink.close()` throws (descriptor write, count mismatch) | the mapped archive reason | Archive abort |

For Files, `dispose` runs the same synchronous cleanup as every other Files failure: it aborts the fetch immediately, cancels the reader without awaiting if one was acquired, and never acquires a reader if `pump` never started. For the Vault, `dispose` is a no-network no-op that marks the entry finished.
   - `close()` is idempotent: the first call verifies `count === size`, writes the data descriptor once, and records the central entry.
   - It never closes the archive.
   - `downloadVaultV2` already calls `sink.close()` itself after its own abort check. The orchestrator's call is then a no-op.

`entrySink.abort()` is a no-op on the archive. The orchestrator alone owns the single archive `abort()` attempt (spec §20).

**CRC lives only in the writer (M-6).** `entrySink.write(bytes)` runs: overflow check, then `hasher.update`, then archive write, then count. Sources never create or touch a hasher.

### SC-2: Transfer busy vs dialog hold (I-2)

Two distinct states per screen:

| State | Owner | Set | Released | Blocks |
|---|---|---|---|---|
| **Transfer busy** (`downloadBusyRef`, Vault and Files) | `runBulkZip`; on the Vault also the existing 1–3 per-file loop. The Files 1–3 anchor path stays fire-and-forget (spec §4) and does not set it. | By `runBulkZip`, synchronously, **immediately before** `showSaveFilePicker` (after its own synchronous `isPurged` and signal checks); by the Vault per-file loop as today | In `runBulkZip`'s `finally`; at the end of the Vault per-file loop | A second transfer: announce busy, no picker |
| **Dialog hold** (`zipDialogHoldRef`, Vault only) | `VaultTreeScreen` | When the plaintext-export dialog opens | On Cancel, Escape, lock/purge, dialog close for any reason, and synchronously on Confirm just before calling `runBulkZip` | A second dialog or another bulk/tile download action while the dialog is open: announce busy |

The Vault Confirm sequence is:

1. Confirm click.
2. Synchronous checks only: `isPurged()`, the dialog plan exists, transfer busy is false.
3. Release the dialog hold.
4. Call `runBulkZip({ busyRef: downloadBusyRef, … })`, which claims transfer busy synchronously.
5. The first `await` is `showSaveFilePicker()`.

There is **no await before the picker**. Because the dialog hold is not the transfer busy ref, the hold never blocks Confirm.

### SC-3: Immutable plan copies (I-4)

- `planBulkDownload` builds **new plain objects**. It never freezes or mutates manifest nodes, the `blobIndex` `Map`, blob records, `files` listing rows, or any React state object.
- Each plan entry copies only the scalar fields the ZIP needs:
  - **Files:** `{ id, name /* assigned */, size }`.
  - **Vault:** `{ nodeId, name /* assigned, from manifest */, size /* PROVISIONAL */, manifestPlainSize /* raw copy of node.plainSize, no coercion; may be undefined */, blobRef: { formatVersion, id }, blob: { id, formatVersion, size, chunkSize, chunkCount, contentIdB64, wrappedDekB64, wrapIvB64, metaIvB64, metaB64 } }`.
    - The Vault `size` in the original plan is **provisional**: `manifestPlainSize` if it is a safe non-negative integer, otherwise `estimatedPlainSize(blob)`.
    - It is used **only** for pre-picker decisions (the provisional no-FSA buffered/refuse decision) and the confirmation dialog's displayed total. After pre-flight it is never used for byte counts (SC-4).
- The copies (and the plan, its `entries` array and each nested copy) are `Object.freeze`d.
- The **same frozen `blob` copy** is used for pre-flight, streaming and display:
  - pre-flight authenticates `entry.blob`;
  - the effective entry (SC-4) carries the **same `blob` object reference**, and `downloadVaultV2` receives it (spec §11, "same in-memory `blob` object used in pre-flight");
  - progress names and archive names come from `entry.name`.

### SC-4: Effective plan (Fix C, Fix D)

- **Original frozen plan.** Built synchronously from screen or listing data by `planBulkDownload`. It is **never mutated**. It drives the threshold, the refusals, the dialog and the provisional transport decision.
- **Vault pre-flight** (`vaultV2EntrySource.preflight`, Task 8):
  - authenticates every envelope;
  - validates each authenticated `plainSize` strictly (`Number.isSafeInteger(x) && x >= 0`, no coercion);
  - compares any `manifestPlainSize` (which must itself be a safe non-negative integer and equal);
  - retains **no DEK or `CryptoKey`**;
  - returns a **new frozen effective plan**, in which each effective entry is a new frozen object `{ ...identity fields, name, blob /* same reference */, size: authenticatedPlainSize }`.
- **Normal Files:** `effectivePlan` is the original frozen plan. Listing sizes are confirmed per entry by `open()` against `Content-Length` before any header is written.
- **After pre-flight the orchestrator runs, in order:**
  1. `layout = zipLayout(effectivePlan.entries)`.
  2. Assert `effectivePlan.entries.length === plan.entries.length` (≤ `MAX_ZIP_ENTRIES`).
  3. On the buffered path, re-check `layout.total ≤ 64 MiB`, otherwise `too-large`.
  4. **Only then** `createWritable()` (FSA) or create the buffered sink.
  5. Entries stream.
- **The effective plan is the single authority** after pre-flight for:
  1. `zipLayout` and the exact archive length;
  2. local-header size decisions;
  3. the ZIP64 size decision;
  4. the `opened.size === entry.size` check;
  5. the payload total;
  6. the progress denominator (`totalBytes`);
  7. the no-FSA 64 MiB archive-policy check;
  8. the entry metadata passed to `writer.addEntry`.
- The original plan remains available only for UI and selection identity, such as the dialog snapshot and the failed-entry name lookup by index. It is never used for authoritative byte counts after Vault authentication.

---

## Task 0: Baseline by failing test names (no commit) (M-7, Fix F)

**[RUN ON: WINDOWS — GIT BASH]**

The baseline, and its head re-runs in Tasks 13b and 14b, run in **Git Bash from Git for Windows**. They are **not** run in PowerShell and **not** in WSL. The commands use Bash syntax and the coreutils that ship with Git for Windows (`timeout`, `comm`, `sort`, `sed`, `grep`).

- [ ] Record the environment separately from the results, into `env.txt`: `node --version`, `npm --version`, `git --version`, `uname -a`, `echo $SHELL`, and the base commit SHA.
- [ ] On the implementation branch, before any change, run every affected suite **per file**, recording names rather than counts. The `run-named.sh` script lives in the scratchpad and is not committed:

```bash
# [Git Bash] run-named.sh <outfile-prefix>
for f in tests/vault*.test.js tests/preview*.test.js tests/i18n*.test.js tests/workspace*.test.js \
         tests/transfer*.test.js tests/files*.test.js tests/trash*.test.js tests/protectedTrash*.test.js; do
  start=$(date +%s)
  timeout 900 node --test --test-reporter=tap "$f" > "$1.$(basename "$f").tap" 2>&1; code=$?
  echo "$f exit=$code secs=$(( $(date +%s) - start ))" >> "$1.runs.txt"
  grep -E '^\s*not ok ' "$1.$(basename "$f").tap" | sed -E "s#^\s*not ok [0-9]+ - #$f :: #" >> "$1.failing.txt"
  grep -E '# SKIP' "$1.$(basename "$f").tap" | sed -E "s#^\s*ok [0-9]+ - #$f :: #" >> "$1.skipped.txt"
done
sort -u -o "$1.failing.txt" "$1.failing.txt"
```

- [ ] Save `base.failing.txt`, `base.skipped.txt` and `base.runs.txt`.
- [ ] **Record environment anomalies separately, never as failures:**
  - Postgres skips (no PG environment on Windows);
  - long-lived test processes (`exit=124` from `timeout`);
  - OOM-prone suites (`exit=134`, or heap errors in the TAP output);
  - force-exit artifacts (a process killed after its tests passed).
- [ ] The same script with prefix `head` runs in Tasks 13b and 14b, also in Git Bash. **Acceptance: `BASE_FAILING_TEST_NAMES` = `base.failing.txt`, `HEAD_FAILING_TEST_NAMES` = `head.failing.txt`, and `HEAD_ONLY_FAILURES = comm -13 base.failing.txt head.failing.txt | wc -l` must be `0`.** The aggregate failure count is never used alone; it is informational only.

---

## Task 1: Entry names (sanitise and duplicates)

- **Files:** create `src/lib/zipEntryNames.js`.
- **Test first:** create `tests/zipEntryNames.test.js`.
- **1a RED, `sanitizeZipEntryName`:**
  - `../x` → `.._x`, and `..` alone → `_`.
  - `a/b\c` → `a_b_c`; `:*?"<>|` each → `_`.
  - C0/C1 controls (U+0000–1F, U+007F–9F) → `_`.
  - `  x  ` → `x`; `name.` and `name...` → `name`; `.` → `_`.
  - `CON`, `con.txt`, `COM¹`, `LPT0.log` → `_`-prefixed; `CONSOLE.txt` unchanged.
  - `''`, `'   '`, `'...'` → `file`.
  - The NFD form of `é` comes out as NFC.
  - Thai, CJK and emoji names round-trip unchanged.
  - A 300-byte Thai name with `.pdf` → at most 255 UTF-8 bytes, ends in `.pdf`, and is cut on a code-point boundary (`TextDecoder` with `fatal: true` does not throw).
  - An extension over 32 bytes is not preserved.
  - A non-string input is converted with `String()`.
- **1b RED, `assignZipEntryNames`:**
  - `['A.txt','a.txt']` → `['A.txt','a (2).txt']`.
  - Three copies → `(2)`, `(3)`.
  - `['x.txt','x (2).txt','x.txt']` → the third becomes `x (3).txt`.
  - `.env` twice → `.env (2)`.
  - `archive.tar.gz` → `archive.tar (2).gz`.
  - NFC and NFD forms collide.
  - A 255-byte name plus a suffix is re-truncated to at most 255 bytes and stays unique.
  - Output is deterministic and in plan order.
- **RED command:** `T tests/zipEntryNames.test.js`
- **Expected RED:** 1a `ERR_MODULE_NOT_FOUND`; 1b `assignZipEntryNames is not a function`.
- **Minimal implementation:**
  - Spec §5 steps 1–7, in order.
  - Duplicates: a `taken` Set of `toLowerCase()` keys; on a collision, loop `k = 2…` with `stem (k).ext`, re-truncating, and check every candidate.
- **GREEN command:** same. **Expected:** all pass.
- **Regression:** `T tests/i18nCopyAudit.test.js`.
- **Commit 1:** `feat(idea1): sanitize and de-duplicate ZIP entry names`

## Task 2: ZIP64 end predicate, exact layout, and the bulk plan

- **Files:**
  - create `src/lib/zipStreamWriter.js` (this task exports only `needsZip64End`; the writer comes in Task 3);
  - create `src/lib/bulkDownloadPlan.js`.
- **Test first:** create `tests/zipStreamWriter.test.js` (predicate section) and `tests/bulkDownloadPlan.test.js`.
- **2a RED, pure predicate (I-5).** `needsZip64End({ entryCount, cdSize, cdStart })` is true iff `entryCount ≥ 0xFFFF || cdSize ≥ 0xFFFFFFFF || cdStart ≥ 0xFFFFFFFF`. Each boundary is tested independently with the other two inputs at 0:

  | Input | Value | Expected |
  |---|---|---|
  | `entryCount` | `0xFFFE` | `false` |
  | `entryCount` | `0xFFFF` | `true` |
  | `cdSize` | `0xFFFFFFFE` | `false` |
  | `cdSize` | `0xFFFFFFFF` | `true` |
  | `cdStart` | `0xFFFFFFFE` | `false` |
  | `cdStart` | `0xFFFFFFFF` | `true` |

  No test generates millions of entries to reach the `cdSize` trigger.
- **2b RED, `zipLayout(entries /* {nameBytes,size} */, { startOffset = 0 } = {})`:**
  - **One entry,** `n=5`, `s=3` → `total = (30+5+3+16)+(46+5)+22 = 127`.
  - **Zero-byte entry:** `L=30+n`, `D=16`.
  - **`s=0xFFFFFFFF`:** `sizeZ64`, `L=50+n`, `D=24`, `k=2`, `C=46+n+20`, plus 76 bytes for the ZIP64 end records.
  - **`s=0xFFFFFFFE`:** not `sizeZ64`.
  - **Offset-only via `startOffset` (C-1):** a local header at `0xFFFFFFFF` → `offZ64`, `k=1`, `C=46+n+12`; at `0xFFFFFFFE` → classic.
  - **Predicate use:** in every vector, `layout.z64End === needsZip64End({ entryCount, cdSize, cdStart })` for the computed values. The layout uses the predicate, it does not re-implement it.
  - **C-1:** every reported offset includes `S`.
- **2c RED, `planBulkDownload({ source, items, resolve, fsa, enabled = BULK_ZIP_ENABLED, now })`:**
  - **Counts:** 0 → `none`; 1, 2, 3 → `per-file`; 4 and 1000 → `zip`; 1001 → `refused/'too-many'`.
  - **Folders:** 3 files + 2 folders → per-file with `skippedFolders:2`. 4 files + 1 folder → zip with `skippedFolders:1`.
  - **Unavailable before the threshold (M-5):**
    - Files ids missing from the listing count as `unavailable`.
    - **A Vault file node whose `blobRef` is missing, or whose blob is absent from `blobIndex`, also counts as `unavailable`.**
    - Both are filtered **before** the threshold, so 4 nodes with one missing blob → per-file with `unavailable:1`.
  - **D-1:** 4+ Vault entries including V1 → `refused/'v1-in-zip'`; 3 including V1 → per-file.
  - **No-FSA (provisional, plan-time decision; the Vault re-checks against the effective plan in SC-4):** `zipLayout(original entries).total ≤ 64 MiB` → `buffered`. Above that: Files → per-file with `fallbackNotice:'no-fsa-large'`, Vault → `refused/'too-large'`. The boundary is `64 MiB` vs `64 MiB + 1`.
  - **FSA:** `transport:'fsa'`.
  - **Feature flag:** `enabled:false` → per-file for every `n`. `BULK_ZIP_ENABLED === false` (PR-1 recommendation).
  - **Archive name:** `suggestedName` is `AEGIS-Files-YYYYMMDD-HHmmss.zip` or `AEGIS-Vault-export-YYYYMMDD-HHmmss.zip`, in local time from an injected `now`.
  - **Constants:** `ZIP_THRESHOLD === 4`, `MAX_ZIP_ENTRIES === 1000`.
  - **Vault provisional sizes (SC-3):**
    - the **original-plan** (provisional) `entry.size` is `node.plainSize` when it is a safe non-negative integer, otherwise `estimatedPlainSize(blob)`. After pre-flight it is superseded by the effective entry's authenticated size (SC-4);
    - `entry.manifestPlainSize` is the **raw** `node.plainSize` copied without coercion: `123` stays `123`, `"123"` stays `"123"`, and a missing value stays `undefined`;
    - the plan never validates or rejects on `manifestPlainSize`; that is pre-flight's job (Task 8).
  - **Immutable copies (I-4, SC-3):**
    - `Object.isFrozen(plan)`, `plan.entries`, and every entry and nested `blob` copy are frozen;
    - **the original nodes, blob records and Files rows passed in are still `Object.isExtensible` and unfrozen afterwards**;
    - mutating an original blob record after planning leaves the plan copy unchanged;
    - `plan.entries[i].blob !== originalBlob`.
- **RED command:** `T tests/zipStreamWriter.test.js tests/bulkDownloadPlan.test.js`
- **Expected RED:** `ERR_MODULE_NOT_FOUND` for 2a, 2b and 2c in turn.
- **Minimal implementation:**
  - `needsZip64End` is pure.
  - `zipLayout` is a forward pass of §7.3 with `o₀ = startOffset` (JSDoc marks it test-only), assigning `z64End = needsZip64End(...)`.
  - `planBulkDownload` is synchronous: filter, count, refuse, assign names, copy and freeze (SC-3), run `zipLayout` with the default offset, and choose the transport.
- **GREEN command:** same.
- **Regression:** `T tests/zipEntryNames.test.js`.
- **Commit 2:** `feat(idea1): plan bulk downloads with exact ZIP layout and ZIP64 predicate`

## Task 3: ZIP writer (core, size-ZIP64, offset-only, misuse)

- **Files:** modify `src/lib/zipStreamWriter.js`.
- **Test first:** extend `tests/zipStreamWriter.test.js` with:
  - an in-test parser and extractor;
  - a **counting sink** that counts every byte and keeps only the requested regions;
  - a **pattern source** that yields one reused ≤ 1 MiB buffer filled with `byte(p) = (p*167+13) & 0xFF` (period 256), with a final partial chunk of `buf.subarray(0,k)`;
  - a **counting hasher wrapper** `createHasher: async () => wrap(await createCRC32())` that records `hashedBytes` (the sum of `update` lengths) and `updateCalls`.
- **3a RED, core records:**
  - CRC vectors: `"123456789"` → `0xCBF43926`; empty → `0`.
  - Pattern sanity: 256 pattern bytes → `0xD20B5F2B`.
  - Round trip: 3 entries, one of them 0 bytes:
    - signatures `0x04034b50`, `0x08074b50`, `0x02014b50`, `0x06054b50`;
    - flags `0x0808`, method 0, version made by 45 with host 0, version needed 20;
    - local CRC and sizes are 0;
    - descriptors are 16 bytes with real values;
    - the zero-byte entry has CRC 0, sizes 0 and a 16-byte descriptor;
    - DOS time and date are identical across entries (injected `now`);
    - no extra fields, no comment, attributes 0;
    - the bytes extract exactly.
  - Thai, CJK and emoji names are UTF-8 with bit 11 set.
  - **Production offset 0:** a writer created without `startOffset` has its first local-header signature at physical byte 0 and central local-header offset 0 for the first entry, and the physical length equals `zipLayout(entries).total`.
  - Python cross-check: `zipfile` `testzip()` returns `None` if `python` exists (skipped, and says so, when it is absent).
- **3b RED, size-ZIP64 Case A (I-1, PR-3):** one entry of declared size `0xFFFFFFFF`, streamed from the pattern source into the counting sink, timeout **30 s**.
  - **CRC:** the descriptor CRC and the central CRC both equal the hard-coded **`0xBA5A5BB3`**.
  - **Hashed bytes:** `hashedBytes === 0xFFFFFFFF` (= declared size) and `updateCalls > 0`.
  - **Records:**
    - local sizes `0xFFFFFFFF`, a 20-byte local ZIP64 extra (zeros), version 45;
    - a 24-byte descriptor with 8-byte sizes;
    - central sizes `0xFFFFFFFF` with an extra containing uncompressed then compressed size, version 45;
    - ZIP64 EOCD (56 bytes, record size 44, versions 45/45) and locator (20 bytes) present, classic EOCD offset `0xFFFFFFFF`;
    - `count === zipLayout(...).total`.
  - **Boundary `0xFFFFFFFE`:** the same pattern and timeout. CRC = hard-coded **`0x8507C66D`**, `hashedBytes === 0xFFFFFFFE`, a classic entry (16-byte descriptor, version 20), and end records exactly as `needsZip64End` evaluates the computed `cdStart`/`cdSize`.
  - **Why this cannot pass falsely:**
    - if `update()` is never called, `hashedBytes` is 0 and the CRC would be `0x00000000`;
    - if fewer bytes are hashed, `hashedBytes` falls short of the declared size;
    - if the CRC is wrong, it does not match the independent constant.

    Each of these fails the test. Memory stays at about 1 MiB, and nothing allocates 4 GiB.
- **3c RED, offset-only Case B and misuse:**
  - **Case B:** a 5-byte pattern entry with `startOffset` chosen so its local header is at logical `0xFFFFFFFF` (C-1).
    - Real 32-bit sizes; the local header has no extra and version 45.
    - The descriptor is 16 bytes.
    - The central offset field is `0xFFFFFFFF`, and the central extra has data size 8 and contains only the offset, which equals the true logical offset including `S`.
    - Central version 45, ZIP64 end records present.
    - `S + count === zipLayout(..., {startOffset:S}).total`.
    - At `0xFFFFFFFE` it is classic.
  - **Predicate wiring:** a `cdStart`-triggered case at `0xFFFFFFFE`/`0xFFFFFFFF` via `startOffset` produces end records exactly when `needsZip64End` says so. The predicate's own boundaries are already pinned in 2a.
  - **Misuse:**
    - writing beyond the declared size throws, and none of those bytes are written;
    - `finish()` with an entry whose `close()` was not called throws;
    - a second `addEntry` while one is open throws;
    - `close()` with `count !== size` throws;
    - `close()` is idempotent: the second call writes nothing;
    - a hasher throw propagates;
    - the writer never calls `sink.close` or `sink.abort`.
  - **No test asserts a ZIP64 entry without ZIP64 end records** (spec §7.2).
- **RED command:** `T tests/zipStreamWriter.test.js`
- **Expected RED:** 3a `createZipStreamWriter is not a function`; 3b and 3c fail on the ZIP64 field, extra and descriptor assertions.
- **Minimal implementation:** `createZipStreamWriter({ sink, createHasher, now, startOffset = 0 })`.
  - `begin()` awaits `createHasher()`.
  - `addEntry({ name, size })` writes the local header (ZIP64 decisions made here from `size` and `pos`) and returns the SC-1 entry sink:
    - `write`: overflow check, then `hasher.update`, then `sink.write` (skipped when the length is 0), then count;
    - idempotent `close`: verify, write the descriptor, record central;
    - `abort`: no-op.
  - `finish()`: central directory, then `needsZip64End(...) ? ZIP64 EOCD + locator : nothing`, then the classic EOCD with sentinels only on the fields that overflowed.
  - `hasher.init()` runs per entry. Little-endian via `DataView`.
- **GREEN command:** same.
- **Regression:** `T tests/bulkDownloadPlan.test.js`.
- **Commit 3:** `feat(idea1): stream STORE ZIP with descriptors, CRC-32 and ZIP64`

## Task 4: `apiFetchStream`

- **Files:** modify `src/lib/api.js`.
- **Test first:** create `tests/apiFetchStream.test.js` (Node `Response` and `ReadableStream`, with `t.mock.method(globalThis, 'fetch')`).
- **RED tests:**
  - Returns `{ok:true,status,errorKind:null,headers,body}` without reading the body.
  - `credentials:'include'` and the `withBase` path.
  - The caller's signal is passed through, and an abort maps to `'network'`.
  - 401 → `'unauthorized'` and calls the registered handler.
  - 403 → `'forbidden'`; 500 → `'server'`; a thrown fetch → `'network'`.
  - No internal timeout (fake timers advanced 10 minutes).
  - A `null` body is returned as-is.
- **RED command:** `T tests/apiFetchStream.test.js`
- **Expected RED:** `apiFetchStream is not a function`.
- **Minimal implementation:** mirror `apiFetchBytes` (`src/lib/api.js:142-172`) without the timer and without `arrayBuffer`.
- **GREEN command:** same.
- **Regression:** `T tests/apiFetchStream.test.js "tests/files*.test.js" tests/i18nCopyAudit.test.js`.
- **Commit 4:** `feat(idea1): add apiFetchStream for unbuffered same-origin downloads`

## Task 5: Extract `authenticateVaultV2Entry` (behaviour-preserving) (M-2, M-3)

- **Files:** modify `src/lib/vaultChunkedDownload.js`.
- **Test first:** create `tests/vaultAuthenticateEntry.test.js` (real WebCrypto, `lazyV2` pattern).
- **RED tests,** at the correct boundary:
  - `authenticateVaultV2Entry({ kek, blob })` returns `{ ok:true, plainSize }` with no `dek` field.
  - **The authenticated value is preserved exactly (Fix A).** The test builds envelopes whose encrypted metadata carries each of these:
    - `meta.plainSize = 123` → `plainSize === 123` (`typeof` is `'number'`);
    - `meta.plainSize = "123"` → `plainSize === "123"` (`typeof` is `'string'`, not coerced);
    - `meta.plainSize` absent → `result.plainSize === undefined` (no default, no `0`).
  - The helper authenticates and exposes the field. It does **not** validate the field's semantic type; that is Task 8 pre-flight.
  - The wrong KEK or a tampered `metaB64` → `{ ok:false, reason:'wrong-key' }`. These are **exactly the spec §9 results; this helper has no `integrity` reason.**
  - No network: `t.mock.method(globalThis, 'fetch')` records zero calls.
  - Key import count: `t.mock.method(globalThis.crypto.subtle, 'importKey')`, installed after the KEK is imported, records exactly **1** `'raw'` AES-GCM import per call (M-3; no ESM import spying).
- **`prepareVaultV2Download` is unchanged in behaviour.** It still returns `{ ok, dek, sink }` or `no-key | cancelled | picker | too-large-for-memory | wrong-key | destination`. Its assertions stay in the existing #334 suite and are not duplicated here (M-2).
- **RED command:** `T tests/vaultAuthenticateEntry.test.js`
- **Expected RED:** `authenticateVaultV2Entry is not a function`.
- **Minimal implementation:** an internal `unwrapAndAuthenticate(kek, blob) → { dek, meta }`.
  - `authenticateVaultV2Entry` calls it, drops `dek`, and returns `{ ok:true, plainSize: meta.plainSize }`: the authenticated field exactly as decrypted. **No `Number(...)`, no defaulting, no `parseInt`, no coercion.**
  - `prepareVaultV2Download` calls it, keeping its order and reasons.
  - `downloadVaultV2` is unchanged, including its own existing internal arithmetic.
  - The strict semantic validation (`Number.isSafeInteger(x) && x >= 0`) and the manifest comparison belong to the Vault source pre-flight (Task 8), not this helper.
- **GREEN command:** same.
- **Regression (mandatory, #334):** `T tests/vaultDownloadPickerFirst.test.js tests/vaultTreeDownloadProgress.test.js tests/vaultLegacyV2DownloadBusy.test.js tests/vaultTreeBulkDownloadCancel.test.js`, all green.
- **Commit 5:** `refactor(idea1): extract Vault V2 envelope authentication for bulk pre-flight`

## Task 6: Orchestrator (`runBulkZip`)

- **Files:** create `src/lib/bulkZipDownload.js`.
- **Test first:** create `tests/bulkZipOrchestrator.test.js`, with:
  - a fake SC-1 source whose `open`/`pump`/`dispose` are scripted;
  - a fake `scope.showSaveFilePicker` and writable that log every call to one event list (#334 `fakeScope` style);
  - an injected `createWriter` spy that wraps the real `createZipStreamWriter`.
- **RED tests:**
  - **Picker-first (behavioural):** exactly one `showSaveFilePicker` per archive, and the spy has recorded it before `runBulkZip(...)` returns its promise. It receives `{suggestedName, types:[{description:'ZIP archive',accept:{'application/zip':['.zip']}}]}`.
  - **Transfer busy (SC-2):**
    - `busyRef.current === true` → `{ status:'busy' }` synchronously, with no picker;
    - otherwise `busyRef.current` becomes `true` synchronously before the picker call (asserted inside the picker spy) and `false` after settle, whether the run succeeds, fails or is cancelled;
    - single-flight: a second `runBulkZip` while the first is pending → `busy`, with exactly one picker in total.
  - **Ordering:** `picker → hasher → preflight* → createWritable → [open → addEntry → pump → close]* → finish → close`.
  - **SC-1 order and handle ownership (Fix E):**
    - `open` failure → no `addEntry` for that entry (zero local-header bytes) and no next `open`;
    - `opened.size !== entry.size` → `dispose('size-mismatch')` exactly once, no `addEntry`, failure;
    - **`writer.addEntry` throws after a successful `open`** (via a `createWriter` wrapper whose `addEntry` throws; variant: the archive sink rejects the header write with `QuotaExceededError`):
      - `dispose` is called **exactly once**, with `'write'` (variant `'localDiskFull'`);
      - `pump` is never called;
      - one archive abort, no next `open`, no close, no success;
    - Cancel, or `isPurged()` true, between `open` and `pump` → `dispose('cancelled')` exactly once, no `addEntry` or `pump`, abort, no close;
    - `pump` returns `{ ok:false }` → `dispose` called once (idempotent at the source), abort, no close;
    - a successful entry → `dispose` is **not** called.
  - **Effective plan (SC-4, Fix C/D),** using a fake source with `preflight` that returns an effective plan whose sizes differ from the provisional ones. The provisional size is a **sentinel** (`7`), and the authenticated size is `5`:
    - the injected `computeLayout` spy (default `zipLayout`) is called with the **effective** entries, never with the provisional ones;
    - `writer.addEntry` receives `size: 5`; the sentinel `7` never appears in any `addEntry` call;
    - `opened.size` is compared with `5`; an `open` returning `7` fails with `size-mismatch`;
    - `onProgress` `totalBytes` equals the sum of the effective sizes;
    - on the buffered path, the 64 MiB check uses `computeLayout(effective).total` (variant: provisional ≤ 64 MiB but effective > 64 MiB → `too-large`, with no sink writes);
    - the physical total written equals `zipLayout(effective).total`;
    - `effectivePlan.entries.length === plan.entries.length` is asserted before `createWritable`;
    - the original plan object is unchanged (`Object.isFrozen`, same sizes).
  - Without `preflight` (Files shape), the effective plan **is** the original plan (`===`).
  - **Picker and destination failures:** `AbortError` → `cancelled` with zero `open` calls and no `createWritable`; another error → `picker`; a `createWritable` throw → `destination`.
  - **State machine** `picking → preparing → opening → archiving → finishing → finalizing → done|failed|cancelled`:
    - any failure before close leads to exactly one `abort()` and never `close()`;
    - Cancel before close reports `cancelled`;
    - `isPurged()` true between entries or just before close leads to an abort;
    - a `close()` rejection leads to at most one abort and `finalizeFailed`;
    - a `close()` rejection with `QuotaExceededError` leads to `localDiskFull`;
    - `QuotaExceededError` on a write leads to `localDiskFull`, an abort and no close, even when a source swallowed it (a guarded archive sink records the first write error);
    - an `abort()` rejection is swallowed.
  - **Final-write race (#334 lineage):** a signal abort after the last descriptor but before `close` leads to an abort, never a close.
  - **Progress:**
    - stage `preparing`, then `archiving {index,count,name}`, then `finalizing`;
    - `totalBytes` is the payload sum of the **effective** plan (SC-4);
    - `percent = floor(t/T·1000)/10`, never decreasing, at most 99.9 until `close` resolves, then 100;
    - a total of 0 shows 0 and then 100;
    - nothing fires before the picker returns;
    - Cancel is unavailable from `finalizing` on, and a Cancel there is a no-op.
  - **Production offset (C-1, behavioural):** the `createWriter` spy's options object has **no `startOffset` key**, the first archive bytes written are `PK\x03\x04` at physical offset 0, and the physical total written equals `zipLayout(effective plan entries).total`.
  - **Entry failure:** the result carries `{ failedEntry:{ index, name }, reason }`.
- **RED command:** `T tests/bulkZipOrchestrator.test.js`
- **Expected RED:** `ERR_MODULE_NOT_FOUND`.
- **Minimal implementation:** `runBulkZip({ plan, source, scope, busyRef, signal, isPurged, onProgress, createWriter = createZipStreamWriter, computeLayout = zipLayout, createHasher, createRateEstimator, sinks })`.
  - Synchronous prologue: busy check, `isPurged`, signal, claim busy, then `showSaveFilePicker` as the first await.
  - After the hasher: `effectivePlan = source.preflight ? (await source.preflight(plan, signal)).effectivePlan : plan`, then the SC-4 sequence (layout, count assert, buffered cap), then `createWritable` or the buffered sink.
  - Every later step reads only `effectivePlan`.
  - Guarded archive sink, an `abortOnce` flag, the SC-1 per-entry order, and SC-1 handle ownership (`dispose` exactly once on any failure after a successful `open`).
  - `startOffset` is never passed.
- **GREEN command:** same.
- **Regression:** `T tests/zipStreamWriter.test.js tests/bulkDownloadPlan.test.js`.
- **Commit 6:** `feat(idea1): orchestrate one-picker streaming ZIP with fail-closed finalization`

## Task 7: Normal Files source (two-phase, idle timer, cleanup order)

- **Files:** modify `src/lib/bulkZipDownload.js` (add `createFilesEntrySource({ fetchStream = apiFetchStream, idleMs = 60_000 })`). **No hasher parameter** (M-6).
- **Test first:** create `tests/bulkZipFiles.test.js`, with:
  - a scripted fake reader (controllable `read()` promises, plus `cancel` and `releaseLock` spies);
  - an injected `fetchStream`;
  - a counting archive sink;
  - the real writer with the counting hasher wrapper.
- **`open()`:** arm the idle timer, `fetchStream`, clear the timer on headers, check the HTTP result, require `body !== null`, apply the Content-Length policy, check `size === entry.size`. It writes nothing to the ZIP.
- **`pump()`:** acquire the reader, then the read loop: idle timer, overlong check, `entrySink.write`.
- **`dispose()`, and every failure, run the same idempotent `cleanup(reason)`:**
  1. Mark the entry and archive failed.
  2. Clear the timer.
  3. `fetchCtrl.abort()` immediately.
  4. `reader?.cancel(reason).catch(()=>{})`, **never awaited**.
- **7a RED, open phase (I-3):**
  - Content-Length missing, `"12a"`, `""` and `"-1"` → `invalid-length`; `"9007199254740993"` → `invalid-length`; whitespace is trimmed and accepted; a mismatch → `size-mismatch`; `body === null` → `stream-missing`.
  - **For each of these, ZERO local-header bytes are written for that entry:**
    - if it is the first entry, the counting sink's count is still 0;
    - otherwise the count equals the position just after the previous descriptor, and no `0x04034b50` follows it;
    - the next entry's `fetchStream` is **never** called.
  - Network → `network`; 401 → `unauthorized`; 403 → `forbidden`; 500 → `server`, all with the same zero-header and no-next-entry assertions.
  - Happy path: 5 entries, `arrayBuffer` never called, each path `/api/files/:id/download`, extracted SHA-256 equals the source, and the writer's `hashedBytes` equals the declared size per entry. **The CRC is computed only by the writer (M-6).**
- **7b RED, source-idle timer** (`t.mock.timers.enable({ apis:['setTimeout'] })` and a microtask `flush()`):
  - **(a)** no headers for 60 s → `timeout` (open phase, zero header bytes).
  - **(b)** headers, then no positive payload for 60 s → `timeout`.
  - **(c)** after the last positive chunk, only zero-length non-done reads for 60 s → `timeout`; these reads do not extend the deadline.
  - **Each also requires:** `fetchCtrl` aborted, `reader.cancel` called when a reader exists, one abort, no close, and no next `fetchStream`.
  - **Control:** 59 s, then 1 byte, then 59 s → no timeout.
  - **SLOW-SINK:**
    - a chunk arrives at +30 s;
    - the archive `write` is held for 90 s, and no timeout fires;
    - after the write, a chunk at +59 s succeeds;
    - in a variant, no chunk arrives within 60 s after the write → `timeout`.
- **7c RED, cleanup order:**
  - **STALLED-READER-CANCEL:**
    - `reader.cancel` never settles (variant: a rejection delayed 5 s);
    - triggered by `overlong`;
    - a call-order spy shows `fetchCtrl.abort` before `reader.cancel`, and `signal.aborted` is true synchronously inside cleanup;
    - one abort, no close, no next fetch, no success, and `runBulkZip` resolves.
  - **Overlong:** excess bytes are not written.
  - **Early EOF:** `early-eof`.
  - **Archive write throws:** `write`, and a quota error → `localDiskFull`.
  - **Writer hasher throws:** `write`.
  - **Explicit Cancel mid-entry:** `cancelled`.
  - **Idempotent cleanup:** a second trigger does not abort again.
  - **`dispose()` before `pump()`:** the fetch is aborted, and a body reader is never acquired.
- **7d RED, ADDENTRY-FAIL-DISPOSE (Fix E),** with the real Files source and the real orchestrator:
  - entry 1's `open()` succeeds: headers arrive with a valid `Content-Length`, and the body stream is **live** (its reader would block);
  - an injected `createWriter` wrapper makes `writer.addEntry` throw (variant: the archive sink rejects the local-header write with `QuotaExceededError`);
  - **assertions:**
    - the source's `dispose` is called **exactly once** (counting wrapper);
    - the entry's `fetchCtrl.signal.aborted === true` synchronously after `dispose`;
    - `body.getReader` is **never** called, because `pump` never started;
    - entry 2's `fetchStream` is never called;
    - one archive `abort()`, no `close()`, no success, and the reason is `write` (variant `localDiskFull`).
  - Also covered: Cancel, or a size mismatch reported by the orchestrator, between `open` and `pump` produces the same exactly-once `dispose` and the same fetch abort, with no reader acquired.
- **RED command:** `T tests/bulkZipFiles.test.js`
- **Expected RED:** 7a `createFilesEntrySource is not a function`; 7b the timer is absent or fires during the held write; 7c order assertions fail, or a hang (each test has a 5 s timeout); 7d `dispose` is missing on the `addEntry` failure path, so the fetch stays live.
- **Minimal implementation:** spec §10 steps, split exactly along `open`/`pump` per SC-1. The timer is armed only around `await fetchStream` and `await reader.read()`. On a positive read: `received += len`, clear the timer, overlong check, then `await entrySink.write(value)`.
- **GREEN command:** same.
- **Regression:** `T tests/bulkZipOrchestrator.test.js tests/apiFetchStream.test.js`.
- **Commit 7:** `feat(idea1): two-phase Normal Files ZIP source with source-idle timeout`

## Task 8: Vault V2 source (two-phase, pre-flight before `createWritable`)

- **Files:** modify `src/lib/bulkZipDownload.js` (add `createVaultV2EntrySource({ kek, authenticate = authenticateVaultV2Entry, download = downloadVaultV2, isPurged })`).
- **Test first:** create `tests/bulkZipVault.test.js`. This is the module level: real crypto, `lazyV2` with an injected `fetchBytes` passed through `download`. The screen-level D-3 tests are in Task 11.
- **`preflight(plan, signal)` produces the effective plan (SC-4; Fix B and Fix C).** For each original entry, in order:
  1. `auth = await authenticate({ kek, blob: entry.blob })`. A failure → `wrong-key` at `index`.
  2. **Strict authenticated size:** require `Number.isSafeInteger(auth.plainSize) && auth.plainSize >= 0`, with **no coercion**; otherwise `integrity` at `index`.
  3. **Manifest comparison:** if `entry.manifestPlainSize !== undefined`, it must itself satisfy `Number.isSafeInteger(x) && x >= 0` **and** `=== auth.plainSize`; otherwise `integrity`.
  4. Check the signal and `isPurged()` between entries.
  5. The DEK is never returned or kept (`authenticate` returns none).
  - Result: `{ ok:true, effectivePlan }`. This is a **new** frozen plan whose entries are new frozen objects `{ nodeId, name, blobRef, blob /* same reference as the original entry.blob */, size: auth.plainSize }`. The original plan is not mutated.
  - The orchestrator then runs the SC-4 sequence (layout from the effective plan, count assert, buffered-cap re-check) before `createWritable`.
- **`open(entry)`:** `entry` is an **effective** entry. No network. Returns `{ ok:true, size: entry.size /* already authenticated */, pump, dispose }`, keeping the SC-1 shape. `dispose` is a no-op that marks the entry finished.
- **`pump(entrySink, signal)`:** `download({ kek, blob: entry.blob /* the same frozen copy */, sink: entrySink, signal, onProgress })`. A non-ok result maps to `res.reason`, and success also requires `res.bytesWritten === entry.size` (the effective size).
- **RED tests:**
  - **Pre-flight ordering:**
    - every envelope is authenticated before `createWritable`;
    - a bad envelope on entry 3 means no `createWritable` and zero chunk fetches;
    - pre-flight makes no network fetch.
  - **Strict authenticated size (Fix B).** An injected `authenticate` returns each of these as `plainSize`, and every one must give `integrity` before `createWritable`, with zero chunk fetches:

    | Authenticated `plainSize` | Why it is rejected |
    |---|---|
    | `undefined` (missing) | not an integer |
    | `null` | not an integer |
    | `"123"` | a string; no coercion |
    | `"-1"` | a string; no coercion |
    | `1.5` | not an integer |
    | `NaN` | not an integer |
    | `Infinity` | not a safe integer |
    | `-1` | negative |
    | `Number.MAX_SAFE_INTEGER + 1` (`9007199254740992`) | not a safe integer |

    One real-crypto variant encrypts metadata with `plainSize: "123"` and runs it through the real `authenticateVaultV2Entry` (Task 5), proving the end-to-end path rejects it.
  - **Effective size (Fix D):**
    1. Provisional `manifestPlainSize` absent and authenticated size valid → the effective `entry.size` is the authenticated value, even though the provisional `size` came from `estimatedPlainSize` and is deliberately set to a different sentinel in the test.
    2. Provisional `manifestPlainSize` present and equal → success.
    3. Provisional `manifestPlainSize` present and different → `integrity` before `createWritable`.
    4. Authenticated field is a numeric string → `integrity`.
    5. Authenticated field missing → `integrity`.
    6. With spies, the effective size (not the provisional sentinel) is what reaches `zipLayout`, `writer.addEntry`, the progress `totalBytes` and the no-FSA cap check (buffered variant).
    - Also checked: `manifestPlainSize` present but invalid (`"5"`, `-1`) → `integrity`.
    - Also checked: the original plan is still frozen and unchanged, and each effective entry `!==` its original entry.
  - **Keys not retained (M-3):**
    - `t.mock.method(globalThis.crypto.subtle, 'importKey')`, installed after the KEK import, counts exactly **`2 × entries`** `'raw'` AES-GCM imports (pre-flight plus stream);
    - injected counting wrappers record `authenticate` × N and `download` × N;
    - pre-flight results contain no `CryptoKey`.
  - **Same object:** the `blob` argument seen by `authenticate` (original entry) and by `download` (effective entry) for entry *i* is the same object (`===`), the frozen plan copy.
  - **AEAD before the sink:** a tampered chunk in entry 2 leads to one abort, no close, failed name = entry 2, and entry 3 is never fetched. Strict fetch/write alternation.
  - **Zero-byte V2 entry:**
    - one tag-only chunk is fetched and AEAD-verified;
    - a tampered tag makes the archive fail;
    - on success, the extracted entry is 0 bytes with CRC 0 and the archive parses.
  - **Lock and cancel:**
    - lock during pre-flight → no writable;
    - lock mid-entry → abort, no close;
    - lock after the last entry but before close → abort, no close;
    - Cancel → no later entry fetched.
  - **Bytes:** SHA-256 per entry equals the source. **Memory proxy:** `writable.maxHeld` is at most one chunk.
- **RED command:** `T tests/bulkZipVault.test.js`
- **Expected RED:** `createVaultV2EntrySource is not a function`.
- **GREEN command:** same.
- **Regression:** `T tests/bulkZipOrchestrator.test.js tests/vaultDownloadPickerFirst.test.js tests/vaultAuthenticateEntry.test.js`.
- **Commit 8:** `feat(idea1): stream authenticated Vault V2 entries into one ZIP`

## Task 9: No-FSA path and the buffering guard (M-1)

- **Files:** modify `src/lib/bulkZipDownload.js` (add an exported `finalizeBufferedZip`).
- **Test first:** create `tests/bulkZipNoFsa.test.js` and `tests/bulkZipSourceGuard.test.js` (buffering section).
- **9a RED, buffering guard, written first.** It asserts:
  - `src/lib/bulkZipDownload.js` exports `finalizeBufferedZip` (import check);
  - `zipStreamWriter.js`, `bulkZipDownload.js` and `bulkDownloadPlan.js` contain no `arrayBuffer(` and no `apiFetchBytes`;
  - **every `new Blob(` in these files lies inside the source span of `function finalizeBufferedZip`.**
  - **Genuine RED:** before this task the finaliser does not exist, so the export check fails.
- **9b RED, behaviour:**
  - **Files, `total ≤ 64 MiB`:** `createBufferedSink({ limitBytes: 64 MiB })`; the result is a `Blob` of type `application/zip` with the plan's name; one anchor click; `revokeObjectURL` after 10 s (fake timers); the ZIP parses.
  - **Files above 64 MiB:** the orchestrator is not invoked, and the plan is per-file with `fallbackNotice` and no buffering.
  - **Vault, `≤ 64 MiB`:** buffered, and the object URL goes to `registerObjectUrl`.
  - **Vault re-check (SC-4):** within the cap by the provisional plan but above it once authenticated, so `zipLayout(effectivePlan).total > 64 MiB` → `too-large` after pre-flight, with no buffered-sink writes and zero chunk fetches. The cap check reads only the effective plan's layout. If the provisional layout is already above the cap, the Vault is refused at plan time (spec §14), so pre-flight never runs.
  - **Vault above 64 MiB at plan time:** refused, nothing fetched.
  - **Backstop:** a `BUFFER_LIMIT` overrun leads to a failed archive and discarded parts.
  - **No picker** on this path.
  - (The comment-text assertion about the meaning of 64 MiB was dropped. The policy is still stated in a code comment and in section L.)
- **RED command:** `T tests/bulkZipSourceGuard.test.js tests/bulkZipNoFsa.test.js`
- **Expected RED:** 9a `finalizeBufferedZip` export missing; 9b buffered transport missing.
- **Minimal implementation:** `transport:'buffered'` skips the picker and uses the buffered sink, then `finalizeBufferedZip(parts, name, { registerObjectUrl })`.
- **GREEN command:** same.
- **Regression:** same as Task 8.
- **Commit 9:** `feat(idea1): bounded buffered ZIP fallback for browsers without FSA`

## Task 10: Strings, transfer panel, plaintext-export dialog (M-4)

- **Files:** modify `src/lib/strings.js`, `src/components/vault/VaultTransferPanel.jsx` and `src/components/vault/VaultDialogs.jsx`.
- **Test first:** create `tests/bulkZipPanelStrings.test.js` (static render) and `tests/vaultPlaintextExportDialog.test.js` (jsdom through the harness `load`).
- **10a RED, strings.** New keys in en, th and zh pass the `i18nCopyAudit` parity check:
  - `zipArchiving` "File {index} of {count}: {name}"
  - `zipFinalizing`
  - `zipFoldersSkipped` {n}
  - `zipUnavailable` {n}
  - `zipTooManyFiles`
  - `zipV1NotSupported`
  - `vaultZipExportTitle`, `vaultZipExportBody` {count} {size}, `vaultZipExportConfirm` "Save unencrypted ZIP"
  - `xferReasonLocalDiskFull`
  - `xferReasonFinalizeFailed`
  - `filesDownloadBusy`
  - `filesZipLargeFallback`
- **10b RED, panel (M-4):**
  - **`preparing`** (explicit): label `vaultXferPreparing`, Cancel available, rate row reserved.
  - **`archiving`** (explicit): label `zipArchiving` with vars, **included in `measuring`** (the rate row is shown and sampled on archive bytes), Cancel available.
  - **`finalizing`** (explicit): label `zipFinalizing`, the rate row hidden (no bytes moving), and **Cancel not rendered**.
  - Reasons `localDiskFull` and `finalizeFailed` render the new keys, and the Data Lake `noSpace` key is not used for them.
  - Existing stages are unchanged.
- **10c RED, dialog (D-3):** `PlaintextExportDialog`:
  - shows the not-encrypted warning, the count and `fmtBytes(total)`;
  - Confirm (`data-testid="vault-zip-export-confirm"`) calls `onConfirm` synchronously inside the click;
  - Cancel, Escape and the close button call `onClose` only;
  - `usePurgeAwareDialog` calls `onClose` on lock.
- **RED command:** `T tests/bulkZipPanelStrings.test.js tests/vaultPlaintextExportDialog.test.js tests/i18nCopyAudit.test.js`
- **Expected RED:** missing keys, the stage falls through to `vaultXferFailed`, and the dialog export is missing.
- **Minimal implementation:**
  - Add the keys.
  - Panel: `active` includes `archiving` and `finalizing`; `measuring` includes `archiving`; Cancel is shown when `active && stage !== 'finalizing'`.
  - Dialog: follow the `TrashConfirmDialog` pattern.
- **GREEN command:** same.
- **Regression:** `T tests/vaultTreeDownloadProgress.test.js tests/vaultLegacyV2DownloadBusy.test.js tests/vaultTreeBulkDownloadCancel.test.js "tests/i18n*.test.js"`.
- **Commit 10:** `feat(idea1): archive progress stages, plaintext-export dialog and strings (en/th/zh)`

## Task 11: Harness stubs and VaultTreeScreen integration

- **Files:**
  - modify `tests/helpers/vaultScreenHarness.js` (add `'./vaultChunkedDownload.js'` to `STUBBED`);
  - modify `tests/fixtures/vaultScreenBackend.js` (add `authenticateVaultV2Entry`, which honours `metaAuthFails`, and an inert `apiFetchStream`);
  - modify `src/screens/VaultTreeScreen.jsx`: the `startBulkDownload` block (`:486-535`), a new `zipDialogHoldRef`, the dialog render block, the panel props, the purge disposer, and the prop `bulkZipEnabled = BULK_ZIP_ENABLED`.
- **Test first:** create `tests/vaultScreenHarnessStubs.test.js` and `tests/vaultTreeBulkZip.test.js`.
- **11a RED, harness identity guard:** through the harness, `/src/lib/bulkZipDownload.js`'s `./vaultChunkedDownload.js` resolves to the same fixture instance the screen uses (identity check on an exported function), and the fixture exports `authenticateVaultV2Entry`. **Expected RED:** the identity assertion fails because the real module is loaded.
- **11b RED, screen** (renders `VaultTreeScreen` with `bulkZipEnabled` injected as `true`, except where noted):
  - **Per-file path:** 1–3 files still use `treeDownloadEntry` per file, unchanged from #334 (picker count = n).
  - **Default off (PR-1):** with no prop, so `BULK_ZIP_ENABLED = false`, 4 files go per-file.
  - **D-3:** 4+ files open the confirmation with no picker or fetch on open.
  - **Dialog hold (SC-2):**
    - with the dialog open, a second bulk Download, or a tile-menu Download, announces `vaultTreeDownloadBusy` and opens **no second dialog** and no picker;
    - **Confirm is not blocked by the hold:** Confirm calls `showSaveFilePicker` synchronously, exactly once for N = 5;
    - **Cancel releases the hold:** a following Download opens the dialog again;
    - **Escape releases the hold;**
    - **Lock releases the hold** and closes the dialog;
    - **a stale Confirm after lock** (a handler captured before the lock and invoked afterwards) is a no-op, with no picker and no fetch.
  - **`runBulkZip` stays single-flight:** a second Download during the archive announces busy and opens no picker.
  - **Snapshot and copies (I-4):**
    - changing the selection while the dialog is open does not change the saved plan;
    - after planning, the live manifest node and the `blobIndex` blob are still `Object.isExtensible`;
    - a **Rename of one planned node after the dialog closes succeeds** (normal screen behaviour unaffected).
  - **Refusals and counts:**
    - V1 in a 4+ selection → `zipV1NotSupported`, with no dialog;
    - 1001 files → `zipTooManyFiles`;
    - a node whose blob is missing from `blobIndex` is counted unavailable before the threshold (M-5);
    - 4 files + 1 folder → ZIP plus `zipFoldersSkipped`; 2 files + 1 folder → per-file plus the notice.
  - **Panel:** shows `archiving` "File i of N: name"; Cancel aborts with no later entry; Cancel is hidden in `finalizing`; `localDiskFull` and `finalizeFailed` render.
  - **Single-file entry points:** the tile menu and preview `onDownload` stay per-file.
- **RED command:** `T tests/vaultScreenHarnessStubs.test.js tests/vaultTreeBulkZip.test.js`
- **Expected RED:** 11a identity failure; 11b 4+ files loop pickers and no dialog exists.
- **Minimal implementation:**
  - Harness: the one-line `STUBBED` addition plus the two fixture exports (additive).
  - Screen, `startBulkDownload(nodes)`:
    - if `downloadBusyRef.current || zipDialogHoldRef.current`, announce busy;
    - otherwise run `planBulkDownload` synchronously with `resolve` returning a node only when `blobIndex` has its blob;
    - `per-file` keeps the existing loop verbatim, plus the notice; `refused` announces;
    - `zip` sets `zipDialogHoldRef.current = true` and `setDialog({ kind:'zipExport', plan })`.
  - Dialog `onClose` releases the hold. The purge disposer also releases it.
  - Confirm runs the SC-2 sequence: synchronous checks, release the hold, `registerAbort(ctrl)`, then `runBulkZip({ plan, source: createVaultV2EntrySource(...), busyRef: downloadBusyRef, signal: ctrl.signal, isPurged, … })`.
- **GREEN command:** same.
- **Regression:** `T tests/vaultTreeDownloadProgress.test.js tests/vaultTreeBulkDownloadCancel.test.js tests/vaultLegacyV2DownloadBusy.test.js tests/vaultDownloadPickerFirst.test.js "tests/vault*Ui*.test.js" "tests/previewIndex*.test.js" tests/vaultTreeSourceScan.test.js`.
- **Commit 11:** `feat(idea1): save 4+ Vault files as one confirmed streaming ZIP`

## Task 12: Files screen integration

- **Files:** modify `src/screens/Files.jsx`:
  - the bulk Download handler (`:1203-1210`);
  - a `downloadBusyRef` (transfer busy, SC-2; Files has no dialog hold);
  - a `files-bulk-notice` `role="status"` region;
  - a `VaultTransferPanel` import from `components/vault/` (not moved);
  - the prop `bulkZipEnabled = BULK_ZIP_ENABLED`.
- **Test first:** create `tests/filesBulkZip.test.js` (jsdom plus Vite SSR, as in `filesInteractionPolish.test.js`; the stubbed `fetch` returns stream `Response` objects with `Content-Length`).
- **RED tests** (with `bulkZipEnabled` injected as `true`, except where noted):
  - **Per-file path:** 1–3 files click anchors only, unchanged, with no picker.
  - **Default off (PR-1):** with no prop, 4 files click anchors per file.
  - **ZIP path:**
    - 4+ files → `showSaveFilePicker` called synchronously within the click, exactly once, with no dialog;
    - the panel goes `archiving`, then `finalizing`, then 100, then clears;
    - an id missing from the listing is counted as unavailable before the threshold;
    - folders give `zipFoldersSkipped`.
  - **Busy:** a second click announces `filesDownloadBusy`.
  - **Cancel:** Cancel aborts the archive.
  - **Copies (I-4):** the `files` listing rows are still extensible after planning.
  - **No FSA:** above 64 MiB → per-file anchors plus `filesZipLargeFallback`; at or below 64 MiB → one Blob ZIP anchor.
  - **Single-file entry points:** the tile menu and preview `onDownload` stay per-file.
- **RED command:** `T tests/filesBulkZip.test.js`
- **Expected RED:** N anchors, and no picker.
- **Minimal implementation:** `planBulkDownload({ source:'files', …, fsa: supportsStreamingFileSink(), enabled: bulkZipEnabled })`, then dispatch. The zip path calls `runBulkZip` synchronously from the click with `createFilesEntrySource()`.
- **GREEN command:** same.
- **Regression:** `T "tests/files*.test.js" "tests/trash*.test.js" tests/previewFilesWiring.test.js tests/allScreensEmptyState.test.js`.
- **Commit 12:** `feat(idea1): save 4+ Files as one streaming ZIP with a single picker`

## Task 13: Remaining guards and the regression sweep

- **Files:** create `tests/helpers/sourceScan.mjs`; extend `tests/bulkZipSourceGuard.test.js`.
- **13a RED, storage and console guard (M-1, a genuine RED).** The test first runs a **scanner self-check**:
  - `scanForbidden(sourceText)`, imported from `tests/helpers/sourceScan.mjs`, must flag synthetic strings containing `localStorage.getItem`, `sessionStorage`, `indexedDB.open`, `caches.open` and `console.log`;
  - **RED:** the helper module does not exist yet, so the import fails with `ERR_MODULE_NOT_FOUND`.
  - **GREEN:** after the helper is added, the real scan runs over the new modules (`zipEntryNames.js`, `zipStreamWriter.js`, `bulkDownloadPlan.js`, `bulkZipDownload.js`). It is expected to pass on its first run, and that fact is recorded honestly.
- **Guards kept elsewhere:**
  - behavioural picker-first spies (Tasks 6, 11, 12);
  - production offset-0 behaviour (Tasks 3, 6);
  - writer physical length equals `layout.total` (Task 3);
  - buffering primitive guard (Task 9);
  - harness identity guard (Task 11).
- **Dropped as brittle:** the comment-text check for 64 MiB; the text scan from handler start to picker; the "`startOffset` appears only here" text rule; git-diff and package-key checks as unit tests. The last two moved to Task 14 closeout verification.
- **RED command:** `T tests/bulkZipSourceGuard.test.js`
- **Expected RED:** `ERR_MODULE_NOT_FOUND` for `tests/helpers/sourceScan.mjs`.
- **GREEN command:** same, plus `T tests/vaultTreeSourceScan.test.js`.
- **13b regression sweep (M-7). [RUN ON: WINDOWS — GIT BASH]** Run with `run-named.sh head` and compare `BASE_FAILING_TEST_NAMES` with `HEAD_FAILING_TEST_NAMES`:
  - **#334** picker-first, final-write abort race, batch cancel, legacy V2 busy guard: `vaultDownloadPickerFirst`, `vaultTreeDownloadProgress`, `vaultTreeBulkDownloadCancel`, `vaultLegacyV2DownloadBusy`.
  - **Trash #319:** `trashPreviewRoute`, `trashPreviewUi`, `trashDestructiveReauthUi`, `protectedTrash*`.
  - **D-1 preview index:** `previewIndex*`.
  - **Acceptance:** `HEAD_ONLY_FAILURES = comm -13 base.failing.txt head.failing.txt` is **empty**. Environment anomalies (PG skips, long-lived processes, OOM, force-exit) are recorded separately, and each is compared with its baseline entry.
- **Commit 13:** `test(idea1): guard streaming ZIP modules against browser storage and console`

## Task 14: Acceptance tooling (built, NOT executed) and closeout

- **Files (PR-2 recommendation, Option A):**
  - `IDEA1-AEGIS_Drive_LC/scripts/zip-acceptance/make-sources.mjs`
  - `IDEA1-AEGIS_Drive_LC/scripts/zip-acceptance/verify_zip.py`
  - `IDEA1-AEGIS_Drive_LC/scripts/zip-acceptance/README.md`
  - the receipt and the `idea1-status.md` update at closeout.
- **Test first:** create `tests/zipAcceptanceTooling.test.js`.
- **14a RED, tooling:**
  - `make-sources.mjs --set R1 --out <tmp>` writes deterministic pattern files (including a 0-byte file and Thai, CJK, emoji, duplicate and reserved names) plus `manifest.json` (name, size, SHA-256). Large sets are streamed, never held in memory.
  - `--set R2 --dry-run` prints one file of at least 4.1 GiB plus 3 small files.
  - `--set R3 --dry-run` prints 4 files of about 1.1 GiB each (each below `0xFFFFFFFF`), then a final 1 KiB file, and asserts via `zipLayout` that the final entry's local-header offset is at least `0xFFFFFFFF`.
  - When Python is present, `verify_zip.py` on a small writer-made archive:
    - `testzip()` returns `None`;
    - `extractall` succeeds and the SHA-256 values equal the manifest;
    - `--inspect-offset-only NAME` exits non-zero on a non-ZIP64 entry.
  - `--extracted <dir> <manifest>` mode checks folders extracted by Windows Explorer and macOS Archive Utility.
  - The README holds the R1–R3 and A1–A12 matrix with every cell `NOT RUN`, and the section L memory procedure.
- **RED command:** `T tests/zipAcceptanceTooling.test.js`
- **Expected RED:** scripts missing.
- **GREEN command:** same.
- **14b closeout verification** (moved here from the unit tests):
  1. **[RUN ON: WINDOWS — GIT BASH]** `npm test`, plus `run-named.sh head` again. `HEAD_ONLY_FAILURES` (by test name, not count) must be 0, with anomalies and `env.txt` recorded separately.
  2. `npx vite build`, then from the repository root `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge`.
  3. `git diff --check`; `git diff --name-status origin/main...HEAD`. No path under `server/`, `gateway/`, `Vault.jsx`, `VaultTreeRollback`, `vaultPreviewIndex*` or `vaultDerivative*`.
  4. `git diff origin/main...HEAD -- IDEA1-AEGIS_Drive_LC/package.json IDEA1-AEGIS_Drive_LC/package-lock.json` is empty (no dependency change).
  5. A secret pattern scan of the diff.
  6. Exactly one receipt, `90-Status/logs/YYYY-MM-DD_HHMMSS_kla_idea1-multi-file-streaming-zip.md`, including:
     - commands and results;
     - both base SHAs and the "no IDEA1 drift" fact;
     - reader and memory acceptance `NOT RUN`;
     - `BULK_ZIP_ENABLED` as landed.
  7. Update the "Current Task" section of `idea1-status.md`.
  8. Run the collaboration policy with a local Draft event.
  9. Draft PR with `integration-review` set from the actual changed paths.
- **Commit 14:** `test(idea1): add ZIP acceptance tooling and record implementation receipt`

## L. Memory acceptance (procedure only, NOT executed)

- **Setup:** Chrome or Edge on the FSA path, a non-Production instance. Vault and Files are tested separately. Record the blob's `chunkSize`.
- **Measure:** sample the tab's memory footprint every second (browser Task Manager, `performance.measureUserAgentSpecificMemory()` where available, or a DevTools heap timeline) while archiving one 1 GiB entry, and separately one 5 GiB entry.
- **Pass criterion:** peak growth over the idle baseline differs by less than 64 MiB between the two runs, so growth does not scale with file size.
- **What it does not certify:** no exact process-RAM ceiling is promised. The 64 MiB no-FSA figure is a buffer and archive-size policy, not a peak-RAM bound.
- **Unit-level proxies:** Task 8 `maxHeld` is at most one chunk, and Task 3 holds about 1 MiB while streaming 4 GiB.

## N. Rollout boundary

- **No deploy:** the implementation PR does **not** deploy and does **not** mutate Production. With the PR-1 recommendation it lands with `BULK_ZIP_ENABLED = false`.
- **Separate acceptance task:** a later task flips the flag on a candidate build and runs, on a non-Production instance:
  - the reader gate R1–R3 (Windows Explorer, macOS Archive Utility and Python `zipfile` required; 7-Zip optional);
  - the A1–A12 browser matrix;
  - the memory procedure (L).

  A required-reader failure blocks acceptance and triggers a separate record-layout redesign under D-4.
- **One Drive release:** Trash #319, Download UX #334 and the accepted ZIP build deploy to Production together, later, as **one Drive release**. That deployment is its own task.
- **Rollback:** revert the implementation PR, or set `BULK_ZIP_ENABLED = false`.

---

## Codex review traceability (revisions 2 and 3)

| Finding | Where it is fixed |
|---|---|
| I-1 zero-CRC blind spot | Facts (reference CRCs and derivation), Task 3b: non-zero pattern, hard-coded `0xBA5A5BB3`/`0x8507C66D`, `hashedBytes === declared` |
| I-2 busy-ref contradiction | SC-2; Task 6 (transfer busy claimed by `runBulkZip` just before the picker); Task 11 (dialog-hold tests) |
| I-3 entry source contract | SC-1; Task 6 (order); Task 7a (zero local-header bytes on open failure); Task 8 (Vault keeps the same shape) |
| I-4 freeze copies | SC-3; Task 2c (originals extensible); Tasks 11 and 12 (screen behaviour unaffected) |
| I-5 ZIP64 end predicate | Task 2a `needsZip64End` boundaries; Task 2b layout and Task 3 writer use it |
| M-1 TDD order of guards | Task 9a (genuine RED: missing export); Task 13a (scanner self-check RED) |
| M-2 reason boundary | Task 5 (`wrong-key` only); Task 8 (`integrity` in pre-flight) |
| M-3 no ESM spying | Tasks 5 and 8 (`t.mock.method(crypto.subtle,'importKey')`, plus dependency injection) |
| M-4 panel stages | Task 10b |
| M-5 missing Vault blob unavailable | Task 2c; Task 11 |
| M-6 CRC only in the writer | SC-1; Task 7 (no hasher parameter; `hashedBytes` checked) |
| M-7 named baseline | Task 0 (Git Bash, `env.txt`, names not counts); Task 13b; Task 14b |
| M-8 plan PR integration review | Kept `integration-review: yes` on the plan PR |
| **Rev 3, Fix A:** no coercion of the authenticated `plainSize` | Task 5: returns `meta.plainSize` exactly; tests `123`, `"123"`, missing → `undefined`; no `integrity` reason |
| **Rev 3, Fix B:** strict authenticated size | Task 8 pre-flight: `Number.isSafeInteger(x) && x >= 0`; rejection table (`undefined`, `null`, `"123"`, `"-1"`, `1.5`, `NaN`, `Infinity`, `-1`, `> MAX_SAFE_INTEGER`); `manifestPlainSize` must also be valid and equal |
| **Rev 3, Fix C:** effective plan | SC-4; SC-3 (provisional `size`, raw `manifestPlainSize`); Task 2c (raw copy, no coercion); Task 6 (orchestrator uses only `effectivePlan` after pre-flight) |
| **Rev 3, Fix D:** effective size downstream | SC-1 (`entry` is effective); Task 6 (sentinel test: layout, `addEntry`, `opened.size`, `totalBytes`, buffered cap, physical total); Task 8 (tests 1–6); Task 9 (cap from `zipLayout(effectivePlan)`) |
| **Rev 3, Fix E:** `dispose` after post-`open` failure | SC-1 ownership table; Task 6 (exactly-once `dispose` on `addEntry` throw, mismatch, cancel/lock, pump failure; none on success); Task 7d ADDENTRY-FAIL-DISPOSE (fetch aborted, reader never acquired, no next entry, abort, no close) |
| **Rev 3, Fix F:** Windows baseline shell | Task 0, Task 13b, Task 14b labelled **[RUN ON: WINDOWS — GIT BASH]** (Git for Windows; not PowerShell, not WSL); environment recorded in `env.txt`; `HEAD_ONLY_FAILURES` by name = 0 |
| Source-guard cleanup | Task 13 (dropped and kept lists); Task 14b (moved checks) |

## Overlap and risk summary

- **Files shared with #334:**
  - `src/lib/vaultChunkedDownload.js`
  - `src/screens/VaultTreeScreen.jsx`
  - `src/components/vault/VaultTransferPanel.jsx`
  - `src/lib/strings.js`
  - `tests/helpers/vaultScreenHarness.js`
  - `tests/fixtures/vaultScreenBackend.js`
  - `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md`

  The #334 suites are run, not edited.
- **Files shared with Trash #319:**
  - `src/screens/Files.jsx`
  - `src/lib/strings.js`
  - `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md`
- **D-1 preview index:** no `vaultPreviewIndex*`, `vaultDerivative*` or server file is touched. `VaultTreeScreen.jsx` also carries D-1 wiring, but only its download block, dialog block and purge disposer are edited. This is checked at closeout (Task 14b).
- **Size:** **15 execution tasks** (Task 0 plus Tasks 1–14) and **14 intended commits**.
