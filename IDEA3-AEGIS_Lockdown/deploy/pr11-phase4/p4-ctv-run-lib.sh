#!/usr/bin/env bash
# CTv successor-stage primitives.  CTv has its own namespace and provenance
# record; no CTu marker, closeout, runner, Authorization, or K3 is accepted.
set -Eeuo pipefail

CTV_CANONICAL_DIR=${CTV_CANONICAL_DIR:-/var/lib/aegis-idea3-governance}
CTV_GLOBAL_MARKER_NAME=CTV-GLOBAL-ATTEMPT-CONSUMED
CTV_CLOSEOUT_PASS_NAME=CTV-GLOBAL-CLOSEOUT-PASS
CTV_CLOSEOUT_FAIL_NAME=CTV-GLOBAL-CLOSEOUT-FAIL
CTV_SUDO=${CTV_SUDO-${SUDO-sudo}}
CTV_SUCCESS_CORE_RESTARTS=1
CTV_MAX_FAILURE_RESTARTS=2
CTV_EXPLICIT_DETECTOR_LIFECYCLE_COMMANDS=0
# The rehearsal is the single pre-consume proof boundary: all deterministic
# provenance and host gates must be PASS before this value may be asserted.
ALL_DETERMINISTIC_PROVENANCE_GATES_PRECONSUME=YES
ctv_git() { HOME=/nonexistent GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_NO_REPLACE_OBJECTS=1 /usr/bin/git "$@"; }

