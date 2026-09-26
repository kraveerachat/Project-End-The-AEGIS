#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — L6b LIVE separate TLS broker, ONE owner-supervised attempt. OWNER-RUN ONLY.
# REPOSITORY TEMPLATE: EXPECTED_MAIN is unpinned, so this file REFUSES TO RUN as committed. The owner freeze workflow copies it
# OUTSIDE the repository (e.g. ~/Workspace/idea3-p4-evidence/l6b-owner-run/), replaces PIN_MAIN_SHA with the merged main SHA,
# records the frozen file's SHA-256, and only then authorizes a run. Design: docs/superpowers/specs/2026-09-27-idea3-pr11-phase4-l6b-operational-design.md
# Usage (normal user, NOT root):  bash run-l6b-owner.sh <AUTH_DIR>     AUTH_DIR holds authorization-L6b.txt and k3-L6b.txt
# L6b is PERSISTENT on success (aegis-idea3-mosquitto.service stays enabled+active with the stage-owned material installed).
# It rolls back ONLY on failure/abort. It never reactivates L2/L3/L4, never touches legacy mosquitto.service, Twingate, chrony/
# timesyncd, NetworkManager, nftables, forwarding, any ESP32/serial device, and never starts L7. NO automatic retry; one attempt
# per authorization. It does not delete the plaintext JIT input (a separately authorized owner workflow does).
set -Eeuo pipefail
umask 077

EXPECTED_MAIN=PIN_MAIN_SHA
case "$EXPECTED_MAIN" in PIN_*) echo "STOP: runner is not pinned (EXPECTED_MAIN). Run the owner freeze workflow first."; exit 2 ;; esac
[[ "$EXPECTED_MAIN" =~ ^[0-9a-f]{40}$ ]] || { echo "STOP: EXPECTED_MAIN is not a 40-hex SHA."; exit 2; }
[ "$(id -u)" != 0 ] || { echo "Run as your normal user, not root."; exit 2; }
AUTH_DIR=${1:-}
[ -n "$AUTH_DIR" ] && [ -d "$AUTH_DIR" ] || { echo "usage: bash $0 <AUTH_DIR with authorization-L6b.txt and k3-L6b.txt>"; exit 2; }

# ---- frozen inputs -----------------------------------------------------------------------------------------------------
REPO=/home/kittipat/Workspace/IDEA3-Cyber-Last/worktrees/Project-End-The-AEGIS-L6BLIVE   # clean pinned execution worktree at merged main
INPUT_DIR=/home/kittipat/Workspace/idea3-p4-evidence/l6b-owner-input
PY=/home/kittipat/.venvs/aegis-idea3-core/bin/python
P4=$REPO/IDEA3-AEGIS_Lockdown/deploy/pr11-phase4
STG=$P4/stages/L6b
LIB=$P4/p4-l6b-run-lib.sh
CLOCK=$P4/p4-l5-clock.py
AP_IF=wlp0s20f3                 # OD-L6B-04
AP_ADDR=10.77.30.1              # OD-L6B-05 (must be freshly proven present before apply)
EXP_UPLINK_IF=enp62s0           # OD-L6B-06 expectation only; the value used is the FRESH runtime value
EXP_UPLINK_ADDR=192.168.1.144
TODAY=$(TZ=Asia/Bangkok date +%F)
STAMP=$(TZ=Asia/Bangkok date +%Y%m%d-%H%M%S)
EVID=/home/kittipat/Workspace/idea3-p4-evidence/$TODAY-l6b-$STAMP
WORK=$EVID/l6b-work
ENGINE=aegis-detection-engine.service; TUNNEL=aegis-detection-tunnel.service
UNIT=aegis-idea3-mosquitto.service

die() { echo "STOP: $*" >&2; exit 1; }
GATE_FAILED=0; gate() { echo "GATE_FAIL: $*" >&2; GATE_FAILED=1; }
show() { systemctl show -p "$2" --value "$1"; }
listen_now() { ss -ltnH | awk '{print $4}'; }

