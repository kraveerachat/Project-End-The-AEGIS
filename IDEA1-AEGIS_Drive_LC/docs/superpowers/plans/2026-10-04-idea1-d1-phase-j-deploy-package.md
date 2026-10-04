# IDEA1 D-1 Phase J — Stage 2 / Stage 3 deploy package (binds runbook V6)

> **Package status:** `PHASE_J=CLOSED/ACCEPTED`. The Human Owner executed Stage 2, Stage 3 and Stage 4 in
> Production (2026-10-04 → 2026-10-05, UTC+7): Stage 2 `DEPLOYED/ACCEPTED` (HG-S2 PASS), Stage 3
> `DEPLOYED/ACCEPTED` (HG-S3 PASS; writer enabled with exactly 8589934592 B per owner), Stage 4 `ACCEPTED`
> (HG-S4 PASS). Bound evidence: **§9 Production closeout**. Sections 1–8 are the **historical preparation
> record**, written before execution; their "not executed" / `PRODUCTION_MUTATION=NO` statements describe the
> state at package time. Every Production command was run by the **Human Owner**; no agent built-and-shipped,
> loaded an image, installed an overlay, ran `docker compose up`, restarted Drive, or changed Production
> environment.

Plan: `docs/superpowers/plans/2026-10-02-idea1-d1-separate-encrypted-preview-index-implementation.md`, Phase J, Stages 2–3.
Precedent: `IDEA1-AEGIS_Drive_LC/docs/superpowers/plans/2026-10-02-idea1-d1-stage1-production-runbook.md` (Stage 1 build/transfer/install).
Operational runbook (outside Git, bound by hash): `d1-stage234-final-runbook-v6.md`.

## 1. Authorities

```text
REPOSITORY=kraveerachat/Project-End-The-AEGIS
PR_E=#310 MERGED
PR_E_MERGE_SHA=2cbeb8363acd8ec611eb984e4c4c0c155c2fb24b      # origin/main at package time; contains PR #303 and PR-E
V6_RUNBOOK=d1-stage234-final-runbook-v6.md
V6_SHA256=7911e780f35ead33ed50a52e3786fb7e2653a69ab75fc462749416a9d059b62e
STAGE1_ACCEPTED_IMAGE=aegis-prod-drive:preview-d1-s1-9f5a01148ce0   # V6 EXPECTED_STAGE1_IMAGE (Stage 1 receipt 2026-10-02)
STAGE1_ACCEPTED_REVISION=9f5a01148ce016bc0056dbbcc85ac8a3e5fac23f   # ancestor of PR_E_MERGE_SHA: verified
APPROVED_BUDGET=8589934592                                   # HG-G 2026-10-03, 8 GiB per owner
WRITER_KINDS=thumb,poster
```

Machine-readable copy: `IDEA1-AEGIS_Drive_LC/deploy/production/d1/phase-j/phase-j-authority.txt`.

Runtime delta `9f5a0114..2cbeb836` in Drive build inputs: server JS only (`server/config/vaultTreeLimits.js`,
`server/db/vaultPreviewIndexStore.js`, `server/db/vaultTreeStore.js`, `server/db/vaultV2Store.js`,
`server/routes/api.js`, `server/routes/vaultPreviewIndex.js`, `server/routes/vaultUploads.js`) plus client
sources. **No new migration** (latest is still `012_vault_preview_index_v1.sql`, applied in Stage 1);
`Dockerfile`, `package.json`, `package-lock.json` unchanged since Stage 1.

## 2. V6 placeholder bindings

Every `<PENDING_PHASE_J_DEPLOY_PR>` in V6 resolves as follows. Paste these exact values into V6 §S2.4,
§S3.3, §S3.4 and §S3.7 (fresh-shell blocks).

| V6 variable | Bound value |
|---|---|
| `S2_SHA` | `2cbeb8363acd8ec611eb984e4c4c0c155c2fb24b` |
| `S2_IMAGE` | `aegis-prod-drive:preview-d1-s2-2cbeb8363acd` |
| `S2_OVERLAY` | `/opt/aegis/runtime/preview-d1/drive-preview-index-stage2-2cbeb8363acd.yml` |
| `S2_OVERLAY_SHA256` | `75f992bdb29994238f1d1e1985e4d40113baf346c99e7ba453da2273620b601e` |
| `IMAGE_ARCHIVE` | `/tmp/aegis-prod-drive-preview-d1-s2-2cbeb8363acd.tar` |
| `IMAGE_ARCHIVE_SHA256` | `8ef9aa88fce4e9fe5fd37eb21fb58367077827a601cf29c69d65cabb0de0e922` (Step 0 record below) |
| `IMAGE_REVISION_LABEL` | `2cbeb8363acd8ec611eb984e4c4c0c155c2fb24b` |
| `IMAGE_USER` | `node` |
| `S3_OVERLAY` | `/opt/aegis/runtime/preview-d1/drive-preview-index-stage3-2cbeb8363acd.yml` |
| `S3_OVERLAY_SHA256` | `c7a4538f671e6632ae4f74e792e01f75fe343b8d34ac9fc69b1a9312b0e0eb60` |

