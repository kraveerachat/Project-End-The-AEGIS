#!/usr/bin/env bash
# PUBLIC-SHARE-7 S5.5 connector-only rollback.
#
# Removes exactly what S5.5 added, in reverse order, and nothing else:
#
#   1. stop + disable the drift timer (so the watchdog cannot fight the rollback)
#   2. stop + disable the connector service
#   3. stop + remove ONLY the public-share-connector container
#   4. remove the S5.5 firewall policy through s5-5-firewall.sh remove (removes task-owned iptables anchors/chains and bridge aegis_s55_edge table)
#   5. prove aegis_public_share_egress has zero endpoints, then remove it
#
# The accepted S5.4 baseline is preserved: drive, public-share-gateway, the
# database, every volume, the edge/upstream/private networks and all internal
# sharing are untouched. There is deliberately no whole-stack operation here -
# no compose down, no prune of any kind, no volume removal, no recreation of an
# unrelated service, and no control of the Docker daemon or UFW.
#
# Running this against a live host changes Production runtime state and requires
# separate S5.5-F/S5.5-G owner authorization. It performs nothing on its own.
set -euo pipefail

readonly EGRESS_NETWORK='aegis_public_share_egress'
readonly CONNECTOR_SERVICE='aegis-public-share-connector.service'
readonly DRIFT_TIMER='aegis-public-share-drift.timer'
readonly DRIFT_SERVICE='aegis-public-share-drift.service'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DOCKER="${AEGIS_DOCKER_BIN:-docker}"
SYSTEMCTL="${AEGIS_SYSTEMCTL_BIN:-systemctl}"
FIREWALL_SCRIPT="${AEGIS_FIREWALL_SCRIPT:-${SCRIPT_DIR}/s5-5-firewall.sh}"
CONNECTOR_CONTAINER="${AEGIS_CONNECTOR_CONTAINER:-aegis-prod-public-share-connector-1}"

note() { echo "S5.5-ROLLBACK: $*"; }
die() { echo "S5.5-ROLLBACK=FAIL: $*" >&2; exit 1; }

# Already-absent objects are an expected rollback state, not an error, and must
# never be "handled" by reaching for a broader cleanup.
quietly() { "$@" >/dev/null 2>&1 || true; }

# --- 1 + 2: lifecycle -------------------------------------------------------

stop_lifecycle() {
  note 'stopping the drift timer before anything else'
  quietly "$SYSTEMCTL" stop "$DRIFT_TIMER"
  quietly "$SYSTEMCTL" disable "$DRIFT_TIMER"
  quietly "$SYSTEMCTL" stop "$DRIFT_SERVICE"

  note 'stopping the connector service'
  quietly "$SYSTEMCTL" stop "$CONNECTOR_SERVICE"
  quietly "$SYSTEMCTL" disable "$CONNECTOR_SERVICE"
}

# --- 3: connector container only --------------------------------------------

remove_connector_container() {
  if ! "$DOCKER" inspect "$CONNECTOR_CONTAINER" >/dev/null 2>&1; then
    note "connector container ${CONNECTOR_CONTAINER} is already absent"
    return 0
  fi
  note "removing only the connector container ${CONNECTOR_CONTAINER}"
  quietly "$DOCKER" stop "$CONNECTOR_CONTAINER"
  # No -v: S5.5 owns no volume, and none may be destroyed here.
  quietly "$DOCKER" rm "$CONNECTOR_CONTAINER"
}

# --- 4: firewall policy ------------------------------------------------------

remove_firewall_policy() {
  note 'removing the S5.5-owned firewall policy (iptables anchors/chains and bridge aegis_s55_edge table)'
  bash "$FIREWALL_SCRIPT" remove >/dev/null 2>&1 \
    || die 'the S5.5 firewall policy could not be removed cleanly'
}

# --- 5: egress network, only when provably empty -----------------------------

egress_endpoint_count() {
  NETWORK_JSON="$1" node --input-type=commonjs -e '
    const data = JSON.parse(process.env.NETWORK_JSON)
    const net = Array.isArray(data) ? data[0] : data
    process.stdout.write(String(Object.keys(net?.Containers ?? {}).length))
  ' 2>/dev/null
}

remove_egress_network() {
  local json count
  if ! json="$("$DOCKER" network inspect "$EGRESS_NETWORK" 2>/dev/null)" || [ -z "$json" ]; then
    note "network ${EGRESS_NETWORK} is already absent"
    return 0
  fi
  count="$(egress_endpoint_count "$json")"
  [ -n "$count" ] || die "could not determine ${EGRESS_NETWORK} endpoint count"
  if [ "$count" != '0' ]; then
    die "${EGRESS_NETWORK} still has ${count} endpoint(s); refusing to remove it"
  fi
  note "removing ${EGRESS_NETWORK} (0 endpoints confirmed)"
  "$DOCKER" network rm "$EGRESS_NETWORK" >/dev/null 2>&1 \
    || die "failed to remove ${EGRESS_NETWORK}"
}

main() {
  case "${1:-}" in
    ''|--yes) ;;
    -h|--help) echo 'usage: rollback-s5-5.sh [--yes]'; exit 0 ;;
    *) echo "unknown argument: ${1}" >&2; exit 1 ;;
  esac

  stop_lifecycle
  remove_connector_container
  remove_firewall_policy
  remove_egress_network

  note 'the S5.4 gateway, drive, database, volumes and private sharing are untouched'
  echo 'S5.5-ROLLBACK=COMPLETE'
}

main "$@"
