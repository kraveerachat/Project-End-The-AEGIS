#!/usr/bin/env bash
# PUBLIC-SHARE-7 S5.5 connector runtime safety gate.
#
#   s5-5-runtime-check.sh --pre-start      exit 0 only when it is safe to start
#                                          the connector
#   s5-5-runtime-check.sh --enforce-drift  re-check the same invariants and stop
#                                          ONLY the connector if they no longer hold
#
# Fail-closed by design: anything unproven is a failure. This script inspects
# topology and metadata only. It never starts a container, never weakens a
# firewall rule, and never reads, prints, hashes, exports or passes the tunnel
# token; it checks the token path's TYPE, OWNERSHIP and MODE and nothing else.
#
# Compose applies create_host_path to a bind mount, so a missing credential
# source is silently materialised as a DIRECTORY. Requiring a regular file here
# is what stops that from being accepted as a valid credential.
set -euo pipefail

readonly EDGE_NETWORK='aegis_public_share_edge'
readonly UPSTREAM_NETWORK='aegis_public_share_upstream'
readonly EGRESS_NETWORK='aegis_public_share_egress'

readonly GATEWAY_EDGE_IP='172.31.240.2'
readonly CONNECTOR_EDGE_IP='172.31.240.3'
readonly GATEWAY_UPSTREAM_IP='172.31.241.2'
readonly DRIVE_UPSTREAM_IP='172.31.241.3'
readonly CONNECTOR_EGRESS_IP='172.31.242.2'
readonly EGRESS_SUBNET='172.31.242.0/29'
readonly EGRESS_GATEWAY='172.31.242.1'
readonly EGRESS_BRIDGE='aegis-ps-eg'

# Exactly these two attachments are permitted. Anything else is a violation.
readonly ALLOWED_NETWORKS="${EDGE_NETWORK} ${EGRESS_NETWORK}"

readonly TOKEN_OWNER_UID='0'
readonly TOKEN_GROUP_GID='65532'
readonly TOKEN_MODE='440'

readonly CONNECTOR_SERVICE='aegis-public-share-connector.service'
readonly COMPOSE_PROJECT='aegis-prod'
readonly COMPOSE_SERVICE='public-share-connector'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DOCKER="${AEGIS_DOCKER_BIN:-docker}"
STAT="${AEGIS_STAT_BIN:-stat}"
SYSTEMCTL="${AEGIS_SYSTEMCTL_BIN:-systemctl}"
FIREWALL_SCRIPT="${AEGIS_FIREWALL_SCRIPT:-${SCRIPT_DIR}/s5-5-firewall.sh}"
TOKEN_FILE="${AEGIS_TOKEN_FILE:-/opt/aegis/runtime/public-share/secrets/cloudflared-token}"
CONNECTOR_CONTAINER="${AEGIS_CONNECTOR_CONTAINER:-aegis-prod-public-share-connector-1}"

fail() { echo "S5.5-RUNTIME=FAIL: $*" >&2; return 1; }

# --- topology ---------------------------------------------------------------

network_json() {
  "$DOCKER" network inspect "$1" 2>/dev/null
}

# Print "<container-name> <ipv4>" for every member of a network.
network_members() {
  NETWORK_JSON="$1" node --input-type=commonjs -e '
    const data = JSON.parse(process.env.NETWORK_JSON)
    const net = Array.isArray(data) ? data[0] : data
    const members = net?.Containers ?? {}
    for (const entry of Object.values(members)) {
      const ip = String(entry.IPv4Address ?? "").split("/")[0]
      process.stdout.write(`${entry.Name} ${ip}\n`)
    }
  ' 2>/dev/null
}

network_field() {
  NETWORK_JSON="$1" FIELD="$2" node --input-type=commonjs -e '
    const data = JSON.parse(process.env.NETWORK_JSON)
    const net = Array.isArray(data) ? data[0] : data
    const ipam = net?.IPAM?.Config?.[0] ?? {}
    const field = process.env.FIELD
    const value = field === "subnet" ? ipam.Subnet
      : field === "gateway" ? ipam.Gateway
      : field === "bridge" ? net?.Options?.["com.docker.network.bridge.name"]
      : ""
    process.stdout.write(String(value ?? ""))
  ' 2>/dev/null
}