Overlay SHA-256 values are over Git blob (LF) bytes: `git show <ref>:<path> | sha256sum`.
Host paths follow the Stage 1 precedent: archive transferred to `/tmp/`, overlays installed under
`$RT=/opt/aegis/runtime/preview-d1` (V6 §2).

### Live Production bindings (read-only preflight, 2026-10-03T18:56:30Z)

`LIVE_BINDINGS_PENDING=NONE`, `LIVE_BINDINGS_READY=YES`. Captured by a read-only preflight (no mutation;
PostgreSQL `TRANSACTION_READ_ONLY=on`). The evidence file stays **outside Git** (it also holds terminal
prompt output): `phase-j-prod-readonly-preflight-20261004T015504.txt`,
SHA-256 `ee5f993d72b8d9b4581fce6cec4f1617f307ec873181df07023a8c7c38d1fa08`. Stage 2 has **not** been executed.

| Fact | Bound value |
|---|---|
| `LIVE_CURRENT_IMAGE` | `aegis-prod-drive:preview-d1-s1-9f5a01148ce0` (ID `sha256:8d5356fc…88e0`, revision `9f5a0114…`, user `node`) = V6 `EXPECTED_STAGE1_IMAGE` |
| `LIVE_POSTGRES_USER` | `aegis` (V6 still resolves it dynamically; this is the expected value) |
| `LIVE_STAGE1_CHAIN` | `phase-j/live-stage1-chain.txt` — exact ordered **31-file** drive-container chain (`com.docker.compose.project.config_files`); order SHA-256 `197a22837026e1d9ea94220ef282d5a5a262b6d4738227dc13009a29765a703b` |
| live chain manifest | `phase-j/live-stage1-chain.sha256` — per-file SHA-256 as captured; SHA-256 `d3a8cd04aae6d095ec98a4bf8fb9e44acc33b4519f062c3ee69cedb4b44a52bc` |
| `LIVE_STAGE1_OVERLAY_PATHS` | `/opt/aegis/runtime/preview-d1/drive-image-9f5a01148ce0.yml`, `/opt/aegis/runtime/preview-d1/drive-preview-index-stage1-9f5a01148ce0.yml` (chain positions 30, 31) |
| `LIVE_STAGE1_OVERLAY_SHA256` | `49b0ad5f…6f78`, `7c5f0df7…6a59` — equal to the Git blobs of the Stage 1 overlays |
| `PREVIEW_D1_DIR_EXISTS` | `YES` (`root:root 755`) |
| Flags | `SCHEMA_ENABLED=YES`, `READ_ENABLED=YES`, `WRITE_ENABLED=NO`, `BUDGET_ENV=UNSET` |
| Owners | `TOTAL_USERS=3`, `TREE_V1_OWNERS=2`, `MIGRATING_TREE_V1_OWNERS=0`, `ELIGIBLE_OWNER_UNION=2`, `CAPACITY_REVIEW_REQUIRED=NO` |
| Originals | `TOTAL_V2_BLOBS=62`, `TOTAL_V2_CIPHERTEXT_BYTES=3916387459` |
| D-1 state | heads 0, generations 0, blob_refs 0, `INDEX_STAGED_BYTES=0`, `INDEX_MANAGED_BYTES=0`, `INDEX_RETAINED_BYTES_TOTAL=0`, `INDEX_STATE_WITHOUT_BLOB=0` |
| Storage | `STORAGE_MOUNT=/var/lib/docker/volumes/aegis_drive_storage/_data`, `FS_TOTAL_BYTES=94793244672`, `FS_AVAILABLE_BYTES=31212642304` |
| Baseline | `STAGE2_ZERO_WRITE_BASELINE_READY=YES` |

The two chain files are byte-identical to what V6 §S2.2.1 writes on the host (`tr ',' '\n'` of the label;
`sha256sum` lines). At Stage 2 entry: `sha256sum $RT/pre-stage2-live-chain.txt` must print `197a2283…703b`
and `$RT/pre-stage2-live-chain.sha256` must equal `d3a8cd04…52bc`; any difference means the live chain moved
since the preflight → STOP and re-capture.

Observations for the operator (no action by this package):

- The **project**-level chain from `docker compose ls` has 35 files (it adds 4 monitor overlays). V6 uses the
  **drive container** label (31 files), as Stage 1 did; `up -d --no-deps --no-build drive` touches only `drive`.
