# AEGIS IDEA1 Transfer and Media Performance Study Design

Status: IN PROGRESS / REMOTE PRE-FIX MEASUREMENTS COMPLETE / ONSITE PENDING
Task: LFT-PERF-1 / TRANSFER_AND_MEDIA_PREVIEW_PERFORMANCE_STUDY
Area / owner: IDEA1 / kla
Production mutation: NO
Performance settings changed: NO
Optimization executed: NO
Root cause: NOT PROVEN

## 1. Purpose and research questions

This study operationalizes the existing LFT-PERF-1 backlog. It also consolidates
FILES-TRANSFER-PERF-1 and the performance work explicitly deferred by PR187 and
PR212. It does not start a second unrelated performance task.

Primary question:

> Which client, application, server, storage, or network-path stages limit AEGIS
> upload, download, Public Anywhere delivery, and media-preview responsiveness,
> and how do those limits change with payload size and media characteristics?

Secondary questions:

1. How do the two primary network paths (P1 Onsite Direct LAN vs P2 Remote Internet through Twingate) differ when the same source object and workload are used, and how does the supplementary Cloudflare Public Anywhere path compare?
2. How much elapsed time is spent in client hashing, Vault encryption/decryption,
   network transfer, server write/read, commit verification, derivative
   generation, queueing, and browser decode?
3. Which effects scale with bytes, chunk count, codec/bitrate, cache state,
   concurrency, or path?
4. Where is HTTP Range effective, unsupported, or generating excess work?
5. Which current limits are configuration ceilings rather than performance
   failures?
6. Which controlled optimization is justified by evidence, and what safety
   invariant must it preserve?

No optimization, configuration mutation, infrastructure change, or Production
benchmark execution is authorized by this document.

## 2. Evidence vocabulary

| Label | Meaning | Required treatment |
|---|---|---|
| ARCHITECTURE FACT | A behavior demonstrated by current source/configuration or an accepted runtime contract | Cite exact source/path and SHA or accepted receipt |
| HISTORICAL EVIDENCE | A prior measured observation bound to its recorded environment and source | Preserve conditions, result, and limitations |
| MEASURED EVIDENCE | A result produced by this study under the declared path, fixture, repetition, and runtime | Store raw run plus derived summary; never overwrite |
| HYPOTHESIS | A falsifiable candidate explanation | State supporting, falsifying, and distinguishing measurements |
| INFERENCE | A conclusion drawn from multiple measurements | Name the measurements and uncertainty; never present as direct observation |
| NOT PROVEN | Evidence is missing or cannot distinguish alternatives | Remains open |

Source defaults are ARCHITECTURE FACTS, not current Production values. Running
Production values were measured in Human-run Phase B0 (2026-09-25T14:35:03Z).

## 3. Architecture and measurement boundaries

### 3.1 Primary network paths

For the core PRE/POST experiment, there are exactly TWO primary network paths:

- **P1 = ONSITE_DIRECT_LAN**: Human laptop physically on site, wired Ethernet / Management VLAN30, direct internal AEGIS access (e.g. `192.168.10.10:443`), Twingate not part of the tested data path.
- **P2 = REMOTE_TWINGATE**: Human laptop physically remote from site, Twingate enabled, accesses private AEGIS services remotely through the Twingate overlay path.

Earlier browser tracer runs were generated with historical labels such as `P3_T1_...`. Those historical run labels MUST NOT be rewritten or falsified. The interpretation mapping is documented explicitly:

~~~text
HISTORICAL_RUN_LABEL_P3 = FINAL_METHODOLOGY_P2_REMOTE_TWINGATE
~~~

Original raw labels are preserved in evidence tables; their interpretation is normalized in tables and analysis. Do NOT create a third primary path such as "local Wi-Fi + Twingate". The core controlled PRE/POST comparison evaluates P1 vs P2 only.

~~~text
Client browser
  -> P1: On-site wired Ethernet (Management VLAN30) -> direct private access
  -> P2: Remote Internet client -> Twingate private-access overlay
  -> private LAN / NAT boundary
  -> HUB / Drive application
  -> PostgreSQL metadata + Data Lake storage
~~~

Twingate is the private remote-access overlay/path. It is not the NAT server. The AEGIS host is a PC-based, self-hosted private server behind a private LAN/NAT environment.

### 3.2 Supplementary Public Anywhere path

~~~text
External Internet client (Twingate OFF)
  -> Cloudflare edge
  -> Cloudflare Tunnel
  -> isolated Public Share connector
  -> Public Share Gateway
  -> AEGIS Drive
  -> Data Lake storage
~~~

Public Anywhere through Cloudflare is a separate supplementary architecture, download/redemption oriented, and does not provide an authenticated Files upload path. It is not a third primary core path. Public Share security architecture is out of scope. The study measures the accepted path; it does not redesign ingress, trust, token, revocation, network isolation, or fail-closed controls.

### 3.3 Current application transfer facts

Running Production values measured during Phase B0 observation (2026-09-25T14:35:03Z):

| Surface | Current source fact | Production truth (B0 Measured 2026-09-25) |
|---|---|---|
| Normal Files upload | Default 16 MiB chunks; default 5 GiB logical limit; configurable source ceiling 32 GiB; incremental SHA-256 in 4 MiB slices; resumable session/chunk map | MEASURED: chunkSizeBytes=16777216, maxLogicalFileBytes=5368709120 (5 GiB), maxSupportedLogicalFileBytes=34359738368 (32 GiB), sessionTtlMs=86400000; usable capacity=10349204889 B |
| Vault V2 upload | Default 32 MiB plaintext chunks; recommended concurrency 2, bounded 1–4; default 5 GiB logical limit; source ceiling 32 GiB; per-chunk client AES-GCM | MEASURED (`/drive/api/vault/uploads/limits`): formatVersion=2, plaintextChunkBytes=16777216 (16 MiB), ciphertextChunkBytes=16777232, gcmTagBytes=16, uploadConcurrency=2, maxLogicalFileBytes=5368709120 (5 GiB), maxPlaintextChunkBytes=67108864, minPlaintextChunkBytes=8388608, sessionTtlMs=86400000 |
| Normal Files full download | Disk-backed streaming; full-download path and current response framing must be observed | MEASURED: Browser streaming via native `<a>` download to `/api/files/:id/download`; no in-tab fetch buffering |
| Files explicit Preview | Owner-only preview supports byte Range where current route permits | ARCHITECTURE FACT |
| Vault V2 video Preview | Service Worker maps browser Range requests to minimum encrypted chunks and client decryption | ARCHITECTURE FACT |
| Public Share | Streams full response; current architecture explicitly has no Range/resume, so interruption restarts from byte zero | ARCHITECTURE FACT; functionally restored post-1033; external video ~1.01 GB download PASS |
| Files media derivatives | Server poster/motion pipeline; bounded in-process queue; default one worker; Sharp for eligible stills and FFmpeg for other poster/motion work; content-addressed rebuildable cache | MEASURED (`/drive/api/admin/media-cache/status`): enabled=true, ffmpeg=8.0.1, sharp=0.35.4, cache_bytes=274284, cache_entries=5, highWater=2147483648, lowWater=1717986918, queue_depth=0, queue_running=0, failures_24h=0 |
| Vault media cards | Client-side, zero-knowledge image/GIF/video extraction and range/decryption behavior; no server derivative cache | ARCHITECTURE FACT |

