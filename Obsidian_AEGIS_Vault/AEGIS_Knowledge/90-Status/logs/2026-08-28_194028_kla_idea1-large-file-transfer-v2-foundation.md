---
title: Task Receipt — IDEA1 Large File Transfer V2 · Resumable Chunked Foundation
date: 2026-08-28T19:40:28+07:00
owner: kla
area: idea1
branch: feat/idea1-large-file-transfer-v2-foundation
status: complete
integration-review: yes
edit_policy: append-by-new-file
---

# Task Receipt — IDEA1 Large File Transfer V2 · Resumable Chunked Foundation

`SCOPE = LFT-V2-A`

`ROOT_CAUSE = APPLICATION_TRANSFER_ARCHITECTURE`

`CHUNKED_UPLOAD = PASS`

`RESUMABLE_UPLOAD = PASS`

`INCREMENTAL_SHA256 = PASS`

`WHOLE_FILE_BROWSER_BUFFERING_REMOVED = PASS`

`SERVER_FINAL_HASH_VERIFY = PASS`

`OWNER_SCOPED_SESSION = PASS`

`PARTIAL_FILE_VISIBLE = NO`

`LEGACY_FILE_COMPATIBILITY = PASS`

`PRIVATE_VAULT_CRYPTO_CHANGED = NO`

`PRODUCTION_CHANGED = NO`

`PRODUCTION_ACCEPTANCE = NOT STARTED`

`FORMAL_REPORT = NO UPDATE`

## What changed

### The defect this starts from

Large-file transfers into AEGIS Drive failed or stalled in production, and the
first reading was bandwidth — VLAN throughput, Twingate relay, HDD write rate.
That reading is wrong, and the source says so:

| Layer | Constant / setting | Value | What it limited |
| --- | --- | --- | --- |
| Private Vault | `MAX_VAULT_CIPHERTEXT_BYTES` (`server/storage/vaultStore.js`) | 67 108 864 (~64 MiB) | Ciphertext of one vault file, per request |
| Normal Files backend | `MAX_UPLOAD_BYTES` (`server/storage/fileStore.js`) | 1 073 741 824 (1 GiB) | One multipart request **and** one logical file, conflated |
| HUB edge | `client_max_body_size` in `location /drive/` | 512 MiB | Any single request through `/drive` — the tightest of the three |

On top of the numbers, both browser paths (`Uploads.jsx`, `UploadDrawer.jsx`)
called `file.arrayBuffer()` and `crypto.subtle.digest()` before sending, so the
whole file existed in the tab's RAM first. **The effective ceiling was therefore
`min(one-request limit, browser RAM)` — not the capacity of the Data Lake — and
any interruption discarded all progress.** Doubling link speed only reaches the
same failure sooner. `ROOT_CAUSE = APPLICATION_TRANSFER_ARCHITECTURE`.

### The V2 protocol (Normal Files only)

```text
POST   /api/files/uploads                     open a durable session
PUT    /api/files/uploads/:id/chunks/:index   send one bounded chunk
GET    /api/files/uploads/:id                 ask which chunks are still missing
POST   /api/files/uploads/:id/commit          server verifies, then publishes
DELETE /api/files/uploads/:id                 cancel and reclaim staged bytes
GET    /api/files/uploads/limits              the ceilings this deployment enforces
```

Every route sits behind `requireAuth` and the existing CSRF gate, and every
session is scoped to `req.user.id`. **No route reads a `userId` from a body,
param or query.** A session belonging to another user answers `404`, never `403`,
so the reply does not confirm the id exists — and there is no Admin exception,
matching the existing rule that Admin gains governance screens, not authority
over other people's files. A malformed id is also `404`, not a `400` that hints
at the id format.

### Storage — staged, opaque, atomic

Bytes land in `STORAGE_ROOT/.staging/uploads/<random-24-byte-hex>/part`. One
sparse file per session; every chunk is a **positional write at
`index * chunkSize`**, not a per-chunk file assembled later.

- Commit is a `rename` onto the existing `uploads/<uuid>.bin` key semantics — no
  second copy of a multi-gigabyte file is ever made, and publication is atomic, so
  there is no instant at which the final key exists with incomplete bytes behind it.
- A resent chunk overwrites exactly its own range, so **retry is idempotent by
  construction** rather than by bookkeeping.
- No chunk has a filename, so there is no per-chunk name to make opaque; the
  directory name is random and is never the user's filename. A user filename never
  becomes a path on disk.
- **No row in `files` points at staged bytes at any point before commit**, so a
  partial upload cannot appear in `GET /api/files` by structure, not by a filter.
- On a failed commit no metadata row is written; if the metadata write itself
  fails after publication, the published bytes are removed so no orphan remains.

### Durable session state

`upload_sessions` and `upload_session_chunks`, added to `server/db/schema.sql`
for new databases and to the idempotent `server/db/migrations/003_upload_sessions.sql`
for existing ones. The migration only creates tables; the
`ALTER DEFAULT PRIVILEGES` already set by `postgres/init/02-app-roles.sh` grants
`drive_app` DML on tables created afterwards, so **no new GRANT, role or database
privilege is introduced**, and no existing row is read, rewritten or migrated.

State lives in the database, not React memory or process memory, so it survives
browser retry, temporary network interruption, a failed request and an
application restart. One row per received chunk rather than an array on the
session row: chunks can be in flight concurrently, and concurrent
read-modify-write on one array loses updates silently, whereas
`INSERT … ON CONFLICT DO UPDATE` per row is correct under any amount of
resending. No file bytes are stored in PostgreSQL. The plaintext filename is
stored only where Normal Files already legitimately stores it.

### Integrity — the server is the only source of truth

Three gates at commit, all reading the bytes on disk: every chunk index present
with its exact computed size; the assembled size equal to the declared logical
size; and **the SHA-256 the server computes itself** equal to the value the
client claimed. The client checksum is only ever compared. A mismatch aborts the
session and discards the staged bytes rather than leaving a session whose bytes
are known to be wrong available for another commit attempt.

