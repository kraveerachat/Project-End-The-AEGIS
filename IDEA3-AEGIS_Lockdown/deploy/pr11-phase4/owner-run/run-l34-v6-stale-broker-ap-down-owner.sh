#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — L3/L4 STALE-BROKER / AP-DOWN RUNTIME REACTIVATION (V6), ONE bounded owner-supervised attempt. OWNER-RUN ONLY.
# REPOSITORY TEMPLATE: EXPECTED_MAIN is unpinned, so this file REFUSES TO RUN as committed. The owner freeze workflow copies it OUTSIDE the
# repository, replaces PIN_MAIN_SHA with the merged main SHA, records the frozen file's SHA-256, and only then authorizes a run.
# Design: docs/superpowers/specs/2026-09-29-idea3-pr11-phase4-l34-v6-stale-broker-ap-down-design.md
# V6_STAGE_NAME=l34-v6-stale-broker-ap-down  V6_BASELINE_ID=STALE_BROKER_AP_DOWN
#
# V6 is a DISTINCT operation from V1–V3 (radio disabled), V4 (dnsmasq AND broker healthy, AP up) and V5 (dnsmasq failed, broker crash-
# looping). It supports EXACTLY ONE baseline: the L6b broker already active/running and stable, holding the stale 127.0.0.1:8883 +
# 10.77.30.1:8883 pair, with the AP address absent and aegis-idea3-dnsmasq.service cleanly inactive/dead.
#
# V6 performs EXACTLY: a temporary `nmcli device set wlp0s20f3 autoconnect no` (PRE value restored), one `nmcli connection up
# aegis-idea3-ap ifname wlp0s20f3`, the autoconnect restore, ONE plain `systemctl start aegis-idea3-dnsmasq.service` (no reset-failed on
# the normal path), ONE handshake-only TLS probe to 10.77.30.1:8883 (p4-l7-broker-probe.py), a 6 x 5 s soak. It NEVER issues any command
# against the broker (start/stop/restart/reload/reset-failed/kill/try-restart/enable/disable/mask); it proves the broker's
# MainPID/NRestarts/InvocationID tuple equals PRE before, after and in rollback (a change is S-11 HOLD, never a repair). It never touches
# rfkill, the global NM radio, nftables, forwarding, regulatory state, enp62s0, legacy mosquitto (incl. :1883), Twingate, IDEA1/IDEA2,
# never sends an MQTT command, never touches ESP32, never runs L3/L4 apply.sh, never starts L7, claims NO L3/L4/L6b live acceptance.
# TrustedClock stabilization (post live attempt 2026-09-29-l34-v6-20260929-170043, where POST and RB failed ONLY on time.trustedclock.state
# SYNCED -> UNTRUSTED and the clock was SYNCED/OK on every later probe): before the POST capture and before the RB capture the runner runs a
# bounded, READ-ONLY gate that repeats the existing `p4-l5-clock.py state` probe until it reports exactly `state=SYNCED reason=OK`. The bound is
# the reviewed L5 readiness bound (60 s / 1 s). The gate never touches a time service or the clock, never weakens p4-compare.sh (which still
# decides PRESERVATION_S10 / COMPARE_RESULT independently), and every sample's full output is kept in clock-stabilization-{post,rb}.log.
# NO automatic retry. The attempt is consumed only AFTER every read-only gate, the handler preflight, the PRE capture (+hash verify) and
# the final broker-tuple equality have passed; once consumed, any failure is STOP/rollback/evidence and the authorization is never reused.
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
HND=$P4/reactivation/l34-v6-stale-broker-ap-down
LIB=$P4/p4-l34-reactivation-lib.sh
AP_IF=wlp0s20f3
AP_ADDR=10.77.30.1
EXPECTED_SCOPE='L3_L4_RUNTIME_REACTIVATION_V6_STALE_BROKER_AP_DOWN: one AP up, one dnsmasq start, one TLS handshake probe; no broker control, no nft/forwarding, no IDEA1/IDEA2 change, no MQTT/ESP32/L6c/L7'
TODAY=$(TZ=Asia/Bangkok date +%F)
STAMP=$(TZ=Asia/Bangkok date +%Y%m%d-%H%M%S)
EVID=/home/kittipat/Workspace/idea3-p4-evidence/$TODAY-l34-v6-$STAMP
WORK=$EVID/l34-v6-work
PREFLIGHT_WORK=$EVID/l34-v6-preflight
ENGINE=aegis-detection-engine.service; TUNNEL=aegis-detection-tunnel.service
DNSMASQ_UNIT=aegis-idea3-dnsmasq.service
BROKER_UNIT=aegis-idea3-mosquitto.service
MARKER="$AUTH_DIR/L34-V6-REACTIVATION-ATTEMPT-CONSUMED"
CLOCK_STAB_TIMEOUT_S=60   # the reviewed L5 readiness bound (stages/L5/apply.sh AEGIS_L5_READINESS_TIMEOUT_SEC default); not a new policy
CLOCK_STAB_INTERVAL_S=1   # the reviewed L5 readiness poll interval (AEGIS_L5_READINESS_INTERVAL_SEC default)

