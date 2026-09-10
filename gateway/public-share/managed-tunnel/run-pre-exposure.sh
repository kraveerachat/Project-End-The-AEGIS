#!/bin/sh
# PUBLIC-SHARE-7 pre-exposure runner — the managed-tunnel harness on AEGIS
# server hardware. Keep this file LF-only: it is executed on the Linux host.
#
# It runs the PS7 pre-exposure acceptance matrix while touching no existing
# production service, data, network, runtime Compose, .env, migration or public
# ingress. It is the PUBLIC-SHARE-6 `run-stage-b.sh` safety model, applied to
# the one new harness.
#
# ⚠️ IT CREATES NO INTERNET EXPOSURE OF ANY KIND. No cloudflared, no tunnel, no
#    Cloudflare account or credential, no domain, no DNS record, no TLS
#    certificate, no NAT rule, no firewall change, no host port. The "managed
#    tunnel" in this harness is a container that re-originates HTTP with
#    CF-Connecting-IP; that is the security property under test, and it is the
#    only thing this runner produces evidence about.
#
# ⚠️ IT REFUSES TO RUN unless every precondition below holds. Each guard exits
#    non-zero with a reason rather than "continuing carefully", because a run
#    that half-executes on a production host is worse than one that does not
#    start.
#
# ⚠️ WHAT IT NEVER DOES. No pull, no prune of any kind, no production container
#    start, stop, restart, recreate or exec. No production network attach or
#    detach. No production volume mount. No connection to Production PostgreSQL.
#    No edit of the runtime Compose file or Production .env. No migration
#    against Production. No credential is asked for, captured, stored or echoed.
#
# ── The three things this runner owns, and nothing else ──────────────────────
#
#   1. ONE Compose project      $PS7_PROJECT      (always `aegis-ps7-…`)
#   2. THREE networks           aegis_ps7_edge / _upstream / _data
#   3. ONE temporary directory  /tmp/$PS7_PROJECT/, holding the evidence files
#      and the ONE Compose env file /tmp/$PS7_PROJECT/evidence/compose.env (0600)
#
#   plus the project's anonymous volumes and its two BUILT images, which are
#   removed by the project-scoped teardown. Every destructive command below
#   names one of those. There is no `prune`, no bare `down`, and no filter broad
#   enough to reach `aegis-prod`, `aegis_postgres_data`, `aegis_drive_storage`
#   or a production image.
#
# ── Privilege model: owner-mediated, non-interactive, fail-closed ────────────
#
#   On this host the administrative account is NOT in the `docker` group and
#   `DOCKER_HOST` points at a Podman socket that does not exist, so Docker must
#   be reached as `sudo env -u DOCKER_HOST docker`.
#
#   This runner NEVER prompts for a credential. It uses `sudo -n` exclusively.
#   Before starting it, the OWNER establishes the sudo timestamp by hand:
#
#       sudo -v
#
#   There is no `sudo -E`, no `--preserve-env`, no sudoers `env_keep`, no
#   docker-group change and no daemon configuration change anywhere in this file.
#
# ── Source ───────────────────────────────────────────────────────────────────
#
#   Unlike the PUBLIC-SHARE-6 runner, this one does NOT clone. The PS7 branch is
#   not published yet, so the only honest source is the checkout this file is
#   part of, and building from a copy of it would only add a way for the two to
#   differ. The checkout is used READ-ONLY: nothing is fetched into it, written
#   to it, or reset in it, and guard 2 refuses to run at all if it turns out to
#   be the production checkout.
#
# ── Usage (from a quiet window) ──────────────────────────────────────────────
#
#     sudo -v
#     sh gateway/public-share/managed-tunnel/run-pre-exposure.sh
set -eu

# ═══ Identity ════════════════════════════════════════════════════════════════

PRODUCTION_CHECKOUT=/opt/aegis/Project-End-The-AEGIS

