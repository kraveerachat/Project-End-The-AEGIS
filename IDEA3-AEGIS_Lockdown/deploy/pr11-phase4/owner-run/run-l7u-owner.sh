#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — L7u (POST-L7 RECOVERY CORE UPGRADE) LIVE window, ONE owner-supervised attempt. OWNER-RUN ONLY.
# REPOSITORY TEMPLATE: EXPECTED_MAIN, OLD_RELEASE_ID, NEW_RELEASE_ID and ALERT_SOURCE_UID are unpinned, so this file REFUSES TO RUN as committed. The
# owner freeze workflow copies it OUTSIDE the repository, replaces the four PIN_ values (merged main SHA, the running release, the new release id,
# and the owner-frozen numeric uid of the dedicated account aegis-idea3-detector), records the frozen file's SHA-256, and only then authorizes a
# run. Nothing in this repository executes it. No real uid is committed here and this template authorizes nothing (OD-F1-DEPLOY-01).
# Design: docs/superpowers/specs/2026-10-01-idea3-pr11-phase4-l7u-post-l7-recovery-core-upgrade.md.
# Usage (the operator, NOT root):  bash run-l7u-owner.sh <AUTH_DIR>     AUTH_DIR holds authorization-L7u.txt and k3-L7u.txt (same-day, stage=L7u)
# Stage order: L7 -> L7u -> Recovery R1-R8 -> LVR -> L8. L7u does NOT prove Recovery R1-R8, does NOT prove LVR and does NOT authorize L8.
# It moves the running Core onto a NEW immutable release and provisions the Recovery transport surface AND the dedicated F1 alert surface (group
# aegis-idea3-alert, /run/aegis-idea3-alert, AEGIS_ALERT_SOURCE_UID, Core supplementary group) inside the SAME ONE Core restart; it NEVER starts the
# F1 detector (activated later by the F1 package, after the Core alert socket was verified here). It is PERSISTENT on success and rolls back ONLY
# on failure/abort. It never runs Recovery, never sends CUT/RESTORE, never touches an ESP32/serial device, never starts L8, never
# repairs a predecessor, never modifies IDEA1/IDEA2, Twingate, legacy mosquitto, the L6b broker, NetworkManager, nftables, forwarding or
# TrustedClock, never creates a secret, and has NO automatic second attempt: one attempt per authorization.
set -Eeuo pipefail
umask 077

