---
title: Large File Transfer V2 — Resumable Chunked Transport
tags: [aegis, concept, idea1, drive, upload, transfer, resumable, integrity, storage]
type: concept
created: 2026-08-28
updated: 2026-08-29
sources: ["[[idea1/idea1-status]]", "[[concepts/Three_Layer_Data_Lake]]"]
owner: kla
edit_policy: owner-writable
---

# 📦 Large File Transfer V2 — Resumable Chunked Transport

> **The claim this architecture supports, exactly as worded:**
> *Large files are transferred in bounded chunks and may resume after an
> interruption. The logical file-size ceiling is controlled by storage capacity,
> quota and deployment configuration rather than browser RAM or one HTTP request.*
>
> **The claim it does not support, and which must never be made anywhere:**
> "unlimited file size".

---

## 1. Production symptom

Users transferring large files into AEGIS Drive over the LAN/VLAN and over
Twingate hit failures and stalls that looked like a network problem: an upload
that ran for minutes and then died with nothing saved, a browser tab that became
unresponsive on multi-gigabyte files, and a Private Vault that refused files far
smaller than the free space on the volume.

The reflex reading was bandwidth — VLAN throughput, Twingate relay speed, HDD
write rate. **That reading was wrong.** The failures reproduce on a fast local
link, and they reproduce at sizes far below any bandwidth limit.

`ROOT_CAUSE = APPLICATION_TRANSFER_ARCHITECTURE`

---

## 2. Confirmed limits before V2 (measured in source, not assumed)

| Layer | Constant / setting | Value | What it actually limited |
| :--- | :--- | :--- | :--- |
| Private Vault | `MAX_VAULT_CIPHERTEXT_BYTES` in `server/storage/vaultStore.js` | `67_108_864` (~64 MiB) | Ciphertext of one vault file, per request |
| Normal Files backend | `MAX_UPLOAD_BYTES` in `server/storage/fileStore.js` | `1_073_741_824` (1 GiB) | One multipart request **and** one logical file, conflated |
| HUB edge | `client_max_body_size` in `HUB-AEGIS_Entry/nginx.conf`, `location /drive/` | `512m` | Any single request through `/drive` — the tightest of the three |
| Dev gateway | `client_max_body_size` in `gateway/nginx.conf` | `512m` | Same, on the local dev compose path |

Two browser-side behaviours mattered at least as much as the numbers above:

- **Normal Files** — `Uploads.jsx` and `UploadDrawer.jsx` both computed the
  checksum with `file.arrayBuffer()` followed by `crypto.subtle.digest()`. That
  is the whole file in the tab's RAM before a single byte is sent. WebCrypto has
  no streaming digest API, so this was not an oversight in the call — it was the
  only thing `subtle.digest` can do.
- **Private Vault** — `file.arrayBuffer()` → whole-file AES-GCM encrypt → whole
  ciphertext held in RAM → one multipart request. Download and preview mirror it:
  the complete ciphertext is fetched before decryption begins.

**So the effective ceiling was `min(one-request limit, browser RAM)`, and the
smallest number on the path — 512 MiB at the HUB — silently won.**

---

## 3. Network bandwidth is not the same thing as transfer architecture

This distinction is the whole point of the note, and it generalises past this
feature.

- **Bandwidth** determines *how long* a given number of bytes takes. It is
  measured in bits per second and it is improved by better links, better routing,
  or fewer hops.
- **Transfer architecture** determines *whether a transfer can complete at all,
  and what happens when it does not.* It is decided by how the application frames
  the work: one request or many, whole-file buffers or bounded ones, restart from
  zero or resume from the last acknowledged unit.

A file that fails at 480 MiB on a 1 Gb/s LAN is not a bandwidth failure. Doubling
the link speed halves the time to reach the same failure. Only the framing of the
work changes the outcome — which is why the fix is in the application, and why
`LFT-V2-C` (nginx tuning) is a *follow-up* to the protocol rather than a
substitute for it.

The corollary matters for expectation-setting: **V2 does not make transfers
faster.** On a healthy link a large upload takes about as long as it did before.
What changes is that it *finishes*, that an interruption costs one chunk instead
of the whole file, and that the tab does not need gigabytes of RAM.

---

## 4. V2 architecture — bounded chunks with durable session state

### 4.1 The protocol

```text
1. POST   /api/files/uploads                     open a session
2. PUT    /api/files/uploads/:id/chunks/:index   send one bounded chunk
3. GET    /api/files/uploads/:id                 ask which chunks are still missing
4. POST   /api/files/uploads/:id/commit          server verifies, then publishes
5. DELETE /api/files/uploads/:id                 cancel and reclaim staged bytes
   GET    /api/files/uploads/limits              the ceilings this deployment enforces
```

Steps 2 and 3 repeat as needed; that repetition *is* the resume mechanism.

### 4.2 Chunk size

Server-dictated, deployment-configurable through `UPLOAD_CHUNK_SIZE_BYTES`.
Default **16 MiB**, accepted range **8–64 MiB**.

The client never chooses it. The server writes each chunk at byte offset
`index * chunkSize`, so a client able to pick that value could choose where its
bytes land. The value the client must use is returned by the session response.

### 4.3 Staging on disk

```text
STORAGE_ROOT/.staging/uploads/<opaque-48-hex-id>/part
```

One sparse file per session; every chunk is a positional write at its own offset.
The consequences are deliberate:

- **Commit is a `rename`, not a copy.** No second copy of a multi-gigabyte file
  is ever created, and publishing is atomic — there is no instant at which the
  final key exists with incomplete bytes behind it.
- **A resent chunk overwrites exactly its own range**, so retry is idempotent by
  construction rather than by bookkeeping.
- **No chunk has a filename**, so there is no per-chunk name to make opaque.
- The directory name is a random 24-byte id, never the user's filename. A user
  filename never becomes a path on disk — the same rule `uploads/<uuid>.bin`
  already follows in [[concepts/Three_Layer_Data_Lake]].

### 4.4 Durable session state

`upload_sessions` and `upload_session_chunks` in PostgreSQL — created by
`server/db/schema.sql` for new databases and by the idempotent
`server/db/migrations/003_upload_sessions.sql` for existing ones.

Session state is **not** React memory and **not** process memory. It survives a
browser retry, a temporary network interruption, a failed request, and an
application restart. State that dies with the tab is not resume.

One row per received chunk, not an array on the session row: chunks can be in
flight concurrently, and concurrent read-modify-write on one array loses updates
silently. `INSERT … ON CONFLICT DO UPDATE` per row is correct under any amount of
resending.

> [!warning] A migration must grant the application role explicitly
> `003_upload_sessions.sql` issues its own
> `GRANT SELECT, INSERT, UPDATE, DELETE … TO drive_app`, guarded on the role
> existing. It does **not** rely on the `ALTER DEFAULT PRIVILEGES` statements in
> `postgres/init/02-app-roles.sh`. Measured against PostgreSQL 15.18, those
> statements only cover tables created by **the same role that executed them** —
> default privileges are recorded per creating role in `pg_default_acl.defaclrole`,
> not per database. Applying the migration with a different superuser account
> produced **zero** grants on both tables and a Drive that failed at runtime with
> `permission denied for table upload_sessions`, after a migration that reported
> nothing but success. **This applies to every future migration that creates a
> table, in IDEA1 and IDEA2 alike.**

### 4.5 Integrity — the server is the only source of truth

Three gates at commit, all read from the bytes on disk:

1. every chunk index present, each with the exact size the server computed;
2. the assembled file size equals the logical size declared when the session opened;
3. the **SHA-256 the server computes itself** equals the value the client claimed.

The client's checksum is only ever compared, never trusted. The browser computes
it incrementally with `hash-wasm`'s streaming SHA-256 over `file.slice()` ranges —
an existing dependency (Argon2id for the Vault), so no new package and no CSP
change: `'wasm-unsafe-eval'` is already granted.