- Worst-case Stage 3 retained exposure is `2 × 8589934592 = 17179869184` B against `FS_AVAILABLE_BYTES=31212642304`;
  V6 §S3.1 re-measures before enablement.

## 3. Stage contracts

| Variable | Stage 2 (`stage2` overlay) | Stage 3 (`stage2` + `stage3` overlays) |
|---|---|---|
| `image` | `aegis-prod-drive:preview-d1-s2-2cbeb8363acd` | **same** — Stage 3 overlay has no `image`/`build` key |
| `VAULT_PREVIEW_INDEX_SCHEMA_AVAILABLE` | `true` | `true` (inherited) |
| `VAULT_PREVIEW_INDEX_READ_ENABLED` | `true` | `true` (inherited) |
| `VAULT_PREVIEW_INDEX_WRITE_ENABLED` | `false` | `true` |
| `VAULT_PREVIEW_INDEX_MAX_RETAINED_BYTES_PER_OWNER` | **absent** | `8589934592` |
| `VAULT_MEDIA_PREVIEW_ENABLED` | `true` (restated) | `true` (inherited) |
| `VAULT_DESTRUCTIVE_PURGE_ENABLED` | `false` (restated) | `false` (inherited) |
| Boot line (V6) | `schema verified, read enabled, write disabled` | `schema verified, read enabled, write ENABLED` |

Same-image enforcement: (a) the Stage 3 overlay contains no `image`/`build`; (b) V6 §S3.3.2 requires the live
chain to end with `S2_OVERLAY`; (c) V6 §S3.4 requires the rendered Stage 3 drive image to equal `S2_IMAGE`;
(d) `verify-phase-j-package.sh` proves (a) and (c) on a fixture chain before shipping.

Stage 3 enables the writer **server-wide** for all eligible TREE_V1 owners (V6 §S3.1); the capacity preflight
and `ELIGIBLE_OWNERS <= 2` stop remain mandatory.

## 4. Step 0 — approved build workstation (Human)

Run in **Git Bash** (PowerShell `>` re-encodes bytes and breaks SHA-256 checks).

```bash
set -euo pipefail
SHA=2cbeb8363acd8ec611eb984e4c4c0c155c2fb24b
TAG=aegis-prod-drive:preview-d1-s2-2cbeb8363acd
REPO=/c/path/to/AEGIS_System                 # any clone of kraveerachat/Project-End-The-AEGIS
WT=/c/aegis-build-d1-s2-2cbeb8363acd
DEPLOY_REF=origin/feat/idea1-d1-phase-j-deploy   # or the exact reviewed commit of this package PR

git -C "$REPO" fetch origin
git -C "$REPO" merge-base --is-ancestor 9f5a01148ce016bc0056dbbcc85ac8a3e5fac23f "$SHA" && echo STAGE1_IN_CANDIDATE=YES
git -C "$REPO" -c core.autocrlf=false worktree add --detach "$WT" "$SHA"   # LF checkout
test -z "$(git -C "$WT" status --porcelain)" || { echo 'STOP: build worktree is not clean' >&2; exit 1; }

cd "$WT/IDEA1-AEGIS_Drive_LC"
docker build \
  --label org.opencontainers.image.revision=$SHA \
  --label org.opencontainers.image.source=https://github.com/kraveerachat/Project-End-The-AEGIS \
  -t "$TAG" .

docker image inspect "$TAG" \
  --format 'ID={{.Id}} REV={{index .Config.Labels "org.opencontainers.image.revision"}} USER={{.Config.User}}'
docker image inspect "$TAG" --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | cut -d= -f1 | grep -E '^(VAULT_|DATABASE_URL|PG|POSTGRES|SESSION|SECRET)' && { echo 'STOP: image bakes forbidden env' >&2; exit 1; } || echo 'IMAGE_ENV_CLEAN=YES'

# Package self-check at the reviewed deploy ref (local only; renders a fixture chain).
git -C "$REPO" worktree add --detach /c/aegis-verify-phase-j "$DEPLOY_REF"
bash /c/aegis-verify-phase-j/IDEA1-AEGIS_Drive_LC/deploy/production/d1/phase-j/verify-phase-j-package.sh HEAD

OUT="$USERPROFILE/Downloads/aegis-d1-s2"; mkdir -p "$OUT"
for f in drive-preview-index-stage2-2cbeb8363acd.yml drive-preview-index-stage3-2cbeb8363acd.yml; do
  git -C "$REPO" show "$DEPLOY_REF:IDEA1-AEGIS_Drive_LC/deploy/production/d1/$f" > "$OUT/$f"
done
sha256sum "$OUT"/*.yml     # must equal §2 S2_OVERLAY_SHA256 / S3_OVERLAY_SHA256
docker save --output "$OUT/aegis-prod-drive-preview-d1-s2-2cbeb8363acd.tar" "$TAG"
sha256sum "$OUT/aegis-prod-drive-preview-d1-s2-2cbeb8363acd.tar"
```

