# AEGIS IDEA1 Transfer and Media Performance Study Design

Status: PLANNED / DRAFT — measurement design only
Task: LFT-PERF-1 / TRANSFER_AND_MEDIA_PREVIEW_PERFORMANCE_STUDY
Area / owner: IDEA1 / kla
Production mutation: NO
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

1. How do LAN, local Wi-Fi through Twingate, remote Internet through Twingate,
   and Cloudflare Public Anywhere paths differ when the same source object and
   workload are used?
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

Source defaults are ARCHITECTURE FACTS, not current Production values. Current
Production values must be re-measured in Human-run Phase B0.

## 3. Architecture and measurement boundaries

### 3.1 Private paths

~~~text
Client browser
  -> local network or Internet
  -> optional Twingate private-access overlay
  -> private LAN / NAT boundary
  -> HUB / Drive application
  -> PostgreSQL metadata + Data Lake storage
~~~

Twingate is the private remote-access overlay/path. It is not the NAT server.
The AEGIS host is a PC-based, self-hosted private server behind a private
LAN/NAT environment.

### 3.2 Public Anywhere path

~~~text
External Internet client (Twingate OFF)
  -> Cloudflare edge
  -> Cloudflare Tunnel
  -> isolated Public Share connector
  -> Public Share Gateway
  -> AEGIS Drive
  -> Data Lake storage
~~~

Public Share security architecture is out of scope. The study measures the
accepted path; it does not redesign ingress, trust, token, revocation, network
isolation, or fail-closed controls.

### 3.3 Current application transfer facts

Current source at study base 87a1b6a252c5d862f3da9176c710151095579c0a:

| Surface | Current source fact | Production truth |
|---|---|---|
| Normal Files upload | Default 16 MiB chunks; default 5 GiB logical limit; configurable source ceiling 32 GiB; incremental SHA-256 in 4 MiB slices; resumable session/chunk map | RE-MEASURE REQUIRED |
| Vault V2 upload | Default 32 MiB plaintext chunks; recommended concurrency 2, bounded 1–4; default 5 GiB logical limit; source ceiling 32 GiB; per-chunk client AES-GCM | RE-MEASURE REQUIRED |
| Normal Files full download | Disk-backed streaming; full-download path and current response framing must be observed | RE-MEASURE REQUIRED |
| Files explicit Preview | Owner-only preview supports byte Range where current route permits | RE-MEASURE REQUIRED |
| Vault V2 video Preview | Service Worker maps browser Range requests to minimum encrypted chunks and client decryption | RE-MEASURE REQUIRED |
| Public Share | Streams full response; current architecture explicitly has no Range/resume, so interruption restarts from byte zero | RE-MEASURE REQUIRED |
| Files media derivatives | Server poster/motion pipeline; bounded in-process queue; default one worker; Sharp for eligible stills and FFmpeg for other poster/motion work; content-addressed rebuildable cache | RE-MEASURE REQUIRED |
| Vault media cards | Client-side, zero-knowledge image/GIF/video extraction and range/decryption behavior; no server derivative cache | RE-MEASURE REQUIRED |

Current source defaults:

- MEDIA_WORKERS=1; queue maximum 500.
- Media cache default 2 GiB, low-water 0.8, free reserve 512 MiB.
- Poster box 640x360; motion box 480x270; motion 12 fps, maximum 6 s.
- Probe/poster/motion timeouts: 20 s / 60 s / 120 s.
- Poster and motion outputs capped at 512 KiB and 4 MiB.
- Client Files tile scheduler caps: info 1, poster 6, motion 3.

These are source/configuration facts only. Phase B0 captures the running values.

## 4. Historical evidence inventory

| Area | Prior PR / evidence | What was tested | Result | What it proves | What it does NOT prove |
|---|---|---|---|---|---|
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
| B | Current Production baseline measurement | PLANNED / HUMAN-RUN |
| C | Network path comparison | PLANNED / HUMAN-RUN |
| D | Upload, download, HTTP Range, and media measurement | PLANNED |
| E | Client/server resource measurement | PLANNED |
| F | Root-cause classification | DESIGNED / NOT EXECUTED |
| G | Controlled one-variable optimization experiments | DESIGNED / NOT AUTHORIZED |
| H | Recommended settings, limitations, future work | DESIGNED / EVIDENCE REQUIRED |

