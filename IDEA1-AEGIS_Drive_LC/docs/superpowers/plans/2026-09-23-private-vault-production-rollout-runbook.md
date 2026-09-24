# PR #187 Private Vault TREE_V1 — Production rollout runbook

Status: **SECOND STAGE A ROLLED BACK / DATA GATE CORRECTED / THIRD STAGE A NOT AUTHORIZED.**

This runbook deploys merged source `70b0fdf059672e2b1c408ec5e5c16cfed5261257`.
It never builds application code from the PR #187 documentation head. The active
Production checkout remains read-only evidence. No command in this document is
authorization to execute a later stage.

## Historical first Stage A — retained evidence

The first candidate remains historical evidence and is permanently
`RETIRED_DO_NOT_DEPLOY`:

```text
FIRST_STAGE_A_TECHNICAL=PASS
FIRST_STAGE_A_HUMAN_QHD=FAIL
FIRST_STAGE_A_ROLLBACK=PASS
PRODUCTION_MIGRATION_011_APPLIED=NO
TREE_OWNER_CREATED=NO
OLD_SOURCE_SHA=0051cceb4927220446fbb12a7e730b43af777b71
OLD_IMAGE_TAG=aegis-prod-drive:vault-tree-0051cceb4927
OLD_IMAGE_ID=sha256:73ac0ef368de9fee8f4137e6abcf43bbc734de587a24daeb0015cfef7dae3f32
OLD_CANDIDATE_STATUS=RETIRED_DO_NOT_DEPLOY
```

The first Stage A passed technical health but failed Human QHD locked-Vault
acceptance. Drive-only rollback passed without applying migration 011 or creating
a TREE owner. PR #191 corrected the layout, passed Human Owner 2560x1440
acceptance, preserved the PR #171 UI, and merged at
`2d7e7fd84e9b61eb0623e6bf762c0ce2858d341f`. Never deploy the old tag again.

## Historical second Stage A — retained evidence

Human execution reached the intended image-only candidate runtime, then stopped
on the whole-database data SHA equality gate and completed the exact pre-TREE
rollback. Evidence supplied by the Human Owner:

```text
SECOND_STAGE_A_CANDIDATE_RUNTIME=PASS
SECOND_STAGE_A_PRE_TREE_ROLLBACK=PASS
WHOLE_DATABASE_DATA_SHA_GATE=INVALID_FOR_LIVE_STAGE_A
WHOLE_DATABASE_DATA_SHA_SEQUENCE=b22d… -> 015b… -> 89c…
UNRELATED_DATABASE_ACTIVITY_CAUSE=NOT_PROVEN
CANDIDATE_IMAGE=aegis-prod-drive:vault-tree-70b0fdf05967
CANDIDATE_HEALTH=healthy
CANDIDATE_RESTARTS=0
CANDIDATE_OOM=false
VAULT_TREE_SCHEMA_AVAILABLE=false
VAULT_TREE_PROTOCOL_ENABLED=false
VAULT_DESTRUCTIVE_PURGE_ENABLED=false
TREE_TABLE_COUNT_PRE=0
TREE_TABLE_COUNT_CANDIDATE=0
TREE_TABLE_COUNT_ROLLBACK=0
VAULT_META_COUNT=2
VAULT_BLOBS_COUNT=2
VAULT_V2_BLOBS_COUNT=6
PRODUCTION_SCHEMA_UNCHANGED=YES
ROLLBACK_IMAGE=aegis-prod-drive:media-preview-1a3c16622407
ROLLBACK_HEALTH=healthy
ROLLBACK_RESTARTS=0
ROLLBACK_OOM=false
PRODUCTION_MIGRATION_011_APPLIED=NO
```

The whole-database data SHA changed from the recorded `b22d…` pre-value to
`015b…` after candidate cutover, then to `89c…` after rollback to the original
image. Read-only timestamp inspection found no rows changed during the cutover
window in `files`, `upload_sessions`, `vault_v2_upload_sessions`, or
`vault_v2_upload_chunks`. This proves whole-database `pg_dump --data-only` hash
equality is not a stable live Stage-A invariant. It does not prove the cause of
the unrelated database activity, nor prove that the candidate caused or did not
cause it.

```text
SOURCE_MAIN_SHA=70b0fdf059672e2b1c408ec5e5c16cfed5261257
SHA12=70b0fdf05967
CANDIDATE_IMAGE=aegis-prod-drive:vault-tree-70b0fdf05967
OCI_REVISION=70b0fdf059672e2b1c408ec5e5c16cfed5261257
PRODUCTION_RUNTIME_DIR=/opt/aegis/runtime/pr187
VAULT_DESTRUCTIVE_PURGE_ENABLED=false
PRODUCTION_PRIVILEGED_ACTIONS=HUMAN_OWNER_ONLY
```

Reviewed repository overlay SHA-256 values:

```text
577a25b20bbef0112a675cc1f2a48af593bd17b009eab2bda041e6819dd621d1  drive-image-70b0fdf05967.yml
6d5142c7a2297a908e109c046217f4ec16e3939af03604404e3d1c2840f70e76  drive-vault-protocol-70b0fdf05967.yml
fcf60eb60a16ae38c7f29045045569825de2479b308ce62baca0dc400541c161  drive-vault-ui-70b0fdf05967.yml
dbc5cdee07fa188744ec9d51d964ecb3a58deba5b122d7ea523643d207d50aef  drive-vault-fail-secure-70b0fdf05967.yml
```

## Frozen safety rules

- Never run `docker compose down`, any prune, `--remove-orphans`, a global
  recreate, or database-volume recreation.