Observed Production container runtime environment:
- Container `/aegis-prod-drive-1`: image `aegis-prod-drive:vault-stage-d-fix-f8c876754dd6`, status `running`, health `healthy`, restarts `0`, oom `false`.
- Container `/aegis-prod-public-share-gateway-1`: image `aegis-public-share-gateway:public-share-50ce6e1638`, status `running`, health `healthy`, restarts `0`, oom `false`.
- Container `/aegis-prod-public-share-connector-1`: image `cloudflare/cloudflared:2026.9.0`, status `running`, restarts `0`.
- Data Lake storage: total 61,075,263,488 B, used 44,536,557,568 B, available ~13,403,045,888 B (~77% usage). SSD-backed storage path, not the separate rotational backup disk. (Topology/runtime truth only; does NOT mean storage cannot be a bottleneck).
- Effective relevant Drive runtime values:
  - `MEDIA_CACHE_POLICY=immutable`
  - `VAULT_CHUNK_PLAINTEXT_BYTES=16777216`
  - `MEDIA_CACHE_MAX_BYTES=2147483648`
  - `MEDIA_STILL_ENGINE=sharp`
  - `VAULT_UPLOAD_CONCURRENCY=2`
  - `MEDIA_ENABLED=true`
  - `MEDIA_WORKERS=1`

## 4. Historical evidence inventory

| Area | Prior PR / evidence | What was tested | Result | What it proves | What it does NOT prove |
|---|---|---|---|---|---|
| Historical Onsite vs Remote | PR #61 receipt and measurements (2026-09-02) | Direct VLAN30 (client 192.168.30.10, gateway 192.168.30.1, server 192.168.10.10:443); ~1.1 GB Vault video (TTFF ~8 s, >60 s playback, seek PASS); ciphertext fetch at 1, 2, 4 parallel; Remote comparison | Direct ciphertext: 1 parallel = 10.17 MiB/s, 2 parallel = 10.53 MiB/s, 4 parallel = 10.46 MiB/s; Remote: ~4.65 / 4.22 / 4.26 MiB/s | Historical delivery baseline at 2026-09-02; ~10 MiB/s direct VLAN30 vs ~4.2–4.6 MiB/s remote; accepted as REMOTE_DELIVERY_ENVIRONMENT_NETWORK_PATH_LIMITATION | Current application/runtime baseline (application and pipeline evolved); numbers must not be merged into current 2026-09-25 controlled Files sample set; re-measurement of P1 on current Production required |
| Large File Transfer V2 | Large_File_Transfer_V2; LFT-V2 receipts | Bounded/resumable Files and Vault protocols, integrity, configuration bounds, direct-VLAN large preview | Source and accepted scope PASS; 1.1 GB V2 upload historical PASS; ~1.1 GB direct-VLAN Vault video first frame ~8 s, >60 s playback, seek resumed | Chunked architecture, resume, integrity, and one direct-VLAN preview path work | Comparative LAN/Twingate/Cloudflare throughput; 5/10 GB acceptance; universal browser/media performance |
| Files upload | PR148 receipt and canonical status | Production upload UX, rate/ETA, refresh recovery, same-file resume, oversize gate | Single-file ~1.9–2.8 MB/s; two-file aggregate ~3.4 MB/s; ~2.9 GB recovered upload PASS; ~6 GB rejected by configured limit | Real Production transfers and resume occurred; configuration rejection is distinct from network failure | Controlled path comparison; stable sample distribution; exact root cause |
| Vault encrypted upload | LFT-V2-B/E2 plus PR212 | Per-chunk AES-GCM, concurrency, resume/recovery, TREE upload UX | Source/regression and Human Production behavior PASS | Zero-knowledge chunk upload/recovery works | Crypto time share, per-path throughput, safe optimal concurrency |
| Resumable upload | PR148 and PR212 receipts | Missing-chunk resume, wrong-file rejection, recovery metadata | PASS | Resume avoids retransmitting acknowledged chunks under tested flows | WAN interruption distributions, time saved at each size/path |
| Public Share internal | PUBLIC-SHARE-6 history | Real Gateway/Drive/PostgreSQL, deterministic 64 MiB, SHA-256, interruption, slow client, four recipients | PASS | Streaming integrity, lifecycle, slow-client survival, concurrency at 64 MiB | Multi-GB throughput or Public Cloudflare path performance |
| Public Share external Twingate-OFF | S5.8–S5.12 receipt | Wi-Fi and mobile external create/redeem/revoke; Cloudflare route; 64 MiB integrity/resilience | PASS | External Public Anywhere functionality works without Twingate | Cloudflare throughput ceiling; 1/5/10 GB controlled samples |
| PR150 media preview | PR150 design/plan/runbook and accepted source | Server derivatives, cache, Range serving for derivatives, queue bounds, large/sparse source classes, Production image/GIF/video behavior | Accepted implementation; Production 49.7 MB GIF and ~196 MB video behavior recorded; large-source fixture evidence exists | Pipeline architecture, output bounds, cache semantics, and selected media behavior | Current cold/warm latency distribution; current queue/resource bottleneck; Vault media performance |
| PR171 media UX | PR171 receipt/history | Client-only Vault image/GIF/video cards, poster selection, hover/preview UX | Human accepted | Files-like Vault media UX exists | Transfer/media latency or bottleneck |
| PR187 Production rollout | 2026-09-25 PR187 receipt | Migration 011, TREE_V1 rollout, flags, health, rollback boundary | Production TREE_V1 PASS; destructive purge false | Current Vault protocol state and immutable post-TREE boundary | Performance improvement or cause |
| PR212 Stage-D repair | 2026-09-25 PR212 receipt | Upload drawer/tray, refresh recovery, realtime media covers, TREE_V1 preservation | Human Production PASS | Accepted current UX/source and recovery flow | Hover/Preview buffering, TTFF, throughput, network/gateway contribution |
| Recent Public Share recovery | Human Owner evidence supplied to LFT-PERF-1 on 2026-09-25 | Recovery after Cloudflare 1033; connector lifecycle/drift; external image and ~1 GB video download; revoke | PUBLIC_SHARE_FUNCTIONALITY=RESTORED; image download PASS; large-video download PASS; revoke/post-revoke block PASS | The current public feature functions again; 1033 was associated with inactive connector/drift recovery | Throughput root cause; Twingate contribution; proof that candidate did or did not cause unrelated activity |
| Historical LFT-PERF-1 | 2026-09-16 follow-up note/receipt | Backlog classification | PLANNED; no isolating experiment | Performance diagnosis was intentionally deferred and already has one canonical identity | Any confirmed bottleneck |