Parts F–H cannot claim an outcome until B–E provide adequate evidence.

## 6. Fixture size ladder and capacity classification

Decimal units are mandatory for fixtures:

| Class | Label | Exact bytes |
|---|---|---:|
| S | 100 MB | 100,000,000 |
| M | 300 MB | 300,000,000 |
| L | 1 GB | 1,000,000,000 |
| XL | 5 GB | 5,000,000,000 |
| XXL | 10 GB | 10,000,000,000 |

Each result has test_mode=ACTUAL_TRANSFER_TEST or
test_mode=CONFIGURED_LIMIT_TEST. Decimal GB must not be confused with binary
GiB. The historical 5 GiB default equals 5,368,709,120 bytes.

10 GB policy:

1. Read the running limit first.
2. Do not change a limit for the benchmark.
3. If client or server rejects before transfer, record:

~~~text
TEST_SIZE=10_GB
TRANSFER_STARTED=NO
RESULT=EXPECTED_CONFIG_LIMIT
NETWORK_PERFORMANCE=NOT_MEASURED
~~~

4. Record rejection layer: CLIENT_CONFIG, HTTP_APPLICATION,
   SERVER_CONFIG, STORAGE_CAPACITY, NETWORK_TIMEOUT, or INTEGRITY.
5. Apply the same boundary discipline to 5 GB.

Generic fixtures are deterministic local byte streams. Each manifest records
exact bytes, SHA-256, generator version/command, filename, creation host,
filesystem allocation, and cleanup disposition.

Media fixtures additionally record container, video/audio codec, resolution,
fps, duration, average bitrate, exact bytes, SHA-256, encoder build, and whether
the file is a real encoded fixture or a structural/sparse fixture. Sparse
fixtures are architecture tests only and never throughput evidence.

## 7. Network path definitions

| ID | Path | Required proof |
|---|---|---|
| P1 | Closest practical LAN client-to-server path, no Twingate or Cloudflare | Interface, route, server identity, Twingate OFF |
| P2 | Local Wi-Fi plus Twingate private access | Wi-Fi link/signal, Twingate ON, direct/relayed if observable |
| P3 | Remote Internet plus Twingate | Outside LAN proof, WAN type, Twingate ON, direct/relayed if observable |
| P4 | External Public Anywhere through Cloudflare | Twingate OFF, public hostname, Cloudflare path, disposable public share |

If a path cannot be physically produced, its result is NOT TESTED. Simulated
latency or a local proxy is not equivalent.

## 8. Workloads

| ID | Workload | Principal measurements |
|---|---|---|
| T1 | Normal Files upload | hash time, upload time, commit time, rate, retries, integrity |
| T2 | Private Vault encrypted upload | key/encrypt time, chunk rate/concurrency, commit, resume, integrity boundary |
| T3 | Authenticated Files full download | TTFB, bytes, rate, integrity |
| T4 | Vault full download/Preview | decrypt time, Range/chunk mapping, TTFF, seek, integrity |
| T5 | Public Anywhere full download | Cloudflare TTFB/rate, integrity, interruption behavior |
| T6 | HTTP Range transfer | status, requested/returned range, TTFB, seek latency, 206/416 |
| T7 | Image thumbnail/cover | cold/warm ready latency, bytes, cache/source behavior |
| T8 | GIF preview | poster ready, hover start, bytes, stalls |
| T9 | Video poster | cold/warm poster ready, queue/generation/read bytes |
| T10 | Video hover/motion preview | startup, derivative/client work, stalls |
| T11 | Interactive Preview playback | TTFF, seek, range count, stalls, total stalled time |

## 9. Master Path x Workload x Size matrix

