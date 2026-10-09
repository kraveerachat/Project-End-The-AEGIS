#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — L3/L4 POST-V7 PERSISTENT AP RECOVERY (V8, OD-L34-V8-01), ONE bounded owner-supervised attempt. OWNER-RUN ONLY.
# REPOSITORY TEMPLATE: EXPECTED_MAIN is unpinned, so this file REFUSES TO RUN as committed. The owner freeze workflow copies it OUTSIDE the
# repository, replaces PIN_MAIN_SHA with the merged main SHA, records the frozen file's SHA-256, and only then authorizes a run.
# Design: docs/superpowers/specs/2026-10-02-idea3-pr11-phase4-l34-v8-post-v7-persistent-ap-recovery-design.md
# Usage (normal user, NOT root):  bash run-l34-v8-post-v7-persistent-ap-recovery-owner.sh <AUTH_DIR>    AUTH_DIR holds authorization-L4.txt and k3-L4.txt (stage=L4)
#
# V8 is a NEW one-shot governed stage, NOT a V7 retry: V7 is historical (its live result is immutable); its authorization, runner, marker and evidence are
# never reused (a V7 marker in AUTH_DIR refuses this run). V7 was RUNTIME_ONLY and K12 was NOT_PROVEN, so after two reboots the host is back in the
# radio-disabled / AP-down / broker-churn state. V8 supports EXACTLY ONE baseline (target phy soft-blocked, NM Wi-Fi radio disabled, wlp0s20f3 unavailable,
# aegis-idea3-ap inactive with connection.autoconnect=no, 10.77.30.1 absent, dnsmasq failed/start-limit-hit, the broker crash-looping ONLY because
# 10.77.30.1 is absent, no :8883 listener, Core healthy, an alternate default route present). It performs exactly the sequence documented in
# reactivation/l34-v8-post-v7-persistent-ap-recovery/apply.sh, including the ONE persistent change (aegis-idea3-ap connection.autoconnect no -> yes) through
# NetworkManager's own connection-modify command, issues NO command against the broker or Core, edits no rfkill/NetworkManager state file, and claims NO
# K12/L3/L4/L6b live acceptance. Recovery R1-R8, L7u and L8 are NOT executed or authorized. NO automatic retry.
set -Eeuo pipefail
umask 077

EXPECTED_MAIN=PIN_MAIN_SHA
case "$EXPECTED_MAIN" in PIN_*) echo "STOP: runner is not pinned (EXPECTED_MAIN). Run the owner freeze workflow first."; exit 2 ;; esac
[[ "$EXPECTED_MAIN" =~ ^[0-9a-f]{40}$ ]] || { echo "STOP: EXPECTED_MAIN is not a 40-hex SHA."; exit 2; }
[ "$(id -u)" != 0 ] || { echo "Run as your normal user, not root."; exit 2; }
AUTH_DIR=${1:-}
[ -n "$AUTH_DIR" ] && [ -d "$AUTH_DIR" ] || { echo "usage: bash $0 <AUTH_DIR with authorization-L4.txt and k3-L4.txt>"; exit 2; }

# ---- frozen inputs -----------------------------------------------------------------------------------------------------
REPO=/home/kittipat/Workspace/IDEA3-Cyber-Last/worktrees/Project-End-The-AEGIS-L34V8LIVE   # clean pinned execution worktree at merged main
PY=/home/kittipat/.venvs/aegis-idea3-core/bin/python
P4=$REPO/IDEA3-AEGIS_Lockdown/deploy/pr11-phase4
HND=$P4/reactivation/l34-v8-post-v7-persistent-ap-recovery
V3=$P4/reactivation/l34            # the exact V3 preservation catalogs are reused, never copied or widened
LIB=$P4/p4-l34-reactivation-lib.sh
AP_IF=wlp0s20f3
AP_ADDR=10.77.30.1
PROFILE=/etc/NetworkManager/system-connections/aegis-idea3-ap.nmconnection
EXPECTED_SCOPE='L3_L4_RUNTIME_RECOVERY_V8_POST_V7_PERSISTENT_AP: rfkill and radio on once, AP profile autoconnect no->yes once, one ifname-bound AP up, one dnsmasq start; no broker or Core control'
TODAY=$(TZ=Asia/Bangkok date +%F)
STAMP=$(TZ=Asia/Bangkok date +%Y%m%d-%H%M%S)
EVID=/home/kittipat/Workspace/idea3-p4-evidence/$TODAY-l34-v8-$STAMP
WORK=$EVID/l34-v8-work
PREFLIGHT_WORK=$EVID/l34-v8-preflight
ENGINE=aegis-detection-engine.service; TUNNEL=aegis-detection-tunnel.service
DNSMASQ_UNIT=aegis-idea3-dnsmasq.service
BROKER_UNIT=aegis-idea3-mosquitto.service
CORE_UNIT=aegis-idea3-core.service

