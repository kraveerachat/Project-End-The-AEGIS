# Multi-file streaming ZIP — acceptance tooling

Tooling for the **separate** reader, browser and memory acceptance gate of the multi-file streaming ZIP
(spec `docs/superpowers/specs/2026-10-05-idea1-multi-file-streaming-zip.md` §24, plan section L).

**Nothing in this folder has been executed against AEGIS.** The implementation PR only builds and unit-tests
the tooling. Every cell below stays `NOT RUN` until that gate runs it on a non-Production instance with
`BULK_ZIP_ENABLED = true` on the candidate build. An untested cell is never written as `PASS`.

## Tools

| Tool | Purpose |
|---|---|
| `make-sources.mjs --set R1\|R2\|R3 --out <dir>` | Writes deterministic pattern files and `manifest.json` (path, name to use in AEGIS, size, SHA-256). Streams through one 1 MiB buffer, so multi-GiB sets never sit in memory. `--dry-run` prints the plan. |
| `verify_zip.py ARCHIVE --manifest manifest.json` | Python `zipfile` reader check: `testzip()` is `None`, `extractall` succeeds, SHA-256 values equal the manifest. |
| `verify_zip.py ARCHIVE --inspect-offset-only NAME` | Proves that entry is a real offset-only ZIP64 entry (local header offset ≥ `0xFFFFFFFF`, real 32-bit sizes, central offset `0xFFFFFFFF`, ZIP64 extra holding only the offset, version needed 45). |
| `verify_zip.py --extracted DIR manifest.json` | Checks a folder extracted by Windows Explorer or macOS Archive Utility against the manifest. |

Source sets:

- **R1** — small files including a 0-byte file, Thai, CJK and emoji names, a case-insensitive duplicate
  (`Report.txt` / `report.txt`, stored in two folders) and the reserved name `CON.txt` (stored on disk as
  `reserved/con-device-name.txt`; rename it to `CON.txt` after uploading).
- **R2** — size-ZIP64: one file of at least 4.1 GiB plus three small files.
- **R3** — offset-only ZIP64: four files of about 1.1 GiB each (each below `0xFFFFFFFF`), then `r3-final.bin`
  (1 KiB) whose local header starts at or beyond `0xFFFFFFFF`. Select them in the listed order.

## Reader compatibility gate (BLOCKING, spec §24)

| Archive | Windows Explorer (required) | macOS Archive Utility (required) | Python `zipfile` (required) | 7-Zip (optional) |
|---|---|---|---|---|
| R1 | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| R2 | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| R3 | NOT RUN | NOT RUN | NOT RUN | NOT RUN |

R3 additionally requires `verify_zip.py <archive> --inspect-offset-only r3-final.bin`: NOT RUN.
A required-reader failure blocks implementation acceptance (D-4); no seek-back or header-patch fix is pre-approved.

## Browser matrix (spec §24)

| # | Scenario | Chrome/Edge Win (FSA) | Chrome macOS (FSA) | Firefox (no FSA) | Safari macOS (no FSA) |
|---|---|---|---|---|---|
| A1 | 3 files (incl. a V1 Vault file) → 3 per-file downloads | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| A2 | 4 small files → 1 picker, 1 ZIP (Vault: confirmation first) | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| A3 | 0-byte, Thai/CJK/emoji, duplicate and reserved names | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| A4 | Folder in the selection → skipped notice | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| A5 | Vault single entry ≥ 4.1 GiB (size-ZIP64) + 3 small | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| A6 | Files offset-only ZIP64 fixture (R3) | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| A7 | Cancel mid-entry 2 → no success; record destination state | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| A8 | Lock Vault mid-archive → abort; record destination state | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| A9 | Disk full → `localDiskFull`, no success; record destination state | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| A10 | Network drop mid-entry → failure, next entry not started | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| A11 | Tab memory: 1 GiB vs 5 GiB entry peak growth differs by < 64 MiB | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| A12 | V1 in a 4+ Vault selection → refused before the confirmation | NOT RUN | NOT RUN | NOT RUN | NOT RUN |

## L. Memory acceptance procedure (A11)

1. Chrome or Edge on the File System Access path, against a non-Production instance. Run Vault and Files separately.
   Record the blob's `chunkSize` for the Vault run.
2. Sample the tab's memory footprint every second (browser Task Manager, `performance.measureUserAgentSpecificMemory()`
   where available, or a DevTools heap timeline) from an idle baseline through the end of the archive.
3. Run one archive whose largest entry is **1 GiB**, then one whose largest entry is **5 GiB**.
4. **Pass:** the peak growth over the idle baseline differs by less than 64 MiB between the two runs, so memory does
   not scale with file size.
5. **Not certified:** no exact process-RAM ceiling is promised. The 64 MiB no-FSA figure is a buffer and
   archive-size policy, not a peak-RAM bound (spec §14, §15).