Recent recovery details are owner-supplied historical evidence: the connector
service was inactive; drift had observed Drive temporarily missing from
aegis_public_share_upstream at 172.31.241.3; fail-closed logic stopped only
cloudflared; Human restoration passed the pre-start gate; connector identities
returned to edge 172.31.240.3 and egress 172.31.242.2; drift returned
S5.5-RUNTIME=DRIFT-OK. Cloudflare 1033 is classified RESOLVED. This is a
lifecycle/drift incident, not a measured throughput root cause.

## 5. Study parts and gates

| Part | Content | Current state |
|---|---|---|
| A | Historical architecture and existing evidence | DOCUMENTED |
| B | Current Production baseline measurement | B0 EXECUTED (2026-09-25T14:35:03Z) / B1 PENDING_ONSITE |
| C | Network path comparison | P2 REMOTE PRE-FIX EXECUTED (18 runs) / P1 ONSITE PENDING |
| D | Upload, download, HTTP Range, and media measurement | REMOTE FILES UPLOAD & DOWNLOAD COMPLETE (18 runs) / ONSITE PENDING (18 runs) / VAULT & MEDIA SUPPLEMENTARY |
| E | Client/server resource measurement | SAMPLED ON 1 GB REMOTE (CPU ~6.97%, RAM ~1.32%, low iostat util/await) |
| F | Root-cause classification | ROOT_CAUSE=NOT_PROVEN; TWINGATE_SOLE_BOTTLENECK=NOT_PROVEN; UPLOAD_SPECIFIC_BOTTLENECK=STRONGER_CANDIDATE |
| G | Controlled one-variable optimization experiments | DESIGNED / NOT AUTHORIZED / MUTATION GATE BLOCKED PENDING P1 PRE-FIX |
| H | Recommended settings, limitations, future work | EVIDENCE REQUIRED |

Parts F–H cannot claim an outcome until B–E provide adequate evidence.

## 6. Fixture size ladder and capacity classification

Decimal units are mandatory for fixtures. Deterministic benchmark fixtures on the Human Windows client reside in `C:\Users\User\AEGIS-LFT-PERF-1`:

| Class | Label | Exact bytes | Status / Manifest SHA-256 |
|---|---|---:|---|
| S | 100 MB | 100,000,000 | `f079cad53add0091ed5d0409b0469f9f5cb745b8c280be685dda73203dea90e8` |
| M | 300 MB | 300,000,000 | Generated deterministic binary fixture |
| L | 1 GB | 1,000,000,000 | Generated deterministic binary fixture |
| XL | 5 GB | 5,000,000,000 | 5,000,000,000 B < 5 GiB logical limit (5,368,709,120 B) |
| XXL | 10 GB | 10,000,000,000 | 10,000,000,000 B > 5 GiB logical limit -> EXPECTED_CONFIG_LIMIT |

Each result has test_mode=ACTUAL_TRANSFER_TEST or
test_mode=CONFIGURED_LIMIT_TEST. Decimal GB must not be confused with binary
GiB. The measured 5 GiB default equals 5,368,709,120 bytes.

10 GB policy:

1. Read the running limit first (measured at B0: 5,368,709,120 bytes).
2. 5 GB decimal (5,000,000,000 bytes) is below the 5 GiB limit.
3. 10 GB decimal (10,000,000,000 bytes) is above the 5 GiB limit.
4. Do not change a limit for the benchmark. Do not propose raising the limit just to make the benchmark pass.
5. If client or server rejects before transfer, record:

~~~text
TEST_SIZE=10_GB
TRANSFER_STARTED=NO
RESULT=EXPECTED_CONFIG_LIMIT
NETWORK_PERFORMANCE=NOT_MEASURED
~~~

6. Record rejection layer: CLIENT_CONFIG, HTTP_APPLICATION,
   SERVER_CONFIG, STORAGE_CAPACITY, NETWORK_TIMEOUT, or INTEGRITY.
7. Apply the same boundary discipline to 5 GB.

Generic fixtures are deterministic local byte streams. Each manifest records
exact bytes, SHA-256, generator version/command, filename, creation host,
filesystem allocation, and cleanup disposition.

Media fixtures additionally record container, video/audio codec, resolution,
fps, duration, average bitrate, exact bytes, SHA-256, encoder build, and whether
the file is a real encoded fixture or a structural/sparse fixture. Sparse
fixtures are architecture tests only and never throughput evidence.

## 7. Network path definitions

For the core PRE/POST experiment, exactly TWO primary network paths are defined:

| ID | Path | Required proof | Status in Core Matrix |
|---|---|---|---|
| P1 | ONSITE_DIRECT_LAN: Closest practical LAN client-to-server path, wired Ethernet / Management VLAN30, Twingate OFF | Interface, route, server identity 192.168.10.10:443, Twingate OFF | PENDING_ONSITE (18 runs) |
| P2 | REMOTE_TWINGATE: Remote Internet client physically outside LAN with Twingate enabled | Outside LAN proof, WAN type, Twingate ON, direct/relayed if observable | COMPLETE (18 runs) |

### 7.1 Historical tracer label mapping

Earlier browser tracer runs were recorded using labels such as `P3_T1_...`. Those historical run labels MUST NOT be rewritten or falsified. The interpretation mapping is:

~~~text
HISTORICAL_RUN_LABEL_P3 = FINAL_METHODOLOGY_P2_REMOTE_TWINGATE
~~~

Original raw labels are preserved in evidence tables; their interpretation is normalized in tables and analysis. Do NOT create a third primary path such as "local Wi-Fi + Twingate". The core controlled comparison is P1 vs P2.

### 7.2 Supplementary paths

- **Cloudflare Public Anywhere**: External client with Twingate OFF via Cloudflare Tunnel -> Public Share Gateway. Download/redemption oriented only; supplementary future measurement, not a third core path.
- **Local Wi-Fi + Twingate**: Retained as optional exploratory diagnostic path only, not a primary core path.

## 8. Workloads

### 8.1 Core PRE/POST transfer workloads

| ID | Workload | Direction | Principal measurements |
|---|---|---|---|
| T1 | Normal Files upload | Upload | Chunk requests, chunk span ms, chunk span MB/s, HTTP status, integrity |
| T3 | Authenticated Files full download | Download | Browser native stream duration ms, download MB/s, exact bytes, SHA-256 |

### 8.2 Supplementary future workloads

| ID | Workload | Principal measurements |
|---|---|---|
| T2 | Private Vault encrypted upload | key/encrypt time, chunk rate/concurrency, commit, resume, integrity boundary |
| T4 | Vault full download/Preview | decrypt time, Range/chunk mapping, TTFF, seek, integrity |
| T5 | Public Anywhere full download | Cloudflare TTFB/rate, integrity, interruption behavior |
| T6 | HTTP Range transfer | status, requested/returned range, TTFB, seek latency, 206/416 |
| T7 | Image thumbnail/cover | cold/warm ready latency, bytes, cache/source behavior |
| T8 | GIF preview | poster ready, hover start, bytes, stalls |
| T9 | Video poster | cold/warm poster ready, queue/generation/read bytes |
| T10 | Video hover/motion preview | startup, derivative/client work, stalls |
| T11 | Interactive Preview playback | TTFF, seek, range count, stalls, total stalled time |

## 9. Core controlled experiment matrix

The core PRE/POST experiment evaluates:
- 2 network paths: P1 On-site Direct LAN, P2 Remote + Twingate
- 3 file sizes: S (100 MB = 100,000,000 B), M (300 MB = 300,000,000 B), L (1 GB = 1,000,000,000 B)
- 2 transfer directions: Files Upload (T1), Files Download (T3)
- 3 repetitions (n=3)

Total PRE-FIX target: 2 paths × 3 sizes × 2 directions × 3 repetitions = **36 PRE-FIX runs**.
Total POST-FIX target: identical 2 paths × 3 sizes × 2 directions × 3 repetitions = **36 POST-FIX runs**.
Overall study target: **72 measured runs**.

### 9.1 Current core matrix execution status

| Path | Workload | 100 MB | 300 MB | 1 GB | 5 GB (Round 2) | 10 GB (Round 2) | Status |
|---|---|---|---|---|---|---|---|
| **P1 Onsite Direct LAN** | T1 Files upload | PENDING (n=3) | PENDING (n=3) | PENDING (n=3) | Deferred | CONFIG-LIMITED | 9 runs PENDING_ONSITE |
| **P1 Onsite Direct LAN** | T3 Files download | PENDING (n=3) | PENDING (n=3) | PENDING (n=3) | Deferred | CONFIG-LIMITED | 9 runs PENDING_ONSITE |
| **P2 Remote + Twingate** | T1 Files upload | **COMPLETE** (2.981 MB/s) | **COMPLETE** (3.080 MB/s) | **COMPLETE** (3.016 MB/s) | Deferred | CONFIG-LIMITED | **9 runs COMPLETE** |
| **P2 Remote + Twingate** | T3 Files download | **COMPLETE** (4.799 MB/s) | **COMPLETE** (5.050 MB/s) | **COMPLETE** (4.829 MB/s) | Deferred | CONFIG-LIMITED | **9 runs COMPLETE** |

Core PRE-FIX Summary:
- P2 Remote + Twingate PRE-FIX: **18/18 COMPLETE**
- P1 Onsite Direct LAN PRE-FIX: **18/18 PENDING_ONSITE**
- Core PRE-FIX overall: **18/36 COMPLETE**
- POST-FIX: **0/36 NOT STARTED** (`PERFORMANCE_MUTATION_GATE=BLOCKED_PENDING_P1_PRE_FIX`)

### 9.2 Time-bounded execution priority

- Round 1 uses S/M/L (100 MB, 300 MB, 1 GB) across P1 and P2 for core T1 and T3 workloads.
- Round 2 evaluates 5 GB and 10 GB only after P1 PRE-FIX baseline is captured and storage/time safety permit.
- Supplementary workloads (T2, T4, T5, T6, T7–T11) remain planned for subsequent sub-studies; they are not required to declare the core two-path transfer baseline.

## 10. Validated measurement methods and metrics

### 10.1 Upload measurement method correction

The original plan assumed browser Resource Timing would capture upload XHRs. In the tested Production/browser path, upload XHRs were not exposed in Resource Timing entries.

The validated method uses a temporary Human-controlled in-page `XMLHttpRequest` tracer (`window.__AEGIS_LFT_TRACE__`):
- Patches `XMLHttpRequest.prototype.open` and `send` in tab memory.
- Intercepts PUT requests to `/drive/api/files/uploads...`.
- Records body bytes, chunk start/end timestamps, HTTP status, and duration.
- Exposes control methods: `window.__AEGIS_LFT_TRACE__.startRun(...)` and `report()`.
- Primary reliable throughput metric: **`CHUNK_SPAN_MBPS`** (bytes transferred divided by elapsed span across upload chunk requests).
- Contamination note: The E2E timer includes human file-picker interaction delay and UI latency; E2E is supplementary/contaminated and MUST NOT be used as the primary transfer throughput.
- Resource Timing upload capture is NOT a validated method for this path.

### 10.2 Download measurement method correction

Brave browser Files download intentionally uses native browser streaming (`<a>` link to `/api/files/:id/download` with `a.click()`) to avoid fetch()-buffering large whole files in tab memory.

Because browser DevTools did not expose a suitable network request for this native streaming download, the validated method uses a PowerShell observer:
- Waits for newly-created Brave `.crdownload` temporary file in the download directory.
- Starts high-resolution Stopwatch.
- Polls until the `.crdownload` file disappears.
- Resolves the promoted final file by expected exact byte size.
- Stops timing and computes decimal MB/s.