EXPECTED_MAIN=PIN_MAIN_SHA
OLD_RELEASE_ID=PIN_OLD_RELEASE_ID
NEW_RELEASE_ID=PIN_NEW_RELEASE_ID
ALERT_SOURCE_UID=PIN_ALERT_SOURCE_UID
case "$EXPECTED_MAIN" in PIN_*) echo "STOP: runner is not pinned (EXPECTED_MAIN). Run the owner freeze workflow first."; exit 2 ;; esac
[[ "$EXPECTED_MAIN" =~ ^[0-9a-f]{40}$ ]] || { echo "STOP: EXPECTED_MAIN is not a 40-hex SHA."; exit 2; }
case "$OLD_RELEASE_ID" in PIN_*) echo "STOP: runner is not pinned (OLD_RELEASE_ID). Run the owner freeze workflow first."; exit 2 ;; esac
case "$NEW_RELEASE_ID" in PIN_*) echo "STOP: runner is not pinned (NEW_RELEASE_ID). Run the owner freeze workflow first."; exit 2 ;; esac
case "$ALERT_SOURCE_UID" in PIN_*) echo "STOP: runner is not pinned (ALERT_SOURCE_UID). Run the owner freeze workflow first."; exit 2 ;; esac
[[ "$ALERT_SOURCE_UID" =~ ^[1-9][0-9]{0,9}$ ]] && [ "$ALERT_SOURCE_UID" -le 4294967294 ] || { echo "STOP: ALERT_SOURCE_UID is not a canonical non-root decimal uid."; exit 2; }
for id in "$OLD_RELEASE_ID" "$NEW_RELEASE_ID"; do
  [[ "$id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || { echo "STOP: a release id is not valid."; exit 2; }
done
[ "$OLD_RELEASE_ID" != "$NEW_RELEASE_ID" ] || { echo "STOP: old and new release ids are identical."; exit 2; }
[ "$(id -u)" != 0 ] || { echo "Run as your normal user, not root."; exit 2; }
AUTH_DIR=${1:-}
[ -n "$AUTH_DIR" ] && [ -d "$AUTH_DIR" ] || { echo "usage: bash $0 <AUTH_DIR with authorization-L7u.txt and k3-L7u.txt>"; exit 2; }

# ---- frozen inputs -----------------------------------------------------------------------------------------------------
REPO=/home/kittipat/Workspace/IDEA3-Cyber-Last/worktrees/Project-End-The-AEGIS-L7ULIVE   # clean pinned execution worktree at merged main
WHEELHOUSE=/home/kittipat/Workspace/idea3-p4-evidence/l7u-wheelhouse
PY=/home/kittipat/.venvs/aegis-idea3-core/bin/python
APP=$REPO/IDEA3-AEGIS_Lockdown
P4=$APP/deploy/pr11-phase4
STG=$P4/stages/L7u
ROLLBACK_ALLOW=$STG/allow-keys-rollback.txt
LIB=$P4/p4-l7u-run-lib.sh
OPERATOR_USER=kittipat
OPERATOR_UID=1000
DETECTOR_ACCOUNT=aegis-idea3-detector   # exact account name (never an input); the frozen uid must be exactly this account's uid
CORE_ACCOUNT=aegis-idea3
AP_IF=wlp0s20f3
AP_ADDR=10.77.30.1
TODAY=$(TZ=Asia/Bangkok date +%F)
STAMP=$(TZ=Asia/Bangkok date +%Y%m%d-%H%M%S)
EVID=/home/kittipat/Workspace/idea3-p4-evidence/$TODAY-l7u-$STAMP
BUILD_ROOT=/home/kittipat/Workspace/idea3-p4-evidence/$TODAY-l7u-build-$STAMP
SOURCE_DIR=$BUILD_ROOT/$NEW_RELEASE_ID
WORK=$EVID/l7u-work
ENGINE=aegis-detection-engine.service; TUNNEL=aegis-detection-tunnel.service
UNIT=aegis-idea3-core.service
BROKER_UNIT=aegis-idea3-mosquitto.service

die() { echo "STOP: $*" >&2; exit 1; }
GATE_FAILED=0; gate() { echo "GATE_FAIL: $*" >&2; GATE_FAILED=1; }
show() { systemctl show -p "$2" --value "$1"; }

[ -f "$LIB" ] || die "gate library missing: $LIB (is $REPO at the pinned main?)"
# shellcheck disable=SC1090
source "$LIB"

echo "== L7u owner-run: pre-gates (read-only; nothing is created or changed yet)"
sudo -v || die "sudo authentication failed"

# 1. operator identity, pinned main, clean pinned worktree, same-day records, stage gate (live mode)
l7u_alert_identity_gate "$DETECTOR_ACCOUNT" "$ALERT_SOURCE_UID" "$CORE_ACCOUNT" "$OPERATOR_UID" || gate "alert source identity is not the frozen dedicated account (see reason above)"
l7u_identity_gate "$OPERATOR_USER" "$OPERATOR_UID" || gate "operator identity is not the frozen Recovery operator (see reason above)"
for f in authorization-L7u.txt k3-L7u.txt; do
  [ -f "$AUTH_DIR/$f" ] || gate "$f missing"
  grep -qx "date=$TODAY" "$AUTH_DIR/$f" 2>/dev/null || gate "$f date is not today ($TODAY Asia/Bangkok)"
  grep -qx "stage=L7u" "$AUTH_DIR/$f" 2>/dev/null || gate "$f is not stage=L7u"
done
l7u_attempt_unconsumed "$AUTH_DIR" || gate "this authorization already consumed its one live attempt"
[ "$(git -C "$REPO" rev-parse HEAD)" = "$EXPECTED_MAIN" ] || gate "worktree HEAD is not $EXPECTED_MAIN"
[ -z "$(git -C "$REPO" status --porcelain)" ] || gate "worktree is not clean"
git -C "$REPO" fetch -q origin 2>/dev/null && [ "$(git -C "$REPO" rev-parse origin/main)" = "$EXPECTED_MAIN" ] \
  || gate "origin/main is not $EXPECTED_MAIN (or fetch failed); not silently re-pinning"
for f in apply.sh verify.sh rollback.sh allow-keys.txt allow-listeners.txt; do [ -f "$STG/$f" ] || gate "handler file $f missing"; done
[ -f "$ROLLBACK_ALLOW" ] || gate "rollback allow file missing"
gate_out=$(TZ=Asia/Bangkok bash "$P4/p4-stage-gate.sh" --stage L7u --mode live --authorization "$AUTH_DIR/authorization-L7u.txt" --k3 "$AUTH_DIR/k3-L7u.txt" 2>&1) || gate "stage gate failed"
for l in AUTHORIZATION_RECORD=VALID K3_CONFIRMATION=VALID ROLLBACK_HANDLER=REGISTERED; do printf '%s\n' "$gate_out" | grep -qx "$l" || gate "stage gate did not report $l"; done

# 2. predecessor ACCEPTANCE (historical, from the pinned commit) incl. L7; refuses if L7u is already recorded as accepted
l7u_receipt_gate "$REPO" || gate "receipt gate failed (see reason above)"

# 3. tools / pinned python
for c in systemctl groupadd groupdel gpasswd systemd-tmpfiles getent ss ip git; do command -v "$c" >/dev/null || gate "$c missing"; done
[ -d "$WHEELHOUSE" ] || gate "wheelhouse missing: $WHEELHOUSE"
[ ! -e "$BUILD_ROOT" ] || gate "$BUILD_ROOT already exists"

# 4. CURRENT runtime (fresh proof; never repaired here): the OLD Core runs, IDEA2 §10 holds, host safety, broker + legacy services untouched
l7u_core_running_gate "$UNIT" || gate "the running Core is not the exact old baseline (see reason above)"
l7_disk_gate 80 / /var /opt /run || gate "disk headroom below 20% free (see reason above)"
l7_idea2_s10_gate "$ENGINE" "$TUNNEL" || gate "IDEA2 §10 fresh preservation precondition failed (see reason above)"
for u in twingate.service mosquitto.service "$BROKER_UNIT"; do [ "$(show "$u" ActiveState)" = active ] && [ "$(show "$u" SubState)" = running ] || gate "$u not active/running"; done
for k in net.ipv4.ip_forward net.ipv4.conf.all.forwarding net.ipv6.conf.all.forwarding; do [ "$(sysctl -n $k)" = 0 ] || gate "$k is not 0"; done

# 5. the new immutable release is BUILT from the pinned main by the existing deterministic builder (user-owned staging; no host mutation) and
#    the engine's read-only preflight proves both releases with the real guard, the exact current pointer, the identity/group state and core.env
if [ "$GATE_FAILED" = 0 ]; then
  mkdir -m 700 "$BUILD_ROOT"
  "$PY" "$P4/p4-l7-build-release.py" build --source-root "$REPO" --staging-root "$BUILD_ROOT" --release-id "$NEW_RELEASE_ID" --wheelhouse "$WHEELHOUSE" >/dev/null \
    || gate "release build failed"
  [ -d "$SOURCE_DIR" ] || gate "built release directory missing"
fi
if [ "$GATE_FAILED" = 0 ]; then
  sudo "$PY" "$P4/p4-l7u-upgrade.py" preflight --old-release-id "$OLD_RELEASE_ID" --new-release-id "$NEW_RELEASE_ID" --expected-main "$EXPECTED_MAIN" \
    --source-dir "$SOURCE_DIR" --work-dir "$WORK" --operator-user "$OPERATOR_USER" --operator-uid "$OPERATOR_UID" --alert-source-uid "$ALERT_SOURCE_UID" >/dev/null \
    || gate "engine preflight failed (see reason above; NOTHING was consumed)"
fi
[ ! -e "$EVID" ] || gate "$EVID already exists"
[ "$GATE_FAILED" = 0 ] || die "one or more pre-gates failed; NOTHING was created or changed on the host"

snap() { printf '%s/%s\n' "$(show "$1" MainPID)" "$(show "$1" NRestarts)"; }
ENGINE_PRE=$(snap $ENGINE); TUNNEL_PRE=$(snap $TUNNEL); TG_PRE=$(snap twingate.service); MQ_PRE=$(snap mosquitto.service); BROKER_PRE=$(snap $BROKER_UNIT)
L1883_PRE=$(ss -ltnH | awk '$4 ~ /:1883$/ {print $4}' | LC_ALL=C sort -u); L8883_PRE=$(ss -ltnH | awk '$4 ~ /:8883$/ {print $4}' | LC_ALL=C sort -u)

mkdir -m 700 "$EVID"; exec > >(tee -a "$EVID/owner-run.log") 2>&1
JOURNAL_SINCE=$(date -u '+%Y-%m-%d %H:%M:%S UTC'); printf '%s\n' "$JOURNAL_SINCE" > "$EVID/journal_since.txt"
cp "$AUTH_DIR/authorization-L7u.txt" "$AUTH_DIR/k3-L7u.txt" "$EVID/"
printf 'stage L7u\nrelease_id %s\n' "$NEW_RELEASE_ID" > "$EVID/release-allow.txt"
{ echo "MAIN=$EXPECTED_MAIN"; echo "OLD_RELEASE=$OLD_RELEASE_ID"; echo "NEW_RELEASE=$NEW_RELEASE_ID"; echo "OPERATOR=$OPERATOR_USER/$OPERATOR_UID"
  echo "ALERT_SOURCE=$DETECTOR_ACCOUNT/$ALERT_SOURCE_UID"
  echo "RUNNER_SHA256=$(sha256sum "$0" | cut -d' ' -f1)"; } > "$EVID/frozen-inputs.txt"
echo "EVIDENCE_ROOT=$EVID MAIN=$EXPECTED_MAIN OLD=$OLD_RELEASE_ID NEW=$NEW_RELEASE_ID"

MUTATED=0; ROLLED_BACK=0
capture() { sudo env EVID_DIR="$2" CAPTURE_LABEL="${1,,}" JOURNAL_SINCE="$JOURNAL_SINCE" bash "$P4/p4-l0-capture.sh" || return 1
  sudo grep -q 'L0_CAPTURE=COMPLETE' "$2/capture.log" || return 1; sudo bash -c "cd '$2' && sha256sum -c --quiet --strict SHA256SUMS" || return 1; echo "CAPTURE_$1=COMPLETE SHA256=PASS"; }
compare() { local allow=() rc=0
  case "${4:-}" in
    post) allow=(ALLOW_KEYS_FILE="$STG/allow-keys.txt" ALLOW_LISTENERS_FILE="$STG/allow-listeners.txt" ALLOW_L6C_RELEASE_FILE="$EVID/release-allow.txt") ;;
    rb) allow=(ALLOW_KEYS_FILE="$ROLLBACK_ALLOW") ;;
  esac
  sudo env DISK_THRESHOLD_PCT=90 AEGIS_AP_INTERFACE="$AP_IF" AEGIS_AP_ADDRESS="$AP_ADDR" "${allow[@]}" bash "$P4/p4-compare.sh" "$1" "$2" > "$3" 2>&1 || rc=$?
  grep -E '^(FINDING|FINDINGS_|PRESERVATION_S10|COMPARE_RESULT)' "$3" || true; [ "$rc" = 0 ] || return 1
  for l in FINDINGS_NEW_OR_WORSENED_DRIFT=0 FINDINGS_BASELINE_UNHEALTHY_BUT_UNCHANGED=0 FINDINGS_INCOMPARABLE=0 PRESERVATION_S10=PASS COMPARE_RESULT=PASS; do grep -qx "$l" "$3" || { echo "COMPARE_REQUIREMENT_FAILED: $l"; return 1; }; done; }
