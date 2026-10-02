# shellcheck shell=bash
# AEGIS IDEA3 PR11 Phase 4 — governed dnsmasq UNIT boot-order REPAIR gate library (task-specific package: dnsmasq-unit-boot-order-repair).
# Sourced by reactivation/dnsmasq-unit-boot-order-repair/{apply,verify,rollback}.sh and the two owner-run scripts AFTER p4-l34-reactivation-lib.sh (and
# p4-l34-v8-lib.sh for the read-only profile record). Those libraries are reused UNCHANGED; nothing here edits them.
#
# Why this package exists: PR #305 fixed the canonical aegis-idea3-dnsmasq.service.example (bounded AP-readiness gate) in the repository only. The live host
# still has the OLD pre-PR305 unit, which the corrected L34 authority (l34_dnsmasq_unit_gate) intentionally REFUSES, so every L34 reactivation tool stops
# at that gate until the repaired unit is installed and qualified. No existing governed stage can do ONLY that: V4-V8 all demand the unit already match the
# new authority and assume the AP is down; stages/L4/apply.sh renders the whole AP network. This package changes exactly one file and one service.
#
# Every function is either a read-only check or the single, explicitly named unit installer. A check returns 0 on PASS; on FAIL it prints one stable reason
# line to stderr and returns 1. The Wi-Fi PSK is never read into a variable, printed or digested.

DNSREPAIR_STAGE_NAME="dnsmasq-unit-boot-order-repair"
DNSREPAIR_MARKER_NAME="DNSMASQ-UNIT-REPAIR-ATTEMPT-CONSUMED"
# GOVERNED SUCCESSOR MODEL (amendment 2026-10-03). The first live attempt (PR #308 runner) was CONSUMED and ended ROLLBACK_FAILED_ESCALATE at S10 because IDEA2 was
# already unhealthy. It is historical and immutable: its AUTH_DIR, Authorization, K3, marker, frozen runner and evidence directory are NEVER reused, and a retry of it
# is never allowed. A successor is a NEW one-shot attempt with its own fresh same-day AUTH_DIR, a NEW exact-main frozen runner and an explicit owner authorization.
DNSREPAIR_OLD_ATTEMPT_RETRY_ALLOWED=NO
DNSREPAIR_HISTORICAL_CONSUMED_AUTH_DIRS=(/home/kittipat/Workspace/idea3-p4-owner-run/2026-10-03-dnsmasq-unit-repair/auth)
# sha256 of the EXACT first-attempt records (digests only; the contents are never read here, copied or printed). A successor whose authorization-L4.txt or k3-L4.txt is
# byte-identical to either is refused wherever it is stored: copying the historical records into a new directory does not make them a fresh authorization.
DNSREPAIR_HISTORICAL_AUTHORIZATION_SHA256=ae49d20902735ca41a387a34d8a23c7938b50df4cf08691c5bff227fe4a76689
DNSREPAIR_HISTORICAL_K3_SHA256=863f141624a42649c86634bbadc4bca22abf5eea4d02955a1bab2defe0d19912
# PR #305 (merge commit): the repository fix this package installs. A pinned runner must contain it.
DNSREPAIR_PR305_MERGE=827251f2478f03822c42ab43eadb50f73005d432
# sha256 of the EXACT pre-PR305 unit that stages/L4/apply.sh rendered (printf of the unit without the readiness gate). It is the only installed unit this
# package replaces; any other content (local edit, partial repair, raw placeholder template) is refused rather than overwritten.
DNSREPAIR_OLD_UNIT_SHA256=a684746d6e20bf672c93b11f8a8ded32d867b8f72050e88e1f26ab86aad10036
# units whose definitions `systemctl daemon-reload` would re-read: none may have a pending on-disk change this package did not make.
DNSREPAIR_RELOAD_UNITS=(aegis-idea3-dnsmasq.service aegis-idea3-mosquitto.service aegis-idea3-core.service twingate.service mosquitto.service)

dnsrepair_sha256() { sha256sum -- "$1" | cut -d' ' -f1; }