A checksum mismatch aborts the session and discards the staged bytes. The
alternative — keeping a session whose bytes are known to be wrong so it can be
committed again — is an invitation to publish a corrupt file. Re-uploading costs
the user time; a silently wrong file costs them the data.

### 4.5.1 Commit happens exactly once, and nothing can pull the bytes away

`upload_sessions.status` carries a short-lived **`committing`** claim state.
Commit takes it with a conditional update —
`UPDATE … SET status = 'committing' WHERE upload_id = $1 AND user_id = $2 AND status = 'open'`
— and proceeds only when that affects one row. The mutual exclusion is **in SQL**;
a read in application code followed by a write has a window in which two requests
observe the same value. Two concurrent commits of one session therefore return
exactly `201` and `409`, and produce one `files` row. The completeness check runs
*before* the claim, so an incomplete commit never parks the session mid-state, and
every failure path releases the claim.

Two consequences follow, and both are enforced:

- **Cleanup uses an allow-list, not a deny-list.** It touches only `open` and
  `aborted` sessions. A deny-list (`<> 'committed'`) would have swept up a session
  that is being committed at that instant and deleted its staged bytes from under a
  running commit. An allow-list also excludes any status added later by default.
- **Cancel refuses a session that is committing**, for the same reason.

**If the metadata write fails after publication**, the bytes are moved *back* into
staging rather than merely deleted. Publish is a `rename`, so deleting the
published bytes and returning the session to `open` would leave a session whose
chunk rows still report `missing: []` while the bytes are gone — permanently
uncommittable, and lying to the client about being ready. If the move back itself
fails, the bytes are removed and the session is aborted honestly. Neither branch
leaves an orphan.

### 4.5.2 Surviving a process crash mid-commit

A claim that cleanup and cancel must not touch is only safe while the process
holding it is alive. Three mechanisms make a crash recoverable rather than
permanent.

**Durable commit intent.** The final storage key is chosen and written to
`upload_sessions.commit_storage_key` *in the same statement that takes the claim*,
before any rename. Previously the key existed only in a local variable, so a
process dying after the rename left bytes nothing could ever identify.
`commit_started_at` records the start of the lease and `committed_file_id` records
which `files` row the session produced.

**One transaction.** The `files` row, `committed_file_id` and `status='committed'`
are written together. A row still marked `committing` therefore means the metadata
was definitely not written — recovery never guesses which side of the metadata
write a crash landed on.

**A lease, not a new status.** `recoverStaleCommits()` takes rows where
`status='committing' AND commit_started_at < now() - lease` using
`FOR UPDATE SKIP LOCKED`, one row per transaction, so concurrent workers cannot
both recover the same row. No `recovering` status was added on purpose: it would
recreate the same "stuck in a state nobody recovers" problem one level up, whereas
a row lock is released automatically when a dying worker's connection drops.
Default lease `UPLOAD_COMMIT_LEASE_MS` = 15 minutes, which must stay well above a
real commit's duration — the slow step inside `committing` is hashing the staged
file.

Recovery converges to **OPEN**, **COMMITTED** or **ABORTED**, deciding only from
what is on disk and in the tables: bytes at the final key with no metadata are
moved *back* to staging and the session reopens; a `files` row that already
references the key with its bytes present is bound to the session and marked
committed without creating a second file; missing bytes abort truthfully rather
than claim success.

### 4.5.3 Same-name versioning must not move the previous file's bytes

The V2 commit records the previous version's `storage_key` **in place** and never
renames it. The earlier ordering called `moveToVersions()` before the metadata
write, so a crash in between left `files.path` pointing at a key that no longer
existed — measured against a live database, the user's existing file returned
`404` from `GET /api/files/:id/download` while the new one was not saved either.
Recording the old key as the version row inside the same transaction that repoints
`files.path` removes that window entirely rather than narrowing it.

The consequence to know: versions created by the V2 path live under `uploads/`
rather than `versions/`. That is a cosmetic on-disk difference; every consumer
resolves a version by its stored key, not by its directory. **The legacy V1
endpoint still uses `moveToVersions()` and still has this window.**

### 4.6 Logical size limit and the free-space rule

The 1 GiB constant is **not** the new architectural ceiling. Two separate,
configurable values replace it:

| Setting | Default | Range a deployment may set | Meaning |
| :--- | :--- | :--- | :--- |
| `UPLOAD_CHUNK_SIZE_BYTES` | 16 MiB | 8–64 MiB | Size of one HTTP request |
| `MAX_LOGICAL_FILE_BYTES` | 5 GiB | one chunk – **32 GiB** | Size of one file this deployment will accept |

The upper bound of that range is `MAX_SUPPORTED_LOGICAL_FILE_BYTES` =
`34_359_738_368` (32 GiB), exported from `server/config/transferLimits.js` and
mirrored for the Vault as `MAX_SUPPORTED_VAULT_LOGICAL_FILE_BYTES`. It is the
**largest value the environment is allowed to name**, not a value any deployment
receives. A deployment that does not set the variable keeps 5 GiB. Setting it
above 32 GiB fails at boot rather than being clamped silently, for the same
reason every other malformed value in this file does: a deployment must never run
at a ceiling that no file records.

Why bound it at all, rather than leaving the previous `Number.MAX_SAFE_INTEGER`?
An unbounded setting is a claim that files of *any* size work, made by nobody who
measured it. 32 GiB is the size at which the commit budget, the commit lease and
the edge timeout can still be explained — see §11.2. Beyond that somebody has to
measure first.

5 GiB is *a safe value for the current hardware*, not a maximum the design
implies. **Do not assume the present 56.9 GB filesystem is the final storage
capacity** — when the volume grows, this number is raised in the environment, not
in code.

On top of the ceiling, a session opens only when:

```text
freeBytes − logicalSize ≥ max(STORAGE_FREE_RESERVE_BYTES,
                              totalBytes × STORAGE_FREE_RESERVE_FRACTION)
```

Defaults: 2 GiB and 5%. The reserve exists because a filesystem at 100% stops
PostgreSQL, the audit log and the session store from writing — one upload must
never be able to take the whole service down. Free space comes from the real
`statfs` of the mount. When it cannot be measured the check is **skipped and
declared skipped** in the response and on screen, per
[[concepts/Honest_Telemetry_and_Unavailable_States]] — not faked as "enough" and
not turned into a blanket refusal.

### 4.7 Cleanup of abandoned sessions

`server/storage/uploadCleanup.js` runs once at boot and hourly thereafter. Two
rules, both test-pinned:

1. it touches only sessions that are **not committed** and **expired**
   (`status <> 'committed'` lives in the SQL itself, not only in the caller); and
2. it never touches `uploads/` or `versions/` — its scope is
   `.staging/uploads/<valid-id>/` only.

Staging directories with no surviving session row are also reclaimed, matched
against the live id list rather than against file mtimes.

### 4.8 Download

**Unchanged, and deliberately so.** `GET /api/files/:id/download` still streams
from disk through `openReadStream`, sets `Content-Length`, and never materialises
the file in memory on either side. Range requests were **not** added: partial
download support that is not correct end to end is worse than none, and nothing
in this scope needed it. The Vault's whole-file download path is a separate
problem and belongs to `LFT-V2-B`.

---

## 5. Security boundaries

Nothing here is a new path around an existing control.

- **Authentication and CSRF.** Every route sits behind `requireAuth` and the
  existing synchronizer-token CSRF gate. The chunk `PUT` is bound by the same
  `Origin` check and the same session token as any other mutating request.
- **Ownership.** Every session is scoped to `req.user.id`. **No route accepts a
  `userId` from a body, param or query.** A session belonging to another user
  behaves exactly like one that does not exist — `404`, never `403`, so the reply
  does not confirm that the id is real. There is no Admin exception, matching the
  existing rule that Admin gains governance screens, not authority over other
  people's files.
- **Audit.** Session start, cancel, denial, and commit all reach `audit_log`
  through the same `auditAct` helper, with the filename stored as SHA-256 exactly
  as before ([[concepts/OWASP_Security_Defense]]).
