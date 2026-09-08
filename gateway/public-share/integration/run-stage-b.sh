#!/bin/sh
# PUBLIC-SHARE-6 Stage B runner — isolated PS6 harness on AEGIS server hardware.
# Keep this file LF-only: it is executed on the Linux host.
#
# Runs the SAME Stage A acceptance matrix on the server's hardware while touching
# no existing production service, data, network, runtime Compose, .env, migration
# or public ingress.
#
# ⚠️ IT REFUSES TO RUN unless every precondition below holds. Each guard exits
#    non-zero with a reason rather than "continuing carefully", because a Stage B
#    that half-runs on a production host is worse than one that does not start.
#
# ⚠️ WHAT IT NEVER DOES. No pull, no prune of any kind, no production container
#    start, stop, restart, recreate or exec. No production network attach or
#    detach. No production volume mount. No connection to Production PostgreSQL.
#    No edit of the runtime Compose file or Production .env. No migration against
#    Production. No host port. No ingress, DNS, TLS, NAT, tunnel, firewall or
#    VLAN change. No credential is asked for, captured, stored or echoed.
#
# ── The four things this runner owns, and nothing else ────────────────────────
#
#   1. ONE Compose project      $PS6_PROJECT      (always `aegis-ps6-…`)
#   2. THREE networks           aegis_ps6_edge / _upstream / _data
#   3. The project's anonymous volumes and its two BUILT images
#   4. ONE temporary directory  /tmp/$PS6_PROJECT/
#
#    Every destructive command below names one of those four. There is no
#    `prune`, no bare `down`, and no filter broad enough to reach `aegis-prod`,
#    `aegis_postgres_data`, `aegis_drive_storage` or a production image.
#
# ── Privilege model: owner-mediated, non-interactive, fail-closed ─────────────
#
#    On this host the administrative account is NOT in the `docker` group and
#    `DOCKER_HOST` points at a Podman socket that does not exist, so Docker must
#    be reached as `sudo env -u DOCKER_HOST docker`.
#
#    This runner NEVER prompts for a credential. It uses `sudo -n` exclusively.
#    Before starting it, the OWNER establishes the sudo timestamp by hand:
#
#        sudo -v
#
#    If `sudo -n` is not already authorised, the runner refuses to start; if it
#    stops being authorised mid-run, the runner fails closed — it performs the
#    cleanup that is still possible and stops, rather than retrying in a way that
#    could prompt. An optional bounded keepalive (`sudo -n -v`) refreshes the
#    existing timestamp only, is capped, and is killed by the cleanup trap.
#
# ── Usage (from a quiet window) ──────────────────────────────────────────────
#
#     sudo -v                                   # OWNER runs this, by hand
#     PS6_SOURCE_SHA=<PR #105 HEAD> sh run-stage-b.sh 2>&1 | tee ps6-stage-b.log
#
#   The evidence is this script's OUTPUT, deliberately: every temporary file it
#   writes lives inside the one directory it owns, and the cleanup trap removes
#   that directory in full. Pipe it through `tee` if you want to keep it.
#
# ⚠️ THE SOURCE SHA IS REQUIRED AND IS NOT DEFAULTED.
#    An earlier draft hardcoded the Stage A commit, which was wrong the moment
#    this file existed: that commit predates the PS6_DOCKER override and so
#    cannot run on this host at all. A pinned default would also always be one
#    commit stale, because adding it changes the branch head. Pass the SHA that
#    PR #105 actually points at when you run this; the guard below verifies both
#    that the checkout really is that commit and that the commit is contained in
#    the PR branch, before anything is built.
set -eu

# ═══ Identity ════════════════════════════════════════════════════════════════

PRODUCTION_CHECKOUT=/opt/aegis/Project-End-The-AEGIS
REPO_URL=https://github.com/kraveerachat/Project-End-The-AEGIS.git
PR_BRANCH=feat/idea1-public-share-internal-integration

# Docker is ALWAYS non-interactive. `-n` is what makes this fail closed instead
# of blocking on a hidden password prompt inside a Node child process.
DOCKER="sudo -n env -u DOCKER_HOST docker"

REQUIRED_IMAGES="postgres:15-alpine node:20-alpine nginx:alpine"
PS6_NETWORKS="aegis_ps6_edge aegis_ps6_upstream aegis_ps6_data"