- Never edit an active Compose file in place. Append reviewed PR187 overlays.
- Every service operation names `drive` and uses `up -d --no-deps --no-build drive`.
- Never print a password, `.env`, container environment, session secret, or token.
- Never modify Public Share, HUB, Monitor, IDEA2, IDEA3, or PR #154.
- Never enable destructive purge during this rollout.
- Never flatten TREE_V1, delete migration-011 tables, or return a TREE_V1 owner
  to legacy flat mutation.

## Verified pre-cutover baseline

The Human Owner's read-only Production preflight established:

```text
HOST=aegis-system
PROJECT=aegis-prod
DRIVE_CONTAINER=aegis-prod-drive-1
DRIVE_IMAGE=aegis-prod-drive:media-preview-1a3c16622407
DRIVE_REVISION=1a3c166224078d87c1aa41e6a7cc3f06790fdca9
DRIVE_HEALTH=healthy
DRIVE_RESTARTS=0
DRIVE_OOM=false
POSTGRES_CONTAINER=aegis-prod-postgres-1
POSTGRES_VERSION=15.19
DATABASE=aegis_drive
MIGRATION_010=PASS
MIGRATION_011_ALREADY_APPLIED=NO
TREE_TABLE_COUNT=0
```

Protected Drive runtime properties that every rendered diff must preserve:

```text
aegis_drive_proxy=172.19.255.3
aegis_internal=172.18.0.3
aegis_public_share_upstream=172.31.241.3
aegis_vlan10_macvlan=192.168.10.11
/run/aegis-telemetry=ro
/run/aegis-backup=ro
aegis_drive_media_cache:/var/cache/aegis-media=rw
aegis_drive_storage:/datalake=rw
group_add=[29100,29102]
```

## Backup gate

The initial fresh backup failed with `PG_DUMP_FAILED`. Diagnosis found the
backup-agent `.pgpass` host still bound to old bridge address `172.18.0.4` while
live PostgreSQL was `172.18.0.5`. The Human Owner changed only the host binding;
the password was neither printed nor changed. Authenticated `drive_backup`
connection then passed.

```text
PRE_DEPLOY_BACKUP=PASS
BACKUP_FRESH=YES
BACKUP_JOB_ID=23ca7538-cbd3-4373-a8e2-f580aca104a5
BACKUP_SNAPSHOT_ID=4c0e0b990e7a17dfc4e916bb8dbbb109a15fe2f21dfbcbdcde0f0ec5357089e3
BACKUP_FINISHED_AT=2026-09-23T12:32:37.410Z
BACKUP_INTEGRITY_CHECK=PASS
RESTORE_VERIFY_JOB_ID=8bfe48fa-8836-4ade-ae33-975da26c2528
RESTORE_VERIFICATION=PASS
BACKUP_TARGET=hgst-usb-1
BACKUP_TARGET_PROTECTION=DIFFERENT_DEVICE
```

Deferred technical debt: backup credentials currently bind to an ephemeral
Docker bridge address. A stable PostgreSQL endpoint requires a separate
integration-reviewed architecture decision; PR #187 does not implement one.

## Exact live Compose chain

The following chain was reported by the Human Owner. Re-read the Drive Compose
labels before each stage; live truth wins and any unexplained difference stops
the rollout.

```bash
D=(sudo env -u DOCKER_HOST -u CONTAINER_HOST docker)
COMPOSE=("${D[@]}" compose --env-file /opt/aegis/Project-End-The-AEGIS/.env --project-name aegis-prod)
CHAIN=(
  -f /opt/aegis/runtime/docker-compose.production.yml
  -f /opt/aegis/runtime/public-share/drive-s5-3.yml
  -f /opt/aegis/runtime/public-share/drive-gateway-s5-4.yml
  -f /opt/aegis/runtime/public-share/connector-s5-5.yml
  -f /opt/aegis/runtime/public-share/docker-compose.s5-11-ui.yml
  -f /opt/aegis/runtime/pr150/drive-image-e5bea949a917.yml
  -f /opt/aegis/runtime/pr150/drive-image-1a3c16622407.yml
  -f /opt/aegis/runtime/pr150/drive-media-preview-1a3c16622407.yml
)
```

## Candidate provenance and qualification

Local approved-build-host result:

```text
BUILD_COMMAND=docker build --label org.opencontainers.image.revision=70b0fdf059672e2b1c408ec5e5c16cfed5261257 --label org.opencontainers.image.source=https://github.com/kraveerachat/Project-End-The-AEGIS -t aegis-prod-drive:vault-tree-70b0fdf05967 .
CANDIDATE_IMAGE_ID=sha256:c97cf9f6e3bdd36b4ecca5471d842a46f151f8ca09edcda0be2084e97c42c673
OCI_REVISION=70b0fdf059672e2b1c408ec5e5c16cfed5261257
NODE=v20.20.2
ALPINE=3.23.4
FFMPEG=8.0.1
FFPROBE=8.0.1
SHARP=0.35.4
VIPS=8.18.6
IMAGE_CONFIG_USER=node
RUNTIME_USER_NAME=node
RUNTIME_UID=1000
RUNTIME_GID=1000
STARTUP_FILES=PASS
TREE_ENV_BAKED_IN=NO
DATABASE_URL_BAKED_IN=NO
CREDENTIALS_BAKED_IN=NO
SECRETS_BAKED_IN=NO
```

Qualification on the exact detached source:

```text
QHD_AND_TREE_UI=121/121 PASS
TREE_BACKEND_IN_MEMORY=108/108 PASS
LEGACY_V1_V2_CORE=140/140 PASS
POSTGRESQL_15_TREE_AND_LEGACY=61/61 PASS on clean rerun
SHARED_FILES=265 PASS / 0 FAIL / 12 environment-gated SKIP
MEDIA=233 PASS / 2 known superseded locked-presentation assertions / 43 environment-gated SKIP / 0 functional regression
BUILD=PASS (2725 modules; existing >500 kB chunk warning)
```

