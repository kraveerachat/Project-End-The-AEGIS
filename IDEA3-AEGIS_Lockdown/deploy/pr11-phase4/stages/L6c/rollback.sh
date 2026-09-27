#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — Stage L6c "Immutable Release Install" rollback handler. MUTATING in live mode, failure/abort
# path only. Acts ONLY if this attempt itself created the immutable release, and only after re-proving — via the real,
# current p4-l7-release-guard.py, never a copied predicate — that the target is EXACTLY the stage-created release (no
# drift since placement). Never touches /opt/aegis-idea3/current, a pre-existing release, or anything outside the exact
# journaled paths. Removes a parent directory only if this stage itself created it AND it is now empty. Idempotent.
set -uo pipefail

fail() { printf 'L6C_ROLLBACK=FAIL reason=%s\n' "$1" >&2; exit 1; }

LEGACY_UNIT=mosquitto.service
BROKER_UNIT=aegis-idea3-mosquitto.service
CORE_UNIT=aegis-idea3-core.service
IDEA2_ENGINE=aegis-detection-engine.service
IDEA2_TUNNEL=aegis-detection-tunnel.service

HERE="$(cd "$(dirname "$0")" && pwd)"
P4_HERE="$(cd "$HERE/../.." && pwd)"
PY="${AEGIS_PYTHON_BIN:-python3}"
ROOT="${AEGIS_P4_FS_ROOT:-}"
FIXTURE_SYSTEMCTL="${AEGIS_L6C_FIXTURE_SYSTEMCTL:-}"
FIXTURE_SS="${AEGIS_L6C_FIXTURE_SS:-}"
WORK="${AEGIS_L6C_WORK_DIR:-}"
RELEASE_ID="${AEGIS_L6C_RELEASE_ID:-}"
EXPECTED_SOURCE_SHA="${AEGIS_L6C_EXPECTED_SOURCE_SHA:-}"

host_path() { if [ -n "$ROOT" ]; then printf '%s%s\n' "${ROOT%/}" "$1"; else printf '%s\n' "$1"; fi; }
use_systemd() { [ -z "$ROOT" ] || [ -n "$FIXTURE_SYSTEMCTL" ]; }
sysctl_do() { if [ -z "$ROOT" ]; then systemctl "$@"; else "$FIXTURE_SYSTEMCTL" "$@"; fi; }
use_ss() { [ -z "$ROOT" ] || [ -n "$FIXTURE_SS" ]; }
ss_do() { if [ -z "$ROOT" ]; then ss "$@"; else "$FIXTURE_SS" "$@"; fi; }
snapshot_tree() {
  local dir=$1 out=$2
  if [ -d "$dir" ]; then (cd "$dir" && find . -xdev -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum) > "$out"; else : > "$out"; fi
}

[ -n "$WORK" ] && [ -d "$WORK" ] && [ ! -L "$WORK" ] || fail WORK_DIR_MISSING
JOURNAL="$WORK/journal.tsv"
[ -f "$JOURNAL" ] && [ ! -L "$JOURNAL" ] || fail JOURNAL_MISSING
[ -f "$WORK/legacy-tree.sha256" ] && [ -f "$WORK/prestate.manifest" ] || fail BASELINE_MISSING
[ -n "$RELEASE_ID" ] || fail AEGIS_L6C_RELEASE_ID_REQUIRED
LOGICAL="/opt/aegis-idea3/releases/$RELEASE_ID"

# ── journal validation: only the fixed L6c-owned entries are ever acted on ────────────────────────────────────────────────
j_opt=0 j_releases=0 j_release=0
while IFS=$'\t' read -r kind value || [ -n "$kind" ]; do
  [ -n "$kind" ] || continue
  case "$kind" in
    DIR)
      case "$value" in
        /opt/aegis-idea3) j_opt=1 ;;
        /opt/aegis-idea3/releases) j_releases=1 ;;
        *) fail JOURNAL_ENTRY_NOT_OWNED ;;
      esac ;;
    RELEASE) [ "$value" = "$LOGICAL" ] || fail JOURNAL_ENTRY_NOT_OWNED; j_release=1 ;;
    *) fail JOURNAL_ENTRY_UNKNOWN ;;
  esac
done < "$JOURNAL"

opt_host=$(host_path /opt/aegis-idea3)
releases_host=$(host_path /opt/aegis-idea3/releases)
rel_host=$(host_path "$LOGICAL")
current_host=$(host_path /opt/aegis-idea3/current)
legacy_dir=$(host_path /etc/mosquitto)

# current must never be touched, regardless of anything else; refuse to even proceed if it drifted already.
prior_target=$(sed -n 's/^current_target=//p' "$WORK/prestate.manifest")
if [ "$prior_target" = "<absent>" ]; then
  [ ! -e "$current_host" ] && [ ! -L "$current_host" ] || fail CURRENT_LINK_CHANGED
else
  [ -L "$current_host" ] && [ "$(readlink "$current_host")" = "$prior_target" ] || fail CURRENT_LINK_CHANGED
fi

