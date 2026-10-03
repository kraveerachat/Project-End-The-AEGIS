# shellcheck shell=bash
# AEGIS IDEA3 PR11 Phase 4 — PRE-L8p NTP RUNTIME REACTIVATION gate library (task package: pre-l8p-ntp-runtime-reactivation).
# Sourced by reactivation/pre-l8p-ntp-runtime-reactivation/{apply,verify,rollback}.sh and owner-run/run-pre-l8p-ntp-runtime-reactivation-owner.sh.
# Nothing here runs on its own and nothing here mutates the host: every function is a read-only check. A check returns 0 on PASS; on FAIL it prints one stable
# reason line to stderr and returns 1. Commands are resolved from PATH so tests can stub them.
#
# Why this package exists: L5 (historical, LIVE-PROVEN, unchanged) deliberately mutated RUNTIME ActiveState only (stop systemd-timesyncd, start chronyd) and never
# enabled/disabled either unit. After a reboot the host is therefore back at timesyncd active/enabled, chronyd inactive/disabled and no UDP/123 listener — exactly
# what that design predicts, and a K12 (automatic reboot persistence) NOT_PROVEN state. L8p needs the AP NTP server again. This package restores ONLY that runtime
# handoff. It is NOT an L5 rerun, NOT L5 acceptance, NOT K12 proof, NOT persistent enablement, NOT L8p.

NTPREACT_TASK_ID="PRE_L8P_NTP_RUNTIME_REACTIVATION"
NTPREACT_STAGE_NAME="pre-l8p-ntp-runtime-reactivation"
NTPREACT_MARKER_NAME="PRE-L8P-NTP-RUNTIME-REACTIVATION-ATTEMPT-CONSUMED"
# The p4-stage-gate.sh knows no stage name for this task, so the records say stage=L5 (the NTP stage); the EXACT scope string below is what binds an Authorization
# to THIS successor. Historical L5 records are dated 2026-09-25 (same-day gate), carry a different scope, and their reference (below) is explicitly refused.
NTPREACT_EXPECTED_SCOPE="PRE_L8P_NTP_RUNTIME_REACTIVATION: systemctl stop systemd-timesyncd.service then start chronyd.service only; no enable, disable, config, network, AP, dnsmasq, broker, Core or ESP32 change"
NTPREACT_HISTORICAL_L5_REFERENCE_ID="5833985188"   # PR #215 owner comment of the consumed L5 Attempt #4 — never reusable

NTPREACT_AP_IF="wlp0s20f3"
NTPREACT_AP_ADDR="10.77.30.1"
NTPREACT_AP_CIDR="10.77.30.1/28"
NTPREACT_AP_SUBNET="10.77.30.0/28"
NTPREACT_CHRONY_CONF="/etc/chrony.conf"
# SHA-256 of the rendered L5 runtime configuration (L5 live acceptance receipt: server 2.arch.pool.ntp.org iburst / bindaddress 10.77.30.1 / allow 10.77.30.0/28 / rtcsync).
NTPREACT_CHRONY_CONF_SHA256="20e283e4616fadeb3f2ae9438b17e3351b7af354844a911038a47089af3a35fe"
NTPREACT_CHRONY_CONF_MODE_OWNER="640:0:0"   # mode:uid:gid, as left by the L5 apply handler
NTPREACT_MAXERROR_BOUND_US=1000000          # the L5 acceptance bound (aegis_soc.trusted_time.MAX_ERROR_US), shared via p4-l5-clock.py
NTPREACT_LOGS_REL="Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs"
_NTPREACT_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ntpreact_reason() { printf '%s\n' "$1" >&2; return 1; }

# ── unit state ─────────────────────────────────────────────────────────────────────────────────────────────────────────
# ntpreact_unit_prop UNIT KEY — one `systemctl show` property value (empty when unreadable).
ntpreact_unit_prop() { systemctl show -p "$2" --value "$1" 2>/dev/null; }

# ntpreact_unit_expect UNIT LOAD ACTIVE SUB UNITFILE — exact LoadState/ActiveState/SubState/UnitFileState (Result must be success when the unit is not running).
ntpreact_unit_expect() {
  local unit=$1 want_load=$2 want_active=$3 want_sub=$4 want_ufs=$5 got
  got=$(ntpreact_unit_prop "$unit" LoadState);     [ "$got" = "$want_load" ]   || { ntpreact_reason "NTPREACT_UNIT_STATE_MISMATCH:$unit.LoadState=${got:-UNREADABLE}"; return 1; }
  got=$(ntpreact_unit_prop "$unit" ActiveState);   [ "$got" = "$want_active" ] || { ntpreact_reason "NTPREACT_UNIT_STATE_MISMATCH:$unit.ActiveState=${got:-UNREADABLE}"; return 1; }
  got=$(ntpreact_unit_prop "$unit" SubState);      [ "$got" = "$want_sub" ]    || { ntpreact_reason "NTPREACT_UNIT_STATE_MISMATCH:$unit.SubState=${got:-UNREADABLE}"; return 1; }
  got=$(ntpreact_unit_prop "$unit" UnitFileState); [ "$got" = "$want_ufs" ]    || { ntpreact_reason "NTPREACT_UNIT_STATE_MISMATCH:$unit.UnitFileState=${got:-UNREADABLE}"; return 1; }
}

