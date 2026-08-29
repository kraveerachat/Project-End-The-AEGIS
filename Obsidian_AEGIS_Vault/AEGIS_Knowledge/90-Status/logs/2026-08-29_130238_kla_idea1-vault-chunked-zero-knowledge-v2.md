---
title: Task Receipt — IDEA1 Private Vault chunked zero-knowledge transfer (LFT-V2-B)
date: 2026-08-29T13:02:38+07:00
owner: kla
area: idea1
branch: feat/idea1-vault-chunked-zero-knowledge-v2
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA1 Private Vault chunked zero-knowledge transfer (LFT-V2-B)

> New receipt, not an append. PR #45 (`LFT-V2-A` crash recovery) is merged and its
> receipt `2026-08-29_004222_kla_idea1-lft-v2-a-commit-crash-recovery.md` is frozen
> and was not touched. Base `main` at branch point:
> `bc5e4b743af08c503da2426bb481bed0495cf48c`.

## What changed

- **A Private Vault file is no longer capped by the tab's RAM or by one HTTP
  request.** Vault V1 read the whole file with `file.arrayBuffer()`, encrypted it
  as **one** AES-256-GCM message, held the complete ciphertext, and sent it in a
  single multipart request; download and preview mirrored that. Stage B adds a
  second, explicitly versioned format in which one logical file becomes N
  independently authenticated chunks that are encrypted, transferred, verified and
  decrypted a bounded piece at a time.
  `ROOT_CAUSE = WHOLE_FILE_ZERO_KNOWLEDGE_TRANSFER_ARCHITECTURE`.
- **`MAX_VAULT_CIPHERTEXT_BYTES` is unchanged at 64 MiB, deliberately.** Raising
  it was never a valid fix — it does not remove the whole-file RAM requirement —
  and the constant still correctly governs V1 blobs, which really are one GCM
  message and really cannot be decrypted in parts.
- **Zero knowledge is unchanged in every particular.** The server still never
  receives a passphrase, a KEK, an unwrapped DEK, a plaintext filename, a
  plaintext MIME type or plaintext content, and still never decrypts, derives
  keys, thumbnails, transcodes, indexes or searches Vault content. One random
  256-bit DEK per logical file, wrapped by the KEK exactly as the existing
  envelope requires. No user-wide content key exists; the KEK never encrypts file
  content.
- **An interrupted Vault upload costs one chunk, not the file.** A transient
  failure retries only the failing chunk and the screen offers Resume, which sends
  only the indices the server says are missing.
- **A Vault download is written straight to disk.** `showSaveFilePicker()` →
  `createWritable()` → sequential writes → `close()`, opened inside the user's own
  click. Browsers without the File System Access API get a bounded 64 MiB RAM
  fallback — exactly V1's old ceiling, so they can do what they always could and
  no more — and a truthful message above it.
- **Every existing V1 blob still works** through the code path it always used. No
  ciphertext was rewritten, moved or migrated, and no V1 column was relaxed.

### The format, recorded exactly

`formatVersion = 2` is an explicit column, not a sentinel. A sentinel such as
`iv_b64 = 'v2'` was rejected because it makes an invalid row representable; V2
lives in its own tables so every V1 `NOT NULL` survives untouched.

16 MiB of plaintext per chunk by default, 8–64 MiB configurable via
`VAULT_CHUNK_PLAINTEXT_BYTES`. An empty file is **one** chunk, not zero: a file
with no authenticated message is a file anyone could replace without a key.

A fresh random 96-bit IV is generated inside `encryptVaultChunk()`, which exposes
no parameter for a caller to supply one. A retry re-encrypts and therefore ships a
different IV with different ciphertext; the (IV, bytes) pair recorded server-side
always comes from one request, enforced by a writer token on the finalising
`UPDATE`. There is no code path that can reuse an IV with different plaintext
under one DEK.

AAD is a canonical binary layout, not JSON — property order in an arbitrary object
is not a stable contract:

```
content chunk AAD (34 bytes)
  "AEGIS-VLT2"      10 bytes ASCII
  contentId         16 bytes, random per file
  chunkIndex         4 bytes uint32 big-endian
  chunkCount         4 bytes uint32 big-endian

encrypted metadata AAD (33 bytes)
  "AEGIS-VLT2-MD"   13 bytes ASCII
  contentId         16 bytes
  chunkCount         4 bytes uint32 big-endian
```

### Stated honestly rather than described as hidden

The server sees `ciphertext_size`, `chunk_size` and `chunk_count`, so the logical
plaintext size is derivable as `ciphertext_size − 16 × chunk_count`. That is the
same class of disclosure V1 already makes. It is why **no `plainSize` field is
accepted from the client**: the arithmetic is unavoidable, but the server must not
additionally hold the number as user-supplied data.

## Invariants proven on this branch

| Invariant | How it is proven |
| :--- | :--- |
| `NO_DUPLICATE_VAULT_BLOB` | commit twice, and crash-after-metadata recovery, both leave exactly one `vault_v2_blobs` row |
| `NO_ORPHAN_VAULT_CIPHERTEXT` | crash after publish restores the bytes to staging; no file is left that no row references |
| `NO_METADATA_TO_MISSING_CIPHERTEXT` | bytes deleted under a stale `committing` session ⇒ `aborted`, and no blob row is written |
| `RECOVERY_IDEMPOTENT` | three further recovery passes report `{0,0,0,0}` and change no column |
| `RECOVERY_RACE_SAFE` | two concurrent workers: `scanned` totals 1 and `reopened` totals 1 (`FOR UPDATE SKIP LOCKED`) |
| `COMMIT_LEASE` | a commit inside its lease is not even scanned, and expiry cleanup refuses to touch `committing` |
| `SERVER_CIPHERTEXT_INTEGRITY` | one byte altered on disk after receipt ⇒ `422 CIPHERTEXT_INTEGRITY_FAILED`, session aborted, nothing published |
| `CLIENT_AEAD_AUTHENTICATION` | one bit flipped in any chunk, a reordered chunk, a chunk from another file, a wrong IV, and a tampered `chunkCount` all fail decryption in the browser |
| `UNIQUE_IV_PER_ENCRYPTION` | 200 encryptions under one DEK produce 200 distinct 12-byte IVs; a retry after a network failure is asserted to use a **different** IV |
| `OWNER_ISOLATION` | every V2 verb on another owner's session or blob answers `404`, never `403` |
| `APP_ROLE_BOUNDARY` | `drive_app` has exactly `DELETE,INSERT,SELECT,UPDATE` on all four tables; `CREATE`/`ALTER`/`DROP`/`TRUNCATE` all refused |

## Source files changed

**Created — server**

- `IDEA1-AEGIS_Drive_LC/server/config/vaultTransferLimits.js` — Vault limits kept
  separate from `transferLimits.js` because the Vault counts **ciphertext**, and
  overhead is 16 bytes per chunk rather than per file.
- `IDEA1-AEGIS_Drive_LC/server/storage/vaultStaging.js` — opaque staging area,
  positional writes into one `part` file, bounded range hashing, atomic publish by
  `rename`, restore-on-failure, orphan listing.
- `IDEA1-AEGIS_Drive_LC/server/db/migrations/004_vault_v2.sql` — additive
  migration for existing databases; four tables, three indexes, and an explicit
  role-guarded `GRANT`.
- `IDEA1-AEGIS_Drive_LC/server/db/vaultV2Store.js` — V2 metadata layer with the
  same PostgreSQL/in-memory duality as `store.js`; advisory-lock chunk writes,
  writer-token compare-and-set, commit claim, transactional publish, stale-lease
  scan.
- `IDEA1-AEGIS_Drive_LC/server/routes/vaultUploads.js` — the upload protocol.
- `IDEA1-AEGIS_Drive_LC/server/storage/vaultCommitRecovery.js` — converges stale
  `committing` sessions to `open`, `committed` or `aborted` from what is actually
  on disk and in the tables.
