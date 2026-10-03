#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — GOVERNED dnsmasq UNIT boot-order REPAIR, ONE bounded owner-supervised attempt. OWNER-RUN ONLY.
# REPOSITORY TEMPLATE: EXPECTED_MAIN is unpinned, so this file REFUSES TO RUN as committed. The owner freeze workflow copies it OUTSIDE the repository, replaces
# PIN_MAIN_SHA with the merged main SHA, records the frozen file's SHA-256, and only then authorizes a run. Nothing in this repository authorizes a run.
# Design: docs/superpowers/specs/2026-10-03-idea3-dnsmasq-unit-boot-order-governed-repair-design.md
# Usage (normal user, NOT root):  bash run-dnsmasq-unit-boot-order-repair-owner.sh <AUTH_DIR>    AUTH_DIR holds authorization-L4.txt and k3-L4.txt (stage=L4)
#
# This is a NEW one-shot governed package, NOT an L-stage and NOT a replay of V7/V8: no earlier authorization, K3 record, attempt marker, runner or evidence is reused
# (an attempt marker of ANY other governed run in AUTH_DIR refuses this run). The stage record says stage=L4 only because p4-stage-gate.sh knows no other name for the
# AP/dnsmasq network stage; the exact scope string below is what binds an authorization to THIS repair, and no L3/L4 acceptance is claimed.
# The whole live mutation is: render the canonical deploy/network/aegis-idea3-dnsmasq.service.example with the fixed approved values, install it, daemon-reload, and
# reset-failed + start (failed baseline) or restart (running baseline) aegis-idea3-dnsmasq.service ONLY — see reactivation/dnsmasq-unit-boot-order-repair/apply.sh.
# GOVERNED SUCCESSOR (amendment 2026-10-03): the first live attempt of this package was CONSUMED and ended ROLLBACK_FAILED_ESCALATE at the S10 comparator (IDEA2 was already
# unhealthy). It is historical and is NEVER replayed (OLD_ATTEMPT_RETRY_ALLOWED=NO): its AUTH_DIR, Authorization, K3, marker, frozen runner and evidence directory are
# refused/never reused. A successor needs a NEW exact-main frozen runner, a BRAND-NEW same-day AUTH_DIR/Authorization/K3 and the owner's explicit authorization of ONE attempt.
# This runner additionally accepts the exact SAFE_STOPPED dnsmasq baseline and runs a PRE-CONSUME read-only S10 stability guard (see below).
# It issues NO command against the AP, NetworkManager, nftables, forwarding, the broker, Twingate, Core, Recovery, the F1 detector, L8p or any ESP32, and it claims NO
# K12 reboot persistence (the separate orderly-reboot verification is owner-run/verify-dnsmasq-boot-order-after-reboot.sh). NO automatic retry.
set -Eeuo pipefail
umask 077

EXPECTED_MAIN=PIN_MAIN_SHA
case "$EXPECTED_MAIN" in PIN_*) echo "STOP: runner is not pinned (EXPECTED_MAIN). Run the owner freeze workflow first."; exit 2 ;; esac
[[ "$EXPECTED_MAIN" =~ ^[0-9a-f]{40}$ ]] || { echo "STOP: EXPECTED_MAIN is not a 40-hex SHA."; exit 2; }
[ "$(id -u)" != 0 ] || { echo "Run as your normal user, not root."; exit 2; }
S10_WINDOW_SEC=30   # frozen length of the pre-consume S10 stability window (the owner has no knob; tests substitute this line only)
AUTH_DIR=${1:-}
[ -n "$AUTH_DIR" ] && [ -d "$AUTH_DIR" ] || { echo "usage: bash $0 <AUTH_DIR with authorization-L4.txt and k3-L4.txt>"; exit 2; }

