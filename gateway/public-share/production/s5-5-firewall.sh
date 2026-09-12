#!/usr/bin/env bash
# PUBLIC-SHARE-7 S5.5 task-owned firewall tooling.
#
#   s5-5-firewall.sh apply     install the S5.5 isolation policy (idempotent)
#   s5-5-firewall.sh validate   exit 0 only on the complete, undrifted policy
#   s5-5-firewall.sh remove     remove only the S5.5-owned anchors and chains
#
# This script owns exactly two chains, AEGIS-PS-EGRESS and AEGIS-PS-INPUT, and
# two jump anchors, one in DOCKER-USER and one in INPUT. It never flushes
# INPUT, FORWARD, DOCKER-USER, Docker chains or UFW, never sets a builtin
# policy, and never restores a whole ruleset.
#
# Destination endpoints are read from the reviewed cloudflare-endpoints.json
# snapshot and are never embedded here. The edge Linux bridge is resolved at
# runtime from `docker network inspect`, because a Docker network name is NOT a
# Linux interface name and the br-<id> suffix changes if the network is
# recreated. The egress bridge is pinned in Compose via
# com.docker.network.bridge.name, so `aegis-ps-eg` is stable and used directly.
#
# Running this against a live host changes host packet filtering and requires
# root. It performs no Production mutation on its own and is not invoked by the
# repository test suite, which exercises it against a disposable mock.
set -euo pipefail

readonly EGRESS_CHAIN='AEGIS-PS-EGRESS'
readonly INPUT_CHAIN='AEGIS-PS-INPUT'
# Staging chains exist only during a rebuild so the deny boundary never lapses.
readonly EGRESS_STAGE="${EGRESS_CHAIN}-NEW"
readonly INPUT_STAGE="${INPUT_CHAIN}-NEW"

readonly CONNECTOR_EDGE_IP='172.31.240.3/32'
readonly CONNECTOR_EGRESS_IP='172.31.242.2/32'
readonly GATEWAY_EDGE_IP='172.31.240.2/32'
readonly EGRESS_SUBNET='172.31.242.0/29'
readonly GATEWAY_HTTP_PORT='8080'
readonly TUNNEL_PORT='7844'
readonly EDGE_NETWORK='aegis_public_share_edge'
readonly EGRESS_BRIDGE='aegis-ps-eg'
readonly DOCKER_USER_CHAIN='DOCKER-USER'
# Host chains the S5.5 anchors attach to. Both must pre-exist.
readonly REQUIRED_HOST_CHAINS='INPUT DOCKER-USER'
# Compose identity of the connector this firewall isolates.
readonly COMPOSE_PROJECT='aegis-prod'
readonly COMPOSE_SERVICE='public-share-connector'

# Native nftables bridge plane constants
readonly BRIDGE_FAMILY='bridge'
readonly BRIDGE_TABLE='aegis_s55_edge'
readonly BRIDGE_CHAIN='forward'
readonly BRIDGE_OWNER='AEGIS-PUBLIC-SHARE-S5.5'

# Test seams. Defaults are the real tools and the real sysfs path.
IPTABLES="${AEGIS_IPTABLES_BIN:-iptables}"
DOCKER="${AEGIS_DOCKER_BIN:-docker}"
NFT="${AEGIS_NFT_BIN:-nft}"
CONNECTOR_CONTAINER="${AEGIS_CONNECTOR_CONTAINER:-aegis-prod-public-share-connector-1}"
SYSFS_NET="${AEGIS_SYSFS_NET:-/sys/class/net}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ENDPOINTS_FILE="${AEGIS_ENDPOINTS_FILE:-${SCRIPT_DIR}/cloudflare-endpoints.json}"
VERIFY_ENDPOINTS="${SCRIPT_DIR}/verify-cloudflare-endpoints.sh"

die() { echo "S5.5-FIREWALL=FAIL: $*" >&2; exit 1; }

# --- preflight -------------------------------------------------------------