handler() { sudo env AEGIS_L7U_LIVE_AUTHORIZED=YES AEGIS_L7U_WORK_DIR="$WORK" AEGIS_L7U_SOURCE_DIR="$SOURCE_DIR" AEGIS_L7U_OLD_RELEASE_ID="$OLD_RELEASE_ID" \
  AEGIS_L7U_NEW_RELEASE_ID="$NEW_RELEASE_ID" AEGIS_L7U_EXPECTED_MAIN="$EXPECTED_MAIN" AEGIS_L7U_OPERATOR_USER="$OPERATOR_USER" AEGIS_L7U_OPERATOR_UID="$OPERATOR_UID" \
  AEGIS_L7U_ALERT_SOURCE_UID="$ALERT_SOURCE_UID" AEGIS_PYTHON_BIN="$PY" bash "$STG/$1"; }
own_work() { sudo chown -R "$(id -u):$(id -g)" "$WORK" 2>/dev/null || true; }
s10_unchanged() { [ "$(snap $ENGINE)" = "$ENGINE_PRE" ] && [ "$(snap $TUNNEL)" = "$TUNNEL_PRE" ] && [ "$(snap twingate.service)" = "$TG_PRE" ] \
  && [ "$(snap mosquitto.service)" = "$MQ_PRE" ] && [ "$(snap $BROKER_UNIT)" = "$BROKER_PRE" ] \
  && [ "$(ss -ltnH | awk '$4 ~ /:1883$/ {print $4}' | LC_ALL=C sort -u)" = "$L1883_PRE" ] && [ "$(ss -ltnH | awk '$4 ~ /:8883$/ {print $4}' | LC_ALL=C sort -u)" = "$L8883_PRE" ]; }
