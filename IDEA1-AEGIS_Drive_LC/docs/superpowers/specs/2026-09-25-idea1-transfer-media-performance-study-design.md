# AEGIS IDEA1 Transfer and Media Performance Study Design

Status: IN PROGRESS / DIAGNOSIS COMPLETE TO CURRENT GATE / NO_SAFE_APP_FIX_PROVEN
Task: LFT-PERF-1 / TRANSFER_AND_MEDIA_PREVIEW_PERFORMANCE_STUDY
Area / owner: IDEA1 / kla
Production mutation: NO
Performance settings changed: NO
Optimization executed: NO
Root cause: P1 SHARED PATH CAPACITY LIMITER PROVEN (U2/D1) / ROUTER 100MBPS CEILING STRONGLY SUPPORTED / APP DEFECT NOT PROVEN / REMOTE RESIDUAL OPEN

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

### 3.2 Supplementary Public Anywhere path (C1)

~~~text
External Internet client (Twingate OFF)
  -> Cloudflare edge
  -> Cloudflare Tunnel
  -> isolated Public Share connector (cloudflared)
  -> site outbound Internet
  -> Public Share Gateway
  -> AEGIS Drive
  -> Data Lake storage
~~~

Public Anywhere through Cloudflare is a separate supplementary architecture, download/redemption oriented, and does not provide an authenticated Files upload path. It is not a third primary core path. It represents a distinct study: **PUBLIC SHARE ANYWHERE DELIVERY PERFORMANCE** (download-only under current architecture).

**Why C1 was added:**
The Human Owner explicitly raised the concern that Public Share delivery may change if later optimization or maintenance work affects:
- Drive read path
- server outbound networking
- Public Share Gateway
- cloudflared connector
- Cloudflare Tunnel transport
- shared storage
- host networking
- application streaming

Therefore, a PRE-FIX baseline was required BEFORE any relevant change is planned or executed. This preserves the ability to answer:
1. *"What was Share Anywhere download performance before changes?"*
2. *"What exact component was changed?"*
3. *"Did Public Share performance improve, regress, or remain unchanged?"*
4. *"Was the change specific to Public Share, or did it affect shared server paths?"*

Public Share security architecture is out of scope. The study measures the accepted delivery path; it does not redesign ingress, trust, token, revocation, network isolation, or fail-closed controls.

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

- **C1 = PUBLIC_SHARE_CLOUDFLARE**: External Internet client with Twingate OFF, accessing Share Anywhere via Cloudflare edge -> Cloudflare Tunnel -> Public Share Gateway -> AEGIS Drive. Download-only under current architecture.
  - Test conditions: Human Owner physically remote, using the same remote Windows PC, same general Internet environment, and Brave browser as P2; Twingate explicitly turned OFF.
  - Controls: Exact S/M/L deterministic fixtures (100 MB, 300 MB, 1 GB), password-protected public redemption workflow, n=3 valid measurements per fixture.
  - Boundary note: While the client-side environment is substantially controlled relative to P2, network variables are not identical because Cloudflare and Twingate employ distinct transport and edge routing architectures.
- **C2 = OPTIONAL_EXTERNAL_FIELD_VALIDATION**: Real-world external recipients/networks accessing Public Share with Twingate OFF. Evaluates recipient-network variability. Not mixed into controlled C1 statistical summaries.
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

### 9.1 Current matrix execution status

| Path | Workload | 100 MB | 300 MB | 1 GB | 5 GB (Round 2) | 10 GB (Round 2) | Status |
|---|---|---|---|---|---|---|---|
| **P1 Onsite Direct LAN** (Core) | T1 Files upload | **COMPLETE** (5.056 MB/s) | **COMPLETE** (5.172 MB/s) | **COMPLETE** (5.151 MB/s) | Deferred | CONFIG-LIMITED | **9 runs COMPLETE** |
| **P1 Onsite Direct LAN** (Core) | T3 Files download | **COMPLETE** (6.744 MB/s) | **COMPLETE** (7.253 MB/s) | **COMPLETE** (7.026 MB/s) | Deferred | CONFIG-LIMITED | **9 runs COMPLETE** |
| **P2 Remote + Twingate** (Core) | T1 Files upload | **COMPLETE** (2.981 MB/s) | **COMPLETE** (3.080 MB/s) | **COMPLETE** (3.016 MB/s) | Deferred | CONFIG-LIMITED | **9 runs COMPLETE** |
| **P2 Remote + Twingate** (Core) | T3 Files download | **COMPLETE** (4.799 MB/s) | **COMPLETE** (5.050 MB/s) | **COMPLETE** (4.829 MB/s) | Deferred | CONFIG-LIMITED | **9 runs COMPLETE** |
| **C1 Public Share / Cloudflare** (Supp.) | T5 Public download | **COMPLETE** (13.546 MB/s) | **COMPLETE** (11.978 MB/s) | **COMPLETE** (11.666 MB/s) | N/A | N/A | **9 valid runs COMPLETE** |

Execution Summary:
- P1 Onsite Direct LAN PRE-FIX: **18/18 COMPLETE** (Upload S/M/L ×3, Download S/M/L ×3)
- P2 Remote + Twingate PRE-FIX: **18/18 COMPLETE** (Upload S/M/L ×3, Download S/M/L ×3)
- Core PRE-FIX overall: **36/36 COMPLETE** (target 36)
- Supplementary Public Share C1 PRE-FIX: **9/9 COMPLETE**
- Total current valid controlled runs: **45 runs** (18 P1 + 18 P2 + 9 C1)
- POST-FIX: **0/36 NOT STARTED**
- Core Mutation Gate Status: Pre-fix baselines captured across P1, P2, and C1 (`CORE_PERFORMANCE_MUTATION_GATE=PRE_FIX_BASELINES_CAPTURED`); performance mutations remain unauthorized pending isolating diagnosis (`PERFORMANCE_MUTATION_AUTHORIZED=NO`).

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

### 10.3 Public Share download measurement method (C1)

The Public Share link is password-protected. For each controlled run, the Human Owner executed the following validated workflow:
1. Open or refresh the Public Share redemption page in Brave browser (Twingate OFF).
2. Enter the Share password.
3. Prepare the PowerShell download observer script in an adjacent terminal.
4. Wait for the observer prompt: `READY - CLICK PUBLIC SHARE DOWNLOAD NOW`.
5. Trigger the Share Anywhere download button.
6. Brave immediately creates a temporary file: `Unconfirmed XXXXX.crdownload`.
7. PowerShell observer detects the file and starts a high-resolution Stopwatch.
8. Observer polls at 50 ms intervals until the temporary `.crdownload` file disappears.
9. Final promoted file is resolved in the download directory by matching exact expected byte size.
10. Timing stops and decimal MB/s is computed (`bytes / 1,000,000 / seconds`).

Under the hood, this exercises the complete AEGIS Public Share delivery stack:
~~~text
POST /s/:token -> password validation -> deliver() -> stream.pipe(res)
~~~

Delivery response headers:
- `Content-Length`: exact payload bytes
- `Content-Type: application/octet-stream`
- `Content-Disposition: attachment; filename="..."`
- `Cache-Control: no-store`

Because `Cache-Control: no-store` is enforced, each download is a fresh network and application delivery rather than a browser cache hit.

**Invalid C1 pilot run handling:**
One initial 100 MB test run produced:
~~~text
TRANSFER_STARTED=Unconfirmed 719237.crdownload
FILE=
FILE_BYTES=0
DOWNLOAD_MS=7727
DOWNLOAD_MBPS=0.000
~~~
The file transferred completely to disk, but the observer script failed to resolve the final filename before exiting.
- Classification: `C1_100MB_INITIAL_ATTEMPT=INVALID_MEASUREMENT`
- Reason: `HARNESS_FINAL_FILE_RESOLUTION_FAILED`
- Root cause: Test harness observer defect, NOT an AEGIS, Cloudflare, or Share Anywhere failure.
- Treatment: Excluded from the controlled n=3 sample set. Preserved in documentation for methodological transparency rather than silently deleted.

### 10.4 Metric definitions

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
Executed by Human Owner across P1 Onsite Direct LAN, P2 Remote + Twingate, and C1 Public Share / Cloudflare.

### 11.1 Files download results (P1 Onsite Direct LAN)

Tested on site over wired Ethernet / Management VLAN30 with Twingate OFF.
Fixtures: S-100MB (100,000,000 B), M-300MB (300,000,000 B), L-1GB (1,000,000,000 B).
Measured via PowerShell `.crdownload` observer.