# Read the reviewed allowlist, refusing anything the Task 4 gate rejects.
load_endpoints() {
  [ -r "$ENDPOINTS_FILE" ] || die "allowlist not readable: ${ENDPOINTS_FILE}"
  if [ -x "$VERIFY_ENDPOINTS" ] || [ -r "$VERIFY_ENDPOINTS" ]; then
    bash "$VERIFY_ENDPOINTS" --check-schema "$ENDPOINTS_FILE" >/dev/null \
      || die 'allowlist failed CLOUDFLARE_TRANSPORT_ALLOWLIST verification'
  fi
  local endpoints
  endpoints="$(
    ENDPOINTS_FILE="$ENDPOINTS_FILE" node --input-type=commonjs -e '
      const fs = require("node:fs")
      const data = JSON.parse(fs.readFileSync(process.env.ENDPOINTS_FILE, "utf8"))
      const host32 = /^(\d{1,3}\.){3}\d{1,3}\/32$/
      if (data?.transport?.port !== 7844) throw new Error("port")
      if (JSON.stringify(data?.transport?.protocols) !== JSON.stringify(["tcp"])) throw new Error("proto")
      const list = data.endpoints
      if (!Array.isArray(list) || list.length === 0) throw new Error("empty")
      for (const e of list) if (!host32.test(e)) throw new Error("cidr")
      process.stdout.write(list.join("\n"))
    ' 2>/dev/null
  )" || die 'allowlist is not a verified TCP/7844 /32 endpoint snapshot'
  [ -n "$endpoints" ] || die 'allowlist contains no endpoints'
  printf '%s\n' "$endpoints"
}

# A Docker network name is not an interface name. Resolve the real bridge.
resolve_edge_bridge() {
  local inspect bridge
  inspect="$("$DOCKER" network inspect "$EDGE_NETWORK" 2>/dev/null)" \
    || die "cannot inspect docker network ${EDGE_NETWORK}"
  bridge="$(
    DOCKER_INSPECT="$inspect" node --input-type=commonjs -e '
      const data = JSON.parse(process.env.DOCKER_INSPECT)
      const net = Array.isArray(data) ? data[0] : data
      if (!net) throw new Error("empty inspect")
      const configured = net.Options?.["com.docker.network.bridge.name"]
      if (configured) { process.stdout.write(String(configured)); }
      else {
        const id = String(net.Id ?? "")
        if (id.length < 12) throw new Error("no id")
        process.stdout.write("br-" + id.slice(0, 12))
      }
    ' 2>/dev/null
  )" || die "cannot resolve the Linux bridge for ${EDGE_NETWORK}"
  [ -n "$bridge" ] || die "empty bridge resolution for ${EDGE_NETWORK}"
  require_interface "$bridge"
  printf '%s' "$bridge"
}

require_interface() {
  [ -e "${SYSFS_NET}/$1" ] || die "resolved interface does not exist on this host: $1"
}

# --- rule model ------------------------------------------------------------

# Forwarding policy for connector traffic, in exact order. The two terminal
# DROPs are the isolation boundary: anything not accepted above is denied.
egress_rules() {
  local endpoints="$1" endpoint
  # Return direction ONLY. AEGIS-PS-EGRESS is anchored first in DOCKER-USER, so
  # an unqualified ESTABLISHED,RELATED accept here would authorise forwarding for
  # every unrelated container on the host before Docker and UFW policy is ever
  # consulted. Scoping by DESTINATION keeps the reply path of the connector's own
  # flows working while leaving unrelated traffic to fall through untouched.
  #
  # Scoping by SOURCE would be wrong: an already-established connector flow to an
  # unauthorised destination would then survive a reconciliation instead of
  # hitting the terminal deny below.
  echo "-d ${CONNECTOR_EDGE_IP} -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT"
  echo "-d ${CONNECTOR_EGRESS_IP} -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT"
  echo "-s ${CONNECTOR_EDGE_IP} -d ${GATEWAY_EDGE_IP} -p tcp --dport ${GATEWAY_HTTP_PORT} -j ACCEPT"
  while IFS= read -r endpoint; do
    [ -n "$endpoint" ] || continue
    echo "-s ${CONNECTOR_EGRESS_IP} -d ${endpoint} -p tcp --dport ${TUNNEL_PORT} -j ACCEPT"
  done <<< "$endpoints"
  # No DNS exception is granted here. The Production resolver path must be
  # measured and reconciled before S5.5-F activation.
  echo "-s ${CONNECTOR_EDGE_IP} -j DROP"
  echo "-s ${CONNECTOR_EGRESS_IP} -j DROP"
}

