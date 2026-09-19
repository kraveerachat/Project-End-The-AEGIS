# PR #150 media preview — Production cutover runbook (Human Owner only)

Status: **PREPARED, NOT EXECUTED.** Nothing in this document has been run against Production. Every command below is for the Human Owner to run on the Production host after the independent review of the pre-production SHA. This gate wrote no file under `/opt/aegis`, ran no `sudo`, and ran no Production Docker command.

```
PREPROD_SOURCE_SHA=<PREPROD_SOURCE_SHA — the branch head named in the Tranche C final report>
CANDIDATE_TAG=aegis-prod-drive:media-preview-<sha12>
CANDIDATE_IMAGE_ID=<from the final report>
CANDIDATE_REVISION=<PREPROD_SOURCE_SHA — the branch head named in the Tranche C final report> (org.opencontainers.image.revision)
MEDIA_OVERLAY_PATH_PLANNED=/opt/aegis/runtime/pr150/drive-media-preview-<sha12>.yml
ROLLBACK_MODEL=OMIT_MEDIA_OVERLAY
DATABASE_MUTATION=NO   MIGRATION_APPLIED=NO   PUBLIC_SHARE_TOUCHED=NO
ANIMATED_WEBP_MOTION=POSTER_ONLY_DEGRADATION (DEMUXER_WEBP_MISSING in the packaged ffmpeg 8.0.1-r1)
```

## 0. Preconditions the Owner must confirm (this gate could not)

1. **Production Drive image / checkout state.** The plan's global constraints record `PRODUCTION_RUNTIME_CURRENT=e5bea949` (the accepted Round 10 build). The last repository receipt (2026-09-18, PR #148 closure) names `aegis-prod-drive:files-upload-ux-22ff70a85088` as the accepted Drive image. Read the tag actually referenced by the live Drive image override before cutover (section 2) and record it as `ROLLBACK_IMAGE_TAG`. Do not assume.
2. **Migration 010 (`kind`/`parent_id`).** PR #150 carries migration 010; this media cutover does not apply any migration. If the live database has **not** been migrated to 010, the candidate image must not be deployed by this runbook — the migration is a separate, backed-up, owner-run step that precedes it. Section 2 records the migration state; `MIGRATION_APPLIED=NO` in this runbook means "this cutover applies nothing", not "010 is unnecessary".
3. **Drive image override file.** The candidate tag is carried by the existing Drive image override layer (`/opt/aegis/runtime/public-share/drive-s5-3.yml` in the recorded chain, or its current successor). The media overlay never sets `image:`.

## 1. Files (content to create on the host — Owner action)

### 1.1 Media overlay — `/opt/aegis/runtime/pr150/drive-media-preview-<sha12>.yml`

```yaml
# PR #150 media preview — service-scoped overlay (Drive only). Applied LAST in the -f chain.
# Adds ONLY the MEDIA_* environment and the rebuildable derivative cache mount.
# Never sets image:, networks, addresses, /datalake, telemetry/backup binds, group_add,
# Public Share services, the gateway or PostgreSQL.
services:
  drive:
    environment:
      MEDIA_ENABLED: "true"
      MEDIA_CACHE_DIR: /var/cache/aegis-media
      MEDIA_CACHE_MAX_BYTES: "2147483648"
      MEDIA_WORKERS: "1"
      MEDIA_STILL_ENGINE: sharp
      MEDIA_CACHE_POLICY: immutable
    volumes:
      - aegis_drive_media_cache:/var/cache/aegis-media

volumes:
  aegis_drive_media_cache:
    name: aegis_drive_media_cache   # rebuildable derivative cache — not backed up, safe to delete when unused
```

### 1.2 Drive image override — existing layer, one line changed by the Owner

In the existing Drive image override (currently `/opt/aegis/runtime/public-share/drive-s5-3.yml` per the recorded chain), set the Drive image to the candidate:

```yaml
services:
  drive:
    image: aegis-prod-drive:media-preview-<sha12>
```

