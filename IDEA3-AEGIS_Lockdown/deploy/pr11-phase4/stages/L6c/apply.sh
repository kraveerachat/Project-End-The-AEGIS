#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — Stage L6c "Immutable Release Install" apply handler. MUTATING in live mode.
# Authority: docs/superpowers/specs/2026-09-27-idea3-pr11-phase4-l6c-release-install-governance.md.
#
# Installs exactly ONE already-built, already-reviewed immutable Core release from a builder output directory
# (p4-l7-build-release.py, PR #208) into /opt/aegis-idea3/releases/<release-id>/, by calling the already-merged
# p4-l7-install-release.py exactly once. This handler does NOT duplicate that tool's predicate (source ownership,
# checksum/manifest provenance, symlink/special-file rejection, atomic staged placement) — it only journals the exact
# prestate first, calls the installer once, and records the non-secret evidence.
#
# L6C_MUTATION_BOUNDARY = /opt/aegis-idea3/releases/<release-id>, plus only the parent directories (/opt/aegis-idea3,
# /opt/aegis-idea3/releases) that this run itself had to create.
# L6C_FORBIDDEN = /opt/aegis-idea3/current, /etc/aegis-idea3, systemd, the Core service, network, broker, NTP, Twingate,
# IDEA1, IDEA2, ESP32, L8, Production credentials. This handler never builds code, never generates or chowns a source
# directory as a workaround, and never touches a pre-existing release.
set -uo pipefail

fail() { printf 'L6C_APPLY=FAIL reason=%s\n' "$1" >&2; exit 1; }

RELEASE_ID_RE='^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
LEGACY_UNIT=mosquitto.service
BROKER_UNIT=aegis-idea3-mosquitto.service
CORE_UNIT=aegis-idea3-core.service
IDEA2_ENGINE=aegis-detection-engine.service
IDEA2_TUNNEL=aegis-detection-tunnel.service

HERE="$(cd "$(dirname "$0")" && pwd)"
P4_HERE="$(cd "$HERE/../.." && pwd)"
PY="${AEGIS_PYTHON_BIN:-python3}"
ROOT="${AEGIS_P4_FS_ROOT:-}"
# Fixture-only seams (read-only snapshots), honoured ONLY when AEGIS_P4_FS_ROOT is set; live mode always uses the real tools.
FIXTURE_SYSTEMCTL="${AEGIS_L6C_FIXTURE_SYSTEMCTL:-}"
FIXTURE_SS="${AEGIS_L6C_FIXTURE_SS:-}"
WORK="${AEGIS_L6C_WORK_DIR:-}"
SOURCE_DIR="${AEGIS_L6C_SOURCE_DIR:-}"
RELEASE_ID="${AEGIS_L6C_RELEASE_ID:-}"

host_path() {
  if [ -n "$ROOT" ]; then printf '%s%s\n' "${ROOT%/}" "$1"; else printf '%s\n' "$1"; fi
}
use_systemd() { [ -z "$ROOT" ] || [ -n "$FIXTURE_SYSTEMCTL" ]; }
sysctl_do() { if [ -z "$ROOT" ]; then systemctl "$@"; else "$FIXTURE_SYSTEMCTL" "$@"; fi; }
use_ss() { [ -z "$ROOT" ] || [ -n "$FIXTURE_SS" ]; }
ss_do() { if [ -z "$ROOT" ]; then ss "$@"; else "$FIXTURE_SS" "$@"; fi; }
snapshot_tree() {
  local dir=$1 out=$2
  if [ -d "$dir" ]; then (cd "$dir" && find . -xdev -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum) > "$out"; else : > "$out"; fi
}
journal() { printf '%s\t%s\n' "$1" "$2" >> "$WORK/journal.tsv" || fail JOURNAL_WRITE_FAILED; }

# ── 1. environment ───────────────────────────────────────────────────────────────────────────────────────────────────────
[ -n "$WORK" ] || fail AEGIS_L6C_WORK_DIR_REQUIRED
[ -n "$SOURCE_DIR" ] || fail AEGIS_L6C_SOURCE_DIR_REQUIRED
[ -n "$RELEASE_ID" ] || fail AEGIS_L6C_RELEASE_ID_REQUIRED
[[ "$RELEASE_ID" =~ $RELEASE_ID_RE ]] || fail RELEASE_ID_INVALID
LOGICAL="/opt/aegis-idea3/releases/$RELEASE_ID"

if [ -z "$ROOT" ]; then
  [ "${AEGIS_L6C_LIVE_AUTHORIZED:-NO}" = YES ] || fail LIVE_AUTHORIZATION_FLAG_REQUIRED
  [ "$(id -u)" = 0 ] || fail ROOT_REQUIRED
fi