- **Path traversal.** Upload ids are validated as 48 hex characters before any
  filesystem call; a user filename is never part of any path.
- **Nothing partial is ever visible.** No row in `files` points at staged bytes
  at any point before commit, so an in-progress upload cannot appear in
  `GET /api/files` — by structure, not by a filter that could be missed.
- **Private Vault is untouched.** No vault constant, format, or policy changed in
  this stage. See §7.

Encryption at rest for the ordinary Data Lake path remains **not configured**,
and the Uploads screen continues to say so. V2 changes how bytes travel, not
whether they are encrypted on disk.

---

## 6. Staged implementation

| Stage | Scope | Status |
| :--- | :--- | :--- |
| **LFT-V2-A** | Normal Files: resumable chunked upload foundation — session/chunk/status/commit/cancel, durable session state, incremental browser hashing, server-side final verification, staged storage, cleanup, configurable limits, truthful UI states | **Source complete.** Verified against a real isolated PostgreSQL 15.18 (full IDEA1 suite 454/454, zero skips; both database lifecycles and the migration proven). **The migration has NOT been applied to production and nothing has been accepted in production.** |
| **LFT-V2-B** | Private Vault: chunked zero-knowledge transfer (format and protocol in §7) | **SOURCE COMPLETE / LOCAL+PG VERIFIED.** Full IDEA1 suite 586/586 against a real isolated PostgreSQL 15 with **zero skips**, and 519/586 with 67 PostgreSQL-gated skips in in-memory mode. Migration `004_vault_v2.sql` proven additive, idempotent and explicitly granting `drive_app` DML when applied by a different superuser. **The migration has NOT been applied to production and nothing has been accepted in production.** |
| **LFT-V2-C** | Edge tuning: `client_max_body_size`, `proxy_request_buffering`, timeouts retuned to chunk-sized semantics at the HUB and gateway | **SOURCE COMPLETE / EDGE CONFIG VERIFIED.** Normal V2 chunks are capped at `64m`; Vault V2 ciphertext chunks use `65m` for the 64 MiB plaintext chunk plus the 16-byte GCM tag. Chunk request buffering is off with 120-second body/send/read inactivity windows, commit responses have a route-scoped 600-second read timeout, and V2 downloads stream without proxy response buffering. The parent `/drive/` remains `512m`/60 seconds so legacy V1 uploads remain compatible. Structural parity tests plus disposable real-nginx syntax and functional routing/header smoke passed for both HUB and gateway. **Nothing has been deployed or accepted in production.** |
| **LFT-V2-D** | Production acceptance against the matrix in §9, for both Normal Files and Private Vault | Not started |

### Legacy endpoint status

`POST /api/files/upload` (V1, single-request multipart) **remains available** and
unchanged. The UI no longer uses it: both the Uploads screen and the Files upload
drawer now use the V2 session path. V1 is kept for existing clients and scripts,
and its limits are exactly the ones it always had. Removing it is a separate task
for after V2 passes production acceptance. **Files uploaded through V1 remain
readable, downloadable and verifiable; nothing about existing stored files was
migrated or rewritten.**

---

## 7. Private Vault chunked zero-knowledge transfer (LFT-V2-B)

**Implemented in source and verified locally and against a real isolated
PostgreSQL 15. Not deployed, not accepted in production.**

`ROOT_CAUSE = WHOLE_FILE_ZERO_KNOWLEDGE_TRANSFER_ARCHITECTURE`

Explicitly rejected, and still rejected: raising `MAX_VAULT_CIPHERTEXT_BYTES`,
and splitting one whole-file AES-GCM ciphertext into ad-hoc pieces. The first
does not remove the whole-file RAM requirement; the second breaks authentication,
because a GCM tag authenticates one message, not a fragment of one. The constant
is therefore **unchanged at 64 MiB** and still governs V1 blobs, which is correct:
a V1 blob really is one GCM message and really cannot be decrypted in parts.

### 7.1 What did not change

The envelope of [[concepts/Mnemonic_Recovery_and_Zero_Knowledge]] is untouched.
Passphrase → Argon2id(vault salt) → KEK, browser-side only. One randomly
generated 256-bit DEK per logical file, wrapped by the KEK. No user-wide content
key exists, and the KEK never encrypts file content. The server still never
receives a passphrase, a KEK, an unwrapped DEK, a plaintext filename, a plaintext
MIME type, or plaintext content, and still never decrypts, derives keys,
thumbnails, transcodes or indexes Vault content.

### 7.2 The V2 format

`formatVersion = 2` is an explicit column, not a sentinel. A sentinel such as
`iv_b64 = 'v2'` was rejected because it makes an invalid row representable; V2
lives in its own tables so that every V1 `NOT NULL` survives untouched.

One logical file becomes **N independently authenticated AES-256-GCM chunks**,
16 MiB of plaintext per chunk by default and 8–64 MiB configurable through
`VAULT_CHUNK_PLAINTEXT_BYTES`. An empty file is **one** chunk, not zero: a file
with no authenticated message is a file anyone could replace without a key.

Each chunk carries a **fresh random 96-bit IV**, generated inside
`encryptVaultChunk()`, which exposes no parameter for a caller to supply one. A
retry re-encrypts and therefore ships a different IV with different ciphertext;
the pair (IV, bytes) recorded server-side always comes from a single request,
enforced by a writer token on the finalising `UPDATE`.

**AAD, pinned byte for byte by test:**

```
content chunk AAD (34 bytes)
  "AEGIS-VLT2"      10 bytes, ASCII
  contentId         16 bytes, random per file
  chunkIndex         4 bytes, uint32 big-endian
  chunkCount         4 bytes, uint32 big-endian

encrypted metadata AAD (33 bytes)
  "AEGIS-VLT2-MD"   13 bytes, ASCII
  contentId         16 bytes
  chunkCount         4 bytes, uint32 big-endian
```

A canonical binary layout, not JSON — property order in an arbitrary object is
not a stable contract. Reordering a chunk, moving one between files, or changing
the declared chunk count all fail decryption, and each of those is a test.

Encrypted metadata holds `{ name, type, plainSize }` under the DEK. The browser
rebuilds the AAD locally from values it already holds; the server never sends it.

### 7.3 What the server can still see, stated honestly

The server sees `ciphertext_size`, `chunk_size` and `chunk_count`, so the logical
plaintext size is derivable as `ciphertext_size − 16 × chunk_count`. That is the
same class of disclosure V1 already makes, and it is why **no `plainSize` field
is accepted from the client** — the arithmetic is unavoidable, but the server
must not additionally be handed the number as user-supplied data.

### 7.4 Protocol

`POST /api/vault/uploads` · `GET /api/vault/uploads/:id` ·
`PUT /api/vault/uploads/:id/chunks/:index` · `POST /api/vault/uploads/:id/commit` ·
`DELETE /api/vault/uploads/:id`, plus
`GET /api/vault/blobs/:id/chunks/:index` for bounded reads.

Every route is behind `requireAuth`, scoped to `req.user.id` — no route reads a
user id from a request — and another owner's resource is **404, never 403**.

One deliberate difference from LFT-V2-A: **the client proposes the chunk size**,
because the ciphertext is sealed before the first request and the server cannot
re-chunk it without a key. The server validates that the declared values are in
range and internally consistent, then **freezes** them; every disk offset after
that comes from the stored row, never from the request that carries the bytes.

### 7.5 Integrity language

- `SERVER_CIPHERTEXT_INTEGRITY` — at commit the server re-reads the staged bytes
  and compares each chunk's SHA-256 against the hash **it computed itself** on
  receipt. A client-reported hash is never trusted. This proves the stored
  ciphertext is the ciphertext that arrived, and nothing more.
- `CLIENT_AEAD_PLAINTEXT_AUTHENTICATION` — the GCM tag of each chunk, checked in
  the browser at decryption, is what proves the plaintext.

`SERVER_PLAINTEXT_SHA256_VERIFY` is **not** claimed and must never be: the server
has no key, so the claim would be a lie.