Keep a copy of the previous file (`cp drive-s5-3.yml drive-s5-3.yml.pre-pr150-$(date -u +%Y%m%dT%H%M%SZ)`) — it is the rollback file.

## 2. Pre-cutover snapshot (record every output; read-only)

```bash
# checkout / repo state (read-only)
cd /opt/aegis/Project-End-The-AEGIS && git rev-parse HEAD && git status --short | head
# live compose file set (read-only)
ls -la /opt/aegis/runtime /opt/aegis/runtime/public-share /opt/aegis/runtime/pr150 2>/dev/null
sha256sum /opt/aegis/runtime/docker-compose.production.yml /opt/aegis/runtime/public-share/*.yml
grep -n 'image:' /opt/aegis/runtime/public-share/drive-s5-3.yml    # → ROLLBACK_IMAGE_TAG
# Drive container / image / health / restarts
sudo docker ps --filter name=aegis-prod-drive-1 --format '{{.ID}} {{.Image}} {{.Status}}'
sudo docker inspect aegis-prod-drive-1 --format 'image={{.Image}} restarts={{.RestartCount}} health={{.State.Health.Status}} oom={{.State.OOMKilled}}'
sudo docker inspect aegis-prod-drive-1 --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}={{$v.IPAddress}} {{end}}'
sudo docker inspect aegis-prod-drive-1 --format '{{range .Mounts}}{{.Type}} {{.Name}}{{.Source}} -> {{.Destination}} rw={{.RW}}
{{end}}'
sudo docker inspect aegis-prod-drive-1 --format '{{.HostConfig.GroupAdd}}'
sudo docker exec aegis-prod-drive-1 wget -qO- http://127.0.0.1:8001/healthz
# unrelated services and Public Share services (must be unchanged after cutover)
sudo docker ps --format '{{.Names}} {{.Image}} {{.Status}}' | sort
sudo docker network ls --format '{{.Name}} {{.Driver}}' | sort
sudo docker volume ls --format '{{.Name}}' | sort
# database: counts + migration state (read-only, non-secret)
sudo docker exec aegis-prod-postgres-1 psql -U <admin-role> -d aegis_drive -Atc "SELECT count(*) FROM files; SELECT count(*) FROM files WHERE vault; SELECT count(*) FROM files WHERE deleted_at IS NOT NULL;"
sudo docker exec aegis-prod-postgres-1 psql -U <admin-role> -d aegis_drive -Atc "SELECT column_name FROM information_schema.columns WHERE table_name='files' AND column_name IN ('kind','parent_id') ORDER BY 1;"   # both rows present = migration 010 applied
```

Expected for the media cutover itself: `DATABASE_MUTATION=NO`, `MIGRATION_APPLIED=NO`, `PUBLIC_SHARE_TOUCHED=NO`.

## 3. Candidate image on the host (Owner action; build from the exact SHA)

```bash
cd /opt/aegis/Project-End-The-AEGIS   # or a clean clone at the exact SHA — never modify the stale checkout in place
git fetch origin && git worktree add /opt/aegis/build/pr150-<sha12> <PREPROD_SOURCE_SHA — the branch head named in the Tranche C final report>
cd /opt/aegis/build/pr150-<sha12>/IDEA1-AEGIS_Drive_LC
sudo docker build --label org.opencontainers.image.revision=<PREPROD_SOURCE_SHA — the branch head named in the Tranche C final report> -t aegis-prod-drive:media-preview-<sha12> .
sudo docker image inspect aegis-prod-drive:media-preview-<sha12> --format 'id={{.Id}} rev={{index .Config.Labels "org.opencontainers.image.revision"}} size={{.Size}}'
# in-image toolchain truth (must match section 6)
sudo docker run --rm --entrypoint sh aegis-prod-drive:media-preview-<sha12> -c 'cat /etc/alpine-release; node --version; ffmpeg -version | head -1; ffprobe -version | head -1; ffmpeg -hide_banner -encoders | grep -E " (libx264|libwebp) "; ffmpeg -hide_banner -decoders | grep -E "^ V" | grep -E " (gif|apng|webp|av1|h264|vp8|vp9) "; ffmpeg -hide_banner -demuxers | grep -E "^ D +webp"; node -e "import(\"sharp\").then(s=>console.log(s.default.versions))"'
```