ctv_run() { if [ -n "$CTV_SUDO" ]; then "$CTV_SUDO" "$@"; else "$@"; fi; }
ctv_failpoint() {
  [ "${CTV_FAIL_PHASE:-}" = "${1:-}" ] || return 0
  printf 'CTV_HERMETIC_FAILURE_INJECTED=%s\n' "$1" >&2
  return 1
}
ctv_path_ok() {
  local value=${1:-}
  [[ "$value" == /* && "$value" != *//* && "$value" != */../* && "$value" != */.. && "$value" != *..* ]] || return 1
  [ "$value" != "/" ] || return 0
  [ "${value%/}" = "$value" ]
}
ctv_canonical_dir() {
  if [ "${CTV_TEST_ONLY_CANONICAL_DIR_ENABLED:-}" = YES ] && [ -n "${CTV_TEST_ONLY_CANONICAL_DIR:-}" ]; then
    printf '%s' "$CTV_TEST_ONLY_CANONICAL_DIR"
  else printf '%s' "$CTV_CANONICAL_DIR"; fi
}
ctv_fsync() { ctv_run sync -- "$1" 2>/dev/null; }
ctv_prepare_work_dir() {
  local dir=${1:-}; ctv_path_ok "$dir" || return 1
  ctv_run mkdir -p -- "$dir" || return 1
  ctv_run chmod 0711 -- "$dir" || return 1
  ctv_fsync "$dir"
}
ctv_write_journal() {
  local journal=${1:-} phase=${2:-} preimage=${3:-} tmp
  ctv_path_ok "$journal" || return 1
  case "$phase" in prepared-no-production-mutation|consumed-no-production-mutation|preimage-captured|mutation-started|unit-installed|daemon-reloaded|before-core-restart|after-core-restart|apply-verified|rollback-complete) ;; *) return 1 ;; esac
  ctv_prepare_work_dir "$(dirname "$journal")" || return 1
  tmp="$journal.tmp.$$"
  { printf 'phase=%s\n' "$phase"; if [ -n "$preimage" ]; then printf 'preimage=%s\n' "$preimage"; fi; } | ctv_run tee "$tmp" >/dev/null || return 1
  ctv_run chmod 0600 "$tmp" || return 1
  ctv_fsync "$tmp" || return 1
  ctv_run mv -f "$tmp" "$journal" || return 1
  ctv_fsync "$journal" && ctv_fsync "$(dirname "$journal")"
}
ctv_prepare_no_mutation_journal() { ctv_write_journal "$1" prepared-no-production-mutation; }
ctv_verify_regular_trusted() {
  local file=${1:-} expected_sha=${2:-}; ctv_path_ok "$file" || return 1
  [ -f "$file" ] && [ ! -L "$file" ] || return 1
  [ "$(stat -c %F -- "$file" 2>/dev/null)" = "regular file" ] || return 1
  [ -z "$(find "$file" -maxdepth 0 -perm /022 2>/dev/null)" ] || return 1
  if [ -n "$CTV_SUDO" ]; then [ "$(ctv_run stat -c %u -- "$file" 2>/dev/null)" = 0 ] || return 1; fi
  [[ "$expected_sha" =~ ^[0-9a-f]{64}$ ]] || return 1
  [ "$(sha256sum -- "$file" | cut -d' ' -f1)" = "$expected_sha" ]
}
ctv_verify_provenance_domains() {
  local runner=${1:-} runner_sha=${2:-} template_sha=${3:-} bundle_sha=${4:-} control_sha=${5:-}
  ctv_verify_regular_trusted "$runner" "$runner_sha" || { echo CTV_FROZEN_RUNNER_PROVENANCE_INVALID >&2; return 1; }
  [[ "$template_sha" =~ ^[0-9a-f]{64}$ && "$bundle_sha" =~ ^[0-9a-f]{64}$ && "$control_sha" =~ ^[0-9a-f]{64}$ ]] || return 1
  [ "$runner_sha" != "$template_sha" ] || { echo CTV_PROVENANCE_DOMAINS_COLLAPSED >&2; return 1; }
  printf 'CTV_FROZEN_RUNNER_SHA256=%s\nCTV_RUNNER_TEMPLATE_SHA256=%s\nCTV_BUNDLE_MANIFEST_SHA256=%s\nCTV_CONTROL_MANIFEST_SHA256=%s\n' "$runner_sha" "$template_sha" "$bundle_sha" "$control_sha"
}
ctv_prepare_bundle() {
  local repo=${1:-} p4=${2:-} bundle=${3:-} main=${4:-} rel src dst got expected
  ctv_path_ok "$repo" && ctv_path_ok "$p4" && ctv_path_ok "$bundle" || return 1
  [[ "$main" =~ ^[0-9a-f]{40}$ ]] || return 1
  local -a files=(
    p4-lib.sh p4-stage-gate.sh p4-ctv-run-lib.sh p4-l0-capture.sh p4-l5-clock.py p4-l6c-tree-digest.py
    p4-l7u-run-lib.sh p4-l7-run-lib.sh p4-l6b-run-lib.sh p4-ctu-runtime-verify.py
    owner-run/run-ctv-owner.sh ctv-acceptance/ctv_runner_freeze.py ctv-acceptance/ctv_verifier_snapshot.py
    stages/CTv/apply.sh stages/CTv/verify.sh stages/CTv/rollback.sh stages/CTv/allow-keys.txt
    stages/CTv/allow-keys-rollback.txt stages/CTv/allow-listeners.txt
  )
  ctv_prepare_work_dir "$(dirname "$bundle")" || return 1
  ctv_run mkdir -p -m 0711 -- "$bundle/owner-run" "$bundle/ctv-acceptance" "$bundle/stages/CTv" || return 1
  : | ctv_run tee "$bundle/CTV-BUNDLE-SHA256SUMS" >/dev/null || return 1
  for rel in "${files[@]}"; do
    src="$p4/$rel"; dst="$bundle/$rel"
    [ -f "$src" ] && [ ! -L "$src" ] || return 1
    ctv_git -C "$repo" cat-file -e "$main:IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/$rel" 2>/dev/null || return 1
    expected=$(ctv_git -C "$repo" show "$main:IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/$rel" | sha256sum | cut -d' ' -f1)
    got=$(sha256sum "$src" | cut -d' ' -f1); [ "$got" = "$expected" ] || return 1
    ctv_run install -o root -g root -m 0555 -- "$src" "$dst" 2>/dev/null || ctv_run install -m 0555 -- "$src" "$dst" || return 1
    printf '%s  %s\n' "$got" "$rel" | ctv_run tee -a "$bundle/CTV-BUNDLE-SHA256SUMS" >/dev/null || return 1
  done
  ctv_run chmod 0444 "$bundle/CTV-BUNDLE-SHA256SUMS"; ctv_run chmod 0555 "$bundle"
  (cd "$bundle" && sha256sum -c --quiet --strict CTV-BUNDLE-SHA256SUMS) >/dev/null 2>&1
}
ctv_verify_bundle() {
  local bundle=${1:-} repo=${2:-} main=${3:-} digest rel; ctv_path_ok "$bundle" || return 1
  [ -d "$bundle" ] && [ ! -L "$bundle" ] && [ -f "$bundle/CTV-BUNDLE-SHA256SUMS" ] || return 1
  [ -z "$(find "$bundle" -type d -perm /022 -print -quit 2>/dev/null)" ] || return 1
  [ -z "$(find "$bundle" -type l -print -quit 2>/dev/null)" ] || return 1
  (cd "$bundle" && sha256sum -c --quiet --strict CTV-BUNDLE-SHA256SUMS) >/dev/null 2>&1 || return 1
  if [ -n "$repo" ]; then
    [[ "$main" =~ ^[0-9a-f]{40}$ ]] || return 1
    while read -r digest rel; do
      [[ "$digest" =~ ^[0-9a-f]{64}$ && -n "$rel" ]] || return 1
      [ "$rel" != "CTV-BUNDLE-SHA256SUMS" ] && [[ "$rel" != /* && "$rel" != *..* ]] || return 1
      [ "$(ctv_git -C "$repo" show "$main:IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/$rel" 2>/dev/null | sha256sum | cut -d' ' -f1)" = "$digest" ] || return 1
    done < "$bundle/CTV-BUNDLE-SHA256SUMS"
  fi
  return 0
}
ctv_establish_consumed_no_mutation_journal() {
  local journal=${1:-} phase; ctv_path_ok "$journal" || return 1
  [ -f "$journal" ] && [ ! -L "$journal" ] || return 1
  phase=$(awk -F= '$1 == "phase" {print $2}' "$journal")
  [ "$phase" = prepared-no-production-mutation ] || return 1
  ctv_write_journal "$journal" consumed-no-production-mutation
}
ctv_rollback_governed() {
  local journal=${1:-} phase; ctv_verify_regular_trusted "$journal" "$(sha256sum "$journal" | cut -d' ' -f1)" || return 1
  phase=$(awk -F= '$1 == "phase" {print $2}' "$journal")
  if [[ "$phase" = prepared-no-production-mutation || "$phase" = consumed-no-production-mutation ]]; then
    printf 'CTV_ROLLBACK=PASS reason=NO_MUTATION\nCTV_CORE_RESTARTS=0\nCTV_DETECTOR_COMMANDS=0\n'
    return 0
  fi
  local preimage; preimage=$(awk -F= '$1 == "preimage" {print $2}' "$journal")
  case "$phase" in preimage-captured|mutation-started|unit-installed|daemon-reloaded|before-core-restart|after-core-restart|apply-verified)
    [ -n "$preimage" ] && [ -f "$preimage" ] || { echo CTV_ROLLBACK=FAIL reason=PREIMAGE_MISSING >&2; return 1; }
    if [ "${CTV_TEST_MODE:-NO}" = YES ]; then
      [ -n "${CTV_UNIT_DEST:-}" ] && cp -f "$preimage" "$CTV_UNIT_DEST" || return 1
      if [ "$phase" = after-core-restart ] || [ "$phase" = apply-verified ]; then printf '2\n' > "${CTV_CORE_RESTARTS_FILE:?}"; fi
    else
      install -o root -g root -m 0644 "$preimage" "${CTV_UNIT_DEST:?}" || return 1
      systemctl daemon-reload || return 1
      systemctl restart aegis-idea3-core.service || return 1
    fi
    ctv_write_journal "$journal" rollback-complete "$preimage"
    printf 'CTV_ROLLBACK=PASS reason=RESTORED_PREIMAGE\nCTV_CORE_RESTARTS=%s\nCTV_DETECTOR_COMMANDS=0\n' "${CTV_ROLLBACK_RESTARTS:-0}"
    return 0 ;;
  esac
  printf 'CTV_ROLLBACK=FAIL reason=UNSUPPORTED_JOURNAL_PHASE\n' >&2; return 1
}
ctv_marker_unconsumed() {
  local dir; dir=$(ctv_canonical_dir); ctv_path_ok "$dir" || return 1
  [ ! -e "$dir/$CTV_GLOBAL_MARKER_NAME" ] && [ ! -L "$dir/$CTV_GLOBAL_MARKER_NAME" ] || return 1
  [ ! -e "$dir/$CTV_CLOSEOUT_PASS_NAME" ] && [ ! -e "$dir/$CTV_CLOSEOUT_FAIL_NAME" ]
}
ctv_consume_attempt() {
  local work=${1:-} runner_sha=${2:-} template_sha=${3:-} bundle_sha=${4:-} control_sha=${5:-} dir marker
  ctv_path_ok "$work" || return 1
  [ -f "$work/journal" ] && [ ! -L "$work/journal" ] && grep -qx 'phase=prepared-no-production-mutation' "$work/journal" || return 1
  [[ "$runner_sha" =~ ^[0-9a-f]{64}$ && "$template_sha" =~ ^[0-9a-f]{64}$ && "$bundle_sha" =~ ^[0-9a-f]{64}$ && "$control_sha" =~ ^[0-9a-f]{64}$ ]] || return 1
  ctv_marker_unconsumed || return 1
  dir=$(ctv_canonical_dir); ctv_run mkdir -p -m 0700 -- "$dir" || return 1; marker="$dir/$CTV_GLOBAL_MARKER_NAME"
  printf 'CTV_ATTEMPT_CONSUMED=YES\nCTV_RERUN_ALLOWED=NO\nCTV_FROZEN_RUNNER_SHA256=%s\nCTV_RUNNER_TEMPLATE_SHA256=%s\nCTV_BUNDLE_MANIFEST_SHA256=%s\nCTV_CONTROL_MANIFEST_SHA256=%s\nwork=%s\n' "$runner_sha" "$template_sha" "$bundle_sha" "$control_sha" "$work" | ctv_run bash -c 'set -o noclobber; umask 077; cat > "$1"' _ "$marker" || return 1
  ctv_fsync "$marker" && ctv_fsync "$dir"
}
ctv_record_success() {
  local main=${1:-} unit_sha=${2:-} receipt=${3:-} runner_sha=${4:-} template_sha=${5:-} bundle_sha=${6:-} control_sha=${7:-} dir closeout tmp
  [[ "$main" =~ ^[0-9a-f]{40}$ && "$unit_sha" =~ ^[0-9a-f]{64}$ && "$runner_sha" =~ ^[0-9a-f]{64}$ && "$template_sha" =~ ^[0-9a-f]{64}$ && "$bundle_sha" =~ ^[0-9a-f]{64}$ && "$control_sha" =~ ^[0-9a-f]{64}$ ]] || return 1
  [ "$runner_sha" != "$template_sha" ] || return 1
  dir=$(ctv_canonical_dir); closeout="$dir/$CTV_CLOSEOUT_PASS_NAME"; tmp="$closeout.tmp.$$"
  [ -f "$dir/$CTV_GLOBAL_MARKER_NAME" ] && [ ! -e "$closeout" ] && [ ! -e "$dir/$CTV_CLOSEOUT_FAIL_NAME" ] || return 1
  printf 'CTV_RESULT=CLOSED_PASS\nCTV_LIVE=CLOSED_PASS\nCTV_LIVE_EXECUTED=YES\nCTV_ATTEMPT_CONSUMED=YES\nCTV_RERUN_ALLOWED=NO\nCTV_IS_CTU_RETRY=NO\nCTV_EXPECTED_MAIN=%s\nCTV_UNIT_SHA256=%s\nCTV_FROZEN_RUNNER_SHA256=%s\nCTV_RUNNER_TEMPLATE_SHA256=%s\nCTV_BUNDLE_MANIFEST_SHA256=%s\nCTV_CONTROL_MANIFEST_SHA256=%s\nCTV_CORE_RESTARTS=1\nCTV_EXPLICIT_DETECTOR_LIFECYCLE_COMMANDS=0\nCTV_PRODUCTION_RUNTIME_MUTATION_OCCURRED=YES\nCTV_RUNTIME_PROOF=PASS\nCTV_DETECTOR_BASELINE_MODE=${CTV_DETECTOR_BASELINE_MODE:-UNKNOWN}\nCTV_DEVICE_ID=${CTV_DEVICE_ID:-UNKNOWN}\nCTV_EVIDENCE_MANIFEST_SHA256=${CTV_EVIDENCE_MANIFEST_SHA256:-UNKNOWN}\nCTV_PRE_POST_PRESERVATION=PASS\nCTV_REPOSITORY_RECEIPT=%s\n' "$main" "$unit_sha" "$runner_sha" "$template_sha" "$bundle_sha" "$control_sha" "$receipt" | ctv_run tee "$tmp" >/dev/null || return 1
  ctv_run chmod 0600 "$tmp"; ctv_fsync "$tmp"; ctv_run mv -n "$tmp" "$closeout"; ctv_fsync "$closeout"; ctv_fsync "$dir"
  printf '%s  %s\n' "$(sha256sum "$closeout" | cut -d' ' -f1)" "$(basename "$closeout")" | ctv_run tee "$closeout.sha256" >/dev/null
  ctv_run chmod 0444 "$closeout.sha256"; ctv_fsync "$closeout.sha256"; ctv_fsync "$dir"
}
ctv_record_failure() {
  local reason=${1:-UNKNOWN} executed=${2:-YES} dir closeout tmp
  dir=$(ctv_canonical_dir); closeout="$dir/$CTV_CLOSEOUT_FAIL_NAME"; tmp="$closeout.tmp.$$"
  [ -f "$dir/$CTV_GLOBAL_MARKER_NAME" ] && [ ! -e "$dir/$CTV_CLOSEOUT_PASS_NAME" ] && [ ! -e "$closeout" ] || return 1
  [ "$executed" = YES ] || executed=NO
  printf 'CTV_RESULT=FAIL_IMMUTABLE\nCTV_LIVE=CLOSED_FAIL\nCTV_LIVE_EXECUTED=%s\nCTV_ATTEMPT_CONSUMED=YES\nCTV_RERUN_ALLOWED=NO\nCTV_IS_CTU_RETRY=NO\nCTV_FAILURE_REASON=%s\n' "$executed" "$reason" | ctv_run tee "$tmp" >/dev/null || return 1
  ctv_run chmod 0600 "$tmp"; ctv_fsync "$tmp"; ctv_run mv -n "$tmp" "$closeout"; ctv_fsync "$closeout"; ctv_fsync "$dir"
  printf '%s  %s\n' "$(sha256sum "$closeout" | cut -d' ' -f1)" "$(basename "$closeout")" | ctv_run tee "$closeout.sha256" >/dev/null
  ctv_run chmod 0444 "$closeout.sha256"; ctv_fsync "$closeout.sha256"; ctv_fsync "$dir"
}
ctv_predecessor_gate() {
  local canon=${1:-}; ctv_path_ok "$canon" || return 1
  [ -f "$canon/CTU-GLOBAL-ATTEMPT-CONSUMED" ] && [ -f "$canon/CTU-GLOBAL-CLOSEOUT-FAIL" ] || return 1
  [ ! -e "$canon/CTU-GLOBAL-CLOSEOUT-PASS" ] || return 1
  grep -qx 'CTU_RESULT=FAIL_IMMUTABLE' "$canon/CTU-GLOBAL-CLOSEOUT-FAIL" || return 1
  grep -qx 'CTU_FAILURE_REASON=APPLY' "$canon/CTU-GLOBAL-CLOSEOUT-FAIL" || return 1
  grep -qx 'CTU_ATTEMPT_CONSUMED=YES' "$canon/CTU-GLOBAL-ATTEMPT-CONSUMED" || return 1
  grep -qx 'CTU_RERUN_ALLOWED=NO' "$canon/CTU-GLOBAL-ATTEMPT-CONSUMED" || return 1
  [ ! -e "$canon/$CTV_GLOBAL_MARKER_NAME" ] && [ ! -e "$canon/$CTV_CLOSEOUT_PASS_NAME" ] && [ ! -e "$canon/$CTV_CLOSEOUT_FAIL_NAME" ] || return 1
  [ ! -e "$canon/RECOVERY-GLOBAL-ATTEMPT-CONSUMED" ] && [ ! -L "$canon/RECOVERY-GLOBAL-ATTEMPT-CONSUMED" ]
}
ctv_target_unit_preflight() {
  local unit=${1:-} expected_sha=${2:-}; ctv_verify_regular_trusted "$unit" "$expected_sha" || return 1
  grep -q '^ProtectClock=false$' "$unit" || return 1
  grep -q '^User=aegis-idea3$' "$unit" || return 1
  grep -q '^NoNewPrivileges=true$' "$unit" || return 1
  grep -q '^CapabilityBoundingSet=$' "$unit" || return 1
  grep -q '^AmbientCapabilities=$' "$unit"
}
ctv_journal_phase() {
  local journal=${1:-} phase=${2:-} tmp; ctv_path_ok "$journal" || return 1
  case "$phase" in consumed-no-production-mutation|preimage-captured|mutation-started|unit-installed|daemon-reloaded|before-core-restart|after-core-restart|apply-verified|rollback-complete) ;; *) return 1 ;; esac
  local preimage; preimage=$(awk -F= '$1 == "preimage" {print $2}' "$journal" 2>/dev/null || true)
  tmp="$journal.tmp.$$"; { printf 'phase=%s\n' "$phase"; if [ -n "$preimage" ]; then printf 'preimage=%s\n' "$preimage"; fi; } | ctv_run tee "$tmp" >/dev/null || return 1
  ctv_run chmod 0600 "$tmp"; ctv_fsync "$tmp"; ctv_run mv -f "$tmp" "$journal"; ctv_fsync "$journal"; ctv_fsync "$(dirname "$journal")"
}
ctv_capture_state() {
  local dest=${1:-} fixture=${2:-} label=${3:-}
  ctv_path_ok "$dest" && ctv_path_ok "$fixture" || return 1
  [ -d "$fixture" ] && [ ! -L "$fixture" ] || return 1
  ctv_run mkdir -p -m 0700 "$dest" || return 1
  ctv_run cp -a --no-preserve=ownership "$fixture/." "$dest/" || return 1
  printf 'capture=%s\n' "$label" | ctv_run tee "$dest/CAPTURE-META" >/dev/null || return 1
  ctv_fsync "$dest/CAPTURE-META" && ctv_fsync "$dest"
}
ctv_compare_preservation() {
  local pre=${1:-} post=${2:-} a b
  ctv_path_ok "$pre" && ctv_path_ok "$post" || return 1
  a=$(cd "$pre" && find . -type f ! -name CAPTURE-META -print0 | sort -z | xargs -0 sha256sum)
  b=$(cd "$post" && find . -type f ! -name CAPTURE-META -print0 | sort -z | xargs -0 sha256sum)
  [ "$a" = "$b" ]
}
ctv_runtime_verify() {
  local fixture=${1:-}; ctv_path_ok "$fixture" || return 1
  grep -qx PASS "$fixture/runtime-verify" || return 1
  grep -qx PASS "$fixture/detector-preservation" || return 1
}
ctv_evidence_manifest() {
  local work=${1:-} manifest
  ctv_path_ok "$work" || return 1
  manifest="$work/CTV-EVIDENCE-SHA256SUMS"
  (cd "$work" && find . -type f ! -name CTV-EVIDENCE-SHA256SUMS -printf '%P\n' | LC_ALL=C sort | xargs sha256sum) | ctv_run tee "$manifest" >/dev/null || return 1
  ctv_fsync "$manifest" || return 1
  CTV_EVIDENCE_MANIFEST_SHA256=$(sha256sum "$manifest" | cut -d' ' -f1)
  export CTV_EVIDENCE_MANIFEST_SHA256
}
ctv_apply_governed() {
  local journal=${1:-} unit_source=${2:-} unit_dest=${3:-} unit_sha=${4:-}
  [ "${CTV_LIVE_AUTHORIZED:-NO}" = YES ] || { echo CTV_LIVE_AUTHORIZATION_REQUIRED >&2; return 1; }
  ctv_target_unit_preflight "$unit_source" "$unit_sha" || { echo CTV_TARGET_UNIT_PREFLIGHT_FAIL >&2; return 1; }
  grep -qx 'phase=consumed-no-production-mutation' "$journal" || { echo CTV_JOURNAL_NOT_PREMUTATION >&2; return 1; }
  local preimage="${journal}.preimage"; ctv_failpoint preimage-capture || return 1; [ -f "$unit_dest" ] && cp -f "$unit_dest" "$preimage" || : > "$preimage"
  ctv_write_journal "$journal" preimage-captured "$preimage" || return 1
  ctv_journal_phase "$journal" mutation-started || return 1
  ctv_failpoint mutation-started || return 1
  if [ "${CTV_TEST_MODE:-NO}" = YES ]; then
    ctv_failpoint unit-install || return 1; cp -f "$unit_source" "$unit_dest" || return 1
    ctv_journal_phase "$journal" unit-installed || return 1
    ctv_failpoint unit-installed || return 1
    ctv_failpoint daemon-reload || return 1
    ctv_journal_phase "$journal" daemon-reloaded || return 1
    ctv_failpoint after-daemon-reload || return 1
    ctv_journal_phase "$journal" before-core-restart || return 1
    ctv_failpoint before-core-restart || return 1
    ctv_failpoint core-restart || return 1
    printf '1\n' > "${CTV_CORE_RESTARTS_FILE:?}"
    ctv_journal_phase "$journal" after-core-restart || return 1
    ctv_failpoint after-core-restart || return 1
  else
    ctv_failpoint unit-install || return 1; ctv_run install -o root -g root -m 0644 "$unit_source" "$unit_dest" || return 1
    ctv_journal_phase "$journal" unit-installed || return 1
    ctv_failpoint unit-installed || return 1
    ctv_failpoint daemon-reload || return 1
    ctv_run systemctl daemon-reload || return 1
    ctv_journal_phase "$journal" daemon-reloaded || return 1
    ctv_failpoint after-daemon-reload || return 1
    ctv_journal_phase "$journal" before-core-restart || return 1
    ctv_failpoint before-core-restart || return 1
    ctv_failpoint core-restart || return 1
    ctv_run systemctl restart aegis-idea3-core.service || return 1
    ctv_journal_phase "$journal" after-core-restart || return 1
    ctv_failpoint after-core-restart || return 1
  fi
  ctv_journal_phase "$journal" apply-verified || return 1
  printf 'CTV_APPLY=PASS\nCTV_CORE_RESTARTS=%s\nCTV_EXPLICIT_DETECTOR_LIFECYCLE_COMMANDS=%s\n' "$CTV_SUCCESS_CORE_RESTARTS" "$CTV_EXPLICIT_DETECTOR_LIFECYCLE_COMMANDS"
}
ctv_preconsume_rehearsal() {
  local repo=${1:-} main=${2:-} auth=${3:-} k3=${4:-} canon=${5:-} bundle=${6:-} control=${7:-} runner=${8:-} runner_sha=${9:-} template_sha=${10:-} unit=${11:-} unit_sha=${12:-} fixture=${13:-}
  if [ -z "$repo" ]; then
    [ "${CTV_ATTEMPT_CONSUMED:-NO}" = NO ] && [ "${CTV_PRODUCTION_MUTATION:-NO}" = NO ] || return 1
  else
    ctv_path_ok "$repo" && ctv_path_ok "$auth" && ctv_path_ok "$k3" && ctv_path_ok "$canon" && ctv_path_ok "$bundle" && ctv_path_ok "$control" && ctv_path_ok "$runner" && ctv_path_ok "$unit" && ctv_path_ok "$fixture" || return 1
    [ -d "$fixture" ] && [ ! -L "$fixture" ] || return 1
    local required_file; for required_file in remote-main device-id work-topology operator-identity auth-k3-binding auth-fresh k3-fresh frozen-derivation target-unit core.state core-security detector.state dropins l0-pre.result rollback-preflight evidence-capacity runtime-verify detector-preservation remote-main-equality recovery-unconsumed; do
      [ -f "$fixture/$required_file" ] && [ ! -L "$fixture/$required_file" ] || return 1
    done
    [[ "$main" =~ ^[0-9a-f]{40}$ && "$runner_sha" =~ ^[0-9a-f]{64}$ && "$template_sha" =~ ^[0-9a-f]{64}$ && "$unit_sha" =~ ^[0-9a-f]{64}$ ]] || return 1
    [ "$(ctv_git -C "$repo" rev-parse --verify HEAD^{commit})" = "$main" ] && [ -z "$(ctv_git -C "$repo" status --porcelain=v1)" ] || return 1
    grep -qx 'stage=CTv' "$auth" && grep -qx 'stage=CTv' "$k3" || return 1
    grep -qx "expected_main=$main" "$auth" && grep -qx "expected_main=$main" "$k3" || return 1
    grep -qx "runner_sha256=$runner_sha" "$auth" && grep -qx "runner_sha256=$runner_sha" "$k3" || return 1
    grep -qx "runner_template_sha256=$template_sha" "$auth" && grep -qx "runner_template_sha256=$template_sha" "$k3" || return 1
    ctv_predecessor_gate "$canon" || return 1
    ctv_marker_unconsumed || return 1
    ctv_verify_bundle "$bundle" "$repo" "$main" || return 1
    [ -f "$control/CTV-CONTROL-SHA256SUMS" ] && [ ! -L "$control/CTV-CONTROL-SHA256SUMS" ] || return 1
    (cd "$control" && sha256sum -c --quiet --strict CTV-CONTROL-SHA256SUMS) >/dev/null 2>&1 || return 1
    [ -z "$(find "$control" -type l -print -quit 2>/dev/null)" ] || return 1
    [ -z "$(find "$control" -perm /222 -print -quit 2>/dev/null)" ] || return 1
    ctv_verify_regular_trusted "$runner" "$runner_sha" || return 1
    ctv_target_unit_preflight "$unit" "$unit_sha" || return 1
    [ "$(cat "$fixture/remote-main")" = "$main" ] || return 1
    grep -qx "${DEVICE_ID:-${CTV_DEVICE_ID:-}}" "$fixture/device-id" || return 1
    grep -qx PASS "$fixture/work-topology" || return 1
    grep -qx PASS "$fixture/operator-identity" || return 1
    grep -qx PASS "$fixture/auth-k3-binding" || return 1
    grep -qx PASS "$fixture/auth-fresh" || return 1
    grep -qx PASS "$fixture/k3-fresh" || return 1
    grep -qx PASS "$fixture/frozen-derivation" || return 1
    grep -qx PASS "$fixture/target-unit" || return 1
    grep -qx 'active running 0' "$fixture/core.state" || return 1
    grep -qx 'ProtectClock=true' "$fixture/core-security" || return 1
    grep -Eq '^(ACTIVE|INACTIVE)$' "$fixture/detector.state" || return 1
    grep -qx '10-recovery.conf 20-f1-alert.conf' "$fixture/dropins" || return 1
    grep -qx COMPLETE "$fixture/l0-pre.result" || return 1
    grep -qx PASS "$fixture/rollback-preflight" || return 1
    grep -qx PASS "$fixture/evidence-capacity" || return 1
    grep -qx PASS "$fixture/runtime-verify" || return 1
    grep -qx PASS "$fixture/detector-preservation" || return 1
    grep -qx PASS "$fixture/remote-main-equality" || return 1
    grep -qx PASS "$fixture/recovery-unconsumed" || return 1
  fi
  printf 'CTV_PRECONSUME_REHEARSAL=PASS\nADDITIONAL_DETERMINISTIC_PRECONSUME_BLOCKER=NONE\n'
}