# Host INPUT guard: nothing from either connector address may reach ANY
# host-local listener, on the connector bridges or any other interface. The
# enforcement is the generic source-based deny, not an inventory of
# destinations; measured listeners (host SSH/HTTP/HTTPS, the service on the
# default docker bridge, and the resolver stubs) are acceptance evidence only,
# and the guard holds equally for anything that starts listening later.
#
# S5.5 owns the egress network outright, so host INPUT from that whole bridge is
# denied. The edge network is shared with the S5.4 gateway, so only the
# connector address is denied there and accepted S5.4 behaviour is untouched.
# The last two rules are interface-independent, so the guard still holds if the
# connector ever appears on an unexpected interface.
#
# The egress bridge is a designed future interface: aegis_public_share_egress
# does not exist on Production yet. The measured edge and upstream bridges carry
# no IPv4 host address (internal, gateway_mode_ipv4=isolated), so these rules are
# a forward-looking guard rather than a description of current host routing.
#
# No DNS exception is granted. Host resolver configuration has been measured
# (systemd-resolved stubs with public uplinks), but the connector/container DNS
# path has NOT been measured, so every connector DNS query stays denied until
# that path is measured and reconciled before S5.5-F activation.
input_rules() {
  local edge_bridge="$1"
  echo "-i ${edge_bridge} -s ${CONNECTOR_EDGE_IP} -j DROP"
  echo "-i ${EGRESS_BRIDGE} -s ${CONNECTOR_EGRESS_IP} -j DROP"
  echo "-i ${EGRESS_BRIDGE} -s ${EGRESS_SUBNET} -j DROP"
  echo "-s ${CONNECTOR_EDGE_IP} -j DROP"
  echo "-s ${CONNECTOR_EGRESS_IP} -j DROP"
}

# --- pre-mutation safety ----------------------------------------------------

# Production runs iptables-nft. Writing into an unexpected backend would appear
# to succeed while the rules are never consulted, so refuse before mutating.
require_nft_backend() {
  local version
  version="$("$IPTABLES" --version 2>/dev/null)" \
    || die 'cannot determine the iptables backend'
  case "$version" in
    *nf_tables*) ;;
    *) die "expected the nf_tables iptables backend, found: ${version}" ;;
  esac
}

# The anchors have nowhere to go without these. Checked before any chain is
# created, flushed or inserted, so a partial policy is never left behind.
require_host_chains() {
  local chain
  for chain in $REQUIRED_HOST_CHAINS; do
    chain_exists "$chain" \
      || die "required host chain ${chain} is absent; refusing to mutate"
  done
}

require_nft_bridge_support() {
  command -v "$NFT" >/dev/null 2>&1 \
    || die 'nft CLI is required for S5.5 edge-bridge isolation'
  "$NFT" list tables >/dev/null 2>&1 \
    || die 'cannot inspect nftables ruleset'
}

# --- chain primitives ------------------------------------------------------

chain_exists() { "$IPTABLES" -S "$1" >/dev/null 2>&1; }

chain_rules() {
  "$IPTABLES" -S "$1" 2>/dev/null | sed -n "s|^-A $1 ||p"
}

ensure_chain() { chain_exists "$1" || "$IPTABLES" -N "$1"; }

drop_chain() {
  if chain_exists "$1"; then
    "$IPTABLES" -F "$1"
    "$IPTABLES" -X "$1"
  fi
}

fill_chain() {
  local chain="$1" rules="$2" rule
  while IFS= read -r rule; do
    [ -n "$rule" ] || continue
    # shellcheck disable=SC2086 # rule is a deliberate argument vector
    "$IPTABLES" -A "$chain" $rule
  done <<< "$rules"
}

anchor_count() {
  chain_rules "$1" | grep -cxF -- "-j $2" || true
}

anchor_index() {
  chain_rules "$1" | grep -nxF -- "-j $2" | head -1 | cut -d: -f1
}

ensure_anchor_first() {
  local host_chain="$1" target="$2"
  while [ "$(anchor_count "$host_chain" "$target")" -gt 0 ]; do
    "$IPTABLES" -D "$host_chain" -j "$target"
  done
  "$IPTABLES" -I "$host_chain" 1 -j "$target"
}

remove_anchor() {
  local host_chain="$1" target="$2"
  while [ "$(anchor_count "$host_chain" "$target")" -gt 0 ]; do
    "$IPTABLES" -D "$host_chain" -j "$target"
  done
}

