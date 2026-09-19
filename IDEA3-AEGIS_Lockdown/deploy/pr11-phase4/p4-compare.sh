#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — T1 / G-15 deterministic before/after comparison of
# two p4-l0-capture.sh bundles (execution document §10 preservation, §11 stop
# conditions). Reads evidence files only; calls no host command.
#
#   DISK_THRESHOLD_PCT=<owner threshold> [ALLOW_KEYS_FILE=…] [ALLOW_LISTENERS_FILE=…] \
#     [REPORT_FILE=…] bash p4-compare.sh <BEFORE_DIR> <AFTER_DIR>
#
# Finding classes:
#   NEW_OR_WORSENED_DRIFT             an unapproved change relative to BEFORE        (fails)
#   BASELINE_UNHEALTHY_BUT_UNCHANGED  a pre-existing unhealthy condition persisted,
#                                     or repeated within its existing failure class  (fails)
#   INCOMPARABLE                      evidence missing, unreadable, or not comparable (fails)
#   APPROVED_CHANGE                   exactly listed in an allow file                (passes)
#   INFO                              recorded for review, not a preservation check  (passes)
#
# BASELINE_UNHEALTHY_BUT_UNCHANGED is shown separately so a reviewer can tell a
# persisting IDEA2 tunnel regression from a new one. It never passes: §10 stays
# as written until the IDEA2 owners restore the tunnel or accept a narrowed
# criterion in writing, and this tool accepts none (IDEA2_NARROWED_CRITERION).
#
# Exit 0 = COMPARE_RESULT=PASS, 1 = COMPARE_RESULT=FAIL, 2 = STOP (usage/integrity).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=p4-lib.sh
. "$HERE/p4-lib.sh"

stop() { printf 'STOP: %s\n' "$*"; printf 'COMPARE_RESULT=FAIL\n'; exit 2; }

[ $# = 2 ] || stop "usage: p4-compare.sh <BEFORE_DIR> <AFTER_DIR>"
BEFORE=$1 AFTER=$2
THRESHOLD="${DISK_THRESHOLD_PCT:-}"
[[ "$THRESHOLD" =~ ^[1-9][0-9]?$ ]] || stop "DISK_THRESHOLD_PCT (owner threshold, 1-99) is required"
REPORT_FILE="${REPORT_FILE:-}"
[ -z "$REPORT_FILE" ] || [ ! -e "$REPORT_FILE" ] || stop "REPORT_FILE exists; reports are never overwritten"

verify_bundle() { # DIR
  local dir=$1 f
  [ -d "$dir" ] && [ -f "$dir/SHA256SUMS" ] || stop "not a capture bundle: $dir"
  (cd "$dir" && sha256sum -c --quiet --strict SHA256SUMS >/dev/null 2>&1) || stop "checksum verification failed: $dir"
  for f in "$dir"/*.tsv; do
    grep -qE "^[0-9a-f]{64}  ${f##*/}\$" "$dir/SHA256SUMS" || stop "unlisted evidence file: $f"
  done
}
verify_bundle "$BEFORE"
verify_bundle "$AFTER"

meta() { awk -F '\t' -v k="$2" '$1 == k { print $2 }' "$1/meta.tsv"; }
[ "$(meta "$BEFORE" meta.schema)" = "$P4_SCHEMA" ] && [ "$(meta "$AFTER" meta.schema)" = "$P4_SCHEMA" ] \
  || stop "capture schema mismatch (expected $P4_SCHEMA)"
[ "$(meta "$BEFORE" meta.evidence_class)" = "$(meta "$AFTER" meta.evidence_class)" ] \
  || stop "evidence classes differ; test fixtures and host evidence are never compared"