# ---- frozen inputs -----------------------------------------------------------------------------------------------------
REPO=/home/kittipat/Workspace/IDEA3-Cyber-Last/worktrees/Project-End-The-AEGIS-DNSMASQREPAIRLIVE   # clean pinned execution worktree at merged main
PY=/home/kittipat/.venvs/aegis-idea3-core/bin/python
P4=$REPO/IDEA3-AEGIS_Lockdown/deploy/pr11-phase4
HND=$P4/reactivation/dnsmasq-unit-boot-order-repair
LIB=$P4/p4-l34-reactivation-lib.sh
V8LIB=$P4/p4-l34-v8-lib.sh
RLIB=$P4/p4-dnsmasq-repair-lib.sh
AP_IF=wlp0s20f3
AP_ADDR=10.77.30.1
PROFILE=/etc/NetworkManager/system-connections/aegis-idea3-ap.nmconnection
EXPECTED_SCOPE='DNSMASQ_UNIT_BOOT_ORDER_REPAIR: install canonical rendered dnsmasq unit, daemon-reload, dnsmasq reset-failed/start or restart only; no AP, network, broker, Core or ESP32 change'
TODAY=$(TZ=Asia/Bangkok date +%F)
STAMP=$(TZ=Asia/Bangkok date +%Y%m%d-%H%M%S)
EVID=/home/kittipat/Workspace/idea3-p4-evidence/$TODAY-dnsmasq-unit-repair-$STAMP
WORK=$EVID/dnsmasq-repair-work
PREFLIGHT_WORK=$EVID/dnsmasq-repair-preflight
ENGINE=aegis-detection-engine.service; TUNNEL=aegis-detection-tunnel.service
CORE_UNIT=aegis-idea3-core.service
BROKER_UNIT=aegis-idea3-mosquitto.service

die() { echo "STOP: $*" >&2; echo "DNSMASQ_REPAIR_RESULT=NOT_STARTED_NO_MUTATION" >&2; exit 1; }
GATE_FAILED=0; gate() { echo "GATE_FAIL: $*" >&2; GATE_FAILED=1; }
show() { systemctl show -p "$2" --value "$1"; }

[ -f "$LIB" ] && [ -f "$V8LIB" ] && [ -f "$RLIB" ] || die "gate library missing under $P4 (is $REPO at the pinned main?)"
# shellcheck disable=SC1090
source "$LIB"; source "$V8LIB"; source "$RLIB"
auth_real=$(readlink -f -- "$AUTH_DIR")
for hist in "${DNSREPAIR_HISTORICAL_CONSUMED_AUTH_DIRS[@]}"; do
  [ "$auth_real" != "$(readlink -f -- "$hist" 2>/dev/null || printf '%s' "$hist")" ] || die "AUTH_DIR is the historical CONSUMED first-attempt authorization directory; a successor needs a brand-new same-day AUTH_DIR (OLD_ATTEMPT_RETRY_ALLOWED=NO)"
done

echo "K12_AUTOMATIC_REBOOT_PERSISTENCE=NOT_PROVEN"
echo "REBOOT_VERIFICATION_EXECUTED=NO"
echo "== governed dnsmasq unit repair owner-run: pre-gates (read-only; nothing is created or changed yet)"
sudo -v || die "sudo authentication failed"

# 1. pinned main, clean pinned worktree containing PR #305, same-day stage=L4 records with the exact repair scope, K3/stage gate (live mode)
for f in authorization-L4.txt k3-L4.txt; do
  [ -f "$AUTH_DIR/$f" ] || gate "$f missing"
  grep -qx "date=$TODAY" "$AUTH_DIR/$f" 2>/dev/null || gate "$f date is not today ($TODAY Asia/Bangkok)"
  grep -qx "stage=L4" "$AUTH_DIR/$f" 2>/dev/null || gate "$f is not stage=L4"
