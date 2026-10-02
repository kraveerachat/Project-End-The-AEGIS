#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — T1 / G-15 deterministic before/after comparison of
# two p4-l0-capture.sh bundles (execution document §10 preservation, §11 stop
# conditions). Reads evidence files only; calls no host command.
#
#   DISK_THRESHOLD_PCT=<owner threshold> [ALLOW_KEYS_FILE=…] [ALLOW_LISTENERS_FILE=…] [ALLOW_L6C_RELEASE_FILE=…] \
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
# persisting IDEA2 tunnel regression from a new one. It never passes.
#
# IDEA2_NARROWED_CRITERION (accepted by the IDEA2 owner via PR #189 review):
# a historical absolute idea2.tunnel.NRestarts > 0 is not by itself an unhealthy
# baseline. The preservation dimension is the window delta: NRestarts and MainPID
# unchanged between BEFORE and AFTER pass; any increase or MainPID change fails,
# as do a new failure class, :8077/:18002 loss, and a currently unhealthy tunnel.
#
# ALLOW_TRANSITIONS_FILE (stage L3 or stage L4, exactly one declared) activates one exact semantic regulatory
# window for the phy behind AEGIS_AP_INTERFACE. Accepted after-states: 00 -> 00
# and TH -> TH (unchanged) and 00 -> TH (the one approved transition, which
# also accounts for the wifi.reg.sha256 change). 00 -> 00 is the state proven live
# on the self-managed Intel phy (it stays 00 after the exact rfkill unblock and
# while the AP runs); 00 -> TH is tolerated, never required. The phy is resolved
# from wifi.iface.<if>.phy in BOTH bundles. Every other wifi.reg.* change
# (global, other phys, TH -> 00, any other country, a changed rule table
# without the approved transition), a missing/unparseable target state, or a
# target country other than 00/TH after the window still fails. wifi.reg.* stays in
# PROTECTED, so ALLOW_KEYS_FILE can never approve it.
#
# ALLOW_DYNAMIC_TRANSITIONS_FILE (opt-in, default off) activates one exact, value-level runtime-state window for the
# L3/L4 post-reboot RUNTIME REACTIVATION operation only. First active line `operation L34_RUNTIME_REACTIVATION` (PRE->POST) or
# `operation L34_RUNTIME_REACTIVATION_ROLLBACK` (PRE->RB); every other active line must be one exact member of that operation's
# hard-coded catalog below (key, exact before value, exact after value), each at most once, single-space separated. A rule
# approves a change ONLY when the key changed from exactly that before value to exactly that after value; the pseudo key
# `nm.general#WIFI` matches only the WIFI field of nm.general while STATE/CONNECTIVITY/WIFI-HW stay equal. It cannot approve
# any other key, value, wildcard or protected class, and it is not an allow-keys mechanism. See the L3/L4 reactivation design.
# ALLOW_L6C_RELEASE_FILE (stage L6c only, opt-in): names the ONE exact new release id a run is authorized to add to
# host.aegis_idea3.release_catalog (`stage L6c` once, `release_id <id>` once). It is a relational rule, not a plain allow
# key: every release id already present in BEFORE must remain byte-identical in AFTER regardless of this file; the file
# can only approve the addition of the id it names, never a mutation or removal of an existing release.
#   L34_RUNTIME_REACTIVATION           svc.aegis-idea3-dnsmasq.service.ActiveState failed active
#                                      svc.aegis-idea3-dnsmasq.service.SubState failed running
#                                      svc.aegis-idea3-dnsmasq.service.Result start-limit-hit success
#                                      nm.general#WIFI disabled enabled
#   DNSMASQ_SAFE_STOPPED_POST          svc.aegis-idea3-dnsmasq.service.ActiveState inactive active   (governed dnsmasq repair successor; PRE->POST only)
#                                      svc.aegis-idea3-dnsmasq.service.SubState dead running
#   L34_RUNTIME_REACTIVATION_ROLLBACK  svc.aegis-idea3-dnsmasq.service.ActiveState failed inactive
#                                      svc.aegis-idea3-dnsmasq.service.SubState failed dead
#                                      svc.aegis-idea3-dnsmasq.service.Result start-limit-hit success
#
# V3 (live attempt 2, 2026-09-27): four further operations of the same opt-in file, each with its own closed catalog, model the proven, exact
# side effects of NetworkManager initializing Wi-Fi on this host. `<absent>`, `<empty>`, `<nonempty>`, `<positive>` and `<sha256>` are the only
# value classes a catalog member may use. Rules on `svc.wpa_supplicant.service.*` and `wifi.phy.sha256` are RELATIONAL: they approve a change only
# when the whole gate holds in the two bundles (POST: radio disabled->enabled, target AP the active connection, no unrelated Wi-Fi, unit
# disabled / NRestarts 0 / Result success; ROLLBACK: radio disabled again, target rfkill blocked, no Wi-Fi active, same unit facts; phy: the
# approved target regulatory transition 00->TH under ALLOW_TRANSITIONS_FILE, global regulatory unchanged 00, channel 6 permitted, phy identity
# and AP mode unchanged, and the regulatory-insensitive digest wifi.phy.regnorm_sha256 EQUAL). The p2p pseudo-device rules are gated too (POST: radio
# disabled->enabled with unchanged prefix, approved AP active, no unrelated Wi-Fi/P2P; ROLLBACK_FRESH: radio disabled and target rfkill blocked in both,
# no Wi-Fi/P2P active, target unavailable). Nothing here is a generic allow key.
#   L34_V3_POST_FRESH / L34_V3_POST_RESIDUAL / L34_V3_ROLLBACK_FRESH / L34_V3_ROLLBACK_RESIDUAL  (catalogs in the design document)
#
# Exit 0 = COMPARE_RESULT=PASS, 1 = COMPARE_RESULT=FAIL, 2 = STOP (usage/integrity).
set -uo pipefail
export LC_ALL=C
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