| Fixture | Run | Elapsed (ms) | Download (MB/s) | Integrity Result |
|---|---|---:|---:|---|
| **100 MB** | r01 | 14,828 | 6.744 | Exact size match (`S-100MB.bin`) |
| 100 MB | r02 | 14,359 | 6.964 | Exact size match (`S-100MB (1).bin`) |
| 100 MB | r03 | 15,247 | 6.559 | Exact size match (`S-100MB (2).bin`) |
| **100 MB Summary** | **n=3** | **Min: 6.559** | **Median: 6.744** | **Max: 6.964 (Mean: 6.756)** |
| **300 MB** | r01 | 42,250 | 7.101 | Exact size match (`M-300MB.bin`) |
| 300 MB | r02 | 41,365 | 7.253 | Exact size match (`M-300MB (1).bin`) |
| 300 MB | r03 | 40,131 | 7.476 | Exact size match (`M-300MB (2).bin`) |
| **300 MB Summary** | **n=3** | **Min: 7.101** | **Median: 7.253** | **Max: 7.476 (Mean: 7.277)** |
| **1 GB** | r01 | 142,204 | 7.032 | Exact size match (`L-1GB.bin`) |
| 1 GB | r02 | 143,029 | 6.992 | Exact size match (`L-1GB (1).bin`) |
| 1 GB | r03 | 142,328 | 7.026 | Exact size match (`L-1GB (2).bin`) |
| **1 GB Summary** | **n=3** | **Min: 6.992** | **Median: 7.026** | **Max: 7.032 (Mean: 7.017)** |

Download Controlled Verdict:
- `P1_ONSITE_DIRECT_LAN_FILES_DOWNLOAD_PRE_FIX=COMPLETE` (9 runs).
- 100 MB median = 6.744 MB/s; 300 MB median = 7.253 MB/s; 1 GB median = 7.026 MB/s.
- `SUSTAINED_LAN_DOWNLOAD_THROUGHPUT≈6.7_TO_7.3_MBPS_BY_MEDIAN`.
- Rates are remarkably consistent and reproducible across sizes.

### 11.2 Files upload results (P1 Onsite Direct LAN)

Tested on site over wired Ethernet / Management VLAN30 with Twingate OFF.
Fixtures: S-100MB (100,000,000 B, 6 chunks), M-300MB (300,000,000 B, 18 chunks), L-1GB (1,000,000,000 B, 60 chunks).
Measured via browser console in-page XHR tracer (`window.__AEGIS_LFT_TRACE__`).

| Fixture | Run | Total Requests | Chunk Bytes | HTTP Status | Elapsed (ms) | Throughput (MB/s) |
|---|---|---:|---:|---|---:|---:|
| **100 MB** | r01 | 9 | 100,000,000 | all 200 | 19,778 | 5.056 |
| 100 MB | r02 | 9 | 100,000,000 | all 200 | 19,854 | 5.037 |
| 100 MB | r03 | 9 | 100,000,000 | all 200 | 19,427 | 5.147 |
| **100 MB Summary** | **n=3** | **Min: 5.037** | **Median: 5.056** | **Max: 5.147** | **Mean: 5.080** | **PASS** |
| **300 MB** | r01 | 21 | 300,000,000 | all 200 | 57,951 | 5.177 |
| 300 MB | r02 | 21 | 300,000,000 | all 200 | 58,113 | 5.162 |
| 300 MB | r03 | 21 | 300,000,000 | all 200 | 58,009 | 5.172 |
| **300 MB Summary** | **n=3** | **Min: 5.162** | **Median: 5.172** | **Max: 5.177** | **Mean: 5.170** | **PASS** |
| **1 GB** | r01 | 63 | 1,000,000,000 | all 200 | 193,956 | 5.156 |
| 1 GB | r02 | 63 | 1,000,000,000 | all 200 | 194,498 | 5.141 |
| 1 GB | r03 | 63 | 1,000,000,000 | all 200 | 194,150 | 5.151 |
| **1 GB Summary** | **n=3** | **Min: 5.141** | **Median: 5.151** | **Max: 5.156** | **Mean: 5.149** | **PASS** |

Upload Controlled Verdict:
- `P1_ONSITE_DIRECT_LAN_FILES_UPLOAD_PRE_FIX=COMPLETE` (9 runs).
- Verification audit: All three 1 GB upload runs verified as actual browser-console measured tracer runs (63 total HTTP requests: 60 chunk PUTs + 3 session lifecycle requests; exact millisecond spans; zero request failures).
- 100 MB median = 5.056 MB/s; 300 MB median = 5.172 MB/s; 1 GB median = 5.151 MB/s.
- `SUSTAINED_LAN_UPLOAD_THROUGHPUT≈5.06_TO_5.17_MBPS_BY_MEDIAN` (flat across all sizes).
- `FILE_SIZE_DEPENDENT_DEGRADATION=NOT_OBSERVED` within 100 MB to 1 GB.

### 11.3 P1 Onsite Direct LAN upload vs download asymmetry

Under the same Onsite Direct LAN wired Ethernet / Management VLAN30 environment:

| Size | Download Median (MB/s) | Upload Median (MB/s) | Ratio (Download / Upload) | Delta |
|---|---:|---:|---:|---|
| 100 MB | 6.744 | 5.056 | ~1.33x | Download ~33% faster |
| 300 MB | 7.253 | 5.172 | ~1.40x | Download ~40% faster |
| 1 GB | 7.026 | 5.151 | ~1.36x | Download ~36% faster |

Observation:
- Under Onsite Direct LAN conditions, Files download throughput was consistently 33–40% higher (~1.36x average) than Files upload throughput across all three fixtures.
- The asymmetry on LAN (~1.36x) is less pronounced than under P2 Remote Twingate (~1.6x), indicating that while both directions gain throughput on LAN, upload gains relatively more on LAN (~70% gain) than download does (~43% gain).

### 11.4 Files upload results (P2 Remote + Twingate)

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
- `P2_REMOTE_TWINGATE_FILES_UPLOAD_PRE_FIX=COMPLETE` (9 runs).
- 100 MB median = 2.981 MB/s; 300 MB median = 3.080 MB/s; 1 GB median = 3.016 MB/s.
- `SUSTAINED_UPLOAD_THROUGHPUT≈3.0 MB/s` across the tested range.
- `FILE_SIZE_DEPENDENT_DEGRADATION=NOT_OBSERVED` within 100 MB to 1 GB.
- `REPRODUCIBLE=YES`.

### 11.5 Files download results (P2 Remote + Twingate)

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
- `P2_REMOTE_TWINGATE_FILES_DOWNLOAD_PRE_FIX=COMPLETE` (9 runs).
- 100 MB median = 4.799 MB/s; 300 MB median = 5.050 MB/s; 1 GB median = 4.829 MB/s.
- `FILE_SIZE_DEPENDENT_DEGRADATION=NOT_OBSERVED` within 100 MB to 1 GB.

### 11.6 P2 Remote + Twingate upload vs download asymmetry

Under the same Remote + Twingate client environment:

| Size | Download Median (MB/s) | Upload Median (MB/s) | Ratio (Download / Upload) | Delta |
|---|---:|---:|---:|---|
| 100 MB | 4.799 | 2.981 | ~1.61x | Download ~61% faster |
| 300 MB | 5.050 | 3.080 | ~1.64x | Download ~64% faster |
| 1 GB | 4.829 | 3.016 | ~1.60x | Download ~60% faster |

Observation:
- Files download throughput was consistently roughly 60–64% higher (~1.6x) than Files upload throughput across all three tested fixtures.

### 11.7 Supporting server telemetry during 1 GB upload (r01)

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

### 11.8 Public Share download results (C1 Public Share / Cloudflare)

Fixtures: S-100MB (100,000,000 B), M-300MB (300,000,000 B), L-1GB (1,000,000,000 B).
Executed by Human Owner on the same remote Windows PC / Brave browser used for P2, with Twingate OFF.

| Fixture | Run | Elapsed (ms) | Download (MB/s) | Integrity Result |
|---|---|---:|---:|---|
| **100 MB** | r01 | 7,230 | 13.831 | Exact size match |
| 100 MB | r02 | 7,382 | 13.546 | Exact size match |
| 100 MB | r03 | 8,854 | 11.294 | Exact size match |
| **100 MB Summary** | **n=3** | **Min: 11.294** | **Median: 13.546** | **Max: 13.831 (Mean: ~12.890)** |
| **300 MB** | r01 | 25,231 | 11.890 | Exact size match |
| 300 MB | r02 | 25,046 | 11.978 | Exact size match |
| 300 MB | r03 | 24,346 | 12.322 | Exact size match |
| **300 MB Summary** | **n=3** | **Min: 11.890** | **Median: 11.978** | **Max: 12.322 (Mean: ~12.063)** |
| **1 GB** | r01 | 85,515 | 11.694 | Exact size match |
| 1 GB | r02 | 85,723 | 11.665 | Exact size match |
| 1 GB | r03 | 85,722 | 11.666 | Exact size match |
| **1 GB Summary** | **n=3** | **Min: 11.665** | **Median: 11.666** | **Max: 11.694 (Mean: ~11.675)** |

Public Share Controlled Verdict:
- `C1_PUBLIC_SHARE_PRE_FIX=COMPLETE` (9 valid runs).
- 100 MB median = 13.546 MB/s, 300 MB median = 11.978 MB/s, 1 GB median = 11.666 MB/s.
- `PUBLIC_SHARE_SUSTAINED_DELIVERY≈11.7_TO_13.5_MBPS_BY_MEDIAN` within the tested range.
- The 1 GB measurements are especially stable across repetitions (~11.67 MB/s).
- Discipline: Do NOT convert these measurements into an Internet-wide SLA.