# ── remove ONLY the exact stage-created release, and only after proving it is still exactly what was placed ──────────────
if [ "$j_release" = 1 ] && { [ -e "$rel_host" ] || [ -L "$rel_host" ]; }; then
  [ -d "$rel_host" ] && [ ! -L "$rel_host" ] || fail RELEASE_PATH_NOT_A_DIRECTORY
  guard_out=$("$PY" "$P4_HERE/p4-l7-release-guard.py" check --logical-path "$LOGICAL" --host-path "$rel_host" --expect-owner any 2>&1) \
    || fail "RELEASE_DRIFTED_REFUSING_ROLLBACK:$(sed -n 's/.*reason=//p' <<< "$guard_out" | head -n 1)"
  seen_release_id=$(sed -n 's/.*release_id=\([^ ]*\).*/\1/p' <<< "$guard_out")
  seen_sha=$(sed -n 's/.*source_git_sha=\([^ ]*\).*/\1/p' <<< "$guard_out")
  [ "$seen_release_id" = "$RELEASE_ID" ] || fail RELEASE_DRIFTED_REFUSING_ROLLBACK:RELEASE_ID_MISMATCH
  [ -z "$EXPECTED_SOURCE_SHA" ] || [ "$seen_sha" = "$EXPECTED_SOURCE_SHA" ] || fail RELEASE_DRIFTED_REFUSING_ROLLBACK:SOURCE_SHA_MISMATCH
  "$PY" - "$rel_host" <<'PYC' || fail RELEASE_REMOVE_FAILED
import os, stat, sys
root = sys.argv[1]
entries = []
def scan(path):
    info = os.lstat(path)
    if stat.S_ISLNK(info.st_mode):
        raise SystemExit(1)
    if stat.S_ISDIR(info.st_mode):
        for name in sorted(os.listdir(path)):
            scan(os.path.join(path, name))
    elif not stat.S_ISREG(info.st_mode):
        raise SystemExit(1)
    entries.append((path, stat.S_ISDIR(info.st_mode)))
scan(root)
for path, is_dir in entries:
    os.rmdir(path) if is_dir else os.unlink(path)
PYC
fi

# ── remove parent directories ONLY if this stage created them AND they are now empty; never a pre-existing parent ────────
if [ "$j_releases" = 1 ] && [ -d "$releases_host" ] && [ ! -L "$releases_host" ]; then
  [ -z "$(ls -A "$releases_host")" ] || fail RELEASES_DIR_NOT_EMPTY
  rmdir -- "$releases_host" || fail RELEASES_DIR_REMOVE_FAILED
fi
if [ "$j_opt" = 1 ] && [ -d "$opt_host" ] && [ ! -L "$opt_host" ]; then
  [ -z "$(ls -A "$opt_host")" ] || fail OPT_DIR_NOT_EMPTY
  rmdir -- "$opt_host" || fail OPT_DIR_REMOVE_FAILED
fi

# ── proofs: no L6c residue, current untouched, legacy/predecessor boundary intact ─────────────────────────────────────────
[ "$j_release" = 0 ] || [ ! -e "$rel_host" ] || fail RELEASE_RESIDUE
[ "$j_releases" = 0 ] || [ ! -e "$releases_host" ] || fail RELEASES_DIR_RESIDUE
[ "$j_opt" = 0 ] || [ ! -e "$opt_host" ] || fail OPT_DIR_RESIDUE
if [ "$prior_target" = "<absent>" ]; then
  [ ! -e "$current_host" ] && [ ! -L "$current_host" ] || fail CURRENT_LINK_RESIDUE
else
  [ -L "$current_host" ] && [ "$(readlink "$current_host")" = "$prior_target" ] || fail CURRENT_LINK_RESIDUE
fi

snapshot_tree "$legacy_dir" "$WORK/legacy-tree.rollback"
cmp -s "$WORK/legacy-tree.sha256" "$WORK/legacy-tree.rollback" || fail LEGACY_CONFIG_TREE_CHANGED
if use_systemd && [ -f "$WORK/services.before" ]; then
  sysctl_do show -p LoadState -p ActiveState -p SubState -p UnitFileState -p MainPID -p NRestarts -p ExecMainStartTimestamp \
    "$LEGACY_UNIT" "$BROKER_UNIT" "$CORE_UNIT" "$IDEA2_ENGINE" "$IDEA2_TUNNEL" > "$WORK/services.rollback" \
    || fail SERVICE_READ_FAILED
  cmp -s "$WORK/services.before" "$WORK/services.rollback" || fail PREDECESSOR_SERVICE_CHANGED
fi
if use_ss && [ -f "$WORK/listeners.before" ]; then
  ss_do -H -ltnu | awk '{ print $1 ":" $5 }' | LC_ALL=C sort -u > "$WORK/listeners.rollback"
  cmp -s "$WORK/listeners.before" "$WORK/listeners.rollback" || fail LISTENER_CHANGED
fi

printf 'L6C_ROLLBACK=PASS\n'
printf 'L6C_MATERIAL_RESIDUE=NO\n'