done
grep -qxF "scope=$EXPECTED_SCOPE" "$AUTH_DIR/authorization-L4.txt" 2>/dev/null || gate "authorization scope is not exactly the approved dnsmasq repair scope"
# exact historical-record digest denial (independent of the AUTH_DIR path): a byte-identical copy of the consumed first attempt's Authorization or K3 is refused here, BEFORE
# the stage gate, the pre-consume S10 guard, the marker and any mutation. Only digests are compared; record contents are never printed.
if [ -f "$AUTH_DIR/authorization-L4.txt" ] && [ -r "$AUTH_DIR/authorization-L4.txt" ]; then
  [ "$(sha256sum -- "$AUTH_DIR/authorization-L4.txt" | cut -d' ' -f1)" != "$DNSREPAIR_HISTORICAL_AUTHORIZATION_SHA256" ] \
    || die "HISTORICAL_AUTHORIZATION_RECORD_REUSE_FORBIDDEN: authorization-L4.txt is byte-identical to the consumed first attempt's record; a successor needs a brand-new Authorization"
fi
if [ -f "$AUTH_DIR/k3-L4.txt" ] && [ -r "$AUTH_DIR/k3-L4.txt" ]; then
  [ "$(sha256sum -- "$AUTH_DIR/k3-L4.txt" | cut -d' ' -f1)" != "$DNSREPAIR_HISTORICAL_K3_SHA256" ] \
    || die "HISTORICAL_K3_RECORD_REUSE_FORBIDDEN: k3-L4.txt is byte-identical to the consumed first attempt's record; a successor needs a brand-new K3"
fi
marker="$AUTH_DIR/$DNSREPAIR_MARKER_NAME"
[ ! -e "$marker" ] || gate "this authorization already consumed its one bounded attempt"
# this package never reuses any other governed run's authorization directory: ANY other attempt marker refuses
others=$(find "$AUTH_DIR" -maxdepth 1 -name '*ATTEMPT-CONSUMED*' ! -name "$DNSREPAIR_MARKER_NAME" -printf '%f\n' 2>/dev/null | head -n 1 || true)
[ -z "$others" ] || gate "AUTH_DIR carries the attempt marker of another governed run ($others): this repair requires its own fresh same-day authorization directory"
[ "$(git -C "$REPO" rev-parse HEAD)" = "$EXPECTED_MAIN" ] || gate "worktree HEAD is not $EXPECTED_MAIN"
[ -z "$(git -C "$REPO" status --porcelain)" ] || gate "worktree is not clean"
git -C "$REPO" fetch -q origin 2>/dev/null && [ "$(git -C "$REPO" rev-parse origin/main)" = "$EXPECTED_MAIN" ] \
  || gate "origin/main is not $EXPECTED_MAIN (or fetch failed); not silently re-pinning"
git -C "$REPO" merge-base --is-ancestor "$DNSREPAIR_PR305_MERGE" "$EXPECTED_MAIN" 2>/dev/null || gate "PR #305 merge $DNSREPAIR_PR305_MERGE is not an ancestor of $EXPECTED_MAIN"
for f in apply.sh verify.sh rollback.sh allow-keys.txt allow-keys-rollback.txt allow-listeners.txt allow-dynamic-transitions-failed-post.txt allow-dynamic-transitions-failed-rollback.txt; do
  [ -f "$HND/$f" ] || gate "handler file $f missing"
done
gate_out=$(TZ=Asia/Bangkok bash "$P4/p4-stage-gate.sh" --stage L4 --mode live --authorization "$AUTH_DIR/authorization-L4.txt" --k3 "$AUTH_DIR/k3-L4.txt" 2>&1) || gate "stage gate failed"
for l in AUTHORIZATION_RECORD=VALID K3_CONFIRMATION=VALID; do printf '%s\n' "$gate_out" | grep -qx "$l" || gate "stage gate did not report $l"; done

# 2. host safety (read-only). The deep static/runtime preflight runs again inside the handler, as root.
for c in nmcli iw ip nft sysctl systemctl ss dnsmasq journalctl systemd-analyze; do command -v "$c" >/dev/null || gate "$c missing"; done
disk_pct=$(df -P / | awk 'NR == 2 { sub("%", "", $5); print $5 }'); [ "$disk_pct" -lt 90 ] || gate "disk $disk_pct% >= 90"
for u in "$ENGINE" "$TUNNEL" twingate.service mosquitto.service "$CORE_UNIT" "$BROKER_UNIT"; do
  [ "$(show "$u" ActiveState)" = active ] && [ "$(show "$u" SubState)" = running ] || gate "$u not active/running"