# dnsrepair_render_gate TEMPLATE OUT — render the single canonical template with the FIXED approved L34 values into OUT, refuse any unresolved placeholder,
# and prove the result is byte-identical to what the corrected L34 authority accepts. There is no second unit definition in this package.
dnsrepair_render_gate() {
  local tpl=$1 out=$2
  [ -f "$tpl" ] && [ ! -L "$tpl" ] || { l34_reason "DNSREPAIR_TEMPLATE_MISSING"; return 1; }
  l34_render_dnsmasq_unit "$tpl" > "$out" || { l34_reason "DNSREPAIR_RENDER_FAILED"; return 1; }
  chmod 0644 "$out" || { l34_reason "DNSREPAIR_RENDER_FAILED"; return 1; }
  [ -s "$out" ] || { l34_reason "DNSREPAIR_RENDER_UNRESOLVED"; return 1; }
  ! grep -q '<AEGIS_' "$out" || { l34_reason "DNSREPAIR_RENDER_UNRESOLVED"; return 1; }
  l34_dnsmasq_unit_gate "$out" "$tpl" 2>/dev/null || { l34_reason "DNSREPAIR_RENDERED_UNIT_NOT_ACCEPTED_BY_L34_AUTHORITY"; return 1; }
}

# dnsrepair_installed_unit_gate FILE TEMPLATE — the installed unit is the OLD refused authority and nothing else: a regular root-style 0644 file whose
# digest is the recorded pre-PR305 digest, which the corrected L34 authority refuses. Already-canonical is reported separately (nothing to repair).
dnsrepair_installed_unit_gate() {
  local f=$1 tpl=$2
  [ -f "$f" ] && [ ! -L "$f" ] || { l34_reason "L34_DNSMASQ_UNIT_MISSING"; return 1; }
  if l34_dnsmasq_unit_gate "$f" "$tpl" 2>/dev/null; then l34_reason "DNSREPAIR_UNIT_ALREADY_CANONICAL"; return 1; fi
  [ "$(dnsrepair_sha256 "$f")" = "$DNSREPAIR_OLD_UNIT_SHA256" ] || { l34_reason "DNSREPAIR_UNIT_UNKNOWN_AUTHORITY"; return 1; }
  [ "$(stat -c '%a' -- "$f")" = 644 ] || { l34_reason "DNSREPAIR_UNIT_MODE_UNEXPECTED"; return 1; }
}

# dnsrepair_canonical_unit_gate FILE TEMPLATE — the installed unit is byte-identical to the canonical template RENDERED with the fixed approved values (the corrected L34
# authority, called unchanged). The handlers call this wrapper so this package adds no new direct consumer of l34_dnsmasq_unit_gate (that set is pinned by PR #305's tests).
dnsrepair_canonical_unit_gate() { l34_dnsmasq_unit_gate "$1" "$2"; }

# dnsrepair_analyze_gate FILE — `systemd-analyze verify` accepts the rendered unit (read-only; it only parses and cross-checks the file)
dnsrepair_analyze_gate() {
  systemd-analyze verify "$1" >/dev/null 2>&1 || { l34_reason "DNSREPAIR_SYSTEMD_ANALYZE_FAILED"; return 1; }
}

# dnsrepair_baseline_classify < `systemctl show -p LoadState,ActiveState,SubState,UnitFileState,Result,MainPID aegis-idea3-dnsmasq.service`
# Prints FAILED (the observed boot failure: failed / start-limit-hit, MainPID 0), RUNNING (active/running under the old unit) or SAFE_STOPPED (the exact state a
# governed rollback leaves behind: loaded / enabled / inactive / dead / Result=success / MainPID 0). Anything else — any other inactive or activating state, a
# different failure Result, disabled, masked — is unsupported and refused. SAFE_STOPPED is admitted ONLY by this exact property set; it widens no other baseline.
dnsrepair_baseline_classify() {
  local text kv
  text=$(cat)
  if grep -qx 'ActiveState=failed' <<< "$text"; then
    for kv in LoadState=loaded UnitFileState=enabled ActiveState=failed SubState=failed Result=start-limit-hit MainPID=0; do
      grep -qx "$kv" <<< "$text" || { l34_reason "DNSREPAIR_DNSMASQ_BASELINE_UNSUPPORTED:${kv%%=*}"; return 1; }
    done
    printf 'FAILED\n'
  elif grep -qx 'ActiveState=active' <<< "$text"; then
    for kv in LoadState=loaded UnitFileState=enabled ActiveState=active SubState=running Result=success; do
      grep -qx "$kv" <<< "$text" || { l34_reason "DNSREPAIR_DNSMASQ_BASELINE_UNSUPPORTED:${kv%%=*}"; return 1; }
    done
    grep -Eq '^MainPID=[1-9][0-9]*$' <<< "$text" || { l34_reason "DNSREPAIR_DNSMASQ_BASELINE_UNSUPPORTED:MainPID"; return 1; }
    printf 'RUNNING\n'
  elif grep -qx 'ActiveState=inactive' <<< "$text"; then
    for kv in LoadState=loaded UnitFileState=enabled ActiveState=inactive SubState=dead Result=success MainPID=0; do
      grep -qx "$kv" <<< "$text" || { l34_reason "DNSREPAIR_DNSMASQ_BASELINE_UNSUPPORTED:${kv%%=*}"; return 1; }
    done
    printf 'SAFE_STOPPED\n'
  else
    l34_reason "DNSREPAIR_DNSMASQ_BASELINE_UNSUPPORTED:ActiveState"; return 1
  fi
}