The image id built on the host will differ from the gate's `CANDIDATE_IMAGE_ID` (different build host); the **revision label and the toolchain versions must match**.

## 4. Rendered-config check (read-only; abort on ANY unexpected difference)

```bash
sudo docker compose \
  --env-file /opt/aegis/Project-End-The-AEGIS/.env \
  --project-name aegis-prod \
  -f /opt/aegis/runtime/docker-compose.production.yml \
  -f /opt/aegis/runtime/public-share/drive-s5-3.yml \
  -f /opt/aegis/runtime/public-share/drive-gateway-s5-4.yml \
  -f /opt/aegis/runtime/public-share/connector-s5-5.yml \
  -f /opt/aegis/runtime/public-share/docker-compose.s5-11-ui.yml \
  -f /opt/aegis/runtime/pr150/drive-media-preview-<sha12>.yml \
  config > /tmp/pr150-rendered.yml
```

(Use exactly the file set currently in force — if the live chain differs from the five files above, use the live chain and append the media overlay last.)

Prove in `/tmp/pr150-rendered.yml`, service `drive`:

- `image: aegis-prod-drive:media-preview-<sha12>`
- networks and static addresses identical to the section 2 snapshot (`aegis_drive_proxy` 172.19.255.3, `aegis_internal` 172.18.0.3, `aegis_public_share_upstream` 172.31.241.3, `aegis_vlan10_macvlan` 192.168.10.11 — as recorded in the snapshot)
- `/datalake` mount unchanged and `rw`
- `/run/aegis-telemetry:/run/aegis-telemetry:ro` present, read-only
- `/run/aegis-backup:/run/aegis-backup:ro` present, read-only
- `group_add` contains `29100` and `29102`
- exactly ONE new mount: `aegis_drive_media_cache` → `/var/cache/aegis-media`
- top-level `volumes.aegis_drive_media_cache.name == aegis_drive_media_cache`
- `environment` gains only `MEDIA_ENABLED, MEDIA_CACHE_DIR, MEDIA_CACHE_MAX_BYTES, MEDIA_WORKERS, MEDIA_STILL_ENGINE, MEDIA_CACHE_POLICY`
- every other service (postgres, hub, monitor, public-share-gateway, connector, UI) byte-identical to a render WITHOUT the media overlay:

```bash
sudo docker compose --env-file ... --project-name aegis-prod -f ...(same chain without the media overlay) config > /tmp/pr150-rendered-before.yml
diff /tmp/pr150-rendered-before.yml /tmp/pr150-rendered.yml     # only the drive image line, the MEDIA_* lines, the one mount and the volume block may differ
```

## 5. Cutover (Drive only) — DO NOT RUN until the review says GO

```bash
sudo docker compose \
  --env-file /opt/aegis/Project-End-The-AEGIS/.env \
  --project-name aegis-prod \
  -f /opt/aegis/runtime/docker-compose.production.yml \
  -f /opt/aegis/runtime/public-share/drive-s5-3.yml \
  -f /opt/aegis/runtime/public-share/drive-gateway-s5-4.yml \
  -f /opt/aegis/runtime/public-share/connector-s5-5.yml \
  -f /opt/aegis/runtime/public-share/docker-compose.s5-11-ui.yml \
  -f /opt/aegis/runtime/pr150/drive-media-preview-<sha12>.yml \
  up -d --no-deps --no-build drive
```

Never: `--remove-orphans`, `down`, `pull`, `prune`, `--force-recreate`, or any command without `--no-deps drive`.

Post-recreate proof:

```bash
sudo docker inspect aegis-prod-drive-1 --format 'image={{.Image}} restarts={{.RestartCount}} health={{.State.Health.Status}}'
sudo docker inspect aegis-prod-drive-1 --format '{{range .Mounts}}{{.Type}} {{.Name}}{{.Source}} -> {{.Destination}} rw={{.RW}}
{{end}}'      # /datalake rw, telemetry ro, backup ro, aegis_drive_media_cache -> /var/cache/aegis-media
sudo docker volume inspect aegis_drive_media_cache --format '{{.Name}} {{.Mountpoint}}'
sudo docker exec aegis-prod-drive-1 wget -qO- http://127.0.0.1:8001/healthz      # media.enabled true, ffmpeg 8.0.1, sharp 0.35.4, cacheWritable true, cacheVolume "volume"
sudo docker exec aegis-prod-drive-1 ls -ld /var/cache/aegis-media                # owner node
sudo docker ps --format '{{.Names}} {{.Image}} {{.Status}}' | sort                # every other service unchanged
```

Browser acceptance (Owner, per plan Task 18 Steps 8–11): cold cache pending icon → poster; warm refresh; first hover on the REAL 49.7 MB GIF and the real 196 MB video with the network log showing derivative-sized transfers only; mouseleave poster; reduced motion; cross-account cache isolation (A → logout → 401 → B → 404, real network request, not "from disk cache"); `docker stats`, `RestartCount`, child `VmHWM`, p95 before/during a 300 MB-class and a 10 GB-class job.

## 6. Rollback — OMIT the media overlay, restore the previous Drive image override

```bash
# 1) restore the pre-PR150 Drive image override (the file copied in 1.2)
sudo cp /opt/aegis/runtime/public-share/drive-s5-3.yml.pre-pr150-<stamp> /opt/aegis/runtime/public-share/drive-s5-3.yml
# 2) recreate Drive WITHOUT the media overlay (exact pre-cutover chain)
sudo docker compose \
  --env-file /opt/aegis/Project-End-The-AEGIS/.env \
  --project-name aegis-prod \
  -f /opt/aegis/runtime/docker-compose.production.yml \
  -f /opt/aegis/runtime/public-share/drive-s5-3.yml \
  -f /opt/aegis/runtime/public-share/drive-gateway-s5-4.yml \
  -f /opt/aegis/runtime/public-share/connector-s5-5.yml \
  -f /opt/aegis/runtime/public-share/docker-compose.s5-11-ui.yml \
  up -d --no-deps --no-build drive
# 3) proof: image == ROLLBACK_IMAGE_TAG, no /var/cache/aegis-media mount, networks/addresses/binds/group_add as in section 2
sudo docker inspect aegis-prod-drive-1 --format 'image={{.Image}} {{range .Mounts}}{{.Destination}} {{end}}'
```

The volume `aegis_drive_media_cache` stays in place, unused. Do **not** `docker volume rm` it during rollback (Docker refuses while any container references it, and it is not on the critical path). Kill switches that avoid a redeploy: `MEDIA_ENABLED=false`, `MEDIA_STILL_ENGINE=ffmpeg`, `MEDIA_CACHE_POLICY=revalidate` (edit the overlay, then the same `up -d --no-deps --no-build drive`).

## 7. Evidence recorded by this gate (values, not promises)

Measured in the packaged candidate (`MEDIA_TOOLCHAIN_PROVENANCE=PACKAGED_CANDIDATE`, gate image `sha256:039f8c518b1f8981c8c7e153381fdeeb35a3d49876ba5ecc584e00a41c7d4797` built from test-tree commit `7ca6fe78`; runtime tree identical to the final SHA), Alpine 3.23.4, Node v20.20.2, ffmpeg/ffprobe 8.0.1 (apk `8.0.1-r1`), sharp 0.35.4 / libvips 8.18.6. Host tools are supplemental only.

