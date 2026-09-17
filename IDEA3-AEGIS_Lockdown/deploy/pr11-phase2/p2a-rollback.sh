#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 2A — scoped rollback (K7 rollback owner: kraveerachat).
# MUTATING. DRY_RUN=1 prints the commands only.
#
#   sudo CONFIRM_ROLLBACK=YES BASELINE_DIR=<dir> bash p2a-rollback.sh --stage web
#       failure before the NGINX install: remove IDEA3 Web and its network only
#   sudo CONFIRM_ROLLBACK=YES BASELINE_DIR=<dir> RUN_DIR=<execute dir> bash p2a-rollback.sh --stage full
#       failure at or after the NGINX install / HUB recreate
#
# Never: docker compose down, --remove-orphans, a restart of any preserved
# service, removal of the aegis_idea3_web_data volume, CUT, RESTORE, GPIO,
# firmware, or a reboot. Afterwards run p2a-verify.sh with MODE=rollback.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=p2-lib.sh
. "$HERE/p2-lib.sh"
need_root
# A fixture root is TEST-ONLY: it may only ever be combined with DRY_RUN=1.
[ -z "${AEGIS_P2_ROOT:-}" ] || [ "$DRY_RUN" = 1 ] || die "AEGIS_P2_ROOT is TEST-ONLY; refusing a real run while it is set"
[ "${CONFIRM_ROLLBACK:-}" = YES ] || die "set CONFIRM_ROLLBACK=YES"
STAGE="${2:-}"; [ "${1:-}" = --stage ] && [[ "$STAGE" =~ ^(web|full)$ ]] || die "usage: --stage web|full"
log "ROLLBACK START stage=$STAGE dry_run=$DRY_RUN"

if [ "$STAGE" = full ]; then
  : "${RUN_DIR:?RUN_DIR (the execute run directory) is required for --stage full}"
  SNAP=$(cat "$RUN_DIR/nginx-snapshot-path.txt")
  [ "$(sha "$SNAP")" = "$EXPECT_LIVE_NGINX_SHA" ] || die "snapshot $SNAP is not the accepted live artifact"
  # R1 restore the accepted live NGINX artifact and validate it in isolation
  MODE=$(stat -c '%a' "$NGINX_LIVE"); OWN=$(stat -c '%u:%g' "$NGINX_LIVE")
  mut install -m "$MODE" -o "${OWN%:*}" -g "${OWN#*:}" "$SNAP" "$NGINX_LIVE"
  [ "$DRY_RUN" = 1 ] || [ "$(sha "$NGINX_LIVE")" = "$EXPECT_LIVE_NGINX_SHA" ] || die "restore hash mismatch"
  mut docker run --rm --network none --entrypoint nginx \
    -v "$NGINX_LIVE:/etc/nginx/conf.d/default.conf:ro" -v "$CERTS:/etc/nginx/certs:ro" "$EXPECT_HUB_IMAGE_ID" -t
  # R2 recreate the HUB alone from the accepted base model (K7: base semantics)
  mut "${DC_BASE[@]}" up -d --no-deps --no-build --force-recreate hub
  [ "$DRY_RUN" = 1 ] || wait_healthy "$HUB" 120 || die "HUB not healthy after rollback — escalate to kraveerachat"
fi

# R3 stop and remove IDEA3 Web only (the service exists only in the two-file model)
if docker inspect "$WEB" >/dev/null 2>&1; then
  mut "${DC_P2A[@]}" stop idea3-web
  mut "${DC_P2A[@]}" rm -f idea3-web
fi

# R4 remove the IDEA3 network only when no container is attached
if docker network inspect "$IDEA3_NET" >/dev/null 2>&1; then
  members=$(docker network inspect "$IDEA3_NET" --format '{{len .Containers}}')
  if [ "$members" = 0 ] || [ "$DRY_RUN" = 1 ]; then mut docker network rm "$IDEA3_NET"
  else log "NOT removing ${IDEA3_NET}: $members container(s) still attached"; fi
fi

# R5 take the overlay out of the canonical HUB list; keep secrets and the volume
if [ -e "$OVL" ]; then mut mv "$OVL" "$OVL.rolled-back-$(date -u +%Y%m%dT%H%M%SZ)"; fi
log "aegis_idea3_web_data volume preserved (never removed by an IDEA3 task)"
log "ROLLBACK DONE — now run: MODE=rollback BASELINE_DIR=$BASELINE_DIR bash p2a-verify.sh"