In the browser, `src/lib/chunkedUpload.js` hashes incrementally over
`file.slice()` ranges with `hash-wasm`'s streaming SHA-256. `hash-wasm` was
already a dependency (Argon2id for the Vault), so **no new package was added**,
and `'wasm-unsafe-eval'` is already in the CSP, so **no CSP change was needed**.
WebCrypto was not usable here: `subtle.digest` accepts only a complete buffer,
which is the exact problem being removed.

### Limits, free space, and the removal of the 1 GiB constant as an architecture

`server/config/transferLimits.js` reads five values from the environment and
**refuses to start on an invalid one** rather than silently clamping (the same
fail-closed shape as `config/trustedProxy.js`):

| Setting | Default | Meaning |
| --- | --- | --- |
| `UPLOAD_CHUNK_SIZE_BYTES` | 16 MiB (range 8–64 MiB) | Size of one HTTP request |
| `MAX_LOGICAL_FILE_BYTES` | 5 GiB | Size of one file this deployment accepts |
| `UPLOAD_SESSION_TTL_MS` | 24 h | How long an unfinished session stays resumable |
| `STORAGE_FREE_RESERVE_BYTES` | 2 GiB | Floor of the free-space reserve |
| `STORAGE_FREE_RESERVE_FRACTION` | 0.05 | Proportional part of the reserve |

5 GiB is *a safe value for the current volume*, not a maximum the design implies;
the present 56.9 GB filesystem is explicitly **not** assumed to be final. The
chunk size is server-dictated and the client must use the value the session
response returns — a client able to choose it could choose where its bytes land,
since the write offset is `index * chunkSize`.

**Free-space rule, as implemented:**

```text
accept only when  freeBytes − logicalSize ≥ max(STORAGE_FREE_RESERVE_BYTES,
                                                totalBytes × STORAGE_FREE_RESERVE_FRACTION)
```

The reserve exists because a filesystem at 100% stops PostgreSQL, the audit log
and the session store from writing; one upload must never be able to take the
service down. Free space comes from the real `statfs` of the mount. When it
cannot be measured the check is **skipped and declared skipped** in the response
and on screen — not faked as "enough", and not turned into a blanket refusal that
would stop all uploads out of ignorance.

### Cleanup

`server/storage/uploadCleanup.js` runs once at boot and hourly. It touches only
sessions that are **not committed** and **expired** — the `status <> 'committed'`
condition is in the SQL itself, not only in the caller, so a mistaken caller still
cannot delete a committed session — and its filesystem scope is
`.staging/uploads/<valid-id>/` only. It never touches `uploads/` or `versions/`.
Staging directories with no surviving session row are reclaimed by comparison
against the live id list, not by file mtime.

### Client UX

Both the Uploads screen and the Files upload drawer now use the V2 path and
report **Preparing · Hashing · Uploading · Paused · Committing · Complete ·
Failed** (plus Cancelled), with bytes transferred, total bytes, percentage, and
current chunk of total. Percentages come only from real XHR byte events and the
chunk state the server reports; there are no stage-derived fake percentages.

A dropped connection **pauses** and offers **Resume**, which asks the server what
is missing and re-sends only those chunks — completed chunks are never re-sent.
Failures carry a specific reason (too large / no space / checksum / expired /
network) rather than a bare "Failed". Cancelling releases the staged bytes on the
server immediately instead of waiting for expiry. Files over the limit are
rejected with a visible row and an explanation, never dropped silently. The
screen shows the **configured** limit and the **measured** free space read from
`GET /api/files/uploads/limits`, replacing the 1 GiB constant that had been
hard-coded in three places. **No copy anywhere claims unlimited file size.**

### Deliberately unchanged

- **Private Vault.** `MAX_VAULT_CIPHERTEXT_BYTES`, the KEK/DEK format, metadata
  encryption, ownership semantics and Preview policy are byte-for-byte unchanged.
  Its per-chunk AEAD design is written down in the concept note for `LFT-V2-B` but
  **not implemented here**. Raising the constant and splitting the existing
  whole-file GCM ciphertext ad hoc are both explicitly rejected.
- **Production nginx.** No runtime nginx change. `LFT-V2-C` will retune
  `client_max_body_size`, `proxy_request_buffering` and timeouts to chunk-sized
  semantics *after* the application protocol is deployed.
- **Download.** Still a real server read stream with `Content-Length` and
  `Content-Disposition`; nothing was converted to an `ArrayBuffer`. **Range
  requests were not added** — partial-download support that is not correct end to
  end would be worse than none, so it is not faked.
- **The legacy endpoint.** `POST /api/files/upload` remains available and
  unchanged for existing clients and scripts; the UI no longer uses it. Its
  limitations are documented in place. Removal is a separate task after V2 passes
  production acceptance. Existing stored files were not migrated or rewritten.

## Source files changed

**New — server**

- `IDEA1-AEGIS_Drive_LC/server/config/transferLimits.js` — the five
  deployment-configurable limits, chunk-count/expected-size arithmetic, and the
  free-space reserve rule. Invalid environment values fail the boot.
- `IDEA1-AEGIS_Drive_LC/server/storage/uploadStaging.js` — opaque staging area,
  streamed positional chunk writes with a hard byte cap, staged size and SHA-256
  from disk, atomic publish by `rename`, and orphan detection.
- `IDEA1-AEGIS_Drive_LC/server/storage/uploadCleanup.js` — one cleanup pass plus
  the hourly schedule; both rules that protect committed data live here.
- `IDEA1-AEGIS_Drive_LC/server/routes/uploads.js` — the five session routes and
  the limits route, all owner-scoped behind `requireAuth` and CSRF.
- `IDEA1-AEGIS_Drive_LC/server/db/migrations/003_upload_sessions.sql` — the
  reviewed path for an already-initialised `aegis_drive`.

**New — client and tests**

- `IDEA1-AEGIS_Drive_LC/src/lib/chunkedUpload.js` — incremental slice-based
  SHA-256, the resumable upload state machine, retry/pause semantics, and session
  cancellation. The only place in the app that reads bytes of a user's file.
- `IDEA1-AEGIS_Drive_LC/tests/resumableUpload.test.js` — 14 API tests through the
  real Express app.