The first PostgreSQL run was 60/61 because the already documented
ordering-sensitive `PG-MG-2` lease race fired; a clean isolated rerun passed
61/61. The two media failures assert the retired locked ciphertext-card
presentation and are superseded by the accepted privacy/QHD contract; the
current QHD/TREE UI regression suite passes 121/121. These are reported, not
converted to PASS.

A non-gating complete-suite audit against the preceding source, whose IDEA1
tree is byte-identical to this candidate after the IDEA3-only main advance,
reached 830 pass / 1 fail / 80 skip before the runner retained open handles.
The sole failure reproduces alone on this exact source and is the pre-existing
Thai/English locale key-parity check (`vaultKeyConfirmLabel` absent from Thai).
This rollout changes no localization source; the result is recorded as
unrelated baseline debt, not as a candidate regression or a PASS.

The image must be rebuilt or transferred to Production through an approved
mechanism while retaining the exact tag and OCI label. Image IDs may differ
after a host rebuild; the required identity is source SHA + OCI revision label
+ packaged toolchain verification.

## Stage A — candidate image only

Append only:

```text
/opt/aegis/runtime/pr187/drive-image-70b0fdf05967.yml
```

All TREE flags remain absent/false. Exact-source runtime qualification proved
the candidate starts against a PostgreSQL 15 database with zero migration-011
tables: `/healthz` PASS, metadata/storage/media PASS, tree schema/protocol/purge
false, restart 0, OOM false, and zero tree table creation.

The rendered config may change only `services.drive.image`. After a separately
authorized Human Owner cutover, use only:

```bash
"${COMPOSE[@]}" "${CHAIN[@]}" \
  -f /opt/aegis/runtime/pr187/drive-image-70b0fdf05967.yml \
  up -d --no-deps --no-build drive
```

Before any owner reaches TREE_V1, rollback omits every PR187 overlay and restores
the exact pre-cutover chain. This rollback boundary ends permanently when the
first owner reaches TREE_V1.

## Stage B — additive migration 011

Allowed only after Stage A and the backup gate remain PASS. The migration source
must come from the isolated exact-SHA build tree:

```text
IDEA1-AEGIS_Drive_LC/server/db/migrations/011_vault_tree_v1.sql
```

Execution requires the Production migration/superuser role and
`psql -v ON_ERROR_STOP=1`. It must yield exactly seven tables, the
`vault_tree_revisions_immutable` trigger, all constraints/indexes, and 28 direct
`drive_app` DML grants. Legacy V1/V2 counts and ciphertext byte counts must remain
unchanged. No down migration exists or is permitted.

## Stage C — schema + protocol

Append the image overlay plus:

```text
/opt/aegis/runtime/pr187/drive-vault-protocol-70b0fdf05967.yml
```

Effective flags:

```text
VAULT_TREE_SCHEMA_AVAILABLE=true
VAULT_TREE_PROTOCOL_ENABLED=true
VAULT_TREE_GENESIS_MIGRATION_ENABLED=false
VAULT_TREE_UI_ENABLED=false
VAULT_MEDIA_PREVIEW_ENABLED=false
VAULT_DESTRUCTIVE_PURGE_ENABLED=false
```

The rendered diff may add only these Drive environment keys. A missing tree
table must fail startup. No owner migration is available in this stage.

## Stage D — genesis + UI + client media

Append the image overlay plus the Stage C overlay plus:

```text
/opt/aegis/runtime/pr187/drive-vault-ui-70b0fdf05967.yml
```

Effective flags are schema/protocol/genesis/UI/media `true`, destructive purge
`false`. Human Production browser acceptance is mandatory before closeout.

## Post-migration fail-secure rollback

After any owner becomes TREE_V1, never omit the candidate image and never return
to a pre-PR157 image. Keep the TREE-capable image and append:

```text
/opt/aegis/runtime/pr187/drive-vault-fail-secure-70b0fdf05967.yml
```

Effective flags:

```text
VAULT_TREE_SCHEMA_AVAILABLE=true
VAULT_TREE_PROTOCOL_ENABLED=false
VAULT_TREE_GENESIS_MIGRATION_ENABLED=false
VAULT_TREE_UI_ENABLED=false
VAULT_MEDIA_PREVIEW_ENABLED=false
VAULT_DESTRUCTIVE_PURGE_ENABLED=false
```

The legacy mutation fence reads the owner protocol state independently of the
feature flags. `MIGRATING_TREE_V1` remains fenced and `TREE_V1` remains permanently
fenced from legacy flat mutation. Tables, heads, encrypted manifests, blob state,
and ciphertext remain intact.

## Third Stage A — corrected Human Owner command set

The commands below are the corrected package proposed for a possible third
Stage A. They are not authorization. The Human Owner must review the protected
Vault-data fingerprint contract and separately authorize any execution.

### A. Approved build workstation — export and transfer

```powershell
$Image = 'aegis-prod-drive:vault-tree-70b0fdf05967'
$Archive = "$env:USERPROFILE\Downloads\aegis-prod-drive-vault-tree-70b0fdf05967.tar"
docker image inspect $Image --format 'ID={{.Id}} REV={{index .Config.Labels "org.opencontainers.image.revision"}} SOURCE={{index .Config.Labels "org.opencontainers.image.source"}}'
docker save --output $Archive $Image
Get-FileHash -Algorithm SHA256 -LiteralPath $Archive
scp $Archive aegis-system:/tmp/aegis-prod-drive-vault-tree-70b0fdf05967.tar
scp IDEA1-AEGIS_Drive_LC/deploy/production/pr187/drive-image-70b0fdf05967.yml aegis-system:/tmp/drive-image-70b0fdf05967.yml
```