# Rebuild a live chain without ever leaving connector traffic unrestricted.
# A fully populated staging chain, terminal DROPs included, is anchored ahead
# of the existing anchor before the real chain is flushed, so the deny boundary
# is continuous. On a first install the chain is not yet anchored and there is
# nothing to cover.
rebuild_chain() {
  local chain="$1" stage="$2" host_chain="$3" rules="$4"
  if chain_exists "$chain" && [ "$(anchor_count "$host_chain" "$chain")" -gt 0 ]; then
    drop_chain "$stage"
    "$IPTABLES" -N "$stage"
    fill_chain "$stage" "$rules"
    "$IPTABLES" -I "$host_chain" 1 -j "$stage"
    "$IPTABLES" -F "$chain"
    fill_chain "$chain" "$rules"
    ensure_anchor_first "$host_chain" "$chain"
    remove_anchor "$host_chain" "$stage"
    drop_chain "$stage"
  else
    ensure_chain "$chain"
    "$IPTABLES" -F "$chain"
    fill_chain "$chain" "$rules"
    ensure_anchor_first "$host_chain" "$chain"
  fi
}

# Tearing down isolation while the connector is still running would leave it
# briefly unfiltered, so removal is refused until the connector is inactive.
#
# This guard REFUSES; it never stops a container itself. Stopping the connector
# is the job of systemd (the connector unit BindsTo/After this one, so it stops
# first) and of rollback-s5-5.sh. A firewall script that could stop workloads
# would be a far larger blast radius than this one is allowed to have.
#
# Anything that is not positively identified as "the connector is absent" or
# "the connector is inactive" fails closed.
require_connector_inactive() {
  local out rc state
  out="$("$DOCKER" inspect "$CONNECTOR_CONTAINER" 2>&1)" && rc=0 || rc=$?
  if [ "${rc}" -ne 0 ]; then
    case "$out" in
      *'No such object'*|*'No such container'*)
        # Already rolled back or never created: removal is safe.
        return 0 ;;
      *)
        die 'cannot determine connector state; refusing to remove S5.5 isolation' ;;
    esac
  fi

  state="$(CONTAINER_JSON="$out" node --input-type=commonjs -e '
    try {
      const data = JSON.parse(process.env.CONTAINER_JSON)
      const c = Array.isArray(data) ? data[0] : data
      const s = c?.State ?? {}
      const labels = c?.Config?.Labels ?? {}
      process.stdout.write([
        labels["com.docker.compose.project"] ?? "",
        labels["com.docker.compose.service"] ?? "",
        s.Status ?? "unknown",
        s.Running === true, s.Restarting === true, s.Paused === true,
      ].join("|"))
    } catch { process.exit(1) }
  ' 2>/dev/null)" || die 'unreadable connector state; refusing to remove S5.5 isolation'

  local project service status running restarting paused
  IFS='|' read -r project service status running restarting paused <<< "$state"

  # An object EXISTS at the connector's name. If it does not carry the exact
  # Compose identity then we cannot account for what is there, and tearing down
  # isolation on the strength of an unrecognised object would be fail-open.
  # Refuse and let a human resolve the anomaly.
  if [ "$project" != "$COMPOSE_PROJECT" ] || [ "$service" != "$COMPOSE_SERVICE" ]; then
    die "object at ${CONNECTOR_CONTAINER} does not carry the expected Compose identity (${COMPOSE_PROJECT}/${COMPOSE_SERVICE}); refusing to remove S5.5 isolation"
  fi

  if [ "$running" = 'true' ] || [ "$restarting" = 'true' ] || [ "$paused" = 'true' ]; then
    die "connector is active (${status}); stop it before removing S5.5 isolation"
  fi
  # Only positively safe stopped states permit teardown. 'dead', 'removing' and
  # anything unrecognised are indeterminate, not safe, so they refuse.
  case "$status" in
    created|exited) return 0 ;;
    *) die "connector state '${status}' is not a positively safe stopped state; refusing to remove isolation" ;;
  esac
}

# --- bridge primitives -----------------------------------------------------

bridge_table_exists() {
  "$NFT" list table "$BRIDGE_FAMILY" "$BRIDGE_TABLE" >/dev/null 2>&1
}