[ -f "$LIB" ] || die "gate library missing: $LIB (is $REPO at the pinned main?)"
# shellcheck disable=SC1090
source "$LIB"

echo "== L6b owner-run: pre-gates (read-only; nothing is created or changed yet)"
sudo -v || die "sudo authentication failed"

# 1. pinned main, clean pinned worktree, same-day records, stage gate (live mode)
for f in authorization-L6b.txt k3-L6b.txt; do
  [ -f "$AUTH_DIR/$f" ] || gate "$f missing"
  grep -qx "date=$TODAY" "$AUTH_DIR/$f" 2>/dev/null || gate "$f date is not today ($TODAY Asia/Bangkok)"
  grep -qx "stage=L6b" "$AUTH_DIR/$f" 2>/dev/null || gate "$f is not stage=L6b"
done
[ ! -e "$AUTH_DIR/L6B-ATTEMPT-CONSUMED" ] || gate "this authorization already consumed its one live attempt"
[ "$(git -C "$REPO" rev-parse HEAD)" = "$EXPECTED_MAIN" ] || gate "worktree HEAD is not $EXPECTED_MAIN"
[ -z "$(git -C "$REPO" status --porcelain)" ] || gate "worktree is not clean"
git -C "$REPO" fetch -q origin 2>/dev/null && [ "$(git -C "$REPO" rev-parse origin/main)" = "$EXPECTED_MAIN" ] \
  || gate "origin/main is not $EXPECTED_MAIN (or fetch failed); not silently re-pinning"
for f in apply.sh verify.sh rollback.sh allow-keys.txt allow-listeners.txt; do [ -f "$STG/$f" ] || gate "handler file $f missing"; done
gate_out=$(TZ=Asia/Bangkok bash "$P4/p4-stage-gate.sh" --stage L6b --mode live --authorization "$AUTH_DIR/authorization-L6b.txt" --k3 "$AUTH_DIR/k3-L6b.txt" 2>&1) || gate "stage gate failed"
for l in AUTHORIZATION_RECORD=VALID K3_CONFIRMATION=VALID ROLLBACK_HANDLER=REGISTERED; do printf '%s\n' "$gate_out" | grep -qx "$l" || gate "stage gate did not report $l"; done

# 2. predecessor ACCEPTANCE (historical) from receipts at the pinned commit; L6A must be merged + PROVEN
l6b_receipt_gate "$REPO" >/dev/null || gate "predecessor receipt gate failed (see reason above)"

# 3. tools / pinned python (the verify handler runs as root through this interpreter)
"$PY" - <<'PYC' >/dev/null 2>&1 || gate "pinned python lacks paho-mqtt 2.1.0 with CallbackAPIVersion"
import importlib.metadata as m, paho.mqtt.client as c, sys
sys.exit(0 if m.version("paho-mqtt") == "2.1.0" and hasattr(c, "CallbackAPIVersion") else 1)
PYC
for c in mosquitto mosquitto_passwd openssl ss ip iw nmcli nft; do command -v "$c" >/dev/null || gate "$c missing"; done

