# shellcheck shell=bash
# shellcheck disable=SC2034  # constants are consumed by the scripts that source this file
# shellcheck disable=SC2046  # `docker network ls -q` is split into arguments on purpose
# AEGIS IDEA3 PR11 Phase 2 — shared constants and helpers for the owner-run
# scripts in this directory. Sourced, never executed. Values come from the
# merged decision records (PR #139, PR #140) and owner-run evidence S2A/K7-E3.

# AEGIS_P2_ROOT is a TEST-ONLY override. The local dry-run harness sets it so the
# scripts can be exercised against fixtures; Production leaves it unset, which
# keeps every path at its real /opt/aegis location. A real run never sets it, and
# p2a-execute.sh and p2a-rollback.sh refuse anything but DRY_RUN=1 while it is set.
readonly P2_ROOT="${AEGIS_P2_ROOT:-/opt/aegis}"
readonly RT="$P2_ROOT/runtime"
readonly BASE="$RT/docker-compose.production.yml"
readonly OVL="$RT/idea3/idea3-phase2.yml"
readonly ENVF="${AEGIS_P2_ENV_FILE:-$P2_ROOT/Project-End-The-AEGIS/.env}"
readonly NGINX_LIVE="$RT/nginx/nginx.production.conf"
readonly CERTS="$RT/certs"
readonly SECRET_DIR="$RT/idea3/secrets"
readonly PROJECT=aegis-prod

readonly HUB=aegis-prod-hub-1
readonly WEB=aegis-prod-idea3-web-1
readonly CONNECTOR=aegis-prod-public-share-connector-1
readonly IDEA3_NET=aegis_idea3_internal
readonly IDEA3_SUBNET=172.31.243.0/29
readonly IDEA3_GW=172.31.243.1
readonly HUB_IDEA3_IP=172.31.243.2
readonly WEB_IP=172.31.243.3
readonly WEB_IMAGE=aegis-idea3-web:pr11-phase2-dbc9ad92cd3e

readonly EXPECT_BASE_SHA=61528b8636b560021d15fb9dd98316533447adfc348210b4da4cf5b7ea021869
readonly EXPECT_OVL_SHA=2feaad012d55d1bf2cccde403c487f4348bd3a47b561f8d5fd5aa706df28d591
readonly EXPECT_LIVE_NGINX_SHA=16cee16232f5636eb11dd434d43ba42c6314d75a2b306265ee62032b84fb3722
readonly EXPECT_RUNNING_HUB_HASH=ed4f24db58201ad219fc4fe7d9fc11e4a3814c9d57ceb66ea8057355e52e79cd
readonly EXPECT_BASE_HUB_HASH=2656d5a8bd86494f579264017c7023ffce744d6427e8cf8eab26cf4921b89f25
readonly EXPECT_P2A_HUB_HASH=b545835c17aa8840bebacbfa1d7c5caf9b1cad600e7e511ae3ebfd8d0fdf8ae9
readonly EXPECT_HUB_IMAGE_ID=sha256:8c365f8c8ae82b61d9e9048cb05afccb2e580b03b73a849edc8d830f99d560fc
readonly EXPECT_WEB_CONTEXT_SHA=1710d0ee23f894a057049e0d2979988e6fb7a5be364e3a1f23846baca484dc04

# Service-scoped containers that Phase 2 must never recreate, restart, or stop.
readonly PRESERVED="aegis-prod-drive-1 aegis-prod-monitor-1 aegis-prod-postgres-1 aegis-prod-public-share-gateway-1 aegis-prod-public-share-connector-1 twingate-aegis-connector-02"

# The accepted K7 HUB model (two files, in order). Never add the Monitor or
# Public Share overlays here; never run this without an explicit service name.
DC_P2A=(docker compose -p "$PROJECT" --project-directory "$RT" --env-file "$ENVF" -f "$BASE" -f "$OVL")
DC_BASE=(docker compose -p "$PROJECT" --project-directory "$RT" --env-file "$ENVF" -f "$BASE")

# DRY_RUN=1 prints mutating commands instead of running them.
DRY_RUN="${DRY_RUN:-0}"

log()  { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
die()  { log "STOP: $*"; exit 1; }
mut()  { if [ "$DRY_RUN" = 1 ]; then log "DRY-RUN would run: $*"; else log "RUN: $*"; "$@"; fi; }
sha()  { sha256sum "$1" | cut -d' ' -f1; }
need_root() { [ "$(id -u)" = 0 ] || die "run with sudo"; }

label() { docker inspect "$1" --format "{{index .Config.Labels \"$2\"}}"; }

# name ip pairs for one container, sorted
nets_of() {
  docker inspect "$1" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}={{$v.IPAddress}}{{println}}{{end}}' | sed '/^$/d' | sort
}

# Identity line used for preservation comparison (no environment values).
ident() {
  docker inspect "$1" --format '{{.Name}} id={{.Id}} image={{.Image}} created={{.Created}} started={{.State.StartedAt}} status={{.State.Status}} restarts={{.RestartCount}} hash={{index .Config.Labels "com.docker.compose.config-hash"}}'
}

wait_healthy() { # container timeout_seconds
  local c=$1 t=$2 s
  for _ in $(seq 1 "$t"); do
    s=$(docker inspect "$c" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || echo absent)
    [ "$s" = healthy ] && return 0
    sleep 1
  done
  log "health of $c after ${t}s: $s"; return 1
}

k4_clear() { # 0 when 172.31.243.0/29 is free and the IDEA3 network is absent
  ! ip -4 route show table all | grep -q '172\.31\.243\.' \
    && ! ip -4 addr show | grep -q '172\.31\.243\.' \
    && ! docker network inspect $(docker network ls -q) --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}' | grep -q '172\.31\.243\.' \
    && ! docker network inspect "$IDEA3_NET" >/dev/null 2>&1
}