require_bridge_table_owned() {
  if ! bridge_table_exists; then
    return 0
  fi
  local text
  text="$("$NFT" list table "$BRIDGE_FAMILY" "$BRIDGE_TABLE" 2>/dev/null)" \
    || die "cannot inspect pre-existing table ${BRIDGE_FAMILY} ${BRIDGE_TABLE}"
  case "$text" in
    *"${BRIDGE_OWNER}"*) ;;
    *) die "pre-existing table ${BRIDGE_FAMILY} ${BRIDGE_TABLE} is unowned by S5.5; refusing to mutate" ;;
  esac
  case "$text" in
    *"chain ${BRIDGE_CHAIN}"*) ;;
    *) die "pre-existing table ${BRIDGE_FAMILY} ${BRIDGE_TABLE} lacks expected chain ${BRIDGE_CHAIN}; refusing to mutate" ;;
  esac
}

bridge_candidate() {
  local edge_bridge="$1"
  if bridge_table_exists; then
    echo "delete table ${BRIDGE_FAMILY} ${BRIDGE_TABLE}"
  fi
  # In the bridge forward hook a frame's iifname/oifname are the veth bridge
  # PORTS it enters and leaves on. The policy binds to the Docker bridge MASTER,
  # so the bridge-master selectors ibrname/obrname are required; iifname/oifname
  # keyed on the master name never match a forwarded frame.
  cat <<NFT
table ${BRIDGE_FAMILY} ${BRIDGE_TABLE} {
  comment "${BRIDGE_OWNER}"
  chain ${BRIDGE_CHAIN} {
    type filter hook forward priority 0; policy accept;

    ibrname "${edge_bridge}" obrname "${edge_bridge}" ether type ip ip saddr 172.31.240.3 ip daddr 172.31.240.2 tcp dport 8080 counter accept comment "AEGIS-S55 edge connector-to-gateway-http"

    ibrname "${edge_bridge}" obrname "${edge_bridge}" ether type ip ip saddr 172.31.240.2 ip daddr 172.31.240.3 tcp sport 8080 counter accept comment "AEGIS-S55 edge gateway-http-return"

    ibrname "${edge_bridge}" ether type ip ip saddr 172.31.240.3 counter drop comment "AEGIS-S55 edge connector-source-deny"

    obrname "${edge_bridge}" ether type ip ip daddr 172.31.240.3 counter drop comment "AEGIS-S55 edge connector-destination-deny"
  }
}
NFT
}

# The candidate file is cleaned up on every exit path, including die().
BRIDGE_CANDIDATE_FILE=''
cleanup_bridge_candidate() {
  if [ -n "$BRIDGE_CANDIDATE_FILE" ]; then
    rm -f "$BRIDGE_CANDIDATE_FILE"
    BRIDGE_CANDIDATE_FILE=''
  fi
  return 0
}

# Spec 7.1 step 4: build and no-commit-check the bridge candidate, and prove
# ownership of any pre-existing owned table, BEFORE anything is mutated.
#
# Spec 9 requires that a preflight or candidate-check failure performs no new
# mutation at all. Doing this inside the commit step would have meant a rejected
# candidate still left the iptables plane rebuilt - a partial policy on a host
# that was supposed to be untouched.
bridge_prepare() {
  local edge_bridge="$1"
  require_bridge_table_owned
  BRIDGE_CANDIDATE_FILE="$(mktemp "${TMPDIR:-/tmp}/aegis-nft-XXXXXX.nft")"
  chmod 0600 "$BRIDGE_CANDIDATE_FILE"
  bridge_candidate "$edge_bridge" > "$BRIDGE_CANDIDATE_FILE"
  "$NFT" --check -f "$BRIDGE_CANDIDATE_FILE" \
    || die 'native bridge candidate failed nft --check'
}

# Single atomic batch commit of the already-validated candidate.
bridge_commit() {
  [ -n "$BRIDGE_CANDIDATE_FILE" ] \
    || die 'internal error: no prepared bridge candidate to commit'
  "$NFT" -f "$BRIDGE_CANDIDATE_FILE" \
    || die 'native bridge firewall transaction failed'
  cleanup_bridge_candidate
}