### 7.6 Commit exactly once

The commit lease, durable commit intent and stale-commit recovery of LFT-V2-A are
reused from the start rather than retrofitted. A commit records its chosen final
storage key **before** any rename, claims the session with a conditional update,
verifies, renames, then writes blob and chunk metadata in one transaction. The
recovery worker takes rows with `FOR UPDATE SKIP LOCKED`, so two workers converge
on one outcome. There is no `recovering` state, deliberately — it would recreate
the "stuck row nobody can recover" problem one layer up.

Invariants proven against real PostgreSQL: `NO_DUPLICATE_VAULT_BLOB`,
`NO_ORPHAN_VAULT_CIPHERTEXT`, `NO_METADATA_TO_MISSING_CIPHERTEXT`,
`RECOVERY_IDEMPOTENT`, `RECOVERY_RACE_SAFE`.

### 7.7 Bounded memory, both directions

Upload never calls `file.arrayBuffer()` on the whole file — it slices. The
regression test uses a `File` whose whole-file `arrayBuffer()` **throws**, which
is the only way to prove absence rather than assert it by reading the code. V1's
`fileToBytes()` still exists for V1 and is never reached from the V2 path.

Download requests one chunk, rebuilds the AAD, decrypts, writes it to the output
sink, releases it, then moves on. Peak memory is O(chunk size), measured by a
sink that counts retained bytes rather than by inspection.

Browser output uses `showSaveFilePicker()` → `createWritable()` → sequential
writes → `close()`, opened inside the user's own click. Browsers without the File
System Access API get a **bounded** RAM fallback capped at 64 MiB — V1's old
ceiling exactly, so they can do what they always could and no more — and a
truthful message for anything larger. Tested browser family for the streaming
path: **Chromium desktop**. Universal support is not claimed.

Any chunk failure — network, wrong AAD, AEAD failure, missing IV, wrong size —
stops the download, aborts the destination, and reports failure. No file that is
incomplete is ever handed over as if it were complete.

### 7.8 Recorded limitations

| Marker | Value | Meaning |
| :--- | :--- | :--- |
| `VAULT_BROWSER_REFRESH_RESUME` | `NOT_IMPLEMENTED` | The server-side session is durable and survives a restart, but the KEK lives only in tab memory and is never persisted. After a refresh the user must unlock again, and the resume affordance is not wired to a reloaded page. |
| `LARGE_V2_VIDEO_PREVIEW` | `IN_PROGRESS` (large video) / `LIMITED` (images) | **Video** above 64 MiB streams through a same-origin Service Worker. E3.1 and E3.2 are deployed and production proved correctness — 206 media ranges bounded at exactly 16 MiB, 200 ciphertext chunks, first frame rendered, routine Chromium range cancellation no longer fatal. The remaining failure is **throughput**: on the real 1,206,241,622 B / ~120 s file the media needs ~10 MB/s while one ~16 MiB ciphertext chunk took 5–8 s and the container moved ~4 MB/s at 0–8 % CPU, because the pipeline was demand-driven and serial. E3.3 adds bounded proactive read-ahead (current + up to 3 ahead, derived from the 64 MiB budget), real concurrent chunk fetch with a reserved foreground slot, prefetch Promise reuse and seek reprioritisation. Source-verified only; not browser-accepted. **Still-image** preview remains limited above 64 MiB. The buffered ceiling was **not** raised and the 16 MiB Range window was **not** enlarged. |
| `VAULT_V1_LEGACY_READ` | `SUPPORTED` | Every V1 blob stays listable, unlockable, previewable, downloadable and deletable through the code path it always used. No ciphertext was rewritten or migrated. |
| `VAULT_V1_NEW_UPLOAD` | `SUPPORTED_BUT_UNUSED_BY_UI` | `POST /api/vault/blobs` still works and still has its 64 MiB ceiling. The Vault screen now uploads through V2 only. V1 is not large-file capable and is not described as such. |

Vault ownership semantics, the KEK/DEK envelope, metadata encryption and the
Preview allowlist (image/jpeg, png, gif, webp; video/mp4, webm, ogg — no HTML,
SVG, PDF, Office, executables or arbitrary `application/*`) are unchanged. The
locked-vault policy of PR #40 is unchanged and re-tested for V2 cards: while
locked a card is opaque, with no filename, extension, MIME, plaintext size or
content metadata anywhere in the DOM, and no Preview, Download, Open or Delete.

---

## 8. Mapped network drives and SMB are not a substitute

An SMB/CIFS share (or any mapped network drive) that exposes the same volume
would move large files without any of this work. **It must not be used as the
transport for AEGIS Drive content, and it is not equivalent to this transport.**

A file written over SMB:

- **bypasses RBAC** — access is decided by the file server's own ACLs, not by the
  application's server-side authorization and ownership rules;
- **bypasses the audit log** — no `FILE_UPLOAD`, no actor, no source address, no
  privacy-preserving target hash; a forensic trail that is silent about how a
  file arrived is not a forensic trail;
- **bypasses the Metadata Layer** — no row in `files`, so no size, no SHA-256, no
  owner, no version history, no share link, and nothing for integrity
  verification to compare against later;
- **bypasses the identity boundary** described in [[concepts/Identity_Decoupling]],
  since the file-server identity is not the Drive identity.

The three-layer design in [[concepts/Three_Layer_Data_Lake]] is only true while
every byte enters through the Application Layer. A second, unaudited door into
the Storage Layer does not extend the architecture — it removes it.

---

## 9. Test matrix to record for LFT-V2-D

This is the **future production acceptance matrix**, not a record of results. No
entry below has been executed in production.

### Normal Files — per size

Sizes: **2 MiB · 64 MiB · 256 MiB · 512 MiB · 1 GiB · 2 GiB · 5 GiB (if free
storage permits)**.

For each size record: `UPLOAD` · `SHA256` · `DOWNLOAD` · `BYTE/HASH MATCH`.

The 512 MiB and 1 GiB rows matter most: 512 MiB is the old HUB request ceiling
and 1 GiB the old backend ceiling, so those two rows are the direct evidence that
the per-request ceilings no longer bound a logical file.

### Interruption

- disconnect during a middle chunk;
- reconnect;
- resume **without** re-sending the chunks that already completed.

### Additional

- cancel an upload and confirm staged bytes are reclaimed;
- browser refresh and resume behaviour;
- duplicate chunk retry;
- two concurrent uploads;
- insufficient free-space rejection;
- service restart behaviour, since sessions are durable.

### Private Vault (LFT-V2-B) — per size

**RECORD ONLY. Not executed. Multi-gigabyte Vault runs were deliberately not
performed in this PR, and none of them has been performed in production.**

Sizes: **2 MiB · 64 MiB · 256 MiB · 512 MiB · 1 GiB · 2 GiB · 5 GiB (if free
storage permits)**.

For each size record: `ENCRYPT` · `UPLOAD` · `COMMIT` · `DOWNLOAD` ·
`DECRYPT` · `BYTE MATCH` · `PEAK TAB MEMORY`.

The 64 MiB row is the direct evidence that the old `MAX_VAULT_CIPHERTEXT_BYTES`
ceiling no longer bounds a Vault file, and the 512 MiB row that the HUB request
ceiling no longer does either.

### Private Vault — behaviour

- disconnect during a middle chunk, reconnect, resume **without** re-sending the
  chunks the server already acknowledged;
- retry one transient chunk failure and confirm the other chunks are not resent;
- restart the application mid-upload and confirm the durable session still
  resumes;
- kill the process mid-commit at each phase (after claim, after verification,
  after publish, after metadata) and confirm the recovery worker converges;
- unlock with the wrong passphrase and confirm nothing decrypts;
- tamper with one stored ciphertext byte and confirm the download fails and no
  file is delivered;
- request another owner's blob and chunk and confirm `404`;
- lock the vault mid-transfer and confirm the transfer stops;
- fill the volume to the reserve threshold and confirm `507` before any bytes
  are staged;
