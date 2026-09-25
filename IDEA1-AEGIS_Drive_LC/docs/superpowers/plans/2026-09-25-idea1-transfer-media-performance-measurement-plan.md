# AEGIS IDEA1 Transfer and Media Performance Measurement Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to execute repository-local preparation tasks. Production phases are Human Owner only and require separate authorization. Steps use checkbox syntax for tracking.

**Goal:** Produce reproducible, machine-readable evidence that localizes AEGIS transfer and media-preview bottlenecks without changing Production performance settings.

**Architecture:** Historical evidence and current-source facts define a fixed
matrix. Human-run Production phases measure one path/workload/fixture at a time,
pair browser timing with client/server resource samples, and classify
configuration limits separately from transfer failures. Optimization remains a
later owner-authorized task.

**Tech Stack:** AEGIS Drive React/Express, PostgreSQL 15, Docker, browser
DevTools, PowerShell, FFmpeg/FFprobe, SHA-256, JSON Lines/CSV.

**Spec:** IDEA1-AEGIS_Drive_LC/docs/superpowers/specs/2026-09-25-idea1-transfer-media-performance-study-design.md

## Global constraints

- Production execution is Human Owner only.
- No SSH, Production command, benchmark, upload, download, or share action is
  executed by the planning agent.
- Baseline changes no Twingate, Cloudflare, Docker network, firewall, sysctl,
  chunk size, concurrency, file limit, worker count, media profile, schema,
  storage mount, or application configuration.
- No password, cookie, session/CSRF token, bearer link, Vault key, wrapped key,
  plaintext private content, or secret-bearing environment output enters evidence.
- Current Production values are measured; source defaults are not substituted.
- 10 GB never causes a limit increase. Rejection before transfer is
  EXPECTED_CONFIG_LIMIT and NETWORK_PERFORMANCE=NOT_MEASURED.
- Destructive purge remains false. TREE_V1/migration 011 state is observed only.
- Public Share security rollout is not reopened.
- No final receipt is created for this Draft planning task.

## Review focus

1. A 5/10 GB configuration rejection must not be charted as zero throughput.
2. Public bearer links must never appear in command lines, HAR exports, filenames,
   shell history, JSON, CSV, screenshots, or report prose.
3. Media comparisons must pair size with codec, bitrate, resolution, duration,
   keyframe/index placement, and cache state.
4. P1/P2/P3 comparisons must change only the path and preserve fixture/client/
   server conditions where practical.
5. Sparse structural fixtures must never be used as throughput evidence.

---

## File map

| Path | Responsibility |
|---|---|
| docs/superpowers/specs/2026-09-25-idea1-transfer-media-performance-study-design.md | Research contract, evidence inventory, matrix, hypotheses, decision framework |
| docs/superpowers/plans/2026-09-25-idea1-transfer-media-performance-measurement-plan.md | Human-run phases, commands, evidence naming, stop/cleanup gates |
| Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md | Canonical PLANNED/DRAFT registration only |

No benchmark harness code is added in this Draft. Existing browser, OS, Docker,
FFmpeg, and hashing tools are sufficient to review the method first. This avoids
premature Production-capable automation and any secret/token handling surface.

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
fixture.json. Raw HAR files remain local and are never committed; preferably
record sanitized timing fields manually instead of exporting HAR.

## 2. Deterministic generic fixtures

### Task 1: Generate exact-size payloads locally

**Produces:** five deterministic local binary files and SHA-256 manifest.

- [ ] **Step 1: Confirm free space**

~~~powershell
Get-Volume | Select-Object DriveLetter,FileSystem,Size,SizeRemaining
~~~

Stop if available space cannot hold fixtures plus downloaded copies and safe
headroom. Do not generate on the Production host.

- [ ] **Step 2: Generate fixtures**

This builds one deterministic 1 MiB pseudorandom block from SHA-256(seed plus
counter), repeats it to the exact decimal-byte target, flushes each file, then
hashes it. Repetition is acceptable because application paths do not compress
octet-stream payloads; record if the client filesystem itself uses compression.