# ntpreact_pre_units_gate — the exact approved PRE runtime baseline (the post-reboot L5 shape). UnitFileState is asserted here and again, unchanged, in verify.
ntpreact_pre_units_gate() {
  ntpreact_unit_expect systemd-timesyncd.service loaded active running enabled || return 1
  ntpreact_unit_expect chronyd.service loaded inactive dead disabled || return 1
  [ "$(ntpreact_unit_prop chronyd.service Result)" = success ] || { ntpreact_reason "NTPREACT_UNIT_STATE_MISMATCH:chronyd.service.Result=$(ntpreact_unit_prop chronyd.service Result)"; return 1; }
}

# ── AP address ─────────────────────────────────────────────────────────────────────────────────────────────────────────
# ntpreact_ap_gate — wlp0s20f3 carries exactly one IPv4 address and it is exactly 10.77.30.1/28.
ntpreact_ap_gate() {
  local out
  out=$(ip -4 -o addr show dev "$NTPREACT_AP_IF" 2>/dev/null | awk '{ print $4 }') || out=""
  [ -n "$out" ] || { ntpreact_reason "NTPREACT_AP_ADDRESS_MISSING:$NTPREACT_AP_IF"; return 1; }
  [ "$out" = "$NTPREACT_AP_CIDR" ] || { ntpreact_reason "NTPREACT_AP_ADDRESS_MISMATCH:$(printf '%s' "$out" | paste -sd,)"; return 1; }
}

# ── /etc/chrony.conf authority ─────────────────────────────────────────────────────────────────────────────────────────
# ntpreact_conf_gate — regular non-symlink file, approved mode/owner, SHA-256 equal to the approved rendered L5 config, exactly the four approved active directives.
ntpreact_conf_gate() {
  local conf=$NTPREACT_CHRONY_CONF active
  [ -L "$conf" ] && { ntpreact_reason "NTPREACT_CHRONY_CONF_IS_SYMLINK"; return 1; }
  [ -f "$conf" ] || { ntpreact_reason "NTPREACT_CHRONY_CONF_MISSING"; return 1; }
  [ "$(stat -c %a:%u:%g "$conf")" = "$NTPREACT_CHRONY_CONF_MODE_OWNER" ] || { ntpreact_reason "NTPREACT_CHRONY_CONF_MODE_OWNER_MISMATCH"; return 1; }
  [ "$(sha256sum "$conf" | awk '{ print $1 }')" = "$NTPREACT_CHRONY_CONF_SHA256" ] || { ntpreact_reason "NTPREACT_CHRONY_CONF_NOT_APPROVED_L5_CONTENT"; return 1; }
  active=$(grep -v '^[[:space:]]*#' "$conf" | grep -v '^[[:space:]]*$' || true)
  [ "$active" = "$(printf 'server 2.arch.pool.ntp.org iburst\nbindaddress %s\nallow %s\nrtcsync' "$NTPREACT_AP_ADDR" "$NTPREACT_AP_SUBNET")" ] \
    || { ntpreact_reason "NTPREACT_CHRONY_CONF_DIRECTIVES_NOT_APPROVED"; return 1; }
}

# ntpreact_conf_meta — mode:uid:gid:size:mtime of the config (evidence for the PRE==POST proof).
ntpreact_conf_meta() { stat -c %a:%u:%g:%s:%Y "$NTPREACT_CHRONY_CONF"; }