- cancel an upload and confirm the staged ciphertext is reclaimed;
- delete a V2 blob and confirm both its metadata rows and its ciphertext file
  are gone while no other blob is touched.


---

## 10. Report-ready note

> To be used **after** production acceptance, when the formal report is updated.
> The formal report was deliberately not edited at this stage.
> `FORMAL_REPORT = NO UPDATE`

**Problem.** The transfer path framed one logical file as one HTTP request and
required the whole file to exist in browser memory before sending. The effective
size ceiling was therefore the smaller of a per-request limit and the tab's RAM —
not the capacity of the Data Lake — and any interruption discarded all progress.
The Private Vault carried a second, sharper form of the same fault: the whole
file was read into memory, encrypted as **one** AES-GCM message, held again as
ciphertext, and sent in a single request, so its 64 MiB limit was a consequence
of the architecture rather than a policy that could be raised.

**Improvement.** A resumable, bounded-chunk transport with durable server-side
session state and incremental integrity verification, now covering both Normal
Files and the Private Vault. Each request carries a bounded chunk; the browser
hashes or encrypts the file in slices instead of buffering it; the server
verifies byte count and SHA-256 from the bytes it stored before publishing
anything; an interrupted transfer resumes from the last acknowledged chunk. For
the Vault this required a second, explicitly versioned encryption format: one
DEK per file as before, but N independently authenticated chunks instead of one
whole-file message, so a file can be encrypted, transferred, verified and
decrypted a bounded piece at a time. Existing V1 vault blobs are untouched and
still readable through the path they always used.

**Engineering value.** Reliability over both LAN and WAN paths, since a transient
interruption costs one chunk instead of an entire file; bounded memory on the
client and on the server regardless of file size, in both directions; retry
efficiency; storage safety through an explicit free-space reserve that prevents
one upload from filling the volume; and measurable integrity, because the
checksum that decides success is computed by the server from the stored bytes
rather than reported by the client. Progress reported to the user is derived from
bytes actually processed and chunks actually acknowledged, so a stalled transfer
looks stalled instead of animating a bar that means nothing.

**Security.** No control is bypassed: authentication, CSRF, server-side ownership
and the audit trail apply to every step, another owner's resource is a `404`
rather than a `403`, and no partial upload is visible in the file list. The
Private Vault **remains genuinely zero-knowledge**: the server still never
receives a passphrase, a key-encryption key, an unwrapped data key, a plaintext
filename, a plaintext MIME type or plaintext content, and still never decrypts,
derives keys, thumbnails, transcodes or indexes vault content. Per-file DEKs,
per-chunk AES-256-GCM authentication, a unique 96-bit IV per encryption, and AAD
binding of format version, file identity, chunk index and chunk count are all
enforced and pinned by test. Two integrity claims are kept separate and named:
the server proves `SERVER_CIPHERTEXT_INTEGRITY` — that the ciphertext it stored
is the ciphertext it received — while only the browser can prove
`CLIENT_AEAD_PLAINTEXT_AUTHENTICATION`. The server holds no key, so no claim of
server-side plaintext verification is made for the Vault.

---

## 11. LFT-V2-E — Truthful transfer rate, and a 32 GiB deployment ceiling

### 11.1 Speed and time-remaining come from bytes, or they are not shown

The transfer panel used to state bytes and percent only. Both are true, and both
are useless for the question a user actually asks during a multi-gigabyte
transfer: *how long is this going to take?* The answer now comes from
`src/lib/transferRate.js`, and the module is built around one rule:

> **Every number on that line is derived from real transferred bytes. When there
> is not enough real evidence, nothing is shown — a placeholder is never
> invented, and no timer ever advances the count.**

| Property | Behaviour | Why it is that way |
| :--- | :--- | :--- |
| Smoothing | Rolling window, 5 s | A cumulative average makes the estimate "remember" a slow patch for the rest of the transfer, so a user whose link recovered still sees minutes that will not happen. The window reflects *now*, which is the only thing an ETA should predict from. |
| First sample | Reference point only, never a measurement | Resume starts from a non-zero byte count. Counting those bytes as freshly transferred produces an impossible GB/s reading on the first sample. |
| Evidence floor | ≥3 real advances **and** ≥750 ms of span | Three progress events 20 ms apart are not evidence of a rate. |
| Stall | No byte growth for 4 s → `stalled`, rate and ETA both `null` | Leaving the last known speed on screen while nothing moves is the most convincing lie this panel can tell. |
| Byte regression | Re-baseline, do not report a negative rate | Progress legitimately moves backwards when an in-flight chunk fails and the count falls back to what the server confirmed. |
| Unknown total | Rate shown, ETA withheld | A remaining-time figure with no denominator is fiction. |

The estimator takes `(transferredBytes, performance.now())` and returns
`{ bytesPerSecond, etaSeconds, stalled }`. It knows nothing about React or the
DOM and never reads a clock itself, so its behaviour is pinned deterministically
by `tests/transferRate.test.js` rather than by waiting on wall-clock time.

`transferRateLine(t, rate)` lives in the same module rather than in
`Vault.jsx` **on purpose**: Normal Files (`UploadDrawer` / `Uploads`) must say
the same sentence as the Vault. Duplicated formatting is how two screens start
lying in two different dialects.

The rendered line, in the three shipped languages:

```text
en   58.4 MB/s · about 12s remaining
th   58.4 MB/s · เหลือประมาณ 12 วินาที
zh   58.4 MB/s · 约剩 12 秒
```

Speed uses the same 1024-based units as the byte counter directly above it, so
the two lines divide into each other. During `committing` no rate is shown at
all: the server is hashing its own bytes and nothing is on the wire, so a
"waiting for the network" warning there would be a false alarm that invites the
user to cancel a healthy commit.

**Not yet wired:** Normal Files still renders its own progress line. The helper
is generic and importable; that UI integration is recorded as outstanding.

### 11.2 What a 32 GiB file costs at commit time

`committing` is dominated by reading the whole staged file to verify SHA-256, so
its duration is linear in file size, not constant:

| Logical size | Read at ~60 MB/s (edge-box HDD) | Edge `proxy_read_timeout` required |
| :--- | :--- | :--- |
| 5 GiB | ~90 s | 600 s — the value in `gateway/nginx.conf` today |
| 16 GiB | ~290 s | 600 s, still sufficient |
| 32 GiB | ~570 s | **insufficient** — needs ~1800 s |

The server-side commit lease is already environment-controlled
(`UPLOAD_COMMIT_LEASE_MS`, `VAULT_COMMIT_LEASE_MS`, default 15 min, settable up
to 24 h), so it needs no code change to follow the ceiling upward. The **edge**
timeout is static nginx configuration and cannot read the environment.

> **Deployment rule:** raising `MAX_LOGICAL_FILE_BYTES` or
> `MAX_VAULT_LOGICAL_FILE_BYTES` above roughly 8 GiB requires also raising
> `proxy_read_timeout` on the **two commit routes only** in `gateway/nginx.conf`
> and at the HUB edge, and raising the commit lease. Without it a healthy commit
> is cut at 600 s and surfaces to the user as an unexplained failure.

That gateway change is deliberately **not** made in this PR: no deployment has
opted into a ceiling above 5 GiB yet, and broadening a shared edge timeout for a
ceiling nobody has enabled is a change with downside and no benefit. It is
recorded as an integration request against `gateway/nginx.conf` for Kla.

### 11.3 Environment variables, collected