# Names this runner must never be pointed at, whatever the environment says.
PROTECTED_PROJECTS="aegis-prod aegis_prod"
PROTECTED_VOLUMES="aegis_postgres_data aegis_drive_storage"

say()  { printf '\n[ps6-stage-b] %s\n' "$*"; }
note() { printf '  %s\n' "$*"; }
die()  { printf '\n[ps6-stage-b] REFUSING: %s\n' "$*" >&2; exit 1; }

PS6_SOURCE_SHA=${PS6_SOURCE_SHA:-${1:-}}
[ -n "$PS6_SOURCE_SHA" ] || {
  printf '\n[ps6-stage-b] REFUSING: no source SHA given.\n  Pass PR #105 HEAD, e.g.\n    PS6_SOURCE_SHA=<40-hex> sh run-stage-b.sh\n  Find it with: git ls-remote %s refs/heads/%s\n' "$REPO_URL" "$PR_BRANCH" >&2
  exit 2
}
case "$PS6_SOURCE_SHA" in
  *[!0-9a-f]*|"") printf '\n[ps6-stage-b] REFUSING: source SHA must be full 40-char lowercase hex\n' >&2; exit 2 ;;
esac
[ ${#PS6_SOURCE_SHA} -eq 40 ] || {
  printf '\n[ps6-stage-b] REFUSING: source SHA must be the full 40 characters, not abbreviated\n' >&2
  exit 2
}

# ── The Compose project this run owns ────────────────────────────────────────
#
# Generated here unless the caller supplies one, so the runner ALWAYS knows the
# exact project name before a single Docker object exists — which is what makes
# a crash-safe, project-scoped teardown possible at all. The `aegis-ps6-` prefix
# is enforced, not assumed: every teardown below is `-p "$PS6_PROJECT"`-scoped,
# and the prefix is what makes it structurally impossible to aim that teardown at
# a production project.
PS6_RUN_ID=${PS6_RUN_ID:-$(date -u +%Y%m%d-%H%M%S)-$$}
PS6_PROJECT=${PS6_PROJECT:-aegis-ps6-stage-b-$PS6_RUN_ID}

printf '%s' "$PS6_PROJECT" | grep -qE '^aegis-ps6-[a-z0-9][a-z0-9_-]*$' \
  || die "PS6_PROJECT must match ^aegis-ps6-[a-z0-9][a-z0-9_-]*\$ — got '$PS6_PROJECT'"
[ ${#PS6_PROJECT} -le 64 ] || die "PS6_PROJECT must be at most 64 characters"
for protected in $PROTECTED_PROJECTS; do
  [ "$PS6_PROJECT" = "$protected" ] && die "PS6_PROJECT may never be '$protected'"
done
case "$PS6_PROJECT" in *prod*) die "PS6_PROJECT may not contain 'prod'" ;; esac

# ── The one temporary directory this run owns ────────────────────────────────
#
# Source tree AND evidence live inside it. No sibling `.pre` / `.post` files are
# created anywhere: an earlier draft wrote `$WORKDIR.pre` and `$WORKDIR.post`,
# which are outside the directory the cleanup trap removes and so survived it.
PS6_WORKDIR=${PS6_WORKDIR:-/tmp/$PS6_PROJECT}
SRC_DIR=$PS6_WORKDIR/src
EVIDENCE_DIR=$PS6_WORKDIR/evidence
COMPOSE_FILE=$SRC_DIR/gateway/public-share/integration/docker-compose.yml

case "$PS6_WORKDIR" in
  /tmp/aegis-ps6-*) ;;
  *) die "PS6_WORKDIR must be /tmp/aegis-ps6-* so the cleanup trap can own it — got '$PS6_WORKDIR'" ;;
