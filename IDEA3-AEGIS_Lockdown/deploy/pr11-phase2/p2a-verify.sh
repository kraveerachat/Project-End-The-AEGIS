#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 2A — READ-ONLY post-change verification and
# preservation comparison against the p2a-baseline.sh evidence.
#
#   sudo BASELINE_DIR=<dir> bash p2a-verify.sh              after p2a-execute.sh
#   sudo BASELINE_DIR=<dir> MODE=rollback bash p2a-verify.sh after p2a-rollback.sh
#
# Server-side checks only. The browser-route checks with certificate
# validation run from a trusted workstation (see README, "HTTP checks").
# Any FAIL after execution is a rollback trigger.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=p2-lib.sh
. "$HERE/p2-lib.sh"
need_root
: "${BASELINE_DIR:?BASELINE_DIR is required}"
MODE="${MODE:-phase2a}"
OUT="$BASELINE_DIR/../verify-$MODE-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT"
exec > >(tee "$OUT/verify.log") 2>&1
fail=0
check() { if eval "$2"; then log "PASS $1"; else log "FAIL $1"; fail=1; fi; }

# 1. Preserved containers: identical id, image, created, started, restarts, hash
for c in $PRESERVED; do
  before=$(grep "^/$c " "$BASELINE_DIR/containers.txt" || true)
  after=$(ident "$c")
  check "$c unchanged" '[ -n "$before" ] && [ "$before" = "$after" ]'
  [ "$before" = "$after" ] || { echo "  before: $before"; echo "  after:  $after"; }
done
for c in $PRESERVED; do
  s=$(docker inspect "$c" --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}')
  check "$c running and not unhealthy ($s)" '[[ "$s" == running* ]] && [[ "$s" != *unhealthy ]]'
done
for c in $PRESERVED; do
  check "$c networks unchanged" \
    '[ "$(nets_of "$c")" = "$(awk -v c="== $c" "\$0==c{f=1;next} /^== /{f=0} f && /=/" "$BASELINE_DIR/container-networks.txt")" ]'
done

# 2. Files that must never change in Phase 2A
for f in "$BASE" "$RT"/public-share/*.yml "$RT"/monitor-single-camera-ui-20260906-204814/compose.active.yml; do
  check "hash unchanged: $f" 'grep -qx "$(sha256sum "$f")" "$BASELINE_DIR/file-hashes.txt"'
done

# 3. Public Share runtime gate (IDEA1-owned, read-only)
check "connector service and drift timer active" '[ "$(systemctl is-active aegis-public-share-connector.service aegis-public-share-drift.timer | sort -u)" = active ]'
check "last drift run succeeded" '[ "$(systemctl show aegis-public-share-drift.service -p Result --value)" = success ]'
check "S5.5 firewall validate = VALID" 'bash "$RT/public-share/s5-5-firewall.sh" validate >/dev/null 2>&1'

# 4. HUB and IDEA3 state for the mode
check "HUB healthy" '[ "$(docker inspect "$HUB" --format "{{.State.Health.Status}}")" = healthy ]'
check "HUB image unchanged" '[ "$(docker inspect "$HUB" --format "{{.Image}}")" = "$EXPECT_HUB_IMAGE_ID" ]'
if [ "$MODE" = phase2a ]; then
  check "HUB networks = drive_proxy .2 + idea3 .2 + internal .4" \
    '[ "$(nets_of "$HUB" | tr "\n" " ")" = "aegis_drive_proxy=172.19.255.2 ${IDEA3_NET}=${HUB_IDEA3_IP} aegis_internal=172.18.0.4 " ]'
  check "IDEA3 Web healthy" '[ "$(docker inspect "$WEB" --format "{{.State.Health.Status}}")" = healthy ]'
  check "IDEA3 Web only on ${IDEA3_NET} at ${WEB_IP}" '[ "$(nets_of "$WEB" | tr "\n" " ")" = "${IDEA3_NET}=${WEB_IP} " ]'
  check "IDEA3 Web publishes no host port" '[ -z "$(docker port "$WEB")" ]'
  check "${IDEA3_NET} members = HUB + IDEA3 Web only" \
    '[ "$(docker network inspect "$IDEA3_NET" --format "{{range .Containers}}{{.Name}} {{end}}" | tr " " "\n" | sed "/^$/d" | sort | tr "\n" " ")" = "$HUB $WEB " ]'
  check "readiness READY through the IDEA3 listener" \
    'docker exec "$WEB" wget -qO- "http://${WEB_IP}:8003/security/api/readiness" | grep -q "\"status\":\"READY\""'
  check "HUB reaches IDEA3 on the pinned address" \
    'docker exec "$HUB" wget -qO- "http://${WEB_IP}:8003/security/api/readiness" | grep -q "\"status\":\"READY\""'
  check "machine listener not started (dispatch disabled in 2A)" \
    '! docker exec "$HUB" wget -q -T 3 -O /dev/null "http://${WEB_IP}:8004/" 2>/dev/null'
else
  check "HUB networks back to drive_proxy .2 + internal .4" \
    '[ "$(nets_of "$HUB" | tr "\n" " ")" = "aegis_drive_proxy=172.19.255.2 aegis_internal=172.18.0.4 " ]'
  check "IDEA3 Web absent" '! docker inspect "$WEB" >/dev/null 2>&1'
  check "live NGINX artifact restored to ${EXPECT_LIVE_NGINX_SHA:0:8}" '[ "$(sha "$NGINX_LIVE")" = "$EXPECT_LIVE_NGINX_SHA" ]'
fi

# 5. Nothing else was created
check "no other new container" \
  '[ "$(docker ps -a --format "{{.Names}}" | sort | grep -vxF -f <(sed -E "s#^/([^ ]+) .*#\1#" "$BASELINE_DIR/containers.txt") | grep -vx "$WEB" | wc -l)" = 0 ]'

if [ "$fail" = 0 ]; then log "VERIFY_${MODE^^}=PASS"; else log "VERIFY_${MODE^^}=FAIL — rollback trigger"; fi
exit "$fail"
