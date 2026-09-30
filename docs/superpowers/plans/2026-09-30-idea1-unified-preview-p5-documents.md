# IDEA1 Unified Preview — P5 PDF and Office Document Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **P5_EXECUTION=BLOCKED_UNTIL_HUMAN_DEPENDENCY_APPROVAL.** Every task in this plan depends on third-party parsing/rendering/sanitizing libraries. D-6 is **not approved**. No task may start, and no package may be installed, until the Human Owner approves the D-6 table below (package + exact version) in writing.

**Goal:** Safe, read-only preview of PDF, DOCX, XLSX/XLS/ODS (where the approved parser supports them), and simplified PPTX in both Normal Files and the Private Vault, with DOC/PPT remaining `PREVIEW_UNSUPPORTED` + `DOWNLOAD_AVAILABLE` and no server-side conversion.

**Architecture:** Providers registered in the P0 registry, rendered inside the shared modal shell. Parsing runs in dedicated same-origin workers; HTML output (DOCX) is sanitized on the main thread and rendered in `<iframe sandbox="" srcdoc>`; PDF uses range loading from Normal Files `/preview` or from the Vault Service Worker range-decryption session URL. Bytes for Office formats come from `/preview` (served as `application/octet-stream`, fetched not navigated) or from decrypted Vault bytes, subject to caps. Text/Markdown/JSON/CSV are **P1**, not here.

**Tech Stack:** approved libraries only (see D-6 table), module Workers, React 19, Express, `node:test`, jsdom, Chromium browser QA.

**Spec:** §4.2, §5.3 (OOXML confirmation), §6.2, §18.1, §18.3, §19, §21–§22, §35 T5/T6/T10, §36 T-PDF, T-OFFICE, T-CSP, §37 H10, H12, H13. Decisions D-6, D-7, D-11.

**Depends on:** P0 and P1 merged; **G-D6-DOC** approval. Independent of P2a–P4. **Branch:** `feat/idea1-preview-p5-documents` from `origin/main`.

## Global Constraints

- Master plan §3 block applies verbatim.
- `D-7`: DOC and PPT → `PREVIEW_UNSUPPORTED`, `DOWNLOAD_AVAILABLE`. **No server LibreOffice** or any server-side document conversion.
- No PDF JavaScript, no forms scripting, no `eval`, no Office macros, no external resource loads, no `<object>`/`<embed>`, no `dangerouslySetInnerHTML` outside the sanitized `srcdoc` path.
- CSP (`server/middleware/securityHeaders.js`) is expected to remain unchanged. Any required CSP change → STOP; it is a cross-cutting security change needing integration review.
- Caps (provisional; measured in Task 9): DOCX 20 MiB, spreadsheets 15 MiB / 100,000 cells, PPTX 50 MiB, PDF: range-loaded, ≤ 2 rendered pages retained, page canvas ≤ 16 MP.

## D-6 dependency table — **NOT APPROVED**

Licenses/maintenance as understood at planning time; **re-verify each package's LICENSE, repository, and security advisories at approval time.**

### PDF renderer

```
PACKAGE=pdfjs-dist
VERSION_POLICY=exact pin (current stable major at approval); upgrades only by reviewed PR with advisory check
LICENSE=Apache-2.0
PURPOSE=parse and rasterize PDF pages to canvas; range loading
PROCESSES_ATTACKER_BYTES=YES
EXECUTION_BOUNDARY=browser; parsing in pdf.js module Worker (same origin); rendering on main-thread canvas
CSP_IMPACT=none expected: worker bundled same-origin; isEvalSupported=false; any bundled wasm (image codecs) covered by existing 'wasm-unsafe-eval'; fonts via FontFace(ArrayBuffer) — must verify in T-CSP
FALLBACK=unsupported state + Download
REPLACEMENT_OPTION=none equivalent in-browser; browser built-in viewer is not usable (sandbox CSP / Vault virtual URLs)
```

### DOCX provider