Record the local archive SHA-256. The server-side value must match before
loading. Do not transfer or install the Stage C/D/fail-secure overlays during
Stage A.

### B. Production host — read-only preconditions

```bash
set -euo pipefail
D=(sudo env -u DOCKER_HOST -u CONTAINER_HOST docker)
COMPOSE=("${D[@]}" compose --env-file /opt/aegis/Project-End-The-AEGIS/.env --project-name aegis-prod)
CHAIN=(
  -f /opt/aegis/runtime/docker-compose.production.yml
  -f /opt/aegis/runtime/public-share/drive-s5-3.yml
  -f /opt/aegis/runtime/public-share/drive-gateway-s5-4.yml
  -f /opt/aegis/runtime/public-share/connector-s5-5.yml
  -f /opt/aegis/runtime/public-share/docker-compose.s5-11-ui.yml
  -f /opt/aegis/runtime/pr150/drive-image-e5bea949a917.yml
  -f /opt/aegis/runtime/pr150/drive-image-1a3c16622407.yml
  -f /opt/aegis/runtime/pr150/drive-media-preview-1a3c16622407.yml
)

EXPECTED_CURRENT_DRIVE_IMAGE=aegis-prod-drive:media-preview-1a3c16622407
EXPECTED_TREE_TABLE_COUNT=0
EXPECTED_CANDIDATE_REVISION=70b0fdf059672e2b1c408ec5e5c16cfed5261257
EXPECTED_STAGE_A_OVERLAY_SHA256=577a25b20bbef0112a675cc1f2a48af593bd17b009eab2bda041e6819dd621d1

EXPECTED_CONFIG_FILES=''
for ((i=1; i<${#CHAIN[@]}; i+=2)); do
  [[ -z "$EXPECTED_CONFIG_FILES" ]] || EXPECTED_CONFIG_FILES+=','
  EXPECTED_CONFIG_FILES+="${CHAIN[$i]}"
done

LIVE_PROJECT=$("${D[@]}" inspect aegis-prod-drive-1 --format '{{index .Config.Labels "com.docker.compose.project"}}')
LIVE_CONFIG_FILES=$("${D[@]}" inspect aegis-prod-drive-1 --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}')
LIVE_SERVICE=$("${D[@]}" inspect aegis-prod-drive-1 --format '{{index .Config.Labels "com.docker.compose.service"}}')
printf 'LIVE_PROJECT=%s\nLIVE_SERVICE=%s\nLIVE_CONFIG_FILES=%s\n' "$LIVE_PROJECT" "$LIVE_SERVICE" "$LIVE_CONFIG_FILES"
test "$LIVE_PROJECT" = 'aegis-prod' || { echo 'STOP: live Drive Compose project mismatch' >&2; exit 1; }
test "$LIVE_SERVICE" = 'drive' || { echo 'STOP: live Drive Compose service mismatch' >&2; exit 1; }
test "$LIVE_CONFIG_FILES" = "$EXPECTED_CONFIG_FILES" || { echo 'STOP: unexplained live Drive Compose config-file chain difference' >&2; exit 1; }

IFS='|' read -r CURRENT_DRIVE_IMAGE CURRENT_DRIVE_HEALTH CURRENT_DRIVE_RESTARTS CURRENT_DRIVE_OOM < <(
  "${D[@]}" inspect aegis-prod-drive-1 --format '{{.Config.Image}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.RestartCount}}|{{.State.OOMKilled}}'
)
printf 'CURRENT_DRIVE_IMAGE=%s\nCURRENT_DRIVE_HEALTH=%s\nCURRENT_DRIVE_RESTARTS=%s\nCURRENT_DRIVE_OOM=%s\n' "$CURRENT_DRIVE_IMAGE" "$CURRENT_DRIVE_HEALTH" "$CURRENT_DRIVE_RESTARTS" "$CURRENT_DRIVE_OOM"
test "$CURRENT_DRIVE_IMAGE" = "$EXPECTED_CURRENT_DRIVE_IMAGE" || { echo 'STOP: current Production Drive image mismatch' >&2; exit 1; }
test "$CURRENT_DRIVE_HEALTH" = 'healthy' || { echo 'STOP: current Production Drive is not healthy' >&2; exit 1; }
test "$CURRENT_DRIVE_OOM" = 'false' || { echo 'STOP: current Production Drive reports OOMKilled' >&2; exit 1; }

IFS='|' read -r POSTGRES_IMAGE POSTGRES_HEALTH POSTGRES_RESTARTS POSTGRES_OOM < <(
  "${D[@]}" inspect aegis-prod-postgres-1 --format '{{.Config.Image}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.RestartCount}}|{{.State.OOMKilled}}'
)
printf 'POSTGRES_IMAGE=%s\nPOSTGRES_HEALTH=%s\nPOSTGRES_RESTARTS=%s\nPOSTGRES_OOM=%s\n' "$POSTGRES_IMAGE" "$POSTGRES_HEALTH" "$POSTGRES_RESTARTS" "$POSTGRES_OOM"
test "$POSTGRES_HEALTH" = 'healthy' || { echo 'STOP: current Production PostgreSQL is not healthy' >&2; exit 1; }
test "$POSTGRES_OOM" = 'false' || { echo 'STOP: current Production PostgreSQL reports OOMKilled' >&2; exit 1; }
POSTGRES_VERSION_NUM=$("${D[@]}" exec aegis-prod-postgres-1 sh -lc 'psql -U "$POSTGRES_USER" -d aegis_drive -v ON_ERROR_STOP=1 -Atc "SELECT current_setting('"'"'server_version_num'"'"');"')
TREE_TABLE_COUNT=$("${D[@]}" exec aegis-prod-postgres-1 sh -lc 'psql -U "$POSTGRES_USER" -d aegis_drive -v ON_ERROR_STOP=1 -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema='"'"'public'"'"' AND table_name IN ('"'"'vault_tree_state'"'"','"'"'vault_tree_frozen_inventory'"'"','"'"'vault_tree_key_envelope'"'"','"'"'vault_tree_heads'"'"','"'"'vault_tree_revisions'"'"','"'"'vault_tree_blob_state'"'"','"'"'vault_tree_purge_candidates'"'"');"')
PRE_LEGACY_COUNTS=$("${D[@]}" exec aegis-prod-postgres-1 sh -lc 'psql -U "$POSTGRES_USER" -d aegis_drive -v ON_ERROR_STOP=1 -Atc "SELECT '"'"'vault_meta='"'"'||count(*) FROM vault_meta; SELECT '"'"'vault_blobs='"'"'||count(*) FROM vault_blobs; SELECT '"'"'vault_v2_blobs='"'"'||count(*) FROM vault_v2_blobs;"')
printf 'POSTGRES_VERSION_NUM=%s\nTREE_TABLE_COUNT=%s\n%s\n' "$POSTGRES_VERSION_NUM" "$TREE_TABLE_COUNT" "$PRE_LEGACY_COUNTS"
POSTGRES_MAJOR=$((POSTGRES_VERSION_NUM / 10000))
test "$POSTGRES_MAJOR" = '15' || { echo 'STOP: PostgreSQL major is not 15' >&2; exit 1; }
test "$TREE_TABLE_COUNT" = "$EXPECTED_TREE_TABLE_COUNT" || { echo 'STOP: migration 011/TREE tables are already present' >&2; exit 1; }

vault_protected_sha256() {
  "${D[@]}" exec -i aegis-prod-postgres-1 sh -lc 'psql -X -qAt -U "$POSTGRES_USER" -d aegis_drive -v ON_ERROR_STOP=1' <<'SQL' | sha256sum | cut -d' ' -f1
COPY (
  SELECT payload
  FROM (
    SELECT 0 AS section_rank, 'contract'::text AS primary_key_1, ''::text AS primary_key_2,
           jsonb_build_array(
             'PR187_STAGE_A_PROTECTED_VAULT_V1',
             'vault_meta:user_id',
             'vault_blobs:id',
             'vault_v2_blobs:id',
             'vault_v2_blob_chunks:blob_id,chunk_index'
           )::text AS payload
    UNION ALL
    SELECT 1, lpad(user_id::text, 20, '0'), '',
           jsonb_build_array(
             'vault_meta', user_id, salt_b64, kdf, memory_kib, iterations,
             parallelism, verifier_iv, verifier_data,
             to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
           )::text
      FROM vault_meta
    UNION ALL
    SELECT 2, lpad(id::text, 20, '0'), '',
           jsonb_build_array(
             'vault_blobs', id, user_id, storage_key, iv_b64, wrapped_dek_b64,
             wrap_iv_b64, meta_iv_b64, meta_b64, size_bytes,
             to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
           )::text
      FROM vault_blobs
    UNION ALL
    SELECT 3, id, '',
           jsonb_build_array(
             'vault_v2_blobs', id, user_id, format_version, storage_key,
             content_id_b64, ciphertext_size, chunk_size, chunk_count,
             wrapped_dek_b64, wrap_iv_b64, meta_iv_b64, meta_b64,
             to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
           )::text
      FROM vault_v2_blobs
    UNION ALL
    SELECT 4, blob_id, lpad(chunk_index::text, 10, '0'),
           jsonb_build_array(
             'vault_v2_blob_chunks', blob_id, chunk_index, ciphertext_size,
             ciphertext_sha256, iv_b64
           )::text
      FROM vault_v2_blob_chunks
  ) AS protected_vault_rows
  ORDER BY section_rank, primary_key_1 COLLATE "C", primary_key_2 COLLATE "C"
) TO STDOUT;
SQL
}

PRE_SCHEMA_SHA256=$("${D[@]}" exec aegis-prod-postgres-1 sh -lc 'pg_dump -U "$POSTGRES_USER" -d aegis_drive --schema-only --no-owner --no-privileges | grep -vE "^\\\\(un)?restrict " | sha256sum | cut -d" " -f1')
PRE_PROTECTED_VAULT_SHA256=$(vault_protected_sha256)
printf 'PRE_SCHEMA_SHA256=%s\nPRE_PROTECTED_VAULT_SHA256=%s\n' "$PRE_SCHEMA_SHA256" "$PRE_PROTECTED_VAULT_SHA256"
```

