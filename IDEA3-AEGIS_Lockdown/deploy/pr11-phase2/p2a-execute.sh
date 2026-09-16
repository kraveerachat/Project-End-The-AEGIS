#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 2A — scoped Production execution (browser route).
# MUTATING. Run only in an authorized window, by the owner with Kla (K7 rollback
# owner) present, after p2a-baseline.sh exits 0. DRY_RUN=1 prints every
# mutating command without running it.
#
# Required environment (the script refuses to start without every value):
#   AUTHORIZE_IDEA3_PR11_PHASE2_RUNTIME_PRODUCTION_MUTATION=YES
#   K3_EXECUTION_WINDOW=CLEAR           accepted owner value, re-checked just before this run
#   BASELINE_DIR=<dir written by p2a-baseline.sh>
#   OVERLAY_SRC=<repo copy of IDEA3-AEGIS_Lockdown/deploy/docker-compose.pr11-phase2.yml>
#   WEB_CONTEXT_TGZ=<git archive of IDEA3-AEGIS_Lockdown/web, gzip -n>
#   NODE_IMAGE_DIGEST=sha256:<verified node:22-alpine index digest>
#   K1_NGINX_CANDIDATE=<Kla-reviewed HUB-AEGIS_Entry/nginx.conf: live 16cee162 + IR-1>
#   K1_NGINX_CANDIDATE_SHA256=<SHA-256 of that file at the merged Kla commit>
#
# Never: docker compose down, --remove-orphans, an `up` without a service name,
# a restart of any preserved service, CUT/RESTORE/GPIO/MQTT, or a reboot.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=p2-lib.sh
. "$HERE/p2-lib.sh"
need_root

for v in AUTHORIZE_IDEA3_PR11_PHASE2_RUNTIME_PRODUCTION_MUTATION K3_EXECUTION_WINDOW BASELINE_DIR \
         OVERLAY_SRC WEB_CONTEXT_TGZ NODE_IMAGE_DIGEST K1_NGINX_CANDIDATE K1_NGINX_CANDIDATE_SHA256; do
  [ -n "${!v:-}" ] || die "required input $v is missing"