- `IDEA1-AEGIS_Drive_LC/server/storage/vaultUploadCleanup.js` — reclaims abandoned
  sessions and orphaned staging directories; never touches `vault/`.

**Modified — server**

- `IDEA1-AEGIS_Drive_LC/server/storage/vaultStore.js` — added
  `openVaultCiphertextRange()` (bounded read stream). V1 paths and
  `MAX_VAULT_CIPHERTEXT_BYTES` untouched.
- `IDEA1-AEGIS_Drive_LC/server/db/connection.js` — added `withAdvisoryLock()`, a
  dedicated pooled client around `pg_try_advisory_lock` / `pg_advisory_unlock`.
- `IDEA1-AEGIS_Drive_LC/server/db/schema.sql` — same four tables for fresh
  databases, appended after the LFT-V2-A section.
- `IDEA1-AEGIS_Drive_LC/server/routes/api.js` — mounts `/vault/uploads`;
  `GET /api/vault` now merges V1 and V2 into one user-facing inventory; adds the
  per-chunk read endpoint; `GET /vault/blobs/:id` answers `409
  VAULT_V2_USE_CHUNK_ENDPOINT` for an **owned** V2 id and `404` otherwise;
  `DELETE` dispatches by format.
- `IDEA1-AEGIS_Drive_LC/server/index.js` — staging init, commit recovery and
  cleanup at boot and on a schedule.

**Created — client**

- `IDEA1-AEGIS_Drive_LC/src/lib/vaultChunkCrypto.js` — the format: AAD layout,
  chunk planning, envelope creation, per-chunk encrypt/decrypt, DEK unwrap.
- `IDEA1-AEGIS_Drive_LC/src/lib/vaultChunkedUpload.js` — slice → encrypt → PUT,
  per-chunk retry with backoff, resume state, cancellation.
- `IDEA1-AEGIS_Drive_LC/src/lib/vaultChunkedDownload.js` — one chunk at a time
  into a sink; File System Access sink and a **bounded** RAM fallback.

**Modified — client**

- `IDEA1-AEGIS_Drive_LC/src/lib/api.js` — `apiFetchBytes` now returns `headers` on
  every branch, so the per-chunk IV can be read.
- `IDEA1-AEGIS_Drive_LC/src/screens/Vault.jsx` — V2 upload/download/preview paths,
  the transfer panel, resume and cancel, lock-aborts-transfer, and the
  large-file preview notice.
- `IDEA1-AEGIS_Drive_LC/src/lib/strings.js` — 22 new keys × en/th/zh.

**Tests**

- Created: `vaultChunkCrypto.test.js`, `vaultChunkedUploadClient.test.js`,
  `vaultChunkedDownloadClient.test.js`, `vaultV2Api.test.js`,
  `vaultV2Postgres.test.js`, `vaultV2ScreenUi.test.js`
  (all under `IDEA1-AEGIS_Drive_LC/tests/`).
- Modified: `tests/helpers/vaultScreenHarness.js` and
  `tests/fixtures/vaultScreenBackend.js` (stub the three new modules, add V2
  fixtures and test-controllable drivers); `tests/vaultStateSync.test.js`,
  `tests/vaultTileActions.test.js`, `tests/vaultMediaPreview.test.js` (repointed
  from the retired V1 upload endpoint to `/api/vault/uploads`);
  `tests/vaultApi.test.js` and `tests/vaultPostgres.test.js` (also reset the V2
  tables — `GET /api/vault` now returns the whole vault, so clearing only the V1
  tables let rows from another suite leak into a shared PostgreSQL database).

## Verification evidence

- `npm test` (in-memory) — **pass**: 586 tests, 519 pass, 0 fail, 67
  PostgreSQL-gated skips.
- `sh scripts/pg-integration-env.sh up` then `npm test` with `TEST_DATABASE_URL`,
  `AEGIS_PGTEST_SUPER_URL` and `AEGIS_PGTEST_LEGACY_URL` — **pass**: 586 tests,
  **586 pass, 0 fail, 0 skipped**, against an isolated PostgreSQL 15 container.