rollback_flow() { trap - ERR INT TERM; [ "$ROLLED_BACK" = 0 ] || return 0; ROLLED_BACK=1; echo "== L7u ROLLBACK (reason: $1) — failure/abort path only"
  if sudo test -f "$WORK/production-mutation"; then
    local out; out=$(handler rollback.sh 2>&1) || { printf '%s\n' "$out"; own_work; echo "L7U_ROLLBACK=FAIL (S-11 HOLD) — ESCALATE; do NOT retry; inspect $EVID"; exit 3; }
    printf '%s\n' "$out"; own_work
  else echo "NO_PRODUCTION_MUTATION_MARKER: rollback handler not needed; proving zero drift instead"; fi
  capture RB "$EVID/rb-root" || { echo "RB capture FAILED — ESCALATE"; exit 3; }
  compare "$EVID/pre-root" "$EVID/rb-root" "$EVID/compare-pre-rb.txt" rb && s10_unchanged || { echo "PRE_RB_COMPARE=FAIL — ESCALATE; do NOT retry"; exit 3; }
  echo "PRE_RB_COMPARE=PASS ROLLBACK_RESULT=PASS L7U_LIVE_ACCEPTANCE=NOT_PROVEN. NOT retrying. Authorization is consumed."; exit 1; }
fail_after_mutation() { [ "$MUTATED" = 1 ] && rollback_flow "$1" || { echo "STOP before any mutation: $1"; exit 1; }; }
trap 'fail_after_mutation "unexpected error at line $LINENO"' ERR
trap 'fail_after_mutation "interrupted"' INT TERM

