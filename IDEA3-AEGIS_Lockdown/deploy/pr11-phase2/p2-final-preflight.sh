#!/usr/bin/env bash
# AEGIS IDEA3 PR11 — final pre-mutation preflight. READ-ONLY, both modes.
#
#   MODE=local  bash p2-final-preflight.sh    workstation: Git/GitHub gates (K1 merged, K3 window, overlay hash)
#   MODE=server sudo bash p2-final-preflight.sh   aegis-system: K4, K7, hashes, health
#
# It changes nothing anywhere. It is the last gate before anyone types the
# Production authorization phrase: every line must read PASS.
# shellcheck disable=SC2034  # values are referenced inside the quoted check expressions
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
MODE="${MODE:-local}"
REPO="${REPO:-$(cd "$HERE/../../.." && pwd)}"
fail=0
log()   { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
check() { if eval "$2"; then log "PASS $1"; else log "FAIL $1"; fail=1; fi; }

# The reconciled HUB artifact: live 16cee162… plus IR-1, as reviewed in PR #144.
EXPECT_RECONCILED_NGINX_SHA=7ca8769e2abeb22a6e8af3d8a01b5d15bfe2abfb5c470ae7bf10d530a39e5ce2
EXPECT_LIVE_NGINX_SHA=16cee16232f5636eb11dd434d43ba42c6314d75a2b306265ee62032b84fb3722
EXPECT_OVL_SHA=2feaad012d55d1bf2cccde403c487f4348bd3a47b561f8d5fd5aa706df28d591
# Phase 2B overlay form (PR #145). Checked only once that PR is merged.
EXPECT_OVL_2B_SHA=0be5e5b4db590923ea397b2063b4de216f74ebcdbf92f4fe7e8976db5c650812
# PHASE selects what the IDEA3 network must look like: before Phase 2A it must
# be absent; after Phase 2A it must exist with exactly the HUB and IDEA3 Web.
PHASE="${PHASE:-pre2a}"

if [ "$MODE" = local ]; then
  cd "$REPO" || { log "STOP: repository not found at $REPO"; exit 2; }
  log "=== L1 repository is current"
  git fetch origin --quiet 2>/dev/null
  log "origin/main = $(git rev-parse origin/main)"

  log "=== L2 K1 reconciliation is merged into origin/main"
  merged_sha=$(git show origin/main:HUB-AEGIS_Entry/nginx.conf 2>/dev/null | sha256sum | cut -d' ' -f1)
  log "origin/main HUB-AEGIS_Entry/nginx.conf = ${merged_sha:-<absent>}"
  check "the reconciled artifact is on main" '[ "$merged_sha" = "$EXPECT_RECONCILED_NGINX_SHA" ]'
  check "the stale pre-K1 artifact is gone from main" '[ "$merged_sha" != ac70bfbaf2254b3a878924635e8c76cb97961f8c464ae1de3ba61325c94668c6 ]'
  # NOTE: never pipe `git show` into `grep -q`. grep exits at the first match,
  # git then dies with SIGPIPE, and `set -o pipefail` turns a true condition into
  # a false FAIL. `grep -c … >/dev/null` reads the whole stream instead.
  check "the Phase 2B machine block is present but NOT included by nginx.conf" \
    'git show origin/main:HUB-AEGIS_Entry/nginx.idea3-machine-phase2b.conf >/dev/null 2>&1 \
     && [ "$(git show origin/main:HUB-AEGIS_Entry/nginx.conf | grep -cE "include[^;]*idea3-machine-phase2b")" = 0 ]'
  check "the HUB routing contract test is on main" 'git show origin/main:HUB-AEGIS_Entry/tests/idea3RoutingContract.test.mjs >/dev/null 2>&1'
  check "the reconciled artifact still contains the IR-1 /security route" \
    '[ "$(git show origin/main:HUB-AEGIS_Entry/nginx.conf | grep -c "location /security/")" -ge 1 ]'
  check "HUB contract tests pass against main" 'node --test HUB-AEGIS_Entry/tests/*.test.mjs >/dev/null 2>&1'

  log "=== L3 the IDEA3 overlays are byte-identical to the reviewed files"
  check "Phase 2A overlay hash = ${EXPECT_OVL_SHA:0:8}…" \
    '[ "$(sha256sum IDEA3-AEGIS_Lockdown/deploy/docker-compose.pr11-phase2.yml | cut -d" " -f1)" = "$EXPECT_OVL_SHA" ]'
  # PR #145 adds the Phase 2B form. It is optional until that PR merges, but once
  # present it must be the reviewed bytes and must differ from 2A by two lines only.
  if git show origin/main:IDEA3-AEGIS_Lockdown/deploy/docker-compose.pr11-phase2b.yml >/dev/null 2>&1; then
    log "Phase 2B overlay is merged into main"
    check "Phase 2B overlay hash = ${EXPECT_OVL_2B_SHA:0:8}…" \
      '[ "$(git show origin/main:IDEA3-AEGIS_Lockdown/deploy/docker-compose.pr11-phase2b.yml | sha256sum | cut -d" " -f1)" = "$EXPECT_OVL_2B_SHA" ]'
    check "Phase 2B differs from Phase 2A by exactly two lines" \
      '[ "$(diff <(git show origin/main:IDEA3-AEGIS_Lockdown/deploy/docker-compose.pr11-phase2.yml) \
                 <(git show origin/main:IDEA3-AEGIS_Lockdown/deploy/docker-compose.pr11-phase2b.yml) \
            | grep -c "^[<>]")" = 4 ]'
    check "Phase 2B keeps the same Production path" \
      '[ "$(git show origin/main:IDEA3-AEGIS_Lockdown/deploy/docker-compose.pr11-phase2b.yml | grep -c "PRODUCTION_PATH: /opt/aegis/runtime/idea3/idea3-phase2.yml")" = 1 ]'
  else
    log "NOTE Phase 2B overlay (PR #145) is not merged yet — required only for a Phase 2B window"
  fi

  log "=== L4 K3: no conflicting IDEA1 Production window"
  if command -v gh >/dev/null 2>&1; then
    open_prs=$(gh pr list --state open --json number,headRefName,title --jq '.[]|"\(.number) \(.headRefName) — \(.title)"')
    printf '%s\n' "${open_prs:-<none>}"
    idea1_runtime=$(printf '%s\n' "$open_prs" | grep -iE 'idea1|public-share|drive' | grep -viE 'docs|post-closeout|follow' || true)
    check "no open IDEA1 PR declares runtime or Production work" '[ -z "$idea1_runtime" ]'
    check "IDEA1 Public Share closeout is merged" \
      '[ "$(git show origin/main:Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md | grep -c "S5.12")" -ge 1 ]'
  else log "SKIP gh not installed; check open IDEA1 PRs by hand"; fi
  log "NOTE the live IDEA1 window recheck still runs in p2a-baseline.sh and execute S0"

elif [ "$MODE" = server ]; then
  # shellcheck source=p2-lib.sh
  . "$HERE/p2-lib.sh"
  need_root
  # Phase 2A installs the reconciled artifact and recreates the HUB from the
  # two-file model, so the pinned artifact and config-hash depend on PHASE.
  # Phase 2B appends the machine block in place, so no whole-file hash exists
  # for post2b; the block itself is checked instead.
  case "$PHASE" in
    pre2a)        want_nginx=$EXPECT_LIVE_NGINX_SHA;       want_hub_hash=$EXPECT_RUNNING_HUB_HASH ;;
    post2a|pre2b) want_nginx=$EXPECT_RECONCILED_NGINX_SHA; want_hub_hash=$EXPECT_P2A_HUB_HASH ;;
    *)            want_nginx="";                           want_hub_hash=$EXPECT_P2A_HUB_HASH ;;
  esac

  log "=== S1 K1: the live artifact is the accepted one for phase=$PHASE"
  if [ -n "$want_nginx" ]; then
    check "host artifact = ${want_nginx:0:8}…" '[ "$(sha "$NGINX_LIVE")" = "$want_nginx" ]'
  else
    check "host artifact carries exactly one idea3-core.aegis.internal machine block" \
      '[ "$(grep -c "server_name idea3-core.aegis.internal;" "$NGINX_LIVE")" = 1 ]'
  fi
  check "running HUB serves the host artifact" \
    '[ "$(docker exec "$HUB" sha256sum /etc/nginx/conf.d/default.conf | cut -d" " -f1)" = "$(sha "$NGINX_LIVE")" ]'

  log "=== S2 K7: the accepted HUB model still matches"
  check "base Compose = ${EXPECT_BASE_SHA:0:8}…" '[ "$(sha "$BASE")" = "$EXPECT_BASE_SHA" ]'
  check "running HUB config-hash = ${want_hub_hash:0:8}…" \
    '[ "$(label "$HUB" com.docker.compose.config-hash)" = "$want_hub_hash" ]'
  check "base renders hub = ${EXPECT_BASE_HUB_HASH:0:8}…" \
    '[ "$("${DC_BASE[@]}" config --hash hub | awk "{print \$2}")" = "$EXPECT_BASE_HUB_HASH" ]'
  check "HUB image unchanged" '[ "$(docker inspect "$HUB" --format "{{.Image}}")" = "$EXPECT_HUB_IMAGE_ID" ]'

  log "=== S3 K4 and the IDEA3 network, for phase=$PHASE"
  case "$PHASE" in
    pre2a)
      # Before Phase 2A the subnet must be free and the network must not exist.
      check "172.31.243.0/29 free and ${IDEA3_NET} absent" k4_clear
      check "no IDEA3 Web container exists yet" '! docker inspect "$WEB" >/dev/null 2>&1'
      ;;
    post2a|pre2b|post2b)
      # After Phase 2A the network must exist with exactly the two accepted members.
      check "${IDEA3_NET} exists with the accepted model" \
        '[ "$(docker network inspect "$IDEA3_NET" --format "{{range .IPAM.Config}}{{.Subnet}} {{.Gateway}}{{end}} {{.Internal}} {{.Attachable}}")" = "$IDEA3_SUBNET $IDEA3_GW true false" ]'
      check "${IDEA3_NET} members are exactly the HUB and IDEA3 Web" \
        '[ "$(docker network inspect "$IDEA3_NET" --format "{{range .Containers}}{{.Name}} {{end}}" | tr " " "\n" | sed "/^$/d" | sort | tr "\n" " ")" = "$HUB $WEB " ]'
      check "IDEA3 Web publishes no host port" '[ -z "$(docker port "$WEB" 2>/dev/null)" ]'
      check "HUB is on the IDEA3 network at ${HUB_IDEA3_IP}" \
        '[ "$(nets_of "$HUB" | grep -c "^${IDEA3_NET}=${HUB_IDEA3_IP}$")" = 1 ]'
      ;;
    *) log "FAIL unknown PHASE=$PHASE (expected pre2a, post2a, pre2b or post2b)"; fail=1 ;;
  esac

  log "=== S3b HUB identity (captured, and pinned where it must not move)"
  docker inspect "$HUB" --format 'hub_image={{.Config.Image}} hub_image_id={{.Image}} restart={{(.HostConfig.RestartPolicy).Name}} ports={{json .HostConfig.PortBindings}}'
  docker inspect "$HUB" --format '{{range .Mounts}}mount {{.Type}} {{.Source}} -> {{.Destination}} ro={{not .RW}}{{println}}{{end}}' | sed '/^$/d'
  nets_of "$HUB" | sed 's/^/  hub_network /'
  check "HUB restart policy is unless-stopped" \
    '[ "$(docker inspect "$HUB" --format "{{(.HostConfig.RestartPolicy).Name}}")" = unless-stopped ]'
  check "HUB still publishes 443 and 80 on 192.168.10.10 only" \
    '[ "$(docker inspect "$HUB" --format "{{json .HostConfig.PortBindings}}")" = "{\"443/tcp\":[{\"HostIp\":\"192.168.10.10\",\"HostPort\":\"443\"}],\"80/tcp\":[{\"HostIp\":\"192.168.10.10\",\"HostPort\":\"80\"}]}" ] \
     || [ "$(docker inspect "$HUB" --format "{{json .HostConfig.PortBindings}}")" = "{\"80/tcp\":[{\"HostIp\":\"192.168.10.10\",\"HostPort\":\"80\"}],\"443/tcp\":[{\"HostIp\":\"192.168.10.10\",\"HostPort\":\"443\"}]}" ]'

  log "=== S3c Twingate preservation (never touched by IDEA3)"
  check "twingate-aegis-connector-02 is running" \
    '[ "$(docker inspect twingate-aegis-connector-02 --format "{{.State.Status}}")" = running ]'
  check "Twingate is not Compose-managed by this project" \
    '[ -z "$(docker inspect twingate-aegis-connector-02 --format "{{index .Config.Labels \"com.docker.compose.project\"}}")" ]'

  log "=== S4 service health and the Public Share gate"
  for c in $PRESERVED $HUB; do
    s=$(docker inspect "$c" --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' 2>/dev/null || echo absent)
    printf '  %-40s %s\n' "$c" "$s"
    case "$s" in running*unhealthy|absent) log "FAIL $c is $s"; fail=1 ;; running*) ;; *) log "FAIL $c is $s"; fail=1 ;; esac
  done
  check "connector service and drift timer active" '[ "$(systemctl is-active aegis-public-share-connector.service aegis-public-share-drift.timer | sort -u)" = active ]'
  check "last drift run succeeded" '[ "$(systemctl show aegis-public-share-drift.service -p Result --value)" = success ]'
  check "S5.5 firewall validate = VALID" 'bash "$RT/public-share/s5-5-firewall.sh" validate >/dev/null 2>&1'

  log "=== S5 IDEA3 inputs"
  case "$PHASE" in
    pre2a)        check "the IDEA3 overlay is still absent (fresh placement)" '[ ! -e "$OVL" ]' ;;
    post2a|pre2b) check "placed overlay = Phase 2A ${EXPECT_OVL_SHA:0:8}…" '[ "$(sha "$OVL")" = "$EXPECT_OVL_SHA" ]' ;;
    *)            check "placed overlay = Phase 2B ${EXPECT_OVL_2B_SHA:0:8}…" '[ "$(sha "$OVL")" = "$EXPECT_OVL_2B_SHA" ]' ;;
  esac
  for f in session-secret admin-password-hash; do
    check "secret $f is a 1000:1000 0400 regular file (content never read)" \
      '[ "$(stat -c "%F %u:%g %a" "$SECRET_DIR/'"$f"'" 2>/dev/null)" = "regular file 1000:1000 400" ]'
  done
else
  log "STOP: MODE must be local or server"; exit 2
fi

if [ "$fail" = 0 ]; then log "FINAL_PREFLIGHT_${MODE^^}=PASS"; else log "FINAL_PREFLIGHT_${MODE^^}=FAIL"; fi
exit "$fail"