require_member_at() {
  local members="$1" ip="$2" label="$3"
  if ! printf '%s\n' "$members" | awk -v ip="$ip" '$2 == ip { found = 1 } END { exit found ? 0 : 1 }'; then
    fail "${label} is not present at ${ip}"
    return 1
  fi
  return 0
}

check_edge_topology() {
  local json members
  json="$(network_json "$EDGE_NETWORK")" || { fail "network ${EDGE_NETWORK} is absent"; return 1; }
  [ -n "$json" ] || { fail "network ${EDGE_NETWORK} is absent"; return 1; }
  members="$(network_members "$json")"
  require_member_at "$members" "$GATEWAY_EDGE_IP" "the S5.4 gateway on ${EDGE_NETWORK}"
}

check_upstream_topology() {
  local json members status=0
  json="$(network_json "$UPSTREAM_NETWORK")" || { fail "network ${UPSTREAM_NETWORK} is absent"; return 1; }
  [ -n "$json" ] || { fail "network ${UPSTREAM_NETWORK} is absent"; return 1; }
  members="$(network_members "$json")"
  require_member_at "$members" "$GATEWAY_UPSTREAM_IP" "the S5.4 gateway on ${UPSTREAM_NETWORK}" || status=1
  require_member_at "$members" "$DRIVE_UPSTREAM_IP" "drive on ${UPSTREAM_NETWORK}" || status=1
  return "$status"
}

# The egress network is materialised by the authorized bootstrap create, which
# runs BEFORE the firewall and before pre-start. At pre-start it must therefore
# already exist; during drift enforcement it is checked only when present, since
# a completed rollback legitimately removes it.
check_egress_topology() {
  local required="${1:-0}" json status=0
  if ! json="$(network_json "$EGRESS_NETWORK")" || [ -z "$json" ]; then
    if [ "$required" = '1' ]; then
      fail "network ${EGRESS_NETWORK} must exist before the connector may start; run the authorized bootstrap create first"
      return 1
    fi
    return 0
  fi
  [ "$(network_field "$json" subnet)" = "$EGRESS_SUBNET" ] \
    || { fail "${EGRESS_NETWORK} subnet is not ${EGRESS_SUBNET}"; status=1; }
  [ "$(network_field "$json" gateway)" = "$EGRESS_GATEWAY" ] \
    || { fail "${EGRESS_NETWORK} gateway is not ${EGRESS_GATEWAY}"; status=1; }
  [ "$(network_field "$json" bridge)" = "$EGRESS_BRIDGE" ] \
    || { fail "${EGRESS_NETWORK} does not use the stable bridge ${EGRESS_BRIDGE}"; status=1; }
  return "$status"
}

# --- connector membership ---------------------------------------------------

# Bind validation to the accepted Compose project and service rather than to a
# human-readable container name, which is not an authorisation boundary.
check_connector_identity() {
  local labels project service
  labels="$(CONTAINER_JSON="$1" node --input-type=commonjs -e '
    const data = JSON.parse(process.env.CONTAINER_JSON)
    const c = Array.isArray(data) ? data[0] : data
    const l = c?.Config?.Labels ?? {}
    process.stdout.write([
      l["com.docker.compose.project"] ?? "",
      l["com.docker.compose.service"] ?? "",
    ].join("|"))
  ' 2>/dev/null)"
  IFS='|' read -r project service <<< "$labels"
  local status=0
  [ "$project" = "$COMPOSE_PROJECT" ]     || { fail "connector must belong to Compose project ${COMPOSE_PROJECT}"; status=1; }
  [ "$service" = "$COMPOSE_SERVICE" ]     || { fail "connector must be Compose service ${COMPOSE_SERVICE}"; status=1; }
  return "$status"
}

