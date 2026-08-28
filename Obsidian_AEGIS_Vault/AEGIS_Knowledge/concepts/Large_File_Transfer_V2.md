---
title: Large File Transfer V2 — Resumable Chunked Transport
tags: [aegis, concept, idea1, drive, upload, transfer, resumable, integrity, storage]
type: concept
created: 2026-08-28
updated: 2026-08-28
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

### 4.6 Logical size limit and the free-space rule

The 1 GiB constant is **not** the new architectural ceiling. Two separate,
configurable values replace it:

| Setting | Default | Meaning |
| :--- | :--- | :--- |
| `UPLOAD_CHUNK_SIZE_BYTES` | 16 MiB | Size of one HTTP request |
| `MAX_LOGICAL_FILE_BYTES` | 5 GiB | Size of one file this deployment will accept |

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
| **LFT-V2-A** | Normal Files: resumable chunked upload foundation — session/chunk/status/commit/cancel, durable session state, incremental browser hashing, server-side final verification, staged storage, cleanup, configurable limits, truthful UI states | **This work.** Source complete and locally verified; **not yet accepted in production** |
| **LFT-V2-B** | Private Vault: chunked zero-knowledge transfer (design in §7) | Not started |
| **LFT-V2-C** | Edge tuning: `client_max_body_size`, `proxy_request_buffering`, timeouts retuned to chunk-sized semantics at the HUB and gateway | Not started — deliberately after the application protocol is deployed |
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

## 7. Next stage — Private Vault chunked zero-knowledge transfer (LFT-V2-B)

**Not implemented here. Recorded so the next stage reuses the session and chunk
concepts without weakening zero knowledge.**

Explicitly rejected approaches: raising `MAX_VAULT_CIPHERTEXT_BYTES`, and
splitting the existing whole-file AES-GCM ciphertext into ad-hoc pieces. The
first does not remove the whole-file RAM requirement; the second breaks
authentication, because a GCM tag authenticates one message, not a fragment of
one.

The design to build:

- **one DEK per logical file**, wrapped by the KEK exactly as today — the envelope
  structure of [[concepts/Mnemonic_Recovery_and_Zero_Knowledge]] does not change;
- plaintext split into **bounded chunks** of the same order as the transport chunk;
- **AES-256-GCM independently authenticated per chunk**, so each chunk is a
  complete authenticated message that can be verified and decrypted alone;
- a **unique 96-bit IV per encrypted chunk** — never reused with the same key;
- **AAD binds at minimum**: format version, logical file identifier, chunk index,
  and total chunk count — so a chunk cannot be reordered, dropped, duplicated,
  moved between files, or replayed from a different format version;
- the **server stores ciphertext only**; encrypted metadata stays encrypted; the
  wrapped DEK stays opaque to the server;
- **retries must never cause IV reuse with different plaintext.** A resent chunk
  must carry byte-identical ciphertext, or a fresh IV — the client, not the
  server, owns this invariant, because the server cannot see either side of it;
- **existing V1 vault blobs remain readable** — the format is versioned and the
  old path is kept for blobs written before the change.

Vault ownership semantics, KEK/DEK format, metadata encryption and the Preview
policy are unchanged until that stage, and any change to them is its own review.

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

Private Vault has **no matrix here** — it is reserved for `LFT-V2-B`/`LFT-V2-D`.

---

## 10. Report-ready note

> To be used **after** production acceptance, when the formal report is updated.
> The formal report was deliberately not edited at this stage.

**Problem.** The transfer path framed one logical file as one HTTP request and
required the whole file to exist in browser memory before sending. The effective
size ceiling was therefore the smaller of a per-request limit and the tab's RAM —
not the capacity of the Data Lake — and any interruption discarded all progress.

**Improvement.** A resumable, bounded-chunk transport with durable server-side
session state and incremental integrity verification. Each request carries a
bounded chunk; the browser hashes the file in slices instead of buffering it; the
server verifies byte count and SHA-256 from the bytes it stored before publishing
anything; an interrupted transfer resumes from the last acknowledged chunk.

**Engineering value.** Reliability over both LAN and WAN paths, since a transient
interruption costs one chunk instead of an entire file; bounded memory on the
client and on the server regardless of file size; retry efficiency; storage
safety through an explicit free-space reserve that prevents one upload from
filling the volume; and measurable integrity, because the checksum that decides
success is computed by the server from the stored bytes rather than reported by
the client.

**Security.** No control is bypassed: authentication, CSRF, server-side ownership
and the audit trail apply to every step, and no partial upload is visible in the
file list. The Private Vault remains zero-knowledge and unchanged at this stage;
its chunked design is specified but not implemented, and it preserves per-file
DEKs, per-chunk authentication, unique IVs, and AAD binding of file identity and
chunk position.

---

## 🔗 Related Notes

* [[idea1/idea1-status]]
* [[concepts/Three_Layer_Data_Lake]]
* [[concepts/Mnemonic_Recovery_and_Zero_Knowledge]]
* [[concepts/Honest_Telemetry_and_Unavailable_States]]
* [[concepts/OWASP_Security_Defense]]
* [[concepts/Identity_Decoupling]]
* [[summaries/08_Outstanding_Items_Consolidated]]
