# PR #187 Private Vault TREE_V1 — Production rollout runbook

Status: **PREPARED / NOT APPLIED. HUMAN OWNER EXECUTION ONLY.**

This runbook deploys merged source `0051cceb4927220446fbb12a7e730b43af777b71`.
It never builds application code from the PR #187 documentation head. The active
Production checkout remains read-only evidence. No command in this document is
authorization to execute a later stage.

```text
SOURCE_MAIN_SHA=0051cceb4927220446fbb12a7e730b43af777b71
SHA12=0051cceb4927
CANDIDATE_IMAGE=aegis-prod-drive:vault-tree-0051cceb4927
OCI_REVISION=0051cceb4927220446fbb12a7e730b43af777b71
PRODUCTION_RUNTIME_DIR=/opt/aegis/runtime/pr187
VAULT_DESTRUCTIVE_PURGE_ENABLED=false
PRODUCTION_PRIVILEGED_ACTIONS=HUMAN_OWNER_ONLY
```

Reviewed repository overlay SHA-256 values:

```text
4b6f0e900455a0e460dc6733aa43d4eeca6c619e245fe15b3e4b010ddfcfaf28  drive-image-0051cceb4927.yml
9ede9694b7e4219331e4eaa8c5b944a4d25837aaf825b5491760febbf1e221a8  drive-vault-protocol-0051cceb4927.yml
ccb5c1f04a0bfb22ad84451e0ed3c58a1fdfbbf158a10eb77651180b5e90400a  drive-vault-ui-0051cceb4927.yml
cf36d34576fced3b28db6297af93a251eafac44496b8c416754d649a7d3d8ed0  drive-vault-fail-secure-0051cceb4927.yml
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
BUILD_COMMAND=docker build --label org.opencontainers.image.revision=0051cceb4927220446fbb12a7e730b43af777b71 -t aegis-prod-drive:vault-tree-0051cceb4927 .
CANDIDATE_IMAGE_ID=sha256:73ac0ef368de9fee8f4137e6abcf43bbc734de587a24daeb0015cfef7dae3f32
CANDIDATE_REPODIGEST=aegis-prod-drive@sha256:73ac0ef368de9fee8f4137e6abcf43bbc734de587a24daeb0015cfef7dae3f32
OCI_REVISION=0051cceb4927220446fbb12a7e730b43af777b71
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
```

The image must be rebuilt or transferred to Production through an approved
mechanism while retaining the exact tag and OCI label. Image IDs may differ
after a host rebuild; the required identity is source SHA + OCI revision label
+ packaged toolchain verification.

## Stage A — candidate image only

Append only:

```text
/opt/aegis/runtime/pr187/drive-image-0051cceb4927.yml
```

All TREE flags remain absent/false. Exact-source runtime qualification proved
the candidate starts against a PostgreSQL 15 database with zero migration-011
tables: `/healthz` PASS, metadata/storage/media PASS, tree schema/protocol/purge
false, restart 0, OOM false, and zero tree table creation.

The rendered config may change only `services.drive.image`. After a separately
authorized Human Owner cutover, use only:

```bash
"${COMPOSE[@]}" "${CHAIN[@]}" \
  -f /opt/aegis/runtime/pr187/drive-image-0051cceb4927.yml \
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
/opt/aegis/runtime/pr187/drive-vault-protocol-0051cceb4927.yml
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
/opt/aegis/runtime/pr187/drive-vault-ui-0051cceb4927.yml
```

Effective flags are schema/protocol/genesis/UI/media `true`, destructive purge
`false`. Human Production browser acceptance is mandatory before closeout.

## Post-migration fail-secure rollback

After any owner becomes TREE_V1, never omit the candidate image and never return
to a pre-PR157 image. Keep the TREE-capable image and append:

```text
/opt/aegis/runtime/pr187/drive-vault-fail-secure-0051cceb4927.yml
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

## Current stop gate

No PR187 overlay has been installed. Migration 011 has not been applied. Drive
has not been recreated. Vault flags have not changed. The next action is a Human
Owner review and separate authorization for Stage A only.
