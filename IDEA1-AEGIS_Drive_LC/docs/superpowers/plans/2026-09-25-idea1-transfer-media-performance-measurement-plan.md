# AEGIS IDEA1 Transfer and Media Performance Measurement Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to execute repository-local preparation tasks. Production phases are Human Owner only and require separate authorization. Steps use checkbox syntax for tracking.

**Goal:** Produce reproducible, machine-readable evidence that localizes AEGIS transfer and media-preview bottlenecks without changing Production performance settings.

**Architecture:** Historical evidence and current-source facts define a fixed
matrix. The core PRE/POST experiment evaluates exactly TWO primary network paths:
P1 (Onsite Direct LAN) and P2 (Remote + Twingate). Historical browser tracer labels
using P3 map directly: `HISTORICAL_RUN_LABEL_P3 = FINAL_METHODOLOGY_P2_REMOTE_TWINGATE`.
A supplementary path C1 (Public Share / Cloudflare, download-only) evaluates public delivery performance.
Human-run Production phases measure one path/workload/fixture at a time,
pair browser timing with client/server resource samples, and classify
configuration limits separately from transfer failures.
Phase B0 Production baseline is EXECUTED. Phase P2 Remote PRE-FIX (18 controlled runs) is EXECUTED.
Phase C1 Public Share / Cloudflare PRE-FIX (9 valid runs) is EXECUTED.
Phase P1 Onsite Direct LAN PRE-FIX (18 controlled runs) is EXECUTED.
Total current valid controlled runs: 45 (18 P1 + 18 P2 + 9 C1). Core PRE-FIX baselines are 36/36 COMPLETE.
Diagnosis and root-cause analysis is the IMMEDIATE NEXT GATE.
Optimization remains a later owner-authorized task; mutations are strictly blocked pending diagnosis (`CORE_PERFORMANCE_MUTATION_GATE=PRE_FIX_BASELINES_CAPTURED`, `PERFORMANCE_MUTATION_AUTHORIZED=NO`).

**Tech Stack:** AEGIS Drive React/Express, PostgreSQL 15, Docker, in-page XHR tracer,
PowerShell download observer, FFmpeg/FFprobe, SHA-256, JSON Lines/CSV.

**Spec:** IDEA1-AEGIS_Drive_LC/docs/superpowers/specs/2026-09-25-idea1-transfer-media-performance-study-design.md

## Global constraints

- Production execution is Human Owner only.
- No SSH, Production command, benchmark, upload, download, or share action is
  executed by the planning agent.
- Baseline changes no Twingate, Cloudflare, Docker network, firewall, sysctl,
  chunk size, concurrency, file limit, worker count, media profile, schema,
  storage mount, or application configuration.
- `CORE_PERFORMANCE_MUTATION_GATE=PRE_FIX_BASELINES_CAPTURED`.
- `PERFORMANCE_MUTATION_AUTHORIZED=NO`.
- `PUBLIC_SHARE_SPECIFIC_MUTATION_GATE=PRE_FIX_BASELINE_CAPTURED`; `PUBLIC_SHARE_MUTATION_AUTHORIZED=NO`.
- `SHARED_MUTATION=BLOCKED_PENDING_DIAGNOSIS`.
- No password, cookie, session/CSRF token, bearer link, Vault key, wrapped key,
  plaintext private content, or secret-bearing environment output enters evidence.
- Current Production values are measured; source defaults are not substituted.
- 10 GB never causes a limit increase. Rejection before transfer is
  EXPECTED_CONFIG_LIMIT and NETWORK_PERFORMANCE=NOT_MEASURED.
- Destructive purge remains false. TREE_V1/migration 011 state is observed only.
- Public Share security rollout is not reopened.
- No final receipt is created for this in-progress Draft task.

## Review focus

1. A 5/10 GB configuration rejection must not be charted as zero throughput.
2. Public bearer links must never appear in command lines, HAR exports, filenames,
   shell history, JSON, CSV, screenshots, or report prose.
3. Media comparisons must pair size with codec, bitrate, resolution, duration,
   keyframe/index placement, and cache state.
4. P1 vs P2 comparisons must change only the path and preserve fixture/client/server
   conditions where practical.
5. Sparse structural fixtures must never be used as throughput evidence.
6. Upload throughput relies on the in-page XHR tracer (`CHUNK_SPAN_MBPS`), not browser Resource Timing.
7. Download throughput relies on the PowerShell `.crdownload` observer resolving final file by exact size.

---

## File map

| Path | Responsibility |
|---|---|
| docs/superpowers/specs/2026-09-25-idea1-transfer-media-performance-study-design.md | Research contract, evidence inventory, matrix, hypotheses, decision framework |
| docs/superpowers/plans/2026-09-25-idea1-transfer-media-performance-measurement-plan.md | Human-run phases, validated methods, commands, evidence naming, stop/cleanup gates |
| Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md | Canonical IN_PROGRESS status and session register |

No benchmark harness code is added in this Draft. Existing browser, OS, Docker,
FFmpeg, and hashing tools are sufficient.

## 1. Evidence directory and naming

Production evidence stays outside Git until sanitized and reviewed. On the
Human Owner workstation:

~~~powershell
$StudyRoot = Join-Path $env:USERPROFILE 'AEGIS-LFT-PERF-1-EVIDENCE'
$RunDate = Get-Date -Format 'yyyyMMdd'
$EvidenceRoot = Join-Path $StudyRoot $RunDate
New-Item -ItemType Directory -Force -Path $EvidenceRoot | Out-Null
Write-Output $EvidenceRoot
~~~

Filename convention:

~~~text
YYYYMMDDTHHMMSSZ__P<path>__T<workload>__<size>__r<repeat>__<artifact>.<ext>
example:
20260925T120000Z__P1__T1__S__r01__run.json
20260925T120000Z__P1__T1__S__r01__server.csv
20260925T120000Z__P1__T11__L__r01__media.json
~~~

Artifacts: run.json, client.csv, server.csv, media.json, sanitized-summary.csv,
fixture.json. Raw HAR files remain local and are never committed; record sanitized
timing fields manually instead of exporting HAR.

## 2. Deterministic generic fixtures

Deterministic benchmark fixtures on the Human Windows client reside in:

~~~text
C:\Users\User\AEGIS-LFT-PERF-1
~~~

### Task 1: Generate exact-size payloads locally

**Produces:** deterministic local binary files and SHA-256 manifest.

- [x] **Step 1: Confirm free space**
- [x] **Step 2: Generate fixtures**

Known fixture manifest in `C:\Users\User\AEGIS-LFT-PERF-1`:
- `S-100MB.bin`: exact bytes = 100,000,000, SHA-256 = `f079cad53add0091ed5d0409b0469f9f5cb745b8c280be685dda73203dea90e8`
- `M-300MB.bin`: exact bytes = 300,000,000
- `L-1GB.bin`: exact bytes = 1,000,000,000
- `XL-5GB.bin`: exact bytes = 5,000,000,000 (below 5 GiB limit)
- `XXL-10GB.bin`: exact bytes = 10,000,000,000 (above 5 GiB limit -> EXPECTED_CONFIG_LIMIT)

Do NOT invent SHA-256 digests for M or L if not present in verified evidence.

- [x] **Step 3: Verify exact lengths and repeat hashes**

~~~powershell
'FIXTURE_VERIFICATION=PASS'
~~~

## 3. Media fixtures

### Task 2: Create representative encoded video fixtures

**Produces:** toolchain-bound synthetic MP4 fixtures; exact bytes/hashes and
FFprobe metadata. “Approximately class size” is accepted; actual bytes govern.

- [ ] **Step 1: Record toolchain**
- [ ] **Step 2: Generate only sizes authorized by free space/runtime**

Durations target about 8.128 Mbps total. Run one row at a time. The 5/10 GB
rows may be NOT TESTED. Never replace them with sparse files for throughput.

| Class | Duration seconds |
|---|---:|
| 100 MB | 98 |
| 300 MB | 295 |
| 1 GB | 985 |
| 5 GB | 4923 |
| 10 GB | 9846 |

Exact command, replacing DURATION and OUTPUT:

~~~powershell
ffmpeg -hide_banner -nostdin -f lavfi -i 'testsrc2=size=1280x720:rate=30' -f lavfi -i 'sine=frequency=1000:sample_rate=48000' -t DURATION -map 0:v:0 -map 1:a:0 -c:v libx264 -preset veryfast -pix_fmt yuv420p -b:v 8M -maxrate 8M -bufsize 16M -g 60 -keyint_min 60 -sc_threshold 0 -c:a aac -b:a 128k -movflags +faststart -map_metadata -1 -metadata creation_time=1970-01-01T00:00:00Z -y OUTPUT
~~~

- [ ] **Step 3: Record metadata for every media fixture**

Image and GIF fixtures must likewise record exact bytes/hash, dimensions,
animation/frame evidence, and generator/toolchain.

## 4. Repetition schedule

| Size | Warm-up | Measured minimum | Allowed shortfall |
|---|---:|---:|---|
| 100 MB | 1 | 3 | none unless blocked |
| 300 MB | 1 | 3 | none unless blocked |
| 1 GB | 1 | 3 preferred | record time/capacity limitation |
| 5 GB | 0 or 1 | 1+ | record n and capacity/runtime limitation |
| 10 GB | configuration probe first | 1 if accepted | CONFIG-LIMITED or NOT TESTED is valid |

For media, cold and warm each have separate samples. Do not count warm-up as a
measured run.

### Core PRE/POST experiment matrix