Legend: P=PLANNED; NA=NOT APPLICABLE by product contract. A planned cell becomes
CONFIG-LIMITED when the running limit blocks it, or NOT TESTED when the required
physical path/fixture cannot be produced. No cell is a result yet.

| Path | Workload | 100 MB | 300 MB | 1 GB | 5 GB | 10 GB |
|---|---|---|---|---|---|---|
| P1 | T1 Files upload | P | P | P | P | P |
| P1 | T2 Vault upload | P | P | P | P | P |
| P1 | T3 Files download | P | P | P | P | P |
| P1 | T4 Vault download/Preview | P | P | P | P | P |
| P1 | T5 Public download | NA | NA | NA | NA | NA |
| P1 | T6 HTTP Range | P | P | P | P | P |
| P1 | T7 image cover | P | P | P | P | P |
| P1 | T8 GIF preview | P | P | P | P | P |
| P1 | T9 video poster | P | P | P | P | P |
| P1 | T10 hover preview | P | P | P | P | P |
| P1 | T11 interactive playback | P | P | P | P | P |
| P2 | T1 Files upload | P | P | P | P | P |
| P2 | T2 Vault upload | P | P | P | P | P |
| P2 | T3 Files download | P | P | P | P | P |
| P2 | T4 Vault download/Preview | P | P | P | P | P |
| P2 | T5 Public download | NA | NA | NA | NA | NA |
| P2 | T6 HTTP Range | P | P | P | P | P |
| P2 | T7 image cover | P | P | P | P | P |
| P2 | T8 GIF preview | P | P | P | P | P |
| P2 | T9 video poster | P | P | P | P | P |
| P2 | T10 hover preview | P | P | P | P | P |
| P2 | T11 interactive playback | P | P | P | P | P |
| P3 | T1 Files upload | P | P | P | P | P |
| P3 | T2 Vault upload | P | P | P | P | P |
| P3 | T3 Files download | P | P | P | P | P |
| P3 | T4 Vault download/Preview | P | P | P | P | P |
| P3 | T5 Public download | NA | NA | NA | NA | NA |
| P3 | T6 HTTP Range | P | P | P | P | P |
| P3 | T7 image cover | P | P | P | P | P |
| P3 | T8 GIF preview | P | P | P | P | P |
| P3 | T9 video poster | P | P | P | P | P |
| P3 | T10 hover preview | P | P | P | P | P |
| P3 | T11 interactive playback | P | P | P | P | P |
| P4 | T1 Files upload | NA | NA | NA | NA | NA |
| P4 | T2 Vault upload | NA | NA | NA | NA | NA |
| P4 | T3 Files download | NA | NA | NA | NA | NA |
| P4 | T4 Vault download/Preview | NA | NA | NA | NA | NA |
| P4 | T5 Public download | P | P | P | P | P |
| P4 | T6 HTTP Range | NA | NA | NA | NA | NA |
| P4 | T7 image cover | NA | NA | NA | NA | NA |
| P4 | T8 GIF preview | NA | NA | NA | NA | NA |
| P4 | T9 video poster | NA | NA | NA | NA | NA |
| P4 | T10 hover preview | NA | NA | NA | NA | NA |
| P4 | T11 interactive playback | NA | NA | NA | NA | NA |

P4 T6 is NA because the accepted Public Share contract currently has no Range.
If future source changes that contract, it requires a separate reviewed task and
new baseline; this study does not smuggle Range into Public Share.

### 9.1 Time-bounded execution priority

The complete matrix above remains the authoritative study contract. Execution is
prioritized without deleting any row:

- Round 1 uses S/M/L (100 MB, 300 MB, 1 GB), paths P1/P2/P4, and workloads
  T1/T2/T3/T4/T5/T6/T9/T10/T11 where applicable. Its purpose is rapid
  bottleneck localization.
- P3 is included only when a genuine remote Twingate client/path exists. A local
  simulation is not valid P3 evidence.
- Round 2 uses 5 GB and 10 GB only after measured Production limits,
  storage/time safety, Round 1 justification, and a permitting 10 GB
  configuration probe.
