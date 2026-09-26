#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — L6b owner-run gate library (sourced by the external frozen owner runner; nothing here runs
# on its own and nothing here mutates the host). Pure gate logic so it can be tested with stubs and fixture repositories.
# Every function returns 0 on PASS; on FAIL it prints one `reason` line to stderr and returns 1.
# Commands are resolved from PATH so tests can stub `ip`, `iw`, `nmcli`; SUDO defaults to `sudo` (tests set SUDO="").

: "${SUDO=sudo}"

L6B_LOGS_REL=Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs
L6B_L6A_RECEIPT_RE='_music_idea3-pr11-l6a-live-acceptance\.md$'

l6b_reason() { printf '%s\n' "$1" >&2; return 1; }

# l6b_consume_attempt AUTH_DIR — one live attempt per authorization (OD-L6B-08). Atomic create-if-absent; a second
# invocation for the same AUTH_DIR fails closed even if the first attempt failed.
l6b_consume_attempt() {
  local dir=${1:-} marker
  [ -d "$dir" ] && [ ! -L "$dir" ] || { l6b_reason "L6B_ATTEMPT_AUTH_DIR_INVALID"; return 1; }
  marker="$dir/L6B-ATTEMPT-CONSUMED"
  if ( set -o noclobber; printf 'consumed_at=%s\n' "$(date -u +%FT%TZ)" > "$marker" ) 2>/dev/null; then
    return 0
  fi
  l6b_reason "L6B_ATTEMPT_ALREADY_CONSUMED (one live attempt per authorization; obtain a fresh same-day authorization)"
}

# l6b_receipt_gate REPO — predecessor ACCEPTANCE proven by receipts read from the PINNED commit (HEAD == merged main),
# never from the working tree. This proves historical acceptance only; current runtime state is gated separately.
l6b_receipt_gate() {
  local repo=${1:-} n path
  git -C "$repo" rev-parse --verify -q HEAD >/dev/null || { l6b_reason "L6B_RECEIPT_GATE_NO_HEAD"; return 1; }
  for n in 2 3 4 5; do
    git -C "$repo" grep -qE "L${n}_LIVE_ACCEPTANCE ?= ?\`? ?PROVEN" HEAD -- "$L6B_LOGS_REL" \
      || { l6b_reason "L6B_PREDECESSOR_RECEIPT_MISSING:L${n}"; return 1; }
  done
  mapfile -t l6a < <(git -C "$repo" ls-tree -r --name-only HEAD -- "$L6B_LOGS_REL" | grep -E "$L6B_L6A_RECEIPT_RE")
  [ "${#l6a[@]}" = 1 ] || { l6b_reason "L6B_L6A_RECEIPT_NOT_EXACTLY_ONE:${#l6a[@]}"; return 1; }
  path=${l6a[0]}
  git -C "$repo" show "HEAD:$path" | grep -qx 'L6A_LIVE_ACCEPTANCE=PROVEN' \
    || { l6b_reason "L6B_L6A_ACCEPTANCE_MARKER_MISSING"; return 1; }
  git -C "$repo" show "HEAD:$path" | grep -qx 'L6A_COMPLETE=YES' \
    || { l6b_reason "L6B_L6A_COMPLETE_MARKER_MISSING"; return 1; }
  git -C "$repo" show "HEAD:$path" | grep -qx 'L6B_STARTED=NO' \
    || { l6b_reason "L6B_L6A_RECEIPT_CLAIMS_L6B_STARTED"; return 1; }
  printf 'L6A_RECEIPT=%s\n' "$path"
}

