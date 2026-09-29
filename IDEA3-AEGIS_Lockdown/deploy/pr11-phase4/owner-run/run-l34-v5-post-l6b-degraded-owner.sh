#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — L3/L4 POST-L6b/L6c DEGRADED RUNTIME REACTIVATION (V5), ONE bounded owner-supervised
# attempt. OWNER-RUN ONLY.
# REPOSITORY TEMPLATE: EXPECTED_MAIN is unpinned, so this file REFUSES TO RUN as committed. The owner freeze workflow
# copies it OUTSIDE the repository, replaces PIN_MAIN_SHA with the merged main SHA, records the frozen file's
# SHA-256, and only then authorizes a run.
# Design: docs/superpowers/specs/2026-09-28-idea3-pr11-phase4-l34-v5-post-l6b-degraded-reactivation-design.md
#
# V5 is a DISTINCT reactivation operation from V1/V2/V3 (owner-run/run-l34-reactivation-owner.sh, reactivation/l34/,
# which require the NM radio disabled) AND from V4 (owner-run/run-l34-v4-post-l6b-owner.sh,
# reactivation/l34-v4-post-l6b/, which requires aegis-idea3-dnsmasq.service AND aegis-idea3-mosquitto.service
# ALREADY active/running). V5 supports EXACTLY ONE, different, already-observed baseline: the same wifi/rfkill/
# radio/wpa topology as V4 (radio already enabled, target already disconnected, rfkill already unblocked), but
# aegis-idea3-dnsmasq.service is in the exact V3 post-reboot failed/start-limit-hit precondition, and
# aegis-idea3-mosquitto.service (the L6b broker) is crash-looping (systemd auto-restarting it) because its
# AP-facing 8883 listener cannot bind while the AP address is absent.
#
# V5 performs EXACTLY: a temporary `nmcli device set wlp0s20f3 autoconnect no` (PRE value restored), exactly one
# `nmcli connection up aegis-idea3-ap ifname wlp0s20f3`, the autoconnect restore, then `systemctl reset-failed` +
# `systemctl start` of aegis-idea3-dnsmasq.service ONLY (the exact V3 pattern), then a BOUNDED, read-only wait for
# aegis-idea3-mosquitto.service to reach active/running on its own via its own already-configured systemd
# auto-restart. It NEVER issues start/stop/restart/reset-failed against the broker, never touches rfkill, the
# global NM Wi-Fi radio, nftables, forwarding, regulatory state, enp62s0, legacy mosquitto, Twingate, IDEA1/IDEA2,
# never sends an MQTT command, never touches ESP32, never runs L3/L4 apply.sh, never starts L7, and claims NO
# L3/L4/L6b live acceptance. NO automatic retry.
set -Eeuo pipefail
umask 077

EXPECTED_MAIN=PIN_MAIN_SHA
case "$EXPECTED_MAIN" in PIN_*) echo "STOP: runner is not pinned (EXPECTED_MAIN). Run the owner freeze workflow first."; exit 2 ;; esac
[[ "$EXPECTED_MAIN" =~ ^[0-9a-f]{40}$ ]] || { echo "STOP: EXPECTED_MAIN is not a 40-hex SHA."; exit 2; }
[ "$(id -u)" != 0 ] || { echo "Run as your normal user, not root."; exit 2; }
AUTH_DIR=${1:-}
[ -n "$AUTH_DIR" ] && [ -d "$AUTH_DIR" ] || { echo "usage: bash $0 <AUTH_DIR with authorization-L4.txt and k3-L4.txt>"; exit 2; }

# ---- frozen inputs -----------------------------------------------------------------------------------------------------
REPO=/home/kittipat/Workspace/IDEA3-Cyber-Last/worktrees/Project-End-The-AEGIS-L34LIVE   # clean pinned execution worktree at merged main
PY=/home/kittipat/.venvs/aegis-idea3-core/bin/python
P4=$REPO/IDEA3-AEGIS_Lockdown/deploy/pr11-phase4
HND=$P4/reactivation/l34-v5-post-l6b-degraded
LIB=$P4/p4-l34-reactivation-lib.sh
AP_IF=wlp0s20f3
AP_ADDR=10.77.30.1
PROFILE=/etc/NetworkManager/system-connections/aegis-idea3-ap.nmconnection
EXPECTED_SCOPE='L3_L4_RUNTIME_REACTIVATION_V5_POST_L6B_DEGRADED: activate aegis-idea3-ap once, recover dnsmasq, bounded broker auto-restart wait, no broker control, no persistent rewrite, no L7/ESP32/MQTT action'
TODAY=$(TZ=Asia/Bangkok date +%F)
STAMP=$(TZ=Asia/Bangkok date +%Y%m%d-%H%M%S)
EVID=/home/kittipat/Workspace/idea3-p4-evidence/$TODAY-l34-v5-$STAMP
WORK=$EVID/l34-v5-work
PREFLIGHT_WORK=$EVID/l34-v5-preflight
ENGINE=aegis-detection-engine.service; TUNNEL=aegis-detection-tunnel.service
DNSMASQ_UNIT=aegis-idea3-dnsmasq.service
BROKER_UNIT=aegis-idea3-mosquitto.service

