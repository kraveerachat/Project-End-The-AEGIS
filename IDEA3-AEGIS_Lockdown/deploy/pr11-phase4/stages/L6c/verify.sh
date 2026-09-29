#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — Stage L6c "Immutable Release Install" verify handler. READ-ONLY.
# Proves: the target release is installed exactly, root-owned, with valid provenance (via the real, current
# p4-l7-release-guard.py — never a copied predicate); /opt/aegis-idea3/current is unchanged; no Core unit, listener, L6b
# broker, or IDEA2 state changed; no L7-owned credential/core.env material exists; and no secret is ever printed.
set -uo pipefail

fail() { printf 'L6C_VERIFY=FAIL reason=%s\n' "$1" >&2; exit 1; }

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

[ -n "$WORK" ] && [ -d "$WORK" ] || fail WORK_DIR_MISSING
[ -n "$RELEASE_ID" ] || fail AEGIS_L6C_RELEASE_ID_REQUIRED
for f in journal.tsv prestate.manifest legacy-tree.sha256; do [ -f "$WORK/$f" ] || fail APPLY_ARTIFACTS_MISSING; done
LOGICAL="/opt/aegis-idea3/releases/$RELEASE_ID"

rel_host=$(host_path "$LOGICAL")
current_host=$(host_path /opt/aegis-idea3/current)
legacy_dir=$(host_path /etc/mosquitto)

# ── 1. the target release exists exactly, is not a symlink, and the REAL current guard passes with owner=root live ──────
[ -d "$rel_host" ] && [ ! -L "$rel_host" ] || fail RELEASE_NOT_INSTALLED
owner_expect=any
[ -z "$ROOT" ] && owner_expect=root
guard_out=$("$PY" "$P4_HERE/p4-l7-release-guard.py" check --logical-path "$LOGICAL" --host-path "$rel_host" --expect-owner "$owner_expect" 2>&1) \
  || fail "RELEASE_GUARD_FAILED:$(sed -n 's/.*reason=//p' <<< "$guard_out" | head -n 1)"
seen_release_id=$(sed -n 's/.*release_id=\([^ ]*\).*/\1/p' <<< "$guard_out")
seen_sha=$(sed -n 's/.*source_git_sha=\([^ ]*\).*/\1/p' <<< "$guard_out")
[ "$seen_release_id" = "$RELEASE_ID" ] || fail RELEASE_ID_MISMATCH
[ -z "$EXPECTED_SOURCE_SHA" ] || [ "$seen_sha" = "$EXPECTED_SOURCE_SHA" ] || fail SOURCE_SHA_MISMATCH

# ── 2. no L7-owned credential/core.env material was created by this stage ────────────────────────────────────────────────
for p in /etc/aegis-idea3/credentials /etc/aegis-idea3/core.env; do
  [ ! -e "$(host_path "$p")" ] || fail "L7_MATERIAL_PRESENT:${p}"
done

# ── 3. /opt/aegis-idea3/current is unchanged ─────────────────────────────────────────────────────────────────────────────
prior_target=$(sed -n 's/^current_target=//p' "$WORK/prestate.manifest")
if [ "$prior_target" = "<absent>" ]; then
  [ ! -e "$current_host" ] && [ ! -L "$current_host" ] || fail CURRENT_LINK_CHANGED
else
  [ -L "$current_host" ] && [ "$(readlink "$current_host")" = "$prior_target" ] || fail CURRENT_LINK_CHANGED
fi

# ── 4. legacy Mosquitto tree, the Core/broker/IDEA2 units, and listeners are all unchanged ────────────────────────────────
snapshot_tree "$legacy_dir" "$WORK/legacy-tree.current"
cmp -s "$WORK/legacy-tree.sha256" "$WORK/legacy-tree.current" || fail LEGACY_CONFIG_TREE_CHANGED
if use_systemd; then
  sysctl_do show -p LoadState -p ActiveState -p SubState -p UnitFileState -p MainPID -p NRestarts -p ExecMainStartTimestamp \
    "$LEGACY_UNIT" "$BROKER_UNIT" "$CORE_UNIT" "$IDEA2_ENGINE" "$IDEA2_TUNNEL" > "$WORK/services.current" \
    || fail SERVICE_READ_FAILED
  cmp -s "$WORK/services.before" "$WORK/services.current" || fail PREDECESSOR_SERVICE_CHANGED
  [ "$(sysctl_do show -p LoadState --value "$CORE_UNIT")" = not-found ] || fail CORE_UNIT_LOADED
fi
if use_ss; then
  ss_do -H -ltnu | awk '{ print $1 ":" $5 }' | LC_ALL=C sort -u > "$WORK/listeners.current"
  cmp -s "$WORK/listeners.before" "$WORK/listeners.current" || fail LISTENER_CHANGED
fi

# ── 5. ESP32/L8: this stage has no device backend and issues no such command; nothing to check beyond static review ──────

printf 'L6C_VERIFY=PASS\n'
printf 'L6C_RELEASE_ID=%s\n' "$RELEASE_ID"
printf 'L6C_SOURCE_GIT_SHA=%s\n' "$seen_sha"