# Keys whose change is never approvable (S-03, S-04, S-09, host identity, §10 IDEA2).
PROTECTED='^(sysctl\.|idea2\.|net\.route[46]\.default|net\.dns|host\.|meta\.|cap\.|listen\.|disk\.|nm\.general$|wifi\.reg\.|wifi\.rfkill\..*\.(id|hard)$)'
ALLOW_KEYS=""
if [ -n "${ALLOW_KEYS_FILE:-}" ]; then
  [ -r "$ALLOW_KEYS_FILE" ] || stop "ALLOW_KEYS_FILE unreadable"
  ALLOW_KEYS=$(grep -vE '^[[:space:]]*(#|$)' "$ALLOW_KEYS_FILE" || true)
  ALLOW_KEY_PAT='^[-A-Za-z0-9@._:/]+$'
  while IFS= read -r k; do
    [ -n "$k" ] || continue
    [[ "$k" =~ $ALLOW_KEY_PAT ]] || stop "malformed allow key"
    [[ "$k" =~ $PROTECTED ]] && stop "protected key cannot be approved: $k"
  done <<< "$ALLOW_KEYS"
fi
ALLOW_LISTENERS=""
if [ -n "${ALLOW_LISTENERS_FILE:-}" ]; then
  [ -r "$ALLOW_LISTENERS_FILE" ] || stop "ALLOW_LISTENERS_FILE unreadable"
  ALLOW_LISTENERS=$(grep -vE '^[[:space:]]*(#|$)' "$ALLOW_LISTENERS_FILE" || true)
  RESOLVED_ALLOW_LISTENERS=""
  while IFS= read -r k; do
    [ -n "$k" ] || continue

    placeholder="<AEGIS_AP_ADDRESS>"
    if [[ "$k" == *"$placeholder"* ]]; then
      [[ "${AEGIS_AP_ADDRESS:-}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] \
        || stop "AEGIS_AP_ADDRESS is required for the L6b listener contract"
      k=${k//$placeholder/$AEGIS_AP_ADDRESS}
    fi

    [[ "$k" != *"<AEGIS_"* ]] || stop "unresolved allowed-listener placeholder"
    [[ "$k" =~ ^listen\.(tcp|udp)\.(.+):([0-9]{1,5})$ ]] || stop "malformed allowed listener"
    addr=${BASH_REMATCH[2]} port=${BASH_REMATCH[3]}
    [[ "$addr" =~ ^(0\.0\.0\.0|\[::\]|::|\*|\[::\]%.*|0\.0\.0\.0%.*|\*%.*)$ ]] \
      && stop "wildcard listener cannot be approved (S-05): $k"
    [ "$port" = 1883 ] && stop "a plaintext 1883 listener cannot be approved (S-12): $k"

    if [ -n "$RESOLVED_ALLOW_LISTENERS" ]; then
      RESOLVED_ALLOW_LISTENERS+=$'\n'
    fi
    RESOLVED_ALLOW_LISTENERS+="$k"
  done <<< "$ALLOW_LISTENERS"

  ALLOW_LISTENERS="$RESOLVED_ALLOW_LISTENERS"
fi

read -r -d '' COMPARE_AWK <<'AWK'
function emit(cls, code, key, b, a) {
  printf "FINDING\t%s\t%s\t%s\t%s\t%s\n", cls, code, key, b, a
  count[cls]++
}
# UNKNOWN is a sentinel only for IDEA2 verdicts; `ip -br link` reports loopback operstate UNKNOWN.
function bad(v) { return v == "UNAVAILABLE" || v == "UNREADABLE" }
function port_of(key,   n, parts) { n = split(key, parts, ":"); return parts[n] }
function isnum(v) { return v ~ /^[0-9]+$/ }
BEGIN {
  FS = "\t"
  n = split(allow_keys, tmp, "\n"); for (i = 1; i <= n; i++) if (tmp[i] != "") AK[tmp[i]] = 1
  n = split(allow_listeners, tmp, "\n"); for (i = 1; i <= n; i++) if (tmp[i] != "") AL[tmp[i]] = 1
  split("ip sysctl nft ss systemctl journalctl df timedatectl nmcli iw rfkill", REQ, " ")
  split("8883 123 67 53 8003 8004", P, " "); for (i in P) IDEA3_PORT[P[i]] = 1
  split("timeout refused auth hostkey forward dns unreachable unit_failed restart_scheduled", TC, " ")
}
{
  i = index($0, "\t"); if (!i) next
  k = substr($0, 1, i - 1); v = substr($0, i + 1)
  if (side == "B") B[k] = v; else A[k] = v
  K[k] = 1
}
END {
  T = threshold + 0
  for (i in REQ) {
    t = "cap." REQ[i]
    if (B[t] != "available" || A[t] != "available") emit("INCOMPARABLE", "CAPABILITY_MISSING", t, B[t], A[t])
  }
  if (B["meta.capture_status"] != "COMPLETE" || A["meta.capture_status"] != "COMPLETE")
    emit("INCOMPARABLE", "CAPTURE_PARTIAL", "meta.capture_status", B["meta.capture_status"], A["meta.capture_status"])
  if (B["meta.journal_since"] != A["meta.journal_since"])
    emit("INCOMPARABLE", "JOURNAL_BOUNDARY_MISMATCH", "meta.journal_since", B["meta.journal_since"], A["meta.journal_since"])

  tunnel_unhealthy = (B["idea2.verdict.tunnel_healthy"] == "NO")
  new_class = 0
  for (i in TC) {
    t = "idea2.tunnel.journal." TC[i]
    if (B[t] == "0" && isnum(A[t]) && A[t] + 0 > 0) new_class = 1
  }

  for (key in K) {
    b = (key in B) ? B[key] : "<absent>"
    a = (key in A) ? A[key] : "<absent>"
    if (key ~ /^(meta|cap)\./ || key == "idea2.heartbeat.probe") continue

    if (key ~ /^idea2\.verdict\./) {
      if (bad(b) || bad(a) || b == "UNKNOWN" || a == "UNKNOWN") {
        emit("INCOMPARABLE", "IDEA2_VERDICT_UNKNOWN", key, b, a); continue
      }
      if (b != a) { emit("NEW_OR_WORSENED_DRIFT", "IDEA2_VERDICT_CHANGED", key, b, a); continue }
      if (key == "idea2.verdict.tunnel_healthy" && b == "NO")
        emit("BASELINE_UNHEALTHY_BUT_UNCHANGED", "IDEA2_TUNNEL_BASELINE_UNHEALTHY", key, b, a)
      if (key == "idea2.verdict.runtime_healthy" && b == "NO")
        emit("BASELINE_UNHEALTHY_BUT_UNCHANGED", "IDEA2_RUNTIME_BASELINE_UNHEALTHY", key, b, a)
      if (key == "idea2.verdict.process_active" && b == "NO")
        emit("BASELINE_UNHEALTHY_BUT_UNCHANGED", "IDEA2_PROCESS_BASELINE_INACTIVE", key, b, a)
      continue
    }

    if (bad(b) || bad(a)) {
      if (b == a && key ~ /^(host\.twingate\.|time\.timesyncd\.|time\.chrony\.)/) continue
      emit("INCOMPARABLE", "EVIDENCE_UNAVAILABLE", key, b, a); continue
    }

    if (b == a) {
      if (key ~ /^sysctl\./ && key ~ /forward/ && a != "0")
        emit("BASELINE_UNHEALTHY_BUT_UNCHANGED", "FORWARDING_ENABLED", key, b, a)
      if (key ~ /^disk\..*\.use_pct$/ && isnum(a) && a + 0 >= T)
        emit("BASELINE_UNHEALTHY_BUT_UNCHANGED", "DISK_ABOVE_THRESHOLD", key, b, a)
      continue
    }

    if (key in AK) { emit("APPROVED_CHANGE", "KEY_APPROVED", key, b, a); continue }

    if (key ~ /^sysctl\./ && key ~ /forward/) {
      emit("NEW_OR_WORSENED_DRIFT", (a != "0" ? "FORWARDING_ENABLED" : "FORWARDING_CHANGED"), key, b, a)
    } else if (key ~ /^net\.route[46]\.default$/) {
      emit("NEW_OR_WORSENED_DRIFT", "DEFAULT_ROUTE_DRIFT", key, b, a)
    } else if (key ~ /^net\.route[46]\./) {
      emit("NEW_OR_WORSENED_DRIFT", "ROUTE_TABLE_DRIFT", key, b, a)
    } else if (key ~ /^net\.rule/) {
      emit("NEW_OR_WORSENED_DRIFT", "ROUTING_RULE_DRIFT", key, b, a)
    } else if (key ~ /^net\.dns/) {
      emit("NEW_OR_WORSENED_DRIFT", "DNS_CONFIGURATION_DRIFT", key, b, a)
    } else if (key ~ /^net\.addr/) {
      emit("NEW_OR_WORSENED_DRIFT", "INTERFACE_ADDRESS_DRIFT", key, b, a)
    } else if (key ~ /^net\.link/) {
      emit("NEW_OR_WORSENED_DRIFT", "INTERFACE_STATE_DRIFT", key, b, a)
    } else if (key ~ /^net\.sysctl_conf\./) {
      emit("NEW_OR_WORSENED_DRIFT", "SYSCTL_PERSISTENT_DRIFT", key, b, a)
    } else if (key == "fw.nft.tables") {
      emit("NEW_OR_WORSENED_DRIFT", "NFT_TABLE_SET_DRIFT", key, b, a)
    } else if (key ~ /^fw\.nft\.table\./) {
      emit("NEW_OR_WORSENED_DRIFT", "NFT_TABLE_DRIFT", key, b, a)
    } else if (key ~ /^fw\.nft\.ruleset/) {
      emit("NEW_OR_WORSENED_DRIFT", "NFT_RULESET_DRIFT", key, b, a)
    } else if (key ~ /^fw\.nftables_/) {
      emit("NEW_OR_WORSENED_DRIFT", "NFT_PERSISTENT_CONF_DRIFT", key, b, a)
    } else if (key ~ /^wifi\.rfkill\..*\.hard$/) {
      emit("NEW_OR_WORSENED_DRIFT", "RFKILL_HARD_DRIFT", key, b, a)
    } else if (key ~ /^wifi\.rfkill/) {
      emit("NEW_OR_WORSENED_DRIFT", "RFKILL_STATE_DRIFT", key, b, a)
    } else if (key ~ /^wifi\.reg/) {
      emit("NEW_OR_WORSENED_DRIFT", "REGULATORY_DRIFT", key, b, a)
    } else if (key ~ /^wifi\./) {
      emit("NEW_OR_WORSENED_DRIFT", "WIFI_STATE_DRIFT", key, b, a)
    } else if (key == "nm.general") {
      emit("NEW_OR_WORSENED_DRIFT", "NM_GENERAL_DRIFT", key, b, a)
    } else if (key ~ /^nm\.profile\./) {
      emit("NEW_OR_WORSENED_DRIFT", "NM_PROFILE_DRIFT", key, b, a)
    } else if (key ~ /^nm\.active\./) {
      emit("NEW_OR_WORSENED_DRIFT", "NM_ACTIVE_DRIFT", key, b, a)
    } else if (key ~ /^nm\.device\./) {
      emit("NEW_OR_WORSENED_DRIFT", "NM_DEVICE_DRIFT", key, b, a)
    } else if (key ~ /^nm\./) {
      emit("NEW_OR_WORSENED_DRIFT", "NM_STATE_DRIFT", key, b, a)
    } else if (key == "time.NTPSynchronized") {
      emit("NEW_OR_WORSENED_DRIFT", (b == "yes" ? "TIME_SYNC_LOST" : "TIME_STATE_DRIFT"), key, b, a)
    } else if (key ~ /^time\./) {
      emit("NEW_OR_WORSENED_DRIFT", "TIME_STATE_DRIFT", key, b, a)
    } else if (key ~ /^mqtt\.established\./) {
      if (isnum(b) && isnum(a) && a + 0 > b + 0) emit("INFO", "MQTT_SESSION_INCREASE", key, b, a)
      else emit("NEW_OR_WORSENED_DRIFT", "MQTT_SESSION_DROP", key, b, a)
    } else if (key ~ /^mqtt\./) {
      emit("NEW_OR_WORSENED_DRIFT", "MQTT_CONFIG_DRIFT", key, b, a)
    } else if (key ~ /^listen\./ && key != "listen.inventory") {
      p = port_of(key)
      if (b == "present") {
        if (p == "1883") c = "MQTT_1883_LISTENER_REMOVED"
        else if (p == "8077") c = "IDEA2_8077_LISTENER_REMOVED"
        else if (p == "18002") c = "IDEA2_18002_STATE_CHANGED"
        else c = "LISTENER_REMOVED"
        emit("NEW_OR_WORSENED_DRIFT", c, key, b, a)
      } else if (key in AL) {
        emit("APPROVED_CHANGE", "IDEA3_LISTENER_APPROVED", key, b, a)
      } else if (p in IDEA3_PORT) {
        emit("NEW_OR_WORSENED_DRIFT", "IDEA3_LISTENER_OUT_OF_SCOPE", key, b, a)
      } else {
        emit("NEW_OR_WORSENED_DRIFT", (p == "18002" ? "IDEA2_18002_STATE_CHANGED" : "LISTENER_ADDED"), key, b, a)
      }
    } else if (key == "idea2.listen.8077") {
      emit("NEW_OR_WORSENED_DRIFT", (b == "present" ? "IDEA2_8077_LISTENER_REMOVED" : "IDEA2_8077_STATE_CHANGED"), key, b, a)
    } else if (key == "idea2.listen.18002") {
      emit("NEW_OR_WORSENED_DRIFT", "IDEA2_18002_STATE_CHANGED", key, b, a)
    } else if (key ~ /^idea2\.engine\.journal\./) {
      emit("NEW_OR_WORSENED_DRIFT", "IDEA2_ENGINE_FAILURE_DRIFT", key, b, a)
    } else if (key ~ /^idea2\.engine\./) {
      emit("NEW_OR_WORSENED_DRIFT", "IDEA2_ENGINE_DRIFT", key, b, a)
    } else if (key ~ /^idea2\.tunnel\.journal\./) {
      if (!isnum(b) || !isnum(a) || a + 0 < b + 0) emit("INCOMPARABLE", "IDEA2_JOURNAL_COUNT_INCONSISTENT", key, b, a)
      else if (b + 0 == 0) emit("NEW_OR_WORSENED_DRIFT", "IDEA2_TUNNEL_NEW_FAILURE_CLASS", key, b, a)
      else if (tunnel_unhealthy) emit("BASELINE_UNHEALTHY_BUT_UNCHANGED", "IDEA2_TUNNEL_FAILURE_COUNT", key, b, a)
      else emit("NEW_OR_WORSENED_DRIFT", "IDEA2_TUNNEL_FAILURE_COUNT", key, b, a)
    } else if (key ~ /^idea2\.tunnel\.(MainPID|NRestarts|ExecMainStartTimestamp)$/) {
      if (tunnel_unhealthy && !new_class) emit("BASELINE_UNHEALTHY_BUT_UNCHANGED", "IDEA2_TUNNEL_RESTART_DRIFT", key, b, a)
      else emit("NEW_OR_WORSENED_DRIFT", "IDEA2_TUNNEL_RESTART_DRIFT", key, b, a)
    } else if (key ~ /^idea2\.tunnel\.(SubState|Result)$/ && tunnel_unhealthy && !new_class \
               && B["idea2.tunnel.ActiveState"] ~ /^(active|activating)$/ \
               && A["idea2.tunnel.ActiveState"] ~ /^(active|activating)$/) {
      emit("BASELINE_UNHEALTHY_BUT_UNCHANGED", "IDEA2_TUNNEL_STATE_FLAP", key, b, a)
    } else if (key ~ /^idea2\./) {
      emit("NEW_OR_WORSENED_DRIFT", "IDEA2_TUNNEL_STATE_DRIFT", key, b, a)
    } else if (key ~ /^svc\..*\.(MainPID|NRestarts|ExecMainStartTimestamp)$/) {
      emit("NEW_OR_WORSENED_DRIFT", "SERVICE_RESTART_DRIFT", key, b, a)
    } else if (key ~ /^svc\./) {
      emit("NEW_OR_WORSENED_DRIFT", "SERVICE_STATE_DRIFT", key, b, a)
    } else if (key ~ /^disk\..*\.use_pct$/) {
      if (!isnum(b) || !isnum(a)) emit("INCOMPARABLE", "DISK_VALUE_INVALID", key, b, a)
      else if (a + 0 >= T && (b + 0 < T || a + 0 > b + 0)) emit("NEW_OR_WORSENED_DRIFT", "DISK_THRESHOLD_WORSENED", key, b, a)
      else if (a + 0 >= T) emit("BASELINE_UNHEALTHY_BUT_UNCHANGED", "DISK_ABOVE_THRESHOLD", key, b, a)
      else emit("INFO", "DISK_USAGE_CHANGED", key, b, a)
    } else if (key ~ /^disk\..*\.avail_kb$/) {
      emit("INFO", "DISK_AVAILABLE_CHANGED", key, b, a)
    } else if (key ~ /^disk\./) {
      emit("NEW_OR_WORSENED_DRIFT", "DISK_MOUNTPOINT_DRIFT", key, b, a)
    } else if (key == "host.boot_id") {
      emit("NEW_OR_WORSENED_DRIFT", "HOST_BOOT_CHANGED", key, b, a)
    } else if (key == "host.identity") {
      emit("NEW_OR_WORSENED_DRIFT", "HOST_IDENTITY_MISMATCH", key, b, a)
    } else if (key == "host.kernel") {
      emit("NEW_OR_WORSENED_DRIFT", "HOST_KERNEL_CHANGED", key, b, a)
    } else if (key ~ /^host\.twingate\./) {
      emit("NEW_OR_WORSENED_DRIFT", "TWINGATE_STATE_DRIFT", key, b, a)
    } else if (key ~ /^host\.(path|aegis_idea3)\./) {
      emit("NEW_OR_WORSENED_DRIFT", "IDEA3_HOST_PATH_DRIFT", key, b, a)
    } else {
      emit("NEW_OR_WORSENED_DRIFT", "UNCLASSIFIED_DRIFT", key, b, a)
    }
  }

  printf "SUMMARY\tIDEA2_BASELINE_PROCESS_ACTIVE=%s\n", B["idea2.verdict.process_active"]
  printf "SUMMARY\tIDEA2_BASELINE_TUNNEL_HEALTHY=%s\n", B["idea2.verdict.tunnel_healthy"]
  printf "SUMMARY\tIDEA2_BASELINE_RUNTIME_HEALTHY=%s\n", B["idea2.verdict.runtime_healthy"]
  split("NEW_OR_WORSENED_DRIFT BASELINE_UNHEALTHY_BUT_UNCHANGED INCOMPARABLE APPROVED_CHANGE INFO", CL, " ")
  for (i = 1; i <= 5; i++) printf "SUMMARY\tFINDINGS_%s=%d\n", CL[i], count[CL[i]] + 0
  drift = (count["NEW_OR_WORSENED_DRIFT"] + count["INCOMPARABLE"] == 0) ? "PASS" : "FAIL"
  s10 = (drift == "PASS" && count["BASELINE_UNHEALTHY_BUT_UNCHANGED"] + 0 == 0) ? "PASS" : "FAIL"
  printf "SUMMARY\tIDEA2_NARROWED_CRITERION=NOT_ACCEPTED\n"
  printf "SUMMARY\tDRIFT_RESULT=%s\n", drift
  printf "SUMMARY\tPRESERVATION_S10=%s\n", s10
  printf "SUMMARY\tCOMPARE_RESULT=%s\n", s10
}
AWK

result=$(awk -v threshold="$THRESHOLD" -v allow_keys="$ALLOW_KEYS" -v allow_listeners="$ALLOW_LISTENERS" \
  "$COMPARE_AWK" side=B "$BEFORE"/*.tsv side=A "$AFTER"/*.tsv) || stop "comparison failed"

report=$(
  printf 'P4_COMPARE_SCHEMA=%s\n' "$P4_SCHEMA"
  printf 'EVIDENCE_CLASS=%s\n' "$(meta "$BEFORE" meta.evidence_class)"
  printf 'BEFORE=%s captured_at=%s\n' "$(meta "$BEFORE" meta.label)" "$(meta "$BEFORE" meta.captured_at)"
  printf 'AFTER=%s captured_at=%s\n' "$(meta "$AFTER" meta.label)" "$(meta "$AFTER" meta.captured_at)"
  printf 'DISK_THRESHOLD_PCT=%s\n' "$THRESHOLD"
  printf '%s\n' "$result" | grep '^FINDING' | LC_ALL=C sort
  printf '%s\n' "$result" | grep '^SUMMARY' | cut -f2-
  printf 'PRODUCTION_MUTATION_PERFORMED=NO\n'
)
printf '%s\n' "$report"
[ -z "$REPORT_FILE" ] || printf '%s\n' "$report" > "$REPORT_FILE"
if printf '%s\n' "$report" | grep -qx 'COMPARE_RESULT=PASS'; then exit 0; else exit 1; fi