- `node --test --test-concurrency=1 tests/vaultChunkCrypto.test.js` — **pass** 23/23
  (AAD pinned byte for byte, one DEK per file, IV uniqueness and retry freshness,
  reorder/cross-file/tamper all rejected, metadata secrecy on the wire).
- `node --test --test-concurrency=1 tests/vaultChunkedUploadClient.test.js` —
  **pass** 12/12, including a `File` whose whole-file `arrayBuffer()` **throws**
  still uploading successfully.
- `node --test --test-concurrency=1 tests/vaultChunkedDownloadClient.test.js` —
  **pass** 26/26 (one chunk at a time, peak memory ≤ one chunk, byte-exact output,
  every failure aborts the destination without delivering a file).
- `node --test --test-concurrency=1 tests/vaultV2Api.test.js` — **pass** 24/24.
- `node --test --test-concurrency=1 tests/vaultV2Postgres.test.js` — **pass** 17/17
  with `TEST_DATABASE_URL` + `AEGIS_PGTEST_SUPER_URL`; migration `004` applied to a
  pre-V2 database by a **different** superuser than the one holding
  `ALTER DEFAULT PRIVILEGES` still delivered all four DML privileges, applied three
  times unchanged, V1 rows byte-identical afterwards, `vault_blobs.iv_b64` still
  `NOT NULL`.
- `node --test --test-concurrency=1 tests/vaultV2ScreenUi.test.js` — **pass** 17/17.
- `npm run build` — **pass** (built in 13.27s). `dist/` was restored to its
  committed state afterwards; no build artefact is in this change.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` —
  **pass** with the two pre-existing canvas owner-review warnings.
- `node scripts/validate-collaboration-policy.mjs` — **pass**.
- `git diff --check` — **pass**, no whitespace errors.
- Targeted secret scan over the diff for `passphrase`, `BEGIN .* PRIVATE KEY`,
  `password=`, `postgresql://` credentials and `.env` values — **pass**, no match.
- `sh scripts/pg-integration-env.sh down` — **pass**; the container, its anonymous
  volume and its network were removed. Only resources this script created were
  touched: no `docker compose down`, no `prune`, no production endpoint contacted,
  and the throwaway credentials it generated were deleted from the scratchpad.

**A real defect was found by the new UI tests and fixed here.** The V2 download
progress callback reports `bytesWritten` while the transfer panel reads
`transferredBytes`, so the byte counter would have sat at zero for the entire
download while the percentage advanced — two numbers on one bar contradicting each
other. `Vault.jsx` now translates between them.

## Production acceptance — recorded, not run

No multi-gigabyte Vault test was executed here and none has been executed in
production. The matrix (2 MiB → 5 GiB plus interruption, restart, crash, wrong
key, tamper, cross-owner, lock and free-space cases) is recorded in
`concepts/Large_File_Transfer_V2` §9 for `LFT-V2-D`. The largest file actually
moved through the Vault protocol in any test is ~16 MiB; multi-gigabyte behaviour
remains argued from bounded memory rather than measured.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — new section
  "Private Vault chunked zero-knowledge transfer — LFT-V2-B (2026-08-29)":
  the root cause, the format, the protocol, the two integrity claims kept apart,
  the PostgreSQL gate result, the recorded limitations, and the explicit statement
  that nothing is deployed.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/concepts/Large_File_Transfer_V2.md` —
  Stage B row moved to `SOURCE COMPLETE / LOCAL+PG VERIFIED`; §7 replaced with the
  implemented format, AAD byte layout, protocol, integrity language, commit
  design, bounded-memory proof and recorded limitations; §9 gained the Private
  Vault acceptance matrix (record only); §10 report-ready note rewritten to cover
  both stages.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/summaries/08_Outstanding_Items_Consolidated.md`
  — the `LARGE_FILE_TRANSFER_V2` row and the Private Vault caveat now state that
  Stage B is source-complete and PostgreSQL-verified while Vault large-file support
  stays `IN PROGRESS` until `LFT-V2-D`.

The formal report was **not** edited: `FORMAL_REPORT = NO UPDATE`.