- `IDEA1-AEGIS_Drive_LC/tests/chunkedUploadClient.test.js` — 8 browser-transport
  tests.

**Modified**

- `IDEA1-AEGIS_Drive_LC/server/db/schema.sql` — `upload_sessions` and
  `upload_session_chunks` for new databases, with the reasoning for the child
  table and the prohibition on reusing it for the Vault.
- `IDEA1-AEGIS_Drive_LC/server/db/store.js` — session/chunk accessors in both DB
  modes; every lookup takes a mandatory `userId` and filters in SQL.
- `IDEA1-AEGIS_Drive_LC/server/routes/api.js` — mounts `uploadsRouter` at
  `/files/uploads` **before** the `/files/:id` routes (Express matches in
  declaration order), and records the legacy endpoint's status in place.
- `IDEA1-AEGIS_Drive_LC/server/index.js` — staging init before the port opens;
  one cleanup pass at boot plus the hourly schedule.
- `IDEA1-AEGIS_Drive_LC/src/lib/api.js` — `apiUpload` accepts caller headers so a
  chunk can be sent as `application/octet-stream`. No other behaviour changed.
- `IDEA1-AEGIS_Drive_LC/src/screens/Uploads.jsx` — rewritten onto the V2 path
  with the seven truthful states, byte/chunk counters, Resume and Cancel, and
  server-reported limits.
- `IDEA1-AEGIS_Drive_LC/src/components/UploadDrawer.jsx` — same migration; its
  whole-file `sha256OfFile()` and its duplicated 1 GiB constant are gone.
- `IDEA1-AEGIS_Drive_LC/src/lib/strings.js` — 20 new keys in TH/EN/ZH; the
  `uploadTooLarge` copy no longer hard-codes "1 GB".
- `IDEA1-AEGIS_Drive_LC/tests/uploadProgress.test.js` — the structural assertion
  now follows `apiUpload` to `chunkedUpload.js`, where the per-chunk call lives.
- `IDEA1-AEGIS_Drive_LC/tests/uploadCompletionUx.test.js` — the drawer's injected
  seam is now `runUpload`/`loadLimits` instead of `uploadFile`/`hashFile`.
- `IDEA1-AEGIS_Drive_LC/.env.example` — documents the five new variables, the
  accepted chunk range, and the free-space formula. No secret added.

`IDEA1-AEGIS_Drive_LC/dist/` was rebuilt during verification and deliberately
**restored to its committed state**; no build artefact is included.

## Verification evidence

- `npm test` (IDEA1, in-memory DB mode) — **pass: 436 tests, 417 passed, 0 failed,
  19 skipped**. The 19 skips are the pre-existing `TEST_DATABASE_URL`-gated
  PostgreSQL vault tests, unchanged by this task.
- `node --test tests/resumableUpload.test.js` — **pass: 14/14**. Covers, by number:
  (1) own-session read; (2) cross-user `404` on GET/PUT/commit/DELETE with the
  session provably intact afterwards, Admin included; (3) valid chunk accepted;
  (4) duplicate retry idempotent — the same chunk sent four times leaves
  `receivedBytes` and the final file length unchanged; (5) out-of-range, negative
  and non-numeric chunk indices rejected and not recorded; (6) short, long, and
  full-sized-final chunks rejected and not recorded; (7) missing chunk blocks
  commit and names the missing index; (8) size mismatch blocks commit and
  publishes nothing; (9) server-computed SHA-256 mismatch blocks commit, aborts
  the session and reclaims the bytes; (10) successful commit yields exactly one
  file whose bytes on disk and downloaded bytes both equal the source;
  (11) nothing appears in `GET /api/files` before commit; (12) resume status
  reports the missing chunk accurately and finishes with a matching hash;
  (13) cleanup removes the abandoned session and leaves the committed file's row,
  disk bytes, download and session status untouched; (14) a file uploaded through
  the legacy V1 endpoint still downloads byte-for-byte and still verifies;
  (17) CSRF blocks create/chunk/commit/cancel without a token and blocks a
  cross-origin chunk, without damaging the session. Plus the logical-size ceiling,
  cancellation, and the unauthenticated-access checks.
- `node --test tests/chunkedUploadClient.test.js` — **pass: 8/8**. Covers (15) and
  (16). (15) is proven **behaviourally, not by grep**: the test drives a `File`
  whose whole-file `arrayBuffer()` throws on any call, and the hash still comes
  out equal to the SHA-256 of the whole buffer; a source scan for
  `file.arrayBuffer()` and `crypto.subtle.digest(` across `chunkedUpload.js`,
  `Uploads.jsx` and `UploadDrawer.jsx` backs it up. (16) records every slice read
  and every chunk sent, asserting no read exceeds the declared bound, that reads
  tile the file exactly once with no gap or overlap, that the last chunk is the
  remainder rather than a full block, and — on the server side — that the chunk
  route contains no `express.raw`/`express.json`/`multer`/`.buffer` and pipes the
  request stream straight to a positional `createWriteStream`.
- `node --test tests/uploadProgress.test.js tests/uploadCompletionUx.test.js tests/uploadDrawerUi.test.js`
  — **pass: 12/12** after the two seam updates.