### 11.9 Comprehensive three-path comparison (P1 Direct LAN vs P2 Remote Twingate vs C1 Public Share)

| Workload | Fixture | P1 Onsite LAN Median (MB/s) | P2 Remote Twingate Median (MB/s) | C1 Public Share Median (MB/s) | P1 vs P2 Ratio | C1 vs P1 Ratio | C1 vs P2 Ratio |
|---|---|---:|---:|---:|---:|---:|---:|
| **Download** | 100 MB | 6.744 | 4.799 | 13.546 | ~1.41x (P1 +41%) | ~2.01x (C1 +101%) | ~2.82x (C1 +182%) |
| **Download** | 300 MB | 7.253 | 5.050 | 11.978 | ~1.44x (P1 +44%) | ~1.65x (C1 +65%) | ~2.37x (C1 +137%) |
| **Download** | 1 GB | 7.026 | 4.829 | 11.666 | ~1.45x (P1 +45%) | ~1.66x (C1 +66%) | ~2.42x (C1 +142%) |
| **Upload** | 100 MB | 5.056 | 2.981 | N/A (download only) | ~1.70x (P1 +70%) | N/A | N/A |
| **Upload** | 300 MB | 5.172 | 3.080 | N/A (download only) | ~1.68x (P1 +68%) | N/A | N/A |
| **Upload** | 1 GB | 5.151 | 3.016 | N/A (download only) | ~1.71x (P1 +71%) | N/A | N/A |

#### Permitted observations and governance boundaries

1. **P1 vs P2 path delta**:
   - Direct-LAN P1 is materially faster than Remote/Twingate P2 for both Files upload (~1.7x, ~70% gain) and Files download (~1.4x–1.45x, ~43% gain).
   - Therefore, network path / Twingate overlay overhead is observable and measurable.
   - However, Direct LAN performance does **NOT** demonstrate that Twingate is the sole bottleneck. Even on direct wired Ethernet / Management VLAN30, upload is capped at ~5.15 MB/s and download at ~7.0–7.25 MB/s—far below Gigabit Ethernet line rate (~110–120 MB/s).
2. **C1 Public Share vs Authenticated P1/P2**:
   - C1 Cloudflare Public Share download (~11.7–13.5 MB/s) is substantially faster than both authenticated AEGIS Drive P1 direct LAN (~7.0–7.25 MB/s) and P2 remote (~4.8–5.05 MB/s).
   - The tested paths are not identical application paths:
     - Public Share: unauthenticated public link -> password validation -> single continuous streaming response (`POST /s/:token` -> `deliver()` -> `stream.pipe(res)`) via dedicated Public Share Gateway and Cloudflare edge.
     - Files download: authenticated user session with RBAC -> HUB reverse proxy -> Drive application -> disk read -> browser native stream.
     - Files upload: authenticated session -> client SHA-256 chunking -> sequential 16 MiB PUT requests -> server chunk write and verification -> session commit.
   - Therefore, C1 must not be used to claim a single network bottleneck by itself.
3. **Required governance truth statements**:
   ~~~text
   ROOT_CAUSE=NOT_PROVEN
   TWINGATE_SOLE_BOTTLENECK=NOT_PROVEN
   CLOUDFLARE_BOTTLENECK=NOT_PROVEN
   STORAGE_BOTTLENECK=NOT_PROVEN
   SWITCH_BOTTLENECK=NOT_PROVEN
   ROUTER_BOTTLENECK=NOT_PROVEN
   ~~~
   - Do NOT change MikroTik router, TP-Link switch, VLAN configuration, Twingate configuration, Cloudflare Tunnel settings, upload chunk size, or upload concurrency based solely on these baseline comparisons.

### 11.10 Separate defect discovered during P1: Production storage capacity / accounting discrepancy

During P1 on-site testing, a separate Production storage capacity and accounting issue was observed:
- Docker named storage volume: `aegis_drive_storage`
- Host volume mountpoint: `/var/lib/docker/volumes/aegis_drive_storage/_data`
- Observed volume data size: ~29 GB
- Host root filesystem (`/`): ~57 GB total, ~51 GB used, ~3.1 GB available (~95% disk utilization)
- External ~1 TB disk is separately mounted for backup (`/mnt/backup`) and is not the active Drive storage authority.
- Human Owner observed that deleting test files and emptying the Drive Trash did not visibly reduce Dashboard storage accounting usage.

**Strict governance rules for this defect**:
- Do NOT attempt to fix this issue within PR #216.
- Do NOT prune Docker system/volumes.
- Do NOT delete Vault ciphertext or orphan files.
- Do NOT modify storage mount configuration in this documentation task.
- Status: Recorded as a separate investigation and blocker requiring dedicated root-cause analysis (`STORAGE_ACCOUNTING_DEFECT_RECORDED=YES`).

### 11.11 C1 Public Share technical interpretation and prohibited overclaims
- Prohibited overclaims:
  - `CLOUDFLARE_IS_FASTER=PROVEN`
  - `TWINGATE_IS_THE_BOTTLENECK`
  - `CLOUDFLARE_HAS_NO_BOTTLENECK`
  - `DRIVE_READ_IS_NOT_THE_BOTTLENECK`
  - `SERVER_NETWORK_IS_NOT_THE_BOTTLENECK`
- Maintained status:
  - `CLOUDFLARE_BOTTLENECK=NOT_PROVEN`
  - `TWINGATE_SOLE_BOTTLENECK=NOT_PROVEN`
  - `ROOT_CAUSE=NOT_PROVEN`

Technical interpretation:
- C1 demonstrates that the same AEGIS host and storage stack can deliver a 1 GB file through the Public Share path at approximately 11.7 MB/s.
- The simplistic hypothesis *"AEGIS server can only send files at ~5 MB/s"* is NOT supported by current evidence.
- However, C1 and P2 differ across multiple architectural dimensions:
  1. Ingress and egress network paths;
  2. Access architecture (overlay vs edge tunnel);
  3. Gateway and proxy surfaces (HUB vs Public Share Gateway);
  4. Authentication and session handling (authenticated session vs password redemption token);
  5. Transport protocol characteristics;
  6. Application routing (`/drive/api/files/...` vs `/drive/api/public-share/...`);
  7. Twingate connector/relay vs cloudflared connector.
- Therefore, no single component has yet been isolated.

### 11.12 Replication and statistical summary

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
| H1 | Twingate path is limiting | P2 materially slower than paired P1 while client/server/storage remain below saturation | Paired P1/P2 similar or P1 equally slow; download over Twingate reaches ~5.0 MB/s while upload is ~3.0 MB/s | Paired P1 vs P2 comparison; Direct vs Relayed | **TWINGATE_SOLE_BOTTLENECK=NOT_PROVEN**; P1 is ~1.4x–1.7x faster than P2 showing measurable network path overhead, but LAN upload caps at ~5.15 MB/s and download at ~7.0–7.25 MB/s |
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
| H15 | Bottleneck changes by size | Small files overhead-bound; large files network/storage/crypto-bound with breakpoints | Same limiting stage and normalized rate across sizes; upload ~3.0 MB/s (P2) / ~5.15 MB/s (P1) and download ~4.8–5.1 MB/s (P2) / ~6.7–7.3 MB/s (P1) flat from 100 MB to 1 GB | full size ladder with stage/resource decomposition | NOT OBSERVED between 100 MB and 1 GB |
| H16 | Local switch hardware/port limits throughput | Switch port errors/drops/negotiation mismatch or buffer saturation correlate with LAN rate | Switch counters clear; gigabit full-duplex verified; rate remains low | Port counters, switch management, direct host-client run | **SWITCH_BOTTLENECK=NOT_PROVEN**; TP-Link switch port settings unverified as bottleneck |
| H17 | Router / VLAN configuration limits throughput | Inter-VLAN routing overhead, router CPU saturation, or queue limit throughput | Intra-VLAN or direct bridge equally capped; router CPU low | Router CPU/queues, direct host-to-client link test | **ROUTER_BOTTLENECK=NOT_PROVEN**; MikroTik router / VLAN30 unverified as bottleneck |

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

### 15.1 Future root-cause decision logic

When P1 Onsite Direct LAN measurements become available, the following decision rules guide candidate prioritization (these are decision rules, not current conclusions):
1. **If P1 LAN throughput >> P2 Remote throughput:**
   - The remote/private delivery path becomes a stronger candidate.
2. **If P1 Upload ≈ P2 Upload ≈ ~3.0 MB/s:**
   - The application/upload pipeline (chunking, framing, request gaps, write path) becomes a stronger candidate than network path differences.
3. **If P1 Download is high and C1 Download is high (~12–14 MB/s), but P2 Download is low (~5 MB/s):**
   - The P2 private remote path / Twingate-associated surfaces become stronger candidates.
   - *Discipline*: This still does NOT prove Twingate itself is the sole cause; proxy, ingress, MTU, or overlay interaction may contribute.