EVID_CLASS="$(meta "$BEFORE" meta.evidence_class)"

# Keys whose change is never approvable (S-03, S-04, S-09, host identity, §10 IDEA2).
# Option A: host.* is default-deny except for exact host.aegis_idea3.file, host.path, host.symlink, and host.unit_file keys.
PROTECTED='^(sysctl\.|idea2\.|net\.route[46]\.(default|sha256|unscoped)|net\.dns|meta\.|cap\.|listen\.|disk\.|nm\.general$|wifi\.reg\.|wifi\.rfkill\..*\.(id|hard)$)'
ALLOW_KEYS=""
if [ -n "${ALLOW_KEYS_FILE:-}" ]; then
  [ -r "$ALLOW_KEYS_FILE" ] || stop "ALLOW_KEYS_FILE unreadable"
  ALLOW_KEYS=$(grep -vE '^[[:space:]]*(#|$)' "$ALLOW_KEYS_FILE" || true)
  ALLOW_KEY_PAT='^[-A-Za-z0-9@._:/]+$'
  while IFS= read -r k; do
    [ -n "$k" ] || continue
    [[ "$k" =~ $ALLOW_KEY_PAT ]] || stop "malformed allow key"
    [[ "$k" =~ $PROTECTED ]] && stop "protected key cannot be approved: $k"
    if [[ "$k" =~ ^host\. ]]; then
      if ! [[ "$k" =~ ^host\.(aegis_idea3\.(file|recovery|alert)\.|path\.|symlink\.|unit_file\.) ]]; then
        stop "protected key cannot be approved: $k"
      fi
    fi
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
        || stop "AEGIS_AP_ADDRESS is required for listener contract"
      k=${k//$placeholder/$AEGIS_AP_ADDRESS}
    fi

    if_placeholder="<AEGIS_AP_INTERFACE>"
    if [[ "$k" == *"$if_placeholder"* ]]; then
      ap_if="${AEGIS_AP_INTERFACE:-wlp0s20f3}"
      k=${k//$if_placeholder/$ap_if}
    fi

    [[ "$k" != *"<AEGIS_"* ]] || stop "unresolved allowed-listener placeholder"
    [[ "$k" =~ ^listen\.(tcp|udp)\.(.+):([0-9]{1,5})$ ]] || stop "malformed allowed listener"
    proto=${BASH_REMATCH[1]} addr=${BASH_REMATCH[2]} port=${BASH_REMATCH[3]}
    if [ "$EVID_CLASS" = "TEST_FIXTURE" ]; then
      allowed_dhcp_if="${AEGIS_AP_INTERFACE:-wlp0s20f3}"
    else
      allowed_dhcp_if="wlp0s20f3"
    fi
    if [ "$port" = 67 ] && [ "$proto" = "udp" ] && [ "$addr" = "0.0.0.0%$allowed_dhcp_if" ]; then
      # PF-02 reviewed exception: exactly interface-bound UDP/67 on target AP interface
      :
    else
      [[ "$addr" =~ ^(0\.0\.0\.0|\[::\]|::|\*|\[::\]%.*|0\.0\.0\.0%.*|\*%.*)$ ]] \
        && stop "wildcard listener cannot be approved (S-05): $k"
    fi
    [ "$port" = 1883 ] && stop "a plaintext 1883 listener cannot be approved (S-12): $k"

    if [ -n "$RESOLVED_ALLOW_LISTENERS" ]; then
      RESOLVED_ALLOW_LISTENERS+=$'\n'
    fi
    RESOLVED_ALLOW_LISTENERS+="$k"
  done <<< "$ALLOW_LISTENERS"

  ALLOW_LISTENERS="$RESOLVED_ALLOW_LISTENERS"
fi

ALLOW_TRANSITIONS=""
TRANS_IFACE=""
if [ -n "${ALLOW_TRANSITIONS_FILE:-}" ]; then
  [ -r "$ALLOW_TRANSITIONS_FILE" ] || stop "ALLOW_TRANSITIONS_FILE unreadable"
  # Strict contract: exactly two active lines, `stage L3` or `stage L4` (one of them, once) and
  # `wifi.reg.<AEGIS_AP_PHY> 00 TH` once,
  # single-space separated, no CR, no other token. Anything else (wildcard, regex, other stage/key/value,
  # duplicate, conflicting or malformed line) stops the run.
  n_stage=0 n_rule=0 DECLARED_STAGE=""
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    case "$line" in
      'stage L3'|'stage L4') n_stage=$((n_stage + 1)); DECLARED_STAGE="${line#stage }" ;;
      'wifi.reg.<AEGIS_AP_PHY> 00 TH') n_rule=$((n_rule + 1)) ;;
      *) stop "malformed or broadened regulatory transition: only 'stage L3'/'stage L4' and 'wifi.reg.<AEGIS_AP_PHY> 00 TH' are approvable" ;;
    esac
  done < "$ALLOW_TRANSITIONS_FILE"
  [ "$n_stage" = 1 ] && [ "$n_rule" = 1 ] || stop "ALLOW_TRANSITIONS_FILE must declare exactly one stage (L3 or L4) once and the single transition once"
  if [ "$EVID_CLASS" = "TEST_FIXTURE" ]; then TRANS_IFACE="${AEGIS_AP_INTERFACE:-wlp0s20f3}"; else TRANS_IFACE="wlp0s20f3"; fi
  [[ "$TRANS_IFACE" =~ ^[A-Za-z0-9_.-]{1,15}$ ]] || stop "AEGIS_AP_INTERFACE invalid for regulatory transition"
  [ "$EVID_CLASS" = "TEST_FIXTURE" ] || [ "${AEGIS_AP_INTERFACE:-wlp0s20f3}" = wlp0s20f3 ] \
    || stop "regulatory transition is bound to wlp0s20f3"
  ALLOW_TRANSITIONS="stage $DECLARED_STAGE"