- Every 5 GB and 10 GB row remains reportable as measured, CONFIG-LIMITED, or
  NOT TESTED. A time-, safety-, or configuration-based skip is not a failed
  performance result.

## 10. Metrics and calculations

### 10.1 Transfer metrics

- exact bytes requested, sent, received, and integrity-verified;
- wall-clock elapsed milliseconds;
- effective MB/s = bytes / 1,000,000 / elapsed seconds;
- effective Mbps = bytes x 8 / 1,000,000 / elapsed seconds;
- browser-reported and server-observed rates, labelled by observer;
- HTTP status, retry count, resumed byte offset/chunk set, outcome;
- source and received SHA-256 for non-Vault payloads;
- Vault server ciphertext-integrity result and client plaintext-integrity result,
  kept distinct.

### 10.2 HTTP/media metrics

- TTFB from request start to response start;
- TTFF from explicit open/play intent to first rendered frame;
- poster-ready and thumbnail-ready latency;
- hover intent to first moving frame;
- seek intent to first post-seek frame;
- HTTP 206/416 status, requested range, returned range, bytes returned;
- Range request count and overfetch ratio;
- stall count, total stalled milliseconds, longest stall, playback duration;
- cold-cache and warm-cache result;
- derivative queue wait, generation time, source bytes read, output bytes.

### 10.3 Client resources

- total/client browser CPU where practical;
- browser working set/private memory;
- hash duration and hash MB/s;
- Vault encryption/decryption duration and crypto MB/s;
- device power mode and browser version;
- long tasks and main-thread blocking where browser tooling exposes them.

### 10.4 Server resources

- host CPU, memory, load average;
- disk read/write MB/s, IOPS, latency, utilization, and iowait;
- Drive/Gateway/connector container CPU and memory;
- Drive restart/OOM state;
- media queue depth/running count and cache state;
- FFmpeg child duration, exit class, and observed process metrics;
- cache hit/miss classification where safely observable.

### 10.5 Network context

- RTT and packet loss from safe bounded probes;
- client interface, negotiated link rate, Wi-Fi RSSI where available;
- Twingate Direct/Relayed/Unknown;
- Cloudflare path classification;
- no synthetic speed-test result substitutes for application workload evidence.

## 11. Replication and statistical summary

- Warm-up: one preliminary run where warm-up cannot mutate authoritative data or
  is explicitly a disposable application action.
- 100 MB and 300 MB: minimum three measured repetitions.
- 1 GB: minimum three when time/capacity permits; otherwise record shortfall.
- 5 GB and 10 GB: one or more; state sample count and practical limitation.
- Alternate path order where practical to reduce time-of-day bias.
- Record every run. Never discard an outlier without preserving it and stating
  the exclusion rule before looking at the result.
- Summaries: sample count, median, min, max, and optional arithmetic mean.
- Report both cold and warm media/cache states; never mix them in one median.
- A CONFIGURED_LIMIT_TEST has no throughput statistic.

## 12. Control variables

Each run records:

- timestamp and timezone;
- client identifier, OS, browser/version, device power mode;
- interface, Ethernet/Wi-Fi, link rate/RSSI, local/remote;
- Twingate ON/OFF and Direct/Relayed/Unknown;
- path class P1–P4;
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

