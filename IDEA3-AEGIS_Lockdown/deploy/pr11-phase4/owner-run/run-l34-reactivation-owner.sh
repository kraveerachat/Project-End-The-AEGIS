#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — L3/L4 POST-REBOOT RUNTIME REACTIVATION, ONE bounded owner-supervised attempt. OWNER-RUN ONLY.
# REPOSITORY TEMPLATE: EXPECTED_MAIN is unpinned, so this file REFUSES TO RUN as committed. The owner freeze workflow copies it OUTSIDE the
# repository, replaces PIN_MAIN_SHA with the merged main SHA, records the frozen file's SHA-256, and only then authorizes a run.
# Design: docs/superpowers/specs/2026-09-27-idea3-pr11-phase4-l34-post-reboot-reactivation-design.md
# Usage (normal user, NOT root):  bash run-l34-reactivation-owner.sh <AUTH_DIR>    AUTH_DIR holds authorization-L4.txt and k3-L4.txt (stage=L4)
#
# V2 (live attempt 1 remediation): the exact rfkill unblock alone left NetworkManager's software Wi-Fi radio disabled (NM_WIFI_RADIO_DISABLED).
# The owner-authorized V2 scope additionally covers ONE global `nmcli radio wifi on`, allowed only when preflight proves wlp0s20f3 is the SOLE
# Wi-Fi device, guarded by a runtime device-autoconnect disable, and restored on rollback. Design: ...l34-nm-radio-remediation-design.md
# RUNTIME_ONLY: this restores the already accepted persistent L3/L4 configuration to its accepted ACTIVE runtime state (manual post-reboot
# reactivation). It is NOT an L3/L4 apply, reinstall, profile rewrite or dnsmasq rewrite, and it does NOT claim any L3/L4 live acceptance.
# It never rewrites persistent files, never touches nftables/forwarding/regulatory state/the global radio/enp62s0/legacy mosquitto/Twingate/
# NTP/ESP32, never runs L3/L4 apply.sh, never starts L6b or L7. K12_AUTOMATIC_REBOOT_PERSISTENCE stays NOT_PROVEN. NO automatic retry.
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
HND=$P4/reactivation/l34
LIB=$P4/p4-l34-reactivation-lib.sh
AP_IF=wlp0s20f3
AP_ADDR=10.77.30.1
PROFILE=/etc/NetworkManager/system-connections/aegis-idea3-ap.nmconnection
EXPECTED_SCOPE='L3_L4_RUNTIME_REACTIVATION_V2: exact rfkill unblock, NM radio enable (sole Wi-Fi device), activate aegis-idea3-ap on wlp0s20f3, reset-failed+start aegis-idea3-dnsmasq, no persistent config rewrite'
TODAY=$(TZ=Asia/Bangkok date +%F)
STAMP=$(TZ=Asia/Bangkok date +%Y%m%d-%H%M%S)
EVID=/home/kittipat/Workspace/idea3-p4-evidence/$TODAY-l34-reactivation-$STAMP
WORK=$EVID/l34-work
PREFLIGHT_WORK=$EVID/l34-preflight
ENGINE=aegis-detection-engine.service; TUNNEL=aegis-detection-tunnel.service

die() { echo "STOP: $*" >&2; exit 1; }
GATE_FAILED=0; gate() { echo "GATE_FAIL: $*" >&2; GATE_FAILED=1; }
show() { systemctl show -p "$2" --value "$1"; }

[ -f "$LIB" ] || die "gate library missing: $LIB (is $REPO at the pinned main?)"
# shellcheck disable=SC1090
source "$LIB"

echo "== L3/L4 reactivation owner-run: pre-gates (read-only; nothing is created or changed yet)"
sudo -v || die "sudo authentication failed"

# 1. pinned main, clean pinned worktree, same-day stage=L4 records with the exact reactivation scope, stage gate (live mode)
for f in authorization-L4.txt k3-L4.txt; do
  [ -f "$AUTH_DIR/$f" ] || gate "$f missing"
  grep -qx "date=$TODAY" "$AUTH_DIR/$f" 2>/dev/null || gate "$f date is not today ($TODAY Asia/Bangkok)"
  grep -qx "stage=L4" "$AUTH_DIR/$f" 2>/dev/null || gate "$f is not stage=L4"