| Class | Fixture (stat) | Result | Source read (rchar) | Notes |
|---|---|---|---|---|
| IMAGE_200MB (7000×5000 rgb16 PNG) | 210,069,458 B | poster OK ≤ 512 KiB, sharp | — | 35 MP ≤ 40 MP guard |
| IMAGE_300MB (8000×5000 rgba16 PNG) | 320,103,184 B | poster OK, sharp | — | exactly the 40 MP guard (allowed) |
| OVER_PIXELS (9000×5000 header) | header only | UNSUPPORTED / DIMENSIONS in ms, no decode | — | |
| GIF_518KB / GIF_49MB | 536,442 B / 52,416,569 B | poster + motion OK | 78,987 / 91,506,632 B | recorded, not bounded |
| GIF_200MB hi/lo | 220,155,593 / 233,857,170 B | motion 6 s ≤ 4 MiB, in time | hi 816,463,659 / lo 765,223,613 B | multi-pass reads (probe+poster+motion); recorded |
| GIF_300MB hi/lo | 325,100,320 / 337,571,675 B | OK | hi 1,045,522,393 / lo 893,980,916 B | recorded |
| APNG_200MB hi/lo | 220,122,905 / 213,633,712 B | OK | hi 103,607,226 / lo 906,934 B | recorded |
| APNG_300MB hi/lo | 324,770,259 / 350,038,032 B | OK | hi 107,801,530 / lo 909,814 B | recorded |
| VIDEO_196MB (H.264 720p) | 200,068,961 B | poster 12,638 B + motion 10,606 B | 33,554,102 B | browser transfer = derivatives only |
| MP4_FASTSTART 10G / 20G (sparse, structurally verified, allocated 16 KiB) | 10,737,428,356 / 21,474,846,596 B | poster + motion OK | 26,187 / 162,767 B | **< 64 MiB bound MET** |
| MP4_MOOV_AT_END 10G / 20G | same | poster + motion OK (moov read from the end) | 23,307 / 20,427 B | recorded (not claimed as a bound) |
| WEBM_CUES_MID 10G / 20G (Void after first Cluster) | 10,737,492,313 / 21,474,910,553 B | poster + motion OK; motion 29.4 s / 58.2 s | 10,737,656,376 / 21,470,604,416 B | **read-bound NOT MET on the sparse fixture**: the matroska demuxer reads through the synthetic Void; VmHWM 46 MiB; within the 120 s timeout; not generalised to real files (which have no Void) |
| WEBM_NO_CUES_MID 10G / 20G | same | poster 29.2 s / 58.2 s, motion 30.3 s / 58.0 s | 21,459,977,355 / 42,944,730,131 B | each stage reads through the Void; recorded |
| WEBM_*_VOID_FIRST 10G (plan layout: 10 GiB before the first Cluster) | 10,737,444,881 B | truthful PROBE_FAILED (20 s probe timeout), VmHWM 35–36 MiB, no hang | 7,414,068,703 / 7,430,911,459 B | pathological shape; recorded |
| WEBM_CUES_VOID_FIRST 20G | — | NOT_PROVEN (verification ffprobe exceeded the 60 s check under host load) | — | |
| WEBM_NO_CUES_VOID_FIRST 20G | 21,474,863,034 B | truthful PROBE_FAILED | 7,423,636,959 B | |

Responsiveness (30 s baseline at 5 req/s, `/healthz` + `GET /api/files`): baseline p95 healthz 9 ms / files 6 ms; during the 300 MB-class GIF job (finished in 0.8 s) 7 / 5 ms; during the sparse 10 GiB MP4 moov-at-end job (0.2 s) 8 / 4 ms; REGRESSION_RATIO 0.78 / 0.89 (healthz) and 0.83 / 0.67 (files); zero non-200, none > 5 s; child peak VmHWM 60,404 KiB (59.0 MiB) over 6 runs; container cgroup CPU delta 35.7 s; no restart (single `docker run`), OOMKilled=false. `REAL_49_7MB_GIF_PREPROD=NOT_AVAILABLE` — the deterministic 45–55 MiB fixture was used; the real file stays mandatory in Production browser acceptance.