- `npm run build` (IDEA1) — **pass: built in 7.91s**, no chunk-size warning
  introduced. `git status` after the build shows only intended paths.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge`
  — **pass**, with the same two pre-existing owner-review Canvas warnings recorded
  on `main` (`AEGIS_Architecture_Canvas.canvas`, `AEGIS_Knowledge_Network.canvas`).
- `node --test tests/vaultStructure.test.mjs tests/vaultMultiWriter.test.mjs tests/collaborationPolicy.test.mjs tests/dockerBootstrap.test.mjs tests/endpointOnboarding.test.mjs`
  (root policy suites) — **pass: 53/53**.
- `node scripts/validate-collaboration-policy.mjs --event <pr-event.json> --changed-files <delta>`
  over this branch's Pull Request body and changed-file delta — **pass**.
- `git diff --check` — **pass**: no whitespace errors (only the repository's usual
  CRLF normalisation notices from `.gitattributes`).
- Targeted secret scan over the changed delta — **pass**: no new key material,
  credential, token value or API key, and no high-entropy literal of 40 characters
  or more anywhere in the added lines. Three matches were reviewed and are the
  repository's existing **public** test fixtures, reused verbatim rather than
  introduced: `aegis-drive-user` and `aegis-drive-admin` (the seed demo passwords
  already in `server/db/seed.sql` and in seven existing test files on `main`), and
  the `test-only-session-secret-not-used-in-production` string that every existing
  IDEA1 API suite sets. `.env.example` gained documentation and default sizes
  only — no value.
- **Vault suites unchanged and still green** — the IDEA1 vault tests run inside
  the `npm test` figure above and were not modified.
- **No destructive production test was run.** No production database, container,
  image, gateway or configuration was touched, and nothing was deployed.

### What the evidence does not prove

The suites ran in **in-memory DB mode**; `TEST_DATABASE_URL` was not set, so the
PostgreSQL code path of the new store functions and the new migration were **not
executed against a real PostgreSQL instance**. The SQL is written to the same
shape as the existing `files`/`vault_blobs` accessors and the migration mirrors
`schema.sql`, but that is a structural argument, not a measurement. Running the
suite against an isolated `aegis_drive_test` is required before deployment and is
named under Integration requests.

The largest file actually transferred through the protocol in these tests is
~16.8 MiB (three 8 MiB chunks). Multi-gigabyte behaviour is argued from bounded
memory and streaming, and is proven only for the bound, not for the size — the
size rows belong to the `LFT-V2-D` matrix.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — new section
  "Large-file transfer V2 — resumable chunked foundation (2026-08-28)" recording
  the measured pre-V2 limits, the Stage A implementation, what was deliberately
  left unchanged, and that verification is local only with production acceptance
  not started.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/summaries/08_Outstanding_Items_Consolidated.md`
  — adds `LARGE_FILE_TRANSFER_V2 = IN_PROGRESS` under real functional gaps with
  the A/B/C/D stage status, and an operational caveat stating that **Private Vault
  large-file transfer remains IN PROGRESS** and that the Normal Files improvement
  must not be read as a Vault improvement.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/concepts/Large_File_Transfer_V2.md` —
  **new canonical concept note**: production symptom, the three confirmed limits,
  the bandwidth-versus-architecture distinction, the V2 architecture, security
  boundaries, the staged A/B/C/D plan, the `LFT-V2-B` Vault crypto design, the
  `LFT-V2-C` nginx scope, the `LFT-V2-D` acceptance matrix, the statement that a
  mapped network drive/SMB is **not** an equivalent transport and must not bypass
  AEGIS RBAC/audit/storage metadata, and the report-ready note.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/index.md` — one line for the genuinely new
  canonical note.

No historical receipt was edited, and `log.md` was not touched.