done
grep -qxF "scope=$EXPECTED_SCOPE" "$AUTH_DIR/authorization-L4.txt" 2>/dev/null || gate "authorization scope is not exactly the approved L3_L4_RUNTIME_REACTIVATION scope"
[ ! -e "$AUTH_DIR/L34-REACTIVATION-ATTEMPT-CONSUMED" ] || gate "this authorization already consumed its one bounded attempt"
[ "$(git -C "$REPO" rev-parse HEAD)" = "$EXPECTED_MAIN" ] || gate "worktree HEAD is not $EXPECTED_MAIN"
[ -z "$(git -C "$REPO" status --porcelain)" ] || gate "worktree is not clean"
git -C "$REPO" fetch -q origin 2>/dev/null && [ "$(git -C "$REPO" rev-parse origin/main)" = "$EXPECTED_MAIN" ] \
  || gate "origin/main is not $EXPECTED_MAIN (or fetch failed); not silently re-pinning"
for f in apply.sh verify.sh rollback.sh allow-keys.txt allow-keys-rollback.txt allow-listeners.txt allow-transitions.txt \
  allow-dynamic-transitions.txt allow-dynamic-transitions-rollback.txt; do [ -f "$HND/$f" ] || gate "handler file $f missing"; done
gate_out=$(TZ=Asia/Bangkok bash "$P4/p4-stage-gate.sh" --stage L4 --mode live --authorization "$AUTH_DIR/authorization-L4.txt" --k3 "$AUTH_DIR/k3-L4.txt" 2>&1) || gate "stage gate failed"
for l in AUTHORIZATION_RECORD=VALID K3_CONFIRMATION=VALID; do printf '%s\n' "$gate_out" | grep -qx "$l" || gate "stage gate did not report $l"; done

# 2. historical L3/L4 acceptance receipts at the pinned commit (kept authoritative; this run adds no acceptance claim)
l34_receipt_gate "$REPO" || gate "predecessor receipt gate failed (see reason above)"

# 3. host safety (read-only): the deep static/runtime preflight runs again inside the handler, twice, as root
for c in rfkill nmcli iw ip nft sysctl systemctl ss dnsmasq; do command -v "$c" >/dev/null || gate "$c missing"; done
disk_pct=$(df -P / | awk 'NR == 2 { sub("%", "", $5); print $5 }'); [ "$disk_pct" -lt 90 ] || gate "disk $disk_pct% >= 90"
for u in "$ENGINE" "$TUNNEL" twingate.service mosquitto.service; do [ "$(show "$u" ActiveState)" = active ] && [ "$(show "$u" SubState)" = running ] || gate "$u not active/running"; done
[ "$(show aegis-idea3-mosquitto.service ActiveState)" = inactive ] || gate "L6b broker is not inactive (L6b must not have started)"
[ -z "$(ss -H -ltn "sport = :8883")" ] || gate "an 8883 listener exists (L6b must not have started)"
[ "$GATE_FAILED" = 0 ] || die "one or more pre-gates failed; NOTHING was created or changed"

# 4. the bounded attempt is consumed here: a second invocation for this AUTH_DIR is refused, even after a failure
l34_consume_attempt "$AUTH_DIR" || die "could not consume the one-attempt marker"

mkdir -m 700 "$EVID"; exec > >(tee -a "$EVID/owner-run.log") 2>&1
JOURNAL_SINCE=$(date -u '+%Y-%m-%d %H:%M:%S UTC'); printf '%s\n' "$JOURNAL_SINCE" > "$EVID/journal_since.txt"
cp "$AUTH_DIR/authorization-L4.txt" "$AUTH_DIR/k3-L4.txt" "$EVID/"
{ echo "OPERATION=L3_L4_RUNTIME_REACTIVATION"; echo "REACTIVATION_TYPE=RUNTIME_ONLY"; echo "MAIN=$EXPECTED_MAIN"
  echo "RUNNER_SHA256=$(sha256sum "$0" | cut -d' ' -f1)"; echo "K12_AUTOMATIC_REBOOT_PERSISTENCE=NOT_PROVEN"; } > "$EVID/frozen-inputs.txt"