```
PACKAGE=mammoth
VERSION_POLICY=exact pin
LICENSE=BSD-2-Clause
PURPOSE=convert DOCX to semantic HTML (no styles/scripts)
PROCESSES_ATTACKER_BYTES=YES
EXECUTION_BOUNDARY=browser module Worker (conversion is DOM-free); output string posted to main thread
CSP_IMPACT=none expected (bundled, no eval) — verify
FALLBACK=unsupported state + Download
REPLACEMENT_OPTION=docx-preview (Apache-2.0; renders into DOM, main thread — weaker isolation)
```

### XLS / XLSX / ODS parser

```
PACKAGE=xlsx (SheetJS Community Edition)
VERSION_POLICY=exact pin to a vendor-published tarball with integrity hash; the npm-registry copy is stale and has published advisories, so the registry version is NOT acceptable
LICENSE=Apache-2.0
PURPOSE=parse XLSX, XLS (BIFF), ODS to cell values
PROCESSES_ATTACKER_BYTES=YES
EXECUTION_BOUNDARY=browser module Worker; only plain cell values (strings/numbers/dates) posted to main thread
CSP_IMPACT=none expected — verify
FALLBACK=unsupported state + Download
REPLACEMENT_OPTION=exceljs (MIT; XLSX only — XLS/ODS would become unsupported)
NOTE=non-registry dependency source requires explicit Human approval of the source URL and integrity policy
```

### PPTX parser/provider

```
PACKAGE=fflate (ZIP) + fast-xml-parser (XML), with an in-house slide-outline extractor
VERSION_POLICY=exact pins
LICENSE=fflate MIT; fast-xml-parser MIT
PURPOSE=read OOXML ZIP parts; parse slide XML for titles/text and embedded raster image references; also used to confirm [Content_Types].xml for DOCX/XLSX/PPTX
PROCESSES_ATTACKER_BYTES=YES
EXECUTION_BOUNDARY=browser module Worker (DOMParser is unavailable in workers, hence the XML parser)
CSP_IMPACT=none expected — verify
FALLBACK=unsupported state + Download
REPLACEMENT_OPTION=JSZip (MIT OR GPL-3.0 dual) for ZIP; @xmldom/xmldom (MIT) for XML
```

### HTML sanitizer

```
PACKAGE=dompurify
VERSION_POLICY=exact pin; track security releases promptly
LICENSE=MPL-2.0 OR Apache-2.0
PURPOSE=sanitize DOCX-derived HTML with a strict allowlist before srcdoc rendering
PROCESSES_ATTACKER_BYTES=YES (converted content)
EXECUTION_BOUNDARY=browser main thread (requires DOM); result rendered only inside <iframe sandbox="" srcdoc>
CSP_IMPACT=none expected — verify
FALLBACK=if sanitizer unavailable, DOCX provider disabled (unsupported + Download)
REPLACEMENT_OPTION=browser Sanitizer API where available (capability-detected), else none
```

MP4/WebM demux/mux tooling is covered in the P4 plan's D-6 table.

---

## File Map

| Action | Path | Responsibility |
|---|---|---|
| Modify | `server/config/previewMedia.js` | inline entries: `pdf → application/pdf`; `docx xlsx xls ods pptx → application/octet-stream` (derivative `none`) |
| Modify | `server/config/formatSignatures.js` | `%PDF-`, ZIP, CFB families for `familyMatches` |
| Verify | `src/lib/vaultPreviewResponder.js` | P1 rule (non-`video/*` → `nosniff` + sandbox CSP) covers PDF; regression test only |
| Create | `src/lib/preview/ooxml.js` | `confirmOoxml(bytes)` (worker-side) |
| Create | `src/workers/pdfWorkerEntry.js` | pdf.js worker bootstrap |
| Create | `src/workers/docxWorker.js`, `src/workers/sheetWorker.js`, `src/workers/pptxWorker.js` | parsing workers |
| Create | `src/components/preview/providers/PdfPreview.jsx`, `DocxPreview.jsx`, `SheetPreview.jsx`, `PptxOutlinePreview.jsx` | renderers |
| Modify | `src/lib/preview/registry.js` | register `pdfjs`, `docx-html`, `sheet-table`, `pptx-outline`; DOC/PPT stay `unsupported` |
| Modify | `src/lib/vaultTreeLimits.js` + test | document caps |
| Modify | `package.json`, `package-lock.json` | approved packages only |