Required: `STAGE1_IN_CANDIDATE=YES`, `REV=2cbeb836…b24b`, `USER=node`, `IMAGE_ENV_CLEAN=YES`,
`PHASE_J_PACKAGE_VERIFY=PASS`, both overlay hashes as in §2.

### Step 0 record (build workstation, 2026-10-04 — local only, no Production connection)

```text
SOURCE_SHA=2cbeb8363acd8ec611eb984e4c4c0c155c2fb24b      # detached LF worktree, clean
BUILD_CONTEXT=IDEA1-AEGIS_Drive_LC  DOCKERFILE=IDEA1-AEGIS_Drive_LC/Dockerfile   # same as Stage 1
BUILD_INPUTS_SINCE_STAGE1=UNCHANGED                      # Dockerfile, package.json, package-lock.json: 9f5a0114..2cbeb836 empty diff
BUILDER=Docker Desktop 28.3.2 (containerd image store), linux/amd64
S2_IMAGE=aegis-prod-drive:preview-d1-s2-2cbeb8363acd
S2_IMAGE_ID=sha256:3a924636d1b09effcc7eee7f2115f14a735abb6e606eb334bf7dd4f55b9e36ff        # local .Id (OCI index digest; Stage 1 convention)
S2_IMAGE_CONFIG_DIGEST=sha256:5e1a0096cc487a32028e1643e16bc228b33ae51358b38844d336953299648819  # .Id reported by a classic-store daemon after docker load
S2_OCI_REVISION=2cbeb8363acd8ec611eb984e4c4c0c155c2fb24b
S2_OCI_SOURCE=https://github.com/kraveerachat/Project-End-The-AEGIS
CONTAINER_USER=node (uid=1000 gid=1000)
IMAGE_ENV_CLEAN=YES
IMAGE_SOURCE_EQ_GIT=YES                                  # 97/97 files (server/**, package.json, package-lock.json) byte-equal to Git blobs
SANITY (--network none): node v20.20.2, Alpine 3.23.4, ffmpeg/ffprobe 8.0.1, sharp loads, dist/index.html present,
  /datalake and /var/cache/aegis-media owned by node, `node --check server/index.js` OK, boot-line source present
S2_IMAGE_ARCHIVE_LOCAL=C:\Users\User\Downloads\aegis-d1-s2\aegis-prod-drive-preview-d1-s2-2cbeb8363acd.tar
S2_IMAGE_ARCHIVE_SHA256=8ef9aa88fce4e9fe5fd37eb21fb58367077827a601cf29c69d65cabb0de0e922
S2_IMAGE_ARCHIVE_BYTES=146528768
```

Re-check a local archive against these bindings:
`S2_IMAGE_ARCHIVE_LOCAL=<path> bash IDEA1-AEGIS_Drive_LC/deploy/production/d1/phase-j/verify-phase-j-package.sh`
(adds SHA-256, byte count, RepoTag, config digest, and config revision/user checks from inside the archive).
After V6 §S2.4 `docker load`, the host `docker image inspect "$S2_IMAGE" --format '{{.Id}}'` must equal
`S2_IMAGE_CONFIG_DIGEST` (classic store) or `S2_IMAGE_ID` (containerd store).

Transfer with the established mechanism (Stage 1 runbook §4 / PR187 §B) — archive and both overlays to `/tmp/` on the host.

## 5. Step T — host: verify transfer and install overlays (Human, before V6 §S2.4)

V6 §S2.4 / §S3.4 require `S2_OVERLAY` and `S3_OVERLAY` to exist at their host paths. Installing a file is not
a service mutation; it changes nothing running. Run after the V6 §2 Common Authority Block.

```bash
set -euo pipefail
RT=/opt/aegis/runtime/preview-d1
S2_OVERLAY_SHA256=75f992bdb29994238f1d1e1985e4d40113baf346c99e7ba453da2273620b601e
S3_OVERLAY_SHA256=c7a4538f671e6632ae4f74e792e01f75fe343b8d34ac9fc69b1a9312b0e0eb60
for pair in "drive-preview-index-stage2-2cbeb8363acd.yml:$S2_OVERLAY_SHA256" "drive-preview-index-stage3-2cbeb8363acd.yml:$S3_OVERLAY_SHA256"; do
  f=${pair%%:*}; h=${pair##*:}
  test "$(sha256sum "/tmp/$f" | cut -d' ' -f1)" = "$h" || { echo "STOP: /tmp/$f SHA-256 mismatch" >&2; exit 1; }
  sudo test ! -e "$RT/$f" || { echo "STOP: $RT/$f already exists — inspect before overwrite" >&2; exit 1; }
  sudo install -m 0644 "/tmp/$f" "$RT/$f"
  test "$(sha256sum "$RT/$f" | cut -d' ' -f1)" = "$h" || { echo "STOP: installed $f mismatch" >&2; exit 1; }
done
echo PHASE_J_OVERLAYS_INSTALLED=YES
```