*Harness defect note*: An early pilot script defect incorrectly expected `Unconfirmed XXXXX.crdownload` to rename without an extension; Brave promoted it to the target filename (e.g. `S-100MB.bin`). This was a test harness defect, not an AEGIS defect. The pilot attempt is excluded and was not counted as a controlled run.

### 10.3 Metric definitions

- exact bytes requested, sent, received, and integrity-verified;
- wall-clock elapsed milliseconds;
- effective MB/s = bytes / 1,000,000 / elapsed seconds;
- effective Mbps = bytes x 8 / 1,000,000 / elapsed seconds;
- browser-reported and server-observed rates, labelled by observer;
- HTTP status, retry count, resumed byte offset/chunk set, outcome;
- source and received SHA-256 for non-Vault payloads;
- Vault server ciphertext-integrity result and client plaintext-integrity result, kept distinct;
- TTFB, TTFF, poster/motion latencies, and seek latencies for media.

## 11. Measured evidence and statistical summary

All throughput values are decimal MB/s (`bytes / 1,000,000 / seconds`).
Executed by Human Owner under Remote + Twingate conditions.

### 11.1 Files upload results (P2 Remote + Twingate)

Fixtures: S-100MB (100,000,000 B, 6 chunks), M-300MB (300,000,000 B, 18 chunks), L-1GB (1,000,000,000 B, 60 chunks: 59 × 16,777,216 B + 1 × 10,144,256 B).

| Fixture | Run | Chunk Requests | Chunk Bytes | HTTP Status | Chunk Span (ms) | Throughput (MB/s) |
|---|---|---:|---:|---|---:|---:|
| **100 MB** | r01 | 6 | 100,000,000 | all 200 | 33,541 | 2.981 |
| 100 MB | r02 | 6 | 100,000,000 | all 200 | 35,284 | 2.834 |
| 100 MB | r03 | 6 | 100,000,000 | all 200 | 32,681 | 3.060 |
| **100 MB Summary** | **n=3** | **Min: 2.834** | **Median: 2.981** | **Max: 3.060** | **Mean: ~2.958** | **PASS** |
| **300 MB** | r01 | 18 | 300,000,000 | all 200 | 97,389 | 3.080 |
| 300 MB | r02 | 18 | 300,000,000 | all 200 | 96,675 | 3.103 |
| 300 MB | r03 | 18 | 300,000,000 | all 200 | 100,773 | 2.977 |
| **300 MB Summary** | **n=3** | **Min: 2.977** | **Median: 3.080** | **Max: 3.103** | **Mean: ~3.053** | **PASS** |
| **1 GB** | r01 | 60 | 1,000,000,000 | all 200 | 329,883 | 3.031 |
| 1 GB | r02 | 60 | 1,000,000,000 | all 200 | 332,576 | 3.007 |
| 1 GB | r03 | 60 | 1,000,000,000 | all 200 | 331,597 | 3.016 |
| **1 GB Summary** | **n=3** | **Min: 3.007** | **Median: 3.016** | **Max: 3.031** | **Mean: ~3.018** | **PASS** |

Upload Controlled Verdict:
- `P2_REMOTE_TWINGATE_FILES_UPLOAD_PRE_FIX=COMPLETE`
- 100 MB median = 2.981 MB/s; 300 MB median = 3.080 MB/s; 1 GB median = 3.016 MB/s.
- `SUSTAINED_UPLOAD_THROUGHPUT≈3.0 MB/s` across the tested range.
- `FILE_SIZE_DEPENDENT_DEGRADATION=NOT_OBSERVED` within 100 MB to 1 GB.
- `REPRODUCIBLE=YES`.

### 11.2 Files download results (P2 Remote + Twingate)

| Fixture | Run | Elapsed (ms) | Download (MB/s) | Integrity Result |
|---|---|---:|---:|---|
| **100 MB** | r01 | 20,839 | 4.799 | Exact size match |
| 100 MB | r02 | 23,286 | 4.294 | Exact size match |
| 100 MB | r03 | 18,992 | 5.265 | Exact size match |
| **100 MB Summary** | **n=3** | **Min: 4.294** | **Median: 4.799** | **Max: 5.265 (Mean: ~4.786)** |
| **300 MB** | r01 | 59,410 | 5.050 | Exact size match |
| 300 MB | r02 | 61,937 | 4.844 | Exact size match |
| 300 MB | r03 | 49,321 | 6.083 | Exact size match |
| **300 MB Summary** | **n=3** | **Min: 4.844** | **Median: 5.050** | **Max: 6.083 (Mean: ~5.326)** |
| **1 GB** | r01 | 207,080 | 4.829 | Exact size match |
| 1 GB | r02 | 205,192 | 4.873 | Exact size match |
| 1 GB | r03 | 214,789 | 4.656 | Exact size match |
| **1 GB Summary** | **n=3** | **Min: 4.656** | **Median: 4.829** | **Max: 4.873 (Mean: ~4.786)** |

Download Controlled Verdict:
- `P2_REMOTE_TWINGATE_FILES_DOWNLOAD_PRE_FIX=COMPLETE`
- 100 MB median = 4.799 MB/s; 300 MB median = 5.050 MB/s; 1 GB median = 4.829 MB/s.
- `FILE_SIZE_DEPENDENT_DEGRADATION=NOT_OBSERVED` within 100 MB to 1 GB.

### 11.3 Upload vs download asymmetry observation

Under the same Remote + Twingate client environment:

| Size | Download Median (MB/s) | Upload Median (MB/s) | Ratio (Download / Upload) | Delta |
|---|---:|---:|---:|---|
| 100 MB | 4.799 | 2.981 | ~1.61x | Download ~61% faster |
| 300 MB | 5.050 | 3.080 | ~1.64x | Download ~64% faster |
| 1 GB | 4.829 | 3.016 | ~1.60x | Download ~60% faster |

Observation:
- Files download throughput was consistently roughly 60–64% higher (~1.6x) than Files upload throughput across all three tested fixtures.
- Governance classification:
  - Allowed: "Under the tested Remote + Twingate condition, Files download throughput was consistently higher than Files upload throughput across 100 MB, 300 MB, and 1 GB fixtures."
  - NOT allowed: "Twingate is not the bottleneck."
  - NOT allowed: "The upload code is definitively the bottleneck."
  - Formal finding: `TWINGATE_SOLE_BOTTLENECK=NOT_PROVEN`; `UPLOAD_SPECIFIC_BOTTLENECK=STRONGER_CANDIDATE`; `ROOT_CAUSE=NOT_PROVEN`.