# Only a genuinely stopped object may be validated and then started. Anything
# already running, mid-restart, paused, dead or in an unknown state is refused.
#
# An ACTIVE restart loop is read from CURRENT state only - State.Restarting, or a
# "restarting" status. RestartCount is deliberately NOT consulted: it is a
# cumulative historical counter, so a container that restarted at some point in
# the past and is now genuinely stopped is still a safe object to start. Treating
# it as proof of a live loop would make the connector permanently unstartable
# after any past restart.
check_connector_stopped() {
  local state status running restarting paused dead
  state="$(CONTAINER_JSON="$1" node --input-type=commonjs -e '
    const data = JSON.parse(process.env.CONTAINER_JSON)
    const c = Array.isArray(data) ? data[0] : data
    const s = c?.State ?? {}
    process.stdout.write([
      s.Status ?? "unknown", s.Running === true, s.Restarting === true,
      s.Paused === true, s.Dead === true,
    ].join("|"))
  ' 2>/dev/null)"
  IFS='|' read -r status running restarting paused dead <<< "$state"

  local result=0
  case "$status" in
    created|exited) ;;
    *) fail "connector must be stopped before start; state is '${status}'"; result=1 ;;
  esac
  [ "$running" = 'false' ] || { fail 'connector is already running'; result=1; }
  [ "$restarting" = 'false' ] || { fail 'connector is restarting'; result=1; }
  [ "$paused" = 'false' ] || { fail 'connector is paused'; result=1; }
  [ "$dead" = 'false' ] || { fail 'connector is dead'; result=1; }
  return "$result"
}

# The object that is validated must be the object that starts.
#
# At pre-start the connector has already been CREATED (stopped) by the authorized
# bootstrap, so it MUST exist, MUST carry the accepted Compose identity, and MUST
# still be stopped. Validating a container that is then created or recreated by
# the start command would defeat the whole check, so nothing here tolerates an
# absent connector at pre-start. During drift enforcement the connector is
# expected to be running, and an absent one simply means there is nothing to
# isolate.
check_connector_membership() {
  local required="${1:-0}" json mode networks status=0
  if ! json="$("$DOCKER" inspect "$CONNECTOR_CONTAINER" 2>/dev/null)" || [ -z "$json" ]; then
    if [ "$required" = '1' ]; then
      fail "connector container ${CONNECTOR_CONTAINER} does not exist; run the authorized bootstrap create first"
      return 1
    fi
    return 0
  fi

  if [ "$required" = '1' ]; then
    check_connector_identity "$json" || status=1
    check_connector_stopped "$json" || status=1
  fi

  mode="$(CONTAINER_JSON="$json" node --input-type=commonjs -e '
    const data = JSON.parse(process.env.CONTAINER_JSON)
    const c = Array.isArray(data) ? data[0] : data
    process.stdout.write(String(c?.HostConfig?.NetworkMode ?? ""))
  ' 2>/dev/null)"
  case "$mode" in
    host|container:*) fail "connector must never use ${mode} networking"; status=1 ;;
  esac

  networks="$(CONTAINER_JSON="$json" node --input-type=commonjs -e '
    const data = JSON.parse(process.env.CONTAINER_JSON)
    const c = Array.isArray(data) ? data[0] : data
    const nets = c?.NetworkSettings?.Networks ?? {}
    for (const [name, value] of Object.entries(nets)) {
      process.stdout.write(`${name} ${value?.IPAddress ?? ""}\n`)
    }
  ' 2>/dev/null)"

  local attached
  attached="$(printf '%s\n' "$networks" | awk 'NF { print $1 }' | sort | tr '\n' ' ')"
  local expected
  expected="$(printf '%s\n' $ALLOWED_NETWORKS | sort | tr '\n' ' ')"
  if [ "$attached" != "$expected" ]; then
    fail "connector attachments must be exactly [${expected% }], found [${attached% }]"
    status=1
  fi

  local name ip
  while read -r name ip; do
    [ -n "$name" ] || continue
    case "$name" in
      "$EDGE_NETWORK")
        [ "$ip" = "$CONNECTOR_EDGE_IP" ] \
          || { fail "connector must hold ${CONNECTOR_EDGE_IP} on ${EDGE_NETWORK}"; status=1; } ;;
      "$EGRESS_NETWORK")
        [ "$ip" = "$CONNECTOR_EGRESS_IP" ] \
          || { fail "connector must hold ${CONNECTOR_EGRESS_IP} on ${EGRESS_NETWORK}"; status=1; } ;;
    esac
  done <<< "$networks"
  return "$status"
}

