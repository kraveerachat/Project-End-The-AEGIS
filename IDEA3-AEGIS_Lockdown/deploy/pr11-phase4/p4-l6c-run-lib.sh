#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — L6c "Immutable Release Install" owner-run gate library (sourced by the external frozen owner
# runner; nothing here runs on its own and nothing here mutates the host). Pure gate logic so it can be tested with stubs
# and fixture repositories. Reuses the already-merged, stage-independent gates rather than duplicating their predicates:
# receipt/AP/nft/TrustedClock from p4-l6b-run-lib.sh, and disk/IDEA2-§10/broker-runtime from p4-l7-run-lib.sh (both
# genuinely stage-independent despite their filenames). Every function returns 0 on PASS; on FAIL it prints one `reason`
# line to stderr and returns 1. Read-only: only `systemctl show`, `ss`, `df`, git reads, file tests, and the read-only
# p4-l7-release-guard.py are issued. It never installs a release, never repairs a predecessor, and never invokes L7.

: "${SUDO=sudo}"
_L6C_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=p4-l7-run-lib.sh
. "$_L6C_LIB_DIR/p4-l7-run-lib.sh"

l6c_reason() { printf '%s\n' "$1" >&2; return 1; }

# l6c_consume_attempt AUTH_DIR — one live attempt per authorization. Atomic create-if-absent; a second invocation for the
# same AUTH_DIR fails closed even if the first attempt failed. Distinct marker name from every other stage.
l6c_consume_attempt() {
  local dir=${1:-} marker
  [ -d "$dir" ] && [ ! -L "$dir" ] || { l6c_reason "L6C_ATTEMPT_AUTH_DIR_INVALID"; return 1; }
  marker="$dir/L6C-ATTEMPT-CONSUMED"
  if ( set -o noclobber; printf 'consumed_at=%s\n' "$(date -u +%FT%TZ)" > "$marker" ) 2>/dev/null; then
    return 0
  fi
  l6c_reason "L6C_ATTEMPT_ALREADY_CONSUMED (one live attempt per authorization; obtain a fresh same-day authorization)"
}

# l6c_receipt_gate REPO — predecessor ACCEPTANCE (L2..L5, L6a, L6b) proven by receipts read from the PINNED commit, never
# the working tree. L6c does NOT require, consume, or care about any L7 authorization or acceptance state.
l6c_receipt_gate() {
  local repo=${1:-}
  l6b_receipt_gate "$repo" >/dev/null || return 1
  git -C "$repo" grep -qE "L6B_LIVE_ACCEPTANCE ?= ?\`? ?PROVEN" HEAD -- "$L6B_LOGS_REL" \
    || { l6c_reason "L6C_L6B_ACCEPTANCE_RECEIPT_MISSING"; return 1; }
}

# l6c_release_source_gate SOURCE_DIR RELEASE_ID EXPECTED_MAIN PY P4_DIR REPO — the builder output (user-owned) must pass
# the real, current release guard at --expect-owner any for the EXACT pinned release id (the same id apply.sh will use),
# and its manifest source_git_sha must be an ancestor of the pinned main. Read-only; never installs anything.
l6c_release_source_gate() {
  local source=$1 release_id=$2 main=$3 py=$4 p4=$5 repo=$6 out sha
  out=$("$py" "$p4/p4-l7-release-guard.py" check --logical-path "/opt/aegis-idea3/releases/$release_id" --host-path "$source" --expect-owner any 2>&1) \
    || { l6c_reason "L6C_SOURCE_GUARD_FAILED:$(sed -n 's/.*reason=//p' <<< "$out" | head -n 1)"; return 1; }
  sha=$(sed -n 's/.*source_git_sha=//p' <<< "$out" | head -n 1)
  git -C "$repo" merge-base --is-ancestor "$sha" "$main" 2>/dev/null || { l6c_reason "L6C_SOURCE_SHA_NOT_ON_MAIN:$sha"; return 1; }
  printf 'L6C_SOURCE_SHA=%s\n' "$sha"
}

# l6c_target_absent_gate RELEASE_ID [FS_ROOT] — the immutable destination must not already exist. Read-only.
l6c_target_absent_gate() {
  local rid=$1 root=${2:-} dest="/opt/aegis-idea3/releases/$1"
  $SUDO test ! -e "$root$dest" || { l6c_reason "L6C_TARGET_ALREADY_EXISTS"; return 1; }
}

# l6c_secret_scan EVID_DIR PY — L6c never receives a credential, so this only guards against an accidental leak of a
# private-key block or a Mosquitto/scrypt hash ending up in the evidence tree (e.g. from a mis-pointed source directory).
# Runs through $SUDO so root-owned captures are covered. Prints only counts, never values.
l6c_secret_scan() {
  local evid=$1 py=$2
  $SUDO "$py" - "$evid" <<'PYC'
import pathlib, re, sys
ev = pathlib.Path(sys.argv[1])
pem = re.compile(rb"-----BEGIN [A-Z ]*PRIVATE KEY-----")
mosq = re.compile(rb"\$7\$\d+\$")
scrypt = re.compile(rb"scrypt\$\d+\$\d+\$\d+\$[0-9a-f]{16,}\$[0-9a-f]{32,}")
bad = scanned = 0
for f in ev.rglob("*"):
    if not f.is_file() or f.stat().st_size >= 50_000_000:
        continue
    scanned += 1
    data = f.read_bytes()
    if pem.search(data) or mosq.search(data) or scrypt.search(data):
        bad += 1
print(f"SECRET_SCAN_FILES={scanned} SECRET_SCAN_HITS={bad}")
sys.exit(1 if bad else 0)
PYC
}
