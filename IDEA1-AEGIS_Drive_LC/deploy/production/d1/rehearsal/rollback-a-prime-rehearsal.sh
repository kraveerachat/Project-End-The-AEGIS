#!/usr/bin/env bash
# D-1 Stage 1 rollback A-prime rehearsal — LOCAL / DISPOSABLE ONLY. No Production host, credential, or volume.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
S=${REHEARSAL_OUT:-$(mktemp -d)}   # state/migration copy/logs; never inside the repository
echo "REHEARSAL_OUT=$S"
P1_ROOT=${P1_ROOT:?set P1_ROOT to the IDEA1-AEGIS_Drive_LC dir of a clean detached worktree at 8634360f (node_modules installed)}
S1_ROOT=${S1_ROOT:?set S1_ROOT to the IDEA1-AEGIS_Drive_LC dir of a clean detached worktree at 4a8cc3c9 (node_modules installed)}
P1_IMAGE=${P1_IMAGE:-aegis-local-rehearsal-drive:p1-8634360f74ed}   # built from exact revision 8634360f (runbook §16.1)
S1_IMAGE=${S1_IMAGE:-aegis-local-rehearsal-drive:preview-d1-s1-4a8cc3c95e2f}
NET=aegis-d1rb-net; PG=aegis-d1rb-pg; DRIVE=aegis-d1rb-drive; VOL=aegis-d1rb-datalake; MVOL=aegis-d1rb-media
PORT=58801; BASE=http://127.0.0.1:$PORT
STATE=$S/rb-state.json; rm -f "$STATE"
SUPER_PW=$(node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))")
APP_PW=$(node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))")
SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
D=(docker)
log() { printf '\n===== %s =====\n' "$*"; }

cleanup() { docker rm -fv "$DRIVE" "$PG" >/dev/null 2>&1 || true; docker volume rm "$VOL" "$MVOL" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; }
cleanup
docker network create "$NET" >/dev/null
docker volume create "$VOL" >/dev/null; docker volume create "$MVOL" >/dev/null

log "1. disposable PostgreSQL 15 with P1-era schema + seed + production role/grant model"
docker run -d --name "$PG" --network "$NET" -e POSTGRES_USER=d1rb_super -e POSTGRES_PASSWORD="$SUPER_PW" -e POSTGRES_DB=aegis_drive postgres:15-alpine >/dev/null
until docker exec -e PGPASSWORD="$SUPER_PW" "$PG" psql -h 127.0.0.1 -U d1rb_super -d aegis_drive -tAc 'SELECT 1' >/dev/null 2>&1; do sleep 1; done
su_psql() { docker exec -i "$PG" psql -X -q -U d1rb_super -d aegis_drive -v ON_ERROR_STOP=1 "$@"; }
git -C "$P1_ROOT" show 8634360f74ed2f50b2fcb49925a3d273c605a8a2:IDEA1-AEGIS_Drive_LC/server/db/schema.sql | su_psql -f - 2>&1 | grep -v NOTICE || true
git -C "$P1_ROOT" show 8634360f74ed2f50b2fcb49925a3d273c605a8a2:IDEA1-AEGIS_Drive_LC/server/db/seed.sql | su_psql -f -
# mirrors postgres/init/02-app-roles.sh (incl. ALTER DEFAULT PRIVILEGES set by the same superuser that later runs 012)
su_psql <<SQL
CREATE ROLE drive_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '$APP_PW';
REVOKE CONNECT ON DATABASE aegis_drive FROM PUBLIC;
GRANT CONNECT ON DATABASE aegis_drive TO drive_app;
GRANT USAGE ON SCHEMA public TO drive_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO drive_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO drive_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO drive_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO drive_app;
SQL
echo PG_READY