The image archive stays in `/tmp/`; V6 §S2.4 verifies `IMAGE_ARCHIVE_SHA256` and loads it.

## 6. Local verification (agent-safe)

```bash
bash IDEA1-AEGIS_Drive_LC/deploy/production/d1/phase-j/verify-phase-j-package.sh [ref]
```

Checks authority bindings (pending set must be empty), live-chain structure (count, order and manifest hashes,
uniqueness, absolute `/opt/aegis/runtime` paths, Stage 1 overlays last with Git-equal hashes, P1 overlay hash,
S2/S3 overlays absent, zero D-1 state, eligible-owner capacity rule), overlay Git-blob SHA-256, the static overlay contract, and
renders `fixture base → Stage 1 image → Stage 1 flags → Stage 2 → Stage 3` with `docker compose config`
using the V6 §S2.4 / §S3.4 extraction expressions (images, WRITE, budget) plus non-drive equality. It never
runs `up`, `pull`, `load`, or contacts a host. The fixture (`phase-j/fixtures/live-chain-base.fixture.yml`) stands
in for the live base chain and is never shipped.

## 7. Rollback references

- Case C (Stage 2 → Stage 1, zero D-1 rows): V6 §S2.7, re-applies the authenticated `pre-stage2-live-chain.txt`.
- Case D (writer-capable → Stage 1 with D-1 rows): V6 §S2.8, separate Human authorization.
- Case E (Stage 3 → Stage 2): V6 §S3.7 with `S2_IMAGE` / `S2_OVERLAY` from §2; budget must be absent afterwards.

## 8. Non-Production replica rollback rehearsal — Cases B, D, E (V6 §1 precondition)

`REPLICA_ROLLBACK_REHEARSAL=COMPLETE` — `CASE_B=PASS`, `CASE_D=PASS`, `CASE_E=PASS` (run 6, 2026-10-04, 57/57 harness
checks, 0 failures). `REPLICA_ROLLBACK_REHEARSAL_REF=replica-bde-run6-20261004.tar`
(SHA-256 `c70c8c414504d92718e9727ea9f06d1be4b1b96869a90fe96d72755991073478`, 1382400 B, kept outside Git with the
preflight evidence). `PRODUCTION_CONNECTION=NO`, `PRODUCTION_MUTATION=NO`.

### Case definitions used

- **Case D** — V6 §S2.8 (lines 592–636), executed as written: writer-capable Stage 2/3 build → Stage 1 accepted
  read-only build when D-1 rows exist, re-applying the authenticated `pre-stage2-live-chain.*`.
- **Case E** — V6 §S3.7 (lines 962–1030), executed as written: Stage 3 → Stage 2, same image, writer false,
  budget unset, re-applying the authenticated `pre-stage3-live-chain.*` that must end with `S2_OVERLAY`.
