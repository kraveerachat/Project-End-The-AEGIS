# PR #187 Private Vault TREE_V1 — Production rollout runbook

Status: **SECOND STAGE A PREPARED / NOT APPLIED. HUMAN OWNER EXECUTION ONLY.**

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
IMAGE_USER=1000:1000
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

## Second Stage A — exact Human Owner command set (prepared, not executed)

The commands below are the complete second-Stage-A package. They are not an
authorization. The Human Owner runs them only after reviewing this PR and the
recorded image/overlay hashes.

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

"${D[@]}" inspect aegis-prod-drive-1 --format 'IMAGE={{.Config.Image}} HEALTH={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} RESTARTS={{.RestartCount}} OOM={{.State.OOMKilled}}'
"${D[@]}" inspect aegis-prod-postgres-1 --format 'IMAGE={{.Config.Image}} HEALTH={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} RESTARTS={{.RestartCount}} OOM={{.State.OOMKilled}}'
"${D[@]}" exec aegis-prod-postgres-1 sh -lc 'psql -U "$POSTGRES_USER" -d aegis_drive -v ON_ERROR_STOP=1 -Atc "SELECT current_setting('"'"'server_version_num'"'"'); SELECT count(*) FROM information_schema.tables WHERE table_schema='"'"'public'"'"' AND table_name IN ('"'"'vault_tree_state'"'"','"'"'vault_tree_frozen_inventory'"'"','"'"'vault_tree_key_envelope'"'"','"'"'vault_tree_heads'"'"','"'"'vault_tree_revisions'"'"','"'"'vault_tree_blob_state'"'"','"'"'vault_tree_purge_candidates'"'"'); SELECT '"'"'vault_meta='"'"'||count(*) FROM vault_meta; SELECT '"'"'vault_blobs='"'"'||count(*) FROM vault_blobs; SELECT '"'"'vault_v2_blobs='"'"'||count(*) FROM vault_v2_blobs;"'

PRE_SCHEMA_SHA256=$("${D[@]}" exec aegis-prod-postgres-1 sh -lc 'pg_dump -U "$POSTGRES_USER" -d aegis_drive --schema-only --no-owner --no-privileges | grep -vE "^\\\\(un)?restrict " | sha256sum | cut -d" " -f1')
PRE_DATA_SHA256=$("${D[@]}" exec aegis-prod-postgres-1 sh -lc 'pg_dump -U "$POSTGRES_USER" -d aegis_drive --data-only --no-owner --no-privileges | grep -vE "^\\\\(un)?restrict " | sha256sum | cut -d" " -f1')
printf 'PRE_SCHEMA_SHA256=%s\nPRE_DATA_SHA256=%s\n' "$PRE_SCHEMA_SHA256" "$PRE_DATA_SHA256"
```

Stop unless Drive/PostgreSQL are healthy, restart/OOM values are acceptable,
PostgreSQL major is 15, TREE table count is 0, and the legacy row-count baseline
is recorded. Run Stage A in the same shell and maintenance window; the pre-cutover
schema/data fingerprints above stay in memory for the post-cutover equality gate.

### C. Production host — verify transfer, load, and install Stage A overlay

```bash
sha256sum /tmp/aegis-prod-drive-vault-tree-70b0fdf05967.tar
"${D[@]}" load --input /tmp/aegis-prod-drive-vault-tree-70b0fdf05967.tar
"${D[@]}" image inspect aegis-prod-drive:vault-tree-70b0fdf05967 --format 'ID={{.Id}} REV={{index .Config.Labels "org.opencontainers.image.revision"}} SOURCE={{index .Config.Labels "org.opencontainers.image.source"}} USER={{.Config.User}}'
sudo install -d -m 0755 /opt/aegis/runtime/pr187
sudo install -m 0644 /tmp/drive-image-70b0fdf05967.yml /opt/aegis/runtime/pr187/drive-image-70b0fdf05967.yml
sha256sum /opt/aegis/runtime/pr187/drive-image-70b0fdf05967.yml
```

Required image ID is
`sha256:c97cf9f6e3bdd36b4ecca5471d842a46f151f8ca09edcda0be2084e97c42c673`;
required OCI revision is
`70b0fdf059672e2b1c408ec5e5c16cfed5261257`; required overlay SHA-256 is
`577a25b20bbef0112a675cc1f2a48af593bd17b009eab2bda041e6819dd621d1`.

### D. Production host — render and apply Drive-only Stage A

```bash
"${COMPOSE[@]}" "${CHAIN[@]}" \
  -f /opt/aegis/runtime/pr187/drive-image-70b0fdf05967.yml \
  config > /tmp/aegis-pr187-stage-a-rendered.yml