done
[ "$GATE_FAILED" = 0 ] || die "one or more pre-gates failed; NOTHING was created or changed"

# 3. evidence directory (read-only host effect only). The one-shot authorization is NOT consumed yet: it is consumed only after the handler preflight and the PRE
#    capture have both succeeded, immediately before the first host mutation (see "consume" below).
mkdir -m 700 "$EVID"; exec > >(tee -a "$EVID/owner-run.log") 2>&1
JOURNAL_SINCE=$(date -u '+%Y-%m-%d %H:%M:%S UTC'); printf '%s\n' "$JOURNAL_SINCE" > "$EVID/journal_since.txt"
cp "$AUTH_DIR/authorization-L4.txt" "$AUTH_DIR/k3-L4.txt" "$EVID/"
{ echo "OPERATION=DNSMASQ_UNIT_BOOT_ORDER_REPAIR"; echo "REPAIR_TYPE=ONE_UNIT_FILE_AND_ONE_SERVICE"; echo "MAIN=$EXPECTED_MAIN"; echo "PR305_MERGE=$DNSREPAIR_PR305_MERGE"
  echo "RUNNER_SHA256=$(sha256sum "$0" | cut -d' ' -f1)"; echo "K12_AUTOMATIC_REBOOT_PERSISTENCE=NOT_PROVEN"; echo "REBOOT_VERIFICATION_EXECUTED=NO"
  echo "L8P_LIVE_EXECUTED=NO"; echo "RECOVERY_R1_R8=NOT_RUN"; echo "LVR=NOT_RUN"; echo "L8=NOT_RUN"; echo "ESP32_TOUCHED=NO"; } > "$EVID/frozen-inputs.txt"

MUTATED=0; ROLLED_BACK=0; BASELINE=unknown
capture() { sudo env EVID_DIR="$2" CAPTURE_LABEL="${1,,}" JOURNAL_SINCE="$JOURNAL_SINCE" bash "$P4/p4-l0-capture.sh" || return 1
  sudo grep -q 'L0_CAPTURE=COMPLETE' "$2/capture.log" || return 1; sudo bash -c "cd '$2' && sha256sum -c --quiet --strict SHA256SUMS" || return 1; echo "CAPTURE_$1=COMPLETE SHA256=PASS"; }
# compare BEFORE AFTER REPORT post|rollback — the only approved drift is the dnsmasq service's own process bookkeeping (+ the exact failed->active catalog window on
# the FAILED baseline); persistent-file and AP keys are never allowed
compare() {
  local kind=${4:-post} rc=0
  local -a env_allow
  [[ "$BASELINE" =~ ^(failed|running|safe_stopped)$ ]] || { echo "COMPARE_BASELINE_UNKNOWN"; return 1; }
  if [ "$kind" = post ]; then
    env_allow=(ALLOW_KEYS_FILE="$HND/allow-keys.txt" ALLOW_LISTENERS_FILE="$HND/allow-listeners.txt")
    [ "$BASELINE" != failed ] || env_allow+=(ALLOW_DYNAMIC_TRANSITIONS_FILE="$HND/allow-dynamic-transitions-failed-post.txt")
    [ "$BASELINE" != safe_stopped ] || env_allow+=(ALLOW_DYNAMIC_TRANSITIONS_FILE="$HND/allow-dynamic-transitions-safe-stopped-post.txt")
  else
    env_allow=(ALLOW_KEYS_FILE="$HND/allow-keys-rollback.txt" ALLOW_LISTENERS_FILE="$HND/allow-listeners.txt")
    [ "$BASELINE" != failed ] || env_allow+=(ALLOW_DYNAMIC_TRANSITIONS_FILE="$HND/allow-dynamic-transitions-failed-rollback.txt")
  fi
  sudo env DISK_THRESHOLD_PCT=90 AEGIS_AP_INTERFACE="$AP_IF" AEGIS_AP_ADDRESS="$AP_ADDR" "${env_allow[@]}" bash "$P4/p4-compare.sh" "$1" "$2" > "$3" 2>&1 || rc=$?
  grep -E '^(FINDING|FINDINGS_|PRESERVATION_S10|COMPARE_RESULT)' "$3" || true; [ "$rc" = 0 ] || return 1
  for l in FINDINGS_NEW_OR_WORSENED_DRIFT=0 FINDINGS_BASELINE_UNHEALTHY_BUT_UNCHANGED=0 FINDINGS_INCOMPARABLE=0 PRESERVATION_S10=PASS COMPARE_RESULT=PASS; do grep -qx "$l" "$3" || { echo "COMPARE_REQUIREMENT_FAILED: $l"; return 1; }; done; }