die() { echo "STOP: $*" >&2; exit 1; }
GATE_FAILED=0; gate() { echo "GATE_FAIL: $*" >&2; GATE_FAILED=1; }
show() { systemctl show -p "$2" --value "$1"; }

[ -f "$LIB" ] || die "gate library missing: $LIB (is $REPO at the pinned main?)"
# shellcheck disable=SC1090
source "$LIB"

echo "RECOVERY_R1_R8_PROVEN=NO"
echo "L8_AUTHORIZED=NO"
echo "== L3/L4 V8 post-V7 persistent AP recovery owner-run: pre-gates (read-only; nothing is created or changed yet)"
sudo -v || die "sudo authentication failed"

# 1. pinned main, clean pinned worktree, same-day stage=L4 records with the exact V8 scope, K3/stage gate (live mode)
for f in authorization-L4.txt k3-L4.txt; do
  [ -f "$AUTH_DIR/$f" ] || gate "$f missing"
  grep -qx "date=$TODAY" "$AUTH_DIR/$f" 2>/dev/null || gate "$f date is not today ($TODAY Asia/Bangkok)"
  grep -qx "stage=L4" "$AUTH_DIR/$f" 2>/dev/null || gate "$f is not stage=L4"
done
grep -qxF "scope=$EXPECTED_SCOPE" "$AUTH_DIR/authorization-L4.txt" 2>/dev/null || gate "authorization scope is not exactly the approved V8 scope"
[ ! -e "$AUTH_DIR/L34-V8-REACTIVATION-ATTEMPT-CONSUMED" ] || gate "this authorization already consumed its one bounded attempt"
# V8 never reuses V7 (or any other stage's) authorization directory: a V7 attempt marker means this AUTH_DIR belongs to the historical one-shot V7 flow
[ ! -e "$AUTH_DIR/L34-V7-REACTIVATION-ATTEMPT-CONSUMED" ] || gate "AUTH_DIR carries the historical V7 attempt marker: V8 requires its own fresh same-day authorization directory"
[ "$(git -C "$REPO" rev-parse HEAD)" = "$EXPECTED_MAIN" ] || gate "worktree HEAD is not $EXPECTED_MAIN"
[ -z "$(git -C "$REPO" status --porcelain)" ] || gate "worktree is not clean"
git -C "$REPO" fetch -q origin 2>/dev/null && [ "$(git -C "$REPO" rev-parse origin/main)" = "$EXPECTED_MAIN" ] \
  || gate "origin/main is not $EXPECTED_MAIN (or fetch failed); not silently re-pinning"
for f in apply.sh verify.sh rollback.sh allow-keys.txt allow-keys-rollback.txt allow-listeners.txt; do [ -f "$HND/$f" ] || gate "handler file $f missing"; done
for f in allow-transitions.txt allow-dynamic-transitions-v3-post-fresh.txt allow-dynamic-transitions-v3-post-residual.txt \
  allow-dynamic-transitions-v3-rollback-fresh.txt allow-dynamic-transitions-v3-rollback-residual.txt; do [ -f "$V3/$f" ] || gate "V3 catalog $f missing"; done
gate_out=$(TZ=Asia/Bangkok bash "$P4/p4-stage-gate.sh" --stage L4 --mode live --authorization "$AUTH_DIR/authorization-L4.txt" --k3 "$AUTH_DIR/k3-L4.txt" 2>&1) || gate "stage gate failed"
for l in AUTHORIZATION_RECORD=VALID K3_CONFIRMATION=VALID; do printf '%s\n' "$gate_out" | grep -qx "$l" || gate "stage gate did not report $l"; done

# 2. historical L3/L4 acceptance receipts at the pinned commit (kept authoritative; this run adds no acceptance claim)
l34_receipt_gate "$REPO" || gate "predecessor receipt gate failed (see reason above)"

# 3. host safety (read-only): the ONE supported V8 baseline. The deep static/runtime preflight runs again inside the handler, as root.
for c in rfkill nmcli iw ip nft sysctl systemctl ss dnsmasq journalctl; do command -v "$c" >/dev/null || gate "$c missing"; done
disk_pct=$(df -P / | awk 'NR == 2 { sub("%", "", $5); print $5 }'); [ "$disk_pct" -lt 90 ] || gate "disk $disk_pct% >= 90"
for u in "$ENGINE" "$TUNNEL" twingate.service mosquitto.service "$CORE_UNIT"; do
  [ "$(show "$u" ActiveState)" = active ] && [ "$(show "$u" SubState)" = running ] || gate "$u not active/running"
