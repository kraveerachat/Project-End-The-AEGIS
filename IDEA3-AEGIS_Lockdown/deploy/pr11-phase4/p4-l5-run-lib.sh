#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — L5 owner-run helpers (sourced by the external owner runner; nothing here runs on its own).
# Pure bookkeeping: whole-run production-mutation accounting and an owner-readable, read-only copy of root-owned evidence.
# SUDO defaults to `sudo`; tests set SUDO="" to exercise the functions without privileges.

: "${SUDO=sudo}"

# l5_run_mutation_marker APPLY_OUTPUT WORK_MARKER_FILE
# Whole-run production-mutation result. YES when the apply handler reported YES at its first actual mutation (stdout line
# PRODUCTION_MUTATION_PERFORMED=YES) OR its durable WORK marker file says YES. Anything else (including a comparison-local
# "PRODUCTION_MUTATION_PERFORMED=NO", which only says the comparison itself did not mutate) is NO.
l5_run_mutation_marker() {
  local apply_out=${1:-} marker_file=${2:-} v=NO
  if printf '%s\n' "$apply_out" | grep -qx 'PRODUCTION_MUTATION_PERFORMED=YES'; then
    v=YES
  elif [ -n "$marker_file" ] && [ "$($SUDO cat -- "$marker_file" 2>/dev/null | head -n1)" = YES ]; then
    v=YES
  fi
  printf 'RUN_PRODUCTION_MUTATION_PERFORMED=%s\n' "$v"
}

# l5_relabel_compare_marker  (stdin -> stdout)
# p4-compare.sh prints a hard-coded, comparison-local PRODUCTION_MUTATION_PERFORMED=NO. Relabel it so it can never be read
# as the whole-run result.
l5_relabel_compare_marker() {
  sed 's/^PRODUCTION_MUTATION_PERFORMED=/COMPARE_LOCAL_PRODUCTION_MUTATION_PERFORMED=/'
}

# l5_copy_work_diagnostics SRC_DIR DEST_DIR
# Owner-readable copy of the (root-owned) L5 work directory. Read-only on SRC (files are streamed through `cat`; nothing in
# SRC is created, changed or removed). DEST must not exist; it is created 0700 owned by the caller, with a SHA256SUMS manifest.
l5_copy_work_diagnostics() {
  local src=${1:-} dst=${2:-} f name
  [ -n "$src" ] && [ -n "$dst" ] || { echo "usage: l5_copy_work_diagnostics SRC DEST" >&2; return 2; }
  $SUDO test -d "$src" || { echo "l5_copy_work_diagnostics: source missing: $src" >&2; return 1; }
  [ ! -e "$dst" ] || { echo "l5_copy_work_diagnostics: destination exists: $dst" >&2; return 1; }
  mkdir -m 700 -- "$dst" || return 1
  while IFS= read -r -d '' f; do
    name=${f#"$src"/}
    mkdir -p -- "$dst/$(dirname -- "$name")" || return 1
    $SUDO cat -- "$f" > "$dst/$name" || return 1
  done < <($SUDO find "$src" -type f -print0 | LC_ALL=C sort -z)
  ( cd "$dst" && find . -type f ! -name SHA256SUMS -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum > SHA256SUMS ) || return 1
}