handler() { local w=${2:-$WORK}
  sudo env AEGIS_DNSREPAIR_LIVE_AUTHORIZED=YES AEGIS_DNSREPAIR_WORK_DIR="$w" AEGIS_AP_INTERFACE="$AP_IF" AEGIS_DNSREPAIR_PREFLIGHT_ONLY="${AEGIS_DNSREPAIR_PREFLIGHT_ONLY_RUN:-NO}" bash "$HND/$1"; }
own_work() { sudo chown -R "$(id -u):$(id -g)" "$WORK" "$PREFLIGHT_WORK" 2>/dev/null || true; }
identity_now() { for u in mosquitto.service twingate.service "$ENGINE" "$TUNNEL" "$CORE_UNIT" "$BROKER_UNIT"; do printf '%s %s/%s\n' "$u" "$(show "$u" MainPID)" "$(show "$u" NRestarts)"; done; }
IDENT_PRE=$(identity_now)
identity_unchanged() { [ "$(identity_now)" = "$IDENT_PRE" ]; }
verdict_end() { echo "DNSMASQ_REPAIR_RESULT=$1"; echo "DNSMASQ_REPAIR_RESULT=$1" > "$EVID/terminal-verdict.txt"; }
rollback_flow() { trap - ERR INT TERM; [ "$ROLLED_BACK" = 0 ] || return 0; ROLLED_BACK=1; echo "== governed dnsmasq repair ROLLBACK (reason: $1) — failure/abort path only"
  if sudo test -f "$WORK/production-mutation"; then
    local out; out=$(handler rollback.sh 2>&1) || { printf '%s\n' "$out"; own_work; echo "DNSMASQ_REPAIR_ROLLBACK=FAIL (S-11 HOLD) — ESCALATE; do NOT retry; inspect $EVID"; verdict_end ROLLBACK_FAILED_ESCALATE; exit 3; }
    printf '%s\n' "$out"; own_work
  else echo "NO_PRODUCTION_MUTATION_MARKER: rollback handler not needed; proving zero drift instead"; fi
  capture RB "$EVID/rb-root" || { echo "RB capture FAILED — ESCALATE"; verdict_end ROLLBACK_FAILED_ESCALATE; exit 3; }
  compare "$EVID/pre-root" "$EVID/rb-root" "$EVID/compare-pre-rb.txt" rollback && identity_unchanged \
    || { echo "PRE_RB_COMPARE=FAIL — ESCALATE; do NOT retry"; verdict_end ROLLBACK_FAILED_ESCALATE; exit 3; }
  echo "PRE_RB_COMPARE=PASS ROLLBACK_RESULT=PASS SAFE_STATE_RESTORED=YES. The dnsmasq unit is the old one again; the AP, broker and Core were never commanded. NOT retrying. Authorization is consumed."
  echo "DNSMASQ_REPAIR_APPLIED=NO"; echo "ESP32_TOUCHED=NO"; verdict_end ROLLED_BACK; exit 1; }