done
unit_props() { systemctl show -p LoadState -p ActiveState -p SubState -p UnitFileState -p Result -p MainPID "$1"; }
unit_props "$DNSMASQ_UNIT" | l34_service_pre_gate || gate "$(unit_props "$DNSMASQ_UNIT" | l34_service_pre_gate 2>&1 | head -n 1)"
BROKER_JOURNAL_PREGATE=$(mktemp) && BROKER_SHOW_PREGATE=$(mktemp) || die "could not create temporary broker capture files"
trap 'rm -f "$BROKER_JOURNAL_PREGATE" "$BROKER_SHOW_PREGATE"' EXIT
# one systemd read feeds BOTH the journal binding (current boot + failed InvocationID) and the churn gate, so they cannot disagree
l34_v7_broker_show "$BROKER_UNIT" > "$BROKER_SHOW_PREGATE" || gate "broker show failed"
l34_v7_broker_journal_capture "$BROKER_UNIT" "$BROKER_SHOW_PREGATE" "$BROKER_JOURNAL_PREGATE" \
  || gate "$(l34_v7_broker_journal_capture "$BROKER_UNIT" "$BROKER_SHOW_PREGATE" "$BROKER_JOURNAL_PREGATE" 2>&1 | head -n 1)"
l34_v7_broker_churn_gate "$BROKER_JOURNAL_PREGATE" < "$BROKER_SHOW_PREGATE" \
  || gate "$(l34_v7_broker_churn_gate "$BROKER_JOURNAL_PREGATE" < "$BROKER_SHOW_PREGATE" 2>&1 | head -n 1)"
l34_v7_no_8883_listener_gate || gate "$(l34_v7_no_8883_listener_gate 2>&1 | head -n 1)"
[ "$GATE_FAILED" = 0 ] || die "one or more pre-gates failed; NOTHING was created or changed"

# 4. evidence directory (read-only host effect only). The one-shot authorization is NOT consumed yet: it is consumed only after the handler preflight and
#    the PRE capture have both succeeded, immediately before the first host mutation (see "consume" below).
marker="$AUTH_DIR/L34-V8-REACTIVATION-ATTEMPT-CONSUMED"
mkdir -m 700 "$EVID"; exec > >(tee -a "$EVID/owner-run.log") 2>&1
JOURNAL_SINCE=$(date -u '+%Y-%m-%d %H:%M:%S UTC'); printf '%s\n' "$JOURNAL_SINCE" > "$EVID/journal_since.txt"
cp "$AUTH_DIR/authorization-L4.txt" "$AUTH_DIR/k3-L4.txt" "$EVID/"
{ echo "OPERATION=L3_L4_RUNTIME_RECOVERY_V8_POST_V7_PERSISTENT_AP"; echo "REACTIVATION_TYPE=RUNTIME_RECOVERY_WITH_ONE_PERSISTENT_AUTOCONNECT_CHANGE"; echo "PERSISTENT_CHANGE_SCOPE=NM_PROFILE_aegis-idea3-ap_connection.autoconnect_no_to_yes_ONLY"; echo "MAIN=$EXPECTED_MAIN"
  echo "RUNNER_SHA256=$(sha256sum "$0" | cut -d' ' -f1)"; echo "K12_AUTOMATIC_REBOOT_PERSISTENCE=NOT_PROVEN"
  echo "RECOVERY_R1_R8_PROVEN=NO"; echo "L8_AUTHORIZED=NO"; } > "$EVID/frozen-inputs.txt"

MUTATED=0; ROLLED_BACK=0; BASELINE=unknown
capture() { sudo env EVID_DIR="$2" CAPTURE_LABEL="${1,,}" JOURNAL_SINCE="$JOURNAL_SINCE" bash "$P4/p4-l0-capture.sh" || return 1
  sudo grep -q 'L0_CAPTURE=COMPLETE' "$2/capture.log" || return 1; sudo bash -c "cd '$2' && sha256sum -c --quiet --strict SHA256SUMS" || return 1; echo "CAPTURE_$1=COMPLETE SHA256=PASS"; }