Run any separately authorized Third Stage A in this same shell during a controlled
maintenance window with no intentional user writes. Any unexplained extra or
missing live Compose config file stops the cutover. The pre-cutover row counts,
normalized schema fingerprint, and protected Vault fingerprint stay in memory for
exact post-cutover comparison.

The protected fingerprint sends canonical rows directly from `psql` to
`sha256sum`; it prints only the final hash. It covers committed immutable Vault
state: V1 vault configuration and blobs, V2 published blobs, V2 committed chunk
metadata, storage keys, envelope/IV fields, encrypted metadata, ciphertext sizes,
and server-recorded ciphertext hashes. It orders explicitly by each table's stable
primary key under `C` collation. In-flight upload/session tables are excluded
because their lease, status, expiry, writer-token, and recovery fields are mutable
operational state; inspect them separately when investigating activity.

### C. Production host — verify transfer, load, and install Stage A overlay

```bash
SERVER_ARCHIVE_SHA256=$(sha256sum /tmp/aegis-prod-drive-vault-tree-70b0fdf05967.tar | cut -d' ' -f1)
printf 'SERVER_ARCHIVE_SHA256=%s\n' "$SERVER_ARCHIVE_SHA256"
read -r -p 'Paste approved local workstation archive SHA-256: ' APPROVED_LOCAL_ARCHIVE_SHA256
[[ "$APPROVED_LOCAL_ARCHIVE_SHA256" =~ ^[[:xdigit:]]{64}$ ]] || { echo 'STOP: approved local archive SHA-256 is invalid' >&2; exit 1; }
test "${APPROVED_LOCAL_ARCHIVE_SHA256,,}" = "$SERVER_ARCHIVE_SHA256" || { echo 'STOP: transferred archive SHA-256 does not match the approved workstation value' >&2; exit 1; }

"${D[@]}" load --input /tmp/aegis-prod-drive-vault-tree-70b0fdf05967.tar
CANDIDATE_REVISION=$("${D[@]}" image inspect aegis-prod-drive:vault-tree-70b0fdf05967 --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
"${D[@]}" image inspect aegis-prod-drive:vault-tree-70b0fdf05967 --format 'ID={{.Id}} REV={{index .Config.Labels "org.opencontainers.image.revision"}} SOURCE={{index .Config.Labels "org.opencontainers.image.source"}} IMAGE_CONFIG_USER={{.Config.User}}'
test "$CANDIDATE_REVISION" = "$EXPECTED_CANDIDATE_REVISION" || { echo 'STOP: candidate OCI revision mismatch' >&2; exit 1; }

sudo install -d -m 0755 /opt/aegis/runtime/pr187
sudo install -m 0644 /tmp/drive-image-70b0fdf05967.yml /opt/aegis/runtime/pr187/drive-image-70b0fdf05967.yml
STAGE_A_OVERLAY_SHA256=$(sha256sum /opt/aegis/runtime/pr187/drive-image-70b0fdf05967.yml | cut -d' ' -f1)
printf 'STAGE_A_OVERLAY_SHA256=%s\n' "$STAGE_A_OVERLAY_SHA256"
test "$STAGE_A_OVERLAY_SHA256" = "$EXPECTED_STAGE_A_OVERLAY_SHA256" || { echo 'STOP: installed Stage A overlay SHA-256 mismatch' >&2; exit 1; }
```