die() { echo "STOP: $*" >&2; exit 1; }
GATE_FAILED=0; gate() { echo "GATE_FAIL: $*" >&2; GATE_FAILED=1; }
show() { systemctl show -p "$2" --value "$1"; }

[ -f "$LIB" ] || die "gate library missing: $LIB (is $REPO at the pinned main?)"
# shellcheck disable=SC1090
source "$LIB"

echo "== L3/L4 V5 post-L6b degraded reactivation owner-run: pre-gates (read-only; nothing is created or changed yet)"
sudo -v || die "sudo authentication failed"

# 1. pinned main, clean pinned worktree, same-day stage=L4 records with the exact V5 scope, stage gate (live mode)
for f in authorization-L4.txt k3-L4.txt; do
  [ -f "$AUTH_DIR/$f" ] || gate "$f missing"
  grep -qx "date=$TODAY" "$AUTH_DIR/$f" 2>/dev/null || gate "$f date is not today ($TODAY Asia/Bangkok)"
  grep -qx "stage=L4" "$AUTH_DIR/$f" 2>/dev/null || gate "$f is not stage=L4"
done
grep -qxF "scope=$EXPECTED_SCOPE" "$AUTH_DIR/authorization-L4.txt" 2>/dev/null || gate "authorization scope is not exactly the approved V5 scope"
[ ! -e "$AUTH_DIR/L34-V5-REACTIVATION-ATTEMPT-CONSUMED" ] || gate "this authorization already consumed its one bounded attempt"
[ "$(git -C "$REPO" rev-parse HEAD)" = "$EXPECTED_MAIN" ] || gate "worktree HEAD is not $EXPECTED_MAIN"
[ -z "$(git -C "$REPO" status --porcelain)" ] || gate "worktree is not clean"
git -C "$REPO" fetch -q origin 2>/dev/null && [ "$(git -C "$REPO" rev-parse origin/main)" = "$EXPECTED_MAIN" ] \
  || gate "origin/main is not $EXPECTED_MAIN (or fetch failed); not silently re-pinning"
for f in apply.sh verify.sh rollback.sh; do [ -f "$HND/$f" ] || gate "handler file $f missing"; done
gate_out=$(TZ=Asia/Bangkok bash "$P4/p4-stage-gate.sh" --stage L4 --mode live --authorization "$AUTH_DIR/authorization-L4.txt" --k3 "$AUTH_DIR/k3-L4.txt" 2>&1) || gate "stage gate failed"
for l in AUTHORIZATION_RECORD=VALID K3_CONFIRMATION=VALID; do printf '%s\n' "$gate_out" | grep -qx "$l" || gate "stage gate did not report $l"; done

# 2. historical L3/L4 acceptance receipts at the pinned commit (kept authoritative; this run adds no acceptance claim)
l34_receipt_gate "$REPO" || gate "predecessor receipt gate failed (see reason above)"

# 3. host safety (read-only): the ONE supported V5 baseline. dnsmasq must be exactly the post-reboot failed
#    precondition and the broker exactly crash-looping -- this run never repairs anything outside that.
for c in rfkill nmcli iw ip nft sysctl systemctl ss dnsmasq; do command -v "$c" >/dev/null || gate "$c missing"; done
disk_pct=$(df -P / | awk 'NR == 2 { sub("%", "", $5); print $5 }'); [ "$disk_pct" -lt 90 ] || gate "disk $disk_pct% >= 90"
for u in "$ENGINE" "$TUNNEL" twingate.service mosquitto.service; do
  [ "$(show "$u" ActiveState)" = active ] && [ "$(show "$u" SubState)" = running ] || gate "$u not active/running"