TREE_ENV=(-e VAULT_TREE_SCHEMA_AVAILABLE=true -e VAULT_TREE_PROTOCOL_ENABLED=true -e VAULT_TREE_GENESIS_MIGRATION_ENABLED=true -e VAULT_TREE_UI_ENABLED=true -e VAULT_MEDIA_PREVIEW_ENABLED=true -e VAULT_DESTRUCTIVE_PURGE_ENABLED=false)
S1_ENV=(-e VAULT_PREVIEW_INDEX_SCHEMA_AVAILABLE=true -e VAULT_PREVIEW_INDEX_READ_ENABLED=true -e VAULT_PREVIEW_INDEX_WRITE_ENABLED=false)
boot() { # $1 image, rest extra env
  local img=$1; shift
  docker rm -fv "$DRIVE" >/dev/null 2>&1 || true
  docker run -d --name "$DRIVE" --network "$NET" -p "127.0.0.1:$PORT:8001" \
    -e DATABASE_URL="postgresql://drive_app:$APP_PW@$PG:5432/aegis_drive" -e SESSION_SECRET="$SESSION_SECRET" -e COOKIE_SECURE=false -e TRUSTED_PROXY_CIDRS=172.19.255.2/32 \
    -v "$VOL:/datalake" -v "$MVOL:/var/cache/aegis-media" "${TREE_ENV[@]}" "$@" "$img" >/dev/null
  for i in $(seq 1 60); do
    st=$(docker inspect "$DRIVE" --format '{{.State.Status}}'); [[ "$st" != running ]] && { docker logs "$DRIVE" 2>&1 | tail -20; echo "STOP: $img exited" >&2; return 1; }
    curl -fsS "$BASE/healthz" >/dev/null 2>&1 && break; sleep 1
  done
  echo "IMAGE=$(docker inspect "$DRIVE" --format '{{.Config.Image}}') REV=$(docker image inspect "$img" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}') RESTARTS=$(docker inspect "$DRIVE" --format '{{.RestartCount}}') OOM=$(docker inspect "$DRIVE" --format '{{.State.OOMKilled}}')"
  echo "HEALTHZ=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/healthz") $(curl -s "$BASE/healthz" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(JSON.stringify({ok:j.ok,db:j.db,layers:Object.fromEntries(Object.entries(j.layers).map(([k,v])=>[k,v.ok])),vaultTree:j.vaultTree}))})')"
  docker logs "$DRIVE" 2>&1 | grep -E '\[aegis-drive\] vault (tree|preview index):' || true
}
stop_drive() { docker stop "$DRIVE" >/dev/null; docker rm -v "$DRIVE" >/dev/null; echo "DRIVE_STOPPED (PostgreSQL and volumes kept)"; }
drive() { node "$HERE/rollback-a-prime-driver.mjs" --root "$1" --base "$BASE" --phase "$2" --state "$STATE"; }
PSQL_RO() { docker exec -i "$PG" psql -X -qAt -U d1rb_super -d aegis_drive -v ON_ERROR_STOP=1; }
dbq() { PSQL_RO <<'SQL'
SELECT 'D1_TABLE_COUNT=' || count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('vault_preview_index_heads','vault_preview_index_generations','vault_preview_index_blob_refs');
SELECT 'TREE_TABLE_COUNT=' || count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('vault_tree_state','vault_tree_frozen_inventory','vault_tree_key_envelope','vault_tree_heads','vault_tree_revisions','vault_tree_blob_state','vault_tree_purge_candidates');
SELECT 'INDEX_LIFECYCLE_ROWS=' || count(*) FROM vault_tree_blob_state WHERE lifecycle IN ('INDEX_STAGED','INDEX_MANAGED');
SELECT 'LIFECYCLE_ROWS ' || lifecycle || '=' || count(*) FROM vault_tree_blob_state GROUP BY lifecycle ORDER BY lifecycle;
SELECT 'TREE_V1_OWNERS=' || count(*) FROM vault_tree_state WHERE protocol_state='TREE_V1';
SELECT 'USERS=' || count(*) FROM users;
SELECT 'VAULT_V2_BLOBS=' || count(*) FROM vault_v2_blobs;
SELECT 'TREE_HEADS=' || string_agg(user_id || ':g' || generation, ',' ORDER BY user_id) FROM vault_tree_heads;
SQL
  if [[ "$(PSQL_RO <<<"SELECT count(*) FROM information_schema.tables WHERE table_name='vault_preview_index_heads'")" = 1 ]]; then
    PSQL_RO <<'SQL'
SELECT 'D1_HEAD_ROWS=' || count(*) FROM vault_preview_index_heads;
SELECT 'D1_GENERATION_ROWS=' || count(*) FROM vault_preview_index_generations;
SELECT 'D1_BLOB_REF_ROWS=' || count(*) FROM vault_preview_index_blob_refs;
SQL
  fi
}