fail_after_mutation() { [ "$MUTATED" = 1 ] && rollback_flow "$1" || { echo "STOP before any mutation: $1"; verdict_end NOT_STARTED_NO_MUTATION; exit 1; }; }
trap 'fail_after_mutation "unexpected error at line $LINENO"' ERR
trap 'fail_after_mutation "interrupted"' INT TERM

echo "== read-only preflight through the handler (as root; writes only into the evidence dir)"
pf_out=$(AEGIS_DNSREPAIR_PREFLIGHT_ONLY_RUN=YES handler apply.sh "$PREFLIGHT_WORK" 2>&1) || { printf '%s\n' "$pf_out"; own_work; die "preflight failed; NOTHING was changed"; }
printf '%s\n' "$pf_out"; own_work
printf '%s\n' "$pf_out" | grep -qx 'DNSMASQ_REPAIR_PREFLIGHT=PASS' || die "preflight did not report DNSMASQ_REPAIR_PREFLIGHT=PASS"
case "$(printf '%s\n' "$pf_out" | grep -x 'DNSMASQ_REPAIR_BASELINE=\(FAILED\|RUNNING\|SAFE_STOPPED\)' | wc -l)" in 1) ;; *) die "preflight did not report exactly one recognized DNSMASQ_REPAIR_BASELINE" ;; esac
BASELINE=$(printf '%s\n' "$pf_out" | sed -n 's/^DNSMASQ_REPAIR_BASELINE=//p' | tr 'A-Z' 'a-z')
echo "BASELINE=$BASELINE" >> "$EVID/frozen-inputs.txt"

echo "== PRE capture (before the unit replacement, daemon-reload and the dnsmasq service action)"; capture PRE "$EVID/pre-root" || die "PRE capture failed; nothing changed"
# PRE-CONSUME S10 STABILITY GUARD (read-only; the canonical p4-l0-capture.sh and p4-compare.sh, no second S10 implementation). The first attempt consumed its marker while
# IDEA2 was already unhealthy (:18002 absent although the tunnel unit was active/running), so the S10 comparator failed after the mutation. Here a SECOND fresh capture is
# taken after a bounded window and compared with PRE with NO allowance: any drift, any unhealthy-but-unchanged IDEA2/Core/broker baseline or any incomparable key refuses the
# run NOW -> NO attempt marker, NO Production mutation, the authorization stays unconsumed.
echo "== pre-consume S10 stability guard (read-only; window ${S10_WINDOW_SEC}s)"
sleep "$S10_WINDOW_SEC"
capture S10 "$EVID/s10-root" || die "S10_STABILITY_GUARD: second capture failed; nothing changed, authorization NOT consumed"
s10_rc=0; sudo env DISK_THRESHOLD_PCT=90 AEGIS_AP_INTERFACE="$AP_IF" AEGIS_AP_ADDRESS="$AP_ADDR" bash "$P4/p4-compare.sh" "$EVID/pre-root" "$EVID/s10-root" > "$EVID/compare-pre-s10.txt" 2>&1 || s10_rc=$?
for l in FINDINGS_NEW_OR_WORSENED_DRIFT=0 FINDINGS_BASELINE_UNHEALTHY_BUT_UNCHANGED=0 FINDINGS_INCOMPARABLE=0 PRESERVATION_S10=PASS COMPARE_RESULT=PASS; do
  [ "$s10_rc" = 0 ] && grep -qx "$l" "$EVID/compare-pre-s10.txt" 2>/dev/null || { grep -E '^(FINDING|FINDINGS_|PRESERVATION_S10|COMPARE_RESULT)' "$EVID/compare-pre-s10.txt" 2>/dev/null || true
    die "S10_STABILITY_GUARD failed ($l not satisfied; IDEA2/Core/broker not stable and healthy); nothing changed, authorization NOT consumed"; }
