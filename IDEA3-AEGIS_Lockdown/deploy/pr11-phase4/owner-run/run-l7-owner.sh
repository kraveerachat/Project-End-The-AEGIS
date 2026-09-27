#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — L7 LIVE Core credential delivery + Core start, ONE owner-supervised attempt. OWNER-RUN ONLY.
# REPOSITORY TEMPLATE: EXPECTED_MAIN and RELEASE_ID are unpinned, so this file REFUSES TO RUN as committed. The owner freeze workflow
# copies it OUTSIDE the repository (e.g. ~/Workspace/idea3-p4-evidence/l7-owner-run/), replaces PIN_MAIN_SHA with the merged main SHA and
# PIN_RELEASE_ID with the id of the already-installed immutable release, records the frozen file's SHA-256, and only then authorizes a run.
# Design: docs/superpowers/specs/2026-09-21-idea3-pr11-phase4-l7-operational-design.md (+ 2026-09-27 amendments).
# Usage (normal user, NOT root):  bash run-l7-owner.sh <AUTH_DIR>     AUTH_DIR holds authorization-L7.txt (with d6_notice=pub) and k3-L7.txt
# L7 is PERSISTENT on success (aegis-idea3-core.service stays enabled+active in the no-device state). It rolls back ONLY on failure/abort.
# It never creates or derives a secret (K_C2D/K_D2C/PIN/passwords/restore credential are owner-supplied JIT input), never installs the
# release (a separate owner step must have done that), never starts L8, never touches an ESP32/serial device, never sends a relay
# command, never repairs a predecessor stage, never modifies IDEA1/IDEA2, Twingate, legacy mosquitto, the L6b broker, NetworkManager,
# nftables, forwarding or TrustedClock. NO automatic retry; one attempt per authorization. It does not delete the plaintext JIT input.
set -Eeuo pipefail
umask 077