Required image ID is
`sha256:c97cf9f6e3bdd36b4ecca5471d842a46f151f8ca09edcda0be2084e97c42c673`;
required OCI revision is
`70b0fdf059672e2b1c408ec5e5c16cfed5261257`; required overlay SHA-256 is
`577a25b20bbef0112a675cc1f2a48af593bd17b009eab2bda041e6819dd621d1`.

### D. Production host — non-persistent Stage A render validation

```bash
"${COMPOSE[@]}" "${CHAIN[@]}" \
  -f /opt/aegis/runtime/pr187/drive-image-70b0fdf05967.yml \
  config --quiet

STAGE_A_IMAGES=$("${COMPOSE[@]}" "${CHAIN[@]}" \
  -f /opt/aegis/runtime/pr187/drive-image-70b0fdf05967.yml \
  config --images)
CANDIDATE_IMAGE_COUNT=$(printf '%s\n' "$STAGE_A_IMAGES" | grep -Fxc 'aegis-prod-drive:vault-tree-70b0fdf05967' || true)
printf 'EXPECTED_STAGE_A_DRIVE_IMAGE=%s\n' 'aegis-prod-drive:vault-tree-70b0fdf05967'
test "$CANDIDATE_IMAGE_COUNT" = '1' || { echo 'STOP: Stage A candidate image is missing or duplicated in the effective Compose model' >&2; exit 1; }

FORBIDDEN_STAGE_A_LINES=$("${COMPOSE[@]}" "${CHAIN[@]}" \
  -f /opt/aegis/runtime/pr187/drive-image-70b0fdf05967.yml \
  config | grep -nE 'VAULT_TREE_SCHEMA_AVAILABLE|VAULT_TREE_PROTOCOL_ENABLED|VAULT_TREE_GENESIS_MIGRATION_ENABLED|VAULT_TREE_UI_ENABLED|VAULT_MEDIA_PREVIEW_ENABLED|VAULT_DESTRUCTIVE_PURGE_ENABLED' || true)
if [[ -n "$FORBIDDEN_STAGE_A_LINES" ]]; then
  printf '%s\n' "$FORBIDDEN_STAGE_A_LINES"
  echo 'STOP: Stage A render contains TREE flags' >&2
  exit 1
fi
echo 'STAGE_A_NON_PERSISTENT_RENDER=PASS'
```

The fully interpolated Compose model flows only through the validation pipeline;
it is not persisted to disk. Only the expected candidate image and any
forbidden matching flag lines are printed.

### E. STAGE_A_PRE_TREE_ROLLBACK_ONLY — prepared, do not execute now

This rollback is valid only while migration 011 is absent, TREE table count is
zero, and no owner has entered `MIGRATING_TREE_V1` or `TREE_V1`.

**AFTER MIGRATION 011 / TREE_V1 OWNER: THIS ROLLBACK IS FORBIDDEN.**