bridge_validate() {
  local edge_bridge="$1" json
  bridge_table_exists || { echo "missing table ${BRIDGE_FAMILY} ${BRIDGE_TABLE}" >&2; return 1; }
  json="$("$NFT" -j list table "$BRIDGE_FAMILY" "$BRIDGE_TABLE" 2>/dev/null)" \
    || { echo "cannot export JSON for table ${BRIDGE_FAMILY} ${BRIDGE_TABLE}" >&2; return 1; }

  EDGE_BRIDGE="$edge_bridge" NFT_JSON="$json" node --input-type=commonjs -e '
    const edgeBridge = process.env.EDGE_BRIDGE
    let data
    try {
      data = JSON.parse(process.env.NFT_JSON)
    } catch {
      console.error("cannot parse nft JSON")
      process.exit(1)
    }
    const list = data?.nftables
    if (!Array.isArray(list)) {
      console.error("nftables property is not an array")
      process.exit(1)
    }
    const tables = list.filter(x => x.table)
    if (tables.length !== 1) {
      console.error("expected exactly 1 table, found " + tables.length)
      process.exit(1)
    }
    const t = tables[0].table
    if (t.family !== "bridge" || t.name !== "aegis_s55_edge" || t.comment !== "AEGIS-PUBLIC-SHARE-S5.5") {
      console.error("table attributes drifted: " + JSON.stringify(t))
      process.exit(1)
    }
    const chains = list.filter(x => x.chain)
    if (chains.length !== 1) {
      console.error("expected exactly 1 chain, found " + chains.length)
      process.exit(1)
    }
    const c = chains[0].chain
    if (c.family !== "bridge" || c.table !== "aegis_s55_edge" || c.name !== "forward" ||
        c.type !== "filter" || c.hook !== "forward" || (c.prio !== 0 && c.priority !== 0) ||
        c.policy !== "accept") {
      console.error("chain attributes drifted: " + JSON.stringify(c))
      process.exit(1)
    }
    const rules = list.filter(x => x.rule).map(x => x.rule)
    if (rules.length !== 4) {
      console.error("expected exactly 4 rules in forward chain, found " + rules.length)
      process.exit(1)
    }

    function parseExpr(exprs) {
      const res = { ibrname: null, obrname: null, iifname: null, oifname: null, etherType: null, saddr: null, daddr: null, dport: null, sport: null, action: null }
      for (const e of (exprs || [])) {
        if (e.accept !== undefined) res.action = "accept"
        if (e.drop !== undefined) res.action = "drop"
        if (e.match) {
          const { left, right } = e.match
          if (left?.meta?.key === "ibrname") res.ibrname = right
          if (left?.meta?.key === "obrname") res.obrname = right
          if (left?.meta?.key === "iifname") res.iifname = right
          if (left?.meta?.key === "oifname") res.oifname = right
          if (left?.payload?.protocol === "ether" && left?.payload?.field === "type") res.etherType = right
          if (left?.payload?.protocol === "ip" && left?.payload?.field === "saddr") res.saddr = right
          if (left?.payload?.protocol === "ip" && left?.payload?.field === "daddr") res.daddr = right
          if (left?.payload?.protocol === "tcp" && left?.payload?.field === "dport") res.dport = Number(right)
          if (left?.payload?.protocol === "tcp" && left?.payload?.field === "sport") res.sport = Number(right)
        }
      }
      if (res.etherType === null && (res.saddr !== null || res.daddr !== null)) {
        res.etherType = "ip"
      }
      return res
    }
    // The canonical policy binds bridge MASTERS only. A bridge-PORT selector on
    // any rule - alone (the pre-correction shape that matched nothing) or mixed
    // with a master selector - is an ambiguous representation and is drift.
    for (let i = 0; i < rules.length; i++) {
      const p = parseExpr(rules[i].expr)
      if (p.iifname !== null || p.oifname !== null) {
        console.error("rule " + i + " drifted: bridge-port selector iifname/oifname is not the bridge-master policy: " + JSON.stringify(rules[i]))
        process.exit(1)
      }
    }

    const r0 = parseExpr(rules[0].expr)
    if (rules[0].comment !== "AEGIS-S55 edge connector-to-gateway-http" ||
        r0.action !== "accept" || r0.ibrname !== edgeBridge || r0.obrname !== edgeBridge ||
        r0.etherType !== "ip" || r0.saddr !== "172.31.240.3" || r0.daddr !== "172.31.240.2" ||
        r0.dport !== 8080) {
      console.error("rule 0 drifted: " + JSON.stringify(rules[0]))
      process.exit(1)
    }

    const r1 = parseExpr(rules[1].expr)
    if (rules[1].comment !== "AEGIS-S55 edge gateway-http-return" ||
        r1.action !== "accept" || r1.ibrname !== edgeBridge || r1.obrname !== edgeBridge ||
        r1.etherType !== "ip" || r1.saddr !== "172.31.240.2" || r1.daddr !== "172.31.240.3" ||
        r1.sport !== 8080) {
      console.error("rule 1 drifted: " + JSON.stringify(rules[1]))
      process.exit(1)
    }

    const r2 = parseExpr(rules[2].expr)
    if (rules[2].comment !== "AEGIS-S55 edge connector-source-deny" ||
        r2.action !== "drop" || r2.ibrname !== edgeBridge || r2.obrname !== null ||
        r2.etherType !== "ip" || r2.saddr !== "172.31.240.3") {
      console.error("rule 2 drifted: " + JSON.stringify(rules[2]))
      process.exit(1)
    }

    const r3 = parseExpr(rules[3].expr)
    if (rules[3].comment !== "AEGIS-S55 edge connector-destination-deny" ||
        r3.action !== "drop" || r3.obrname !== edgeBridge || r3.ibrname !== null ||
        r3.etherType !== "ip" || r3.daddr !== "172.31.240.3") {
      console.error("rule 3 drifted: " + JSON.stringify(rules[3]))
      process.exit(1)
    }
  ' || { echo "native bridge validation failed for table ${BRIDGE_TABLE}" >&2; return 1; }
  return 0
}