| Variable | Default | Bounds | Owner file |
| :--- | :--- | :--- | :--- |
| `UPLOAD_CHUNK_SIZE_BYTES` | 16 MiB | 8–64 MiB | `server/config/transferLimits.js` |
| `MAX_LOGICAL_FILE_BYTES` | 5 GiB | one chunk – 32 GiB | `server/config/transferLimits.js` |
| `UPLOAD_COMMIT_LEASE_MS` | 15 min | 1 min – 24 h | `server/config/transferLimits.js` |
| `STORAGE_FREE_RESERVE_BYTES` | 2 GiB | ≥ 0 | `server/config/transferLimits.js` |
| `STORAGE_FREE_RESERVE_FRACTION` | 0.05 | [0, 1) | `server/config/transferLimits.js` |
| `VAULT_CHUNK_PLAINTEXT_BYTES` | **32 MiB** | 8–64 MiB | `server/config/vaultTransferLimits.js` |
| `VAULT_UPLOAD_CONCURRENCY` | 2 | 1–4 | `server/config/vaultTransferLimits.js` |
| `MAX_VAULT_LOGICAL_FILE_BYTES` | 5 GiB | 0 – 32 GiB | `server/config/vaultTransferLimits.js` |
| `VAULT_COMMIT_LEASE_MS` | 15 min | 1 min – 24 h | `server/config/vaultTransferLimits.js` |

`VAULT_UPLOAD_CONCURRENCY` and the raised Vault chunk default arrived with
LFT-V2-E2 — see §12, which also states the tab memory contract they jointly
define.

Both `/limits` endpoints now return `maxSupportedLogicalFileBytes` alongside
`maxLogicalFileBytes`. The two answer different questions — *what will this
server accept today* versus *what could an administrator configure* — and a UI
that shows the second as the user's ceiling is promising a size the server will
refuse.

---

## 12. LFT-V2-E2 — Bounded concurrency on the Vault upload path

### 12.1 What changed, and what deliberately did not

The Vault upload loop was strictly serial: encrypt one chunk, upload it, wait,
advance. On a link with any meaningful round-trip time that leaves the pipe idle
for the whole gap between "last byte of chunk N acknowledged" and "first byte of
chunk N+1 sent" — and it does so once per chunk, for every chunk in the file.

`src/lib/vaultChunkedUpload.js` now runs a **fixed pool of workers over one
shared queue** of missing chunk indexes. Not batches: batching makes every batch
wait for its slowest member before the next starts, which gives most of the
saving back when chunk sizes differ (the final chunk is a remainder). Workers
pulling from a single queue stay busy until the queue is empty.

**The safety properties are unchanged, and each is pinned by a test:**

| Property | How it is guaranteed |
| :--- | :--- |
| One index, one successful writer from this client | The queue hands out indexes with a synchronous `cursor += 1`, with no `await` between read and increment. Two workers cannot receive the same index — by structure, not by timing luck. |
| A fresh IV on every encryption, including every retry | Unchanged from LFT-V2-B: `encryptVaultChunk()` generates a new 96-bit IV on every call, and a retry always re-encrypts rather than resending held ciphertext. Concurrency does not touch this path. |
| Bounded memory | Each worker holds one plaintext slice plus one ciphertext at a time and releases the plaintext the moment sealing completes. Peak is `O(chunk × concurrency)` — a constant, independent of file size. |
| No whole-file read | The regression test whose `File.arrayBuffer()` **throws** now also runs at concurrency 4, and additionally records every slice range to prove none is wider than one chunk. |
| Exactly-once commit | Commit still happens once, after all workers drain and only when no terminal failure occurred. |
| Resume authority | Unchanged: resume re-reads server status rather than trusting anything the client remembered. |

### 12.2 Progress with several chunks in flight

Two counters, and a chunk is in exactly one of them, never both:

- `settledBytes` — plaintext bytes of chunks the server has confirmed.
- `inflightBytes` — a map of index → plaintext-equivalent bytes currently on the wire.

The move from one to the other happens in adjacent statements with no `await`
between them, immediately before the progress callback fires. That adjacency is
the entire defence against counting a chunk twice while several are in flight,
and the test asserts that no reported `transferredBytes` ever exceeds the file
size — the observable symptom of a double count.

A retry resets that chunk's in-flight contribution to zero, because the bytes of
a failed attempt never reached the server; carrying them forward would be
counting bytes that do not exist.

The chunk index shown to the user is the **lowest index still in flight**, not
the one that reported most recently — otherwise "part X of N" would jump back and
forth between two chunks racing each other. Likewise the stage label is derived
once from whether any upload is active, rather than announced by each worker,
which would make the label flicker between "encrypting" and "uploading" several
times a second.

### 12.3 Failure stops scheduling; it does not abandon work in flight

The stop condition is checked **before a worker takes new work**, never in the
middle of a request already sent. A request that is already travelling is allowed
to settle: dropping it would discard bytes the server may already have accepted
without the client knowing, which is precisely the state that makes a later
resume compute the wrong missing set.

This is a visible behavioural difference from the serial path, and it is correct:
at concurrency 1, a permanent failure on chunk 1 means chunk 2 is never touched;
at concurrency 2, chunk 2 may already have succeeded. Both are pinned by separate
tests, and the serial expectations are kept under an explicit `concurrency: 1`.

### 12.4 The memory contract, stated as a number

> **Peak tab memory during a Vault upload ≈ 2 × `VAULT_CHUNK_PLAINTEXT_BYTES` ×
> `VAULT_UPLOAD_CONCURRENCY`** — one plaintext plus one ciphertext per active
> worker.

At the new defaults (32 MiB × 2) that is **≈ 128 MiB**, up from ≈ 32 MiB under the
old 16 MiB serial path. That increase is real and is the deliberate cost of this
change. What matters is that it remains a **constant**: it does not grow with the
file, so a 32 GiB upload has the same ceiling as a 200 MiB one. A deployment
serving low-memory clients lowers either variable — `VAULT_CHUNK_PLAINTEXT_BYTES=8388608`
with `VAULT_UPLOAD_CONCURRENCY=1` restores a ≈ 16 MiB peak — with no code change.

Concurrency is capped at 4 rather than left open. Each additional worker consumes
a full chunk of tab memory and holds one more request open against an edge with a
finite worker pool; "more is faster" stops being true well before it stops being
harmful.

A 32 MiB plaintext chunk is 33,554,448 bytes of ciphertext with its GCM tag, which
sits comfortably under the 65m Vault chunk cap set at the edge in LFT-V2-C.

### 12.5 Where the concurrency value comes from

The server publishes `uploadConcurrency` in `GET /api/vault/uploads/limits` so
every client uses the deployment's number instead of one baked into the bundle.
It is a **recommendation, not an enforced limit**: the server cannot stop a client
from opening more connections, and pretending otherwise would be security theatre.
Real protection against too many simultaneous writes lives at the edge and in the
per-chunk write lock (`CHUNK_WRITE_IN_PROGRESS`), neither of which this value
touches.

Consequently the two sides validate differently, on purpose: the **server refuses
to boot** on a value outside 1–4, while the **client clamps** it. A tab must not
refuse to upload because an administrator typed a bad number into an advisory
field — that punishes the user for someone else's mistake.

**No throughput improvement is claimed here.** Concurrency removes a structural
idle gap; whether that translates into measurable throughput on the real link is a
question for LFT-V2-D acceptance, and nothing in this repository has measured it.

## 13. LFT-V2-E3 — Streaming preview for large encrypted video

### 13.1 The limitation being replaced

Preview built a whole plaintext object URL, so a multi-gigabyte video could only
be refused. That refusal was correct — assembling gigabytes of decrypted video in
a tab to make a button look functional would reintroduce, through the back door,
the exact problem V2 was built to remove.

What was missing was not a bigger buffer. It was a way to answer *part* of the
file. Video players do not want the whole file; they want `bytes=start-end`. V2
already stores the file as independently authenticated chunks, so the mapping from
a byte range to the minimum set of chunks is arithmetic — the only thing absent
was somewhere to perform it.

### 13.2 Shape of the path

```text
<video src="/drive/__vault_preview/<ephemeral-token>">
        │
        ▼  (never leaves the browser)
   Service Worker, scope /drive/
        │   token → { non-extractable DEK, blob metadata }  ← in memory only
        ▼
   GET /drive/api/vault/blobs/:id/chunks/:index      ← existing authenticated route
        │   X-Vault-Chunk-IV
        ▼
   AAD rebuilt locally · AES-GCM decrypt · slice to the requested range
        ▼
   206 Partial Content, streamed chunk by chunk
```