```bash
PRE_ROLLBACK_TREE_TABLE_COUNT=$("${D[@]}" exec aegis-prod-postgres-1 sh -lc 'psql -U "$POSTGRES_USER" -d aegis_drive -v ON_ERROR_STOP=1 -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema='"'"'public'"'"' AND table_name IN ('"'"'vault_tree_state'"'"','"'"'vault_tree_frozen_inventory'"'"','"'"'vault_tree_key_envelope'"'"','"'"'vault_tree_heads'"'"','"'"'vault_tree_revisions'"'"','"'"'vault_tree_blob_state'"'"','"'"'vault_tree_purge_candidates'"'"');"')
printf 'PRE_ROLLBACK_TREE_TABLE_COUNT=%s\n' "$PRE_ROLLBACK_TREE_TABLE_COUNT"
test "$PRE_ROLLBACK_TREE_TABLE_COUNT" = '0' || { echo 'STOP_FOR_HUMAN_INVESTIGATION: pre-TREE rollback is forbidden because TREE tables exist' >&2; exit 1; }

"${COMPOSE[@]}" "${CHAIN[@]}" \
  up -d --no-deps --no-build drive

for attempt in {1..30}; do
  ROLLBACK_HEALTH=$("${D[@]}" inspect aegis-prod-drive-1 --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')
  [[ "$ROLLBACK_HEALTH" = 'healthy' ]] && break
  sleep 2
done

IFS='|' read -r ROLLBACK_IMAGE ROLLBACK_HEALTH ROLLBACK_RESTARTS ROLLBACK_OOM < <(
  "${D[@]}" inspect aegis-prod-drive-1 --format '{{.Config.Image}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.RestartCount}}|{{.State.OOMKilled}}'
)
printf 'ROLLBACK_IMAGE=%s\nROLLBACK_HEALTH=%s\nROLLBACK_RESTARTS=%s\nROLLBACK_OOM=%s\n' "$ROLLBACK_IMAGE" "$ROLLBACK_HEALTH" "$ROLLBACK_RESTARTS" "$ROLLBACK_OOM"
test "$ROLLBACK_IMAGE" = "$EXPECTED_CURRENT_DRIVE_IMAGE" || { echo 'STOP_FOR_HUMAN_INVESTIGATION: rollback image mismatch' >&2; exit 1; }
test "$ROLLBACK_HEALTH" = 'healthy' || { echo 'STOP_FOR_HUMAN_INVESTIGATION: rollback Drive is not healthy' >&2; exit 1; }
test "$ROLLBACK_OOM" = 'false' || { echo 'STOP_FOR_HUMAN_INVESTIGATION: rollback Drive reports OOMKilled' >&2; exit 1; }

ROLLBACK_TREE_TABLE_COUNT=$("${D[@]}" exec aegis-prod-postgres-1 sh -lc 'psql -U "$POSTGRES_USER" -d aegis_drive -v ON_ERROR_STOP=1 -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema='"'"'public'"'"' AND table_name IN ('"'"'vault_tree_state'"'"','"'"'vault_tree_frozen_inventory'"'"','"'"'vault_tree_key_envelope'"'"','"'"'vault_tree_heads'"'"','"'"'vault_tree_revisions'"'"','"'"'vault_tree_blob_state'"'"','"'"'vault_tree_purge_candidates'"'"');"')
printf 'ROLLBACK_TREE_TABLE_COUNT=%s\n' "$ROLLBACK_TREE_TABLE_COUNT"
test "$ROLLBACK_TREE_TABLE_COUNT" = '0' || { echo 'STOP_FOR_HUMAN_INVESTIGATION: rollback is forbidden because TREE tables exist' >&2; exit 1; }
```

The Human Owner classifies the reported rollback restart count. Never use
`down`, `--remove-orphans`, prune, PostgreSQL recreation, or volume deletion.

### F. Production host — apply Drive-only Stage A

```bash

"${COMPOSE[@]}" "${CHAIN[@]}" \
  -f /opt/aegis/runtime/pr187/drive-image-70b0fdf05967.yml \
  up -d --no-deps --no-build drive
```

This names only `drive`. Never use `down`, `--remove-orphans`, prune, volume
deletion, or whole-stack recreation.

### G. Production host — technical post-cutover verification