done
unit_props() { systemctl show -p LoadState -p ActiveState -p SubState -p UnitFileState -p Result -p MainPID "$1"; }
unit_props "$DNSMASQ_UNIT" | l34_service_pre_gate || gate "$(unit_props "$DNSMASQ_UNIT" | l34_service_pre_gate 2>&1 | head -n 1)"
BROKER_JOURNAL_PREGATE=$(mktemp) || die "could not create temporary broker journal capture file"
trap 'rm -f "$BROKER_JOURNAL_PREGATE"' EXIT
journalctl -u "$BROKER_UNIT" -n 30 --no-pager > "$BROKER_JOURNAL_PREGATE" 2>&1 || gate "broker journal capture failed"
unit_props "$BROKER_UNIT" | l34_v5_broker_crashloop_gate "$BROKER_JOURNAL_PREGATE" \
  || gate "$(unit_props "$BROKER_UNIT" | l34_v5_broker_crashloop_gate "$BROKER_JOURNAL_PREGATE" 2>&1 | head -n 1)"
[ "$GATE_FAILED" = 0 ] || die "one or more pre-gates failed; NOTHING was created or changed"

# 4. the bounded attempt is consumed here: a second invocation for this AUTH_DIR is refused, even after a failure
marker="$AUTH_DIR/L34-V5-REACTIVATION-ATTEMPT-CONSUMED"
( set -o noclobber; printf 'consumed_at=%s\n' "$(date -u +%FT%TZ)" > "$marker" ) 2>/dev/null \
  || die "could not consume the one-attempt marker"

mkdir -m 700 "$EVID"; exec > >(tee -a "$EVID/owner-run.log") 2>&1
JOURNAL_SINCE=$(date -u '+%Y-%m-%d %H:%M:%S UTC'); printf '%s\n' "$JOURNAL_SINCE" > "$EVID/journal_since.txt"
cp "$AUTH_DIR/authorization-L4.txt" "$AUTH_DIR/k3-L4.txt" "$EVID/"
{ echo "OPERATION=L3_L4_RUNTIME_REACTIVATION_V5_POST_L6B_DEGRADED"; echo "REACTIVATION_TYPE=RUNTIME_ONLY"; echo "MAIN=$EXPECTED_MAIN"
  echo "RUNNER_SHA256=$(sha256sum "$0" | cut -d' ' -f1)"; echo "K12_AUTOMATIC_REBOOT_PERSISTENCE=NOT_PROVEN"; } > "$EVID/frozen-inputs.txt"

MUTATED=0; ROLLED_BACK=0
capture() { sudo env EVID_DIR="$2" CAPTURE_LABEL="${1,,}" JOURNAL_SINCE="$JOURNAL_SINCE" bash "$P4/p4-l0-capture.sh" || return 1
  sudo grep -q 'L0_CAPTURE=COMPLETE' "$2/capture.log" || return 1; sudo bash -c "cd '$2' && sha256sum -c --quiet --strict SHA256SUMS" || return 1; echo "CAPTURE_$1=COMPLETE SHA256=PASS"; }
compare() {
  sudo env DISK_THRESHOLD_PCT=90 AEGIS_AP_INTERFACE="$AP_IF" AEGIS_AP_ADDRESS="$AP_ADDR" \
    ALLOW_KEYS_FILE="$HND/allow-keys.txt" ALLOW_LISTENERS_FILE="$HND/allow-listeners.txt" \
    bash "$P4/p4-compare.sh" "$1" "$2" > "$3" 2>&1
  local rc=$?
  grep -E '^(FINDING|FINDINGS_|PRESERVATION_S10|COMPARE_RESULT)' "$3" || true
  [ "$rc" = 0 ] || return 1
  for l in FINDINGS_NEW_OR_WORSENED_DRIFT=0 FINDINGS_BASELINE_UNHEALTHY_BUT_UNCHANGED=0 FINDINGS_INCOMPARABLE=0 PRESERVATION_S10=PASS COMPARE_RESULT=PASS; do
    grep -qx "$l" "$3" || { echo "COMPARE_REQUIREMENT_FAILED: $l"; return 1; }
  done
}
handler() { local w=${2:-$WORK}
  sudo env AEGIS_L34_LIVE_AUTHORIZED=YES AEGIS_L34_WORK_DIR="$w" AEGIS_AP_INTERFACE="$AP_IF" AEGIS_L34_PREFLIGHT_ONLY="${AEGIS_L34_PREFLIGHT_ONLY_RUN:-NO}" bash "$HND/$1"; }