die() { echo "STOP: $*" >&2; exit 1; }
GATE_FAILED=0; gate() { echo "GATE_FAIL: $*" >&2; GATE_FAILED=1; }
show() { systemctl show -p "$2" --value "$1"; }

[ -f "$LIB" ] || die "gate library missing: $LIB (is $REPO at the pinned main?)"
# shellcheck disable=SC1090
source "$LIB"

echo "== L3/L4 V6 stale-broker/AP-down reactivation owner-run: pre-gates (read-only; nothing is created or changed yet)"
sudo -v || die "sudo authentication failed"

# 1. pinned main, clean pinned worktree, same-day stage=L4 records with the exact V6 scope, stage gate (live mode)
for f in authorization-L4.txt k3-L4.txt; do
  [ -f "$AUTH_DIR/$f" ] || gate "$f missing"
  grep -qx "date=$TODAY" "$AUTH_DIR/$f" 2>/dev/null || gate "$f date is not today ($TODAY Asia/Bangkok)"
  grep -qx "stage=L4" "$AUTH_DIR/$f" 2>/dev/null || gate "$f is not stage=L4"
done
grep -qxF "scope=$EXPECTED_SCOPE" "$AUTH_DIR/authorization-L4.txt" 2>/dev/null || gate "authorization scope is not exactly the approved V6 scope"
[ ! -e "$AUTH_DIR/L34-V6-REACTIVATION-ATTEMPT-CONSUMED" ] || gate "this authorization already consumed its one bounded attempt"
[ "$(git -C "$REPO" rev-parse HEAD)" = "$EXPECTED_MAIN" ] || gate "worktree HEAD is not $EXPECTED_MAIN"
[ -z "$(git -C "$REPO" status --porcelain)" ] || gate "worktree is not clean"
git -C "$REPO" fetch -q origin 2>/dev/null && [ "$(git -C "$REPO" rev-parse origin/main)" = "$EXPECTED_MAIN" ] \
  || gate "origin/main is not $EXPECTED_MAIN (or fetch failed); not silently re-pinning"
for f in apply.sh verify.sh rollback.sh allow-keys.txt allow-listeners.txt; do [ -f "$HND/$f" ] || gate "handler file $f missing"; done
gate_out=$(TZ=Asia/Bangkok bash "$P4/p4-stage-gate.sh" --stage L4 --mode live --authorization "$AUTH_DIR/authorization-L4.txt" --k3 "$AUTH_DIR/k3-L4.txt" 2>&1) || gate "stage gate failed"
for l in AUTHORIZATION_RECORD=VALID K3_CONFIRMATION=VALID; do printf '%s\n' "$gate_out" | grep -qx "$l" || gate "stage gate did not report $l"; done

# 2. historical L3/L4 acceptance receipts at the pinned commit (kept authoritative; this run adds no acceptance claim)
l34_receipt_gate "$REPO" || gate "predecessor receipt gate failed (see reason above)"