echo "== PRE evidence (read-only; BEFORE the attempt is consumed and before any L7u-owned change)"
capture PRE "$EVID/pre-root" || die "PRE capture failed; nothing changed and nothing consumed"

# 6. authorization is consumed here (one attempt): from this point a second invocation for this AUTH_DIR is refused
l7u_consume_attempt "$AUTH_DIR" || die "could not consume the one-attempt marker"

echo "== L7u APPLY (once; release install, groups + membership, core.env append, drop-ins, tmpfiles, runtime dirs, reload, atomic switch, ONE Core restart; the detector is NOT started)"; MUTATED=1
apply_rc=0; apply_out=$(handler apply.sh 2>&1) || apply_rc=$?; printf '%s\n' "$apply_out"; own_work
{ [ "$apply_rc" = 0 ] && printf '%s\n' "$apply_out" | grep -qx 'L7U_APPLY=PASS'; } || rollback_flow "L7U_APPLY failed (rc=$apply_rc)"
echo "== L7u VERIFY (pointer, releases, core.env, drop-in, tmpfiles, group, runtime dir, socket, Core health, process group)"
ver_rc=0; ver_out=$(handler verify.sh 2>&1) || ver_rc=$?; printf '%s\n' "$ver_out"; own_work
{ [ "$ver_rc" = 0 ] && printf '%s\n' "$ver_out" | grep -qx 'L7U_VERIFY=PASS' && printf '%s\n' "$ver_out" | grep -qx 'L7U_RECOVERY_CHANNEL=PRESENT' && printf '%s\n' "$ver_out" | grep -qx 'L7U_ALERT_CHANNEL=PRESENT'; } || rollback_flow "L7U_VERIFY failed"
echo "== POST capture"; capture POST "$EVID/post-root" || rollback_flow "POST capture failed"
echo "== PRE -> POST compare (approved exact L7u delta only)"; compare "$EVID/pre-root" "$EVID/post-root" "$EVID/compare-pre-post.txt" post || rollback_flow "PRE->POST compare failed"
echo "== exact-value delta proof"; "$PY" "$P4/p4-l7u-upgrade.py" delta --old-release-id "$OLD_RELEASE_ID" --new-release-id "$NEW_RELEASE_ID" --expected-main "$EXPECTED_MAIN" \
  --source-dir "$SOURCE_DIR" --work-dir "$WORK" --operator-user "$OPERATOR_USER" --operator-uid "$OPERATOR_UID" --alert-source-uid "$ALERT_SOURCE_UID" --pre-dir "$EVID/pre-root" --post-dir "$EVID/post-root" \
  || rollback_flow "exact-value delta proof failed"
