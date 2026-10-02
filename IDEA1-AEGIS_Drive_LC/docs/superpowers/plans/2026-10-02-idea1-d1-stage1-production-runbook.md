# IDEA1 D-1 Stage 1 — Compatibility / read-only Production runbook

> **Package status:** `STAGE1_PACKAGE=READY_FOR_HUMAN_REVIEW`; Human package-review decisions D1–D5 recorded in §3;
> local rollback A′ rehearsal (D4) recorded in §16.1. `HG_S1` is the Human Owner's decision and is **not** granted by this document.
> **Nothing in this document has been executed.** `PRODUCTION_MIGRATION_EXECUTED=NO`,
> `PRODUCTION_DEPLOYED=NO`, `PRODUCTION_FLAGS_CHANGED=NO`, `WRITER_ENABLED=NO`.
> Every command below is for the **Human Owner** to run, only after separate
> **HG-S1** authorization. An agent may prepare, review, and correct this package;
> an agent never runs migration 012, restarts Drive, loads an image, edits the live
> Compose chain, or changes Production environment.

Plan: `docs/superpowers/plans/2026-10-02-idea1-d1-separate-encrypted-preview-index-implementation.md`, Phase J, Stage 1.
Design: `docs/superpowers/specs/2026-10-01-idea1-d1-separate-encrypted-preview-index-design.md`.
Precedent: `IDEA1-AEGIS_Drive_LC/docs/superpowers/plans/2026-09-23-private-vault-production-rollout-runbook.md` (PR187).

## 1. Identity of the Stage 1 candidate

```text
REPOSITORY=kraveerachat/Project-End-The-AEGIS
STAGE1_CANDIDATE_SHA=9f5a01148ce016bc0056dbbcc85ac8a3e5fac23f   # merge of PR #297 into main (post-privilege-fix authority)
PR_A=#283 MERGED at fa22edd5d5db18e692e7814b895f7af3d3c166dc    # ancestor of the candidate: verified
PR_B=#285 MERGED at 4a8cc3c95e2f4147fbab9c505079c0377a271d99    # ancestor of the candidate: verified
PR_297=#297 MERGED at 9f5a01148ce016bc0056dbbcc85ac8a3e5fac23f  # preview-index DELETE privilege fix (head 04890e18)
STAGE_1_BUILD=PR_A_MERGED + PR_B_MERGED + PR_297_MERGED          # plan §0 binding condition satisfied
SUPERSEDED_CANDIDATE=4a8cc3c95e2f4147fbab9c505079c0377a271d99    # NOT deployable: its migration 012 left drive_app DELETE on preview-index tables
CANDIDATE_IMAGE=aegis-prod-drive:preview-d1-s1-9f5a01148ce0
CANDIDATE_OCI_REVISION=9f5a01148ce016bc0056dbbcc85ac8a3e5fac23f
CANDIDATE_OCI_SOURCE=https://github.com/kraveerachat/Project-End-The-AEGIS

ROLLBACK_TARGET_IMAGE=aegis-prod-drive:p1-8634360f74ed             # previous accepted P1 runtime
ROLLBACK_TARGET_REVISION=8634360f74ed2f50b2fcb49925a3d273c605a8a2
ROLLBACK_TARGET_P1_OVERLAY=/opt/aegis/runtime/preview-p1/drive-image-8634360f74ed.yml
ROLLBACK_TARGET_P1_OVERLAY_SHA256=de6b877b13d8fe1d8ee5c550589d54816cd536c141d345be3e69ceda3379a1f7

MIGRATION=IDEA1-AEGIS_Drive_LC/server/db/migrations/012_vault_preview_index_v1.sql
MIGRATION_GIT_BLOB=540e2a4e091211b15a64dbf221a0b9f64ccd5a2f
MIGRATION_SHA256=aac26537c1500737f2fada157696ca5522d34e3386099f3d580151c45cbcb239   # `git show <SHA>:<path> | sha256sum` (LF bytes)

OVERLAY_IMAGE=IDEA1-AEGIS_Drive_LC/deploy/production/d1/drive-image-9f5a01148ce0.yml
OVERLAY_IMAGE_SHA256=49b0ad5fbe0f49a9cfe168ec28c12aeb3f6fe1ead6dd870105423f4b37b96f78
OVERLAY_FLAGS=IDEA1-AEGIS_Drive_LC/deploy/production/d1/drive-preview-index-stage1-9f5a01148ce0.yml
OVERLAY_FLAGS_SHA256=7c5f0df78c3f5cf46bb2edd83bb8b015ed63d9645ed8de22c69eb1d8d6216a59
PRODUCTION_RUNTIME_DIR=/opt/aegis/runtime/preview-d1
```