## Shared surfaces touched

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/concepts/Large_File_Transfer_V2.md` — a
  new **Core-adjacent concept note**, outside the `idea1/` and `summaries/04_`
  knowledge boundary. It states a cross-module architectural rule (SMB/mapped
  drives are not an alternative transport) and specifies unimplemented Private
  Vault cryptography, so it needs integration review rather than IDEA1 sign-off
  alone.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/summaries/08_Outstanding_Items_Consolidated.md`
  — the project-wide open-items register, read by every area. This task adds one
  open item and one operational caveat that constrain a **future** Private Vault
  change.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/index.md` — the vault entry index, an
  owner-only Core surface; one line added for the new canonical note.

No file under `HUB-AEGIS_Entry/`, `gateway/`, `postgres/`, `shared/`,
`docker-compose.yml`, the root `.env.example`, or any IDEA2/IDEA3 path was
changed. The only `.env.example` touched is
`IDEA1-AEGIS_Drive_LC/.env.example`, which is inside the IDEA1 boundary.

## Integration requests

- **Kla, integration review — the SMB/mapped-drive prohibition is a project-wide
  architectural rule, not an IDEA1 preference.** The decision to confirm is:
  *bulk file movement into the Data Lake must continue to enter through the
  Application Layer, because a share that writes the volume directly bypasses
  server-side RBAC, the audit trail, and the entire Metadata Layer — leaving files
  with no owner, no checksum, no version history and no forensic record of
  arrival.* This is recorded in a Core-adjacent concept note and will be cited by
  future infrastructure decisions, so it should be accepted or amended
  deliberately rather than inherited from an IDEA1 receipt. Rollback is a revert
  of the note; it touches no runtime behaviour.
- **Kla, integration review — the `LFT-V2-B` Private Vault cryptographic design is
  specified here but not implemented.** The decision to confirm is the design
  itself: one DEK per logical file; plaintext split into bounded chunks; AES-256-GCM
  authenticated **independently per chunk**; a unique 96-bit IV per encrypted
  chunk; AAD binding at minimum the format version, logical file identifier, chunk
  index and total chunk count; ciphertext-only server storage; encrypted metadata
  left encrypted; the wrapped DEK left server-opaque; retries that can never cause
  IV reuse with different plaintext; and V1 blobs still readable. Accepting this
  now sets the contract the next PR is measured against. Any later request to
  simply raise `MAX_VAULT_CIPHERTEXT_BYTES`, or to chunk the existing whole-file
  GCM ciphertext without per-chunk authentication, is a different decision with a
  different risk profile and must come back through review.
- **Kla, deployment decision — this is source-complete and unaccepted.** Before
  any deployment: (a) run the IDEA1 suite against an isolated `aegis_drive_test`
  with `TEST_DATABASE_URL` set, since the new PostgreSQL code path and
  `003_upload_sessions.sql` are unexecuted here; (b) apply
  `server/db/migrations/003_upload_sessions.sql` to the existing `aegis_drive` as
  the superuser, since `drive_app` deliberately cannot create tables; (c) decide
  the production value of `MAX_LOGICAL_FILE_BYTES` against the real volume — the
  5 GiB default is a safe starting value for the current 56.9 GB filesystem, not
  an architectural maximum; and (d) execute the `LFT-V2-D` matrix. Rollback is a
  revert of this Pull Request plus a Drive rebuild; the two new tables can be left
  in place harmlessly, or dropped, since nothing else references them and no
  existing table, column or row was altered.
- **Kla, sequencing — `LFT-V2-C` must not be pulled forward.** The HUB and gateway
  `client_max_body_size` values stay at 512 MiB in this Pull Request on purpose.
  They are now larger than one chunk, so they no longer bound a logical file, and
  retuning them together with `proxy_request_buffering` and the timeouts should
  happen once the chunk protocol is actually running in production and its request
  shape can be measured.

## Known limitations

- **Not deployed, not accepted in production, not measured at scale.** Everything
  recorded above is local verification of source. `PRODUCTION_ACCEPTANCE` for
  large-file transfer stays open, and the matrix in the concept note is a plan.
- **The PostgreSQL path of the new code is untested.** The suites ran in in-memory
  mode. The new store functions' SQL and `003_upload_sessions.sql` have not been
  executed against a real PostgreSQL instance. This is the single largest gap in
  the evidence and is the first item under Integration requests.
- **The largest file actually transferred in the tests is ~16.8 MiB.** Bounded
  memory is proven; multi-gigabyte transfer is not. Nothing here demonstrates a
  2 GiB or 5 GiB upload.
- **Resume after a full browser refresh is not available.** A browser cannot
  re-open a previously selected `File` without the user picking it again, and
  there is no endpoint that lists a user's open sessions, so a refresh loses the
  client's handle on the session even though the server keeps it. Resume works for
  network interruption, chunk failure and retry within the tab. Adding a session
  list endpoint plus re-selection matching is a `LFT-V2-D` item.
- **Concurrent uploads of the same filename by the same user are not serialised.**
  Two sessions for one name will each version the file at commit in the order they
  commit, exactly as two sequential legacy uploads would. That is consistent with
  the existing behaviour, but it was not made explicitly safe and was not tested.
- **A checksum mismatch discards the whole session.** The server cannot tell which
  chunk is corrupt, so the user re-uploads the file. A per-chunk client-declared
  hash could narrow it; that was not built, and the per-chunk hash the server
  stores is diagnostic only.
- **Range requests on download were not implemented**, so a partially downloaded
  large file still restarts. This was scoped out rather than faked.
- **Private Vault is unchanged and still capped at ~64 MiB of ciphertext**, still
  encrypts whole files in browser memory, and still downloads the complete
  ciphertext before decrypting. Nothing in this task improves it.
- **The legacy `POST /api/files/upload` still exists** with its original 1 GiB and
  whole-file-request behaviour. It is no longer reachable from the UI, but it is
  reachable by any authenticated client.
- **The free-space check is a point-in-time check at session open.** It does not
  reserve the space, so several sessions opened at once could between them exceed
  what was free; the reserve margin absorbs the ordinary case rather than
  guaranteeing the worst one. Per-user quota does not exist and was not added.
- **The staging area shares the volume with `uploads/` and `versions/`**, so
  abandoned sessions consume the same space as live data until cleanup runs. The
  hourly schedule and the boot pass bound this, but a burst of abandoned uploads
  inside one hour is not bounded.
- Everything the previous IDEA1 receipts recorded as open — `confirmDelete()`
  swallowing 403, no encryption at rest for ordinary Data Lake uploads, no
  off-site backup, sessions not surviving restart — remains true and was not
  addressed here.

---

## PostgreSQL integration gate — 2026-08-28T20:26:29+07:00

> [!info] Same unmerged task, one receipt
> This section records the **LFT-V2-A PostgreSQL integration gate**, run on this
> same branch before PR #43 was put forward for Code Owner approval. It is appended
> here rather than filed as a second receipt because AGENTS.md §7 and the
> collaboration-policy check define **one task → one Pull Request → one receipt**,
> and §9 permits updating a receipt that "is still part of the same unmerged task".
> Nothing above this line was altered; the record below is additive.
>
> **The gate found two real source defects, both fixed on this branch.** The
> headline claim of the section above — that the PostgreSQL path was unverified —
> is now superseded: see `Verification evidence` below for 454/454 against real
> PostgreSQL. Everything the section above records under `Known limitations`
> that is not explicitly closed below **remains true**.

`SCOPE = LFT-V2-A POSTGRES INTEGRATION`

`POSTGRES_15_ISOLATED = PASS`

`FRESH_SCHEMA_PATH = PASS`

`EXISTING_DB_MIGRATION_PATH = PASS`

`MIGRATION_IDEMPOTENT = PASS`

`APP_ROLE_SUPERUSER = NO`

`APP_ROLE_DDL_ALLOWED = NO`

`APP_ROLE_UPLOAD_SESSION_DML = PASS`

`APP_ROLE_UPLOAD_CHUNK_DML = PASS`

`POSTGRES_OWNER_ISOLATION = PASS`

`POSTGRES_RESUME_PERSISTENCE = PASS`

`POSTGRES_CHUNK_IDEMPOTENCE = PASS`

`POSTGRES_COMMIT_EXACTLY_ONCE = PASS`

`POSTGRES_CLEANUP_SAFETY = PASS`

`POSTGRES_CASCADE = PASS`

`SOURCE_DEFECT_FOUND = YES (2)`

`PRODUCTION_CHANGED = NO`

`PRODUCTION_MIGRATION_APPLIED = NO`

`FORMAL_REPORT = NO UPDATE`

`LARGE_FILE_TRANSFER_V2 = IN_PROGRESS`

### What the gate changed

This gate exists because LFT-V2-A shipped its source with every test run in the
**in-memory fallback store**. The SQL path of `upload_sessions` and
`upload_session_chunks`, `003_upload_sessions.sql`, the `drive_app` privileges,
`ON DELETE CASCADE`, cleanup, and commit behaviour under real transactions were
all unproven. That was the largest evidence gap in PR #43.

**The gate found two real source defects. Both are fixed in this PR, both have
regression tests, and one of them would have broken production on first deploy.**

### Defect 1 — the migration granted `drive_app` nothing when a different superuser applied it

`003_upload_sessions.sql` issued no `GRANT` of its own. Its header claimed the
`ALTER DEFAULT PRIVILEGES` statements in `postgres/init/02-app-roles.sh` would
cover tables created by later migrations. **Measured against PostgreSQL 15.18,
that claim is only true when the very same role that executed
`ALTER DEFAULT PRIVILEGES` also creates the tables** — default privileges are
recorded per creating role in `pg_default_acl.defaclrole`, not per database.

Reproduced directly: default privileges set by `lftv2_admin`, migration applied
by a second superuser `lftv2_migrator`:

```text
GRANTS for drive_app on upload_sessions / upload_session_chunks
  *** NO GRANTS AT ALL ***