**Nothing new is exposed server-side.** No plaintext endpoint, no transcode, no
volume mounted anywhere else, no new route at all — the worker consumes the same
authenticated chunk endpoint the download path already uses, with the page's own
session cookie.

### 13.3 Why the logic does not live in the Service Worker

A Service Worker cannot be exercised by `node:test`: there is no `FetchEvent`, no
registration, no scope. Logic placed inside one becomes code nobody tests — and
here that code decides byte offsets and whether a failed authentication tag stops
playback. So the worker file is a thin shell over ordinary, directly tested modules:

| Module | Responsibility | Pinned by |
| :--- | :--- | :--- |
| `src/lib/vaultPreviewRange.js` | `Range` parsing, byte-range → chunk plan, response headers | `tests/vaultPreviewRange.test.js` (20 tests) |
| `src/lib/vaultPreviewResponder.js` | Fetch, decrypt, slice, stream, fail closed | `tests/vaultPreviewResponder.test.js` (19 tests, real AES-GCM) |
| `src/lib/vaultPreviewSession.js` | Register, hand over the key, revoke it, answer recovery requests | `tests/vaultPreviewSession.test.js` |
| `src/lib/vaultPreviewWorkerState.js` | Ephemeral sessions, one-shot recovery, two-entry/64 MiB plaintext LRU | `tests/vaultPreviewWorkerState.test.js` |
| `src/lib/vaultPreviewErrors.js` | Stable failure taxonomy and UI grouping | `tests/vaultPreviewErrors.test.js` |
| `src/lib/vaultPreviewDiagnostics.js` | Opt-in allowlisted operational metrics | `tests/vaultPreviewDiagnostics.test.js` |
| `src/vaultPreviewServiceWorker.js` | Event wiring over those tested contracts | production build + screen protocol tests |

An off-by-one in the range mapping is the failure mode that matters most here: the
video still plays, but seeks land in the wrong place and frames are subtly wrong,
with no error anywhere. The range tests state expected offsets literally — first
byte, mid-chunk, spanning two chunks, exact chunk boundary, final byte, the whole
trailing partial chunk — rather than comparing against the function under test.

### 13.4 The rules that must not be relaxed

1. **Only the required chunks are fetched.** A 1 MiB request from the middle of a
   4 GiB file touches one or two chunks. A test counts the URLs actually requested.
2. **Opening a preview downloads nothing.** Building the response plan issues no
   request at all; bytes move only when the player pulls them. Pinned by test, and
   `<video preload="metadata">` keeps the browser from eagerly prefetching the
   rest of a multi-gigabyte file just because the modal opened.
3. **Nothing is ever fully assembled.** Both 206 and plain 200 responses stream one
   chunk at a time. The worker retains only a bounded window of resolved chunks
   (≤64 MiB, see invariant 9), and transient fetch/decrypt work remains
   O(chunk window), not O(file size). Even a `Range`-less GET — which some
   browsers issue first — is served this way.
4. **A failed tag stops the stream.** No skipping, no zero-fill, no "rest of the
   file anyway". The stream errors, and the page is told *why*, so the UI can say
   the file failed authentication rather than showing a generic error. Tampered
   bytes, a reordered chunk and a chunk from another file all fail identically —
   the AAD binds `contentId`, `chunkIndex` and `chunkCount`, exactly as the
   download path does.
5. **The key lives in memory and nowhere else.** The DEK crosses to the worker as a
   non-extractable `CryptoKey` via structured clone. No `localStorage`, no
   `sessionStorage`, no IndexedDB, **no Cache API**, and every response carries
   `Cache-Control: no-store`. Only what a chunk decrypt needs is sent — id,
   `contentIdB64`, chunk size and count. Not the filename, not the wrapped DEK,
   not the encrypted metadata.
6. **Closing means the key is gone.** Modal close, vault lock, auto-lock and
   component unmount each revoke the session. Lock clears *every* session, not just
   the visible one. Each is a separate test, because a preview URL whose key is
   still resident is a file that can still be decrypted after the user believes
   they locked the vault.
7. **An open-ended request is not an EOF request.** `bytes=X-` receives at most a
   16 MiB 206 response window. Explicit finite and suffix ranges remain exact.
   Logical files through 32 GiB prove the chunk plan depends on the response
   window, not total file size.
8. **Worker restart does not require persisted keys.** The worker asks controlled
   pages for the exact active token. Only an unlocked page still holding that
   preview's non-extractable DEK in memory may answer; one request makes at most
   one recovery attempt. Lock/close/replacement deny recovery and invalidate work
   already in flight.
9. **Plaintext reuse is bounded by bytes, and the byte budget is the rule.** The
   worker retains at most **64 MiB** of resolved plaintext across all preview
   tokens. The chunk-count limit is derived from that budget, never assumed:
   `cacheSlots = floor(64 MiB / plaintextChunkSize)`, capped at 4 — 4 chunks on a
   16 MiB profile, 2 on 32 MiB, 1 on 64 MiB. A single chunk larger than the whole
   budget is served but never retained. Integrity failures are never cached;
   close, lock, replacement and worker death clear it.
10. **Cancellation is not failure.** A media Range response the browser
    supersedes and cancels reports nothing: no failure callback, no
    chunk-fetch-failed, no UI network error. A genuine transport fault on a live
    response still reports `chunk-fetch-failed`, an `AbortError` with no
    cancellation context is still a real failure, and an integrity failure stays
    fatal whether or not the response was canceled.
11. **An in-flight chunk load belongs to the session, not to one request.** Two
    overlapping ranges routinely await one shared chunk Promise, so that load
    carries the session's `AbortSignal`. Cancelling one range never aborts work
    another range is consuming; only close, Vault lock, close-all and session
    replacement abort it, and after any of those no late plaintext is delivered.
12. **An activated worker that does not control the page is recovered, not
    reloaded.** The page sends one `vault-preview-claim` message, waits for
    `controllerchange` under a deadline, and otherwise reports
    `worker-controller-timeout` truthfully. It never reloads: the same
    uncontrolled state can reproduce on the next load, and every reload destroys
    the in-memory DEK and the unlocked Vault.
13. **Read-ahead is proactive, bounded and session-owned.** When foreground
    playback requests chunk N the worker prioritises N and immediately begins
    loading N+1…N+k concurrently, where `k = cacheSlots - 1` from invariant 9.
    Waiting for the browser to ask for N+1 is too late for any real bitrate: a
    16 MiB plaintext chunk is only ~1.5–2 s of a 10 MB/s video while fetching it
    takes several seconds. The window depends on chunk size and memory budget
    only — never on total file size — and read-ahead runs forward only.
14. **Speculative work can never delay the chunk the user is watching.** The
    plaintext byte budget, the cache-entry count and the maximum in-flight
    ciphertext loads are three separate limits, not one number. Speculative loads
    are capped at `cacheSlots - 1` and one slot is reserved for foreground work,
    so a seek starts immediately instead of queueing behind speculation. Seeking
    rebuilds the window at the new position and discards queued read-ahead before
    it reaches the network; work already in flight is allowed to finish because
    it is bounded and holds no reserved slot. Transient in-flight ciphertext is
    bounded at `(cacheSlots + 1) × (chunkSize + 16 B)` — O(window), never
    O(file size).
15. **A prefetched chunk is joined, never re-fetched.** A Range request for a
    chunk already being read ahead attaches to the existing session-owned Promise
    and issues no second ciphertext GET; a still-queued prefetch is promoted to
    foreground priority instead of being duplicated. A speculative load that
    fails announces nothing — nobody asked for it — while the same chunk
    requested as foreground still reports integrity and transport faults in full.
    Eviction drops chunks behind the playhead first: plain LRU would discard the
    chunk read ahead moments before it is needed, since playback keeps touching
    the current chunk and never touches the next one until it plays.