# --- credential -------------------------------------------------------------

# Metadata only. The token's bytes are never opened, printed, hashed, exported
# or passed as an argument by this script.
check_token_file() {
  local metadata type uid gid mode
  metadata="$("$STAT" -c '%F|%u|%g|%a' -- "$TOKEN_FILE" 2>/dev/null)" \
    || { fail "credential path is absent: ${TOKEN_FILE}"; return 1; }

  IFS='|' read -r type uid gid mode <<< "$metadata"
  local status=0
  # A directory here means Compose create_host_path materialised a missing
  # bind source. A symlink is not permitted by the approved design.
  [ "$type" = 'regular file' ] \
    || { fail "credential path must be a regular file, found '${type}'"; status=1; }
  [ "$uid" = "$TOKEN_OWNER_UID" ] \
    || { fail "credential owner UID must be ${TOKEN_OWNER_UID}"; status=1; }
  [ "$gid" = "$TOKEN_GROUP_GID" ] \
    || { fail "credential group GID must be ${TOKEN_GROUP_GID}"; status=1; }
  [ "$mode" = "$TOKEN_MODE" ] \
    || { fail "credential mode must be exactly 0${TOKEN_MODE}"; status=1; }
  return "$status"
}

# --- firewall ---------------------------------------------------------------

check_firewall() {
  bash "$FIREWALL_SCRIPT" validate >/dev/null 2>&1 \
    || { fail 's5-5-firewall.sh validate did not pass'; return 1; }
}

# --- modes ------------------------------------------------------------------

# strict=1 is pre-start: the egress network and a stopped, correctly-identified
# connector must already exist. strict=0 is drift enforcement, where the
# connector is expected to be running and may legitimately be absent.
run_all_checks() {
  local strict="${1:-0}" status=0
  # Firewall first: if isolation is not in place nothing else may proceed.
  check_firewall || return 1
  check_edge_topology || status=1
  check_upstream_topology || status=1
  check_egress_topology "$strict" || status=1
  check_connector_membership "$strict" || status=1
  check_token_file || status=1
  return "$status"
}

mode_pre_start() {
  if run_all_checks 1; then
    echo 'S5.5-RUNTIME=PRESTART-OK'
    return 0
  fi
  echo 'S5.5-RUNTIME=PRESTART-REFUSED' >&2
  return 1
}

# Fail-closed watchdog. On drift it stops ONLY the connector service. It never
# stops the gateway, drive, database, monitoring or Twingate, never touches the
# Docker daemon or UFW, and never weakens a firewall rule to "recover".
mode_enforce_drift() {
  if run_all_checks 0; then
    echo 'S5.5-RUNTIME=DRIFT-OK'
    return 0
  fi
  echo 'S5.5-RUNTIME=DRIFT-DETECTED stopping the connector only' >&2
  if ! "$SYSTEMCTL" stop "$CONNECTOR_SERVICE"; then
    # Report the failure rather than escalating to a broader action.
    echo 'S5.5-RUNTIME=DRIFT-STOP-FAILED' >&2
    return 1
  fi
  echo 'S5.5-RUNTIME=DRIFT-CONNECTOR-STOPPED' >&2
  return 1
}

usage() {
  cat <<'USAGE'
usage: s5-5-runtime-check.sh <--pre-start|--enforce-drift>

  --pre-start      exit 0 only when it is safe to start the connector
  --enforce-drift  re-check the invariants; on drift stop ONLY the connector
USAGE
}

main() {
  case "${1:-}" in
    --pre-start) mode_pre_start ;;
    --enforce-drift) mode_enforce_drift ;;
    -h|--help) usage ;;
    *) usage >&2; exit 1 ;;
  esac
}

main "$@"