grep -n 'aegis-prod-drive:vault-tree-70b0fdf05967' /tmp/aegis-pr187-stage-a-rendered.yml
if grep -nE 'VAULT_TREE_SCHEMA_AVAILABLE|VAULT_TREE_PROTOCOL_ENABLED|VAULT_TREE_GENESIS_MIGRATION_ENABLED|VAULT_TREE_UI_ENABLED|VAULT_MEDIA_PREVIEW_ENABLED|VAULT_DESTRUCTIVE_PURGE_ENABLED' /tmp/aegis-pr187-stage-a-rendered.yml; then
  echo 'STOP: Stage A render contains TREE flags' >&2
  exit 1
fi

"${COMPOSE[@]}" "${CHAIN[@]}" \
  -f /opt/aegis/runtime/pr187/drive-image-70b0fdf05967.yml \
  up -d --no-deps --no-build drive
```

This names only `drive`. Never use `down`, `--remove-orphans`, prune, volume
deletion, or whole-stack recreation.

### E. Production host — post-cutover verification

```bash
"${D[@]}" inspect aegis-prod-drive-1 --format 'IMAGE={{.Config.Image}} HEALTH={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} RESTARTS={{.RestartCount}} OOM={{.State.OOMKilled}}'
"${D[@]}" exec aegis-prod-drive-1 node -e 'fetch("http://127.0.0.1:8001/healthz").then(async r=>{const j=await r.json(); console.log(JSON.stringify({status:r.status,ok:j.ok,layers:j.layers,media:j.media,vaultTree:j.vaultTree})); if(!r.ok)process.exit(1)})'
"${D[@]}" exec aegis-prod-postgres-1 sh -lc 'psql -U "$POSTGRES_USER" -d aegis_drive -v ON_ERROR_STOP=1 -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema='"'"'public'"'"' AND table_name IN ('"'"'vault_tree_state'"'"','"'"'vault_tree_frozen_inventory'"'"','"'"'vault_tree_key_envelope'"'"','"'"'vault_tree_heads'"'"','"'"'vault_tree_revisions'"'"','"'"'vault_tree_blob_state'"'"','"'"'vault_tree_purge_candidates'"'"'); SELECT '"'"'vault_meta='"'"'||count(*) FROM vault_meta; SELECT '"'"'vault_blobs='"'"'||count(*) FROM vault_blobs; SELECT '"'"'vault_v2_blobs='"'"'||count(*) FROM vault_v2_blobs;"'

POST_SCHEMA_SHA256=$("${D[@]}" exec aegis-prod-postgres-1 sh -lc 'pg_dump -U "$POSTGRES_USER" -d aegis_drive --schema-only --no-owner --no-privileges | grep -vE "^\\\\(un)?restrict " | sha256sum | cut -d" " -f1')
POST_DATA_SHA256=$("${D[@]}" exec aegis-prod-postgres-1 sh -lc 'pg_dump -U "$POSTGRES_USER" -d aegis_drive --data-only --no-owner --no-privileges | grep -vE "^\\\\(un)?restrict " | sha256sum | cut -d" " -f1')
printf 'POST_SCHEMA_SHA256=%s\nPOST_DATA_SHA256=%s\n' "$POST_SCHEMA_SHA256" "$POST_DATA_SHA256"
test "$POST_SCHEMA_SHA256" = "$PRE_SCHEMA_SHA256" || { echo 'STOP: Production schema changed during Stage A' >&2; exit 1; }
test "$POST_DATA_SHA256" = "$PRE_DATA_SHA256" || { echo 'STOP: Production data changed during Stage A' >&2; exit 1; }
echo 'PRODUCTION_SCHEMA_UNCHANGED=YES'
echo 'PRODUCTION_DATA_UNCHANGED=YES'
```

Required: candidate image, healthy Drive, restart 0, OOM false,
application/metadata/storage healthy, `vaultTree.schemaAvailable=false`,
`vaultTree.protocolEnabled=false`, `vaultTree.destructivePurgeEnabled=false`,
TREE table count still 0, and all three legacy row counts unchanged.
The schema and data SHA-256 values must also match their pre-cutover values
exactly. A mismatch stops acceptance and requires Human investigation; never
rewrite the baseline or dismiss a mismatch as noise.

## Current stop gate

The new candidate is built and locally qualified. No new PR187 overlay has been
installed on Production. Migration 011 remains unapplied. Production Drive has
not been recreated in this phase. Production Vault flags have not changed. The
next action is Human review and separate authorization for the second Stage A
command set above.