| ID | Hypothesis | Supporting evidence | Falsifying evidence | Distinguishing measurement |
|---|---|---|---|---|
| H1 | Twingate path is limiting | P2/P3 materially slower than paired P1 while client/server/storage remain below saturation | Paired P1/P2/P3 similar or P1 equally slow | Same fixture/workload/client, path only; Direct vs Relayed |
| H2 | Wi-Fi is limiting | P2 slower than Ethernet P1 with poor RSSI/link and no server saturation | Wi-Fi and Ethernet equal; P3 alone slow | Ethernet/Wi-Fi pair plus link/RSSI/RTT |
| H3 | Server storage I/O is limiting | Throughput tracks disk utilization/latency/iowait; LAN also slow | Disk has headroom while throughput remains low | iostat/pidstat/container samples aligned to run |
| H4 | Browser hashing is limiting | Checking/hash stage dominates; client CPU saturated; network idle | Hash small relative to total; client CPU/headroom | Separate hash_ms/hash_mbps from upload_ms |
| H5 | Vault client crypto is limiting | T2/T4 slower than same-path T1/T3; client crypto CPU/time dominates | Vault and Files equal after byte/framing adjustment | Same source/path with client crypto timings |
| H6 | Upload chunk size limits throughput | High request-gap/overhead per byte; controlled chunk-only experiment improves rate without new saturation | Rate unchanged or worsens | Future one-variable chunk experiment after authorization |
| H7 | Low upload concurrency limits throughput | One stream under-fills path; bounded increase improves rate and resource use stays safe | No gain or CPU/memory/edge pressure rises | Future one-variable concurrency experiment |
| H8 | Cloudflare Public path limits throughput | P4 slower than comparable P1/P3 full download with origin/server headroom | P4 comparable, or origin/storage equally slow | Same fixture T3/T5, path and auth surface separated |
| H9 | Gateway/proxy behavior limits throughput | Gateway-observed delay/temp I/O/rate diverges from Drive read | Direct Drive path equally slow; proxy shows no added delay | Upstream vs edge timing and container/resource samples |
| H10 | Range behavior causes video startup delay | Many/large/416 ranges, high overfetch, TTFF/seek correlate with range sequence | Efficient 206 sequence but TTFF remains high | DevTools Range log + server timing + TTFF |
| H11 | Media queue causes cover/poster delay | Queue wait dominates cold poster-ready latency and rises with visible work | Queue near zero while generation/transfer dominates | queue enqueued/start/finish timestamps |
| H12 | FFmpeg processing is limiting | FFmpeg duration/CPU dominates, queue worker occupied | Generation fast; network/browser dominates | child duration/CPU/read bytes plus output-ready time |
| H13 | Cache misses dominate repeat latency | Cold slow, warm fast with identical path and cache hit | Warm remains slow or cache hit absent | paired cold/warm, cache key/state |
| H14 | Disk reads dominate large-video Preview | Read MB/s/iowait and source read scale with TTFF/stalls | Disk headroom; client/network/decoder correlates instead | disk samples, source bytes read, range overfetch |
| H15 | Bottleneck changes by size | Small files overhead-bound; large files network/storage/crypto-bound with breakpoints | Same limiting stage and normalized rate across sizes | full size ladder with stage/resource decomposition |

These hypotheses are not mutually exclusive.

### 14.1 First-day preliminary classification

After Round 1, report P1/P2 Files upload, Vault upload, and Files download Mbps;
P4 Public download Mbps; P1/P2 video TTFF; and peak server CPU, server iowait,
and client CPU. Select exactly one preliminary classification:

~~~text
NETWORK_PATH_CANDIDATE
SERVER_STORAGE_CANDIDATE
CLIENT_CRYPTO_CANDIDATE
MEDIA_RANGE_PIPELINE_CANDIDATE
MULTIPLE_CANDIDATES
INSUFFICIENT_EVIDENCE
~~~

This output determines measurement priority only. ROOT_CAUSE=NOT_PROVEN
remains mandatory until sufficient evidence supports a causal finding.

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
  D -- No --> G{P2/P3 slow only?}
  G -- Yes --> H{Wi-Fi degradation present?}
  H -- Yes --> HW[Wi-Fi candidate: H2]
  H -- No --> HT[Twingate/path candidate: H1; split Direct/Relayed]
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
- LAN fast + Twingate slow: investigate Wi-Fi/Twingate/private WAN path.
- LAN fast + Cloudflare slow: investigate Gateway/cloudflared/Cloudflare path.
- Files fast + Vault slow: inspect client crypto and Vault chunk pipeline.
- Download fast + upload slow: inspect hash/encrypt/chunk/write/commit stages.
- First media load slow, repeat fast: cache/generation candidate.

The tree selects a candidate class, not a final claim.

## 16. Controlled optimization gate

No tuning begins until:

1. baseline raw evidence and summaries are reviewed;
2. one hypothesis has differentiating evidence;
3. proposed change preserves security, integrity, storage reserve, zero-knowledge,
   RBAC, fail-secure behavior, and accepted runtime architecture;
4. rollback and acceptance metrics are written first;
5. Human Owner authorizes a separate implementation task.

Potential experiments such as chunk size, concurrency, worker count, cache
profile, proxy timeout, or network configuration are future tasks. They are not
recommendations in this Draft.

## 17. Report-ready table templates

| Table | Required columns |
|---|---|
| 1 System architecture/network paths | Path ID, client location/interface, overlay/edge, ingress, application hop, storage hop, measured/not measured |
| 2 Test environment | Timestamp, source SHA/image, client OS/browser, server/runtime, storage, limits, concurrent load |
| 3 Transfer fixtures | Class, filename, exact bytes, SHA-256, generator, cleanup |
| 4 Media fixtures | Class, container, codecs, resolution, fps, duration, bitrate, bytes, SHA-256 |
| 5 Upload throughput | Path, workload, size, run, hash/crypto/upload/commit ms, MB/s, Mbps, result |
| 6 Download throughput | Path, workload, size, run, TTFB, elapsed, MB/s, integrity |
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
| Path vs throughput | P1–P4 | median MB/s | size/workload | NOT TESTED and CONFIG-LIMITED excluded, not zero |
| File size vs TTFF | exact bytes | median TTFF ms | codec/path/cache | codec/bitrate labels |
| Path vs TTFB | P1–P4 | median TTFB ms | workload/size | n and min/max |
| Server iowait vs throughput | iowait % | MB/s | workload/path | run IDs, no causal trendline without adequate n |
| Preview before/after | baseline/candidate | latency/stall metric | fixture/path | only after controlled optimization |

Charts are generated only from machine-readable evidence. Missing and
CONFIG-LIMITED values remain categorical gaps, never numeric zeroes.

## 19. Limitations and future continuation

- The PC server, storage device, client, Wi-Fi environment, ISP, Twingate route,
  and Cloudflare route limit generalizability.
- Human browser timing introduces observer variance; machine timing should be
  paired where possible.
- Browser caches, media derivative cache, and OS filesystem cache are different
  states and must be labelled.
- Real multi-GB media generation is expensive; fewer runs and NOT TESTED are
  acceptable when stated.
- Codec, bitrate, keyframe placement, and container index placement can dominate
  media behavior independently of file size.
- Public Share has no Range, so its full-download result cannot be generalized
  to interactive preview.
- Historical rates were not collected under this matrix; they remain context,
  not baseline samples.
- Current Production configuration is unknown until Phase B0; source defaults
  must not be substituted.
- Root cause, safe tuning values, and before/after improvement remain NOT PROVEN.

## 20. Study truth at Draft creation

~~~text
PRODUCTION_MUTATED=NO
PERFORMANCE_SETTINGS_CHANGED=NO
ROOT_CAUSE=NOT_PROVEN
TWINGATE_BOTTLENECK=NOT_PROVEN
CLOUDFLARE_BOTTLENECK=NOT_PROVEN
STORAGE_BOTTLENECK=NOT_PROVEN
CLIENT_CRYPTO_BOTTLENECK=NOT_PROVEN
PRODUCTION_VALUES_REMEASURE_REQUIRED=YES
PUBLIC_SHARE_FUNCTIONALITY=RESTORED
PUBLIC_SHARE_EXTERNAL_WITHOUT_TWINGATE=PASS
IMAGE_DOWNLOAD=PASS
LARGE_VIDEO_DOWNLOAD=PASS
REVOCATION=PASS
POST_REVOKE_BLOCK=PASS
CLOUDFLARE_1033=RESOLVED
~~~

## 21. Evidence source register

Canonical/history:

- Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-secure-share-post-closeout-followups.md
- Obsidian_AEGIS_Vault/AEGIS_Knowledge/concepts/Large_File_Transfer_V2.md
- Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-public-share-architecture.md
- Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md
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