- **Case B** — V6 names it (§1 lines 27, 65) but defines **no procedure**. V6's governing standard (plan Task I.2)
  defines it: *new reader/server → baseline server after an index exists*; must prove baseline boots,
  `/tree/blobs?lifecycle=UNREFERENCED` excludes `INDEX_*`, main `casHead` refuses `INDEX_*`, `GET /api/vault`
  carries the index envelopes (documented degraded payload, size recorded), baseline UI ignores them, no data loss.
  Baseline = the accepted P1 runtime `8634360f` (its server/src/Dockerfile/package inputs are byte-identical to the
  plan's `2dc596d1` baseline), reached through the authenticated `pre-stage1` chain as in the Stage 1 runbook.
- **Case C** (negative control, not requested): V6 §S2.7 run with D-1 rows present must refuse without mutation.

### Replica

| Item | Value |
|---|---|
| Isolation | Compose project `aegis-d1rep`, own network/volumes, bind-mounted disposable `/datalake`, `127.0.0.1:58811`, generated throw-away secrets; harness refuses `DOCKER_HOST` and non-local Docker contexts |
| Platform | Windows 11, Git Bash, Docker Desktop 28.3.2 (containerd store), Compose 2.38.2, Node 24.14.0 (driver) |
| PostgreSQL | `postgres:15-alpine`, `log_statement=all`; P1-era `schema.sql` + `seed.sql` (Git `8634360f`), production `drive_app` role/grant model, migration 012 from Git `9f5a0114` (SHA-256 `aac26537…b239`) |
| Images | P1 `aegis-prod-drive:p1-8634360f74ed` (built from exact `8634360f`, id `sha256:f38dfda1…5fc09`); Stage 1 `…:preview-d1-s1-9f5a01148ce0` (id `sha256:8d5356fc…88e0` = Production); Stage 2 `…:preview-d1-s2-2cbeb8363acd` (id `sha256:3a924636…36ff`, loaded from the bound archive by V6 §S2.4) |
| Chain | replica base + replica P1 overlay + Git Stage 1 overlays (`49b0ad5f…`, `7c5f0df7…`) + Git Stage 2/3 overlays (`75f992bd…`, `c7a4538f…`) |
| Client code | real client modules of each build: Stage 1 `9f5a0114`, Stage 2/3 `2cbeb836` (writer path), P1 `8634360f` |

### Lifecycle replayed on one database and one storage root

Setup (before `RUNTIME_BEGIN`) → Stage 1 (2 TREE_V1 owners + 1 provisioned user, 6 originals) → **V6 §S2.2–§S2.5**
(`PRE_STAGE2_ZERO_STATE_ASSERTED`, `STAGE2_BUDGET_UNSET_VERIFIED`, `STAGE2_BOOT_LINE_VERIFIED`,
`STAGE2_ZERO_STATE_ASSERTED`) → **V6 §S3.1–§S3.6** (`ELIGIBLE_OWNERS=2`, `BUDGET_BINDING_VERIFIED` 8589934592,
`STAGE3_BOOT_LINE_VERIFIED`) → real D-1 state through the Stage 2/3 writer path for 3 owners (heads 3, generations 3,
blob_refs 9, `INDEX_MANAGED` 9) → **Case E** → **Case C refusal** → **Case D** → **Case B**.

V6 blocks are extracted from the hash-verified V6 file and executed unchanged except authority tokens (35 logged
substitutions: Compose project/dir/env-file, `$RT`, container names, the `<PENDING_PHASE_J_DEPLOY_PR>` values bound in
§2 re-targeted to replica paths) plus a platform prelude (`sudo` → direct call with Docker Desktop VM-path → host-path
mapping; GNU `sha256sum` backslash-escape normalisation). The extractor fails if any Production path, container,
project, host address, or unresolved placeholder remains.

### Results

| Case | V6 / harness | Client (real modules) | D-1 snapshot | Originals |
|---|---|---|---|---|
| E | §S3.7 rc 0, `CASE_E_BUDGET_UNSET_VERIFIED=YES`, image = `S2_IMAGE`, env `WRITE=false` | 46/46: `/state` write=false; `POST /preview-index/head` and `/uploads` → 503 `PREVIEW_INDEX_WRITE_DISABLED`; reader READY on retained index; byte-exact downloads; upload/rename/move/trash/restore; 0 orphans | unchanged | unchanged |
| C (neg.) | §S2.7 rc 1: `CRITICAL: D-1 rows exist (12). Case C rollback is INVALID`; container image/StartedAt unchanged | — | unchanged | unchanged |
| D | §S2.8 rc 0, image = Stage 1 accepted image | 46/46: Stage 1 flags; write routes 404; Stage 1 reader READY on retained index; byte-exact downloads; ordinary flows; 0 orphans | unchanged | unchanged |
| B | authenticated pre-stage1 chain, image P1 (revision `8634360f`), restarts 0, OOM false, `/healthz` 200 | 49/49: no preview-index route; UNREFERENCED excludes all 9 index blobs; main CAS attaching a derivative → 409 `TREE_BLOB_STATE_CONFLICT` (×3); `GET /api/vault` carries index envelopes (degraded payload: 8/8/6 envelopes, 3929/3953/3061 B vs 3/3/1 on Stage 3); byte-exact downloads; ordinary flows; 0 orphans | unchanged | unchanged |

- **D-1 snapshot** (every `INDEX_*` blob with size/storage key, every head/generation/blob_ref row; 24 rows,
  SHA-256 `2d358be7…1828`) identical after E, D and B. Schema identical throughout (3 D-1 tables, widened lifecycle
  CHECK, 2 immutability triggers, `drive_app` has no DELETE on D-1 tables). `NON_V1_MAIN_REVISIONS=0` everywhere.
- **Originals**: 14 non-index blob rows + chunk rows (SHA-256 `23a2c6f5…cb4d`) unchanged after every case; all 29
  on-disk files present at Stage 3 still present with identical SHA-256 after every case; client downloads byte-exact.
- **Destructive-SQL audit** (`RUNTIME_BEGIN..RUNTIME_END`, 3254 statements, `drive_app` 3208): `NO_DOWNMIGRATION=YES`,
  `NO_DESTRUCTIVE_D1_DELETE=YES`, `NO_PURGE=YES`; no DDL, no DROP/TRUNCATE, no `DELETE FROM` a protected table, no
  purge-candidate insert, no preview-index write and no `INDEX_*` lifecycle write after the index was frozen; the
  superuser issued only reads. Only application `DELETE`: `DELETE FROM vault_tree_frozen_inventory WHERE user_id=$1`
  (tree genesis bookkeeping of the newly set-up vault; not D-1 or original state). Positive control: injected
  DELETE/TRUNCATE/purge-insert/ALTER statements are all detected (`SQL_CAPTURE_VERIFY=FAIL`).
- **Rollback chains**: V6 wrote `pre-stage2` (4 files) and `pre-stage3` (5 files, ending with `S2_OVERLAY`) lists,
  per-file manifests and order hashes; each order hash recomputed independently; Case D/E re-verified them
  (`sha256sum -c`, line-count and arg-count checks) before mutating.

### Reproduce

```bash
# clean detached LF worktrees (P1 8634360f, Stage 1 9f5a0114, Stage 2 2cbeb836) with node_modules; the three
# images above present locally; Stage 2 archive from §4.
P1_ROOT=<8634360f>/IDEA1-AEGIS_Drive_LC S1_ROOT=<9f5a0114>/IDEA1-AEGIS_Drive_LC S2_ROOT=<2cbeb836>/IDEA1-AEGIS_Drive_LC \
V6=<d1-stage234-final-runbook-v6.md> S2_ARCHIVE=<aegis-prod-drive-preview-d1-s2-2cbeb8363acd.tar> OUT=<dir outside repo> \
bash IDEA1-AEGIS_Drive_LC/deploy/production/d1/phase-j/rehearsal/rehearse-bde.sh   # → REPLICA_ROLLBACK_REHEARSAL=COMPLETE
```

Cleanup is part of the run (only project `aegis-d1rep`; `REMAINING_REPLICA_RESOURCES=0`).

### Limitations

- Replica, not Production: Windows/Docker Desktop host, 3 accounts and 6–25 small files, not the 31-file live chain
  (replica base + P1 stand-in overlay; Production P1 overlay bytes are not in Git). Live chain authenticity remains
  V6's job at execution time.
- D-1 state is created through the real writer path modules (`buildPreviewIndexFor`: seal derivative, shard, root,
  CAS) with a synthetic JPEG derivative, as in plan Task I.2; no browser canvas/thumbnail generation.
- V6 browser checks (§S2.3.3, §S2.5.2–3, §S3.3.3, §S3.6.2, Case E browser check) are exercised over HTTP with the
  build's own client modules, not a browser.
- V6 §S3.1.3 ran against the replica bind mount (host free space of the build workstation, not Production).
- Five harness-only runs preceded run 6 and were discarded (global MSYS path-conversion override broke `git -C`;
  missing replica `TRUSTED_PROXY_CIDRS`; probe file absent for the third account; Docker Desktop bind-path form;
  audit regex false positive on a read-only query plus an abort trap that overwrote the statement log).
  None touched Production; each replica was removed.

## 9. Production closeout (Human-executed; evidence kept outside Git, bound by SHA-256)

```text
PHASE_J=CLOSED/ACCEPTED
PRODUCTION_MUTATION_PERFORMED_BY=HUMAN_OWNER        # no agent executed any Production step
STAGE2=DEPLOYED/ACCEPTED   HG_S2=PASS
STAGE3=DEPLOYED/ACCEPTED   HG_S3=PASS
STAGE4=ACCEPTED            HG_S4=PASS (Human Owner APPROVED)
IMAGE=aegis-prod-drive:preview-d1-s2-2cbeb8363acd   # Stage 2 and Stage 3 run the same image
WRITER_ENABLED=YES                                  # remains enabled after Stage 4
VAULT_PREVIEW_INDEX_MAX_RETAINED_BYTES_PER_OWNER=8589934592   # exact 8 GiB
VAULT_DESTRUCTIVE_PURGE_ENABLED=false               # no destructive purge
FINAL_ELIGIBLE_OWNER_SET=1,2,3                      # new owner 3 = expected Stage 4 newly created user
```

### Stage 2 — zero-write deploy (V6 §S2)

| Fact | Value |
|---|---|
| Evidence | `phase-j-stage2-run-20261004T042047.txt`, SHA-256 `6533613c58a855430ed3e2847729a8d855052fe24bdc649ce57a995c119cd78c` |
| Result | `STAGE2_RESULT=DEPLOYED_ZERO_WRITE`, image `aegis-prod-drive:preview-d1-s2-2cbeb8363acd`, `write=false`, budget absent (`STAGE2_BUDGET_UNSET_VERIFIED=YES`) |
| Pre/post | `PRE_DEPLOY_BACKUP=PASS`; pre image = Stage 1 accepted image; post healthy, restarts 0, OOM false |
| Gate | HG-S2 PASS (browser 200/404 checks) |

Three earlier Stage 2 run files of the same day (`…T034016`, `…T040816`, `…T041502`) exist next to the accepted
run and are not the acceptance evidence.

### Stage 3 — writer enablement (V6 §S3)

| Fact | Value |
|---|---|
| Evidence | `phase-j-stage3-run-20261004T052958.txt`, SHA-256 `6a575f45fad8ba3035652ad9aaf07a8ad88ff0fb3a2c427684510bc35221b8f9` |
| Result | `STAGE3_RESULT=DEPLOYED_WRITER_ENABLED`, same image as Stage 2, `write=true`, `budget=8589934592`, `purge=false` |
| Entry | `PRE_S3_RECHECK=PASS` (Stage 2 image, healthy, write false, budget absent, D-1 rows 0); Human `CAPACITY-ACCEPTED`; `BUDGET_BINDING_VERIFIED` exact 8589934592 B |
| Gate | HG-S3 PASS; Stage 3 CLOSED/ACCEPTED |

One earlier Stage 3 run file (`…T052719`) is not the acceptance evidence.

### Stage 4 — live acceptance (runbook V7_R4, SHA-256 `a77bf708151ba7bca298181e08e6651c0bad9d4cad60976b61f3b155fe9b567d`)

| Phase | Evidence file | SHA-256 | Result |
|---|---|---|---|
| Entry | `phase-j-stage4-entry-20261004T234356.txt` | `a642d7243ffd33c02b1bd507484266c7adad89a85ca05d35ada33ac9511d1a90` | `VALID_BOUND_PRE_START` |
| Start | `phase-j-stage4-start-20261004T234557.txt` | `e2cc6cf245a2d44052f417ca2105ef7e61c280a80db5c54c731c30037d5ad49b` | `STARTED_PRE_VAULT` (62 originals fingerprinted) |
| Third vault | `phase-j-stage4-thirdvault-20261004T234828.txt` | `de25e5b3e1a9527f014c4d3516407c5f54b3571e4772c742030ecf8bed92e0a4` | `VALID_POST_VAULT` (recorded before first upload) |
| Post | `phase-j-stage4-post-20261005T000022.txt` | `286582980607b39f4e9d479441432932d7b55a09c484baa6f6f1aef399b43d96` | `STAGE4_POST_RESULT=MACHINE_EVIDENCE_PASS` |
| Acceptance record | `stage4-acceptance-record-final.json` | `5be829af64549c4fd925426d50894c52f7746c4d713660b5b3744612d9838341` | validator `RECORD=COMPLETE_HG_S4_READY` |

Final machine facts (Post): `ORIGINALS_PRESERVATION_VERIFIED=PASS`, `NON_V1_MAIN_REVISIONS=0`,
`INDEX_STATE_WITHOUT_BLOB=0`, `ORPHAN_COUNT_FINAL=0`, `MAX_OWNER_RETAINED_BYTES=323936`,
`AUDIT_PRIVACY_VIOLATIONS=0`, `S4_EXIT_CAPACITY=PASS`; final D-1 counts heads 1, generations 7, blob_refs 29,
staged 0, managed 21. Capacity: Human `CAPACITY-ACCEPTED-S4-3-OWNERS` for at most 3 eligible owners
(worst case 3 × 8589934592 = 25769803776 B against 31231864832 B available at entry; 31205990400 B at exit);
a 4th eligible owner requires a new capacity review.

Browser matrix (Human): mandatory items 1–8 and 10 PASS for ADMIN, EXISTING_USER and NEWLY_CREATED_USER on
both LAN and REMOTE (54/54 cells); item 9 PASS (`NON_V1_MAIN_REVISIONS=0`);
item 12 audit privacy 0 violations. Item 11 `NOT_AUTHORIZED`; item 13 (Case E rollback + re-enable)
`NOT_AUTHORIZED` — writer remains enabled; item 14 `NOT_EXECUTED` by policy (budget-exhaustion proof stays local:
PR-E H.1 PI-BUDGET HTTP 507, PR-E I.3).

### Closeout limits (no claim beyond evidence)

- No live rollback was executed in Production (Cases C/D/E remain replica-rehearsed only, §8).
- No Production budget-exhaustion (HTTP 507) test; no claim of D-1 throughput or bulk backfill behaviour.
- Evidence files are operator-written cross-evidence, not cryptographic seals; they stay outside Git with the
  sealed Stage 4 bundle (unaltered).
- `phase-j-authority.txt` keeps the **pre-Stage-2** read-only preflight facts (e.g. `LIVE_WRITE_ENABLED=NO`)
  as historical bindings; they are not the current Production state.
