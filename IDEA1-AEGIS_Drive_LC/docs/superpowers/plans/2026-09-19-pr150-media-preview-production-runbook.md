# PR #150 media preview — Production cutover runbook (Human Owner only)

Status: **PREPARED, NOT EXECUTED.** Nothing in this document has been run against Production. Every command below is for the Human Owner to run on the Production host after the independent review of the pre-production SHA. This gate wrote no file under `/opt/aegis`, ran no `sudo`, and ran no Production Docker command.

```
PREPROD_SHA=4d0b4fab0f667f9a161b75a3e497868cbb673fb2
SHA12=4d0b4fab0f66
CANDIDATE_TAG=aegis-prod-drive:media-preview-4d0b4fab0f66
CANDIDATE_IMAGE_OVERRIDE=/opt/aegis/runtime/pr150/drive-image-4d0b4fab0f66.yml     (NEW file)
MEDIA_OVERLAY=/opt/aegis/runtime/pr150/drive-media-preview-4d0b4fab0f66.yml       (NEW file)
ROLLBACK_MODEL=OMIT_NEW_IMAGE_OVERRIDE_AND_MEDIA_OVERLAY
DATABASE_MUTATION=NO   MIGRATION_APPLIED=NO   PUBLIC_SHARE_TOUCHED=NO
ANIMATED_WEBP_MOTION=POSTER_ONLY_DEGRADATION (DEMUXER_WEBP_MISSING in the packaged ffmpeg 8.0.1-r1)
LIST_ROW_MEDIA_PREVIEW=NOT_IMPLEMENTED   LIST_ROW_CURRENT_BEHAVIOR=ICON_ONLY   (section 9)
```

Invariants of this runbook:

- **No currently-active Production compose file is edited.** Not the base file, not any Public Share overlay (`drive-s5-3.yml`, `drive-gateway-s5-4.yml`, `connector-s5-5.yml`, `docker-compose.s5-11-ui.yml`), not the existing Drive image override. Every active file stays byte-identical; the cutover only **appends two new files** to the chain.
- **The stale Production checkout `/opt/aegis/Project-End-The-AEGIS` is read-only evidence.** No fetch, checkout, pull, worktree creation or any other mutation is run there. The candidate is built from a separate, isolated tree.
- **Every Production Docker command uses the scrubbed privileged prefix** `sudo env -u DOCKER_HOST -u CONTAINER_HOST docker …` so an inherited daemon selector can never redirect a command. `sudo -E` is never used.
- Only the Drive service is recreated (`up -d --no-deps --no-build drive`). Never `down`, `pull`, `prune`, `--remove-orphans`, `--force-recreate`, or a global recreate.

Shell shorthand used below (set once per shell; not persisted anywhere):

```bash
DOCKER='sudo env -u DOCKER_HOST -u CONTAINER_HOST docker'
PREPROD_SHA=4d0b4fab0f667f9a161b75a3e497868cbb673fb2
SHA12=4d0b4fab0f66
CANDIDATE_TAG=aegis-prod-drive:media-preview-${SHA12}
```

## 0. Preconditions the Owner must confirm (this gate could not)