4. **If P1 and C1 are both unexpectedly low:**
   - The common server/storage/application delivery path receives higher priority.

The decision framework selects candidate classes for targeted investigation; it never constitutes a proven root cause on its own.

## 16. Controlled optimization gate and study structure

### 16.1 PRE / DIAGNOSIS / CHANGE / POST / DELTA structure

Every performance surface evaluated in this study follows a strict five-stage lifecycle:

1. **A. PRE-FIX Baseline**:
   - Record environment, exact fixtures, network path, measurement method, repetition count (n), individual runs, min, median, max, mean, supporting telemetry, limitations, and initial hypotheses.
2. **B. DIAGNOSIS**:
   - Record observed symptom, candidate bottlenecks, evidence for each, evidence against each, read-only diagnostic results, and root-cause confidence.
   - Rule: `ROOT_CAUSE=NOT_PROVEN` remains mandatory until isolating evidence directly supports it.
3. **C. CHANGE / OPTIMIZATION (when authorized)**:
   - Record exact component changed, exact file/config/runtime surface, before value, after value, reason for change, hypothesis being tested, and whether the change affects P1, P2, C1, or shared surfaces.
4. **D. POST-FIX Verification**:
   - Repeat the exact SAME controlled workload (identical fixtures, sizes, repetitions) whenever applicable.
   - No size or repetition changes without documenting technical justification.
5. **E. DELTA Analysis**:
   - For each fixture, record:
     - Absolute change: `POST_MBPS - PRE_MBPS`
     - Percentage improvement: `((POST - PRE) / PRE) * 100`
     - Speedup ratio: `POST / PRE`
     - Regressions: any degradation must be explicitly declared; never report only "faster".

### 16.2 Change-impact classification

Future optimization proposals must be classified into one of two impact classes:

- **CASE A: PUBLIC-SHARE-ONLY CHANGE**:
  - Surfaces: cloudflared connector configuration, Public Share Gateway-only routing/logic, Cloudflare Tunnel-specific behavior.
  - Requirement: Only if diagnosis demonstrates bottleneck isolation to this path.
  - Lifecycle impact: If authorized by Human Owner, C1 may be re-run POST-FIX without invalidating an untouched P1 baseline, provided the change truly does not touch shared server surfaces.
- **CASE B: SHARED SERVER / APPLICATION CHANGE**:
  - Surfaces: Drive application, file read/streaming implementation, storage subsystem, server NIC, host networking, Docker-wide resource allocations, shared reverse proxy, OS TCP tuning, filesystem parameters, common server resource limits.
  - Lifecycle impact: If a proposed change touches any shared surface, **DO NOT APPLY IT** before P1 PRE-FIX baseline is complete. Applying Case B changes before P1 PRE-FIX would permanently invalidate the pre-fix state of the P1 baseline.

### 16.3 Explicit mutation gates

The study operates under three explicit gates:

~~~text
CORE_PERFORMANCE_MUTATION_GATE = PRE_FIX_BASELINES_CAPTURED
PERFORMANCE_MUTATION_AUTHORIZED = NO
PUBLIC_SHARE_SPECIFIC_MUTATION_GATE = PRE_FIX_BASELINE_CAPTURED
PUBLIC_SHARE_MUTATION_AUTHORIZED = NO
SHARED_MUTATION = BLOCKED_PENDING_DIAGNOSIS
~~~

- `CORE_PERFORMANCE_MUTATION_GATE`: Transitions from `BLOCKED_PENDING_P1_PRE_FIX` to `PRE_FIX_BASELINES_CAPTURED` now that P1 Onsite Direct LAN PRE-FIX is complete (18/18 runs) alongside P2 Remote Twingate (18/18 runs) and supplementary C1 Cloudflare (9 runs), totaling 45 valid controlled runs.
- `PERFORMANCE_MUTATION_AUTHORIZED`: Strictly remains `NO`. Capturing the baseline satisfies the gate prerequisite but does NOT authorize code or system modifications.
- `PUBLIC_SHARE_SPECIFIC_MUTATION_GATE`: Retains `PRE_FIX_BASELINE_CAPTURED` with `PUBLIC_SHARE_MUTATION_AUTHORIZED=NO`.
- `SHARED_MUTATION`: Retains `BLOCKED_PENDING_DIAGNOSIS`. No shared server, proxy, chunking, concurrency, or router/switch configuration may be modified without isolating root-cause evidence and separate human authorization.

## 17. Report-ready table templates and final report structure

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

### 17.1 C1 Public Share future POST-FIX table template

When any authorized Public-Share-affecting change is evaluated, record results using this template:

| Fixture | PRE median MB/s | POST median MB/s | Delta MB/s | Improvement % | Speedup | Verdict |
|---|---:|---:|---:|---:|---:|---|
| 100 MB | 13.546 | PENDING | PENDING | PENDING | PENDING | PENDING |
| 300 MB | 11.978 | PENDING | PENDING | PENDING | PENDING | PENDING |
| 1 GB | 11.666 | PENDING | PENDING | PENDING | PENDING | PENDING |

Do not fabricate POST values. POST fields remain PENDING until actual measurement.

### 17.2 Final report structure

The final performance report will be organized into seven standard sections:

- **A. Authenticated File Transfer Performance**:
  - P1: Onsite Direct LAN (Upload & Download, PRE vs POST)
  - P2: Remote + Twingate (Upload & Download, PRE vs POST)
- **B. Public Share Anywhere Delivery Performance**:
  - C1: Public Share / Cloudflare (Download only: 100 MB, 300 MB, 1 GB, PRE vs POST where relevant)
- **C. Real-world Public Recipient Validation**:
  - C2: Optional external recipient/network field observations
- **D. Media Preview Performance**:
  - Separate supplementary study covering covers, posters, hover streams, and interactive playback
- **E. Root-Cause Analysis**:
  - Diagnostic evidence, candidate bottlenecks, eliminated/unsupported candidates, proven cause if established
- **F. Optimization**:
  - Exact component changed, rationale, expected effect, affected paths, rollback
- **G. PRE vs POST Results**:
  - Absolute delta, percent improvement, speedup ratio, regressions, limitations

## 18. Chart specifications

| Chart | X | Y | Series/facets | Required annotation |
|---|---|---|---|---|
| File size vs throughput | exact bytes, log-friendly | median MB/s | path and workload | min/max whiskers, n |
| Path vs throughput | P1–P2, C1 | median MB/s | size/workload | NOT TESTED and CONFIG-LIMITED excluded, not zero |
| File size vs TTFF | exact bytes | median TTFF ms | codec/path/cache | codec/bitrate labels |
| Path vs TTFB | P1–P2, C1 | median TTFB ms | workload/size | n and min/max |
| Server iowait vs throughput | iowait % | MB/s | workload/path | run IDs, no causal trendline without adequate n |
| Preview before/after | baseline/candidate | latency/stall metric | fixture/path | only after controlled optimization |

Charts are generated only from machine-readable evidence. Missing and
CONFIG-LIMITED values remain categorical gaps, never numeric zeroes.

## 19. Optional future C2 field validation

- **Classification**: `OPTIONAL / FIELD VALIDATION / NOT CONTROLLED CORE MATRIX`
- **Identifier**: `C2 = OPTIONAL_EXTERNAL_FIELD_VALIDATION`
- **Purpose**: Verify Share Anywhere delivery behavior from independent real-world external networks and client devices.
- **Future design**:
  - 1–2 external recipients/networks
  - Twingate OFF
  - Representative 300 MB fixture
  - n=3 per recipient/network
  - Optional 1 GB sustained delivery confirmation
- **Telemetry recorded**:
  - Approximate network type (e.g. residential fiber, cellular 5G)
  - Client OS/browser type
  - File size and exact byte length
  - Duration in milliseconds
  - Calculated decimal MB/s
  - Observed limitations or interruptions
- **Boundary rule**: Do NOT mix C2 samples into the controlled C1 median or mean. C2 evaluates recipient-network variability across public Internet routes, whereas C1 evaluates controlled Cloudflare delivery isolation on the reference client machine.
- **Current status**: `C2_FIELD_VALIDATION=PLANNED_OPTIONAL / NOT_EXECUTED`.

## 20. Limitations and future continuation

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

## 21. Study truth at P1 Onsite Direct LAN Pre-Fix reconciliation