Server code delta from the accepted P1 runtime (`8634360f..9f5a0114`, `IDEA1-AEGIS_Drive_LC/server` +
`package*.json` + `Dockerfile`): 10 server files, all D-1 PR-A (flags, migration 012 + `schema.sql`, read store,
schema probe, read-only router, inventory exclusion, boot log); `4a8cc3c9..9f5a0114` changes only migration 012
(PR #297 privilege narrowing) in Drive runtime inputs. `package.json`, `package-lock.json`, and
`Dockerfile` are unchanged since P1, so the runtime toolchain is the P1 toolchain.

### Effective Stage 1 configuration

| Variable | Stage 1 value | Source |
|---|---|---|
| `VAULT_PREVIEW_INDEX_SCHEMA_AVAILABLE` | `true` | flags overlay |
| `VAULT_PREVIEW_INDEX_READ_ENABLED` | `true` | flags overlay |
| `VAULT_PREVIEW_INDEX_WRITE_ENABLED` | `false` | flags overlay |
| `VAULT_PREVIEW_INDEX_MAX_RETAINED_BYTES_PER_OWNER` | **unset** (must not appear anywhere) | absent; allowed only while WRITE=false |
| `VAULT_MEDIA_PREVIEW_ENABLED` | `true` (live value restated; READ chain requires it) | flags overlay; precondition proves live value is already `true` |
| `VAULT_DESTRUCTIVE_PURGE_ENABLED` | `false` (live value restated) | flags overlay; precondition proves live value is already `false` |
| `VAULT_TREE_SCHEMA_AVAILABLE`, `VAULT_TREE_PROTOCOL_ENABLED`, `VAULT_TREE_GENESIS_MIGRATION_ENABLED`, `VAULT_TREE_UI_ENABLED` | **unchanged** from live chain | not in any D-1 overlay; pre/post equality is checked |
| Other `VAULT_PREVIEW_INDEX_MAX_*` limits | code defaults (64 / 64 / 32), not set | not in any D-1 overlay |

The server flag chain (`server/config/vaultTreeLimits.js`) fails boot if `READ=true` without
`VAULT_MEDIA_PREVIEW_ENABLED=true`, or if `SCHEMA=true` and migration 012's three tables or widened lifecycle CHECK
are missing. A failed boot is a configuration STOP, not something to work around.

## 2. Frozen safety rules

- Never run `docker compose down`, any prune, `--remove-orphans`, a global recreate, or database-volume recreation.
- Never edit an active Compose file in place. Append the reviewed D-1 overlays after the captured live chain.
- Every service operation names `drive` and uses `up -d --no-deps --no-build drive`.
- Never print a password, `.env`, the full container environment, a session secret, cookie, or token. Only the
  allow-listed `VAULT_*` flag lines below are printed.
- Never set `VAULT_PREVIEW_INDEX_WRITE_ENABLED=true` and never set `VAULT_PREVIEW_INDEX_MAX_RETAINED_BYTES_PER_OWNER`
  in Stage 1.
- Never run a down-migration. Migration 012 is retained on every rollback. No table, row, or blob is deleted.
- Never enable destructive purge. Never return any TREE_V1 owner to pre-PR157 code (PR187 boundary still holds;
  the P1 image is TREE-capable).
- Never modify Public Share, HUB, Monitor, IDEA2, IDEA3, gateway, or PostgreSQL configuration.
- Never create preview-index data. Stage 1 must end with zero index rows.
- Any `STOP` line ends the session. Never rewrite an expected value to make a check pass.

## 3. Human package-review decisions (2026-10-02)

| # | Decision | Effect on this runbook |
|---|---|---|
| D1 | `D1_STAGE1_WRITE_503_SUBSTITUTE=APPROVED`. The Stage 1 build has **no** preview-index mutation route: `requirePreviewIndexWrite` (503 `PREVIEW_INDEX_WRITE_DISABLED`) is defined in `server/routes/vaultPreviewIndex.js` but mounted on no route (static mutating-handler count `0`; test `PI-API-8`). An authenticated `POST /api/vault/tree/preview-index/head` returns **404 `{"error":"Not found"}`**; a browser request without a CSRF token is rejected 403 earlier. No runtime code is changed to produce a 503. | `STAGE1_WRITE_ROUTE_PRESENT=NO`, `STAGE1_WRITE_ROUTE_404=EXPECTED`, `STAGE1_WRITE_CAPABILITY=NOT_ROUTABLE`, `STAGE2_WRITE_DISABLED_503_REQUIRED=YES`. Stage 1 S-WRITE = `/state previewIndexWriteEnabled=false` + mutation route absent/404 + boot line `write disabled` + zero preview-index rows. **503 is not required at Stage 1**; the live 503 write-gate acceptance moves to Stage 2 (post-PR-C). Do not send mutating probes to Production. |
| D2 | `D2_NEW_USER_SETUP_PRECONDITION=APPROVED`. `GET /preview-index/head` requires TREE_V1; before Vault setup it answers **409 `TREE_STATE_CONFLICT`**. | NEWLY_CREATED_USER before Vault setup: `409 = ACCOUNT_NOT_SETUP` — neither PASS nor FAIL. The account completes normal Vault setup; only a subsequent **404 `PREVIEW_INDEX_NOT_FOUND`** may PASS that cell. |
| D3 | `D3_SERVER_SIDE_HEAD_CHECK_REQUIRED=APPROVED`. The client maps both 404 `PREVIEW_INDEX_NOT_FOUND` and 503 `PREVIEW_INDEX_DISABLED` to the original fallback, so browser behaviour alone cannot prove READ is on. | S-HEAD (direct authenticated `GET /api/vault/tree/preview-index/head`) is mandatory per account. After Vault setup expect 404 `PREVIEW_INDEX_NOT_FOUND`; 503 `PREVIEW_INDEX_DISABLED` = Stage 1 configuration FAIL. |
| D4 | `D4_LOCAL_ROLLBACK_A_PRIME_REQUIRED_BEFORE_HG_S1=YES`; `HG_S1=WITHHELD_PENDING_LOCAL_ROLLBACK_A_PRIME`. | Local disposable rehearsal recorded in §16.1, re-run on the post-PR #297 candidate `9f5a0114` with corrected migration 012. HG-S1 may be requested only after it passes. |
| D5 | `D5_LIVE_COMPOSE_DISCOVERY_FAIL_CLOSED=APPROVED`. | Step 2 discovers the live chain read-only from container labels and STOPs if the chain cannot be determined, an unexpected Compose file is present, the active image/revision differs from the expected authority, an unrelated overlay would be dropped, or any discovered state contradicts this runbook. No mutation during discovery. |

Corroborating independent rehearsal (Codex, local, recorded as reported to the Human Owner; it did **not** cover rollback A′).
Historical: it ran against the **superseded** candidate `4a8cc3c9` (pre-PR #297 migration 012); it is not evidence for
the current package's privilege state:

```text
MAIN_SHA=4a8cc3c95e2f4147fbab9c505079c0377a271d99
MIGRATION012_LOCAL=PASS
SERVER_BOOT=PASS
HEALTHZ=200
STATE_FLAGS=schema=true,read=true,write=false
HEAD_ABSENT_404=PASS
WRITE_ROUTE_POST=404_EXPECTED_FOR_STAGE1
INDEX_ROWS_CREATED=0
FOCUSED_COMPAT_TESTS=60/60 PASS
PRODUCTION_TOUCHED=NO
```

## 4. Step 0 — approved build workstation: build the exact-source image (Human)

Run in **Git Bash** (not PowerShell: `>` in PowerShell re-encodes bytes and breaks the SHA-256 checks).

```bash
set -euo pipefail
SHA=9f5a01148ce016bc0056dbbcc85ac8a3e5fac23f
REPO=/c/path/to/AEGIS_System            # any clone of kraveerachat/Project-End-The-AEGIS
WT=/c/aegis-build-d1-s1-9f5a01148ce0

git -C "$REPO" fetch origin
git -C "$REPO" merge-base --is-ancestor fa22edd5d5db18e692e7814b895f7af3d3c166dc "$SHA" && echo PR_A_IN_CANDIDATE=YES
git -C "$REPO" merge-base --is-ancestor 3747a183 "$SHA" && echo PR_B_IN_CANDIDATE=YES
git -C "$REPO" merge-base --is-ancestor 04890e18 "$SHA" && echo PR_297_IN_CANDIDATE=YES
git -C "$REPO" -c core.autocrlf=false worktree add --detach "$WT" "$SHA"   # LF checkout: image bytes match Git
test -z "$(git -C "$WT" status --porcelain)" || { echo 'STOP: build worktree is not clean' >&2; exit 1; }

cd "$WT/IDEA1-AEGIS_Drive_LC"
docker build \
  --label org.opencontainers.image.revision=$SHA \
  --label org.opencontainers.image.source=https://github.com/kraveerachat/Project-End-The-AEGIS \
  -t aegis-prod-drive:preview-d1-s1-9f5a01148ce0 .

docker image inspect aegis-prod-drive:preview-d1-s1-9f5a01148ce0 \
  --format 'ID={{.Id}} REV={{index .Config.Labels "org.opencontainers.image.revision"}} SOURCE={{index .Config.Labels "org.opencontainers.image.source"}} USER={{.Config.User}}'

# Image must not carry Vault flags, DATABASE_URL, or credentials.
docker image inspect aegis-prod-drive:preview-d1-s1-9f5a01148ce0 --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | cut -d= -f1 | grep -E '^(VAULT_|DATABASE_URL|PG|POSTGRES|SESSION|SECRET)' && { echo 'STOP: image bakes forbidden env' >&2; exit 1; } || echo 'IMAGE_ENV_CLEAN=YES'

# Exact migration and overlays from Git objects (LF bytes), plus hashes.
OUT="$USERPROFILE/Downloads/aegis-d1-s1"; mkdir -p "$OUT"
git -C "$REPO" show "$SHA:IDEA1-AEGIS_Drive_LC/server/db/migrations/012_vault_preview_index_v1.sql" > "$OUT/012_vault_preview_index_v1.sql"
DEPLOY_REF=origin/deploy/idea1-preview-d1-stage1   # or the exact reviewed commit of this package PR
git -C "$REPO" show "$DEPLOY_REF:IDEA1-AEGIS_Drive_LC/deploy/production/d1/drive-image-9f5a01148ce0.yml" > "$OUT/drive-image-9f5a01148ce0.yml"
git -C "$REPO" show "$DEPLOY_REF:IDEA1-AEGIS_Drive_LC/deploy/production/d1/drive-preview-index-stage1-9f5a01148ce0.yml" > "$OUT/drive-preview-index-stage1-9f5a01148ce0.yml"
sha256sum "$OUT"/*
docker save --output "$OUT/aegis-prod-drive-preview-d1-s1-9f5a01148ce0.tar" aegis-prod-drive:preview-d1-s1-9f5a01148ce0
sha256sum "$OUT/aegis-prod-drive-preview-d1-s1-9f5a01148ce0.tar"
```

Build from an LF checkout (`core.autocrlf=false` above). A Windows CRLF checkout still produces a working image,
but its copied source files (including the unused in-image copy of migration 012) differ from Git bytes, so it is not
byte-reproducible. Migration 012 is always applied from the Git blob (§8), never from the image.

Required: `PR_A_IN_CANDIDATE=YES`, `PR_B_IN_CANDIDATE=YES`, `PR_297_IN_CANDIDATE=YES`, `REV=9f5a0114…`, `USER=node`, `IMAGE_ENV_CLEAN=YES`,
migration SHA-256 `aac26537…b239`, overlay SHA-256 values from §1. Record `CANDIDATE_IMAGE_ID` and the archive
SHA-256. Transfer with the established mechanism (PR187 §B: `scp -i ~/.ssh/id_ed25519_admin-main_thispc … admin-main@192.168.10.10:/tmp/`):
the archive, the migration file, and both overlays, all to `/tmp/` on the host.

Record:

```text
CANDIDATE_IMAGE_ID=
CANDIDATE_ARCHIVE_SHA256=
BUILD_NODE= / ALPINE= / FFMPEG=        # optional: docker run --rm --entrypoint sh <image> -c 'node -v; cat /etc/alpine-release; ffmpeg -version | head -1'
```

## 5. Step 1 — Backup gate (Human)

Use the existing backup-agent flow exactly as in PR187. Required evidence before any further step:

```text
PRE_DEPLOY_BACKUP=PASS
BACKUP_FRESH=YES                        # finished inside this maintenance window, after the last intended user write
BACKUP_JOB_ID=
BACKUP_SNAPSHOT_ID=
BACKUP_FINISHED_AT=
BACKUP_INTEGRITY_CHECK=PASS
RESTORE_VERIFY_JOB_ID=
RESTORE_VERIFICATION=PASS
BACKUP_TARGET=
BACKUP_TARGET_PROTECTION=DIFFERENT_DEVICE
```

Known debt from PR187: backup credentials bind to an ephemeral Docker bridge address. If `PG_DUMP_FAILED` recurs,
diagnose the host binding only, without printing or changing the password, exactly as before. **No backup PASS → STOP.**

## 6. Step 2 — Production host: read-only preconditions (Human)

Run every later step **in this same shell**. It keeps the baseline values in memory for exact post-checks.

```bash
set -euo pipefail
D=(sudo env -u DOCKER_HOST -u CONTAINER_HOST docker)
COMPOSE=("${D[@]}" compose --env-file /opt/aegis/Project-End-The-AEGIS/.env --project-name aegis-prod)
PSQL_RO() { "${D[@]}" exec -i aegis-prod-postgres-1 sh -lc 'psql -X -qAt -U "$POSTGRES_USER" -d aegis_drive -v ON_ERROR_STOP=1'; }

EXPECTED_CURRENT_DRIVE_IMAGE=aegis-prod-drive:p1-8634360f74ed
EXPECTED_CURRENT_REVISION=8634360f74ed2f50b2fcb49925a3d273c605a8a2
EXPECTED_P1_OVERLAY=/opt/aegis/runtime/preview-p1/drive-image-8634360f74ed.yml
EXPECTED_P1_OVERLAY_SHA256=de6b877b13d8fe1d8ee5c550589d54816cd536c141d345be3e69ceda3379a1f7
FLAG_RE='^(VAULT_TREE_SCHEMA_AVAILABLE|VAULT_TREE_PROTOCOL_ENABLED|VAULT_TREE_GENESIS_MIGRATION_ENABLED|VAULT_TREE_UI_ENABLED|VAULT_MEDIA_PREVIEW_ENABLED|VAULT_DESTRUCTIVE_PURGE_ENABLED|VAULT_PREVIEW_INDEX_[A-Z_]+)='
TREE_FLAG_RE='^(VAULT_TREE_SCHEMA_AVAILABLE|VAULT_TREE_PROTOCOL_ENABLED|VAULT_TREE_GENESIS_MIGRATION_ENABLED|VAULT_TREE_UI_ENABLED)='

# 2.1 Live Compose chain (truth comes from the running container, not from this document)
LIVE_PROJECT=$("${D[@]}" inspect aegis-prod-drive-1 --format '{{index .Config.Labels "com.docker.compose.project"}}')
LIVE_SERVICE=$("${D[@]}" inspect aegis-prod-drive-1 --format '{{index .Config.Labels "com.docker.compose.service"}}')
LIVE_CONFIG_FILES=$("${D[@]}" inspect aegis-prod-drive-1 --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}')
printf 'LIVE_PROJECT=%s\nLIVE_SERVICE=%s\nLIVE_CONFIG_FILES=%s\n' "$LIVE_PROJECT" "$LIVE_SERVICE" "$LIVE_CONFIG_FILES"
test "$LIVE_PROJECT" = aegis-prod || { echo 'STOP: live Drive Compose project mismatch' >&2; exit 1; }
test "$LIVE_SERVICE" = drive || { echo 'STOP: live Drive Compose service mismatch' >&2; exit 1; }
test -n "$LIVE_CONFIG_FILES" || { echo 'STOP: live Compose chain cannot be determined' >&2; exit 1; }
LIVE_ENV_FILE=$("${D[@]}" inspect aegis-prod-drive-1 --format '{{index .Config.Labels "com.docker.compose.project.environment_file"}}')
printf 'LIVE_ENV_FILE=%s
' "$LIVE_ENV_FILE"   # path only; never print its contents
test "$LIVE_ENV_FILE" = /opt/aegis/Project-End-The-AEGIS/.env || { echo 'STOP: live env-file differs from the runbook COMPOSE definition' >&2; exit 1; }
IFS=',' read -r -a LIVE_FILES <<< "$LIVE_CONFIG_FILES"
CHAIN=(); for f in "${LIVE_FILES[@]}"; do test -f "$f" || { echo "STOP: live chain file missing: $f" >&2; exit 1; }; CHAIN+=(-f "$f"); done
test "${LIVE_FILES[-1]}" = "$EXPECTED_P1_OVERLAY" || { echo 'STOP: live chain does not end with the accepted P1 overlay' >&2; exit 1; }
case "$LIVE_CONFIG_FILES" in *preview-d1*) echo 'STOP: a D-1 overlay is already in the live chain' >&2; exit 1;; esac
test "$(sha256sum "$EXPECTED_P1_OVERLAY" | cut -d' ' -f1)" = "$EXPECTED_P1_OVERLAY_SHA256" || { echo 'STOP: P1 overlay SHA-256 mismatch' >&2; exit 1; }
# Human: read the printed chain and confirm every element is explained. Any unexplained or unexpected file → STOP.
# Every live file is re-used verbatim in CHAIN, so no unrelated overlay can be dropped by Stage 1 or by rollback A′.
# Discovery is read-only: nothing above writes, restarts, or renders to disk.

# 2.2 Running Drive / PostgreSQL / rollback image presence
IFS='|' read -r CUR_IMAGE CUR_HEALTH CUR_RESTARTS CUR_OOM < <("${D[@]}" inspect aegis-prod-drive-1 --format '{{.Config.Image}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.RestartCount}}|{{.State.OOMKilled}}')
printf 'CUR_IMAGE=%s\nCUR_HEALTH=%s\nCUR_RESTARTS=%s\nCUR_OOM=%s\n' "$CUR_IMAGE" "$CUR_HEALTH" "$CUR_RESTARTS" "$CUR_OOM"
test "$CUR_IMAGE" = "$EXPECTED_CURRENT_DRIVE_IMAGE" || { echo 'STOP: current Drive image is not the accepted P1 image' >&2; exit 1; }
test "$CUR_HEALTH" = healthy || { echo 'STOP: current Drive not healthy' >&2; exit 1; }
test "$CUR_OOM" = false || { echo 'STOP: current Drive OOMKilled' >&2; exit 1; }
P1_REV=$("${D[@]}" image inspect "$EXPECTED_CURRENT_DRIVE_IMAGE" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
P1_IMAGE_ID=$("${D[@]}" image inspect "$EXPECTED_CURRENT_DRIVE_IMAGE" --format '{{.Id}}')
printf 'P1_REV=%s\nP1_IMAGE_ID=%s\n' "$P1_REV" "$P1_IMAGE_ID"
test "$P1_REV" = "$EXPECTED_CURRENT_REVISION" || { echo 'STOP: rollback image revision mismatch' >&2; exit 1; }
RUNNING_IMAGE_ID=$("${D[@]}" inspect aegis-prod-drive-1 --format '{{.Image}}')
test "$RUNNING_IMAGE_ID" = "$P1_IMAGE_ID" || { echo 'STOP: running Drive image ID differs from the tagged P1 image (tag moved?)' >&2; exit 1; }
IFS='|' read -r PG_IMAGE PG_HEALTH PG_RESTARTS PG_OOM < <("${D[@]}" inspect aegis-prod-postgres-1 --format '{{.Config.Image}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.RestartCount}}|{{.State.OOMKilled}}')
printf 'PG_IMAGE=%s\nPG_HEALTH=%s\nPG_RESTARTS=%s\nPG_OOM=%s\n' "$PG_IMAGE" "$PG_HEALTH" "$PG_RESTARTS" "$PG_OOM"
test "$PG_HEALTH" = healthy || { echo 'STOP: PostgreSQL not healthy' >&2; exit 1; }

# 2.3 Live Vault flags (allow-listed names only; values are booleans/limits, never secrets)
PRE_FLAGS=$("${D[@]}" inspect aegis-prod-drive-1 --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E "$FLAG_RE" | sort || true)
printf 'PRE_FLAGS:\n%s\n' "$PRE_FLAGS"
grep -qx 'VAULT_MEDIA_PREVIEW_ENABLED=true' <<< "$PRE_FLAGS" || { echo 'STOP: live VAULT_MEDIA_PREVIEW_ENABLED is not true (overlay would change it)' >&2; exit 1; }
grep -qx 'VAULT_DESTRUCTIVE_PURGE_ENABLED=false' <<< "$PRE_FLAGS" || { echo 'STOP: live VAULT_DESTRUCTIVE_PURGE_ENABLED is not false' >&2; exit 1; }
grep -q '^VAULT_PREVIEW_INDEX_' <<< "$PRE_FLAGS" && { echo 'STOP: a VAULT_PREVIEW_INDEX_* variable is already present' >&2; exit 1; } || true
PRE_TREE_FLAGS=$(grep -E "$TREE_FLAG_RE" <<< "$PRE_FLAGS" || true)

# 2.4 Non-Drive containers (must be unchanged after every Drive-only step)
PRE_OTHERS=$("${D[@]}" ps --format '{{.Names}}' | grep -vx aegis-prod-drive-1 | sort | while read -r n; do "${D[@]}" inspect "$n" --format '{{.Name}}|{{.Config.Image}}|{{.Image}}|{{.State.StartedAt}}|{{.RestartCount}}'; done)
printf 'NON_DRIVE_CONTAINER_COUNT=%s\n' "$(printf '%s\n' "$PRE_OTHERS" | grep -c . || true)"

# 2.5 Database read-only baseline
PSQL_RO <<'SQL'
SELECT 'POSTGRES_VERSION_NUM=' || current_setting('server_version_num');
SELECT 'MIGRATION_ROLE_IS_SUPERUSER=' || rolsuper FROM pg_roles WHERE rolname = current_user;
SELECT 'TREE_TABLE_COUNT=' || count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN
  ('vault_tree_state','vault_tree_frozen_inventory','vault_tree_key_envelope','vault_tree_heads','vault_tree_revisions','vault_tree_blob_state','vault_tree_purge_candidates');
SELECT 'D1_TABLE_COUNT=' || count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN
  ('vault_preview_index_heads','vault_preview_index_generations','vault_preview_index_blob_refs');
SELECT 'LIFECYCLE_CHECK=' || conname || ' ' || pg_get_constraintdef(oid) FROM pg_constraint
 WHERE conrelid = 'vault_tree_blob_state'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%lifecycle%';
SELECT 'LIFECYCLE_ROWS ' || lifecycle || '=' || count(*) FROM vault_tree_blob_state GROUP BY lifecycle ORDER BY lifecycle;
SELECT 'TREE_V1_OWNERS=' || count(*) FROM vault_tree_state WHERE protocol_state = 'TREE_V1';
SELECT 'INVALID_INDEX_COUNT=' || count(*) FROM pg_index WHERE NOT indisvalid;
SQL
```

Required: `POSTGRES_VERSION_NUM` major 15; `MIGRATION_ROLE_IS_SUPERUSER=true`; `TREE_TABLE_COUNT=7`;
`D1_TABLE_COUNT=0`; exactly one `LIFECYCLE_CHECK` line whose definition lists only the four original values;
`INVALID_INDEX_COUNT=0`. Record every line. If `D1_TABLE_COUNT` is not 0, STOP and investigate (012 is idempotent,
but an unexplained earlier application is an evidence gap).

Baseline fingerprints (print only hashes):

```bash
vault_protected_sha256() {   # PR187 protected Vault contract — unchanged
  PSQL_RO <<'SQL' | sha256sum | cut -d' ' -f1
COPY (
  SELECT payload FROM (
    SELECT 0 AS r, 'contract'::text AS k1, ''::text AS k2, jsonb_build_array('PR187_STAGE_A_PROTECTED_VAULT_V1','vault_meta:user_id','vault_blobs:id','vault_v2_blobs:id','vault_v2_blob_chunks:blob_id,chunk_index')::text AS payload
    UNION ALL SELECT 1, lpad(user_id::text,20,'0'), '', jsonb_build_array('vault_meta',user_id,salt_b64,kdf,memory_kib,iterations,parallelism,verifier_iv,verifier_data,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))::text FROM vault_meta
    UNION ALL SELECT 2, lpad(id::text,20,'0'), '', jsonb_build_array('vault_blobs',id,user_id,storage_key,iv_b64,wrapped_dek_b64,wrap_iv_b64,meta_iv_b64,meta_b64,size_bytes,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))::text FROM vault_blobs
    UNION ALL SELECT 3, id, '', jsonb_build_array('vault_v2_blobs',id,user_id,format_version,storage_key,content_id_b64,ciphertext_size,chunk_size,chunk_count,wrapped_dek_b64,wrap_iv_b64,meta_iv_b64,meta_b64,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))::text FROM vault_v2_blobs
    UNION ALL SELECT 4, blob_id, lpad(chunk_index::text,10,'0'), jsonb_build_array('vault_v2_blob_chunks',blob_id,chunk_index,ciphertext_size,ciphertext_sha256,iv_b64)::text FROM vault_v2_blob_chunks
  ) t ORDER BY r, k1 COLLATE "C", k2 COLLATE "C"
) TO STDOUT;
SQL
}
tree_state_sha256() {        # D-1 addition: tree lifecycle + heads must be untouched by migration 012
  PSQL_RO <<'SQL' | sha256sum | cut -d' ' -f1
COPY (
  SELECT payload FROM (
    SELECT 1 AS r, lpad(user_id::text,20,'0') || ':' || blob_format_version || ':' || blob_id AS k,
           jsonb_build_array('vault_tree_blob_state',user_id,blob_format_version,blob_id,lifecycle,attached_generation,purge_id)::text AS payload FROM vault_tree_blob_state
    UNION ALL SELECT 2, lpad(user_id::text,20,'0'), jsonb_build_array('vault_tree_heads',user_id,tree_id,revision_id,generation)::text FROM vault_tree_heads
  ) t ORDER BY r, k COLLATE "C"
) TO STDOUT;
SQL
}
schema_sha256() {
  "${D[@]}" exec aegis-prod-postgres-1 sh -lc 'pg_dump -U "$POSTGRES_USER" -d aegis_drive --schema-only --no-owner --no-privileges | grep -vE "^\\\\(un)?restrict " | sha256sum | cut -d" " -f1'
}
PRE_PROTECTED_VAULT_SHA256=$(vault_protected_sha256)
PRE_TREE_STATE_SHA256=$(tree_state_sha256)
PRE_SCHEMA_SHA256=$(schema_sha256)
printf 'PRE_PROTECTED_VAULT_SHA256=%s\nPRE_TREE_STATE_SHA256=%s\nPRE_SCHEMA_SHA256=%s\n' "$PRE_PROTECTED_VAULT_SHA256" "$PRE_TREE_STATE_SHA256" "$PRE_SCHEMA_SHA256"
```

Run the remaining steps in a controlled maintenance window with no intentional user writes until Step 9.

## 7. Step 3 — verify transfer, load image, install overlays (Human)

```bash
EXPECTED_MIGRATION_SHA256=aac26537c1500737f2fada157696ca5522d34e3386099f3d580151c45cbcb239
EXPECTED_OVERLAY_IMAGE_SHA256=49b0ad5fbe0f49a9cfe168ec28c12aeb3f6fe1ead6dd870105423f4b37b96f78
EXPECTED_OVERLAY_FLAGS_SHA256=7c5f0df78c3f5cf46bb2edd83bb8b015ed63d9645ed8de22c69eb1d8d6216a59
CANDIDATE_IMAGE=aegis-prod-drive:preview-d1-s1-9f5a01148ce0
CANDIDATE_REVISION=9f5a01148ce016bc0056dbbcc85ac8a3e5fac23f
RT=/opt/aegis/runtime/preview-d1
OV_IMAGE=$RT/drive-image-9f5a01148ce0.yml
OV_FLAGS=$RT/drive-preview-index-stage1-9f5a01148ce0.yml

test "$(sha256sum /tmp/012_vault_preview_index_v1.sql | cut -d' ' -f1)" = "$EXPECTED_MIGRATION_SHA256" || { echo 'STOP: migration 012 SHA-256 mismatch' >&2; exit 1; }
test "$(sha256sum /tmp/drive-image-9f5a01148ce0.yml | cut -d' ' -f1)" = "$EXPECTED_OVERLAY_IMAGE_SHA256" || { echo 'STOP: image overlay SHA-256 mismatch' >&2; exit 1; }
test "$(sha256sum /tmp/drive-preview-index-stage1-9f5a01148ce0.yml | cut -d' ' -f1)" = "$EXPECTED_OVERLAY_FLAGS_SHA256" || { echo 'STOP: flags overlay SHA-256 mismatch' >&2; exit 1; }

SERVER_ARCHIVE_SHA256=$(sha256sum /tmp/aegis-prod-drive-preview-d1-s1-9f5a01148ce0.tar | cut -d' ' -f1)
printf 'SERVER_ARCHIVE_SHA256=%s\n' "$SERVER_ARCHIVE_SHA256"
read -r -p 'Paste approved workstation archive SHA-256: ' APPROVED_ARCHIVE_SHA256
test "${APPROVED_ARCHIVE_SHA256,,}" = "$SERVER_ARCHIVE_SHA256" || { echo 'STOP: archive SHA-256 mismatch' >&2; exit 1; }
"${D[@]}" load --input /tmp/aegis-prod-drive-preview-d1-s1-9f5a01148ce0.tar
"${D[@]}" image inspect "$CANDIDATE_IMAGE" --format 'ID={{.Id}} REV={{index .Config.Labels "org.opencontainers.image.revision"}} SOURCE={{index .Config.Labels "org.opencontainers.image.source"}} USER={{.Config.User}}'
test "$("${D[@]}" image inspect "$CANDIDATE_IMAGE" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "$CANDIDATE_REVISION" || { echo 'STOP: candidate OCI revision mismatch' >&2; exit 1; }
test "$("${D[@]}" image inspect "$CANDIDATE_IMAGE" --format '{{.Config.User}}')" = node || { echo 'STOP: candidate image user mismatch' >&2; exit 1; }

sudo install -d -m 0755 "$RT"
sudo install -m 0644 /tmp/drive-image-9f5a01148ce0.yml "$OV_IMAGE"
sudo install -m 0644 /tmp/drive-preview-index-stage1-9f5a01148ce0.yml "$OV_FLAGS"
printf '%s\n' "$LIVE_CONFIG_FILES" | sudo tee "$RT/pre-stage1-live-chain.txt" >/dev/null   # file paths only, no secrets
test "$(sha256sum "$OV_IMAGE" | cut -d' ' -f1)" = "$EXPECTED_OVERLAY_IMAGE_SHA256" || { echo 'STOP: installed image overlay mismatch' >&2; exit 1; }
test "$(sha256sum "$OV_FLAGS" | cut -d' ' -f1)" = "$EXPECTED_OVERLAY_FLAGS_SHA256" || { echo 'STOP: installed flags overlay mismatch' >&2; exit 1; }
echo 'STAGE1_ARTIFACTS_INSTALLED=YES'
```

Loading the image and installing overlay files does not change the running service.

## 8. Step 4 — apply migration 012 (Human-only; HG-S1 required)

P1 keeps serving during this step. Migration 012 is one transaction (`BEGIN … COMMIT`); `lock_timeout` makes a
blocked `ALTER TABLE vault_tree_blob_state` fail and roll back instead of queueing behind traffic.

```bash
if "${D[@]}" exec -i -e PGOPTIONS='-c lock_timeout=10s -c statement_timeout=300s' aegis-prod-postgres-1 \
     sh -lc 'psql -X -U "$POSTGRES_USER" -d aegis_drive -v ON_ERROR_STOP=1 -f -' \
     < /tmp/012_vault_preview_index_v1.sql; then
  echo 'MIGRATION_012_APPLIED=YES'
else
  echo 'STOP: migration 012 failed and rolled back; do not retry, do not cut over' >&2; exit 1
fi
```

Expected `psql` output is only `BEGIN`, `DO`, `CREATE TABLE` ×3, `CREATE FUNCTION`, `DROP TRIGGER` (with a
"does not exist, skipping" NOTICE on first application), `CREATE TRIGGER`, `CREATE FUNCTION`, `DROP TRIGGER`,
`CREATE TRIGGER`, `DO`, `COMMIT`.

- Non-zero exit → the transaction rolled back. **STOP.** Do not retry blindly, do not edit the SQL, do not cut over.
  Record the error class only (no secrets) and return to the Human Owner.
- Never run a down-migration. There is none.

## 9. Step 5 — post-migration verification (read-only)

```bash
PSQL_RO <<'SQL'
SELECT 'D1_TABLE_COUNT=' || count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN
  ('vault_preview_index_heads','vault_preview_index_generations','vault_preview_index_blob_refs');
SELECT 'TREE_TABLE_COUNT=' || count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN
  ('vault_tree_state','vault_tree_frozen_inventory','vault_tree_key_envelope','vault_tree_heads','vault_tree_revisions','vault_tree_blob_state','vault_tree_purge_candidates');
SELECT 'LIFECYCLE_CHECK_COUNT=' || count(*) FROM pg_constraint
 WHERE conrelid = 'vault_tree_blob_state'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%lifecycle%';
SELECT 'LIFECYCLE_CHECK=' || conname || ' ' || pg_get_constraintdef(oid) FROM pg_constraint
 WHERE conrelid = 'vault_tree_blob_state'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%lifecycle%';
SELECT 'D1_TRIGGERS=' || string_agg(tgname, ',' ORDER BY tgname) FROM pg_trigger
 WHERE NOT tgisinternal AND tgname IN ('vault_preview_index_generations_immutable','vault_preview_index_blob_refs_immutable','vault_tree_revisions_immutable');
SELECT 'DRIVE_APP_D1_GRANTS=' || string_agg(table_name || ':' || privilege_type, ',' ORDER BY table_name, privilege_type)
  FROM information_schema.role_table_grants WHERE grantee = 'drive_app' AND table_name LIKE 'vault_preview_index_%';
SELECT 'DRIVE_APP_PRIV ' || t || ' S=' || has_table_privilege('drive_app', t, 'SELECT') || ' I=' || has_table_privilege('drive_app', t, 'INSERT')
    || ' U=' || has_table_privilege('drive_app', t, 'UPDATE') || ' D=' || has_table_privilege('drive_app', t, 'DELETE') || ' T=' || has_table_privilege('drive_app', t, 'TRUNCATE')
  FROM unnest(ARRAY['vault_preview_index_heads','vault_preview_index_generations','vault_preview_index_blob_refs']) t;
SELECT 'OTHER_TABLES_WITHOUT_DRIVE_APP_DELETE=' || count(*) FILTER (WHERE NOT has_table_privilege('drive_app', c.oid, 'DELETE'))
    || ' OF ' || count(*)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname NOT LIKE 'vault_preview_index_%';
SELECT 'D1_HEAD_ROWS=' || count(*) FROM vault_preview_index_heads;
SELECT 'D1_GENERATION_ROWS=' || count(*) FROM vault_preview_index_generations;
SELECT 'D1_BLOB_REF_ROWS=' || count(*) FROM vault_preview_index_blob_refs;
SELECT 'INDEX_LIFECYCLE_ROWS=' || count(*) FROM vault_tree_blob_state WHERE lifecycle IN ('INDEX_STAGED','INDEX_MANAGED');
SELECT 'LIFECYCLE_ROWS ' || lifecycle || '=' || count(*) FROM vault_tree_blob_state GROUP BY lifecycle ORDER BY lifecycle;
SELECT 'INVALID_INDEX_COUNT=' || count(*) FROM pg_index WHERE NOT indisvalid;
SQL
POST_MIG_PROTECTED_VAULT_SHA256=$(vault_protected_sha256)
POST_MIG_TREE_STATE_SHA256=$(tree_state_sha256)
POST_MIG_SCHEMA_SHA256=$(schema_sha256)
printf 'POST_MIG_PROTECTED_VAULT_SHA256=%s\nPOST_MIG_TREE_STATE_SHA256=%s\nPOST_MIG_SCHEMA_SHA256=%s\n' "$POST_MIG_PROTECTED_VAULT_SHA256" "$POST_MIG_TREE_STATE_SHA256" "$POST_MIG_SCHEMA_SHA256"
test "$POST_MIG_PROTECTED_VAULT_SHA256" = "$PRE_PROTECTED_VAULT_SHA256" || { echo 'STOP_FOR_HUMAN_INVESTIGATION: protected Vault data changed' >&2; exit 1; }
test "$POST_MIG_TREE_STATE_SHA256" = "$PRE_TREE_STATE_SHA256" || { echo 'STOP_FOR_HUMAN_INVESTIGATION: tree lifecycle/head rows changed' >&2; exit 1; }
test "$POST_MIG_SCHEMA_SHA256" != "$PRE_SCHEMA_SHA256" || { echo 'STOP_FOR_HUMAN_INVESTIGATION: schema did not change after migration 012' >&2; exit 1; }
"${D[@]}" inspect aegis-prod-drive-1 --format '{{.Config.Image}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.RestartCount}}|{{.State.OOMKilled}}'
PRIV_BAD=$(PSQL_RO <<'SQL'
SELECT count(*) FROM unnest(ARRAY['vault_preview_index_heads','vault_preview_index_generations','vault_preview_index_blob_refs']) t
 WHERE NOT (has_table_privilege('drive_app', t, 'SELECT') AND has_table_privilege('drive_app', t, 'INSERT') AND has_table_privilege('drive_app', t, 'UPDATE'))
    OR has_table_privilege('drive_app', t, 'DELETE') OR has_table_privilege('drive_app', t, 'TRUNCATE');
SQL
)
test "$PRIV_BAD" = 0 || { echo 'STOP_FOR_HUMAN_INVESTIGATION: drive_app preview-index privileges are not SELECT/INSERT/UPDATE only' >&2; exit 1; }
echo 'MIGRATION_012_VERIFIED=YES'
```

Required: `D1_TABLE_COUNT=3`; `TREE_TABLE_COUNT=7`; `LIFECYCLE_CHECK_COUNT=1` named
`vault_tree_blob_state_lifecycle_check` listing all six values (`UNREFERENCED, TREE_MANAGED, PURGE_PENDING, PURGED,
INDEX_STAGED, INDEX_MANAGED`); `D1_TRIGGERS` contains both D-1 triggers and the 011 trigger;
`DRIVE_APP_D1_GRANTS` = exactly `INSERT, SELECT, UPDATE` on each of the three tables (9 entries); each
`DRIVE_APP_PRIV` line `S=true I=true U=true D=false T=false` (**no DELETE, no TRUNCATE** — PR #297 contract: 012
revokes what `ALTER DEFAULT PRIVILEGES` from `postgres/init/02-app-roles.sh` granted and re-grants SELECT/INSERT/UPDATE);
`OTHER_TABLES_WITHOUT_DRIVE_APP_DELETE=0 OF <n>` (every unrelated table keeps the blanket DML); `PRIV_BAD=0` is enforced
above;
all three `D1_*_ROWS=0`; `INDEX_LIFECYCLE_ROWS=0`; `LIFECYCLE_ROWS` identical to the Step 2 baseline;
`INVALID_INDEX_COUNT=0`; both data fingerprints equal; schema fingerprint changed (expected); P1 Drive still healthy.

**Migration 012 is now permanent for this rollout.** Every rollback below retains it.

## 10. Step 6 — non-persistent render validation

```bash
"${COMPOSE[@]}" "${CHAIN[@]}" -f "$OV_IMAGE" -f "$OV_FLAGS" config --quiet
S1_IMAGES=$("${COMPOSE[@]}" "${CHAIN[@]}" -f "$OV_IMAGE" -f "$OV_FLAGS" config --images)
test "$(printf '%s\n' "$S1_IMAGES" | grep -Fxc "$CANDIDATE_IMAGE" || true)" = 1 || { echo 'STOP: candidate image missing/duplicated in render' >&2; exit 1; }
printf '%s\n' "$S1_IMAGES" | grep -Fx "$EXPECTED_CURRENT_DRIVE_IMAGE" && { echo 'STOP: P1 image still rendered' >&2; exit 1; } || true
S1_FLAG_LINES=$("${COMPOSE[@]}" "${CHAIN[@]}" -f "$OV_IMAGE" -f "$OV_FLAGS" config \
  | grep -oE '(VAULT_TREE_SCHEMA_AVAILABLE|VAULT_TREE_PROTOCOL_ENABLED|VAULT_TREE_GENESIS_MIGRATION_ENABLED|VAULT_TREE_UI_ENABLED|VAULT_MEDIA_PREVIEW_ENABLED|VAULT_DESTRUCTIVE_PURGE_ENABLED|VAULT_PREVIEW_INDEX_[A-Z_]+)[:=] *"?[A-Za-z0-9]*"?' | sort -u)
printf 'S1_RENDERED_FLAGS:\n%s\n' "$S1_FLAG_LINES"
grep -q 'VAULT_PREVIEW_INDEX_MAX_RETAINED_BYTES_PER_OWNER' <<< "$S1_FLAG_LINES" && { echo 'STOP: retained-bytes budget is set in Stage 1' >&2; exit 1; } || true
echo 'STAGE1_NON_PERSISTENT_RENDER=PASS'
```

Human reads `S1_RENDERED_FLAGS`: `VAULT_PREVIEW_INDEX_SCHEMA_AVAILABLE=true`, `_READ_ENABLED=true`,
`_WRITE_ENABLED=false`, `VAULT_MEDIA_PREVIEW_ENABLED=true`, `VAULT_DESTRUCTIVE_PURGE_ENABLED=false`, four
`VAULT_TREE_*` values equal to `PRE_TREE_FLAGS`, no budget variable. The interpolated model is never written to disk.

## 11. Step 7 — apply Stage 1, Drive only (Human; HG-S1 required)

```bash
CUTOVER_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ); echo "CUTOVER_TS=$CUTOVER_TS"
"${COMPOSE[@]}" "${CHAIN[@]}" -f "$OV_IMAGE" -f "$OV_FLAGS" up -d --no-deps --no-build drive
```

If the container does not become healthy (Step 8 loop), go directly to Step 12 (rollback A′); migration 012 stays.

## 12. Step 8 — server technical acceptance (Human)

```bash
for attempt in {1..30}; do
  H=$("${D[@]}" inspect aegis-prod-drive-1 --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}'); [[ "$H" = healthy ]] && break; sleep 2
done
IFS='|' read -r S1_IMAGE S1_HEALTH S1_RESTARTS S1_OOM < <("${D[@]}" inspect aegis-prod-drive-1 --format '{{.Config.Image}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.RestartCount}}|{{.State.OOMKilled}}')
printf 'S1_IMAGE=%s\nS1_HEALTH=%s\nS1_RESTARTS=%s\nS1_OOM=%s\n' "$S1_IMAGE" "$S1_HEALTH" "$S1_RESTARTS" "$S1_OOM"
test "$S1_IMAGE" = "$CANDIDATE_IMAGE" || { echo 'STOP: candidate not running' >&2; exit 1; }
test "$S1_HEALTH" = healthy || { echo 'STOP: candidate not healthy' >&2; exit 1; }
test "$S1_RESTARTS" = 0 || { echo 'STOP: candidate restart count nonzero' >&2; exit 1; }
test "$S1_OOM" = false || { echo 'STOP: candidate OOMKilled' >&2; exit 1; }

# S-HEALTH: /healthz → 200 with all layers ok; tree flags unchanged; purge off
"${D[@]}" exec aegis-prod-drive-1 node -e 'fetch("http://127.0.0.1:8001/healthz").then(async r=>{const j=await r.json();const v=j.vaultTree??{};console.log(JSON.stringify({status:r.status,ok:j.ok,layers:{application:j.layers?.application?.ok,metadata:j.layers?.metadata?.ok,storage:j.layers?.storage?.ok},vaultTree:v}));if(r.status!==200||j.ok!==true||j.layers?.application?.ok!==true||j.layers?.metadata?.ok!==true||j.layers?.storage?.ok!==true||v.schemaAvailable!==true||v.protocolEnabled!==true||v.destructivePurgeEnabled!==false)process.exit(1)}).catch(e=>{console.error(e.message);process.exit(1)})' \
  || { echo 'STOP: /healthz acceptance failed' >&2; exit 1; }

# S-BOOT: boot probe found migration 012; writer reported disabled
"${D[@]}" logs --since "$CUTOVER_TS" aegis-prod-drive-1 2>&1 | grep -F '[aegis-drive] vault preview index:' | tail -1
"${D[@]}" logs --since "$CUTOVER_TS" aegis-prod-drive-1 2>&1 | grep -Fq '[aegis-drive] vault preview index: schema verified, read enabled, write disabled' \
  || { echo 'STOP: boot line is not "schema verified, read enabled, write disabled"' >&2; exit 1; }

# S-ENV: effective flags (allow-listed only); budget absent; tree flags unchanged
S1_FLAGS=$("${D[@]}" inspect aegis-prod-drive-1 --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E "$FLAG_RE" | sort || true)
printf 'S1_FLAGS:\n%s\n' "$S1_FLAGS"
for want in VAULT_PREVIEW_INDEX_SCHEMA_AVAILABLE=true VAULT_PREVIEW_INDEX_READ_ENABLED=true VAULT_PREVIEW_INDEX_WRITE_ENABLED=false VAULT_MEDIA_PREVIEW_ENABLED=true VAULT_DESTRUCTIVE_PURGE_ENABLED=false; do
  grep -qx "$want" <<< "$S1_FLAGS" || { echo "STOP: missing $want" >&2; exit 1; }
done
grep -q '^VAULT_PREVIEW_INDEX_MAX_RETAINED_BYTES_PER_OWNER=' <<< "$S1_FLAGS" && { echo 'STOP: budget variable present' >&2; exit 1; } || true
test "$(grep -E "$TREE_FLAG_RE" <<< "$S1_FLAGS" || true)" = "$PRE_TREE_FLAGS" || { echo 'STOP: VAULT_TREE_* flags changed' >&2; exit 1; }

# S-OTHERS: non-Drive containers untouched
POST_OTHERS=$("${D[@]}" ps --format '{{.Names}}' | grep -vx aegis-prod-drive-1 | sort | while read -r n; do "${D[@]}" inspect "$n" --format '{{.Name}}|{{.Config.Image}}|{{.Image}}|{{.State.StartedAt}}|{{.RestartCount}}'; done)
test "$POST_OTHERS" = "$PRE_OTHERS" || { echo 'STOP: a non-Drive container changed' >&2; exit 1; }

# S-DB: still zero index data; Vault data untouched by the cutover
PSQL_RO <<'SQL'
SELECT 'D1_HEAD_ROWS=' || count(*) FROM vault_preview_index_heads;
SELECT 'D1_GENERATION_ROWS=' || count(*) FROM vault_preview_index_generations;
SELECT 'D1_BLOB_REF_ROWS=' || count(*) FROM vault_preview_index_blob_refs;
SELECT 'INDEX_LIFECYCLE_ROWS=' || count(*) FROM vault_tree_blob_state WHERE lifecycle IN ('INDEX_STAGED','INDEX_MANAGED');
SQL
test "$(vault_protected_sha256)" = "$PRE_PROTECTED_VAULT_SHA256" || { echo 'STOP: protected Vault data changed at cutover' >&2; exit 1; }
test "$(tree_state_sha256)" = "$PRE_TREE_STATE_SHA256" || { echo 'STOP: tree rows changed at cutover' >&2; exit 1; }
test "$(schema_sha256)" = "$POST_MIG_SCHEMA_SHA256" || { echo 'STOP: schema changed at cutover' >&2; exit 1; }
echo 'STAGE1_SERVER_TECHNICAL=PASS'
```

Required: all four `D1_*`/`INDEX_*` row counts `0`.

### S-WRITE — writer absent / off (see §3 D1)

Workstation, Git Bash, against the exact candidate SHA:

```bash
SHA=9f5a01148ce016bc0056dbbcc85ac8a3e5fac23f
git show $SHA:IDEA1-AEGIS_Drive_LC/server/routes/vaultPreviewIndex.js | grep -cE 'vaultPreviewIndexRouter\.(post|put|patch|delete|all)\('   # expect 0
git grep -n requirePreviewIndexWrite $SHA -- IDEA1-AEGIS_Drive_LC/server                                                             # expect definition only
```

Pre-filled from package preparation at the candidate SHA: mutating-handler count `0`; `requirePreviewIndexWrite`
appears only at its definition (`server/routes/vaultPreviewIndex.js:44`), mounted nowhere.

Stage 1 S-WRITE verdict (Human decision D1) = `/state previewIndexWriteEnabled=false` (S-STATE) + preview-index mutation
route **absent / 404** (static count above; reproduced locally: authenticated `POST /api/vault/tree/preview-index/head`
→ `404 {"error":"Not found"}`) + boot line `write disabled` (S-BOOT) + zero preview-index rows (S-DB, and again after
browser acceptance). Do not send mutating probes to Production.

```text
STAGE1_WRITE_ROUTE_PRESENT=NO
STAGE1_WRITE_ROUTE_404=EXPECTED
STAGE1_WRITE_CAPABILITY=NOT_ROUTABLE
STAGE2_WRITE_DISABLED_503_REQUIRED=YES
```

503 `PREVIEW_INDEX_WRITE_DISABLED` is **not** a Stage 1 requirement; it is a mandatory Stage 2 (post-PR-C) acceptance item.

### S-STATE and S-HEAD — authenticated, once per test account (browser DevTools console)

Precondition per account: logged in through the normal UI and Vault set up as TREE_V1 (§3 D2). The snippet uses
only same-origin `GET` with the HttpOnly session cookie; it reads no storage, sends no CSRF token, and prints no
tree id, blob id, or token.

```js
(async () => {
  const get = async (p) => { const r = await fetch('/drive/api' + p, { credentials: 'same-origin', cache: 'no-store' }); let b = null; try { b = await r.json() } catch {} ; return { s: r.status, cc: r.headers.get('cache-control'), b } }
  const st = await get('/vault/tree/state'); const hd = await get('/vault/tree/preview-index/head'); const f = st.b?.flags ?? {}
  const out = {
    stateStatus: st.s, protocolState: st.b?.protocolState,
    previewIndexSchemaAvailable: f.previewIndexSchemaAvailable, previewIndexReadEnabled: f.previewIndexReadEnabled,
    previewIndexWriteEnabled: f.previewIndexWriteEnabled, mediaPreviewEnabled: f.mediaPreviewEnabled, destructivePurgeEnabled: f.destructivePurgeEnabled,
    headStatus: hd.s, headCode: hd.b?.code ?? null, headCacheControl: hd.cc,
  }
  out.verdict =
    hd.s === 503 && out.headCode === 'PREVIEW_INDEX_DISABLED' ? 'FAIL_CONFIG_READ_OFF' :
    hd.s === 409 ? 'ACCOUNT_NOT_SETUP' :
    (st.s === 200 && out.previewIndexSchemaAvailable === true && out.previewIndexReadEnabled === true && out.previewIndexWriteEnabled === false &&
     out.mediaPreviewEnabled === true && out.destructivePurgeEnabled === false &&
     hd.s === 404 && out.headCode === 'PREVIEW_INDEX_NOT_FOUND' && /no-store/.test(out.headCacheControl ?? '')) ? 'PASS' : 'FAIL'
  console.log(JSON.stringify(out))
})()
```

| Account | Path | `stateStatus` | write flag | `headStatus` / `headCode` | verdict | Operator / time |
|---|---|---|---|---|---|---|
| ADMIN | LAN | | | | | |
| EXISTING_USER | LAN | | | | | |
| NEWLY_CREATED_USER | LAN | | | | | |
| ADMIN | REMOTE | | | | | |
| EXISTING_USER | REMOTE | | | | | |
| NEWLY_CREATED_USER | REMOTE | | | | | |

`200` on `/head` (an index exists) is a STOP: no index may exist at Stage 1. `503 PREVIEW_INDEX_DISABLED` is a
configuration FAIL, not acceptance.

`ACCOUNT_NOT_SETUP` (409 before Vault setup) is neither PASS nor FAIL (§3 D2): complete normal Vault setup in the UI, re-run
the snippet, and only a `404 PREVIEW_INDEX_NOT_FOUND` result may mark the cell PASS. Record both runs for
NEWLY_CREATED_USER.

## 13. Step 9 — browser acceptance matrix (Human)

Use disposable test files only. Keep DevTools Network open (filter `preview-index`) for every row.
Expected network shape on each unlock/browse: `GET …/vault/tree/preview-index/head` → `404`; **no**
`…/preview-index/envelopes` request; **no** non-GET request to any `…/preview-index/…` path; tile bytes come from
the normal original-blob chunk reads (`…/api/vault/blobs/<id>/chunks/…`), i.e. the exact pre-D-1 fallback path.

Mark each cell `PASS`, `FAIL`, or `N/A` (with reason). Nothing is pre-filled. **No cell may be marked PASS unless the
Human actually executed it.**

### 13.1 LAN

| # | Check | ADMIN | EXISTING_USER | NEWLY_CREATED_USER |
|---|---|---|---|---|
| L1 | Login through normal UI | | | |
| L2 | Vault unlock | | | |
| L3 | Browse root + one subfolder | | | |
| L4 | Image/video tiles render from the original path (Network: original chunk reads) | | | |
| L5 | Absent-index fallback exactly normal: head 404 only, no envelopes call, no error toast/console error, tiles identical to P1 | | | |
| L6 | Upload (new file appears without refresh) | | | |
| L7 | Download (file opens; optional SHA-256 vs source) | | | |
| L8 | Rename | | | |
| L9 | Move to another folder | | | |
| L10 | Trash | | | |
| L11 | Restore from trash | | | |
| L12 | Lock (names/tiles cleared) | | | |
| L13 | Unlock again; browse; tiles render | | | |
| L14 | Network: zero non-GET requests to `/preview-index/` during L1–L13 | | | |

### 13.2 REMOTE (where applicable; record N/A with reason for an account that has no remote access)

| # | Check | ADMIN | EXISTING_USER | NEWLY_CREATED_USER |
|---|---|---|---|---|
| R1 | Login through normal UI | | | |
| R2 | Vault unlock | | | |
| R3 | Browse root + one subfolder | | | |
| R4 | Tiles render from the original path | | | |
| R5 | Absent-index fallback exactly normal | | | |
| R6 | Upload | | | |
| R7 | Download | | | |
| R8 | Rename | | | |
| R9 | Move | | | |
| R10 | Trash | | | |
| R11 | Restore | | | |
| R12 | Lock | | | |
| R13 | Unlock again; browse; tiles render | | | |
| R14 | Network: zero non-GET requests to `/preview-index/` | | | |

### 13.3 Post-browser server re-check (same shell)

```bash
PSQL_RO <<'SQL'
SELECT 'D1_HEAD_ROWS=' || count(*) FROM vault_preview_index_heads;
SELECT 'D1_GENERATION_ROWS=' || count(*) FROM vault_preview_index_generations;
SELECT 'D1_BLOB_REF_ROWS=' || count(*) FROM vault_preview_index_blob_refs;
SELECT 'INDEX_LIFECYCLE_ROWS=' || count(*) FROM vault_tree_blob_state WHERE lifecycle IN ('INDEX_STAGED','INDEX_MANAGED');
SQL
"${D[@]}" inspect aegis-prod-drive-1 --format '{{.Config.Image}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.RestartCount}}|{{.State.OOMKilled}}'
```

Required: all zero; candidate healthy, restarts 0, OOM false. (Vault fingerprints are expected to change now
because the matrix uploads/renames files; they are not compared after Step 9.)

## 14. Step 10 — Rollback Case A′ (prepared; Human executes only as rehearsal or on failure)

**Case A′:** Stage 1 → previous accepted P1 runtime image (`aegis-prod-drive:p1-8634360f74ed`) with the exact
pre-Stage-1 live chain, **migration 012 retained**, no down-migration, no row/table/blob deletion. Valid because no
preview index exists (S-DB = 0) and P1 has no preview-index route, CAS, or upload family, so nothing can create one
while rolled back.

```bash
ROLLBACK_FILES=$(cat /opt/aegis/runtime/preview-d1/pre-stage1-live-chain.txt)
test "$ROLLBACK_FILES" = "$LIVE_CONFIG_FILES" || { echo 'STOP: recorded pre-Stage-1 chain differs from Step 2' >&2; exit 1; }
case "$ROLLBACK_FILES" in *preview-d1*) echo 'STOP: rollback chain contains a D-1 overlay' >&2; exit 1;; esac

# Index must still be absent before rollback (Case A′ precondition)
PSQL_RO <<'SQL'
SELECT 'PRE_ROLLBACK_D1_HEAD_ROWS=' || count(*) FROM vault_preview_index_heads;
SELECT 'PRE_ROLLBACK_INDEX_LIFECYCLE_ROWS=' || count(*) FROM vault_tree_blob_state WHERE lifecycle IN ('INDEX_STAGED','INDEX_MANAGED');
SQL
# If either is nonzero: STOP — this is Case B, not A′; return to the Human Owner.

RB_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ); echo "RB_TS=$RB_TS"
"${COMPOSE[@]}" "${CHAIN[@]}" up -d --no-deps --no-build drive

for attempt in {1..30}; do H=$("${D[@]}" inspect aegis-prod-drive-1 --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}'); [[ "$H" = healthy ]] && break; sleep 2; done
IFS='|' read -r RB_IMAGE RB_HEALTH RB_RESTARTS RB_OOM < <("${D[@]}" inspect aegis-prod-drive-1 --format '{{.Config.Image}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.RestartCount}}|{{.State.OOMKilled}}')
printf 'RB_IMAGE=%s\nRB_HEALTH=%s\nRB_RESTARTS=%s\nRB_OOM=%s\n' "$RB_IMAGE" "$RB_HEALTH" "$RB_RESTARTS" "$RB_OOM"
test "$RB_IMAGE" = "$EXPECTED_CURRENT_DRIVE_IMAGE" || { echo 'STOP_FOR_HUMAN_INVESTIGATION: rollback image mismatch' >&2; exit 1; }
test "$RB_HEALTH" = healthy || { echo 'STOP_FOR_HUMAN_INVESTIGATION: P1 not healthy on migrated DB' >&2; exit 1; }
test "$RB_OOM" = false || { echo 'STOP_FOR_HUMAN_INVESTIGATION: P1 OOMKilled' >&2; exit 1; }
"${D[@]}" exec aegis-prod-drive-1 node -e 'fetch("http://127.0.0.1:8001/healthz").then(async r=>{const j=await r.json();const v=j.vaultTree??{};console.log(JSON.stringify({status:r.status,ok:j.ok,vaultTree:v}));if(r.status!==200||j.ok!==true||v.schemaAvailable!==true||v.protocolEnabled!==true||v.destructivePurgeEnabled!==false)process.exit(1)}).catch(e=>{console.error(e.message);process.exit(1)})' \
  || { echo 'STOP_FOR_HUMAN_INVESTIGATION: P1 /healthz failed' >&2; exit 1; }
RB_FLAGS=$("${D[@]}" inspect aegis-prod-drive-1 --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E "$FLAG_RE" | sort || true)
test "$RB_FLAGS" = "$PRE_FLAGS" || { echo 'STOP_FOR_HUMAN_INVESTIGATION: rollback flags differ from pre-Stage-1' >&2; exit 1; }
PSQL_RO <<'SQL'
SELECT 'RB_D1_TABLE_COUNT=' || count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN
  ('vault_preview_index_heads','vault_preview_index_generations','vault_preview_index_blob_refs');
SELECT 'RB_INDEX_LIFECYCLE_ROWS=' || count(*) FROM vault_tree_blob_state WHERE lifecycle IN ('INDEX_STAGED','INDEX_MANAGED');
SQL
echo 'ROLLBACK_A_PRIME_TECHNICAL=PASS'
```

Required: P1 image, healthy, OOM false (Human classifies the restart count), `/healthz` 200 with tree schema/protocol
true and purge false, flags byte-equal to `PRE_FLAGS` (no `VAULT_PREVIEW_INDEX_*`), `RB_D1_TABLE_COUNT=3`
(**migration 012 retained**), `RB_INDEX_LIFECYCLE_ROWS=0`. Never use `down`, prune, `--remove-orphans`, volume
deletion, PostgreSQL recreation, or any DDL.

### 14.1 Rollback A′ functional checklist (Human, ADMIN on LAN at minimum; add others if time permits)

| # | Check | Result |
|---|---|---|
| RB1 | Health: `/healthz` 200 (above) | |
| RB2 | Login + Vault unlock | |
| RB3 | Browse root + subfolder; tiles render (P1 path; no `/preview-index/` request at all) | |
| RB4 | Upload | |
| RB5 | Download | |
| RB6 | Rename | |
| RB7 | Move | |
| RB8 | Trash | |
| RB9 | Restore | |
| RB10 | Lock | |
| RB11 | After RB2–RB10: `INDEX_LIFECYCLE_ROWS=0`, `D1_HEAD_ROWS=0` (re-run the §13.3 query) | |

```text
ROLLBACK_A_PRIME_EXECUTED=
ROLLBACK_A_PRIME_FUNCTIONAL=
MIGRATION_012_RETAINED=
```

## 15. Step 11 — forward redeploy back to Stage 1 (Human)

Only after Case A′ evidence is recorded:

```bash
FWD_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ); echo "FWD_TS=$FWD_TS"
test "$(sha256sum "$OV_IMAGE" | cut -d' ' -f1)" = "$EXPECTED_OVERLAY_IMAGE_SHA256" || { echo 'STOP: image overlay changed' >&2; exit 1; }
test "$(sha256sum "$OV_FLAGS" | cut -d' ' -f1)" = "$EXPECTED_OVERLAY_FLAGS_SHA256" || { echo 'STOP: flags overlay changed' >&2; exit 1; }
"${COMPOSE[@]}" "${CHAIN[@]}" -f "$OV_IMAGE" -f "$OV_FLAGS" up -d --no-deps --no-build drive
```

Then repeat, with `CUTOVER_TS=$FWD_TS`:

| # | Check | Result |
|---|---|---|
| FW1 | Step 8 technical block (image, healthy, restarts 0, OOM false, `/healthz`, boot line, flags, non-Drive containers, zero index rows). Skip only the two Vault-data fingerprint lines, which legitimately changed during Step 9/RB. | |
| FW2 | S-STATE / S-HEAD snippet for ADMIN, EXISTING_USER, NEWLY_CREATED_USER (LAN) → `PASS` | |
| FW3 | ADMIN LAN: unlock, browse, tiles via original path, upload, download, lock | |
| FW4 | §13.3 re-check: zero index rows; candidate healthy | |

## 16. Package-preparation evidence (local, non-Production; refreshed 2026-10-02 for candidate `9f5a0114`)

These checks validate the package, not Production. None of them is Stage 1 acceptance.

| Check | Result |
|---|---|
| `origin/main` at refresh; PR #297 | `9f5a01148ce016bc0056dbbcc85ac8a3e5fac23f` = merge of PR #297 (MERGED) |
| Ancestry: PR-A `fa22edd5`, PR-B head `3747a183`, PR #297 head `04890e18` | all ancestors of the candidate |
| Migration 012 at candidate (LF Git bytes) | SHA-256 `aac26537c1500737f2fada157696ca5522d34e3386099f3d580151c45cbcb239`; Git blob `540e2a4e…` |
| Drive runtime-input delta `4a8cc3c9..9f5a0114` | migration 012 only; `package*.json` and `Dockerfile` identical to P1 |
| `bash -n` on every bash block of this runbook; `node --check` on the console snippet | all pass |
| Runbook SQL verbatim (§6 2.5 → §8 → §9 incl. `PRIV_BAD` STOP check → re-apply §8/§9) on disposable `postgres:15-alpine` 15.18 with P1-era `schema.sql` (`8634360f`), **Production role model** (exact Drive SQL of `postgres/init/02-app-roles.sh`, incl. `ALTER DEFAULT PRIVILEGES`), seeded lifecycle rows | pre: 7 tree tables, 0 D-1 tables, four-value CHECK. Post: 3 D-1 tables, one six-value CHECK, 3 triggers; `DRIVE_APP_D1_GRANTS` = exactly 9 (`INSERT/SELECT/UPDATE` ×3); every `DRIVE_APP_PRIV` `S=true I=true U=true D=false T=false`; `OTHER_TABLES_WITHOUT_DRIVE_APP_DELETE=0 OF 21`; `PRIV_BAD=0`; 0 D-1/`INDEX_*` rows; lifecycle distribution, protected-Vault and tree-state fingerprints unchanged; schema fingerprint changed. Re-apply: identical output, schema fingerprint unchanged |
| Fresh-install path (schema.sql + `02-app-roles.sh` via the real Postgres init sequence) | proven at the same merged files by PR #297: preview-index tables `SELECT/INSERT/UPDATE` only, DELETE/TRUNCATE false; 21 other Drive tables full DML; 15 Monitor tables keep DELETE |
| `docker compose config` with a synthetic base + PR187-style flags + both D-1 overlays | `--quiet` pass; images = `aegis-prod-drive:preview-d1-s1-9f5a01148ce0` only; SCHEMA/READ true, WRITE false, media true, purge false, `VAULT_TREE_*` inherited, no budget variable; without D-1 overlays the render returns the P1 image |
| `vaultTreeConfigFromEnv` (candidate) with the Stage 1 env | boots; budget `null` |
| Static mutating-handler count in `vaultPreviewIndex.js` at the candidate | `0` (route absent → 404 at Stage 1) |

Not covered by package preparation: the Production image build, the Production live chain, any Production HTTP
acceptance, any browser check.

### 16.1 Local rollback A′ runtime rehearsal (Human decision D4; LOCAL / DISPOSABLE; no Production)

Harness (committed, reproducible): `IDEA1-AEGIS_Drive_LC/deploy/production/d1/rehearsal/rollback-a-prime-rehearsal.sh`
+ `rollback-a-prime-driver.mjs`. The driver drives each running server over HTTP with the **real client modules of
the same revision** (P1 client against P1, candidate client against Stage 1): cookie + CSRF login with the forced
first-login reset, Argon2id Vault setup/unlock, genesis to TREE_V1, chunked V2 tree upload, manifest CAS commits
(create folder / rename / move / trash / restore), chunked V2 download with SHA-256 comparison, recovery listing,
and lock via the unlocked-state purge. After migration 012 the harness enforces the PR #297 privilege contract and
re-applies 012 to prove it is a no-op.

Environment: Docker 28.3.2 (Windows), `postgres:15-alpine` 15.18, one disposable network, PostgreSQL container, and
two named volumes (`/datalake`, media cache) shared by every boot; all removed at the end. Database = P1-era
`schema.sql` + `seed.sql` from `8634360f` plus the Production role model of `postgres/init/02-app-roles.sh`
(`drive_app` NOSUPERUSER/NOINHERIT, DML grants, `ALTER DEFAULT PRIVILEGES`). Drive containers run with
`NODE_ENV=production` (image default), `DATABASE_URL` as `drive_app`, `COOKIE_SECURE=false` (plain local HTTP),
`TRUSTED_PROXY_CIDRS=172.19.255.2/32` (approved HUB identity; required for production boot), and the PR187 Stage D
tree flags (schema/protocol/genesis/UI/media true, purge false); Stage 1 adds SCHEMA/READ true, WRITE false.

```text
P1_IMAGE_LOCAL=aegis-local-rehearsal-drive:p1-8634360f74ed   (sha256:b8285def…2f09; docker build of the exact P1 tree, OCI revision 8634360f74ed2f50b2fcb49925a3d273c605a8a2)
ROLLBACK_IMAGE_EXACT_PRODUCTION_ARTIFACT=NO                  (aegis-prod-drive:p1-8634360f74ed is not present on the rehearsal host)
ROLLBACK_CODE_REVISION_EXACT=YES                             (package.json / package-lock.json / Dockerfile identical between P1 and the candidate)
STAGE1_IMAGE_LOCAL=aegis-local-rehearsal-drive:preview-d1-s1-9f5a01148ce0 (sha256:21c967c3…9922; exact candidate tree, OCI revision 9f5a01148ce016bc0056dbbcc85ac8a3e5fac23f)
RUNTIME=node v20.20.2 / Alpine 3.23.4 / user node
LOCAL_BUILD_CHECKOUT=Windows CRLF (behaviour-equivalent; not byte-identical to an LF build — see §4)
```

| Step | Result |
|---|---|
| 1–2 P1 on pre-migration DB; seed ADMIN + EXISTING_USER (setup, genesis TREE_V1, folder, 2 files each, byte-exact read-back) | `PHASE_SEED=PASS (10/10)`; healthz 200; 7 tree tables, 0 D-1 tables |
| 3 **Corrected** migration 012 exactly as §8 (verbatim Git blob SHA-256 `aac26537…b239`, superuser, `ON_ERROR_STOP`, timeouts) | applied; `PRIVILEGE_CONTRACT=PASS`: each preview-index table `S=true I=true U=true D=false T=false`; `OTHER_TABLES=21 WITHOUT_FULL_DML=0` |
| 3b Re-apply 012 | `PRIVILEGE_CONTRACT=PASS`; `MIGRATION_012_REAPPLY_NOOP=YES` (identical table/row/lifecycle state) |
| 4 Refreshed Stage 1 boot (`9f5a0114`) on the migrated DB; all three account classes | `PHASE_STAGE1=PASS (19/19)`; boot line `schema verified, read enabled, write disabled`; `/state` schema/read true, write false; `GET head` → 404 `PREVIEW_INDEX_NOT_FOUND` + `no-store` (ADMIN, EXISTING_USER, NEWLY_CREATED_USER); authenticated `POST head` → `404 {"error":"Not found"}`; NEWLY_CREATED_USER before Vault setup → 409 (`ACCOUNT_NOT_SETUP`), after setup → 404; seed files byte-exact; one Stage 1 upload |
| 5 Stop Stage 1 application only | PostgreSQL + volumes kept; 0 D-1 rows; 0 `INDEX_*` rows |
| 6–12 **Rollback A′**: exact P1 code revision on the same migrated DB, no down-migration; all three accounts | `PHASE_P1=PASS (47/47)`; healthz 200; restarts 0; OOM false; login, unlock, browse, ordinary upload, byte-exact download (seed, Stage 1, new), rename, move, trash, restore, byte-exact after rename/move/restore, recovery listing (0 orphans, nothing offered), lock |
| 10–12 after rollback | `D1_TABLE_COUNT=3` (**migration 012 and preview-index tables retained**); 0 D-1 rows; 0 `INDEX_*` rows; seed `vault_v2_blobs` rows identical to pre-migration (`SEED_BLOB_ROWS_INTACT=YES`) |
| 13–15 Stop P1; **forward** refreshed Stage 1 on the same DB | `PHASE_FORWARD=PASS (23/23)`; boot line `write disabled`; flags schema/read true, write false; head 404 for all three TREE_V1 accounts; POST head 404; every known file (seed, Stage 1, P1-rollback) byte-exact; lock; 0 D-1 / `INDEX_*` rows |
| Cleanup | containers, volumes, network removed |

The sequence ran twice against `9f5a0114` (a harness revision before the OID-based privilege query, then the committed
harness verbatim); both runs produced the result above.

```text
ROLLBACK_A_PRIME_LOCAL=PASS (corrected migration 012, candidate 9f5a0114)
P1_BOOT_ON_CORRECTED_012=PASS
P1_EXISTING_FLOWS=PASS (3 account classes)
MIGRATION012_RETAINED=YES
INDEX_ROWS_AFTER_ROLLBACK=0
FORWARD_STAGE1_BOOT=PASS
FORWARD_STAGE1_HEAD_404=PASS (3 account classes)
```

Superseded: two earlier runs of the same sequence against candidate `4a8cc3c9` with the pre-PR #297 migration also
passed functionally but showed `drive_app` DELETE on the preview-index tables; they are not evidence for this package.

Limits of this rehearsal: not the Production image artifact (exact code revision, local build); not Production data
volume or scale; no gateway/Twingate path; no browser UI (client modules run in Node, so tile rendering and browser
DevTools checks remain for the Human matrices); "lock" is the client-side unlocked-state purge, which is how the
product implements lock (the server has no lock endpoint); the recovery listing had no orphan to show, so it proves
the listing works and offers no `INDEX_*` blob, not orphan recovery itself.

## 17. Evidence record (fill only with executed results)

```text
HG_S1_AUTHORIZED=
PRE_DEPLOY_BACKUP=
LIVE_CONFIG_FILES=
PRE_FLAGS=
CANDIDATE_IMAGE_ID=
MIGRATION_012_APPLIED=
MIGRATION_012_VERIFIED=
STAGE1_NON_PERSISTENT_RENDER=
STAGE1_CUTOVER_TS=
STAGE1_SERVER_TECHNICAL=
HEALTHZ=
STATE_FLAGS_PREVIEW_INDEX=schema:  read:  write:
HEAD_404_ADMIN= / EXISTING_USER= / NEWLY_CREATED_USER=
WRITE_ROUTE_PRESENT=NO (static, candidate SHA)
INDEX_ROWS_AFTER_ACCEPTANCE=
BROWSER_LAN_MATRIX=
BROWSER_REMOTE_MATRIX=
ROLLBACK_A_PRIME=
FORWARD_REDEPLOY=
STAGE1_ACCEPTED=
```

No line may be filled from this document or from an agent; only from Human-executed output.

## 18. Stop gate

This package ends at `STAGE1_PACKAGE=READY_FOR_HUMAN_REVIEW`. Stage 2 (writer-capable build, WRITE still off) needs
PR-C, PR-D, PR-E merged, its own `deploy/idea1-preview-d1-stage2` package, and HG-S2. Writer enablement (Stage 3)
remains impossible before HG-G (approved IDX-SIZE limits and retained-storage budget) and HG-H.