### 13.5 CSP is unchanged, and that is the point

The virtual URL is same-origin, so the existing `media-src 'self'` already
permits it, and `worker-src` is deliberately left undeclared so it inherits
`default-src 'self'` — which is precisely the grant a same-origin worker needs.
Two tests assert that no directive was widened, that `connect-src` stays
`'self'` (a worker holding a DEK must never be able to reach another origin), and
that `worker-src`/`child-src` remain undeclared. If a future change "needs" a
new CSP source to make preview work, that is the signal something is being fetched
from somewhere it should not be.

### 13.6 Where it does not work, said plainly

Browsers without Service Worker support, without `ReadableStream`, or on an
insecure context get a message saying **this browser cannot stream large encrypted
video, download the file to watch it**, plus the Download button. There is no
silent fallback to whole-file buffering — that would trade a clear message for a
dead tab. Registration failure, controller timeout, session-open/loss/rehydration
failure, chunk-network failure, integrity failure, invalid range and media
playback failure are separate machine-readable reasons. The UI groups them
truthfully rather than describing temporary infrastructure or network failures as
browser incompatibility, while still offering Download.

The worker is built as a separate Vite entry with a **fixed, unhashed filename at
the root of `dist/`**: a Service Worker's scope is its own directory, so a file
under `assets/` could never intercept `/drive/…`, and a hashed name would look
like a different worker on every deploy.

### 13.7 Production evidence and E3.1 acceptance boundary

Production proved the V2 upload path with a real ~1.1 GB MP4 and proved buffered
preview with a ~5.4 MB MP4. The large streamed preview did **not** pass: it may
start slowly or stall, stutter, and fail on a later attempt. E3.1 addresses the
two demonstrated architectural causes — unbounded open-ended responses and the
worker's ephemeral session — plus repeated decrypt work, failure truthfulness and
safe diagnostics.

E3.1 is source acceptance only: 101 focused preview/screen tests, 117 focused
CSP/crypto regressions, 704 full-suite tests discovered with 637 pass, 0 fail and
67 PostgreSQL-gated skips, plus a passing production build. Edge/Chrome desktop on
Windows is the primary production target; Firefox compatibility is secondary;
Safari/WebKit production acceptance is deferred. The existing ~1.1 GB MP4 must be
retested after merge/deploy for first frame, sustained play, middle/end seeks,
close/reopen, worker restart and lock invalidation. Until that passes,
`LARGE_V2_VIDEO_PREVIEW = IN_PROGRESS`.

### 13.8 E3.2 — cancellation, shared-load ownership and controller recovery

Deploying E3.1 proved the streaming path itself: the real ~1.1 GB MP4 returns
HTTP 206 for virtual media ranges, HTTP 200 for Vault ciphertext chunks, and the
first video frame renders. Range mapping and client-side decrypt work. Two
defects sat on top of that working path.

**Chromium's routine cancellations were being read as network failures.** The
player opens several overlapping ranges, keeps the one it wants and cancels the
rest; each cancelled response aborted its own controller, the resulting
`AbortError` was caught by the generic chunk handler, and the preview announced
*"Video data could not be retrieved from the server"* while playback was healthy.
Cancellation now carries an explicit, attributable kind — the media element
superseded this response, or the session was deliberately torn down — and only
those are silent. Everything else, and every integrity failure, still reports.

**One cancelled range could poison another.** The shared chunk cache can hold an
in-flight Promise; when that load carried the `AbortSignal` of whichever range
started it, cancelling that range rejected the shared Promise and destroyed a
second, still-playing range waiting on the same chunk. Ownership now sits with
the preview session. A bounded chunk may finish loading after one range is
cancelled — the work is bounded and the Vault is still unlocked — but close,
lock, close-all and session replacement abort every session-owned load, and no
plaintext crosses those boundaries afterwards.

**An activated worker did not always control the page.** In production
`registration.active` was activated while `navigator.serviceWorker.controller`
was `null`, so `<video>` requests never reached the worker at all and the preview
reported `worker-controller-timeout`; only a manual reload recovered it. The page
now asks the active worker to `clients.claim()` once and waits for
`controllerchange` under a deadline. An already-controlled page keeps its fast
path and sends nothing. There is no automatic reload anywhere on this path.

E3.2 is source acceptance only. The 64 MiB retained-plaintext ceiling, the
two-chunk limit, the absence of Cache API, IndexedDB and web storage, the
non-extractable DEK and the Zero-Knowledge boundary are all unchanged.
`LARGE_V2_VIDEO_PREVIEW` remains `IN_PROGRESS` until the real ~1.1 GB MP4 passes
Windows Edge/Chrome acceptance.

### 13.9 E3.3 — high-throughput read-ahead

With E3.2 deployed, the preview became *correct* and stayed *unwatchable*. The
measurement that matters, from the real `START_LIVE.mp4`:

| Quantity | Observed |
|---|---|
| Plaintext size / duration | 1,206,241,622 B / ~120 s |
| Required media rate | ~10 MB/s (~80 Mbps before overhead) |
| Virtual Range response | exactly 16 MiB, e.g. `bytes 83886080-100663295/1206241622` |
| One ~16 MiB ciphertext chunk | 5–8 s |
| Drive container NET | 8.82 → 8.99 GB in ~42 s (≈ 4 MB/s) |
| Drive container CPU / RSS | 0–8 % / 25–47 MiB |

Range semantics and the first frame were fine; throughput was not. A 16 MiB
plaintext chunk is roughly 1.5–2 s of this video, so a strictly demand-driven
pipeline — ask, fetch, decrypt, serve, *then* wait to be asked again — is
structurally incapable of feeding it, regardless of how fast any single step is.
The low container CPU is the tell: nothing was compute-bound, the pipe was simply
never kept full.

E3.3 changes the shape of the pipeline, not the bytes and not the contract:

- **Proactive read-ahead.** Foreground chunk N is prioritised and N+1…N+k begin
  loading at once. `k` comes from the byte budget, not a constant.
- **Genuine concurrency.** Retained plaintext bytes, cache-entry count and
  in-flight ciphertext loads became three separate limits. On the production
  16 MiB profile that is four useful concurrent session-owned loads.
- **Promise reuse.** The Range request for a chunk already being read ahead joins
  the existing load; no chunk is fetched twice.
- **Seek reprioritisation.** The new position becomes foreground immediately, the
  window is rebuilt around it, and stale queued speculation is dropped before it
  reaches the network.
- **Playback-aware eviction.** Chunks behind the playhead go first, so read-ahead
  is not silently undone by LRU.

What deliberately did not change: `PREVIEW_RANGE_WINDOW_BYTES` is still 16 MiB
(the fix is read-ahead and concurrency, not a larger Range response); no
whole-file buffering; no plaintext server endpoint; no nginx, route or API
contract change — source review of `GET /api/vault/blobs/:id/chunks/:index`
found it stateless per request, already streaming a bounded range through
`openVaultCiphertextRange(...)` + `stream.pipe(res)` with `proxy_buffering off`,
so no server-side serialization bottleneck exists to fix. Encryption, the
non-extractable DEK, the Zero-Knowledge boundary, the absence of Cache API,
IndexedDB and web storage, and the 64 MiB retained-plaintext ceiling are all
unchanged.

E3.3 is source acceptance only. `LARGE_V2_VIDEO_PREVIEW` remains `IN_PROGRESS`
until the real file opens, shows a first frame, plays without repeated
buffering, seeks mid-file and near the end, and survives close/reopen on Windows
Edge/Chrome.

---

## 🔗 Related Notes

* [[idea1/idea1-status]]
* [[concepts/Three_Layer_Data_Lake]]
* [[concepts/Mnemonic_Recovery_and_Zero_Knowledge]]
* [[concepts/Honest_Telemetry_and_Unavailable_States]]
* [[concepts/OWASP_Security_Defense]]
* [[concepts/Identity_Decoupling]]
* [[summaries/08_Outstanding_Items_Consolidated]]
