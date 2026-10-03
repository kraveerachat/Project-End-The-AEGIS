#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — GOVERNED PRE-L8p NTP RUNTIME REACTIVATION, ONE bounded owner-supervised attempt. OWNER-RUN ONLY.
# REPOSITORY TEMPLATE: EXPECTED_MAIN, OPERATOR_USER and OPERATOR_UID are unpinned, so this file REFUSES TO RUN as committed. The owner freeze workflow copies it OUTSIDE the
# repository, replaces the three PIN_* values, records the frozen file's SHA-256, and only then authorizes a run. Nothing in this repository authorizes a run.
# Design: docs/superpowers/specs/2026-10-03-idea3-pre-l8p-ntp-runtime-reactivation-design.md
# Usage (the FROZEN operator user, NOT root):  bash run-pre-l8p-ntp-runtime-reactivation-owner.sh <AUTH_DIR>    AUTH_DIR holds authorization-L5.txt and k3-L5.txt (stage=L5)
#
# This is a NEW one-shot governed successor, NOT an L5 rerun and NOT L5 acceptance: historical L5 LIVE acceptance stays PROVEN and unchanged, and no L5 Authorization, K3,
# attempt marker, runner or evidence is reused (any other governed run's attempt marker in AUTH_DIR refuses this run; the historical L5 authorization reference is refused).
# The stage record says stage=L5 only because p4-stage-gate.sh knows no other name for the NTP stage; the exact scope string in p4-ntp-reactivation-lib.sh binds an
# authorization to THIS task.
# The whole live mutation is: systemctl stop systemd-timesyncd.service ; systemctl start chronyd.service — see reactivation/pre-l8p-ntp-runtime-reactivation/apply.sh.
# It never enables/disables a unit, never writes /etc/chrony.conf, and issues NO command against the AP, NetworkManager, nftables, dnsmasq, the broker, Twingate, Core, Recovery,
# L8p, serial/esptool or any ESP32; it publishes no MQTT message and sends no CUT/RESTORE. It claims NO K12 reboot persistence. NO automatic retry.
set -Eeuo pipefail
umask 077

EXPECTED_MAIN=PIN_MAIN_SHA
OPERATOR_USER=PIN_OPERATOR_USER
OPERATOR_UID=PIN_OPERATOR_UID
for pin in EXPECTED_MAIN OPERATOR_USER OPERATOR_UID; do
  case "${!pin}" in PIN_*) echo "STOP: runner is not pinned ($pin). Run the owner freeze workflow first."; exit 2 ;; esac
done
[[ "$EXPECTED_MAIN" =~ ^[0-9a-f]{40}$ ]] || { echo "STOP: EXPECTED_MAIN is not a 40-hex SHA."; exit 2; }
[ "$(id -u)" != 0 ] || { echo "Run as your normal user, not root."; exit 2; }
S10_WINDOW_SEC=30   # frozen length of the pre-consume S10 stability window (the owner has no knob; tests substitute this line only)
AUTH_DIR=${1:-}
[ -n "$AUTH_DIR" ] && [ -d "$AUTH_DIR" ] || { echo "usage: bash $0 <AUTH_DIR with authorization-L5.txt and k3-L5.txt>"; exit 2; }

# ---- frozen inputs -----------------------------------------------------------------------------------------------------
REPO=/home/kittipat/Workspace/IDEA3-Cyber-Last/worktrees/Project-End-The-AEGIS-NTPREACTLIVE   # clean pinned execution worktree at merged main
P4=$REPO/IDEA3-AEGIS_Lockdown/deploy/pr11-phase4
HND=$P4/reactivation/pre-l8p-ntp-runtime-reactivation
LIB=$P4/p4-ntp-reactivation-lib.sh
TODAY=$(TZ=Asia/Bangkok date +%F)
STAMP=$(TZ=Asia/Bangkok date +%Y%m%d-%H%M%S)
EVID=/home/kittipat/Workspace/idea3-p4-evidence/$TODAY-pre-l8p-ntp-reactivation-$STAMP
WORK=$EVID/ntp-reactivation-work
PREFLIGHT_WORK=$EVID/ntp-reactivation-preflight
ENGINE=aegis-detection-engine.service; TUNNEL=aegis-detection-tunnel.service
CORE_UNIT=aegis-idea3-core.service
BROKER_UNIT=aegis-idea3-mosquitto.service