done
[ "$AUTHORIZE_IDEA3_PR11_PHASE2_RUNTIME_PRODUCTION_MUTATION" = YES ] || die "authorization phrase absent"
[ "$K3_EXECUTION_WINDOW" = CLEAR ] || die "K3 is not CLEAR"
[[ "$NODE_IMAGE_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || die "NODE_IMAGE_DIGEST is not a sha256 digest"
[ -s "$BASELINE_DIR/containers.txt" ] || die "baseline missing: $BASELINE_DIR"
# Both baseline preconditions live here, so a stale or failed baseline is
# reported immediately rather than after every hash has been recomputed.
tail -n1 "$BASELINE_DIR/baseline.log" 2>/dev/null | grep -q 'BASELINE=PASS' \
  || die "the baseline run did not end in BASELINE=PASS"

RUN_DIR="$BASELINE_DIR/../execute-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$RUN_DIR"
exec > >(tee "$RUN_DIR/execute.log") 2>&1
log "PHASE 2A START dry_run=$DRY_RUN run_dir=$RUN_DIR"

# ── S0 re-verify inputs and live state (read-only) ─────────────────────────
[ "$(sha "$OVERLAY_SRC")" = "$EXPECT_OVL_SHA" ] || die "overlay source is not byte-identical to the repository"
[ "$(sha "$WEB_CONTEXT_TGZ")" = "$EXPECT_WEB_CONTEXT_SHA" ] || die "web build context hash mismatch"
[ "$(sha "$K1_NGINX_CANDIDATE")" = "$K1_NGINX_CANDIDATE_SHA256" ] || die "NGINX candidate hash mismatch"
[ "$(sha "$NGINX_LIVE")" = "$EXPECT_LIVE_NGINX_SHA" ] || die "live NGINX artifact changed since the accepted baseline"
[ "$(sha "$BASE")" = "$EXPECT_BASE_SHA" ] || die "base Compose changed"
[ "$(label "$HUB" com.docker.compose.config-hash)" = "$EXPECT_RUNNING_HUB_HASH" ] || die "running HUB changed since K7-E3"
k4_clear || die "K4: 172.31.243.0/29 or ${IDEA3_NET} is no longer free"
for f in session-secret admin-password-hash; do   # metadata only; content is never read
  [ "$(stat -c '%F %u:%g %a' "$SECRET_DIR/$f")" = "regular file 1000:1000 400" ] || die "secret file $f must be a regular 1000:1000 0400 file"
  [ -s "$SECRET_DIR/$f" ] || die "secret file $f is empty"
done
CONNECTOR_START=$(docker inspect "$CONNECTOR" --format '{{.State.StartedAt}}')
log "S0 PASS"

# ── S1 place the overlay byte-identical to Git ─────────────────────────────
mut install -D -m 0644 -o root -g root "$OVERLAY_SRC" "$OVL"
[ "$DRY_RUN" = 1 ] || [ "$(sha "$OVL")" = "$EXPECT_OVL_SHA" ] || die "placed overlay hash mismatch"

# ── S2 render the accepted two-file model (no values printed) ─────────────
if [ "$DRY_RUN" != 1 ]; then
  "${DC_P2A[@]}" config --quiet || die "Phase 2A model does not render"
  [ "$("${DC_P2A[@]}" config --services | sort | tr '\n' ' ')" = "drive hub idea3-web monitor postgres " ] || die "unexpected service set"
  [ "$("${DC_P2A[@]}" config --hash hub | awk '{print $2}')" = "$EXPECT_P2A_HUB_HASH" ] || die "Phase 2A hub render hash changed"
fi
log "S2 PASS"

# ── S3 build the IDEA3 Web image from the verified context ────────────────
CTX=$(mktemp -d /var/tmp/idea3-web-ctx.XXXXXX)
trap 'rm -rf "$CTX"' EXIT
tar -xzf "$WEB_CONTEXT_TGZ" -C "$CTX"
mut docker build --build-arg "NODE_IMAGE=node:22-alpine@${NODE_IMAGE_DIGEST}" -t "$WEB_IMAGE" "$CTX/IDEA3-AEGIS_Lockdown/web"
[ "$DRY_RUN" = 1 ] || docker image inspect "$WEB_IMAGE" --format 'web_image_id={{.Id}}' | tee "$RUN_DIR/web-image.txt"

# ── S4 start IDEA3 Web first (creates aegis_idea3_internal and the volume) ─
mut "${DC_P2A[@]}" up -d --no-deps --no-build idea3-web
if [ "$DRY_RUN" != 1 ]; then
  wait_healthy "$WEB" 120 || die "IDEA3 Web not healthy — run p2a-rollback.sh --stage web"
  [ "$(nets_of "$WEB" | tr '\n' ' ')" = "${IDEA3_NET}=${WEB_IP} " ] || die "IDEA3 Web networks wrong — rollback --stage web"
  [ -z "$(docker port "$WEB")" ] || die "IDEA3 Web has a published port — rollback --stage web"
  [ "$(docker network inspect "$IDEA3_NET" --format '{{range .IPAM.Config}}{{.Subnet}} {{.Gateway}}{{end}} {{.Internal}} {{.Attachable}}')" \
    = "$IDEA3_SUBNET $IDEA3_GW true false" ] || die "network model wrong — rollback --stage web"
  docker exec "$WEB" wget -qO- "http://${WEB_IP}:8003/security/api/readiness" | grep -q '"status":"READY"' \
    || die "readiness is not READY — rollback --stage web"
fi
log "S4 PASS"

# ── S5 drift checkpoint: the new bridge must not trip IDEA1's drift gate ──
if [ "$DRY_RUN" != 1 ]; then
  log "waiting 90s for at least one aegis-public-share-drift run"; sleep 90
  [ "$(systemctl show aegis-public-share-drift.service -p Result --value)" = success ] || die "drift run failed — rollback --stage web"
  [ "$(docker inspect "$CONNECTOR" --format '{{.State.Status}} {{.State.StartedAt}}')" = "running $CONNECTOR_START" ] \
    || die "Public Share connector changed — rollback --stage web"
  bash "$RT/public-share/s5-5-firewall.sh" validate >/dev/null 2>&1 || die "S5.5 firewall not VALID — rollback --stage web"
fi
log "S5 PASS"

# ── S6 validate the Kla-reviewed NGINX candidate in isolation ─────────────
mut docker run --rm --network none --entrypoint nginx \
  -v "$K1_NGINX_CANDIDATE:/etc/nginx/conf.d/default.conf:ro" -v "$CERTS:/etc/nginx/certs:ro" \
  "$EXPECT_HUB_IMAGE_ID" -t
log "S6 PASS"

# ── S7 snapshot the live artifact, then install the candidate ─────────────
SNAP="$NGINX_LIVE.pre-idea3-p2a-$(date -u +%Y%m%dT%H%M%SZ)"
mut cp -p "$NGINX_LIVE" "$SNAP"
echo "$SNAP" > "$RUN_DIR/nginx-snapshot-path.txt"
[ "$DRY_RUN" = 1 ] || [ "$(sha "$SNAP")" = "$EXPECT_LIVE_NGINX_SHA" ] || die "snapshot hash mismatch"
MODE=$(stat -c '%a' "$NGINX_LIVE"); OWN=$(stat -c '%u:%g' "$NGINX_LIVE")
mut install -m "$MODE" -o "${OWN%:*}" -g "${OWN#*:}" "$K1_NGINX_CANDIDATE" "$NGINX_LIVE"
[ "$DRY_RUN" = 1 ] || [ "$(sha "$NGINX_LIVE")" = "$K1_NGINX_CANDIDATE_SHA256" ] || die "installed NGINX hash mismatch — rollback --stage full"

# ── S8 recreate the HUB only, with the accepted two-file model ────────────
mut "${DC_P2A[@]}" up -d --no-deps --no-build --force-recreate hub
if [ "$DRY_RUN" != 1 ]; then
  wait_healthy "$HUB" 120 || die "HUB not healthy — run p2a-rollback.sh --stage full NOW"
  [ "$(nets_of "$HUB" | tr '\n' ' ')" = "aegis_drive_proxy=172.19.255.2 ${IDEA3_NET}=${HUB_IDEA3_IP} aegis_internal=172.18.0.4 " ] \
    || die "HUB networks wrong — rollback --stage full"
  [ "$(docker inspect "$HUB" --format '{{.Image}}')" = "$EXPECT_HUB_IMAGE_ID" ] || die "HUB image changed — rollback --stage full"
  label "$HUB" com.docker.compose.config-hash | sed 's/^/hub_config_hash_after=/' | tee "$RUN_DIR/hub-hash.txt"
fi
log "S8 PASS — now run p2a-verify.sh BASELINE_DIR=$BASELINE_DIR (rollback on any FAIL)"