### 11.4 Supporting server telemetry during 1 GB upload (r01)

- Drive container snapshot: CPU ≈ 6.97%, RAM ≈ 94.93 MiB / 7.035 GiB (~1.32%).
- Sampled iostat: low device utilization and await; no sustained queue/saturation pattern in captured screenshots.
- Classification:
  - `CPU_SATURATION=NOT_SUPPORTED_BY_OBSERVED_EVIDENCE`
  - `MEMORY_PRESSURE=NOT_SUPPORTED_BY_OBSERVED_EVIDENCE`
  - `STORAGE_SATURATION=NOT_SUPPORTED_BY_SAMPLED_EVIDENCE`
- Strict limitations:
  - The iostat screenshots were sampled portions of the timeline, NOT complete-run telemetry.
  - Do NOT write: `STORAGE_BOTTLENECK=PROVEN_FALSE`.
  - Docker stats Block I/O is cumulative and must not be described as per-run instantaneous disk throughput.

### 11.5 Replication and statistical summary

- Minimum three measured repetitions per condition (n=3).
- Summaries: sample count, median, min, max, and optional arithmetic mean.
- Report both cold and warm media/cache states separately; never mix them in one median.
- A CONFIGURED_LIMIT_TEST has no throughput statistic.

## 12. Control variables

Each run records:

- timestamp and timezone;
- client identifier, OS, browser/version, device power mode;
- interface, Ethernet/Wi-Fi, link rate/RSSI, local/remote;
- Twingate ON/OFF and Direct/Relayed/Unknown;
- path class P1/P2;
- server image, source SHA, container runtime;
- storage device/filesystem, free bytes, and cache state;
- running transfer/media limits measured at B0;
- concurrent users/tasks and study-induced concurrency;
- fixture name, exact bytes, SHA-256;
- media container/codecs/resolution/fps/duration/bitrate;
- workload and repetition/warm-up state.

Later optimization changes one independent variable at a time. Environment drift
or concurrent unplanned load invalidates comparison pairing and is recorded.

## 13. Evidence model

One JSON Lines record per run:

~~~json
{
  "schema_version": "aegis.idea1.perf.v1",
  "run_id": "20260925T120000Z-P1-T1-S-r01",
  "timestamp": "ISO-8601",
  "source_sha": "full Git SHA",
  "server_image": "non-secret image tag",
  "path_class": "P1",
  "workload": "T1",
  "test_mode": "ACTUAL_TRANSFER_TEST",
  "repetition": 1,
  "warmup": false,
  "file_size_bytes": 100000000,
  "file_sha256": "hex digest",
  "media_metadata": null,
  "elapsed_ms": 0,
  "bytes_transferred": 0,
  "effective_mbps": 0,
  "ttfb_ms": null,
  "ttff_ms": null,
  "poster_ready_ms": null,
  "hover_start_ms": null,
  "seek_ms": null,
  "range_count": null,
  "stall_count": null,
  "stall_ms": null,
  "client_cpu_pct": null,
  "client_memory_bytes": null,
  "server_cpu_pct": null,
  "server_memory_bytes": null,
  "server_iowait_pct": null,
  "result": "PASS",
  "limitation": null
}
~~~

Required additions for CONFIGURED_LIMIT_TEST: transfer_started=false,
limit_layer, configured_limit_bytes, HTTP status/error code, and
network_performance="NOT_MEASURED".

Forbidden evidence fields and artifacts: passwords, cookies, session/CSRF
tokens, bearer URLs/tokens, Vault keys, wrapped keys, KEK/DEK material, raw
ciphertext metadata, private user content, or full secret-bearing environment
output. HAR exports must be sanitized before repository/report use; raw HAR is
local evidence only because URLs/headers may carry credentials.

## 14. Hypotheses

| ID | Hypothesis | Supporting evidence | Falsifying evidence | Distinguishing measurement | Status / Current Evidence |
|---|---|---|---|---|---|
| H1 | Twingate path is limiting | P2 materially slower than paired P1 while client/server/storage remain below saturation | Paired P1/P2 similar or P1 equally slow; download over Twingate reaches ~5.0 MB/s while upload is ~3.0 MB/s | Paired P1 vs P2 comparison; Direct vs Relayed | **TWINGATE_SOLE_BOTTLENECK=NOT_PROVEN**; UPLOAD_SPECIFIC_BOTTLENECK=STRONGER_CANDIDATE |
| H2 | Wi-Fi is limiting | Wi-Fi slower than Ethernet P1 with poor RSSI/link and no server saturation | Wi-Fi and Ethernet equal | Ethernet/Wi-Fi pair plus link/RSSI/RTT | Exploratory diagnostic |
| H3 | Server storage I/O is limiting | Throughput tracks disk utilization/latency/iowait; LAN also slow | Disk has headroom while throughput remains low | iostat/pidstat/container samples aligned to run | **STORAGE_BOTTLENECK=NOT_PROVEN**; sampled iostat showed low device util/await |
| H4 | Browser hashing is limiting | Checking/hash stage dominates; client CPU saturated; network idle | Hash small relative to total; client CPU/headroom | Separate hash_ms/hash_mbps from upload_ms | NOT PROVEN |
| H5 | Vault client crypto is limiting | T2/T4 slower than same-path T1/T3; client crypto CPU/time dominates | Vault and Files equal after byte/framing adjustment | Same source/path with client crypto timings | **CLIENT_CRYPTO_BOTTLENECK=NOT_PROVEN** |
| H6 | Upload chunk size limits throughput | High request-gap/overhead per byte; controlled chunk-only experiment improves rate without new saturation | Rate unchanged or worsens | Future one-variable chunk experiment after authorization | Future hypothesis |
| H7 | Low upload concurrency limits throughput | One stream under-fills path; bounded increase improves rate and resource use stays safe | No gain or CPU/memory/edge pressure rises | Future one-variable concurrency experiment | Future hypothesis |
| H8 | Cloudflare Public path limits throughput | P4 slower than comparable P1 full download with origin/server headroom | P4 comparable, or origin/storage equally slow | Same fixture T3/T5, path and auth surface separated | **CLOUDFLARE_BOTTLENECK=NOT_PROVEN** |
| H9 | Gateway/proxy behavior limits throughput | Gateway-observed delay/temp I/O/rate diverges from Drive read | Direct Drive path equally slow; proxy shows no added delay | Upstream vs edge timing and container/resource samples | NOT PROVEN |
| H10 | Range behavior causes video startup delay | Many/large/416 ranges, high overfetch, TTFF/seek correlate with range sequence | Efficient 206 sequence but TTFF remains high | DevTools Range log + server timing + TTFF | Supplementary |
| H11 | Media queue causes cover/poster delay | Queue wait dominates cold poster-ready latency and rises with visible work | Queue near zero while generation/transfer dominates | queue enqueued/start/finish timestamps | Supplementary |
| H12 | FFmpeg processing is limiting | FFmpeg duration/CPU dominates, queue worker occupied | Generation fast; network/browser dominates | child duration/CPU/read bytes plus output-ready time | Supplementary |
| H13 | Cache misses dominate repeat latency | Cold slow, warm fast with identical path and cache hit | Warm remains slow or cache hit absent | paired cold/warm, cache key/state | Supplementary |
| H14 | Disk reads dominate large-video Preview | Read MB/s/iowait and source read scale with TTFF/stalls | Disk headroom; client/network/decoder correlates instead | disk samples, source bytes read, range overfetch | Supplementary |
| H15 | Bottleneck changes by size | Small files overhead-bound; large files network/storage/crypto-bound with breakpoints | Same limiting stage and normalized rate across sizes; upload ~3.0 MB/s and download ~4.8–5.1 MB/s flat from 100 MB to 1 GB | full size ladder with stage/resource decomposition | NOT OBSERVED between 100 MB and 1 GB |

