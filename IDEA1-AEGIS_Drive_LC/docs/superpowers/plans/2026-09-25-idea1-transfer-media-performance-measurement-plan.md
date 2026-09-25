# AEGIS IDEA1 Transfer and Media Performance Measurement Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to execute repository-local preparation tasks. Production phases are Human Owner only and require separate authorization. Steps use checkbox syntax for tracking.

**Goal:** Produce reproducible, machine-readable evidence that localizes AEGIS transfer and media-preview bottlenecks without changing Production performance settings.

**Architecture:** Historical evidence and current-source facts define a fixed
matrix. The core PRE/POST experiment evaluates exactly TWO primary network paths:
P1 (Onsite Direct LAN) and P2 (Remote + Twingate). Historical browser tracer labels
using P3 map directly: `HISTORICAL_RUN_LABEL_P3 = FINAL_METHODOLOGY_P2_REMOTE_TWINGATE`.
Human-run Production phases measure one path/workload/fixture at a time,
pair browser timing with client/server resource samples, and classify
configuration limits separately from transfer failures.
Phase B0 Production baseline is EXECUTED. Phase P2 Remote PRE-FIX (18 controlled runs) is EXECUTED.
Phase P1 Onsite Direct LAN PRE-FIX (18 runs) is the IMMEDIATE NEXT GATE.
Optimization remains a later owner-authorized task, strictly blocked until P1 PRE-FIX is complete.

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
- `PERFORMANCE_MUTATION_GATE=BLOCKED_PENDING_P1_PRE_FIX`.
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
- P2 Remote + Twingate PRE-FIX: **18/18 COMPLETE** (Upload S/M/L ×3, Download S/M/L ×3).
- P1 Onsite Direct LAN PRE-FIX: **18/18 PENDING_ONSITE** (Upload S/M/L ×3, Download S/M/L ×3).
- Core PRE-FIX overall: **18/36 COMPLETE**.
- POST-FIX: **0/36 NOT STARTED**.
- Optimization: **BLOCKED** pending P1 PRE-FIX.

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

## 7. Phase B1 — P1 Onsite Direct LAN PRE-FIX baseline (IMMEDIATE NEXT GATE)

### Prerequisites

- Human laptop physically on site.
- Connected via wired Ethernet / Management VLAN30 (e.g. client IP `192.168.30.x`, gateway `192.168.30.1`).
- Direct internal AEGIS access: `192.168.10.10:443`.
- Twingate OFF and Cloudflare not in path.
- Disposable test files/folders only.
- Phase B0 executed and verified; no unrelated heavy load.

### Target test matrix (18 controlled runs)

1. **Files Upload (T1)**:
   - S (100 MB) × 3 repetitions (r01, r02, r03)
   - M (300 MB) × 3 repetitions (r01, r02, r03)
   - L (1 GB) × 3 repetitions (r01, r02, r03)
2. **Files Download (T3)**:
   - S (100 MB) × 3 repetitions (r01, r02, r03)
   - M (300 MB) × 3 repetitions (r01, r02, r03)
   - L (1 GB) × 3 repetitions (r01, r02, r03)

Capture in-page XHR chunk span for upload; capture PowerShell observer timing for download.
Verify exact downloaded byte sizes and SHA-256 hashes against fixture manifest.

Stop conditions: container health degradation, restart/OOM, integrity mismatch, unexpected 5xx.
Cleanup: remove only study-owned disposable files via UI. Do NOT use destructive purge.

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

## 10. Phase B4 — P4 Cloudflare Public Share baseline (Supplementary)

Supplementary future measurement. Download/redemption oriented only.
Do not reopen Public Share security architecture. `CLOUDFLARE_BOTTLENECK=NOT_PROVEN`.

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
PERFORMANCE_MUTATION_GATE=BLOCKED_PENDING_P1_PRE_FIX
~~~

All performance mutations remain forbidden until the P1 Onsite Direct LAN PRE-FIX
baseline (18 runs) is captured and Human Owner authorizes optimization work.

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
- [x] P1 Onsite Direct LAN PRE-FIX framed as immediate next gate.
- [x] Performance mutation gate strictly blocked pending P1 PRE-FIX.
- [x] No secrets, bearer links, credentials, or private content present.

## 18. Self-review record

Harness decision: HARNESS_ADDED=NO. Validated in-page XHR tracer and PowerShell
download observer cover measurement requirements without adding permanent
repository automation or secret-handling surfaces.

## 19. Draft-state truth

~~~text
TASK=LFT-PERF-1
STATUS=IN_PROGRESS / REMOTE PRE-FIX MEASUREMENTS COMPLETE / ONSITE PENDING
HUMAN_REVIEW_REQUIRED=YES
PRODUCTION_MUTATED=NO
PERFORMANCE_SETTINGS_CHANGED=NO
OPTIMIZATION_EXECUTED=NO
HARNESS_ADDED=NO
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