# compare BEFORE AFTER REPORT post|rollback — value-level windows are exact V3 catalog rules chosen by the reported baseline; persistent-file keys are never allowed
compare() {
  local kind=${4:-post} rc=0
  local -a env_allow
  [[ "$BASELINE" =~ ^(fresh|residual)$ ]] || { echo "COMPARE_BASELINE_UNKNOWN"; return 1; }
  if [ "$kind" = post ]; then
    env_allow=(ALLOW_KEYS_FILE="$HND/allow-keys.txt" ALLOW_LISTENERS_FILE="$HND/allow-listeners.txt" ALLOW_TRANSITIONS_FILE="$V3/allow-transitions.txt"
      ALLOW_DYNAMIC_TRANSITIONS_FILE="$V3/allow-dynamic-transitions-v3-post-$BASELINE.txt")
  else
    # the broker may be left crash-looping OR holding a stale 8883 pair (it is never commanded), so its runtime keys and the approved listeners stay allowed
    env_allow=(ALLOW_KEYS_FILE="$HND/allow-keys-rollback.txt" ALLOW_LISTENERS_FILE="$HND/allow-listeners.txt"
      ALLOW_DYNAMIC_TRANSITIONS_FILE="$V3/allow-dynamic-transitions-v3-rollback-$BASELINE.txt")
    [ "$BASELINE" != fresh ] || env_allow+=(ALLOW_TRANSITIONS_FILE="$V3/allow-transitions.txt")
  fi
  sudo env DISK_THRESHOLD_PCT=90 AEGIS_AP_INTERFACE="$AP_IF" AEGIS_AP_ADDRESS="$AP_ADDR" "${env_allow[@]}" bash "$P4/p4-compare.sh" "$1" "$2" > "$3" 2>&1 || rc=$?
  grep -E '^(FINDING|FINDINGS_|PRESERVATION_S10|COMPARE_RESULT)' "$3" || true; [ "$rc" = 0 ] || return 1
  for l in FINDINGS_NEW_OR_WORSENED_DRIFT=0 FINDINGS_BASELINE_UNHEALTHY_BUT_UNCHANGED=0 FINDINGS_INCOMPARABLE=0 PRESERVATION_S10=PASS COMPARE_RESULT=PASS; do grep -qx "$l" "$3" || { echo "COMPARE_REQUIREMENT_FAILED: $l"; return 1; }; done; }
handler() { local w=${2:-$WORK}
  sudo env AEGIS_L34_LIVE_AUTHORIZED=YES AEGIS_L34_WORK_DIR="$w" AEGIS_AP_INTERFACE="$AP_IF" AEGIS_L34_V8_PYTHON="$PY" AEGIS_L34_PREFLIGHT_ONLY="${AEGIS_L34_PREFLIGHT_ONLY_RUN:-NO}" bash "$HND/$1"; }
own_work() { sudo chown -R "$(id -u):$(id -g)" "$WORK" "$PREFLIGHT_WORK" 2>/dev/null || true; }
identity_now() { for u in mosquitto.service twingate.service "$ENGINE" "$TUNNEL" "$CORE_UNIT"; do printf '%s %s/%s\n' "$u" "$(show "$u" MainPID)" "$(show "$u" NRestarts)"; done; }
IDENT_PRE=$(identity_now)
identity_unchanged() { [ "$(identity_now)" = "$IDENT_PRE" ]; }
rollback_flow() { trap - ERR INT TERM; [ "$ROLLED_BACK" = 0 ] || return 0; ROLLED_BACK=1; echo "== L3/L4 V8 recovery ROLLBACK (reason: $1) — failure/abort path only"
  if sudo test -f "$WORK/production-mutation"; then
    local out; out=$(handler rollback.sh 2>&1) || { printf '%s\n' "$out"; own_work; echo "L34_V8_ROLLBACK=FAIL (S-11 HOLD) — ESCALATE; do NOT retry; inspect $EVID"; exit 3; }
    printf '%s\n' "$out"; own_work
  else echo "NO_PRODUCTION_MUTATION_MARKER: rollback handler not needed; proving zero drift instead"; fi
  capture RB "$EVID/rb-root" || { echo "RB capture FAILED — ESCALATE"; exit 3; }
  compare "$EVID/pre-root" "$EVID/rb-root" "$EVID/compare-pre-rb.txt" rollback && identity_unchanged \
    || { echo "PRE_RB_COMPARE=FAIL — ESCALATE; do NOT retry"; exit 3; }
  echo "PRE_RB_COMPARE=PASS ROLLBACK_RESULT=PASS SAFE_NETWORK_BOUNDARY_RESTORED=YES L34_V8_RECOVERY=NOT_RESTORED. The broker was never commanded and may be crash-looping or hold a stale pair. NOT retrying. Authorization is consumed."; exit 1; }