# dnsrepair_need_reload_gate — no unit `daemon-reload` would re-read has a pending, unreviewed on-disk change (read-only)
dnsrepair_need_reload_gate() {
  local u v
  for u in "${DNSREPAIR_RELOAD_UNITS[@]}"; do
    v=$(systemctl show -p NeedDaemonReload --value "$u" 2>/dev/null) || { l34_reason "DNSREPAIR_NEED_DAEMON_RELOAD_UNREADABLE:$u"; return 1; }
    [ "$v" = no ] || { l34_reason "DNSREPAIR_NEEDS_DAEMON_RELOAD:$u"; return 1; }
  done
}

# dnsrepair_ap_unchanged_gate AP_IF — the AP is exactly the approved one, served by the approved profile, and no other Wi-Fi connection is active
dnsrepair_ap_unchanged_gate() {
  local ap=$1 active
  l34_ap_active_gate "$ap" || return 1
  [ "$(nmcli -g GENERAL.CONNECTION device show "$ap" 2>/dev/null)" = "$L34_CONN" ] || { l34_reason "DNSREPAIR_AP_CONNECTION_NOT_APPROVED_PROFILE"; return 1; }
  active=$(nmcli -t -f TYPE,DEVICE connection show --active 2>/dev/null) || { l34_reason "L34_WIFI_ACTIVE_UNREADABLE"; return 1; }
  [ "$(grep -c '^802-11-wireless' <<< "$active" || true)" = 1 ] && grep -qx "802-11-wireless:$ap" <<< "$active" || { l34_reason "DNSREPAIR_UNRELATED_WIFI_ACTIVE"; return 1; }
}

# dnsrepair_persistent_snapshot OUT PROFILE FILE... — the profile gets the canonical non-secret record (order/uuid/timestamp/autoconnect tolerant: NetworkManager may
# legitimately re-serialize it); every other accepted persistent file keeps the exact mode/owner/size/mtime/ctime/digest record.
dnsrepair_persistent_snapshot() { l34_v8_persistent_snapshot "$@"; }

# dnsrepair_persistent_verify SNAPSHOT — nothing in the snapshot moved (this package never writes any of these files)
dnsrepair_persistent_verify() {
  local snap=$1 rec f cur
  [ -s "$snap" ] || { l34_reason "L34_PERSISTENT_SNAPSHOT_MISSING"; return 1; }
  while IFS= read -r rec; do
    f=${rec%%$'\t'*}
    case "$f" in
      *.nmconnection) cur=$(l34_v8_profile_record "$f") || return 1 ;;
      *) cur=$(l34_persistent_line "$f") || return 1 ;;
    esac
    [ "$cur" = "$rec" ] || { l34_reason "L34_PERSISTENT_FILE_CHANGED:${f##*/}"; return 1; }
  done < "$snap"
}

# dnsrepair_install_unit SRC DEST — THE ONLY FILE WRITE IN THIS PACKAGE OUTSIDE ITS OWN EVIDENCE DIRECTORY: atomically replace the dnsmasq unit file.
# A same-directory temporary is created 0644 and renamed over DEST (rename is atomic on one filesystem), so DEST is always either the whole old unit or the
# whole new unit. The temporary has a suffix systemd ignores, so a failed rename cannot be mistaken for a unit.
dnsrepair_install_unit() {
  local src=$1 dest=$2 tmp="$2.aegis-repair-new"
  [ ! -e "$tmp" ] || { l34_reason "DNSREPAIR_INSTALL_TEMP_EXISTS"; return 1; }
  install -m 0644 -- "$src" "$tmp" || { l34_reason "DNSREPAIR_INSTALL_FAILED"; return 1; }
  mv -T -- "$tmp" "$dest" || { l34_reason "DNSREPAIR_INSTALL_RENAME_FAILED"; return 1; }
}

# dnsrepair_journal_count FILE KIND — how many journal lines of this exact kind exist (the journal is the ownership record rollback acts on)
dnsrepair_journal_count() { awk -F'\t' -v k="$2" '$1 == k { n++ } END { print n + 0 }' "$1"; }