# l6b_resolve_uplink AP_IF AP_ADDR EXPECTED_IF EXPECTED_ADDR — OD-L6B-06. Freezes the CURRENT uplink IPv4 (never a
# hard-coded production value). Fails closed if missing/ambiguous/loopback/AP; a difference from the expected topology is
# reported for owner review and is accepted only via AEGIS_L6B_ACCEPT_UPLINK=<if>:<addr> naming exactly the observed pair.
# Sets L6B_UPLINK_IF / L6B_UPLINK_ADDR.
l6b_resolve_uplink() {
  local ap_if=$1 ap_addr=$2 exp_if=$3 exp_addr=$4 line ifn a
  local -a routes addrs
  mapfile -t routes < <(ip -4 route show default)
  [ "${#routes[@]}" = 1 ] || { l6b_reason "L6B_UPLINK_DEFAULT_ROUTE_COUNT:${#routes[@]}"; return 1; }
  line=${routes[0]}
  ifn=$(awk '{ for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit } }' <<< "$line")
  [ -n "$ifn" ] || { l6b_reason "L6B_UPLINK_INTERFACE_UNKNOWN"; return 1; }
  [ "$ifn" != "$ap_if" ] || { l6b_reason "L6B_UPLINK_IS_AP_INTERFACE"; return 1; }
  mapfile -t addrs < <(ip -4 -o addr show dev "$ifn" scope global | awk '{ split($4, p, "/"); print p[1] }')
  [ "${#addrs[@]}" = 1 ] || { l6b_reason "L6B_UPLINK_ADDRESS_COUNT:${#addrs[@]}"; return 1; }
  a=${addrs[0]}
  [[ "$a" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || { l6b_reason "L6B_UPLINK_ADDRESS_INVALID"; return 1; }
  case "$a" in 127.* | 0.* | 224.* | 255.*) l6b_reason "L6B_UPLINK_ADDRESS_NOT_ROUTABLE"; return 1 ;; esac
  [ "$a" != "$ap_addr" ] || { l6b_reason "L6B_UPLINK_EQUALS_AP_ADDRESS"; return 1; }
  if [ "$ifn" != "$exp_if" ] || [ "$a" != "$exp_addr" ]; then
    if [ "${AEGIS_L6B_ACCEPT_UPLINK:-}" != "$ifn:$a" ]; then
      l6b_reason "L6B_UPLINK_EXPECTATION_MISMATCH observed=$ifn:$a expected=$exp_if:$exp_addr (owner review; to accept set AEGIS_L6B_ACCEPT_UPLINK=$ifn:$a)"
      return 1
    fi
  fi
  L6B_UPLINK_IF=$ifn
  L6B_UPLINK_ADDR=$a
}

# l6b_ap_runtime_gate AP_IF AP_ADDR — OD-L6B-03/04/05: FRESH proof that the L3/L4 AP topology is currently applied.
# Never repairs anything: a missing predecessor is PREDECESSOR_RUNTIME_REACTIVATION_REQUIRED (separate owner action).
l6b_ap_runtime_gate() {
  local ap_if=$1 ap_addr=$2 out
  ip -o link show dev "$ap_if" >/dev/null 2>&1 || { l6b_reason "PREDECESSOR_RUNTIME_REACTIVATION_REQUIRED=YES:AP_INTERFACE_MISSING"; return 1; }
  ip -4 -o addr show dev "$ap_if" | awk '{ split($4, p, "/"); print p[1] }' | grep -qx "$ap_addr" \
    || { l6b_reason "PREDECESSOR_RUNTIME_REACTIVATION_REQUIRED=YES:AP_ADDRESS_NOT_PRESENT:$ap_addr"; return 1; }
  out=$(iw dev "$ap_if" info 2>/dev/null) || { l6b_reason "PREDECESSOR_RUNTIME_REACTIVATION_REQUIRED=YES:AP_STATE_UNREADABLE"; return 1; }
  [ "$(awk '$1 == "type" { print $2 }' <<< "$out")" = AP ] \
    || { l6b_reason "PREDECESSOR_RUNTIME_REACTIVATION_REQUIRED=YES:AP_NOT_IN_AP_MODE"; return 1; }
  awk '$1 == "ssid" { $1 = ""; sub(/^ /, ""); print }' <<< "$out" | grep -qx 'AEGIS-IDEA3' \
    || { l6b_reason "PREDECESSOR_RUNTIME_REACTIVATION_REQUIRED=YES:AP_SSID_MISMATCH"; return 1; }
  [ "$(nmcli -g GENERAL.CONNECTION device show "$ap_if" 2>/dev/null)" = aegis-idea3-ap ] \
    || { l6b_reason "PREDECESSOR_RUNTIME_REACTIVATION_REQUIRED=YES:AP_PROFILE_NOT_ACTIVE"; return 1; }
}

# l6b_nft_text_gate AP_IF < nft table text — L2 runtime + PF-01 (explicit AP-interface TCP/1883 drop), and no NAT.
l6b_nft_text_gate() {
  local ap_if=$1 text
  text=$(cat)
  [ -n "$text" ] || { l6b_reason "PREDECESSOR_RUNTIME_REACTIVATION_REQUIRED=YES:L2_NFT_TABLE_ABSENT"; return 1; }
  grep -q 'table inet aegis_idea3' <<< "$text" || { l6b_reason "PREDECESSOR_RUNTIME_REACTIVATION_REQUIRED=YES:L2_NFT_TABLE_ABSENT"; return 1; }
  grep -Eq "iifname[[:space:]]+\"?$ap_if\"?.*tcp dport 1883.*drop" <<< "$text" \
    || { l6b_reason "PF01_EXPLICIT_1883_DROP_MISSING"; return 1; }
  ! grep -Eq '\b(masquerade|snat|dnat)\b' <<< "$text" || { l6b_reason "L6B_NAT_IN_IDEA3_TABLE"; return 1; }
}

# l6b_trustedclock_gate PROBE_OUTPUT — L5 requires historical PROVEN plus a FRESH read-only TrustedClock proof (not chronyd).
l6b_trustedclock_gate() {
  [[ "${1:-}" =~ ^state=SYNCED\ reason=OK\ maxerror_us=[0-9]+\  ]] || { l6b_reason "L6B_TRUSTEDCLOCK_NOT_OK"; return 1; }
}

# l6b_input_gate INPUT_DIR PY P4_DIR — private JIT input contract + PKI validation including the key relationship.
l6b_input_gate() {
  local dir=$1 py=$2 p4=$3 f
  [ -d "$dir" ] && [ ! -L "$dir" ] || { l6b_reason "L6B_INPUT_DIR_INVALID"; return 1; }
  [ "$(stat -c %a "$dir")" = 700 ] || { l6b_reason "L6B_INPUT_DIR_MODE_NOT_0700"; return 1; }
  [ "$(stat -c %u "$dir")" = "$(id -u)" ] || { l6b_reason "L6B_INPUT_DIR_OWNER_MISMATCH"; return 1; }
  [ ! -e "$dir/ca.key" ] && [ ! -L "$dir/ca.key" ] || { l6b_reason "L6B_CA_PRIVATE_KEY_FORBIDDEN"; return 1; }
  [ "$(ls -A "$dir" | LC_ALL=C sort | paste -sd,)" = "broker.crt,broker.key,ca.crt,core.pass,device.pass" ] \
    || { l6b_reason "L6B_INPUT_ENTRIES_NOT_EXACT"; return 1; }
  for f in broker.crt broker.key ca.crt core.pass device.pass; do
    [ -f "$dir/$f" ] && [ ! -L "$dir/$f" ] || { l6b_reason "L6B_INPUT_NOT_REGULAR:$f"; return 1; }
  done
  for f in broker.key core.pass device.pass; do
    case "$(stat -c %a "$dir/$f")" in 600 | 400) ;; *) l6b_reason "L6B_INPUT_SECRET_MODE_INVALID:$f"; return 1 ;; esac
  done
  for f in ca.crt broker.crt; do
    [ -z "$(find "$dir/$f" -perm /022)" ] || { l6b_reason "L6B_INPUT_CERT_WRITABLE:$f"; return 1; }
  done
  "$py" "$p4/p4-mqtt-pki.py" validate-broker-cert --ca-file "$dir/ca.crt" --cert-file "$dir/broker.crt" \
    --key-file "$dir/broker.key" >/dev/null 2>&1 || { l6b_reason "L6B_PKI_VALIDATION_FAILED"; return 1; }
}