Total core matrix dimensions:
- 2 paths: P1 (Onsite Direct LAN) and P2 (Remote + Twingate)
- 3 file sizes: S (100 MB), M (300 MB), L (1 GB)
- 2 directions: T1 Files Upload, T3 Files Download
- 3 repetitions (n=3)
- Target: 36 PRE-FIX runs + 36 POST-FIX runs = 72 total.

Execution status:
- P1 Onsite Direct LAN PRE-FIX: **18/18 COMPLETE** (Upload S/M/L ×3, Download S/M/L ×3).
- P2 Remote + Twingate PRE-FIX: **18/18 COMPLETE** (Upload S/M/L ×3, Download S/M/L ×3).
- C1 Public Share / Cloudflare PRE-FIX: **9/9 valid runs COMPLETE** (Download S/M/L ×3).
- Core PRE-FIX overall: **36/36 COMPLETE** (target 36).
- Supplementary Public Share PRE-FIX: **9/9 COMPLETE**.
- Total current valid controlled runs: **45 runs** (18 P1 + 18 P2 + 9 C1).
- POST-FIX: **0/36 NOT STARTED**.
- Performance mutations: **BLOCKED PENDING DIAGNOSIS** (`CORE_PERFORMANCE_MUTATION_GATE=PRE_FIX_BASELINES_CAPTURED`, `PERFORMANCE_MUTATION_AUTHORIZED=NO`).

## 5. Phase B0 — Production configuration inventory (EXECUTED)

Executed by Human Owner on 2026-09-25T14:35:03+00:00. Read-only observation.

### B0.1 Container identity and health (Measured)

~~~bash
date --iso-8601=seconds
# 2026-09-25T14:35:03+00:00
D=(sudo env -u DOCKER_HOST -u CONTAINER_HOST docker)
"${D[@]}" inspect aegis-prod-drive-1 --format 'name={{.Name}} image={{.Config.Image}} id={{.Image}} status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} restarts={{.RestartCount}} oom={{.State.OOMKilled}}'
# name=/aegis-prod-drive-1 image=aegis-prod-drive:vault-stage-d-fix-f8c876754dd6 status=running health=healthy restarts=0 oom=false

"${D[@]}" inspect aegis-prod-public-share-gateway-1 --format 'name={{.Name}} image={{.Config.Image}} status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} restarts={{.RestartCount}} oom={{.State.OOMKilled}}'
# name=/aegis-prod-public-share-gateway-1 image=aegis-public-share-gateway:public-share-50ce6e1638 status=running health=healthy restarts=0 oom=false

"${D[@]}" inspect aegis-prod-public-share-connector-1 --format 'name={{.Name}} image={{.Config.Image}} status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} restarts={{.RestartCount}} oom={{.State.OOMKilled}}'
# name=/aegis-prod-public-share-connector-1 image=cloudflare/cloudflared:2026.9.0 status=running restarts=0
~~~

### B0.2 Allowlisted runtime configuration fields (Measured)

Effective relevant Drive runtime values:
- `MEDIA_CACHE_POLICY=immutable`
- `VAULT_CHUNK_PLAINTEXT_BYTES=16777216` (16 MiB)
- `MEDIA_CACHE_MAX_BYTES=2147483648` (2 GiB)
- `MEDIA_STILL_ENGINE=sharp`
- `VAULT_UPLOAD_CONCURRENCY=2`
- `MEDIA_ENABLED=true`
- `MEDIA_WORKERS=1`

### B0.3 Storage topology and space (Measured)

Data Lake mount `/datalake`:
- Total bytes: 61,075,263,488 B
- Used bytes: 44,536,557,568 B
- Available bytes: ~13,403,045,888 B (~77% usage)
- Backing device: SSD-backed storage path, not the rotational backup disk.
- *Discipline*: Topology/runtime truth only; does not prove storage is not a bottleneck.

### B0.4 Application transfer limits (Measured)

1. Files limits (`GET /drive/api/files/uploads/limits`): HTTP 200
   - `chunkSizeBytes`: 16,777,216 (16 MiB)
   - `maxLogicalFileBytes`: 5,368,709,120 (5 GiB)
   - `maxSupportedLogicalFileBytes`: 34,359,738,368 (32 GiB)
   - `sessionTtlMs`: 86,400,000 (24 h)
   - Capacity: total 61,075,263,488 B, free ≈ 13,402,968,064 B, reserve 3,053,763,175 B, usable 10,349,204,889 B

2. Vault limits (`GET /drive/api/vault/uploads/limits` — note: NOT `/drive/api/vault/tree/uploads/limits`): HTTP 200
   - `formatVersion`: 2
   - `plaintextChunkBytes`: 16,777,216 (16 MiB)
   - `ciphertextChunkBytes`: 16,777,232 (16 MiB + 16-byte GCM tag)
   - `gcmTagBytes`: 16
   - `uploadConcurrency`: 2
   - `maxLogicalFileBytes`: 5,368,709,120 (5 GiB)
   - `maxPlaintextChunkBytes`: 67,108,864
   - `minPlaintextChunkBytes`: 8,388,608
   - `maxSupportedLogicalFileBytes`: 34,359,738,368 (32 GiB)
   - `sessionTtlMs`: 86,400,000 (24 h)

Limit classification:
- 5 GB decimal = 5,000,000,000 B < 5 GiB limit -> below limit.
- 10 GB decimal = 10,000,000,000 B > 5 GiB limit -> above limit (`EXPECTED_CONFIG_LIMIT`, `NETWORK_PERFORMANCE=NOT_MEASURED`).

### B0.5 Admin media cache and queue status (Measured)

`GET /drive/api/admin/media-cache/status`: HTTP 200
- `enabled`: true
- `capabilities.ffmpeg.version`: 8.0.1
- `capabilities.sharp.version`: 0.35.4
- `cache.bytes`: 274,284
- `cache.entries`: 5
- `cache.highWater`: 2,147,483,648 (2 GiB)
- `cache.lowWater`: 1,717,986,918 (~1.6 GiB)
- `cache.volume`: "volume"
- `queue.depth`: 0
- `queue.running`: 0
- `failures.last24h`: 0

## 6. Common run protocol and validated measurement methods

### 6.1 Upload measurement method — in-page XHR tracer

Browser Resource Timing empirically failed to capture upload XHRs. The validated
upload measurement method uses a temporary Human-controlled in-page `XMLHttpRequest`
tracer:

~~~javascript
// Injected into browser console on authenticated Drive page
(() => {
  window.__AEGIS_LFT_TRACE__ = {
    runs: [],
    currentRun: null,
    startRun(label, expectedBytes) {
      this.currentRun = {
        label,
        expectedBytes,
        chunks: [],
        startMs: performance.now(),
        endMs: null
      };
      this.runs.push(this.currentRun);
    },
    report() {
      const r = this.currentRun;
      if (!r || r.chunks.length === 0) return null;
      const firstChunkStart = Math.min(...r.chunks.map(c => c.startMs));
      const lastChunkEnd = Math.max(...r.chunks.map(c => c.endMs));
      const chunkSpanMs = lastChunkEnd - firstChunkStart;
      const totalBytes = r.chunks.reduce((acc, c) => acc + c.bytes, 0);
      const chunkSpanMBps = (totalBytes / 1e6) / (chunkSpanMs / 1000);
      return {
        label: r.label,
        chunkCount: r.chunks.length,
        totalBytes,
        chunkSpanMs,
        chunkSpanMBps: Math.round(chunkSpanMBps * 1000) / 1000,
        allHttp200: r.chunks.every(c => c.status === 200)
      };
    }
  };
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this.__traceUrl = url;
    this.__traceMethod = method;
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function(body) {
    if (this.__traceMethod === 'PUT' && this.__traceUrl && this.__traceUrl.includes('/drive/api/files/uploads')) {
      const startMs = performance.now();
      const bytes = body ? (body.size || body.byteLength || 0) : 0;
      this.addEventListener('loadend', () => {
        const endMs = performance.now();
        if (window.__AEGIS_LFT_TRACE__ && window.__AEGIS_LFT_TRACE__.currentRun) {
          window.__AEGIS_LFT_TRACE__.currentRun.chunks.push({
            startMs, endMs, bytes, status: this.status
          });
        }
      });
    }
    return origSend.call(this, body);
  };
})();
~~~

Primary reliable metric is **`CHUNK_SPAN_MBPS`**.
The E2E timer includes human file-picker interaction delay and UI latency; E2E is supplementary/contaminated and MUST NOT be used as the primary transfer throughput.

### 6.2 Download measurement method — PowerShell observer

Brave browser Files download uses native browser streaming (`<a>` + `click()`).
The validated measurement method uses a PowerShell observer polling for the `.crdownload` file:

~~~powershell
$DownloadDir = "C:\Users\User\Downloads"
$ExpectedBytes = 100000000 # Example for S-100MB
$TimeoutSeconds = 600

Write-Host "Waiting for .crdownload file..."
$Sw = [System.Diagnostics.Stopwatch]::StartNew()
while ($Sw.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
  $Cr = Get-ChildItem -Path $DownloadDir -Filter "*.crdownload" | Select-Object -First 1
  if ($Cr) { break }
  Start-Sleep -Milliseconds 50
}
if (-not $Cr) { throw "Timed out waiting for download to start" }

$TimingSw = [System.Diagnostics.Stopwatch]::StartNew()
Write-Host "Downloading $($Cr.Name)..."
while ($TimingSw.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
  if (-not (Test-Path -LiteralPath $Cr.FullName)) { break }
  Start-Sleep -Milliseconds 50
}
$TimingSw.Stop()

# Resolve final file by size
$FinalFile = Get-ChildItem -Path $DownloadDir | Where-Object { $_.Length -eq $ExpectedBytes -and $_.LastWriteTime -ge (Get-Date).AddMinutes(-2) } | Select-Object -First 1
if (-not $FinalFile) { throw "Could not resolve final file with size $ExpectedBytes" }