fail_after_mutation() { [ "$MUTATED" = 1 ] && rollback_flow "$1" || { echo "STOP before any mutation: $1"; exit 1; }; }
trap 'fail_after_mutation "unexpected error at line $LINENO"' ERR
trap 'fail_after_mutation "interrupted"' INT TERM

echo "== read-only preflight through the handler (as root; writes only into the evidence dir)"
pf_out=$(AEGIS_L34_PREFLIGHT_ONLY_RUN=YES handler apply.sh "$PREFLIGHT_WORK" 2>&1) || { printf '%s\n' "$pf_out"; own_work; die "preflight failed; NOTHING was changed"; }
printf '%s\n' "$pf_out"; own_work
printf '%s\n' "$pf_out" | grep -qx 'L34_V8_PREFLIGHT=PASS' || die "preflight did not report L34_V8_PREFLIGHT=PASS"
case "$(printf '%s\n' "$pf_out" | grep -x 'L34_BASELINE=\(FRESH\|RESIDUAL\)' | wc -l)" in 1) ;; *) die "preflight did not report exactly one recognized L34_BASELINE (mixed/unrecognized state)" ;; esac
BASELINE=$(printf '%s\n' "$pf_out" | sed -n 's/^L34_BASELINE=//p' | tr 'A-Z' 'a-z')
echo "BASELINE=$BASELINE" >> "$EVID/frozen-inputs.txt"

echo "== PRE capture (before rfkill, NetworkManager, reset-failed and dnsmasq changes)"; capture PRE "$EVID/pre-root" || die "PRE capture failed; nothing changed"
# consume: the bounded attempt is spent here, after every refusable check passed and immediately before the first mutation. A second invocation for
# this AUTH_DIR is refused from now on, even after a failure. A refused preflight or failed PRE capture above leaves the authorization usable.
( set -o noclobber; printf 'consumed_at=%s\n' "$(date -u +%FT%TZ)" > "$marker" ) 2>/dev/null \
  || die "could not consume the one-attempt marker; nothing changed"
echo "== L3/L4 V8 recovery APPLY (once)"; MUTATED=1
apply_rc=0; apply_out=$(handler apply.sh 2>&1) || apply_rc=$?; printf '%s\n' "$apply_out"; own_work
{ [ "$apply_rc" = 0 ] && printf '%s\n' "$apply_out" | grep -qx 'L34_V8_APPLY=PASS'; } || rollback_flow "L34_V8_APPLY failed (rc=$apply_rc)"
echo "== VERIFY"
ver_rc=0; ver_out=$(handler verify.sh 2>&1) || ver_rc=$?; printf '%s\n' "$ver_out"; own_work
{ [ "$ver_rc" = 0 ] && printf '%s\n' "$ver_out" | grep -qx 'L34_V8_VERIFY=PASS'; } || rollback_flow "L34_V8_VERIFY failed"
l34_psk_leak_scan "$PROFILE" "$EVID" "$PY" || rollback_flow "PSK_OUTPUT_SCAN failed"
echo "== POST capture"; capture POST "$EVID/post-root" || rollback_flow "POST capture failed"
echo "== PRE -> POST compare (exact reactivation windows only)"; compare "$EVID/pre-root" "$EVID/post-root" "$EVID/compare-pre-post.txt" post || rollback_flow "PRE->POST compare failed"
identity_unchanged || rollback_flow "legacy mosquitto/Twingate/IDEA2/Core identity changed"
trap - ERR INT TERM
echo "L34_V8_REACTIVATION_EXECUTED=YES L34_V8_APPLY=PASS L34_V8_VERIFY=PASS L34_V8_POST_CAPTURE=COMPLETE L34_V8_PRE_POST_COMPARE=PASS"
echo "L3_L4_RUNTIME_RECOVERY_V8=PASS (baseline=$BASELINE). The ONE persistent change was NetworkManager aegis-idea3-ap connection.autoconnect no -> yes; every other persistent file is unchanged. NO new L3_LIVE_ACCEPTANCE / L4_LIVE_ACCEPTANCE / L6B_LIVE_ACCEPTANCE claim. L6B_BROKER_MUTATED=NO (recovered via its own systemd auto-restart only). CORE_RESTARTED=NO."
echo "K12_AUTOMATIC_REBOOT_PERSISTENCE=NOT_PROVEN (a later, separate reboot acceptance). RECOVERY_R1_R8_PROVEN=NO. L7U_EXECUTED=NO. L8_AUTHORIZED=NO. No ESP32, no MQTT command. Evidence: $EVID"