fi

DYN_RULES=""
if [ -n "${ALLOW_DYNAMIC_TRANSITIONS_FILE:-}" ]; then
  [ -r "$ALLOW_DYNAMIC_TRANSITIONS_FILE" ] || stop "ALLOW_DYNAMIC_TRANSITIONS_FILE unreadable"
  DYN_OP="" DYN_SEEN=" " n_op=0 n_rules=0
  DYN_CATALOG_L34_RUNTIME_REACTIVATION=(
    "svc.aegis-idea3-dnsmasq.service.ActiveState failed active"
    "svc.aegis-idea3-dnsmasq.service.SubState failed running"
    "svc.aegis-idea3-dnsmasq.service.Result start-limit-hit success"
    "nm.general#WIFI disabled enabled"
  )
  DYN_CATALOG_L34_RUNTIME_REACTIVATION_ROLLBACK=(
    "svc.aegis-idea3-dnsmasq.service.ActiveState failed inactive"
    "svc.aegis-idea3-dnsmasq.service.SubState failed dead"
    "svc.aegis-idea3-dnsmasq.service.Result start-limit-hit success"
  )
  # governed dnsmasq repair successor (SAFE_STOPPED baseline): the ONLY value-level window is the stopped -> running pair; Result stays success. A task-specific
  # catalog, so the L34 / V3 catalogs above and below are not widened.
  DYN_CATALOG_DNSMASQ_SAFE_STOPPED_POST=(
    "svc.aegis-idea3-dnsmasq.service.ActiveState inactive active"
    "svc.aegis-idea3-dnsmasq.service.SubState dead running"
  )
  _svc_dnsmasq_post=(
    "svc.aegis-idea3-dnsmasq.service.ActiveState failed active"
    "svc.aegis-idea3-dnsmasq.service.SubState failed running"
    "svc.aegis-idea3-dnsmasq.service.Result start-limit-hit success"
    "nm.general#WIFI disabled enabled"
  )
  _svc_dnsmasq_rb=(
    "svc.aegis-idea3-dnsmasq.service.ActiveState failed inactive"
    "svc.aegis-idea3-dnsmasq.service.SubState failed dead"
    "svc.aegis-idea3-dnsmasq.service.Result start-limit-hit success"
  )
  _wpa_lifecycle=(
    "svc.wpa_supplicant.service.ActiveState inactive active"
    "svc.wpa_supplicant.service.SubState dead running"
    "svc.wpa_supplicant.service.MainPID 0 <positive>"
    "svc.wpa_supplicant.service.ExecMainStartTimestamp <empty> <nonempty>"
  )
  _phy_reg=("wifi.phy.sha256 <sha256> <sha256>")
  DYN_CATALOG_L34_V3_POST_FRESH=(
    "${_svc_dnsmasq_post[@]}"
    "nm.active.device.p2p-dev-wlp0s20f3 <absent> none"
    "nm.device.p2p-dev-wlp0s20f3.type <absent> wifi-p2p"
    "nm.device.p2p-dev-wlp0s20f3.state <absent> disconnected"
    "${_wpa_lifecycle[@]}"
    "${_phy_reg[@]}"
  )
  DYN_CATALOG_L34_V3_POST_RESIDUAL=(
    "${_svc_dnsmasq_post[@]}"
    "nm.device.p2p-dev-wlp0s20f3.state unavailable disconnected"
  )
  DYN_CATALOG_L34_V3_ROLLBACK_FRESH=(
    "${_svc_dnsmasq_rb[@]}"
    "nm.active.device.p2p-dev-wlp0s20f3 <absent> none"
    "nm.device.p2p-dev-wlp0s20f3.type <absent> wifi-p2p"
    "nm.device.p2p-dev-wlp0s20f3.state <absent> unavailable"
    "${_wpa_lifecycle[@]}"
    "${_phy_reg[@]}"
  )
  DYN_CATALOG_L34_V3_ROLLBACK_RESIDUAL=("${_svc_dnsmasq_rb[@]}")
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    case "$line" in
      'operation L34_RUNTIME_REACTIVATION'|'operation L34_RUNTIME_REACTIVATION_ROLLBACK'|'operation L34_V3_POST_FRESH'|'operation L34_V3_POST_RESIDUAL'|'operation L34_V3_ROLLBACK_FRESH'|'operation L34_V3_ROLLBACK_RESIDUAL'|'operation DNSMASQ_SAFE_STOPPED_POST')
        n_op=$((n_op + 1)); DYN_OP="${line#operation }" ;;
      *)
        [ -n "$DYN_OP" ] || stop "dynamic transition rule before the operation declaration"
        ref="DYN_CATALOG_${DYN_OP}[@]"
        found=0
        for member in "${!ref}"; do [ "$member" = "$line" ] && found=1; done
        [ "$found" = 1 ] || stop "dynamic transition is not in the approved catalog for $DYN_OP: only exact catalog members are approvable"
        [[ "$DYN_SEEN" != *" $line "* ]] || stop "duplicate dynamic transition rule"
        DYN_SEEN+="$line "
        read -r dk df dt <<< "$line"
        DYN_RULES+="${dk}|${df}|${dt}"$'\n'
        n_rules=$((n_rules + 1)) ;;
    esac
  done < "$ALLOW_DYNAMIC_TRANSITIONS_FILE"
  [ "$n_op" = 1 ] && [ "$n_rules" -ge 1 ] || stop "ALLOW_DYNAMIC_TRANSITIONS_FILE must declare exactly one operation once and at least one catalog rule"
  ! grep -q $'\r' "$ALLOW_DYNAMIC_TRANSITIONS_FILE" || stop "ALLOW_DYNAMIC_TRANSITIONS_FILE must not contain CR"