$ElapsedMs = $TimingSw.ElapsedMilliseconds
$MBps = ($ExpectedBytes / 1000000.0) / ($ElapsedMs / 1000.0)
Write-Output "DOWNLOAD_MS=$ElapsedMs"
Write-Output "DOWNLOAD_MBPS=$([Math]::Round($MBps, 3))"
~~~

*Harness defect note*: An early pilot script defect incorrectly expected `Unconfirmed XXXXX.crdownload` to rename without an extension; Brave promoted it to the target filename (e.g. `S-100MB.bin`). This was a test harness defect, not an AEGIS defect. The pilot attempt is excluded and was not counted as a controlled run.

### 6.3 Public Share download measurement method (C1)

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

## 7. Phase B1 — P1 Onsite Direct LAN PRE-FIX baseline (EXECUTED)

Executed by Human Owner on site connected via wired Ethernet / Management VLAN30 (client IP `192.168.30.x`, direct internal AEGIS access `192.168.10.10:443`, Twingate OFF, Cloudflare not in path).
All 18 controlled runs complete (9 download + 9 upload).

### 7.1 Files download results (P1 Onsite Direct LAN)

Captured via PowerShell `.crdownload` observer resolving final file by exact byte length:

| Fixture | Run | Elapsed (ms) | Download (MB/s) | Integrity Result |
|---|---|---:|---:|---|
| S-100MB (100,000,000 B) | r01 | 14,828 | 6.744 | Exact size match |
| S-100MB (100,000,000 B) | r02 | 14,359 | 6.964 | Exact size match |
| S-100MB (100,000,000 B) | r03 | 15,247 | 6.559 | Exact size match |
| **100 MB Summary** | **n=3** | **Min: 6.559** | **Median: 6.744** | **Max: 6.964 (Mean: 6.756)** |
| M-300MB (300,000,000 B) | r01 | 42,250 | 7.101 | Exact size match |
| M-300MB (300,000,000 B) | r02 | 41,365 | 7.253 | Exact size match |
| M-300MB (300,000,000 B) | r03 | 40,131 | 7.476 | Exact size match |
| **300 MB Summary** | **n=3** | **Min: 7.101** | **Median: 7.253** | **Max: 7.476 (Mean: 7.277)** |
| L-1GB (1,000,000,000 B) | r01 | 142,204 | 7.032 | Exact size match |
| L-1GB (1,000,000,000 B) | r02 | 143,029 | 6.992 | Exact size match |
| L-1GB (1,000,000,000 B) | r03 | 142,328 | 7.026 | Exact size match |
| **1 GB Summary** | **n=3** | **Min: 6.992** | **Median: 7.026** | **Max: 7.032 (Mean: 7.017)** |

Download Controlled Verdict:
- `P1_ONSITE_DIRECT_LAN_FILES_DOWNLOAD_PRE_FIX=COMPLETE` (9 runs).
- 100 MB median = 6.744 MB/s; 300 MB median = 7.253 MB/s; 1 GB median = 7.026 MB/s.
- `SUSTAINED_DOWNLOAD_THROUGHPUT≈6.7_TO_7.3_MBPS` across the tested range.
- `FILE_SIZE_DEPENDENT_DEGRADATION=NOT_OBSERVED` within 100 MB to 1 GB.

### 7.2 Files upload results (P1 Onsite Direct LAN)

Captured via browser console in-page XHR tracer `window.__AEGIS_LFT_TRACE__`:

| Fixture | Run | Chunk span (ms) | Upload (MB/s) | Chunks | Chunk Requests (HTTP 200) |
|---|---|---:|---:|---:|---|
| S-100MB (100,000,000 B) | r01 | 19,778 | 5.056 | 6 × 16 MiB | 9 requests (6 PUT + 3 lifecycle), all 200 |
| S-100MB (100,000,000 B) | r02 | 19,854 | 5.037 | 6 × 16 MiB | 9 requests (6 PUT + 3 lifecycle), all 200 |
| S-100MB (100,000,000 B) | r03 | 19,427 | 5.147 | 6 × 16 MiB | 9 requests (6 PUT + 3 lifecycle), all 200 |
| **100 MB Summary** | **n=3** | **Min: 5.037** | **Median: 5.056** | **Max: 5.147 (Mean: 5.080)** |
| M-300MB (300,000,000 B) | r01 | 57,951 | 5.177 | 18 × 16 MiB | 21 requests (18 PUT + 3 lifecycle), all 200 |
| M-300MB (300,000,000 B) | r02 | 58,113 | 5.162 | 18 × 16 MiB | 21 requests (18 PUT + 3 lifecycle), all 200 |
| M-300MB (300,000,000 B) | r03 | 58,009 | 5.172 | 18 × 16 MiB | 21 requests (18 PUT + 3 lifecycle), all 200 |
| **300 MB Summary** | **n=3** | **Min: 5.162** | **Median: 5.172** | **Max: 5.177 (Mean: 5.170)** |
| L-1GB (1,000,000,000 B) | r01 | 193,956 | 5.156 | 60 × 16 MiB | 63 requests (60 PUT + 3 lifecycle), all 200 |
| L-1GB (1,000,000,000 B) | r02 | 194,498 | 5.141 | 60 × 16 MiB | 63 requests (60 PUT + 3 lifecycle), all 200 |
| L-1GB (1,000,000,000 B) | r03 | 194,150 | 5.151 | 60 × 16 MiB | 63 requests (60 PUT + 3 lifecycle), all 200 |
| **1 GB Summary** | **n=3** | **Min: 5.141** | **Median: 5.151** | **Max: 5.156 (Mean: 5.149)** |

Upload Controlled Verdict:
- `P1_ONSITE_DIRECT_LAN_FILES_UPLOAD_PRE_FIX=COMPLETE` (9 runs).
- 100 MB median = 5.056 MB/s; 300 MB median = 5.172 MB/s; 1 GB median = 5.151 MB/s.
- `SUSTAINED_UPLOAD_THROUGHPUT≈5.06_TO_5.17_MBPS` across the tested range (remarkably flat).
- `FILE_SIZE_DEPENDENT_DEGRADATION=NOT_OBSERVED` within 100 MB to 1 GB.
- **Source verification audit**: All three 1 GB upload runs verified as actual measured browser-console tracer runs (63 total requests: 60 chunk PUTs + 3 session lifecycle requests; exact millisecond spans; zero request failures).

### 7.3 P1 Onsite Direct LAN upload vs download asymmetry

Under the same wired Ethernet / Management VLAN30 client environment:
- 100 MB: download (6.744) / upload (5.056) ≈ 1.33x (~33% faster)
- 300 MB: download (7.253) / upload (5.172) ≈ 1.40x (~40% faster)
- 1 GB: download (7.026) / upload (5.151) ≈ 1.36x (~36% faster)

Observation:
- Onsite Direct LAN download throughput is consistently roughly 33–40% higher (~1.36x average) than upload throughput across all three tested fixtures.
- Download advantage is somewhat lower than under P2 Remote + Twingate (~1.6x), but download remains consistently faster than upload on both paths.

### 7.4 Comprehensive three-path comparison (P1 Direct LAN vs P2 Remote Twingate vs C1 Public Share)

| Workload | Fixture | P1 Onsite LAN Median (MB/s) | P2 Remote Twingate Median (MB/s) | C1 Public Share Median (MB/s) | P1 vs P2 Ratio | C1 vs P1 Ratio | C1 vs P2 Ratio |
|---|---|---:|---:|---:|---:|---:|---:|
| **Download** | 100 MB | 6.744 | 4.799 | 13.546 | ~1.41x (P1 +41%) | ~2.01x (C1 +101%) | ~2.82x (C1 +182%) |
| **Download** | 300 MB | 7.253 | 5.050 | 11.978 | ~1.44x (P1 +44%) | ~1.65x (C1 +65%) | ~2.37x (C1 +137%) |
| **Download** | 1 GB | 7.026 | 4.829 | 11.666 | ~1.45x (P1 +45%) | ~1.66x (C1 +66%) | ~2.42x (C1 +142%) |
| **Upload** | 100 MB | 5.056 | 2.981 | N/A (download only) | ~1.70x (P1 +70%) | N/A | N/A |
| **Upload** | 300 MB | 5.172 | 3.080 | N/A (download only) | ~1.68x (P1 +68%) | N/A | N/A |
| **Upload** | 1 GB | 5.151 | 3.016 | N/A (download only) | ~1.71x (P1 +71%) | N/A | N/A |

Key observations:
1. P1 LAN is materially faster than P2 Remote Twingate for both upload (~1.7x) and download (~1.4x–1.45x), confirming observable network/overlay overhead.
2. Direct LAN performance does **NOT** prove Twingate is the sole bottleneck: LAN upload caps at ~5.15 MB/s and download at ~7.0–7.25 MB/s, well below Gigabit wire rate (~110–120 MB/s).
3. C1 Cloudflare Public Share download (~11.7–13.5 MB/s) is faster than both authenticated P1 LAN and P2 remote paths, but path architectures differ fundamentally (auth, gateway, streaming pipe vs chunked session).
4. Prohibited claims: Do NOT claim `ROOT_CAUSE=PROVEN`, `TWINGATE_SOLE_BOTTLENECK=PROVEN`, `SWITCH_BOTTLENECK=PROVEN`, or `ROUTER_BOTTLENECK=PROVEN`.

### 7.5 Separate defect discovered during P1: Production storage capacity / accounting discrepancy