These hypotheses are not mutually exclusive.

### 14.1 Preliminary classification rule

After Round 1 (P1 and P2 S/M/L complete), report P1/P2 Files upload and download Mbps, peak server CPU, server iowait, and client CPU. Select exactly one preliminary classification:

~~~text
NETWORK_PATH_CANDIDATE
SERVER_STORAGE_CANDIDATE
CLIENT_CRYPTO_CANDIDATE
MEDIA_RANGE_PIPELINE_CANDIDATE
MULTIPLE_CANDIDATES
INSUFFICIENT_EVIDENCE
~~~

This output determines measurement priority only. `ROOT_CAUSE=NOT_PROVEN` remains mandatory until sufficient evidence supports a causal finding.

## 15. Root-cause decision framework

~~~mermaid
flowchart TD
  A[Validate fixture, path, source, config, repetition] --> B{Transfer started?}
  B -- No --> C[Classify configured/client/server/storage rejection; network NOT MEASURED]
  B -- Yes --> D{P1 LAN slow?}
  D -- Yes --> E{Client hash/crypto or CPU dominant?}
  E -- Yes --> EC[Client pipeline candidate: H4/H5]
  E -- No --> F{Disk/iowait/container saturated?}
  F -- Yes --> FS[Storage/server candidate: H3/H14]
  F -- No --> FA[Application framing/proxy candidate: H6/H7/H9]
  D -- No --> G{P2 slow only?}
  G -- Yes --> H{Twingate path candidate: H1; split Direct/Relayed}
  G -- No --> I{P4 slow only?}
  I -- Yes --> IC[Cloudflare/gateway candidate: H8/H9]
  I -- No --> J{Full download fast, Preview slow?}
  J -- Yes --> K{Cold only?}
  K -- Yes --> KM[Cache/queue/generation candidate: H11/H12/H13]
  K -- No --> KR[Range/decode/disk candidate: H10/H14]
  J -- No --> L[Check size-dependent multi-bottleneck H15]
~~~

Interpretation examples:

- LAN slow + Twingate slow + Cloudflare slow: inspect client, application,
  server, and storage before blaming overlay paths.
- LAN fast + Twingate slow: investigate Twingate/private WAN path.
- LAN fast + Cloudflare slow: investigate Gateway/cloudflared/Cloudflare path.
- Files fast + Vault slow: inspect client crypto and Vault chunk pipeline.
- Download fast + upload slow: inspect hash/encrypt/chunk/write/commit stages.
- First media load slow, repeat fast: cache/generation candidate.

The tree selects a candidate class, not a final claim.

## 16. Controlled optimization gate

No tuning begins until:

1. Baseline raw evidence and summaries are complete across both P1 and P2;
2. `PERFORMANCE_MUTATION_GATE=BLOCKED_PENDING_P1_PRE_FIX` is satisfied;
3. One hypothesis has differentiating evidence;
4. Proposed change preserves security, integrity, storage reserve, zero-knowledge,
   RBAC, fail-secure behavior, and accepted runtime architecture;
5. Rollback and acceptance metrics are written first;
6. Human Owner authorizes a separate implementation task.

Potential experiments such as chunk size, concurrency, worker count, cache
profile, proxy timeout, or network configuration are future tasks. They are not
recommendations in this study.

## 17. Report-ready table templates

| Table | Required columns |
|---|---|
| 1 System architecture/network paths | Path ID, client location/interface, overlay/edge, ingress, application hop, storage hop, measured/not measured |
| 2 Test environment | Timestamp, source SHA/image, client OS/browser, server/runtime, storage, limits, concurrent load |
| 3 Transfer fixtures | Class, filename, exact bytes, SHA-256, generator, cleanup |
| 4 Media fixtures | Class, container, codecs, resolution, fps, duration, bitrate, bytes, SHA-256 |
| 5 Upload throughput | Path, workload, size, run, chunk requests, chunk bytes, chunk span ms, MB/s, Mbps, result |
| 6 Download throughput | Path, workload, size, run, elapsed ms, MB/s, integrity |
| 7 LAN vs Twingate vs Cloudflare | Paired fixture/workload, path medians, min/max, delta, Direct/Relay, limitation |
| 8 Media TTFF/buffering | Path, fixture, cache state, poster/hover/TTFF/seek ms, stalls/count/ms, ranges |
| 9 Server resources | Run ID, CPU/memory, disk MB/s/IOPS/iowait, container stats, queue/FFmpeg/cache |
| 10 Hypothesis evaluation | Hypothesis, support, falsification, distinguishing evidence, verdict, confidence/limitation |
| 11 Before/after optimization | Controlled variable, baseline, candidate, delta, safety regressions, sample count |
| 12 Limitations/future work | Gap, why unproven, impact, next measurement, authorization/dependency |

No empty template row is a result. Report prose cites run IDs and evidence files.

## 18. Chart specifications