done
echo "S10_STABILITY_GUARD=PASS"
# consume: the bounded attempt is spent here, after every refusable check passed and immediately before the first mutation. A second invocation for this AUTH_DIR is
# refused from now on, even after a failure. A refused preflight or failed PRE capture above leaves the authorization usable.
( set -o noclobber; printf 'consumed_at=%s\n' "$(date -u +%FT%TZ)" > "$marker" ) 2>/dev/null \
  || die "could not consume the one-attempt marker; nothing changed"
echo "== governed dnsmasq unit repair APPLY (once)"; MUTATED=1
apply_rc=0; apply_out=$(handler apply.sh 2>&1) || apply_rc=$?; printf '%s\n' "$apply_out"; own_work
{ [ "$apply_rc" = 0 ] && printf '%s\n' "$apply_out" | grep -qx 'DNSMASQ_REPAIR_APPLY=PASS'; } || rollback_flow "DNSMASQ_REPAIR_APPLY failed (rc=$apply_rc)"
echo "== VERIFY"
ver_rc=0; ver_out=$(handler verify.sh 2>&1) || ver_rc=$?; printf '%s\n' "$ver_out"; own_work
{ [ "$ver_rc" = 0 ] && printf '%s\n' "$ver_out" | grep -qx 'DNSMASQ_REPAIR_VERIFY=PASS'; } || rollback_flow "DNSMASQ_REPAIR_VERIFY failed"
for l in DNSMASQ_REPAIR_APPLIED=YES DNSMASQ_UNIT_AUTHORITY=PASS DNSMASQ_ACTIVE=YES DNSMASQ_RUNNING=YES DNSMASQ_START_LIMIT_HIT=NO AP_MODE=PASS AP_SSID=PASS AP_CHANNEL=PASS \
  AP_IPV4_PREFIX=PASS CORE_HEALTH=PASS BROKER_UNCHANGED=PASS FORWARDING_POLICY=PASS ESP32_TOUCHED=NO; do
  printf '%s\n' "$ver_out" | grep -qx "$l" || rollback_flow "verify did not report $l"
done
l34_psk_leak_scan "$PROFILE" "$EVID" "$PY" || rollback_flow "PSK_OUTPUT_SCAN failed"
echo "== POST capture"; capture POST "$EVID/post-root" || rollback_flow "POST capture failed"
echo "== PRE -> POST compare (exact dnsmasq bookkeeping window only)"; compare "$EVID/pre-root" "$EVID/post-root" "$EVID/compare-pre-post.txt" post || rollback_flow "PRE->POST compare failed"
identity_unchanged || rollback_flow "legacy mosquitto/Twingate/IDEA2/Core/broker identity changed"
trap - ERR INT TERM
{ printf '%s\n' "$ver_out" | grep -E '^(DNSMASQ_REPAIR_APPLIED|DNSMASQ_UNIT_AUTHORITY|DNSMASQ_ACTIVE|DNSMASQ_RUNNING|DNSMASQ_START_LIMIT_HIT|AP_MODE|AP_SSID|AP_CHANNEL|AP_IPV4_PREFIX|CORE_HEALTH|BROKER_UNCHANGED|FORWARDING_POLICY)='
  echo "UNEXPECTED_DRIFT=NONE"; echo "ESP32_TOUCHED=NO"; echo "DNSMASQ_REPAIR_RESULT=PASS"; echo "BASELINE=$BASELINE"
  echo "K12_AUTOMATIC_REBOOT_PERSISTENCE=NOT_PROVEN"; echo "REBOOT_VERIFICATION_EXECUTED=NO"; } | tee "$EVID/terminal-verdict.txt"
echo "DNSMASQ_UNIT_BOOT_ORDER_REPAIR=PASS (baseline=$BASELINE). Exactly one unit file was replaced and one service acted on; the AP, NetworkManager, nftables, forwarding, broker, Twingate, Core and every ESP32 were not touched. NO K12 reboot-persistence claim (a separate orderly-reboot verification). CORE_RESTARTED=NO. L34 reactivation is NOT run and needs its own fresh authorization. Evidence: $EVID"