die() { echo "STOP: $*" >&2; echo "NTP_REACTIVATION_RESULT=NOT_STARTED_NO_MUTATION" >&2; exit 1; }
GATE_FAILED=0; gate() { echo "GATE_FAIL: $*" >&2; GATE_FAILED=1; }
show() { systemctl show -p "$2" --value "$1"; }

[ -f "$LIB" ] || die "gate library missing under $P4 (is $REPO at the pinned main?)"
# shellcheck disable=SC1090
source "$LIB"

echo "K12_AUTOMATIC_REBOOT_PERSISTENCE=NOT_PROVEN"
echo "L5_LIVE_ACCEPTANCE=HISTORICAL_PROVEN_UNCHANGED"
echo "== governed PRE-L8p NTP runtime reactivation owner-run: pre-gates (read-only; nothing is created or changed yet)"
# 0. frozen operator identity, and the frozen runner is a copy OUTSIDE the repository
ntpreact_identity_gate "$OPERATOR_USER" "$OPERATOR_UID" || die "operator identity is not the frozen operator (see reason above); nothing was created or touched"
case "$(readlink -f -- "$0")" in "$(readlink -f -- "$REPO")"/*) die "the runner must be the frozen copy OUTSIDE the repository worktree" ;; esac
sudo -v || die "sudo authentication failed"

# 1. same-day stage=L5 records with the exact successor scope, no historical L5 reference, fresh one-attempt marker, K3/stage gate (live mode)
ntpreact_record_gate "$AUTH_DIR/authorization-L5.txt" "$AUTH_DIR/k3-L5.txt" "$TODAY" || gate "records are not fresh same-day exact-scope stage=L5 records (see reason above)"
ntpreact_attempt_unconsumed "$AUTH_DIR" || gate "attempt marker gate failed (see reason above)"
[ "$(git -C "$REPO" rev-parse HEAD)" = "$EXPECTED_MAIN" ] || gate "worktree HEAD is not $EXPECTED_MAIN"
[ -z "$(git -C "$REPO" status --porcelain)" ] || gate "worktree is not clean"
git -C "$REPO" fetch -q origin 2>/dev/null && [ "$(git -C "$REPO" rev-parse origin/main)" = "$EXPECTED_MAIN" ] \
  || gate "origin/main is not $EXPECTED_MAIN (or fetch failed); not silently re-pinning"
ntpreact_receipt_gate "$REPO" || gate "historical L5 live acceptance receipt is not PROVEN at the pinned commit (see reason above)"
for f in apply.sh verify.sh rollback.sh allow-keys.txt allow-listeners.txt; do
  [ -f "$HND/$f" ] || gate "handler file $f missing"
done
gate_out=$(TZ=Asia/Bangkok bash "$P4/p4-stage-gate.sh" --stage L5 --mode live --authorization "$AUTH_DIR/authorization-L5.txt" --k3 "$AUTH_DIR/k3-L5.txt" 2>&1) || gate "stage gate failed"
for l in AUTHORIZATION_RECORD=VALID K3_CONFIRMATION=VALID; do printf '%s\n' "$gate_out" | grep -qx "$l" || gate "stage gate did not report $l"; done

# 2. host safety (read-only). The deep runtime preflight runs again inside the handler, as root.
for c in systemctl ip ss python3 sha256sum; do command -v "$c" >/dev/null || gate "$c missing"; done
disk_pct=$(df -P / | awk 'NR == 2 { sub("%", "", $5); print $5 }'); [ "$disk_pct" -lt 90 ] || gate "disk $disk_pct% >= 90"
[ "$GATE_FAILED" = 0 ] || die "one or more pre-gates failed; NOTHING was created or changed"

# 3. evidence directory (read-only host effect only). The one-shot authorization is NOT consumed yet: it is consumed only after the handler preflight, the PRE capture and
#    the S10 stability guard have all succeeded, immediately before the first host mutation (see "consume" below).
mkdir -m 700 "$EVID"; exec > >(tee -a "$EVID/owner-run.log") 2>&1
JOURNAL_SINCE=$(date -u '+%Y-%m-%d %H:%M:%S UTC'); printf '%s\n' "$JOURNAL_SINCE" > "$EVID/journal_since.txt"
cp "$AUTH_DIR/authorization-L5.txt" "$AUTH_DIR/k3-L5.txt" "$EVID/"
{ echo "OPERATION=$NTPREACT_TASK_ID"; echo "MAIN=$EXPECTED_MAIN"; echo "OPERATOR=$OPERATOR_USER/$OPERATOR_UID"
  echo "RUNNER_SHA256=$(sha256sum "$0" | cut -d' ' -f1)"; echo "L5_LIVE_ACCEPTANCE=HISTORICAL_PROVEN_UNCHANGED"; echo "K12_AUTOMATIC_REBOOT_PERSISTENCE=NOT_PROVEN"
  echo "L8P_LIVE_EXECUTED=NO"; echo "RECOVERY_EXECUTED=NO"; echo "LVR_EXECUTED=NO"; echo "L8_ACCEPTANCE=NO"; echo "ESP32_FLASH_PERFORMED=NO"; } > "$EVID/frozen-inputs.txt"

MUTATED=0; ROLLED_BACK=0
capture() { sudo env EVID_DIR="$2" CAPTURE_LABEL="${1,,}" JOURNAL_SINCE="$JOURNAL_SINCE" bash "$P4/p4-l0-capture.sh" || return 1
  sudo grep -q 'L0_CAPTURE=COMPLETE' "$2/capture.log" || return 1; sudo bash -c "cd '$2' && sha256sum -c --quiet --strict SHA256SUMS" || return 1; echo "CAPTURE_$1=COMPLETE SHA256=PASS"; }
# compare BEFORE AFTER REPORT — the only approved drift is the two units' own runtime bookkeeping, the derived time state and the AP NTP/chronyd command listeners.
# UnitFileState and every /etc/chrony.conf key are NOT approved: any change is drift.
compare() {
  local rc=0
  sudo env DISK_THRESHOLD_PCT=90 AEGIS_AP_INTERFACE="$NTPREACT_AP_IF" AEGIS_AP_ADDRESS="$NTPREACT_AP_ADDR" ALLOW_KEYS_FILE="$HND/allow-keys.txt" ALLOW_LISTENERS_FILE="$HND/allow-listeners.txt" \
    bash "$P4/p4-compare.sh" "$1" "$2" > "$3" 2>&1 || rc=$?
  grep -E '^(FINDING|FINDINGS_|PRESERVATION_S10|COMPARE_RESULT)' "$3" || true; [ "$rc" = 0 ] || return 1
  for l in FINDINGS_NEW_OR_WORSENED_DRIFT=0 FINDINGS_BASELINE_UNHEALTHY_BUT_UNCHANGED=0 FINDINGS_INCOMPARABLE=0 PRESERVATION_S10=PASS COMPARE_RESULT=PASS; do grep -qx "$l" "$3" || { echo "COMPARE_REQUIREMENT_FAILED: $l"; return 1; }; done; }
handler() { local w=${2:-$WORK}
  sudo env AEGIS_NTPREACT_LIVE_AUTHORIZED=YES AEGIS_NTPREACT_WORK_DIR="$w" AEGIS_AP_INTERFACE="$NTPREACT_AP_IF" AEGIS_NTPREACT_PREFLIGHT_ONLY="${AEGIS_NTPREACT_PREFLIGHT_ONLY_RUN:-NO}" bash "$HND/$1"; }
own_work() { sudo chown -R "$(id -u):$(id -g)" "$WORK" "$PREFLIGHT_WORK" 2>/dev/null || true; }
identity_now() { for u in mosquitto.service twingate.service "$ENGINE" "$TUNNEL" "$CORE_UNIT" "$BROKER_UNIT"; do printf '%s %s/%s\n' "$u" "$(show "$u" MainPID)" "$(show "$u" NRestarts)"; done; }
IDENT_PRE=$(identity_now)
identity_unchanged() { [ "$(identity_now)" = "$IDENT_PRE" ]; }
verdict_end() { echo "NTP_REACTIVATION_RESULT=$1"; echo "NTP_REACTIVATION_RESULT=$1" > "$EVID/terminal-verdict.txt"; }
rollback_flow() { trap - ERR INT TERM; [ "$ROLLED_BACK" = 0 ] || return 0; ROLLED_BACK=1; echo "== governed NTP reactivation ROLLBACK (reason: $1) — failure/abort path only"
  if sudo test -f "$WORK/production-mutation"; then
    local out; out=$(handler rollback.sh 2>&1) || { printf '%s\n' "$out"; own_work; echo "NTPREACT_ROLLBACK=FAIL — ESCALATE; do NOT retry; inspect $EVID"; verdict_end ROLLBACK_FAILED_ESCALATE; exit 3; }
    printf '%s\n' "$out"; own_work
  else echo "NO_PRODUCTION_MUTATION_MARKER: rollback handler not needed; proving zero drift instead"; fi
  capture RB "$EVID/rb-root" || { echo "RB capture FAILED — ESCALATE"; verdict_end ROLLBACK_FAILED_ESCALATE; exit 3; }
  compare "$EVID/pre-root" "$EVID/rb-root" "$EVID/compare-pre-rb.txt" && identity_unchanged \
    || { echo "PRE_RB_COMPARE=FAIL — ESCALATE; do NOT retry"; verdict_end ROLLBACK_FAILED_ESCALATE; exit 3; }
  echo "PRE_RB_COMPARE=PASS ROLLBACK_RESULT=PASS RUNTIME_BASELINE_RESTORED=YES. systemd-timesyncd is active again and chronyd is inactive; no UnitFileState or configuration was touched. NOT retrying. Authorization is consumed."
  echo "PRE_L8P_NTP_RUNTIME_REACTIVATION=NOT_APPLIED"; echo "NTP_RUNTIME_READY_FOR_L8P=NO"; verdict_end ROLLED_BACK; exit 1; }
fail_after_mutation() { [ "$MUTATED" = 1 ] && rollback_flow "$1" || { echo "STOP before any mutation: $1"; verdict_end NOT_STARTED_NO_MUTATION; exit 1; }; }
trap 'fail_after_mutation "unexpected error at line $LINENO"' ERR
trap 'fail_after_mutation "interrupted"' INT TERM

echo "== read-only preflight through the handler (as root; writes only into the evidence dir)"
pf_out=$(AEGIS_NTPREACT_PREFLIGHT_ONLY_RUN=YES handler apply.sh "$PREFLIGHT_WORK" 2>&1) || { printf '%s\n' "$pf_out"; own_work; die "preflight failed; NOTHING was changed"; }
printf '%s\n' "$pf_out"; own_work
printf '%s\n' "$pf_out" | grep -qx 'NTPREACT_PREFLIGHT=PASS' || die "preflight did not report NTPREACT_PREFLIGHT=PASS"

echo "== PRE capture (before the systemd-timesyncd stop and the chronyd start)"; capture PRE "$EVID/pre-root" || die "PRE capture failed; nothing changed"
# PRE-CONSUME S10 STABILITY GUARD (read-only; the canonical p4-l0-capture.sh and p4-compare.sh, no second S10 implementation): a second fresh capture after a bounded window is
# compared with PRE with NO allowance. Any drift, any unhealthy-but-unchanged IDEA2/Core/broker baseline or any incomparable key refuses the run NOW -> NO attempt marker,
# NO Production mutation, the authorization stays unconsumed.
echo "== pre-consume S10 stability guard (read-only; window ${S10_WINDOW_SEC}s)"
sleep "$S10_WINDOW_SEC"
capture S10 "$EVID/s10-root" || die "S10_STABILITY_GUARD: second capture failed; nothing changed, authorization NOT consumed"
s10_rc=0; sudo env DISK_THRESHOLD_PCT=90 AEGIS_AP_INTERFACE="$NTPREACT_AP_IF" AEGIS_AP_ADDRESS="$NTPREACT_AP_ADDR" bash "$P4/p4-compare.sh" "$EVID/pre-root" "$EVID/s10-root" > "$EVID/compare-pre-s10.txt" 2>&1 || s10_rc=$?
for l in FINDINGS_NEW_OR_WORSENED_DRIFT=0 FINDINGS_BASELINE_UNHEALTHY_BUT_UNCHANGED=0 FINDINGS_INCOMPARABLE=0 PRESERVATION_S10=PASS COMPARE_RESULT=PASS; do
  [ "$s10_rc" = 0 ] && grep -qx "$l" "$EVID/compare-pre-s10.txt" 2>/dev/null || { grep -E '^(FINDING|FINDINGS_|PRESERVATION_S10|COMPARE_RESULT)' "$EVID/compare-pre-s10.txt" 2>/dev/null || true
    die "S10_STABILITY_GUARD failed ($l not satisfied; IDEA2/Core/broker not stable and healthy); nothing changed, authorization NOT consumed"; }
done
echo "S10_STABILITY_GUARD=PASS"
# consume: the bounded attempt is spent here, after every refusable check passed and immediately before the first mutation. A second invocation for this AUTH_DIR is refused
# from now on, even after a failure. A refused preflight, failed PRE capture or failed S10 guard above leaves the authorization usable.
ntpreact_consume_attempt "$AUTH_DIR" || die "could not consume the one-attempt marker; nothing changed"
echo "== governed PRE-L8p NTP runtime reactivation APPLY (once)"; MUTATED=1
apply_rc=0; apply_out=$(handler apply.sh 2>&1) || apply_rc=$?; printf '%s\n' "$apply_out"; own_work
{ [ "$apply_rc" = 0 ] && printf '%s\n' "$apply_out" | grep -qx 'NTPREACT_APPLY=PASS'; } || rollback_flow "NTPREACT_APPLY failed (rc=$apply_rc)"
echo "== VERIFY"
ver_rc=0; ver_out=$(handler verify.sh 2>&1) || ver_rc=$?; printf '%s\n' "$ver_out"; own_work
{ [ "$ver_rc" = 0 ] && printf '%s\n' "$ver_out" | grep -qx 'NTPREACT_VERIFY=PASS'; } || rollback_flow "NTPREACT_VERIFY failed"
for l in CHRONYD_ACTIVE=YES TIMESYNCD_INACTIVE=YES "NTP_LISTENER=$NTPREACT_AP_ADDR:123" WILDCARD_NTP_LISTENER=NO TRUSTEDCLOCK=SYNCED MAXERROR_WITHIN_L5_BOUND=YES \
  CHRONYD_UNITFILESTATE=disabled TIMESYNCD_UNITFILESTATE=enabled CHRONY_CONF_SHA256_PRE_EQ_POST=YES; do
  printf '%s\n' "$ver_out" | grep -qx "$l" || rollback_flow "verify did not report $l"
done
echo "== POST capture"; capture POST "$EVID/post-root" || rollback_flow "POST capture failed"
echo "== PRE -> POST compare (the two units' runtime bookkeeping, time state and the AP NTP listener only)"; compare "$EVID/pre-root" "$EVID/post-root" "$EVID/compare-pre-post.txt" || rollback_flow "PRE->POST compare failed"
identity_unchanged || rollback_flow "legacy mosquitto/Twingate/IDEA2/Core/broker identity changed"
trap - ERR INT TERM
{ printf '%s\n' "$ver_out" | grep -E '^(CHRONYD_ACTIVE|TIMESYNCD_INACTIVE|NTP_LISTENER|WILDCARD_NTP_LISTENER|TRUSTEDCLOCK|MAXERROR_WITHIN_L5_BOUND|CHRONYD_UNITFILESTATE|TIMESYNCD_UNITFILESTATE|CHRONY_CONF_SHA256_PRE_EQ_POST)='
  echo "UNITFILESTATE_MUTATION=NO"; echo "CHRONY_CONFIG_MUTATION=NO"; echo "UNEXPECTED_DRIFT=NONE"
  echo "PRE_L8P_NTP_RUNTIME_REACTIVATION=PASS"; echo "NTP_RUNTIME_READY_FOR_L8P=YES"; echo "NTP_LISTENER_ADDRESS=$NTPREACT_AP_ADDR:123"
  echo "L5_LIVE_ACCEPTANCE=HISTORICAL_PROVEN_UNCHANGED"; echo "K12_AUTOMATIC_REBOOT_PERSISTENCE=NOT_PROVEN"
  echo "L8P_LIVE_EXECUTED=NO"; echo "ESP32_FLASH_PERFORMED=NO"; echo "RECOVERY_EXECUTED=NO"; echo "LVR_EXECUTED=NO"; echo "L8_ACCEPTANCE=NO"
  echo "NTP_REACTIVATION_RESULT=PASS"; } | tee "$EVID/terminal-verdict.txt"
echo "PRE_L8P_NTP_RUNTIME_REACTIVATION=PASS. Exactly two systemctl commands ran (stop systemd-timesyncd, start chronyd); no unit was enabled or disabled, /etc/chrony.conf is byte-identical, and the AP, dnsmasq, broker, Core and every ESP32 were not touched. This is NOT an L5 rerun, NOT K12 proof (a reboot returns the host to timesyncd), and L8p is NOT run: it needs its own fresh authorization. Evidence: $EVID"