# Docker is ALWAYS non-interactive. `-n` is what makes this fail closed instead
# of blocking on a hidden password prompt inside a Node child process.
DOCKER="sudo -n env -u DOCKER_HOST docker"

REQUIRED_IMAGES="postgres:15-alpine node:20-alpine nginx:alpine"
PS7_NETWORKS="aegis_ps7_edge aegis_ps7_upstream aegis_ps7_data"
PS7_SUBNET_PREFIXES="172.31.240. 172.31.241. 172.31.242."

# Names this runner must never be pointed at, whatever the environment says.
PROTECTED_PROJECTS="aegis-prod aegis_prod"
PROTECTED_VOLUMES="aegis_postgres_data aegis_drive_storage"

say()  { printf '\n[ps7-pre] %s\n' "$*"; }
note() { printf '  %s\n' "$*"; }
die()  { printf '\n[ps7-pre] REFUSING: %s\n' "$*" >&2; exit 1; }

# The repository this file belongs to: <repo>/gateway/public-share/managed-tunnel.
SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH='' cd -- "$SCRIPT_DIR/../../.." && pwd)
COMPOSE_FILE=$SCRIPT_DIR/docker-compose.yml
DRIVE_DIR=$REPO_ROOT/IDEA1-AEGIS_Drive_LC

# ── The Compose project this run owns ────────────────────────────────────────
#
# Generated here unless the caller supplies one, so the runner ALWAYS knows the
# exact project name before a single Docker object exists — which is what makes
# a crash-safe, project-scoped teardown possible at all. The `aegis-ps7-` prefix
# is enforced, not assumed: every teardown below is `-p "$PS7_PROJECT"`-scoped,
# and the prefix is what makes it structurally impossible to aim that teardown
# at a production project.
PS7_RUN_ID=${PS7_RUN_ID:-$(date -u +%Y%m%d-%H%M%S)-$$}
PS7_PROJECT=${PS7_PROJECT:-aegis-ps7-pre-$PS7_RUN_ID}

printf '%s' "$PS7_PROJECT" | grep -qE '^aegis-ps7-[a-z0-9][a-z0-9_-]*$' \
  || die "PS7_PROJECT must match ^aegis-ps7-[a-z0-9][a-z0-9_-]*\$ — got '$PS7_PROJECT'"
[ ${#PS7_PROJECT} -le 64 ] || die "PS7_PROJECT must be at most 64 characters"
for protected in $PROTECTED_PROJECTS; do
  [ "$PS7_PROJECT" = "$protected" ] && die "PS7_PROJECT may never be '$protected'"
done
case "$PS7_PROJECT" in *prod*) die "PS7_PROJECT may not contain 'prod'" ;; esac

# ── The one temporary directory this run owns ────────────────────────────────
PS7_WORKDIR=${PS7_WORKDIR:-/tmp/$PS7_PROJECT}
EVIDENCE_DIR=$PS7_WORKDIR/evidence

case "$PS7_WORKDIR" in
  /tmp/aegis-ps7-*) ;;
  *) die "PS7_WORKDIR must be /tmp/aegis-ps7-* so the cleanup trap can own it — got '$PS7_WORKDIR'" ;;