l7u_secret_scan "$EVID" "$PY" || rollback_flow "SECRET_OUTPUT_SCAN failed"
s10_unchanged || rollback_flow "S10/legacy mosquitto/Twingate/L6b broker preservation failed"
[ "$(show "$UNIT" ActiveState)" = active ] && [ "$(show "$UNIT" UnitFileState)" = enabled ] || rollback_flow "IDEA3 Core not active+enabled at closeout"
[ "$(show "$BROKER_UNIT" ActiveState)" = active ] || rollback_flow "L6b broker not active at closeout"
trap - ERR INT TERM
echo "L7U_LIVE_EXECUTED=YES L7U_APPLY=PASS L7U_VERIFY=PASS L7U_POST_CAPTURE=COMPLETE L7U_PRE_POST_COMPARE=PASS L7U_DELTA=PASS L7U_S10_PRESERVATION=PASS"
echo "L7U_LIVE_ACCEPTANCE=PROVEN (this run only). PERSISTENT: $UNIT runs release $NEW_RELEASE_ID with the Recovery transport surface provisioned."
echo "RECOVERY_R1_R8_PROVEN=NO LVR_PROVEN=NO L8_AUTHORIZED=NO L8_STARTED=NO ESP32_TOUCHED=NO RECOVERY_LIVE_EXECUTED=NO"
echo "L7U_CORE_RESTART_COUNT=ONE L7U_STARTS_DETECTOR=NO F1_DETECTOR_STARTED=NO (the F1 package starts it later, only after this stage verified the Core alert socket)"
echo "L7U_OPERATOR_SESSION_NOTE=the new group membership applies to NEW login sessions only (re-login or newgrp); an existing shell does not have it yet."
echo "Evidence: $EVID"
