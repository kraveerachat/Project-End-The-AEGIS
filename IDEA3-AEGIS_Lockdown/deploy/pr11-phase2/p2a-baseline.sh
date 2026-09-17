#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 2A — READ-ONLY pre-mutation baseline (owner-run on
# aegis-system). Changes nothing on Production. Writes evidence only under
# $EVID_DIR (default ~/idea3-p2a-evidence/<UTC timestamp>) in the operator's home.
#
#   sudo EVID_DIR=~/idea3-p2a-evidence/pre bash p2a-baseline.sh
#
# Prints hashes, labels, states, and addresses only; never an environment value
# or a secret. Exit 0 = every Phase 2A precondition that can be checked
# read-only holds. Any failure prints STOP and exits non-zero.
# shellcheck disable=SC2034  # values are referenced inside the quoted check expressions
# shellcheck disable=SC2046  # `docker network ls -q` is split into arguments on purpose
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=p2-lib.sh
. "$HERE/p2-lib.sh"
need_root

EVID_DIR="${EVID_DIR:-$HOME/idea3-p2a-evidence/$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$EVID_DIR"
exec > >(tee "$EVID_DIR/baseline.log") 2>&1
fail=0
check() { if eval "$2"; then log "PASS $1"; else log "FAIL $1"; fail=1; fi; }

log "baseline evidence dir: $EVID_DIR"
docker compose version --short > "$EVID_DIR/compose-version.txt"

# 1. Identity of every container (preservation reference)
docker ps -a --format '{{.Names}}' | sort | while read -r c; do ident "$c"; done > "$EVID_DIR/containers.txt"
for c in $PRESERVED $HUB; do
  { echo "== $c"; nets_of "$c"; label "$c" com.docker.compose.project.config_files; } >> "$EVID_DIR/container-networks.txt"
done
cat "$EVID_DIR/containers.txt"

# 2. Networks (K4)
docker network inspect $(docker network ls -q) \
  --format '{{.Name}} {{.Driver}} {{range .IPAM.Config}}{{.Subnet}} gw={{.Gateway}} {{end}}internal={{.Internal}}' \
  | sort > "$EVID_DIR/networks.txt"
check "K4 172.31.243.0/29 free and ${IDEA3_NET} absent" k4_clear
holders=$(docker network inspect aegis_internal --format '{{range .Containers}}{{.Name}}={{.IPv4Address}} {{end}}' | tr ' ' '\n' | grep -c '=172\.18\.0\.4/' || true)
hub_holds=$(docker network inspect aegis_internal --format '{{range .Containers}}{{.Name}}={{.IPv4Address}} {{end}}' | tr ' ' '\n' | grep -c "^${HUB}=172\.18\.0\.4/" || true)
check "172.18.0.4 held only by the HUB on aegis_internal" '[ "$holders" = 1 ] && [ "$hub_holds" = 1 ]'

# 3. File hashes (K1, K7, Public Share, Monitor)
sha256sum "$BASE" "$NGINX_LIVE" "$RT"/public-share/*.yml \
  "$RT"/monitor-single-camera-ui-20260906-204814/compose.active.yml 2>&1 | tee "$EVID_DIR/file-hashes.txt"
check "base Compose = ${EXPECT_BASE_SHA:0:8}" '[ "$(sha "$BASE")" = "$EXPECT_BASE_SHA" ]'
check "live NGINX host artifact = ${EXPECT_LIVE_NGINX_SHA:0:8}" '[ "$(sha "$NGINX_LIVE")" = "$EXPECT_LIVE_NGINX_SHA" ]'
check "running HUB default.conf = ${EXPECT_LIVE_NGINX_SHA:0:8}" \
  '[ "$(docker exec "$HUB" sha256sum /etc/nginx/conf.d/default.conf | cut -d" " -f1)" = "$EXPECT_LIVE_NGINX_SHA" ]'

# 4. K7 accepted model still holds
check "running HUB config-hash = ${EXPECT_RUNNING_HUB_HASH:0:8}" '[ "$(label "$HUB" com.docker.compose.config-hash)" = "$EXPECT_RUNNING_HUB_HASH" ]'
check "base renders hub = ${EXPECT_BASE_HUB_HASH:0:8}" '[ "$("${DC_BASE[@]}" config --hash hub | awk "{print \$2}")" = "$EXPECT_BASE_HUB_HASH" ]'
check "HUB image = ${EXPECT_HUB_IMAGE_ID:7:8}" '[ "$(docker inspect "$HUB" --format "{{.Image}}")" = "$EXPECT_HUB_IMAGE_ID" ]'
check "HUB networks = aegis_drive_proxy .2 + aegis_internal .4" \
  '[ "$(nets_of "$HUB" | tr "\n" " ")" = "aegis_drive_proxy=172.19.255.2 aegis_internal=172.18.0.4 " ]'

# 5. Service and timer state (Public Share)
systemctl is-active aegis-public-share-connector.service aegis-public-share-drift.timer | tee "$EVID_DIR/units.txt"
systemctl show aegis-public-share-drift.service -p Result -p ExecMainStatus -p ExecMainExitTimestamp | tee -a "$EVID_DIR/units.txt"
check "connector service and drift timer active" '[ "$(systemctl is-active aegis-public-share-connector.service aegis-public-share-drift.timer | sort -u)" = active ]'
check "last drift run succeeded" '[ "$(systemctl show aegis-public-share-drift.service -p Result --value)" = success ]'
# IDEA1-owned firewall check; its validate mode performs no mutation.
check "S5.5 firewall validate = VALID" 'bash "$RT/public-share/s5-5-firewall.sh" validate > "$EVID_DIR/firewall-validate.txt" 2>&1'

# 6. Health of every preserved container
for c in $PRESERVED $HUB; do
  printf '%s %s\n' "$c" "$(docker inspect "$c" --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}')"
done | tee "$EVID_DIR/health.txt"
check "preserved containers running" '! grep -qv " running " "$EVID_DIR/health.txt"'
check "no preserved container unhealthy" '! grep -q " unhealthy$" "$EVID_DIR/health.txt"'

# 7. Phase 2A inputs that must exist before authorization is used
check "IDEA3 runtime directory absent (fresh placement)" '[ ! -e "$OVL" ]'
check "IDEA3 Web image not yet present" '! docker image inspect "$WEB_IMAGE" >/dev/null 2>&1'
df -h /var/lib/docker "$RT" | tee "$EVID_DIR/disk.txt"

sha256sum "$EVID_DIR"/*.txt > "$EVID_DIR/SHA256SUMS"
if [ "$fail" = 0 ]; then log "BASELINE=PASS"; else log "BASELINE=FAIL (see FAIL lines)"; fi
exit "$fail"