---

### Task 0: Dependency approval confirmation

- [ ] Confirm written G-D6-DOC approval listing package + exact version (+ SheetJS source URL/integrity if approved).
- [ ] Install only approved packages with `npm install --save-exact`; record license text hashes and `npm audit --omit=dev` output in the PR.
- [ ] Worktree + `npm test` baseline → `$SCRATCH/p5-baseline-failures.txt`.

### Task 1: Server inline entries for PDF/Office (Normal Files)

**Files:** `server/config/previewMedia.js`, `server/config/formatSignatures.js`, `tests/previewFormatTable.test.js`, `tests/filesPreviewRoute.test.js`.

- [ ] **Step 1 — RED:** `report.pdf` (`%PDF-`) → 200 `application/pdf`, sandbox CSP, nosniff, Range 206; `a.docx` (ZIP) → 200 `application/octet-stream`; `a.xls` (CFB) → 200 octet-stream; `a.doc`/`a.ppt` → 415 (D-7); `fake.pdf` with PNG bytes → 415; derivative-eligible set unchanged; owner/Vault/folder ordering unchanged; three account classes identical.
- [ ] **Step 2 — verify RED.** **Step 3 — GREEN.** **Step 4 — verify GREEN** (memory + PG).
- [ ] **Step 5 — commit:** `feat(idea1): serve PDF and Office bytes for in-app preview`.

### Task 2: SW PDF response hardening (regression on the P1 rule)

**Files:** `tests/vaultPreviewResponder.test.js` (P1 already made every non-`video/*` SW response carry `nosniff` + sandbox CSP).

- [ ] **Step 1:** add a case for `contentType: 'application/pdf'` asserting `nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cache-Control: no-store`. Expected GREEN immediately (P1 rule); if RED, fix `src/lib/vaultPreviewResponder.js` minimally.
- [ ] **Step 2 — commit:** `test(idea1): pin sandboxed Vault PDF preview responses`.

### Task 3: OOXML confirmation

**Files:** `src/lib/preview/ooxml.js`, `tests/previewOoxml.test.js`.

- [ ] **Step 1 — RED:** crafted ZIPs: `[Content_Types].xml` with `wordprocessingml.document.main` → `docx`; `spreadsheetml.sheet.main` → `xlsx`; `presentationml.presentation.main` → `pptx`; plain ZIP/APK/JAR → `null`; ZIP bomb (declared huge uncompressed size) → rejected before inflate; path traversal names ignored.
- [ ] **Step 2 — verify RED.** **Step 3 — GREEN.** **Step 4 — verify GREEN.**
- [ ] **Step 5 — commit:** `feat(idea1): confirm OOXML document types from package content`.

### Task 4: PDF provider (T-PDF)

**Files:** `src/workers/pdfWorkerEntry.js`, `src/components/preview/providers/PdfPreview.jsx`, `tests/previewPdf.test.js`.

- [ ] **Step 1 — RED:** (pdf.js injected as a fake in jsdom) loader options include `isEvalSupported: false`, `enableScripting: false`, annotation forms disabled, range loading with `disableAutoFetch: true`; Files source URL is `/api/files/:id/preview`; Vault source is the SW session URL with detected `application/pdf`; only ≤ 2 page canvases alive; canvas pixel cap enforced; links rendered inert (no navigation); malformed PDF → `integrity-failed` + Download; lock → `destroy()` + worker terminated.
- [ ] **Step 2 — verify RED.** **Step 3 — GREEN.** **Step 4 — verify GREEN.**
- [ ] **Step 5 — commit:** `feat(idea1): add sandboxed PDF preview for Files and Vault`.

### Task 5: DOCX provider (T-OFFICE part A)

