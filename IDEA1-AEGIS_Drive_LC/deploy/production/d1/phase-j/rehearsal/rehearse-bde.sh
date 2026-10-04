#!/usr/bin/env bash
# IDEA1 D-1 Phase J — NON-PRODUCTION replica rehearsal of rollback Cases B, D, E (runbook V6 §1 precondition).
# LOCAL / DISPOSABLE ONLY: own Compose project `aegis-d1rep`, own network/volumes/bind dir, 127.0.0.1:58811,
# generated throw-away secrets. Never contacts a remote host, never uses a Production credential/path/volume.
#
# Lifecycle replayed on one database + one storage root (as Production would):
#   setup  : PostgreSQL 15, P1-era schema + seed + drive_app role model, migration 012 (= Stage 1 history)
#   Stage 1: accepted Stage 1 image (base + P1 + Stage 1 overlays) + seed (2 TREE_V1 owners, 1 provisioned user)
#   Stage 2: V6 §S2.2–§S2.5 verbatim (re-targeted authority tokens only), Stage 2 overlay from Git
#   Stage 3: V6 §S3.1–§S3.6 verbatim, Stage 3 overlay from Git; real D-1 state created through the writer path
#   Case E : V6 §S3.7 (Stage 3 → Stage 2)          + plan I.2 E assertions
#   Case C : V6 §S2.7 must REFUSE (D-1 rows exist)  — fail-closed negative control, no mutation
#   Case D : V6 §S2.8 (writer-capable → Stage 1)    + plan I.2 D assertions
#   Case B : plan I.2 B (V6 names Case B but defines no procedure): → baseline P1 after index creation
# Evidence: D-1 snapshot identity, originals (DB rows + on-disk bytes) intact, destructive-SQL audit, chain hashes.
#
# Usage (Git Bash):
#   P1_ROOT=<8634360f IDEA1 dir> S1_ROOT=<9f5a0114 IDEA1 dir> S2_ROOT=<2cbeb836 IDEA1 dir> \
#   V6=<d1-stage234-final-runbook-v6.md> S2_ARCHIVE=<aegis-prod-drive-preview-d1-s2-2cbeb8363acd.tar> \
#   OUT=<evidence dir outside the repo> bash rehearse-bde.sh
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(git -C "$HERE" rev-parse --show-toplevel)
: "${P1_ROOT:?}" "${S1_ROOT:?}" "${S2_ROOT:?}" "${V6:?}" "${S2_ARCHIVE:?}" "${OUT:?}"
V6_SHA256=7911e780f35ead33ed50a52e3786fb7e2653a69ab75fc462749416a9d059b62e
S2_SHA=2cbeb8363acd8ec611eb984e4c4c0c155c2fb24b; S1_SHA=9f5a01148ce016bc0056dbbcc85ac8a3e5fac23f; P1_SHA=8634360f74ed2f50b2fcb49925a3d273c605a8a2
S1_IMAGE=aegis-prod-drive:preview-d1-s1-9f5a01148ce0; S2_IMAGE=aegis-prod-drive:preview-d1-s2-2cbeb8363acd; P1_IMAGE=aegis-prod-drive:p1-8634360f74ed
S2_ARCHIVE_SHA256=8ef9aa88fce4e9fe5fd37eb21fb58367077827a601cf29c69d65cabb0de0e922
MIGRATION_SHA256=aac26537c1500737f2fada157696ca5522d34e3386099f3d580151c45cbcb239
PROJECT=aegis-d1rep; DRIVE=aegis-d1rep-drive-1; PG=aegis-d1rep-postgres-1; BASE=http://127.0.0.1:58811
D1=IDEA1-AEGIS_Drive_LC/deploy/production/d1

FAILS=0
ok() { printf 'PASS %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1" >&2; FAILS=$((FAILS + 1)); }
eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got '$2', want '$3')"; fi; }
log() { printf '\n========== %s ==========\n' "$*"; }
w() { cygpath -w "$1"; }