~~~text
TASK=LFT-PERF-1
STATUS=IN_PROGRESS / PRE-FIX BASELINES COMPLETE (P1, P2, C1) / DIAGNOSIS PENDING
PRODUCTION_MUTATED=NO
PERFORMANCE_SETTINGS_CHANGED=NO
NETWORK_CONFIGURATION_CHANGED=NO
TRANSFER_CONFIGURATION_CHANGED=NO
OPTIMIZATION_EXECUTED=NO
REMOTE_B0=COMPLETE
P1_ONSITE_DIRECT_LAN_PRE_FIX=COMPLETE
P1_CONTROLLED_RUNS=18
P1_UPLOAD_100MB_N=3
P1_UPLOAD_100MB_MEDIAN_MBPS=5.056
P1_UPLOAD_100MB_MEAN_MBPS=5.080
P1_UPLOAD_300MB_N=3
P1_UPLOAD_300MB_MEDIAN_MBPS=5.172
P1_UPLOAD_300MB_MEAN_MBPS=5.170
P1_UPLOAD_1GB_N=3
P1_UPLOAD_1GB_MEDIAN_MBPS=5.151
P1_UPLOAD_1GB_MEAN_MBPS=5.149
P1_DOWNLOAD_100MB_N=3
P1_DOWNLOAD_100MB_MEDIAN_MBPS=6.744
P1_DOWNLOAD_100MB_MEAN_MBPS=6.756
P1_DOWNLOAD_300MB_N=3
P1_DOWNLOAD_300MB_MEDIAN_MBPS=7.253
P1_DOWNLOAD_300MB_MEAN_MBPS=7.277
P1_DOWNLOAD_1GB_N=3
P1_DOWNLOAD_1GB_MEDIAN_MBPS=7.026
P1_DOWNLOAD_1GB_MEAN_MBPS=7.017
P2_REMOTE_TWINGATE_PRE_FIX=COMPLETE
P2_CONTROLLED_RUNS=18
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
C1_PUBLIC_SHARE_PRE_FIX=COMPLETE
C1_CONTROLLED_VALID_RUNS=9
C1_100MB_N=3
C1_100MB_MEDIAN_MBPS=13.546
C1_100MB_MEAN_MBPS=12.890
C1_300MB_N=3
C1_300MB_MEDIAN_MBPS=11.978
C1_300MB_MEAN_MBPS=12.063
C1_1GB_N=3
C1_1GB_MEDIAN_MBPS=11.666
C1_1GB_MEAN_MBPS=11.675
CORE_PRE_FIX_RUNS_COMPLETE=36
CORE_PRE_FIX_RUNS_TARGET=36
SUPPLEMENTARY_PUBLIC_RUNS_COMPLETE=9
TOTAL_CURRENT_VALID_CONTROLLED_RUNS=45
POST_FIX=NOT_STARTED
OPTIMIZATION=NOT_STARTED
CORE_PERFORMANCE_MUTATION_GATE=PRE_FIX_BASELINES_CAPTURED
PERFORMANCE_MUTATION_AUTHORIZED=NO
PUBLIC_SHARE_BASELINE_CAPTURED=YES
PUBLIC_SHARE_MUTATION_AUTHORIZED=NO
SHARED_MUTATION=BLOCKED_PENDING_DIAGNOSIS
STORAGE_ACCOUNTING_DEFECT_RECORDED=YES
ROOT_CAUSE=NOT_PROVEN
TWINGATE_SOLE_BOTTLENECK=NOT_PROVEN
CLOUDFLARE_BOTTLENECK=NOT_PROVEN
STORAGE_BOTTLENECK=NOT_PROVEN
SWITCH_BOTTLENECK=NOT_PROVEN
ROUTER_BOTTLENECK=NOT_PROVEN
CLIENT_CRYPTO_BOTTLENECK=NOT_PROVEN
FINAL_RECEIPT_CREATED=NO
NEXT_GATE=DIAGNOSIS_AND_STORAGE_INVESTIGATION
~~~

## 22. Evidence source register

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

## 23. Task 1 root-cause diagnosis gate (2026-09-29)

Scope: Task 1 of `docs/superpowers/plans/2026-09-29-idea1-transfer-throughput-optimization-implementation.md`.
Source inspected at PR216 commit `28069f7fbb9934198561a7ba5a165ebe239eb4ee`, the Task 0 normal merge of `origin/main` `21b52d5ecd5ca41a0a3c3429d93405b38dbe81b8`.
This section adds diagnosis only. It does not rewrite any PRE-FIX run, label, or value in sections 7–11. No application source changed.

### 23.1 Normal Files upload path, traced from current source

| Stage | Current source | Fact |
|---|---|---|
| Incremental hash | `src/lib/chunkedUpload.js` `incrementalSha256` | `hash-wasm` SHA-256 over `HASH_SLICE_BYTES = 4 MiB` slices. Runs to completion **before** the session POST. |
| Session create | `chunkedUpload.js` `createSession` → `server/routes/uploads.js` `POST /` | One POST with the claimed SHA-256. Server checks logical limit and capacity (`statfs`), creates the staged part file, inserts the session row, writes an audit row, returns `chunkSize` (server-owned). |
| Chunk scheduling | `chunkedUpload.js:227` `for (const index of [...upload.missing])` | **Serial awaited loop. Exactly one chunk PUT in flight per file.** The next PUT starts only after the previous PUT's response is parsed. |
| Per-chunk request | `chunkedUpload.js` `sendChunk` → `src/lib/api.js` `apiUpload` (XHR) | `file.slice(start, end)` Blob body, `application/octet-stream`, CSRF header, 10 min timeout. |
| Retry/backoff | `chunkedUpload.js` `CHUNK_ATTEMPTS = 3`, `retryDelayMs = 500 * 2 ** (attempt - 1)` | Retries only on network, 5xx, or 408. Backoff is 500 ms, then 1000 ms. |
| Edge | `HUB-AEGIS_Entry/nginx.conf` chunk location | TLS with `http2 on`. `proxy_request_buffering off`, `client_max_body_size 64m`, 120 s send/read timeouts. Upstream `drive-proxy:8001` is the Drive container's network alias (`docker-compose.yml`), not a separate proxy tier. |
| Server write | `uploads.js` `PUT /:uploadId/chunks/:index` → `server/storage/uploadStaging.js` `writeStagedChunk` | Streams `req` through a counting and SHA-256 Transform into `fs.createWriteStream(part, { flags: 'r+', start: index * chunkSize })`. The write is positional, and a different index writes a disjoint byte range. |
| DB acknowledgement | `server/db/store.js` `recordUploadChunk`, then `listUploadChunks` | Chunk upsert `ON CONFLICT (upload_id, chunk_index)` plus a session `updated_at` update, then the whole chunk list is re-read to build `sessionView` for the response. |
| Commit | `uploads.js` `POST /:uploadId/commit` | Checks that every chunk is present and correctly sized, claims the session in SQL, compares `stagedPartSize`, streams a full-file SHA-256 (`stagedPartSha256`), and compares it with the claimed hash. |
| Publish | `publishStagedPartTo` + `store.finishUploadCommit` | Atomic rename, then files row and session close in one transaction. Derivatives are scheduled after the response. |

Current configuration defaults (`server/config/transferLimits.js`): chunk `16 MiB` (range 8–64 MiB), logical limit `5 GiB`, supported ceiling `32 GiB`, session TTL 24 h, commit lease 15 min. `GET /api/files/uploads/limits` returns chunk size, logical limits, TTL, and capacity. It returns no concurrency value because Normal Files has none.

Multi-file behavior (`src/components/UploadDrawer.jsx` `enqueue`): each selected file starts `processFile` without awaiting the others. **Several files in one selection therefore already upload concurrently, one chunk in flight each.** The one-in-flight restriction applies per file, not per page.

1 GB fixture on the current architecture: `ceil(1,000,000,000 / 16,777,216) = 60` PUTs (59 × 16,777,216 B + 1 × 10,144,256 B). This matches the historical audit fact of **63 total requests (60 chunk PUTs + 3 session lifecycle requests)**. That fact is preserved unchanged.

### 23.2 Upload timing budget from existing evidence

The accepted PRE-FIX metric `CHUNK_SPAN` runs from the first PUT `send()` to the last PUT `loadend` (measurement plan §6.1 tracer). It therefore contains only PUT durations plus the gaps between PUTs.

| Component | Value from existing evidence | Basis |
|---|---|---|
| HASH_TIME | NOT_MEASURED. **Excluded from the accepted rate by construction** | Hashing finishes before the session POST, which precedes the first PUT. |
| SESSION_CREATE_TIME | NOT_MEASURED. Excluded by construction | POST, not traced, and before the first PUT. |
| CHUNK_PAYLOAD_TRANSFER_TIME | NOT_SEPARATED | The tracer recorded only `send`→`loadend` per PUT and the reports kept only the aggregate span. |
| SERVER_WRITE_TIME | NOT_SEPARATED (inside each PUT duration) | Same. |
| DB_ACK_TIME | NOT_SEPARATED (inside each PUT duration) | Same. |
| CHUNK_IDLE_GAP_TIME | NOT_RECORDED. Source-bounded to JavaScript scheduling only: no timer or network call sits between one PUT's `loadend` and the next `send()` on the success path | `chunkedUpload.js:232-251` |
| RETRY_BACKOFF_TIME | **0 ms in every accepted run** | Every run recorded exactly the expected chunk count of PUTs, all HTTP 200, with zero failures, so no retry fired. |
| COMMIT_VERIFY_TIME | NOT_MEASURED. Excluded by construction | Commit is a POST after the last PUT. |