# 3. host safety (read-only): the ONE supported V6 baseline. dnsmasq must be exactly clean-inactive and the broker exactly active/running;
#    the handler preflight (below) proves the rest (stable tuple, stale pair, absent AP address, no AP listeners, legacy :1883). This run
#    never repairs anything outside that baseline.
for c in rfkill nmcli iw ip nft sysctl systemctl ss dnsmasq timeout; do command -v "$c" >/dev/null || gate "$c missing"; done
disk_pct=$(df -P / | awk 'NR == 2 { sub("%", "", $5); print $5 }'); [ "$disk_pct" -lt 90 ] || gate "disk $disk_pct% >= 90"
for u in "$ENGINE" "$TUNNEL" twingate.service mosquitto.service; do
  [ "$(show "$u" ActiveState)" = active ] && [ "$(show "$u" SubState)" = running ] || gate "$u not active/running"
done
unit_props() { systemctl show -p LoadState -p ActiveState -p SubState -p UnitFileState -p Result -p MainPID "$1"; }
unit_props "$DNSMASQ_UNIT" | l34_v6_dnsmasq_pre_gate || gate "$(unit_props "$DNSMASQ_UNIT" | l34_v6_dnsmasq_pre_gate 2>&1 | head -n 1)"
unit_props "$BROKER_UNIT" | l34_v4_service_active_gate "$BROKER_UNIT" || gate "$(unit_props "$BROKER_UNIT" | l34_v4_service_active_gate "$BROKER_UNIT" 2>&1 | head -n 1)"
[ "$GATE_FAILED" = 0 ] || die "one or more pre-gates failed; NOTHING was created or changed"