log "2. P1 boot on pre-migration DB + seed representative TREE_V1 data (ADMIN, EXISTING_USER)"
boot "$P1_IMAGE"
drive "$P1_ROOT" seed
stop_drive
dbq
SEED_FP_SQL="COPY (SELECT id||'|'||user_id||'|'||storage_key||'|'||content_id_b64||'|'||ciphertext_size||'|'||chunk_count||'|'||wrapped_dek_b64||'|'||meta_b64 FROM vault_v2_blobs ORDER BY id COLLATE \"C\") TO STDOUT;"
PRE_SEED_PROTECTED=$(PSQL_RO <<<"$SEED_FP_SQL" | sha256sum | cut -d" " -f1)
SEED_IDS=$(PSQL_RO <<<"SELECT string_agg(quote_literal(id), ',') FROM vault_v2_blobs")
echo "PRE_MIGRATION_V2_BLOB_FINGERPRINT=$PRE_SEED_PROTECTED"

log "3. apply migration 012 exactly as the runbook (superuser, ON_ERROR_STOP, lock/statement timeouts; verbatim Git blob)"
git -C "$S1_ROOT" show 4a8cc3c95e2f4147fbab9c505079c0377a271d99:IDEA1-AEGIS_Drive_LC/server/db/migrations/012_vault_preview_index_v1.sql > "$S/rb-012.sql"
echo "MIGRATION_SHA256=$(sha256sum "$S/rb-012.sql" | cut -d' ' -f1)"
if docker exec -i -e PGOPTIONS='-c lock_timeout=10s -c statement_timeout=300s' "$PG" \
     sh -lc 'psql -X -U "$POSTGRES_USER" -d aegis_drive -v ON_ERROR_STOP=1 -f -' < "$S/rb-012.sql"; then echo 'MIGRATION_012_APPLIED=YES'; else echo 'STOP: migration failed' >&2; exit 1; fi
PSQL_RO <<'SQL'
SELECT 'DRIVE_APP_D1_GRANTS=' || string_agg(table_name || ':' || privilege_type, ',' ORDER BY table_name, privilege_type) FROM information_schema.role_table_grants WHERE grantee='drive_app' AND table_name LIKE 'vault_preview_index_%';
SELECT 'LIFECYCLE_CHECK=' || pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='vault_tree_blob_state'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%lifecycle%';
SQL
dbq

log "4. Stage 1 candidate boot on migrated DB + Stage 1 state (all three account classes)"
boot "$S1_IMAGE" "${S1_ENV[@]}"
drive "$S1_ROOT" stage1
log "5. stop Stage 1 application only"
stop_drive
dbq

log "6-12. ROLLBACK A-PRIME: P1 boot on the SAME migrated DB (no down-migration) + every P1 flow"
boot "$P1_IMAGE"
drive "$P1_ROOT" p1
dbq
POST_RB_PROTECTED_SEED=$(PSQL_RO <<<"${SEED_FP_SQL/FROM vault_v2_blobs/FROM vault_v2_blobs WHERE id IN ($SEED_IDS)}" | sha256sum | cut -d" " -f1)
echo "SEED_V2_BLOB_FINGERPRINT pre-migration=$PRE_SEED_PROTECTED after-rollback-flows=$POST_RB_PROTECTED_SEED"
test "$PRE_SEED_PROTECTED" = "$POST_RB_PROTECTED_SEED" && echo SEED_BLOB_ROWS_INTACT=YES || { echo "STOP: seed blob rows changed" >&2; exit 1; }
log "13. stop P1"
stop_drive

log "14-15. FORWARD: Stage 1 boot again on the SAME DB"
boot "$S1_IMAGE" "${S1_ENV[@]}"
drive "$S1_ROOT" forward
dbq
stop_drive
log "rehearsal complete — cleaning up disposable resources"
cleanup
echo REHEARSAL_RESOURCES_REMOVED
