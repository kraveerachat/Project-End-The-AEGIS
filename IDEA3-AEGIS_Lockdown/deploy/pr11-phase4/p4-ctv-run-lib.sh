#!/usr/bin/env bash
# CTv successor-stage primitives.  CTv has its own namespace and provenance
# record; no CTu marker, closeout, runner, Authorization, or K3 is accepted.
set -Eeuo pipefail

CTV_CANONICAL_DIR=${CTV_CANONICAL_DIR:-/var/lib/aegis-idea3-governance}
CTV_GLOBAL_MARKER_NAME=CTV-GLOBAL-ATTEMPT-CONSUMED
CTV_CLOSEOUT_PASS_NAME=CTV-GLOBAL-CLOSEOUT-PASS
CTV_CLOSEOUT_FAIL_NAME=CTV-GLOBAL-CLOSEOUT-FAIL
CTV_SUDO=${CTV_SUDO-${SUDO-sudo}}
# The rehearsal is the single pre-consume proof boundary: all deterministic
# provenance and host gates must be PASS before this value may be asserted.
ALL_DETERMINISTIC_PROVENANCE_GATES_PRECONSUME=YES

ctv_run() { if [ -n "$CTV_SUDO" ]; then "$CTV_SUDO" "$@"; else "$@"; fi; }
ctv_path_ok() { [[ "${1:-}" == /* && "${1:-}" != *..* && "${1:-}" != *//* ]]; }
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
  ctv_path_ok "$repo"; ctv_path_ok "$p4"; ctv_path_ok "$bundle" || return 1
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
    git -C "$repo" cat-file -e "$main:IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/$rel" 2>/dev/null || return 1
    expected=$(git -C "$repo" show "$main:IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/$rel" | sha256sum | cut -d' ' -f1)
    got=$(sha256sum "$src" | cut -d' ' -f1); [ "$got" = "$expected" ] || return 1
    ctv_run install -o root -g root -m 0555 -- "$src" "$dst" 2>/dev/null || ctv_run install -m 0555 -- "$src" "$dst" || return 1
    printf '%s  %s\n' "$got" "$rel" | ctv_run tee -a "$bundle/CTV-BUNDLE-SHA256SUMS" >/dev/null || return 1
  done
  ctv_run chmod 0444 "$bundle/CTV-BUNDLE-SHA256SUMS"; ctv_run chmod 0555 "$bundle"
  (cd "$bundle" && sha256sum -c --quiet --strict CTV-BUNDLE-SHA256SUMS) >/dev/null 2>&1
}
ctv_verify_bundle() {
  local bundle=${1:-}; ctv_path_ok "$bundle" || return 1
  [ -d "$bundle" ] && [ ! -L "$bundle" ] && [ -f "$bundle/CTV-BUNDLE-SHA256SUMS" ] || return 1
  [ -z "$(find "$bundle" -type l -print -quit 2>/dev/null)" ] || return 1
  (cd "$bundle" && sha256sum -c --quiet --strict CTV-BUNDLE-SHA256SUMS) >/dev/null 2>&1
}
ctv_establish_consumed_no_mutation_journal() {
  local journal=${1:-} tmp; ctv_path_ok "$journal" || return 1
  ctv_prepare_work_dir "$(dirname "$journal")" || return 1
  [ ! -e "$journal" ] && [ ! -L "$journal" ] || return 1
  tmp="$journal.tmp.$$"
  printf 'phase=consumed-no-production-mutation\nCTV_PRODUCTION_MUTATION=NO\n' | ctv_run tee "$tmp" >/dev/null || return 1
  ctv_run chmod 0600 -- "$tmp" || return 1
  ctv_fsync "$tmp" || return 1
  ctv_run mv -n -- "$tmp" "$journal" || return 1
  ctv_fsync "$journal" && ctv_fsync "$(dirname "$journal")"
}
ctv_rollback_governed() {
  local journal=${1:-} phase; ctv_verify_regular_trusted "$journal" "$(sha256sum "$journal" | cut -d' ' -f1)" || return 1
  phase=$(awk -F= '$1 == "phase" {print $2}' "$journal")
  if [ "$phase" = consumed-no-production-mutation ]; then
    printf 'CTV_ROLLBACK=PASS reason=NO_MUTATION\nCTV_CORE_RESTARTS=0\nCTV_DETECTOR_COMMANDS=0\n'
    return 0
  fi
  printf 'CTV_ROLLBACK=FAIL reason=UNSUPPORTED_JOURNAL_PHASE\n' >&2
  return 1
}
ctv_marker_unconsumed() {
  local dir; dir=$(ctv_canonical_dir); ctv_path_ok "$dir" || return 1
  [ ! -e "$dir/$CTV_GLOBAL_MARKER_NAME" ] && [ ! -L "$dir/$CTV_GLOBAL_MARKER_NAME" ] || return 1
  [ ! -e "$dir/$CTV_CLOSEOUT_PASS_NAME" ] && [ ! -e "$dir/$CTV_CLOSEOUT_FAIL_NAME" ]
}
ctv_consume_attempt() {
  local work=${1:-} runner_sha=${2:-} template_sha=${3:-} bundle_sha=${4:-} control_sha=${5:-} dir marker
  ctv_path_ok "$work" || return 1
  [[ "$runner_sha" =~ ^[0-9a-f]{64}$ && "$template_sha" =~ ^[0-9a-f]{64}$ && "$bundle_sha" =~ ^[0-9a-f]{64}$ && "$control_sha" =~ ^[0-9a-f]{64}$ ]] || return 1
  ctv_marker_unconsumed || return 1
  dir=$(ctv_canonical_dir); ctv_run mkdir -p -m 0700 -- "$dir" || return 1; marker="$dir/$CTV_GLOBAL_MARKER_NAME"
  printf 'CTV_ATTEMPT_CONSUMED=YES\nCTV_RERUN_ALLOWED=NO\nCTV_FROZEN_RUNNER_SHA256=%s\nCTV_RUNNER_TEMPLATE_SHA256=%s\nCTV_BUNDLE_MANIFEST_SHA256=%s\nCTV_CONTROL_MANIFEST_SHA256=%s\nwork=%s\n' "$runner_sha" "$template_sha" "$bundle_sha" "$control_sha" "$work" | ctv_run bash -c 'set -o noclobber; cat > "$1"' _ "$marker" || return 1
  ctv_fsync "$marker" && ctv_fsync "$dir"
}
ctv_predecessor_gate() {
  local canon=${1:-}; ctv_path_ok "$canon" || return 1
  [ -f "$canon/CTU-GLOBAL-ATTEMPT-CONSUMED" ] && [ -f "$canon/CTU-GLOBAL-CLOSEOUT-FAIL" ] || return 1
  [ ! -e "$canon/CTU-GLOBAL-CLOSEOUT-PASS" ] || return 1
  grep -qx 'CTU_RESULT=FAIL_IMMUTABLE' "$canon/CTU-GLOBAL-CLOSEOUT-FAIL" || return 1
  grep -qx 'CTU_FAILURE_REASON=APPLY' "$canon/CTU-GLOBAL-CLOSEOUT-FAIL" || return 1
  grep -qx 'CTU_ATTEMPT_CONSUMED=YES' "$canon/CTU-GLOBAL-ATTEMPT-CONSUMED" || return 1
  grep -qx 'CTU_RERUN_ALLOWED=NO' "$canon/CTU-GLOBAL-ATTEMPT-CONSUMED"
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
  case "$phase" in consumed-no-production-mutation|mutation-started|mutation-applied|rollback-complete) ;; *) return 1 ;; esac
  tmp="$journal.tmp.$$"; printf 'phase=%s\n' "$phase" | ctv_run tee "$tmp" >/dev/null || return 1
  ctv_run chmod 0600 "$tmp"; ctv_fsync "$tmp"; ctv_run mv -f "$tmp" "$journal"; ctv_fsync "$journal"; ctv_fsync "$(dirname "$journal")"
}
ctv_apply_governed() {
  local journal=${1:-} unit_source=${2:-} unit_dest=${3:-} unit_sha=${4:-}
  [ "${CTV_LIVE_AUTHORIZED:-NO}" = YES ] || { echo CTV_LIVE_AUTHORIZATION_REQUIRED >&2; return 1; }
  ctv_target_unit_preflight "$unit_source" "$unit_sha" || { echo CTV_TARGET_UNIT_PREFLIGHT_FAIL >&2; return 1; }
  grep -qx 'phase=consumed-no-production-mutation' "$journal" || { echo CTV_JOURNAL_NOT_PREMUTATION >&2; return 1; }
  ctv_journal_phase "$journal" mutation-started || return 1
  ctv_run install -o root -g root -m 0644 "$unit_source" "$unit_dest" || return 1
  ctv_journal_phase "$journal" mutation-applied || return 1
  ctv_run systemctl daemon-reload || return 1
  # Exactly one explicit Core restart; no Detector command is permitted here.
  ctv_run systemctl restart aegis-idea3-core.service || return 1
  ctv_journal_phase "$journal" rollback-complete || return 1
  printf 'CTV_APPLY=PASS\nCTV_CORE_RESTARTS=1\nCTV_EXPLICIT_DETECTOR_LIFECYCLE_COMMANDS=0\n'
}
ctv_preconsume_rehearsal() {
  # This function is intentionally read-only. Callers pass already-captured
  # proof records; no CTV marker is created here.
  [ "${CTV_ATTEMPT_CONSUMED:-NO}" = NO ] || return 1
  [ "${CTV_PRODUCTION_MUTATION:-NO}" = NO ] || return 1
  printf 'CTV_PRECONSUME_REHEARSAL=PASS\nADDITIONAL_DETERMINISTIC_PRECONSUME_BLOCKER=NONE\n'
}