# ---------- 0. isolation preconditions ----------
log "0. isolation preconditions"
test -z "${DOCKER_HOST:-}" || { echo 'STOP: DOCKER_HOST is set — refusing (could target a remote daemon)' >&2; exit 1; }
CTX=$(docker context show); case "$CTX" in default|desktop-linux) ;; *) echo "STOP: docker context $CTX is not local" >&2; exit 1 ;; esac
echo "DOCKER_CONTEXT=$CTX DOCKER_SERVER=$(docker version --format '{{.Server.Version}}') COMPOSE=$(docker compose version --short)"
test "$(sha256sum "$V6" | cut -d' ' -f1 | tr -d '\\')" = "$V6_SHA256" || { echo 'STOP: V6 hash mismatch' >&2; exit 1; }
test "$(sha256sum "$S2_ARCHIVE" | cut -d' ' -f1 | tr -d '\\')" = "$S2_ARCHIVE_SHA256" || { echo 'STOP: S2 archive hash mismatch' >&2; exit 1; }
for pair in "$P1_ROOT:$P1_SHA" "$S1_ROOT:$S1_SHA" "$S2_ROOT:$S2_SHA"; do
  r=${pair%:*}; s=${pair##*:}; eq "WORKTREE_$(basename "$(dirname "$r")")" "$(git -C "$r" rev-parse HEAD)" "$s"
done
eq S1_IMAGE_ID "$(docker image inspect $S1_IMAGE --format '{{.Id}}')" sha256:8d5356fc4c7a02a7b1f9e067097b89dc11913743d299a99d0726997b796b88e0
eq S2_IMAGE_ID "$(docker image inspect $S2_IMAGE --format '{{.Id}}')" sha256:3a924636d1b09effcc7eee7f2115f14a735abb6e606eb334bf7dd4f55b9e36ff
for im in "$P1_IMAGE:$P1_SHA" "$S1_IMAGE:$S1_SHA" "$S2_IMAGE:$S2_SHA"; do
  i=${im%:*}; s=${im##*:}; eq "REVISION $i" "$(docker image inspect "$i" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}|{{.Config.User}}')" "$s|node"
done
[ "$FAILS" -eq 0 ] || { echo 'STOP: preconditions failed' >&2; exit 1; }

mkdir -p "$OUT"; R="$OUT/replica"
C0=(env -u DOCKER_HOST -u CONTAINER_HOST docker compose --project-name "$PROJECT")
if docker ps -a --format '{{.Names}}' | grep -q "^$PROJECT-"; then echo 'STOP: an aegis-d1rep replica already exists — remove it first' >&2; exit 1; fi
rm -rf "$R"; mkdir -p "$R/preview-p1" "$R/preview-d1" "$R/datalake"
export D1REP_DIR_W; D1REP_DIR_W=$(w "$R")
export D1REP_ENV_FILE; D1REP_ENV_FILE=$(w "$R/replica.env")
export D1REP_RT="$R/preview-d1"
rnd() { node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"; }
SUPER=d1rep_super
cat > "$R/replica.env" <<EOF
D1REP_PG_SUPERUSER=$SUPER
D1REP_PG_SUPERUSER_PASSWORD=$(rnd)
D1REP_APP_PASSWORD=$(rnd)
D1REP_SESSION_SECRET=$(rnd)
D1REP_DATALAKE=$(cygpath -m "$R/datalake")
EOF
APP_PW=$(grep '^D1REP_APP_PASSWORD=' "$R/replica.env" | cut -d= -f2)

# Chain files (Git LF bytes): base and P1 are replica stand-ins; Stage 1/2/3 overlays are the reviewed Git files.
cp "$HERE/replica-base.yml" "$R/docker-compose.replica.yml"
cp "$HERE/replica-p1-image.yml" "$R/preview-p1/drive-image-8634360f74ed.yml"
git -C "$REPO" show "HEAD:$D1/drive-image-9f5a01148ce0.yml" > "$R/preview-d1/drive-image-9f5a01148ce0.yml"
git -C "$REPO" show "HEAD:$D1/drive-preview-index-stage1-9f5a01148ce0.yml" > "$R/preview-d1/drive-preview-index-stage1-9f5a01148ce0.yml"
eq S1_IMAGE_OVERLAY_SHA256 "$(sha256sum "$R/preview-d1/drive-image-9f5a01148ce0.yml" | cut -d' ' -f1)" 49b0ad5fbe0f49a9cfe168ec28c12aeb3f6fe1ead6dd870105423f4b37b96f78
eq S1_FLAGS_OVERLAY_SHA256 "$(sha256sum "$R/preview-d1/drive-preview-index-stage1-9f5a01148ce0.yml" | cut -d' ' -f1)" 7c5f0df78c3f5cf46bb2edd83bb8b015ed63d9645ed8de22c69eb1d8d6216a59
CH_BASE=$(w "$R/docker-compose.replica.yml"); CH_P1=$(w "$R/preview-p1/drive-image-8634360f74ed.yml")
CH_S1I=$(w "$R/preview-d1/drive-image-9f5a01148ce0.yml"); CH_S1F=$(w "$R/preview-d1/drive-preview-index-stage1-9f5a01148ce0.yml")
C=("${C0[@]}" --project-directory "$D1REP_DIR_W" --env-file "$D1REP_ENV_FILE")
# On any early stop: capture logs, then remove this project's disposable resources (never anything else).
abort_cleanup() {
  docker logs "$DRIVE" > "$OUT/drive-on-abort.log" 2>&1 || true
  docker logs "$PG" > "$OUT/postgres-on-abort.log" 2>&1 || true
  "${C[@]}" -f "$CH_BASE" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$R/datalake" "$R/replica.env"
}
CLEANED=0
trap 'rc=$?; if [ $rc -ne 0 ] && [ "$CLEANED" = 0 ]; then echo "ABORTED rc=$rc — cleaning up replica"; abort_cleanup; fi' EXIT

# Phase-J authority (package bindings, re-targeted to replica paths)
export D1REP_S2_SHA=$S2_SHA D1REP_S2_IMAGE=$S2_IMAGE
export D1REP_S2_OVERLAY; D1REP_S2_OVERLAY=$(w "$R/preview-d1/drive-preview-index-stage2-2cbeb8363acd.yml")
export D1REP_S3_OVERLAY; D1REP_S3_OVERLAY=$(w "$R/preview-d1/drive-preview-index-stage3-2cbeb8363acd.yml")
export D1REP_S2_OVERLAY_SHA256=75f992bdb29994238f1d1e1985e4d40113baf346c99e7ba453da2273620b601e
export D1REP_S3_OVERLAY_SHA256=c7a4538f671e6632ae4f74e792e01f75fe343b8d34ac9fc69b1a9312b0e0eb60
export D1REP_IMAGE_ARCHIVE; D1REP_IMAGE_ARCHIVE=$(cygpath -m "$S2_ARCHIVE")
export D1REP_IMAGE_ARCHIVE_SHA256=$S2_ARCHIVE_SHA256
node "$HERE/v6-blocks.mjs" "$(w "$V6")" "$V6_SHA256" "$(w "$OUT")"

PSQL() { docker exec -i "$PG" psql -X -qAt -U "$SUPER" -d aegis_drive -v ON_ERROR_STOP=1 "$@"; }
mark() { PSQL -c "SELECT 'D1REP_MARK $1'" >/dev/null; echo "MARK $1"; }
wait_healthy() {
  for _ in $(seq 1 60); do
    st=$(docker inspect "$1" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || echo none)
    [ "$st" = healthy ] && return 0; [ "$st" = unhealthy ] && break; sleep 2
  done
  docker logs "$1" 2>&1 | tail -20; echo "STOP: $1 not healthy" >&2; return 1
}
driver() { local root=$1 phase=$2; shift 2; node "$(w "$HERE/bde-driver.mjs")" --root "$(w "$root")" --base "$BASE" --phase "$phase" --state "$(w "$OUT/driver-state.json")" "$@" | tee "$OUT/driver-$phase.json" | tail -1 || true
  grep -q "=PASS (" "$OUT/driver-$phase.json" && ok "DRIVER $phase" || bad "DRIVER $phase"; }
session() { local name=$1 expect=${2:-0}; set +e; bash "$OUT/session-$name.sh" > "$OUT/session-$name.log" 2>&1; local rc=$?; set -e
  tail -4 "$OUT/session-$name.log"; echo "SESSION_$name RC=$rc"; if [ "$expect" = 0 ]; then eq "V6_SESSION_$name" "$rc" 0; else [ "$rc" -ne 0 ] && ok "V6_SESSION_$name refused (rc=$rc)" || bad "V6_SESSION_$name did not refuse"; fi; }

counts() { PSQL <<'SQL'
SELECT 'heads=' || (SELECT count(*) FROM vault_preview_index_heads) || ' generations=' || (SELECT count(*) FROM vault_preview_index_generations)
  || ' blob_refs=' || (SELECT count(*) FROM vault_preview_index_blob_refs)
  || ' staged=' || (SELECT count(*) FROM vault_tree_blob_state WHERE lifecycle='INDEX_STAGED')
  || ' managed=' || (SELECT count(*) FROM vault_tree_blob_state WHERE lifecycle='INDEX_MANAGED')
  || ' non_v1=' || (SELECT count(*) FROM vault_tree_revisions WHERE manifest_schema_version != 1)
  || ' tree_v1_owners=' || (SELECT count(*) FROM vault_tree_state WHERE protocol_state='TREE_V1')
  || ' v2_blobs=' || (SELECT count(*) FROM vault_v2_blobs);
SQL
}
schema_facts() { PSQL <<'SQL'
SELECT 'd1_tables=' || (SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('vault_preview_index_heads','vault_preview_index_generations','vault_preview_index_blob_refs'))
  || ' tree_tables=' || (SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'vault_tree_%')
  || ' lifecycle_check_has_index=' || (SELECT bool_or(pg_get_constraintdef(oid) LIKE '%INDEX_STAGED%' AND pg_get_constraintdef(oid) LIKE '%INDEX_MANAGED%') FROM pg_constraint WHERE conrelid='vault_tree_blob_state'::regclass AND contype='c')
  || ' d1_triggers=' || (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgrelid::regclass::text LIKE 'vault_preview_index_%')
  || ' drive_app_d1_delete=' || (SELECT bool_or(has_table_privilege('drive_app', t, 'DELETE')) FROM unnest(ARRAY['vault_preview_index_heads','vault_preview_index_generations','vault_preview_index_blob_refs']) t);
SQL
}
index_snapshot() { PSQL <<'SQL'
SELECT 'blob ' || s.user_id || ' ' || s.blob_id || ' ' || s.lifecycle || ' ' || b.ciphertext_size || ' ' || b.storage_key FROM vault_tree_blob_state s JOIN vault_v2_blobs b ON b.user_id=s.user_id AND b.id=s.blob_id WHERE s.lifecycle IN ('INDEX_STAGED','INDEX_MANAGED') ORDER BY s.blob_id COLLATE "C";
SELECT 'head ' || user_id || ' ' || tree_id || ' g' || index_generation || ' ' || root_blob_id || ' ' || root_content_id_b64 FROM vault_preview_index_heads ORDER BY user_id;
SELECT 'gen ' || user_id || ' g' || index_generation || ' ' || root_blob_id || ' ' || coalesce(superseded_at::text,'-') FROM vault_preview_index_generations ORDER BY user_id, index_generation;
SELECT 'ref ' || user_id || ' g' || index_generation || ' ' || blob_id || ' ' || role FROM vault_preview_index_blob_refs ORDER BY user_id, index_generation, blob_id COLLATE "C", role;
SQL
}
originals_rows() { PSQL <<SQL
SELECT b.id || '|' || b.user_id || '|' || b.storage_key || '|' || b.content_id_b64 || '|' || b.ciphertext_size || '|' || b.chunk_count || '|' || b.wrapped_dek_b64 || '|' || b.meta_b64
FROM vault_v2_blobs b WHERE b.id IN ($1) ORDER BY b.id COLLATE "C";
SELECT c.blob_id || '#' || c.chunk_index || '|' || c.ciphertext_size || '|' || c.ciphertext_sha256 FROM vault_v2_blob_chunks c WHERE c.blob_id IN ($1) ORDER BY c.blob_id COLLATE "C", c.chunk_index;
SQL
}
disk_manifest() { (cd "$R/datalake" && find . -type f | LC_ALL=C sort | while read -r f; do command sha256sum "$f"; done); }
disk_subset() { # every line of $1 (earlier manifest) must still be present unchanged in $2
  local missing; missing=$(LC_ALL=C comm -23 <(LC_ALL=C sort "$1") <(LC_ALL=C sort "$2") | wc -l | tr -d ' '); echo "$missing"; }
drive_image() { docker inspect "$DRIVE" --format '{{.Config.Image}}'; }

# ---------- 1. setup (harness; before RUNTIME_BEGIN) ----------
log "1. setup: PostgreSQL 15 (statement logging), P1-era schema + seed + role model, migration 012"
"${C[@]}" -f "$CH_BASE" up -d postgres 2>&1 | tail -1
wait_healthy "$PG"
git -C "$P1_ROOT" show "$P1_SHA:IDEA1-AEGIS_Drive_LC/server/db/schema.sql" | PSQL -f - 2>&1 | grep -v NOTICE || true
git -C "$P1_ROOT" show "$P1_SHA:IDEA1-AEGIS_Drive_LC/server/db/seed.sql" | PSQL -f -
PSQL <<SQL
CREATE ROLE drive_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '$APP_PW';
REVOKE CONNECT ON DATABASE aegis_drive FROM PUBLIC;
GRANT CONNECT ON DATABASE aegis_drive TO drive_app;
GRANT USAGE ON SCHEMA public TO drive_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO drive_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO drive_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO drive_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO drive_app;
SQL
git -C "$S1_ROOT" show "$S1_SHA:IDEA1-AEGIS_Drive_LC/server/db/migrations/012_vault_preview_index_v1.sql" > "$R/012.sql"
eq MIGRATION_012_SHA256 "$(sha256sum "$R/012.sql" | cut -d' ' -f1)" "$MIGRATION_SHA256"
docker exec -i "$PG" psql -X -q -U "$SUPER" -d aegis_drive -v ON_ERROR_STOP=1 -f - < "$R/012.sql" && echo MIGRATION_012_APPLIED=YES
schema_facts | tee "$OUT/schema-after-012.txt"

# ---------- 2. Stage 1 ----------
mark RUNTIME_BEGIN
log "2. Stage 1: accepted image, chain base + P1 + Stage 1 image + Stage 1 flags"
printf '%s\n' "$CH_BASE" "$CH_P1" > "$R/preview-d1/pre-stage1-live-chain.txt"   # Case B rollback target (as the Stage 1 runbook)
while read -r f; do sha256sum "$f"; done < "$R/preview-d1/pre-stage1-live-chain.txt" > "$R/preview-d1/pre-stage1-live-chain.sha256"
sha256sum "$R/preview-d1/pre-stage1-live-chain.txt" > "$R/preview-d1/pre-stage1-chain-order.sha256"
"${C[@]}" -f "$CH_BASE" -f "$CH_P1" -f "$CH_S1I" -f "$CH_S1F" up -d --no-deps --no-build drive 2>&1 | tail -1
wait_healthy "$DRIVE"; eq STAGE1_IMAGE "$(drive_image)" "$S1_IMAGE"
driver "$S1_ROOT" seed
counts | tee "$OUT/counts-stage1.txt"

# ---------- 3. Stage 2 (V6 §S2.2–§S2.5) ----------
log "3. Stage 2 — install overlays from Git (package Step T), then V6 §S2.2–§S2.5"
for f in drive-preview-index-stage2-2cbeb8363acd.yml drive-preview-index-stage3-2cbeb8363acd.yml; do
  git -C "$REPO" show "HEAD:$D1/$f" > "$R/preview-d1/$f"
done
eq S2_OVERLAY_INSTALLED_SHA256 "$(sha256sum "$R/preview-d1/drive-preview-index-stage2-2cbeb8363acd.yml" | cut -d' ' -f1)" "$D1REP_S2_OVERLAY_SHA256"
eq S3_OVERLAY_INSTALLED_SHA256 "$(sha256sum "$R/preview-d1/drive-preview-index-stage3-2cbeb8363acd.yml" | cut -d' ' -f1)" "$D1REP_S3_OVERLAY_SHA256"
session s2
driver "$S2_ROOT" stage2
counts | tee "$OUT/counts-stage2.txt"

# ---------- 4. Stage 3 (V6 §S3.1–§S3.6) + D-1 state ----------
log "4. Stage 3 — V6 §S3.1–§S3.6, then create D-1 state through the writer path"
session s3
driver "$S2_ROOT" stage3 --writer-root "$(w "$S2_ROOT")"
mark INDEX_FROZEN
counts | tee "$OUT/counts-stage3.txt"
index_snapshot > "$OUT/index-snapshot-stage3.txt"; SNAP=$(sha256sum < "$OUT/index-snapshot-stage3.txt" | cut -d' ' -f1)
echo "INDEX_SNAPSHOT_SHA256=$SNAP ($(wc -l < "$OUT/index-snapshot-stage3.txt") rows)"
grep -q '^head ' "$OUT/index-snapshot-stage3.txt" && grep -q INDEX_MANAGED "$OUT/index-snapshot-stage3.txt" && ok D1_STATE_PRESENT || bad D1_STATE_PRESENT
ORIG_IDS=$(PSQL -c "SELECT string_agg(quote_literal(b.id), ',' ORDER BY b.id) FROM vault_v2_blobs b LEFT JOIN vault_tree_blob_state s ON s.user_id=b.user_id AND s.blob_id=b.id AND s.blob_format_version=2 WHERE s.lifecycle IS NULL OR s.lifecycle NOT IN ('INDEX_STAGED','INDEX_MANAGED')")
originals_rows "$ORIG_IDS" > "$OUT/originals-stage3.txt"; ORIG=$(sha256sum < "$OUT/originals-stage3.txt" | cut -d' ' -f1)
disk_manifest > "$OUT/disk-stage3.txt"
echo "ORIGINAL_ROWS=$(grep -c '|' "$OUT/originals-stage3.txt") ORIGINALS_SHA256=$ORIG DISK_FILES=$(wc -l < "$OUT/disk-stage3.txt")"
after_case() { # $1 label — D-1 rows/blobs unchanged, original rows + every earlier on-disk byte unchanged, schema intact
  counts | tee "$OUT/counts-$1.txt"
  grep -q ' non_v1=0 ' "$OUT/counts-$1.txt" && ok "$1 NON_V1_MAIN_REVISIONS=0" || bad "$1 NON_V1_MAIN_REVISIONS"
  index_snapshot > "$OUT/index-snapshot-$1.txt"; eq "$1 INDEX_SNAPSHOT_UNCHANGED" "$(sha256sum < "$OUT/index-snapshot-$1.txt" | cut -d' ' -f1)" "$SNAP"
  originals_rows "$ORIG_IDS" > "$OUT/originals-$1.txt"; eq "$1 ORIGINAL_ROWS_UNCHANGED" "$(sha256sum < "$OUT/originals-$1.txt" | cut -d' ' -f1)" "$ORIG"
  disk_manifest > "$OUT/disk-$1.txt"; eq "$1 EARLIER_DISK_BYTES_UNCHANGED (missing/changed files)" "$(disk_subset "$OUT/disk-stage3.txt" "$OUT/disk-$1.txt")" 0
  schema_facts > "$OUT/schema-$1.txt"; eq "$1 SCHEMA" "$(cat "$OUT/schema-$1.txt")" "$(cat "$OUT/schema-after-012.txt")"
}

# ---------- 5. Case E (V6 §S3.7) ----------
log "5. CASE E — V6 §S3.7 Stage 3 → Stage 2"
eq CASE_E_PRE_IMAGE "$(drive_image)" "$S2_IMAGE"
session case-e
grep -q 'CASE_E_BUDGET_UNSET_VERIFIED=YES' "$OUT/session-case-e.log" && ok CASE_E_BUDGET_UNSET_VERIFIED || bad CASE_E_BUDGET_UNSET_VERIFIED
eq CASE_E_POST_IMAGE "$(drive_image)" "$S2_IMAGE"
eq CASE_E_WRITE_ENV "$(docker exec "$DRIVE" env | grep '^VAULT_PREVIEW_INDEX_WRITE_ENABLED=')" VAULT_PREVIEW_INDEX_WRITE_ENABLED=false
driver "$S2_ROOT" case-e
after_case case-e
CASE_E_FAILS=$FAILS

# ---------- 6. Case C negative control (V6 §S2.7 must refuse) ----------
log "6. CASE C (negative control) — V6 §S2.7 with D-1 rows present must FAIL CLOSED without mutation"
PRE_C=$(docker inspect "$DRIVE" --format '{{.Config.Image}}|{{.State.StartedAt}}')
session case-c refuse
grep -q 'Case C rollback is INVALID' "$OUT/session-case-c.log" && ok CASE_C_REFUSED_D1_ROWS_EXIST || bad CASE_C_REFUSED_D1_ROWS_EXIST
eq CASE_C_NO_MUTATION "$(docker inspect "$DRIVE" --format '{{.Config.Image}}|{{.State.StartedAt}}')" "$PRE_C"

# ---------- 7. Case D (V6 §S2.8) ----------
log "7. CASE D — V6 §S2.8 writer-capable build → Stage 1 read-only build with D-1 rows"
F0=$FAILS
session case-d
eq CASE_D_POST_IMAGE "$(drive_image)" "$S1_IMAGE"
driver "$S1_ROOT" case-d
after_case case-d
CASE_D_FAILS=$((FAILS - F0))

# ---------- 8. Case B (plan I.2 B) ----------
log "8. CASE B — new reader/server → baseline P1 after index creation (authenticated pre-stage1 chain)"
F0=$FAILS
sha256sum -c "$R/preview-d1/pre-stage1-chain-order.sha256" && sha256sum -c "$R/preview-d1/pre-stage1-live-chain.sha256" && ok CASE_B_CHAIN_AUTHENTICATED || bad CASE_B_CHAIN_AUTHENTICATED
B_ARGS=(); while read -r f; do B_ARGS+=(-f "$f"); done < "$R/preview-d1/pre-stage1-live-chain.txt"
eq CASE_B_CHAIN_ARGS "${#B_ARGS[@]}" 4
"${C[@]}" "${B_ARGS[@]}" up -d --no-deps --no-build drive 2>&1 | tail -1
wait_healthy "$DRIVE"
eq CASE_B_POST_IMAGE "$(drive_image)" "$P1_IMAGE"
eq CASE_B_REVISION "$(docker image inspect "$(drive_image)" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" "$P1_SHA"
eq CASE_B_RESTARTS_OOM "$(docker inspect "$DRIVE" --format '{{.RestartCount}}|{{.State.OOMKilled}}')" "0|false"
eq CASE_B_HEALTHZ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/healthz")" 200
driver "$P1_ROOT" case-b
after_case case-b
CASE_B_FAILS=$((FAILS - F0))
mark RUNTIME_END

# ---------- 9. SQL audit + summary ----------
log "9. destructive-SQL audit (RUNTIME_BEGIN..RUNTIME_END), chain evidence, summary"
docker logs "$PG" > "$OUT/postgres-statements.log" 2>&1
node "$(w "$HERE/sql-audit.mjs")" "$(w "$OUT/postgres-statements.log")" "$SUPER" | tee "$OUT/sql-audit.txt" || true
grep -q 'SQL_CAPTURE_VERIFY=PASS' "$OUT/sql-audit.txt" && ok SQL_CAPTURE_VERIFY || bad SQL_CAPTURE_VERIFY
for s in stage2 stage3; do
  echo "pre-$s chain:"; cat "$R/preview-d1/pre-$s-live-chain.txt"; cat "$R/preview-d1/pre-$s-chain-order.sha256"
  eq "PRE_${s^^}_CHAIN_ORDER_RECOMPUTED" "$(sha256sum "$R/preview-d1/pre-$s-live-chain.txt" | cut -d' ' -f1)" "$(cut -d' ' -f1 "$R/preview-d1/pre-$s-chain-order.sha256" | tr -d '\\')"
done | tee "$OUT/chains.txt"
cp "$R/preview-d1/"pre-*.txt "$R/preview-d1/"pre-*.sha256 "$OUT/" 2>/dev/null || true

echo
echo "CASE_E=$([ "$CASE_E_FAILS" -eq 0 ] && echo PASS || echo FAIL)"
echo "CASE_D=$([ "$CASE_D_FAILS" -eq 0 ] && echo PASS || echo FAIL)"
echo "CASE_B=$([ "$CASE_B_FAILS" -eq 0 ] && echo PASS || echo FAIL)"
echo "REHEARSAL_FAILS=$FAILS"

# ---------- 10. cleanup (only this project's disposable resources) ----------
log "10. cleanup"
CLEANED=1
"${C[@]}" -f "$CH_BASE" down -v --remove-orphans 2>&1 | tail -2
rm -rf "$R/datalake" "$R/replica.env"
echo "REMAINING_REPLICA_RESOURCES=$( (docker ps -a --format '{{.Names}}'; docker volume ls -q; docker network ls --format '{{.Name}}') | grep -c "^$PROJECT" || true)"
[ "$FAILS" -eq 0 ] && echo REPLICA_ROLLBACK_REHEARSAL=COMPLETE || { echo REPLICA_ROLLBACK_REHEARSAL=PENDING; exit 1; }