Mean wall time per PUT, including any gap (span ÷ 60, 1 GB runs):

| Path | r01 | r02 | r03 |
|---|---:|---:|---:|
| P1 Direct LAN | 3,232.6 ms | 3,241.6 ms | 3,235.8 ms |
| P2 Remote/Twingate | 5,498.1 ms | 5,542.9 ms | 5,526.6 ms |

Interpretation limits:

- The accepted upload ceilings (P1 ≈ 5.06–5.17 MB/s, P2 ≈ 2.98–3.08 MB/s) lie **entirely inside the serial PUT phase**. Client hashing, session creation, commit verification, and retry backoff did not contribute to those numbers.
- The serial loop is a structural fact. Whether it limits throughput is **not** proven. A fixed per-chunk overhead (response RTT, server tail, DB ack) would need to be about 50% of each 3.2 s LAN PUT (about 1.6 s) for two lanes to double LAN throughput. Existing evidence cannot confirm or exclude that.
- A per-stream transport limit would also make a second in-flight chunk useful. Candidates include HTTP/2 per-stream flow control at the HUB edge with `proxy_request_buffering off`, and single-stream window/RTT over Twingate. A shared path-capacity limit (network, Twingate, or aggregate HUB/Drive/storage) would not. Existing evidence does not separate these two classes.
- Server CPU ~6.97%, RAM ~1.32%, and low iostat were sampled during the P2 1 GB upload (§11.7). A server CPU or storage saturation limiter is **not supported**, although only one run was sampled.
- Historical parallel-transfer experiments, including the Vault 1–4 lane policy, are context only and are not current proof.

### 23.3 Authenticated Files download path, traced from current source

| Stage | Current source | Fact |
|---|---|---|
| Authorization + metadata | `server/routes/api.js` `GET /files/:id/download` | `requireAuth`, then `store.findFile`. Owner mismatch returns 404. `keyExists` is checked, then an audit row is written (awaited). These costs are paid **before the first byte (TTFB only)**. |
| Storage read + response | `api.js` → `server/storage/fileStore.js` `openReadStream` | `fs.createReadStream(abs)` with the default 64 KiB highWaterMark, `.pipe(res)`, `Content-Length` set, no Range support. |
| drive-proxy | `docker-compose.yml` | Network alias of the Drive container. No extra proxy hop. |
| HUB NGINX | `HUB-AEGIS_Entry/nginx.conf` `location ~* ^/drive/api/files/[^/]+/download/?$` | **`proxy_buffering off` is present in reconciled source** and pinned by `HUB-AEGIS_Entry/tests/driveTransferEdge.test.mjs` ("large streaming download routes disable only upstream response buffering"). The client side is TLS with `http2 on`. |
| Client | native `<a download>` stream | Measured by the `.crdownload` observer, which starts after the response headers, so it measures sustained body throughput. |

Structural comparison with Public Share, with no trust semantics carried over: `server/routes/share.js` also serves bytes through `openReadStream(share.filePath)` and `.pipe(res)`, the same Drive storage-read and Node-pipe primitive. C1 delivered **11.7–13.5 MB/s** through Cloudflare, the tunnel, the Public Share gateway, and Drive. P1 authenticated LAN delivered 6.7–7.3 MB/s. So the Drive storage read plus Node pipe primitive **is not by itself** the ~7 MB/s ceiling for a single sequential download. The residual sits in the parts that differ: HUB NGINX with TLS, HTTP/2, and the unbuffered proxy loop, the client network path (inter-VLAN LAN or Twingate), or route startup cost. Route startup cost affects TTFB only and cannot cause a sustained 1 GB body ceiling. No accepted evidence isolates which one.

TTFB versus sustained body: the accepted download method measures body time only. The accepted method never recorded TTFB, so its share is NOT_MEASURED. The awaited route work (find, keyExists, audit) is TTFB-only by construction.

### 23.4 Classification

| Candidate limiter | Upload | Download |
|---|---|---|
| Client hash/crypto | **Excluded from the accepted rate by construction** (§23.2) | N/A for Normal Files (no client crypto) |
| Request serialization / one in flight | NOT_PROVEN (structural fact: serial loop) | N/A (single streaming response) |
| Per-stream transport (HTTP/2 stream, window/RTT) | NOT_PROVEN | NOT_PROVEN |
| Server CPU/event loop | Not supported by sampled evidence | NOT_MEASURED |
| Storage I/O | Not supported by sampled evidence | Drive read primitive alone excluded as the sole ~7 MB/s ceiling (C1) |
| DB acknowledgement | NOT_SEPARATED | TTFB-only |
| NGINX/HUB | NOT_PROVEN | NOT_PROVEN (candidate) |
| Twingate/network path | Contributes (P1 ≈ 1.7× P2). Not the sole limiter (LAN is also far below wire rate) | Contributes (P1 ≈ 1.4× P2). Not the sole limiter |

~~~text
UPLOAD_ROOT_CAUSE_CLASSIFICATION=NOT_PROVEN
DOWNLOAD_ROOT_CAUSE_CLASSIFICATION=NOT_PROVEN
UPLOAD_CLIENT_HASH_IN_ACCEPTED_RATE=EXCLUDED_BY_CONSTRUCTION
UPLOAD_RETRY_BACKOFF_IN_ACCEPTED_RUNS=0
UPLOAD_SERIAL_ONE_IN_FLIGHT_PER_FILE=STRUCTURAL_FACT
UPLOAD_SERIALIZATION_AS_LIMITER=NOT_PROVEN
DOWNLOAD_PROXY_BUFFERING_OFF_PRESENT=YES
DOWNLOAD_DRIVE_READ_PRIMITIVE_SOLE_CEILING=EXCLUDED_BY_C1_STRUCTURAL_COMPARISON
TASK2_NORMAL_FILES_CONCURRENCY=BLOCKED_PENDING_HUMAN_PROBE
~~~

### 23.5 Gate decision

Existing evidence is insufficient to prove or experimentally isolate that more than one in-flight Normal Files chunk is a useful application-side lever. Per plan Task 1 Step 5, one minimal Human-run probe per path is prepared in the measurement plan, §20. Task 2 does not start until the upload probe result meets its decision rule. The download result can only inform a later, separately authorized Task 5. It never authorizes Task 2.

## 24. U1 Remote/Twingate upload probe result and Human Owner ruling (2026-09-29)

The Human Owner executed probe U1 exactly as specified in measurement plan §20.1 (commit `32100cb02496c89166e42ff612b3b17cd3ed8976`). Path: P2 Remote/Twingate. Fixtures: three 300,000,000 B files with unique names. This section records the results as supplied by the Human Owner. Sections 7–11 and 23 are unchanged.

### 24.1 Authoritative U1 results

| Run | Files | PUTs per file | aggregateMBps | Per-file MBps | medBodyMs | medTailMs | sumGapMs | HTTP |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| U1-A-single | 1 | 18 | **2.998** | 2.998 | ≈5586 | ≈1 | ≈0 | all 200 |
| U1-B-dual | 2 | 18 | **3.472** | 1.736 / 1.736 | ≈9540 / ≈9534 | ≈1 / ≈4 | ≈0 | all 200 |

~~~text
U1_R=1.1581054            # 3.472 / 2.998
U1_VALID=YES              # no non-200 PUT, no retry observed
~~~

### 24.2 Interpretation (evidence only)

- **R falls in the `1.15 < R < 1.50` band**, so under the approved U1 rule `UPLOAD_ROOT_CAUSE_CLASSIFICATION=NOT_PROVEN` is unchanged.
- **Per-request idle overhead is measured negligible on P2.** `medTailMs` ≈ 1–4 ms and `sumGapMs` ≈ 0. The response arrives almost immediately after the body is sent, and the client starts the next PUT without delay. The per-chunk cost is almost entirely body-send time (≈5.6 s for 16,777,216 B ≈ 3.0 MB/s). A fixed per-request RTT, server write tail, or DB-ack overhead does **not** explain the P2 upload rate.
- **The second lane mostly shares, not adds, capacity.** Per-lane body time rose from ≈5.6 s to ≈9.5 s per chunk (≈1.76 MB/s per lane). Aggregate gain was ≈15.8%. On P2 the upload is dominated by a capacity that both streams share. Candidates are the Remote/Twingate/Internet path or a common HUB/Drive/storage path. U1 alone cannot separate those two.
- A one-chunk-in-flight change would therefore buy at most ≈16% on P2 while halving per-file speed when users upload two files. That does not justify a platform default of concurrency 2.

### 24.3 Human Owner ruling

~~~text
UPLOAD_ROOT_CAUSE_CLASSIFICATION=NOT_PROVEN
HUMAN_OWNER_RULING=DO_NOT_ENTER_TASK2_YET
TASK2_ENTERED=NO
UPLOAD_CONCURRENCY_CHANGED=NO
RUNTIME_SOURCE_CHANGED=NO
NEXT_DIAGNOSIS=U2_DIRECT_LAN_SINGLE_VS_DUAL + D1_DIRECT_LAN_DOWNLOAD (measurement plan §21)
~~~