fi

# ALLOW_L6C_RELEASE_FILE (stage L6c, or stage L7u for the post-L7 Recovery Core upgrade): names the ONE exact new release id this run is
# authorized to add to host.aegis_idea3.release_catalog. Strict contract: exactly two active lines, exactly one stage line (`stage L6c` OR
# `stage L7u`) and `release_id <id>` once, single-space separated, no CR, no other token. It never approves a mutation or removal of any id already present
# in BEFORE — that check is unconditional (see the release-catalog rule below) and cannot be satisfied by this file.
L6C_RELEASE_ID=""
if [ -n "${ALLOW_L6C_RELEASE_FILE:-}" ]; then
  [ -r "$ALLOW_L6C_RELEASE_FILE" ] || stop "ALLOW_L6C_RELEASE_FILE unreadable"
  n_stage=0 n_rid=0
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    case "$line" in
      'stage L6c' | 'stage L7u') n_stage=$((n_stage + 1)) ;;
      release_id\ *)
        rid=${line#release_id }
        [[ "$rid" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || stop "malformed release_id in ALLOW_L6C_RELEASE_FILE"
        L6C_RELEASE_ID="$rid"; n_rid=$((n_rid + 1)) ;;
      *) stop "malformed ALLOW_L6C_RELEASE_FILE line: only one 'stage L6c'|'stage L7u' line and 'release_id <id>' are approvable" ;;
    esac
  done < "$ALLOW_L6C_RELEASE_FILE"
  [ "$n_stage" = 1 ] && [ "$n_rid" = 1 ] || stop "ALLOW_L6C_RELEASE_FILE must declare exactly one stage (L6c or L7u) once and exactly one release_id once"
  ! grep -q $'\r' "$ALLOW_L6C_RELEASE_FILE" || stop "ALLOW_L6C_RELEASE_FILE must not contain CR"
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
# value classes of the V3 dynamic catalogs; anything else is a literal, exact match
function vmatch(pat, v) {
  if (pat == "<absent>") return v == "<absent>"
  if (pat == "<empty>") return v == ""
  if (pat == "<nonempty>") return v != "" && v != "<absent>"
  if (pat == "<positive>") return v ~ /^[1-9][0-9]*$/
  if (pat == "<sha256>") return v ~ /^[0-9a-f]{64}$/
  return v == pat
}
function radio_field(v,   n, f) { n = split(v, f, ":"); return (n == 4) ? f[4] : "" }
function radio_prefix_equal(b, a,   nb, na, fb, fa) {
  nb = split(b, fb, ":"); na = split(a, fa, ":")
  return nb == 4 && na == 4 && fb[1] == fa[1] && fb[2] == fa[2] && fb[3] == fa[3]
}
BEGIN {
  FS = "\t"
  n = split(allow_keys, tmp, "\n"); for (i = 1; i <= n; i++) if (tmp[i] != "") AK[tmp[i]] = 1
  n = split(allow_listeners, tmp, "\n"); for (i = 1; i <= n; i++) if (tmp[i] != "") AL[tmp[i]] = 1
  n = split(dyn_rules, tmp, "\n"); for (i = 1; i <= n; i++) if (tmp[i] != "") { split(tmp[i], dr, "|"); dyn_n++; DR_K[dyn_n] = dr[1]; DR_F[dyn_n] = dr[2]; DR_T[dyn_n] = dr[3] }
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
  # The engine's HeartbeatWorker logs one "Monitor unreachable ... Connection refused" warning every 5s for as long as the
  # IDEA2 monitor (18002) is down. Both captures share one JOURNAL_SINCE, so the window is ~0s in PRE and the whole
  # mutation window in RB: a growing count is then a window-length artifact, not new drift. Narrowly baseline-only when
  # the monitor was already down (runtime unhealthy, 18002 absent) in BOTH captures.
  engine_monitor_down = (B["idea2.verdict.runtime_healthy"] == "NO" && A["idea2.verdict.runtime_healthy"] == "NO" \
                         && B["idea2.listen.18002"] == "absent" && A["idea2.listen.18002"] == "absent")
  new_class = 0
  for (i in TC) {
    t = "idea2.tunnel.journal." TC[i]
    if (B[t] == "0" && isnum(A[t]) && A[t] + 0 > 0) new_class = 1
  }

  fam_unapproved[4] = 0; fam_approved[4] = 0
  fam_unapproved[6] = 0; fam_approved[6] = 0
  for (f = 4; f <= 6; f += 2) {
    pat = "^net\\.route" f "\\.iface\\."
    for (k in K) {
      if (k ~ pat) {
        bv = (k in B) ? B[k] : "<absent>"
        av = (k in A) ? A[k] : "<absent>"
        if (bv != av) {
          if (k in AK) fam_approved[f]++
          else fam_unapproved[f]++
        }
      }
    }
    def_k = "net.route" f ".default"
    def_b = (def_k in B) ? B[def_k] : "<absent>"
    def_a = (def_k in A) ? A[def_k] : "<absent>"
    fam_def_changed[f] = (def_b != def_a)
    unscoped_k = "net.route" f ".unscoped"
    unscoped_b = (unscoped_k in B) ? B[unscoped_k] : "<absent>"
    unscoped_a = (unscoped_k in A) ? A[unscoped_k] : "<absent>"
    fam_unscoped_changed[f] = (unscoped_b != unscoped_a)
  }

  # L3 semantic regulatory transition (ALLOW_TRANSITIONS_FILE): target phy 00 -> 00 / TH -> TH unchanged, or 00 -> TH.
  reg_tk = ""; reg_other_changed = 0
  if (trans_iface != "") {
    pk = "wifi.iface." trans_iface ".phy"
    pb = (pk in B) ? B[pk] : ""; pa = (pk in A) ? A[pk] : ""
    if (pb !~ /^phy[0-9]+$/ || pa !~ /^phy[0-9]+$/ || pb != pa) {
      emit("INCOMPARABLE", "REGULATORY_TARGET_PHY_UNRESOLVED", pk, (pk in B) ? B[pk] : "<absent>", (pk in A) ? A[pk] : "<absent>")
    } else {
      reg_tk = "wifi.reg." pb
      rb = (reg_tk in B) ? B[reg_tk] : ""; ra = (reg_tk in A) ? A[reg_tk] : ""
      if (rb !~ /^[0-9A-Z][0-9A-Z]$/ || ra !~ /^[0-9A-Z][0-9A-Z]$/) {
        emit("INCOMPARABLE", "REGULATORY_STATE_MISSING", reg_tk, (reg_tk in B) ? B[reg_tk] : "<absent>", (reg_tk in A) ? A[reg_tk] : "<absent>")
        reg_tk = ""
      } else if (ra != "TH" && ra != "00") {
        emit("NEW_OR_WORSENED_DRIFT", "REGULATORY_TARGET_NOT_APPROVED", reg_tk, rb, ra)
      }
    }
    for (k in K) if (k ~ /^wifi\.reg\./ && k != reg_tk && k != "wifi.reg.sha256") {
      if (((k in B) ? B[k] : "<absent>") != ((k in A) ? A[k] : "<absent>")) reg_other_changed = 1
    }
  }

  # V3 relational gates (only meaningful for the L34_V3_* operations; false otherwise)
  wifi_active_any = 0; unrelated_wifi = 0
  for (k in A) if (k ~ /^nm\.active\.device\./) {
    d = substr(k, 18)
    if (A[k] ~ /:(802-11-wireless|wifi-p2p)$/) { wifi_active_any = 1; if (d != "wlp0s20f3") unrelated_wifi = 1 }
  }
  U = "svc.wpa_supplicant.service."
  wpa_unit_ok = (B[U "UnitFileState"] == "disabled" && A[U "UnitFileState"] == "disabled" && B[U "NRestarts"] == "0" && A[U "NRestarts"] == "0" \
                 && B[U "Result"] == "success" && A[U "Result"] == "success" && B[U "LoadState"] == "loaded" && A[U "LoadState"] == "loaded")
  wpa_lifecycle = (B[U "ActiveState"] == "inactive" && B[U "SubState"] == "dead" && B[U "MainPID"] == "0" \
                   && A[U "ActiveState"] == "active" && A[U "SubState"] == "running" && A[U "MainPID"] ~ /^[1-9][0-9]*$/ && A[U "ExecMainStartTimestamp"] != "")
  radio_pre = radio_field(B["nm.general"]); radio_post = radio_field(A["nm.general"])
  wpa_gate = 0
  if (dyn_op ~ /_POST_FRESH$/)
    wpa_gate = (wpa_lifecycle && wpa_unit_ok && radio_pre == "disabled" && radio_post == "enabled" && radio_prefix_equal(B["nm.general"], A["nm.general"]) \
                && A["nm.active.device.wlp0s20f3"] == "aegis-idea3-ap:802-11-wireless" && !unrelated_wifi)
  else if (dyn_op ~ /_ROLLBACK_FRESH$/)
    wpa_gate = (wpa_lifecycle && wpa_unit_ok && radio_pre == "disabled" && radio_post == "disabled" && radio_prefix_equal(B["nm.general"], A["nm.general"]) \
                && B["wifi.rfkill.iface.wlp0s20f3.soft"] == "blocked" && A["wifi.rfkill.iface.wlp0s20f3.soft"] == "blocked" && !wifi_active_any \
                && A["nm.device.wlp0s20f3.state"] == B["nm.device.wlp0s20f3.state"])
  # p2p pseudo-device transitions are relational to the authorized NM radio transition too (exact names/values are enforced by the catalog)
  p2p_gate = 0
  if (dyn_op ~ /_POST_(FRESH|RESIDUAL)$/)
    p2p_gate = (radio_pre == "disabled" && radio_post == "enabled" && radio_prefix_equal(B["nm.general"], A["nm.general"]) \
                && A["nm.active.device.wlp0s20f3"] == "aegis-idea3-ap:802-11-wireless" && !unrelated_wifi)
  else if (dyn_op ~ /_ROLLBACK_FRESH$/)
    p2p_gate = (radio_pre == "disabled" && radio_post == "disabled" \
                && B["wifi.rfkill.iface.wlp0s20f3.soft"] == "blocked" && A["wifi.rfkill.iface.wlp0s20f3.soft"] == "blocked" \
                && !wifi_active_any && A["nm.device.wlp0s20f3.state"] == "unavailable")
  phy_gate = 0
  if (dyn_op ~ /_(POST|ROLLBACK)_FRESH$/ && reg_tk != "") {
    pk2 = "wifi.iface." trans_iface ".phy"
    phy_gate = (B[reg_tk] == "00" && A[reg_tk] == "TH" && !reg_other_changed \
                && B["wifi.reg.global"] == "00" && A["wifi.reg.global"] == "00" \
                && (pk2 in B) && (pk2 in A) && B[pk2] == A[pk2] \
                && B["wifi.phy.ap_mode"] == "supported" && A["wifi.phy.ap_mode"] == "supported" \
                && B["wifi.phy.regnorm_sha256"] ~ /^[0-9a-f]{64}$/ && B["wifi.phy.regnorm_sha256"] == A["wifi.phy.regnorm_sha256"] \
                && A["wifi.phy.channel6_permitted"] == "YES")
  }

  for (key in K) {
    b = (key in B) ? B[key] : "<absent>"
    a = (key in A) ? A[key] : "<absent>"
    if (key ~ /^(meta|cap)\./ || key == "idea2.heartbeat.probe") continue
    # Bundles captured before the phy field existed: the key appearing is a capture-schema addition, not drift.
    # (A changed or removed phy mapping still fails; L3 transition mode requires the key in BOTH bundles.)
    if (key ~ /^wifi\.iface\.[^.]+\.phy$/ && !(key in B) && (key in A) && a ~ /^phy[0-9]+$/ && trans_iface == "") {
      emit("INFO", "CAPTURE_FIELD_ADDED", key, b, a); continue
    }

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

    # L6c release catalog (host.aegis_idea3.release_catalog): a relational rule, never a plain allow-key. Every release id
    # present in BEFORE must still be present in AFTER with an IDENTICAL fingerprint, unconditionally — ALLOW_L6C_RELEASE_FILE
    # can only approve the addition of the ONE id it names; it can never launder a mutation or removal of an existing id.
    if (key == "host.aegis_idea3.release_catalog") {
      delete RCB; delete RCA
      if (b != "absent" && b != "<empty>") {
        nrc = split(b, RCPB, ","); for (ri = 1; ri <= nrc; ri++) { split(RCPB[ri], rp, ":"); RCB[rp[1]] = rp[2] }
      }
      if (a != "absent" && a != "<empty>") {
        nrc = split(a, RCPA, ","); for (ri = 1; ri <= nrc; ri++) { split(RCPA[ri], rp, ":"); RCA[rp[1]] = rp[2] }
      }
      for (rid in RCB) {
        if (!(rid in RCA)) emit("NEW_OR_WORSENED_DRIFT", "RELEASE_REMOVED", key "#" rid, RCB[rid], "<absent>")
        else if (RCA[rid] != RCB[rid]) emit("NEW_OR_WORSENED_DRIFT", "RELEASE_CONTENT_DRIFT", key "#" rid, RCB[rid], RCA[rid])
      }
      for (rid in RCA) {
        if (!(rid in RCB)) {
          if (l6c_release_id != "" && rid == l6c_release_id) emit("APPROVED_CHANGE", "L6C_RELEASE_INSTALLED", key "#" rid, "<absent>", RCA[rid])
          else emit("NEW_OR_WORSENED_DRIFT", "RELEASE_UNAPPROVED_ADDITION", key "#" rid, "<absent>", RCA[rid])
        }
      }
      continue
    }

    if (key in AK) { emit("APPROVED_CHANGE", "KEY_APPROVED", key, b, a); continue }

    # L3/L4 runtime-reactivation value-level window (ALLOW_DYNAMIC_TRANSITIONS_FILE): exact key + exact before + exact after only.
    # Rules on wpa_supplicant and the phy digest additionally need their relational gate (V3).
    if (dyn_n > 0) {
      dyn_hit = 0
      if (key == "nm.general") {
        if (radio_prefix_equal(b, a)) {
          for (r = 1; r <= dyn_n; r++) if (DR_K[r] == "nm.general#WIFI" && vmatch(DR_F[r], radio_field(b)) && vmatch(DR_T[r], radio_field(a))) { dyn_hit = 1; break }
        }
      } else {
        for (r = 1; r <= dyn_n; r++) if (DR_K[r] == key && vmatch(DR_F[r], b) && vmatch(DR_T[r], a)) {
          if (key ~ /^svc\.wpa_supplicant\.service\./) dyn_hit = wpa_gate
          else if (key ~ /^nm\.(active\.)?device\.p2p-dev-wlp0s20f3(\.|$)/) dyn_hit = p2p_gate
          else if (key == "wifi.phy.sha256") dyn_hit = phy_gate
          else dyn_hit = 1
          if (dyn_hit) break
        }
      }
      if (dyn_hit) { emit("APPROVED_CHANGE", "DYNAMIC_TRANSITION_APPROVED", key, b, a); continue }
    }

    if (reg_tk != "" && key == reg_tk && b == "00" && a == "TH") {
      emit("APPROVED_CHANGE", "REGULATORY_TRANSITION_APPROVED", key, b, a); continue
    }
    if (key == "wifi.reg.sha256" && reg_tk != "" && ((reg_tk in B) ? B[reg_tk] : "") == "00" && ((reg_tk in A) ? A[reg_tk] : "") == "TH" && !reg_other_changed) {
      emit("APPROVED_CHANGE", "REGULATORY_SHA_ACCOUNTED_BY_APPROVED_TRANSITION", key, b, a); continue
    }

    if (key ~ /^sysctl\./ && key ~ /forward/) {
      emit("NEW_OR_WORSENED_DRIFT", (a != "0" ? "FORWARDING_ENABLED" : "FORWARDING_CHANGED"), key, b, a)
    } else if (key ~ /^net\.route[46]\.default$/) {
      emit("NEW_OR_WORSENED_DRIFT", "DEFAULT_ROUTE_DRIFT", key, b, a)
    } else if (key ~ /^net\.route[46]\.unscoped$/) {
      emit("NEW_OR_WORSENED_DRIFT", "UNSCOPED_ROUTE_DRIFT", key, b, a)
    } else if (key == "net.route4.sha256") {
      if (fam_unapproved[4] == 0 && fam_approved[4] > 0 && !fam_def_changed[4] && !fam_unscoped_changed[4]) {
        emit("APPROVED_CHANGE", "ROUTE_CHANGES_ACCOUNTED_BY_APPROVED_IFACE", key, b, a)
      } else {
        emit("NEW_OR_WORSENED_DRIFT", "ROUTE_TABLE_DRIFT", key, b, a)
      }
    } else if (key == "net.route6.sha256") {
      if (fam_unapproved[6] == 0 && fam_approved[6] > 0 && !fam_def_changed[6] && !fam_unscoped_changed[6]) {
        emit("APPROVED_CHANGE", "ROUTE_CHANGES_ACCOUNTED_BY_APPROVED_IFACE", key, b, a)
      } else {
        emit("NEW_OR_WORSENED_DRIFT", "ROUTE_TABLE_DRIFT", key, b, a)
      }
    } else if (key ~ /^net\.route[46]\./) {
      emit("NEW_OR_WORSENED_DRIFT", "ROUTE_TABLE_DRIFT", key, b, a)
    } else if (key ~ /^net\.rule/) {
      emit("NEW_OR_WORSENED_DRIFT", "ROUTING_RULE_DRIFT", key, b, a)
    } else if (key ~ /^net\.idea3_dnsmasq_conf\./) {
      emit("NEW_OR_WORSENED_DRIFT", "DNSMASQ_CONFIG_DRIFT", key, b, a)
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
    } else if (key == "time.timesyncd.ServerName") {
      # CONSTRAINED_INFORMATIONAL_DYNAMIC_STATE (owner decision 2026-09-25): restarting timesyncd legitimately reselects one of
      # its configured fallback servers. Informational ONLY when timesyncd is active/running, the TrustedClock is SYNCED, the
      # fallback set is captured and unchanged, and the new name is a member of it. Anything else stays drift; every other
      # time-state key is judged independently. This is NOT an allowance key.
      fbA = A["time.timesyncd.FallbackNTPServers"]; fbB = B["time.timesyncd.FallbackNTPServers"]
      sn_ok = 0
      if (fbA != "" && !bad(fbA) && fbA == fbB && !bad(a) && a != "" && a != "<absent>" \
          && A["svc.systemd-timesyncd.service.ActiveState"] == "active" && A["svc.systemd-timesyncd.service.SubState"] == "running" \
          && A["time.trustedclock.state"] == "SYNCED") {
        nfb = split(fbA, FB, " "); for (fi = 1; fi <= nfb; fi++) if (FB[fi] == a) sn_ok = 1
      }
      if (sn_ok) emit("INFO", "TIMESYNCD_SERVER_RESELECTED_CONFIGURED", key, b, a)
      else emit("NEW_OR_WORSENED_DRIFT", "TIME_STATE_DRIFT", key, b, a)
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
    } else if (key ~ /^idea2\.engine\.journal\.(heartbeat_failed|refused)$/ && engine_monitor_down \
               && isnum(b) && isnum(a) && a + 0 >= b + 0) {
      emit("BASELINE_UNHEALTHY_BUT_UNCHANGED", "IDEA2_ENGINE_HEARTBEAT_BASELINE", key, b, a)
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
    } else if (key ~ /^host\.(path|aegis_idea3|symlink|unit_file)\./) {
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
  printf "SUMMARY\tIDEA2_NARROWED_CRITERION=WINDOW_DELTA_ACCEPTED_BY_IDEA2_OWNER\n"
  printf "SUMMARY\tDRIFT_RESULT=%s\n", drift
  printf "SUMMARY\tPRESERVATION_S10=%s\n", s10
  printf "SUMMARY\tCOMPARE_RESULT=%s\n", s10
}
AWK

result=$(awk -v threshold="$THRESHOLD" -v allow_keys="$ALLOW_KEYS" -v allow_listeners="$ALLOW_LISTENERS" -v dyn_rules="$DYN_RULES" -v dyn_op="${DYN_OP:-}" -v trans_iface="$TRANS_IFACE" \
  -v l6c_release_id="$L6C_RELEASE_ID" \
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