During P1 testing, a separate storage issue was observed on the Production host:
- Docker named volume: `aegis_drive_storage`
- Mountpoint: `/var/lib/docker/volumes/aegis_drive_storage/_data` (~29 GB volume data)
- Root filesystem (`/`): ~57 GB total, ~51 GB used, ~3.1 GB available (~95% disk usage)
- External ~1 TB disk is mounted for backup (`/mnt/backup`) and is not the active Drive storage authority.
- Human Owner observed that deleting test files and emptying Trash did not visibly reduce Dashboard storage accounting usage.
- Strict governance: Do NOT fix in PR #216. Do NOT prune Docker. Do NOT delete Vault ciphertext/orphans. Do NOT modify storage layout. Status: `STORAGE_ACCOUNTING_DEFECT_RECORDED=YES`, recorded as a separate investigation/blocker.

## 8. Exploratory path — Local Wi-Fi plus Twingate (Diagnostic only)

Optional exploratory diagnostic path. Not part of the primary two-path PRE/POST matrix.
Retained only if needed to isolate Wi-Fi degradation from remote WAN behavior.

## 9. Phase B2 / Historical B3 — P2 Remote Internet plus Twingate PRE-FIX (EXECUTED)

Executed by Human Owner under Remote + Twingate conditions. 18 controlled runs complete.

### 9.1 Files upload results (P2 Remote + Twingate)

- **100 MB** (6 chunks): r01 = 2.981 MB/s (33,541 ms), r02 = 2.834 MB/s (35,284 ms), r03 = 3.060 MB/s (32,681 ms). **Median = 2.981 MB/s** (min 2.834, max 3.060, mean ~2.958). All HTTP 200.
- **300 MB** (18 chunks): r01 = 3.080 MB/s (97,389 ms), r02 = 3.103 MB/s (96,675 ms), r03 = 2.977 MB/s (100,773 ms). **Median = 3.080 MB/s** (min 2.977, max 3.103, mean ~3.053). All HTTP 200.
- **1 GB** (60 chunks): r01 = 3.031 MB/s (329,883 ms), r02 = 3.007 MB/s (332,576 ms), r03 = 3.016 MB/s (331,597 ms). **Median = 3.016 MB/s** (min 3.007, max 3.031, mean ~3.018). All HTTP 200.
- **Verdict**: Sustained upload throughput ≈ 3.0 MB/s; no file-size dependent degradation between 100 MB and 1 GB; reproducible.

### 9.2 Files download results (P2 Remote + Twingate)

- **100 MB**: r01 = 4.799 MB/s (20,839 ms), r02 = 4.294 MB/s (23,286 ms), r03 = 5.265 MB/s (18,992 ms). **Median = 4.799 MB/s** (min 4.294, max 5.265, mean ~4.786). Exact size match.
- **300 MB**: r01 = 5.050 MB/s (59,410 ms), r02 = 4.844 MB/s (61,937 ms), r03 = 6.083 MB/s (49,321 ms). **Median = 5.050 MB/s** (min 4.844, max 6.083, mean ~5.326). Exact size match.
- **1 GB**: r01 = 4.829 MB/s (207,080 ms), r02 = 4.873 MB/s (205,192 ms), r03 = 4.656 MB/s (214,789 ms). **Median = 4.829 MB/s** (min 4.656, max 4.873, mean ~4.786). Exact size match.
- **Verdict**: Sustained download throughput ≈ 4.8–5.1 MB/s; no file-size dependent degradation between 100 MB and 1 GB.

### 9.3 Upload vs download asymmetry

- 100 MB: download / upload = 4.799 / 2.981 ≈ 1.61x
- 300 MB: download / upload = 5.050 / 3.080 ≈ 1.64x
- 1 GB: download / upload = 4.829 / 3.016 ≈ 1.60x
- Download is consistently 60–64% higher than upload across all sizes.
- Finding: `TWINGATE_SOLE_BOTTLENECK=NOT_PROVEN`; `UPLOAD_SPECIFIC_BOTTLENECK=STRONGER_CANDIDATE`; `ROOT_CAUSE=NOT_PROVEN`.

### 9.4 Supporting server telemetry during 1 GB upload (r01)

- Drive container: CPU ≈ 6.97%, RAM ≈ 94.93 MiB / 7.035 GiB (~1.32%).
- Sampled iostat: low device utilization and await; no sustained queue saturation.
- Classification: `CPU_SATURATION=NOT_SUPPORTED_BY_OBSERVED_EVIDENCE`, `MEMORY_PRESSURE=NOT_SUPPORTED_BY_OBSERVED_EVIDENCE`, `STORAGE_SATURATION=NOT_SUPPORTED_BY_SAMPLED_EVIDENCE`.
- Strict limitation: Sampled portion of timeline, not full-run telemetry. `STORAGE_BOTTLENECK=PROVEN_FALSE` is NOT permitted. Docker stats Block I/O is cumulative, not instantaneous throughput.

## 10. Phase B4 — C1 Public Share / Cloudflare PRE-FIX baseline (EXECUTED)

Executed by Human Owner on the same remote Windows PC / Brave browser used for P2, with Twingate OFF.
9 valid controlled runs complete.

### 10.1 Measured C1 results

- **100 MB** (100,000,000 B):
  - r01: 7,230 ms -> 13.831 MB/s
  - r02: 7,382 ms -> 13.546 MB/s
  - r03: 8,854 ms -> 11.294 MB/s
  - Summary: n=3, min: 11.294 MB/s, **median: 13.546 MB/s**, max: 13.831 MB/s, mean: ~12.890 MB/s. Exact size match.
  - Verdict: `C1_PUBLIC_SHARE_100MB_PRE_FIX=COMPLETE`
- **300 MB** (300,000,000 B):
  - r01: 25,231 ms -> 11.890 MB/s
  - r02: 25,046 ms -> 11.978 MB/s
  - r03: 24,346 ms -> 12.322 MB/s
  - Summary: n=3, min: 11.890 MB/s, **median: 11.978 MB/s**, max: 12.322 MB/s, mean: ~12.063 MB/s. Exact size match.
  - Verdict: `C1_PUBLIC_SHARE_300MB_PRE_FIX=COMPLETE`
- **1 GB** (1,000,000,000 B):
  - r01: 85,515 ms -> 11.694 MB/s
  - r02: 85,723 ms -> 11.665 MB/s
  - r03: 85,722 ms -> 11.666 MB/s
  - Summary: n=3, min: 11.665 MB/s, **median: 11.666 MB/s**, max: 11.694 MB/s, mean: 11.675 MB/s. Exact size match.
  - Verdict: `C1_PUBLIC_SHARE_1GB_PRE_FIX=COMPLETE` (highly stable across repetitions).

Overall verdict:
- `C1_PUBLIC_SHARE_PRE_FIX=COMPLETE` (9 valid runs).
- Within tested 100 MB–1 GB range: `PUBLIC_SHARE_SUSTAINED_DELIVERY≈11.7_TO_13.5_MBPS_BY_MEDIAN`.
- Discipline: Do not convert to an Internet-wide SLA.

### 10.2 P2 Remote + Twingate vs C1 Public Share comparison

Same client machine and general remote Internet environment:
- 100 MB: P2 4.799 MB/s vs C1 13.546 MB/s (ratio ~2.82x, C1 ~182% faster)
- 300 MB: P2 5.050 MB/s vs C1 11.978 MB/s (ratio ~2.37x, C1 ~137% faster)
- 1 GB: P2 4.829 MB/s vs C1 11.666 MB/s (ratio ~2.42x, C1 ~142% faster)

Findings:
- Under tested client environment, Public Share delivery achieved substantially higher download throughput than authenticated P2 Remote + Twingate Files download across all 3 sizes.
- `PUBLIC_SHARE_PATH_PENALTY=NOT_OBSERVED`
- `PUBLIC_SHARE_SLOWER_THAN_P2=NOT_SUPPORTED_BY_CURRENT_EVIDENCE`
- Prohibited overclaims: `CLOUDFLARE_IS_FASTER=PROVEN`, `TWINGATE_IS_THE_BOTTLENECK`.
- Status: `CLOUDFLARE_BOTTLENECK=NOT_PROVEN`, `TWINGATE_SOLE_BOTTLENECK=NOT_PROVEN`, `ROOT_CAUSE=NOT_PROVEN`.

### 10.3 C1 POST-FIX verification procedure and template

If an authorized Public-Share-affecting change is deployed, repeat the exact S/M/L n=3 workload using the same password redemption and PowerShell observer method:

| Fixture | PRE median MB/s | POST median MB/s | Delta MB/s | Improvement % | Speedup | Verdict |
|---|---:|---:|---:|---:|---:|---|
| 100 MB | 13.546 | PENDING | PENDING | PENDING | PENDING | PENDING |
| 300 MB | 11.978 | PENDING | PENDING | PENDING | PENDING | PENDING |
| 1 GB | 11.666 | PENDING | PENDING | PENDING | PENDING | PENDING |

### 10.4 Optional future C2 field validation packet

- Target: 1–2 external recipients/networks, Twingate OFF.
- Fixture: representative 300 MB fixture (n=3 per recipient/network), optional 1 GB sustained confirmation.
- Telemetry: network type, client device/browser, bytes, elapsed ms, MB/s, interruptions.
- Rule: Do NOT mix C2 into controlled C1 median/mean.
- Status: `C2_FIELD_VALIDATION=PLANNED_OPTIONAL / NOT_EXECUTED`.

## 11. Phase B5 — Media preview baseline (Supplementary)

Supplementary future sub-study.
T7–T11 media protocols remain planned for separate execution after core transfer baseline is established.

## 12. Machine-readable run record

Create one JSON record from the design schema. Derive rates only after validating
bytes and elapsed:

~~~powershell
$Bytes = [double]100000000
$ElapsedMs = [double]25000
$Seconds = $ElapsedMs / 1000
$EffectiveMBps = ($Bytes / 1000000) / $Seconds
$EffectiveMbps = (($Bytes * 8) / 1000000) / $Seconds
[pscustomobject]@{
  bytes_transferred=[int64]$Bytes
  elapsed_ms=[int64]$ElapsedMs
  effective_MBps=[Math]::Round($EffectiveMBps,3)
  effective_Mbps=[Math]::Round($EffectiveMbps,3)
}
~~~

## 13. Analysis workflow

### Task 6: Validate raw evidence before summarizing
- Confirm each run ID is unique.
- Confirm source/image/path/fixture identities exist.
- Recompute MB/s and Mbps from raw bytes and elapsed.
- Confirm no secret-bearing fields, URLs, headers, or private content.
- Confirm CONFIG-LIMITED rows have no throughput value.

### Task 7: Produce summaries
For every Path x Workload x Size group: sample count, median, min/max, optional mean, limitation.

### Task 8: Evaluate hypotheses
Cite exact run IDs under support, falsification, and distinction.
Verdicts: `SUPPORTED_WITHIN_TESTED_SCOPE`, `NOT_SUPPORTED_WITHIN_TESTED_SCOPE`, `MIXED`, `NOT_PROVEN`.

## 14. Future controlled optimization gate — not authorized now

~~~text
CORE_PERFORMANCE_MUTATION_GATE = PRE_FIX_BASELINES_CAPTURED
PERFORMANCE_MUTATION_AUTHORIZED = NO
PUBLIC_SHARE_SPECIFIC_MUTATION_GATE = PRE_FIX_BASELINE_CAPTURED
PUBLIC_SHARE_MUTATION_AUTHORIZED = NO
SHARED_MUTATION = BLOCKED_PENDING_DIAGNOSIS
~~~

All performance mutations remain forbidden until root-cause diagnosis is established and Human Owner explicitly authorizes optimization work in a separate task.

### 14.1 Change-impact classification

Future optimization proposals must distinguish:
- **CASE A: PUBLIC-SHARE-ONLY CHANGE**:
  - Surfaces: cloudflared connector, Public Share Gateway only, Cloudflare Tunnel configuration.
  - If authorized by Human Owner, C1 may be re-run POST-FIX without invalidating an untouched P1 baseline, provided no shared surfaces are touched.
- **CASE B: SHARED SERVER / APPLICATION CHANGE**:
  - Surfaces: Drive app, file read/streaming implementation, storage, server NIC, host network, Docker resources, shared reverse proxy, OS TCP tuning, filesystem parameters, common resource limits.
  - Rule: **STRICTLY BLOCKED** before P1 PRE-FIX baseline is complete. Applying Case B changes before P1 PRE-FIX permanently invalidates the pre-fix state of the P1 baseline.

An optimization experiment requires a separate approved task containing:
1. Baseline evidence across both P1 and P2;
2. Differentiating hypothesis evidence;
3. One changed variable;
4. Security/integrity/resource acceptance criteria;
5. Rollback;
6. Identical POST-FIX matrix verification (36 runs);
7. Human Owner Production authorization.

Candidate variables include chunk size, concurrency, worker count, cache policy,
media profile, and proxy behavior. Network, Twingate, Cloudflare, firewall, Docker,
storage, database, or file-limit changes remain prohibited.

## 15. Cleanup ledger

| Resource | Identifier class | Created by study | Cleanup action | Result |
|---|---|---:|---|---|
| Files fixture | sanitized study name | yes | delete through UI after all dependent runs | pending |
| Vault fixture | sanitized study name | yes | trash/allowed cleanup through UI; no destructive purge | pending |
| Public link | run ID only; never bearer | yes | revoke through UI; verify post-revoke block | pending |
| Client fixture | exact local path `C:\Users\User\AEGIS-LFT-PERF-1` | yes | retain for comparison; checksum verified | active |
| Evidence | outside-repo directory | yes | retain sanitized required set | active |

## 16. Phase completion reports

Return standard completion format after each phase.

## 17. Planning-task validation

Before this Draft PR is handed to the Human Owner:
- [x] Design contains architecture/evidence vocabulary and historical inventory.
- [x] Exact decimal size ladder and 10 GB policy present.
- [x] Core 2-path matrix (P1, P2) and supplementary paths defined.
- [x] Round 1 S/M/L fast triage and conditional Round 2 XL/XXL gate present.
- [x] Validated upload (in-page XHR tracer) and download (PowerShell observer) methods documented.
- [x] Phase B0 Production baseline recorded as EXECUTED with exact observed values.
- [x] P2 Remote PRE-FIX recorded as EXECUTED with 18 controlled runs.
- [x] Phase C1 Public Share PRE-FIX recorded as EXECUTED with 9 valid runs.
- [x] Phase P1 Onsite Direct LAN PRE-FIX recorded as EXECUTED with 18 controlled runs.
- [x] Total 45 valid controlled runs recorded (36/36 core + 9 supplementary).
- [x] Root-cause diagnosis framed as immediate next gate.
- [x] Core and shared performance mutation gates strictly blocked pending diagnosis.
- [x] Separate storage capacity/accounting defect recorded as unaddressed blocker.
- [x] No secrets, bearer links, credentials, or private content present.

## 18. Self-review record

Harness decision: HARNESS_ADDED=NO. Validated in-page XHR tracer and PowerShell
download observer cover measurement requirements without adding permanent
repository automation or secret-handling surfaces.

## 19. Draft-state truth

~~~text
TASK=LFT-PERF-1
STATUS=IN_PROGRESS / PRE-FIX BASELINES COMPLETE (P1, P2, C1) / DIAGNOSIS PENDING
HUMAN_REVIEW_REQUIRED=YES
PRODUCTION_MUTATED=NO
PERFORMANCE_SETTINGS_CHANGED=NO
NETWORK_CONFIGURATION_CHANGED=NO
TRANSFER_CONFIGURATION_CHANGED=NO
OPTIMIZATION_EXECUTED=NO
HARNESS_ADDED=NO
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

## 20. Task 1 Human probe packet — one upload probe, one download probe (prepared 2026-09-29, NOT EXECUTED)

Diagnosis and rationale: study design §23. Both probes run in the browser tab of the same reference client used for PRE-FIX. Neither probe changes configuration, restarts or recreates a service, or needs SSH. Both use only the Human Owner's own authenticated session. They print no cookie, CSRF token, or session identifier. Upload session ids are replaced with ordinals before printing.

This is **not** the POST-FIX 36-run matrix. Accepted PRE-FIX values are not rewritten. Probe numbers are compared only with the probe's own in-session single-stream baseline.

### 20.1 Upload probe U1 — does a second in-flight PUT raise aggregate throughput?

- Path: **P2 Remote/Twingate** (primary target, and the path with the largest per-request RTT). Twingate ON, same client and browser as PRE-FIX.
- Traffic generated: three normal 300,000,000 B Files uploads (about 900 MB total). Nothing else is written. The three probe files can be deleted afterwards through the normal Files UI.
- Why it discriminates: the app already starts every file of one picker selection concurrently (`UploadDrawer.jsx` `enqueue`), with one chunk in flight each. Two files selected together therefore produce exactly two concurrent PUTs over the same HTTP/2 connection and HUB route as Task 2 would, without any code change.
- Fixtures: three distinct names so that no upload takes the new-version path, created from the PRE-FIX `M-300MB` fixture, for example in PowerShell: `Copy-Item .\M-300MB.bin .\U1-a.bin; Copy-Item .\M-300MB.bin .\U1-b.bin; Copy-Item .\M-300MB.bin .\U1-c.bin`.

Steps:

1. Open Drive → Files (an empty test folder is fine). Open DevTools Console and paste:

~~~javascript
(() => {
  const P = window.__AEGIS_LFT_PROBE__ = { runs: [], cur: null,
    start(label) { this.cur = { label, puts: [] }; this.runs.push(this.cur); return label },
    report() {
      const r = this.cur; if (!r || !r.puts.length) return null
      const ids = [...new Set(r.puts.map(p => p.sid))]
      const per = ids.map((sid, i) => {
        const ps = r.puts.filter(p => p.sid === sid).sort((a, b) => a.send - b.send)
        const gaps = ps.slice(1).map((p, k) => p.send - ps[k].end)
        const med = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null }
        const bytes = ps.reduce((a, p) => a + p.bytes, 0)
        const span = ps[ps.length - 1].end - ps[0].send
        return { file: i + 1, puts: ps.length, bytes, spanMs: Math.round(span),
          MBps: +(bytes / 1e6 / (span / 1000)).toFixed(3),
          medBodyMs: Math.round(med(ps.map(p => p.bodySent - p.send))),
          medTailMs: Math.round(med(ps.map(p => p.end - p.bodySent))),
          sumGapMs: Math.round(gaps.reduce((a, g) => a + g, 0)),
          allHttp200: ps.every(p => p.status === 200) }
      })
      const t0 = Math.min(...r.puts.map(p => p.send)), t1 = Math.max(...r.puts.map(p => p.end))
      const bytes = r.puts.reduce((a, p) => a + p.bytes, 0)
      return { label: r.label, files: per.length, aggregateBytes: bytes, unionSpanMs: Math.round(t1 - t0),
        aggregateMBps: +(bytes / 1e6 / ((t1 - t0) / 1000)).toFixed(3), perFile: per }
    } }
  const open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send
  XMLHttpRequest.prototype.open = function (m, u, ...rest) { this.__m = m; this.__u = String(u); return open.call(this, m, u, ...rest) }
  XMLHttpRequest.prototype.send = function (body) {
    const m = this.__m === 'PUT' && /\/api\/files\/uploads\/([^/]+)\/chunks\//.exec(this.__u)
    if (m && P.cur) {
      const rec = { sid: m[1], send: performance.now(), bodySent: null, end: null, bytes: body?.size ?? 0, status: 0 }
      this.upload.addEventListener('load', () => { rec.bodySent = performance.now() })
      this.addEventListener('loadend', () => { rec.end = performance.now(); rec.status = this.status; if (rec.bodySent === null) rec.bodySent = rec.end; P.cur.puts.push(rec) })
    }
    return send.call(this, body)
  }
  return 'probe installed'
})()
~~~

