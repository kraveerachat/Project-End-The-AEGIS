#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — L6c LIVE "Immutable Release Install", ONE owner-supervised attempt. OWNER-RUN ONLY.
# REPOSITORY TEMPLATE: EXPECTED_MAIN, RELEASE_ID and EXPECTED_SOURCE_SHA are unpinned, so this file REFUSES TO RUN as
# committed. The owner freeze workflow copies it OUTSIDE the repository (e.g. ~/Workspace/idea3-p4-evidence/l6c-owner-run/),
# replaces PIN_MAIN_SHA with the merged main SHA, PIN_RELEASE_ID with the exact release id to install, and PIN_SOURCE_SHA
# with the exact source git SHA the builder output must have been built from; records the frozen file's SHA-256; and only
# then authorizes a run. Design: docs/superpowers/specs/2026-09-27-idea3-pr11-phase4-l6c-release-install-governance.md.
# Usage (normal user, NOT root):  bash run-l6c-owner.sh <AUTH_DIR>     AUTH_DIR holds authorization-L6c.txt and k3-L6c.txt
# L6c is PERSISTENT on success (the immutable release stays installed). It rolls back ONLY on failure/abort. It NEVER
# invokes L7 apply, creates A-L7, uses L7 input, creates a credential or core.env, touches /opt/aegis-idea3/current,
# installs/starts/enables the Core unit, touches an ESP32, sends a command, repairs L6b, restarts Twingate, or modifies
# IDEA1/IDEA2. NO automatic retry; one attempt per authorization. A-L6c and its K3 are consumed here and never satisfy or
# substitute for A-L7 or a fresh L7 K3.
set -Eeuo pipefail
umask 077