~~~powershell
$FixtureRoot = Join-Path $EvidenceRoot 'fixtures'
New-Item -ItemType Directory -Force -Path $FixtureRoot | Out-Null
$Sizes = [ordered]@{
  'S-100MB.bin' = [int64]100000000
  'M-300MB.bin' = [int64]300000000
  'L-1GB.bin' = [int64]1000000000
  'XL-5GB.bin' = [int64]5000000000
  'XXL-10GB.bin' = [int64]10000000000
}
$Seed = [Text.Encoding]::UTF8.GetBytes('AEGIS-LFT-PERF-1-v1')
$Block = New-Object byte[] 1048576
$Sha = [Security.Cryptography.SHA256]::Create()
for ($Offset = 0; $Offset -lt $Block.Length; $Offset += 32) {
  $Counter = [BitConverter]::GetBytes([int64]($Offset / 32))
  $Input = New-Object byte[] ($Seed.Length + $Counter.Length)
  [Buffer]::BlockCopy($Seed,0,$Input,0,$Seed.Length)
  [Buffer]::BlockCopy($Counter,0,$Input,$Seed.Length,$Counter.Length)
  $Digest = $Sha.ComputeHash($Input)
  $Count = [Math]::Min(32,$Block.Length-$Offset)
  [Buffer]::BlockCopy($Digest,0,$Block,$Offset,$Count)
}
$Rows = foreach ($Entry in $Sizes.GetEnumerator()) {
  $Path = Join-Path $FixtureRoot $Entry.Key
  if (Test-Path -LiteralPath $Path) { throw "Refusing to overwrite $Path" }
  $Stream = [IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try {
    $Remaining = [int64]$Entry.Value
    while ($Remaining -gt 0) {
      $Count = [int][Math]::Min([int64]$Block.Length,$Remaining)
      $Stream.Write($Block,0,$Count)
      $Remaining -= $Count
    }
    $Stream.Flush($true)
  } finally {
    $Stream.Dispose()
  }
  $Item = Get-Item -LiteralPath $Path
  $Hash = Get-FileHash -Algorithm SHA256 -LiteralPath $Path
  [pscustomobject]@{
    schema_version='aegis.idea1.fixture.v1'
    file_name=$Item.Name
    exact_bytes=[int64]$Item.Length
    sha256=$Hash.Hash.ToLowerInvariant()
    generator='powershell-sha256-block-v1'
  }
}
$Rows | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 (Join-Path $FixtureRoot 'fixture-manifest.json')
$Rows | Format-Table -AutoSize
~~~

- [ ] **Step 3: Verify exact lengths and repeat hashes**

~~~powershell
$Manifest = Get-Content -Raw (Join-Path $FixtureRoot 'fixture-manifest.json') | ConvertFrom-Json
foreach ($Row in $Manifest) {
  $Path = Join-Path $FixtureRoot $Row.file_name
  $Item = Get-Item -LiteralPath $Path
  $Hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
  if ($Item.Length -ne $Row.exact_bytes -or $Hash -ne $Row.sha256) {
    throw "Fixture verification failed: $($Row.file_name)"
  }
}
'FIXTURE_VERIFICATION=PASS'
~~~

## 3. Media fixtures

### Task 2: Create representative encoded video fixtures

**Produces:** toolchain-bound synthetic MP4 fixtures; exact bytes/hashes and
FFprobe metadata. “Approximately class size” is accepted; actual bytes govern.

- [ ] **Step 1: Record toolchain**

~~~powershell
ffmpeg -version | Select-Object -First 3
ffprobe -version | Select-Object -First 3
~~~

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

Never compare hashes across FFmpeg builds as proof of incorrectness. The fixture
is deterministic only within the recorded toolchain/run; its exact produced hash
becomes its identity.

- [ ] **Step 3: Record metadata for every media fixture**

~~~powershell
ffprobe -v error -show_entries 'format=filename,format_name,duration,size,bit_rate:stream=index,codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,bit_rate' -of json 'PATH_TO_MEDIA' | Set-Content -Encoding utf8 'PATH_TO_MEDIA.ffprobe.json'
Get-FileHash -Algorithm SHA256 -LiteralPath 'PATH_TO_MEDIA'
~~~

Image and GIF fixtures must likewise record exact bytes/hash, dimensions,
animation/frame evidence, and generator/toolchain. A same-size different-codec
pair is strongly preferred for T9–T11 because it distinguishes byte-size effects
from decoder/container effects.

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

## 5. Phase B0 — Production configuration inventory, read-only

### Prerequisites

- Human Owner at Production console.
- Exact running Drive/Gateway/connector identities known.
- No active maintenance/cutover.
- No command prints full environment or secrets.

### Commands

- [ ] **B0.1 Record container identity and health**

~~~bash
date --iso-8601=seconds
docker inspect aegis-prod-drive-1 --format 'name={{.Name}} image={{.Config.Image}} id={{.Image}} status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} restarts={{.RestartCount}} oom={{.State.OOMKilled}}'
docker inspect aegis-prod-gateway-1 --format 'name={{.Name}} image={{.Config.Image}} status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} restarts={{.RestartCount}} oom={{.State.OOMKilled}}'
docker inspect aegis-prod-public-share-connector-1 --format 'name={{.Name}} image={{.Config.Image}} status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} restarts={{.RestartCount}} oom={{.State.OOMKilled}}'
~~~

If actual names differ, stop and identify the live chain. Do not guess or create
containers.

- [ ] **B0.2 Print only allowlisted performance/configuration fields**

~~~bash
docker inspect aegis-prod-drive-1 --format '{{range .Config.Env}}{{println .}}{{end}}' |
grep -E '^(UPLOAD_CHUNK_SIZE_BYTES|MAX_LOGICAL_FILE_BYTES|VAULT_CHUNK_PLAINTEXT_BYTES|MAX_VAULT_LOGICAL_FILE_BYTES|VAULT_UPLOAD_CONCURRENCY|MEDIA_ENABLED|MEDIA_CACHE_MAX_BYTES|MEDIA_CACHE_LOW_WATER|MEDIA_CACHE_FREE_RESERVE_BYTES|MEDIA_WORKERS|MEDIA_FFMPEG_DECODER_THREADS|MEDIA_FFMPEG_FILTER_THREADS|MEDIA_FFMPEG_ENCODER_THREADS|MEDIA_PROBESIZE_BYTES|MEDIA_POSTER_MAX_BYTES|MEDIA_MOTION_MAX_BYTES|MEDIA_PROBE_TIMEOUT_MS|MEDIA_POSTER_TIMEOUT_MS|MEDIA_MOTION_TIMEOUT_MS|MEDIA_QUEUE_MAX|MEDIA_STILL_ENGINE|MEDIA_CACHE_POLICY)='
~~~

Missing fields are recorded UNSET, not replaced silently with guessed Production
values. Current source defaults may be listed separately.

- [ ] **B0.3 Record mounts/storage without content**

~~~bash
docker inspect aegis-prod-drive-1 --format '{{range .Mounts}}{{println .Type .Name .Source .Destination .RW}}{{end}}'
docker exec aegis-prod-drive-1 sh -lc 'df -B1 /datalake /var/cache/aegis-media 2>/dev/null || true; stat -f -c "%T %S %b %a %m" /datalake /var/cache/aegis-media 2>/dev/null || true'
lsblk -o NAME,TYPE,SIZE,FSTYPE,MOUNTPOINTS,ROTA,MODEL
~~~

- [ ] **B0.4 Record application limits through authenticated browser**

In DevTools Console on the authenticated private Drive origin:

~~~javascript
const normal = await fetch('/drive/api/files/uploads/limits', {credentials:'same-origin'}).then(r => r.json())
const vault = await fetch('/drive/api/vault/tree/uploads/limits', {credentials:'same-origin'}).then(r => r.json())
console.table({normal:normal.data ?? normal, vault:vault.data ?? vault})
~~~

Copy only numeric limits/concurrency. Do not copy request headers, cookies, or
storage values.

- [ ] **B0.5 Record media/cache/queue status via authenticated Admin API**

In DevTools Console on the authenticated Admin Drive origin:

~~~javascript
const media = await fetch('/drive/api/admin/media-cache/status', {credentials:'same-origin'}).then(r => r.json())
console.table({
  enabled:media.enabled,
  ffmpeg:media.capabilities?.ffmpeg?.version ?? null,
  sharp:media.capabilities?.sharp?.version ?? null,
  cache_bytes:media.cache?.bytes ?? null,
  cache_entries:media.cache?.entries ?? null,
  cache_high_water:media.cache?.highWater ?? null,
  cache_low_water:media.cache?.lowWater ?? null,
  cache_volume:media.cache?.volume ?? null,
  queue_depth:media.queue?.depth ?? null,
  queue_running:media.queue?.running ?? null,
  failures_24h:media.failures?.last24h ?? null
})
~~~

Record only these allowlisted values. Do not copy request headers, cookies, the
full response, process environment, cache paths, or database output.

### Stop conditions

- Unexpected image/source identity, unhealthy/restarting/OOM container.
- Unknown live Compose chain.
- Storage below fixture plus reserve requirement.
- Any command would require exposing a secret.
- Active incident, backup, migration, or unrelated heavy workload.

### Cleanup

None. Read-only.

## 6. Common run protocol

### Task 3: Prepare synchronized observation

- [ ] **Step 1: Create a run ID**

~~~powershell
$RunId = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ') + '__P1__T1__S__r01'
$RunId
~~~

- [ ] **Step 2: Capture client interface context**

~~~powershell
Get-NetAdapter | Where-Object Status -eq 'Up' | Select-Object Name,InterfaceDescription,LinkSpeed,MacAddress
Get-NetIPConfiguration | Select-Object InterfaceAlias,IPv4Address,IPv4DefaultGateway
netsh wlan show interfaces
~~~

Store only necessary network characteristics. Redact SSID/BSSID/MAC from
report-ready evidence unless technically needed; never publish private network
identifiers.

- [ ] **Step 3: Start server samples if tools already exist**

No packages are installed. Open separate Human terminals:

~~~bash
docker stats --no-trunc aegis-prod-drive-1 aegis-prod-gateway-1 aegis-prod-public-share-connector-1
iostat -dx 1
pidstat -dur -p ALL 1
~~~

If iostat or pidstat is absent, record NOT AVAILABLE. Do not install during the
baseline. Save only the bounded run interval and relevant processes/devices.

- [ ] **Step 4: Measure one application action**

Record UTC start/end, visible application stage times, HTTP status, bytes, retries,
resume state, and browser DevTools Timing. For upload, separate Checking/Hashing,
Encrypting (Vault), Uploading, and Finalizing/Commit. For download, hash the
received non-Vault file and compare to the fixture manifest.

- [ ] **Step 5: Stop samples and write one run record**

Use the evidence schema in the design. A null means unavailable; zero means
measured zero. Never convert missing evidence to zero.

- [ ] **Step 6: Validate run completeness**

Required identity: run_id, source SHA/image, path, workload, fixture bytes/hash,
timestamp, repetition/warm-up, result, limitation. ACTUAL_TRANSFER_TEST additionally
requires bytes and elapsed time. CONFIGURED_LIMIT_TEST additionally requires
transfer_started=false, limit layer/value, and network_performance=NOT_MEASURED.

## 7. Phase B1 — P1 LAN baseline

### Prerequisites

- Closest practical client/server LAN path.
- Twingate OFF and Cloudflare not in path.
- Exact server reached is proven.
- Disposable account/folder/Vault content only.
- B0 PASS; no unrelated load.

### Actions

- [ ] Run T1 Files upload at S/M/L/XL, then XXL configuration probe.
- [ ] Run T2 Vault encrypted upload at S/M/L/XL, then XXL configuration probe.
- [ ] Run T3 Files full download on the committed fixtures.
- [ ] Run T4 Vault full download/Preview where supported.
- [ ] Run T6 Range/seek on representative video fixtures.
- [ ] Run T7–T11 media protocol in Phase B5.
- [ ] Verify non-Vault downloaded SHA-256; verify Vault UI/client integrity result.
- [ ] Complete required repetitions and preserve every run.

Expected safe outputs: numeric stage timings, HTTP statuses, byte counts,
hash-match verdicts, resource samples, no credentials/content.

Stop on health degradation, restart/OOM, integrity mismatch, unexpected 5xx,
unplanned heavy load, storage reserve breach, or any unexpected Production state
mutation. Preserve failure evidence; do not retry blindly.

Cleanup: through real UI, remove only study-owned disposable Files/Vault objects
after evidence capture. Do not use destructive purge. Verify other data untouched.

## 8. Phase B2 — P2 local Wi-Fi plus Twingate

### Prerequisites

- Same client and fixtures as B1.
- Client on local Wi-Fi; record link/RSSI.
- Twingate ON; record Direct/Relayed/Unknown if visible.
- Private Drive hostname/path proves Twingate route.

### Actions

- [ ] Repeat paired T1–T4 and T6 cells using the same fixture hashes.
- [ ] Keep browser, server image, concurrent load, and repetitions aligned with B1.
- [ ] Record RTT/loss only with a bounded safe probe if the endpoint permits it.
- [ ] Do not mutate Twingate policy, connector, routing, or diagnostics settings.

Stop/cleanup: same as B1. If path attribution is uncertain, classify PATH=UNKNOWN
and do not use the run in P1/P2 comparisons.

## 9. Phase B3 — P3 remote Internet plus Twingate

### Prerequisites

- Client physically outside the local LAN; record network type without publishing
  private identifiers.
- Twingate ON; Direct/Relayed/Unknown recorded.
- Same client, browser, fixture identities, and Production source where practical.

### Actions

- [ ] Repeat prioritized T1–T4/T6 at S/M/L first.
- [ ] Execute XL/XXL only after limits, time, storage, and stability remain safe.
- [ ] Record client uplink/downlink context separately from application throughput.
- [ ] Preserve interruption/resume evidence if a natural interruption occurs;
  do not induce a Production network failure.

Stop on unstable client connectivity, unknown path, server health issue, or
integrity mismatch. Cleanup only task-owned application objects.

## 10. Phase B4 — P4 Cloudflare Public Share baseline

### Prerequisites

- External client with Twingate OFF.
- Accepted Public Share runtime healthy; no 1033.
- Human Owner creates a disposable Public Anywhere link through the product UI.
- The raw bearer URL remains only in browser memory/UI. Never paste it into shell,
  evidence, screenshot, HAR, clipboard log, or report.

### Actions

- [ ] Create a disposable public share for each eligible committed Files fixture.
- [ ] From external browser, measure T5 full download at S/M/L/XL where accepted.
- [ ] Perform XXL only as a configuration probe first.
- [ ] Record TTFB, exact downloaded bytes, elapsed time, status, and local SHA-256.
- [ ] Record Cloudflare path separately from origin/server observations.
- [ ] Revoke each disposable link through the UI after its runs.
- [ ] Verify one post-revoke attempt is blocked, then stop using the URL.

Public Share has no Range/resume in the current contract. Do not test T6, do not
claim partial-resume behavior, and do not alter Gateway/cloudflared/Cloudflare.

Stop immediately on 1033, unexpected route exposure, auth/scope anomaly, hash
mismatch, server health issue, or inability to protect the bearer URL. A 1033
event is lifecycle availability evidence, not throughput evidence.

Cleanup: revoke every study link; remove task-owned source files only after all
other path runs no longer need them; verify post-revoke block. Do not delete audit
history or unrelated rows.

## 11. Phase B5 — media preview baseline

### Prerequisites

- Exact media fixture metadata and SHA-256 available.
- Each fixture uploaded through the normal product flow.
- Path P1 first; P2/P3 follow for client-delivered behavior.
- Cold/warm state explicitly controlled and labelled.

### Task 4: Measure Files server-derivative media

- [ ] Record cold T7/T8/T9/T10 from list response to poster/thumbnail/motion ready.
- [ ] Record queue depth/wait, generator start/end, FFmpeg/Sharp behavior, source
  bytes read when available, derivative bytes, and resource samples.
- [ ] Repeat warm without deleting authoritative content; confirm cache-hit state.
- [ ] Hover while motion is pending and measure intent-to-first-moving-frame.
- [ ] Open explicit Preview and measure T11 TTFF, stalls, and seek latency.
- [ ] Use DevTools Network to count only endpoint classes; never export private
  URLs/headers into repository evidence.

### Task 5: Measure Vault client-side zero-knowledge media

- [ ] Use the same path/fixture class where product limits permit.
- [ ] Record thumbnail/poster/hover/Preview timings separately.
- [ ] Record Range count and encrypted chunk fetch/decrypt work without recording
  ciphertext metadata, envelopes, keys, or decrypted private content.
- [ ] Record client CPU/memory and main-thread impact.
- [ ] Lock after each controlled group and verify no decrypted view remains.

### Browser event definitions

| Metric | Start | Stop |
|---|---|---|
| thumbnail_ready_ms | Files/Vault inventory response complete | visible non-placeholder thumbnail painted |
| poster_ready_ms | inventory response complete | representative poster painted |
| hover_start_ms | pointerenter timestamp | first moving frame painted |
| ttff_ms | explicit Preview open/play intent | first video frame callback/paint |
| seek_ms | seeking intent | first post-seek playing frame |
| stall_ms | waiting/stalled event | matching playing/canplay recovery |

Prefer requestVideoFrameCallback for video-frame timestamps when supported;
otherwise record the fallback and limitation.

Stop on unexpected original-body grid fetch, cross-account leakage, broken
security boundary, health degradation, runaway queue/process, cache reserve
failure, or integrity error. No cache purge is authorized during baseline.

Cleanup: remove only disposable media through UI after all cold/warm/path runs.
Do not remove the Production media volume or clear unrelated cache entries.

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

For Vault, never represent server ciphertext verification as plaintext SHA-256.
Record separate fields:

~~~text
server_ciphertext_integrity=PASS|FAIL|NOT_AVAILABLE
client_plaintext_integrity=PASS|FAIL|NOT_AVAILABLE
~~~

### Result taxonomy

| Result | Meaning |
|---|---|
| PASS | Workload completed and required integrity gate passed |
| EXPECTED_CONFIG_LIMIT | Transfer did not start because current configured limit rejected it |
| CLIENT_CONFIG_REJECTION | Client rejected before transport |
| HTTP_APPLICATION_REJECTION | Application returned a bounded rejection |
| SERVER_CONFIG_REJECTION | Server limit rejected |
| STORAGE_CAPACITY_REJECTION | Reserve/free-space gate rejected |
| NETWORK_TIMEOUT | Transfer started; network timeout evidenced |
| INTEGRITY_FAILURE | Required digest/authentication check failed |
| NOT TESTED | Required path/fixture/time unavailable |
| BLOCKED | Safety/identity/health prerequisite failed |

## 13. Analysis workflow

### Task 6: Validate raw evidence before summarizing

- [ ] Confirm each run ID is unique.
- [ ] Confirm source/image/path/fixture identities exist.
- [ ] Recompute MB/s and Mbps from raw bytes and elapsed.
- [ ] Confirm no secret-bearing fields, URLs, headers, or private content.
- [ ] Confirm CONFIG-LIMITED rows have no throughput value.
- [ ] Confirm cold and warm media samples are separate.
- [ ] Confirm sparse fixtures are absent from throughput results.
- [ ] Confirm every excluded run remains preserved with exclusion reason.

### Task 7: Produce summaries

For every Path x Workload x Size x cache-state group:

- individual run values;
- n;
- median;
- min/max;
- optional mean;
- limitation.

Do not pool different codecs, bitrate profiles, client machines, Twingate
Direct/Relayed states, or server images.

### Task 8: Evaluate hypotheses

For H1–H15, cite exact run IDs under support, falsification, and distinction.
Verdicts:

~~~text
SUPPORTED_WITHIN_TESTED_SCOPE
NOT_SUPPORTED_WITHIN_TESTED_SCOPE
MIXED
NOT_PROVEN
~~~

No statistical/causal claim is stronger than the matrix and sample count.

## 14. Future controlled optimization gate — not authorized now

An optimization experiment requires a separate approved task containing:

1. baseline evidence and selected hypothesis;
2. one changed variable;
3. exact before/after source/config;
4. security/integrity/resource acceptance criteria;
5. rollback;
6. same fixture/path/repetition pairing;
7. regression verification;
8. Human Owner Production authorization.

Candidate variables include chunk size, concurrency, worker count, cache policy,
media profile, and proxy behavior. This list is not a recommendation. Network,
Twingate, Cloudflare, firewall, Docker, storage, database, or file-limit changes
remain prohibited until separately justified and authorized.

## 15. Cleanup ledger

At the end of each Human phase record:

| Resource | Identifier class | Created by study | Cleanup action | Result |
|---|---|---:|---|---|
| Files fixture | sanitized study name | yes | delete through UI after all dependent runs | pending |
| Vault fixture | sanitized study name | yes | trash/allowed cleanup through UI; no destructive purge | pending |
| Public link | run ID only; never bearer | yes | revoke through UI; verify post-revoke block | pending |
| Client fixture | exact local path | yes | remove after archive/checksum review | pending |
| Evidence | outside-repo directory | yes | retain sanitized required set; securely remove token-bearing raw capture if any | pending |

Never delete containers, volumes, networks, databases, cache volumes, audit rows,
or unrelated user data.

## 16. Phase completion reports

Each phase returns:

~~~text
PHASE=
SOURCE_SHA=
SERVER_IMAGE=
PATH_CLASS=
WORKLOADS_EXECUTED=
FIXTURE_CLASSES=
RUNS_PLANNED=
RUNS_COMPLETED=
RUNS_CONFIG_LIMITED=
RUNS_NOT_TESTED=
INTEGRITY_FAILURES=
HEALTH_DEGRADATION=
PRODUCTION_SETTINGS_CHANGED=NO
UNRELATED_RESOURCES_TOUCHED=NO
LIMITATIONS=
NEXT_GATE=
~~~

## 17. Planning-task validation

Before this Draft PR is handed to the Human Owner:

- [ ] Design contains architecture/evidence vocabulary and historical inventory.
- [ ] Exact decimal size ladder and 10 GB policy present.
- [ ] P1–P4 x T1–T11 x size matrix present.
- [ ] Transfer/media/client/server/network metrics present.
- [ ] Repetition/control-variable policy present.
- [ ] H1–H15 and decision tree present.
- [ ] B0–B5 prerequisites, commands, stop conditions, cleanup present.
- [ ] Tables 1–12 and chart specifications present.
- [ ] Current Production values marked RE-MEASURE REQUIRED.
- [ ] No fake measurement or improvement claim.
- [ ] No Production-capable secret-bearing harness.
- [ ] Markdown/path validation, collaboration policy, repository validator, and
  git diff check pass.

## 18. Self-review record

Spec coverage:

- Historical LFT/Public Share/PR150/PR187/PR212 evidence: design sections 3–5.
- Size, path, workload matrices: design sections 6–9.
- Metrics, repetition, variables, evidence schema: design sections 10–13.
- Hypotheses/decision framework: design sections 14–16.
- Final-project tables/charts/limitations: design sections 17–19.
- Deterministic fixtures and media metadata: plan sections 2–3.
- Human Production packet B0–B5: plan sections 5–11.
- Stop/cleanup/future optimization gates: plan sections 5–16.

Placeholder scan: no TBD/TODO instruction is used. Placeholder tokens
DURATION, OUTPUT, and PATH_TO_MEDIA are explicit command parameters the Human
must replace with the selected matrix row, not unspecified design work.

Harness decision: HARNESS_ADDED=NO. Reason: existing tools cover fixture
generation, timing, hashing, resource observation, and structured manual
recording; review of the measurement contract should precede any authenticated
automation. If repetition later proves error-prone, a separate repository-local,
local/dev-only JSONL recorder can be proposed with tests and zero secret fields.

## 19. Draft-state truth

~~~text
TASK=LFT-PERF-1
STATUS=PLANNED / DRAFT
HUMAN_REVIEW_REQUIRED=YES
PRODUCTION_BENCHMARK_EXECUTED=NO
PRODUCTION_MUTATED=NO
PERFORMANCE_SETTINGS_CHANGED=NO
HARNESS_ADDED=NO
ROOT_CAUSE=NOT_PROVEN
TWINGATE_BOTTLENECK=NOT_PROVEN
CLOUDFLARE_BOTTLENECK=NOT_PROVEN
STORAGE_BOTTLENECK=NOT_PROVEN
CLIENT_CRYPTO_BOTTLENECK=NOT_PROVEN
NEXT_GATE=HUMAN DESIGN / MEASUREMENT PLAN REVIEW
~~~