esac
case "$PS7_WORKDIR" in
  "$PRODUCTION_CHECKOUT"|"$PRODUCTION_CHECKOUT"/*) die "PS7_WORKDIR is inside the production checkout" ;;
esac

# ── The one Compose env file this run owns ───────────────────────────────────
#
# The only file this runner ever writes a secret into, and it never writes the
# secret itself: it creates the file empty at mode 0600 and the acceptance suite
# fills it with its own four throwaway values. A PATH crosses `sudo` because it
# is an argument; an environment variable does not — which is the whole reason
# this file exists (PUBLIC-SHARE-6 Stage B attempt #1).
PS7_COMPOSE_ENV_FILE=${PS7_COMPOSE_ENV_FILE:-$EVIDENCE_DIR/compose.env}
case "$PS7_COMPOSE_ENV_FILE" in
  "$PS7_WORKDIR"/*) ;;
  *) die "PS7_COMPOSE_ENV_FILE must be inside $PS7_WORKDIR so the cleanup trap removes it" ;;
esac
case "$PS7_COMPOSE_ENV_FILE" in
  *..*) die "PS7_COMPOSE_ENV_FILE may not contain '..'" ;;
esac

# ═══ Cleanup trap ════════════════════════════════════════════════════════════
#
# Armed BEFORE anything is created, so an INT/TERM at any point still tears down
# exactly what exists. Both halves are idempotent: the main flow calls them in
# order so the post-state can be measured after cleanup, and the trap calls them
# again on the way out, where they become no-ops.

STARTED=0
KEEPALIVE_PID=""
DOCKER_CLEANED=0
WORKDIR_CLEANED=0
BUILT_IMAGE_IDS=""

sudo_ok() { sudo -n true 2>/dev/null; }

stop_keepalive() {
  [ -n "$KEEPALIVE_PID" ] || return 0
  kill "$KEEPALIVE_PID" 2>/dev/null || true
  wait "$KEEPALIVE_PID" 2>/dev/null || true
  KEEPALIVE_PID=""
}

cleanup_docker() {
  [ "$DOCKER_CLEANED" -eq 1 ] && return 0
  DOCKER_CLEANED=1
  [ "$STARTED" -eq 0 ] && return 0

  say "cleanup — Docker objects owned by project $PS7_PROJECT"

  if ! sudo_ok; then
    printf '\n[ps7-pre] FAIL CLOSED: sudo -n is no longer authorised, so Docker cleanup cannot run.\n' >&2
    printf '  Run these by hand, in this order:\n    sudo -v\n' >&2
    if [ -s "$PS7_COMPOSE_ENV_FILE" ]; then
      printf '    sudo env -u DOCKER_HOST docker compose --env-file %s -p %s -f %s down --volumes --remove-orphans --rmi local --timeout 10\n' \
        "$PS7_COMPOSE_ENV_FILE" "$PS7_PROJECT" "$COMPOSE_FILE" >&2
    fi
    printf '    sudo env -u DOCKER_HOST docker ps -aq --filter label=com.docker.compose.project=%s\n' "$PS7_PROJECT" >&2
    printf '    rm -rf %s\n' "$PS7_WORKDIR" >&2
    return 1
  fi

  # 1 · the project itself. `--rmi local` removes ONLY images the project built
  #     without a custom tag. postgres:15-alpine and node:20-alpine carry an
  #     explicit `image:` key and are therefore a custom tag, which `local`
  #     never removes. That is Compose's own scoping, not a filter written here.
  #
  #     ⚠️ `--env-file` FIRST, before `-p` and `-f`: it is a top-level flag, and
  #        after the subcommand it is a different, service-scoped one.
  if [ -f "$COMPOSE_FILE" ]; then
    if [ -s "$PS7_COMPOSE_ENV_FILE" ]; then
      $DOCKER compose --env-file "$PS7_COMPOSE_ENV_FILE" -p "$PS7_PROJECT" -f "$COMPOSE_FILE" \
        down --volumes --remove-orphans --rmi local --timeout 10 || true
    else
      note "no Compose env file — the project-scoped down is skipped because it could"
      note "only fail interpolation; the label-scoped sweeps below do the teardown"
    fi
  fi

  # 2 · anything the project labelled that survived, swept by label only.
  for id in $($DOCKER ps -aq --filter "label=com.docker.compose.project=$PS7_PROJECT" 2>/dev/null || true); do
    note "removing leftover container $id"
    $DOCKER rm -f "$id" >/dev/null 2>&1 || true
  done
  for vol in $($DOCKER volume ls -q --filter "label=com.docker.compose.project=$PS7_PROJECT" 2>/dev/null || true); do
    case " $PROTECTED_VOLUMES " in *" $vol "*) note "REFUSING to remove protected volume $vol"; continue ;; esac
    note "removing leftover volume $vol"
    $DOCKER volume rm "$vol" >/dev/null 2>&1 || true
  done
  for net in $($DOCKER network ls -q --filter "label=com.docker.compose.project=$PS7_PROJECT" 2>/dev/null || true); do
    note "removing leftover network $net"
    $DOCKER network rm "$net" >/dev/null 2>&1 || true
  done

  # 3 · built images, by repository name, which Compose derives from the project
  #     name. Double-guarded: the repository must start with "$PS7_PROJECT-", and
  #     a base image or an aegis-prod image is skipped even if it somehow matched.
  for line in $($DOCKER images --no-trunc --format '{{.Repository}}:{{.Tag}}|{{.ID}}' 2>/dev/null || true); do
    repo_tag=${line%%|*}
    image_id=${line#*|}
    case "$repo_tag" in "$PS7_PROJECT-"*) ;; *) continue ;; esac
    skip=0
    for base in $REQUIRED_IMAGES; do [ "$repo_tag" = "$base" ] && skip=1; done
    case "$repo_tag" in *aegis-prod*|*aegis_prod*) skip=1 ;; esac
    [ "$skip" -eq 1 ] && { note "REFUSING to remove $repo_tag"; continue; }
    note "removing PS7-built image $repo_tag ($image_id)"
    $DOCKER rmi "$image_id" >/dev/null 2>&1 || true
  done

  # NOTE: there is deliberately no `docker system prune`, no `image prune`, no
  # `volume prune` and no `builder prune` anywhere in this file.
  return 0
}

cleanup_workdir() {
  [ "$WORKDIR_CLEANED" -eq 1 ] && return 0
  WORKDIR_CLEANED=1
  case "$PS7_WORKDIR" in
    /tmp/aegis-ps7-*) ;;
    *) printf '[ps7-pre] REFUSING to remove %s\n' "$PS7_WORKDIR" >&2; return 1 ;;
  esac
  # The secret-bearing file is named and removed explicitly first, so its removal
  # is a statement rather than a side effect. Its CONTENTS are never read.
  if [ -e "$PS7_COMPOSE_ENV_FILE" ]; then
    rm -f "$PS7_COMPOSE_ENV_FILE"
  fi
  [ -e "$PS7_WORKDIR" ] || return 0
  say "cleanup — temporary directory $PS7_WORKDIR"
  rm -rf "$PS7_WORKDIR"
  [ -e "$PS7_WORKDIR" ] && { printf '[ps7-pre] %s survived removal\n' "$PS7_WORKDIR" >&2; return 1; }
  note "removed"
  return 0
}

on_exit() {
  status=$?
  stop_keepalive
  cleanup_docker || true
  cleanup_workdir || true
  exit "$status"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ═══ Guards ══════════════════════════════════════════════════════════════════

say "identity"
note "project:  $PS7_PROJECT"
note "workdir:  $PS7_WORKDIR"
note "source:   $REPO_ROOT (read-only)"
note "compose:  $COMPOSE_FILE"
note "docker:   $DOCKER"

# ── Guard 0 · the OWNER has already authorised sudo; we never prompt ─────────
say "guard 0 — non-interactive sudo authorisation"
sudo_ok || {
  printf '\n[ps7-pre] REFUSING: `sudo -n true` failed, so no non-interactive sudo authorisation exists.\n' >&2
  printf '  This runner never prompts for a credential and never handles one.\n' >&2
  printf '  The OWNER should run this by hand in the same terminal, then re-run:\n\n    sudo -v\n\n' >&2
  exit 2
}
note "sudo -n is authorised; no credential is requested, stored or echoed"

# Bounded keepalive. It only refreshes a timestamp that ALREADY exists — it can
# never create one, because `-n` cannot prompt. Capped, and killed by the trap.
PS7_SUDO_KEEPALIVE=${PS7_SUDO_KEEPALIVE:-1}
PS7_SUDO_KEEPALIVE_MAX_SECONDS=${PS7_SUDO_KEEPALIVE_MAX_SECONDS:-5400}
if [ "$PS7_SUDO_KEEPALIVE" = 1 ]; then
  (
    elapsed=0
    while [ "$elapsed" -lt "$PS7_SUDO_KEEPALIVE_MAX_SECONDS" ]; do
      sleep 50
      elapsed=$((elapsed + 50))
      sudo -n -v 2>/dev/null || exit 0
    done
  ) &
  KEEPALIVE_PID=$!
  note "sudo timestamp keepalive: pid $KEEPALIVE_PID, capped at ${PS7_SUDO_KEEPALIVE_MAX_SECONDS}s"
fi

# ── Guard 1 · the daemon is reachable the way this host requires ─────────────
say "guard 1 — Docker daemon"
$DOCKER version --format 'server {{.Server.Version}}' \
  || die "cannot reach the system Docker daemon through: $DOCKER"
$DOCKER compose version >/dev/null || die "docker compose plugin unavailable"

# ── Guard 2 · never build from, or even touch, the production checkout ───────
say "guard 2 — production checkout is off limits"
case "$REPO_ROOT" in
  "$PRODUCTION_CHECKOUT"|"$PRODUCTION_CHECKOUT"/*)
    die "this script is running from the production checkout ($PRODUCTION_CHECKOUT); copy the branch elsewhere first" ;;
esac
[ -e "$PS7_WORKDIR" ] && die "$PS7_WORKDIR already exists — remove it or set PS7_WORKDIR"
[ -f "$COMPOSE_FILE" ] || die "$COMPOSE_FILE not found"
[ -f "$DRIVE_DIR/tests/publicShareManagedTunnelIntegration.test.js" ] \
  || die "the PS7 acceptance suite is not present in $DRIVE_DIR"
note "$PRODUCTION_CHECKOUT is never read, written, fetched or built from"

# ── Guard 3 · the project name is not already in use ────────────────────────
say "guard 3 — the PS7 project name is free"
for kind in "ps -aq" "volume ls -q" "network ls -q"; do
  # shellcheck disable=SC2086
  existing=$($DOCKER $kind --filter "label=com.docker.compose.project=$PS7_PROJECT" 2>/dev/null || true)
  [ -n "$existing" ] && die "objects already carry project label $PS7_PROJECT — this runner never adopts objects it did not create"
done
note "no container, volume or network carries $PS7_PROJECT"

# ── Guard 4 · the required base images are already present; never pull ──────
say "guard 4 — required base images already present"
for image in $REQUIRED_IMAGES; do
  $DOCKER image inspect "$image" >/dev/null 2>&1 \
    || die "$image is not present locally, and this runner never pulls"
  note "present: $image"
done

# ── Guard 5 · PS7 network names are free ────────────────────────────────────
say "guard 5 — PS7 network names are free"
for net in $PS7_NETWORKS; do
  if $DOCKER network inspect "$net" >/dev/null 2>&1; then
    die "$net already exists — this runner never adopts a network it did not create"
  fi
  note "absent: $net"
done

# ── Guard 6 · no subnet overlap with anything currently defined ─────────────
say "guard 6 — subnet overlap"
for net in $($DOCKER network ls --format '{{.Name}}'); do
  for subnet in $($DOCKER network inspect "$net" --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}'); do
    for prefix in $PS7_SUBNET_PREFIXES; do
      case "$subnet" in
        "$prefix"*) die "network $net already uses $subnet, which PS7 needs" ;;
      esac
    done
  done
done
note "no conflict with 172.31.240-242.0/29"

# ── Guard 7 · the gateway really is configured for managed mode ─────────────
say "guard 7 — the harness under test is the managed-tunnel one"
grep -q '^      PUBLIC_SHARE_EDGE_MODE: cloudflare$' "$COMPOSE_FILE" \
  || die "$COMPOSE_FILE does not put the gateway in managed-proxy mode"
grep -qE '^      PUBLIC_SHARE_EDGE_PROXY_CIDR: [0-9.]+/32$' "$COMPOSE_FILE" \
  || die "$COMPOSE_FILE does not pin exactly one connector /32"
grep -q 'ports:' "$COMPOSE_FILE" && die "$COMPOSE_FILE requests a host port"
note "managed mode, one pinned connector, no host port"

mkdir -p "$EVIDENCE_DIR"

# ── The Compose env file, created empty and owner-only ──────────────────────
say "compose env file — explicit interpolation plumbing across the sudo boundary"
(umask 077; : > "$PS7_COMPOSE_ENV_FILE") || die "cannot create $PS7_COMPOSE_ENV_FILE"
chmod 600 "$PS7_COMPOSE_ENV_FILE" || die "cannot set mode 0600 on $PS7_COMPOSE_ENV_FILE"
ENV_FILE_MODE=$(stat -c '%a' "$PS7_COMPOSE_ENV_FILE" 2>/dev/null || echo unknown)
[ "$ENV_FILE_MODE" = 600 ] || die "$PS7_COMPOSE_ENV_FILE is mode $ENV_FILE_MODE, expected 600"
note "path: $PS7_COMPOSE_ENV_FILE (mode 0600, contents never printed)"

# ═══ Stable inventory ════════════════════════════════════════════════════════
#
# ⚠️ NOT `docker ps --format '{{.Status}}'`. That prints "Up 4 days (healthy)",
#    a HUMAN string whose uptime advances between the pre and the post snapshot.
#    What is captured instead is the stable identity of each production object:
#    container name, container ID, image ID, Compose project, running state,
#    health state and network attachments. Those must be IDENTICAL afterwards,
#    and a difference in any of them is a real finding.
#
# Rows belonging to $PS7_PROJECT are excluded, because this harness's own
# containers legitimately exist between the two snapshots.

inventory() {
  target=$1

  {
    echo '### containers  name<TAB>id<TAB>imageId<TAB>project<TAB>running<TAB>health<TAB>networks'
    ids=$($DOCKER ps -aq 2>/dev/null || true)
    if [ -n "$ids" ]; then
      # shellcheck disable=SC2086
      $DOCKER inspect $ids --format \
'{{.Name}}	{{.Id}}	{{.Image}}	{{with index .Config.Labels "com.docker.compose.project"}}{{.}}{{else}}-{{end}}	{{.State.Running}}	{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}	{{range $k,$v := .NetworkSettings.Networks}}{{$k}}={{$v.IPAddress}};{{end}}' \
        2>/dev/null | grep -v "	$PS7_PROJECT	" | LC_ALL=C sort || true
    fi

    echo '### networks  id<TAB>name<TAB>driver<TAB>scope'
    $DOCKER network ls --no-trunc --format '{{.ID}}	{{.Name}}	{{.Driver}}	{{.Scope}}' 2>/dev/null \
      | grep -vE "	($(echo "$PS7_NETWORKS" | tr ' ' '|'))	" | LC_ALL=C sort || true

    echo '### volumes  name<TAB>driver'
    $DOCKER volume ls -q --filter "label=com.docker.compose.project=$PS7_PROJECT" \
      > "$EVIDENCE_DIR/.ps7-volumes" 2>/dev/null || : > "$EVIDENCE_DIR/.ps7-volumes"
    $DOCKER volume ls --format '{{.Name}}	{{.Driver}}' 2>/dev/null \
      | { if [ -s "$EVIDENCE_DIR/.ps7-volumes" ]; then grep -Fvf "$EVIDENCE_DIR/.ps7-volumes"; else cat; fi; } \
      | LC_ALL=C sort || true

    echo '### images  repo:tag<TAB>id'
    $DOCKER images --no-trunc --format '{{.Repository}}:{{.Tag}}	{{.ID}}' 2>/dev/null \
      | grep -v "^$PS7_PROJECT-" | LC_ALL=C sort || true
  } > "$target"
}

say "pre-state — stable production inventory (read-only)"
inventory "$EVIDENCE_DIR/pre.txt"
cat "$EVIDENCE_DIR/pre.txt"

# ═══ Run ═════════════════════════════════════════════════════════════════════
#
# Sequential, project-scoped, no host port, no production contact.

say "run — PS7 pre-exposure acceptance matrix as project $PS7_PROJECT"
STARTED=1
cd "$DRIVE_DIR"
set +e
PS7_DOCKER="$DOCKER" PS7_PROJECT="$PS7_PROJECT" \
PS7_WORKDIR="$PS7_WORKDIR" PS7_COMPOSE_ENV_FILE="$PS7_COMPOSE_ENV_FILE" \
PUBLIC_SHARE_MANAGED_TUNNEL_RUNTIME=1 \
  node --test --test-concurrency=1 --test-timeout=1800000 \
  tests/publicShareManagedTunnelIntegration.test.js
RESULT=$?
set -e
cd /
say "acceptance exit code $RESULT"

# ── Capture what the project BUILT, so its removal can be proven ────────────
say "built images — captured before cleanup so removal can be verified"
BUILT_IMAGE_IDS=$($DOCKER images --no-trunc --format '{{.Repository}}:{{.Tag}}|{{.ID}}' 2>/dev/null \
  | grep "^$PS7_PROJECT-" | cut -d'|' -f2 | LC_ALL=C sort -u || true)
if [ -n "$BUILT_IMAGE_IDS" ]; then
  $DOCKER images --no-trunc --format '  {{.Repository}}:{{.Tag}}  {{.ID}}' | grep "$PS7_PROJECT-" || true
else
  note "none present (the run may not have reached the build)"
fi

# ═══ Cleanup, then measure ═══════════════════════════════════════════════════

cleanup_docker || die "Docker cleanup could not complete"
stop_keepalive

FAILURES=0
fail() { printf '\n[ps7-pre] CHECK FAILED: %s\n' "$*" >&2; FAILURES=$((FAILURES + 1)); }

say "post-state — stable production inventory (read-only, after cleanup)"
inventory "$EVIDENCE_DIR/post.txt"
cat "$EVIDENCE_DIR/post.txt"

say "check — production identity is unchanged (container IDs, image IDs, networks, health)"
if diff -u "$EVIDENCE_DIR/pre.txt" "$EVIDENCE_DIR/post.txt" > "$EVIDENCE_DIR/diff.txt"; then
  note "IDENTICAL — every production container ID, image ID, Compose project,"
  note "running state, health state and network attachment matches the pre-state."
else
  cat "$EVIDENCE_DIR/diff.txt"
  fail "the production inventory changed across the run"
fi

say "check — every production service is still healthy"
UNHEALTHY=$(grep -E '^/' "$EVIDENCE_DIR/post.txt" | awk -F'\t' '$6 != "none" && $6 != "healthy" { print $1 " -> " $6 }' || true)
if [ -n "$UNHEALTHY" ]; then
  printf '%s\n' "$UNHEALTHY"
  fail "a production container is not healthy after the run"
else
  grep -E '^/' "$EVIDENCE_DIR/post.txt" | awk -F'\t' '{ printf "  %-32s running=%-5s health=%s\n", $1, $5, $6 }'
  note "no container reports an unhealthy state"
fi

say "check — protected production volumes still exist"
for vol in $PROTECTED_VOLUMES; do
  if grep -qE "^$vol	" "$EVIDENCE_DIR/post.txt"; then
    note "present: $vol"
  else
    fail "$vol is missing after the run"
  fi
done

say "check — no PS7 container, network, volume or image survives"
LEFT_C=$($DOCKER ps -aq --filter "label=com.docker.compose.project=$PS7_PROJECT" 2>/dev/null || true)
[ -z "$LEFT_C" ] && note "containers: none" || fail "PS7 containers survive: $LEFT_C"
LEFT_V=$($DOCKER volume ls -q --filter "label=com.docker.compose.project=$PS7_PROJECT" 2>/dev/null || true)
[ -z "$LEFT_V" ] && note "volumes:    none" || fail "PS7 volumes survive: $LEFT_V"
LEFT_N=$($DOCKER network ls --format '{{.Name}}' 2>/dev/null | grep -E '^aegis_ps7_' || true)
[ -z "$LEFT_N" ] && note "networks:   none" || fail "PS7 networks survive: $LEFT_N"
LEFT_I=$($DOCKER images --no-trunc --format '{{.Repository}}:{{.Tag}} {{.ID}}' 2>/dev/null | grep "^$PS7_PROJECT-" || true)
[ -z "$LEFT_I" ] && note "images:     none by repository name" || fail "PS7 images survive: $LEFT_I"

say "check — each image the project built is gone, by ID"
if [ -z "$BUILT_IMAGE_IDS" ]; then
  note "no built image was captured, so there is nothing to verify removed"
else
  for id in $BUILT_IMAGE_IDS; do
    if $DOCKER image inspect "$id" >/dev/null 2>&1; then
      fail "built image $id still exists"
    else
      note "removed: $id"
    fi
  done
fi

say "check — the base images were NOT removed"
for image in $REQUIRED_IMAGES; do
  if $DOCKER image inspect "$image" >/dev/null 2>&1; then
    note "preserved: $image"
  else
    fail "$image was removed — the cleanup was not project-scoped"
  fi
done

say "check — every aegis-prod row is identical pre and post"
grep -i 'aegis-prod\|aegis_prod' "$EVIDENCE_DIR/pre.txt"  > "$EVIDENCE_DIR/prod-pre.txt"  || true
grep -i 'aegis-prod\|aegis_prod' "$EVIDENCE_DIR/post.txt" > "$EVIDENCE_DIR/prod-post.txt" || true
if diff -u "$EVIDENCE_DIR/prod-pre.txt" "$EVIDENCE_DIR/prod-post.txt" >/dev/null 2>&1; then
  note "$(wc -l < "$EVIDENCE_DIR/prod-post.txt" | tr -d ' ') aegis-prod rows, all unchanged"
else
  diff -u "$EVIDENCE_DIR/prod-pre.txt" "$EVIDENCE_DIR/prod-post.txt" || true
  fail "an aegis-prod row changed across the run"
fi

# ═══ Temporary artifacts ═════════════════════════════════════════════════════

cleanup_workdir || fail "the temporary directory could not be removed"

say "check — the Compose env file is gone"
if [ -e "$PS7_COMPOSE_ENV_FILE" ]; then
  fail "$PS7_COMPOSE_ENV_FILE survived cleanup"
else
  note "removed: $PS7_COMPOSE_ENV_FILE"
fi

say "check — no PS7 temporary artifact survives"
STRAY=$(ls -d /tmp/aegis-ps7-* 2>/dev/null || true)
[ -z "$STRAY" ] && note "nothing matches /tmp/aegis-ps7-*" || fail "temporary artifacts survive: $STRAY"

# ═══ Verdict ═════════════════════════════════════════════════════════════════

say "done"
note "acceptance exit code:    $RESULT"
note "post-run check failures: $FAILURES"
echo
echo "This is PRE-EXPOSURE evidence only. No cloudflared, tunnel, domain, DNS"
echo "record, TLS certificate, NAT rule, firewall change or host port was"
echo "created. G5 and G6 remain OPEN and Public Internet Share remains NOT"
echo "IMPLEMENTED."

[ "$FAILURES" -eq 0 ] || exit 1
exit "$RESULT"