EXPECTED_MAIN=PIN_MAIN_SHA
RELEASE_ID=PIN_RELEASE_ID
EXPECTED_SOURCE_SHA=PIN_SOURCE_SHA
case "$EXPECTED_MAIN" in PIN_*) echo "STOP: runner is not pinned (EXPECTED_MAIN). Run the owner freeze workflow first."; exit 2 ;; esac
[[ "$EXPECTED_MAIN" =~ ^[0-9a-f]{40}$ ]] || { echo "STOP: EXPECTED_MAIN is not a 40-hex SHA."; exit 2; }
case "$RELEASE_ID" in PIN_*) echo "STOP: runner is not pinned (RELEASE_ID). Run the owner freeze workflow first."; exit 2 ;; esac
[[ "$RELEASE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || { echo "STOP: RELEASE_ID is not a valid release id."; exit 2; }
case "$EXPECTED_SOURCE_SHA" in PIN_*) echo "STOP: runner is not pinned (EXPECTED_SOURCE_SHA). Run the owner freeze workflow first."; exit 2 ;; esac
[[ "$EXPECTED_SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "STOP: EXPECTED_SOURCE_SHA is not a 40-hex SHA."; exit 2; }
[ "$(id -u)" != 0 ] || { echo "Run as your normal user, not root."; exit 2; }
AUTH_DIR=${1:-}
[ -n "$AUTH_DIR" ] && [ -d "$AUTH_DIR" ] || { echo "usage: bash $0 <AUTH_DIR with authorization-L6c.txt and k3-L6c.txt>"; exit 2; }

# ---- frozen inputs -----------------------------------------------------------------------------------------------------
REPO=/home/kittipat/Workspace/IDEA3-Cyber-Last/worktrees/Project-End-The-AEGIS-L6CLIVE   # clean pinned execution worktree at merged main
SOURCE_DIR=/home/kittipat/Workspace/idea3-p4-evidence/l6c-owner-source/$RELEASE_ID        # completed builder output (user-owned)
PY=/home/kittipat/.venvs/aegis-idea3-core/bin/python
APP=$REPO/IDEA3-AEGIS_Lockdown
P4=$APP/deploy/pr11-phase4
STG=$P4/stages/L6c
LIB=$P4/p4-l6c-run-lib.sh
CLOCK=$P4/p4-l5-clock.py
AP_IF=wlp0s20f3
AP_ADDR=10.77.30.1
BROKER_UNIT=aegis-idea3-mosquitto.service
TODAY=$(TZ=Asia/Bangkok date +%F)
STAMP=$(TZ=Asia/Bangkok date +%Y%m%d-%H%M%S)
EVID=/home/kittipat/Workspace/idea3-p4-evidence/$TODAY-l6c-$STAMP
WORK=$EVID/l6c-work
ENGINE=aegis-detection-engine.service; TUNNEL=aegis-detection-tunnel.service
LEGACY_UNIT=mosquitto.service

die() { echo "STOP: $*" >&2; exit 1; }
GATE_FAILED=0; gate() { echo "GATE_FAIL: $*" >&2; GATE_FAILED=1; }
show() { systemctl show -p "$2" --value "$1"; }
listen_now() { ss -ltnH | awk '{print $4}'; }

[ -f "$LIB" ] || die "gate library missing: $LIB (is $REPO at the pinned main?)"
# shellcheck disable=SC1090
source "$LIB"

echo "== L6c owner-run: pre-gates (read-only; nothing is created or changed yet)"
sudo -v || die "sudo authentication failed"

# 1. pinned main, clean pinned worktree, same-day records, stage gate (live mode). No d6_notice, no recovery_authorization:
# L6c installs code only.
for f in authorization-L6c.txt k3-L6c.txt; do
  [ -f "$AUTH_DIR/$f" ] || gate "$f missing"
  grep -qx "date=$TODAY" "$AUTH_DIR/$f" 2>/dev/null || gate "$f date is not today ($TODAY Asia/Bangkok)"
  grep -qx "stage=L6c" "$AUTH_DIR/$f" 2>/dev/null || gate "$f is not stage=L6c"
done
[ ! -e "$AUTH_DIR/L6C-ATTEMPT-CONSUMED" ] || gate "this authorization already consumed its one live attempt"
[ "$(git -C "$REPO" rev-parse HEAD)" = "$EXPECTED_MAIN" ] || gate "worktree HEAD is not $EXPECTED_MAIN"
[ -z "$(git -C "$REPO" status --porcelain)" ] || gate "worktree is not clean"
git -C "$REPO" fetch -q origin 2>/dev/null && [ "$(git -C "$REPO" rev-parse origin/main)" = "$EXPECTED_MAIN" ] \
  || gate "origin/main is not $EXPECTED_MAIN (or fetch failed); not silently re-pinning"
for f in apply.sh verify.sh rollback.sh allow-keys.txt allow-listeners.txt; do [ -f "$STG/$f" ] || gate "handler file $f missing"; done
gate_out=$(TZ=Asia/Bangkok bash "$P4/p4-stage-gate.sh" --stage L6c --mode live --authorization "$AUTH_DIR/authorization-L6c.txt" --k3 "$AUTH_DIR/k3-L6c.txt" 2>&1) || gate "stage gate failed"
for l in AUTHORIZATION_RECORD=VALID K3_CONFIRMATION=VALID ROLLBACK_HANDLER=REGISTERED; do printf '%s\n' "$gate_out" | grep -qx "$l" || gate "stage gate did not report $l"; done

# 2. predecessor ACCEPTANCE (historical) L2..L6b from receipts at the pinned commit. L6c does not require or touch A-L7.
l6c_receipt_gate "$REPO" || gate "predecessor receipt gate failed (see reason above)"

# 3. the persistent L6b broker must be healthy (read-only; never repaired here)
l7_broker_runtime_gate "$BROKER_UNIT" "$AP_ADDR" || gate "persistent L6b broker gate failed (see reason above; PREDECESSOR_RUNTIME_REACTIVATION_REQUIRED is a separate owner action)"

# 4. the builder output must already exist, pass the real release guard, and be built from a commit on the pinned main,
# and its source sha must equal the exact pinned expectation (defense in depth beyond "on main").
[ -d "$SOURCE_DIR" ] && [ ! -L "$SOURCE_DIR" ] || gate "builder output source is missing: $SOURCE_DIR"
source_out=$(l6c_release_source_gate "$SOURCE_DIR" "$RELEASE_ID" "$EXPECTED_MAIN" "$PY" "$P4" "$REPO" 2>&1) || gate "release source gate failed: $source_out"
SEEN_SOURCE_SHA=$(sed -n 's/L6C_SOURCE_SHA=//p' <<< "$source_out")
[ "$SEEN_SOURCE_SHA" = "$EXPECTED_SOURCE_SHA" ] || gate "builder output source sha ($SEEN_SOURCE_SHA) does not match the pinned EXPECTED_SOURCE_SHA"

# 5. the target immutable release must be absent
l6c_target_absent_gate "$RELEASE_ID" || gate "target release already exists (see reason above; NOTHING was consumed)"
[ ! -e "$EVID" ] || gate "$EVID already exists"

# 6. host safety, IDEA2 §10 fresh precondition (all BEFORE the authorization is consumed)
l7_disk_gate 80 / /opt || gate "disk headroom below 20% free on / or /opt (see reason above)"
l7_idea2_s10_gate "$ENGINE" "$TUNNEL" || gate "IDEA2 §10 fresh preservation precondition failed (see reason above)"
for u in twingate.service mosquitto.service; do [ "$(show "$u" ActiveState)" = active ] && [ "$(show "$u" SubState)" = running ] || gate "$u not active/running"; done
listen_now | grep -qx '0.0.0.0:1883' || gate "legacy 1883 wildcard listener not present (expected legacy broker state)"
[ "$GATE_FAILED" = 0 ] || die "one or more pre-gates failed; NOTHING was created or changed"

# 7. authorization is consumed here (one attempt): from this point a second invocation for this AUTH_DIR is refused
l6c_consume_attempt "$AUTH_DIR" || die "could not consume the one-attempt marker"

snap() { printf '%s/%s\n' "$(show "$1" MainPID)" "$(show "$1" NRestarts)"; }
ENGINE_PRE=$(snap $ENGINE); TUNNEL_PRE=$(snap $TUNNEL); TG_PRE=$(snap twingate.service); MQ_PRE=$(snap mosquitto.service); BROKER_PRE=$(snap $BROKER_UNIT)
L1883_PRE=$(ss -ltnH | awk '$4 ~ /:1883$/ {print $4}' | LC_ALL=C sort -u); L8883_PRE=$(ss -ltnH | awk '$4 ~ /:8883$/ {print $4}' | LC_ALL=C sort -u)

mkdir -m 700 "$EVID"; exec > >(tee -a "$EVID/owner-run.log") 2>&1
JOURNAL_SINCE=$(date -u '+%Y-%m-%d %H:%M:%S UTC'); printf '%s\n' "$JOURNAL_SINCE" > "$EVID/journal_since.txt"
cp "$AUTH_DIR/authorization-L6c.txt" "$AUTH_DIR/k3-L6c.txt" "$EVID/"
{ echo "MAIN=$EXPECTED_MAIN"; echo "RELEASE=$RELEASE_ID"; echo "SOURCE_SHA=$EXPECTED_SOURCE_SHA"
  echo "RUNNER_SHA256=$(sha256sum "$0" | cut -d' ' -f1)"; } > "$EVID/frozen-inputs.txt"
echo "EVIDENCE_ROOT=$EVID MAIN=$EXPECTED_MAIN RELEASE=$RELEASE_ID SOURCE_SHA=$EXPECTED_SOURCE_SHA"

RELEASE_FILE="$WORK-allow-l6c-release.txt"
MUTATED=0; ROLLED_BACK=0
capture() { sudo env EVID_DIR="$2" CAPTURE_LABEL="${1,,}" JOURNAL_SINCE="$JOURNAL_SINCE" bash "$P4/p4-l0-capture.sh" || return 1
  sudo grep -q 'L0_CAPTURE=COMPLETE' "$2/capture.log" || return 1; sudo bash -c "cd '$2' && sha256sum -c --quiet --strict SHA256SUMS" || return 1; echo "CAPTURE_$1=COMPLETE SHA256=PASS"; }
compare() { local allow=(); [ "${4:-}" = allow ] && allow=(ALLOW_KEYS_FILE="$STG/allow-keys.txt" ALLOW_L6C_RELEASE_FILE="$RELEASE_FILE"); local rc=0
  sudo env DISK_THRESHOLD_PCT=90 "${allow[@]}" bash "$P4/p4-compare.sh" "$1" "$2" > "$3" 2>&1 || rc=$?
  grep -E '^(FINDING|FINDINGS_|PRESERVATION_S10|COMPARE_RESULT)' "$3" || true; [ "$rc" = 0 ] || return 1
  for l in FINDINGS_NEW_OR_WORSENED_DRIFT=0 FINDINGS_BASELINE_UNHEALTHY_BUT_UNCHANGED=0 FINDINGS_INCOMPARABLE=0 PRESERVATION_S10=PASS COMPARE_RESULT=PASS; do grep -qx "$l" "$3" || { echo "COMPARE_REQUIREMENT_FAILED: $l"; return 1; }; done; }
handler() { sudo env AEGIS_L6C_WORK_DIR="$WORK" AEGIS_L6C_SOURCE_DIR="$SOURCE_DIR" AEGIS_L6C_RELEASE_ID="$RELEASE_ID" \
  AEGIS_L6C_EXPECTED_SOURCE_SHA="$EXPECTED_SOURCE_SHA" AEGIS_L6C_LIVE_AUTHORIZED=YES AEGIS_PYTHON_BIN="$PY" bash "$STG/$1"; }
own_work() { sudo chown -R "$(id -u):$(id -g)" "$WORK" 2>/dev/null || true; }
s10_unchanged() { [ "$(snap $ENGINE)" = "$ENGINE_PRE" ] && [ "$(snap $TUNNEL)" = "$TUNNEL_PRE" ] && [ "$(snap twingate.service)" = "$TG_PRE" ] \
  && [ "$(snap mosquitto.service)" = "$MQ_PRE" ] && [ "$(snap $BROKER_UNIT)" = "$BROKER_PRE" ] \
  && [ "$(ss -ltnH | awk '$4 ~ /:1883$/ {print $4}' | LC_ALL=C sort -u)" = "$L1883_PRE" ] && [ "$(ss -ltnH | awk '$4 ~ /:8883$/ {print $4}' | LC_ALL=C sort -u)" = "$L8883_PRE" ]; }
rollback_flow() { trap - ERR INT TERM; [ "$ROLLED_BACK" = 0 ] || return 0; ROLLED_BACK=1; echo "== L6c ROLLBACK (reason: $1) — failure/abort path only"
  if sudo test -f "$WORK/production-mutation"; then
    local out; out=$(handler rollback.sh 2>&1) || { printf '%s\n' "$out"; own_work; echo "L6C_ROLLBACK=FAIL (S-11 HOLD) — ESCALATE; do NOT retry; inspect $EVID"; exit 3; }
    printf '%s\n' "$out"; own_work
  else echo "NO_PRODUCTION_MUTATION_MARKER: rollback handler not needed; proving zero drift instead"; fi
  capture RB "$EVID/rb-root" || { echo "RB capture FAILED — ESCALATE"; exit 3; }
  compare "$EVID/pre-root" "$EVID/rb-root" "$EVID/compare-pre-rb.txt" && s10_unchanged || { echo "PRE_RB_COMPARE=FAIL — ESCALATE; do NOT retry"; exit 3; }
  echo "PRE_RB_COMPARE=PASS ROLLBACK_RESULT=PASS L6C_LIVE_ACCEPTANCE=NOT_PROVEN. NOT retrying. Authorization is consumed."; exit 1; }
fail_after_mutation() { [ "$MUTATED" = 1 ] && rollback_flow "$1" || { echo "STOP before any mutation: $1"; exit 1; }; }
trap 'fail_after_mutation "unexpected error at line $LINENO"' ERR
trap 'fail_after_mutation "interrupted"' INT TERM

echo "== PRE capture (before ANY L6c-owned Production change)"; capture PRE "$EVID/pre-root" || die "PRE capture failed; nothing changed"
printf 'stage L6c\nrelease_id %s\n' "$RELEASE_ID" > "$RELEASE_FILE"
echo "== L6c APPLY (once; immutable release install only)"; MUTATED=1
apply_rc=0; apply_out=$(handler apply.sh 2>&1) || apply_rc=$?; printf '%s\n' "$apply_out"; own_work
{ [ "$apply_rc" = 0 ] && printf '%s\n' "$apply_out" | grep -qx 'L6C_APPLY=PASS'; } || rollback_flow "L6C_APPLY failed (rc=$apply_rc)"
echo "== L6c VERIFY (installed release, provenance, no forbidden-surface change)"
ver_rc=0; ver_out=$(handler verify.sh 2>&1) || ver_rc=$?; printf '%s\n' "$ver_out"; own_work
{ [ "$ver_rc" = 0 ] && printf '%s\n' "$ver_out" | grep -qx 'L6C_VERIFY=PASS'; } || rollback_flow "L6C_VERIFY failed"
echo "== POST capture"; capture POST "$EVID/post-root" || rollback_flow "POST capture failed"
echo "== PRE -> POST compare (approved exact L6c release install only)"; compare "$EVID/pre-root" "$EVID/post-root" "$EVID/compare-pre-post.txt" allow || rollback_flow "PRE->POST compare failed"
l6c_secret_scan "$EVID" "$PY" || rollback_flow "SECRET_OUTPUT_SCAN failed"
s10_unchanged || rollback_flow "S10/legacy mosquitto/Twingate/L6b broker preservation failed"
trap - ERR INT TERM
echo "L6C_LIVE_EXECUTED=YES L6C_APPLY=PASS L6C_VERIFY=PASS L6C_POST_CAPTURE=COMPLETE L6C_PRE_POST_COMPARE=PASS L6C_S10_PRESERVATION=PASS"
echo "L6C_LIVE_ACCEPTANCE=PROVEN (this run only). PERSISTENT: /opt/aegis-idea3/releases/$RELEASE_ID installed root-owned and immutable; /opt/aegis-idea3/current untouched; L7_STARTED=NO A_L7_CREATED=NO."
echo "Evidence: $EVID"