| Chart | X | Y | Series/facets | Required annotation |
|---|---|---|---|---|
| File size vs throughput | exact bytes, log-friendly | median MB/s | path and workload | min/max whiskers, n |
| Path vs throughput | P1–P2 | median MB/s | size/workload | NOT TESTED and CONFIG-LIMITED excluded, not zero |
| File size vs TTFF | exact bytes | median TTFF ms | codec/path/cache | codec/bitrate labels |
| Path vs TTFB | P1–P2 | median TTFB ms | workload/size | n and min/max |
| Server iowait vs throughput | iowait % | MB/s | workload/path | run IDs, no causal trendline without adequate n |
| Preview before/after | baseline/candidate | latency/stall metric | fixture/path | only after controlled optimization |

Charts are generated only from machine-readable evidence. Missing and
CONFIG-LIMITED values remain categorical gaps, never numeric zeroes.

## 19. Limitations and future continuation

- The PC server, storage device, client, Wi-Fi environment, ISP, Twingate route,
  and Cloudflare route limit generalizability.
- Human browser timing introduces observer variance; the in-page XHR tracer isolates
  chunk network time (`CHUNK_SPAN_MBPS`), while E2E time includes UI interaction.
- Browser caches, media derivative cache, and OS filesystem cache are different
  states and must be labelled.
- Real multi-GB media generation is expensive; fewer runs and NOT TESTED are
  acceptable when stated.
- Codec, bitrate, keyframe placement, and container index placement can dominate
  media behavior independently of file size.
- Public Share has no Range, so its full-download result cannot be generalized
  to interactive preview.
- Historical rates (such as PR #61) were collected under earlier application baselines;
  they remain longitudinal context, not baseline samples for current comparison.
- Sampled iostat observations showed low device utilization and await during 1 GB upload,
  but full-run continuous disk telemetry was not captured (`STORAGE_SATURATION=NOT_SUPPORTED_BY_SAMPLED_EVIDENCE`; storage is NOT proven false as a potential bottleneck).
- Root cause, safe tuning values, and before/after improvement remain NOT PROVEN.

## 20. Study truth at Remote Pre-Fix reconciliation

~~~text
TASK=LFT-PERF-1
STATUS=IN_PROGRESS / REMOTE PRE-FIX MEASUREMENTS COMPLETE / ONSITE PENDING
PRODUCTION_MUTATED=NO
PERFORMANCE_SETTINGS_CHANGED=NO
OPTIMIZATION_EXECUTED=NO
REMOTE_B0=COMPLETE
REMOTE_UPLOAD_100MB_N=3
REMOTE_UPLOAD_100MB_MEDIAN_MBPS=2.981
REMOTE_UPLOAD_300MB_N=3
REMOTE_UPLOAD_300MB_MEDIAN_MBPS=3.080
REMOTE_UPLOAD_1GB_N=3
REMOTE_UPLOAD_1GB_MEDIAN_MBPS=3.016
REMOTE_DOWNLOAD_100MB_N=3
REMOTE_DOWNLOAD_100MB_MEDIAN_MBPS=4.799
REMOTE_DOWNLOAD_300MB_N=3
REMOTE_DOWNLOAD_300MB_MEDIAN_MBPS=5.050
REMOTE_DOWNLOAD_1GB_N=3
REMOTE_DOWNLOAD_1GB_MEDIAN_MBPS=4.829
REMOTE_CONTROLLED_RUNS=18
REMOTE_PRE_FIX=COMPLETE
ONSITE_PRE_FIX=PENDING
ONSITE_PENDING_RUNS=18
POST_FIX=NOT_STARTED
PERFORMANCE_MUTATION_GATE=BLOCKED_PENDING_P1_PRE_FIX
ROOT_CAUSE=NOT_PROVEN
TWINGATE_SOLE_BOTTLENECK=NOT_PROVEN
CLOUDFLARE_BOTTLENECK=NOT_PROVEN
STORAGE_BOTTLENECK=NOT_PROVEN
CLIENT_CRYPTO_BOTTLENECK=NOT_PROVEN
FINAL_RECEIPT_CREATED=NO
NEXT_GATE=P1_ONSITE_DIRECT_LAN_PRE_FIX
~~~

## 21. Evidence source register

Canonical/history:

- Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-secure-share-post-closeout-followups.md
- Obsidian_AEGIS_Vault/AEGIS_Knowledge/concepts/Large_File_Transfer_V2.md
- Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-public-share-architecture.md
- Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md
- Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-09-02_032549_kla_idea1-lft-v2-e3-vault-video-preview.md (PR #61)
- Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-09-16_063734_kla_idea1-secure-share-post-closeout-followups.md
- Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-09-16_043452_kla_public-share-s5-12-final-closeout.md
- Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-09-18_013000_kla_idea1-files-upload-ux-refresh.md
- Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-09-25_190000_kla_idea1-private-vault-production-rollout.md
- Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-09-25_183500_kla_idea1-vault-stage-d-ux-media-reconciliation.md

Design/source:

- docs/superpowers/specs/2026-09-18-pr150-media-preview-pipeline-design.md
- docs/superpowers/plans/2026-09-18-pr150-media-preview-pipeline.md
- IDEA1-AEGIS_Drive_LC/docs/superpowers/plans/2026-09-19-pr150-media-preview-production-runbook.md
- IDEA1-AEGIS_Drive_LC/server/config/transferLimits.js
- IDEA1-AEGIS_Drive_LC/server/config/vaultTransferLimits.js
- IDEA1-AEGIS_Drive_LC/server/config/mediaLimits.js
- IDEA1-AEGIS_Drive_LC/src/lib/chunkedUpload.js
- IDEA1-AEGIS_Drive_LC/src/lib/vaultChunkedUpload.js
- IDEA1-AEGIS_Drive_LC/src/lib/vaultTreeUpload.js
- IDEA1-AEGIS_Drive_LC/src/lib/vaultVideoPreview.js
- IDEA1-AEGIS_Drive_LC/src/lib/mediaApi.js
- IDEA1-AEGIS_Drive_LC/src/lib/mediaScheduler.js
- IDEA1-AEGIS_Drive_LC/server/routes/media.js
- IDEA1-AEGIS_Drive_LC/server/media/

The recent Cloudflare 1033 recovery details are Human Owner evidence supplied
directly with this task. No repository receipt for that later incident was found
at the study base, so those facts remain explicitly owner-supplied rather than
silently presented as repository-measured evidence.