case "$WORK" in /etc/*) fail WORK_DIR_INSIDE_ETC ;; esac
[ ! -L "$WORK" ] || fail WORK_DIR_IS_SYMLINK
[ ! -e "$WORK" ] || fail WORK_DIR_ALREADY_EXISTS

# ── 2. work dir + journal first, so any later failure is rollback-able ─────────────────────────────────────────────────
umask 077
mkdir -p "$WORK" || fail WORK_DIR_CREATE_FAILED
chmod 700 "$WORK"
: > "$WORK/journal.tsv"
chmod 600 "$WORK/journal.tsv"

# ── 3. exact prestate, BEFORE any mutation ──────────────────────────────────────────────────────────────────────────────
opt_host=$(host_path /opt/aegis-idea3)
releases_host=$(host_path /opt/aegis-idea3/releases)
rel_host=$(host_path "$LOGICAL")
current_host=$(host_path /opt/aegis-idea3/current)
legacy_dir=$(host_path /etc/mosquitto)
idea3_etc=$(host_path /etc/aegis-idea3)

[ ! -e "$rel_host" ] && [ ! -L "$rel_host" ] || fail "PRESTATE_UNEXPECTED:${rel_host}"
[ -d "$idea3_etc" ] && [ ! -L "$idea3_etc" ] || fail IDEA3_ETC_MISSING_OR_SYMLINK

opt_existed=0; [ -d "$opt_host" ] && [ ! -L "$opt_host" ] && opt_existed=1
[ -e "$opt_host" ] && [ ! -d "$opt_host" ] && fail "PRESTATE_UNEXPECTED:${opt_host}"
releases_existed=0; [ -d "$releases_host" ] && [ ! -L "$releases_host" ] && releases_existed=1
[ -e "$releases_host" ] && [ ! -d "$releases_host" ] && fail "PRESTATE_UNEXPECTED:${releases_host}"
printf 'opt_dir_existed=%s\n' "$opt_existed" > "$WORK/prestate.manifest"
printf 'releases_dir_existed=%s\n' "$releases_existed" >> "$WORK/prestate.manifest"

if [ -L "$current_host" ]; then
  printf 'current_target=%s\n' "$(readlink "$current_host")" >> "$WORK/prestate.manifest"
elif [ -e "$current_host" ]; then
  fail "PRESTATE_UNEXPECTED:${current_host}"
else
  printf 'current_target=<absent>\n' >> "$WORK/prestate.manifest"
fi

# source contract: never build code, never chown/modify the source as a workaround. The installer itself proves every
# other source property (ownership, checksums, manifest, no symlink/special file); this handler only proves it exists.
[ -d "$SOURCE_DIR" ] && [ ! -L "$SOURCE_DIR" ] || fail SOURCE_DIR_INVALID

snapshot_tree "$legacy_dir" "$WORK/legacy-tree.sha256"
if use_systemd; then
  sysctl_do show -p LoadState -p ActiveState -p SubState -p UnitFileState -p MainPID -p NRestarts -p ExecMainStartTimestamp \
    "$LEGACY_UNIT" "$BROKER_UNIT" "$CORE_UNIT" "$IDEA2_ENGINE" "$IDEA2_TUNNEL" > "$WORK/services.before" \
    || fail SERVICE_SNAPSHOT_FAILED
fi
if use_ss; then
  ss_do -H -ltnu | awk '{ print $1 ":" $5 }' | LC_ALL=C sort -u > "$WORK/listeners.before"
fi

# ── 4. journal the exact mutation boundary BEFORE calling the installer (durable marker before first Production write) ──
[ "$releases_existed" = 1 ] || journal DIR /opt/aegis-idea3/releases
[ "$opt_existed" = 1 ] || journal DIR /opt/aegis-idea3
journal RELEASE "$LOGICAL"
printf 'YES\n' > "$WORK/production-mutation"
printf 'PRODUCTION_MUTATION_PERFORMED=YES\n'

# ── 5. call the installer exactly once. No retry. Live default is root-owned; fixture mode relaxes only through the
#      installer's own narrowly named, host-root-gated override. ────────────────────────────────────────────────────────
install_args=(install --release-id "$RELEASE_ID" --source "$SOURCE_DIR" --logical-path "$LOGICAL")
if [ -n "$ROOT" ]; then
  install_args+=(--host-root "$ROOT")
  [ "${AEGIS_L6C_FIXTURE_DEST_OWNER_ANY:-NO}" = YES ] && install_args+=(--fixture-dest-owner-any)
fi
install_args+=(--evidence "$WORK/install-evidence.tsv")
install_out=$("$PY" "$P4_HERE/p4-l7-install-release.py" "${install_args[@]}" 2>&1) || \
  fail "INSTALL_FAILED:$(sed -n 's/.*reason=//p' <<< "$install_out" | head -n 1)"
printf '%s\n' "$install_out" > "$WORK/install-output.txt"

printf 'L6C_APPLY=PASS\n'
printf 'L6C_RELEASE_ID=%s\n' "$RELEASE_ID"