## Shared surfaces touched

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/concepts/Large_File_Transfer_V2.md` — the
  cross-cutting transfer-architecture note is read by IDEA1, IDEA2 and
  infrastructure work; its Stage table drives what `LFT-V2-C` (HUB/gateway nginx)
  and `LFT-V2-D` (production acceptance) are allowed to assume.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/summaries/08_Outstanding_Items_Consolidated.md`
  — the consolidated open-items list spans every area, so a status change here is
  visible to owners outside IDEA1.

## Integration requests

- **Code Owner `pubpup2006p-design`** — review requested for the two shared
  Obsidian surfaces above. Decision required: whether Stage B may be recorded as
  `SOURCE COMPLETE / LOCAL+PG VERIFIED` while Private Vault large-file support
  remains `IN PROGRESS` until `LFT-V2-D`. Downstream effect: `LFT-V2-C` may retune
  `client_max_body_size`, `proxy_request_buffering` and timeouts at the HUB and
  gateway to chunk-sized semantics — an infrastructure change outside IDEA1 —
  and it must not begin before this is accepted.
- **The PR #43 migration rule now binds Vault migrations too.** Every new IDEA1 or
  IDEA2 migration that creates tables must issue its own explicit, idempotent,
  role-guarded `GRANT` for `drive_app`. `ALTER DEFAULT PRIVILEGES` applies only to
  objects created by the role that executed it, so a DBA migrating with a
  different superuser account gets a migration that reports success and an
  application that fails at runtime. `004_vault_v2.sql` follows the rule and there
  is a test that fails if a future edit removes it.
- **Rollout:** apply `004_vault_v2.sql` as the migration/superuser role; it is
  purely additive and touches no V1 table, so V1 continues to work whether or not
  the application is restarted first. **Rollback:** drop the four `vault_v2_*`
  tables. No V1 data depends on them and no existing ciphertext is affected. This
  has **not** been applied to production `aegis_drive`.

## Known limitations

- `VAULT_BROWSER_REFRESH_RESUME = NOT_IMPLEMENTED`. The server-side session is
  durable and survives an application restart, but the KEK lives only in tab
  memory and is deliberately never persisted to browser storage, so a page refresh
  requires unlocking again and the resume affordance is not wired to a reloaded
  page. Persisting the KEK to make this work would break the security contract and
  was rejected.
- `LARGE_V2_VIDEO_PREVIEW = LIMITED`. Preview needs a whole plaintext object URL,
  so above 64 MiB the screen states that preview is unavailable and points at
  download instead of assembling gigabytes in RAM. Real streaming playback needs
  MediaSource plus on-demand decryption and is not built.
- **File System Access API support is claimed only for Chromium desktop**, which
  is the family this was exercised against. Other browsers fall back to the
  bounded 64 MiB RAM sink and get a truthful message above that. Universal support
  is not claimed.
- `VAULT_V1_NEW_UPLOAD = SUPPORTED_BUT_UNUSED_BY_UI`. `POST /api/vault/blobs`
  still works and still has its 64 MiB ceiling; the Vault screen no longer uses
  it. V1 is **not** large-file capable and must not be described as such.
- **Audit granularity is deliberately coarse.** `VAULT_V2_READ` is written for
  chunk 0 only, so a read that starts and is abandoned looks identical to one that
  completes. The alternative — one row per chunk — would be 320 rows per 5 GiB
  download and would bury every other event in the audit log.
- **Recovery is not instantaneous.** A stranded Vault commit becomes actionable up
  to roughly **15–20 minutes** after a crash (15-minute lease plus a 5-minute
  recovery interval), the same accepted window as LFT-V2-A.
- `LEGACY_V1_VERSIONING_CRASH_WINDOW = OPEN` is unrelated to the Vault and remains
  open from the previous task; nothing here changed it.
- **Nothing has been deployed.** `PRODUCTION_CHANGED = NO`. The Beelink runtime,
  production PostgreSQL, production Docker volumes, MikroTik, UFW, Twingate,
  IDEA2 and IDEA3 were not touched, and no destructive Vault test was run against
  production.