# ntpreact_alt_config_gate — chronyd.service must read /etc/chrony.conf: no `-f <other>` anywhere in ExecStart (drop-ins included, as systemd merges them),
# Environment or any EnvironmentFile. Read-only (`systemctl show`, `cat`).
ntpreact_alt_config_gate() {
  local text envfiles entry path tok bad=0
  text=$(systemctl show -p ExecStart -p Environment chronyd.service 2>/dev/null) || { ntpreact_reason "NTPREACT_CHRONYD_UNIT_UNREADABLE"; return 1; }
  envfiles=$(systemctl show -p EnvironmentFiles --value chronyd.service 2>/dev/null || true)
  for entry in $envfiles; do
    path=${entry#-}
    [ -f "$path" ] && text="$text"$'\n'"$(cat -- "$path" 2>/dev/null || true)"
  done
  while IFS= read -r tok; do
    [ "$tok" = "$NTPREACT_CHRONY_CONF" ] || bad=1   # an empty token (a bare -f) is as unproven as any other path
  done < <(grep -oE '(^|[[:space:]=])-f[[:space:]]*[^[:space:];}]*' <<< "$text" | sed -E 's/^[[:space:]=]*-f[[:space:]]*//')
  [ "$bad" = 0 ] || { ntpreact_reason "NTPREACT_CHRONYD_ALTERNATE_CONFIG_PATH"; return 1; }
}

# ── listeners ──────────────────────────────────────────────────────────────────────────────────────────────────────────
# ntpreact_listeners — "<proto> <addr:port>" lines for every listening TCP/UDP socket.
ntpreact_listeners() { ss -H -ltnu 2>/dev/null | awk 'NF >= 5 { print $1 " " $5 }'; }

# ntpreact_no_ntp_listener_gate — nothing listens on port 123 (any protocol, any address) before apply.
ntpreact_no_ntp_listener_gate() {
  local proto addr_port hit=""
  while read -r proto addr_port; do
    [ -n "$addr_port" ] || continue
    [ "${addr_port##*:}" = 123 ] && hit="$hit $proto/$addr_port"
  done < <(ntpreact_listeners)
  [ -z "$hit" ] || { ntpreact_reason "NTPREACT_NTP_LISTENER_PRESENT_BEFORE_APPLY:${hit# }"; return 1; }
}

# ntpreact_listener_exact_gate — AFTER apply: exactly one port-123 listener, udp 10.77.30.1:123; a wildcard, a TCP or any other address is refused; port 323 is
# udp loopback only (chronyd's command port).
ntpreact_listener_exact_gate() {
  local proto addr_port addr port found=0
  while read -r proto addr_port; do
    [ -n "$addr_port" ] || continue
    addr=${addr_port%:*}; port=${addr_port##*:}
    if [ "$port" = 123 ]; then
      [ "$proto" = udp ] || { ntpreact_reason "TCP_NTP_LISTENER_FORBIDDEN"; return 1; }
      [[ "$addr" =~ ^(0\.0\.0\.0|\[::\]|::|\*)$ ]] && { ntpreact_reason "WILDCARD_NTP_LISTENER_FORBIDDEN"; return 1; }
      [ "$addr" = "$NTPREACT_AP_ADDR" ] || { ntpreact_reason "NON_AP_NTP_LISTENER_FORBIDDEN:$addr"; return 1; }
      found=$((found + 1))
    elif [ "$port" = 323 ]; then
      [ "$proto" = udp ] || { ntpreact_reason "TCP_COMMAND_LISTENER_FORBIDDEN"; return 1; }
      [[ "$addr" =~ ^(127\.0\.0\.1|\[::1\]|::1)$ ]] || { ntpreact_reason "NON_LOOPBACK_CONTROL_LISTENER_FORBIDDEN:$addr"; return 1; }
    fi
  done < <(ntpreact_listeners)
  [ "$found" = 1 ] || { ntpreact_reason "AP_NTP_LISTENER_MISSING_OR_DUPLICATED:$found"; return 1; }
}

# ── trusted clock (the existing L5 predicate, shared via p4-l5-clock.py) ───────────────────────────────────────────────
# ntpreact_clock_gate — sets NTPREACT_CLOCK_LINE. OK only when the L5 predicate holds (kernel synced, TrustedClock SYNCED, maxerror <= bound).
ntpreact_clock_gate() {
  local rc=0 maxerr
  NTPREACT_CLOCK_LINE=$(python3 "$_NTPREACT_LIB_DIR/p4-l5-clock.py" probe 2>&1) || rc=$?
  [ "$rc" = 0 ] || { ntpreact_reason "NTPREACT_TRUSTEDCLOCK_NOT_OK:$(sed -n 's/.*reason=\([A-Z_]*\).*/\1/p' <<< "$NTPREACT_CLOCK_LINE" | tail -1)"; return 1; }
  [[ "$NTPREACT_CLOCK_LINE" =~ ^state=SYNCED\ reason=OK\ maxerror_us=([0-9]+)\  ]] || { ntpreact_reason "NTPREACT_TRUSTEDCLOCK_NOT_OK:UNPARSEABLE"; return 1; }
  maxerr=${BASH_REMATCH[1]}
  [ "$maxerr" -le "$NTPREACT_MAXERROR_BOUND_US" ] || { ntpreact_reason "NTPREACT_MAXERROR_EXCEEDED:$maxerr"; return 1; }
}

# ── runner-side gates ──────────────────────────────────────────────────────────────────────────────────────────────────
# ntpreact_identity_gate OPERATOR_USER OPERATOR_UID — the runner is invoked by exactly the frozen operator identity.
ntpreact_identity_gate() {
  local user=${1:-} uid=${2:-}
  [[ "$user" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] && [[ "$uid" =~ ^[1-9][0-9]*$ ]] || { ntpreact_reason "NTPREACT_OPERATOR_IDENTITY_INVALID"; return 1; }
  [ "$(id -un)" = "$user" ] && [ "$(id -u)" = "$uid" ] || { ntpreact_reason "NTPREACT_OPERATOR_IDENTITY_MISMATCH"; return 1; }
  [ "$(id -u "$user" 2>/dev/null)" = "$uid" ] || { ntpreact_reason "NTPREACT_OPERATOR_IDENTITY_MISMATCH"; return 1; }
}

# ntpreact_receipt_gate REPO — historical L5 acceptance PROVEN, read from the PINNED commit (never the working tree). Proves history only; runtime is gated separately.
ntpreact_receipt_gate() {
  local repo=${1:-}
  git -C "$repo" rev-parse --verify -q HEAD >/dev/null || { ntpreact_reason "NTPREACT_RECEIPT_GATE_NO_HEAD"; return 1; }
  git -C "$repo" grep -qE "L5_LIVE_ACCEPTANCE ?= ?\`? ?PROVEN" HEAD -- "$NTPREACT_LOGS_REL" || { ntpreact_reason "NTPREACT_L5_ACCEPTANCE_RECEIPT_MISSING"; return 1; }
}

# ntpreact_attempt_unconsumed AUTH_DIR / ntpreact_consume_attempt AUTH_DIR — one live attempt per authorization; the marker is atomic (noclobber) and distinct from every other
# governed run's marker. ANY other *ATTEMPT-CONSUMED* marker in AUTH_DIR (including the historical L5 and the dnsmasq/L34/L8p markers) refuses: this task never reuses another run's directory.
ntpreact_attempt_unconsumed() {
  local dir=${1:-} other
  [ -d "$dir" ] && [ ! -L "$dir" ] || { ntpreact_reason "NTPREACT_AUTH_DIR_INVALID"; return 1; }
  [ ! -e "$dir/$NTPREACT_MARKER_NAME" ] || { ntpreact_reason "NTPREACT_ATTEMPT_ALREADY_CONSUMED (one live attempt per authorization; obtain a fresh same-day authorization)"; return 1; }
  other=$(find "$dir" -maxdepth 1 -name '*ATTEMPT-CONSUMED*' ! -name "$NTPREACT_MARKER_NAME" -printf '%f\n' 2>/dev/null | head -n 1 || true)
  [ -z "$other" ] || { ntpreact_reason "NTPREACT_FOREIGN_ATTEMPT_MARKER:$other"; return 1; }
}
ntpreact_consume_attempt() {
  local dir=${1:-}
  ntpreact_attempt_unconsumed "$dir" || return 1
  ( set -o noclobber; printf 'consumed_at=%s\n' "$(date -u +%FT%TZ)" > "$dir/$NTPREACT_MARKER_NAME" ) 2>/dev/null \
    || { ntpreact_reason "NTPREACT_ATTEMPT_ALREADY_CONSUMED (marker could not be created atomically)"; return 1; }
}

# ntpreact_record_gate AUTH_FILE K3_FILE TODAY — the two records are same-day, stage=L5, the AUTH scope is EXACTLY the approved successor scope, and neither reference names
# the historical L5 authorization. (Format, authorizer, K3 mode and the rest are validated by p4-stage-gate.sh.) Prints nothing on PASS.
ntpreact_record_gate() {
  local auth=${1:-} k3=${2:-} today=${3:-} f
  for f in "$auth" "$k3"; do
    [ -f "$f" ] && [ ! -L "$f" ] || { ntpreact_reason "NTPREACT_RECORD_MISSING:$(basename -- "$f")"; return 1; }
    grep -qx "date=$today" "$f" || { ntpreact_reason "NTPREACT_RECORD_NOT_SAME_DAY:$(basename -- "$f")"; return 1; }
    grep -qx "stage=L5" "$f" || { ntpreact_reason "NTPREACT_RECORD_NOT_STAGE_L5:$(basename -- "$f")"; return 1; }
    ! grep -qE "^reference=.*${NTPREACT_HISTORICAL_L5_REFERENCE_ID}" "$f" || { ntpreact_reason "NTPREACT_HISTORICAL_L5_REFERENCE_REUSE_FORBIDDEN:$(basename -- "$f")"; return 1; }
  done
  grep -qxF "scope=$NTPREACT_EXPECTED_SCOPE" "$auth" || { ntpreact_reason "NTPREACT_SCOPE_NOT_EXACT"; return 1; }
}