**Files:** `src/workers/docxWorker.js`, `src/components/preview/providers/DocxPreview.jsx`, `tests/previewDocx.test.js`.

- [ ] **Step 1 — RED:** converter output containing `<script>`, `onerror=`, `javascript:` links, external `<img src="http://…">`, `<style>` → all stripped by the sanitizer allowlist; embedded images become Blob URLs registered for revocation; rendered `<iframe>` has `sandbox=""` (empty) and uses `srcdoc`; no `allow-scripts`/`allow-same-origin`; > 20 MiB → `too-large` + Download.
- [ ] **Step 2 — verify RED.** **Step 3 — GREEN.** **Step 4 — verify GREEN.**
- [ ] **Step 5 — commit:** `feat(idea1): add sanitized DOCX preview`.

### Task 6: Spreadsheet provider (T-OFFICE part B)

**Files:** `src/workers/sheetWorker.js`, `src/components/preview/providers/SheetPreview.jsx`, `tests/previewSheet.test.js`.

- [ ] **Step 1 — RED:** worker posts only primitive cell values; formulas shown as cached values; 100k-cell cap with truncation notice; sheet tabs listed; virtualized rendering keeps DOM rows bounded; XLS/ODS enabled only if the approved parser supports them (else `unsupported`); > 15 MiB → `too-large`.
- [ ] **Step 2 — verify RED.** **Step 3 — GREEN.** **Step 4 — verify GREEN.**
- [ ] **Step 5 — commit:** `feat(idea1): add spreadsheet preview`.

### Task 7: PPTX simplified outline (T-OFFICE part C)

**Files:** `src/workers/pptxWorker.js`, `src/components/preview/providers/PptxOutlinePreview.jsx`, `tests/previewPptx.test.js`.

- [ ] **Step 1 — RED:** per-slide title/body text in order; embedded PNG/JPEG shown via Blob URLs; EMF/WMF/video ignored; "Simplified preview" label visible; > 50 MiB → `too-large`; DOC/PPT (CFB) → `unsupported` + Download (D-7 regression).
- [ ] **Step 2 — verify RED.** **Step 3 — GREEN.** **Step 4 — verify GREEN.**
- [ ] **Step 5 — commit:** `feat(idea1): add simplified PPTX outline preview`.

### Task 8: Cleanup and neutrality

- [ ] **RED/GREEN:** lock/modal close terminates all document workers, revokes Blob URLs, clears buffers (`tests/vaultDerivativeLock.test.js` or new `tests/previewDocumentsLifecycle.test.js`); storage guards zero; extend `tests/previewAccountNeutrality.test.js` for PDF/DOCX per class and cross-class 404.
- [ ] **Commit:** `test(idea1): cover document providers in lifecycle and neutrality tests`.

### Task 9: T-CSP browser verification and cap measurement

- [ ] Chromium (Edge/Chrome) against a local production build (`npm run build` then `npm start`): PDF, DOCX, XLSX, PPTX render with **unchanged** CSP; DevTools console shows zero CSP violations; record worker memory peaks for the caps; Firefox/Safari spot check (graceful degradation, Download intact — D-11). Restore `dist` with `git checkout -- dist`.
- [ ] Any CSP violation that requires a policy change → STOP and report (integration review).

### Task 10: Regression and governance

- [ ] `npm test` vs baseline; P1 text/audio and P0 suites; Normal Files media regression; PG runs for `/preview`.
- [ ] `git diff --check`; policy validation; receipt; push.

## Rollback boundary

Reversible by revert (providers + inline entries). Uninstall the packages in the same revert. No data written.

## Human review gates

1. **G-D6-DOC** — mandatory before Task 0 proceeds.
2. Acceptance on ADMIN / EXISTING_USER / NEWLY_CREATED_USER: §37 H10 (PDF renders, pages navigate, no script execution), H12 (DOCX/XLSX/PPTX readable simplified previews), H13 (DOC/PPT/ZIP/unknown → stable fallback, Download works).