esac
case "$PS6_WORKDIR" in
  "$PRODUCTION_CHECKOUT"|"$PRODUCTION_CHECKOUT"/*) die "PS6_WORKDIR is inside the production checkout" ;;
esac

# ═══ Cleanup trap ════════════════════════════════════════════════════════════
#
# Armed BEFORE anything is created, so an INT/TERM at any point still tears down
# exactly what exists. Both halves are idempotent: the main flow calls them in
# order so the post-state can be measured after cleanup, and the trap calls them
# again on the way out, where they become no-ops.

STARTED=0            # 1 once `compose up` has been attempted
KEEPALIVE_PID=""
DOCKER_CLEANED=0
WORKDIR_CLEANED=0
BUILT_IMAGE_IDS=""   # captured after the run, verified gone after cleanup

sudo_ok() { sudo -n true 2>/dev/null; }

stop_keepalive() {
  [ -n "$KEEPALIVE_PID" ] || return 0
  kill "$KEEPALIVE_PID" 2>/dev/null || true
  wait "$KEEPALIVE_PID" 2>/dev/null || true
  KEEPALIVE_PID=""
}

# Remove ONLY: this project's containers, this project's networks, this
# project's anonymous volumes, this project's built images. Nothing here can
# name a production object: every command is filtered by $PS6_PROJECT.
cleanup_docker() {
  [ "$DOCKER_CLEANED" -eq 1 ] && return 0
  DOCKER_CLEANED=1

  # Nothing before `compose up` creates a Docker object — the guards only
  # inspect and list — so a refusal during the guards has nothing to tear down,
  # and complaining about sudo there would bury the real reason for the refusal.
  [ "$STARTED" -eq 0 ] && return 0

  say "cleanup — Docker objects owned by project $PS6_PROJECT"

  if ! sudo_ok; then
    printf '\n[ps6-stage-b] FAIL CLOSED: sudo -n is no longer authorised, so Docker cleanup cannot run.\n' >&2
    printf '  Run these by hand, in this order:\n' >&2
    printf '    sudo -v\n' >&2
    printf '    sudo env -u DOCKER_HOST docker compose -p %s -f %s down --volumes --remove-orphans --rmi local --timeout 10\n' "$PS6_PROJECT" "$COMPOSE_FILE" >&2
    printf '    sudo env -u DOCKER_HOST docker ps -aq --filter label=com.docker.compose.project=%s\n' "$PS6_PROJECT" >&2
    printf '    rm -rf %s\n' "$PS6_WORKDIR" >&2
    return 1
  fi

  # 1 · the project itself. `--rmi local` removes ONLY images the project built
  #     without a custom tag, i.e. the drive and gateway images. postgres:15-alpine
  #     and node:20-alpine carry an explicit `image:` key and are therefore a
  #     custom tag, which `local` never removes. This is Compose's own scoping,
  #     not a filter written here.
  if [ "$STARTED" -eq 1 ] && [ -f "$COMPOSE_FILE" ]; then
    $DOCKER compose -p "$PS6_PROJECT" -f "$COMPOSE_FILE" \
      down --volumes --remove-orphans --rmi local --timeout 10 || true
  fi

  # 2 · anything the project labelled that survived, swept by label only.
  for id in $($DOCKER ps -aq --filter "label=com.docker.compose.project=$PS6_PROJECT" 2>/dev/null || true); do
    note "removing leftover container $id"
    $DOCKER rm -f "$id" >/dev/null 2>&1 || true
  done
  for vol in $($DOCKER volume ls -q --filter "label=com.docker.compose.project=$PS6_PROJECT" 2>/dev/null || true); do
    case " $PROTECTED_VOLUMES " in *" $vol "*) note "REFUSING to remove protected volume $vol"; continue ;; esac
    note "removing leftover volume $vol"
    $DOCKER volume rm "$vol" >/dev/null 2>&1 || true
  done
  for net in $($DOCKER network ls -q --filter "label=com.docker.compose.project=$PS6_PROJECT" 2>/dev/null || true); do
    note "removing leftover network $net"
    $DOCKER network rm "$net" >/dev/null 2>&1 || true
  done

  # 3 · built images, by repository name, which Compose derives from the project
  #     name. Double-guarded: the repository must start with "$PS6_PROJECT-", and
  #     a base image or an aegis-prod image is skipped even if it somehow matched.
  for line in $($DOCKER images --no-trunc --format '{{.Repository}}:{{.Tag}}|{{.ID}}' 2>/dev/null || true); do
    repo_tag=${line%%|*}
    image_id=${line#*|}
    case "$repo_tag" in "$PS6_PROJECT-"*) ;; *) continue ;; esac
    skip=0
    for base in $REQUIRED_IMAGES; do [ "$repo_tag" = "$base" ] && skip=1; done
    case "$repo_tag" in *aegis-prod*|*aegis_prod*) skip=1 ;; esac
    [ "$skip" -eq 1 ] && { note "REFUSING to remove $repo_tag"; continue; }
    note "removing PS6-built image $repo_tag ($image_id)"
    $DOCKER rmi "$image_id" >/dev/null 2>&1 || true
  done

  # NOTE: there is deliberately no `docker system prune`, no `image prune`, no
  # `volume prune` and no `builder prune` anywhere in this file.
  return 0
}

cleanup_workdir() {
  [ "$WORKDIR_CLEANED" -eq 1 ] && return 0
  WORKDIR_CLEANED=1
  case "$PS6_WORKDIR" in
    /tmp/aegis-ps6-*) ;;
    *) printf '[ps6-stage-b] REFUSING to remove %s\n' "$PS6_WORKDIR" >&2; return 1 ;;
  esac
  [ -e "$PS6_WORKDIR" ] || return 0
  say "cleanup — temporary directory $PS6_WORKDIR"
  rm -rf "$PS6_WORKDIR"
  [ -e "$PS6_WORKDIR" ] && { printf '[ps6-stage-b] %s survived removal\n' "$PS6_WORKDIR" >&2; return 1; }
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
# INT and TERM only choose the exit status; EXIT is what actually cleans up, so
# there is exactly one teardown path however the script ends.
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ═══ Guards ══════════════════════════════════════════════════════════════════

say "identity"
note "project:  $PS6_PROJECT"
note "workdir:  $PS6_WORKDIR"
note "source:   $PS6_SOURCE_SHA"
note "docker:   $DOCKER"

# ── Guard 0 · the OWNER has already authorised sudo; we never prompt ──────────
say "guard 0 — non-interactive sudo authorisation"
sudo_ok || {
  printf '\n[ps6-stage-b] REFUSING: `sudo -n true` failed, so no non-interactive sudo authorisation exists.\n' >&2
  printf '  This runner never prompts for a credential and never handles one.\n' >&2
  printf '  The OWNER should run this by hand in the same terminal, then re-run:\n\n    sudo -v\n\n' >&2
  exit 2
}
note "sudo -n is authorised; no credential is requested, stored or echoed"

# Bounded keepalive. It only refreshes a timestamp that ALREADY exists — it can
# never create one, because `-n` cannot prompt. Capped, and killed by the trap.
PS6_SUDO_KEEPALIVE=${PS6_SUDO_KEEPALIVE:-1}
PS6_SUDO_KEEPALIVE_MAX_SECONDS=${PS6_SUDO_KEEPALIVE_MAX_SECONDS:-5400}
if [ "$PS6_SUDO_KEEPALIVE" = 1 ]; then
  (
    elapsed=0
    while [ "$elapsed" -lt "$PS6_SUDO_KEEPALIVE_MAX_SECONDS" ]; do
      sleep 50
      elapsed=$((elapsed + 50))
      sudo -n -v 2>/dev/null || exit 0
    done
  ) &
  KEEPALIVE_PID=$!
  note "sudo timestamp keepalive: pid $KEEPALIVE_PID, capped at ${PS6_SUDO_KEEPALIVE_MAX_SECONDS}s, killed by the cleanup trap"
fi

# ── Guard 1 · the daemon is reachable the way this host requires ─────────────
say "guard 1 — Docker daemon"
$DOCKER version --format 'server {{.Server.Version}}' \
  || die "cannot reach the system Docker daemon through: $DOCKER"
$DOCKER compose version >/dev/null || die "docker compose plugin unavailable"

# ── Guard 2 · never build from, or even touch, the production checkout ───────
say "guard 2 — production checkout is off limits"
[ -e "$PS6_WORKDIR" ] && die "$PS6_WORKDIR already exists — remove it or set PS6_WORKDIR"
note "$PRODUCTION_CHECKOUT is never read, written, fetched or built from"

# ── Guard 3 · the project name is not already in use ────────────────────────
say "guard 3 — the PS6 project name is free"
for kind in "ps -aq" "volume ls -q" "network ls -q"; do
  # shellcheck disable=SC2086
  existing=$($DOCKER $kind --filter "label=com.docker.compose.project=$PS6_PROJECT" 2>/dev/null || true)
  [ -n "$existing" ] && die "objects already carry project label $PS6_PROJECT — this runner never adopts objects it did not create"
done
note "no container, volume or network carries $PS6_PROJECT"

# ── Guard 4 · the required base images are already present; never pull ───────
say "guard 4 — required base images already present"
for image in $REQUIRED_IMAGES; do
  $DOCKER image inspect "$image" >/dev/null 2>&1 \
    || die "$image is not present locally, and this runner never pulls"
  note "present: $image"
done

# ── Guard 5 · PS6 network names are free ─────────────────────────────────────
say "guard 5 — PS6 network names are free"
for net in $PS6_NETWORKS aegis_public_share; do
  if $DOCKER network inspect "$net" >/dev/null 2>&1; then
    die "$net already exists — this runner never adopts a network it did not create"
  fi
  note "absent: $net"
done

# ── Guard 6 · no subnet overlap with anything currently defined ──────────────
# PS6 declares 172.31.250.0/29, .251.0/29 and .252.0/29 explicitly, so a real
# overlap makes network creation fail rather than silently share. This check
# turns that late failure into an early, readable one.
say "guard 6 — subnet overlap"
for net in $($DOCKER network ls --format '{{.Name}}'); do
  for subnet in $($DOCKER network inspect "$net" --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}'); do
    case "$subnet" in
      172.31.250.*|172.31.251.*|172.31.252.*)
        die "network $net already uses $subnet, which PS6 needs" ;;
    esac
  done
done
note "no conflict with 172.31.250-252.0/29"

mkdir -p "$SRC_DIR" "$EVIDENCE_DIR"

# ═══ Stable inventory ════════════════════════════════════════════════════════
#
# ⚠️ NOT `docker ps --format '{{.Status}}'`. That prints "Up 4 days (healthy)",
#    a HUMAN string whose uptime advances between the pre and the post snapshot,
#    so a pre/post diff of it is guaranteed to differ for reasons that mean
#    nothing. What is captured instead is the stable identity of each production
#    object: container name, container ID, image ID, Compose project, running
#    state, health state and network attachments. Those must be IDENTICAL
#    afterwards, and a difference in any of them is a real finding.
#
# Rows belonging to $PS6_PROJECT are excluded, because this harness's own
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
        2>/dev/null | grep -v "	$PS6_PROJECT	" | LC_ALL=C sort || true
    fi

    echo '### networks  id<TAB>name<TAB>driver<TAB>scope'
    $DOCKER network ls --no-trunc --format '{{.ID}}	{{.Name}}	{{.Driver}}	{{.Scope}}' 2>/dev/null \
      | grep -vE "	($(echo "$PS6_NETWORKS" | tr ' ' '|'))	" | LC_ALL=C sort || true

    echo '### volumes  name<TAB>driver'
    $DOCKER volume ls -q --filter "label=com.docker.compose.project=$PS6_PROJECT" \
      > "$EVIDENCE_DIR/.ps6-volumes" 2>/dev/null || : > "$EVIDENCE_DIR/.ps6-volumes"
    $DOCKER volume ls --format '{{.Name}}	{{.Driver}}' 2>/dev/null \
      | { if [ -s "$EVIDENCE_DIR/.ps6-volumes" ]; then grep -Fvf "$EVIDENCE_DIR/.ps6-volumes"; else cat; fi; } \
      | LC_ALL=C sort || true

    echo '### images  repo:tag<TAB>id'
    $DOCKER images --no-trunc --format '{{.Repository}}:{{.Tag}}	{{.ID}}' 2>/dev/null \
      | grep -v "^$PS6_PROJECT-" | LC_ALL=C sort || true
  } > "$target"
}

say "pre-state — stable production inventory (read-only)"
inventory "$EVIDENCE_DIR/pre.txt"
cat "$EVIDENCE_DIR/pre.txt"

# ═══ Source ══════════════════════════════════════════════════════════════════
#
# A temporary tree pinned to PR #105 HEAD. The production checkout is never
# cloned from, fetched into, read or built from.

say "source — temporary tree at $PS6_SOURCE_SHA"
git clone --no-checkout --quiet "$REPO_URL" "$SRC_DIR"
git -C "$SRC_DIR" checkout --quiet "$PS6_SOURCE_SHA" 2>/dev/null || {
  git -C "$SRC_DIR" fetch --quiet origin "$PS6_SOURCE_SHA"
  git -C "$SRC_DIR" checkout --quiet "$PS6_SOURCE_SHA"
}
ACTUAL=$(git -C "$SRC_DIR" rev-parse HEAD)
[ "$ACTUAL" = "$PS6_SOURCE_SHA" ] || die "source SHA is $ACTUAL, expected $PS6_SOURCE_SHA"
[ ${#ACTUAL} -eq 40 ] || die "resolved SHA is not 40 characters: $ACTUAL"
git -C "$SRC_DIR" merge-base --is-ancestor "$PS6_SOURCE_SHA" "origin/$PR_BRANCH" \
  || die "$PS6_SOURCE_SHA is not contained in origin/$PR_BRANCH"
note "verified source SHA: $ACTUAL"
note "contained in origin/$PR_BRANCH: yes"
[ -f "$COMPOSE_FILE" ] || die "compose file missing from the pinned source tree"

# ── Guard 7 · the pinned source honours the project this runner owns ─────────
#
# ⚠️ This guard exists because a dry run caught the failure it prevents. Against
#    a source tree whose acceptance suite still picks its own
#    `aegis-ps6-<pid>` project name, `compose up` runs under a project this
#    runner has never heard of — so every project-scoped teardown below would
#    have cleaned an EMPTY project and reported success while the real one, with
#    its containers, networks, volumes and two built images, leaked onto a
#    production host. Ownership is therefore verified against the pinned tree,
#    not assumed from the branch name.
say "guard 7 — the pinned source honours PS6_PROJECT"
TEST_FILE=$SRC_DIR/IDEA1-AEGIS_Drive_LC/tests/publicShareInternalIntegration.test.js
[ -f "$TEST_FILE" ] || die "the acceptance suite is missing from the pinned source tree"
grep -q 'process\.env\.PS6_PROJECT' "$TEST_FILE" || die "the pinned source at $PS6_SOURCE_SHA does not read PS6_PROJECT, so this runner cannot own the Compose project it would clean up. Use a PR #105 HEAD that includes the PS6_PROJECT amendment."
note "the pinned acceptance suite reads PS6_PROJECT"

# ── Dependencies · none are installed on the host, deliberately ──────────────
#
# The acceptance suite imports node:test, node:assert, node:child_process,
# node:crypto, node:fs/promises, node:url and node:util — Node built-ins, every
# one. It needs no package from node_modules, so a host-side `npm ci` installed
# ~a thousand packages that the run never loaded. Removing it deletes a whole
# mutation (a lockfile-driven write into the temp tree), removes the audit noise,
# and shrinks the Drive build context, since this repository has no .dockerignore
# for IDEA1-AEGIS_Drive_LC and a populated node_modules would otherwise be
# uploaded to the daemon on every build.
#
# ⚠️ The Drive image is UNAFFECTED. It is still built from the shipped
#    IDEA1-AEGIS_Drive_LC/Dockerfile, which runs its own `npm ci` inside the
#    build stage. No Dockerfile was modified to make this possible.
say "dependencies — none installed on the host"
note "the acceptance suite uses Node built-ins only; no host-side npm ci is run"
note "the Drive image still runs npm ci inside its own shipped Dockerfile"

# ═══ Run ═════════════════════════════════════════════════════════════════════
#
# Sequential, project-scoped, no host port, no production contact.
# --test-concurrency=1 keeps the build and the transfers sequential rather than
# parallel, which is the approved build-load posture.

say "run — Stage B acceptance matrix as project $PS6_PROJECT"
STARTED=1
cd "$SRC_DIR/IDEA1-AEGIS_Drive_LC"
set +e
PS6_DOCKER="$DOCKER" PS6_PROJECT="$PS6_PROJECT" PUBLIC_SHARE_INTEGRATION_RUNTIME=1 \
  node --test --test-concurrency=1 --test-timeout=1800000 \
  tests/publicShareInternalIntegration.test.js
RESULT=$?
set -e
cd /
say "acceptance exit code $RESULT"

# ── Capture what the project BUILT, so its removal can be proven ────────────
say "built images — captured before cleanup so removal can be verified"
BUILT_IMAGE_IDS=$($DOCKER images --no-trunc --format '{{.Repository}}:{{.Tag}}|{{.ID}}' 2>/dev/null \
  | grep "^$PS6_PROJECT-" | cut -d'|' -f2 | LC_ALL=C sort -u || true)
if [ -n "$BUILT_IMAGE_IDS" ]; then
  $DOCKER images --no-trunc --format '  {{.Repository}}:{{.Tag}}  {{.ID}}' | grep "$PS6_PROJECT-" || true
else
  note "none present (the run may not have reached the build)"
fi

# ═══ Cleanup, then measure ═══════════════════════════════════════════════════

cleanup_docker || die "Docker cleanup could not complete"
stop_keepalive

FAILURES=0
fail() { printf '\n[ps6-stage-b] CHECK FAILED: %s\n' "$*" >&2; FAILURES=$((FAILURES + 1)); }

say "post-state — stable production inventory (read-only, after cleanup)"
inventory "$EVIDENCE_DIR/post.txt"
cat "$EVIDENCE_DIR/post.txt"

say "check — production identity is unchanged (container IDs, image IDs, networks, health)"
if diff -u "$EVIDENCE_DIR/pre.txt" "$EVIDENCE_DIR/post.txt" > "$EVIDENCE_DIR/diff.txt"; then
  note "IDENTICAL — every production container ID, image ID, Compose project,"
  note "running state, health state and network attachment matches the pre-state,"
  note "as does every network, volume and image outside this project."
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

say "check — no PS6 container, network, volume or image survives"
LEFT_C=$($DOCKER ps -aq --filter "label=com.docker.compose.project=$PS6_PROJECT" 2>/dev/null || true)
[ -z "$LEFT_C" ] && note "containers: none" || fail "PS6 containers survive: $LEFT_C"
LEFT_V=$($DOCKER volume ls -q --filter "label=com.docker.compose.project=$PS6_PROJECT" 2>/dev/null || true)
[ -z "$LEFT_V" ] && note "volumes:    none" || fail "PS6 volumes survive: $LEFT_V"
LEFT_N=$($DOCKER network ls --format '{{.Name}}' 2>/dev/null | grep -E '^aegis_ps6_' || true)
[ -z "$LEFT_N" ] && note "networks:   none" || fail "PS6 networks survive: $LEFT_N"
LEFT_I=$($DOCKER images --no-trunc --format '{{.Repository}}:{{.Tag}} {{.ID}}' 2>/dev/null | grep "^$PS6_PROJECT-" || true)
[ -z "$LEFT_I" ] && note "images:     none by repository name" || fail "PS6 images survive: $LEFT_I"

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
  note "$(wc -l < "$EVIDENCE_DIR/prod-post.txt" | tr -d " ") aegis-prod rows, all unchanged"
else
  diff -u "$EVIDENCE_DIR/prod-pre.txt" "$EVIDENCE_DIR/prod-post.txt" || true
  fail "an aegis-prod row changed across the run"
fi

# ═══ Temporary artifacts ═════════════════════════════════════════════════════

cleanup_workdir || fail "the temporary directory could not be removed"

say "check — no PS6 temporary artifact survives"
STRAY=$(ls -d /tmp/aegis-ps6-* /tmp/ps6-stage-b* 2>/dev/null || true)
[ -z "$STRAY" ] && note "nothing matches /tmp/aegis-ps6-* or /tmp/ps6-stage-b*" \
  || fail "temporary artifacts survive: $STRAY"

# ═══ Verdict ═════════════════════════════════════════════════════════════════

say "done"
note "acceptance exit code:   $RESULT"
note "post-run check failures: $FAILURES"
echo
echo "Production migration 009 and the Public UI flag were NOT read by this"
echo "runner: doing so would require connecting to Production PostgreSQL or"
echo "reading Production configuration, both of which are out of scope. Their"
echo "state is unchanged because nothing here writes to them — see the identity"
echo "diff above and the topology guards."

[ "$FAILURES" -eq 0 ] || exit 1
exit "$RESULT"