2. Run A (single): `__AEGIS_LFT_PROBE__.start('U1-A-single')`, then upload `U1-a.bin` alone and wait for Complete. Run `JSON.stringify(__AEGIS_LFT_PROBE__.report())` and copy the output.
3. Run B (dual): `__AEGIS_LFT_PROBE__.start('U1-B-dual')`, then select **both** `U1-b.bin` and `U1-c.bin` **in one picker selection**, and wait for both to Complete. Run `JSON.stringify(__AEGIS_LFT_PROBE__.report())` and copy the output.
4. Return both JSON lines. Optionally delete the probe files through the normal Files UI.

Expected observations: A `aggregateMBps` near the PRE-FIX P2 upload (~3.0 MB/s), 18 PUTs, all HTTP 200. `medBodyMs` and `medTailMs` split each PUT into body-send time and post-body time (in-flight bytes plus server write tail, DB ack, and the response RTT). `sumGapMs` shows the client idle gaps between PUTs.

**Decision rule U1** (R = B.aggregateMBps ÷ A.aggregateMBps; any non-200 PUT or retry invalidates the pair, so repeat once):

| Result | Classification | Consequence |
|---|---|---|
| R ≥ 1.50 | `PROVEN_PER_REQUEST_SERIALIZATION_OR_PER_STREAM_LIMITER` (application-side lever: more than one in-flight chunk is useful) | Task 2 (bounded Normal Files concurrency, default 2) is justified |
| R ≤ 1.15 | `PROVEN_SHARED_PATH_CAPACITY_LIMITER` (concurrency is not a useful lever on this path) | `TASK2=SKIPPED_CAUSE_MISMATCH`. Diagnose the shared path next (plan amendment required) |
| 1.15 < R < 1.50 | `NOT_PROVEN` (partial gain) | Report it. Task 2 still requires Human Owner judgement |

Supporting read of run A: if `medTailMs + (sumGapMs ÷ PUTs)` is at least 25% of the mean PUT duration, per-request serialization overhead is material in its own right.

### 20.2 Download probe D1 — TTFB versus body, and per-stream versus shared capacity

- Path: **P1 Direct LAN** (Twingate OFF). P1 has the largest unexplained gap against C1: 7 MB/s against 12 MB/s from the same Drive read primitive.
- Traffic generated: three authenticated GETs of one existing Normal Files file (at least 300 MB) owned by the Human Owner. That is about 3× the file size. It writes nothing except the normal `FILE_DOWNLOAD` audit rows. Bytes are read in-page and discarded chunk by chunk, so nothing is saved to disk and tab memory stays bounded.
- Why it discriminates: it separates TTFB from body time on the real authenticated route, and compares one stream against two concurrent streams over the same HTTP/2 connection and HUB `proxy_buffering off` route.

Steps: open Drive → Files and paste into the Console, replacing only the file name:

~~~javascript
(async () => {
  const NAME = 'M-300MB.bin' // an existing root-level Files item of at least 300 MB
  const list = await (await fetch('/drive/api/files', { credentials: 'same-origin' })).json()
  const f = (list.files || []).find(x => x.name === NAME)
  if (!f) return 'file not found at root'
  const url = `/drive/api/files/${encodeURIComponent(f.id)}/download`
  const one = async (label) => {
    const t0 = performance.now()
    const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' })
    const tHdr = performance.now()
    const rd = res.body.getReader(); let bytes = 0, tFirst = null
    for (;;) { const { done, value } = await rd.read(); if (done) break; if (tFirst === null) tFirst = performance.now(); bytes += value.byteLength }
    const tEnd = performance.now()
    return { label, status: res.status, bytes, ttfbMs: Math.round(tHdr - t0), bodyMs: Math.round(tEnd - (tFirst ?? tHdr)),
      bodyMBps: +(bytes / 1e6 / ((tEnd - (tFirst ?? tHdr)) / 1000)).toFixed(3), t0, tEnd }
  }
  const A = await one('D1-A-single')
  const B = await Promise.all([one('D1-B-lane1'), one('D1-B-lane2')])
  const t0 = Math.min(...B.map(b => b.t0)), t1 = Math.max(...B.map(b => b.tEnd))
  const aggB = B.reduce((a, b) => a + b.bytes, 0) / 1e6 / ((t1 - t0) / 1000)
  const strip = ({ t0, tEnd, ...rest }) => rest
  return JSON.stringify({ size: f.size, A: strip(A), B: B.map(strip), aggregateBMBps: +aggB.toFixed(3),
    R: +(aggB / A.bodyMBps).toFixed(3), ttfbShareA: +((A.ttfbMs) / (A.ttfbMs + A.bodyMs)).toFixed(4) })
})()
~~~

Return the JSON line.

Expected observations: `status` 200 on every stream, and `bytes` equal to `size` on every stream. `A.bodyMBps` should be of the same order as the PRE-FIX P1 download (~7 MB/s). Fetch and the native download are different consumers, so only the in-session R is decisive.

**Decision rule D1** (R = aggregateBMBps ÷ A.bodyMBps):

| Result | Classification |
|---|---|
| `ttfbShareA` < 0.05 | Startup cost (auth, metadata, audit) is excluded as the throughput limiter |
| R ≥ 1.50 | `PROVEN_PER_STREAM_DOWNLOAD_LIMITER` (the HUB HTTP/2 stream / unbuffered proxy loop or the Node response stream per request; candidate for a separately authorized Task 5 diagnosis) |
| R ≤ 1.15 | `PROVEN_SHARED_PATH_CAPACITY_LIMITER` on P1 (LAN routing or HUB/Drive aggregate; no per-request application fix indicated) |
| otherwise | `NOT_PROVEN` |

D1 never authorizes Task 2. Download changes remain outside the approved Task 0–2 range.

## 21. U2 Direct-LAN upload and D1 Direct-LAN download probes (EXECUTED 2026-09-29)

Probes U2 and D1 were executed on P1 Direct LAN (wired Ethernet, Management VLAN30, Twingate OFF) by the Human Owner on 2026-09-29.

### 21.1 Authoritative U2 upload probe results

Executed with three 300,000,000 B binary fixtures on P1 Direct LAN using the in-page XHR tracer:

| Run | Files | PUTs per file | Aggregate Bytes | Union Span (ms) | Aggregate MB/s | Per-file MB/s | medBodyMs | medTailMs | sumGapMs | HTTP Status |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| **U2-A single** | 1 | 18 | 300,000,000 | 28,059 | **10.692** | 10.692 | 1,561 | 4 | -17 | all 200 |
| **U2-B dual** | 2 | 18 | 600,000,000 | 59,418 | **10.098** | 5.050 / 5.052 | 3,278 / 3,302 | 7 / 5 | -23 / -23 | all 200 |

~~~text
U2_R = 10.098 / 10.692 = 0.944
U2_VALID = YES
~~~

**Decision rule evaluation:**
- `R = 0.944 <= 1.15`
- Classification: `PROVEN_SHARED_PATH_CAPACITY_LIMITER on P1`.
- Consequence: Concurrency does not add throughput on P1 and degrades per-file completion. Task 2 upload concurrency remains blocked and not justified (`TASK2_UPLOAD_CONCURRENCY=SKIPPED_NOT_JUSTIFIED`).

### 21.2 Authoritative D1 download probe results

Executed on P1 Direct LAN with one root-level 300,000,000 B file (`M-300MB.bin`) using the authenticated in-page stream reader:

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

**Decision rule evaluation:**
- `ttfbShareA < 0.05`: Startup cost (auth, metadata, audit) is excluded as sustained throughput limiter.
- `R = 0.993 <= 1.15`: `PROVEN_SHARED_PATH_CAPACITY_LIMITER on P1`. Download throughput is bound by shared path capacity, not per-stream application serialization.

### 21.3 Live hardware telemetry and infrastructure reconciliation (PR #259)