# l6b_secret_scan INPUT_DIR EVID_DIR PY — no plaintext password, private-key block or Mosquitto password hash may appear
# anywhere in the evidence. Runs through $SUDO so root-owned captures are covered. Prints only counts, never values.
l6b_secret_scan() {
  local inp=$1 evid=$2 py=$3
  $SUDO "$py" - "$inp" "$evid" <<'PYC'
import pathlib, re, sys
inp, ev = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
secrets = [l.strip() for n in ("core.pass", "device.pass") for l in (inp / n).read_text().splitlines() if len(l.strip()) >= 6]
keylines = [l.strip() for l in (inp / "broker.key").read_text().splitlines() if len(l.strip()) >= 16 and not l.startswith("-----")]
pem = re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")
mosq_hash = re.compile(r"\$7\$\d+\$")
bad = scanned = 0
for f in ev.rglob("*"):
    if not f.is_file() or f.stat().st_size >= 50_000_000:
        continue
    scanned += 1
    t = f.read_text(errors="ignore")
    if any(s in t for s in secrets + keylines) or pem.search(t) or mosq_hash.search(t):
        bad += 1
print(f"SECRET_SCAN_FILES={scanned} SECRET_SCAN_HITS={bad}")
sys.exit(1 if bad else 0)
PYC
}