MUTATED=0; ROLLED_BACK=0
capture() { sudo env EVID_DIR="$2" CAPTURE_LABEL="${1,,}" JOURNAL_SINCE="$JOURNAL_SINCE" bash "$P4/p4-l0-capture.sh" || return 1
  sudo grep -q 'L0_CAPTURE=COMPLETE' "$2/capture.log" || return 1; sudo bash -c "cd '$2' && sha256sum -c --quiet --strict SHA256SUMS" || return 1; echo "CAPTURE_$1=COMPLETE SHA256=PASS"; }
# compare BEFORE AFTER REPORT post|rollback — the value-level dynamic-state windows are exact catalog rules; persistent-file keys are never allowed
compare() {
  local kind=${4:-post} rc=0
  local -a env_allow
  if [ "$kind" = post ]; then
    env_allow=(ALLOW_KEYS_FILE="$HND/allow-keys.txt" ALLOW_LISTENERS_FILE="$HND/allow-listeners.txt" ALLOW_TRANSITIONS_FILE="$HND/allow-transitions.txt" ALLOW_DYNAMIC_TRANSITIONS_FILE="$HND/allow-dynamic-transitions.txt")
  else
    env_allow=(ALLOW_KEYS_FILE="$HND/allow-keys-rollback.txt" ALLOW_DYNAMIC_TRANSITIONS_FILE="$HND/allow-dynamic-transitions-rollback.txt")
  fi
  sudo env DISK_THRESHOLD_PCT=90 AEGIS_AP_INTERFACE="$AP_IF" AEGIS_AP_ADDRESS="$AP_ADDR" "${env_allow[@]}" bash "$P4/p4-compare.sh" "$1" "$2" > "$3" 2>&1 || rc=$?
  grep -E '^(FINDING|FINDINGS_|PRESERVATION_S10|COMPARE_RESULT)' "$3" || true; [ "$rc" = 0 ] || return 1
  for l in FINDINGS_NEW_OR_WORSENED_DRIFT=0 FINDINGS_BASELINE_UNHEALTHY_BUT_UNCHANGED=0 FINDINGS_INCOMPARABLE=0 PRESERVATION_S10=PASS COMPARE_RESULT=PASS; do grep -qx "$l" "$3" || { echo "COMPARE_REQUIREMENT_FAILED: $l"; return 1; }; done; }
handler() { local w=${2:-$WORK}
  sudo env AEGIS_L34_LIVE_AUTHORIZED=YES AEGIS_L34_WORK_DIR="$w" AEGIS_AP_INTERFACE="$AP_IF" AEGIS_L34_NM_RADIO_ENABLE=YES AEGIS_L34_PREFLIGHT_ONLY="${AEGIS_L34_PREFLIGHT_ONLY_RUN:-NO}" bash "$HND/$1"; }
own_work() { sudo chown -R "$(id -u):$(id -g)" "$WORK" "$PREFLIGHT_WORK" 2>/dev/null || true; }
identity_now() { for u in mosquitto.service twingate.service "$ENGINE" "$TUNNEL"; do printf '%s %s/%s\n' "$u" "$(show "$u" MainPID)" "$(show "$u" NRestarts)"; done; }
IDENT_PRE=$(identity_now)
identity_unchanged() { [ "$(identity_now)" = "$IDENT_PRE" ]; }
rollback_flow() { trap - ERR INT TERM; [ "$ROLLED_BACK" = 0 ] || return 0; ROLLED_BACK=1; echo "== L3/L4 reactivation ROLLBACK (reason: $1) — failure/abort path only"
  if sudo test -f "$WORK/production-mutation"; then
    local out; out=$(handler rollback.sh 2>&1) || { printf '%s\n' "$out"; own_work; echo "L34_ROLLBACK=FAIL (S-11 HOLD) — ESCALATE; do NOT retry; inspect $EVID"; exit 3; }
    printf '%s\n' "$out"; own_work
  else echo "NO_PRODUCTION_MUTATION_MARKER: rollback handler not needed; proving zero drift instead"; fi
  capture RB "$EVID/rb-root" || { echo "RB capture FAILED — ESCALATE"; exit 3; }
  compare "$EVID/pre-root" "$EVID/rb-root" "$EVID/compare-pre-rb.txt" rollback && identity_unchanged || { echo "PRE_RB_COMPARE=FAIL — ESCALATE; do NOT retry"; exit 3; }
  echo "PRE_RB_COMPARE=PASS ROLLBACK_RESULT=PASS L34_REACTIVATION=NOT_RESTORED. NOT retrying. Authorization is consumed."; exit 1; }