Onsite preflight executed by Human Owner (reconciled with infrastructure PR #259, merged to `main` at `92d479675103988d36240ef219a9193a9a6dcdd4`; `PR259_STATE=MERGED`, `PR259_CURRENT_SCOPE_WORK=COMPLETE`):

- **MikroTik Router:** `board-name=hEX lite`, `model=RB750r2`, `revision=r3`, `RouterOS=7.18.2 stable` (`RB750R2_IDENTITY=PROVEN_LIVE`).
- **Router ether2 Trunk:** `rate=100Mbps`, `full-duplex=yes`, `status=link-ok` (`RB750R2_ETHER2_LINK=100MBPS_FULL_DUPLEX`).
- **TP-Link TL-SG105E Switch:** Port 1 router trunk = `100MF` (`TP_LINK_PORT1_TRUNK=100MF`), Port 2 Beelink = `1000MF`, Port 5 Admin client = `1000MF`.
- **Beelink Host:** `enp1s0` Speed: `1000Mb/s`, Duplex: `Full`, Link: `yes` (`BEELINK_LINK=1_GBPS_FULL`).
- **Admin Test Client:** `Realtek PCIe GbE Family Controller`, LinkSpeed: `1 Gbps` (`ADMIN_CLIENT_LINK=1_GBPS`).

**Classification:**
~~~text
RB750R2_IDENTITY=PROVEN_LIVE
RB750R2_ETHER2_LINK=100MBPS_FULL_DUPLEX
TP_LINK_PORT1_TRUNK=100MF
BEELINK_LINK=1_GBPS_FULL
ADMIN_CLIENT_LINK=1_GBPS
P1_ROUTER_TRUNK_100MBPS_CEILING=PROVEN_LIVE
CURRENT_LAN_THROUGHPUT_LIMITER=PROVEN_HARDWARE_PATH_LIMIT
P1_SHARED_PATH_CAPACITY_LIMITER=PROVEN_BY_U2_D1_AND_LIVE_NETWORK_TELEMETRY
CURRENT_PRODUCTION_ARCHITECTURE=RB750r2_PLUS_TL-SG105E
HARDWARE_REPLACEMENT_AUTHORIZED=NO
PROCUREMENT_AUTHORIZED=NO
PRODUCTION_CUTOVER_AUTHORIZED=NO
REPLACEMENT_WORK_STATE=DEFERRED_OPTIONAL_FUTURE_WORK
POST_FIX=NOT_STARTED
NEW_THROUGHPUT_TEST_EXECUTED=NO
PR259_STATE=MERGED
PR259_MERGE_COMMIT=92d479675103988d36240ef219a9193a9a6dcdd4
PR259_CURRENT_SCOPE_WORK=COMPLETE
~~~

## 22. Remote R1 diagnostic packet — from-home diagnosis (PREPARED / NOT EXECUTED)

- **Status:** `PREPARED / NOT_EXECUTED`.
- **Purpose:** Characterize the Remote P2 path from the home environment to determine whether the residual remote limiter (~3.0 MB/s upload, ~4.8–5.1 MB/s download) is bound by external ISP uplink/downlink, Twingate relay vs direct mode, or transport windowing.
- **Constraints:** No Production configuration mutation; do NOT invent or fabricate results.

### 22.1 Scope of Remote R1 diagnostic packet

When executed from the remote home environment:

1. **Step 1: Baseline ISP speed test (Twingate OFF)**
   - Measure raw client Internet upload and download bandwidth using a standard commercial speed test (e.g., speedtest.net or fast.com).
   - Record: Download Mbps, Upload Mbps, latency / ping ms.

2. **Step 2: Twingate connection state observation**
   - Connect Twingate client to AEGIS resource.
   - Inspect Twingate client / connector connection mode if observable via client status / console:
     - Record: `Direct (P2P / STUN)` vs `Relayed (Twingate Relay)`.
     - Record any visible MTU, latency, or relay indicators.

3. **Step 3: P2 download probe D1-Remote (Twingate ON)**
   - Execute the standard D1 measurement methodology (§20.2) over P2 Remote with Twingate ON against the same root-level 300,000,000 B file (`M-300MB.bin`).
   - Run D1-A single and D1-B dual lanes.
   - Record: TTFB ms, body ms, body MB/s, aggregate MB/s, and in-session R.

4. **Step 4: Report results**
   - Return raw values for ISP speed, connection mode, and D1-Remote.
   - Compare D1-Remote R against P1 D1 (`R=0.993`).

## 23. P1 Direct LAN Final Report Measurement (Executed 2026-10-02)

- **Date:** 2026-10-02
- **Environment:** Onsite P1 Direct LAN (`192.168.30.98`) -> Production Drive Host (`192.168.10.10:443`)
- **Classification:** `FINAL_REPORT_MEASUREMENT` (Explicitly: `NOT PRE_FIX`, `NOT POST_FIX`)
- **Status:** `LAN_FINAL_REPORT_MEASUREMENT=COMPLETE` (18/18 valid runs: 9 upload, 9 download)

### 23.1 Path verification and environment sanity check

Path reachability and interface verification executed prior to measurement:
~~~text
P1_DIRECT_LAN=PASS
TcpTestSucceeded=True
SourceAddress=192.168.30.98
InterfaceAlias=Ethernet
RemoteTarget=192.168.10.10:443
FINAL_PATH_SANITY_CHECK=PASS
~~~
Twingate client was NOT used for the final LAN measurement. The test client operated via physical Ethernet on VLAN 30 (`192.168.30.98`), routing directly across the router trunk to VLAN 10 (`192.168.10.10:443`).

### 23.2 Upload final report measurement (P1 Direct LAN)

Executed across standard fixture sizes (100 MB, 300 MB, 1 GB) using the authenticated in-page XHR tracer method:

| Fixture | Run | Measured MB/s | Chunks | Status | Bytes | Notes |
|---|---|---:|---:|---|---:|---|
| **100 MB** | r01 | 10.534 | 6 | allHttp200=true | 100,000,000 | Tracer label: `LU-S-warmup` (`TRACER_LABEL_MISMATCH_ONLY`) |
| **100 MB** | r02 | 10.735 | 6 | allHttp200=true | 100,000,000 | Tracer label: `LU-S-warmup` (`TRACER_LABEL_MISMATCH_ONLY`) |
| **100 MB** | r03 | 10.588 | 6 | allHttp200=true | 100,000,000 | Tracer label: `LU-S-warmup` (`TRACER_LABEL_MISMATCH_ONLY`) |
| **300 MB** | r01 | 10.752 | 18 | allHttp200=true | 300,000,000 | Clean run |
| **300 MB** | r02 | 10.729 | 18 | allHttp200=true | 300,000,000 | Clean run |
| **300 MB** | r03 | 10.757 | 18 | allHttp200=true | 300,000,000 | Clean run |
| **1 GB** | r01 | 10.608 | 60 | allHttp200=true | 1,000,000,000 | Clean run |
| **1 GB** | r02 | 10.591 | 60 | allHttp200=true | 1,000,000,000 | Clean run |
| **1 GB** | r03 | 10.557 | 60 | allHttp200=true | 1,000,000,000 | Clean run |

**Upload Medians:**
- 100 MB median: **10.588 MB/s**
- 300 MB median: **10.752 MB/s**
- 1 GB median: **10.591 MB/s**
- Overall Upload Median across all sizes: **~10.6 MB/s**

**Methodological Notes:**
- `LAN_UPLOAD_VALID_RUNS=9/9`.
- **Tracer Label Anomaly:** In the 100 MB upload set, individual measured runs retained the harness label `LU-S-warmup` in console output despite being distinct measured runs. Preserved honestly as `TRACER_LABEL_MISMATCH_ONLY`. The underlying byte counts (100,000,000 B), chunk counts (6 × 16 MiB chunks), HTTP 200 statuses, and timing sequences are verified and valid.

### 23.3 Download final report measurement (P1 Direct LAN)

Executed across standard fixture sizes (100 MB, 300 MB, 1 GB) using the authenticated in-page stream reader with SHA-256 integrity verification:

| Fixture | Run | Measured MB/s | HTTP | SHA-256 Digest | Integrity |
|---|---|---:|---|---|---|
| **100 MB** | r01 | 11.143 | 200 | `f079cad53add0091ed5d0409b0469f9f5cb745b8c280be685dda73203dea90e8` | PASS |
| **100 MB** | r02 | 11.006 | 200 | `f079cad53add0091ed5d0409b0469f9f5cb745b8c280be685dda73203dea90e8` | PASS |
| **100 MB** | r03 | 11.042 | 200 | `f079cad53add0091ed5d0409b0469f9f5cb745b8c280be685dda73203dea90e8` | PASS |
| **300 MB** | r01 | 11.279 | 200 | `81ba1dbe05118eab211ea9b613860870950891052c7784ce9ba6aabd44c42efb` | PASS |
| **300 MB** | r02 | 10.954 | 200 | `81ba1dbe05118eab211ea9b613860870950891052c7784ce9ba6aabd44c42efb` | PASS |
| **300 MB** | r03 | 11.068 | 200 | `81ba1dbe05118eab211ea9b613860870950891052c7784ce9ba6aabd44c42efb` | PASS |
| **1 GB** | r01 | 10.994 | 200 | `3e6f285b2180c18eab7f808ed59d9b30a5b8400734b9cf0f447a6bb5dce7e188` | PASS |
| **1 GB** | r02 | 10.958 | 200 | `3e6f285b2180c18eab7f808ed59d9b30a5b8400734b9cf0f447a6bb5dce7e188` | PASS |
| **1 GB** | r03 | 11.029 | 200 | `3e6f285b2180c18eab7f808ed59d9b30a5b8400734b9cf0f447a6bb5dce7e188` | PASS |

**Download Medians:**
- 100 MB median: **11.042 MB/s**
- 300 MB median: **11.068 MB/s**
- 1 GB median: **10.994 MB/s**
- Overall Download Median across all sizes: **~11.0 MB/s**

**Methodological Notes & Excluded Observer Attempt:**
- `LAN_DOWNLOAD_VALID_RUNS=9/9`.
- `DOWNLOAD_INTEGRITY=PASS` (all 9 runs matched expected byte-exact SHA-256 digests).
- **Excluded Pilot Attempt:** An initial attempt on `LD-S-r01` suffered a test harness final file resolution failure (`FINAL_FILE resolution failed / ambiguous`).
  ~~~text
  RESULT=EXCLUDED
  REASON=FINAL_FILE_RESOLUTION_FAILED
  ~~~
  This attempt was formally excluded from the 9-run dataset. Its derived result and stale hash variable are not used.

### 23.4 Summary and interpretation boundary

~~~text
LAN_UPLOAD_VALID_RUNS=9/9
LAN_DOWNLOAD_VALID_RUNS=9/9
LAN_TOTAL_VALID_MEASURED_RUNS=18/18
LAN_FINAL_REPORT_MEASUREMENT=COMPLETE
P1_DIRECT_LAN=PASS
FINAL_PATH_SANITY_CHECK=PASS
DOWNLOAD_INTEGRITY=PASS
~~~

**Interpretation Boundary:**
- Sustained LAN throughput sits cleanly at **Upload ~10.6 MB/s** and **Download ~11.0 MB/s**.
- These figures reflect **~85–88 Mbps wire payload rate**, perfectly consistent with the live hardware telemetry established by infrastructure PR #259 (MikroTik RB750r2 `ether2` 100 Mbps full duplex trunk ceiling, TL-SG105E Port 1 100MF trunk).
- **Strict Boundary:** Do NOT claim:
  - a new application optimization (none was applied);
  - `POST_FIX` (no post-fix code or config was deployed);
  - network remediation (the 100 Mbps inter-VLAN trunk is unchanged);
  - router replacement;
  - Twingate as the sole remote root cause;
  - Remote throughput closure.

### 23.5 Remote next sequence and onsite revisit policy

**Remote R1 Status:** `COMPLETE` (executed 2026-10-02 / 2026-10-03; see §24).

**Decision:** `Path B: NO_SAFE_FIX_PROVEN` selected. No Production mutation; Remote residual limitation documented; throughput workstream closed.

**Onsite Revisit Policy:**
~~~text
ONSITE_REVISIT_REQUIRED = NO
~~~
- Because no application fix is implemented, no LAN re-verification is required.
- Historical PRE-FIX baseline (PR #216) and live physical-path evidence (PR #259) remain unchanged and cross-referenced.

## 24. Remote R1 Diagnostic Packet Execution & Final Decision (Executed 2026-10-02 / 2026-10-03)

- **Date:** 2026-10-02 / 2026-10-03
- **Environment:** Remote Client via Twingate -> Production Drive Host (`192.168.10.10:443`)
- **Status:** `REMOTE_R1=COMPLETE`

### 24.1 R1-A Remote Path Verification & Twingate Activity

- **Client physical link:** Wi-Fi (Intel Wi-Fi 6E AX211, LinkSpeed=866.7 Mbps)
- **Twingate Client IP:** `100.127.255.164`
- **AEGIS Path Verification:**
  - Remote Target: `192.168.10.10:443`
  - `TcpTestSucceeded=True`
  - `SourceAddress=100.127.255.164`
  - `InterfaceAlias=Twingate`
- **Twingate Admin Activity Telemetry:**
  - Resource: `aegis.internal`
  - Protocol/Port: `TCP/443`
  - Connector: `aegis-connector-02`
  - Connection Type: `Peer to peer` (verified by Twingate activity event showing "Established peer-to-peer connection" / Connection Type "Peer to peer")
  - STUN Discovery: `Available` (supporting telemetry, not itself the proof of P2P)
- **Classification:**
  ~~~text
  TWINGATE_CONNECTION = P2P
  TWINGATE_RELAY_PATH = NO
  TWINGATE_RELAY_BOTTLENECK = NOT_APPLICABLE
  ~~~

### 24.2 R1-B Single Remote Upload

Executed with one 300,000,000 B fixture using the in-page XHR tracer:

- **Run Label:** `RU-M-r01`
- **Total Bytes:** 300,000,000 bytes
- **Chunks:** 18 chunks
- **Chunk Span:** 107,690.4 ms
- **Throughput:** **2.786 MB/s**
- **HTTP Status:** All 18 PUTs returned HTTP 200 (`allHttp200=true`)
- **Classification:** `REMOTE_SINGLE_UPLOAD=PASS`, `REMOTE_UPLOAD_MBPS=2.786`

### 24.3 R1-C Single Remote Download

Executed with one 300,000,000 B fixture using the authenticated download stream observer:

- **Run ID:** `RD-M-r01`
- **Total Bytes:** 300,000,000 bytes
- **Download Duration:** 71,331 ms
- **Throughput:** **4.206 MB/s**
- **SHA-256 Digest:** `81ba1dbe05118eab211ea9b613860870950891052c7784ce9ba6aabd44c42efb`
- **Integrity Result:** `HASH_PASS=True`
- **Classification:** `REMOTE_SINGLE_DOWNLOAD=PASS`, `REMOTE_DOWNLOAD_MBPS=4.206`

### 24.4 R1-D Dual Remote Download

Executed with exactly two concurrent 300,000,000 B downloads:

- **Run ID:** `RD-M-dual-r01`
- **Concurrency:** Exactly 2 concurrent downloads (authoritative controlled run; an accidental screenshot showing 3 visible downloads was clarified by Human Owner as not reflecting the controlled test; the recorded test runner output is authoritative).
- **Span:** 144,906 ms
- **Aggregate Throughput:** **4.141 MB/s**
- **Integrity:** `HASH1_PASS=True`, `HASH2_PASS=True` (both streams byte-exact verified)
- **Single Download Reference:** 4.206 MB/s
- **Dual/Single Ratio:**
  ~~~text
  DUAL_SINGLE_RATIO = 4.141 / 4.206 ≈ 0.985
  ~~~
- **Classification:**
  ~~~text
  REMOTE_DUAL_DOWNLOAD = PASS
  REMOTE_DUAL_AGGREGATE_MBPS = 4.141
  REMOTE_SHARED_THROUGHPUT_CEILING = OBSERVED
  ~~~
  The single-versus-dual probe observed a flat aggregate throughput ceiling (~0.985 ratio), showing that concurrency did not increase aggregate Remote throughput. This is consistent with a shared Remote-path/channel ceiling, but the exact limiting component is not proven.

### 24.5 R1-E Server Read-Only Telemetry

Server telemetry captured during remote traffic:

- **Host Uptime / Load:** load average ≈ 1.22 / 1.33 / 1.33 (well within Beelink 4-core capacity)
- **Host Memory:** Total 7.0 GiB, Used 1.7 GiB, Available 5.3 GiB (75% free)
- **Host Swap:** Total 4.0 GiB, Used 1.8 GiB, vmstat `si`/`so` ≈ 0 throughout observation (zero active paging)
- **Host Filesystem:** Root `/` 89 GiB total, 55 GiB used, 30 GiB available (66% utilization)
- **Host vmstat:** CPU idle 92–98%, I/O wait 0%, no blocking process queue pressure
- **Container Telemetry Snapshot:**
  - `aegis-prod-drive-1`: CPU 0.00%, MEM 127.5 MiB / 7.035 GiB (1.77%)
  - `twingate-aegis-connector-02`: CPU 8.68%, MEM 31.72 MiB / 7.035 GiB (0.44%)
- **Methodological Note on Docker NET I/O:** Docker NET I/O metrics represent cumulative counters since container creation, not instantaneous link transfer rates, and must not be cited as bandwidth metrics.
- **Classification:**
  ~~~text
  SERVER_CPU_SATURATION = NOT_OBSERVED
  SERVER_MEMORY_PRESSURE = NOT_OBSERVED
  SERVER_IO_WAIT_BOTTLENECK = NOT_OBSERVED
  DRIVE_CONTAINER_RESOURCE_PRESSURE = NOT_OBSERVED
  TWINGATE_CONNECTOR_RESOURCE_PRESSURE = NOT_OBSERVED
  ~~~

### 24.6 Home ISP Baseline

Measured from the remote client home connection:

- **Twingate OFF (Primary Baseline):**
  - Download: **58.65 Mbps**
  - Upload: **28.40 Mbps**
  - Latency / Ping: **5 ms**
- **Twingate ON (Supplementary Baseline):**
  - Download: **58.33 Mbps**
  - Upload: **28.53 Mbps**
  - Latency / Ping: **4 ms**
- **Interpretation Boundary:**
  - Ordinary Internet Speedtest traffic under Twingate ON does not prove traversal of the AEGIS Twingate Resource tunnel (split tunneling / direct bypass).
  - Twingate OFF numbers serve as the primary local ISP baseline.
  - Do NOT claim: `TWINGATE_HAS_ZERO_OVERHEAD`.
  - Record: `HOME_ISP_BASELINE_AVAILABLE=YES`.

### 24.7 Final Remote Classification and Workstream Closure

~~~text
REMOTE_R1 = COMPLETE
APPLICATION_UPLOAD_DEFECT = NOT_PROVEN
APPLICATION_DOWNLOAD_DEFECT = NOT_PROVEN
SERVER_RESOURCE_BOTTLENECK = NOT_OBSERVED
TWINGATE_CONNECTION = P2P
TWINGATE_RELAY_BOTTLENECK = NOT_APPLICABLE
REMOTE_SHARED_THROUGHPUT_CEILING = OBSERVED
EXACT_REMOTE_ROOT_CAUSE = NOT_PROVEN
SAFE_APPLICATION_FIX_PROVEN = NO
SIMPLE_SAFE_FIX_PROVEN = NO
PERFORMANCE_MUTATION_AUTHORIZED = NO
PERFORMANCE_MUTATION_PERFORMED = NO
FINAL_DECISION = NO_SAFE_FIX_PROVEN
ONSITE_REVISIT_REQUIRED = NO
~~~

**Throughput Workstream Verdict:**
- Because no application defect is proven and no safe, bounded application fix exists, no code or configuration changes will be made to Production.
- The single-versus-dual probe observed a flat aggregate throughput ceiling (~0.985 ratio), showing that concurrency did not increase aggregate Remote throughput. This is consistent with a shared Remote-path/channel ceiling, but the exact limiting component is not proven.
- Remote transfer performance (~2.8 MB/s upload, ~4.1–4.2 MB/s download) reflects observed Remote-path characteristics; no application defect is proven.
- Throughput workstream is formally closed with documented limitations.
