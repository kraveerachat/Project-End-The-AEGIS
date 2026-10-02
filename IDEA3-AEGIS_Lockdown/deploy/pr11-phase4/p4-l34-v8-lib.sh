# shellcheck shell=bash
# AEGIS IDEA3 PR11 Phase 4 — L3/L4 POST-V7 PERSISTENT AP RECOVERY (V8) gate library.
# Sourced by reactivation/l34-v8-post-v7-persistent-ap-recovery/{apply,verify,rollback}.sh AFTER p4-l34-reactivation-lib.sh (whose V1–V7 functions are
# reused unchanged and are NOT modified by V8). Nothing here mutates anything: every function is a read-only check or a pure formatter. Each function
# returns 0 on PASS; on FAIL it prints one stable reason line to stderr and returns 1. The Wi-Fi PSK is never printed or digested.
#
# V8 exists because V7 was explicitly RUNTIME_ONLY and K12_AUTOMATIC_REBOOT_PERSISTENCE was NOT_PROVEN: after two reboots the AP profile (autoconnect=no)
# was never activated, dnsmasq hit its start limit and the L6b broker crash-looped again. V8 recovers that state like V7 AND performs exactly ONE reviewed
# persistent change: the NetworkManager `aegis-idea3-ap` connection.autoconnect transition no -> yes (OD-L34-V8-01). Every other persistent artifact must
# stay byte/metadata identical; the profile itself must stay identical in every non-secret line except its autoconnect line.
# V8 does NOT prove K12 automatic reboot persistence, L3, L4 or L6b acceptance.

L34_V8_STAGE_NAME="l34-v8-post-v7-persistent-ap-recovery"
L34_V8_BASELINE_ID="POST_V7_RADIO_DISABLED_AP_DOWN_BROKER_CHURN"
L34_V8_MARKER_NAME="L34-V8-REACTIVATION-ATTEMPT-CONSUMED"
L34_V8_PROFILE_AUTOCONNECT_TARGET=yes

# l34_v8_profile_file_autoconnect FILE — prints the keyfile's own [connection] autoconnect value: false | true | absent. NetworkManager does not
# serialize the default value (true), so `absent` is how a persisted autoconnect=yes normally looks. Anything else, or a duplicate, is malformed.
l34_v8_profile_file_autoconnect() {
  local f=$1 rows n
  [ -f "$f" ] && [ ! -L "$f" ] || { l34_reason "L34_V8_PROFILE_MISSING"; return 1; }
  rows=$(awk '/^\[/ { on = ($0 == "[connection]"); next } on && /^[[:space:]]*autoconnect[[:space:]]*=/ { gsub(/[[:space:]]/, ""); print }' "$f")
  n=$(grep -c . <<< "$rows" || true)
  case "$n" in
    0) printf 'absent\n' ;;
    1) case "$rows" in autoconnect=false) printf 'false\n' ;; autoconnect=true) printf 'true\n' ;; *) l34_reason "L34_V8_PROFILE_AUTOCONNECT_MALFORMED"; return 1 ;; esac ;;
    *) l34_reason "L34_V8_PROFILE_AUTOCONNECT_DUPLICATE"; return 1 ;;
  esac
}

# l34_v8_pre_autoconnect_gate DEVICE_VALUE NM_PROFILE_VALUE FILE_VALUE — the ONE supported PRE state: the device value is a readable yes|no (it is journaled
# and restored exactly), the persisted profile's own autoconnect is exactly `no` both as NetworkManager reports it and as the keyfile stores it.
# A profile that already autoconnects is REFUSED (V8 never "re-applies" an already-persisted policy; that is a different, reviewed operation).
l34_v8_pre_autoconnect_gate() {
  local dev=$1 profile=$2 file=$3
  [[ "$dev" =~ ^(yes|no)$ ]] || { l34_reason "L34_V8_DEVICE_AUTOCONNECT_UNEXPECTED:$dev"; return 1; }
  case "$profile" in
    no) ;;
    yes) l34_reason "L34_V8_AP_PROFILE_ALREADY_AUTOCONNECT"; return 1 ;;
    *) l34_reason "L34_V8_AP_PROFILE_AUTOCONNECT_UNEXPECTED:$profile"; return 1 ;;
  esac
  [ "$file" = false ] || { l34_reason "L34_V8_AP_PROFILE_FILE_AUTOCONNECT_NOT_FALSE:$file"; return 1; }
}