bridge_remove() {
  if ! bridge_table_exists; then
    return 0
  fi
  require_bridge_table_owned
  "$NFT" delete table "$BRIDGE_FAMILY" "$BRIDGE_TABLE" \
    || die "failed to delete table ${BRIDGE_FAMILY} ${BRIDGE_TABLE}"
}

# --- subcommands -----------------------------------------------------------

cmd_apply() {
  local endpoints edge_bridge egress input
  # Resolve and validate everything before touching a single rule.
  require_nft_backend
  require_host_chains
  require_nft_bridge_support
  endpoints="$(load_endpoints)"
  edge_bridge="$(resolve_edge_bridge)"
  require_interface "$EGRESS_BRIDGE"
  egress="$(egress_rules "$endpoints")"
  input="$(input_rules "$edge_bridge")"

  # Candidate check and ownership gate first: a rejected candidate must leave
  # BOTH enforcement planes untouched.
  bridge_prepare "$edge_bridge"

  rebuild_chain "$EGRESS_CHAIN" "$EGRESS_STAGE" "$DOCKER_USER_CHAIN" "$egress"
  rebuild_chain "$INPUT_CHAIN" "$INPUT_STAGE" 'INPUT' "$input"
  bridge_commit
  echo "S5.5-FIREWALL=APPLIED (edge bridge ${edge_bridge}, $(printf '%s\n' "$endpoints" | grep -c .) endpoints, native bridge table ${BRIDGE_TABLE})"
}

# iptables-nft re-serializes a few semantically equivalent forms when rules are
# read back with `iptables -S`. Keep validation strict by normalizing ONLY the
# transformations observed from the approved rule grammar; rule order, unknown
# matches/options, addresses, ports, protocols and targets remain byte-significant.
canonicalize_rules() {
  sed -E \
    -e 's/--ctstate RELATED,ESTABLISHED/--ctstate ESTABLISHED,RELATED/g' \
    -e 's/-p tcp -m tcp /-p tcp /g' \
    -e 's/^-s ([^ ]+) -i ([^ ]+) /-i \2 -s \1 /'
}

expect_chain() {
  local chain="$1" expected="$2" actual expected_canonical actual_canonical
  chain_exists "$chain" || { echo "missing chain ${chain}" >&2; return 1; }
  actual="$(chain_rules "$chain")"
  expected_canonical="$(printf '%s\n' "$expected" | canonicalize_rules)"
  actual_canonical="$(printf '%s\n' "$actual" | canonicalize_rules)"
  if [ "$actual_canonical" != "$expected_canonical" ]; then
    echo "drifted chain ${chain}" >&2
    return 1
  fi
  return 0
}