1. **Exact currently-active compose chain.** The recorded model (gateway/public-share/production/README.md and the S5.x receipts) is `--env-file /opt/aegis/Project-End-The-AEGIS/.env --project-name aegis-prod` with, in order, `/opt/aegis/runtime/docker-compose.production.yml`, `/opt/aegis/runtime/public-share/drive-s5-3.yml`, `/opt/aegis/runtime/public-share/drive-gateway-s5-4.yml`, `/opt/aegis/runtime/public-share/connector-s5-5.yml`, `/opt/aegis/runtime/public-share/docker-compose.s5-11-ui.yml`. The Owner must **identify and record the chain that is actually in force** (section 2.1) and use exactly that chain as `<CURRENT_CHAIN>` everywhere below. If the live chain differs from the recorded one, the live chain wins and this runbook is not executed until the difference is understood.
2. **Live Drive image.** The plan's global constraints record `PRODUCTION_RUNTIME_CURRENT=e5bea949` (accepted Round 10 build); the last repository receipt (2026-09-18, PR #148 closure) names `aegis-prod-drive:files-upload-ux-22ff70a85088`. Read the image referenced by the live chain and the running container (section 2) and record it as `PRE_CUTOVER_DRIVE_IMAGE`. Rollback returns to exactly that image by omitting the two new files — nothing is written to restore it.
3. **Migration 010 (`kind` / `parent_id`) must already be complete on the live database** (section 2.4). This cutover applies no migration; if any required object is absent, `CUTOVER_ALLOWED=NO`, `MIGRATION_010_REQUIRED=YES`, STOP. Applying migration 010 is a separate, backed-up, owner-run step outside this runbook.
4. **Authorised Git access on the host.** This runbook does not assume that credentials exist on the Production host; the isolated clone in section 3 uses whatever authorised mechanism the host already has for `origin`.

## 1. New files (content to create on the host — Owner action; both under `/opt/aegis/runtime/pr150/`)

### 1.1 Candidate image override — `/opt/aegis/runtime/pr150/drive-image-4d0b4fab0f66.yml` (NEW)

```yaml
# PR #150 media preview — candidate Drive image. Appended AFTER the current chain; it overrides the
# Drive image of the earlier layer without editing that layer. Nothing else.
services:
  drive:
    image: aegis-prod-drive:media-preview-4d0b4fab0f66
```

### 1.2 Media overlay — `/opt/aegis/runtime/pr150/drive-media-preview-4d0b4fab0f66.yml` (NEW)