Reason recorded by the Human Owner: dual-stream aggregate gain is only ~15.8%, while each file falls from ~2.998 MB/s to ~1.736 MB/s.

### 24.4 What U2 decides

U2 repeats U1 unchanged on P1 Direct LAN, which removes Twingate and the Internet path. The two hypotheses:

- **A — Remote/Twingate/shared Internet path ceiling.** LAN should then show meaningful multi-stream headroom.
- **B — Common HUB/Drive/server/storage/application aggregate ceiling.** Present on both paths, so LAN should show little multi-stream gain. The PRE-FIX P1 single-stream ≈5.15 MB/s is itself far below wire rate.

D1 (§20.2) is retained and is required independently, because upload and download root causes must not be conflated.

## 25. U2 Direct LAN upload, D1 Direct LAN download, and hardware root-cause diagnosis (2026-09-29)

The Human Owner executed probes U2 and D1 on P1 Direct LAN (wired Ethernet, Management VLAN30, Twingate OFF) as specified in measurement plan §21. This section records the authoritative results, physical client/network telemetry, router capabilities, application diagnosis, and resulting gate decisions. Historical PRE-FIX values in sections 7–11 and 23–24 remain immutable.

### 25.1 U2 Direct LAN upload probe results

Executed using the validated in-page XHR tracer (`window.__AEGIS_LFT_PROBE__`) on P1 Direct LAN with three 300,000,000 B binary fixtures:

| Run | Files | PUTs per file | Aggregate Bytes | Union Span (ms) | Aggregate MB/s | Per-file MB/s | medBodyMs | medTailMs | sumGapMs | HTTP Status |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| **U2-A single** | 1 | 18 | 300,000,000 | 28,059 | **10.692** | 10.692 | 1,561 | 4 | -17 | all 200 |
| **U2-B dual** | 2 | 18 | 600,000,000 | 59,418 | **10.098** | 5.050 / 5.052 | 3,278 / 3,302 | 7 / 5 | -23 / -23 | all 200 |

~~~text
U2_R = 10.098 / 10.692 = 0.944
U2_VALID = YES (all HTTP 200, zero retries, exact chunk counts)
~~~

**U2 Decision Rule Evaluation:**
- Approved rule: `R <= 1.15 => PROVEN_SHARED_PATH_CAPACITY_LIMITER on P1`.
- Here `U2_R = 0.944` (< 1.0), meaning two concurrent upload streams produce slightly *lower* aggregate throughput than a single stream, while cutting per-file throughput roughly in half (~10.7 MB/s -> ~5.05 MB/s).
- Per-chunk body time doubled from ~1.56 s (single) to ~3.30 s (dual).
- `medTailMs` (4–7 ms) and `sumGapMs` (negative/negligible) prove per-request client/server idle gap is not a limiter on LAN.
- Consequence: **Normal Files upload concurrency does not add capacity on P1.** Task 2 upload concurrency remains blocked and not justified (`TASK2_UPLOAD_CONCURRENCY=SKIPPED_NOT_JUSTIFIED`).

### 25.2 D1 Direct LAN authenticated download probe results

Executed on P1 Direct LAN (Twingate OFF) against an existing root-level 300,000,000 B file via authenticated browser stream reader:

| Stream | Status | Bytes | TTFB (ms) | Body (ms) | Body MB/s |
|---|---:|---:|---:|---:|---:|
| **D1-A single** | 200 | 300,000,000 | 21 | 26,991 | **11.115** |
| **D1-B lane 1** | 200 | 300,000,000 | 25 | 31,627 | 9.486 |
| **D1-B lane 2** | 200 | 300,000,000 | 31 | 54,357 | 5.519 |
| **D1-B aggregate** | 200 | 600,000,000 | — | union | **11.032** |

~~~text
D1_R = 11.032 / 11.115 = 0.993
ttfbShareA = 21 / (21 + 26991) = 0.000778 ≈ 0.0008
~~~

**D1 Decision Rule Evaluation:**
- Approved rule 1: `ttfbShareA < 0.05 => Startup cost (auth, metadata, audit) excluded as sustained throughput limiter`. TTFB accounts for less than 0.1% of total elapsed download time.
- Approved rule 2: `R <= 1.15 => PROVEN_SHARED_PATH_CAPACITY_LIMITER on P1`.
- Here `D1_R = 0.993` (~1.0). Two simultaneous downloads divide the available ~11 MB/s pipe without increasing aggregate throughput.
- Consequence: The download limiter on P1 is a shared path capacity constraint, not an application per-stream buffering or serialization defect.

### 25.3 Physical client and network environment

Physical client hardware collected during on-site diagnostic session:

- **OS / Host:** Windows 11 client machine.
- **Physical Ethernet Adapter:**
  - InterfaceDescription: `Realtek PCIe GbE Family Controller`
  - Status: `Up`
  - LinkSpeed: `1 Gbps`
- **Virtual Adapters (Disregarded):**
  - WSL / Hyper-V virtual adapter reports `10 Gbps`.
  - Discipline: The WSL adapter is virtual host-internal networking and MUST NOT be used as physical network evidence. Physical wire speed is established by the Realtek GbE NIC (`1 Gbps`).
- **Client IP Configuration on VLAN 30:**
  - IPv4: `192.168.30.10`
  - Subnet Mask: `255.255.255.0` (`/24`)
  - Gateway: `192.168.30.1`
  - Twingate: `DISCONNECTED`
  - Direct transport reachability: `192.168.30.10 -> 192.168.10.10:443` = `TcpTestSucceeded=True`.

### 25.4 MikroTik router finding and live hardware verification (reconciled with PR #259)

Repository canonical network architecture and hardware notes (`VLAN-IP-Plan.md`, `Hardware-Inventory.md`, `MikroTik-Config.md`) record the deployed router and inter-VLAN path:

```text
VLAN 30 client (192.168.30.10)
  -> TP-Link TL-SG105E Port 5 (Access VLAN30, PVID 30) — 1000MF (1 Gbps)
  -> TP-Link Port 1 (802.1Q Trunk) — 100MF (100 Mbps)
  -> MikroTik ether2 (Trunk) — 100 Mbps Full Duplex
  -> MikroTik CPU inter-VLAN routing (VLAN30 -> VLAN10)
  -> same 802.1Q Trunk (MikroTik ether2 -> TP-Link Port 1) — 100 Mbps Full Duplex
  -> TP-Link Port 2 (Access VLAN10) — 1000MF (1 Gbps)
  -> Beelink AEGIS Host (192.168.10.10:443) — enp1s0 1 Gbps Full
```