own_work() { sudo chown -R "$(id -u):$(id -g)" "$WORK" "$PREFLIGHT_WORK" 2>/dev/null || true; }
identity_now() { for u in mosquitto.service twingate.service "$ENGINE" "$TUNNEL"; do printf '%s %s/%s\n' "$u" "$(show "$u" MainPID)" "$(show "$u" NRestarts)"; done; }
IDENT_PRE=$(identity_now)
identity_unchanged() { [ "$(identity_now)" = "$IDENT_PRE" ]; }
rollback_flow() { trap - ERR INT TERM; [ "$ROLLED_BACK" = 0 ] || return 0; ROLLED_BACK=1; echo "== L3/L4 V5 reactivation ROLLBACK (reason: $1) — failure/abort path only"
  if sudo test -f "$WORK/production-mutation"; then
    local out; out=$(handler rollback.sh 2>&1) || { printf '%s\n' "$out"; own_work; echo "L34_V5_ROLLBACK=FAIL (S-11 HOLD) — ESCALATE; do NOT retry; inspect $EVID"; exit 3; }
    printf '%s\n' "$out"; own_work
  else echo "NO_PRODUCTION_MUTATION_MARKER: rollback handler not needed; proving zero drift instead"; fi
  capture RB "$EVID/rb-root" || { echo "RB capture FAILED — ESCALATE"; exit 3; }
  compare "$EVID/pre-root" "$EVID/rb-root" "$EVID/compare-pre-rb.txt" && identity_unchanged \
    || { echo "PRE_RB_COMPARE=FAIL — ESCALATE; do NOT retry"; exit 3; }
  echo "PRE_RB_COMPARE=PASS ROLLBACK_RESULT=PASS L34_V5_REACTIVATION=NOT_RESTORED. NOT retrying. Authorization is consumed."; exit 1; }
fail_after_mutation() { [ "$MUTATED" = 1 ] && rollback_flow "$1" || { echo "STOP before any mutation: $1"; exit 1; }; }
trap 'fail_after_mutation "unexpected error at line $LINENO"' ERR
trap 'fail_after_mutation "interrupted"' INT TERM

echo "== read-only preflight through the handler (as root; writes only into the evidence dir)"
pf_out=$(AEGIS_L34_PREFLIGHT_ONLY_RUN=YES handler apply.sh "$PREFLIGHT_WORK" 2>&1) || { printf '%s\n' "$pf_out"; own_work; die "preflight failed; NOTHING was changed"; }
printf '%s\n' "$pf_out"; own_work
printf '%s\n' "$pf_out" | grep -qx 'L34_V5_PREFLIGHT=PASS' || die "preflight did not report L34_V5_PREFLIGHT=PASS"

echo "== PRE capture (before the one bound activation)"; capture PRE "$EVID/pre-root" || die "PRE capture failed; nothing changed"
echo "== L3/L4 V5 reactivation APPLY (once)"; MUTATED=1
apply_rc=0; apply_out=$(handler apply.sh 2>&1) || apply_rc=$?; printf '%s\n' "$apply_out"; own_work
{ [ "$apply_rc" = 0 ] && printf '%s\n' "$apply_out" | grep -qx 'L34_V5_APPLY=PASS'; } || rollback_flow "L34_V5_APPLY failed (rc=$apply_rc)"
echo "== VERIFY"
ver_rc=0; ver_out=$(handler verify.sh 2>&1) || ver_rc=$?; printf '%s\n' "$ver_out"; own_work
{ [ "$ver_rc" = 0 ] && printf '%s\n' "$ver_out" | grep -qx 'L34_V5_VERIFY=PASS'; } || rollback_flow "L34_V5_VERIFY failed"
echo "== POST capture"; capture POST "$EVID/post-root" || rollback_flow "POST capture failed"
echo "== PRE -> POST compare (exact reactivation window only)"; compare "$EVID/pre-root" "$EVID/post-root" "$EVID/compare-pre-post.txt" || rollback_flow "PRE->POST compare failed"
identity_unchanged || rollback_flow "legacy mosquitto/Twingate/IDEA2 identity changed"
trap - ERR INT TERM
echo "L34_V5_REACTIVATION_EXECUTED=YES L34_V5_APPLY=PASS L34_V5_VERIFY=PASS L34_V5_POST_CAPTURE=COMPLETE L34_V5_PRE_POST_COMPARE=PASS"
echo "L3_L4_RUNTIME_REACTIVATION_V5=PASS (RUNTIME_ONLY, post-L6b/L6c degraded). NO new L3_LIVE_ACCEPTANCE / L4_LIVE_ACCEPTANCE / L6B_LIVE_ACCEPTANCE claim. PERSISTENT_FILES_REWRITTEN=NO. L6B_BROKER_MUTATED=NO (recovered via its own systemd auto-restart only)."
echo "K12_AUTOMATIC_REBOOT_PERSISTENCE=NOT_PROVEN. No ESP32, no L7, no MQTT command. Evidence: $EVID"