fail_after_mutation() { [ "$MUTATED" = 1 ] && rollback_flow "$1" || { echo "STOP before any mutation: $1"; exit 1; }; }
trap 'fail_after_mutation "unexpected error at line $LINENO"' ERR
trap 'fail_after_mutation "interrupted"' INT TERM

echo "== read-only preflight through the handler (as root; writes only into the evidence dir)"
pf_out=$(AEGIS_L34_PREFLIGHT_ONLY_RUN=YES handler apply.sh "$PREFLIGHT_WORK" 2>&1) || { printf '%s\n' "$pf_out"; own_work; die "preflight failed; NOTHING was changed"; }
printf '%s\n' "$pf_out"; own_work
printf '%s\n' "$pf_out" | grep -qx 'L34_PREFLIGHT=PASS' || die "preflight did not report L34_PREFLIGHT=PASS"

echo "== PRE capture (before rfkill, NetworkManager, reset-failed and dnsmasq changes)"; capture PRE "$EVID/pre-root" || die "PRE capture failed; nothing changed"
echo "== L3/L4 reactivation APPLY (once)"; MUTATED=1
apply_rc=0; apply_out=$(handler apply.sh 2>&1) || apply_rc=$?; printf '%s\n' "$apply_out"; own_work
{ [ "$apply_rc" = 0 ] && printf '%s\n' "$apply_out" | grep -qx 'L34_APPLY=PASS'; } || rollback_flow "L34_APPLY failed (rc=$apply_rc)"
echo "== VERIFY"
ver_rc=0; ver_out=$(handler verify.sh 2>&1) || ver_rc=$?; printf '%s\n' "$ver_out"; own_work
{ [ "$ver_rc" = 0 ] && printf '%s\n' "$ver_out" | grep -qx 'L34_VERIFY=PASS'; } || rollback_flow "L34_VERIFY failed"
l34_psk_leak_scan "$PROFILE" "$EVID" "$PY" || rollback_flow "PSK_OUTPUT_SCAN failed"
echo "== POST capture"; capture POST "$EVID/post-root" || rollback_flow "POST capture failed"
echo "== PRE -> POST compare (exact reactivation windows only)"; compare "$EVID/pre-root" "$EVID/post-root" "$EVID/compare-pre-post.txt" post || rollback_flow "PRE->POST compare failed"
identity_unchanged || rollback_flow "legacy mosquitto/Twingate/IDEA2 identity changed"
[ "$(show aegis-idea3-mosquitto.service ActiveState)" = inactive ] || rollback_flow "L6b broker unexpectedly active"
trap - ERR INT TERM
echo "L34_REACTIVATION_EXECUTED=YES L34_APPLY=PASS L34_VERIFY=PASS L34_POST_CAPTURE=COMPLETE L34_PRE_POST_COMPARE=PASS"
echo "L3_L4_RUNTIME_REACTIVATION=PASS (RUNTIME_ONLY, manual post-reboot). NO new L3_LIVE_ACCEPTANCE / L4_LIVE_ACCEPTANCE claim. PERSISTENT_FILES_REWRITTEN=NO."
echo "K12_AUTOMATIC_REBOOT_PERSISTENCE=NOT_PROVEN. No L6b, no ESP32, no L7. Evidence: $EVID"