expect_anchor_first() {
  local host_chain="$1" target="$2" count index
  count="$(anchor_count "$host_chain" "$target")"
  [ "$count" -eq 1 ] || { echo "expected exactly one ${target} anchor in ${host_chain}, found ${count}" >&2; return 1; }
  index="$(anchor_index "$host_chain" "$target")"
  [ "$index" = "1" ] || { echo "${target} anchor must be first in ${host_chain}, found at ${index}" >&2; return 1; }
  return 0
}

cmd_validate() {
  local endpoints edge_bridge status=0 egress
  # pre-start treats a successful validate as its firewall safety gate, so a
  # validate that passed on the wrong backend would let the connector start
  # against rules nothing consults. validate performs no mutation.
  require_nft_backend
  require_host_chains
  require_nft_bridge_support
  endpoints="$(load_endpoints)"
  edge_bridge="$(resolve_edge_bridge)"
  require_interface "$EGRESS_BRIDGE"

  expect_chain "$EGRESS_CHAIN" "$(egress_rules "$endpoints")" || status=1
  expect_chain "$INPUT_CHAIN" "$(input_rules "$edge_bridge")" || status=1
  expect_anchor_first "$DOCKER_USER_CHAIN" "$EGRESS_CHAIN" || status=1
  expect_anchor_first 'INPUT' "$INPUT_CHAIN" || status=1
  bridge_validate "$edge_bridge" || status=1

  # Explicit negative scans, so a reviewer sees why a drifted chain failed.
  if chain_exists "$EGRESS_CHAIN"; then
    egress="$(chain_rules "$EGRESS_CHAIN")"
    if grep -qE -- '--dport 443\b' <<< "$egress"; then echo 'TCP/443 is allowed' >&2; status=1; fi
    if grep -qE -- '-p udp' <<< "$egress"; then echo 'UDP is allowed' >&2; status=1; fi
    if grep -qE -- '-d 0\.0\.0\.0/0.*ACCEPT' <<< "$egress"; then echo 'broad destination allowed' >&2; status=1; fi
    if ! grep -qxF -- "-s ${CONNECTOR_EDGE_IP} -j DROP" <<< "$egress"; then echo 'missing edge terminal deny' >&2; status=1; fi
    if ! grep -qxF -- "-s ${CONNECTOR_EGRESS_IP} -j DROP" <<< "$egress"; then echo 'missing egress terminal deny' >&2; status=1; fi
  fi
  # Staging chains must never survive a completed apply.
  if chain_exists "$EGRESS_STAGE" || chain_exists "$INPUT_STAGE"; then
    echo 'a staging chain survived; the last apply did not complete' >&2
    status=1
  fi

  if [ "$status" -eq 0 ]; then
    echo 'S5.5-FIREWALL=VALID'
  else
    echo 'S5.5-FIREWALL=INVALID' >&2
  fi
  return "$status"
}

cmd_remove() {
  # Refuse before touching anything if the connector is still active.
  require_connector_inactive
  bridge_remove
  # Remove only what S5.5 owns. Unrelated anchors, chains, Docker chains, UFW
  # chains and builtin policies are left exactly as they are.
  remove_anchor "$DOCKER_USER_CHAIN" "$EGRESS_CHAIN"
  remove_anchor "$DOCKER_USER_CHAIN" "$EGRESS_STAGE"
  remove_anchor 'INPUT' "$INPUT_CHAIN"
  remove_anchor 'INPUT' "$INPUT_STAGE"
  drop_chain "$EGRESS_STAGE"
  drop_chain "$INPUT_STAGE"
  drop_chain "$EGRESS_CHAIN"
  drop_chain "$INPUT_CHAIN"
  echo 'S5.5-FIREWALL=REMOVED'
}

usage() {
  cat <<'USAGE'
usage: s5-5-firewall.sh <apply|validate|remove>

  apply     install the S5.5 isolation policy (idempotent)
  validate  exit 0 only on the complete, undrifted policy
  remove    remove only the S5.5-owned anchors and chains
USAGE
}

main() {
  local subcommand="${1:-}"
  case "$subcommand" in
    apply|validate|remove)
      if [ "${2:-}" = '--help' ]; then usage; exit 0; fi
      "cmd_${subcommand}"
      ;;
    -h|--help|help) usage ;;
    '') usage >&2; exit 1 ;;
    *) echo "unknown subcommand: ${subcommand}" >&2; usage >&2; exit 1 ;;
  esac
}

trap cleanup_bridge_candidate EXIT

main "$@"