SELECT upload_sessions as drive_app
  ERROR:  permission denied for table upload_sessions
```

A DBA applying the migration with any account other than the one that
initialised the roles — an entirely ordinary thing to do — would get a migration
that **reports nothing but success**, and a Drive that then fails at runtime with
`permission denied for table upload_sessions` on **every** upload.

**Fix (narrowest correct one):** an explicit, idempotent, role-guarded grant at
the end of the migration.

```sql
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'drive_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON upload_sessions, upload_session_chunks TO drive_app';
  END IF;
END
$$;
```

DML only — no ownership, no `CREATE`/`ALTER`/`DROP`/`TRUNCATE`, so the boundary
`02-app-roles.sh` draws is unchanged. Guarded on role existence so a development
database without `drive_app` still applies the file cleanly. Neither table owns a
sequence (`upload_id` is a `TEXT` primary key, `upload_session_chunks` has a
composite key), verified against PostgreSQL rather than assumed, so no sequence
grant is needed. The misleading header comment was replaced with the measurement.

### Defect 2 — a failed metadata write left a session that lied about being ready

Found by the failure-injection test, not by reading the code. When the metadata
write fails after the bytes are published, the old code removed the published
bytes (correct — no orphan) and released the session back to `open`. But publish
is a `rename` that has already moved the staged `part` file away, so the session
returned to `open` **with its bytes gone while its chunk rows still reported
`missing: []`**. The client sees a session that is ready to commit, and every
commit attempt returns `SIZE_MISMATCH` forever, with no way to recover.

**Fix:** move the published bytes **back** into staging first, then release. If
the move back fails, remove the bytes, clear the staging directory and mark the
session `aborted` — an honest terminal state instead of a permanently stuck one.
Both branches leave no orphan bytes.

### Hardening — commit exactly once, and cleanup that cannot pull bytes out from under it

Reviewing the consistency requirements against real transactions, commit-once was
being guaranteed only as a side effect of `rename` failing with `ENOENT` for the
loser, which surfaced as a `500`. That is fragile and inexpressive.

- `upload_sessions.status` gains a short-lived **`committing`** claim state.
  Commit now takes the session with a conditional update,
  `UPDATE … SET status = 'committing' WHERE upload_id = $1 AND user_id = $2 AND status = 'open'`,
  and proceeds only on `rowCount = 1`. The check is **in SQL**, not a read
  followed by a write in JavaScript, which has a window where two requests read
  the same value. The loser now receives a `409 SESSION_NOT_OPEN` it can explain.
- The chunk-count check runs **before** the claim, so an incomplete commit never
  parks the session in an intermediate state.
- Every failure path releases the claim: size mismatch and metadata failure
  return it to `open`; checksum mismatch sets `aborted` as before.
- Cleanup's status filter changed from a deny-list (`<> 'committed'`) to an
  **allow-list** (`IN ('open','aborted')`). A deny-list would have swept up
  `committing` — a session being committed at that instant — and deleted the
  staged bytes out from under a running commit. An allow-list also excludes any
  future status by default, which is the safe side.
- `DELETE /api/files/uploads/:id` refuses a session in `committing` for the same
  reason, with `409 SESSION_COMMITTING`.

### Isolated environment

A disposable PostgreSQL **15.18-alpine** container, `aegis-lftv2pg-db`, on its own
network `aegis-lftv2pg-net`, published only on `127.0.0.1:55433`. **No named
volume was declared.** The `postgres` image itself declares
`VOLUME /var/lib/postgresql/data`, so each run does create an *anonymous* volume;
this was caught during teardown, the script now removes it with `docker rm -fv`
on both the start and `down` paths, and a full up/down cycle was re-run to confirm
`docker volume ls` is byte-identical before and after. The five anonymous volumes
left by the earlier runs were removed individually **by name** — never with
`docker volume prune` — after confirming each was created during this session and
attached to no container. The one pre-existing unattached anonymous volume
(`3bb96008…`, created 2026-07-26) was deliberately left untouched, per the standing
caveat that an unattached volume of unknown ownership must not be deleted.
Credentials were generated by the script; no `.env` file was read and no
production credential was printed. `docker compose down`,
`docker system prune` and `docker volume prune` were never run. The pre-existing
local containers and volumes (`aegis_system-*`, `aegisdrivetest-*`) were left
untouched.

Roles mirror production: `lftv2_admin` (superuser, schema and migrations) and
`drive_app` — **the production role name on purpose** — as
`LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`, DML only, never table
owner. The application and the suites connect as `drive_app`.

### Source files changed

- `IDEA1-AEGIS_Drive_LC/server/db/migrations/003_upload_sessions.sql` — the
  explicit role-guarded `GRANT` (Defect 1); the `status` CHECK gains
  `'committing'`; the header comment now records the measured behaviour of
  `ALTER DEFAULT PRIVILEGES` instead of the claim that was wrong.
- `IDEA1-AEGIS_Drive_LC/server/db/schema.sql` — the same `status` CHECK widening
  for new databases, with the reason recorded next to it.
- `IDEA1-AEGIS_Drive_LC/server/db/store.js` — new
  `claimUploadSessionForCommit()` doing the conditional claim in SQL;
  `listExpiredUploadSessions()` and `deleteUploadSessionUnscoped()` switched to
  the `('open','aborted')` allow-list, shared with the memory mode through one
  `CLEANABLE_STATUSES` constant.
- `IDEA1-AEGIS_Drive_LC/server/routes/uploads.js` — commit claims the session
  before touching bytes and releases on every failure path; the metadata-failure
  path restores the staged bytes (Defect 2); cancel refuses `committing`.
- `IDEA1-AEGIS_Drive_LC/server/storage/uploadStaging.js` — new
  `restoreStagedPart()`, the atomic move back from `uploads/` into the session's
  staging area, with the path-containment check applied to the incoming key.
- `IDEA1-AEGIS_Drive_LC/tests/resumableUploadPostgres.test.js` — **new**, 18
  tests, `TEST_DATABASE_URL`-gated in the same shape as `vaultPostgres.test.js`.
- `IDEA1-AEGIS_Drive_LC/scripts/pg-integration-env.sh` — **new**, the reproducible
  disposable-environment provisioner, with the isolation guarantees stated in its
  header.

No production file, deployment file, gateway config, Docker Compose file or
`postgres/init/*` script was changed.

### Verification evidence

- **`npm test` (IDEA1) against real PostgreSQL 15.18 — pass: 454 tests, 454
  passed, 0 failed, 0 skipped.** This is the number that closes the gate: the
  previously-skipped 19 `TEST_DATABASE_URL`-gated Vault Postgres tests now
  execute too, so the whole IDEA1 suite has run against a real database.
- `npm test` (IDEA1) in in-memory fallback mode — pass: 454 tests, 417 passed,
  0 failed, 37 skipped (the Postgres-gated suites). Both modes stay green.
- `node --test --test-concurrency=1 tests/resumableUploadPostgres.test.js` — pass:
  18/18, covering the gate's numbered list against real SQL: (1) session row
  written with the real column values; (2) owner reads own session; (3) other user
  gets 404 on all four verbs, the row survives, and no `user_id` other than the
  owner's can select it in SQL; (4) chunk row persisted with its real size and
  hash; (5) four identical sends leave exactly one row (`ON CONFLICT DO UPDATE`);
  (6) missing chunks reported accurately; (7) **application restart** — the
  listener is closed and a fresh `createApp()` is started, the session and its
  received chunks are still there, and the upload finishes with a matching hash;
  (8) missing chunk blocks commit and leaves `status = 'open'`; (9) server-computed
  hash mismatch blocks publication and sets `aborted`; (10) successful commit
  writes exactly one `files` row whose bytes on disk equal the source;
  (11) no `files` row exists for a partial upload; (12) cancel removes the session
  row, the chunk rows and the staging directory; (13) expiry cleanup removes only
  expired open sessions; (14) the committed session, its `files` row and its bytes
  survive cleanup; (15) `ON DELETE CASCADE` in both directions — deleting a
  session removes its chunks, and deleting a user removes their sessions and then
  their chunks.
- **Commit exactly once, measured:** two `POST /commit` requests fired with
  `Promise.all` on one session return exactly `[201, 409]`, the loser's code is
  `SESSION_NOT_OPEN`, and `SELECT count(*) FROM files WHERE name = $1` is `1`.
- **Cleanup safety, measured:** a session forced to `committing` and expired is
  **not** deleted and its staging directory still exists, while an expired `open`
  session next to it is removed and a committed one is untouched.
- **Failure injection with a real database failure:** a superuser connection
  revokes `INSERT ON files` from the application role mid-commit. The commit
  returns `500`, no `files` row is written, `readdir(uploads/)` is byte-identical
  before and after (no orphan), the session returns to `open`, and after the grant
  is restored the same session commits successfully **without re-uploading any
  chunk**. This test is what found Defect 2.
- **CHECK constraints proven at the database, not the app:** a bogus `status`,
  a negative `logical_size`, a zero `chunk_size`, a negative `chunk_index` and a
  zero `size_bytes` are each rejected by PostgreSQL; all four valid statuses
  including `committing` are accepted.
- **Privilege matrix as `drive_app` (`rolsuper = false`, asserted in the test):**
  `SELECT`/`INSERT`/`UPDATE`/`DELETE` allowed on both new tables;
  `CREATE TABLE` → `permission denied`, `ALTER TABLE` → `must be owner`,
  `DROP TABLE` → `must be owner`, `TRUNCATE` → `permission denied`. Applying
  `003_upload_sessions.sql` as `drive_app` against a database where the tables are
  absent fails with `ERROR: permission denied for schema public` and creates
  nothing — the application role can never run a migration.
- **PATH A (fresh database):** `CREATE DATABASE aegis_drive_test` → `schema.sql` →
  `seed.sql` → scoped grants. Both tables and all four indexes present; both
  tables owned by `lftv2_admin`, not by the app role; `drive_app` holds exactly
  `DELETE,INSERT,SELECT,UPDATE` on each. The full suite then ran against it.
- **PATH B (pre-V2 database migrated):** `aegis_drive_prev_test` built from the
  real `schema.sql` truncated at the LFT-V2-A section (not a hand-written
  imitation), given production-style grants **and** `ALTER DEFAULT PRIVILEGES` by
  `lftv2_admin`, seeded with two users and one file row, then migrated **by
  `lftv2_migrator`, a deliberately different superuser**. Result: both tables and
  all four indexes created; `drive_app` granted `DELETE,INSERT,SELECT,UPDATE` on
  both and able to query them; **second run of the same file applied with no
  error**, still 2 tables and 4 indexes; the pre-existing row fingerprint
  (`b1095600531fbf7fecd4bc385fa1ef9e`) and the pre-V2 column shape
  (`be6c1446473cb548995c72ccbaea4b90`) both **unchanged**.
- **The regression test fails against the defective migration.** With the `GRANT`
  block stripped back out, both new migration tests fail — the behavioural one on
  *"both tables must grant the application role — zero means the old defect is
  back"*, and the structural one on the missing `GRANT`. Restoring the fix returns
  them to 2/2. The proof is not vacuous.
- `node --test tests/vaultStructure.test.mjs tests/vaultMultiWriter.test.mjs tests/collaborationPolicy.test.mjs tests/dockerBootstrap.test.mjs tests/endpointOnboarding.test.mjs`
  — pass: 53/53.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge`
  — pass, with the same two pre-existing owner-review Canvas warnings recorded on
  `main`.
- `node scripts/validate-collaboration-policy.mjs --event <pr-event.json> --changed-files <delta>`
  — pass.
- `npm run build` (IDEA1) — pass: built in 4.04s. `dist/` was restored to its
  committed state afterwards; no build artefact is included.
- `git diff --check` — pass: no whitespace errors.
- Targeted secret scan over the changed delta — pass: no new key material,
  credential, token value or API key, and no high-entropy literal. The isolated
  instance's credentials are generated at run time by
  `scripts/pg-integration-env.sh` and exist only in that shell; they are not in
  the repository. The one literal password in the new suite,
  `probe-only-not-a-production-credential`, belongs to a temporary superuser role
  created and dropped inside a throwaway probe database.
- **No production database, container, image, volume or configuration was
  touched, and `003_upload_sessions.sql` was NOT applied to production
  `aegis_drive`.** No `docker compose down`, `docker system prune` or
  `docker volume prune` was run at any point.

### Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — the LFT-V2
  section records that the PostgreSQL integration gate passed, the full suite is
  454/454 against real PostgreSQL with zero skips, the two defects found and
  fixed, and that production migration and acceptance remain outstanding.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/concepts/Large_File_Transfer_V2.md` — the
  architecture note gains the measured `ALTER DEFAULT PRIVILEGES` finding, the
  `committing` claim state, the cleanup allow-list, and the corrected description
  of the metadata-failure path.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/summaries/08_Outstanding_Items_Consolidated.md`
  — `LARGE_FILE_TRANSFER_V2` stays `IN_PROGRESS`; the entry now reflects that the
  PostgreSQL evidence gap is closed while production acceptance is not.

### Shared surfaces touched

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/concepts/Large_File_Transfer_V2.md` — the
  Core-adjacent concept note outside the `idea1/` knowledge boundary, updated with
  the migration-privilege finding. It is cited by the deployment plan and by the
  future `LFT-V2-B`/`C`/`D` stages.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/summaries/08_Outstanding_Items_Consolidated.md`
  — the project-wide open-items register read by every area.

No file under `HUB-AEGIS_Entry/`, `gateway/`, `postgres/`, `shared/`,
`docker-compose.yml`, the root `.env.example`, or any IDEA2/IDEA3 path was
changed. In particular **`postgres/init/02-app-roles.sh` was deliberately not
modified**: the fix belongs in the migration that creates the tables, not in the
shared bootstrap script, so it cannot regress another module's role setup.

### Integration requests

- **Kla, integration review — the migration-privilege finding changes the
  deployment instruction for every future IDEA1 migration, not just this one.**
  The decision to confirm is: *a migration that creates a table must grant the
  scoped application role explicitly; `ALTER DEFAULT PRIVILEGES` in
  `postgres/init/02-app-roles.sh` must not be relied on, because it only applies
  to tables created by the same role that executed it.* Every future migration in
  IDEA1 and IDEA2 inherits this. An alternative is to add
  `ALTER DEFAULT PRIVILEGES FOR ROLE <each superuser>` in the bootstrap, which was
  deliberately **not** chosen here because it requires knowing every account a DBA
  might use. Rollback is a revert of this PR; the two tables can be dropped or
  left, since nothing else references them.
- **Kla, deployment gate — production migration is still NOT done, and is a
  separate staged gate.** When it happens: apply
  `server/db/migrations/003_upload_sessions.sql` to production `aegis_drive` **as
  the superuser** (`drive_app` cannot, proven above), confirm afterwards that
  `information_schema.role_table_grants` shows `drive_app` holding all four DML
  privileges on both tables, then decide the production `MAX_LOGICAL_FILE_BYTES`
  against the real volume, then run the `LFT-V2-D` matrix. The migration is
  idempotent and rewrites no existing row, so re-running it is safe.
- **Kla — `LFT-V2-C` still must not be pulled forward.** HUB and gateway
  `client_max_body_size` stay at 512 MiB in this PR.

### Known limitations

**None of the following were fixed by this gate, and none should be read as
closed.**

- **Production migration has NOT been applied**, and no production database,
  container or volume was touched. This gate only determines whether PR #43 is
  safe to approve.
- **2 GiB / 5 GiB production transfer is still unmeasured.** The largest file
  moved through the protocol in any test remains ~16.8 MiB (three 8 MiB chunks).
  Bounded memory is proven; scale is not. Those rows belong to `LFT-V2-D`.
- **Browser-refresh resume is still not automatic.** A browser cannot re-open a
  previously selected `File`, and there is still no endpoint listing a user's open
  sessions. Resume covers network interruption, chunk failure and retry within the
  tab.
- **Range download is not implemented**, so a partially downloaded large file
  still restarts.
- **Concurrent sessions do not reserve free space globally.** The free-space check
  remains point-in-time at session open; several sessions opened together could
  between them exceed what was free. Per-user quota still does not exist.
- **Same-name concurrent commits are not serialised.** Commit-exactly-once is now
  guaranteed *per session*; two different sessions for the same filename still
  version the file in commit order. That matches the legacy behaviour and was not
  hardened.
- **Private Vault remains V1 whole-file crypto**, still capped at ~64 MiB of
  ciphertext. Nothing in this gate touched it.
- **The `committing` window is not crash-safe.** If the process dies between the
  claim and the final status write, the session stays `committing` forever:
  cleanup will not touch it by design, and the user cannot retry it. No reaper for
  stale `committing` sessions was added. It is a narrow window (the size and hash
  read plus one rename), it leaks no data and publishes nothing, but it is a real
  gap and belongs to a follow-up.
- **The failure-injection test needs `AEGIS_PGTEST_SUPER_URL`.** Without it that
  single test and the migration-grant behavioural test skip, because revoking a
  privilege requires a superuser the application deliberately is not. The
  structural assertion on the migration text still runs.
- **PostgreSQL 15.18 only.** The production server version was not read as part of
  this gate, so "the same behaviour on the exact production minor version" is an
  inference from the major version, not a measurement.
