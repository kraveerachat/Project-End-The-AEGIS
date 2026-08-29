---
title: Task Receipt — IDEA1 LFT-V2-E2 bounded-concurrency Vault upload
date: 2026-08-29T21:35:00+07:00
owner: kla
area: idea1
branch: feat/idea1-lft-v2-e2-upload-concurrency
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA1 LFT-V2-E2 bounded-concurrency Vault upload

> **Stacked on `feat/idea1-lft-v2-e1-rate-eta-limits` (PR #50).** This branch is
> based on that branch, not on `main`, because it extends the same two
> configuration files. The Pull Request targets that branch and must be rebased to
> `main` after it merges.

## What changed

- The Vault upload path stopped being strictly serial. It now runs a **fixed pool
  of workers over one shared queue** of missing chunk indexes, with a configurable
  bound (`VAULT_UPLOAD_CONCURRENCY`, default 2, range 1–4).
- The Vault plaintext chunk default moved from **16 MiB to 32 MiB**.
- Together those raise **peak tab memory to ≈ 128 MiB from ≈ 32 MiB**. That is
  stated plainly rather than buried: it is the one user-visible resource cost of
  this change, it remains a constant that does not grow with the file, and a
  deployment can lower it by environment with no code change.

No cryptography, wire format, schema, route, RBAC or identity behaviour changed.

### Why a worker pool and not batches

Batching makes every batch wait for its slowest member before the next begins,
which returns most of the saving when chunk sizes differ — and the final chunk is
always a remainder. Workers pulling from one queue stay busy until it is empty.

### Safety properties, each unchanged and separately pinned

| Property | How it holds under concurrency |
| :--- | :--- |
| One index, one successful writer from this client | The queue hands out indexes with a synchronous `cursor += 1` and no `await` between read and increment. Two workers cannot get the same index by structure, not by timing luck. |
| Fresh IV on every encryption, retries included | Unchanged from LFT-V2-B: `encryptVaultChunk()` draws a new 96-bit IV per call and a retry re-encrypts rather than resending held ciphertext. Concurrency does not touch this path. A test asserts every IV across a run with forced retries is distinct. |
| Bounded memory, no whole-file read | Each worker holds one plaintext slice plus one ciphertext and releases the plaintext as soon as sealing completes. The regression test whose `File.arrayBuffer()` **throws** now also runs at concurrency 4 and records every slice range to prove none exceeds one chunk. |
| Exactly-once commit | Commit still runs once, after all workers drain, only when no terminal failure occurred. |
| Resume authority | Unchanged: resume re-reads server status rather than trusting client memory. |
| contentId / chunkIndex / chunkCount binding | Untouched — AAD construction is the same code. |

### Progress cannot double-count

`settledBytes` (server-confirmed) and `inflightBytes` (per-index, on the wire) are
disjoint; a chunk moves between them in adjacent statements with no `await`
between, immediately before the progress callback. That adjacency is the whole
defence. A retry resets that chunk's in-flight contribution to zero, because the
bytes of a failed attempt never reached the server. The test asserts no reported
`transferredBytes` ever exceeds the file size — the observable symptom of a double
count — and that the final value lands exactly on it.

The user-visible chunk index is the **lowest still in flight**, and the stage
label is derived once from whether any upload is active rather than announced per
worker. Both prevent the panel flickering between two racing chunks.

### A failure stops scheduling; it does not abandon work in flight

The stop condition is checked **before a worker takes new work**, never mid-request.
A request already travelling is allowed to settle: dropping it would discard bytes
the server may already hold without the client knowing, which is exactly the state
that makes a later resume compute the wrong missing set.

This produces a real behavioural difference from the serial path, and it is
correct: at concurrency 1 a permanent failure on chunk 1 means chunk 2 is never
touched; at concurrency 2, chunk 2 may already have succeeded. Two existing tests
encoded the serial expectation, so they were **re-pinned under an explicit
`concurrency: 1`** — which is also the required proof that serial mode still
behaves exactly as before — and the concurrent behaviour got its own tests.

### Server validates strictly, client clamps — on purpose

`uploadConcurrency` is published by `GET /api/vault/uploads/limits` so no client
bakes in its own number. It is a **recommendation, not an enforced limit**: the
server cannot stop a client from opening more connections, and claiming otherwise
would be security theatre. Real protection lives at the edge and in the per-chunk
write lock (`CHUNK_WRITE_IN_PROGRESS`). So the server **refuses to boot** on a
value outside 1–4, while the client **clamps** it — a tab must not refuse to
upload because an administrator typed a bad number into an advisory field.

## Source files changed

- `IDEA1-AEGIS_Drive_LC/src/lib/vaultChunkedUpload.js` — serial loop replaced by the
  bounded worker pool; `resolveUploadConcurrency()` exported; per-index in-flight
  byte accounting; stage derived from active-upload count; the limits fetch stays
  conditional on chunk size only, so a caller that already knows the chunk size
  does not fail when that endpoint is down.
- `IDEA1-AEGIS_Drive_LC/server/config/vaultTransferLimits.js` — `VAULT_UPLOAD_CONCURRENCY`
  (1–4, default 2); plaintext chunk default 16 MiB → 32 MiB; the memory contract
  written down at the constant that defines it.
- `IDEA1-AEGIS_Drive_LC/server/routes/vaultUploads.js` — `/limits` publishes
  `uploadConcurrency`.
- `IDEA1-AEGIS_Drive_LC/tests/vaultChunkedUploadClient.test.js` — two order-dependent
  tests re-pinned to `concurrency: 1`; eight new tests covering real simultaneity,
  the 1–4 bound, no duplicate writers, no double-counted progress, scheduling
  stopping on terminal failure, fresh IVs under concurrency, the bounded-memory
  contract at concurrency 4, and cancel with several chunks in flight.
- `IDEA1-AEGIS_Drive_LC/tests/transferLimitsConfig.test.js` — new default asserted;
  concurrency range and boot-refusal tests; the peak-memory formula pinned as a
  constant independent of file size.

## Verification evidence

- `npm test` (in `IDEA1-AEGIS_Drive_LC/`) — **pass**: 621 tests, 554 pass, 0 fail,
  67 PostgreSQL-gated skips (count unchanged).
- `npm run build` — **pass**, built in 10.73 s.
- `node --test tests/vaultChunkedUploadClient.test.js` — **pass**: 20/20.
- `node --test tests/transferLimitsConfig.test.js` — **pass**: 11/11.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` —
  **pass**, 2 pre-existing canvas warnings.
- Edge headroom checked arithmetically: a 32 MiB plaintext chunk is 33,554,448
  bytes of ciphertext with its GCM tag, against the 65m (68,157,440) Vault chunk
  cap set in LFT-V2-C. No edge change is required by this branch.

The concurrency tests hold every PUT open behind a gate and count how many are
simultaneously live, so simultaneity is **measured, not inferred** from timing.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — new LFT-V2-E2
  section: the worker-pool design and why not batches, each preserved safety
  property, the progress accounting, the deliberate failure semantics, the two
  moved defaults with the memory number stated, and the verification totals.
  `LARGE_FILE_TRANSFER_V2` remains `IN_PROGRESS`.

## Shared surfaces touched

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/concepts/Large_File_Transfer_V2.md` — a
  cross-area concept note outside the `idea1/` boundary. §11.3's variable table
  gains `VAULT_UPLOAD_CONCURRENCY` and the new chunk default; a new §12 documents
  the scheduler, the progress accounting, the failure semantics, the memory
  contract as a formula, and why the server and client validate differently.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/summaries/08_Outstanding_Items_Consolidated.md`
  — the consolidated cross-area outstanding list; the
  `LARGE_FILE_TRANSFER_V2 = IN_PROGRESS` row records LFT-V2-E2 as source-complete
  and locally verified, with the memory increase and the absence of any throughput
  measurement stated explicitly.

No code, deployment, gateway, database, authentication or network surface outside
`IDEA1-AEGIS_Drive_LC/` was touched.

## Integration requests

- **Kla — review of the two shared vault notes above**, both outside the `idea1/`
  ownership boundary.
- **Kla — accept or reject the raised memory ceiling before deployment.** Peak tab
  memory during a Vault upload goes from ≈ 32 MiB to ≈ 128 MiB at the new
  defaults. If any supported client device makes that unacceptable, the fix needs
  no code: set `VAULT_CHUNK_PLAINTEXT_BYTES=8388608` and `VAULT_UPLOAD_CONCURRENCY=1`
  for a ≈ 16 MiB peak, or `VAULT_CHUNK_PLAINTEXT_BYTES=16777216` to keep the old
  chunk size with two lanes (≈ 64 MiB). Rollback of the whole change is reverting
  this branch; rollback of the resource cost alone is the environment variables.
- **Kla — no edge change is requested by this branch.** The 32 MiB chunk fits the
  existing 65m cap with headroom. The separate commit-timeout request from
  LFT-V2-E1 still stands independently.

## Known limitations

- **No throughput improvement is claimed, and none was measured.** Concurrency
  removes a structural idle gap in the schedule. Whether that produces a
  measurable MB/s change on the real link is an `LFT-V2-D` acceptance question,
  and nothing in this repository has measured it. Any claim that this makes
  uploads "N× faster" would be unsupported.
- **The 128 MiB peak is derived, not profiled.** It follows from the code holding
  one plaintext and one ciphertext per worker, and is pinned as a formula by test.
  It is not a browser heap measurement, and real heap use will exceed it by
  whatever the engine's allocator and the request machinery add.
- **Concurrency is unverified against the real edge.** Two to four simultaneous
  in-flight PUTs per user have not been run through the real nginx configuration
  under load. The per-chunk write lock and the edge worker pool are the relevant
  surfaces, and neither was exercised here.
- **No multi-gigabyte or 32 GiB transfer was performed.** Test chunk sizes are
  1 KiB for speed; the logic is size-independent but the scale is not measured.
- **Nothing was deployed and no production acceptance was performed.**
- **Stacked branch.** This PR targets `feat/idea1-lft-v2-e1-rate-eta-limits`. If
  that branch changes during review, this one must be updated and re-verified
  before its own merge.
- **Goal D (Service Worker large encrypted video preview) is not in this branch**
  and is planned as LFT-V2-E3.