# 4. private JIT input (never printed) + PKI incl. key match
l6b_input_gate "$INPUT_DIR" "$PY" "$P4" || gate "owner input gate failed (see reason above)"
[ ! -e "$EVID" ] || gate "$EVID already exists"
case "$INPUT_DIR" in "$EVID"*|/etc/*) gate "input dir overlaps evidence or /etc" ;; esac

# 5. CURRENT predecessor runtime (fresh proof; never repaired here). Historical PROVEN does NOT imply this.
l6b_ap_runtime_gate "$AP_IF" "$AP_ADDR" || gate "AP runtime gate failed (PREDECESSOR_RUNTIME_REACTIVATION_REQUIRED is a separate owner action)"
NFT_TEXT=$(sudo nft list table inet aegis_idea3 2>/dev/null || true)
printf '%s\n' "$NFT_TEXT" | l6b_nft_text_gate "$AP_IF" || gate "L2 nft / PF-01 gate failed (PREDECESSOR_RUNTIME_REACTIVATION_REQUIRED is a separate owner action)"
[ "$(show aegis-idea3-dnsmasq.service ActiveState)" = active ] && [ "$(show aegis-idea3-dnsmasq.service SubState)" = running ] \
  || gate "PREDECESSOR_RUNTIME_REACTIVATION_REQUIRED=YES:L4_DNSMASQ_NOT_RUNNING"
TC=$(python3 "$CLOCK" probe 2>&1 || true)
l6b_trustedclock_gate "$TC" || gate "TrustedClock fresh read-only proof not OK ($TC)"
l6b_resolve_uplink "$AP_IF" "$AP_ADDR" "$EXP_UPLINK_IF" "$EXP_UPLINK_ADDR" || gate "uplink resolution failed"
UPLINK_ADDR=${L6B_UPLINK_ADDR:-}; UPLINK_IF=${L6B_UPLINK_IF:-}

# 6. host safety
disk_pct=$(df -P / | awk 'NR == 2 { sub("%", "", $5); print $5 }'); [ "$disk_pct" -lt 90 ] || gate "disk $disk_pct% >= 90"
for u in "$ENGINE" "$TUNNEL" twingate.service mosquitto.service; do [ "$(show "$u" ActiveState)" = active ] && [ "$(show "$u" SubState)" = running ] || gate "$u not active/running"; done
listen_now | grep -qx '0.0.0.0:1883' || gate "legacy 1883 wildcard listener not present (expected legacy broker state)"
[ "$(show "$UNIT" LoadState)" = not-found ] || gate "$UNIT is already loaded (first L6b apply requires it absent)"
[ ! -e /etc/systemd/system/$UNIT ] || gate "IDEA3 unit file already exists"
sudo test ! -e /etc/aegis-idea3/mqtt || gate "/etc/aegis-idea3/mqtt already exists (stage-owned: must be absent)"
[ -z "$(ss -H -ltn "sport = :8883")" ] || gate "an 8883 listener already exists"
for k in net.ipv4.ip_forward net.ipv4.conf.all.forwarding net.ipv6.conf.all.forwarding; do [ "$(sysctl -n $k)" = 0 ] || gate "$k is not 0"; done
[ "$GATE_FAILED" = 0 ] || die "one or more pre-gates failed; NOTHING was created or changed"

# 7. authorization is consumed here (one attempt): from this point a second invocation for this AUTH_DIR is refused
l6b_consume_attempt "$AUTH_DIR" || die "could not consume the one-attempt marker"

ENGINE_PRE="$(show $ENGINE MainPID)/$(show $ENGINE NRestarts)"; TUNNEL_PRE="$(show $TUNNEL MainPID)/$(show $TUNNEL NRestarts)"
TG_PRE="$(show twingate.service MainPID)/$(show twingate.service NRestarts)"; MQ_PRE="$(show mosquitto.service MainPID)/$(show mosquitto.service NRestarts)"
L1883_PRE=$(ss -ltnH | awk '$4 ~ /:1883$/ {print $4}' | LC_ALL=C sort -u)

mkdir -m 700 "$EVID"; exec > >(tee -a "$EVID/owner-run.log") 2>&1
JOURNAL_SINCE=$(date -u '+%Y-%m-%d %H:%M:%S UTC'); printf '%s\n' "$JOURNAL_SINCE" > "$EVID/journal_since.txt"
cp "$AUTH_DIR/authorization-L6b.txt" "$AUTH_DIR/k3-L6b.txt" "$EVID/"
{ echo "FROZEN_AP=$AP_IF $AP_ADDR"; echo "FROZEN_UPLINK=$UPLINK_IF $UPLINK_ADDR (expected $EXP_UPLINK_IF $EXP_UPLINK_ADDR)"; echo "TRUSTEDCLOCK=$TC"
  echo "MAIN=$EXPECTED_MAIN"; echo "RUNNER_SHA256=$(sha256sum "$0" | cut -d' ' -f1)"; } > "$EVID/frozen-inputs.txt"
echo "EVIDENCE_ROOT=$EVID MAIN=$EXPECTED_MAIN AP=$AP_IF/$AP_ADDR UPLINK=$UPLINK_IF/$UPLINK_ADDR"

MUTATED=0; ROLLED_BACK=0
capture() { sudo env EVID_DIR="$2" CAPTURE_LABEL="${1,,}" JOURNAL_SINCE="$JOURNAL_SINCE" bash "$P4/p4-l0-capture.sh" || return 1
  sudo grep -q 'L0_CAPTURE=COMPLETE' "$2/capture.log" || return 1; sudo bash -c "cd '$2' && sha256sum -c --quiet --strict SHA256SUMS" || return 1; echo "CAPTURE_$1=COMPLETE SHA256=PASS"; }
compare() { local allow=(); [ "${4:-}" = allow ] && allow=(ALLOW_KEYS_FILE="$STG/allow-keys.txt" ALLOW_LISTENERS_FILE="$STG/allow-listeners.txt"); local rc=0
  sudo env DISK_THRESHOLD_PCT=90 AEGIS_AP_INTERFACE="$AP_IF" AEGIS_AP_ADDRESS="$AP_ADDR" "${allow[@]}" bash "$P4/p4-compare.sh" "$1" "$2" > "$3" 2>&1 || rc=$?
  grep -E '^(FINDING|FINDINGS_|PRESERVATION_S10|COMPARE_RESULT)' "$3" || true; [ "$rc" = 0 ] || return 1
  for l in FINDINGS_NEW_OR_WORSENED_DRIFT=0 FINDINGS_BASELINE_UNHEALTHY_BUT_UNCHANGED=0 FINDINGS_INCOMPARABLE=0 PRESERVATION_S10=PASS COMPARE_RESULT=PASS; do grep -qx "$l" "$3" || { echo "COMPARE_REQUIREMENT_FAILED: $l"; return 1; }; done; }
handler() { sudo env AEGIS_L6B_LIVE_AUTHORIZED=YES AEGIS_L6B_WORK_DIR="$WORK" AEGIS_L6B_INPUT_DIR="$INPUT_DIR" AEGIS_AP_ADDRESS="$AP_ADDR" \
  AEGIS_UPLINK_ADDRESS="$UPLINK_ADDR" AEGIS_AP_INTERFACE="$AP_IF" AEGIS_PYTHON_BIN="$PY" bash "$STG/$1"; }
own_work() { sudo chown -R "$(id -u):$(id -g)" "$WORK" 2>/dev/null || true; }   # non-secret evidence only: the hashed passwd staging copy never survives apply
s10_unchanged() { [ "$(show $ENGINE MainPID)/$(show $ENGINE NRestarts)" = "$ENGINE_PRE" ] && [ "$(show $TUNNEL MainPID)/$(show $TUNNEL NRestarts)" = "$TUNNEL_PRE" ] \
  && [ "$(show twingate.service MainPID)/$(show twingate.service NRestarts)" = "$TG_PRE" ] && [ "$(show mosquitto.service MainPID)/$(show mosquitto.service NRestarts)" = "$MQ_PRE" ] \
  && [ "$(ss -ltnH | awk '$4 ~ /:1883$/ {print $4}' | LC_ALL=C sort -u)" = "$L1883_PRE" ]; }
rollback_flow() { trap - ERR INT TERM; [ "$ROLLED_BACK" = 0 ] || return 0; ROLLED_BACK=1; echo "== L6b ROLLBACK (reason: $1) — failure/abort path only"
  if sudo test -f "$WORK/production-mutation"; then
    local out; out=$(handler rollback.sh 2>&1) || { printf '%s\n' "$out"; own_work; echo "L6B_ROLLBACK=FAIL (S-11 HOLD) — ESCALATE; do NOT retry; inspect $EVID"; exit 3; }
    printf '%s\n' "$out"; own_work
  else echo "NO_PRODUCTION_MUTATION_MARKER: rollback handler not needed; proving zero drift instead"; fi
  capture RB "$EVID/rb-root" || { echo "RB capture FAILED — ESCALATE"; exit 3; }
  compare "$EVID/pre-root" "$EVID/rb-root" "$EVID/compare-pre-rb.txt" && s10_unchanged || { echo "PRE_RB_COMPARE=FAIL — ESCALATE; do NOT retry"; exit 3; }
  echo "PRE_RB_COMPARE=PASS ROLLBACK_RESULT=PASS L6B_LIVE_ACCEPTANCE=NOT_PROVEN. NOT retrying. Authorization is consumed."; exit 1; }
fail_after_mutation() { [ "$MUTATED" = 1 ] && rollback_flow "$1" || { echo "STOP before any mutation: $1"; exit 1; }; }
trap 'fail_after_mutation "unexpected error at line $LINENO"' ERR
trap 'fail_after_mutation "interrupted"' INT TERM

echo "== PRE capture (before ANY L6b-owned Production change)"; capture PRE "$EVID/pre-root" || die "PRE capture failed; nothing changed"
echo "== L6b APPLY (once; stage-owned material install + unit + enable/start)"; MUTATED=1
apply_rc=0; apply_out=$(handler apply.sh 2>&1) || apply_rc=$?; printf '%s\n' "$apply_out"; own_work
{ [ "$apply_rc" = 0 ] && printf '%s\n' "$apply_out" | grep -qx 'L6B_APPLY=PASS'; } || rollback_flow "L6B_APPLY failed (rc=$apply_rc)"
echo "== L6b VERIFY (installed material, legacy boundary, listeners, PF-01, live TLS/auth/ACL)"
ver_rc=0; ver_out=$(handler verify.sh 2>&1) || ver_rc=$?; printf '%s\n' "$ver_out"; own_work
{ [ "$ver_rc" = 0 ] && printf '%s\n' "$ver_out" | grep -qx 'L6B_VERIFY=PASS' && printf '%s\n' "$ver_out" | grep -qx 'L6B_LIVE_TLS_AUTH_ACL=PASS'; } || rollback_flow "L6B_VERIFY failed"
[ -s "$WORK/validation-evidence.tsv" ] || rollback_flow "validation-evidence.tsv missing"
cp "$WORK/validation-evidence.tsv" "$EVID/"
l6b_secret_scan "$INPUT_DIR" "$EVID" "$PY" || rollback_flow "SECRET_OUTPUT_SCAN failed"
echo "== POST capture"; capture POST "$EVID/post-root" || rollback_flow "POST capture failed"
echo "== PRE -> POST compare (approved exact L6b persistent deltas only)"; compare "$EVID/pre-root" "$EVID/post-root" "$EVID/compare-pre-post.txt" allow || rollback_flow "PRE->POST compare failed"
s10_unchanged || rollback_flow "S10/legacy mosquitto/Twingate preservation failed"
[ "$(show "$UNIT" ActiveState)" = active ] && [ "$(show "$UNIT" UnitFileState)" = enabled ] || rollback_flow "IDEA3 broker not active+enabled at closeout"
trap - ERR INT TERM
echo "L6B_LIVE_EXECUTED=YES L6B_APPLY=PASS L6B_VERIFY=PASS L6B_LIVE_TLS_AUTH_ACL=PASS L6B_POST_CAPTURE=COMPLETE L6B_PRE_POST_COMPARE=PASS L6B_S10_PRESERVATION=PASS"
echo "L6B_LIVE_ACCEPTANCE=PROVEN (this run only). PERSISTENT: $UNIT left enabled+active; 127.0.0.1:8883 and $AP_ADDR:8883 listening; stage-owned material installed root-owned."
echo "Plaintext JIT input NOT deleted by this runner. No ESP32, no L7. Evidence: $EVID"