EXPECTED_MAIN=PIN_MAIN_SHA
RELEASE_ID=PIN_RELEASE_ID
case "$EXPECTED_MAIN" in PIN_*) echo "STOP: runner is not pinned (EXPECTED_MAIN). Run the owner freeze workflow first."; exit 2 ;; esac
[[ "$EXPECTED_MAIN" =~ ^[0-9a-f]{40}$ ]] || { echo "STOP: EXPECTED_MAIN is not a 40-hex SHA."; exit 2; }
case "$RELEASE_ID" in PIN_*) echo "STOP: runner is not pinned (RELEASE_ID). Run the owner freeze workflow first."; exit 2 ;; esac
[[ "$RELEASE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || { echo "STOP: RELEASE_ID is not a valid release id."; exit 2; }
[ "$(id -u)" != 0 ] || { echo "Run as your normal user, not root."; exit 2; }
AUTH_DIR=${1:-}
[ -n "$AUTH_DIR" ] && [ -d "$AUTH_DIR" ] || { echo "usage: bash $0 <AUTH_DIR with authorization-L7.txt and k3-L7.txt>"; exit 2; }

# ---- frozen inputs -----------------------------------------------------------------------------------------------------
REPO=/home/kittipat/Workspace/IDEA3-Cyber-Last/worktrees/Project-End-The-AEGIS-L7LIVE   # clean pinned execution worktree at merged main
INPUT_DIR=/home/kittipat/Workspace/idea3-p4-evidence/l7-owner-input
PY=/home/kittipat/.venvs/aegis-idea3-core/bin/python
APP=$REPO/IDEA3-AEGIS_Lockdown
P4=$APP/deploy/pr11-phase4
STG=$P4/stages/L7
LIB=$P4/p4-l7-run-lib.sh
CLOCK=$P4/p4-l5-clock.py
AP_IF=wlp0s20f3
AP_ADDR=10.77.30.1
TLS_NAME=mqtt.aegis.home.arpa
RELEASE_DIR=/opt/aegis-idea3/releases/$RELEASE_ID
L6B_CA=/etc/aegis-idea3/mqtt/ca.crt
TODAY=$(TZ=Asia/Bangkok date +%F)
STAMP=$(TZ=Asia/Bangkok date +%Y%m%d-%H%M%S)
EVID=/home/kittipat/Workspace/idea3-p4-evidence/$TODAY-l7-$STAMP
WORK=$EVID/l7-work
ENGINE=aegis-detection-engine.service; TUNNEL=aegis-detection-tunnel.service
UNIT=aegis-idea3-core.service
BROKER_UNIT=aegis-idea3-mosquitto.service

die() { echo "STOP: $*" >&2; exit 1; }
GATE_FAILED=0; gate() { echo "GATE_FAIL: $*" >&2; GATE_FAILED=1; }
show() { systemctl show -p "$2" --value "$1"; }
listen_now() { ss -ltnH | awk '{print $4}'; }

[ -f "$LIB" ] || die "gate library missing: $LIB (is $REPO at the pinned main?)"
# shellcheck disable=SC1090
source "$LIB"

echo "== L7 owner-run: pre-gates (read-only; nothing is created or changed yet)"
sudo -v || die "sudo authentication failed"

# 1. pinned main, clean pinned worktree, same-day records, stage gate (live mode); the A-L7 record must carry the Pub / D6 notice
for f in authorization-L7.txt k3-L7.txt; do
  [ -f "$AUTH_DIR/$f" ] || gate "$f missing"
  grep -qx "date=$TODAY" "$AUTH_DIR/$f" 2>/dev/null || gate "$f date is not today ($TODAY Asia/Bangkok)"
  grep -qx "stage=L7" "$AUTH_DIR/$f" 2>/dev/null || gate "$f is not stage=L7"
done
[ ! -e "$AUTH_DIR/L7-ATTEMPT-CONSUMED" ] || gate "this authorization already consumed its one live attempt"
l7_d6_gate "$AUTH_DIR/authorization-L7.txt" || gate "A-L7 lacks d6_notice=pub"
[ "$(git -C "$REPO" rev-parse HEAD)" = "$EXPECTED_MAIN" ] || gate "worktree HEAD is not $EXPECTED_MAIN"
[ -z "$(git -C "$REPO" status --porcelain)" ] || gate "worktree is not clean"
git -C "$REPO" fetch -q origin 2>/dev/null && [ "$(git -C "$REPO" rev-parse origin/main)" = "$EXPECTED_MAIN" ] \
  || gate "origin/main is not $EXPECTED_MAIN (or fetch failed); not silently re-pinning"
for f in apply.sh verify.sh rollback.sh allow-keys.txt allow-listeners.txt; do [ -f "$STG/$f" ] || gate "handler file $f missing"; done
gate_out=$(TZ=Asia/Bangkok bash "$P4/p4-stage-gate.sh" --stage L7 --mode live --authorization "$AUTH_DIR/authorization-L7.txt" --k3 "$AUTH_DIR/k3-L7.txt" 2>&1) || gate "stage gate failed"
for l in AUTHORIZATION_RECORD=VALID K3_CONFIRMATION=VALID ROLLBACK_HANDLER=REGISTERED; do printf '%s\n' "$gate_out" | grep -qx "$l" || gate "stage gate did not report $l"; done

# 2. predecessor ACCEPTANCE (historical) L2..L6b from receipts at the pinned commit; refuses if L7 is already recorded as accepted
l7_receipt_gate "$REPO" || gate "predecessor receipt gate failed (see reason above)"

# 3. tools / pinned python
"$PY" - <<'PYC' >/dev/null 2>&1 || gate "pinned python lacks paho-mqtt 2.1.0 with CallbackAPIVersion"
import importlib.metadata as m, paho.mqtt.client as c, sys
sys.exit(0 if m.version("paho-mqtt") == "2.1.0" and hasattr(c, "CallbackAPIVersion") else 1)
PYC
for c in openssl ss ip iw nmcli nft runuser systemd-analyze getent; do command -v "$c" >/dev/null || gate "$c missing"; done

# 4. the immutable release must ALREADY be installed and guarded (existence + provenance); L7 never installs it
l7_release_gate "$REPO" "$RELEASE_DIR" "$EXPECTED_MAIN" "$PY" "$P4" root || gate "immutable release gate failed (see reason above)"

# 5. private JIT input (never printed)
l7_input_gate "$INPUT_DIR" "$PY" "$APP" || gate "owner input gate failed (see reason above)"
[ ! -e "$EVID" ] || gate "$EVID already exists"
case "$INPUT_DIR" in "$EVID"*|/etc/*) gate "input dir overlaps evidence or /etc" ;; esac

# 6. CURRENT predecessor runtime (fresh proof; never repaired here). Historical PROVEN does NOT imply this.
l6b_ap_runtime_gate "$AP_IF" "$AP_ADDR" || gate "AP runtime gate failed (PREDECESSOR_RUNTIME_REACTIVATION_REQUIRED is a separate owner action)"
NFT_TEXT=$(sudo nft list table inet aegis_idea3 2>/dev/null || true)
printf '%s\n' "$NFT_TEXT" | l6b_nft_text_gate "$AP_IF" || gate "L2 nft / PF-01 gate failed (PREDECESSOR_RUNTIME_REACTIVATION_REQUIRED is a separate owner action)"
[ "$(show aegis-idea3-dnsmasq.service ActiveState)" = active ] && [ "$(show aegis-idea3-dnsmasq.service SubState)" = running ] \
  || gate "PREDECESSOR_RUNTIME_REACTIVATION_REQUIRED=YES:L4_DNSMASQ_NOT_RUNNING"
TC=$(python3 "$CLOCK" probe 2>&1 || true)
l6b_trustedclock_gate "$TC" || gate "TrustedClock fresh read-only proof not OK ($TC)"
l7_broker_runtime_gate "$BROKER_UNIT" "$AP_ADDR" || gate "persistent L6b broker gate failed (see reason above)"
l7_tls_probe "$PY" "$P4" "$APP" "$L6B_CA" "$AP_ADDR" "$TLS_NAME" >/dev/null || gate "broker TLS hostname probe failed (see reason above)"

# 7. host safety, IDEA2 §10 fresh precondition, exact clean Core prestate (all BEFORE the authorization is consumed)
l7_disk_gate 80 / /var /opt || gate "disk headroom below 20% free (see reason above)"
l7_idea2_s10_gate "$ENGINE" "$TUNNEL" || gate "IDEA2 §10 fresh preservation precondition failed (see reason above)"
for u in twingate.service mosquitto.service; do [ "$(show "$u" ActiveState)" = active ] && [ "$(show "$u" SubState)" = running ] || gate "$u not active/running"; done
listen_now | grep -qx '0.0.0.0:1883' || gate "legacy 1883 wildcard listener not present (expected legacy broker state)"
l7_core_prestate_gate "$UNIT" || gate "IDEA3 Core prestate is not clean (see reason above; NOTHING was consumed)"
for k in net.ipv4.ip_forward net.ipv4.conf.all.forwarding net.ipv6.conf.all.forwarding; do [ "$(sysctl -n $k)" = 0 ] || gate "$k is not 0"; done
[ "$GATE_FAILED" = 0 ] || die "one or more pre-gates failed; NOTHING was created or changed"

# 8. authorization is consumed here (one attempt): from this point a second invocation for this AUTH_DIR is refused
l7_consume_attempt "$AUTH_DIR" || die "could not consume the one-attempt marker"

snap() { printf '%s/%s\n' "$(show "$1" MainPID)" "$(show "$1" NRestarts)"; }
ENGINE_PRE=$(snap $ENGINE); TUNNEL_PRE=$(snap $TUNNEL); TG_PRE=$(snap twingate.service); MQ_PRE=$(snap mosquitto.service); BROKER_PRE=$(snap $BROKER_UNIT)
L1883_PRE=$(ss -ltnH | awk '$4 ~ /:1883$/ {print $4}' | LC_ALL=C sort -u); L8883_PRE=$(ss -ltnH | awk '$4 ~ /:8883$/ {print $4}' | LC_ALL=C sort -u)

mkdir -m 700 "$EVID"; exec > >(tee -a "$EVID/owner-run.log") 2>&1
JOURNAL_SINCE=$(date -u '+%Y-%m-%d %H:%M:%S UTC'); printf '%s\n' "$JOURNAL_SINCE" > "$EVID/journal_since.txt"
cp "$AUTH_DIR/authorization-L7.txt" "$AUTH_DIR/k3-L7.txt" "$EVID/"
{ echo "FROZEN_AP=$AP_IF $AP_ADDR"; echo "TRUSTEDCLOCK=$TC"; echo "MAIN=$EXPECTED_MAIN"; echo "RELEASE=$RELEASE_ID"
  echo "RUNNER_SHA256=$(sha256sum "$0" | cut -d' ' -f1)"; } > "$EVID/frozen-inputs.txt"
echo "EVIDENCE_ROOT=$EVID MAIN=$EXPECTED_MAIN RELEASE=$RELEASE_ID AP=$AP_IF/$AP_ADDR"

MUTATED=0; ROLLED_BACK=0
capture() { sudo env EVID_DIR="$2" CAPTURE_LABEL="${1,,}" JOURNAL_SINCE="$JOURNAL_SINCE" bash "$P4/p4-l0-capture.sh" || return 1
  sudo grep -q 'L0_CAPTURE=COMPLETE' "$2/capture.log" || return 1; sudo bash -c "cd '$2' && sha256sum -c --quiet --strict SHA256SUMS" || return 1; echo "CAPTURE_$1=COMPLETE SHA256=PASS"; }
compare() { local allow=(); [ "${4:-}" = allow ] && allow=(ALLOW_KEYS_FILE="$STG/allow-keys.txt" ALLOW_LISTENERS_FILE="$STG/allow-listeners.txt"); local rc=0
  sudo env DISK_THRESHOLD_PCT=90 AEGIS_AP_INTERFACE="$AP_IF" AEGIS_AP_ADDRESS="$AP_ADDR" "${allow[@]}" bash "$P4/p4-compare.sh" "$1" "$2" > "$3" 2>&1 || rc=$?
  grep -E '^(FINDING|FINDINGS_|PRESERVATION_S10|COMPARE_RESULT)' "$3" || true; [ "$rc" = 0 ] || return 1
  for l in FINDINGS_NEW_OR_WORSENED_DRIFT=0 FINDINGS_BASELINE_UNHEALTHY_BUT_UNCHANGED=0 FINDINGS_INCOMPARABLE=0 PRESERVATION_S10=PASS COMPARE_RESULT=PASS; do grep -qx "$l" "$3" || { echo "COMPARE_REQUIREMENT_FAILED: $l"; return 1; }; done; }
handler() { sudo env AEGIS_L7_LIVE_AUTHORIZED=YES AEGIS_L7_WORK_DIR="$WORK" AEGIS_L7_INPUT_DIR="$INPUT_DIR" AEGIS_L7_RELEASE_DIR="$RELEASE_DIR" \
  AEGIS_AP_ADDRESS="$AP_ADDR" AEGIS_PYTHON_BIN="$PY" bash "$STG/$1"; }
own_work() { sudo chown -R "$(id -u):$(id -g)" "$WORK" 2>/dev/null || true; }
s10_unchanged() { [ "$(snap $ENGINE)" = "$ENGINE_PRE" ] && [ "$(snap $TUNNEL)" = "$TUNNEL_PRE" ] && [ "$(snap twingate.service)" = "$TG_PRE" ] \
  && [ "$(snap mosquitto.service)" = "$MQ_PRE" ] && [ "$(snap $BROKER_UNIT)" = "$BROKER_PRE" ] \
  && [ "$(ss -ltnH | awk '$4 ~ /:1883$/ {print $4}' | LC_ALL=C sort -u)" = "$L1883_PRE" ] && [ "$(ss -ltnH | awk '$4 ~ /:8883$/ {print $4}' | LC_ALL=C sort -u)" = "$L8883_PRE" ]; }
rollback_flow() { trap - ERR INT TERM; [ "$ROLLED_BACK" = 0 ] || return 0; ROLLED_BACK=1; echo "== L7 ROLLBACK (reason: $1) — failure/abort path only"
  if sudo test -f "$WORK/production-mutation"; then
    local out; out=$(handler rollback.sh 2>&1) || { printf '%s\n' "$out"; own_work; echo "L7_ROLLBACK=FAIL (S-11 HOLD) — ESCALATE; do NOT retry; inspect $EVID"; exit 3; }
    printf '%s\n' "$out"; own_work
  else echo "NO_PRODUCTION_MUTATION_MARKER: rollback handler not needed; proving zero drift instead"; fi
  capture RB "$EVID/rb-root" || { echo "RB capture FAILED — ESCALATE"; exit 3; }
  compare "$EVID/pre-root" "$EVID/rb-root" "$EVID/compare-pre-rb.txt" && s10_unchanged || { echo "PRE_RB_COMPARE=FAIL — ESCALATE; do NOT retry"; exit 3; }
  echo "PRE_RB_COMPARE=PASS ROLLBACK_RESULT=PASS L7_LIVE_ACCEPTANCE=NOT_PROVEN. NOT retrying. Authorization is consumed."; exit 1; }
fail_after_mutation() { [ "$MUTATED" = 1 ] && rollback_flow "$1" || { echo "STOP before any mutation: $1"; exit 1; }; }
trap 'fail_after_mutation "unexpected error at line $LINENO"' ERR
trap 'fail_after_mutation "interrupted"' INT TERM

echo "== PRE capture (before ANY L7-owned Production change)"; capture PRE "$EVID/pre-root" || die "PRE capture failed; nothing changed"
echo "== L7 APPLY (once; credentials + core.env + CA copy + unit + enable/start)"; MUTATED=1
apply_rc=0; apply_out=$(handler apply.sh 2>&1) || apply_rc=$?; printf '%s\n' "$apply_out"; own_work
{ [ "$apply_rc" = 0 ] && printf '%s\n' "$apply_out" | grep -qx 'L7_APPLY=PASS'; } || rollback_flow "L7_APPLY failed (rc=$apply_rc)"
echo "== L7 VERIFY (material, release, service, no-device state, zero actuation, listeners, broker connection)"
ver_rc=0; ver_out=$(handler verify.sh 2>&1) || ver_rc=$?; printf '%s\n' "$ver_out"; own_work
{ [ "$ver_rc" = 0 ] && printf '%s\n' "$ver_out" | grep -qx 'L7_VERIFY=PASS' && printf '%s\n' "$ver_out" | grep -qx 'L7_ZERO_ACTUATION=PASS' \
  && printf '%s\n' "$ver_out" | grep -qx 'L7_BROKER_CONNECTION=ESTABLISHED'; } || rollback_flow "L7_VERIFY failed"
[ -s "$WORK/validation-evidence.tsv" ] || rollback_flow "validation-evidence.tsv missing"
echo "== POST capture"; capture POST "$EVID/post-root" || rollback_flow "POST capture failed"
echo "== PRE -> POST compare (approved exact L7 persistent deltas only)"; compare "$EVID/pre-root" "$EVID/post-root" "$EVID/compare-pre-post.txt" allow || rollback_flow "PRE->POST compare failed"
l7_secret_scan "$INPUT_DIR" "$EVID" "$PY" || rollback_flow "SECRET_OUTPUT_SCAN failed"
s10_unchanged || rollback_flow "S10/legacy mosquitto/Twingate/L6b broker preservation failed"
[ "$(show "$UNIT" ActiveState)" = active ] && [ "$(show "$UNIT" UnitFileState)" = enabled ] || rollback_flow "IDEA3 Core not active+enabled at closeout"
[ "$(show "$BROKER_UNIT" ActiveState)" = active ] || rollback_flow "L6b broker not active at closeout"
trap - ERR INT TERM
echo "L7_LIVE_EXECUTED=YES L7_APPLY=PASS L7_VERIFY=PASS L7_POST_CAPTURE=COMPLETE L7_PRE_POST_COMPARE=PASS L7_S10_PRESERVATION=PASS"
echo "L7_LIVE_ACCEPTANCE=PROVEN (this run only). PERSISTENT: $UNIT left enabled+active in the no-device state; zero relay commands were sent; L8_STARTED=NO ESP32_TOUCHED=NO."
echo "Plaintext JIT input NOT deleted by this runner (a separately authorized owner workflow does that). Evidence: $EVID"