# l34_v8_profile_record FILE — one snapshot record for the PSK-bearing profile: path, mode:uid:gid (NO size/mtime/ctime: the one approved rewrite changes
# them), the digest of its NON-secret lines EXCLUDING the autoconnect line, and the NUMBER of secret lines (a count, never a value or a digest of one).
l34_v8_profile_record() {
  local f=$1 meta digest psk
  [ -f "$f" ] && [ ! -L "$f" ] || { l34_reason "L34_V8_PROFILE_MISSING"; return 1; }
  meta=$(stat -c '%a:%u:%g' -- "$f")
  digest=$(grep -viE '^[[:space:]]*(psk|wep-key[0-9]*|leap-password|password|private-key-password|pin|autoconnect)[[:space:]]*=' "$f" | sha256sum | cut -d' ' -f1)
  psk=$(grep -ciE '^[[:space:]]*psk[[:space:]]*=' "$f" || true)
  printf '%s\t%s\t%s\tpsk_lines=%s\n' "$f" "$meta" "$digest" "$psk"
}

# l34_v8_persistent_snapshot OUT PROFILE FILE... — the PROFILE gets the autoconnect-normalized record; every other accepted persistent file keeps the exact
# V1–V7 record (mode, uid, gid, size, mtime, ctime, digest).
l34_v8_persistent_snapshot() {
  local out=$1 profile=$2 f line
  shift 2
  : > "$out"
  line=$(l34_v8_profile_record "$profile") || return 1
  printf '%s\n' "$line" >> "$out"
  for f in "$@"; do
    line=$(l34_persistent_line "$f") || return 1
    printf '%s\n' "$line" >> "$out"
  done
}

# l34_v8_persistent_verify SNAPSHOT EXPECT — EXPECT=no  : the profile is back to autoconnect=false (apply not yet made, or rolled back);
#                                            EXPECT=yes : the profile carries the ONE approved change (autoconnect absent|true).
# In both cases every non-secret profile line except autoconnect is identical to the snapshot, and every other persistent file is byte/metadata identical.
l34_v8_persistent_verify() {
  local snap=$1 expect=$2 rec f cur val
  [ -s "$snap" ] || { l34_reason "L34_PERSISTENT_SNAPSHOT_MISSING"; return 1; }
  [[ "$expect" =~ ^(yes|no)$ ]] || { l34_reason "L34_V8_EXPECT_INVALID"; return 1; }
  while IFS= read -r rec; do
    f=${rec%%$'\t'*}
    case "$f" in
      *.nmconnection)
        cur=$(l34_v8_profile_record "$f") || return 1
        [ "$cur" = "$rec" ] || { l34_reason "L34_V8_PROFILE_CHANGED_BEYOND_AUTOCONNECT:${f##*/}"; return 1; }
        val=$(l34_v8_profile_file_autoconnect "$f") || return 1
        if [ "$expect" = no ]; then
          [ "$val" = false ] || { l34_reason "L34_V8_PROFILE_AUTOCONNECT_NOT_FALSE:$val"; return 1; }
        else
          [ "$val" != false ] || { l34_reason "L34_V8_PROFILE_AUTOCONNECT_NOT_ENABLED"; return 1; }
        fi ;;
      *)
        cur=$(l34_persistent_line "$f") || return 1
        [ "$cur" = "$rec" ] || { l34_reason "L34_PERSISTENT_FILE_CHANGED:${f##*/}"; return 1; } ;;
    esac
  done < "$snap"
}

# l34_v8_profile_autoconnect_enabled_gate FILE — NetworkManager reports connection.autoconnect=yes AND the keyfile does not store autoconnect=false
l34_v8_profile_autoconnect_enabled_gate() {
  local f=$1 val
  [ "$(l34_v4_ap_profile_autoconnect)" = yes ] || { l34_reason "L34_V8_AP_PROFILE_AUTOCONNECT_NOT_ENABLED"; return 1; }
  val=$(l34_v8_profile_file_autoconnect "$f") || return 1
  [ "$val" != false ] || { l34_reason "L34_V8_AP_PROFILE_FILE_AUTOCONNECT_STILL_FALSE"; return 1; }
}

# l34_v8_journal_count FILE KIND — how many journal lines of this exact kind exist (the journal is the ownership record rollback acts on)
l34_v8_journal_count() { awk -F'\t' -v k="$2" '$1 == k { n++ } END { print n + 0 }' "$1"; }

# l34_v8_consume_attempt AUTH_DIR — one bounded V8 attempt per authorization (atomic create-if-absent). The marker name is V8-only: no V1–V7 marker
# ever authorizes V8 and a V7 marker in the directory refuses it.
l34_v8_consume_attempt() {
  local dir=${1:-} marker
  [ -d "$dir" ] && [ ! -L "$dir" ] || { l34_reason "L34_V8_ATTEMPT_AUTH_DIR_INVALID"; return 1; }
  marker="$dir/$L34_V8_MARKER_NAME"
  if ( set -o noclobber; printf 'consumed_at=%s\n' "$(date -u +%FT%TZ)" > "$marker" ) 2>/dev/null; then return 0; fi
  l34_reason "L34_V8_ATTEMPT_ALREADY_CONSUMED (one bounded attempt per authorization; obtain a fresh same-day authorization)"
}