**Live Verified Hardware Telemetry (PR #259 Onsite Evidence):**
- **MikroTik Router Identity:** Verified live via `/system routerboard print` and `/system resource print`:
  - `board-name=hEX lite`, `model=RB750r2`, `revision=r3`, `RouterOS=7.18.2 stable`.
  - Status: `RB750R2_IDENTITY=PROVEN_LIVE`.
- **MikroTik ether2 Interface:** Verified live via `/interface ethernet monitor ether2 once`:
  - `rate=100Mbps`, `full-duplex=yes`, `status=link-ok`.
  - Status: `RB750R2_ETHER2_LINK=100MBPS_FULL_DUPLEX`.
- **TP-Link TL-SG105E Switch:** Verified live on switch web management (`192.168.30.2`, hw 5.0):
  - Port 1 (Router Trunk) = `100MF` (`TP_LINK_PORT1_TRUNK=100MF`).
  - Port 2 (Beelink Host) = `1000MF` (`1 Gbps`).
  - Port 5 (Admin Client) = `1000MF` (`1 Gbps`).
- **Beelink Host Link:** Verified live via `ethtool enp1s0` and `/sys/class/net/enp1s0/speed`:
  - `Speed: 1000Mb/s`, `Duplex: Full`, `Link detected: yes`.
  - Status: `BEELINK_LINK=1_GBPS_FULL`.
- **Client Physical Link:** Verified live via `Get-NetAdapter`:
  - `Realtek PCIe GbE Family Controller`, `LinkSpeed: 1 Gbps` (`ADMIN_CLIENT_LINK=1_GBPS`).

**Physical Throughput Implications:**
- 100BASE-TX Fast Ethernet theoretical maximum payload throughput is approximately 94.9 Mbit/s (~11.87 MB/s).
- Both U2 upload single-stream (10.692 MB/s ≈ 85.5 Mbps) and D1 download single-stream (11.115 MB/s ≈ 88.9 Mbps), as well as dual-stream aggregate saturation (10.098 MB/s and 11.032 MB/s), align precisely within 90–95% of a 100 Mbit/s Ethernet ceiling when accounting for IP/TCP/TLS/HTTP framing overhead.
- On the router-on-a-stick topology where ingress and egress share the same physical 100 Mbps trunk port (`ether2`), inter-VLAN forwarding traverses the 100 Mbps interface twice.
- The 100 Mbps inter-VLAN trunk is the active physical throughput limiter for all traffic crossing between VLAN 30 and VLAN 10 on P1 Direct LAN.

**Truth Boundary:**
~~~text
RB750R2_IDENTITY = PROVEN_LIVE
RB750R2_ETHER2_LINK = 100MBPS_FULL_DUPLEX
TP_LINK_PORT1_TRUNK = 100MF
BEELINK_LINK = 1_GBPS_FULL
ADMIN_CLIENT_LINK = 1_GBPS
P1_ROUTER_TRUNK_100MBPS_CEILING = PROVEN_LIVE
CURRENT_LAN_THROUGHPUT_LIMITER = PROVEN_HARDWARE_PATH_LIMIT
P1_SHARED_PATH_CAPACITY_LIMITER = PROVEN_BY_U2_D1_AND_LIVE_NETWORK_TELEMETRY
CURRENT_PRODUCTION_ARCHITECTURE = RB750r2_PLUS_TL-SG105E
HARDWARE_REPLACEMENT_AUTHORIZED = NO
PROCUREMENT_AUTHORIZED = NO
PRODUCTION_CUTOVER_AUTHORIZED = NO
REPLACEMENT_WORK_STATE = DEFERRED_OPTIONAL_FUTURE_WORK
~~~

*Infrastructure Scope Boundary (Reconciled with PR #259)*:
Production hardware remains MikroTik hEX lite RB750r2 and TP-Link TL-SG105E. Hardware replacement, procurement, router model selection, and production cable cutover are NOT authorized (`HARDWARE_REPLACEMENT_AUTHORIZED=NO`, `PROCUREMENT_AUTHORIZED=NO`). PR #259 documents the capacity boundary and preserves an optional remediation design as deferred future reference only. Hardware replacement is NOT required in the current project scope.

### 25.5 End-to-end application code diagnosis

Source code review at PR216 head (`docs/idea1-transfer-media-performance-study`):

1. **Download Path:**
   - Authenticated download (`server/routes/api.js` `GET /files/:id/download`) streams directly from disk via `fs.createReadStream(abs)`.
   - Node stream backpressure (`stream.pipe(res)`) operates normally.
   - Zero whole-file application buffering in memory.
   - HUB NGINX reverse proxy (`HUB-AEGIS_Entry/nginx.conf`) already has `proxy_buffering off` pinned by tests.
   - Zero application download compression limiter or transform bottlenecks.
   - No `limit_rate`, `limit_req`, or `limit_conn` configured on the download route.
   - No artificial timer delay or speed throttling exists in application code.
   - Login/security rate limits are route-isolated and do not affect streaming data transfer.
   - Maintenance middleware does not gate authenticated download streaming.
   - With `D1_R = 0.993`, concurrency cannot overcome the shared path capacity.
2. **Upload Path:**
   - Normal Files upload (`src/lib/chunkedUpload.js`) uses 16 MiB chunks.
   - With `U2_R = 0.944`, chunk concurrency does not improve aggregate throughput on P1 and degrades per-file completion.
3. **Application Verdict:**
~~~text
APPLICATION_DEFECT_PROVEN = NO
TASK2_UPLOAD_CONCURRENCY_ENTERED = NO
UPLOAD_OPTIMIZATION = NO_SAFE_APP_FIX_PROVEN_AT_CURRENT_GATE
DOWNLOAD_OPTIMIZATION = NO_SAFE_APP_FIX_PROVEN
~~~
No runtime application code will be fabricated merely to satisfy an implementation milestone.

### 25.6 Remote path status and R1 diagnostic scope

Preserve historical U1 results on P2 Remote Twingate:
- Single upload: 2.998 MB/s
- Dual upload aggregate: 3.472 MB/s (1.736 MB/s per file)
- `U1_R = 1.1581054`
- Remote throughput remains materially below P1 Direct LAN (~3.0 MB/s vs ~10.7 MB/s).

Classification:
~~~text
REMOTE_RESIDUAL_LIMITER = OPEN
~~~
*Discipline*: Do NOT claim that replacing or upgrading the on-site router will automatically increase Remote Twingate speeds to >=10 MB/s. Remote performance involves WAN ISP upload/download bandwidth, latency, MTU/MSS fragmentation, and Twingate client/connector relay vs P2P modes.

**Prepared Remote Diagnostic (R1 Packet):**
A diagnostic packet is prepared for execution from the remote home environment (measurement plan §22):
1. Measure baseline ISP bandwidth with Twingate OFF (speed test).
2. Record Twingate connection state (Direct peer-to-peer vs Relayed).
3. Execute the standard D1 download probe methodology over P2 Remote with Twingate ON.
Status: `R1_REMOTE_DIAGNOSTIC=PREPARED / NOT_EXECUTED`.

### 25.7 Historical evidence preservation boundary

DO NOT rewrite or invalidate historical PRE-FIX baseline results in §11:
- Earlier P1 PRE-FIX baseline (executed 2026-09-25):
  - Files upload median: ~5.06–5.17 MB/s
  - Files download median: ~6.7–7.3 MB/s
- Current on-site diagnostic session (executed 2026-09-29):
  - U2-A upload single: ~10.692 MB/s
  - D1-A download single: ~11.115 MB/s

*Methodological Rule*: The U2/D1 diagnostic session was conducted under different client hardware and session conditions than the earlier P1 baseline. Both sets of measurements represent truthful observations of their respective environments. Variations demonstrate that path/client conditions vary over time; they do NOT authorize retroactively altering or deleting the accepted 36-run PRE-FIX matrix.

### 25.8 Cross-reference to infrastructure PR #257

During on-site testing on VLAN 30 (`192.168.30.10`), direct Layer 3 TCP reachability to `192.168.10.10:443` was verified (`TcpTestSucceeded=True`), but central LAN DNS resolution for `aegis.internal` failed (`Resolve-DnsName aegis.internal` returned `DNS name does not exist`). A manual `hosts` file entry (`192.168.10.10 aegis.internal`) was required on the test client to perform HTTPS tests.

This network architecture gap is formally specified and tracked in:
- **PR #257:** `docs(infrastructure): define VLAN30 direct-LAN DNS access contract` (`docs/superpowers/specs/2026-09-29-aegis-vlan30-direct-lan-dns-design.md`).
- **Scope Boundary:** PR #216 owns performance measurement and bottleneck diagnosis. PR #257 owns the infrastructure DNS/DHCP contract. PR #216 does NOT implement router DNS changes or absorb PR #257 scope.

### 25.9 Synthesis and gate status

~~~text
TASK = LFT-PERF-1
STATUS = DIAGNOSIS_COMPLETE_TO_CURRENT_GATE / NO_SAFE_APP_FIX_PROVEN
P1_SHARED_PATH_CAPACITY_LIMITER = PROVEN_BY_U2_D1_AND_LIVE_NETWORK_TELEMETRY
P1_ROUTER_TRUNK_100MBPS_CEILING = PROVEN_LIVE
CURRENT_LAN_THROUGHPUT_LIMITER = PROVEN_HARDWARE_PATH_LIMIT
RB750R2_IDENTITY = PROVEN_LIVE
RB750R2_ETHER2_LINK = 100MBPS_FULL_DUPLEX
TP_LINK_PORT1_TRUNK = 100MF
BEELINK_LINK = 1_GBPS_FULL
ADMIN_CLIENT_LINK = 1_GBPS
APPLICATION_UPLOAD_DEFECT = NOT_PROVEN
APPLICATION_DOWNLOAD_DEFECT = NOT_PROVEN
SAFE_APP_LAYER_FIX = NONE_PROVEN
TASK2_UPLOAD_CONCURRENCY = SKIPPED_NOT_JUSTIFIED
UPLOAD_OPTIMIZATION = NO_SAFE_APP_FIX_PROVEN_AT_CURRENT_GATE
DOWNLOAD_OPTIMIZATION = NO_SAFE_APP_FIX_PROVEN
TASK5_STATUS = DIAGNOSIS_COMPLETE_TO_CURRENT_GATE / NO_SAFE_APP_FIX_PROVEN
TASK6_STATUS = BLOCKED / NOT_APPLICABLE_AT_CURRENT_GATE (no runtime candidate)
TASK7_STATUS = BLOCKED / NOT_APPLICABLE_AT_CURRENT_GATE (no post-fix run executed)
HARDWARE_REPLACEMENT_AUTHORIZED = NO
PROCUREMENT_AUTHORIZED = NO
PRODUCTION_CUTOVER_AUTHORIZED = NO
CURRENT_PRODUCTION_ARCHITECTURE = RB750r2_PLUS_TL-SG105E
REPLACEMENT_WORK_STATE = DEFERRED_OPTIONAL_FUTURE_WORK
REMOTE_RESIDUAL_LIMITER = OPEN
POST_FIX = NOT_STARTED
NEW_THROUGHPUT_TEST_EXECUTED = NO
PR257_CROSS_REFERENCE = ADDED
PR259_INFRASTRUCTURE_TRUTH = RECONCILED (head f8ee2f27)
~~~