mkdir -m 700 "$EVID"; exec > >(tee -a "$EVID/owner-run.log") 2>&1
JOURNAL_SINCE=$(date -u '+%Y-%m-%d %H:%M:%S UTC'); printf '%s\n' "$JOURNAL_SINCE" > "$EVID/journal_since.txt"
cp "$AUTH_DIR/authorization-L4.txt" "$AUTH_DIR/k3-L4.txt" "$EVID/"
{ echo "OPERATION=L3_L4_RUNTIME_REACTIVATION_V6_STALE_BROKER_AP_DOWN"; echo "REACTIVATION_TYPE=RUNTIME_ONLY"; echo "MAIN=$EXPECTED_MAIN"
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
# clock_gate POST|RB — bounded READ-ONLY wait for the existing acceptance predicate (p4-l5-clock.py state) to report exactly SYNCED/OK. Only that
# probe is run: no service is started/stopped, no NTP setting or clock is changed. An unreadable, crashing or malformed probe fails closed at once;
# a well-formed non-OK verdict is retried until the frozen bound, then fails closed. Every sample (full probe output) goes to the evidence log.
clock_gate() { local label=$1 log="$EVID/clock-stabilization-${1,,}.log" start=$SECONDS n=0 out rc why
  local ok_re='^state=SYNCED reason=OK maxerror_us=[0-9]+ adjtimex_ret=[0-9]+ status=0x[0-9a-f]+ sta_unsync=0 time_error=0$'
  local shape_re='^state=[A-Z]+ reason=[A-Z_]+ maxerror_us=-?[0-9]+ adjtimex_ret='
  while :; do
    n=$((n + 1)); rc=0; out=$("$PY" "$P4/p4-l5-clock.py" state 2>&1) || rc=$?
    printf 'ts=%s gate=%s sample=%s elapsed_s=%s rc=%s %s\n' "$(date -u +%FT%TZ)" "$label" "$n" "$((SECONDS - start))" "$rc" "$out" >> "$log"
    if [ "$rc" != 0 ] || ! [[ "$out" =~ $shape_re && "$out" != *$'\n'* ]]; then why=PROBE_MALFORMED_OR_FAILED; break; fi
    if [[ "$out" =~ $ok_re ]]; then
      echo "CLOCK_STABILIZATION_$label=PASS SAMPLES=$n WAITED_S=$((SECONDS - start))" | tee -a "$log"; return 0
    fi
    if [ "$((SECONDS - start))" -ge "$CLOCK_STAB_TIMEOUT_S" ]; then why=BOUND_EXCEEDED; break; fi
    sleep "$CLOCK_STAB_INTERVAL_S"
  done
  echo "CLOCK_STABILIZATION_$label=FAIL SAMPLES=$n REASON=$why BOUND_S=$CLOCK_STAB_TIMEOUT_S evidence=$log" | tee -a "$log"; return 1
}
handler() { local w=${2:-$WORK}
  sudo env AEGIS_L34_LIVE_AUTHORIZED=YES AEGIS_L34_WORK_DIR="$w" AEGIS_AP_INTERFACE="$AP_IF" AEGIS_L34_V6_PYTHON="$PY" AEGIS_L34_PREFLIGHT_ONLY="${AEGIS_L34_PREFLIGHT_ONLY_RUN:-NO}" bash "$HND/$1"; }
own_work() { sudo chown -R "$(id -u):$(id -g)" "$WORK" "$PREFLIGHT_WORK" 2>/dev/null || true; }
identity_now() { for u in mosquitto.service twingate.service "$ENGINE" "$TUNNEL"; do printf '%s %s/%s\n' "$u" "$(show "$u" MainPID)" "$(show "$u" NRestarts)"; done; }
IDENT_PRE=$(identity_now)
identity_unchanged() { [ "$(identity_now)" = "$IDENT_PRE" ]; }
# broker_unchanged FILE — the broker tuple right now is exactly the one the read-only handler preflight recorded
broker_unchanged() { [ "$(l34_v6_broker_tuple "$BROKER_UNIT")" = "$(cat "$1")" ]; }
rollback_flow() { trap - ERR INT TERM; [ "$ROLLED_BACK" = 0 ] || return 0; ROLLED_BACK=1; echo "== L3/L4 V6 reactivation ROLLBACK (reason: $1) — failure/abort path only"
  if sudo test -f "$WORK/production-mutation"; then
    local out; out=$(handler rollback.sh 2>&1) || { printf '%s\n' "$out"; own_work; echo "L34_V6_ROLLBACK=FAIL (S-11 HOLD) — ESCALATE; do NOT retry; the broker is never repaired by V6; inspect $EVID"; exit 3; }
    printf '%s\n' "$out"; own_work
  else echo "NO_PRODUCTION_MUTATION_MARKER: rollback handler not needed; proving zero drift instead"; fi
  clock_gate RB || { echo "RB TrustedClock did not stabilize — S-11 HOLD, ESCALATE; do NOT retry; RB capture NOT taken; inspect $EVID"; exit 3; }
  capture RB "$EVID/rb-root" || { echo "RB capture FAILED — ESCALATE"; exit 3; }
  compare "$EVID/pre-root" "$EVID/rb-root" "$EVID/compare-pre-rb.txt" && identity_unchanged && broker_unchanged "$PREFLIGHT_WORK/broker-tuple-pre.txt" \
    || { echo "PRE_RB_COMPARE=FAIL — S-11 HOLD, ESCALATE; do NOT retry"; exit 3; }
  echo "PRE_RB_COMPARE=PASS ROLLBACK_RESULT=PASS L34_V6_REACTIVATION=NOT_RESTORED. NOT retrying. Authorization is consumed."; exit 1; }
fail_after_mutation() { [ "$MUTATED" = 1 ] && rollback_flow "$1" || { echo "STOP before any mutation: $1"; exit 1; }; }
trap 'fail_after_mutation "unexpected error at line $LINENO"' ERR
trap 'fail_after_mutation "interrupted"' INT TERM

# 4. handler preflight in PREFLIGHT_ONLY mode (as root; writes only into the evidence dir; NOTHING is consumed yet)
echo "== read-only preflight through the handler"
pf_out=$(AEGIS_L34_PREFLIGHT_ONLY_RUN=YES handler apply.sh "$PREFLIGHT_WORK" 2>&1) || { printf '%s\n' "$pf_out"; own_work; die "preflight failed; NOTHING was changed and the attempt is NOT consumed"; }
printf '%s\n' "$pf_out"; own_work
printf '%s\n' "$pf_out" | grep -qx 'L34_V6_PREFLIGHT=PASS' || die "preflight did not report L34_V6_PREFLIGHT=PASS"
[ -s "$PREFLIGHT_WORK/broker-tuple-pre.txt" ] || die "preflight recorded no broker tuple"

# 5. PRE capture + hash verify (a failure here changes nothing and does NOT consume the attempt)
echo "== PRE capture (before the one bound activation)"; capture PRE "$EVID/pre-root" || die "PRE capture failed; nothing changed and the attempt is NOT consumed"

# 6. final broker tuple equality: the broker is byte-for-byte the one the preflight saw, across the whole PRE capture
broker_unchanged "$PREFLIGHT_WORK/broker-tuple-pre.txt" || die "broker tuple changed between preflight and PRE capture; nothing changed and the attempt is NOT consumed"

# 7. the bounded attempt is consumed here, atomically: a second invocation for this AUTH_DIR is refused, even after a failure
( set -o noclobber; printf 'consumed_at=%s\n' "$(date -u +%FT%TZ)" > "$MARKER" ) 2>/dev/null \
  || die "could not consume the one-attempt marker"

echo "== L3/L4 V6 reactivation APPLY (once; the handler repeats the full preflight, then writes the production-mutation marker, then mutates)"; MUTATED=1
apply_rc=0; apply_out=$(handler apply.sh 2>&1) || apply_rc=$?; printf '%s\n' "$apply_out"; own_work
{ [ "$apply_rc" = 0 ] && printf '%s\n' "$apply_out" | grep -qx 'L34_V6_APPLY=PASS'; } || rollback_flow "L34_V6_APPLY failed (rc=$apply_rc)"
cmp -s "$PREFLIGHT_WORK/broker-tuple-pre.txt" "$WORK/broker-tuple-pre.txt" || rollback_flow "broker tuple differs between the runner preflight and the apply preflight"
echo "== VERIFY (single checks, then the frozen 6 x 5 s soak)"
ver_rc=0; ver_out=$(handler verify.sh 2>&1) || ver_rc=$?; printf '%s\n' "$ver_out"; own_work
{ [ "$ver_rc" = 0 ] && printf '%s\n' "$ver_out" | grep -qx 'L34_V6_VERIFY=PASS' && printf '%s\n' "$ver_out" | grep -qx 'L34_V6_SOAK=PASS SAMPLES=6 INTERVAL_S=5'; } \
  || rollback_flow "L34_V6_VERIFY failed"
echo "== TrustedClock stabilization (read-only, bounded) before POST capture"; clock_gate POST || rollback_flow "TrustedClock did not stabilize before POST capture"
echo "== POST capture"; capture POST "$EVID/post-root" || rollback_flow "POST capture failed"
echo "== PRE -> POST compare (exact reactivation window only)"; compare "$EVID/pre-root" "$EVID/post-root" "$EVID/compare-pre-post.txt" || rollback_flow "PRE->POST compare failed"
identity_unchanged || rollback_flow "legacy mosquitto/Twingate/IDEA2 identity changed"
broker_unchanged "$PREFLIGHT_WORK/broker-tuple-pre.txt" || rollback_flow "broker tuple changed by the end of the run"
trap - ERR INT TERM
echo "L34_V6_REACTIVATION_EXECUTED=YES L34_V6_APPLY=PASS L34_V6_VERIFY=PASS L34_V6_SOAK=PASS L34_V6_POST_CAPTURE=COMPLETE L34_V6_PRE_POST_COMPARE=PASS"
echo "L3_L4_RUNTIME_REACTIVATION_V6=PASS (RUNTIME_ONLY, stale-broker/AP-down). NO new L3_LIVE_ACCEPTANCE / L4_LIVE_ACCEPTANCE / L6B_LIVE_ACCEPTANCE claim. PERSISTENT_FILES_REWRITTEN=NO. BROKER_CONTROL_COMMAND_ISSUED=NO (broker tuple equals PRE)."
echo "K12_AUTOMATIC_REBOOT_PERSISTENCE=NOT_PROVEN. No ESP32, no L7, no MQTT command. Evidence: $EVID"