```yaml
# PR #150 media preview — service-scoped overlay (Drive only). Appended LAST in the -f chain.
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

```bash
sudo install -d -m 0755 /opt/aegis/runtime/pr150
# write the two files above, then record their digests
sha256sum /opt/aegis/runtime/pr150/drive-image-${SHA12}.yml /opt/aegis/runtime/pr150/drive-media-preview-${SHA12}.yml
```

No existing file under `/opt/aegis/runtime` is modified.

## 2. Pre-cutover snapshot (record every output; read-only)

### 2.1 Checkout and compose file set (read-only)

```bash
git -C /opt/aegis/Project-End-The-AEGIS rev-parse HEAD
git -C /opt/aegis/Project-End-The-AEGIS status --short | head
git -C /opt/aegis/Project-End-The-AEGIS remote get-url origin
ls -la /opt/aegis/runtime /opt/aegis/runtime/public-share /opt/aegis/runtime/pr150 2>/dev/null
sha256sum /opt/aegis/runtime/docker-compose.production.yml /opt/aegis/runtime/public-share/*.yml
grep -n 'image:' /opt/aegis/runtime/public-share/*.yml /opt/aegis/runtime/docker-compose.production.yml     # → PRE_CUTOVER_DRIVE_IMAGE (read only)
```

Record `<CURRENT_CHAIN>` = the exact `-f` list in force (see precondition 0.1).

### 2.2 Drive container / image / health / restarts / networks / mounts

```bash
$DOCKER ps --filter name=aegis-prod-drive-1 --format '{{.ID}} {{.Image}} {{.Status}}'
$DOCKER inspect aegis-prod-drive-1 --format 'image={{.Image}} config={{.Config.Image}} restarts={{.RestartCount}} health={{.State.Health.Status}} oom={{.State.OOMKilled}}'
$DOCKER inspect aegis-prod-drive-1 --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}={{$v.IPAddress}} {{end}}'
$DOCKER inspect aegis-prod-drive-1 --format '{{range .Mounts}}{{.Type}} {{.Name}}{{.Source}} -> {{.Destination}} rw={{.RW}}
{{end}}'
$DOCKER inspect aegis-prod-drive-1 --format '{{.HostConfig.GroupAdd}}'
$DOCKER exec aegis-prod-drive-1 wget -qO- http://127.0.0.1:8001/healthz
```

### 2.3 Unrelated services, networks, volumes (must be unchanged after cutover)

```bash
$DOCKER ps --format '{{.Names}} {{.Image}} {{.Status}}' | sort
$DOCKER network ls --format '{{.Name}} {{.Driver}}' | sort
$DOCKER volume ls --format '{{.Name}}' | sort
```

### 2.4 Database: role resolution, counts and the FULL migration-010 precheck (SELECT-only; no secret printed)

Resolve the PostgreSQL user from the running container's environment without printing the password (or set `PGUSER` explicitly to a role that can read `information_schema`/`pg_indexes`):

```bash
PGUSER=$($DOCKER exec aegis-prod-postgres-1 sh -c 'printf %s "$POSTGRES_USER"')
test -n "$PGUSER" || { echo 'set PGUSER explicitly'; exit 1; }
PSQL="$DOCKER exec aegis-prod-postgres-1 psql -U $PGUSER -d aegis_drive -At -v ON_ERROR_STOP=1 -c"
# never: echo/printenv of POSTGRES_PASSWORD; never --env or -E
```

Counts (non-secret):

```bash
$PSQL "SELECT count(*) AS files_total FROM files;"
$PSQL "SELECT count(*) AS files_vault FROM files WHERE vault;"
$PSQL "SELECT count(*) AS files_trashed FROM files WHERE deleted_at IS NOT NULL;"
```

Migration-010 precheck — every line must print `1` (the last one `0`); any other result ⇒ `CUTOVER_ALLOWED=NO`, `MIGRATION_010_REQUIRED=YES`, STOP:

```bash
# files.kind exists, NOT NULL, DEFAULT 'file'
$PSQL "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='files' AND column_name='kind' AND is_nullable='NO' AND column_default LIKE '''file''%';"
# files.kind check constraint
$PSQL "SELECT count(*) FROM pg_constraint WHERE conrelid='public.files'::regclass AND conname='files_kind_check';"
# files.parent_id exists
$PSQL "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='files' AND column_name='parent_id';"
# upload_sessions.parent_id exists
$PSQL "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='upload_sessions' AND column_name='parent_id';"
# indexes
$PSQL "SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND tablename='files' AND indexname='files_parent_id_idx';"
$PSQL "SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND tablename='files' AND indexname='files_unique_name_per_parent_idx';"
# no unclassified rows may remain
$PSQL "SELECT count(*) AS unclassified FROM files WHERE kind IS NULL;"     # expected 0
```

Expected for the media cutover itself: `DATABASE_MUTATION=NO`, `MIGRATION_APPLIED=NO`, `PUBLIC_SHARE_TOUCHED=NO`.

## 3. Candidate image on the host (Owner action; isolated tree, exact SHA)

The stale checkout is not touched. Build only from a separate clone at the exact SHA.

```bash
ORIGIN_URL=$(git -C /opt/aegis/Project-End-The-AEGIS remote get-url origin)      # read-only
sudo install -d -m 0755 /opt/aegis/build
# obtain the source with the host's authorised Git mechanism (this runbook assumes no credentials)
git clone --no-checkout "$ORIGIN_URL" /opt/aegis/build/pr150-${SHA12}
git -C /opt/aegis/build/pr150-${SHA12} checkout --detach ${PREPROD_SHA}
# identity proof — both must hold before building
test "$(git -C /opt/aegis/build/pr150-${SHA12} rev-parse HEAD)" = "${PREPROD_SHA}"
test -z "$(git -C /opt/aegis/build/pr150-${SHA12} status --short)"
cd /opt/aegis/build/pr150-${SHA12}/IDEA1-AEGIS_Drive_LC
$DOCKER build --label org.opencontainers.image.revision=${PREPROD_SHA} -t ${CANDIDATE_TAG} .
$DOCKER image inspect ${CANDIDATE_TAG} --format 'id={{.Id}} rev={{index .Config.Labels "org.opencontainers.image.revision"}} size={{.Size}}'
```

The image id built on the host **will differ** from the pre-production verifier image (`sha256:a89a9e316dfb54f4b2da9c11071b164a2d2b5ace5dcc7809be33f8e28aae57bb`). Mandatory identity proof is the label `org.opencontainers.image.revision == 4d0b4fab0f667f9a161b75a3e497868cbb673fb2` plus the toolchain truth below, which must match exactly:

```bash
$DOCKER run --rm --entrypoint sh ${CANDIDATE_TAG} -c '
  echo NODE=$(node --version) ALPINE=$(cat /etc/alpine-release);
  echo FFMPEG=$(ffmpeg -version | head -1 | cut -d" " -f3) FFPROBE=$(ffprobe -version | head -1 | cut -d" " -f3);
  echo -n "LIBX264="; ffmpeg -hide_banner -encoders 2>/dev/null | grep -qE " libx264 " && echo PRESENT || echo MISSING;
  echo -n "LIBWEBP="; ffmpeg -hide_banner -encoders 2>/dev/null | grep -qE " libwebp " && echo PRESENT || echo MISSING;
  echo -n "DECODERS="; ffmpeg -hide_banner -decoders 2>/dev/null | grep -E "^ V" | grep -oE " (gif|apng|webp|av1|h264|vp8|vp9) " | tr -d "\n"; echo;
  echo -n "DEMUXER_WEBP="; ffmpeg -hide_banner -demuxers 2>/dev/null | grep -qE "^ +D +webp +" && echo PRESENT || echo "MISSING (webp_pipe only)";
  node -e "import(\"sharp\").then(s=>console.log(\"SHARP=\"+s.default.versions.sharp+\" VIPS=\"+s.default.versions.vips))"'
```

Expected: `NODE=v20.20.2 ALPINE=3.23.4`, `FFMPEG=8.0.1 FFPROBE=8.0.1`, `LIBX264=PRESENT`, `LIBWEBP=PRESENT`, decoders `apng av1 gif h264 vp8 vp9 webp`, `DEMUXER_WEBP=MISSING (webp_pipe only)` → `ANIMATED_WEBP_MOTION=POSTER_ONLY_DEGRADATION`, `SHARP=0.35.4 VIPS=8.18.6`. Any mismatch aborts.

## 4. Rendered-config diff (read-only; abort on ANY unexpected difference)

`RENDER_BEFORE` = `<CURRENT_CHAIN>`; `RENDER_AFTER` = `<CURRENT_CHAIN>` + candidate image override + media overlay.

```bash
COMPOSE="$DOCKER compose --env-file /opt/aegis/Project-End-The-AEGIS/.env --project-name aegis-prod"
CHAIN='-f /opt/aegis/runtime/docker-compose.production.yml -f /opt/aegis/runtime/public-share/drive-s5-3.yml -f /opt/aegis/runtime/public-share/drive-gateway-s5-4.yml -f /opt/aegis/runtime/public-share/connector-s5-5.yml -f /opt/aegis/runtime/public-share/docker-compose.s5-11-ui.yml'
# ⚠️ replace CHAIN with the exact live chain recorded in 2.1 if it differs
$COMPOSE $CHAIN config > /tmp/pr150-render-before.yml
$COMPOSE $CHAIN -f /opt/aegis/runtime/pr150/drive-image-${SHA12}.yml -f /opt/aegis/runtime/pr150/drive-media-preview-${SHA12}.yml config > /tmp/pr150-render-after.yml
diff /tmp/pr150-render-before.yml /tmp/pr150-render-after.yml
```

The **only** accepted differences in the diff:

- `services.drive.image` → `aegis-prod-drive:media-preview-4d0b4fab0f66`
- `services.drive.environment` gains exactly `MEDIA_ENABLED, MEDIA_CACHE_DIR, MEDIA_CACHE_MAX_BYTES, MEDIA_WORKERS, MEDIA_STILL_ENGINE, MEDIA_CACHE_POLICY`
- one new mount `aegis_drive_media_cache` → `/var/cache/aegis-media` on `drive`
- top-level `volumes.aegis_drive_media_cache` with `name: aegis_drive_media_cache`

Abort if anything else differs, in particular: Drive networks or static addresses (`aegis_drive_proxy` 172.19.255.3, `aegis_internal` 172.18.0.3, `aegis_public_share_upstream` 172.31.241.3, `aegis_vlan10_macvlan` 192.168.10.11 — as recorded in 2.2), the `/datalake` mount (must stay `rw`), `/run/aegis-telemetry:…:ro`, `/run/aegis-backup:…:ro`, `group_add` (`29100`, `29102`), or any line of `postgres`, `hub`, `monitor`, the Public Share gateway, the connector, the Public Share UI, or any other service.

## 5. Cutover (Drive only) — DO NOT RUN until the review says GO

```bash
$COMPOSE $CHAIN \
  -f /opt/aegis/runtime/pr150/drive-image-${SHA12}.yml \
  -f /opt/aegis/runtime/pr150/drive-media-preview-${SHA12}.yml \
  up -d --no-deps --no-build drive
```

Forbidden: `down`, `pull`, `prune`, `--remove-orphans`, `--force-recreate`, any global recreate, any command without `--no-deps drive`.

Post-recreate proof:

```bash
$DOCKER inspect aegis-prod-drive-1 --format 'image={{.Config.Image}} restarts={{.RestartCount}} health={{.State.Health.Status}} oom={{.State.OOMKilled}}'
$DOCKER inspect aegis-prod-drive-1 --format '{{range .Mounts}}{{.Type}} {{.Name}}{{.Source}} -> {{.Destination}} rw={{.RW}}
{{end}}'      # /datalake rw, telemetry ro, backup ro, aegis_drive_media_cache -> /var/cache/aegis-media
$DOCKER inspect aegis-prod-drive-1 --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}={{$v.IPAddress}} {{end}}'   # identical to 2.2
$DOCKER inspect aegis-prod-drive-1 --format '{{.HostConfig.GroupAdd}}'                                                # identical to 2.2
$DOCKER volume inspect aegis_drive_media_cache --format '{{.Name}} {{.Mountpoint}}'
$DOCKER exec aegis-prod-drive-1 wget -qO- http://127.0.0.1:8001/healthz   # media.enabled true, ffmpeg 8.0.1, sharp 0.35.4, cacheWritable true, cacheVolume "volume"
$DOCKER exec aegis-prod-drive-1 ls -ld /var/cache/aegis-media             # owner node
$DOCKER ps --format '{{.Names}} {{.Image}} {{.Status}}' | sort             # every other service unchanged vs 2.3
```

## 6. Browser acceptance (mandatory, Owner; not weakened by this runbook)

- REAL Production ~49.7 MB GIF and REAL ~196 MB video (the pre-production gate used deterministic fixtures: `REAL_49_7MB_GIF_PREPROD=NOT_AVAILABLE`).
- Cold: icon/pending → server poster. Warm: poster immediately from the derivative/cache path.
- GIF first hover while the motion proxy is not yet ready → playback starts automatically once the proxy is ready, with NO mouse re-entry. `mouseleave` → poster immediately visible.
- Video: poster + hover proxy.
- Network log: the grid must not fetch any original media body (only `POST /api/files/media-info/batch`, poster and motion-preview derivatives; `/api/files/:id/preview` only from the explicit Preview dialog).
- Cross-account: A views a poster → logout → the anonymous request reaches the server and gets 401 → B logs in on the same browser → the request for A's row reaches the server and gets 404 (a real network request, not "from disk cache").
- Reduced motion: poster yes, motion autoplay no.
- Resources: `RestartCount` unchanged, `OOMKilled=false`, no HTTP request > 5 s, no unrelated service change (`docker stats`, child `VmHWM`, p95 before/during a 300 MB-class and a 10 GB-class job as in plan Task 18 Step 11).
- Animated WebP: poster-only degradation is the expected, truthful behaviour (`DEMUXER_WEBP_MISSING`).

## 7. Rollback — omit both new PR150 files (nothing is restored or rewritten)

```bash
$COMPOSE $CHAIN up -d --no-deps --no-build drive      # exact PRE-CUTOVER chain: no candidate image override, no media overlay
```

`drive-s5-3.yml` and every other active file were never modified, so nothing is edited or restored. Prove after rollback:

```bash
$DOCKER inspect aegis-prod-drive-1 --format 'image={{.Config.Image}} restarts={{.RestartCount}} health={{.State.Health.Status}}'   # image == PRE_CUTOVER_DRIVE_IMAGE
$DOCKER inspect aegis-prod-drive-1 --format '{{range .Mounts}}{{.Destination}} rw={{.RW}} {{end}}'                             # no /var/cache/aegis-media; /datalake rw; telemetry/backup ro
$DOCKER inspect aegis-prod-drive-1 --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}={{$v.IPAddress}} {{end}}'         # same networks and addresses as 2.2
$DOCKER inspect aegis-prod-drive-1 --format '{{.HostConfig.GroupAdd}}'                                                             # same group_add
```

The volume `aegis_drive_media_cache` stays in place, unused. It is **not** deleted on the rollback critical path (Docker refuses while any container references it; removal is optional housekeeping later). Kill switches that avoid a redeploy: `MEDIA_ENABLED=false`, `MEDIA_STILL_ENGINE=ffmpeg`, `MEDIA_CACHE_POLICY=revalidate` — edit only the media overlay, then the same section-5 command.

## 8. Evidence recorded by the pre-production gate (values, not promises)

Authoritative run inside the final candidate image `sha256:a89a9e316dfb54f4b2da9c11071b164a2d2b5ace5dcc7809be33f8e28aae57bb` (`org.opencontainers.image.revision=4d0b4fab0f667f9a161b75a3e497868cbb673fb2`, `MEDIA_TOOLCHAIN_PROVENANCE=PACKAGED_CANDIDATE`), Alpine 3.23.4, Node v20.20.2, ffmpeg/ffprobe 8.0.1 (apk `8.0.1-r1`), sharp 0.35.4 / libvips 8.18.6. Host tools are supplemental only. Full Linux/PostgreSQL verification at the same SHA: 1871 tests / 1827 pass / 1 accepted historical failure (PS6-ENV-4 Node 24 reporter signature) / 43 skips (linux-gate tool skips covered by the in-image run); `NEW_FAILURE_COUNT=0`.

| Class | Fixture (stat) | Result | Source read (rchar) | Notes |
|---|---|---|---|---|
| IMAGE_200MB (7000×5000 rgb16 PNG) | 210,069,458 B | poster OK ≤ 512 KiB, sharp | — | 35 MP ≤ 40 MP guard |
| IMAGE_300MB (8000×5000 rgba16 PNG) | 320,103,184 B | poster OK, sharp | — | exactly the 40 MP guard (allowed) |
| OVER_PIXELS (9000×5000 header) | header only | UNSUPPORTED / DIMENSIONS in ms, no decode | — | |
| GIF_518KB / GIF_49MB | 536,442 B / 52,416,569 B | poster + motion OK | 2,204,669 / 91,509,512 B | recorded, not bounded |
| GIF_200MB hi/lo | 220,155,593 / 233,857,170 B | motion 6 s ≤ 4 MiB, in time | hi 682,192,994 / lo 636,977,707 B | ≈ 3–4× file size across probe/poster/motion passes; hi/lo ratio 1.07 recorded, no ordering claim |
| GIF_300MB hi/lo | 325,100,320 / 337,571,675 B | OK | hi 1,026,615,257 / lo 824,840,436 B | ratio 1.25 recorded |
| APNG_200MB hi/lo | 220,122,905 / 213,633,712 B | OK | hi 103,672,762 / lo 907,894 B | ratio 114 recorded |
| APNG_300MB hi/lo | 324,770,259 / 350,038,032 B | OK | hi 99,806,138 / lo 906,934 B | ratio 110 recorded |
| VIDEO_196MB (H.264 720p) | 199,818,965 B | poster 12,638 B + motion 10,606 B | 34,400,723 B | browser transfer = derivatives only |
| MP4_FASTSTART 10G / 20G (sparse, structurally verified, ≤ 32 KiB allocated) | 10,737,428,356 / 21,474,846,596 B | poster + motion OK | 29,067 / 15,627 B | **< 64 MiB bound MET (asserted)** |
| MP4_MOOV_AT_END 10G / 20G | same | poster + motion OK (moov read from the end) | 23,307 / 21,387 B | recorded (not claimed as a bound) |
| WEBM_CUES_MID 10G / 20G (Void after first Cluster) | 10,737,492,313 / 21,474,910,553 B | poster + motion OK; motion 31.3 s / 61.1 s | 10,727,191,552 / 21,464,640,640 B | **read-bound NOT MET on the sparse fixture**: the packaged matroska demuxer reads through the synthetic Void (MP4 `free` is seeked past); VmHWM 46 MiB; within the 120 s timeout; not generalised to real files, which carry no Void |
| WEBM_NO_CUES_MID 10G / 20G | same | 10G: poster 30.7 s + motion 31.1 s OK; 20G: poster truthful TRANSIENT/TIMEOUT at 60 s | 21,470,069,899 / 21,463,062,198 B | each stage reads through the Void; recorded |
| WEBM_*_VOID_FIRST 10G (plan layout: 10 GiB before the first Cluster) | 10,737,444,881 B | truthful PROBE_FAILED (20 s probe timeout), VmHWM ≤ 36 MiB, no hang | 6,913,177,057 / 7,022,753,251 B | pathological shape; recorded |
| WEBM_CUES_VOID_FIRST 20G | — | NOT_PROVEN (verification ffprobe exceeded the 60 s check; consistent across runs) | — | |
| WEBM_NO_CUES_VOID_FIRST 20G | 21,474,863,034 B | truthful PROBE_FAILED | 7,029,208,543 B | |

Responsiveness (30 s baseline at 5 req/s, `/healthz` + `GET /api/files`): baseline p95 9 / 4 ms; during the 300 MB-class GIF job (finished in 0.8 s) 10 / 6 ms; during the sparse 10 GiB MP4 moov-at-end job (0.2 s) 5 / 3 ms; REGRESSION_RATIO 1.11 / 0.56 (healthz), 1.50 / 0.75 (files) — below the 2.0 review trigger; zero non-200, none > 5 s; child peak VmHWM 61,404 KiB (60.0 MiB) over 6 runs; container cgroup CPU 36.9 s; no restart (single `docker run`), OOMKilled=false. `REAL_49_7MB_GIF_PREPROD=NOT_AVAILABLE` — the deterministic 45–55 MiB fixture was used; the real files stay mandatory in section 6.

## 9. Design deviation record — list view

```
LIST_ROW_MEDIA_PREVIEW=NOT_IMPLEMENTED
LIST_ROW_CURRENT_BEHAVIOR=ICON_ONLY
PRODUCTION_IMPACT=NONE
FINAL_DOC_RECONCILIATION_REQUIRED=YES
```

The approved design text described a 32 px poster in list rows. The implementation on this SHA renders server derivatives in the **grid** only; list rows keep their icon-only visuals (they never fetched previews before either). This is a truthful record for the final documentation reconciliation, not an instruction to add UI work in this gate.