```bash
for attempt in {1..30}; do
  POST_DRIVE_HEALTH=$("${D[@]}" inspect aegis-prod-drive-1 --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')
  [[ "$POST_DRIVE_HEALTH" = 'healthy' ]] && break
  sleep 2
done

IFS='|' read -r POST_DRIVE_IMAGE POST_DRIVE_HEALTH POST_DRIVE_RESTARTS POST_DRIVE_OOM < <(
  "${D[@]}" inspect aegis-prod-drive-1 --format '{{.Config.Image}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.RestartCount}}|{{.State.OOMKilled}}'
)
printf 'POST_DRIVE_IMAGE=%s\nPOST_DRIVE_HEALTH=%s\nPOST_DRIVE_RESTARTS=%s\nPOST_DRIVE_OOM=%s\n' "$POST_DRIVE_IMAGE" "$POST_DRIVE_HEALTH" "$POST_DRIVE_RESTARTS" "$POST_DRIVE_OOM"
test "$POST_DRIVE_IMAGE" = 'aegis-prod-drive:vault-tree-70b0fdf05967' || { echo 'STOP_FOR_HUMAN_INVESTIGATION: candidate image is not running' >&2; exit 1; }
test "$POST_DRIVE_HEALTH" = 'healthy' || { echo 'STOP_FOR_HUMAN_INVESTIGATION: candidate Drive is not healthy' >&2; exit 1; }
test "$POST_DRIVE_RESTARTS" = '0' || { echo 'STOP_FOR_HUMAN_INVESTIGATION: candidate Drive restart count is nonzero' >&2; exit 1; }
test "$POST_DRIVE_OOM" = 'false' || { echo 'STOP_FOR_HUMAN_INVESTIGATION: candidate Drive reports OOMKilled' >&2; exit 1; }

"${D[@]}" exec aegis-prod-drive-1 node -e 'fetch("http://127.0.0.1:8001/healthz").then(async r=>{const j=await r.json();const v=j.vaultTree??{};const out={status:r.status,ok:j.ok,layers:j.layers,media:j.media,vaultTree:v};console.log(JSON.stringify(out));if(!r.ok||j.ok!==true||j.layers?.application?.ok!==true||j.layers?.metadata?.ok!==true||j.layers?.storage?.ok!==true||v.schemaAvailable!==false||v.protocolEnabled!==false||v.destructivePurgeEnabled!==false)process.exit(1)}).catch(e=>{console.error(e.message);process.exit(1)})'

POST_TREE_TABLE_COUNT=$("${D[@]}" exec aegis-prod-postgres-1 sh -lc 'psql -U "$POSTGRES_USER" -d aegis_drive -v ON_ERROR_STOP=1 -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema='"'"'public'"'"' AND table_name IN ('"'"'vault_tree_state'"'"','"'"'vault_tree_frozen_inventory'"'"','"'"'vault_tree_key_envelope'"'"','"'"'vault_tree_heads'"'"','"'"'vault_tree_revisions'"'"','"'"'vault_tree_blob_state'"'"','"'"'vault_tree_purge_candidates'"'"');"')
POST_LEGACY_COUNTS=$("${D[@]}" exec aegis-prod-postgres-1 sh -lc 'psql -U "$POSTGRES_USER" -d aegis_drive -v ON_ERROR_STOP=1 -Atc "SELECT '"'"'vault_meta='"'"'||count(*) FROM vault_meta; SELECT '"'"'vault_blobs='"'"'||count(*) FROM vault_blobs; SELECT '"'"'vault_v2_blobs='"'"'||count(*) FROM vault_v2_blobs;"')
printf 'POST_TREE_TABLE_COUNT=%s\n%s\n' "$POST_TREE_TABLE_COUNT" "$POST_LEGACY_COUNTS"
test "$POST_TREE_TABLE_COUNT" = "$EXPECTED_TREE_TABLE_COUNT" || { echo 'STOP_FOR_HUMAN_INVESTIGATION: TREE table count changed during Stage A' >&2; exit 1; }
test "$POST_LEGACY_COUNTS" = "$PRE_LEGACY_COUNTS" || { echo 'STOP_FOR_HUMAN_INVESTIGATION: legacy Vault row counts changed during Stage A' >&2; exit 1; }

POST_SCHEMA_SHA256=$("${D[@]}" exec aegis-prod-postgres-1 sh -lc 'pg_dump -U "$POSTGRES_USER" -d aegis_drive --schema-only --no-owner --no-privileges | grep -vE "^\\\\(un)?restrict " | sha256sum | cut -d" " -f1')
POST_PROTECTED_VAULT_SHA256=$(vault_protected_sha256)
printf 'POST_SCHEMA_SHA256=%s\nPOST_PROTECTED_VAULT_SHA256=%s\n' "$POST_SCHEMA_SHA256" "$POST_PROTECTED_VAULT_SHA256"
test "$POST_SCHEMA_SHA256" = "$PRE_SCHEMA_SHA256" || { echo 'STOP_FOR_HUMAN_INVESTIGATION: Production schema changed during Stage A' >&2; exit 1; }
test "$POST_PROTECTED_VAULT_SHA256" = "$PRE_PROTECTED_VAULT_SHA256" || { echo 'STOP_FOR_HUMAN_INVESTIGATION: protected Vault data changed during Stage A' >&2; exit 1; }
echo 'PRODUCTION_SCHEMA_UNCHANGED=YES'
echo 'PROTECTED_VAULT_DATA_UNCHANGED=YES'
echo 'THIRD_STAGE_A_TECHNICAL=PASS'
echo 'THIRD_STAGE_A_HUMAN_QHD=PENDING'
```

Required: candidate image, healthy Drive, restart 0, OOM false,
application/metadata/storage healthy, `vaultTree.schemaAvailable=false`,
`vaultTree.protocolEnabled=false`, `vaultTree.destructivePurgeEnabled=false`,
TREE table count still 0, and all three legacy row counts unchanged.
The schema and protected Vault SHA-256 values must also match their pre-cutover
values exactly. A mismatch stops acceptance and requires Human investigation;
never rewrite the baseline or dismiss a mismatch as noise. Whole-database data
SHA equality is explicitly non-gating and is not part of this command set.

### H. Human Production QHD stop gate — mandatory before Stage B

After technical verification passes, stop. Keep migration 011 unapplied and all
six Vault flags false/unset. The Human Owner must use the actual Production
browser on the physical `2560x1440` display at `100%` browser zoom and record:

- Production login passes.
- `/drive/vault` loads with the genuine locked Vault state.
- The locked body is centered and constrained; privacy blocks are not stretched
  edge-to-edge; left/right gutters and header/body alignment are coherent.
- `/drive/files` is unchanged and no Stage A regression is visible.
- TREE_V1 UI is not expected during Stage A.

Only explicit Human QHD `PASS` authorizes a separate Stage B decision. A visual,
authentication, route, or Files regression stops rollout and requires Human
investigation; do not automatically classify the candidate or execute rollback.

## Current stop gate

Second Stage A was rolled back successfully. Production is again running
`aegis-prod-drive:media-preview-1a3c16622407`, healthy, restart 0, OOM false.
Migration 011 remains unapplied, TREE table count remains zero, and Production
Vault flags remain false/unset. This correction task does not touch Production
or rebuild the candidate. The next gate is Human review of the deterministic
protected-Vault fingerprint contract. Third Stage A and Stage B remain
unauthorized.
